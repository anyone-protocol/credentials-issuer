import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { EpochCounter } from './epoch-counter.entity';

/**
 * Both increments take the caller's EntityManager so they commit or roll back
 * with the issuance itself. A counter that survived a rolled-back purchase
 * would be a divergence the reconciliation job could never explain.
 */
@Injectable()
export class EpochCounters {
  constructor(
    @InjectRepository(EpochCounter) private readonly counters: Repository<EpochCounter>,
  ) {}

  recordBundlePaid(manager: EntityManager, epoch: string, bundleSize: number): Promise<unknown> {
    return manager.query(
      `INSERT INTO epoch_counter (epoch, bundle_size, bundles_paid, signatures_issued, updated_at)
       VALUES ($1, $2, 1, 0, now())
       ON CONFLICT (epoch) DO UPDATE
         SET bundles_paid = epoch_counter.bundles_paid + 1, updated_at = now()`,
      [epoch, bundleSize],
    );
  }

  recordSignaturesIssued(
    manager: EntityManager,
    epoch: string,
    signatures: number,
    bundleSize: number,
  ): Promise<unknown> {
    return manager.query(
      `INSERT INTO epoch_counter (epoch, bundle_size, bundles_paid, signatures_issued, updated_at)
       VALUES ($1, $2, 0, $3, now())
       ON CONFLICT (epoch) DO UPDATE
         SET signatures_issued = epoch_counter.signatures_issued + $3, updated_at = now()`,
      [epoch, bundleSize, signatures],
    );
  }

  all(): Promise<EpochCounter[]> {
    return this.counters.find({ order: { epoch: 'ASC' } });
  }

  forEpoch(epoch: string): Promise<EpochCounter | null> {
    return this.counters.findOneBy({ epoch });
  }
}
