import { encodePaymentClaim } from './claim';
import {
  NoPaymentProvider,
  parsePaymentRequirement,
  type PaymentProvider,
  type RetryHeaders,
} from './payment';
import type { BundleRequest, BundleResponse, IssuerErrorBody, KeyDocument } from './types';

export { encodePaymentClaim };

/** Transport or protocol failure, as opposed to a conformance failure. */
export class IssuerRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'IssuerRequestError';
  }
}

/** Which route the purchase took. `402-retry` means a proxy demanded payment. */
export type PaymentFlow = 'direct' | '402-retry';

export interface IssuerClientOptions {
  readonly baseUrl: string;
  readonly paymentRef: string;
  readonly idempotencyKey?: string;
  /** Defaults to sending nothing: a claim must be signed, so it cannot be invented here. */
  readonly payment?: PaymentProvider;
  /** Injectable for tests and for callers with their own retry or proxy layer. */
  readonly fetch?: typeof globalThis.fetch;
}

export class IssuerClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly payment: PaymentProvider;
  private flow: PaymentFlow = 'direct';

  constructor(private readonly options: IssuerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetch = options.fetch ?? globalThis.fetch;
    this.payment = options.payment ?? new NoPaymentProvider();
  }

  get paymentFlow(): PaymentFlow {
    return this.flow;
  }

  async keyDocument(): Promise<KeyDocument> {
    return (await this.readJson(await this.request('/v1/keys/current', { method: 'GET' }))) as KeyDocument;
  }

  async purchaseBundle(request: BundleRequest): Promise<BundleResponse> {
    const response = await this.request('/v1/bundles', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.idempotencyKey
          ? { 'idempotency-key': this.options.idempotencyKey }
          : {}),
      },
      body: JSON.stringify(request),
    });
    return (await this.readJson(response)) as BundleResponse;
  }

  /**
   * Runs request -> 402 -> pay -> retry. The retry happens at most once: a
   * proxy that answers 402 to a paid request is broken, and looping would turn
   * that into repeated payments.
   */
  private async request(path: string, init: RequestInit): Promise<Response> {
    let response = await this.send(path, init, this.payment.initialHeaders());

    if (response.status === 402) {
      // A 402 carrying payment requirements is a proxy asking to be paid. A 402
      // without them is the issuer refusing a claim, and paying would not help:
      // reporting it as "cannot pay" would hide the real reason.
      const body = await this.readJsonOrNull(response);
      const requirement = parsePaymentRequirement(body);

      if (Object.keys(requirement).length === 0) {
        const { code, message } = errorFrom(body);
        throw new IssuerRequestError(
          `${path} returned 402${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`,
          402,
          code,
        );
      }

      this.flow = '402-retry';
      response = await this.send(path, init, await this.payment.pay(requirement));

      if (response.status === 402) {
        throw new IssuerRequestError(
          `${path} still returned 402 after paying with ${this.payment.name}`,
          402,
        );
      }
    }

    if (!response.ok) {
      const { code, message } = await this.readError(response);
      throw new IssuerRequestError(
        `${path} returned ${response.status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`,
        response.status,
        code,
      );
    }
    return response;
  }

  private async send(path: string, init: RequestInit, extra: RetryHeaders): Promise<Response> {
    try {
      return await this.fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), ...extra },
      });
    } catch (cause) {
      throw new IssuerRequestError(`${path} unreachable: ${(cause as Error).message}`);
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (cause) {
      throw new IssuerRequestError(`response was not valid JSON: ${(cause as Error).message}`);
    }
  }

  private async readJsonOrNull(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  private async readError(response: Response): Promise<{ code?: string; message?: string }> {
    return errorFrom(await this.readJsonOrNull(response));
  }
}

function errorFrom(body: unknown): { code?: string; message?: string } {
  const error = (body as Partial<IssuerErrorBody> | null)?.error;
  return { code: error?.code, message: error?.message };
}
