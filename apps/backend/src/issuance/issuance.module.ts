import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountingModule } from '../accounting/accounting.module';
import { KeysModule } from '../keys/keys.module';
import { RateLimiter } from '../payment/rate-limiter.service';
import { SigningModule } from '../signing/signing.module';
import { IdempotencyRecord } from './idempotency-record.entity';
import { IssuanceRecord } from './issuance-record.entity';
import { IssuanceService } from './issuance.service';

/** The issuance path both rails share. See docs/issuer-mvp-scope.md M2.2. */
@Module({
  imports: [
    TypeOrmModule.forFeature([IssuanceRecord, IdempotencyRecord]),
    SigningModule,
    AccountingModule,
    KeysModule,
  ],
  providers: [IssuanceService, RateLimiter],
  exports: [IssuanceService],
})
export class IssuanceModule {}
