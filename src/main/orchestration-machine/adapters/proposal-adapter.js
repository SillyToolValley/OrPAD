const path = require('path');

const { SCHEMA_VERSIONS, createContractValidator } = require('../contracts');
const { appendMachineEvent, readMachineEvents } = require('../events');
const { repairRunStateFromEvents } = require('../run-store');
const { ingestCandidateProposal, transitionQueueItem } = require('../queue-store');

const validator = createContractValidator();

function idSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'adapter';
}

function createAdapterRequest(options = {}) {
  const {
    adapter = 'proposal-only-fixture',
    runId,
    nodePath,
    taskKind = 'probe',
    workspaceRoot = '',
    workspaceMode = 'read-only',
    inputArtifacts = [],
    outputContract = SCHEMA_VERSIONS.candidateProposal,
    adapterResultPath = '',
    attempt = 1,
  } = options;
  const callStem = `${idSegment(runId)}-${idSegment(nodePath)}-${idSegment(taskKind)}`;
  const adapterCallId = options.adapterCallId || `${callStem}-call`;
  const attemptId = options.attemptId || `${adapterCallId}-attempt-${attempt}`;
  const request = {
    schemaVersion: SCHEMA_VERSIONS.adapterRequest,
    adapter,
    runId,
    adapterCallId,
    attemptId,
    idempotencyKey: options.idempotencyKey || `${adapterCallId}:${attemptId}`,
    nodePath,
    taskKind,
    workspaceRoot,
    workspaceMode,
    allowedFiles: options.allowedFiles || [],
    approvalGrants: options.approvalGrants || [],
    baselineWorkspaceDigest: options.baselineWorkspaceDigest || '',
    inputArtifacts,
    adapterResultPath: adapterResultPath || path.posix.join('adapters', `${adapterCallId}.result.json`),
    outputContract,
  };
  validator.assertValid('adapterRequest', request);
  return request;
}

function candidateProposals(result) {
  return Array.isArray(result?.candidateProposals) ? result.candidateProposals : [];
}

function triageTransitions(result) {
  return Array.isArray(result?.triageTransitions) ? result.triageTransitions : [];
}

function validateAdapterResultForRequest(request, result) {
  validator.assertValid('adapterResult', result);
  for (const field of ['adapterCallId', 'attemptId', 'idempotencyKey']) {
    if (result[field] !== request[field]) {
      throw new Error(`Adapter result ${field} does not match the request.`);
    }
  }
  return result;
}

function assertProposalOnlyResultPolicy(result) {
  const proposals = candidateProposals(result);
  const transitions = triageTransitions(result);
  if (proposals.length || transitions.length) return;
  if (result.status === 'done') {
    const evidence = result.emptyPass?.evidence || [];
    const reason = String(result.emptyPass?.reason || '').trim();
    if (!reason || evidence.length === 0) {
      const err = new Error('Proposal-only adapter empty-pass requires explicit reason and evidence.');
      err.code = 'PROPOSAL_EMPTY_PASS_UNPROVEN';
      throw err;
    }
  }
}

function summaryStatusForProposalResult(result) {
  if (['blocked', 'approval-required', 'failed', 'rejected'].includes(result.status)) return 'blocked';
  return 'partial';
}

async function findAdapterResultEvent(runRoot, idempotencyKey) {
  const events = await readMachineEvents(runRoot);
  return events.find(event => event.eventType === 'adapter.result' && event.payload?.idempotencyKey === idempotencyKey) || null;
}

async function recordAdapterRequest(runRoot, request) {
  validator.assertValid('adapterRequest', request);
  return appendMachineEvent(runRoot, {
    runId: request.runId,
    actor: 'machine',
    eventType: 'adapter.requested',
    nodePath: request.nodePath,
    payload: {
      adapter: request.adapter,
      adapterCallId: request.adapterCallId,
      attemptId: request.attemptId,
      idempotencyKey: request.idempotencyKey,
      taskKind: request.taskKind,
      workspaceMode: request.workspaceMode,
      inputArtifacts: request.inputArtifacts || [],
      outputContract: request.outputContract,
      adapterResultPath: request.adapterResultPath,
    },
  });
}

async function applyProposalAdapterResult(runRoot, request, result, options = {}) {
  validateAdapterResultForRequest(request, result);
  assertProposalOnlyResultPolicy(result);

  const duplicate = await findAdapterResultEvent(runRoot, request.idempotencyKey);
  if (duplicate) {
    return {
      duplicate: true,
      event: duplicate,
      summaryStatus: duplicate.payload?.summaryStatus || 'partial',
      proposals: [],
      triage: [],
      runState: await repairRunStateFromEvents(runRoot),
    };
  }

  const proposals = [];
  for (const proposal of candidateProposals(result)) {
    proposals.push(await ingestCandidateProposal(runRoot, proposal, {
      runId: request.runId,
      transitionId: `proposal:${request.adapterCallId}:${proposal.proposalId}`,
      now: options.now,
    }));
  }

  const triage = [];
  for (const transition of triageTransitions(result)) {
    triage.push(await transitionQueueItem(runRoot, {
      runId: request.runId,
      itemId: transition.itemId,
      toState: transition.toState,
      reason: transition.reason || 'triage.adapter-proposed-machine-owned',
      transitionId: `triage:${request.adapterCallId}:${transition.itemId}:${transition.toState}`,
      now: options.now,
    }));
  }

  const summaryStatus = summaryStatusForProposalResult(result);
  const event = await appendMachineEvent(runRoot, {
    runId: request.runId,
    actor: 'machine',
    eventType: 'adapter.result',
    nodePath: request.nodePath,
    reason: 'proposal-only-result.accepted',
    artifactRefs: result.artifacts || [],
    payload: {
      adapter: request.adapter,
      adapterCallId: request.adapterCallId,
      attemptId: request.attemptId,
      idempotencyKey: request.idempotencyKey,
      status: result.status,
      summaryStatus,
      proposalCount: proposals.length,
      triageTransitionCount: triage.length,
    },
  });
  await appendMachineEvent(runRoot, {
    runId: request.runId,
    actor: 'machine',
    eventType: 'run.summary',
    nodePath: request.nodePath,
    reason: 'proposal-only-adapter-result',
    payload: {
      summaryStatus,
      adapterStatus: result.status,
      adapterCallId: request.adapterCallId,
      proposalCount: proposals.length,
      triageTransitionCount: triage.length,
      message: result.summary,
    },
  });

  return {
    event,
    summaryStatus,
    proposals,
    triage,
    runState: await repairRunStateFromEvents(runRoot),
  };
}

async function runProposalOnlyAdapter(options = {}) {
  const { runRoot, request, adapter, fixtureResult } = options;
  if (!runRoot) throw new Error('runRoot is required.');
  if (!request) throw new Error('adapter request is required.');
  await recordAdapterRequest(runRoot, request);
  const result = adapter?.invoke
    ? await adapter.invoke(request)
    : (typeof fixtureResult === 'function' ? await fixtureResult(request) : fixtureResult);
  if (!result) throw new Error('Proposal-only adapter did not return a result.');
  return applyProposalAdapterResult(runRoot, request, result, options);
}

module.exports = {
  applyProposalAdapterResult,
  createAdapterRequest,
  recordAdapterRequest,
  runProposalOnlyAdapter,
  validateAdapterResultForRequest,
};
