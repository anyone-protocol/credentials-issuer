import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EpochCounter } from './epoch-counter.entity';
import { EpochCounters } from './epoch-counters.service';
import { ReconciliationAlarm } from './reconciliation-alarm.entity';
import {
  RECONCILIATION_QUEUE,
  ReconciliationProcessor,
  ReconciliationScheduler,
} from './reconciliation.processor';
import { Reconciliation } from './reconciliation.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([EpochCounter, ReconciliationAlarm]),
    BullModule.registerQueue({ name: RECONCILIATION_QUEUE }),
  ],
  providers: [EpochCounters, Reconciliation, ReconciliationProcessor, ReconciliationScheduler],
  exports: [EpochCounters, Reconciliation],
})
export class AccountingModule {}
