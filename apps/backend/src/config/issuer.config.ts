export const ISSUER_CONFIG = Symbol('ISSUER_CONFIG');

export interface IssuerConfig {
  /** k: credentials per bundle (I3). Provisional until the 0.3 spec lands. */
  readonly bundleSize: number;
  readonly blankSizeBytes: number;
  readonly signatureSizeBytes: number;
  readonly keyDocumentPath: string;
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
  };
}
