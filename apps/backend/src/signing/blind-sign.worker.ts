/**
 * Blind-signs on a worker thread, under whichever epoch key a request names.
 *
 * Keys arrive by message rather than at spawn, so a rotation updates the pool
 * in place: respawning would drop in-flight work and pay the startup cost on
 * every rotation. Each worker selects its suite independently, since workers
 * are separate realms and the main process's polyfill does not reach here.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { importPrivateKey } from '../keys/epoch-key';
import { selectSigningSuite } from './suite';

export interface EpochKey {
  readonly epoch: string;
  readonly privateKeyPem: string;
}

export type SignCommand =
  | { readonly kind: 'keys'; readonly keys: readonly EpochKey[] }
  | { readonly kind: 'sign'; readonly id: number; readonly epoch: string; readonly blindedBlank: string };

export type SignReply =
  | { readonly id: number; readonly signature: string }
  | { readonly id: number; readonly error: string };

const port = parentPort;
if (!port) throw new Error('blind-sign worker started without a parent port');

const { keys, useNativeRsa } = workerData as { keys: EpochKey[]; useNativeRsa: boolean };
const selection = selectSigningSuite(useNativeRsa);

let signingKeys = importKeys(keys);

function importKeys(material: readonly EpochKey[]): Map<string, Promise<CryptoKey>> {
  return new Map(material.map((key) => [key.epoch, importPrivateKey(key.privateKeyPem)]));
}

port.on('message', (command: SignCommand) => {
  if (command.kind === 'keys') {
    signingKeys = importKeys(command.keys);
    return;
  }

  void (async () => {
    try {
      const key = signingKeys.get(command.epoch);
      if (!key) throw new Error(`no signing key for epoch ${command.epoch}`);

      const blinded = Buffer.from(command.blindedBlank, 'base64');
      const bytes = new Uint8Array(blinded.byteLength);
      bytes.set(blinded);

      const { suite } = await selection;
      const signature = await suite.blindSign(await key, bytes);
      port.postMessage({
        id: command.id,
        signature: Buffer.from(signature).toString('base64'),
      } satisfies SignReply);
    } catch (error) {
      port.postMessage({ id: command.id, error: (error as Error).message } satisfies SignReply);
    }
  })();
});
