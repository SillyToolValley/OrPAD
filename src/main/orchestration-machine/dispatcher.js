const { appendMachineEvent, readMachineEvents } = require('./events');
const { readRunState, repairRunStateFromEvents } = require('./run-store');
const {
  createClaimId,
  createClaimLease,
  isClaimLeaseExpired,
  markClaimLeaseReleased,
  readClaimLease,
} = require('./claims');
const { readQueueItems, transitionQueueItem } = require('./queue-store');
const { acquireWriteSetLock, releaseWriteSetLock } = require('./write-sets');

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
    if (grant === true || grant === '*') return true;
    if (typeof grant === 'string') return grant === item.id;
    return grant?.itemId === item.id && grant?.approved === true;
  });
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

async function claimNextQueuedItem(runRoot, options = {}) {
  const {
    runId,
    workerId = 'orpad.workerLoop',
    leaseMs,
    approvalGrants = [],
    now = new Date().toISOString(),
  } = options;
  if (!runId) throw new Error('runId is required.');

  const recovered = options.recoverStale === false
    ? []
    : await recoverStaleClaims(runRoot, { runId, now });
  const queued = (await readQueueItems(runRoot))
    .filter(entry => entry.state === 'queued')
    .sort(compareQueuedWorkItems);

  if (!queued.length) return { claimed: false, stopReason: 'queue-empty', recovered };

  const next = queued[0];
  if (!hasApprovalGrant(next.item, approvalGrants)) {
    const status = await appendRunStatus(runRoot, runId, 'approval-required', {
      reason: 'dispatcher.approval-required',
      payload: {
        itemId: next.item.id,
      },
    });
    return {
      claimed: false,
      stopReason: 'approval-required',
      item: next.item,
      runState: status.runState,
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
    paths: next.item.sourceOfTruthTargets || [],
    now,
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

  const transition = await transitionQueueItem(runRoot, {
    runId,
    itemId: next.item.id,
    toState: 'claimed',
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

module.exports = {
  claimNextQueuedItem,
  compareQueuedWorkItems,
  hasApprovalGrant,
  recoverStaleClaims,
  severityRank,
};
