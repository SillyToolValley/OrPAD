import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  acquireWriteSetLock,
  appendMachineEvent,
  appendRunLifecycleStatus,
  applyWorkerResult,
  cancelClaimedItem,
  claimLeasePath,
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
  readWriteSetLock,
  recoverStaleClaims,
  registerArtifact,
  runSerialWorkerLoop,
  transitionQueueItem,
  writeSetLockPath,
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

async function createTestSymlink(testContext, target, linkPath, type = 'file') {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch (err) {
    if (['EACCES', 'EPERM', 'ENOTSUP', 'EINVAL'].includes(err?.code)) {
      testContext.skip(`symlink creation is unavailable in this environment: ${err.code}`);
      return false;
    }
    throw err;
  }
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

async function registerWorkerResultArtifacts(run, result) {
  const artifactPaths = [...new Set([
    ...(result.artifacts || []),
    ...(result.patchArtifact ? [result.patchArtifact] : []),
  ].filter(Boolean))];
  for (const artifactPath of artifactPaths) {
    await registerArtifact(run.runRoot, {
      runId: run.runId,
      artifactPath,
      content: `${result.summary}\n`,
      producedBy: 'test.worker-result',
      registeredBy: 'machine',
    });
  }
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

test('dispatcher serializes concurrent claim selection so each queued item is claimed once', async () => {
  const run = await makeRun('run_20260430_dispatcher_atomic_claims');
  await queueProposal(run, proposal({
    suggestedWorkItemId: 'atomic-claim-a',
    fingerprint: 'ux:atomic-claim-a',
    sourceOfTruthTargets: ['src/atomic-a.md'],
  }), 1);
  await queueProposal(run, proposal({
    suggestedWorkItemId: 'atomic-claim-b',
    fingerprint: 'ux:atomic-claim-b',
    sourceOfTruthTargets: ['src/atomic-b.md'],
  }), 2);

  const results = await Promise.all([
    claimNextQueuedItem(run.runRoot, {
      runId: run.runId,
      now: '2026-04-30T00:00:20.000Z',
    }),
    claimNextQueuedItem(run.runRoot, {
      runId: run.runId,
      now: '2026-04-30T00:00:20.000Z',
    }),
  ]);

  assert.deepEqual(results.map(result => result.claimed), [true, true]);
  assert.deepEqual(results.map(result => result.item.id).sort(), ['atomic-claim-a', 'atomic-claim-b']);
  assert.equal(new Set(results.map(result => result.claim.claimId)).size, 2);
  assert.deepEqual((await Promise.all([
    findQueueItem(run.runRoot, 'atomic-claim-a'),
    findQueueItem(run.runRoot, 'atomic-claim-b'),
  ])).map(entry => entry.state), ['claimed', 'claimed']);
  const claimEvents = (await readMachineEvents(run.runRoot))
    .filter(event => event.eventType === 'queue.transition' && event.toState === 'claimed');
  assert.equal(claimEvents.length, 2);
  assert.equal(new Set(claimEvents.map(event => event.itemId)).size, 2);
});

test('dispatcher treats unresolved patch artifacts as virtual write locks and claims non-overlapping work', async () => {
  const run = await makeRun('run_20260430_dispatcher_pending_patch_selects_around_overlap');
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId: 'completed-shared-work',
    reason: 'test.pending-patch-artifact',
    artifactRefs: ['artifacts/patches/shared.patch.json'],
    payload: {
      claimId: 'claim-completed-shared-work',
      patchArtifact: 'artifacts/patches/shared.patch.json',
      changedFiles: ['src/shared.md'],
      status: 'done',
    },
  });
  await queueProposal(run, proposal({
    suggestedWorkItemId: 'overlapping-work',
    fingerprint: 'ux:overlapping-work',
    createdAt: '2026-04-30T00:00:01.000Z',
    sourceOfTruthTargets: ['src/shared.md'],
  }), 1);
  await queueProposal(run, proposal({
    suggestedWorkItemId: 'independent-work',
    fingerprint: 'ux:independent-work',
    createdAt: '2026-04-30T00:00:02.000Z',
    sourceOfTruthTargets: ['src/other.md'],
  }), 2);

  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-independent-work',
    now: '2026-04-30T00:00:20.000Z',
  });

  assert.equal(claimed.claimed, true);
  assert.equal(claimed.item.id, 'independent-work');
  assert.deepEqual(claimed.pendingPatchOverlaps.map(entry => entry.itemId), ['overlapping-work']);
  assert.deepEqual(claimed.pendingPatchOverlaps[0].overlappingPaths, ['src/shared.md']);
  assert.equal((await findQueueItem(run.runRoot, 'overlapping-work')).state, 'queued');
  assert.equal((await findQueueItem(run.runRoot, 'independent-work')).state, 'claimed');
});

test('dispatcher pauses claiming when every queued item overlaps an unresolved patch artifact', async () => {
  const run = await makeRun('run_20260430_dispatcher_pending_patch_all_overlap');
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId: 'completed-shared-work',
    reason: 'test.pending-patch-artifact',
    artifactRefs: ['artifacts/patches/shared.patch.json'],
    payload: {
      claimId: 'claim-completed-shared-work',
      patchArtifact: 'artifacts/patches/shared.patch.json',
      changedFiles: ['src/shared.md'],
      status: 'done',
    },
  });
  await queueProposal(run, proposal({
    suggestedWorkItemId: 'overlapping-work',
    fingerprint: 'ux:overlapping-work',
    sourceOfTruthTargets: ['src/shared.md'],
  }), 1);

  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    now: '2026-04-30T00:00:20.000Z',
  });

  assert.equal(claimed.claimed, false);
  assert.equal(claimed.stopReason, 'pending-patch-overlap');
  assert.deepEqual(claimed.pendingPatchOverlaps.map(entry => entry.patchArtifact), ['artifacts/patches/shared.patch.json']);
  assert.equal((await findQueueItem(run.runRoot, 'overlapping-work')).state, 'queued');
  assert.equal((await readActiveWriteSetLocks(run.runRoot)).length, 0);
});

test('dispatcher does not treat blocked worker patch artifacts as virtual write locks', async () => {
  const run = await makeRun('run_20260520_dispatcher_ignores_blocked_patch_lock');
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId: 'blocked-shared-work',
    reason: 'test.blocked-patch-artifact',
    artifactRefs: ['artifacts/patches/blocked.patch.json'],
    payload: {
      claimId: 'claim-blocked-shared-work',
      patchArtifact: 'artifacts/patches/blocked.patch.json',
      changedFiles: ['src/shared.md'],
      status: 'blocked',
      toState: 'blocked',
    },
  });
  await queueProposal(run, proposal({
    suggestedWorkItemId: 'overlapping-work',
    fingerprint: 'ux:overlapping-work-after-blocked',
    sourceOfTruthTargets: ['src/shared.md'],
  }), 1);

  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-overlapping-work',
    now: '2026-05-20T00:00:20.000Z',
  });

  assert.equal(claimed.claimed, true);
  assert.equal(claimed.item.id, 'overlapping-work');
  assert.deepEqual(claimed.pendingPatchOverlaps, []);
  assert.equal((await findQueueItem(run.runRoot, 'overlapping-work')).state, 'claimed');
});

test('dispatcher allows overlapping queued work after the pending patch artifact is resolved', async () => {
  const run = await makeRun('run_20260430_dispatcher_pending_patch_resolved');
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId: 'completed-shared-work',
    reason: 'test.pending-patch-artifact',
    artifactRefs: ['artifacts/patches/shared.patch.json'],
    payload: {
      claimId: 'claim-completed-shared-work',
      patchArtifact: 'artifacts/patches/shared.patch.json',
      changedFiles: ['src/shared.md'],
      status: 'done',
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'patch.applied',
    reason: 'test.patch-applied',
    artifactRefs: ['artifacts/patches/shared.patch.json'],
    payload: {
      patchArtifact: 'artifacts/patches/shared.patch.json',
      selectedFiles: ['src/shared.md'],
      applied: [{ path: 'src/shared.md' }],
    },
  });
  await queueProposal(run, proposal({
    suggestedWorkItemId: 'overlapping-work',
    fingerprint: 'ux:overlapping-work',
    sourceOfTruthTargets: ['src/shared.md'],
  }), 1);

  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-overlapping-work',
    now: '2026-04-30T00:00:20.000Z',
  });

  assert.equal(claimed.claimed, true);
  assert.equal(claimed.item.id, 'overlapping-work');
  assert.deepEqual(claimed.pendingPatchOverlaps, []);
});

test('dispatcher audit-only write-set mode lets overlapping worker claims reach the in-memory lock manager', async () => {
  const run = await makeRun('run_20260430_dispatcher_audit_only_writesets');
  await queueProposal(run, proposal({
    suggestedWorkItemId: 'audit-only-a',
    fingerprint: 'ux:audit-only-a',
    sourceOfTruthTargets: ['src/shared.md'],
  }), 1);
  await queueProposal(run, proposal({
    suggestedWorkItemId: 'audit-only-b',
    fingerprint: 'ux:audit-only-b',
    sourceOfTruthTargets: ['src/shared.md'],
  }), 2);

  const first = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    enforceWriteSetConflicts: false,
    now: '2026-04-30T00:00:20.000Z',
  });
  const second = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    enforceWriteSetConflicts: false,
    now: '2026-04-30T00:00:21.000Z',
  });

  assert.equal(first.claimed, true);
  assert.equal(second.claimed, true);
  assert.deepEqual([first.item.id, second.item.id], ['audit-only-a', 'audit-only-b']);
  const activeWriteSets = await readActiveWriteSetLocks(run.runRoot);
  assert.equal(activeWriteSets.length, 2);
  assert.deepEqual(activeWriteSets.map(lock => lock.paths), [['src/shared.md'], ['src/shared.md']]);
  const acquiredEvents = (await readMachineEvents(run.runRoot))
    .filter(event => event.eventType === 'write-set.acquired');
  assert.deepEqual(acquiredEvents.map(event => event.payload.conflictPolicy), ['audit-only', 'audit-only']);

  await assert.rejects(
    acquireWriteSetLock(run.runRoot, {
      runId: run.runId,
      claimId: 'claim-enforced-conflict',
      itemId: 'enforced-conflict',
      paths: ['src/shared.md'],
    }),
    error => error?.code === 'WRITE_SET_LOCK_CONFLICT',
  );
});

test('dispatcher uses candidate targetFiles as the claim write set when present', async () => {
  const run = await makeRun('run_20260430_dispatcher_target_files_writeset');
  await queueProposal(run, proposal({
    suggestedWorkItemId: 'target-files-work',
    fingerprint: 'ux:target-files-work',
    sourceOfTruthTargets: ['src/source-only.md'],
    targetFiles: ['src/source-only.md', 'tests/source-only.test.mjs'],
  }));

  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-target-files-work',
    now: '2026-04-30T00:00:20.000Z',
  });

  assert.equal(claimed.claimed, true);
  assert.deepEqual(claimed.writeSet.paths, ['src/source-only.md', 'tests/source-only.test.mjs']);
  assert.deepEqual((await readClaimLease(run.runRoot, claimed.claim.claimId)).writeSetPaths, [
    'src/source-only.md',
    'tests/source-only.test.mjs',
  ]);
});

test('dispatcher lock stores reject symlinked claim and write-set files', async t => {
  const run = await makeRun('run_20260430_dispatcher_lock_symlink');
  await queueProposal(run, proposal({
    suggestedWorkItemId: 'lock-symlink-work',
    fingerprint: 'ux:lock-symlink-work',
  }));
  await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-lock-symlink-work',
    now: '2026-04-30T00:00:20.000Z',
  });

  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-lock-symlink-target-'));
  const outsideClaim = path.join(outsideRoot, 'claim.json');
  const outsideWriteSet = path.join(outsideRoot, 'write-set.json');
  await fs.writeFile(outsideClaim, JSON.stringify({ claimId: 'claim-lock-symlink-work', state: 'active' }), 'utf8');
  await fs.writeFile(outsideWriteSet, JSON.stringify({ lockId: 'wset-claim-lock-symlink-work', state: 'active' }), 'utf8');
  await fs.rm(claimLeasePath(run.runRoot, 'claim-lock-symlink-work'));
  await fs.rm(writeSetLockPath(run.runRoot, 'wset-claim-lock-symlink-work'));
  if (!await createTestSymlink(t, outsideClaim, claimLeasePath(run.runRoot, 'claim-lock-symlink-work'), 'file')) return;
  if (!await createTestSymlink(t, outsideWriteSet, writeSetLockPath(run.runRoot, 'wset-claim-lock-symlink-work'), 'file')) return;

  await assert.rejects(
    readClaimLease(run.runRoot, 'claim-lock-symlink-work'),
    error => error?.code === 'MACHINE_CLAIM_LEASE_SYMLINK_UNSAFE',
  );
  await assert.rejects(
    readActiveClaimLeases(run.runRoot),
    error => error?.code === 'MACHINE_CLAIM_LEASE_SYMLINK_UNSAFE',
  );
  await assert.rejects(
    readWriteSetLock(run.runRoot, 'wset-claim-lock-symlink-work'),
    error => error?.code === 'MACHINE_WRITE_SET_LOCK_SYMLINK_UNSAFE',
  );
  await assert.rejects(
    readActiveWriteSetLocks(run.runRoot),
    error => error?.code === 'MACHINE_WRITE_SET_LOCK_SYMLINK_UNSAFE',
  );
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

  const repeated = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    now: '2026-04-30T00:00:21.000Z',
  });
  assert.equal(repeated.claimed, false);
  assert.equal(repeated.stopReason, 'approval-required');
  assert.equal(repeated.approval.duplicate, true);
  assert.equal((await readMachineEvents(run.runRoot)).filter(event => event.eventType === 'approval.requested').length, 1);

  const externalGrant = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    approvalGrants: [true],
    now: '2026-04-30T00:00:22.000Z',
  });
  assert.equal(externalGrant.claimed, false);
  assert.equal(externalGrant.stopReason, 'approval-required');
  assert.equal(externalGrant.approval.duplicate, true);
  assert.equal((await readActiveClaimLeases(run.runRoot)).length, 0);
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

test('dispatcher rejects unsafe claim ids before creating locks or claims', async () => {
  const run = await makeRun('run_20260430_dispatcher_unsafe_claim');
  const itemId = await queueProposal(run, proposal({
    suggestedWorkItemId: 'unsafe-claim-work',
    fingerprint: 'ux:unsafe-claim-work',
  }));

  await assert.rejects(
    claimNextQueuedItem(run.runRoot, {
      runId: run.runId,
      claimId: '../claim-unsafe',
      now: '2026-04-30T00:00:20.000Z',
    }),
    error => error?.code === 'MACHINE_STORAGE_ID_INVALID' && error?.field === 'claimId',
  );

  assert.equal((await findQueueItem(run.runRoot, itemId)).state, 'queued');
  assert.equal((await readActiveClaimLeases(run.runRoot)).length, 0);
  assert.equal((await readActiveWriteSetLocks(run.runRoot)).length, 0);
});

test('write-set locks reject unsafe lock ids before creating durable files', async () => {
  const run = await makeRun('run_20260430_dispatcher_unsafe_write_set');

  await assert.rejects(
    acquireWriteSetLock(run.runRoot, {
      runId: run.runId,
      claimId: 'claim-safe',
      itemId: 'item-safe',
      lockId: '../wset-unsafe',
      paths: ['src/renderer/renderer.js'],
    }),
    error => error?.code === 'MACHINE_STORAGE_ID_INVALID' && error?.field === 'lockId',
  );

  assert.equal((await readActiveWriteSetLocks(run.runRoot)).length, 0);
  assert.equal((await readMachineEvents(run.runRoot)).filter(event => event.eventType === 'write-set.acquired').length, 0);
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
  const result = workerResult(request);
  await registerWorkerResultArtifacts(run, result);

  const applied = await applyWorkerResult(run.runRoot, {
    runId: run.runId,
    claimId: claimed.claim.claimId,
    itemId,
    request,
    result,
    now: '2026-04-30T00:00:30.000Z',
  });
  const duplicate = await applyWorkerResult(run.runRoot, {
    runId: run.runId,
    claimId: claimed.claim.claimId,
    itemId,
    request,
    result,
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

test('worker done result must include required harness validation evidence', async () => {
  const run = await makeRun('run_20260521_worker_harness_validation_missing');
  const itemId = await queueProposal(run, proposal({
    suggestedWorkItemId: 'harness-validation-item',
  }));
  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-worker-harness-validation-missing',
    now: '2026-04-30T00:00:20.000Z',
  });
  const request = workerRequest(run, claimed.claim.claimId);
  const result = workerResult(request, {
    verification: [{ command: 'static inspection', status: 'passed' }],
  });
  await registerWorkerResultArtifacts(run, result);

  await assert.rejects(
    applyWorkerResult(run.runRoot, {
      runId: run.runId,
      claimId: claimed.claim.claimId,
      itemId,
      request,
      result,
      now: '2026-04-30T00:00:30.000Z',
      requiredValidationCommands: ['dotnet test ThreadProgramming.sln --no-build'],
    }),
    error => error?.code === 'WORKER_DONE_RESULT_MISSING_HARNESS_VALIDATION',
  );

  assert.equal((await readMachineEvents(run.runRoot)).filter(event => event.eventType === 'worker.result').length, 0);
});

test('worker done result accepts harness validation command evidence', async () => {
  const run = await makeRun('run_20260521_worker_harness_validation_present');
  const itemId = await queueProposal(run, proposal({
    suggestedWorkItemId: 'harness-validation-present',
  }));
  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-worker-harness-validation-present',
    now: '2026-04-30T00:00:20.000Z',
  });
  const request = workerRequest(run, claimed.claim.claimId);
  const result = workerResult(request, {
    verification: [{
      command: 'dotnet',
      args: ['test', 'ThreadProgramming.sln', '--no-build'],
      status: 'passed',
    }],
  });
  await registerWorkerResultArtifacts(run, result);

  const applied = await applyWorkerResult(run.runRoot, {
    runId: run.runId,
    claimId: claimed.claim.claimId,
    itemId,
    request,
    result,
    now: '2026-04-30T00:00:30.000Z',
    requiredValidationCommands: ['dotnet test ThreadProgramming.sln --no-build'],
  });

  assert.equal(applied.toState, 'done');
  const workerEvent = (await readMachineEvents(run.runRoot)).find(event => event.eventType === 'worker.result');
  assert.equal(workerEvent.payload.summary, 'Applied fixture worker result.');
});

test('approval-required worker result requeues claimed item and creates permission request', async () => {
  const run = await makeRun('run_20260430_worker_llm_permission');
  const itemId = await queueProposal(run, proposal({
    suggestedWorkItemId: 'llm-permission-item',
  }));
  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-worker-llm-permission',
    now: '2026-04-30T00:00:20.000Z',
  });
  const request = workerRequest(run, claimed.claim.claimId);
  request.commandSpec = {
    command: 'claude',
    args: ['--print', 'work'],
    cwd: 'overlay',
  };
  const result = workerResult(request, {
    status: 'approval-required',
    summary: 'Provider requested permission.',
    artifacts: [],
    verification: [{ command: 'claude', args: ['--print', 'work'], cwdKind: 'overlay' }],
    changedFiles: [],
    requestedCapabilities: ['llm-cli-tool-permission', 'workspace-overlay-write'],
    approvalRequest: {
      reason: 'llm-cli-permission-required',
      commandSpec: request.commandSpec,
    },
  });

  const applied = await applyWorkerResult(run.runRoot, {
    runId: run.runId,
    claimId: claimed.claim.claimId,
    itemId,
    request,
    result,
    now: '2026-04-30T00:00:30.000Z',
  });
  const queued = await findQueueItem(run.runRoot, itemId);
  const events = await readMachineEvents(run.runRoot);

  assert.equal(applied.toState, 'queued');
  assert.equal(applied.approval.request.itemId, itemId);
  assert.deepEqual(applied.approval.request.requestedCapabilities, ['llm-cli-tool-permission', 'workspace-overlay-write']);
  assert.equal(queued.state, 'queued');
  assert.equal(queued.item.approvalRequired, true);
  assert.equal((await readRunState(run.runRoot)).lifecycleStatus, 'approval-required');
  assert.equal(events.some(event => event.eventType === 'approval.requested'), true);
  assert.equal((await readActiveClaimLeases(run.runRoot)).length, 0);
  assert.equal((await readActiveWriteSetLocks(run.runRoot)).length, 0);
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

test('worker done result requires registered proof artifacts before close', async () => {
  const run = await makeRun('run_20260430_worker_unregistered_proof');
  const itemId = await queueProposal(run, proposal());
  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-worker-unregistered-proof',
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
      now: '2026-04-30T00:00:30.000Z',
    }),
    error => error?.code === 'WORKER_RESULT_ARTIFACT_UNREGISTERED',
  );

  assert.equal((await findQueueItem(run.runRoot, itemId)).state, 'claimed');
  assert.equal((await readClaimLease(run.runRoot, claimed.claim.claimId)).state, 'active');
  assert.equal((await readMachineEvents(run.runRoot)).some(event => event.eventType === 'worker.result'), false);
});

test('worker result rejects invalid close targets before recording result events', async () => {
  const run = await makeRun('run_20260430_worker_invalid_target');
  const itemId = await queueProposal(run, proposal());
  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-worker-invalid-target',
    now: '2026-04-30T00:00:20.000Z',
  });
  const request = workerRequest(run, claimed.claim.claimId);
  const eventsBefore = await readMachineEvents(run.runRoot);

  await assert.rejects(
    applyWorkerResult(run.runRoot, {
      runId: run.runId,
      claimId: claimed.claim.claimId,
      itemId,
      request,
      result: workerResult(request),
      toState: 'candidate',
      now: '2026-04-30T00:00:30.000Z',
    }),
    error => error?.code === 'WORKER_RESULT_TARGET_INVALID',
  );

  assert.equal((await findQueueItem(run.runRoot, itemId)).state, 'claimed');
  assert.equal((await readClaimLease(run.runRoot, claimed.claim.claimId)).state, 'active');
  assert.equal((await readMachineEvents(run.runRoot)).length, eventsBefore.length);
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

test('claim cancellation emits node.cancelled for any in-flight node.started attempt', async () => {
  const run = await makeRun('run_20260507_node_cancelled_emit');
  const itemId = await queueProposal(run, proposal());
  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-node-cancelled-emit',
    now: '2026-05-07T00:00:20.000Z',
  });
  // Simulate an in-flight worker attempt: worker calls recordNodeLifecycleEvent
  // with status='started' before invoking the CLI overlay. Our cancel path
  // should now emit node.cancelled for that attempt so the renderer's
  // runtime projection drops the active "Running" badge.
  const { recordNodeLifecycleEvent } = require('../../src/main/orchestration-machine');
  await recordNodeLifecycleEvent(run.runRoot, {
    runId: run.runId,
    nodePath: 'main/worker',
    nodeType: 'orpad.workerLoop',
    status: 'started',
    attempt: 1,
  });

  await cancelClaimedItem(run.runRoot, {
    runId: run.runId,
    claimId: claimed.claim.claimId,
    itemId,
    now: '2026-05-07T00:00:30.000Z',
  });

  const events = await readMachineEvents(run.runRoot);
  const cancelledNodeEvents = events.filter(e => e.eventType === 'node.cancelled');
  assert.equal(cancelledNodeEvents.length, 1);
  assert.equal(cancelledNodeEvents[0].nodePath, 'main/worker');
  assert.equal(cancelledNodeEvents[0].payload.attempt, 1);
  assert.equal(cancelledNodeEvents[0].payload.reason, 'worker-loop.cancel');
});

test('claim cancellation rejects invalid close targets before recording cancelling status', async () => {
  const run = await makeRun('run_20260430_worker_cancel_invalid_target');
  const itemId = await queueProposal(run, proposal());
  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-worker-cancel-invalid-target',
    now: '2026-04-30T00:00:20.000Z',
  });
  const eventsBefore = await readMachineEvents(run.runRoot);

  await assert.rejects(
    cancelClaimedItem(run.runRoot, {
      runId: run.runId,
      claimId: claimed.claim.claimId,
      itemId,
      toState: 'done',
      now: '2026-04-30T00:00:30.000Z',
    }),
    error => error?.code === 'CLAIM_CANCELLATION_TARGET_INVALID',
  );

  assert.equal((await findQueueItem(run.runRoot, itemId)).state, 'claimed');
  assert.equal((await readClaimLease(run.runRoot, claimed.claim.claimId)).state, 'active');
  assert.equal((await readMachineEvents(run.runRoot)).length, eventsBefore.length);
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
    fixtureResult: async ({ request, item }) => {
      const result = workerResult(request, {
        artifacts: [`artifacts/work-items/${request.adapterCallId}/proof.md`],
        changedFiles: item.sourceOfTruthTargets,
      });
      await registerWorkerResultArtifacts(run, result);
      return result;
    },
  });

  assert.equal(result.steps.length, 2);
  assert.equal(result.stopReason, 'queue-empty');
  assert.deepEqual((await Promise.all([
    findQueueItem(run.runRoot, 'serial-work-a'),
    findQueueItem(run.runRoot, 'serial-work-b'),
  ])).map(entry => entry.state), ['done', 'done']);
  assert.equal((await readMachineEvents(run.runRoot)).filter(event => event.eventType === 'worker.result').length, 2);
});
