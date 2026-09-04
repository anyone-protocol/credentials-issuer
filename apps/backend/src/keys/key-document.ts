export const BLIND_SIGNATURE_SUITE = 'RSABSSA-SHA384-PSS-Randomized';

/** The published shape, minus root_sig which the keyring attaches. */
export interface KeyDocument {
  readonly epoch_id: string;
  readonly not_before: string;
  readonly not_after: string;
  readonly alg: string;
  readonly pubkey: string;
}
