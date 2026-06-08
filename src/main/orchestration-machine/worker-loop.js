const { appendMachineEvent, readMachineEvents } = require('./events');
const { requestApprovalForItem } = require('./approvals');
const { createAdapterRequest, recordAdapterRequest, validateAdapterResultForRequest } = require('./adapters/proposal-adapter');
const { claimNextQueuedItem } = require('./dispatcher');
const {
  appendRunLifecycleStatus,
  appendRunSummaryStatus,
  assertRunLifecycleCanTransition,
} = require('./lifecycle');
const { readRunState } = require('./run-store');
const {
  isClaimLeaseExpired,
  markClaimLeaseReleased,
  readClaimLease,
} = require('./claims');
const { SCHEMA_VERSIONS, createContractValidator } = require('./contracts');
const { recordNodeLifecycleEvent } = require('./node-lifecycle');
const { isPathAllowedByWriteSet } = require('./patches');
const {
  assertQueueState,
  findQueueItem,
  transitionAction,
  transitionQueueItem,
} = require('./queue-store');
const { normalizeLockPath } = require('./file-lock-manager');
const { normalizeWriteSetPath, releaseWriteSetLock } = require('./write-sets');
// RC-2: cooperative-cancel helpers. run-control.js depends only on
// events/lifecycle/run-store, so importing it here is acyclic.
const { normalizeRunCancellationError, throwIfRunSignalAborted } = require('./run-control');

const validator = createContractValidator();

function workerResultIsReviewableBlockedPatch(result = {}) {
  return result.status === 'blocked'
    && result.patchArtifact
    && (result.changedFiles || []).length > 0;
}

function targetQueueStateForWorkerResult(result, queueItem = {}) {
  if (result.status === 'done') return 'done';
  if (result.status === 'queued') return 'queued';
  if (result.status === 'requeued') return 'queued';
  if (result.status === 'approval-required') return 'queued';
  if (workerResultIsReviewableBlockedPatch(result)) return 'blocked';
  if (['blocked', 'failed', 'rejected'].includes(result.status)) {
    return (Number(queueItem.managedRetryCount) || 0) > 0 ? 'rejected' : 'queued';
  }
  return 'queued';
}

function readOnlyFilesForClaim(claim = {}) {
  const allowed = new Set((claim.writeSet?.paths || [])
    .map(normalizeWriteSetPath)
    .filter(Boolean));
  return [...new Set((claim.item?.sourceOfTruthTargets || [])
    .map(normalizeWriteSetPath)
    .filter(file => file && !allowed.has(file)))].sort();
}

function summaryStatusForWorkerResult(result) {
  return 'partial';
}

function finalRunLifecycleForCancellation(toState) {
  return toState === 'queued' ? 'waiting' : 'cancelled';
}

function assertWorkerResultTargetQueueState(toState) {
  const state = assertQueueState(toState);
  if (transitionAction('claimed', state)) return state;
  const err = new Error(`Worker result cannot close a claimed item as ${state}.`);
  err.code = 'WORKER_RESULT_TARGET_INVALID';
  err.toState = state;
  throw err;
}

function assertCancellationTargetQueueState(toState) {
  const state = assertQueueState(toState);
  if (state === 'queued' || state === 'blocked') return state;
  const err = new Error(`Claim cancellation cannot move a claimed item to ${state}.`);
  err.code = 'CLAIM_CANCELLATION_TARGET_INVALID';
  err.toState = state;
  throw err;
}

function assertDoneResultHasProof(result) {
  if (result.status !== 'done') return;
  const hasArtifact = (result.artifacts || []).length > 0 || Boolean(result.patchArtifact);
  const hasVerification = (result.verification || []).length > 0;
  if (hasArtifact && hasVerification) return;

  const err = new Error('Worker done result requires evidence files and verification proof.');
  err.code = 'WORKER_DONE_RESULT_MISSING_PROOF';
  throw err;
}

function normalizeValidationCommandText(value) {
  return String(value || '')
    .replace(/^candidate:\s*/i, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function validationCommandLooksConcrete(command) {
  const normalized = normalizeValidationCommandText(command);
  return normalized
    && !normalized.includes('<')
    && !normalized.includes('>')
    && !normalized.startsWith('missing-')
    && !normalized.includes('definitely-missing');
}

function resultVerificationText(result) {
  return normalizeValidationCommandText([
    result.summary,
    ...(result.verification || []).flatMap(item => [
      item?.command,
      ...(Array.isArray(item?.args) ? item.args : []),
      item?.status,
      item?.summary,
      item?.stdout,
      item?.stderr,
    ]),
  ].map(item => String(item || '')).join(' '));
}

function assertDoneResultIncludesHarnessValidation(result, requiredValidationCommands = []) {
  if (result.status !== 'done') return;
  const required = [...new Set((requiredValidationCommands || [])
    .map(normalizeValidationCommandText)
    .filter(validationCommandLooksConcrete))];
  if (!required.length) return;
  const text = resultVerificationText(result);
  const matched = required.find(command => text.includes(command));
  if (matched) return;

  const err = new Error('Worker done result does not include required harness validation evidence.');
  err.code = 'WORKER_DONE_RESULT_MISSING_HARNESS_VALIDATION';
  err.requiredValidationCommands = required;
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

function workerResultArtifactRefs(result) {
  return [...new Set([
    ...(result.artifacts || []),
    ...(result.patchArtifact ? [result.patchArtifact] : []),
  ].filter(Boolean))];
}

const WORKER_RESULT_EVIDENCE_FIELDS = Object.freeze([
  'failingSymptom',
  'failureSymptom',
  'rootCause',
  'rootCauses',
  'filesChanged',
  'verificationCommands',
  'validationCommands',
  'residualRisk',
  'residualRisks',
  'workerEvidence',
  'itemEvidence',
  'contractEvidence',
  'evidence',
  'reportedFilesChanged',
  'reportedStatus',
]);

function workerResultEvidencePayload(result = {}) {
  const payload = {};
  for (const field of WORKER_RESULT_EVIDENCE_FIELDS) {
    if (result[field] !== undefined) payload[field] = result[field];
  }
  return payload;
}

function workerResultNextAction(result = {}, toState = '') {
  const explicit = String(result.nextAction || '').trim();
  if (explicit) return explicit;
  if (result.status === 'approval-required') return 'approve-or-decline-worker-tool-permission';
  if (result.status === 'queued' || result.status === 'requeued' || toState === 'queued') {
    if (['blocked', 'failed', 'rejected'].includes(result.status)) return 'managed-retry-worker-item';
    return 'retry-queued-worker-item';
  }
  if (toState === 'rejected' && ['blocked', 'failed', 'rejected'].includes(result.status)) return 'managed-worker-exception-recorded';
  if (result.status === 'failed') return 'inspect-worker-failure-and-retry-or-requeue';
  if (result.status === 'rejected') return 'revise-worker-result-or-requeue';
  if (result.status === 'blocked' || toState === 'blocked') return 'resolve-worker-block-and-retry-or-requeue';
  return '';
}

function adapterInvokeErrorWorkerResult(request = {}, err) {
  const code = String(err?.code || err?.name || 'ADAPTER_INVOKE_FAILED').trim();
  const message = String(err?.message || 'Adapter failed before returning a worker result.').trim();
  const summary = `${code ? `${code}: ` : ''}${message}`.slice(0, 500)
    || 'Adapter failed before returning a worker result.';
  return {
    schemaVersion: SCHEMA_VERSIONS.adapterResult,
    adapterCallId: request.adapterCallId,
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    status: 'failed',
    summary,
    artifacts: [],
    changedFiles: [],
    verification: [{
      command: request.adapter || 'adapter.invoke',
      status: 'failed',
      phase: 'adapter-invoke',
      spawnErrorCode: code,
      spawnErrorMessage: message,
      managedInternalException: true,
    }],
    deferredReason: 'adapter-invoke-exception',
    failingSymptom: 'The worker adapter failed before it returned a Machine worker result.',
    rootCause: summary,
    residualRisk: 'The work item was returned to managed queue handling instead of leaving a claimed item or terminal node failure.',
    reportedStatus: 'failed',
  };
}

function workerResultApplicationErrorWorkerResult(request = {}, err) {
  const result = adapterInvokeErrorWorkerResult(request, err);
  const code = String(err?.code || err?.name || 'WORKER_RESULT_APPLICATION_FAILED').trim();
  const message = String(err?.message || 'Worker result could not be applied safely.').trim();
  return {
    ...result,
    summary: `${code ? `${code}: ` : ''}${message}`.slice(0, 500),
    verification: [{
      command: request.adapter || 'worker-result.apply',
      status: 'failed',
      phase: 'worker-result-application',
      spawnErrorCode: code,
      spawnErrorMessage: message,
      managedInternalException: true,
    }],
    deferredReason: 'worker-result-application-exception',
    failingSymptom: 'The worker returned a result that could not be applied safely.',
    residualRisk: 'The item was kept in managed queue handling instead of surfacing an internal node failure.',
  };
}

function workerResultBlockedReason(result = {}) {
  return String(
    result.blockedReason
    || result.deferredReason
    || result.failureReason
    || result.summary
    || '',
  ).trim();
}

function normalizeLockFileList(files = []) {
  if (!Array.isArray(files)) return [];
  return [...new Set(files.map(file => normalizeLockPath(file)).filter(Boolean))].sort();
}

function approvalIdForWorkerPermission(itemId, adapterCallId) {
  return `approval-${String(itemId || 'item')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item'}-llm-${String(adapterCallId || 'permission')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'permission'}`;
}

async function assertWorkerResultArtifactsRegistered(runRoot, result) {
  if (result.status !== 'done') return;
  const refs = workerResultArtifactRefs(result);
  if (!refs.length) return;
  const events = await readMachineEvents(runRoot);
  const registered = new Set(events
    .filter(event => event.eventType === 'artifact.registered' && event.payload?.file?.path)
    .map(event => event.payload.file.path));
  const missing = refs.find(ref => !registered.has(ref));
  if (!missing) return;
  const err = new Error(`Worker result references an unregistered proof artifact: ${missing}`);
  err.code = 'WORKER_RESULT_ARTIFACT_UNREGISTERED';
  err.artifactPath = missing;
  throw err;
}

async function appendRunStatus(runRoot, runId, toState, options = {}) {
  return appendRunLifecycleStatus(runRoot, {
    runId,
    toState,
    reason: options.reason || `run.${toState}`,
    payload: options.payload || {},
  });
}

async function appendRunSummary(runRoot, runId, summaryStatus, options = {}) {
  return appendRunSummaryStatus(runRoot, {
    runId,
    summaryStatus,
    reason: options.reason || `run.summary.${summaryStatus}`,
    payload: options.payload || {},
  });
}

async function findWorkerResultEvent(runRoot, claimId, idempotencyKey = '') {
  const events = await readMachineEvents(runRoot);
  return events.find(event => (
    event.eventType === 'worker.result'
    && event.payload?.claimId === claimId
    && (!idempotencyKey || event.payload?.idempotencyKey === idempotencyKey)
  )) || null;
}

async function findIgnoredWorkerResultEvent(runRoot, claimId, idempotencyKey = '') {
  const events = await readMachineEvents(runRoot);
  return events.find(event => (
    event.eventType === 'worker.result.ignored'
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

function workerResultApplicationErrorIsLateClaim(error) {
  return [
    'CLAIM_LEASE_NOT_ACTIVE',
    'CLAIM_QUEUE_STATE_MISMATCH',
  ].includes(String(error?.code || ''));
}

async function recordIgnoredLateWorkerResult(runRoot, options = {}, error = null) {
  const {
    runId,
    claimId,
    itemId,
    result = {},
    request = {},
    now = new Date().toISOString(),
  } = options;
  if (!workerResultApplicationErrorIsLateClaim(error)) return null;
  const current = await findQueueItem(runRoot, itemId, { canonicalOnly: false }).catch(() => null);
  const lease = await readClaimLease(runRoot, claimId).catch(() => null);
  const stillOwnsClaim = current?.state === 'claimed' && current?.item?.claimId === claimId;
  if (stillOwnsClaim) return null;
  if (String(error?.code || '') === 'CLAIM_LEASE_NOT_ACTIVE' && !lease) return null;
  if (String(error?.code || '') === 'CLAIM_LEASE_NOT_ACTIVE' && lease?.state === 'active') return null;

  const duplicate = await findIgnoredWorkerResultEvent(runRoot, claimId, result.idempotencyKey);
  if (duplicate) {
    return {
      ignored: true,
      duplicate: true,
      event: duplicate,
      runState: await readRunState(runRoot),
      summaryStatus: 'partial',
      toState: current?.state || '',
    };
  }

  const event = await appendMachineEvent(runRoot, {
    runId,
    actor: 'machine',
    eventType: 'worker.result.ignored',
    itemId,
    reason: 'worker-result.late-ignored',
    artifactRefs: workerResultArtifactRefs(result),
    payload: {
      claimId,
      adapterCallId: result.adapterCallId || request.adapterCallId || '',
      attemptId: result.attemptId || request.attemptId || '',
      idempotencyKey: result.idempotencyKey || request.idempotencyKey || '',
      status: result.status || '',
      summary: result.summary || '',
      ignoredReason: 'claim-no-longer-active',
      errorCode: error?.code || '',
      errorMessage: error?.message || '',
      leaseState: lease?.state || '',
      currentQueueState: current?.state || '',
      currentQueueClaimId: current?.item?.claimId || '',
      patchArtifact: result.patchArtifact || '',
      changedFiles: normalizeLockFileList(result.changedFiles || []),
    },
  });
  const runState = await appendRunSummary(runRoot, runId, 'partial', {
    reason: 'worker-result.late-ignored',
    payload: {
      itemId,
      claimId,
      workerStatus: result.status || '',
      message: 'Late worker result ignored because the claim had already been recovered or cancelled.',
      summaryStatus: 'partial',
    },
  });
  return {
    ignored: true,
    event,
    runState,
    summaryStatus: 'partial',
    toState: current?.state || '',
    ignoredAt: now,
  };
}

async function applyWorkerResult(runRoot, options = {}) {
  const {
    runId,
    claimId,
    itemId,
    request,
    result,
    now = new Date().toISOString(),
    declaredTargetFiles = [],
    lockTargetFiles = [],
    targetFilesSource = '',
    reviewRequired = false,
  } = options;
  if (!runId) throw new Error('runId is required.');
  if (!claimId) throw new Error('claimId is required.');
  if (!itemId) throw new Error('itemId is required.');
  if (!result) throw new Error('worker result is required.');

  if (request) validateAdapterResultForRequest(request, result);
  else validator.assertValid('adapterResult', result);
  assertDoneResultHasProof(result);
  assertDoneResultIncludesHarnessValidation(result, options.requiredValidationCommands || []);

  const duplicate = await findWorkerResultEvent(runRoot, claimId, result.idempotencyKey);
  if (duplicate) {
    return {
      duplicate: true,
      event: duplicate,
      runState: await readRunState(runRoot),
    };
  }

  await assertRunLifecycleCanTransition(
    runRoot,
    result.status === 'approval-required' ? 'approval-required' : 'running',
    'worker-result.accepted',
  );

  const { lease, queueItem } = await assertClaimCanAcceptResult(runRoot, { claimId, itemId, now });
  assertWorkerResultWithinWriteSet(result, lease);
  const toState = assertWorkerResultTargetQueueState(options.toState || targetQueueStateForWorkerResult(result, queueItem));
  await assertWorkerResultArtifactsRegistered(runRoot, result);
  const nextAction = workerResultNextAction(result, toState);
  const blockedReason = workerResultBlockedReason(result);
  const managedWorkerException = ['blocked', 'failed', 'rejected'].includes(result.status) && !workerResultIsReviewableBlockedPatch(result);
  const managedRetry = managedWorkerException && toState === 'queued';
  const managedFinal = managedWorkerException && toState === 'rejected';
  const managedRetryCount = managedWorkerException ? (Number(queueItem.managedRetryCount) || 0) + 1 : 0;
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
      summary: result.summary || '',
      patchArtifact: result.patchArtifact || '',
      changedFiles: normalizeLockFileList(result.changedFiles || []),
      declaredTargetFiles: normalizeLockFileList(declaredTargetFiles),
      lockTargetFiles: normalizeLockFileList(lockTargetFiles),
      targetFilesSource: targetFilesSource || '',
      reviewRequired: reviewRequired === true,
      managedRetry,
      managedFinal,
      ...(managedWorkerException ? { managedRetryCount } : {}),
      verification: result.verification || [],
      ...(nextAction ? { nextAction } : {}),
      ...(blockedReason ? { blockedReason } : {}),
      ...(result.deferredReason ? { deferredReason: result.deferredReason } : {}),
      ...workerResultEvidencePayload(result),
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
      ...(nextAction ? { nextAction } : {}),
      ...(blockedReason ? { blockedReason } : {}),
      ...(managedWorkerException ? {
        managedRetry: true,
        managedFinal,
        managedRetryCount,
        lastManagedWorkerStatus: result.status,
        lastManagedWorkerReason: blockedReason || result.summary || '',
        ...(managedFinal ? {
          machineRejected: true,
          rejectionReason: blockedReason || result.summary || 'Worker exception was bounded by managed recovery.',
        } : {}),
      } : {}),
      ...(result.status === 'approval-required' ? {
        approvalRequired: true,
        approvalRequiredReason: result.approvalRequest?.reason || 'llm-cli-permission-required',
      } : {}),
      claimId: undefined,
      claimLeaseExpiresAt: undefined,
      writeSetLockId: undefined,
    },
    payload: {
      claimId,
      workerResultEventSequence: workerEvent.sequence,
    },
  });
  if (managedWorkerException) {
    await appendMachineEvent(runRoot, {
      runId,
      actor: 'machine',
      eventType: 'managed-block.recovered',
      itemId,
      reason: managedFinal ? 'worker-result.managed-finalized' : 'worker-result.managed-retry',
      payload: {
        claimId,
        workerStatus: result.status,
        toState,
        managedRetryCount,
        managedFinal,
        nextAction,
        blockedReason,
      },
    });
  }
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
  let runState = await appendRunSummary(runRoot, runId, summaryStatus, {
    reason: 'worker-result.accepted',
    payload: {
      itemId,
      claimId,
      workerStatus: result.status,
      message: result.summary,
      ...(nextAction ? { nextAction } : {}),
    },
  });
  let approval = null;
  if (result.status === 'approval-required') {
    approval = await requestApprovalForItem(runRoot, {
      runId,
      item: {
        ...queueItem,
        id: itemId,
        approvalRequired: true,
      },
      approvalId: approvalIdForWorkerPermission(itemId, result.adapterCallId),
      reason: 'worker-result.approval-required',
      requestedCapabilities: result.requestedCapabilities || ['llm-cli-tool-permission', 'workspace-overlay-write'],
      commandSpec: result.approvalRequest?.commandSpec || request?.commandSpec || null,
      writeSetPaths: lease.writeSetPaths || queueItem.sourceOfTruthTargets || [],
      now,
    });
    runState = approval.runState || runState;
  }

  return {
    event: workerEvent,
    transition,
    runState,
    approval,
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
    lockManager = null,
    // File-Lock Queue Phase 2.A: an authoritative target-files
    // declaration from the worker node's config.targetFiles. When
    // provided AND non-empty, the lock manager schedules against
    // this set instead of falling back to claim.writeSet.paths
    // (the per-candidate sourceOfTruthTargets). Empty array still
    // falls back so the safe-default semantics are preserved.
    lockTargetFiles = null,
    // RC-2: the run's cooperative abort signal. Lets the worker bail BEFORE
    // claiming (no partial queue.transition) and skip the expensive invoke if a
    // cancel landed during claim acquisition.
    signal = null,
  } = options;
  if (!runRoot) throw new Error('runRoot is required.');
  if (!runId) throw new Error('runId is required.');

  // RC-2 pre-claim checkpoint: if a cancel was already requested, bail before
  // claimNextQueuedItem so no write-set lock / claim lease / queued->claimed
  // transition is committed (avoids a partial-then-immediately-cancelled claim).
  throwIfRunSignalAborted(signal, 'Run cancelled before worker claim.');

  const claim = options.claim || await claimNextQueuedItem(runRoot, {
    ...options,
    enforceWriteSetConflicts: options.enforceWriteSetConflicts ?? !lockManager,
  });
  if (!claim.claimed) return claim;

  const request = options.request || createAdapterRequest({
    adapter: adapter?.adapter || 'worker-fixture',
    runId,
    nodePath: options.nodePath || 'queue/worker-loop',
    taskKind: 'workerLoop',
    workspaceRoot,
    workspaceMode: 'read-only-plus-overlay',
    allowedFiles: claim.writeSet?.paths || [],
    readOnlyFiles: readOnlyFilesForClaim(claim),
    inputArtifacts: [`queue/claimed/${claim.item.id}.json`],
    outputContract: 'orpad.workerResult.v1',
    adapterCallId: options.adapterCallId || `${claim.claim.claimId}-worker`,
    attemptId: options.attemptId || `${claim.claim.claimId}-worker-attempt-1`,
    idempotencyKey: options.idempotencyKey || `${claim.claim.claimId}:worker-result`,
  });

  // File-Lock Queue Phase 1 (worker-loop integration): acquire write
  // locks for this claim's declared paths BEFORE recording the
  // adapter request OR invoking the adapter. Codex Fix7 caught that
  // the previous order recorded adapter.requested BEFORE acquiring
  // the lock — under concurrent workers a queued worker would
  // appear "requested" with no matching invocation. By acquiring
  // first, we record the request only once we've committed to
  // calling the adapter.
  //
  // With serial workers (claimPolicy.concurrency=1, the current
  // default), acquisition is always immediate because the previous
  // claim's release already drained the manager. With worker
  // concurrency > 1 (the Phase 2/3 unlock), the manager queues
  // overlapping write sets deterministically — the user never sees
  // a patchReview prompt for routine file races.
  //
  // The lock key is `claim.claim.claimId` and the file set is
  // `claim.writeSet?.paths` (probe-emitted source-of-truth
  // targets). Empty paths => global exclusive lock (= safe
  // fallback). Release happens in `finally` so a thrown adapter
  // unwinds the lock too — otherwise a failing worker would hold
  // its files for the rest of the run.
  const lockTaskId = claim.claim.claimId;
  // Phase 2.A (codex Cross-review P1 #1 fix): the lock-scope MUST
  // include every file the worker could legitimately edit. The
  // post-result `assertWorkerResultWithinWriteSet` validates
  // against `lease.writeSetPaths` (= claim.writeSet.paths) — if
  // the lock holds only `targetFiles` and the claim's writeSet
  // covers DIFFERENT files, the worker could edit a claim-scoped
  // file under no lock at all (other parallel workers could race
  // it). The safe behavior is to lock the UNION of both
  // declarations. The lock covers more files than strictly
  // necessary in some cases, but never less than what validation
  // will allow. Empty union => global exclusive lock (safe).
  const declaredTargetFiles = normalizeLockFileList(lockTargetFiles);
  const lockTargetFilesSet = new Set(declaredTargetFiles);
  for (const path of (claim.writeSet?.paths || [])) {
    const normalized = normalizeLockPath(path);
    if (normalized) lockTargetFilesSet.add(normalized);
  }
  const effectiveLockTargetFiles = [...lockTargetFilesSet].sort();
  // For audit: distinguish the source of each path. node-config
  // paths come from the node's static targetFiles declaration;
  // claim paths come from the probe's per-candidate writeSet.
  const lockTargetFilesSource = (() => {
    const hasNodeConfig = Array.isArray(lockTargetFiles) && lockTargetFiles.length > 0;
    const hasClaim = (claim.writeSet?.paths || []).length > 0;
    if (hasNodeConfig && hasClaim) return 'union';
    if (hasNodeConfig) return 'node-config';
    if (hasClaim) return 'claim-writeset';
    return 'empty';
  })();
  const nodeAttempt = Number(options.nodeAttempt) || 1;
  let lockGranted = null;
  if (lockManager) {
    const willWait = typeof lockManager.wouldWait === 'function'
      ? lockManager.wouldWait(lockTaskId, effectiveLockTargetFiles)
      : false;
    let lockWaitingEvent = Promise.resolve(null);
    if (willWait) {
      lockWaitingEvent = appendMachineEvent(runRoot, {
        runId,
        actor: 'machine',
        eventType: 'lock.waiting',
        nodePath: request.nodePath,
        payload: {
          phase: 'file-lock-queue-phase-1',
          taskId: lockTaskId,
          attempt: nodeAttempt,
          targetFiles: effectiveLockTargetFiles,
          targetFilesSource: lockTargetFilesSource,
        },
      }).catch(() => null);
    }
    lockGranted = await lockManager.acquire(lockTaskId, effectiveLockTargetFiles);
    await lockWaitingEvent;
    await appendMachineEvent(runRoot, {
      runId,
      actor: 'machine',
      eventType: 'lock.granted',
      nodePath: request.nodePath,
      payload: {
        phase: 'file-lock-queue-phase-1',
        taskId: lockTaskId,
        attempt: nodeAttempt,
        targetFiles: effectiveLockTargetFiles,
        // Phase 2.A: record whether the node-level declaration or
        // the claim-level fallback was used. Audit consumers can
        // distinguish "I locked exactly what the author declared"
        // from "I locked the probe's specific scope."
        targetFilesSource: lockTargetFilesSource,
        waited: Boolean(lockGranted.waited),
        waitedMs: lockGranted.waitedMs || 0,
      },
    }).catch(() => null);
  }
  let result;
  let applied;
  let invokeApplicationSourceError = null;
  try {
    // RC-2 pre-invoke checkpoint: a cancel may have landed while we acquired the
    // claim / file lock above. Bail before the expensive adapter invoke; the
    // finally below releases the durable lease + write-set lock idempotently.
    throwIfRunSignalAborted(signal, 'Run cancelled before worker invoke.');
    if (claim.claim?.writeSetLockId) {
      await assertClaimCanAcceptResult(runRoot, {
        claimId: claim.claim.claimId,
        itemId: claim.item.id,
        now: options.now || new Date().toISOString(),
      });
    }
    await recordAdapterRequest(runRoot, request);
    try {
      result = adapter?.invoke
        ? await adapter.invoke(request, { claim, item: claim.item })
        : (typeof fixtureResult === 'function' ? await fixtureResult({ request, claim, item: claim.item }) : fixtureResult);
    } catch (invokeErr) {
      // RC-2: if the invoke threw because the run was cancelled (e.g. its
      // subprocess was SIGKILLed by cancelMachineProcessRun while the signal is
      // aborted), surface it as a clean MACHINE_RUN_CANCELLED so the node records
      // cancelled rather than failed.
      const normalizedErr = normalizeRunCancellationError(invokeErr, signal, 'Run cancelled during worker execution.');
      if (normalizedErr?.cancelled || normalizedErr?.code === 'MACHINE_RUN_CANCELLED') throw normalizedErr;
      invokeApplicationSourceError = normalizedErr;
      result = adapterInvokeErrorWorkerResult(request, normalizedErr);
    }
    if (!result) throw new Error('WorkerLoop fixture/adapter did not return a result.');

    const applyOptions = {
      runId,
      claimId: claim.claim.claimId,
      itemId: claim.item.id,
      request,
      now: options.now,
      declaredTargetFiles,
      lockTargetFiles: effectiveLockTargetFiles,
      targetFilesSource: lockTargetFilesSource,
      reviewRequired: options.reviewRequired === true,
    };
    try {
      applied = await applyWorkerResult(runRoot, {
        ...applyOptions,
        result,
        requiredValidationCommands: options.requiredValidationCommands || [],
      });
    } catch (applyErr) {
      const normalizedErr = normalizeRunCancellationError(applyErr, signal, 'Run cancelled during worker result application.');
      if (normalizedErr?.cancelled || normalizedErr?.code === 'MACHINE_RUN_CANCELLED') throw normalizedErr;
      applied = await recordIgnoredLateWorkerResult(runRoot, {
        ...applyOptions,
        result,
      }, normalizedErr);
      if (!applied) {
        const durableLease = await readClaimLease(runRoot, applyOptions.claimId).catch(() => null);
        if (!durableLease && invokeApplicationSourceError) throw invokeApplicationSourceError;
        applied = await applyWorkerResult(runRoot, {
          ...applyOptions,
          result: workerResultApplicationErrorWorkerResult(request, normalizedErr),
          requiredValidationCommands: [],
        });
      }
    }
  } finally {
    if (lockManager) {
      const released = lockManager.release(lockTaskId);
      await appendMachineEvent(runRoot, {
        runId,
        actor: 'machine',
        eventType: 'lock.released',
        nodePath: request.nodePath,
        payload: {
          phase: 'file-lock-queue-phase-1',
          taskId: lockTaskId,
          attempt: nodeAttempt,
          released: released.released,
        },
      }).catch(() => null);
    }
    // If the adapter or result application throws before applyWorkerResult closes
    // the item, do not leave a durable claimed item behind. The scheduler path
    // passes a pre-claimed item, so this recovery must cover both local and
    // caller-owned claims.
    if (applied === undefined && claim?.claimed && claim?.claim?.claimId && claim?.item?.id) {
      const releaseNow = options.now || new Date().toISOString();
      await transitionQueueItem(runRoot, {
        runId,
        itemId: claim.item.id,
        toState: 'queued',
        reason: 'worker-loop.unapplied-claim-recovered',
        evidence: `locks/claims/${claim.claim.claimId}.json`,
        transitionId: `recover:${claim.claim.claimId}:unapplied-worker-result`,
        now: releaseNow,
        itemPatch: {
          claimId: undefined,
          claimLeaseExpiresAt: undefined,
          writeSetLockId: undefined,
          lastManagedWorkerStatus: 'failed',
          lastManagedWorkerReason: 'Worker attempt ended before a result could be applied.',
          managedRetry: true,
          nextAction: 'managed-retry-worker-item',
        },
        payload: {
          claimId: claim.claim.claimId,
          recoveredUnappliedClaim: true,
        },
      }).catch(() => null);
      await markClaimLeaseReleased(runRoot, claim.claim.claimId, {
        now: releaseNow,
        state: 'released',
        reason: 'worker-loop.unapplied-claim-recovered',
      }).catch(() => null);
      if (claim.claim.writeSetLockId) {
        await releaseWriteSetLock(runRoot, claim.claim.writeSetLockId, {
          now: releaseNow,
          reason: 'worker-loop.unapplied-claim-recovered',
        }).catch(() => null);
      }
    }
  }

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

// Returns the in-flight node executions (started but not yet terminal) at
// the time of the call. A node is "terminal" once any of its post-start
// lifecycle events fires for the same attempt. The worker's overlay site
// always emits node.started before invoking the CLI, so a Cancel issued
// mid-run typically interrupts at least one probe or worker node here.
function inflightNodeExecutionsFromEvents(events = []) {
  const active = new Map();
  for (const event of events || []) {
    if (!event || !String(event.eventType || '').startsWith('node.')) continue;
    const nodePath = String(event.nodePath || '').trim();
    if (!nodePath) continue;
    const attempt = Number(event.payload?.attempt) || 1;
    const key = `${nodePath}:${attempt}`;
    if (event.eventType === 'node.started') {
      active.set(key, {
        nodePath,
        attempt,
        nodeType: event.payload?.nodeType || '',
      });
    } else if (['node.completed', 'node.failed', 'node.blocked', 'node.skipped', 'node.cancelled'].includes(event.eventType)) {
      active.delete(key);
    }
  }
  return [...active.values()];
}

async function emitNodeCancelledForInflight(runRoot, runId, reason) {
  // Self-defending against a concurrent terminal append: re-read events
  // right before each append and skip if any terminal node.* event for
  // this nodePath:attempt has appeared in between. The caller is
  // expected to hold the lifecycle queue (so this is mostly belt-and-
  // braces), but a future code path that bypasses the queue must not
  // be able to produce duplicate terminal lifecycle events for the
  // same attempt.
  const initialEvents = await readMachineEvents(runRoot);
  const inflight = inflightNodeExecutionsFromEvents(initialEvents);
  const cancelled = [];
  for (const node of inflight) {
    const fresh = await readMachineEvents(runRoot);
    const stillInflight = inflightNodeExecutionsFromEvents(fresh).some(
      n => n.nodePath === node.nodePath && n.attempt === node.attempt,
    );
    if (!stillInflight) continue;
    try {
      await recordNodeLifecycleEvent(runRoot, {
        runId,
        nodePath: node.nodePath,
        nodeType: node.nodeType || 'orpad.unknown',
        status: 'cancelled',
        attempt: node.attempt,
        payload: { reason },
      });
      cancelled.push(node);
    } catch {
      // Append may fail if validation rejects the event shape; the
      // run-lifecycle event still records the cancel, so a missed
      // node.cancelled is not fatal for the run.
    }
  }
  return cancelled;
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

  await assertRunLifecycleCanTransition(runRoot, 'cancelling', 'worker-loop.cancel');
  const finalToState = assertCancellationTargetQueueState(toState);
  const { lease } = await assertClaimCanAcceptResult(runRoot, { claimId, itemId, now });
  await appendRunStatus(runRoot, runId, 'cancelling', {
    reason: 'worker-loop.cancel',
    payload: { itemId, claimId },
  });
  const cancelledNodes = await emitNodeCancelledForInflight(runRoot, runId, 'worker-loop.cancel');
  const transition = await transitionQueueItem(runRoot, {
    runId,
    itemId,
    toState: finalToState,
    reason: 'cancelled-during-claim',
    evidence: `locks/claims/${claimId}.json`,
    transitionId: `cancel:${claimId}:${finalToState}`,
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
  const finalLifecycleStatus = finalRunLifecycleForCancellation(finalToState);
  await appendRunStatus(runRoot, runId, finalLifecycleStatus, {
    reason: finalLifecycleStatus === 'waiting' ? 'worker-loop.cancel-requeued' : 'worker-loop.cancelled',
    payload: { itemId, claimId, cancelledNodeCount: cancelledNodes.length },
  });
  const runState = await appendRunSummary(runRoot, runId, finalToState === 'blocked' ? 'blocked' : 'partial', {
    reason: finalLifecycleStatus === 'waiting' ? 'worker-loop.cancel-requeued' : 'worker-loop.cancelled',
    payload: { itemId, claimId, cancelledNodeCount: cancelledNodes.length },
  });
  return { transition, runState, cancelledNodes };
}

module.exports = {
  applyWorkerResult,
  assertClaimCanAcceptResult,
  assertDoneResultHasProof,
  assertWorkerResultArtifactsRegistered,
  assertWorkerResultWithinWriteSet,
  cancelClaimedItem,
  assertCancellationTargetQueueState,
  assertWorkerResultTargetQueueState,
  emitNodeCancelledForInflight,
  findWorkerResultEvent,
  finalRunLifecycleForCancellation,
  inflightNodeExecutionsFromEvents,
  runSerialWorkerLoop,
  runWorkerLoopOnce,
  summaryStatusForWorkerResult,
  targetQueueStateForWorkerResult,
};
