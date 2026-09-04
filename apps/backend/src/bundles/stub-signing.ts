import { createHash } from 'node:crypto';

/**
 * Deterministic filler, NOT a signature and not a blind signature scheme (I1).
 *
 * It is deterministic because RFC 9474 BlindSign is: the randomization in
 * RSABSSA-*-Randomized happens client-side in Prepare/Blind, so signing the
 * same blank under the same epoch key always yields the same bytes. Matching
 * that here means a replayed request reproduces its response by re-signing,
 * so the issuer never has to store a response body (I2, I5).
 *
 * M1.1 replaces this with @cloudflare/blindrsa-ts and the property holds for
 * real, with no change to the idempotency path.
 */
export function stubBlindSignature(epoch: string, blindedBlank: string, sizeBytes: number): string {
  const chunks: Buffer[] = [];
  for (let counter = 0, produced = 0; produced < sizeBytes; counter += 1) {
    const chunk = createHash('sha512').update(`${epoch}:${counter}:${blindedBlank}`).digest();
    chunks.push(chunk);
    produced += chunk.byteLength;
  }
  return Buffer.concat(chunks, sizeBytes).toString('base64');
}
