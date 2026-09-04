import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Per-epoch aggregates (M1.3). Two counters written by two different paths:
 * bundles_paid by the payment side, signatures_issued by the signer. They are
 * only ever compared, never derived from each other, because a reconciliation
 * between two copies of the same number would catch nothing.
 */
@Entity('epoch_counter')
export class EpochCounter {
  @PrimaryColumn({ name: 'epoch', type: 'text' })
  epoch!: string;

  /** k at the time this epoch was first counted, so a later change to k cannot
   *  retroactively make a settled epoch look diverged. */
  @Column({ name: 'bundle_size', type: 'integer' })
  bundleSize!: number;

  @Column({ name: 'bundles_paid', type: 'bigint' })
  bundlesPaid!: string;

  @Column({ name: 'signatures_issued', type: 'bigint' })
  signaturesIssued!: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
