import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { ISSUER_CONFIG, type IssuerConfig } from '../config/issuer.config';
import { IssuanceRecord } from '../issuance/issuance-record.entity';
import type { PaymentClaim } from '../payment/payment-claim';
import { validateBundleRequest } from './bundle-request';

export interface BundleResponse {
  readonly epoch: string;
  readonly blind_signatures: readonly string[];
}

@Injectable()
export class BundlesService {
  constructor(
    @Inject(ISSUER_CONFIG) private readonly config: IssuerConfig,
    @InjectRepository(IssuanceRecord) private readonly records: Repository<IssuanceRecord>,
  ) {}

  async purchase(claim: PaymentClaim, body: unknown): Promise<BundleResponse> {
    // Validation throws before anything is persisted, so a rejected request
    // signs nothing and leaves no record.
    const request = validateBundleRequest(body, this.config);

    // M0.1 stub: random blobs sized as real RSABSSA-SHA384 signatures will be.
    // M1.1 replaces this with @cloudflare/blindrsa-ts BlindSign (I1).
    const blindSignatures = Array.from({ length: this.config.bundleSize }, () =>
      randomBytes(this.config.signatureSizeBytes).toString('base64'),
    );

    await this.records.insert({
      paymentRef: claim.payment_ref,
      epoch: request.epoch,
      bundleCount: 1,
    });

    return { epoch: request.epoch, blind_signatures: blindSignatures };
  }
}
