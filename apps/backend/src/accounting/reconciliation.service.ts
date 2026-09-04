import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EpochCounters } from './epoch-counters.service';
import { ReconciliationAlarm, type AlarmKind } from './reconciliation-alarm.entity';

export interface EpochReconciliation {
  readonly epoch: string;
  readonly bundleSize: number;
  readonly bundlesPaid: number;
  readonly signaturesIssued: number;
  readonly expectedSignatures: number;
  /** signaturesIssued - expectedSignatures. Positive is overissuance. */
  readonly delta: number;
  /** Bundles the issuance ledger actually holds for this epoch. */
  readonly ledgerBundles: number;
  readonly ledgerDelta: number;
  readonly alarms: readonly AlarmKind[];
}

@Injectable()
export class Reconciliation {
  private readonly logger = new Logger(Reconciliation.name);

  constructor(
    private readonly counters: EpochCounters,
    @InjectRepository(ReconciliationAlarm)
    private readonly alarms: Repository<ReconciliationAlarm>,
  ) {}

  /**
   * Compares, per epoch, the signatures the signer says it issued against the
   * bundles the payment side says were paid for. Overissuance is theft from
   * the redemption pool, so a divergence is raised rather than reported.
   */
  async reconcile(): Promise<EpochReconciliation[]> {
    const ledger = await this.ledgerBundlesByEpoch();
    const results: EpochReconciliation[] = [];

    for (const counter of await this.counters.all()) {
      const bundlesPaid = Number(counter.bundlesPaid);
      const signaturesIssued = Number(counter.signaturesIssued);
      const expectedSignatures = bundlesPaid * counter.bundleSize;
      const delta = signaturesIssued - expectedSignatures;
      const ledgerBundles = ledger.get(counter.epoch) ?? 0;
      const ledgerDelta = bundlesPaid - ledgerBundles;

      const alarms: AlarmKind[] = [];
      if (delta > 0) alarms.push('overissuance');
      if (delta < 0) alarms.push('underissuance');
      if (ledgerDelta !== 0) alarms.push('ledger_mismatch');

      for (const kind of alarms) {
        const [expected, actual] =
          kind === 'ledger_mismatch'
            ? [ledgerBundles, bundlesPaid]
            : [expectedSignatures, signaturesIssued];
        await this.raise(kind, counter.epoch, expected, actual, actual - expected);
      }

      results.push({
        epoch: counter.epoch,
        bundleSize: counter.bundleSize,
        bundlesPaid,
        signaturesIssued,
        expectedSignatures,
        delta,
        ledgerBundles,
        ledgerDelta,
        alarms,
      });
    }
    return results;
  }

  alarmsFor(epoch: string): Promise<ReconciliationAlarm[]> {
    return this.alarms.find({ where: { epoch }, order: { raisedAt: 'DESC' } });
  }

  private async raise(
    kind: AlarmKind,
    epoch: string,
    expected: number,
    actual: number,
    delta: number,
  ): Promise<void> {
    this.logger.error(
      `${kind.toUpperCase()} in epoch ${epoch}: expected ${expected}, got ${actual}, delta ${delta}`,
    );
    await this.alarms.insert({
      epoch,
      kind,
      expected: String(expected),
      actual: String(actual),
      delta: String(delta),
    });
  }

  private async ledgerBundlesByEpoch(): Promise<Map<string, number>> {
    const rows: { epoch: string; bundles: string }[] = await this.alarms.query(
      'SELECT epoch, SUM(bundle_count)::bigint AS bundles FROM issuance_record GROUP BY epoch',
    );
    return new Map(rows.map((row) => [row.epoch, Number(row.bundles)]));
  }
}
