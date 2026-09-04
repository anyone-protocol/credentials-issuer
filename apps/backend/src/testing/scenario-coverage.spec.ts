import { describe, expect, it } from 'bun:test';
import {
  IMPLEMENTED_MILESTONES,
  readImplementedScenarioNames,
  readScopeScenarios,
  type ScopeScenario,
} from './scope-scenarios';

const describeScenario = (s: ScopeScenario) => `${s.milestone}: ${s.name}`;

describe('scope scenario coverage', () => {
  it('every scenario in an implemented milestone has a test', async () => {
    const scope = await readScopeScenarios();
    const implemented = await readImplementedScenarioNames();

    const missing = scope
      .filter((s) => IMPLEMENTED_MILESTONES.has(s.milestone))
      .filter((s) => !implemented.has(s.name))
      .map(describeScenario);

    expect(missing).toEqual([]);
  });

  it('every scenario test matches the scope doc verbatim', async () => {
    const scope = await readScopeScenarios();
    const scopeNames = new Set(scope.map((s) => s.name));
    const implemented = await readImplementedScenarioNames();

    // Catches renamed, typo'd, or unilaterally invented scenarios. The scope
    // doc is the spec of record: change it there first.
    const unknown = [...implemented].filter((name) => !scopeNames.has(name));

    expect(unknown).toEqual([]);
  });

  it('the scope doc parses into attributed scenarios', async () => {
    const scope = await readScopeScenarios();

    // Guards the parser itself: a doc restructure that silently yields zero
    // scenarios would otherwise make both checks above vacuously pass.
    expect(scope.length).toBeGreaterThan(0);
    expect(scope.every((s) => /^M\d+\.\d+$/.test(s.milestone))).toBe(true);
    for (const milestone of IMPLEMENTED_MILESTONES) {
      expect(scope.some((s) => s.milestone === milestone)).toBe(true);
    }
  });
});
