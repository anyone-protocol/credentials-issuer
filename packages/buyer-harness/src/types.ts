/**
 * The issuer's wire format, declared independently of the server implementation
 * so this package stays a standalone conformance tool: it must be able to judge
 * any issuer, including one that is not this repo's.
 */
export interface KeyDocument {
  readonly epoch_id: string;
  readonly not_before: string;
  readonly not_after: string;
  readonly alg: string;
  readonly pubkey: string;
}

export interface BundleRequest {
  readonly epoch: string;
  readonly blinded_blanks: readonly string[];
}

export interface BundleResponse {
  readonly epoch: string;
  readonly blind_signatures: readonly string[];
}

export interface IssuerErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

/** Shape both a bundle and its blanks must satisfy. Binds to the 0.3 spec later. */
export interface BundleParameters {
  /** k */
  readonly bundleSize: number;
  readonly blankSizeBytes: number;
  readonly signatureSizeBytes: number;
}

export const DEFAULT_BUNDLE_PARAMETERS: BundleParameters = {
  bundleSize: 10,
  blankSizeBytes: 256,
  signatureSizeBytes: 256,
};
