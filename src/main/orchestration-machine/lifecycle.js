const { appendMachineEvent, projectRunStateFromEvents, readMachineEvents } = require('./events');
const { shouldRequestPatchReview } = require('./patch-review-classifier');
const { repairRunStateFromEvents, readRunState } = require('./run-store');
const { findQueueItem, projectQueueStateFromEvents, readQueueItems, writeQueueItem } = require('./queue-store');

const ACTIVE_QUEUE_STATES = new Set(['candidate', 'queued', 'claimed']);
const TERMINAL_QUEUE_STATES = new Set(['done', 'blocked', 'rejected']);
const RUN_LIFECYCLE_STATES = new Set([
  'created',
  'running',
  'waiting',
  'approval-required',
  'cancelling',
  'cancelled',
  'failed',
  'completed',
]);
const RUN_SUMMARY_STATUSES = new Set(['pending', 'done', 'partial', 'blocked']);
const TERMINAL_RUN_LIFECYCLE_STATES = new Set(['completed', 'cancelled', 'failed']);
const PATCH_REVIEW_RESOLUTION_EVENT_TYPES = new Set(['patch.applied', 'patch.review_skipped']);
const PATCH_REVIEW_DECISION_EVENT_TYPES = new Set([
  ...PATCH_REVIEW_RESOLUTION_EVENT_TYPES,
  'patch.approved',
  'patch.apply_conflict',
  'patch.apply_failed',
]);
const PATCH_REVIEW_REQUEST_EVENT_TYPE = 'patch.review_required';
const PATCH_REVIEW_STATUS_BY_EVENT = new Map([
  ['patch.applied', 'applied'],
  ['patch.review_skipped', 'skipped'],
  ['patch.approved', 'approved'],
  ['patch.apply_conflict', 'conflict'],
  ['patch.apply_failed', 'failed'],
]);

async function readAuthoritativeRunState(runRoot) {
  return await readRunState(runRoot) || projectRunStateFromEvents(await readMachineEvents(runRoot));
}

function terminalRunError(current, toState, reason) {
  const err = new Error(`Machine run is terminal (${current.lifecycleStatus}/${current.summaryStatus}) and cannot transition to ${toState}.`);
  err.code = 'MACHINE_RUN_TERMINAL';
  err.lifecycleStatus = current.lifecycleStatus;
  err.summaryStatus = current.summaryStatus;
  err.toState = toState;
  err.reason = reason;
  return err;
}

function pendingApprovalsFromEvents(events = []) {
  const approvals = new Map();
  for (const event of events || []) {
    const approvalId = event?.payload?.approvalId || '';
    if (!approvalId) continue;
    if (event.eventType === 'approval.requested') {
      approvals.set(approvalId, {
        approvalId,
        itemId: event.itemId || event.payload?.itemId || '',
        status: 'requested',
        requestedSequence: event.sequence,
      });
    } else if (event.eventType === 'approval.decided') {
      const existing = approvals.get(approvalId) || { approvalId };
      approvals.set(approvalId, {
        ...existing,
        status: event.payload?.decision || 'decided',
        decisionSequence: event.sequence,
      });
    }
  }
  return [...approvals.values()].filter(approval => approval.status === 'requested');
}

async function assertNoPendingApprovalsForResume(runRoot) {
  const pendingApprovals = pendingApprovalsFromEvents(await readMachineEvents(runRoot));
  if (!pendingApprovals.length) return pendingApprovals;
  const err = new Error('Machine run cannot resume while approval requests are pending.');
  err.code = 'MACHINE_APPROVAL_PENDING';
  err.pendingApprovals = pendingApprovals;
  throw err;
}

async function assertRunLifecycleCanTransition(runRoot, toState, reason = 'lifecycle.transition') {
  assertRunLifecycleStatus(toState);
  const current = await readAuthoritativeRunState(runRoot);
  if (!current) return current;
  if (current.lifecycleStatus === toState) return current;
  if (TERMINAL_RUN_LIFECYCLE_STATES.has(current.lifecycleStatus)) {
    throw terminalRunError(current, toState, reason);
  }
  return current;
}

function assertRunLifecycleStatus(status) {
  if (RUN_LIFECYCLE_STATES.has(status)) return status;
  const err = new Error(`Invalid Machine run lifecycle status: ${status}`);
  err.code = 'MACHINE_RUN_LIFECYCLE_STATUS_INVALID';
  err.status = status;
  throw err;
}

function assertRunSummaryStatus(status) {
  if (RUN_SUMMARY_STATUSES.has(status)) return status;
  const err = new Error(`Invalid Machine run summary status: ${status}`);
  err.code = 'MACHINE_RUN_SUMMARY_STATUS_INVALID';
  err.status = status;
  throw err;
}

async function appendRunLifecycleStatus(runRoot, options = {}) {
  const { runId, toState, reason = `run.${toState}`, payload = {} } = options;
  if (!runId) throw new Error('runId is required.');
  if (!toState) throw new Error('toState is required.');
  const safeToState = assertRunLifecycleStatus(toState);
  const current = await assertRunLifecycleCanTransition(runRoot, safeToState, reason);
  if (current?.lifecycleStatus === safeToState) return { duplicate: true, runState: current };
  await appendMachineEvent(runRoot, {
    runId,
    actor: 'machine',
    eventType: 'run.status',
    fromState: current?.lifecycleStatus || 'created',
    toState: safeToState,
    reason,
    payload,
  });
  return { runState: await repairRunStateFromEvents(runRoot) };
}

async function appendRunSummaryStatus(runRoot, options = {}) {
  const { runId, summaryStatus, reason = `run.summary.${summaryStatus}`, payload = {} } = options;
  if (!runId) throw new Error('runId is required.');
  if (!summaryStatus) throw new Error('summaryStatus is required.');
  const safeSummaryStatus = assertRunSummaryStatus(summaryStatus);
  await appendMachineEvent(runRoot, {
    runId,
    actor: 'machine',
    eventType: 'run.summary',
    reason,
    payload: {
      ...payload,
      summaryStatus: safeSummaryStatus,
    },
  });
  return repairRunStateFromEvents(runRoot);
}

async function summarizeQueueInventory(runRoot) {
  const counts = Object.create(null);
  for (const entry of await readQueueItems(runRoot)) {
    counts[entry.state] = (counts[entry.state] || 0) + 1;
  }
  const activeCount = [...ACTIVE_QUEUE_STATES].reduce((sum, state) => sum + (counts[state] || 0), 0);
  const terminalCount = [...TERMINAL_QUEUE_STATES].reduce((sum, state) => sum + (counts[state] || 0), 0);
  return {
    counts,
    activeCount,
    terminalCount,
    blockedCount: counts.blocked || 0,
    doneCount: counts.done || 0,
  };
}

function summaryStatusFromInventory(inventory) {
  if (inventory.activeCount > 0) return 'partial';
  if (inventory.blockedCount > 0) return 'blocked';
  if (inventory.doneCount > 0 || inventory.terminalCount > 0) return 'done';
  return 'partial';
}

function workerResultIsPatchReviewEligible(payload = {}) {
  const status = String(payload.status || '').trim().toLowerCase();
  const toState = String(payload.toState || '').trim().toLowerCase();
  if ((status === 'blocked' || toState === 'blocked') && payload.patchArtifact) return true;
  if (status && status !== 'done') return false;
  if (toState && toState !== 'done') return false;
  return true;
}

function workerResultRequiresManualPatchReview(payload = {}) {
  const status = String(payload.status || '').trim().toLowerCase();
  const toState = String(payload.toState || '').trim().toLowerCase();
  return Boolean(payload.patchArtifact) && (status === 'blocked' || toState === 'blocked');
}

function patchReviewResumeStateFromEvents(events = []) {
  const patchArtifacts = [];
  const seen = new Set();
  for (const event of events) {
    if (event?.eventType !== 'worker.result') continue;
    if (!workerResultIsPatchReviewEligible(event.payload || {})) continue;
    const patchArtifact = String(event?.payload?.patchArtifact || '').trim();
    const changedFiles = Array.isArray(event?.payload?.changedFiles)
      ? event.payload.changedFiles.filter(Boolean)
      : [];
    if (!patchArtifact || seen.has(patchArtifact)) continue;
    seen.add(patchArtifact);
    patchArtifacts.push({
      patchArtifact,
      changedFiles,
      lockTargetFiles: Array.isArray(event?.payload?.lockTargetFiles) ? event.payload.lockTargetFiles : [],
      reviewRequired: workerResultRequiresManualPatchReview(event.payload || {}),
      sourceEvent: event,
    });
  }

  const decisions = new Map();
  const appliedFiles = [];
  let historicalConflictCount = 0;
  let historicalFailedCount = 0;
  for (const event of events) {
    const type = String(event?.eventType || '');
    if (!PATCH_REVIEW_DECISION_EVENT_TYPES.has(type)) continue;
    const patchArtifact = String(event?.payload?.patchArtifact || '').trim();
    if (!patchArtifact) continue;
    decisions.set(patchArtifact, {
      eventType: type,
      code: event?.payload?.code || '',
    });
    if (type === 'patch.apply_conflict') historicalConflictCount += 1;
    if (type === 'patch.apply_failed') historicalFailedCount += 1;
    if (type === 'patch.applied') {
      const payload = event.payload || {};
      const applied = Array.isArray(payload.applied)
        ? payload.applied.map(item => (typeof item === 'string' ? item : item?.path || item?.file || ''))
        : [];
      const selected = Array.isArray(payload.selectedFiles) ? payload.selectedFiles : [];
      appliedFiles.push(...(applied.length ? applied : selected).filter(Boolean));
    }
  }

  const reviewRequests = new Map();
  for (const event of events) {
    if (event?.eventType !== PATCH_REVIEW_REQUEST_EVENT_TYPE) continue;
    const patchArtifact = String(event?.payload?.patchArtifact || '').trim();
    if (!patchArtifact) continue;
    reviewRequests.set(patchArtifact, {
      eventType: PATCH_REVIEW_REQUEST_EVENT_TYPE,
      sequence: event.sequence ?? null,
      reason: event?.payload?.reason || '',
      reasons: Array.isArray(event?.payload?.reasons) ? event.payload.reasons : [],
      changedFiles: Array.isArray(event?.payload?.changedFiles) ? event.payload.changedFiles : [],
      declaredTargetFiles: Array.isArray(event?.payload?.declaredTargetFiles) ? event.payload.declaredTargetFiles : [],
      outsideTargetFiles: Array.isArray(event?.payload?.outsideTargetFiles) ? event.payload.outsideTargetFiles : [],
    });
  }

  const reviews = patchArtifacts.map(entry => {
    const decision = decisions.get(entry.patchArtifact) || null;
    const reviewRequest = reviewRequests.get(entry.patchArtifact) || null;
    const decisionType = decision?.eventType || '';
    const classification = shouldRequestPatchReview(entry.sourceEvent, {
      decision,
      reviewRequest,
      reviewRequired: entry.reviewRequired,
      lockTargetFiles: entry.lockTargetFiles,
    });
    return {
      patchArtifact: entry.patchArtifact,
      status: PATCH_REVIEW_STATUS_BY_EVENT.get(decisionType) || 'pending',
      resolved: PATCH_REVIEW_RESOLUTION_EVENT_TYPES.has(decisionType),
      reviewRequired: classification.requestReview,
      reviewReason: classification.reason,
      reviewReasons: classification.reasons,
    };
  });
  const pendingPatchArtifacts = reviews
    .filter(review => review.reviewRequired && !review.resolved)
    .map(review => review.patchArtifact);
  return {
    required: pendingPatchArtifacts.length > 0,
    resolved: pendingPatchArtifacts.length === 0,
    patchCount: patchArtifacts.length,
    pendingCount: pendingPatchArtifacts.length,
    appliedCount: reviews.filter(review => review.status === 'applied').length,
    skippedCount: reviews.filter(review => review.status === 'skipped').length,
    approvedCount: reviews.filter(review => review.status === 'approved').length,
    conflictCount: reviews.filter(review => review.status === 'conflict').length,
    failedCount: reviews.filter(review => review.status === 'failed').length,
    historicalConflictCount,
    historicalFailedCount,
    appliedFiles: [...new Set(appliedFiles)],
    pendingPatchArtifacts,
  };
}

function hasBlockedPatchReviewNode(events = []) {
  const latestByPath = new Map();
  for (const event of events) {
    if (!String(event?.eventType || '').startsWith('node.')) continue;
    if (event?.payload?.nodeType !== 'orpad.patchReview') continue;
    const nodePath = String(event?.nodePath || '').trim();
    if (!nodePath) continue;
    latestByPath.set(nodePath, event);
  }
  return [...latestByPath.values()].some(event => event.eventType === 'node.blocked');
}

function summaryStatusFromInventoryAndEvents(inventory, events = []) {
  const patchReview = patchReviewResumeStateFromEvents(events);
  if (patchReview.required && !patchReview.resolved) return 'blocked';
  return summaryStatusFromInventory(inventory);
}

async function assertNoActiveInventoryForDone(runRoot) {
  const inventory = await summarizeQueueInventory(runRoot);
  if (inventory.activeCount === 0) return inventory;
  const err = new Error('Run cannot be marked done while active queue inventory remains.');
  err.code = 'RUN_DONE_ACTIVE_INVENTORY';
  err.inventory = inventory;
  throw err;
}

async function finalizeRunFromInventory(runRoot, options = {}) {
  const { runId, reason = 'lifecycle.inventory-finalize' } = options;
  if (!runId) throw new Error('runId is required.');
  const inventory = await summarizeQueueInventory(runRoot);
  const events = await readMachineEvents(runRoot);
  const patchReview = patchReviewResumeStateFromEvents(events);
  const summaryStatus = summaryStatusFromInventoryAndEvents(inventory, events);
  if (summaryStatus === 'done') {
    await assertNoActiveInventoryForDone(runRoot);
    await appendRunLifecycleStatus(runRoot, {
      runId,
      toState: 'completed',
      reason,
      payload: { inventory },
    });
  } else {
    await appendRunLifecycleStatus(runRoot, {
      runId,
      toState: 'waiting',
      reason,
      payload: { inventory },
    });
  }
  const runState = await appendRunSummaryStatus(runRoot, {
    runId,
    summaryStatus,
    reason,
    payload: { inventory, patchReview },
  });
  return {
    inventory,
    patchReview,
    summaryStatus,
    runState,
  };
}

async function repairDerivedQueueFilesFromEvents(runRoot) {
  const events = await readMachineEvents(runRoot);
  const projected = projectQueueStateFromEvents(events);
  const repaired = [];
  const missing = [];

  for (const [itemId, projectedState] of projected.entries()) {
    const current = await findQueueItem(runRoot, itemId, { canonicalOnly: false });
    if (!current) {
      missing.push({ itemId, projectedState, reason: 'missing-item-snapshot' });
      continue;
    }
    if (current.state === projectedState && current.item.state === projectedState) continue;
    const item = {
      ...current.item,
      state: projectedState,
      updatedAt: new Date().toISOString(),
    };
    await writeQueueItem(runRoot, item);
    repaired.push({
      itemId,
      fromState: current.state,
      toState: projectedState,
    });
  }

  return { repaired, missing };
}

async function resumeMachineRun(runRoot, options = {}) {
  const {
    runId,
    now = new Date().toISOString(),
    recoverStaleClaims,
    emitNodeCancelledForInflight,
  } = options;
  if (!runId) throw new Error('runId is required.');
  await assertRunLifecycleCanTransition(runRoot, 'waiting', 'lifecycle.resume');
  await assertNoPendingApprovalsForResume(runRoot);
  const queueRepair = await repairDerivedQueueFilesFromEvents(runRoot);
  const staleClaims = recoverStaleClaims
    ? await recoverStaleClaims(runRoot, { runId, now })
    : [];
  const cancelledNodes = staleClaims.length && typeof emitNodeCancelledForInflight === 'function'
    ? await emitNodeCancelledForInflight(runRoot, runId, 'lifecycle.resume.stale-claim')
    : [];
  await appendRunLifecycleStatus(runRoot, {
    runId,
    toState: 'waiting',
    reason: 'lifecycle.resume',
    payload: {
      queueRepair,
      staleClaimCount: staleClaims.length,
      cancelledNodeCount: cancelledNodes.length,
    },
  });
  const inventory = await summarizeQueueInventory(runRoot);
  const events = await readMachineEvents(runRoot);
  const patchReview = patchReviewResumeStateFromEvents(events);
  const runState = await appendRunSummaryStatus(runRoot, {
    runId,
    summaryStatus: summaryStatusFromInventoryAndEvents(inventory, events),
    reason: 'lifecycle.resume',
    payload: {
      inventory,
      patchReview,
      queueRepair,
      staleClaimCount: staleClaims.length,
      cancelledNodeCount: cancelledNodes.length,
    },
  });
  return {
    queueRepair,
    staleClaims,
    cancelledNodes,
    inventory,
    patchReview,
    runState,
  };
}

module.exports = {
  ACTIVE_QUEUE_STATES,
  RUN_LIFECYCLE_STATES,
  RUN_SUMMARY_STATUSES,
  TERMINAL_QUEUE_STATES,
  TERMINAL_RUN_LIFECYCLE_STATES,
  appendRunLifecycleStatus,
  appendRunSummaryStatus,
  assertNoPendingApprovalsForResume,
  assertNoActiveInventoryForDone,
  assertRunLifecycleCanTransition,
  assertRunLifecycleStatus,
  assertRunSummaryStatus,
  finalizeRunFromInventory,
  patchReviewResumeStateFromEvents,
  repairDerivedQueueFilesFromEvents,
  resumeMachineRun,
  summarizeQueueInventory,
  summaryStatusFromInventory,
  summaryStatusFromInventoryAndEvents,
};
