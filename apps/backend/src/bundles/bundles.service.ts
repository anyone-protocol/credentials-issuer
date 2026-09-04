import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { ISSUER_CONFIG, type IssuerConfig } from '../config/issuer.config';
import { IssuerException } from '../errors/issuer.exception';
import { IdempotencyRecord } from '../issuance/idempotency-record.entity';
import { IssuanceRecord } from '../issuance/issuance-record.entity';
import type { PaymentClaim } from '../payment/payment-claim';
import { RateLimiter } from '../payment/rate-limiter.service';
import { validateBundleRequest, type BundleRequest } from './bundle-request';
import { stubBlindSignature } from './stub-signing';

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
    private readonly dataSource: DataSource,
  ) {}

  async purchase(
    claim: PaymentClaim,
    idempotencyKey: string | undefined,
    body: unknown,
  ): Promise<BundleResponse> {
    // Ahead of validation, so cheap malformed floods cost budget too.
    if (!(await this.rateLimiter.allow(claim.payment_ref))) {
      throw new IssuerException('RATE_LIMITED', 'too many requests for this payment_ref');
    }

    const request = validateBundleRequest(body, this.config);

    if (idempotencyKey) {
      await this.claimKeyAndCount(claim.payment_ref, idempotencyKey, request);
    } else {
      await this.records.insert({
        paymentRef: claim.payment_ref,
        epoch: request.epoch,
        bundleCount: 1,
      });
    }

    return {
      epoch: request.epoch,
      // Deterministic, so a replay reproduces the original response without
      // the issuer having stored it (I2, I5). See stub-signing.ts.
      blind_signatures: request.blinded_blanks.map((blank) =>
        stubBlindSignature(request.epoch, blank, this.config.signatureSizeBytes),
      ),
    };
  }

  /**
   * Claims the idempotency key and counts the issuance in one transaction, so
   * a crash between the two cannot leave a claimed key with no issuance. On
   * replay the issuance is not counted a second time.
   */
  private async claimKeyAndCount(
    paymentRef: string,
    idempotencyKey: string,
    request: BundleRequest,
  ): Promise<void> {
    const fingerprint = fingerprintRequest(paymentRef, request);

    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.insert(IdempotencyRecord, {
          paymentRef,
          idempotencyKey,
          requestFingerprint: fingerprint,
        });
        await manager.insert(IssuanceRecord, { paymentRef, epoch: request.epoch, bundleCount: 1 });
      });
      return;
    } catch (error) {
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
  }
}

/** SHA-256 over the request. A fingerprint, never the blanks themselves (I2). */
function fingerprintRequest(paymentRef: string, request: BundleRequest): string {
  const hash = createHash('sha256').update(paymentRef).update('\0').update(request.epoch);
  for (const blank of request.blinded_blanks) hash.update('\0').update(blank);
  return hash.digest('hex');
}
