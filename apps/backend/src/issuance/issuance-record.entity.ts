import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// I5 (minimal retention): these columns are the entire permitted per-purchase
// record. Adding a column here needs a scope change, not a code review.
@Entity('issuance_record')
export class IssuanceRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'payment_ref', type: 'text' })
  paymentRef!: string;

  @Index()
  @Column({ name: 'epoch', type: 'text' })
  epoch!: string;

  @Column({ name: 'bundle_count', type: 'integer' })
  bundleCount!: number;

  @CreateDateColumn({ name: 'timestamp', type: 'timestamptz' })
  timestamp!: Date;
}
