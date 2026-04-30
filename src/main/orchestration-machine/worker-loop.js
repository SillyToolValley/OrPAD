const { appendMachineEvent, readMachineEvents } = require('./events');
const { createAdapterRequest, recordAdapterRequest, validateAdapterResultForRequest } = require('./adapters/proposal-adapter');
const { readRunState, repairRunStateFromEvents } = require('./run-store');
const { claimNextQueuedItem } = require('./dispatcher');
const {
  isClaimLeaseExpired,
  markClaimLeaseReleased,
  readClaimLease,
} = require('./claims');
const { createContractValidator } = require('./contracts');
const { isPathAllowedByWriteSet } = require('./patches');
const { findQueueItem, transitionQueueItem } = require('./queue-store');
const { releaseWriteSetLock } = require('./write-sets');

const validator = createContractValidator();

function targetQueueStateForWorkerResult(result) {
  if (result.status === 'done') return 'done';
  if (result.status === 'queued') return 'queued';
  return 'blocked';
}

function summaryStatusForWorkerResult(result) {
  if (['blocked', 'failed', 'approval-required', 'rejected'].includes(result.status)) return 'blocked';
  return 'partial';
}

function assertDoneResultHasProof(result) {
  if (result.status !== 'done') return;
  const hasArtifact = (result.artifacts || []).length > 0 || Boolean(result.patchArtifact);
  const hasVerification = (result.verification || []).length > 0;
  if (hasArtifact && hasVerification) return;

  const err = new Error('Worker done result requires artifact evidence and verification proof.');
  err.code = 'WORKER_DONE_RESULT_MISSING_PROOF';
  throw err;
}

function assertWorkerResultWithinWriteSet(result, lease) {
  const allowed = lease.writeSetPaths || [];
  const violation = (result.changedFiles || []).find(file => !isPathAllowedByWriteSet(file, allowed));
  if (!violation) return;
  const err = new Error(`Worker result changed a path outside the active write set: ${violation}`);
  err.code = 'WORKER_RESULT_WRITE_SET_VIOLATION';
  err.path = violation;
  throw err;
}

async function appendRunStatus(runRoot, runId, toState, options = {}) {
  const current = await readRunState(runRoot);
  if (current?.lifecycleStatus === toState) return { duplicate: true, runState: current };
  await appendMachineEvent(runRoot, {
    runId,
    actor: 'machine',
    eventType: 'run.status',
    fromState: current?.lifecycleStatus || 'created',
    toState,
    reason: options.reason || `run.${toState}`,
    payload: options.payload || {},
  });
  return { runState: await repairRunStateFromEvents(runRoot) };
}

async function appendRunSummary(runRoot, runId, summaryStatus, options = {}) {
  await appendMachineEvent(runRoot, {
    runId,
    actor: 'machine',
    eventType: 'run.summary',
    reason: options.reason || `run.summary.${summaryStatus}`,
    payload: {
      summaryStatus,
      ...(options.payload || {}),
    },
  });
  return repairRunStateFromEvents(runRoot);
}

async function findWorkerResultEvent(runRoot, claimId, idempotencyKey = '') {
  const events = await readMachineEvents(runRoot);
  return events.find(event => (
    event.eventType === 'worker.result'
    && event.payload?.claimId === claimId
    && (!idempotencyKey || event.payload?.idempotencyKey === idempotencyKey)
  )) || null;
}

async function assertClaimCanAcceptResult(runRoot, options = {}) {
  const { claimId, itemId, now = new Date().toISOString() } = options;
  const lease = await readClaimLease(runRoot, claimId);
  if (!lease || lease.state !== 'active') {
    const err = new Error(`Claim lease is not active: ${claimId}`);
    err.code = 'CLAIM_LEASE_NOT_ACTIVE';
    throw err;
  }
  if (lease.itemId !== itemId) {
    const err = new Error(`Claim lease item mismatch: ${claimId}`);
    err.code = 'CLAIM_ITEM_MISMATCH';
    throw err;
  }
  if (isClaimLeaseExpired(lease, now)) {
    const err = new Error(`Stale claim result rejected: ${claimId}`);
    err.code = 'STALE_CLAIM_RESULT_REJECTED';
    throw err;
  }

  const current = await findQueueItem(runRoot, itemId);
  if (!current || current.state !== 'claimed' || current.item.claimId !== claimId) {
    const err = new Error(`Queue item is not claimed by ${claimId}.`);
    err.code = 'CLAIM_QUEUE_STATE_MISMATCH';
    throw err;
  }
  return { lease, queueItem: current.item };
}

async function applyWorkerResult(runRoot, options = {}) {
  const {
    runId,
    claimId,
    itemId,
    request,
    result,
    now = new Date().toISOString(),
  } = options;
  if (!runId) throw new Error('runId is required.');
  if (!claimId) throw new Error('claimId is required.');
  if (!itemId) throw new Error('itemId is required.');
  if (!result) throw new Error('worker result is required.');

  if (request) validateAdapterResultForRequest(request, result);
  else validator.assertValid('adapterResult', result);
  assertDoneResultHasProof(result);

  const duplicate = await findWorkerResultEvent(runRoot, claimId, result.idempotencyKey);
  if (duplicate) {
    return {
      duplicate: true,
      event: duplicate,
      runState: await repairRunStateFromEvents(runRoot),
    };
  }

  const { lease } = await assertClaimCanAcceptResult(runRoot, { claimId, itemId, now });
  assertWorkerResultWithinWriteSet(result, lease);
  const toState = options.toState || targetQueueStateForWorkerResult(result);
  const workerEvent = await appendMachineEvent(runRoot, {
    runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId,
    reason: 'worker-result.accepted',
    artifactRefs: result.artifacts || [],
    payload: {
      claimId,
      adapterCallId: result.adapterCallId,
      attemptId: result.attemptId,
      idempotencyKey: result.idempotencyKey,
      status: result.status,
      toState,
      patchArtifact: result.patchArtifact || '',
      changedFiles: result.changedFiles || [],
      verification: result.verification || [],
    },
  });
  const transition = await transitionQueueItem(runRoot, {
    runId,
    itemId,
    toState,
    reason: `worker.${result.status}`,
    evidence: result.artifacts?.[0] || result.patchArtifact || `locks/claims/${claimId}.json`,
    transitionId: `close:${claimId}:${result.idempotencyKey}`,
    now,
    itemPatch: {
      closedByClaimId: claimId,
      workerResultStatus: result.status,
      closedAt: now,
      claimId: undefined,
      claimLeaseExpiresAt: undefined,
      writeSetLockId: undefined,
    },
    payload: {
      claimId,
      workerResultEventSequence: workerEvent.sequence,
    },
  });
  await markClaimLeaseReleased(runRoot, claimId, {
    now,
    state: 'released',
    reason: 'worker-result.accepted',
  });
  if (lease.writeSetLockId) {
    await releaseWriteSetLock(runRoot, lease.writeSetLockId, {
      now,
      reason: 'worker-result.accepted',
    });
  }
  const summaryStatus = summaryStatusForWorkerResult(result);
  const runState = await appendRunSummary(runRoot, runId, summaryStatus, {
    reason: 'worker-result.accepted',
    payload: {
      itemId,
      claimId,
      workerStatus: result.status,
      message: result.summary,
    },
  });
  if (result.status === 'approval-required') {
    await appendRunStatus(runRoot, runId, 'approval-required', {
      reason: 'worker-result.approval-required',
      payload: { itemId, claimId },
    });
  }

  return {
    event: workerEvent,
    transition,
    runState,
    summaryStatus,
    toState,
  };
}

async function runWorkerLoopOnce(options = {}) {
  const {
    runRoot,
    runId,
    workspaceRoot = '',
    adapter = null,
    fixtureResult = null,
  } = options;
  if (!runRoot) throw new Error('runRoot is required.');
  if (!runId) throw new Error('runId is required.');

  const claim = options.claim || await claimNextQueuedItem(runRoot, options);
  if (!claim.claimed) return claim;

  const request = options.request || createAdapterRequest({
    adapter: adapter?.adapter || 'worker-fixture',
    runId,
    nodePath: options.nodePath || 'queue/worker-loop',
    taskKind: 'workerLoop',
    workspaceRoot,
    workspaceMode: 'read-only-plus-overlay',
    allowedFiles: claim.writeSet?.paths || [],
    inputArtifacts: [`queue/claimed/${claim.item.id}.json`],
    outputContract: 'orpad.workerResult.v1',
    adapterCallId: options.adapterCallId || `${claim.claim.claimId}-worker`,
    attemptId: options.attemptId || `${claim.claim.claimId}-worker-attempt-1`,
    idempotencyKey: options.idempotencyKey || `${claim.claim.claimId}:worker-result`,
  });
  await recordAdapterRequest(runRoot, request);

  const result = adapter?.invoke
    ? await adapter.invoke(request, { claim, item: claim.item })
    : (typeof fixtureResult === 'function' ? await fixtureResult({ request, claim, item: claim.item }) : fixtureResult);
  if (!result) throw new Error('WorkerLoop fixture/adapter did not return a result.');

  const applied = await applyWorkerResult(runRoot, {
    runId,
    claimId: claim.claim.claimId,
    itemId: claim.item.id,
    request,
    result,
    now: options.now,
  });
  return {
    ...claim,
    request,
    result: applied,
  };
}

async function runSerialWorkerLoop(options = {}) {
  const maxItems = options.maxItems ?? Number.POSITIVE_INFINITY;
  const steps = [];
  let stopReason = 'max-items';

  while (steps.length < maxItems) {
    const step = await runWorkerLoopOnce(options);
    if (!step.claimed) {
      stopReason = step.stopReason;
      return { steps, stopReason, finalStep: step };
    }
    steps.push(step);
  }
  return { steps, stopReason };
}

async function cancelClaimedItem(runRoot, options = {}) {
  const {
    runId,
    claimId,
    itemId,
    now = new Date().toISOString(),
    toState = 'queued',
  } = options;
  if (!runId) throw new Error('runId is required.');
  if (!claimId) throw new Error('claimId is required.');
  if (!itemId) throw new Error('itemId is required.');

  const { lease } = await assertClaimCanAcceptResult(runRoot, { claimId, itemId, now });
  await appendRunStatus(runRoot, runId, 'cancelling', {
    reason: 'worker-loop.cancel',
    payload: { itemId, claimId },
  });
  const transition = await transitionQueueItem(runRoot, {
    runId,
    itemId,
    toState,
    reason: 'cancelled-during-claim',
    evidence: `locks/claims/${claimId}.json`,
    transitionId: `cancel:${claimId}:${toState}`,
    now,
    itemPatch: {
      cancelledClaimId: claimId,
      claimId: undefined,
      claimLeaseExpiresAt: undefined,
      writeSetLockId: undefined,
    },
    payload: {
      claimId,
    },
  });
  await markClaimLeaseReleased(runRoot, claimId, {
    now,
    state: 'cancelled',
    reason: 'cancelled-during-claim',
  });
  if (lease.writeSetLockId) {
    await releaseWriteSetLock(runRoot, lease.writeSetLockId, {
      now,
      state: 'cancelled',
      reason: 'cancelled-during-claim',
    });
  }
  await appendRunStatus(runRoot, runId, 'cancelled', {
    reason: 'worker-loop.cancelled',
    payload: { itemId, claimId },
  });
  const runState = await appendRunSummary(runRoot, runId, toState === 'blocked' ? 'blocked' : 'partial', {
    reason: 'worker-loop.cancelled',
    payload: { itemId, claimId },
  });
  return { transition, runState };
}

module.exports = {
  applyWorkerResult,
  assertClaimCanAcceptResult,
  assertDoneResultHasProof,
  assertWorkerResultWithinWriteSet,
  cancelClaimedItem,
  findWorkerResultEvent,
  runSerialWorkerLoop,
  runWorkerLoopOnce,
  summaryStatusForWorkerResult,
  targetQueueStateForWorkerResult,
};
