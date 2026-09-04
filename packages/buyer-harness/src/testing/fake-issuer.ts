import { randomBytes } from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import type { BundleParameters, KeyDocument } from '../types';

export interface FakeIssuerOptions extends BundleParameters {
  /** Index of the blob to return at the wrong size. Omit for a conforming issuer. */
  readonly wrongSizedBlobIndex?: number;
}

export interface FakeIssuer {
  readonly url: string;
  stop(): void;
}

function keyDocument(): KeyDocument {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    epoch_id: '0',
    not_before: '2026-01-01T00:00:00.000Z',
    not_after: '2027-01-01T00:00:00.000Z',
    alg: 'RSABSSA-SHA384-PSS-Randomized',
    pubkey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

/**
 * A deliberately controllable issuer, so the harness can be tested against
 * nonconformance without any "return the wrong size" switch existing in the
 * real service.
 */
export function startFakeIssuer(options: FakeIssuerOptions): FakeIssuer {
  const document = keyDocument();

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);

      if (pathname === '/v1/keys/current') return Response.json(document);
      if (pathname !== '/v1/bundles') return new Response('not found', { status: 404 });

      const blobs = Array.from({ length: options.bundleSize }, (_unused, index) => {
        const size =
          index === options.wrongSizedBlobIndex
            ? options.signatureSizeBytes - 1
            : options.signatureSizeBytes;
        return randomBytes(size).toString('base64');
      });

      return Response.json({ epoch: document.epoch_id, blind_signatures: blobs }, { status: 201 });
    },
  });

  return { url: server.url.origin, stop: () => server.stop(true) };
}
