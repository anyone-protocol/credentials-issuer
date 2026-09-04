import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClaimRejection } from '../issuance/claim-rejection.entity';
import type { ClaimRejectionReason } from './claim-verifier.service';

@Injectable()
export class ClaimRejections {
  private readonly logger = new Logger(ClaimRejections.name);

  constructor(
    @InjectRepository(ClaimRejection) private readonly counters: Repository<ClaimRejection>,
  ) {}

  /**
   * Atomic per-reason increment. Counting must never turn a rejection into a
   * 500: the request is already being refused, and losing a counter tick is
   * better than masking why.
   */
  async record(reason: ClaimRejectionReason): Promise<void> {
    try {
      await this.counters.query(
        `INSERT INTO claim_rejection (reason, count, updated_at) VALUES ($1, 1, now())
         ON CONFLICT (reason) DO UPDATE SET count = claim_rejection.count + 1, updated_at = now()`,
        [reason],
      );
    } catch (error) {
      this.logger.error(`failed to record claim rejection ${reason}: ${(error as Error).message}`);
    }
  }

  async countFor(reason: ClaimRejectionReason): Promise<number> {
    const row = await this.counters.findOneBy({ reason });
    return row ? Number(row.count) : 0;
  }
}
