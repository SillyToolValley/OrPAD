import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  acquireWriteSetLock,
  appendRunLifecycleStatus,
  applyWorkerResult,
  cancelClaimedItem,
  claimNextQueuedItem,
  createAdapterRequest,
  createMachineRun,
  findQueueItem,
  ingestCandidateProposal,
  queueJournalPath,
  readActiveClaimLeases,
  readActiveWriteSetLocks,
  readClaimLease,
  readMachineEvents,
  readRunState,
  recoverStaleClaims,
  runSerialWorkerLoop,
  transitionQueueItem,
} = require('../../src/main/orchestration-machine');

const fixedNow = new Date('2026-04-30T00:00:00.000Z');

async function makeRun(runId = 'run_20260430_dispatcher_worker') {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-dispatcher-worker-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/sample-machine-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'sample-machine-pipeline',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');
  return createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId,
    now: fixedNow,
  });
}

function proposal(overrides = {}) {
  const id = overrides.suggestedWorkItemId || 'graph-editor-graph-specific-node-types';
  return {
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: `proposal-${id}`,
    suggestedWorkItemId: id,
    sourceNode: 'discovery/ux-probe',
    title: `Fix ${id}`,
    fingerprint: `ux:${id}`,
    contentArea: 'graph editor',
    issueType: 'renderer-validator-parity',
    severity: 'P2',
    confidence: 0.84,
    evidence: [{ id: `${id}-source`, file: 'src/renderer/renderer.js' }],
    acceptanceCriteria: [`${id} is fixed.`],
    sourceOfTruthTargets: ['src/renderer/renderer.js'],
    ...overrides,
  };
}

async function queueProposal(run, candidate, index = 0) {
  const item = await ingestCandidateProposal(run.runRoot, candidate, {
    runId: run.runId,
    now: `2026-04-30T00:00:0${index}.000Z`,
    transitionId: `ingest:${candidate.suggestedWorkItemId}`,
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: item.item.id,
    toState: 'queued',
    reason: 'triage.accepted',
    transitionId: `triage:${item.item.id}`,
    now: `2026-04-30T00:00:1${index}.000Z`,
  });
  return item.item.id;
}

function workerRequest(run, claimId, overrides = {}) {
  return createAdapterRequest({
    adapter: 'worker-fixture',
    runId: run.runId,
    nodePath: 'queue/worker-loop',
    taskKind: 'workerLoop',
    adapterCallId: `${claimId}-worker`,
    attemptId: `${claimId}-worker-attempt-1`,
    idempotencyKey: `${claimId}:worker-result`,
    outputContract: 'orpad.workerResult.v1',
    ...overrides,
  });
}

function workerResult(request, overrides = {}) {
  return {
    schemaVersion: 'orpad.workerResult.v1',
    adapterCallId: request.adapterCallId,
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    status: 'done',
    summary: 'Applied fixture worker result.',
    artifacts: ['artifacts/work-items/graph-editor-graph-specific-node-types/proof.md'],
    verification: [{ command: 'npm run build:renderer', status: 'passed' }],
    changedFiles: ['src/renderer/renderer.js'],
    ...overrides,
  };
}

async function readJournal(runRoot) {
  const source = await fs.readFile(queueJournalPath(runRoot), 'utf8');
  return source.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

test('dispatcher claims the highest priority queued item and owns claim/write-set locks', async () => {
  const run = await makeRun();
  await queueProposal(run, proposal({
    suggestedWorkItemId: 'p3-work',
    fingerprint: 'ux:p3-work',
    severity: 'P3',
    createdAt: '2026-04-30T00:00:01.000Z',
  }), 1);
  await queueProposal(run, proposal({
    suggestedWorkItemId: 'p1-work',
    fingerprint: 'ux:p1-work',
    severity: 'P1',
    createdAt: '2026-04-30T00:00:02.000Z',
  }), 2);

  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-p1-work',
    now: '2026-04-30T00:00:20.000Z',
  });

  assert.equal(claimed.claimed, true);
  assert.equal(claimed.item.id, 'p1-work');
  assert.equal((await findQueueItem(run.runRoot, 'p1-work')).state, 'claimed');
  assert.equal((await readClaimLease(run.runRoot, 'claim-p1-work')).state, 'active');
  assert.deepEqual((await readActiveWriteSetLocks(run.runRoot)).map(lock => lock.lockId), ['wset-claim-p1-work']);

  await assert.rejects(
    acquireWriteSetLock(run.runRoot, {
      runId: run.runId,
      claimId: 'claim-conflict',
      itemId: 'other',
      paths: ['src/renderer/renderer.js'],
    }),
    error => error?.code === 'WRITE_SET_LOCK_CONFLICT',
  );

  const journal = await readJournal(run.runRoot);
  assert.deepEqual(journal.map(entry => entry.action), ['ingest', 'triage', 'ingest', 'triage', 'claim']);
  assert.equal(journal.at(-1).actor, 'orpad.dispatcher');
});

test('dispatcher pauses on approval-required queued item without claiming it', async () => {
  const run = await makeRun('run_20260430_dispatcher_approval');
  await queueProposal(run, proposal({
    suggestedWorkItemId: 'approval-work',
    fingerprint: 'ux:approval-work',
    severity: 'P0',
    approvalRequired: true,
  }));

  const result = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    now: '2026-04-30T00:00:20.000Z',
  });

  assert.equal(result.claimed, false);
  assert.equal(result.stopReason, 'approval-required');
  assert.equal((await findQueueItem(run.runRoot, 'approval-work')).state, 'queued');
  assert.equal((await readActiveClaimLeases(run.runRoot)).length, 0);
  assert.equal((await readRunState(run.runRoot)).lifecycleStatus, 'approval-required');
});

test('dispatcher refuses terminal runs before claiming queued work', async () => {
  const run = await makeRun('run_20260430_dispatcher_terminal');
  const itemId = await queueProposal(run, proposal({
    suggestedWorkItemId: 'terminal-dispatch-work',
    fingerprint: 'ux:terminal-dispatch-work',
  }));
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'cancelled',
    reason: 'test.terminal-before-dispatch',
  });
  const eventsBefore = await readMachineEvents(run.runRoot);

  await assert.rejects(
    claimNextQueuedItem(run.runRoot, {
      runId: run.runId,
      claimId: 'claim-after-terminal-dispatch',
      now: '2026-04-30T00:00:20.000Z',
    }),
    error => error?.code === 'MACHINE_RUN_TERMINAL',
  );

  assert.equal((await findQueueItem(run.runRoot, itemId)).state, 'queued');
  assert.equal((await readActiveClaimLeases(run.runRoot)).length, 0);
  assert.equal((await readActiveWriteSetLocks(run.runRoot)).length, 0);
  assert.equal((await readMachineEvents(run.runRoot)).length, eventsBefore.length);
});

test('worker result closes a claimed item only after proof is accepted', async () => {
  const run = await makeRun('run_20260430_worker_done');
  const itemId = await queueProposal(run, proposal());
  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-worker-done',
    now: '2026-04-30T00:00:20.000Z',
  });
  const request = workerRequest(run, claimed.claim.claimId);

  const applied = await applyWorkerResult(run.runRoot, {
    runId: run.runId,
    claimId: claimed.claim.claimId,
    itemId,
    request,
    result: workerResult(request),
    now: '2026-04-30T00:00:30.000Z',
  });
  const duplicate = await applyWorkerResult(run.runRoot, {
    runId: run.runId,
    claimId: claimed.claim.claimId,
    itemId,
    request,
    result: workerResult(request),
    now: '2026-04-30T00:00:31.000Z',
  });

  assert.equal(applied.toState, 'done');
  assert.equal(duplicate.duplicate, true);
  assert.equal((await findQueueItem(run.runRoot, itemId)).state, 'done');
  assert.equal((await readClaimLease(run.runRoot, claimed.claim.claimId)).state, 'released');
  assert.equal((await readActiveWriteSetLocks(run.runRoot)).length, 0);
  assert.equal((await readMachineEvents(run.runRoot)).filter(event => event.eventType === 'worker.result').length, 1);
  assert.deepEqual((await readJournal(run.runRoot)).map(entry => entry.action), ['ingest', 'triage', 'claim', 'close']);
});

test('worker result refuses terminal runs before closing claimed work', async () => {
  const run = await makeRun('run_20260430_worker_terminal_result');
  const itemId = await queueProposal(run, proposal());
  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-worker-terminal-result',
    now: '2026-04-30T00:00:20.000Z',
  });
  const request = workerRequest(run, claimed.claim.claimId);
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'cancelled',
    reason: 'test.terminal-before-worker-result',
  });
  const eventsBefore = await readMachineEvents(run.runRoot);

  await assert.rejects(
    applyWorkerResult(run.runRoot, {
      runId: run.runId,
      claimId: claimed.claim.claimId,
      itemId,
      request,
      result: workerResult(request),
      now: '2026-04-30T00:00:30.000Z',
    }),
    error => error?.code === 'MACHINE_RUN_TERMINAL',
  );

  assert.equal((await findQueueItem(run.runRoot, itemId)).state, 'claimed');
  assert.equal((await readClaimLease(run.runRoot, claimed.claim.claimId)).state, 'active');
  assert.equal((await readActiveWriteSetLocks(run.runRoot)).length, 1);
  assert.equal((await readMachineEvents(run.runRoot)).length, eventsBefore.length);
});

test('worker done result without artifact and verification proof is rejected before close', async () => {
  const run = await makeRun('run_20260430_worker_proof');
  const itemId = await queueProposal(run, proposal());
  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-worker-proof',
    now: '2026-04-30T00:00:20.000Z',
  });
  const request = workerRequest(run, claimed.claim.claimId);

  await assert.rejects(
    applyWorkerResult(run.runRoot, {
      runId: run.runId,
      claimId: claimed.claim.claimId,
      itemId,
      request,
      result: workerResult(request, { artifacts: [], verification: [] }),
      now: '2026-04-30T00:00:30.000Z',
    }),
    error => error?.code === 'WORKER_DONE_RESULT_MISSING_PROOF',
  );

  assert.equal((await findQueueItem(run.runRoot, itemId)).state, 'claimed');
  assert.equal((await readClaimLease(run.runRoot, claimed.claim.claimId)).state, 'active');
  assert.equal((await readMachineEvents(run.runRoot)).some(event => event.eventType === 'worker.result'), false);
});

test('expired claim rejects late worker result and stale recovery requeues the item', async () => {
  const run = await makeRun('run_20260430_worker_stale');
  const itemId = await queueProposal(run, proposal());
  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-worker-stale',
    leaseMs: 10,
    now: '2026-04-30T00:00:20.000Z',
  });
  const request = workerRequest(run, claimed.claim.claimId);

  await assert.rejects(
    applyWorkerResult(run.runRoot, {
      runId: run.runId,
      claimId: claimed.claim.claimId,
      itemId,
      request,
      result: workerResult(request),
      now: '2026-04-30T00:00:21.000Z',
    }),
    error => error?.code === 'STALE_CLAIM_RESULT_REJECTED',
  );

  const recovered = await recoverStaleClaims(run.runRoot, {
    runId: run.runId,
    now: '2026-04-30T00:00:21.000Z',
  });

  assert.equal(recovered.length, 1);
  assert.equal((await findQueueItem(run.runRoot, itemId)).state, 'queued');
  assert.equal((await readClaimLease(run.runRoot, claimed.claim.claimId)).state, 'expired');
  assert.equal((await readActiveWriteSetLocks(run.runRoot)).length, 0);
});

test('claim cancellation requeues a claimed item and leaves a resumable run state', async () => {
  const run = await makeRun('run_20260430_worker_cancel');
  const itemId = await queueProposal(run, proposal());
  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-worker-cancel',
    now: '2026-04-30T00:00:20.000Z',
  });

  const cancelled = await cancelClaimedItem(run.runRoot, {
    runId: run.runId,
    claimId: claimed.claim.claimId,
    itemId,
    now: '2026-04-30T00:00:30.000Z',
  });

  assert.equal(cancelled.runState.lifecycleStatus, 'waiting');
  assert.equal(cancelled.runState.summaryStatus, 'partial');
  assert.equal((await findQueueItem(run.runRoot, itemId)).state, 'queued');
  assert.equal((await readClaimLease(run.runRoot, claimed.claim.claimId)).state, 'cancelled');
  assert.equal((await readActiveWriteSetLocks(run.runRoot)).length, 0);
});

test('claim cancellation can block a claimed item and cancel the run', async () => {
  const run = await makeRun('run_20260430_worker_cancel_block');
  const itemId = await queueProposal(run, proposal());
  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-worker-cancel-block',
    now: '2026-04-30T00:00:20.000Z',
  });

  const cancelled = await cancelClaimedItem(run.runRoot, {
    runId: run.runId,
    claimId: claimed.claim.claimId,
    itemId,
    toState: 'blocked',
    now: '2026-04-30T00:00:30.000Z',
  });

  assert.equal(cancelled.runState.lifecycleStatus, 'cancelled');
  assert.equal(cancelled.runState.summaryStatus, 'blocked');
  assert.equal((await findQueueItem(run.runRoot, itemId)).state, 'blocked');
  assert.equal((await readClaimLease(run.runRoot, claimed.claim.claimId)).state, 'cancelled');
  assert.equal((await readActiveWriteSetLocks(run.runRoot)).length, 0);
});

test('cancellation refuses terminal runs before releasing claimed work', async () => {
  const run = await makeRun('run_20260430_worker_terminal_cancel');
  const itemId = await queueProposal(run, proposal());
  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-worker-terminal-cancel',
    now: '2026-04-30T00:00:20.000Z',
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'cancelled',
    reason: 'test.terminal-before-cancel',
  });
  const eventsBefore = await readMachineEvents(run.runRoot);

  await assert.rejects(
    cancelClaimedItem(run.runRoot, {
      runId: run.runId,
      claimId: claimed.claim.claimId,
      itemId,
      now: '2026-04-30T00:00:30.000Z',
    }),
    error => error?.code === 'MACHINE_RUN_TERMINAL',
  );

  assert.equal((await findQueueItem(run.runRoot, itemId)).state, 'claimed');
  assert.equal((await readClaimLease(run.runRoot, claimed.claim.claimId)).state, 'active');
  assert.equal((await readActiveWriteSetLocks(run.runRoot)).length, 1);
  assert.equal((await readMachineEvents(run.runRoot)).length, eventsBefore.length);
});

test('serial worker loop processes queued items one at a time until queue-empty', async () => {
  const run = await makeRun('run_20260430_worker_serial');
  await queueProposal(run, proposal({
    suggestedWorkItemId: 'serial-work-a',
    fingerprint: 'ux:serial-work-a',
    sourceOfTruthTargets: ['src/renderer/renderer.js'],
  }), 1);
  await queueProposal(run, proposal({
    suggestedWorkItemId: 'serial-work-b',
    fingerprint: 'ux:serial-work-b',
    sourceOfTruthTargets: ['src/main/runbooks/validator.js'],
  }), 2);

  const result = await runSerialWorkerLoop({
    runRoot: run.runRoot,
    runId: run.runId,
    maxItems: 5,
    now: '2026-04-30T00:00:20.000Z',
    fixtureResult: ({ request, item }) => workerResult(request, {
      artifacts: [`artifacts/work-items/${request.adapterCallId}/proof.md`],
      changedFiles: item.sourceOfTruthTargets,
    }),
  });

  assert.equal(result.steps.length, 2);
  assert.equal(result.stopReason, 'queue-empty');
  assert.deepEqual((await Promise.all([
    findQueueItem(run.runRoot, 'serial-work-a'),
    findQueueItem(run.runRoot, 'serial-work-b'),
  ])).map(entry => entry.state), ['done', 'done']);
  assert.equal((await readMachineEvents(run.runRoot)).filter(event => event.eventType === 'worker.result').length, 2);
});
