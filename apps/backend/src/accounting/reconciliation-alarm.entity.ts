import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type AlarmKind = 'overissuance' | 'underissuance' | 'ledger_mismatch';

/**
 * A raised divergence. Persisted rather than only logged so an operator can ask
 * "has this ever fired" without a log search, and so the alarm survives a
 * process that dies right after detecting it.
 */
@Entity('reconciliation_alarm')
export class ReconciliationAlarm {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'epoch', type: 'text' })
  epoch!: string;

  @Column({ name: 'kind', type: 'text' })
  kind!: AlarmKind;

  @Column({ name: 'expected', type: 'bigint' })
  expected!: string;

  @Column({ name: 'actual', type: 'bigint' })
  actual!: string;

  @Column({ name: 'delta', type: 'bigint' })
  delta!: string;

  @CreateDateColumn({ name: 'raised_at', type: 'timestamptz' })
  raisedAt!: Date;
}
