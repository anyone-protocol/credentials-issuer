/**
 * Blind-signs on a worker thread.
 *
 * With the RSA-RAW fast path a signature is well under a millisecond and the
 * pool is mostly insurance. Without it, blindrsa-ts falls back to pure-JS
 * bignum arithmetic at ~280ms per signature, and signing on the main thread
 * would stall health checks, other requests and the reconciliation cycle for
 * seconds at a time. Each worker selects the suite independently: workers are
 * separate realms, so the main process's polyfill does not reach here.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { importPrivateKey } from '../keys/epoch-key';
import { selectSigningSuite } from './suite';

export interface SignRequest {
  readonly id: number;
  readonly blindedBlank: string;
}

export type SignReply =
  | { readonly id: number; readonly signature: string }
  | { readonly id: number; readonly error: string };

const port = parentPort;
if (!port) throw new Error('blind-sign worker started without a parent port');

const { privateKeyPem, useNativeRsa } = workerData as { privateKeyPem: string; useNativeRsa: boolean };
const selection = selectSigningSuite(useNativeRsa);
const signingKey = importPrivateKey(privateKeyPem);

port.on('message', (request: SignRequest) => {
  void (async () => {
    try {
      const blinded = Buffer.from(request.blindedBlank, 'base64');
      const bytes = new Uint8Array(blinded.byteLength);
      bytes.set(blinded);
      const { suite } = await selection;
      const signature = await suite.blindSign(await signingKey, bytes);
      port.postMessage({
        id: request.id,
        signature: Buffer.from(signature).toString('base64'),
      } satisfies SignReply);
    } catch (error) {
      port.postMessage({ id: request.id, error: (error as Error).message } satisfies SignReply);
    }
  })();
});
