const { appendMachineEvent, projectRunStateFromEvents, readMachineEvents } = require('./events');
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
  const summaryStatus = summaryStatusFromInventory(inventory);
  if (summaryStatus === 'done') {
    await assertNoActiveInventoryForDone(runRoot);
    await appendRunLifecycleStatus(runRoot, {
      runId,
      toState: 'completed',
      reason,
      payload: { inventory },
    });
  }
  const runState = await appendRunSummaryStatus(runRoot, {
    runId,
    summaryStatus,
    reason,
    payload: { inventory },
  });
  return {
    inventory,
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
    const current = await findQueueItem(runRoot, itemId);
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
  const { runId, now = new Date().toISOString(), recoverStaleClaims } = options;
  if (!runId) throw new Error('runId is required.');
  await assertRunLifecycleCanTransition(runRoot, 'waiting', 'lifecycle.resume');
  await assertNoPendingApprovalsForResume(runRoot);
  const queueRepair = await repairDerivedQueueFilesFromEvents(runRoot);
  const staleClaims = recoverStaleClaims
    ? await recoverStaleClaims(runRoot, { runId, now })
    : [];
  await appendRunLifecycleStatus(runRoot, {
    runId,
    toState: 'waiting',
    reason: 'lifecycle.resume',
    payload: {
      queueRepair,
      staleClaimCount: staleClaims.length,
    },
  });
  const inventory = await summarizeQueueInventory(runRoot);
  const runState = await appendRunSummaryStatus(runRoot, {
    runId,
    summaryStatus: summaryStatusFromInventory(inventory),
    reason: 'lifecycle.resume',
    payload: {
      inventory,
      queueRepair,
      staleClaimCount: staleClaims.length,
    },
  });
  return {
    queueRepair,
    staleClaims,
    inventory,
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
  repairDerivedQueueFilesFromEvents,
  resumeMachineRun,
  summarizeQueueInventory,
  summaryStatusFromInventory,
};
