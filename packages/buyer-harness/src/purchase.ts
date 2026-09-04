import { RsaBlinder, type Blinder, type IssuedCredential } from './blinding';
import { IssuerClient, type IssuerClientOptions, type PaymentFlow } from './client';
import {
  checkBundle,
  checkKeyDocument,
  checkSignaturesVerify,
  report,
  type ConformanceReport,
} from './conformance';
import { DEFAULT_BUNDLE_PARAMETERS, type BundleParameters, type BundleResponse } from './types';

export interface PurchaseOptions extends IssuerClientOptions {
  readonly parameters?: BundleParameters;
  /** Defaults to the epoch advertised by the issuer's key document. */
  readonly epoch?: string;
  readonly blinder?: Blinder;
}

export interface PurchaseResult {
  readonly epoch: string;
  /** `402-retry` when a fronting proxy demanded payment before issuing. */
  readonly paymentFlow: PaymentFlow;
  readonly response: BundleResponse;
  /** Empty when the signatures could not be unblinded. */
  readonly credentials: readonly IssuedCredential[];
  readonly conformance: ConformanceReport;
}

/**
 * One full buy: read the key document, blind k blanks, purchase, unblind, and
 * verify the result under the epoch public key. This is the library entry
 * point; the CLI is a thin wrapper so the same flow can be embedded in TOON's
 * tooling or a future agent SDK.
 */
export async function purchaseBundle(options: PurchaseOptions): Promise<PurchaseResult> {
  const parameters = options.parameters ?? DEFAULT_BUNDLE_PARAMETERS;
  const blinder = options.blinder ?? new RsaBlinder();
  const client = new IssuerClient(options);

  const keyDocument = await client.keyDocument();
  const keyChecks = checkKeyDocument(keyDocument);
  const epoch = options.epoch ?? keyDocument.epoch_id;

  const prepared = await blinder.prepare(parameters.bundleSize, keyDocument.pubkey);
  const response = await client.purchaseBundle({
    epoch,
    blinded_blanks: prepared.blindedBlanks,
  });

  const bundleChecks = checkBundle(response, epoch, parameters);
  const { check, credentials } = await checkSignaturesVerify(prepared, response.blind_signatures);

  return {
    epoch,
    paymentFlow: client.paymentFlow,
    response,
    credentials,
    conformance: report([...keyChecks.checks, ...bundleChecks.checks, check]),
  };
}
