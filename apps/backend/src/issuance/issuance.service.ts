import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { EpochCounters } from '../accounting/epoch-counters.service';
import { ISSUER_CONFIG, type IssuerConfig } from '../config/issuer.config';
import { IssuerException } from '../errors/issuer.exception';
import { KeysService } from '../keys/keys.service';
import { RateLimiter } from '../payment/rate-limiter.service';
import { BlindSigner } from '../signing/blind-signer.service';
import { validateBundleRequest, type BundleRequest } from './bundle-request';
import { IdempotencyRecord } from './idempotency-record.entity';
import { IssuanceRecord } from './issuance-record.entity';

/**
 * The wire format of an issued bundle. One type for both rails: a credential
 * bought with crypto and one picked up from a fiat entitlement are the same
 * bytes, and no field here names the rail that produced them (M2.2).
 */
export interface BundleResponse {
  readonly epoch: string;
  readonly blind_signatures: readonly string[];
}

/**
 * Authorization to issue one bundle, already established by the caller. The
 * paid rail proves it with the proxy's payment claim (M1.4), the fiat rail
 * with a due entitlement drip (M2.1); below this point the two are identical.
 */
export interface IssuanceGrant {
  /** Ledger reference and rate-limit key: payment_ref, or entitlement_id. */
  readonly reference: string;
  /**
   * Consumes the grant inside the issuance transaction. Throwing rolls the
   * whole issuance back, so a grant that cannot be consumed issues nothing
   * even if it looked available when the caller checked.
   */
  consume?(manager: EntityManager): Promise<void>;
}

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; driverError?: { code?: string } };
  return e?.code === UNIQUE_VIOLATION || e?.driverError?.code === UNIQUE_VIOLATION;
}

@Injectable()
export class IssuanceService {
  constructor(
    @Inject(ISSUER_CONFIG) private readonly config: IssuerConfig,
    @InjectRepository(IssuanceRecord) private readonly records: Repository<IssuanceRecord>,
    @InjectRepository(IdempotencyRecord) private readonly keys: Repository<IdempotencyRecord>,
    private readonly rateLimiter: RateLimiter,
    private readonly signer: BlindSigner,
    private readonly epochCounters: EpochCounters,
    private readonly keyring: KeysService,
    private readonly dataSource: DataSource,
  ) {}

  async issue(
    grant: IssuanceGrant,
    idempotencyKey: string | undefined,
    body: unknown,
  ): Promise<BundleResponse> {
    if (!(await this.rateLimiter.allow(grant.reference))) {
      throw new IssuerException('RATE_LIMITED', 'too many requests for this reference');
    }

    const request = validateBundleRequest(body, this.config);

    // Checked before signing, so an epoch past its grace window signs nothing.
    if (!this.keyring.usable(request.epoch)) {
      throw new IssuerException('WRONG_EPOCH', `epoch ${request.epoch} is not currently signable`);
    }

    // Signed before the transaction opens. Blind signing is CPU-bound, and
    // holding a database connection across it exhausts the pool under load.
    // Nothing is delivered unless the record commits, so a failure after this
    // point still issues nothing: the caller gets an error, not signatures.
    const response = await this.signBundle(request);

    const { reference } = grant;
    if (!idempotencyKey) {
      await this.record(grant, request, response);
      return response;
    }

    const fingerprint = fingerprintRequest(reference, request);
    try {
      await this.record(grant, request, response, { idempotencyKey, fingerprint });
      return response;
    } catch (error) {
      // Only a claimed key means replay. Anything else propagates with the
      // transaction already rolled back.
      if (!isUniqueViolation(error)) throw error;
    }

    // Key already claimed. Reusing it for a different request would issue
    // signatures without counting them, which is overissuance (M1.3).
    const existing = await this.keys.findOneBy({ paymentRef: reference, idempotencyKey });
    if (existing?.requestFingerprint !== fingerprint) {
      throw new IssuerException(
        'IDEMPOTENCY_CONFLICT',
        'idempotency key was already used for a different request',
      );
    }
    // Replay: BlindSign is deterministic, so this is byte-identical to the
    // original response and the issuer never had to store one (I2, I5).
    return response;
  }

  /** True when this reference has already issued under this idempotency key. */
  async isReplay(reference: string, idempotencyKey: string): Promise<boolean> {
    return (await this.keys.countBy({ paymentRef: reference, idempotencyKey })) > 0;
  }

  /**
   * The ledger row, the idempotency claim, both epoch counters and the grant's
   * own bookkeeping commit together, so a purchase can never be half-recorded.
   */
  private record(
    grant: IssuanceGrant,
    request: BundleRequest,
    response: BundleResponse,
    idempotency?: { idempotencyKey: string; fingerprint: string },
  ): Promise<void> {
    return this.dataSource.transaction(async (manager) => {
      // First, so a replayed key aborts the transaction before anything else
      // runs -- including the grant's consume, which must not fire twice.
      if (idempotency) {
        await manager.insert(IdempotencyRecord, {
          paymentRef: grant.reference,
          idempotencyKey: idempotency.idempotencyKey,
          requestFingerprint: idempotency.fingerprint,
        });
      }
      await manager.insert(IssuanceRecord, {
        paymentRef: grant.reference,
        epoch: request.epoch,
        bundleCount: 1,
      });
      await this.epochCounters.recordBundlePaid(manager, request.epoch, this.config.bundleSize);

      // Counted from what the signer actually produced, not from k. If those
      // ever differ, reconciliation is the thing that notices (M1.3).
      await this.epochCounters.recordSignaturesIssued(
        manager,
        request.epoch,
        response.blind_signatures.length,
        this.config.bundleSize,
      );

      await grant.consume?.(manager);
    });
  }

  private async signBundle(request: BundleRequest): Promise<BundleResponse> {
    return {
      epoch: request.epoch,
      blind_signatures: await Promise.all(
        request.blinded_blanks.map((blank) => this.signer.signBlindedBlank(request.epoch, blank)),
      ),
    };
  }
}

/** SHA-256 over the request. A fingerprint, never the blanks themselves (I2). */
function fingerprintRequest(reference: string, request: BundleRequest): string {
  const hash = createHash('sha256').update(reference).update('\0').update(request.epoch);
  for (const blank of request.blinded_blanks) hash.update('\0').update(blank);
  return hash.digest('hex');
}
