import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
// Cross-workspace on purpose: the scenarios call for the harness to run against
// a real local stub issuer, not a double.
import { startIssuer, type IssuerHarness } from '../../../apps/backend/src/testing/issuer-harness';
import { scenario } from '../../../apps/backend/src/testing/scenario';
import { DEV_PROXY_KEY_PEM } from '../../../scripts/generate-dev-keys';
import { startFakeIssuer } from './testing/fake-issuer';
import { DEFAULT_BUNDLE_PARAMETERS } from './types';

const CLI = join(import.meta.dir, 'cli.ts');

interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(args: readonly string[]): Promise<CliRun> {
  const proc = Bun.spawn(['bun', CLI, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe('buyer harness CLI', () => {
  let issuer: IssuerHarness;

  beforeAll(async () => {
    issuer = await startIssuer();
  });
  afterAll(() => issuer.close());

  scenario('harness passes against a local stub in CI', async () => {
    const { bundleSize, blankSizeBytes, signatureSizeBytes } = issuer.config;

    const run = await runCli([
      '--url', issuer.url,
      '--proxy-key', DEV_PROXY_KEY_PEM,
      '--bundle-size', String(bundleSize),
      '--blank-size', String(blankSizeBytes),
      '--signature-size', String(signatureSizeBytes),
    ]);

    expect(run.exitCode).toBe(0);
    // "having asserted blob count and size"
    expect(run.stdout).toContain('bundle count');
    expect(run.stdout).toContain('signature size');
  });

  scenario('harness detects a nonconforming issuer', async () => {
    const parameters = DEFAULT_BUNDLE_PARAMETERS;
    const fake = startFakeIssuer({ ...parameters, wrongSizedBlobIndex: 3 });

    try {
      const run = await runCli(['--url', fake.url, '--proxy-key', DEV_PROXY_KEY_PEM]);

      expect(run.exitCode).not.toBe(0);
      // "naming the size assertion that failed"
      expect(run.stderr).toContain('signature size');
      expect(run.stdout).toContain(
        `FAIL  signature size: expected ${parameters.signatureSizeBytes} bytes: blob 3 decoded to ${parameters.signatureSizeBytes - 1} bytes`,
      );
      // The count assertion is unaffected, so the failure is specific.
      expect(run.stdout).toContain('PASS  bundle count');
    } finally {
      fake.stop();
    }
  });

  it('exits 2, distinctly from nonconformance, when the issuer is unreachable', async () => {
    const run = await runCli(['--url', 'http://127.0.0.1:1', '--proxy-key', DEV_PROXY_KEY_PEM]);

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('unreachable');
  });

  it('exits 2 on missing --url', async () => {
    expect((await runCli([])).exitCode).toBe(2);
  });
});
