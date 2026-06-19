import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = require(path.join(repoRoot, 'src/main/orchestration-core/core.cjs'));

test('grounding API is exported (the basic plan-before-build step exists)', () => {
  for (const fn of ['composeResearchGoal', 'composeGoalWithGrounding', 'runGroundingResearch', 'runGroundedDelegation']) {
    assert.equal(typeof core[fn], 'function', `core.${fn} is a function`);
  }
});

test('composeResearchGoal asks for prior-art, requirements, competitor-limits, recommendation', () => {
  const g = core.composeResearchGoal('Build a CSV parser', { groundingFile: 'grounding.md' });
  assert.match(g, /RESEARCH ONLY/);
  assert.match(g, /EXISTING SOLUTIONS \/ PRIOR ART/);
  assert.match(g, /MUST-HAVE REQUIREMENTS/);
  assert.match(g, /COMPETITOR LIMITATIONS \+ HOW TO OVERCOME/);
  assert.match(g, /RECOMMENDATION/);
  assert.match(g, /grounding\.md/);
  assert.ok(g.includes('Build a CSV parser'), 'the build task is included for the researcher');
  assert.match(g, /Do NOT build or modify/, 'research is read-only');
});

test('composeGoalWithGrounding injects the brief ahead of the build task', () => {
  const brief = '# Prior art\n- Pyxelate (edge-aware)\n# Must-have\n- palette control';
  const goal = 'Convert an image to pixel art';
  const composed = core.composeGoalWithGrounding(goal, brief);
  assert.ok(composed.includes(brief), 'the grounding brief is present');
  assert.ok(composed.includes(goal), 'the build task is preserved');
  assert.ok(composed.indexOf('Grounding brief') < composed.indexOf('--- Build task ---'), 'grounding precedes the task');
  assert.match(composed, /prefer reusing\/adapting proven solutions over reinventing/i);
});

test('composeGoalWithGrounding is a no-op when there is no brief (back-compat)', () => {
  const goal = 'do X';
  assert.equal(core.composeGoalWithGrounding(goal, ''), goal);
  assert.equal(core.composeGoalWithGrounding(goal, '   '), goal);
  assert.equal(core.composeGoalWithGrounding(goal, null), goal);
  assert.equal(core.composeGoalWithGrounding(goal, undefined), goal);
});

test('the grounding lesson is promoted into the durable guidance catalog', () => {
  const ids = core.loadGuidanceCatalog().map(g => g.id);
  assert.ok(ids.includes('ground-in-prior-art-before-building'),
    'survey-prior-art-before-building is standing guidance now');
});
