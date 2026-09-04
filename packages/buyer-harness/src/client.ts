import type { BundleRequest, BundleResponse, IssuerErrorBody, KeyDocument } from './types';

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

export interface IssuerClientOptions {
  readonly baseUrl: string;
  readonly paymentRef: string;
  readonly idempotencyKey?: string;
  /** Injectable for tests and for callers with their own retry or proxy layer. */
  readonly fetch?: typeof globalThis.fetch;
}

export function encodePaymentClaim(paymentRef: string): string {
  return Buffer.from(JSON.stringify({ payment_ref: paymentRef }), 'utf8').toString('base64url');
}

export class IssuerClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly options: IssuerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async keyDocument(): Promise<KeyDocument> {
    const response = await this.request('/v1/keys/current', { method: 'GET' });
    return (await this.readJson(response)) as KeyDocument;
  }

  async purchaseBundle(request: BundleRequest): Promise<BundleResponse> {
    const response = await this.request('/v1/bundles', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-payment-claim': encodePaymentClaim(this.options.paymentRef),
        ...(this.options.idempotencyKey
          ? { 'idempotency-key': this.options.idempotencyKey }
          : {}),
      },
      body: JSON.stringify(request),
    });
    return (await this.readJson(response)) as BundleResponse;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      throw new IssuerRequestError(`${path} unreachable: ${(cause as Error).message}`);
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

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (cause) {
      throw new IssuerRequestError(`response was not valid JSON: ${(cause as Error).message}`);
    }
  }

  private async readError(response: Response): Promise<{ code?: string; message?: string }> {
    try {
      const body = (await response.json()) as Partial<IssuerErrorBody>;
      return { code: body.error?.code, message: body.error?.message };
    } catch {
      return {};
    }
  }
}
