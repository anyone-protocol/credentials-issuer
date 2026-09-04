export const ISSUER_CONFIG = Symbol('ISSUER_CONFIG');

export interface IssuerConfig {
  /** k: credentials per bundle (I3). Provisional until the 0.3 spec lands. */
  readonly bundleSize: number;
  readonly blankSizeBytes: number;
  readonly signatureSizeBytes: number;
  readonly keyDocumentPath: string;
  /** Epoch signing key, PKCS#8 PEM. Sourced from Vault from M1.2. */
  readonly privateKeyPath: string;
  /** Requests per window, per payment_ref. Never per IP (I5). */
  readonly rateLimitMax: number;
  readonly rateLimitWindowSeconds: number;
  /** Ed25519 public key of the fronting proxy, SPKI PEM (M1.4). */
  readonly proxyPublicKeyPath: string;
  /** Price of one bundle, as an exact decimal string. */
  readonly bundlePrice: string;
  readonly reconciliationIntervalSeconds: number;
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
    keyDocumentPath: env.KEY_DOCUMENT_PATH ?? 'config/keys/current.json',
    privateKeyPath: env.ISSUER_PRIVATE_KEY_PATH ?? 'config/keys/current.pem',
    rateLimitMax: positiveInt(env.RATE_LIMIT_MAX, 60, 'RATE_LIMIT_MAX'),
    rateLimitWindowSeconds: positiveInt(env.RATE_LIMIT_WINDOW_SECONDS, 60, 'RATE_LIMIT_WINDOW_SECONDS'),
    proxyPublicKeyPath: env.PROXY_PUBLIC_KEY_PATH ?? 'config/keys/proxy.pub.pem',
    bundlePrice: env.BUNDLE_PRICE ?? '1.00',
    reconciliationIntervalSeconds: positiveInt(
      env.RECONCILIATION_INTERVAL_SECONDS,
      60,
      'RECONCILIATION_INTERVAL_SECONDS',
    ),
  };
}
