import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { ensureDevKeys } from '../../../../scripts/generate-dev-keys';
import { RsaBlinder } from '../../../../packages/buyer-harness/src/blinding';
import { AppModule } from '../app.module';
import { ISSUER_CONFIG, loadIssuerConfig, type IssuerConfig } from '../config/issuer.config';
import type { KeyDocument } from '../keys/key-document';
import { KeysService } from '../keys/keys.service';

const REPO_ROOT = join(import.meta.dir, '../../../..');

export interface IssuerHarness {
  readonly url: string;
  readonly config: IssuerConfig;
  readonly keyDocument: KeyDocument;
  readonly dataSource: DataSource;
  close(): Promise<void>;
}

export async function startIssuer(
  overrides: Partial<IssuerConfig> = {},
): Promise<IssuerHarness> {
  // Resolved from the source tree so tests do not depend on the caller's cwd.
  // Dev keys are gitignored, so generate them on first run rather than making
  // `bun test` fail on a fresh clone.
  await ensureDevKeys();
  process.env.KEY_DOCUMENT_PATH ??= join(REPO_ROOT, 'config/keys/current.json');
  process.env.ISSUER_PRIVATE_KEY_PATH ??= join(REPO_ROOT, 'config/keys/current.pem');

  // Overridden via DI rather than process.env, which would leak between the
  // spec files bun runs in one process.
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (Object.keys(overrides).length > 0) {
    builder.overrideProvider(ISSUER_CONFIG).useValue({ ...loadIssuerConfig(), ...overrides });
  }
  const moduleRef = await builder.compile();
  const app: INestApplication = moduleRef.createNestApplication();
  await app.listen(0);

  return {
    url: await app.getUrl(),
    config: app.get<IssuerConfig>(ISSUER_CONFIG),
    keyDocument: app.get(KeysService).current(),
    dataSource: app.get(DataSource),
    close: () => app.close(),
  };
}

/**
 * Real RFC 9474 blinded messages. Random bytes of the right length are NOT
 * valid input once the issuer signs for real: a blinded message must be less
 * than the modulus, so random ones are rejected roughly a quarter of the time.
 */
export async function validBlanks(
  harness: IssuerHarness,
  count = harness.config.bundleSize,
): Promise<string[]> {
  const prepared = await new RsaBlinder().prepare(count, harness.keyDocument.pubkey);
  return [...prepared.blindedBlanks];
}

/**
 * Right length, but never a valid blinded message: all-ones exceeds any RSA
 * modulus of the same width, so this is deterministic where random bytes would
 * land in range roughly three times in four.
 */
export function outOfRangeBlanks(config: IssuerConfig, count = config.bundleSize): string[] {
  const blank = Buffer.alloc(config.blankSizeBytes, 0xff).toString('base64');
  return Array.from({ length: count }, () => blank);
}

export function claimHeader(paymentRef: string): string {
  const claim = { payment_ref: paymentRef, amount: '1.00', route_id: 'route-1', proxy_sig: 'stub' };
  return Buffer.from(JSON.stringify(claim), 'utf8').toString('base64url');
}

/** Fresh per call, so rate-limit budgets never carry between tests or runs. */
export function uniquePaymentRef(): string {
  return `pay-${randomUUID()}`;
}

export interface PostBundleOptions {
  /** null omits the claim header entirely. Defaults to a fresh unique ref. */
  readonly paymentRef?: string | null;
  readonly idempotencyKey?: string;
}

export function postBundle(
  harness: IssuerHarness,
  body: unknown,
  options: PostBundleOptions = {},
): Promise<Response> {
  const { paymentRef = uniquePaymentRef(), idempotencyKey } = options;
  return fetch(`${harness.url}/v1/bundles`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(paymentRef === null ? {} : { 'x-payment-claim': claimHeader(paymentRef) }),
      ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
    },
    body: JSON.stringify(body),
  });
}

export async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? '<no error code in body>';
}
