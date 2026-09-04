import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClaimRejection } from '../issuance/claim-rejection.entity';
import { IssuanceModule } from '../issuance/issuance.module';
import { ClaimRejections } from '../payment/claim-rejections.service';
import { ClaimVerifier } from '../payment/claim-verifier.service';
import { BundlesController } from './bundles.controller';
import { BundlesService } from './bundles.service';

@Module({
  imports: [TypeOrmModule.forFeature([ClaimRejection]), IssuanceModule],
  controllers: [BundlesController],
  providers: [BundlesService, ClaimVerifier, ClaimRejections],
})
export class BundlesModule {}
