const path = require('path');

const { readMachineEvents } = require('./events');
const {
  requestApprovalForItem,
  summarizeApprovalsFromEvents,
} = require('./approvals');
const {
  appendRunLifecycleStatus,
  assertRunLifecycleCanTransition,
} = require('./lifecycle');
const {
  createClaimId,
  createClaimLease,
  isClaimLeaseExpired,
  markClaimLeaseReleased,
  readClaimLease,
} = require('./claims');
const { readQueueItems, transitionQueueItem } = require('./queue-store');
const {
  acquireWriteSetLock,
  normalizeWriteSetPath,
  normalizeWriteSetPaths,
  pathsOverlap,
  releaseWriteSetLock,
} = require('./write-sets');

const claimSelectionQueues = new Map();

const SEVERITY_ORDER = Object.freeze({
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
  P5: 5,
});

function severityRank(severity) {
  const key = String(severity || '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(SEVERITY_ORDER, key) ? SEVERITY_ORDER[key] : 99;
}

function compareQueuedWorkItems(a, b) {
  return severityRank(a.item.severity) - severityRank(b.item.severity)
    || String(a.item.createdAt || '').localeCompare(String(b.item.createdAt || ''))
    || String(a.item.id).localeCompare(String(b.item.id));
}

function hasApprovalGrant(item, grants = []) {
  if (!item.approvalRequired) return true;
  return grants.some(grant => {
    return grant?.itemId === item.id
      && grant?.approved === true
      && typeof grant?.approvalId === 'string'
      && grant.approvalId.length > 0;
  });
}

function approvedApprovalGrantsFromEvents(events = []) {
  return summarizeApprovalsFromEvents(events)
    .all
    .filter(approval => approval.status === 'approved')
    .flatMap(approval => approval.grants || []);
}

function writeSetPathsForItem(item = {}) {
  if (Object.prototype.hasOwnProperty.call(item, 'targetFiles') && Array.isArray(item.targetFiles)) {
    return item.targetFiles;
  }
  return item.sourceOfTruthTargets || [];
}

function normalizePatchChangedFiles(files = []) {
  const normalized = [];
  for (const file of Array.isArray(files) ? files : []) {
    try {
      const next = normalizeWriteSetPath(file);
      if (next) normalized.push(next);
    } catch {
      // Historical worker.result events may contain diagnostics rather
      // than strict workspace-relative paths. They should not break
      // future dispatch; the patch review path will still surface them.
    }
  }
  return [...new Set(normalized)].sort();
}

function workerResultIsPendingPatchEligible(payload = {}) {
  const status = String(payload.status || '').trim().toLowerCase();
  const toState = String(payload.toState || '').trim().toLowerCase();
  if (status && status !== 'done') return false;
  if (toState && toState !== 'done') return false;
  return true;
}

function pendingPatchWriteSetsFromEvents(events = []) {
  const pending = new Map();
  for (const event of events || []) {
    if (event?.eventType === 'worker.result') {
      if (!workerResultIsPendingPatchEligible(event.payload || {})) continue;
      const patchArtifact = String(event?.payload?.patchArtifact || '').trim();
      const paths = normalizePatchChangedFiles(event?.payload?.changedFiles || []);
      if (!patchArtifact || !paths.length) continue;
      pending.set(patchArtifact, {
        patchArtifact,
        itemId: event.itemId || '',
        claimId: event.payload?.claimId || '',
        paths,
        sourceSequence: event.sequence ?? null,
      });
      continue;
    }
    if (event?.eventType === 'patch.applied' || event?.eventType === 'patch.review_skipped') {
      const patchArtifact = String(event?.payload?.patchArtifact || '').trim();
      if (patchArtifact) pending.delete(patchArtifact);
    }
  }
  return [...pending.values()];
}

function pendingPatchOverlapForItem(item = {}, pendingPatches = []) {
  if (!pendingPatches.length) return null;
  const itemPaths = normalizeWriteSetPaths(writeSetPathsForItem(item));
  if (!itemPaths.length) {
    const patch = pendingPatches[0];
    return {
      itemId: item.id || '',
      paths: [],
      globalWriteSet: true,
      patchArtifact: patch.patchArtifact,
      patchItemId: patch.itemId,
      patchPaths: patch.paths,
      overlappingPaths: patch.paths,
    };
  }
  for (const patch of pendingPatches) {
    const overlappingPaths = itemPaths.filter(itemPath => (
      patch.paths.some(patchPath => pathsOverlap(itemPath, patchPath))
    ));
    if (!overlappingPaths.length) continue;
    return {
      itemId: item.id || '',
      paths: itemPaths,
      globalWriteSet: false,
      patchArtifact: patch.patchArtifact,
      patchItemId: patch.itemId,
      patchPaths: patch.paths,
      overlappingPaths,
    };
  }
  return null;
}

function selectQueuedItemForDispatch(queued = [], pendingPatches = []) {
  const deferred = [];
  for (const entry of queued) {
    const pendingPatchOverlap = pendingPatchOverlapForItem(entry.item, pendingPatches);
    if (pendingPatchOverlap) {
      deferred.push(pendingPatchOverlap);
      continue;
    }
    return { entry, deferred };
  }
  return { entry: null, deferred };
}

async function withClaimSelectionQueue(runRoot, task) {
  const key = path.resolve(runRoot);
  const previous = claimSelectionQueues.get(key) || Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(task);
  claimSelectionQueues.set(key, operation);
  try {
    return await operation;
  } finally {
    if (claimSelectionQueues.get(key) === operation) claimSelectionQueues.delete(key);
  }
}

async function appendRunStatus(runRoot, runId, toState, options = {}) {
  return appendRunLifecycleStatus(runRoot, {
    runId,
    toState,
    reason: options.reason || `run.${toState}`,
    payload: options.payload || {},
  });
}

async function hasAcceptedWorkerResult(runRoot, claimId) {
  const events = await readMachineEvents(runRoot);
  return events.some(event => event.eventType === 'worker.result' && event.payload?.claimId === claimId);
}

async function recoverStaleClaims(runRoot, options = {}) {
  const {
    runId,
    now = new Date().toISOString(),
    toState = 'queued',
    reason = 'claim.stale-recovered',
    force = false,
    leaseState = force ? 'cancelled' : 'expired',
  } = options;
  await assertRunLifecycleCanTransition(runRoot, 'running', reason);
  const recovered = [];
  const claimed = (await readQueueItems(runRoot))
    .filter(entry => entry.state === 'claimed')
    .sort(compareQueuedWorkItems);

  for (const entry of claimed) {
    const claimId = entry.item.claimId;
    if (!claimId) continue;
    const lease = await readClaimLease(runRoot, claimId);
    if (!lease || lease.state !== 'active') continue;
    if (!force && !isClaimLeaseExpired(lease, now)) continue;
    if (await hasAcceptedWorkerResult(runRoot, claimId)) continue;

    const transition = await transitionQueueItem(runRoot, {
      runId,
      itemId: entry.item.id,
      toState,
      reason,
      evidence: `locks/claims/${claimId}.json`,
      transitionId: `recover:${claimId}:${toState}`,
      now,
      itemPatch: {
        recoveredFromClaimId: claimId,
        claimId: undefined,
        claimLeaseExpiresAt: undefined,
        writeSetLockId: undefined,
      },
      payload: {
        claimId,
        recovery: 'stale-claim',
      },
    });
    await markClaimLeaseReleased(runRoot, claimId, { now, state: leaseState, reason });
    if (lease.writeSetLockId) {
      await releaseWriteSetLock(runRoot, lease.writeSetLockId, { now, state: leaseState, reason });
    }
    recovered.push({ transition, lease });
  }
  return recovered;
}

async function claimNextQueuedItemUnlocked(runRoot, options = {}) {
  const {
    runId,
    workerId = 'orpad.workerLoop',
    leaseMs,
    now = new Date().toISOString(),
  } = options;
  if (!runId) throw new Error('runId is required.');
  await assertRunLifecycleCanTransition(runRoot, 'running', 'dispatcher.claimed');

  const recovered = options.recoverStale === false
    ? []
    : await recoverStaleClaims(runRoot, { runId, now });
  const queued = (await readQueueItems(runRoot))
    .filter(entry => entry.state === 'queued')
    .sort(compareQueuedWorkItems);

  if (!queued.length) return { claimed: false, stopReason: 'queue-empty', recovered };

  const events = await readMachineEvents(runRoot);
  const pendingPatches = options.enforcePendingPatchConflicts === false
    ? []
    : pendingPatchWriteSetsFromEvents(events);
  const selection = selectQueuedItemForDispatch(queued, pendingPatches);
  if (!selection.entry) {
    return {
      claimed: false,
      stopReason: 'pending-patch-overlap',
      recovered,
      pendingPatchOverlaps: selection.deferred,
    };
  }

  const next = selection.entry;
  const approvalGrants = approvedApprovalGrantsFromEvents(events);
  if (!hasApprovalGrant(next.item, approvalGrants)) {
    const approval = await requestApprovalForItem(runRoot, {
      runId,
      item: next.item,
      reason: 'dispatcher.approval-required',
      now,
    });
    return {
      claimed: false,
      stopReason: 'approval-required',
      item: next.item,
      approval,
      runState: approval.runState,
      recovered,
      pendingPatchOverlaps: selection.deferred,
    };
  }

  const claimId = createClaimId(next.item.id, {
    claimId: options.claimId,
    now,
    suffix: options.claimSuffix,
  });
  const writeSet = await acquireWriteSetLock(runRoot, {
    runId,
    claimId,
    itemId: next.item.id,
    paths: writeSetPathsForItem(next.item),
    now,
    enforceConflicts: options.enforceWriteSetConflicts !== false,
  });
  const claimResult = await createClaimLease(runRoot, {
    runId,
    itemId: next.item.id,
    workerId,
    leaseMs,
    now,
    claimId,
    writeSetLockId: writeSet.lock.lockId,
    writeSetPaths: writeSet.lock.paths,
  });
  const claim = claimResult.lease;

  let transition;
  try {
    transition = await transitionQueueItem(runRoot, {
      runId,
      itemId: next.item.id,
      toState: 'claimed',
      expectedFromState: 'queued',
      reason: 'dispatcher.claimed',
      evidence: `locks/claims/${claim.claimId}.json`,
      transitionId: `claim:${next.item.id}:${claim.claimId}`,
      now,
      itemPatch: {
        claimId: claim.claimId,
        claimedBy: workerId,
        claimedAt: now,
        claimLeaseExpiresAt: claim.expiresAt,
        writeSetLockId: writeSet.lock.lockId,
      },
      payload: {
        claimId: claim.claimId,
        workerId,
        writeSetLockId: writeSet.lock.lockId,
      },
    });
  } catch (err) {
    if (!claimResult.duplicate) {
      await markClaimLeaseReleased(runRoot, claim.claimId, {
        now,
        state: 'released',
        reason: 'dispatcher.claim-aborted',
      }).catch(() => null);
    }
    if (!writeSet.duplicate) {
      await releaseWriteSetLock(runRoot, writeSet.lock.lockId, {
        now,
        reason: 'dispatcher.claim-aborted',
      }).catch(() => null);
    }
    throw err;
  }
  await appendRunStatus(runRoot, runId, 'running', {
    reason: 'dispatcher.claimed',
    payload: {
      itemId: next.item.id,
      claimId: claim.claimId,
    },
  });

  return {
    claimed: true,
    item: transition.item,
    claim,
    writeSet: writeSet.lock,
    transition,
    recovered,
    pendingPatchOverlaps: selection.deferred,
  };
}

async function claimNextQueuedItem(runRoot, options = {}) {
  return withClaimSelectionQueue(runRoot, () => claimNextQueuedItemUnlocked(runRoot, options));
}

module.exports = {
  claimNextQueuedItem,
  approvedApprovalGrantsFromEvents,
  compareQueuedWorkItems,
  hasApprovalGrant,
  pendingPatchOverlapForItem,
  pendingPatchWriteSetsFromEvents,
  recoverStaleClaims,
  selectQueuedItemForDispatch,
  severityRank,
  writeSetPathsForItem,
};
