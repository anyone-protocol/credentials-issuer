import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { ISSUER_CONFIG, type IssuerConfig } from '../config/issuer.config';

/**
 * Fixed-window counter in Redis, keyed by payment_ref and never by IP (I5).
 * Redis rather than process memory so the limit holds across Nomad replicas.
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
    const window = Math.floor(Date.now() / 1000 / rateLimitWindowSeconds);
    const key = `ratelimit:${paymentRef}:${window}`;

    const [[, count]] = (await this.redis
      .multi()
      .incr(key)
      .expire(key, rateLimitWindowSeconds)
      .exec()) as [[Error | null, number], ...unknown[]];

    return count <= rateLimitMax;
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
