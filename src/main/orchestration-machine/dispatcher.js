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
const { acquireWriteSetLock, releaseWriteSetLock } = require('./write-sets');

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
    if (!lease || lease.state !== 'active' || !isClaimLeaseExpired(lease, now)) continue;
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
    await markClaimLeaseReleased(runRoot, claimId, { now, state: 'expired', reason });
    if (lease.writeSetLockId) {
      await releaseWriteSetLock(runRoot, lease.writeSetLockId, { now, state: 'expired', reason });
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

  const next = queued[0];
  const approvalGrants = approvedApprovalGrantsFromEvents(await readMachineEvents(runRoot));
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
  recoverStaleClaims,
  severityRank,
  writeSetPathsForItem,
};
