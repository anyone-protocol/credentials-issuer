import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { ISSUER_CONFIG, type IssuerConfig } from '../config/issuer.config';
import { parseKeyDocument, type KeyDocument } from './key-document';

@Injectable()
export class KeysService implements OnModuleInit {
  private document?: KeyDocument;

  constructor(@Inject(ISSUER_CONFIG) private readonly config: IssuerConfig) {}

  // Fail fast: a malformed static key document should stop boot, not surface
  // as a broken /v1/keys/current in production.
  async onModuleInit(): Promise<void> {
    const path = this.config.keyDocumentPath;
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (cause) {
      throw new Error(`unable to read key document at ${path}`, { cause });
    }
    try {
      this.document = parseKeyDocument(JSON.parse(raw));
    } catch (cause) {
      throw new Error(`invalid key document at ${path}: ${(cause as Error).message}`, { cause });
    }
  }

  current(): KeyDocument {
    if (!this.document) throw new Error('key document not loaded');
    return this.document;
  }
}
