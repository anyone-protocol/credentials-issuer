import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { EntityManager, Repository } from 'typeorm';
import { ISSUER_CONFIG, type IssuerConfig } from '../config/issuer.config';
import { IssuerException } from '../errors/issuer.exception';
import { IssuanceService, type BundleResponse, type IssuanceGrant } from '../issuance/issuance.service';
import { Entitlement } from './entitlement.entity';
import { ReceiptValidator } from './receipt-validator.service';

export interface EntitlementResponse {
  readonly entitlement_id: string;
  readonly next_drip_at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The fiat rail (M2.1). A validated receipt buys a drip schedule; a due drip
 * authorizes exactly one bundle through the shared issuance path, so the
 * credentials it produces are indistinguishable from bought ones (M2.2).
 */
@Injectable()
export class EntitlementsService {
  constructor(
    @Inject(ISSUER_CONFIG) private readonly config: IssuerConfig,
    @InjectRepository(Entitlement) private readonly entitlements: Repository<Entitlement>,
    private readonly receipts: ReceiptValidator,
    private readonly issuance: IssuanceService,
  ) {}

  /**
   * Idempotent in the receipt: one subscription is one entitlement no matter
   * how often it is presented. Minting a second entitlement from the same
   * receipt would be a second drip schedule nobody paid for (I6).
   */
  async register(body: unknown): Promise<EntitlementResponse> {
    if (typeof body !== 'object' || body === null) {
      throw new IssuerException('REQUEST_INVALID', 'request body must be a JSON object');
    }
    const { subscriptionId } = await this.receipts.validate((body as Record<string, unknown>).receipt);
    const receiptHash = createHash('sha256').update(subscriptionId).digest('hex');

    // The first drip is due on registration: the subscriber has already paid.
    await this.entitlements.query(
      `INSERT INTO entitlement
         (entitlement_id, receipt_hash, drip_interval_seconds, next_drip_at, drips_issued, created_at)
       VALUES ($1, $2, $3, now(), 0, now())
       ON CONFLICT (receipt_hash) DO NOTHING`,
      [randomUUID(), receiptHash, this.config.entitlementDripIntervalSeconds],
    );

    const entitlement = await this.entitlements.findOneBy({ receiptHash });
    if (!entitlement) throw new Error('entitlement disappeared immediately after registration');
    return {
      entitlement_id: entitlement.entitlementId,
      next_drip_at: entitlement.nextDripAt.toISOString(),
    };
  }

  async pickup(
    entitlementId: string | undefined,
    idempotencyKey: string | undefined,
    body: unknown,
  ): Promise<BundleResponse> {
    const schedule = await this.schedule(entitlementId);

    // Checked before the schedule, so a client that retried a request whose
    // response it never saw gets its credentials back rather than NOT_DUE.
    const replay =
      idempotencyKey !== undefined && (await this.issuance.isReplay(schedule.id, idempotencyKey));

    if (!replay && !schedule.due) {
      throw new IssuerException(
        'NOT_DUE',
        `next drip is not due until ${schedule.nextDripAt.toISOString()}`,
      );
    }

    // On a replay the issuance transaction aborts on the claimed idempotency
    // key before consume runs, so the schedule advances exactly once.
    const grant: IssuanceGrant = {
      reference: schedule.id,
      consume: (manager) => this.advance(manager, schedule.id, schedule.intervalSeconds),
    };
    return this.issuance.issue(grant, idempotencyKey, body);
  }

  /** Dueness is read from the database clock, the same one advance() writes. */
  private async schedule(entitlementId: string | undefined): Promise<{
    id: string;
    due: boolean;
    nextDripAt: Date;
    intervalSeconds: number;
  }> {
    if (typeof entitlementId !== 'string' || !UUID.test(entitlementId)) {
      throw new IssuerException('ENTITLEMENT_UNKNOWN', 'no valid entitlement was presented');
    }
    const [row] = (await this.entitlements.query(
      `SELECT drip_interval_seconds, next_drip_at, next_drip_at <= now() AS due
         FROM entitlement WHERE entitlement_id = $1`,
      [entitlementId],
    )) as { drip_interval_seconds: number; next_drip_at: Date; due: boolean }[];

    if (!row) throw new IssuerException('ENTITLEMENT_UNKNOWN', 'no such entitlement');
    return {
      id: entitlementId,
      due: row.due,
      nextDripAt: row.next_drip_at,
      intervalSeconds: row.drip_interval_seconds,
    };
  }

  /**
   * Claims the due drip and advances the schedule, in one conditional update
   * inside the issuance transaction. Two concurrent pickups therefore issue
   * once: the loser re-reads a schedule that is no longer due and rolls back.
   *
   * Missed drips do not accumulate -- the next one is an interval from now,
   * not from when this one fell due -- so a long-idle subscriber cannot pick
   * up a burst of bundles at once.
   */
  private async advance(
    manager: EntityManager,
    entitlementId: string,
    intervalSeconds: number,
  ): Promise<void> {
    const claimed = await manager
      .createQueryBuilder()
      .update(Entitlement)
      .set({
        nextDripAt: () => 'now() + make_interval(secs => :interval)',
        dripsIssued: () => 'drips_issued + 1',
      })
      .setParameter('interval', intervalSeconds)
      .where('entitlement_id = :id', { id: entitlementId })
      .andWhere('next_drip_at <= now()')
      .execute();

    if (claimed.affected === 0) {
      throw new IssuerException('NOT_DUE', 'next drip was already picked up');
    }
  }
}
