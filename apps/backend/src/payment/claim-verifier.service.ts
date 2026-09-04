import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { ISSUER_CONFIG, type IssuerConfig } from '../config/issuer.config';
import { base64ToBytes } from '../keys/bytes';
import { spkiPemToDer } from '../keys/pem';
import { canonicalClaimPayload, PROXY_SIGNATURE_ALGORITHM } from './claim-signing';
import { decimalEquals, isDecimal } from './decimal';
import type { PaymentClaim } from './payment-claim';

export type ClaimRejectionReason =
  | 'missing'
  | 'malformed'
  | 'bad_signature'
  | 'amount_mismatch';

export class ClaimRejected extends Error {
  constructor(
    readonly reason: ClaimRejectionReason,
    message: string,
  ) {
    super(message);
    this.name = 'ClaimRejected';
  }
}

/**
 * Verifies the fronting proxy's forwarded proof of payment (M1.4).
 *
 * The issuer trusts the proxy, but only a proxy that can prove it: proxy_sig
 * must verify under the configured proxy public key, and the amount must match
 * the bundle price. Until this existed, any well-formed claim bought
 * credentials.
 */
@Injectable()
export class ClaimVerifier implements OnModuleInit {
  private proxyKey?: CryptoKey;

  constructor(@Inject(ISSUER_CONFIG) private readonly config: IssuerConfig) {}

  async onModuleInit(): Promise<void> {
    const path = this.config.proxyPublicKeyPath;
    let pem: string;
    try {
      pem = await readFile(path, 'utf8');
    } catch (cause) {
      throw new Error(`unable to read proxy public key at ${path}`, { cause });
    }
    try {
      this.proxyKey = await crypto.subtle.importKey(
        'spki',
        spkiPemToDer(pem),
        { name: PROXY_SIGNATURE_ALGORITHM },
        true,
        ['verify'],
      );
    } catch (cause) {
      throw new Error(`proxy public key at ${path} is not a valid ${PROXY_SIGNATURE_ALGORITHM} key`, {
        cause,
      });
    }

    if (!isDecimal(this.config.bundlePrice)) {
      throw new Error(`BUNDLE_PRICE must be a decimal string, got ${this.config.bundlePrice}`);
    }
  }

  /** Throws ClaimRejected; never returns a partially trusted claim. */
  async verify(claim: PaymentClaim): Promise<void> {
    if (!this.proxyKey) throw new Error('proxy public key not loaded');

    const { payment_ref, amount, route_id, proxy_sig } = claim;
    for (const [field, value] of Object.entries({ amount, route_id, proxy_sig })) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new ClaimRejected('malformed', `payment claim is missing ${field}`);
      }
    }

    let signature: ReturnType<typeof base64ToBytes>;
    try {
      signature = base64ToBytes(Buffer.from(proxy_sig!, 'base64url').toString('base64'));
    } catch {
      throw new ClaimRejected('malformed', 'proxy_sig is not base64url');
    }

    const verified = await crypto.subtle.verify(
      { name: PROXY_SIGNATURE_ALGORITHM },
      this.proxyKey,
      signature,
      canonicalClaimPayload({ payment_ref, amount: amount!, route_id: route_id! }),
    );
    if (!verified) {
      throw new ClaimRejected('bad_signature', 'proxy_sig does not verify under the proxy key');
    }

    // Checked after the signature, so an unsigned caller cannot learn the price
    // by probing which error comes back.
    if (!decimalEquals(amount!, this.config.bundlePrice)) {
      throw new ClaimRejected(
        'amount_mismatch',
        'claimed amount does not match the bundle price',
      );
    }
  }
}
