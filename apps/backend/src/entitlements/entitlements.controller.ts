import { Body, Controller, Headers, Post } from '@nestjs/common';
import { IDEMPOTENCY_KEY_HEADER } from '../issuance/headers';
import type { BundleResponse } from '../issuance/issuance.service';
import { EntitlementsService, type EntitlementResponse } from './entitlements.service';

export const ENTITLEMENT_HEADER = 'x-entitlement';

@Controller('v1/entitlements')
export class EntitlementsController {
  constructor(private readonly entitlements: EntitlementsService) {}

  @Post()
  register(@Body() body: unknown): Promise<EntitlementResponse> {
    return this.entitlements.register(body);
  }

  /**
   * Returns the same body as POST /v1/bundles, down to the field names: the
   * rail a credential came from must not be readable off the response (M2.2).
   */
  @Post('pickup')
  pickup(
    @Headers(ENTITLEMENT_HEADER) entitlementId: string | undefined,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string | undefined,
    @Body() body: unknown,
  ): Promise<BundleResponse> {
    return this.entitlements.pickup(entitlementId, idempotencyKey, body);
  }
}
