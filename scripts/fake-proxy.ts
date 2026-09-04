#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { startFakeProxy } from '../packages/buyer-harness/src/testing/fake-proxy';

const USAGE = `fake-proxy --issuer <url> [--port <n>] [--proxy-key <path>]

Fronts an issuer with the 402 pay-and-retry flow, so the M0.3 conformance run can be rehearsed
before the TOON proxy exists. It settles nothing: any receipt is accepted. See docs/deployment.md.`;

const { values } = parseArgs({
  options: {
    issuer: { type: 'string' },
    port: { type: 'string', default: '3110' },
    'proxy-key': { type: 'string', default: 'config/keys/proxy.pem' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help || !values.issuer) {
  console.log(USAGE);
  process.exit(values.issuer ? 0 : 2);
}

const proxy = startFakeProxy({
  issuerUrl: values.issuer,
  signingKeyPem: await readFile(values['proxy-key']!, 'utf8'),
  port: Number(values.port),
});

console.log(`fake proxy on ${proxy.url}, fronting ${values.issuer}`);
process.on('SIGINT', () => {
  proxy.stop();
  process.exit(0);
});
