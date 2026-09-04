import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccountingModule } from './accounting/accounting.module';
import { BundlesModule } from './bundles/bundles.module';
import { IssuerConfigModule } from './config/issuer-config.module';
import { DatabaseModule } from './database/database.module';
import { EntitlementsModule } from './entitlements/entitlements.module';
import { HealthController } from './health/health.controller';
import { KeysModule } from './keys/keys.module';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    IssuerConfigModule,
    DatabaseModule,
    QueueModule,
    KeysModule,
    AccountingModule,
    BundlesModule,
    EntitlementsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
