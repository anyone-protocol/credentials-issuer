import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { readFile } from 'node:fs/promises';
import { DEV_KEYRING, DEV_PROXY_KEY_PEM, DEV_ROOT_KEY, ensureDevKeys } from '../../../../scripts/generate-dev-keys';
import {
  importProxySigningKey,
  signPaymentClaim,
} from '../../../../packages/buyer-harness/src/claim';
import { RsaBlinder, type PreparedBundle } from '../../../../packages/buyer-harness/src/blinding';
import { AppModule } from '../app.module';
import { ISSUER_CONFIG, loadIssuerConfig, type IssuerConfig } from '../config/issuer.config';
import type { KeyDocument } from '../keys/key-document';
import { KeysService } from '../keys/keys.service';

const REPO_ROOT = join(import.meta.dir, '../../../..');

export interface IssuerHarness {
  readonly url: string;
  readonly app: INestApplication;
  readonly config: IssuerConfig;
  readonly keyDocument: KeyDocument;
  readonly dataSource: DataSource;
  close(): Promise<void>;
}

/**
 * A complete config with overrides applied. Tests must not hand-build partial
 * configs: a missing field reads as undefined and fails in ways that look like
 * the code under test (a missing timeout fires at 0ms, not never).
 */
export function testIssuerConfig(overrides: Partial<IssuerConfig> = {}): IssuerConfig {
  return { ...loadIssuerConfig(), ...overrides };
}

export async function startIssuer(
  overrides: Partial<IssuerConfig> = {},
): Promise<IssuerHarness> {
  // Resolved from the source tree so tests do not depend on the caller's cwd.
  // Dev keys are gitignored, so generate them on first run rather than making
  // `bun test` fail on a fresh clone.
  await ensureDevKeys();
  process.env.KEYRING_PATH ??= DEV_KEYRING;

  // Overridden via DI rather than process.env, which would leak between the
  // spec files bun runs in one process.
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (Object.keys(overrides).length > 0) {
    builder.overrideProvider(ISSUER_CONFIG).useValue(testIssuerConfig(overrides));
  }
  const moduleRef = await builder.compile();
  const app: INestApplication = moduleRef.createNestApplication();
  await app.listen(0);

  return {
    app,
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
  return [...(await prepareBundle(harness, count)).blindedBlanks];
}

/** Keeps the blinding state, so the caller can finalize and verify (M1.1, M2.2). */
export function prepareBundle(
  harness: IssuerHarness,
  count = harness.config.bundleSize,
): Promise<PreparedBundle> {
  return new RsaBlinder().prepare(count, harness.keyDocument.pubkey);
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

let proxySigningKey: Promise<CryptoKey> | undefined;

/** A claim signed with the dev proxy key, as the fronting proxy would send. */
export function claimHeader(
  paymentRef: string,
  overrides: { amount?: string; routeId?: string } = {},
): Promise<string> {
  proxySigningKey ??= readFile(DEV_PROXY_KEY_PEM, 'utf8').then(importProxySigningKey);
  return proxySigningKey.then((key) =>
    signPaymentClaim(
      {
        payment_ref: paymentRef,
        amount: overrides.amount ?? '1.00',
        route_id: overrides.routeId ?? 'route-1',
      },
      key,
    ),
  );
}

/** Fresh per call, so rate-limit budgets never carry between tests or runs. */
export function uniquePaymentRef(): string {
  return `pay-${randomUUID()}`;
}

export interface PostBundleOptions {
  /** null omits the claim header entirely. Defaults to a fresh unique ref. */
  readonly paymentRef?: string | null;
  readonly idempotencyKey?: string;
  /** Overrides the claim header verbatim, for malformed-claim tests. */
  readonly claim?: string | null;
  /** Claimed amount, for price-mismatch tests. */
  readonly amount?: string;
}

export async function postBundle(
  harness: IssuerHarness,
  body: unknown,
  options: PostBundleOptions = {},
): Promise<Response> {
  const { paymentRef = uniquePaymentRef(), idempotencyKey, claim, amount } = options;
  const header =
    claim !== undefined ? claim : paymentRef === null ? null : await claimHeader(paymentRef, { amount });

  return fetch(`${harness.url}/v1/bundles`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(header === null ? {} : { 'x-payment-claim': header }),
      ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
    },
    body: JSON.stringify(body),
  });
}

/** A fresh entitlement, due for its first drip immediately (M2.1). */
export async function registerEntitlement(
  harness: IssuerHarness,
  receipt = `receipt-${randomUUID()}`,
): Promise<{ entitlement_id: string; next_drip_at: string }> {
  const response = await fetch(`${harness.url}/v1/entitlements`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ receipt }),
  });
  if (response.status !== 201) {
    throw new Error(`entitlement registration failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as { entitlement_id: string; next_drip_at: string };
}

export function postPickup(
  harness: IssuerHarness,
  entitlementId: string | null,
  body: unknown,
  options: { idempotencyKey?: string } = {},
): Promise<Response> {
  return fetch(`${harness.url}/v1/entitlements/pickup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(entitlementId === null ? {} : { 'x-entitlement': entitlementId }),
      ...(options.idempotencyKey === undefined
        ? {}
        : { 'idempotency-key': options.idempotencyKey }),
    },
    body: JSON.stringify(body),
  });
}

export async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? '<no error code in body>';
}

export { DEV_KEYRING, DEV_ROOT_KEY };
