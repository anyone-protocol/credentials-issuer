import { Injectable } from '@nestjs/common';
import { IssuerException } from '../errors/issuer.exception';
import { IssuanceService, type BundleResponse } from '../issuance/issuance.service';
import { ClaimRejections } from '../payment/claim-rejections.service';
import { ClaimRejected, ClaimVerifier } from '../payment/claim-verifier.service';
import { parsePaymentClaim, type PaymentClaim } from '../payment/payment-claim';

export type { BundleResponse };

/**
 * The crypto rail: the fronting proxy's payment claim authorizes one bundle.
 * Everything after admission is IssuanceService, shared with the fiat rail.
 */
@Injectable()
export class BundlesService {
  constructor(
    private readonly issuance: IssuanceService,
    private readonly claims: ClaimVerifier,
    private readonly rejections: ClaimRejections,
  ) {}

  async purchase(
    claimHeader: string | undefined,
    idempotencyKey: string | undefined,
    body: unknown,
  ): Promise<BundleResponse> {
    // Before anything else: an unverified claim must not reach the signer, and
    // must not spend a rate-limit budget it does not own (I6, M1.4).
    const claim = await this.admit(claimHeader);
    return this.issuance.issue({ reference: claim.payment_ref }, idempotencyKey, body);
  }

  /**
   * Parses and verifies the proxy's proof of payment, counting every rejection
   * so a proxy sending claims we will not honour is visible rather than silent.
   */
  private async admit(claimHeader: string | undefined): Promise<PaymentClaim> {
    let claim: PaymentClaim;
    try {
      claim = parsePaymentClaim(claimHeader);
    } catch (error) {
      await this.rejections.record(claimHeader ? 'malformed' : 'missing');
      throw error;
    }

    try {
      await this.claims.verify(claim);
    } catch (error) {
      if (!(error instanceof ClaimRejected)) throw error;
      await this.rejections.record(error.reason);
      throw new IssuerException('CLAIM_INVALID', error.message);
    }
    return claim;
  }
}
