const path = require('path');

const { assertRunRelativePath } = require('../artifacts');
const { SCHEMA_VERSIONS, createContractValidator } = require('../contracts');
const { appendMachineEvent, readMachineEvents } = require('../events');
const { assertMachineStorageId } = require('../ids');
const { classifyNonRunnableWork } = require('../non-runnable-work');
const { repairRunStateFromEvents } = require('../run-store');
const {
  assertQueueState,
  findQueueItem,
  ingestCandidateProposal,
  transitionAction,
  transitionQueueItem,
} = require('../queue-store');

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

function collectResultText(value, options = {}) {
  const {
    depth = 0,
    seen = new Set(),
    output = [],
  } = options;
  if (output.length >= 120 || depth > 6 || value == null) return output;
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }
  if (typeof value !== 'object') return output;
  if (seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectResultText(item, { depth: depth + 1, seen, output });
    return output;
  }
  for (const item of Object.values(value)) collectResultText(item, { depth: depth + 1, seen, output });
  return output;
}

const LOCAL_TOOL_UNAVAILABLE_RE = /\b(windows sandbox:\s*spawn setup refresh|sandbox spawn setup|spawn setup refresh|shell invocation failed|failed before command execution|failed before execution|terminal runner|filesystem reads failed before|could not read any source files|could not inspect local workspace|workspace inspection (?:was )?blocked)\b/i;

function proposalResultLooksLocalToolBlocked(result) {
  if (!result || result.status !== 'done') return false;
  if (candidateProposals(result).length || triageTransitions(result).length) return false;
  const text = collectResultText([
    result.summary,
    result.emptyPass,
    result.deferredReason,
    result.verification,
  ]).join('\n');
  return LOCAL_TOOL_UNAVAILABLE_RE.test(text);
}

function normalizeProposalRuntimeResult(result) {
  if (!proposalResultLooksLocalToolBlocked(result)) return result;
  return {
    ...result,
    status: 'blocked',
    summary: result.summary || 'Adapter could not inspect the local workspace.',
    deferredReason: result.deferredReason || 'adapter-local-tool-unavailable',
    infrastructureBlocked: true,
  };
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

function triageTransitionId(request, transition, toState = transition?.toState) {
  return `triage:${request.adapterCallId}:${transition.itemId}:${toState}`;
}

async function findTransitionEventById(runRoot, transitionId) {
  const events = await readMachineEvents(runRoot);
  return events.find(event => event.payload?.transitionId === transitionId) || null;
}

async function recordSkippedTriageTransition(runRoot, request, transition, current, options = {}) {
  const itemId = assertMachineStorageId(transition.itemId, 'itemId');
  const toState = assertQueueState(transition.toState);
  const transitionId = triageTransitionId(request, transition, toState);
  const duplicate = await findTransitionEventById(runRoot, transitionId);
  if (duplicate) {
    return {
      duplicate: true,
      skipped: true,
      event: duplicate,
      item: current?.item || null,
    };
  }
  const reason = options.reason || 'triage.transition-skipped';
  const currentState = current?.state || '';
  const event = await appendMachineEvent(runRoot, {
    runId: request.runId,
    actor: 'machine',
    eventType: 'queue.transition.skipped',
    itemId,
    fromState: currentState,
    toState,
    reason,
    artifactRefs: currentState ? [`queue/${currentState}/${itemId}.json`] : [],
    payload: {
      action: 'triage-skip',
      transitionId,
      adapterCallId: request.adapterCallId,
      taskKind: request.taskKind,
      requestedToState: toState,
      currentState,
      skipReason: reason,
      ...(options.payload || {}),
    },
  });
  return {
    skipped: true,
    event,
    item: current?.item || null,
  };
}

async function applyTriageTransition(runRoot, request, transition, options = {}) {
  const itemId = assertMachineStorageId(transition.itemId, 'itemId');
  const toState = assertQueueState(transition.toState);
  const transitionId = triageTransitionId(request, transition, toState);
  const duplicate = await findTransitionEventById(runRoot, transitionId);
  if (duplicate) {
    return {
      duplicate: true,
      skipped: duplicate.eventType === 'queue.transition.skipped',
      event: duplicate,
      item: (await findQueueItem(runRoot, itemId))?.item || null,
    };
  }

  const current = await findQueueItem(runRoot, itemId);
  if (!current) {
    return recordSkippedTriageTransition(runRoot, request, transition, null, {
      reason: 'triage.transition.item-not-found',
    });
  }

  const action = transitionAction(current.state, toState);
  if (!action) {
    return recordSkippedTriageTransition(runRoot, request, transition, current, {
      reason: current.state === 'rejected'
        ? 'triage.transition.terminal-rejected'
        : 'triage.transition.invalid-current-state',
      payload: {
        itemState: current.state,
      },
    });
  }

  return transitionQueueItem(runRoot, {
    runId: request.runId,
    itemId,
    toState,
    reason: transition.reason || 'triage.adapter-proposed-machine-owned',
    transitionId,
    now: options.now,
  });
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
  const normalizedResult = normalizeProposalRuntimeResult(validateAdapterResultForRequest(request, result));
  assertProposalOnlyResultPolicy(normalizedResult);

  const duplicate = await findAdapterResultEvent(runRoot, request.idempotencyKey);
  if (duplicate) {
    return duplicateAdapterResultResponse(runRoot, duplicate);
  }

  const proposals = [];
  const rejectedProposals = [];
  for (const proposal of candidateProposals(normalizedResult)) {
    const nonRunnable = classifyNonRunnableWork(proposal);
    const ingested = await ingestCandidateProposal(runRoot, proposal, {
      runId: request.runId,
      transitionId: `proposal:${request.adapterCallId}:${proposal.proposalId}`,
      now: options.now,
    });
    proposals.push(ingested);
    if (!ingested.duplicate && !ingested.deduped && nonRunnable) {
      rejectedProposals.push(await transitionQueueItem(runRoot, {
        runId: request.runId,
        itemId: ingested.item.id,
        expectedFromState: 'candidate',
        toState: 'rejected',
        reason: `candidate.${nonRunnable.classifier}`,
        transitionId: `reject-${nonRunnable.classifier}:${request.adapterCallId}:${ingested.item.id}`,
        now: options.now,
        itemPatch: {
          machineRejected: true,
          rejectionReason: nonRunnable.reason,
          ...(nonRunnable.classifier === 'oversized-worker-scope' ? {
            splitRequired: true,
            nextAction: 'split-work-item-before-dispatch',
          } : {}),
        },
        payload: {
          classifier: nonRunnable.classifier,
          proposalId: proposal.proposalId,
        },
      }));
    }
  }

  const triage = [];
  const skippedTriage = [];
  for (const transition of triageTransitions(normalizedResult)) {
    const result = await applyTriageTransition(runRoot, request, transition, options);
    if (result.skipped) skippedTriage.push(result);
    else triage.push(result);
  }

  const summaryStatus = summaryStatusForProposalResult(normalizedResult);
  const event = await appendMachineEvent(runRoot, {
    runId: request.runId,
    actor: 'machine',
    eventType: 'adapter.result',
    nodePath: request.nodePath,
    reason: proposalOnlyResultReason(normalizedResult.status),
    artifactRefs: normalizedResult.artifacts || [],
    payload: {
      adapter: request.adapter,
      adapterCallId: request.adapterCallId,
      attemptId: request.attemptId,
      idempotencyKey: request.idempotencyKey,
      taskKind: request.taskKind,
      status: normalizedResult.status,
      summaryStatus,
      proposalCount: proposals.length,
      rejectedProposalCount: rejectedProposals.length,
      triageTransitionCount: triage.length,
      skippedTriageTransitionCount: skippedTriage.length,
      ...(normalizedResult.deferredReason ? { deferredReason: normalizedResult.deferredReason } : {}),
      ...(normalizedResult.emptyPass ? { emptyPass: normalizedResult.emptyPass } : {}),
      ...(normalizedResult.infrastructureBlocked ? { infrastructureBlocked: true } : {}),
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
      adapterStatus: normalizedResult.status,
      adapterCallId: request.adapterCallId,
      proposalCount: proposals.length,
      rejectedProposalCount: rejectedProposals.length,
      triageTransitionCount: triage.length,
      skippedTriageTransitionCount: skippedTriage.length,
      message: normalizedResult.summary,
      ...(normalizedResult.deferredReason ? { deferredReason: normalizedResult.deferredReason } : {}),
      ...(normalizedResult.infrastructureBlocked ? { infrastructureBlocked: true } : {}),
    },
  });

  return {
    event,
    summaryStatus,
    proposals,
    rejectedProposals,
    triage,
    skippedTriage,
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
