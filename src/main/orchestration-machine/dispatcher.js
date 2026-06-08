const path = require('path');

const { readMachineEvents } = require('./events');
const {
  requestApprovalForItem,
  summarizeApprovalsFromEvents,
} = require('./approvals');
const { processPidIsActive, registeredMachineProcessCount } = require('./adapters/process-runner');
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
const { projectQueueSteerPriorityFromEvents, readQueueItems, transitionQueueItem } = require('./queue-store');
const {
  acquireWriteSetLock,
  normalizeWriteSetPath,
  normalizeWriteSetPaths,
  pathsOverlap,
  releaseWriteSetLock,
} = require('./write-sets');
const { workerResultIsPatchReviewEligible } = require('./patch-review-eligibility');

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
  // STEER "do this first": a human-reprioritized item sorts ahead of all others.
  // `_steerPriority` is the SEQUENCE of the item's latest queue.reprioritized
  // event (attached at selection time from the event log); higher = more recently
  // steered = claimed sooner. Entries without it (the default — and other callers
  // that don't attach it, e.g. the stale-claim sort) keep the original order.
  const aSteer = Number.isFinite(a._steerPriority) ? a._steerPriority : -1;
  const bSteer = Number.isFinite(b._steerPriority) ? b._steerPriority : -1;
  if (aSteer !== bSteer) return bSteer - aSteer;
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
  return workerResultIsPatchReviewEligible(payload);
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
    if (
      event?.eventType === 'patch.applied'
      || event?.eventType === 'patch.review_skipped'
      || event?.eventType === 'patch.review_rejected'
    ) {
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

function eventTimeMs(event) {
  const value = Date.parse(event?.timestamp || '');
  return Number.isFinite(value) ? value : 0;
}

function unresolvedWorkerAdapterRequestsByClaim(events = []) {
  const requests = new Map();
  const resolvedKeys = new Set();
  for (const event of events || []) {
    const key = String(event?.payload?.idempotencyKey || '').trim();
    if (!key) continue;
    if (event.eventType === 'adapter.requested' && event.payload?.taskKind === 'workerLoop') {
      const claimId = String(event.payload?.adapterCallId || '').replace(/-graph-cli$/, '');
      const itemRef = String((event.payload?.inputArtifacts || [])[0] || '');
      const itemId = itemRef.match(/queue\/claimed\/(.+)\.json$/)?.[1] || '';
      if (!claimId) continue;
      requests.set(claimId, {
        event,
        adapterCallId: String(event.payload.adapterCallId || ''),
        idempotencyKey: key,
        itemId,
        nodePath: String(event.nodePath || '').trim(),
      });
      continue;
    }
    if (event.eventType === 'adapter.result' || event.eventType === 'worker.result') {
      resolvedKeys.add(key);
    }
  }
  for (const [claimId, request] of [...requests.entries()]) {
    if (resolvedKeys.has(request.idempotencyKey)) requests.delete(claimId);
  }
  return requests;
}

function activeWorkerNodeExecutions(events = [], nodePath = '') {
  const active = new Map();
  const pathKey = String(nodePath || '').trim();
  for (const event of events || []) {
    if (!event || (pathKey && event.nodePath !== pathKey)) continue;
    if (!String(event.eventType || '').startsWith('node.')) continue;
    const eventNodePath = String(event.nodePath || '').trim();
    if (!eventNodePath) continue;
    const attempt = Number(event.payload?.attempt) || 1;
    const key = `${eventNodePath}:${attempt}`;
    if (event.eventType === 'node.started' && event.payload?.nodeType === 'orpad.workerLoop') {
      active.set(key, event);
    } else if (['node.completed', 'node.failed', 'node.blocked', 'node.skipped', 'node.cancelled'].includes(event.eventType)) {
      active.delete(key);
    }
  }
  return [...active.values()];
}

function adapterProcessStateForRequest(events = [], request = {}) {
  const idempotencyKey = String(request.idempotencyKey || '').trim();
  const adapterCallId = String(request.adapterCallId || '').trim();
  let started = null;
  let finished = null;
  for (const event of events || []) {
    const payload = event.payload || {};
    const sameRequest = (idempotencyKey && payload.idempotencyKey === idempotencyKey)
      || (adapterCallId && payload.adapterCallId === adapterCallId);
    if (!sameRequest) continue;
    if (event.eventType === 'adapter.process.started') started = event;
    if (event.eventType === 'adapter.process.finished') finished = event;
  }
  const pid = Number(started?.payload?.pid || 0);
  return {
    started,
    finished,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    pidActive: processPidIsActive(pid),
  };
}

function orphanedAdapterRequestForLease(lease, events, options = {}) {
  if (!lease?.claimId || lease.state !== 'active') return null;
  const nowMs = Date.parse(options.now || new Date().toISOString());
  if (!Number.isFinite(nowMs)) return null;
  const request = unresolvedWorkerAdapterRequestsByClaim(events).get(lease.claimId);
  if (!request) return null;
  const requestAgeMs = nowMs - eventTimeMs(request.event);
  const graceMs = Number.isFinite(Number(options.orphanedAdapterGraceMs))
    ? Math.max(0, Number(options.orphanedAdapterGraceMs))
    : 120_000;
  if (requestAgeMs < graceMs) return null;
  if (registeredMachineProcessCount(`process:${request.adapterCallId}`) > 0) return null;
  const processState = adapterProcessStateForRequest(events, request);
  if (processState.pidActive) return null;
  const activeNodes = activeWorkerNodeExecutions(events, request.nodePath);
  if (activeNodes.length) {
    if (!processState.started && !processState.finished) return null;
    if (processState.started && !processState.finished && processState.pid) return {
      ...request,
      requestAgeMs,
      graceMs,
      processState: {
        startedSequence: processState.started.sequence,
        pid: processState.pid,
        pidActive: false,
        reason: 'adapter-process-pid-not-active',
      },
    };
    if (processState.finished) {
      const finishedAgeMs = nowMs - eventTimeMs(processState.finished);
      const finishedGraceMs = Number.isFinite(Number(options.orphanedAdapterFinishedGraceMs))
        ? Math.max(0, Number(options.orphanedAdapterFinishedGraceMs))
        : 30_000;
      if (finishedAgeMs < finishedGraceMs) return null;
      return {
        ...request,
        requestAgeMs,
        graceMs,
        processState: {
          startedSequence: processState.started?.sequence ?? null,
          finishedSequence: processState.finished.sequence,
          pid: processState.pid,
          finishedAgeMs,
          finishedGraceMs,
          reason: 'adapter-process-finished-without-worker-result',
        },
      };
    }
    return null;
  }
  return {
    ...request,
    requestAgeMs,
    graceMs,
    ...(processState.started || processState.finished ? {
      processState: {
        startedSequence: processState.started?.sequence ?? null,
        finishedSequence: processState.finished?.sequence ?? null,
        pid: processState.pid,
        pidActive: false,
      },
    } : {}),
  };
}

async function recoverStaleClaims(runRoot, options = {}) {
  const {
    runId,
    now = new Date().toISOString(),
    toState = 'queued',
    reason = 'claim.stale-recovered',
    force = false,
    leaseState = force ? 'cancelled' : 'expired',
    recoverOrphanedAdapters = false,
    orphanedAdapterGraceMs = 120_000,
    orphanedAdapterFinishedGraceMs,
  } = options;
  await assertRunLifecycleCanTransition(runRoot, 'running', reason);
  const recovered = [];
  const events = await readMachineEvents(runRoot);
  const claimed = (await readQueueItems(runRoot))
    .filter(entry => entry.state === 'claimed')
    .sort(compareQueuedWorkItems);

  for (const entry of claimed) {
    const claimId = entry.item.claimId;
    if (!claimId) continue;
    const lease = await readClaimLease(runRoot, claimId);
    if (!lease || lease.state !== 'active') continue;
    if (await hasAcceptedWorkerResult(runRoot, claimId)) continue;
    const orphanedAdapter = recoverOrphanedAdapters
      ? orphanedAdapterRequestForLease(lease, events, {
        now,
        orphanedAdapterGraceMs,
        orphanedAdapterFinishedGraceMs,
      })
      : null;
    const expired = isClaimLeaseExpired(lease, now);
    if (!force && !expired && !orphanedAdapter) continue;
    const recoveryReason = orphanedAdapter ? 'claim.orphaned-adapter-recovered' : reason;
    const recoveryLeaseState = orphanedAdapter ? 'cancelled' : leaseState;

    const transition = await transitionQueueItem(runRoot, {
      runId,
      itemId: entry.item.id,
      toState,
      reason: recoveryReason,
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
        recovery: orphanedAdapter ? 'orphaned-adapter-request' : 'stale-claim',
        ...(orphanedAdapter ? {
          adapterCallId: orphanedAdapter.adapterCallId,
          idempotencyKey: orphanedAdapter.idempotencyKey,
          requestSequence: orphanedAdapter.event.sequence,
          requestAgeMs: orphanedAdapter.requestAgeMs,
          graceMs: orphanedAdapter.graceMs,
          ...(orphanedAdapter.processState ? { processState: orphanedAdapter.processState } : {}),
        } : {}),
      },
    });
    await markClaimLeaseReleased(runRoot, claimId, { now, state: recoveryLeaseState, reason: recoveryReason });
    if (lease.writeSetLockId) {
      await releaseWriteSetLock(runRoot, lease.writeSetLockId, { now, state: recoveryLeaseState, reason: recoveryReason });
    }
    recovered.push({ transition, lease, orphanedAdapter });
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
    : await recoverStaleClaims(runRoot, {
      runId,
      now,
      recoverOrphanedAdapters: options.recoverOrphanedAdapters === true,
      orphanedAdapterGraceMs: options.orphanedAdapterGraceMs,
    });
  // Read events once (after recovery) for BOTH the STEER priority and the pending
  // patch conflicts. _steerPriority attaches a human "do this first" rank so the
  // comparator pulls reprioritized items to the front; an empty map = default order.
  const events = await readMachineEvents(runRoot);
  const steerPriority = projectQueueSteerPriorityFromEvents(events);
  const queued = (await readQueueItems(runRoot))
    .filter(entry => entry.state === 'queued')
    .map(entry => ({ ...entry, _steerPriority: steerPriority.get(entry.item.id) }))
    .sort(compareQueuedWorkItems);

  if (!queued.length) return { claimed: false, stopReason: 'queue-empty', recovered };

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
