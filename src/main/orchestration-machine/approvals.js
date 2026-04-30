const { registerArtifact } = require('./artifacts');
const { appendMachineEvent, readMachineEvents } = require('./events');
const {
  appendRunLifecycleStatus,
  appendRunSummaryStatus,
  assertRunLifecycleCanTransition,
} = require('./lifecycle');
const { readRunState } = require('./run-store');

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
  const events = await readMachineEvents(runRoot);
  const existingApproval = summarizeApprovalsFromEvents(events)
    .all
    .find(approval => approval.approvalId === approvalId);
  if (existingApproval?.status === 'requested') {
    return {
      approvalId,
      request: null,
      artifact: null,
      event: events.find(event => (
        event.eventType === 'approval.requested'
        && event.payload?.approvalId === approvalId
      )) || null,
      runState: await readRunState(runRoot),
      duplicate: true,
    };
  }
  if (existingApproval) {
    const err = new Error(`Approval has already been decided: ${approvalId}`);
    err.code = 'MACHINE_APPROVAL_ALREADY_DECIDED';
    err.approvalId = approvalId;
    err.status = existingApproval.status;
    throw err;
  }
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
  const approval = summarizeApprovalsFromEvents(await readMachineEvents(runRoot))
    .all
    .find(item => item.approvalId === approvalId);
  if (!approval) {
    const err = new Error(`Approval request not found: ${approvalId}`);
    err.code = 'MACHINE_APPROVAL_NOT_REQUESTED';
    err.approvalId = approvalId;
    throw err;
  }
  if (approval.status !== 'requested') {
    const err = new Error(`Approval has already been decided: ${approvalId}`);
    err.code = 'MACHINE_APPROVAL_ALREADY_DECIDED';
    err.approvalId = approvalId;
    err.status = approval.status;
    throw err;
  }
  if (approval.itemId && itemId && approval.itemId !== itemId) {
    const err = new Error(`Approval decision item mismatch: ${approvalId}`);
    err.code = 'MACHINE_APPROVAL_ITEM_MISMATCH';
    err.approvalId = approvalId;
    err.expectedItemId = approval.itemId;
    err.actualItemId = itemId;
    throw err;
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

function summarizeApprovalsFromEvents(events = []) {
  const approvalsById = new Map();
  for (const event of events || []) {
    const payload = event.payload || {};
    const approvalId = payload.approvalId || '';
    if (!approvalId) continue;
    if (event.eventType === 'approval.requested') {
      approvalsById.set(approvalId, {
        approvalId,
        runId: event.runId || '',
        itemId: event.itemId || payload.itemId || '',
        status: 'requested',
        reason: event.reason || '',
        requestedAt: event.timestamp || '',
        requestedSequence: event.sequence,
        artifactRefs: event.artifactRefs || [],
        requestedCapabilities: payload.requestedCapabilities || [],
        commandSpec: payload.commandSpec || null,
        writeSetPaths: payload.writeSetPaths || [],
      });
    } else if (event.eventType === 'approval.decided') {
      const existing = approvalsById.get(approvalId) || {
        approvalId,
        runId: event.runId || '',
        itemId: event.itemId || payload.itemId || '',
        artifactRefs: [],
        requestedCapabilities: [],
        commandSpec: null,
        writeSetPaths: [],
      };
      approvalsById.set(approvalId, {
        ...existing,
        status: payload.decision || 'decided',
        decision: payload.decision || '',
        decidedAt: payload.decidedAt || event.timestamp || '',
        decidedBy: payload.decidedBy || '',
        decisionSequence: event.sequence,
        grants: payload.grants || [],
      });
    }
  }
  const all = [...approvalsById.values()]
    .sort((a, b) => (a.requestedSequence ?? Number.MAX_SAFE_INTEGER) - (b.requestedSequence ?? Number.MAX_SAFE_INTEGER));
  const pending = all.filter(item => item.status === 'requested');
  return {
    all,
    pending,
    pendingCount: pending.length,
  };
}

module.exports = {
  approvalGrantForItem,
  approvalIdForItem,
  recordApprovalDecision,
  requestApprovalForItem,
  summarizeApprovalsFromEvents,
};
