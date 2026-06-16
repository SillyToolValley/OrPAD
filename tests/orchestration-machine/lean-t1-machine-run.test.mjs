import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { writeMachineSmokeWorkspace } from '../../scripts/smoke-orpad-machine-run.mjs';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
  createMachineRun,
  executeMachineRunStep,
  findQueueItem,
} = require(path.join(repoRoot, 'src/main/orchestration-machine'));

// B2 runtime verification: the lean-T1 graph shape that buildTierT1AuthoringSpec emits —
// entry → context → probe → queue → triage → dispatch → worker → artifact → exit, with NO
// verification gate, NO patch-review, and NO queue-drain loop (a truly linear single
// bounded worker pass). This drives it through the real Machine with the deterministic
// node-cli fixture adapter (no LLM/CLI) to prove the linear shape actually executes to
// `done`, not just that it passes the authoring audit.
const LEAN_T1_GRAPH = {
  kind: 'orpad.graph',
  version: '1.0',
  graph: {
    id: 'machine-smoke-workstream',
    nodes: [
      { id: 'entry', type: 'orpad.entry', label: 'Entry', config: { summary: 'Begin single bounded change.' } },
      { id: 'context', type: 'orpad.context', label: 'Context', config: { summary: 'Prepare smoke context.' } },
      { id: 'probe', type: 'orpad.probe', label: 'Probe', config: { queueRef: 'queue', lens: 'smoke' } },
      { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
      { id: 'triage', type: 'orpad.triage', label: 'Triage', config: { queueRef: 'queue' } },
      { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
      { id: 'worker', type: 'orpad.workerLoop', label: 'Worker', config: { queueRef: 'queue', adapter: 'cli-agent-overlay' } },
      { id: 'artifact', type: 'orpad.artifactContract', label: 'Evidence Contract', config: { manifest: 'harness/generated/latest-run/run-metadata.json' } },
      { id: 'exit', type: 'orpad.exit', label: 'Exit', config: { summary: 'Close after recording change evidence.' } },
    ],
    transitions: [
      { from: 'entry', to: 'context' },
      { from: 'context', to: 'probe' },
      { from: 'probe', to: 'queue' },
      { from: 'queue', to: 'triage' },
      { from: 'triage', to: 'dispatch' },
      { from: 'dispatch', to: 'worker' },
      { from: 'worker', to: 'artifact' },
      { from: 'artifact', to: 'exit' },
    ],
  },
};

test('lean-T1 linear graph (no gate / patch-review / drain loop) executes on the Machine to done', async () => {
  const ws = await writeMachineSmokeWorkspace({ graph: LEAN_T1_GRAPH, marker: 'after from lean-T1 runtime verification' });
  try {
    const run = await createMachineRun({ workspaceRoot: ws.workspaceRoot, pipelinePath: ws.pipelinePath });
    const executed = await executeMachineRunStep({
      workspaceRoot: ws.workspaceRoot,
      pipelinePath: ws.pipelinePath,
      pipelineDir: ws.pipelineDir,
      runRoot: run.runRoot,
      runId: run.runId,
      nodeExecutable: process.execPath,
      timeoutMs: 30_000,
      overlayRootMode: 'run-root',
      createWorkerCommandSpec: null,
    });

    const workerEvent = executed.worker?.result?.event;
    assert.equal(workerEvent?.payload?.status, 'done', 'worker reaches done on the linear lean-T1 graph');
    assert.equal(executed.finalization?.runState?.lifecycleStatus, 'completed', 'run completes (not blocked/partial)');

    const queueItem = await findQueueItem(run.runRoot, 'machine-smoke-target');
    assert.equal(queueItem?.state, 'done', 'the single queued item drains to done without a loop');

    // All 9 nodes (entry/exit included) start and complete — proves the full linear traversal.
    const started = executed.events.filter(e => e.eventType === 'node.started').length;
    const completed = executed.events.filter(e => e.eventType === 'node.completed').length;
    assert.equal(started, 9, 'every lean-T1 node is scheduled');
    assert.equal(completed, 9, 'every lean-T1 node completes');

    // The canonical workspace is untouched (patch stays in the overlay) — least privilege holds.
    const canonical = await fs.readFile(path.join(ws.workspaceRoot, 'src', 'smoke-target.md'), 'utf8');
    assert.equal(canonical, 'before from OrPAD Machine smoke workspace\n');
  } finally {
    await fs.rm(ws.workspaceRoot, { recursive: true, force: true });
  }
});
