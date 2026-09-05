import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ISSUER_CONFIG, type IssuerConfig } from '../config/issuer.config';
import type { KeyDocument } from './key-document';
import {
  currentEpoch,
  parseKeyring,
  publishedDocument,
  usableEpoch,
  type EpochEntry,
  type Keyring,
} from './keyring';
import { verifyKeyringSignatures } from './root-key';

export interface EpochKeyMaterial {
  readonly epoch: string;
  readonly privateKeyPem: string;
}

export interface SigningHealth {
  /** The epoch advertised at GET /v1/keys/current. */
  readonly epoch: string;
  /** False once that epoch's window has closed: purchases against it fail. */
  readonly usable: boolean;
  /** Negative once it has expired. */
  readonly expiresInSeconds: number;
}

/** Below this, the current epoch is logged as needing a rotation. */
const EXPIRY_WARNING_SECONDS = 86_400;

/**
 * Holds the epoch keyring and keeps it current without a restart.
 *
 * The keyring is a file, which a Nomad template renders from Vault with
 * change_mode = "noop". Polling it means no Vault client here, tests that use
 * plain files, and issuance that survives Vault being unreachable. Reload is
 * eventually consistent, and the grace window is exactly the tolerance that
 * makes that harmless: the outgoing key still signs while the new one lands.
 */
@Injectable()
export class KeysService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KeysService.name);
  private readonly listeners: ((material: EpochKeyMaterial[]) => void)[] = [];
  private keyring?: Keyring;
  private fingerprint?: string;
  private timer?: ReturnType<typeof setInterval>;

  constructor(@Inject(ISSUER_CONFIG) private readonly config: IssuerConfig) {}

  async onModuleInit(): Promise<void> {
    await this.reload(true);
    this.timer = setInterval(() => {
      void this.reload(false);
    }, this.config.keyringReloadSeconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** The published key document for the current epoch, with no private material. */
  current(): KeyDocument & { root_sig: string } {
    return publishedDocument(currentEpoch(this.require()));
  }

  /** The epoch a request may be signed under, or null once grace has elapsed. */
  usable(epochId: string): EpochEntry | null {
    return usableEpoch(this.require(), epochId);
  }

  /**
   * Whether a buyer following the documented flow can still complete a
   * purchase: read the current key document, blind against it, and be signed.
   * Nothing rotates the keyring by itself, so this going false is the failure
   * the periodic rotation job exists to prevent. See docs/deployment.md.
   */
  signingHealth(at = new Date()): SigningHealth {
    const epoch = currentEpoch(this.require());
    return {
      epoch: epoch.epoch_id,
      usable: usableEpoch(this.require(), epoch.epoch_id, at) !== null,
      expiresInSeconds: Math.round((Date.parse(epoch.not_after) - at.getTime()) / 1000),
    };
  }

  keyMaterial(): EpochKeyMaterial[] {
    return this.require().epochs.map((epoch) => ({
      epoch: epoch.epoch_id,
      privateKeyPem: epoch.private_key_pkcs8_pem,
    }));
  }

  /** Called whenever the keyring changes, so signers can pick up new epochs. */
  onKeysChanged(listener: (material: EpochKeyMaterial[]) => void): void {
    this.listeners.push(listener);
  }

  private require(): Keyring {
    if (!this.keyring) throw new Error('keyring not loaded');
    return this.keyring;
  }

  private async reload(initial: boolean): Promise<void> {
    const path = this.config.keyringPath;

    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (cause) {
      if (initial) throw new Error(`unable to read keyring at ${path}`, { cause });
      this.logger.error(`keyring at ${path} became unreadable; keeping the loaded one`);
      return;
    }

    const fingerprint = createHash('sha256').update(raw).digest('hex');
    if (fingerprint === this.fingerprint) return;

    let keyring: Keyring;
    try {
      keyring = parseKeyring(JSON.parse(raw));
      await verifyKeyringSignatures(keyring);
    } catch (cause) {
      const message = `invalid keyring at ${path}: ${(cause as Error).message}`;
      // A bad keyring must not take the issuer down mid-flight: a rotation that
      // wrote something wrong should leave the previous keys signing.
      if (initial) throw new Error(message, { cause });
      this.logger.error(`${message}; keeping the loaded one`);
      return;
    }

    this.keyring = keyring;
    this.fingerprint = fingerprint;
    const epochs = keyring.epochs.map((epoch) => epoch.epoch_id).join(', ');
    this.logger.log(
      `${initial ? 'loaded' : 'reloaded'} keyring: current epoch ${keyring.current_epoch}, usable [${epochs}]`,
    );
    for (const listener of this.listeners) listener(this.keyMaterial());
    this.warnIfExpiring();
  }

  /**
   * Expiry is silent otherwise: the issuer keeps serving a key document nobody
   * can buy against, and /healthz is the only thing that notices, by which
   * point issuance has already stopped.
   */
  private warnIfExpiring(): void {
    const { epoch, usable, expiresInSeconds } = this.signingHealth();
    if (!usable) {
      this.logger.error(`epoch ${epoch} is not usable: nothing can be signed until a rotation`);
    } else if (expiresInSeconds < EXPIRY_WARNING_SECONDS) {
      this.logger.warn(`epoch ${epoch} expires in ${expiresInSeconds}s and nothing has rotated it`);
    }
  }
}
