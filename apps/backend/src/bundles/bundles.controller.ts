import { Body, Controller, Headers, Post } from '@nestjs/common';
import { PAYMENT_CLAIM_HEADER } from '../payment/payment-claim';
import { BundlesService, type BundleResponse } from './bundles.service';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

@Controller('v1/bundles')
export class BundlesController {
  constructor(private readonly bundles: BundlesService) {}

  @Post()
  purchase(
    @Headers(PAYMENT_CLAIM_HEADER) claimHeader: string | undefined,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<BundleResponse> {
    return this.bundles.purchase(claimHeader, idempotencyKey, body);
  }
}
