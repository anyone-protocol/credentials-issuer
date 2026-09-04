import { RSABSSA } from '@cloudflare/blindrsa-ts';
import type { BlindRSA } from '@cloudflare/blindrsa-ts';
import { KNOWN_ANSWER } from './known-answer';
import { installRsaRawSupport, rsaRawIsNative } from './rsa-raw';

export interface SuiteSelection {
  readonly suite: BlindRSA;
  readonly fastPath: boolean;
  readonly reason: string;
}

const hex = (value: string) => {
  const decoded = Buffer.from(value, 'hex');
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes;
};

/**
 * Builds the signing suite, using the RSA-RAW fast path only if it reproduces a
 * known answer produced by an independent implementation.
 *
 * A fast path that is subtly wrong would mint signatures no exit would honour,
 * so it has to prove itself before it is trusted. Failing the check falls back
 * to the library's pure-JS path rather than refusing to boot: slow issuance
 * beats no issuance, and the worker pool keeps it off the event loop.
 */
export async function selectSigningSuite(useNativeRsa: boolean): Promise<SuiteSelection> {
  const slow = RSABSSA.SHA384.PSS.Randomized();
  if (!useNativeRsa) {
    return { suite: slow, fastPath: false, reason: 'disabled by configuration' };
  }

  if (!(await rsaRawIsNative(hex(KNOWN_ANSWER.privateKeyPkcs8Hex)))) installRsaRawSupport();

  const fast = RSABSSA.SHA384.PSS.Randomized({ supportsRSARAW: true });
  try {
    const key = await crypto.subtle.importKey(
      'pkcs8',
      hex(KNOWN_ANSWER.privateKeyPkcs8Hex),
      { name: 'RSA-PSS', hash: 'SHA-384' },
      true,
      ['sign'],
    );
    const produced = await fast.blindSign(key, hex(KNOWN_ANSWER.blindedMsgHex));
    if (Buffer.from(produced).toString('hex') !== KNOWN_ANSWER.blindSigHex) {
      return {
        suite: slow,
        fastPath: false,
        reason: `known-answer test ${KNOWN_ANSWER.name} produced the wrong signature`,
      };
    }
  } catch (error) {
    return {
      suite: slow,
      fastPath: false,
      reason: `known-answer test threw: ${(error as Error).message}`,
    };
  }

  return { suite: fast, fastPath: true, reason: `known-answer test ${KNOWN_ANSWER.name} passed` };
}
