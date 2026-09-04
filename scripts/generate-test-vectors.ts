/**
 * Regenerates the blindrsa-ts side of the published test vectors.
 *   bun run vectors:generate
 *
 * CIRCL-origin vectors in the file are preserved untouched; regenerate those
 * with the Go tool (see docs/test-vectors.md). Vectors are committed, so only
 * run this when the suite or the format changes.
 */
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  VECTOR_FILE,
  VECTOR_SUITE,
  type TestVector,
  type TestVectorFile,
} from '../packages/buyer-harness/src/vector-file';

const TS_ORIGIN = 'blindrsa-ts';
const REPO_ROOT = join(import.meta.dir, '..');
const path = join(REPO_ROOT, VECTOR_FILE);

const hex = (bytes: Uint8Array | ArrayBuffer): string =>
  Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString('hex');

async function generate(index: number): Promise<TestVector> {
  const suite = RSABSSA.SHA384.PSS.Randomized();
  const { privateKey, publicKey } = await RSABSSA.SHA384.generateKey({
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
  });

  const prepared = suite.prepare(new TextEncoder().encode(`anyone-credential-serial-${index}`));
  const { blindedMsg, inv } = await suite.blind(publicKey, prepared);
  const blindSig = await suite.blindSign(privateKey, blindedMsg);
  const sig = await suite.finalize(publicKey, prepared, blindSig, inv);

  if (!(await suite.verify(publicKey, sig, prepared))) {
    throw new Error(`generated vector ${index} does not verify against its own key`);
  }

  return {
    name: `blindrsa-ts-${index}`,
    origin: TS_ORIGIN,
    modulus_bits: 2048,
    private_key_pkcs8: hex(await crypto.subtle.exportKey('pkcs8', privateKey)),
    public_key_spki: hex(await crypto.subtle.exportKey('spki', publicKey)),
    prepared_msg: hex(prepared),
    blinded_msg: hex(blindedMsg),
    blind_sig: hex(blindSig),
    inv: hex(inv),
    sig: hex(sig),
  };
}

const existing: TestVector[] = (await Bun.file(path).exists())
  ? ((JSON.parse(await Bun.file(path).text()) as TestVectorFile).vectors as TestVector[])
  : [];
const preserved = existing.filter((vector) => vector.origin !== TS_ORIGIN);

const generated = await Promise.all([0, 1].map(generate));
const file: TestVectorFile = { suite: VECTOR_SUITE, vectors: [...generated, ...preserved] };

await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
console.log(
  `wrote ${file.vectors.length} vectors to ${VECTOR_FILE} ` +
    `(${generated.length} regenerated, ${preserved.length} preserved)`,
);
