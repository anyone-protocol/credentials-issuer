/**
 * Prints scope scenario coverage by milestone. Enforced milestones must be
 * fully covered or `bun test` fails; manual ones are verified by hand and the
 * rest is a backlog view.
 *   bun run scenarios
 */
import {
  IMPLEMENTED_MILESTONES,
  MANUAL_MILESTONES,
  readImplementedScenarioNames,
  readScopeScenarios,
} from '../apps/backend/src/testing/scope-scenarios';

const scope = await readScopeScenarios();
const implemented = await readImplementedScenarioNames();

const milestones = [...new Set(scope.map((s) => s.milestone))];
let covered = 0;
let automatable = 0;
let manual = 0;

for (const milestone of milestones) {
  const manualReason = MANUAL_MILESTONES.get(milestone);
  const label = manualReason
    ? `  (manual: ${manualReason})`
    : IMPLEMENTED_MILESTONES.has(milestone)
      ? '  (enforced in CI)'
      : '';
  console.log(`\n${milestone}${label}`);

  for (const { name } of scope.filter((s) => s.milestone === milestone)) {
    if (manualReason) {
      manual += 1;
      console.log(`  [-] ${name}`);
      continue;
    }
    automatable += 1;
    const hit = implemented.has(name);
    if (hit) covered += 1;
    console.log(`  [${hit ? 'x' : ' '}] ${name}`);
  }
}

console.log(
  `\n${covered}/${automatable} automatable scope scenarios covered by tests` +
    (manual > 0 ? `, ${manual} verified by hand.` : '.'),
);

const gaps = scope.filter(
  (s) => IMPLEMENTED_MILESTONES.has(s.milestone) && !implemented.has(s.name),
);
if (gaps.length > 0) {
  console.error(`\nEnforced milestones with uncovered scenarios: ${gaps.length}`);
  process.exit(1);
}
