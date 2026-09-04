import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { BlindSigner } from '../signing/blind-signer.service';
import {
  errorCode,
  postPickup,
  prepareBundle,
  registerEntitlement,
  startIssuer,
  validBlanks,
  type IssuerHarness,
} from '../testing/issuer-harness';
import { scenario } from '../testing/scenario';

const TABLES = 'issuance_record, idempotency_record, epoch_counter, entitlement';

interface EntitlementRow {
  drips_issued: number;
  next_drip_at: Date;
}

// Scenario names below are verbatim from docs/issuer-mvp-scope.md (M2.1).
describe('entitlement drip', () => {
  let harness: IssuerHarness;

  beforeAll(async () => {
    harness = await startIssuer();
  });
  afterAll(() => harness.close());
  beforeEach(async () => {
    await harness.dataSource.query(`TRUNCATE TABLE ${TABLES}`);
  });

  const epoch = () => harness.keyDocument.epoch_id;

  const entitlementRow = async (id: string): Promise<EntitlementRow> => {
    const [row] = (await harness.dataSource.query(
      'SELECT drips_issued, next_drip_at FROM entitlement WHERE entitlement_id = $1',
      [id],
    )) as EntitlementRow[];
    if (!row) throw new Error(`no entitlement row for ${id}`);
    return row;
  };

  const counters = async () => {
    const [row] = (await harness.dataSource.query(
      'SELECT bundles_paid, signatures_issued FROM epoch_counter WHERE epoch = $1',
      [epoch()],
    )) as { bundles_paid: string; signatures_issued: string }[];
    return {
      bundlesPaid: Number(row?.bundles_paid ?? 0),
      signaturesIssued: Number(row?.signatures_issued ?? 0),
    };
  };

  scenario('due drip issues through the standard path', async () => {
    const { config } = harness;
    const { entitlement_id: id } = await registerEntitlement(harness);
    const prepared = await prepareBundle(harness);

    const response = await postPickup(harness, id, {
      epoch: epoch(),
      blinded_blanks: [...prepared.blindedBlanks],
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { epoch: string; blind_signatures: string[] };
    expect(body.epoch).toBe(epoch());
    expect(body.blind_signatures).toHaveLength(config.bundleSize);

    // "issued via the identical M1 signing path": the blobs are real blind
    // signatures under the current epoch key, not a parallel implementation.
    const credentials = await prepared.finalize(body.blind_signatures);
    for (const credential of credentials) {
      expect(Buffer.from(credential.signature, 'base64').byteLength).toBe(config.signatureSizeBytes);
      expect(await prepared.verify(credential)).toBe(true);
    }

    // The shared path also means the shared ledger and counters (M1.3), so a
    // drip cannot be an issuance that reconciliation never sees.
    expect(await counters()).toEqual({
      bundlesPaid: 1,
      signaturesIssued: config.bundleSize,
    });
    const ledger = await harness.dataSource.query('SELECT payment_ref FROM issuance_record');
    expect(ledger).toEqual([{ payment_ref: id }]);

    // "And the drip schedule advances"
    const row = await entitlementRow(id);
    expect(row.drips_issued).toBe(1);
    expect(row.next_drip_at.getTime()).toBeGreaterThan(Date.now());
  });

  scenario('early pickup is rejected', async () => {
    const { config } = harness;
    const { entitlement_id: id } = await registerEntitlement(harness);

    const first = await postPickup(harness, id, {
      epoch: epoch(),
      blinded_blanks: await validBlanks(harness),
    });
    expect(first.status).toBe(201);

    // "and signs nothing" taken literally: the schedule is checked before the
    // signer is reached, so an early pickup costs no signing at all.
    const signer = spyOn(harness.app.get(BlindSigner), 'signBlindedBlank');
    const early = await postPickup(harness, id, {
      epoch: epoch(),
      blinded_blanks: await validBlanks(harness),
    });
    // Read before restoring: mockRestore also clears the call record.
    const signCalls = signer.mock.calls.length;
    signer.mockRestore();

    expect(early.status).toBe(409);
    expect(await errorCode(early)).toBe('NOT_DUE');
    expect(signCalls).toBe(0);

    // No second issuance, no second drip, no counters moved.
    expect(await harness.dataSource.query('SELECT id FROM issuance_record')).toHaveLength(1);
    expect((await entitlementRow(id)).drips_issued).toBe(1);
    expect(await counters()).toEqual({ bundlesPaid: 1, signaturesIssued: config.bundleSize });
  });

  // Not a scope scenario. The entitlement id is the whole authorization on
  // this rail, so presenting none or a stranger's must issue nothing.
  it.each([
    ['no entitlement header', null],
    ['an unknown entitlement', '00000000-0000-4000-8000-000000000000'],
    ['a non-uuid entitlement', 'not-an-entitlement'],
  ])('rejects a pickup with %s', async (_label, id) => {
    const response = await postPickup(harness, id, {
      epoch: epoch(),
      blinded_blanks: await validBlanks(harness),
    });

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('ENTITLEMENT_UNKNOWN');
    expect(await harness.dataSource.query('SELECT id FROM issuance_record')).toHaveLength(0);
  });

  // Not a scope scenario: two pickups racing for one due drip. The schedule is
  // advanced by a conditional update inside the issuance transaction, so the
  // loser rolls back rather than issuing a second bundle nobody paid for (I6).
  it('issues once when two pickups race for the same drip', async () => {
    const { entitlement_id: id } = await registerEntitlement(harness);
    const bodies = await Promise.all(
      [0, 1].map(async () => ({ epoch: epoch(), blinded_blanks: await validBlanks(harness) })),
    );

    const responses = await Promise.all(bodies.map((body) => postPickup(harness, id, body)));
    const statuses = responses.map((response) => response.status).sort();

    expect(statuses).toEqual([201, 409]);
    expect((await entitlementRow(id)).drips_issued).toBe(1);
    expect(await harness.dataSource.query('SELECT id FROM issuance_record')).toHaveLength(1);
  });

  // Not a scope scenario. A client that never saw its response must be able to
  // retry: without this the retry reads as an early pickup and the subscriber
  // loses the drip they paid for.
  it('replays a picked-up drip without advancing the schedule', async () => {
    const { entitlement_id: id } = await registerEntitlement(harness);
    const body = { epoch: epoch(), blinded_blanks: await validBlanks(harness) };

    const first = await postPickup(harness, id, body, { idempotencyKey: 'drip-1' });
    const replay = await postPickup(harness, id, body, { idempotencyKey: 'drip-1' });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(await first.json());
    expect((await entitlementRow(id)).drips_issued).toBe(1);
    expect(await harness.dataSource.query('SELECT id FROM issuance_record')).toHaveLength(1);
  });

  it('rejects a replayed idempotency key used for different blanks', async () => {
    const { entitlement_id: id } = await registerEntitlement(harness);

    const first = await postPickup(
      harness,
      id,
      { epoch: epoch(), blinded_blanks: await validBlanks(harness) },
      { idempotencyKey: 'drip-1' },
    );
    const conflicting = await postPickup(
      harness,
      id,
      { epoch: epoch(), blinded_blanks: await validBlanks(harness) },
      { idempotencyKey: 'drip-1' },
    );

    expect(first.status).toBe(201);
    expect(conflicting.status).toBe(409);
    expect(await errorCode(conflicting)).toBe('IDEMPOTENCY_CONFLICT');
    expect((await entitlementRow(id)).drips_issued).toBe(1);
  });

  // Not a scope scenario: proves the drip runs the shared request validation
  // rather than a second, laxer copy of it.
  it('applies the same bundle validation as a paid purchase', async () => {
    const { entitlement_id: id } = await registerEntitlement(harness);

    const response = await postPickup(harness, id, {
      epoch: epoch(),
      blinded_blanks: await validBlanks(harness, harness.config.bundleSize + 1),
    });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('BUNDLE_SIZE');
    expect((await entitlementRow(id)).drips_issued).toBe(0);
  });

  // Not a scope scenario. One receipt is one subscription: a second
  // entitlement from the same receipt would be a drip schedule nobody paid
  // for, which is the free class I6 forbids.
  it('returns the same entitlement when a receipt is registered twice', async () => {
    const receipt = 'receipt-shared';

    const first = await registerEntitlement(harness, receipt);
    const second = await registerEntitlement(harness, receipt);

    expect(second.entitlement_id).toBe(first.entitlement_id);
    expect(await harness.dataSource.query('SELECT entitlement_id FROM entitlement')).toHaveLength(1);
  });

  it('rejects a registration with no receipt', async () => {
    for (const body of [{}, { receipt: '' }, { receipt: '   ' }, { receipt: 7 }]) {
      const response = await fetch(`${harness.url}/v1/entitlements`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('RECEIPT_INVALID');
    }
  });
});
