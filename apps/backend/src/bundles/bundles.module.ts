import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyRecord } from '../issuance/idempotency-record.entity';
import { IssuanceRecord } from '../issuance/issuance-record.entity';
import { RateLimiter } from '../payment/rate-limiter.service';
import { BundlesController } from './bundles.controller';
import { BundlesService } from './bundles.service';

@Module({
  imports: [TypeOrmModule.forFeature([IssuanceRecord, IdempotencyRecord])],
  controllers: [BundlesController],
  providers: [BundlesService, RateLimiter],
})
export class BundlesModule {}
