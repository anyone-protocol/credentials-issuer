import { afterAll, beforeAll, describe, expect } from 'bun:test';
import { scenario } from '../testing/scenario';
import { startIssuer, type IssuerHarness } from '../testing/issuer-harness';
import { BLIND_SIGNATURE_SUITE } from './key-document';
import { KEY_DOCUMENT_FIELDS } from './keyring';

describe('GET /v1/keys/current', () => {
  let harness: IssuerHarness;

  beforeAll(async () => {
    harness = await startIssuer();
  });
  afterAll(() => harness.close());

  scenario('key document is served', async () => {
    const response = await fetch(`${harness.url}/v1/keys/current`);

    expect(response.status).toBe(200);
    const doc = (await response.json()) as Record<string, string>;

    // "Then the response matches the 0.3 consensus-publication schema" — the
    // full field list the scope doc states for M1.2, root_sig included.
    // Recheck when the real 0.3 schema lands.
    expect(Object.keys(doc).sort()).toEqual([...KEY_DOCUMENT_FIELDS].sort());

    // "And includes epoch_id, validity window, alg, and pubkey"
    expect(doc.epoch_id).toBeString();
    expect(Date.parse(doc.not_before!)).toBeLessThan(Date.parse(doc.not_after!));
    expect(doc.alg).toBe(BLIND_SIGNATURE_SUITE);
    expect(Buffer.from(doc.pubkey!, 'base64').byteLength).toBeGreaterThan(0);

    // No private material may ever reach the published document.
    expect(JSON.stringify(doc)).not.toContain('PRIVATE');
  });
});
