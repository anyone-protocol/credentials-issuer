export const VECTOR_SUITE = 'RSABSSA-SHA384-PSS-Randomized';
export const VECTOR_FILE = 'test-vectors/rsabssa-sha384-pss-randomized.json';

/**
 * One RFC 9474 test vector. All byte fields are hex, following the style of the
 * RFC's own vectors.
 *
 * The private key is published on purpose: these are throwaway test keys whose
 * whole reason to exist is letting an independent implementation reproduce
 * blind_sig. They are not, and must never be, an issuer's epoch key.
 */
export interface TestVector {
  readonly name: string;
  /** Which implementation produced it: blindrsa-ts or circl-go. */
  readonly origin: string;
  readonly modulus_bits: number;
  readonly private_key_pkcs8: string;
  readonly public_key_spki: string;
  readonly prepared_msg: string;
  readonly blinded_msg: string;
  readonly blind_sig: string;
  /**
   * Blind inverse. Present only on blindrsa-ts vectors: CIRCL's Finalize takes
   * an opaque State, so it cannot export or re-consume one.
   */
  readonly inv?: string;
  readonly sig: string;
}

export interface TestVectorFile {
  readonly suite: string;
  readonly vectors: readonly TestVector[];
}
