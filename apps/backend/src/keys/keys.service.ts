import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { ISSUER_CONFIG, type IssuerConfig } from '../config/issuer.config';
import { importPrivateKey, publicSpkiOf } from './epoch-key';
import { parseKeyDocument, type KeyDocument } from './key-document';

@Injectable()
export class KeysService implements OnModuleInit {
  private document?: KeyDocument;
  private signingKey?: CryptoKey;
  private signingKeyPem?: string;

  constructor(@Inject(ISSUER_CONFIG) private readonly config: IssuerConfig) {}

  /**
   * Fail fast on a bad key document, a missing signing key, or a key document
   * that does not describe the key we actually sign with. Serving a pubkey that
   * cannot verify our signatures is worse than not booting.
   */
  async onModuleInit(): Promise<void> {
    this.document = await this.loadDocument();
    this.signingKey = await this.loadSigningKey();

    const actual = await publicSpkiOf(this.signingKey);
    if (actual !== this.document.pubkey) {
      throw new Error(
        `key document ${this.config.keyDocumentPath} publishes a pubkey that does not match the ` +
          `signing key at ${this.config.privateKeyPath}`,
      );
    }
  }

  current(): KeyDocument {
    if (!this.document) throw new Error('key document not loaded');
    return this.document;
  }

  /** The epoch signing key. Sourced from Vault from M1.2. */
  epochSigningKey(): CryptoKey {
    if (!this.signingKey) throw new Error('signing key not loaded');
    return this.signingKey;
  }

  private async loadDocument(): Promise<KeyDocument> {
    const path = this.config.keyDocumentPath;
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (cause) {
      throw new Error(`unable to read key document at ${path}`, { cause });
    }
    try {
      return parseKeyDocument(JSON.parse(raw));
    } catch (cause) {
      throw new Error(`invalid key document at ${path}: ${(cause as Error).message}`, { cause });
    }
  }

  /** The PEM, for worker threads that import their own copy (see SignerPool). */
  epochSigningKeyPem(): string {
    if (!this.signingKeyPem) throw new Error('signing key not loaded');
    return this.signingKeyPem;
  }

  private async loadSigningKey(): Promise<CryptoKey> {
    const path = this.config.privateKeyPath;
    try {
      this.signingKeyPem = await readFile(path, 'utf8');
      return await importPrivateKey(this.signingKeyPem);
    } catch (cause) {
      throw new Error(`unable to load epoch signing key at ${path}: ${(cause as Error).message}`, {
        cause,
      });
    }
  }
}
