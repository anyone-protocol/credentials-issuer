import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const REPO_ROOT = join(import.meta.dir, '../../../..');
export const SCOPE_DOC = join(REPO_ROOT, 'docs/issuer-mvp-scope.md');
const SPEC_ROOTS = [join(REPO_ROOT, 'apps/backend/src'), join(REPO_ROOT, 'packages')];

/**
 * Milestones whose scenarios must be green in CI. Flip a milestone on in the
 * same commit that lands it; until then its scenarios are reported but not
 * enforced, so unbuilt scope never blocks the build.
 */
export const IMPLEMENTED_MILESTONES = new Set(['M0.1', 'M0.2', 'M0.4', 'M1.1', 'M1.2', 'M1.3', 'M1.4', 'M2.1', 'M2.2']);

/**
 * Milestones verified by hand, not by `bun test`. Their scenarios need
 * something no test process can stand up, so an automated check would be a
 * mock of the thing under test rather than the thing itself.
 *
 * They are not a backlog: the code is complete and the verification is
 * documented. Listing one here says so, and keeps the coverage report from
 * carrying a gap that will never close.
 */
export const MANUAL_MILESTONES = new Map([
  ['M0.3', 'needs the sandbox deployed behind the TOON connector; see docs/deployment.md'],
]);

export interface ScopeScenario {
  readonly milestone: string;
  readonly name: string;
}

/** Scenarios in ```gherkin blocks, attributed to the preceding **M0.1 ...** heading. */
export function parseScopeScenarios(markdown: string): ScopeScenario[] {
  const scenarios: ScopeScenario[] = [];
  let milestone = 'unattributed';
  let inGherkin = false;

  for (const line of markdown.split('\n')) {
    const heading = /^\*\*(M\d+\.\d+)\s/.exec(line);
    if (heading?.[1]) milestone = heading[1];

    if (line.startsWith('```')) {
      inGherkin = line.startsWith('```gherkin');
      continue;
    }
    if (!inGherkin) continue;

    const declared = /^\s*Scenario:\s*(.+?)\s*$/.exec(line);
    if (declared?.[1]) scenarios.push({ milestone, name: declared[1] });
  }
  return scenarios;
}

export async function readScopeScenarios(): Promise<ScopeScenario[]> {
  return parseScopeScenarios(await readFile(SCOPE_DOC, 'utf8'));
}

/** Names passed to scenario() across the suite, found by source scan so the
 *  result does not depend on which spec files a given test run imports. */
export async function readImplementedScenarioNames(): Promise<Set<string>> {
  const files: string[] = [];
  for (const root of SPEC_ROOTS) {
    for (const found of await readdir(root, { recursive: true })) {
      if (found.endsWith('.spec.ts') && !found.endsWith('scenario-coverage.spec.ts')) {
        files.push(join(root, found));
      }
    }
  }

  const names = new Set<string>();
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const [, , name] of source.matchAll(/\bscenario\(\s*(['"`])(.+?)\1/g)) {
      if (name) names.add(name);
    }
  }
  return names;
}
