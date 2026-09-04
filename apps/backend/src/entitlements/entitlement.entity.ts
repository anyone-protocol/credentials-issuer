import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * `{entitlement_id -> drip schedule}` (M2.1). The fiat rail's standing
 * authorization: a subscription that becomes due for one bundle each interval.
 *
 * I5: no receipt is stored, only a hash of the subscription identifier it
 * validated to, which is what makes re-registering the same receipt return the
 * same entitlement instead of minting a second one.
 */
@Entity('entitlement')
export class Entitlement {
  @PrimaryColumn({ name: 'entitlement_id', type: 'uuid' })
  entitlementId!: string;

  @Column({ name: 'receipt_hash', type: 'text', unique: true })
  receiptHash!: string;

  @Column({ name: 'drip_interval_seconds', type: 'integer' })
  dripIntervalSeconds!: number;

  @Column({ name: 'next_drip_at', type: 'timestamptz' })
  nextDripAt!: Date;

  @Column({ name: 'drips_issued', type: 'integer', default: 0 })
  dripsIssued!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
