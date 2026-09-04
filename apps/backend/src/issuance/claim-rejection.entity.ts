import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Aggregate rejection counters, one row per reason (I5: a count, never the
 * rejected claim). M1.4 requires the counter so a proxy sending claims the
 * issuer will not honour is visible rather than silent.
 */
@Entity('claim_rejection')
export class ClaimRejection {
  @PrimaryColumn({ name: 'reason', type: 'text' })
  reason!: string;

  @Column({ name: 'count', type: 'bigint' })
  count!: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
