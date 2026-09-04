import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildDataSourceOptions } from './typeorm.config';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        ...buildDataSourceOptions(),
        migrationsRun: process.env.DB_MIGRATIONS_RUN === 'true',
      }),
    }),
  ],
})
export class DatabaseModule {}
