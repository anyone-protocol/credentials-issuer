export const ISSUER_CONFIG = Symbol('ISSUER_CONFIG');

export interface IssuerConfig {
  /** k: credentials per bundle (I3). Provisional until the 0.3 spec lands. */
  readonly bundleSize: number;
  readonly blankSizeBytes: number;
  readonly signatureSizeBytes: number;
  /** Epoch keyring. Rendered from Vault by a Nomad template; see README. */
  readonly keyringPath: string;
  readonly keyringReloadSeconds: number;
  /** Requests per window, per payment_ref. Never per IP (I5). */
  readonly rateLimitMax: number;
  readonly rateLimitWindowSeconds: number;
  /** Ed25519 public key of the fronting proxy, SPKI PEM (M1.4). */
  readonly proxyPublicKeyPath: string;
  /** Price of one bundle, as an exact decimal string. */
  readonly bundlePrice: string;
  readonly reconciliationIntervalSeconds: number;
  /** Blind-signing worker threads, or 0 to sign inline on the main thread. */
  readonly signingWorkers: number;
  /** Use the RSA-RAW fast path. Off falls back to the library's pure-JS path. */
  readonly useNativeRsa: boolean;
  /** Bounds one signing task, so a wedged worker cannot strand a request. */
  readonly signingTimeoutMs: number;
  /** How often a fiat entitlement becomes due for one bundle (M2.1). */
  readonly entitlementDripIntervalSeconds: number;
}

function nonNegativeInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function loadIssuerConfig(env: NodeJS.ProcessEnv = process.env): IssuerConfig {
  return {
    bundleSize: positiveInt(env.BUNDLE_SIZE, 10, 'BUNDLE_SIZE'),
    blankSizeBytes: positiveInt(env.BLANK_SIZE_BYTES, 256, 'BLANK_SIZE_BYTES'),
    signatureSizeBytes: positiveInt(env.SIGNATURE_SIZE_BYTES, 256, 'SIGNATURE_SIZE_BYTES'),
    keyringPath: env.KEYRING_PATH ?? 'config/keys/keyring.json',
    keyringReloadSeconds: positiveInt(env.KEYRING_RELOAD_SECONDS, 30, 'KEYRING_RELOAD_SECONDS'),
    rateLimitMax: positiveInt(env.RATE_LIMIT_MAX, 60, 'RATE_LIMIT_MAX'),
    rateLimitWindowSeconds: positiveInt(env.RATE_LIMIT_WINDOW_SECONDS, 60, 'RATE_LIMIT_WINDOW_SECONDS'),
    proxyPublicKeyPath: env.PROXY_PUBLIC_KEY_PATH ?? 'config/keys/proxy.pub.pem',
    bundlePrice: env.BUNDLE_PRICE ?? '1.00',
    reconciliationIntervalSeconds: positiveInt(
      env.RECONCILIATION_INTERVAL_SECONDS,
      60,
      'RECONCILIATION_INTERVAL_SECONDS',
    ),
    signingWorkers: nonNegativeInt(env.SIGNING_WORKERS, 4, 'SIGNING_WORKERS'),
    useNativeRsa: (env.SIGNING_NATIVE_RSA ?? 'true') !== 'false',
    signingTimeoutMs: positiveInt(env.SIGNING_TIMEOUT_MS, 10_000, 'SIGNING_TIMEOUT_MS'),
    entitlementDripIntervalSeconds: positiveInt(
      env.ENTITLEMENT_DRIP_INTERVAL_SECONDS,
      86_400,
      'ENTITLEMENT_DRIP_INTERVAL_SECONDS',
    ),
  };
}
