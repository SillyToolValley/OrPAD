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
  assert.deepEqual(result.selectedNodes, {
    probe: 'main/probe',
    triage: 'main/triage',
    dispatcher: 'main/dispatch',
    worker: 'main/worker',
  });
  assert.deepEqual(result.supportNodes.map(node => node.nodePath), [
    'main/context',
    'main/queue',
    'main/artifact',
  ]);
  assert.equal(result.workerStatus, 'done');
  assert.equal(result.queueState, 'done');
  assert.equal(result.finalization.summaryStatus, 'done');
  assert.equal(result.finalization.lifecycleStatus, 'completed');
  assert.deepEqual(result.patchChangedFiles, ['src/smoke-target.md']);
  assert.equal(result.canonicalWorkspaceUnchanged, true);
  assert.equal(result.audit.ok, true);
  assert.ok(result.eventTypes.includes('run.created'));
  assert.equal(result.eventTypes.filter(type => type === 'node.started').length, 7);
  assert.equal(result.eventTypes.filter(type => type === 'node.completed').length, 7);
  assert.ok(result.eventTypes.includes('queue.transition'));
  assert.ok(result.eventTypes.includes('worker.result'));
  assert.ok(result.eventTypes.includes('artifact.registered'));
});
