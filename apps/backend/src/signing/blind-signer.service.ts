import { Injectable } from '@nestjs/common';
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { IssuerException } from '../errors/issuer.exception';
import { base64ToBytes, bytesToBase64 } from '../keys/bytes';
import { KeysService } from '../keys/keys.service';

/**
 * RFC 9474 BlindSign under the current epoch key.
 *
 * The suite is fixed at RSABSSA-SHA384-PSS-Randomized and comes from
 * @cloudflare/blindrsa-ts. Per invariant I1 nothing here may reimplement or
 * "optimize" any part of it.
 *
 * BlindSign is deterministic: the randomization in RSABSSA-*-Randomized is
 * client-side, in Prepare. That is what lets a replayed purchase reproduce its
 * response without the issuer storing one (M0.2).
 */
@Injectable()
export class BlindSigner {
  private readonly suite = RSABSSA.SHA384.PSS.Randomized();

  constructor(private readonly keys: KeysService) {}

  get suiteName(): string {
    return this.suite.toString();
  }

  /**
   * Signs one blinded blank. Input and output are base64; the bytes are passed
   * straight to the library and are never inspected, logged or stored (I2).
   */
  async signBlindedBlank(blindedBlankBase64: string): Promise<string> {
    const blinded = base64ToBytes(blindedBlankBase64);

    let signature: Uint8Array;
    try {
      signature = await this.suite.blindSign(this.keys.epochSigningKey(), blinded);
    } catch (error) {
      // A blank of the right length can still be an invalid blinded message:
      // RFC 9474 requires it to be less than the modulus. That is the client's
      // mistake, not ours, so it is a typed error rather than a 500. Letting
      // the library make the ruling keeps I1 intact.
      if (error instanceof Error && /out of range/i.test(error.message)) {
        throw new IssuerException(
          'BLANK_FORMAT',
          'blinded blank is not a valid blinded message for the epoch key',
        );
      }
      throw error;
    }
    return bytesToBase64(signature);
  }
}
