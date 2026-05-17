import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  cancelClaimedItem,
  claimNextQueuedItem,
  createFileLockManager,
  createMachineRun,
  ingestCandidateProposal,
  readMachineEvents,
  transitionQueueItem,
} = require('../../src/main/orchestration-machine');
const workerLoopModule = require('../../src/main/orchestration-machine/worker-loop');

// File-Lock Queue Phase 2.C regression coverage (codex consult
// 2026-05-16). Codex recommended "A-prime": Phase 2 wiring plus
// targeted concurrency regression tests that exercise the lock
// manager under contention BEFORE bumping the worker concurrency
// default. These tests use direct `runWorkerLoopOnce` invocations
// to bypass the dispatcher's per-claim write-set lock (which is
// fs-backed and serializes claims itself); we want to prove the
// in-memory lock manager arbitrates correctly between simultaneous
// worker dispatches.

async function makeRun(runId) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-flq-worker-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/flq-worker');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'flq-worker',
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

// Build a synthetic "claim" object that runWorkerLoopOnce accepts
// without going through the real dispatcher. The lock manager only
// reads claim.claim.claimId and claim.writeSet?.paths, so the
// minimal shape is fine for testing the lock contract.
function syntheticClaim(claimId, writeSetPaths) {
  return {
    claimed: true,
    item: { id: `item-${claimId}` },
    claim: { claimId },
    writeSet: { paths: writeSetPaths },
  };
}

function proposal(id, targetFiles) {
  return {
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: `proposal-${id}`,
    suggestedWorkItemId: id,
    sourceNode: 'main/probe',
    title: `Exercise ${id}`,
    fingerprint: `flq:${id}`,
    evidence: [{ id: `${id}-source`, file: targetFiles[0] || 'src/unknown.md' }],
    acceptanceCriteria: [`${id} is processed.`],
    sourceOfTruthTargets: targetFiles,
    targetFiles,
  };
}

async function queueAndClaim(run, id, targetFiles, claimId) {
  const candidate = await ingestCandidateProposal(run.runRoot, proposal(id, targetFiles), {
    runId: run.runId,
    now: '2026-05-16T00:00:01.000Z',
    transitionId: `ingest:${id}`,
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: candidate.item.id,
    toState: 'queued',
    reason: 'triage.accepted',
    transitionId: `triage:${id}`,
    now: '2026-05-16T00:00:02.000Z',
  });
  return claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId,
    enforceWriteSetConflicts: false,
    now: '2026-05-16T00:00:03.000Z',
  });
}

async function waitForEvent(runRoot, predicate, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const match = (await readMachineEvents(runRoot)).find(predicate);
    if (match) return match;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for event: ${label}`);
}

// Fixture worker that simulates "work" by waiting until manually
// signaled. Two parallel runWorkerLoopOnce calls use these to
// observe ordering under contention. The fixture returns a result
// that satisfies the adapter-call-id check but downstream
// applyWorkerResult will reject (the synthetic claim isn't backed
// by a real queue item) — callers must wrap runWorkerLoopOnce in a
// try/catch and ignore the post-lock rejection. The lock acquire/
// release happens BEFORE applyWorkerResult, so its state is fully
// observable in the events log regardless.
function buildBlockingFixture() {
  let resolveSignal;
  const signal = new Promise(resolve => { resolveSignal = resolve; });
  return {
    fixtureResult: async ({ request } = {}) => {
      await signal;
      return {
        schemaVersion: 'orpad.workerResult.v1',
        adapterCallId: request?.adapterCallId || 'worker-fixture',
        attemptId: request?.attemptId || 'worker-fixture-1',
        idempotencyKey: request?.idempotencyKey || 'worker-fixture-key',
        status: 'done',
        summary: 'fixture-done',
        artifacts: [],
        verification: [],
        changedFiles: [],
      };
    },
    release: () => resolveSignal(),
  };
}

// Wrapper: swallows applyWorkerResult-side rejections so the tests
// can focus on lock acquire/release/state. The lock is released in
// the finally inside runWorkerLoopOnce BEFORE applyWorkerResult
// runs, so the lock observation is unaffected by the apply failure.
function runWorker(options) {
  return workerLoopModule.runWorkerLoopOnce(options).catch(() => null);
}

// Codex Phase 2 P1 #1 fix (2026-05-16): lock the UNION of
// node-config targetFiles + claim.writeSet so the lock-scope
// covers everything `assertWorkerResultWithinWriteSet` will allow.
// The previous "precedence" semantics let the worker edit a
// claim-scoped file UNDER NO LOCK — parallel workers could race it.
test('Phase 2.A (Codex P1 #1): lock acquires the UNION of node-config targetFiles + claim.writeSet so validation and lock-scope match', async (t) => {
  const { workspaceRoot, run } = await makeRun('run_flq_lt_union');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const lockManager = createFileLockManager();

  const fixture = buildBlockingFixture();
  // Fire the fixture immediately so the worker resolves.
  fixture.release();

  // Claim says "writes src/claim-only.md". Worker node config
  // declares "writes src/node-only.md". The lock should acquire
  // BOTH so a parallel worker that targets either is serialized.
  await runWorker({
    runRoot: run.runRoot,
    runId: run.runId,
    claim: syntheticClaim('claim-union-1', ['src/claim-only.md']),
    fixtureResult: fixture.fixtureResult,
    lockManager,
    lockTargetFiles: ['src/node-only.md'],
  });

  const events = await readMachineEvents(run.runRoot);
  const grantedEvent = events.find(event => event.eventType === 'lock.granted');
  assert.ok(grantedEvent);
  assert.deepEqual(
    grantedEvent.payload.targetFiles.sort(),
    ['src/claim-only.md', 'src/node-only.md'],
    'lock should hold the UNION of both declarations',
  );
  assert.equal(grantedEvent.payload.targetFilesSource, 'union');
});

test('Phase 2.A: empty lockTargetFiles falls back to claim.writeSet.paths', async (t) => {
  const { workspaceRoot, run } = await makeRun('run_flq_lt_fallback');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const lockManager = createFileLockManager();
  const fixture = buildBlockingFixture();
  fixture.release();
  await runWorker({
    runRoot: run.runRoot,
    runId: run.runId,
    claim: syntheticClaim('claim-fallback-1', ['src/probe-emitted.md']),
    fixtureResult: fixture.fixtureResult,
    lockManager,
    lockTargetFiles: [], // empty = fall back to claim.writeSet
  });
  const events = await readMachineEvents(run.runRoot);
  const grantedEvent = events.find(event => event.eventType === 'lock.granted');
  assert.deepEqual(grantedEvent.payload.targetFiles, ['src/probe-emitted.md']);
  assert.equal(grantedEvent.payload.targetFilesSource, 'claim-writeset');
});

test('Phase 2.C: two parallel workers with DISJOINT targetFiles run concurrently (lock manager grants both immediately)', async (t) => {
  const { workspaceRoot, run } = await makeRun('run_flq_disjoint');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const lockManager = createFileLockManager();

  // Both workers want different files. With Phase 2 wiring the
  // lock manager grants both immediately — no contention.
  const fixtureA = buildBlockingFixture();
  const fixtureB = buildBlockingFixture();

  const workerA = runWorker({
    runRoot: run.runRoot,
    runId: run.runId,
    claim: syntheticClaim('claim-disjoint-a', []),
    fixtureResult: fixtureA.fixtureResult,
    lockManager,
    lockTargetFiles: ['src/feature-a.md'],
    adapterCallId: 'worker-a',
    attemptId: 'worker-a-attempt-1',
    idempotencyKey: 'worker-a-key',
  });
  const workerB = runWorker({
    runRoot: run.runRoot,
    runId: run.runId,
    claim: syntheticClaim('claim-disjoint-b', []),
    fixtureResult: fixtureB.fixtureResult,
    lockManager,
    lockTargetFiles: ['src/feature-b.md'],
    adapterCallId: 'worker-b',
    attemptId: 'worker-b-attempt-1',
    idempotencyKey: 'worker-b-key',
  });

  // Both fixtures should have been entered (= both got their locks)
  // before either releases. Yield several microtasks to let the
  // promises move forward.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const stateBeforeRelease = lockManager.snapshot();
  assert.equal(
    stateBeforeRelease.heldByFile.get('src/feature-a.md'),
    'claim-disjoint-a',
    'worker-a should hold its file',
  );
  assert.equal(
    stateBeforeRelease.heldByFile.get('src/feature-b.md'),
    'claim-disjoint-b',
    'worker-b should hold its file in parallel',
  );
  fixtureA.release();
  fixtureB.release();
  await Promise.all([workerA, workerB]);
  // After release the manager has no holdings.
  const stateAfter = lockManager.snapshot();
  assert.equal(stateAfter.heldByFile.size, 0);
});

test('Phase 2.C: two parallel workers with OVERLAPPING targetFiles serialize — worker-b waits for worker-a to release before holding the shared file', async (t) => {
  const { workspaceRoot, run } = await makeRun('run_flq_overlap');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const lockManager = createFileLockManager();

  const fixtureA = buildBlockingFixture();
  const fixtureB = buildBlockingFixture();
  let bGrantedBeforeARelease = false;

  const workerA = runWorker({
    runRoot: run.runRoot,
    runId: run.runId,
    claim: syntheticClaim('claim-overlap-a', []),
    fixtureResult: fixtureA.fixtureResult,
    lockManager,
    lockTargetFiles: ['src/shared.md'],
    adapterCallId: 'worker-overlap-a',
    attemptId: 'worker-overlap-a-attempt-1',
    idempotencyKey: 'worker-overlap-a-key',
  });
  // Start worker-b AFTER yielding so worker-a's acquire fires first.
  await Promise.resolve(); await Promise.resolve();
  // worker-a should now hold src/shared.md.
  const midState = lockManager.snapshot();
  assert.equal(midState.heldByFile.get('src/shared.md'), 'claim-overlap-a');

  const workerB = runWorker({
    runRoot: run.runRoot,
    runId: run.runId,
    claim: syntheticClaim('claim-overlap-b', []),
    fixtureResult: fixtureB.fixtureResult,
    lockManager,
    lockTargetFiles: ['src/shared.md'],
    adapterCallId: 'worker-overlap-b',
    attemptId: 'worker-overlap-b-attempt-1',
    idempotencyKey: 'worker-overlap-b-key',
  });
  await Promise.resolve(); await Promise.resolve();
  // worker-a still holds; worker-b is queued.
  const queuedState = lockManager.snapshot();
  assert.equal(queuedState.heldByFile.get('src/shared.md'), 'claim-overlap-a');
  assert.equal(queuedState.waitersCount, 1, 'worker-b should be queued');

  fixtureA.release();
  await workerA;
  // After A releases, B should now hold src/shared.md.
  await Promise.resolve(); await Promise.resolve();
  const postReleaseState = lockManager.snapshot();
  assert.equal(postReleaseState.heldByFile.get('src/shared.md'), 'claim-overlap-b');
  fixtureB.release();
  await workerB;
  const finalState = lockManager.snapshot();
  assert.equal(finalState.heldByFile.size, 0);

  // Crucially: even though both workers wanted the same file, the
  // run produced ZERO patchReview-style conflict events. The
  // routine race was serialized silently.
  const events = await readMachineEvents(run.runRoot);
  const conflictEvents = events.filter(event => (
    event.eventType === 'patch.apply_conflict' || event.eventType === 'patch.apply_failed'
  ));
  assert.equal(conflictEvents.length, 0, 'lock manager must serialize the routine race without surfacing patchReview');
  const waitingEvents = events.filter(event => event.eventType === 'lock.waiting');
  assert.equal(waitingEvents.length, 1, 'queued workers should emit a lock.waiting audit event');
  assert.equal(waitingEvents[0].payload.taskId, 'claim-overlap-b');
  assert.equal(waitingEvents[0].nodePath, 'queue/worker-loop');
  // Both got lock.granted events with the same targetFiles.
  const grantedEvents = events.filter(event => event.eventType === 'lock.granted');
  assert.equal(grantedEvents.length, 2);
  assert.equal(grantedEvents.every(event => event.nodePath === 'queue/worker-loop'), true);
  // Second granted event records waited=true because it queued.
  const sortedGranted = [...grantedEvents].sort((a, b) => a.sequence - b.sequence);
  assert.equal(sortedGranted[0].payload.waited, false, 'first worker grants immediately');
  assert.equal(sortedGranted[1].payload.waited, true, 'second worker waited for the first to release');
});

test('Phase 2.C: lock is released even when adapter throws (lock.released event still fires)', async (t) => {
  const { workspaceRoot, run } = await makeRun('run_flq_throw');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const lockManager = createFileLockManager();

  await assert.rejects(workerLoopModule.runWorkerLoopOnce({
    runRoot: run.runRoot,
    runId: run.runId,
    claim: syntheticClaim('claim-throw', []),
    fixtureResult: () => {
      throw new Error('adapter exploded');
    },
    lockManager,
    lockTargetFiles: ['src/explodes.md'],
    adapterCallId: 'worker-throw',
    attemptId: 'worker-throw-attempt-1',
    idempotencyKey: 'worker-throw-key',
  }), /adapter exploded/);

  // Lock state must be CLEAN after the throw — no leaked holdings.
  const stateAfter = lockManager.snapshot();
  assert.equal(stateAfter.heldByFile.size, 0, 'lock must be released on adapter throw');
  // lock.released event must have fired.
  const events = await readMachineEvents(run.runRoot);
  const released = events.find(event => event.eventType === 'lock.released');
  assert.ok(released, 'lock.released must fire even when the adapter throws');
});

test('Phase B: lock is released when worker result application fails after adapter success', async (t) => {
  const { workspaceRoot, run } = await makeRun('run_flq_apply_failure_release');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const lockManager = createFileLockManager();

  await assert.rejects(workerLoopModule.runWorkerLoopOnce({
    runRoot: run.runRoot,
    runId: run.runId,
    claim: syntheticClaim('claim-apply-fails', []),
    fixtureResult: ({ request } = {}) => ({
      schemaVersion: 'orpad.workerResult.v1',
      adapterCallId: request?.adapterCallId || 'worker-apply-fails',
      attemptId: request?.attemptId || 'worker-apply-fails-attempt-1',
      idempotencyKey: request?.idempotencyKey || 'worker-apply-fails-key',
      status: 'blocked',
      summary: 'fixture reached apply path without a durable claim lease',
      artifacts: [],
      verification: [],
      changedFiles: [],
    }),
    lockManager,
    lockTargetFiles: ['src/apply-fails.md'],
    adapterCallId: 'worker-apply-fails',
    attemptId: 'worker-apply-fails-attempt-1',
    idempotencyKey: 'worker-apply-fails-key',
  }), error => error?.code === 'CLAIM_LEASE_NOT_ACTIVE');

  assert.equal(lockManager.snapshot().heldByFile.size, 0, 'lock must be released on apply failure');
  const events = await readMachineEvents(run.runRoot);
  assert.equal(events.some(event => event.eventType === 'lock.granted'), true);
  assert.equal(events.some(event => event.eventType === 'lock.released'), true);
});

test('Phase B: worker rechecks a queued claim after waiting on a file lock before invoking the adapter', async (t) => {
  const { workspaceRoot, run } = await makeRun('run_flq_waiting_claim_cancelled');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const lockManager = createFileLockManager();
  await lockManager.acquire('blocking-worker', ['src/shared.md']);
  const claimed = await queueAndClaim(run, 'waiting-cancelled-work', ['src/shared.md'], 'claim-waiting-cancelled');
  let invoked = false;

  const workerPromise = workerLoopModule.runWorkerLoopOnce({
    runRoot: run.runRoot,
    runId: run.runId,
    claim: claimed,
    fixtureResult: ({ request } = {}) => {
      invoked = true;
      return {
        schemaVersion: 'orpad.workerResult.v1',
        adapterCallId: request?.adapterCallId || 'worker-waiting-cancelled',
        attemptId: request?.attemptId || 'worker-waiting-cancelled-attempt-1',
        idempotencyKey: request?.idempotencyKey || 'worker-waiting-cancelled-key',
        status: 'blocked',
        summary: 'should not run after claim cancellation',
        artifacts: [],
        verification: [],
        changedFiles: [],
      };
    },
    lockManager,
    adapterCallId: 'worker-waiting-cancelled',
    attemptId: 'worker-waiting-cancelled-attempt-1',
    idempotencyKey: 'worker-waiting-cancelled-key',
    now: '2026-05-16T00:00:04.000Z',
  });

  await waitForEvent(
    run.runRoot,
    event => event.eventType === 'lock.waiting' && event.payload?.taskId === 'claim-waiting-cancelled',
    'lock.waiting for cancelled claim',
  );
  await cancelClaimedItem(run.runRoot, {
    runId: run.runId,
    claimId: claimed.claim.claimId,
    itemId: claimed.item.id,
    now: '2026-05-16T00:00:05.000Z',
    toState: 'queued',
  });
  lockManager.release('blocking-worker');

  await assert.rejects(workerPromise, error => error?.code === 'CLAIM_LEASE_NOT_ACTIVE');
  assert.equal(invoked, false, 'adapter must not run once the waiting claim was cancelled');
  assert.equal(lockManager.snapshot().heldByFile.size, 0);
});
