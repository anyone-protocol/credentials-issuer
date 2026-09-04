import { it } from 'bun:test';

/**
 * Declares that this test implements a Gherkin scenario from
 * docs/issuer-mvp-scope.md. The name must match the doc verbatim;
 * scenario-coverage.spec.ts enforces that in both directions.
 */
export function scenario(name: string, body: () => void | Promise<void>): void {
  it(name, body);
}
