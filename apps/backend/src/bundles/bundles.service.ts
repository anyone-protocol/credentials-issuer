import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ISSUER_CONFIG, type IssuerConfig } from '../config/issuer.config';
import { IssuerException } from '../errors/issuer.exception';
import { IdempotencyRecord } from '../issuance/idempotency-record.entity';
import { IssuanceRecord } from '../issuance/issuance-record.entity';
import { ClaimRejections } from '../payment/claim-rejections.service';
import { ClaimRejected, ClaimVerifier } from '../payment/claim-verifier.service';
import { parsePaymentClaim, type PaymentClaim } from '../payment/payment-claim';
import { RateLimiter } from '../payment/rate-limiter.service';
import { BlindSigner } from '../signing/blind-signer.service';
import { validateBundleRequest, type BundleRequest } from './bundle-request';

export interface BundleResponse {
  readonly epoch: string;
  readonly blind_signatures: readonly string[];
}

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; driverError?: { code?: string } };
  return e?.code === UNIQUE_VIOLATION || e?.driverError?.code === UNIQUE_VIOLATION;
}

@Injectable()
export class BundlesService {
  constructor(
    @Inject(ISSUER_CONFIG) private readonly config: IssuerConfig,
    @InjectRepository(IssuanceRecord) private readonly records: Repository<IssuanceRecord>,
    @InjectRepository(IdempotencyRecord) private readonly keys: Repository<IdempotencyRecord>,
    private readonly rateLimiter: RateLimiter,
    private readonly signer: BlindSigner,
    private readonly claims: ClaimVerifier,
    private readonly rejections: ClaimRejections,
    private readonly dataSource: DataSource,
  ) {}

  async purchase(
    claimHeader: string | undefined,
    idempotencyKey: string | undefined,
    body: unknown,
  ): Promise<BundleResponse> {
    // Before anything else: an unverified claim must not reach the signer, and
    // must not spend a rate-limit budget it does not own (I6, M1.4).
    const claim = await this.admit(claimHeader);

    if (!(await this.rateLimiter.allow(claim.payment_ref))) {
      throw new IssuerException('RATE_LIMITED', 'too many requests for this payment_ref');
    }

    const request = validateBundleRequest(body, this.config);
    const paymentRef = claim.payment_ref;

    if (!idempotencyKey) {
      return this.countAndSign((manager) => manager.insert(IssuanceRecord, {
        paymentRef,
        epoch: request.epoch,
        bundleCount: 1,
      }), request);
    }

    const fingerprint = fingerprintRequest(paymentRef, request);
    try {
      return await this.countAndSign(async (manager) => {
        await manager.insert(IdempotencyRecord, {
          paymentRef,
          idempotencyKey,
          requestFingerprint: fingerprint,
        });
        await manager.insert(IssuanceRecord, { paymentRef, epoch: request.epoch, bundleCount: 1 });
      }, request);
    } catch (error) {
      // Only a claimed key means replay. A signing failure, or anything else,
      // propagates with the transaction already rolled back.
      if (!isUniqueViolation(error)) throw error;
    }

    // Key already claimed. Reusing it for a different request would issue
    // signatures without counting them, which is overissuance (M1.3).
    const existing = await this.keys.findOneBy({ paymentRef, idempotencyKey });
    if (existing?.requestFingerprint !== fingerprint) {
      throw new IssuerException(
        'IDEMPOTENCY_CONFLICT',
        'idempotency key was already used for a different request',
      );
    }
    // Replay: BlindSign is deterministic, so re-signing reproduces the original
    // response and the issuer never had to store one (I2, I5).
    return this.signBundle(request);
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

  /**
   * Records the issuance and signs in one transaction. Signing inside it is
   * what stops a signing failure leaving a counted purchase behind: the buyer
   * would have been charged for credentials that were never issued.
   */
  private countAndSign(
    record: (manager: EntityManager) => Promise<unknown>,
    request: BundleRequest,
  ): Promise<BundleResponse> {
    return this.dataSource.transaction(async (manager) => {
      await record(manager);
      return this.signBundle(request);
    });
  }

  private async signBundle(request: BundleRequest): Promise<BundleResponse> {
    return {
      epoch: request.epoch,
      blind_signatures: await Promise.all(
        request.blinded_blanks.map((blank) => this.signer.signBlindedBlank(blank)),
      ),
    };
  }
}

/** SHA-256 over the request. A fingerprint, never the blanks themselves (I2). */
function fingerprintRequest(paymentRef: string, request: BundleRequest): string {
  const hash = createHash('sha256').update(paymentRef).update('\0').update(request.epoch);
  for (const blank of request.blinded_blanks) hash.update('\0').update(blank);
  return hash.digest('hex');
}
