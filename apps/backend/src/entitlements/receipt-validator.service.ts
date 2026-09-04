import { Injectable } from '@nestjs/common';
import { IssuerException } from '../errors/issuer.exception';

export interface ValidatedReceipt {
  /** The subscription this receipt proves. Stable across renewals. */
  readonly subscriptionId: string;
}

/**
 * Real App Store / Play verification is out of scope (M2.1), so this accepts
 * any non-empty receipt and treats it as its own subscription id. It proves
 * nothing: anyone can mint a receipt. Replacing it is a prerequisite for
 * running the fiat rail anywhere real -- see the README.
 */
@Injectable()
export class ReceiptValidator {
  async validate(receipt: unknown): Promise<ValidatedReceipt> {
    if (typeof receipt !== 'string' || receipt.trim().length === 0) {
      throw new IssuerException('RECEIPT_INVALID', 'receipt must be a non-empty string');
    }
    return { subscriptionId: receipt.trim() };
  }
}
