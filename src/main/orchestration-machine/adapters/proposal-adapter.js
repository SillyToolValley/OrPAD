const path = require('path');

const { assertRunRelativePath } = require('../artifacts');
const { SCHEMA_VERSIONS, createContractValidator } = require('../contracts');
const { appendMachineEvent, readMachineEvents } = require('../events');
const { assertMachineStorageId } = require('../ids');
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
  const adapterCallId = assertMachineStorageId(options.adapterCallId || `${callStem}-call`, 'adapterCallId');
  const attemptId = assertMachineStorageId(options.attemptId || `${adapterCallId}-attempt-${attempt}`, 'attemptId');
  const safeInputArtifacts = inputArtifacts.map(item => assertRunRelativePath(item));
  const safeAdapterResultPath = assertRunRelativePath(
    adapterResultPath || path.posix.join('adapters', `${adapterCallId}.result.json`),
  );
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
    readOnlyFiles: options.readOnlyFiles || [],
    approvalGrants: options.approvalGrants || [],
    baselineWorkspaceDigest: options.baselineWorkspaceDigest || '',
    inputArtifacts: safeInputArtifacts,
    adapterResultPath: safeAdapterResultPath,
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

// Soft-fix the request-envelope identifier fields when the upstream
// adapter (LLM CLI) forgot to copy them through. Provider plugins
// already inject these from `request`, but a future plugin or a
// hand-written test harness might leave them blank. Filling them in
// here keeps validateAdapterResultForRequest's "exact match" check
// honest for the fields that ARE provided, while letting genuine
// mismatch (a stale or copied-from-other-call result) still error.
//
// We do NOT coerce user-facing fields (status, summary, proposals).
// Those reflect LLM intent and silently editing them would mask bugs.
function softFixAdapterResultEnvelope(request, result) {
  if (!result || typeof result !== 'object') return result;
  const fixed = { ...result };
  if (!fixed.schemaVersion) fixed.schemaVersion = SCHEMA_VERSIONS.adapterResult || 'orpad.workerResult.v1';
  for (const field of ['adapterCallId', 'attemptId', 'idempotencyKey']) {
    if (fixed[field] == null || fixed[field] === '') fixed[field] = request[field];
  }
  return fixed;
}

function validateAdapterResultForRequest(request, result) {
  const fixed = softFixAdapterResultEnvelope(request, result);
  try {
    validator.assertValid('adapterResult', fixed);
  } catch (err) {
    // Surface a typed error code so retry layers can decide to re-invoke
    // the adapter with the validation message as corrective context.
    if (!err.code) err.code = 'INVALID_ADAPTER_CONTRACT';
    err.contract = err.contract || { schemaVersion: SCHEMA_VERSIONS.adapterResult, errors: err.errors || null };
    throw err;
  }
  for (const field of ['adapterCallId', 'attemptId', 'idempotencyKey']) {
    if (fixed[field] !== request[field]) {
      const err = new Error(`Adapter result ${field} does not match the request.`);
      err.code = 'INVALID_ADAPTER_CONTRACT';
      err.contract = { field, expected: request[field], received: fixed[field] };
      throw err;
    }
  }
  return fixed;
}

function assertProposalOnlyResultPolicy(result) {
  const proposals = candidateProposals(result);
  const transitions = triageTransitions(result);
  if (proposals.length || transitions.length) return;
  // Any non-failure adapter result that produces zero proposals AND zero
  // triage transitions must justify the empty result. Without this, a
  // triage adapter that returns status='partial' or 'blocked' with no
  // work would silently leave the run with nothing to do and no audit
  // trail — the caller has no way to tell apart "the LLM saw nothing
  // actionable" from "the LLM produced garbage that the validator
  // stripped".
  //
  // Accepted justifications:
  //   - emptyPass.reason (non-empty) AND emptyPass.evidence.length > 0
  //     when status is 'done' (must prove the no-action conclusion)
  //   - emptyPass.reason OR deferredReason (non-empty) for non-done
  //     statuses (the run state itself encodes the block; reason just
  //     needs to be human-readable)
  // Failure statuses are exempt because they already carry their own
  // reason in the worker.result/adapter.result summary payload.
  if (result.status === 'done') {
    const evidence = result.emptyPass?.evidence || [];
    const reason = String(result.emptyPass?.reason || '').trim();
    if (!reason || evidence.length === 0) {
      const err = new Error('Proposal-only adapter empty-pass requires explicit reason and evidence when status=done.');
      err.code = 'PROPOSAL_EMPTY_PASS_UNPROVEN';
      err.status = result.status;
      throw err;
    }
    return;
  }
  if (['blocked', 'queued'].includes(result.status)) {
    const reason = String(result.emptyPass?.reason || result.deferredReason || '').trim();
    if (!reason) {
      const err = new Error('Proposal-only adapter empty result requires an emptyPass.reason or deferredReason.');
      err.code = 'PROPOSAL_EMPTY_PASS_UNPROVEN';
      err.status = result.status;
      throw err;
    }
  }
  // status 'failed', 'approval-required', 'rejected' carry their own
  // diagnostic in the worker.result/adapter.result summary; not gated here.
}

function summaryStatusForProposalResult(result) {
  if (['blocked', 'approval-required', 'failed', 'rejected'].includes(result.status)) return 'blocked';
  return 'partial';
}

function proposalOnlyResultReason(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'done') return 'proposal-only-result.accepted';
  if (normalized) return `proposal-only-result.${normalized}`;
  return 'proposal-only-result.unknown';
}

async function findAdapterResultEvent(runRoot, idempotencyKey) {
  const events = await readMachineEvents(runRoot);
  return events.find(event => event.eventType === 'adapter.result' && event.payload?.idempotencyKey === idempotencyKey) || null;
}

async function findAdapterRequestEvent(runRoot, idempotencyKey) {
  const events = await readMachineEvents(runRoot);
  return events.find(event => event.eventType === 'adapter.requested' && event.payload?.idempotencyKey === idempotencyKey) || null;
}

async function duplicateAdapterResultResponse(runRoot, event) {
  return {
    duplicate: true,
    event,
    summaryStatus: event.payload?.summaryStatus || 'partial',
    proposals: [],
    triage: [],
    runState: await repairRunStateFromEvents(runRoot),
  };
}

async function recordAdapterRequest(runRoot, request) {
  validator.assertValid('adapterRequest', request);
  const duplicate = await findAdapterRequestEvent(runRoot, request.idempotencyKey);
  if (duplicate) {
    return {
      duplicate: true,
      event: duplicate,
    };
  }
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
    return duplicateAdapterResultResponse(runRoot, duplicate);
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
    reason: proposalOnlyResultReason(result.status),
    artifactRefs: result.artifacts || [],
    payload: {
      adapter: request.adapter,
      adapterCallId: request.adapterCallId,
      attemptId: request.attemptId,
      idempotencyKey: request.idempotencyKey,
      taskKind: request.taskKind,
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
  const duplicate = await findAdapterResultEvent(runRoot, request.idempotencyKey);
  if (duplicate) return duplicateAdapterResultResponse(runRoot, duplicate);
  await recordAdapterRequest(runRoot, request);
  // Soft-retry on contract validation failure: an LLM that drops a
  // required field or returns a slightly wrong shape gets ONE more
  // chance, with the validation error fed back into the prompt as
  // corrective context. Retry is gated by `retryOnInvalidContract`
  // (default false) so existing fixture/harness paths keep their
  // strict semantics. Live providers turn this on through the
  // executeMachineRunStep call site.
  const maxAttempts = options.retryOnInvalidContract ? 2 : 1;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const adapterContext = {
      attempt,
      previousValidationError: lastErr ? {
        code: lastErr.code || 'INVALID_ADAPTER_CONTRACT',
        message: lastErr.message,
        contract: lastErr.contract || null,
      } : null,
    };
    const result = adapter?.invoke
      ? await adapter.invoke(request, adapterContext)
      : (typeof fixtureResult === 'function' ? await fixtureResult(request, adapterContext) : fixtureResult);
    if (!result) throw new Error('Proposal-only adapter did not return a result.');
    try {
      return await applyProposalAdapterResult(runRoot, request, result, options);
    } catch (err) {
      const code = String(err?.code || '');
      const isContractError = code === 'INVALID_ADAPTER_CONTRACT'
        || code === 'PROPOSAL_EMPTY_PASS_UNPROVEN';
      if (!isContractError || attempt >= maxAttempts) throw err;
      lastErr = err;
    }
  }
  // Unreachable: the loop either returns or throws.
  throw lastErr || new Error('Proposal-only adapter retry exhausted without resolution.');
}

module.exports = {
  applyProposalAdapterResult,
  createAdapterRequest,
  recordAdapterRequest,
  runProposalOnlyAdapter,
  softFixAdapterResultEnvelope,
  validateAdapterResultForRequest,
};
