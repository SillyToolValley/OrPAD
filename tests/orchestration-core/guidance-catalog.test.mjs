import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = require(path.join(repoRoot, 'src/main/orchestration-core/core.cjs'));
const catalogDoc = require(path.join(repoRoot, 'src/main/orchestration-core/guidance-catalog.json'));

test('durable guidance catalog loads every promoted entry', () => {
  const catalog = core.loadGuidanceCatalog();
  assert.ok(Array.isArray(catalog), 'catalog is an array');
  assert.ok(catalog.length >= 3, 'has the promoted seed guidance');
  assert.equal(catalog.length, catalogDoc.guidance.length, 'loads all entries from guidance-catalog.json');
  for (const g of catalog) {
    assert.equal(typeof g.guidance, 'string');
    assert.ok(g.guidance.trim().length > 0, 'each guidance is non-empty');
  }
  const ids = catalog.map(g => g.id);
  for (const id of ['regression-guard', 'always-ship-current-best', 'score-against-ground-truth']) {
    assert.ok(ids.includes(id), `catalog includes the ${id} lesson earned from the pixel-art/CSV ralphloop`);
  }
});

test('the exported guidanceCatalog is grown (no longer the empty v0 placeholder)', () => {
  assert.ok(Array.isArray(core.guidanceCatalog));
  assert.ok(core.guidanceCatalog.length > 0, 'OrPAD itself now carries standing guidance');
});

test('composeGoalWithGuidance injects every standing guidance ahead of the task', () => {
  const catalog = core.loadGuidanceCatalog();
  const goal = 'Convert refs/kuguri.png to a 160x240 pixel-art sprite.';
  const composed = core.composeGoalWithGuidance(goal, catalog);
  assert.ok(composed.includes(goal), 'the original task is preserved');
  assert.ok(composed.includes('--- Task ---'), 'task is clearly delimited from guidance');
  assert.ok(composed.indexOf('Standing guidance') < composed.indexOf('--- Task ---'), 'guidance precedes the task');
  for (const g of catalog) {
    assert.ok(composed.includes(g.guidance), `injects the ${g.id} guidance text`);
  }
});

test('composeGoalWithGuidance is a no-op for an empty catalog (back-compat)', () => {
  const goal = 'do exactly X and stop';
  assert.equal(core.composeGoalWithGuidance(goal, []), goal);
  assert.equal(core.composeGoalWithGuidance(goal, null), goal);
  assert.equal(core.composeGoalWithGuidance(goal, undefined), goal);
});

test('a missing/invalid catalog path degrades to no standing guidance', () => {
  const missing = core.loadGuidanceCatalog(path.join(repoRoot, 'does-not-exist.json'));
  assert.deepEqual(missing, [], 'safe default: empty standing guidance, never throws');
});
