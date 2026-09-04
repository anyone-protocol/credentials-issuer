import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { EpochCounters } from './epoch-counters.service';
import { Reconciliation } from './reconciliation.service';
import {
  claimHeader,
  startIssuer,
  uniquePaymentRef,
  validBlanks,
  type IssuerHarness,
} from '../testing/issuer-harness';
import { scenario } from '../testing/scenario';

const SCRIPTED_PURCHASES = 1000;
const CONCURRENCY = 25;

describe('aggregate accounting', () => {
  let harness: IssuerHarness;
  let reconciliation: Reconciliation;
  let counters: EpochCounters;

  beforeAll(async () => {
    // k=2 keeps the "x k" arithmetic meaningful while holding 1000 purchases
    // to 2000 RSA signing operations, and a huge rate limit keeps the scripted
    // run from throttling itself.
    // stubSigner: this scenario is about the counters, and the crypto path is
    // covered by M1.1 and the harness tests. See StartIssuerOptions.
    harness = await startIssuer({ bundleSize: 2, rateLimitMax: 10_000 }, { stubSigner: true });
    reconciliation = harness.app.get(Reconciliation);
    counters = harness.app.get(EpochCounters);
  });
  afterAll(() => harness.close());
  beforeEach(async () => {
    await harness.dataSource.query(
      'TRUNCATE TABLE issuance_record, idempotency_record, epoch_counter, reconciliation_alarm',
    );
  });

  scenario('reconciliation is exact over a scripted run', async () => {
    const epoch = '0';
    // One valid blinded bundle reused across purchases: BlindSign is
    // deterministic and takes no view of freshness, so this measures the
    // accounting rather than the client's blinding throughput.
    const blanks = await validBlanks(harness);

    let issued = 0;
    for (let sent = 0; sent < SCRIPTED_PURCHASES; sent += CONCURRENCY) {
      const batch = Math.min(CONCURRENCY, SCRIPTED_PURCHASES - sent);
      const responses = await Promise.all(
        Array.from({ length: batch }, async () =>
          fetch(`${harness.url}/v1/bundles`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-payment-claim': await claimHeader(uniquePaymentRef()),
            },
            body: JSON.stringify({ epoch, blinded_blanks: blanks }),
          }),
        ),
      );
      issued += responses.filter((response) => response.status === 201).length;
    }
    expect(issued).toBe(SCRIPTED_PURCHASES);

    const [result] = await reconciliation.reconcile();

    expect(result?.epoch).toBe(epoch);
    expect(result?.bundlesPaid).toBe(SCRIPTED_PURCHASES);
    // "Then signatures_issued equals bundles_paid x k"
    expect(result?.signaturesIssued).toBe(SCRIPTED_PURCHASES * harness.config.bundleSize);
    expect(result?.delta).toBe(0);
    // "And no alarm is raised"
    expect(result?.alarms).toEqual([]);
    expect(await reconciliation.alarmsFor(epoch)).toHaveLength(0);
  }, 120_000);

  scenario('overissuance raises an alarm within one cycle', async () => {
    const epoch = 'fault-injection';

    await harness.dataSource.transaction(async (manager) => {
      await manager.insert('issuance_record', {
        paymentRef: uniquePaymentRef(),
        epoch,
        bundleCount: 1,
      });
      await counters.recordBundlePaid(manager, epoch, harness.config.bundleSize);
      await counters.recordSignaturesIssued(
        manager,
        epoch,
        harness.config.bundleSize,
        harness.config.bundleSize,
      );
    });

    // Fault injection: signatures issued with no matching payment.
    const stolen = 7;
    await harness.dataSource.transaction((manager) =>
      counters.recordSignaturesIssued(manager, epoch, stolen, harness.config.bundleSize),
    );

    const result = (await reconciliation.reconcile()).find((r) => r.epoch === epoch);

    expect(result?.alarms).toContain('overissuance');
    expect(result?.delta).toBe(stolen);

    // "the overissuance alarm fires identifying the epoch and delta"
    const alarms = await reconciliation.alarmsFor(epoch);
    const overissuance = alarms.find((alarm) => alarm.kind === 'overissuance');
    expect(overissuance?.epoch).toBe(epoch);
    expect(Number(overissuance?.delta)).toBe(stolen);
  });

  it('raises a ledger mismatch when a counter drifts from the issuance ledger', async () => {
    const epoch = 'ledger-drift';
    await harness.dataSource.transaction((manager) =>
      counters.recordBundlePaid(manager, epoch, harness.config.bundleSize),
    );

    const result = (await reconciliation.reconcile()).find((r) => r.epoch === epoch);

    expect(result?.alarms).toContain('ledger_mismatch');
    expect(result?.ledgerDelta).toBe(1);
  });
});
