const { appendMachineEvent, readMachineEvents } = require('./events');
const { repairRunStateFromEvents, readRunState } = require('./run-store');
const { findQueueItem, projectQueueStateFromEvents, readQueueItems, writeQueueItem } = require('./queue-store');

const ACTIVE_QUEUE_STATES = new Set(['candidate', 'queued', 'claimed']);
const TERMINAL_QUEUE_STATES = new Set(['done', 'blocked', 'rejected']);

async function appendRunLifecycleStatus(runRoot, options = {}) {
  const { runId, toState, reason = `run.${toState}`, payload = {} } = options;
  if (!runId) throw new Error('runId is required.');
  if (!toState) throw new Error('toState is required.');
  const current = await readRunState(runRoot);
  if (current?.lifecycleStatus === toState) return { duplicate: true, runState: current };
  await appendMachineEvent(runRoot, {
    runId,
    actor: 'machine',
    eventType: 'run.status',
    fromState: current?.lifecycleStatus || 'created',
    toState,
    reason,
    payload,
  });
  return { runState: await repairRunStateFromEvents(runRoot) };
}

async function appendRunSummaryStatus(runRoot, options = {}) {
  const { runId, summaryStatus, reason = `run.summary.${summaryStatus}`, payload = {} } = options;
  if (!runId) throw new Error('runId is required.');
  if (!summaryStatus) throw new Error('summaryStatus is required.');
  await appendMachineEvent(runRoot, {
    runId,
    actor: 'machine',
    eventType: 'run.summary',
    reason,
    payload: {
      summaryStatus,
      ...payload,
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
  TERMINAL_QUEUE_STATES,
  appendRunLifecycleStatus,
  appendRunSummaryStatus,
  assertNoActiveInventoryForDone,
  finalizeRunFromInventory,
  repairDerivedQueueFilesFromEvents,
  resumeMachineRun,
  summarizeQueueInventory,
  summaryStatusFromInventory,
};
