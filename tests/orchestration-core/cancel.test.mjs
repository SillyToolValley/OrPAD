import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = require(path.join(repoRoot, 'src/main/orchestration-core/core.cjs'));

test('run cancellation registry: flag set on cancel, cleared, cancelAll is safe', () => {
  const id = `unit-${Date.now()}`;
  assert.equal(core.isRunCancelled(id), false, 'unknown run is not cancelled');
  // no live children registered, so cancelRun reports false but still flags the run
  assert.equal(core.cancelRun(id), false);
  assert.equal(core.isRunCancelled(id), true, 'cancel flags the run so the loops bail');
  core.clearCancelled(id);
  assert.equal(core.isRunCancelled(id), false, 'clearCancelled resets the flag');
  assert.equal(core.cancelRun(''), false, 'empty runId is a no-op');
  assert.doesNotThrow(() => core.cancelAllRuns(), 'cancelAllRuns is safe with no active runs');
});

test('cancellation API is exported (run stop + quit kill)', () => {
  for (const fn of ['cancelRun', 'cancelAllRuns', 'clearCancelled', 'isRunCancelled']) {
    assert.equal(typeof core[fn], 'function', `${fn} exported`);
  }
});
