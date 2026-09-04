import { describe, expect, it } from 'bun:test';
import {
  IMPLEMENTED_MILESTONES,
  MANUAL_MILESTONES,
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
    for (const milestone of [...IMPLEMENTED_MILESTONES, ...MANUAL_MILESTONES.keys()]) {
      expect(scope.some((s) => s.milestone === milestone)).toBe(true);
    }
  });

  // Marking a milestone manual excuses it from the coverage gate, so the two
  // lists must not overlap: a milestone in both would be silently unenforced
  // while still reading as enforced.
  it('no milestone is both enforced and manual', async () => {
    const both = [...MANUAL_MILESTONES.keys()].filter((m) => IMPLEMENTED_MILESTONES.has(m));

    expect(both).toEqual([]);
  });

  // A manual milestone is verified by hand, not by nothing. Each one has to
  // say where that verification is written down, or the exemption is just a
  // way to hide a gap.
  it('every manual milestone gives a reason', async () => {
    const unexplained = [...MANUAL_MILESTONES.entries()]
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([milestone]) => milestone);

    expect(unexplained).toEqual([]);
    for (const reason of MANUAL_MILESTONES.values()) {
      expect(reason).toMatch(/docs\//);
    }
  });
});
