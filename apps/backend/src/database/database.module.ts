import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExampleController } from './example.controller';
import { ExampleEntity } from './example.entity';
import { buildDataSourceOptions } from './typeorm.config';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        ...buildDataSourceOptions(),
        migrationsRun: process.env.DB_MIGRATIONS_RUN === 'true',
      }),
    }),
    TypeOrmModule.forFeature([ExampleEntity]),
  ],
  controllers: [ExampleController],
})
export class DatabaseModule {}
