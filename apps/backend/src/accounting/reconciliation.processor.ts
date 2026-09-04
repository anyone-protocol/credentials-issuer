import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ISSUER_CONFIG, type IssuerConfig } from '../config/issuer.config';
import { Reconciliation } from './reconciliation.service';

export const RECONCILIATION_QUEUE = 'reconciliation';
const SCHEDULER_ID = 'reconciliation-cycle';

@Processor(RECONCILIATION_QUEUE)
export class ReconciliationProcessor extends WorkerHost {
  private readonly logger = new Logger(ReconciliationProcessor.name);

  constructor(private readonly reconciliation: Reconciliation) {
    super();
  }

  async process(): Promise<void> {
    const results = await this.reconciliation.reconcile();
    const raised = results.filter((result) => result.alarms.length > 0);
    this.logger.log(
      `reconciled ${results.length} epoch(s), ${raised.length} with divergence`,
    );
  }
}

/**
 * Registers the repeating cycle. upsert rather than add, so restarts and extra
 * replicas converge on one schedule instead of stacking duplicates.
 */
@Injectable()
export class ReconciliationScheduler implements OnModuleInit {
  constructor(
    @InjectQueue(RECONCILIATION_QUEUE) private readonly queue: Queue,
    @Inject(ISSUER_CONFIG) private readonly config: IssuerConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      SCHEDULER_ID,
      { every: this.config.reconciliationIntervalSeconds * 1000 },
      { name: 'cycle' },
    );
  }
}
