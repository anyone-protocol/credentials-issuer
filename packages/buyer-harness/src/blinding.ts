import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { randomBytes } from 'node:crypto';
import { base64ToBytes, bytesToBase64 } from './bytes';

export interface IssuedCredential {
  /** The prepared message the signature is over, base64. */
  readonly message: string;
  /** The unblinded signature, base64. */
  readonly signature: string;
}

/** One bundle's worth of blinded blanks, plus the state needed to unblind. */
export interface PreparedBundle {
  readonly blindedBlanks: readonly string[];
  finalize(blindSignatures: readonly string[]): Promise<readonly IssuedCredential[]>;
  verify(credential: IssuedCredential): Promise<boolean>;
}

export interface Blinder {
  readonly name: string;
  prepare(count: number, publicKeySpkiBase64: string): Promise<PreparedBundle>;
}

const SUITE_KEY_ALGORITHM = { name: 'RSA-PSS', hash: 'SHA-384' } as const;

/**
 * RFC 9474 Prepare/Blind/Finalize via @cloudflare/blindrsa-ts, suite
 * RSABSSA-SHA384-PSS-Randomized. No hand-rolled crypto (I1).
 *
 * The serial is fresh random bytes chosen here, by the buyer. The issuer sees
 * only the blinded form, which is the whole point (I2).
 */
export class RsaBlinder implements Blinder {
  readonly name: string;
  private readonly suite = RSABSSA.SHA384.PSS.Randomized();

  constructor(private readonly serialSizeBytes = 32) {
    this.name = this.suite.toString();
  }

  async prepare(count: number, publicKeySpkiBase64: string): Promise<PreparedBundle> {
    const publicKey = await crypto.subtle.importKey(
      'spki',
      base64ToBytes(publicKeySpkiBase64),
      SUITE_KEY_ALGORITHM,
      true,
      ['verify'],
    );

    const blinds = await Promise.all(
      Array.from({ length: count }, async () => {
        const prepared = this.suite.prepare(new Uint8Array(randomBytes(this.serialSizeBytes)));
        const { blindedMsg, inv } = await this.suite.blind(publicKey, prepared);
        return { prepared, blindedMsg, inv };
      }),
    );

    const suite = this.suite;
    return {
      blindedBlanks: blinds.map((b) => bytesToBase64(b.blindedMsg)),

      async finalize(blindSignatures) {
        if (blindSignatures.length !== blinds.length) {
          throw new Error(
            `expected ${blinds.length} blind signatures to finalize, got ${blindSignatures.length}`,
          );
        }
        return Promise.all(
          blinds.map(async ({ prepared, inv }, index) => {
            const blindSig = base64ToBytes(blindSignatures[index]!);
            const signature = await suite.finalize(publicKey, prepared, blindSig, inv);
            return { message: bytesToBase64(prepared), signature: bytesToBase64(signature) };
          }),
        );
      },

      verify(credential) {
        return suite.verify(
          publicKey,
          base64ToBytes(credential.signature),
          base64ToBytes(credential.message),
        );
      },
    };
  }
}
