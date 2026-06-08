import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// RC-2 cooperative mid-flight cancel. RC-1 made cancel a step-BOUNDARY checkpoint
// (the driver breaks between steps); RC-2 threads an AbortSignal so a cancel bails
// cleanly WITHIN a step: the scheduler stops dispatching at the next node
// boundary, and the worker bails before claiming (no partial transition) or
// releases its durable claim lease + write-set lock if a cancel lands mid-work.

const require = createRequire(import.meta.url);
const {
  claimNextQueuedItem,
  createMachineRun,
  executeMachineRunStep,
  findQueueItem,
  ingestCandidateProposal,
  readClaimLease,
  readMachineEvents,
  summarizeQueueInventory,
  transitionQueueItem,
} = require('../../src/main/orchestration-machine');
const machineIpc = require('../../src/main/orchestration-machine/ipc');
const runControl = require('../../src/main/orchestration-machine/run-control');
const writeSets = require('../../src/main/orchestration-machine/write-sets');
const { runWorkerLoopOnce } = require('../../src/main/orchestration-machine/worker-loop');

async function makeRun(runId) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-rc2-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/rc2');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'rc2',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId,
    now: new Date('2026-05-16T00:00:00.000Z'),
  });
  return { workspaceRoot, pipelineDir, pipelinePath, run };
}

// A full deterministic-harness workspace (probe/queue/triage/dispatcher/worker)
// so executeMachineRunStep passes its harness validation and reaches the
// scheduler loop, where the RC-2 abort checkpoint lives. Mirrors the harness
// fixture used by the machine-ipc tests.
async function makeHarnessRun(runId) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-rc2-harness-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/rc2-harness');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'src/smoke-target.md'), 'before\n', 'utf8');
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'rc2-harness',
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
          proposalId: 'proposal-rc2-harness',
          suggestedWorkItemId: 'rc2-harness-smoke',
          sourceNode: 'probe/rc2-harness',
          title: 'Exercise RC-2 scheduler boundary',
          fingerprint: 'rc2-harness:src/smoke-target.md',
          evidence: [{ id: 'target-before', file: 'src/smoke-target.md' }],
          acceptanceCriteria: ['Patch artifact records the target file change.'],
          sourceOfTruthTargets: ['src/smoke-target.md'],
        },
        expectedChangedFiles: ['src/smoke-target.md'],
        nodeCliPatch: { file: 'src/smoke-target.md', content: 'after from RC-2 harness\n' },
      },
    },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      nodes: [
        { id: 'probe', type: 'orpad.probe', config: { lens: 'rc2-harness' } },
        { id: 'queue', type: 'orpad.workQueue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', config: { queueRef: 'queue' } },
        { id: 'dispatcher', type: 'orpad.dispatcher', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', config: { queueRef: 'queue' } },
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

function assertInsideWorkspace(workspaceRoot, targetPath) {
  const workspace = path.resolve(workspaceRoot);
  const resolved = path.resolve(String(targetPath || ''));
  const relative = path.relative(workspace, resolved);
  assert.ok(
    relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)),
    `${resolved} must stay inside ${workspace}`,
  );
  return resolved;
}

function makeIpcHarness(run) {
  const handlers = new Map();
  const authority = {
    getWorkspaceRoot: () => run.workspaceRoot,
    assertWorkspacePath: (_sender, targetPath) => assertInsideWorkspace(run.workspaceRoot, targetPath),
    assertWorkspaceContains: targetPath => assertInsideWorkspace(run.workspaceRoot, targetPath),
  };
  machineIpc.registerMachineHandlers({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    authority,
    featureGate: { enabled: true, mutatingCapabilityToken: 'test-token' },
  });
  return {
    invoke(channel, request) {
      const handler = handlers.get(channel);
      assert.equal(typeof handler, 'function', `IPC handler registered for ${channel}`);
      return handler({
        sender: {},
        senderFrame: { url: pathToFileURL(path.join(run.workspaceRoot, 'renderer.html')).href },
      }, request);
    },
  };
}

function proposal(id, targetFiles) {
  return {
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: `proposal-${id}`,
    suggestedWorkItemId: id,
    sourceNode: 'main/probe',
    title: `Exercise ${id}`,
    fingerprint: `rc2:${id}`,
    evidence: [{ id: `${id}-source`, file: targetFiles[0] || 'src/unknown.md' }],
    acceptanceCriteria: [`${id} is processed.`],
    sourceOfTruthTargets: targetFiles,
    targetFiles,
  };
}

async function queueItem(run, id, targetFiles) {
  const candidate = await ingestCandidateProposal(run.run.runRoot, proposal(id, targetFiles), {
    runId: run.run.runId,
    now: '2026-05-16T00:00:01.000Z',
    transitionId: `ingest:${id}`,
  });
  await transitionQueueItem(run.run.runRoot, {
    runId: run.run.runId,
    itemId: candidate.item.id,
    toState: 'queued',
    reason: 'triage.accepted',
    transitionId: `triage:${id}`,
    now: '2026-05-16T00:00:02.000Z',
  });
  return candidate.item.id;
}

test('RC-2: per-run AbortSignal bridges the RC-1 cancel intent', () => {
  const runId = 'rc2-infra-signal';
  try {
    assert.equal(runControl.getRunAbortSignal(runId).aborted, false, 'fresh signal is not aborted');
    runControl.abortRunSignal(runId);
    assert.equal(runControl.getRunAbortSignal(runId).aborted, true, 'abortRunSignal aborts the run signal');
    let threw = null;
    try {
      runControl.throwIfRunSignalAborted(runControl.getRunAbortSignal(runId), 'cancelled mid-flight');
    } catch (err) {
      threw = err;
    }
    assert.equal(threw?.code, 'MACHINE_RUN_CANCELLED');
    assert.equal(threw?.cancelled, true);
    assert.equal(threw?.terminal, true);
    runControl.clearRunAbortSignal(runId);
    assert.equal(runControl.getRunAbortSignal(runId).aborted, false, 'clear yields a fresh non-aborted signal');
  } finally {
    runControl.clearRunAbortSignal(runId);
  }
});

test('RC-2: runWorkerLoopOnce bails before claiming on a pre-aborted signal (no partial transition)', async () => {
  const run = await makeRun('rc2-preclaim');
  const itemId = await queueItem(run, 'preclaim', ['src/a.md']);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runWorkerLoopOnce({
      runRoot: run.run.runRoot,
      runId: run.run.runId,
      signal: controller.signal,
      enforceWriteSetConflicts: false,
      fixtureResult: () => ({ status: 'done' }),
    }),
    err => err.code === 'MACHINE_RUN_CANCELLED',
  );

  const item = await findQueueItem(run.run.runRoot, itemId, { canonicalOnly: false });
  assert.equal(item.item.state, 'queued', 'the item stays queued — no claim was committed');
  const events = await readMachineEvents(run.run.runRoot);
  const claimedTransition = events.some(e => (
    e.eventType === 'queue.transition'
    && (e.toState === 'claimed' || e.payload?.toState === 'claimed')
  ));
  assert.equal(claimedTransition, false, 'no queued->claimed transition was written');
  await fs.rm(run.workspaceRoot, { recursive: true, force: true });
});

test('RC-2: runWorkerLoopOnce releases the durable lease + write-set lock when a cancel lands mid-work', async () => {
  const run = await makeRun('rc2-midwork');
  await queueItem(run, 'midwork', ['src/b.md']);
  const controller = new AbortController();
  const claimId = 'claim-rc2-midwork';

  await assert.rejects(
    runWorkerLoopOnce({
      runRoot: run.run.runRoot,
      runId: run.run.runId,
      claimId,
      enforceWriteSetConflicts: false,
      signal: controller.signal,
      // Simulate the subprocess being SIGKILLed mid-flight while the run signal
      // is aborted: abort the signal, then throw. normalizeRunCancellationError
      // maps this to MACHINE_RUN_CANCELLED, and the worker finally releases the
      // durable lease + write-set lock.
      fixtureResult: async () => {
        controller.abort();
        throw new Error('subprocess SIGKILLed mid-flight');
      },
    }),
    err => err.code === 'MACHINE_RUN_CANCELLED',
  );

  const lease = await readClaimLease(run.run.runRoot, claimId);
  assert.notEqual(lease?.state, 'active', 'the durable claim lease is released on abort, not left active');
  const activeLocks = await writeSets.readActiveWriteSetLocks(run.run.runRoot);
  assert.equal(activeLocks.length, 0, 'the durable write-set lock is released on abort');
  // The run remains replayable / inventory-consistent after a mid-work abort.
  const inventory = await summarizeQueueInventory(run.run.runRoot);
  assert.ok(inventory && inventory.counts, 'queue inventory is derivable from events after the abort');
  await fs.rm(run.workspaceRoot, { recursive: true, force: true });
});

test('RC-2: executeMachineRunStep stops at the scheduler boundary on a pre-aborted signal', async () => {
  const run = await makeHarnessRun('rc2-scheduler');
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    executeMachineRunStep({
      workspaceRoot: run.workspaceRoot,
      pipelinePath: run.pipelinePath,
      pipelineDir: run.pipelineDir,
      runRoot: run.run.runRoot,
      runId: run.run.runId,
      llmApprovalMode: 'bypass',
      exportLatestRunAfterStep: false,
      signal: controller.signal,
    }),
    err => err.code === 'MACHINE_RUN_CANCELLED',
  );

  const events = await readMachineEvents(run.run.runRoot);
  assert.equal(
    events.some(e => e.eventType === 'node.started'),
    false,
    'the scheduler bailed at the boundary before dispatching any node',
  );
  await fs.rm(run.workspaceRoot, { recursive: true, force: true });
});

test('RC-2: IPC execute clears the per-run AbortController after completion', async () => {
  const run = await makeHarnessRun('rc2-ipc-clear');
  const runId = run.run.runId;
  const initialSignal = runControl.getRunAbortSignal(runId);
  const ipcHarness = makeIpcHarness(run);
  try {
    const response = await ipcHarness.invoke(machineIpc.MACHINE_IPC_CHANNELS.executeRunStep, {
      capabilityToken: 'test-token',
      workspacePath: run.workspaceRoot,
      pipelinePath: run.pipelinePath,
      runId,
      exportLatestRun: false,
      options: { llmApprovalMode: 'bypass' },
    });

    assert.equal(response.ok, true, response.error || 'IPC execute should complete');
    assert.equal(initialSignal.aborted, false, 'normal completion does not abort the active signal');
    runControl.abortRunSignal(runId, 'test.after-completion');
    assert.equal(
      initialSignal.aborted,
      false,
      'post-completion abort does not reach the completed execution controller',
    );
    assert.equal(
      runControl.getRunAbortSignal(runId).aborted,
      false,
      'the next run-scoped signal is fresh and non-aborted',
    );
  } finally {
    runControl.clearRunAbortSignal(runId);
    await fs.rm(run.workspaceRoot, { recursive: true, force: true });
  }
});
