#!/usr/bin/env bun
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { IssuerRequestError } from './client';
import {
  NoPaymentProvider,
  PaymentRequiredError,
  StubClaimProvider,
  StubReceiptProvider,
  type PaymentProvider,
} from './payment';
import { failures } from './conformance';
import { purchaseBundle } from './purchase';
import { DEFAULT_BUNDLE_PARAMETERS } from './types';

const EXIT_OK = 0;
const EXIT_NONCONFORMING = 1;
const EXIT_UNUSABLE = 2;

const USAGE = `buyer-harness --url <issuer base url> [options]

Buys one bundle and judges the response against the issuer contract.

  --url <url>              issuer base URL (required)
  --bundle-size <k>        credentials per bundle (default ${DEFAULT_BUNDLE_PARAMETERS.bundleSize})
  --blank-size <bytes>     blinded blank size (default ${DEFAULT_BUNDLE_PARAMETERS.blankSizeBytes})
  --signature-size <bytes> expected blob size (default ${DEFAULT_BUNDLE_PARAMETERS.signatureSizeBytes})
  --epoch <id>             epoch to request (default: the issuer's current epoch)
  --payment-ref <ref>      payment reference to claim (default: random)
  --idempotency-key <key>  send an Idempotency-Key header
  --payment <mode>         stub-claim (default) talks straight to an issuer with a
                           synthetic claim; stub-receipt runs the full
                           request -> 402 -> pay -> retry flow through a proxy,
                           with the payment itself stubbed; none sends nothing
  --json                   emit the report as JSON
  --help

Exit codes: ${EXIT_OK} conforming, ${EXIT_NONCONFORMING} nonconforming, ${EXIT_UNUSABLE} unusable (bad flags, issuer unreachable).`;

function paymentProvider(mode: string, paymentRef: string): PaymentProvider {
  switch (mode) {
    case 'stub-claim':
      return new StubClaimProvider(paymentRef);
    case 'stub-receipt':
      return new StubReceiptProvider();
    case 'none':
      return new NoPaymentProvider();
    default:
      throw new TypeError(`unknown --payment mode ${JSON.stringify(mode)}`);
  }
}

function positiveInt(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${flag} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      'bundle-size': { type: 'string' },
      'blank-size': { type: 'string' },
      'signature-size': { type: 'string' },
      epoch: { type: 'string' },
      'payment-ref': { type: 'string' },
      'idempotency-key': { type: 'string' },
      payment: { type: 'string', default: 'stub-claim' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(USAGE);
    return EXIT_OK;
  }
  if (!values.url) {
    console.error('missing --url\n');
    console.error(USAGE);
    return EXIT_UNUSABLE;
  }

  const paymentRef = values['payment-ref'] ?? `harness-${randomUUID()}`;
  const payment = paymentProvider(values.payment ?? 'stub-claim', paymentRef);

  const result = await purchaseBundle({
    payment,
    baseUrl: values.url,
    paymentRef,
    idempotencyKey: values['idempotency-key'],
    epoch: values.epoch,
    parameters: {
      bundleSize: positiveInt(values['bundle-size'], DEFAULT_BUNDLE_PARAMETERS.bundleSize, '--bundle-size'),
      blankSizeBytes: positiveInt(values['blank-size'], DEFAULT_BUNDLE_PARAMETERS.blankSizeBytes, '--blank-size'),
      signatureSizeBytes: positiveInt(values['signature-size'], DEFAULT_BUNDLE_PARAMETERS.signatureSizeBytes, '--signature-size'),
    },
  });

  if (values.json) {
    console.log(
      JSON.stringify(
        { epoch: result.epoch, paymentFlow: result.paymentFlow, conformance: result.conformance },
        null,
        2,
      ),
    );
  } else {
    for (const check of result.conformance.checks) {
      console.log(`${check.passed ? '✓' : '✗'} ${check.name}: ${check.detail}`);
    }
    console.log(
      result.paymentFlow === '402-retry'
        ? `\npayment: 402 answered and retried via ${payment.name}`
        : `\npayment: direct, no 402 (${payment.name})`,
    );
  }

  if (result.conformance.passed) return EXIT_OK;

  // Named on stderr so a failing run says which assertion broke without
  // anyone having to parse the report.
  console.error(`\nnonconforming issuer: ${failures(result.conformance).map((c) => c.name).join(', ')}`);
  return EXIT_NONCONFORMING;
}

try {
  process.exit(await main());
} catch (error) {
  if (
    error instanceof IssuerRequestError ||
    error instanceof PaymentRequiredError ||
    error instanceof TypeError
  ) {
    console.error(String(error.message));
    process.exit(EXIT_UNUSABLE);
  }
  throw error;
}
