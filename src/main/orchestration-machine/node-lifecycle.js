const { appendMachineEvent } = require('./events');
const { repairRunStateFromEvents } = require('./run-store');

const NODE_LIFECYCLE_STATUSES = Object.freeze([
  'scheduled',
  'started',
  'completed',
  'failed',
  'skipped',
  'blocked',
  // 'cancelled' marks an attempt that was interrupted by a Cancel/Stop
  // user action (or by claim cancellation) while node.started was the
  // last lifecycle event. It is terminal for the current attempt; a
  // fresh attempt N+1 may still re-run the node.
  'cancelled',
]);

function createNodeExecutionId(runId, nodePath, attempt = 1) {
  return `${runId}:${String(nodePath || '').replace(/[^a-zA-Z0-9_.:/-]+/g, '-')}:attempt-${attempt}`;
}

async function recordNodeLifecycleEvent(runRoot, options = {}) {
  const {
    runId,
    nodePath,
    nodeType,
    status,
    attempt = 1,
    timestamp = new Date().toISOString(),
    payload = {},
  } = options;
  if (!NODE_LIFECYCLE_STATUSES.includes(status)) {
    throw new Error(`Unknown node lifecycle status: ${status}`);
  }
  const event = await appendMachineEvent(runRoot, {
    runId,
    timestamp,
    actor: 'machine',
    nodePath,
    eventType: `node.${status}`,
    payload: {
      nodeExecutionId: createNodeExecutionId(runId, nodePath, attempt),
      nodeType,
      status,
      attempt,
      ...payload,
    },
  });
  await repairRunStateFromEvents(runRoot);
  return event;
}

module.exports = {
  NODE_LIFECYCLE_STATUSES,
  createNodeExecutionId,
  recordNodeLifecycleEvent,
};
