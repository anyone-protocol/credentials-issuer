import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Suppresses double-counting on replay. Deliberately separate from
 * IssuanceRecord so the I5 retention record keeps exactly its four permitted
 * fields, and so these rows can be pruned on a TTL without touching aggregates.
 *
 * Holds no payload: request_fingerprint is a SHA-256 over the request, never
 * the blanks themselves (I2).
 */
@Entity('idempotency_record')
export class IdempotencyRecord {
  @PrimaryColumn({ name: 'payment_ref', type: 'text' })
  paymentRef!: string;

  @PrimaryColumn({ name: 'idempotency_key', type: 'text' })
  idempotencyKey!: string;

  @Column({ name: 'request_fingerprint', type: 'text' })
  requestFingerprint!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
