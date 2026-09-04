import { Body, Controller, Headers, Post } from '@nestjs/common';
import { parsePaymentClaim, PAYMENT_CLAIM_HEADER } from '../payment/payment-claim';
import { BundlesService, type BundleResponse } from './bundles.service';

@Controller('v1/bundles')
export class BundlesController {
  constructor(private readonly bundles: BundlesService) {}

  @Post()
  purchase(
    @Headers(PAYMENT_CLAIM_HEADER) claimHeader: string | undefined,
    @Body() body: unknown,
  ): Promise<BundleResponse> {
    return this.bundles.purchase(parsePaymentClaim(claimHeader), body);
  }
}
