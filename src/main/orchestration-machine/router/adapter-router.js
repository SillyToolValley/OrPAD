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
const {
  appendBudgetEntry,
  assertWithinBudget,
  nextEstimateFromUsage,
  readBudgetLedger,
} = require('./budget-ledger');
const {
  applyCacheHitToResult,
  buildCacheEntry,
  computeCacheKey,
  hashAllowedFiles,
  hashPrompt,
  readCacheEntry,
  shouldAttemptCacheLookup,
  writeCacheEntry,
} = require('./response-cache');

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
    runRoot = '',
    budgetConfig: explicitBudget,
    estimateNextCostUsd,
    cacheConfig: explicitCache,
    cachePrompt,
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
  const plugin = providerId ? getProviderPlugin(providerId) : null;
  if (!plugin) {
    const err = new Error(`Provider plugin "${providerId}" is not registered.`);
    err.code = 'MACHINE_PROVIDER_PLUGIN_MISSING';
    throw err;
  }

  const lifted = liftedPipelineAdapter(pipelineAdapter);
  const budgetConfig = explicitBudget || lifted?.budget || null;
  const cacheConfig = explicitCache || lifted?.cache || null;
  const ledger = runRoot ? await readBudgetLedger(runRoot) : null;

  // Cache lookup before any network/process work.
  let cacheKey = '';
  let cacheLookupOutcome = null;
  if (runRoot && cacheConfig && cacheConfig.mode && cacheConfig.mode !== 'off') {
    const lookup = shouldAttemptCacheLookup({
      mode: cacheConfig.mode,
      prompt: cachePrompt,
      idempotencyKey: request.idempotencyKey,
    });
    cacheLookupOutcome = lookup;
    if (lookup.eligible) {
      cacheKey = computeCacheKey({
        mode: cacheConfig.mode,
        providerId,
        model: candidate.selection.model,
        prompt: cachePrompt,
        allowedFiles: request.allowedFiles,
        taskKind: request.taskKind,
        outputContract: request.outputContract,
        qualityTier: candidate.selection.qualityTier || 'standard',
        idempotencyKey: request.idempotencyKey,
      });
      const existing = await readCacheEntry(runRoot, cacheKey);
      if (existing && existing.result) {
        const hitResult = applyCacheHitToResult(existing.result, cacheKey);
        const enriched = attachRoutingDecisionToResult(hitResult, candidate);
        if (typeof beforeAttempt === 'function') {
          await beforeAttempt({
            eventType: 'cache.hit',
            nodePath: request.nodePath,
            payload: {
              adapterCallId: request.adapterCallId,
              attemptId: request.attemptId,
              providerId,
              model: candidate.selection.model,
              cacheKey,
              cacheMode: cacheConfig.mode,
              recordedAt: existing.recordedAt,
            },
          });
        }
        if (runRoot) {
          await appendBudgetEntry(runRoot, {
            runId: request.runId,
            adapterCallId: request.adapterCallId,
            attemptId: request.attemptId,
            nodePath: request.nodePath,
            providerId,
            model: candidate.selection.model,
            family: candidate.selection.family,
            cacheHit: true,
            usage: enriched.usage,
            sourceEventSequence: Number.isFinite(input.sourceEventSequence) ? input.sourceEventSequence : null,
          });
        }
        return enriched;
      }
    }
  }
  let preCallEstimateUsd = 0;
  if (budgetConfig && ledger) {
    if (typeof estimateNextCostUsd === 'function') {
      preCallEstimateUsd = Number(await estimateNextCostUsd({ candidate, request })) || 0;
    } else if (typeof plugin.estimateCost === 'function') {
      preCallEstimateUsd = Number(plugin.estimateCost({
        model: candidate.selection.model,
        promptTokens: 0,
        completionTokens: 0,
      })) || 0;
    }
    const guard = assertWithinBudget(budgetConfig, ledger, preCallEstimateUsd);
    if (!guard.ok && typeof beforeAttempt === 'function') {
      await beforeAttempt({
        eventType: 'budget.warning',
        nodePath: request.nodePath,
        payload: {
          adapterCallId: request.adapterCallId,
          attemptId: request.attemptId,
          providerId,
          model: candidate.selection.model,
          violations: guard.violations,
          preCallEstimateUsd,
          phase: 'pre-call',
        },
      });
    }
  }

  let result;
  let dispatchError;
  try {
    result = await executeAttempt(candidate, request, { invoker, beforeAttempt, afterAttempt });
  } catch (err) {
    dispatchError = err;
  }
  if (runRoot && result?.usage) {
    await appendBudgetEntry(runRoot, {
      runId: request.runId,
      adapterCallId: request.adapterCallId,
      attemptId: request.attemptId,
      nodePath: request.nodePath,
      providerId,
      model: candidate.selection.model,
      family: candidate.selection.family,
      cacheHit: result.cacheHit === true,
      usage: result.usage,
      sourceEventSequence: Number.isFinite(input.sourceEventSequence) ? input.sourceEventSequence : null,
    });
  }
  if (runRoot && cacheConfig && cacheLookupOutcome?.eligible && cacheKey && result && !result.cacheHit) {
    const entry = buildCacheEntry({
      cacheKey,
      mode: cacheConfig.mode,
      ttlSeconds: Number.isFinite(cacheConfig.ttlSeconds) ? cacheConfig.ttlSeconds : 0,
      providerId,
      model: candidate.selection.model,
      promptHash: hashPrompt(cachePrompt),
      allowedFilesHash: hashAllowedFiles(request.allowedFiles),
      taskKind: request.taskKind,
      outputContract: request.outputContract,
      qualityTier: candidate.selection.qualityTier || 'standard',
      idempotencyKey: request.idempotencyKey,
      result,
    });
    await writeCacheEntry(runRoot, entry).catch(() => {});
  }
  if (runRoot && budgetConfig && result?.usage) {
    const observedNext = nextEstimateFromUsage(result.usage);
    const updatedLedger = await readBudgetLedger(runRoot);
    const postGuard = assertWithinBudget(budgetConfig, updatedLedger, 0);
    if (!postGuard.ok && typeof afterAttempt === 'function') {
      await afterAttempt({
        eventType: 'budget.warning',
        nodePath: request.nodePath,
        payload: {
          adapterCallId: request.adapterCallId,
          attemptId: request.attemptId,
          providerId,
          model: candidate.selection.model,
          violations: postGuard.violations,
          observedNextUsd: observedNext,
          phase: 'post-call',
        },
      });
    }
  }
  if (dispatchError) throw dispatchError;
  return result;
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
