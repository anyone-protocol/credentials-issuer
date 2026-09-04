import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './typeorm.config';

// Consumed by the TypeORM migration CLI only; the app builds its own options.
export default new DataSource(buildDataSourceOptions());
