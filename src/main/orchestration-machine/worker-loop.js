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
const { createContractValidator } = require('./contracts');
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

const validator = createContractValidator();

function targetQueueStateForWorkerResult(result) {
  if (result.status === 'done') return 'done';
  if (result.status === 'queued') return 'queued';
  if (result.status === 'requeued') return 'queued';
  if (result.status === 'approval-required') return 'queued';
  return 'blocked';
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
  if (['blocked', 'failed', 'approval-required', 'rejected'].includes(result.status)) return 'blocked';
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
    return 'retry-queued-worker-item';
  }
  if (result.status === 'failed') return 'inspect-worker-failure-and-retry-or-requeue';
  if (result.status === 'rejected') return 'revise-worker-result-or-requeue';
  if (result.status === 'blocked' || toState === 'blocked') return 'resolve-worker-block-and-retry-or-requeue';
  return '';
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
  const toState = assertWorkerResultTargetQueueState(options.toState || targetQueueStateForWorkerResult(result));
  await assertWorkerResultArtifactsRegistered(runRoot, result);
  const nextAction = workerResultNextAction(result, toState);
  const blockedReason = workerResultBlockedReason(result);
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
  } = options;
  if (!runRoot) throw new Error('runRoot is required.');
  if (!runId) throw new Error('runId is required.');

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
  try {
    if (claim.claim?.writeSetLockId) {
      await assertClaimCanAcceptResult(runRoot, {
        claimId: claim.claim.claimId,
        itemId: claim.item.id,
        now: options.now || new Date().toISOString(),
      });
    }
    await recordAdapterRequest(runRoot, request);
    result = adapter?.invoke
      ? await adapter.invoke(request, { claim, item: claim.item })
      : (typeof fixtureResult === 'function' ? await fixtureResult({ request, claim, item: claim.item }) : fixtureResult);
    if (!result) throw new Error('WorkerLoop fixture/adapter did not return a result.');

    applied = await applyWorkerResult(runRoot, {
      runId,
      claimId: claim.claim.claimId,
      itemId: claim.item.id,
      request,
      result,
      now: options.now,
      declaredTargetFiles,
      lockTargetFiles: effectiveLockTargetFiles,
      targetFilesSource: lockTargetFilesSource,
      reviewRequired: options.reviewRequired === true,
      requiredValidationCommands: options.requiredValidationCommands || [],
    });
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
