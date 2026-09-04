import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  errorCode,
  postBundle,
  startIssuer,
  validBlanks,
  type IssuerHarness,
} from '../testing/issuer-harness';

// Scenario names below are verbatim from docs/issuer-mvp-scope.md (M0.1) and
// are the spec of record. Do not rename or add without a scope change.
describe('POST /v1/bundles', () => {
  let harness: IssuerHarness;

  beforeAll(async () => {
    harness = await startIssuer();
  });
  afterAll(() => harness.close());
  beforeEach(async () => {
    await harness.dataSource.query('TRUNCATE TABLE issuance_record');
  });

  it('bundle purchase returns correctly sized blobs', async () => {
    const { config } = harness;

    const response = await postBundle(harness, {
      epoch: '0',
      blinded_blanks: validBlanks(config),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { epoch: string; blind_signatures: string[] };
    expect(body.epoch).toBe('0');
    expect(body.blind_signatures).toHaveLength(config.bundleSize);
    for (const signature of body.blind_signatures) {
      expect(Buffer.from(signature, 'base64').byteLength).toBe(config.signatureSizeBytes);
    }

    // "And nothing beyond {payment_ref, epoch, bundle_count, timestamp} is
    // persisted" (I5) — asserted against the live schema, not the entity class,
    // so a stray column added by a migration also fails this.
    const columns: { column_name: string }[] = await harness.dataSource.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'issuance_record'`,
    );
    expect(new Set(columns.map((c) => c.column_name))).toEqual(
      new Set(['id', 'payment_ref', 'epoch', 'bundle_count', 'timestamp']),
    );

    const rows = await harness.dataSource.query('SELECT * FROM issuance_record');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ payment_ref: 'pay-ref-1', epoch: '0', bundle_count: 1 });
  });

  it('over-count bundle is rejected', async () => {
    const { config } = harness;

    const response = await postBundle(harness, {
      epoch: '0',
      blinded_blanks: validBlanks(config, config.bundleSize + 1),
    });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('BUNDLE_SIZE');
    // "and signs nothing"
    expect(await harness.dataSource.query('SELECT * FROM issuance_record')).toHaveLength(0);
  });

  it('malformed blank is rejected', async () => {
    const { config } = harness;
    const undersized = Buffer.alloc(config.blankSizeBytes - 1).toString('base64');

    for (const blank of [undersized, 'not!valid!base64', '']) {
      const blanks = validBlanks(config);
      blanks[config.bundleSize - 1] = blank;

      const response = await postBundle(harness, { epoch: '0', blinded_blanks: blanks });

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('BLANK_FORMAT');
      expect(await harness.dataSource.query('SELECT * FROM issuance_record')).toHaveLength(0);
    }
  });

  // Not a scope scenario: M0.1 must still do something coherent when the proxy
  // forwards no claim. See docs/payment-claim.md.
  it('rejects a request carrying no payment claim', async () => {
    const response = await postBundle(
      harness,
      { epoch: '0', blinded_blanks: validBlanks(harness.config) },
      null,
    );

    expect(response.status).toBe(402);
    expect(await errorCode(response)).toBe('CLAIM_INVALID');
    expect(await harness.dataSource.query('SELECT * FROM issuance_record')).toHaveLength(0);
  });
});
