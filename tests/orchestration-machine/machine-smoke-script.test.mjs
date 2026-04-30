import assert from 'node:assert/strict';
import test from 'node:test';

import { runMachineSmoke } from '../../scripts/smoke-orpad-machine-run.mjs';

test('smoke script runs a real .or-pipeline through Machine queue, worker, export, and audit', async () => {
  const result = await runMachineSmoke({
    adapter: 'node-cli',
    keep: false,
    timeoutMs: 30_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.validation.ok, true);
  assert.equal(result.validation.canMachineExecute, true);
  assert.equal(result.workerStatus, 'done');
  assert.equal(result.queueState, 'done');
  assert.deepEqual(result.patchChangedFiles, ['src/smoke-target.md']);
  assert.equal(result.canonicalWorkspaceUnchanged, true);
  assert.equal(result.audit.ok, true);
  assert.ok(result.eventTypes.includes('run.created'));
  assert.ok(result.eventTypes.includes('queue.transition'));
  assert.ok(result.eventTypes.includes('worker.result'));
  assert.ok(result.eventTypes.includes('artifact.registered'));
});
