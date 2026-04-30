const { registerArtifact } = require('./artifacts');
const { appendMachineEvent } = require('./events');
const {
  appendRunLifecycleStatus,
  appendRunSummaryStatus,
  assertRunLifecycleCanTransition,
} = require('./lifecycle');

function approvalIdForItem(itemId) {
  return `approval-${String(itemId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'item'}`;
}

async function requestApprovalForItem(runRoot, options = {}) {
  const {
    runId,
    item,
    reason = 'approval-required',
    requestedCapabilities = [],
    commandSpec = null,
    writeSetPaths = item?.sourceOfTruthTargets || [],
    now = new Date().toISOString(),
  } = options;
  if (!runId) throw new Error('runId is required.');
  if (!item?.id) throw new Error('item is required.');
  const approvalId = options.approvalId || approvalIdForItem(item.id);
  const request = {
    schemaVersion: 'orpad.approvalRequest.v1',
    approvalId,
    runId,
    itemId: item.id,
    title: item.title || item.id,
    reason,
    requestedCapabilities,
    commandSpec,
    writeSetPaths,
    createdAt: now,
    status: 'requested',
  };
  const artifact = await registerArtifact(runRoot, {
    runId,
    artifactPath: `artifacts/approvals/${approvalId}.request.json`,
    content: `${JSON.stringify(request, null, 2)}\n`,
    producedBy: 'machine.approvals',
    registeredBy: 'machine',
    schemaVersion: request.schemaVersion,
  });
  const event = await appendMachineEvent(runRoot, {
    runId,
    actor: 'machine',
    eventType: 'approval.requested',
    itemId: item.id,
    reason,
    artifactRefs: [artifact.file.path],
    payload: {
      approvalId,
      requestedCapabilities,
      commandSpec,
      writeSetPaths,
    },
  });
  const runState = await appendRunLifecycleStatus(runRoot, {
    runId,
    toState: 'approval-required',
    reason,
    payload: { approvalId, itemId: item.id },
  });
  await appendRunSummaryStatus(runRoot, {
    runId,
    summaryStatus: 'blocked',
    reason,
    payload: { approvalId, itemId: item.id },
  });
  return {
    approvalId,
    request,
    artifact,
    event,
    runState: runState.runState,
  };
}

async function recordApprovalDecision(runRoot, options = {}) {
  const {
    runId,
    approvalId,
    decision,
    itemId = '',
    decidedBy = 'user',
    grants = [],
    reason = `approval.${decision}`,
    now = new Date().toISOString(),
  } = options;
  if (!runId) throw new Error('runId is required.');
  if (!approvalId) throw new Error('approvalId is required.');
  if (!['approved', 'denied'].includes(decision)) {
    throw new Error(`Unsupported approval decision: ${decision}`);
  }
  await assertRunLifecycleCanTransition(
    runRoot,
    decision === 'approved' ? 'waiting' : 'cancelled',
    reason,
  );
  const event = await appendMachineEvent(runRoot, {
    runId,
    actor: 'machine',
    eventType: 'approval.decided',
    itemId,
    reason,
    payload: {
      approvalId,
      decision,
      decidedBy,
      grants,
      decidedAt: now,
    },
  });
  const lifecycle = await appendRunLifecycleStatus(runRoot, {
    runId,
    toState: decision === 'approved' ? 'waiting' : 'cancelled',
    reason,
    payload: { approvalId, decision, itemId },
  });
  const summary = await appendRunSummaryStatus(runRoot, {
    runId,
    summaryStatus: decision === 'approved' ? 'partial' : 'blocked',
    reason,
    payload: { approvalId, decision, itemId },
  });
  return {
    event,
    runState: summary || lifecycle.runState,
    grants,
  };
}

function approvalGrantForItem(itemId, approvalId) {
  return {
    itemId,
    approvalId,
    approved: true,
  };
}

module.exports = {
  approvalGrantForItem,
  approvalIdForItem,
  recordApprovalDecision,
  requestApprovalForItem,
};
