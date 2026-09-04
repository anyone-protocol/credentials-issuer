/**
 * Prints scope scenario coverage by milestone. Enforced milestones must be
 * fully covered or `bun test` fails; the rest is a backlog view.
 *   bun run scenarios
 */
import {
  IMPLEMENTED_MILESTONES,
  readImplementedScenarioNames,
  readScopeScenarios,
} from '../apps/backend/src/testing/scope-scenarios';

const scope = await readScopeScenarios();
const implemented = await readImplementedScenarioNames();

const milestones = [...new Set(scope.map((s) => s.milestone))];
let covered = 0;

for (const milestone of milestones) {
  const enforced = IMPLEMENTED_MILESTONES.has(milestone);
  console.log(`\n${milestone}${enforced ? '  (enforced in CI)' : ''}`);
  for (const { name } of scope.filter((s) => s.milestone === milestone)) {
    const hit = implemented.has(name);
    if (hit) covered += 1;
    console.log(`  [${hit ? 'x' : ' '}] ${name}`);
  }
}

console.log(`\n${covered}/${scope.length} scope scenarios covered by tests.`);

const gaps = scope.filter(
  (s) => IMPLEMENTED_MILESTONES.has(s.milestone) && !implemented.has(s.name),
);
if (gaps.length > 0) {
  console.error(`\nEnforced milestones with uncovered scenarios: ${gaps.length}`);
  process.exit(1);
}
