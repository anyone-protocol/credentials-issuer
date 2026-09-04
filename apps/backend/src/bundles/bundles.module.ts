import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IssuanceRecord } from '../issuance/issuance-record.entity';
import { BundlesController } from './bundles.controller';
import { BundlesService } from './bundles.service';

@Module({
  imports: [TypeOrmModule.forFeature([IssuanceRecord])],
  controllers: [BundlesController],
  providers: [BundlesService],
})
export class BundlesModule {}
