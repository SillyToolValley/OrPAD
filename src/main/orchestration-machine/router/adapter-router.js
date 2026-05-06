// Adapter Router — picks a provider plugin for an adapter request based on the
// pipeline default + optional per-node override, then executes through the
// resolved plugin and stamps routing metadata onto request/result.
//
// PR M4 scope: deterministic per-node selection plus an error classifier with
// the standard codes the rest of the plan expects. Fallback chain (M7),
// budget gating (M5), and response cache (M6) layer on top of this module
// without changing its surface.

const { liftMachineAdapterV1ToV2 } = require('../contracts');
const {
  getProviderPlugin,
  resolveProviderIdFromAdapter,
} = require('../providers/registry');

const ERROR_CLASSES = Object.freeze([
  'KEY_MISSING',
  'RATE_LIMIT',
  'RETRYABLE',
  'OUTPUT_VIOLATES_CONTRACT',
  'BUDGET_EXCEEDED',
  'FATAL',
]);

const ERROR_CODE_TO_CLASS = Object.freeze({
  KEY_MISSING: 'KEY_MISSING',
  API_KEY_LOCAL_STORAGE_FORBIDDEN: 'KEY_MISSING',
  API_WEB_KEY_CONSENT_REQUIRED: 'KEY_MISSING',
  API_KEY_SOURCE_UNAPPROVED: 'KEY_MISSING',
  RATE_LIMIT: 'RATE_LIMIT',
  RETRYABLE: 'RETRYABLE',
  OUTPUT_VIOLATES_CONTRACT: 'OUTPUT_VIOLATES_CONTRACT',
  CONTRACT_VIOLATION: 'OUTPUT_VIOLATES_CONTRACT',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  FATAL: 'FATAL',
  API_ADAPTER_DISABLED: 'FATAL',
  API_TRACING_NOT_GRANTED: 'FATAL',
  API_TELEMETRY_EXPORT_NOT_GRANTED: 'FATAL',
  CLI_ADAPTER_DISABLED: 'FATAL',
  MACHINE_PROVIDER_PLUGIN_MISSING: 'FATAL',
  MACHINE_DANGEROUS_SANDBOX_BYPASS_NOT_APPROVED: 'FATAL',
  MACHINE_DANGEROUS_SANDBOX_BYPASS_OVERLAY_NOT_ISOLATED: 'FATAL',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function classifyAdapterError(error) {
  if (!error) return 'FATAL';
  if (typeof error.classification === 'string' && ERROR_CLASSES.includes(error.classification)) {
    return error.classification;
  }
  const code = String(error.code || '');
  if (ERROR_CODE_TO_CLASS[code]) return ERROR_CODE_TO_CLASS[code];
  if (code && ERROR_CLASSES.includes(code)) return code;
  // HTTP-style status fallback (e.g. plugins that store err.status)
  const status = Number(error.status);
  if (status === 401 || status === 403) return 'KEY_MISSING';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 408 || (status >= 500 && status <= 599)) return 'RETRYABLE';
  if (status === 400 || status === 422) return 'OUTPUT_VIOLATES_CONTRACT';
  return 'FATAL';
}

function liftedPipelineAdapter(pipelineAdapter) {
  if (!isPlainObject(pipelineAdapter)) return null;
  if (pipelineAdapter.schemaVersion === 'orpad.machineAdapter.v2') return pipelineAdapter;
  return liftMachineAdapterV1ToV2(pipelineAdapter);
}

function selectionFromV2Default(defaults = {}, overrides = {}) {
  const merged = {
    family: overrides.family || defaults.family,
    providerId: overrides.providerId || defaults.providerId,
    model: overrides.model || defaults.model,
    qualityTier: overrides.qualityTier || defaults.qualityTier || 'standard',
    sessionStrategy: overrides.sessionStrategy || defaults.sessionStrategy || 'none',
    toolPolicy: overrides.toolPolicy || defaults.toolPolicy || 'none',
    sandbox: overrides.sandbox !== undefined ? overrides.sandbox : (defaults.sandbox ?? null),
    approvalPolicy: overrides.approvalPolicy || defaults.approvalPolicy || 'never',
    timeoutMs: overrides.timeoutMs || defaults.timeoutMs || 600000,
    ephemeral: overrides.ephemeral !== undefined ? overrides.ephemeral : (defaults.ephemeral !== false),
  };
  if (defaults.legacy) merged.legacy = defaults.legacy;
  if (overrides.legacy) merged.legacy = overrides.legacy;
  return merged;
}

function decideAttempts({ pipelineAdapter, nodeAdapter = null, attempt = 0 } = {}) {
  const v2 = liftedPipelineAdapter(pipelineAdapter);
  if (!v2 || !isPlainObject(v2.default)) return [];

  const candidates = [];
  if (isPlainObject(nodeAdapter) && (nodeAdapter.providerId || nodeAdapter.model || nodeAdapter.family)) {
    candidates.push({
      selection: selectionFromV2Default(v2.default, nodeAdapter),
      chosenBy: 'node-override',
      attemptIndex: candidates.length,
    });
  }
  candidates.push({
    selection: selectionFromV2Default(v2.default),
    chosenBy: candidates.length === 0 ? 'pipeline' : 'pipeline',
    attemptIndex: candidates.length,
  });

  const fallback = Array.isArray(v2.fallback) ? v2.fallback : [];
  for (const entry of fallback) {
    candidates.push({
      selection: selectionFromV2Default(v2.default, entry),
      chosenBy: 'fallback',
      attemptIndex: candidates.length,
      fallbackOf: entry?.reason || `${entry?.providerId || ''}:${entry?.model || ''}`,
    });
  }
  if (!Number.isInteger(attempt) || attempt < 0) return candidates;
  return candidates.slice(attempt);
}

function buildRoutingEnvelope(candidate) {
  const envelope = {
    chosenBy: candidate.chosenBy,
    attemptIndex: candidate.attemptIndex,
  };
  if (candidate.fallbackOf) envelope.fallbackOf = candidate.fallbackOf;
  return envelope;
}

function buildProviderSelectionEnvelope(candidate) {
  const selection = candidate.selection || {};
  return {
    providerId: String(selection.providerId || ''),
    model: String(selection.model || ''),
    family: selection.family,
    qualityTier: selection.qualityTier || 'standard',
    sessionStrategy: selection.sessionStrategy || 'none',
    toolPolicy: selection.toolPolicy || 'none',
  };
}

function attachRoutingToRequest(request, candidate) {
  return {
    ...request,
    routing: buildRoutingEnvelope(candidate),
    providerSelection: buildProviderSelectionEnvelope(candidate),
  };
}

function attachRoutingDecisionToResult(result, candidate) {
  if (!isPlainObject(result)) return result;
  const selection = candidate.selection || {};
  return {
    ...result,
    routingDecision: {
      providerId: String(selection.providerId || ''),
      model: String(selection.model || ''),
      family: selection.family,
      fallbackChainConsumed: candidate.attemptIndex,
    },
  };
}

async function executeAttempt(candidate, request, deps = {}) {
  if (!isPlainObject(candidate) || !isPlainObject(candidate.selection)) {
    const err = new Error('executeAttempt requires a candidate with a provider selection.');
    err.code = 'ROUTING_INVALID_CANDIDATE';
    throw err;
  }
  const { invoker, beforeAttempt, afterAttempt } = deps;
  if (typeof invoker !== 'function') {
    const err = new Error('executeAttempt requires an invoker function.');
    err.code = 'ROUTING_INVOKER_MISSING';
    throw err;
  }
  const enrichedRequest = attachRoutingToRequest(request, candidate);
  const startedEvent = {
    eventType: 'adapter.attempt.started',
    nodePath: enrichedRequest.nodePath,
    payload: {
      adapterCallId: enrichedRequest.adapterCallId,
      attemptId: enrichedRequest.attemptId,
      providerId: enrichedRequest.providerSelection.providerId,
      model: enrichedRequest.providerSelection.model,
      family: enrichedRequest.providerSelection.family,
      chosenBy: enrichedRequest.routing.chosenBy,
      attemptIndex: enrichedRequest.routing.attemptIndex,
      ...(enrichedRequest.routing.fallbackOf ? { fallbackOf: enrichedRequest.routing.fallbackOf } : {}),
    },
  };
  if (typeof beforeAttempt === 'function') await beforeAttempt(startedEvent);

  let result;
  let invokeError;
  try {
    result = await invoker(enrichedRequest, candidate);
  } catch (err) {
    invokeError = err;
  }

  const finishedEvent = {
    eventType: 'adapter.attempt.finished',
    nodePath: enrichedRequest.nodePath,
    payload: {
      adapterCallId: enrichedRequest.adapterCallId,
      attemptId: enrichedRequest.attemptId,
      providerId: enrichedRequest.providerSelection.providerId,
      model: enrichedRequest.providerSelection.model,
      family: enrichedRequest.providerSelection.family,
      chosenBy: enrichedRequest.routing.chosenBy,
      attemptIndex: enrichedRequest.routing.attemptIndex,
      status: invokeError ? 'failed' : (result?.status || 'done'),
      classification: invokeError ? classifyAdapterError(invokeError) : 'OK',
    },
  };
  if (typeof afterAttempt === 'function') await afterAttempt(finishedEvent);

  if (invokeError) {
    invokeError.classification = classifyAdapterError(invokeError);
    invokeError.attempt = candidate;
    throw invokeError;
  }
  return attachRoutingDecisionToResult(result, candidate);
}

async function dispatchAdapter(input = {}) {
  const {
    pipelineAdapter,
    nodeAdapter = null,
    request,
    invoker,
    beforeAttempt,
    afterAttempt,
  } = input;
  if (!request) {
    const err = new Error('dispatchAdapter requires an adapter request.');
    err.code = 'ROUTING_REQUEST_MISSING';
    throw err;
  }
  const candidates = decideAttempts({ pipelineAdapter, nodeAdapter });
  if (!candidates.length) {
    const err = new Error('No adapter candidate available for the requested pipeline.');
    err.code = 'ROUTING_NO_CANDIDATE';
    throw err;
  }
  // M4 calls only the first candidate. Fallback iteration lands in PR M7.
  const candidate = candidates[0];
  const providerId = candidate.selection.providerId;
  if (!providerId || !getProviderPlugin(providerId)) {
    const err = new Error(`Provider plugin "${providerId}" is not registered.`);
    err.code = 'MACHINE_PROVIDER_PLUGIN_MISSING';
    throw err;
  }
  return executeAttempt(candidate, request, { invoker, beforeAttempt, afterAttempt });
}

module.exports = {
  ERROR_CLASSES,
  ERROR_CODE_TO_CLASS,
  attachRoutingDecisionToResult,
  attachRoutingToRequest,
  buildRoutingEnvelope,
  buildProviderSelectionEnvelope,
  classifyAdapterError,
  decideAttempts,
  dispatchAdapter,
  executeAttempt,
  liftedPipelineAdapter,
  resolveProviderIdFromAdapter,
  selectionFromV2Default,
};
