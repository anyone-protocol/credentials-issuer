import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { ISSUER_CONFIG, type IssuerConfig } from '../config/issuer.config';

const REPO_ROOT = join(import.meta.dir, '../../../..');

export interface IssuerHarness {
  readonly url: string;
  readonly config: IssuerConfig;
  readonly dataSource: DataSource;
  close(): Promise<void>;
}

export async function startIssuer(): Promise<IssuerHarness> {
  // Resolved from the source tree so tests do not depend on the caller's cwd.
  process.env.KEY_DOCUMENT_PATH ??= join(REPO_ROOT, 'config/keys/current.json');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app: INestApplication = moduleRef.createNestApplication();
  await app.listen(0);

  return {
    url: await app.getUrl(),
    config: app.get<IssuerConfig>(ISSUER_CONFIG),
    dataSource: app.get(DataSource),
    close: () => app.close(),
  };
}

export function validBlanks(config: IssuerConfig, count = config.bundleSize): string[] {
  return Array.from({ length: count }, () =>
    randomBytes(config.blankSizeBytes).toString('base64'),
  );
}

export function claimHeader(paymentRef: string): string {
  const claim = { payment_ref: paymentRef, amount: '1.00', route_id: 'route-1', proxy_sig: 'stub' };
  return Buffer.from(JSON.stringify(claim), 'utf8').toString('base64url');
}

export function postBundle(
  harness: IssuerHarness,
  body: unknown,
  paymentRef: string | null = 'pay-ref-1',
): Promise<Response> {
  return fetch(`${harness.url}/v1/bundles`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(paymentRef === null ? {} : { 'x-payment-claim': claimHeader(paymentRef) }),
    },
    body: JSON.stringify(body),
  });
}

export async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? '<no error code in body>';
}
