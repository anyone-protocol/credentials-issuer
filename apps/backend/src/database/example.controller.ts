import { Body, Controller, Get, Post } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExampleEntity } from './example.entity';

// Placeholder proving the TypeORM wiring. See README.
@Controller('api/examples')
export class ExampleController {
  constructor(
    @InjectRepository(ExampleEntity)
    private readonly examples: Repository<ExampleEntity>,
  ) {}

  @Get()
  list(): Promise<ExampleEntity[]> {
    return this.findRecent();
  }

  @Post()
  async create(@Body('name') name?: string): Promise<ExampleEntity[]> {
    const trimmed = name?.trim();
    if (trimmed) {
      await this.examples.save(this.examples.create({ name: trimmed }));
    }
    return this.findRecent();
  }

  private findRecent(): Promise<ExampleEntity[]> {
    return this.examples.find({ order: { createdAt: 'DESC' }, take: 10 });
  }
}
