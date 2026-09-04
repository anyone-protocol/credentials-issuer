import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountingModule } from '../accounting/accounting.module';
import { ClaimRejection } from '../issuance/claim-rejection.entity';
import { IdempotencyRecord } from '../issuance/idempotency-record.entity';
import { IssuanceRecord } from '../issuance/issuance-record.entity';
import { ClaimRejections } from '../payment/claim-rejections.service';
import { ClaimVerifier } from '../payment/claim-verifier.service';
import { RateLimiter } from '../payment/rate-limiter.service';
import { SigningModule } from '../signing/signing.module';
import { BundlesController } from './bundles.controller';
import { BundlesService } from './bundles.service';

@Module({
  imports: [TypeOrmModule.forFeature([IssuanceRecord, IdempotencyRecord, ClaimRejection]), SigningModule, AccountingModule],
  controllers: [BundlesController],
  providers: [BundlesService, RateLimiter, ClaimVerifier, ClaimRejections],
})
export class BundlesModule {}
