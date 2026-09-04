import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IssuanceModule } from '../issuance/issuance.module';
import { Entitlement } from './entitlement.entity';
import { EntitlementsController } from './entitlements.controller';
import { EntitlementsService } from './entitlements.service';
import { ReceiptValidator } from './receipt-validator.service';

@Module({
  imports: [TypeOrmModule.forFeature([Entitlement]), IssuanceModule],
  controllers: [EntitlementsController],
  providers: [EntitlementsService, ReceiptValidator],
})
export class EntitlementsModule {}
