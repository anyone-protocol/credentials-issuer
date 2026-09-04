import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { ISSUER_CONFIG, type IssuerConfig } from '../config/issuer.config';

/**
 * Sliding-window counter in Redis, keyed by payment_ref and never by IP (I5).
 * Redis rather than process memory so the limit holds across Nomad replicas.
 *
 * Sliding rather than fixed-window: a fixed window resets on wall-clock
 * boundaries, which lets a caller spend its whole budget twice back to back
 * across the seam, and makes "the next request is blocked" true only until the
 * window rolls.
 *
 * A blocked request still occupies a slot, so hammering extends the block
 * rather than resetting it.
 */
@Injectable()
export class RateLimiter implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(
    @Inject(ISSUER_CONFIG) private readonly config: IssuerConfig,
    configService: ConfigService,
  ) {
    this.redis = new Redis({
      host: configService.get('REDIS_HOST', 'localhost'),
      port: configService.get<number>('REDIS_PORT', 6379),
      maxRetriesPerRequest: 2,
    });
  }

  /** True when the request is within budget. */
  async allow(paymentRef: string): Promise<boolean> {
    const { rateLimitMax, rateLimitWindowSeconds } = this.config;
    const windowMs = rateLimitWindowSeconds * 1000;
    const now = Date.now();
    const key = `ratelimit:${paymentRef}`;

    const results = await this.redis
      .multi()
      .zremrangebyscore(key, 0, now - windowMs)
      .zadd(key, now, `${now}-${randomUUID()}`)
      .zcard(key)
      .pexpire(key, windowMs)
      .exec();

    const inWindow = results?.[2]?.[1];
    if (typeof inWindow !== 'number') {
      throw new Error('rate limiter did not return a count');
    }
    return inWindow <= rateLimitMax;
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
