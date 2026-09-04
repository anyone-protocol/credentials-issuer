import type { DataSourceOptions } from 'typeorm';
import { EpochCounter } from '../accounting/epoch-counter.entity';
import { ReconciliationAlarm } from '../accounting/reconciliation-alarm.entity';
import { ClaimRejection } from '../issuance/claim-rejection.entity';
import { IdempotencyRecord } from '../issuance/idempotency-record.entity';
import { IssuanceRecord } from '../issuance/issuance-record.entity';

// Shared by the running app (database.module.ts) and the migration CLI
// (data-source.ts) so the two can never drift.
export function buildDataSourceOptions(env = process.env): DataSourceOptions {
  return {
    type: 'postgres',
    host: env.POSTGRES_HOST ?? 'localhost',
    port: Number(env.POSTGRES_PORT ?? 5432),
    username: env.POSTGRES_USER ?? 'app',
    password: env.POSTGRES_PASSWORD ?? 'app',
    database: env.POSTGRES_DB ?? 'app',
    entities: [IssuanceRecord, IdempotencyRecord, ClaimRejection, EpochCounter, ReconciliationAlarm],
    migrations: [__dirname + '/migrations/*.{ts,js}'],
    synchronize: (env.DB_SYNCHRONIZE ?? String(env.NODE_ENV !== 'production')) === 'true',
  };
}
