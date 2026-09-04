import { InjectQueue } from '@nestjs/bullmq';
import { Controller, Post } from '@nestjs/common';
import { Queue } from 'bullmq';
import { EXAMPLE_QUEUE } from './example.processor';

// Placeholder proving the BullMQ wiring. See README.
@Controller('api/jobs')
export class QueueController {
  constructor(
    @InjectQueue(EXAMPLE_QUEUE) private readonly queue: Queue,
  ) {}

  @Post()
  async enqueue(): Promise<{ jobId: string | undefined }> {
    const job = await this.queue.add('example', { at: new Date().toISOString() });
    return { jobId: job.id };
  }
}
