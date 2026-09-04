import type { IssuedCredential, PreparedBundle } from './blinding';
import type { BundleParameters, BundleResponse, KeyDocument } from './types';

export const BLIND_SIGNATURE_SUITE = 'RSABSSA-SHA384-PSS-Randomized';

export interface CheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ConformanceReport {
  readonly checks: readonly CheckResult[];
  readonly passed: boolean;
}

export function report(checks: readonly CheckResult[]): ConformanceReport {
  return { checks, passed: checks.every((check) => check.passed) };
}

export function failures(report: ConformanceReport): readonly CheckResult[] {
  return report.checks.filter((check) => !check.passed);
}

const MAX_REPORTED_OFFENDERS = 3;

const pass = (name: string, detail: string): CheckResult => ({ name, passed: true, detail });
const fail = (name: string, detail: string): CheckResult => ({ name, passed: false, detail });

function decodeStrict(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

export function checkBundle(
  response: BundleResponse,
  expectedEpoch: string,
  parameters: BundleParameters,
): ConformanceReport {
  const blobs = response?.blind_signatures;

  if (!Array.isArray(blobs)) {
    return report([fail('bundle shape', 'response has no blind_signatures array')]);
  }

  const checks: CheckResult[] = [
    blobs.length === parameters.bundleSize
      ? pass('bundle count', `${blobs.length} blobs, as configured`)
      : fail('bundle count', `expected ${parameters.bundleSize} blobs, got ${blobs.length}`),
    checkSignatureSize(blobs, parameters.signatureSizeBytes),
    response.epoch === expectedEpoch
      ? pass('epoch echoed', `epoch ${response.epoch}`)
      : fail('epoch echoed', `expected epoch ${expectedEpoch}, got ${String(response.epoch)}`),
  ];
  return report(checks);
}

/** Named "signature size" so a failure identifies the size assertion by name. */
function checkSignatureSize(blobs: readonly unknown[], expectedBytes: number): CheckResult {
  const offenders = blobs.flatMap((blob, index) => {
    const decoded = decodeStrict(blob);
    if (decoded === null) return [`blob ${index} is not valid base64`];
    if (decoded.byteLength !== expectedBytes) {
      return [`blob ${index} decoded to ${decoded.byteLength} bytes`];
    }
    return [];
  });

  if (offenders.length === 0) {
    return pass('signature size', `all ${blobs.length} blobs are ${expectedBytes} bytes`);
  }
  // Truncated: a wholly nonconforming issuer would otherwise print one line per blob.
  const shown = offenders.slice(0, MAX_REPORTED_OFFENDERS).join('; ');
  const rest = offenders.length - MAX_REPORTED_OFFENDERS;
  return fail(
    'signature size',
    `expected ${expectedBytes} bytes: ${shown}${rest > 0 ? ` (and ${rest} more)` : ''}`,
  );
}

export function checkKeyDocument(document: KeyDocument): ConformanceReport {
  const fields = ['epoch_id', 'not_before', 'not_after', 'alg', 'pubkey'] as const;
  const missing = fields.filter(
    (field) => typeof document?.[field] !== 'string' || document[field].length === 0,
  );

  if (missing.length > 0) {
    return report([fail('key document fields', `missing or empty: ${missing.join(', ')}`)]);
  }

  const notBefore = Date.parse(document.not_before);
  const notAfter = Date.parse(document.not_after);

  return report([
    pass('key document fields', `epoch ${document.epoch_id}`),
    document.alg === BLIND_SIGNATURE_SUITE
      ? pass('key document suite', document.alg)
      : fail('key document suite', `expected ${BLIND_SIGNATURE_SUITE}, got ${document.alg}`),
    Number.isFinite(notBefore) && Number.isFinite(notAfter) && notBefore < notAfter
      ? pass('key document validity window', `${document.not_before} to ${document.not_after}`)
      : fail(
          'key document validity window',
          `not_before ${document.not_before} must precede not_after ${document.not_after}`,
        ),
  ]);
}

/**
 * The M1.1 property: unblind the issuer's blind signatures and verify each one
 * under the epoch public key. A signature that does not verify means the buyer
 * paid for a credential no exit will honour, so this is the check that matters
 * most once issuance is real.
 */
export async function checkSignaturesVerify(
  prepared: PreparedBundle,
  blindSignatures: readonly string[],
): Promise<{ check: CheckResult; credentials: readonly IssuedCredential[] }> {
  const name = 'signature verifies';

  let credentials: readonly IssuedCredential[];
  try {
    credentials = await prepared.finalize(blindSignatures);
  } catch (error) {
    return {
      check: fail(name, `could not unblind: ${(error as Error).message}`),
      credentials: [],
    };
  }

  const invalid: number[] = [];
  for (const [index, credential] of credentials.entries()) {
    if (!(await prepared.verify(credential))) invalid.push(index);
  }

  if (invalid.length > 0) {
    const shown = invalid.slice(0, MAX_REPORTED_OFFENDERS).join(', ');
    const rest = invalid.length - MAX_REPORTED_OFFENDERS;
    return {
      check: fail(
        name,
        `did not verify under the epoch public key: blob ${shown}${rest > 0 ? ` (and ${rest} more)` : ''}`,
      ),
      credentials,
    };
  }

  return {
    check: pass(name, `all ${credentials.length} signatures verify under the epoch public key`),
    credentials,
  };
}
