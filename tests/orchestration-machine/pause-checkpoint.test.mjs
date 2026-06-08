import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

// RC-3 mid-step pause checkpoint. RC-1 pauses at the step BOUNDARY; a single
// executeMachineRunStep can drain many nodes, so a pause requested mid-drain
// would otherwise wait for the whole step. RC-3 lets the scheduler checkpoint its
// in-memory readiness (ready/visited/dead/edge-status/source-results) into a
// durable run.pause-checkpoint event and bail; on resume the next step rehydrates
// that state — continuing from exactly where it left off, without re-running
// completed nodes or stranding nodes that were readied but not yet run.

const require = createRequire(import.meta.url);
const {
  appendMachineEvent,
  createMachineRun,
  executeMachineRunStep,
  readMachineEvents,
} = require('../../src/main/orchestration-machine');
const runControl = require('../../src/main/orchestration-machine/run-control');

async function makeHarnessRun(runId) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-rc3-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/rc3-harness');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'src/smoke-target.md'), 'before\n', 'utf8');
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'rc3-harness',
    entryGraph: 'graphs/main.or-graph',
    nodePacks: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3', origin: 'built-in' },
      { id: 'orpad.workstream', version: '>=0.1.0', origin: 'built-in' },
    ],
    run: {
      artifactRoot: 'harness/generated/latest-run/artifacts',
      queueRoot: 'harness/generated/latest-run/queue',
      metadataPath: 'harness/generated/latest-run/run-metadata.json',
      summaryPath: 'harness/generated/latest-run/summary.md',
      machineHarness: {
        candidateProposal: {
          schemaVersion: 'orpad.candidateProposal.v1',
          proposalId: 'proposal-rc3-harness',
          suggestedWorkItemId: 'rc3-harness-smoke',
          sourceNode: 'probe/rc3-harness',
          title: 'Exercise RC-3 checkpoint',
          fingerprint: 'rc3-harness:src/smoke-target.md',
          evidence: [{ id: 'target-before', file: 'src/smoke-target.md' }],
          acceptanceCriteria: ['Patch artifact records the target file change.'],
          sourceOfTruthTargets: ['src/smoke-target.md'],
        },
        expectedChangedFiles: ['src/smoke-target.md'],
        nodeCliPatch: { file: 'src/smoke-target.md', content: 'after from RC-3 harness\n' },
      },
    },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      nodes: [
        { id: 'probe', type: 'orpad.probe', config: { lens: 'rc3-harness' } },
        { id: 'queue', type: 'orpad.workQueue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', config: { queueRef: 'queue' } },
        { id: 'dispatcher', type: 'orpad.dispatcher', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        // reviewRequired keeps the run non-terminal (stops at patch-review) after a
        // full drain, so a second executeMachineRunStep can run for the rehydrate test.
        { id: 'worker', type: 'orpad.workerLoop', config: { queueRef: 'queue', reviewRequired: true } },
      ],
      edges: [],
    },
  }, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId,
    now: new Date('2026-05-16T00:00:00.000Z'),
  });
  return { workspaceRoot, pipelineDir, pipelinePath, run };
}

function stepOptions(h) {
  return {
    workspaceRoot: h.workspaceRoot,
    pipelinePath: h.pipelinePath,
    pipelineDir: h.pipelineDir,
    runRoot: h.run.runRoot,
    runId: h.run.runId,
    llmApprovalMode: 'bypass',
    exportLatestRunAfterStep: false,
  };
}

test('RC-3: a mid-step pause writes a checkpoint + pauses, and resume rehydrates it to completion (no node re-run)', async () => {
  const h = await makeHarnessRun('rc3-roundtrip');
  const runId = h.run.runId;
  try {
    // Request pause BEFORE the step: the scheduler's first loop-top boundary
    // observes the token, checkpoints readiness, and bails before any node runs.
    runControl.markPauseRequested(runId);
    const step1 = await executeMachineRunStep(stepOptions(h));
    assert.equal(step1.finalization?.paused, true, 'step reports a mid-step pause');
    assert.equal(step1.runState.lifecycleStatus, 'paused', 'run is durably paused');
    const afterPause = await readMachineEvents(h.run.runRoot);
    assert.equal(afterPause.some(e => e.eventType === 'run.pause-checkpoint'), true, 'a run.pause-checkpoint was written');
    assert.equal(afterPause.some(e => e.eventType === 'node.started'), false, 'no node was dispatched before the pause boundary');

    // Resume: paused -> waiting + clears the pause token (the real resume path).
    await runControl.requestRunResume(h.run.runRoot, { runId });
    const step2 = await executeMachineRunStep(stepOptions(h));
    const afterResume = await readMachineEvents(h.run.runRoot);
    assert.equal(afterResume.some(e => e.eventType === 'run.pause-checkpoint-consumed'), true, 'resume rehydrated + consumed the checkpoint');
    assert.notEqual(step2.runState.lifecycleStatus, 'paused', 'the run advanced past paused on resume');

    // Every node completed at most once across both steps — the rehydrate did not
    // re-run already-completed work, and nothing was stranded (the run advanced).
    const completedByPath = new Map();
    for (const e of afterResume) {
      if (e.eventType !== 'node.completed') continue;
      completedByPath.set(e.nodePath, (completedByPath.get(e.nodePath) || 0) + 1);
    }
    assert.ok(completedByPath.size > 0, 'the resumed run actually ran nodes (not stranded)');
    for (const [nodePath, count] of completedByPath) {
      assert.equal(count, 1, `node ${nodePath} completed exactly once (got ${count})`);
    }
  } finally {
    runControl.clearRunControlToken(runId);
    await fs.rm(h.workspaceRoot, { recursive: true, force: true });
  }
});

test('RC-3: rehydrate skips already-visited (completed) nodes — they are not re-dispatched', async () => {
  const h = await makeHarnessRun('rc3-skip-visited');
  const runId = h.run.runId;
  try {
    // Run a real step so probe/triage/worker actually run, with real side effects
    // (candidate ingest, queue transitions, patch artifact). reviewRequired stops
    // the run at patch-review, leaving it non-terminal so a second step can run.
    await executeMachineRunStep(stepOptions(h));
    const eventsAfter1 = await readMachineEvents(h.run.runRoot);
    const terminalNodePaths = [...new Set(eventsAfter1
      .filter(e => ['node.completed', 'node.blocked', 'node.failed', 'node.skipped'].includes(e.eventType) && e.nodePath)
      .map(e => e.nodePath))];
    assert.ok(terminalNodePaths.length > 0, 'step 1 ran (and finished) some nodes');
    const startedCountBefore = eventsAfter1.filter(e => e.eventType === 'node.started').length;

    // Inject a checkpoint marking every already-finished node VISITED, with an
    // empty ready set: "everything done so far; nothing left to dispatch." A
    // correct rehydrate must NOT re-dispatch any of these visited nodes.
    await appendMachineEvent(h.run.runRoot, {
      runId,
      actor: 'machine',
      eventType: 'run.pause-checkpoint',
      reason: 'test.synthetic-checkpoint',
      payload: {
        ready: [],
        visited: terminalNodePaths,
        dead: [],
        incomingEdgeStatus: [],
        sourceResults: [],
        loopBackForced: [],
        loopBackRedriveCounts: [],
        recentlyDeferredBarriers: [],
        probeFanoutExecuted: true,
        workerLoopExecuted: true,
        visitedSizeBeforeDispatch: terminalNodePaths.length,
      },
    });

    await executeMachineRunStep(stepOptions(h));
    const eventsAfter2 = await readMachineEvents(h.run.runRoot);
    assert.equal(eventsAfter2.some(e => e.eventType === 'run.pause-checkpoint-consumed'), true, 'the checkpoint was consumed on resume');
    const startedCountAfter = eventsAfter2.filter(e => e.eventType === 'node.started').length;
    assert.equal(startedCountAfter, startedCountBefore, 'no rehydrated-visited node was re-dispatched (no node.started added)');
  } finally {
    runControl.clearRunControlToken(runId);
    await fs.rm(h.workspaceRoot, { recursive: true, force: true });
  }
});
