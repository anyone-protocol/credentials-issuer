import { decodeStrictBase64 } from '../errors/base64';
import { IssuerException } from '../errors/issuer.exception';
import type { IssuerConfig } from '../config/issuer.config';

export interface BundleRequest {
  readonly epoch: string;
  readonly blinded_blanks: readonly string[];
}

/**
 * Validates shape, count and blank sizes. Checks run count-before-format, so a
 * request that is both over-count and malformed reports BUNDLE_SIZE.
 *
 * I2: blanks are measured and discarded. Decoded bytes never leave this
 * function, and no branch here may log or persist them.
 */
export function validateBundleRequest(body: unknown, config: IssuerConfig): BundleRequest {
  if (typeof body !== 'object' || body === null) {
    throw new IssuerException('REQUEST_INVALID', 'request body must be a JSON object');
  }
  const { epoch, blinded_blanks: blanks } = body as Record<string, unknown>;

  if (typeof epoch !== 'string' || epoch.length === 0) {
    throw new IssuerException('REQUEST_INVALID', 'epoch must be a non-empty string');
  }
  if (!Array.isArray(blanks)) {
    throw new IssuerException('BLANK_FORMAT', 'blinded_blanks must be an array of base64 strings');
  }
  if (blanks.length !== config.bundleSize) {
    throw new IssuerException(
      'BUNDLE_SIZE',
      `expected exactly ${config.bundleSize} blinded blanks, got ${blanks.length}`,
    );
  }
  for (const [index, blank] of blanks.entries()) {
    const decoded = decodeStrictBase64(blank);
    if (decoded === null || decoded.byteLength !== config.blankSizeBytes) {
      throw new IssuerException(
        'BLANK_FORMAT',
        `blinded blank at index ${index} must be ${config.blankSizeBytes} base64-encoded bytes`,
      );
    }
  }

  return { epoch, blinded_blanks: blanks as readonly string[] };
}
