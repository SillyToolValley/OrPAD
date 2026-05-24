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
  sweepRunCacheOnce,
  writeCacheEntry,
} = require('./response-cache');

const ERROR_CLASSES = Object.freeze([
  'KEY_MISSING',
  'RATE_LIMIT',
  'RETRYABLE',
  'OUTPUT_VIOLATES_CONTRACT',
  'BUDGET_EXCEEDED',
  'CANCELLED',
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
  MACHINE_RUN_CANCELLED: 'CANCELLED',
  CANCELLED: 'CANCELLED',
  ABORT_ERR: 'CANCELLED',
  AbortError: 'CANCELLED',
  FATAL: 'FATAL',
  API_ADAPTER_DISABLED: 'FATAL',
  API_TRACING_NOT_GRANTED: 'FATAL',
  API_TELEMETRY_EXPORT_NOT_GRANTED: 'FATAL',
  CLI_ADAPTER_DISABLED: 'FATAL',
  MACHINE_PROVIDER_PLUGIN_MISSING: 'FATAL',
  MACHINE_API_PLUGIN_STUB: 'FATAL',
  OPENAI_INVOKE_NOT_IMPLEMENTED: 'FATAL',
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
  if (String(error.name || '') === 'AbortError') return 'CANCELLED';
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

function candidateProviderId(candidate) {
  return String(candidate?.selection?.providerId || '');
}

function isStubProviderPlugin(plugin) {
  return String(plugin?.implementationStatus || '').toLowerCase() === 'stub';
}

function createMissingProviderError(providerId) {
  const err = new Error(`Provider plugin "${providerId}" is not registered.`);
  err.code = 'MACHINE_PROVIDER_PLUGIN_MISSING';
  return err;
}

function createStubProviderError(plugin, candidate) {
  const providerId = candidateProviderId(candidate) || String(plugin?.id || '');
  const err = new Error(
    `Provider plugin "${providerId}" is registered but not runnable (implementationStatus: stub). `
      + 'Configure a runnable provider or remove it from the adapter fallback chain.',
  );
  err.code = 'MACHINE_API_PLUGIN_STUB';
  err.classification = 'FATAL';
  err.providerId = providerId;
  err.implementationStatus = 'stub';
  err.statusNote = String(plugin?.statusNote || '');
  err.nextAction = 'Configure a provider with implementationStatus other than stub, or remove this provider from the fallback chain.';
  err.attempt = candidate;
  return err;
}

function buildStubProviderSkipPayload({
  request,
  candidate,
  plugin,
  fromProviderId = '',
  classification = '',
  triggerReason = '',
} = {}) {
  const selection = candidate?.selection || {};
  return {
    adapterCallId: request?.adapterCallId,
    attemptId: request?.attemptId,
    providerId: candidateProviderId(candidate),
    model: String(selection.model || ''),
    family: selection.family,
    chosenBy: candidate?.chosenBy,
    attemptIndex: candidate?.attemptIndex,
    fromProviderId,
    classification,
    triggerReason,
    implementationStatus: 'stub',
    statusNote: String(plugin?.statusNote || ''),
    reason: 'provider-implementation-status-stub',
    nextAction: 'Configure a runnable provider or remove this stub provider from the fallback chain.',
  };
}

async function emitStubProviderSkipped({
  request,
  beforeAttempt,
  candidate,
  plugin,
  fromProviderId = '',
  classification = '',
  triggerReason = '',
} = {}) {
  const payload = buildStubProviderSkipPayload({
    request,
    candidate,
    plugin,
    fromProviderId,
    classification,
    triggerReason,
  });
  if (typeof beforeAttempt === 'function') {
    await beforeAttempt({
      eventType: 'adapter.attempt.skipped',
      nodePath: request?.nodePath,
      payload,
    });
  }
  return payload;
}

async function resolveRunnableFallbackCandidate({
  allCandidates,
  startIndex,
  request,
  beforeAttempt,
  fromProviderId = '',
  classification = '',
  triggerReason = '',
} = {}) {
  const skippedProviders = [];
  let lastStub = null;
  for (let idx = startIndex; idx < allCandidates.length; idx += 1) {
    const nextCandidate = allCandidates[idx];
    const nextProviderId = candidateProviderId(nextCandidate);
    const nextPlugin = nextProviderId ? getProviderPlugin(nextProviderId) : null;
    if (!nextPlugin) {
      return {
        targetIdx: idx,
        candidate: nextCandidate,
        plugin: null,
        skippedProviders,
        error: createMissingProviderError(nextProviderId),
      };
    }
    if (isStubProviderPlugin(nextPlugin)) {
      lastStub = { candidate: nextCandidate, plugin: nextPlugin };
      const skipped = await emitStubProviderSkipped({
        request,
        beforeAttempt,
        candidate: nextCandidate,
        plugin: nextPlugin,
        fromProviderId,
        classification,
        triggerReason,
      });
      skippedProviders.push(skipped);
      continue;
    }
    return {
      targetIdx: idx,
      candidate: nextCandidate,
      plugin: nextPlugin,
      skippedProviders,
      error: null,
    };
  }
  return {
    targetIdx: -1,
    candidate: null,
    plugin: null,
    skippedProviders,
    error: lastStub ? createStubProviderError(lastStub.plugin, lastStub.candidate) : null,
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
    retryBudget,
    onFallback,
    onRetry,
    onSelfRepair,
  } = input;
  if (!request) {
    const err = new Error('dispatchAdapter requires an adapter request.');
    err.code = 'ROUTING_REQUEST_MISSING';
    throw err;
  }
  const allCandidates = decideAttempts({ pipelineAdapter, nodeAdapter });
  if (!allCandidates.length) {
    const err = new Error('No adapter candidate available for the requested pipeline.');
    err.code = 'ROUTING_NO_CANDIDATE';
    throw err;
  }
  // Fallback chain support (M7): the dispatcher walks candidates from the
  // head of the list and consults the error classifier between attempts.
  let candidateIndex = 0;
  let candidate = allCandidates[candidateIndex];
  let providerId = candidateProviderId(candidate);
  let plugin = providerId ? getProviderPlugin(providerId) : null;
  if (!plugin) {
    throw createMissingProviderError(providerId);
  }
  if (isStubProviderPlugin(plugin)) {
    throw createStubProviderError(plugin, candidate);
  }

  const lifted = liftedPipelineAdapter(pipelineAdapter);
  const budgetConfig = explicitBudget || lifted?.budget || null;
  const cacheConfig = explicitCache || lifted?.cache || null;
  const ledger = runRoot ? await readBudgetLedger(runRoot) : null;

  // Cache lookup before any network/process work. Sweep expired entries once
  // per run root so a long-lived run doesn't pile up stale rows.
  let cacheKey = '';
  let cacheLookupOutcome = null;
  if (runRoot && cacheConfig && cacheConfig.mode && cacheConfig.mode !== 'off') {
    await sweepRunCacheOnce(runRoot).catch(() => {});
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

  // Lazy import to avoid circular dependency through index-level spreads.
  const { decideActionForError, DEFAULT_RETRY_BUDGET } = require('./error-classifier');
  const effectiveRetryBudget = { ...DEFAULT_RETRY_BUDGET, ...(retryBudget || {}) };

  // Re-check budget before *each* fallback / retry attempt so a long fallback
  // chain cannot overrun perRunUsd. Returns true if the loop should continue,
  // false if the dispatcher should halt with the captured BUDGET_EXCEEDED.
  async function reassertBudgetBeforeNextAttempt(currentPlugin) {
    if (!runRoot || !budgetConfig) return true;
    const updatedLedger = await readBudgetLedger(runRoot);
    let nextEstimate = 0;
    if (typeof estimateNextCostUsd === 'function') {
      nextEstimate = Number(await estimateNextCostUsd({ candidate, request })) || 0;
    } else if (typeof currentPlugin?.estimateCost === 'function') {
      nextEstimate = Number(currentPlugin.estimateCost({
        model: candidate.selection.model,
        promptTokens: 0,
        completionTokens: 0,
      })) || 0;
    }
    try {
      assertWithinBudget(budgetConfig, updatedLedger, nextEstimate);
      return true;
    } catch (err) {
      // assertWithinBudget throws BUDGET_EXCEEDED only when hardStop:true.
      if (err?.code !== 'BUDGET_EXCEEDED') throw err;
      err.classification = 'BUDGET_EXCEEDED';
      dispatchError = err;
      return false;
    }
  }

  let result;
  let dispatchError;
  let sameCandidateAttempts = 0;
  let selfRepairAttempts = 0;
  while (true) {
    sameCandidateAttempts += 1;
    try {
      result = await executeAttempt(candidate, request, { invoker, beforeAttempt, afterAttempt });
      dispatchError = undefined;
      break;
    } catch (err) {
      dispatchError = err;
    }
    const remaining = allCandidates.slice(candidateIndex + 1);
    const decision = decideActionForError({
      error: dispatchError,
      candidate,
      remainingCandidates: remaining,
      attemptCounters: { sameCandidateAttempts, selfRepairAttempts },
      retryBudget: effectiveRetryBudget,
    });
    if (decision.action === 'fail') {
      break;
    }
    if (decision.action === 'retry') {
      if (typeof onRetry === 'function') {
        await onRetry({
          eventType: 'adapter.attempt.retry',
          nodePath: request.nodePath,
          payload: {
            adapterCallId: request.adapterCallId,
            attemptId: request.attemptId,
            providerId,
            classification: decision.classification,
            sameCandidateAttempts,
          },
        });
      }
      const backoff = Number(effectiveRetryBudget.backoffMs) || 0;
      if (backoff > 0) await new Promise(resolve => setTimeout(resolve, backoff));
      if (!(await reassertBudgetBeforeNextAttempt(plugin))) break;
      continue;
    }
    if (decision.action === 'self-repair') {
      selfRepairAttempts += 1;
      sameCandidateAttempts = 0; // self-repair is a fresh attempt-counter cycle
      if (typeof onSelfRepair === 'function') {
        await onSelfRepair({
          eventType: 'adapter.attempt.self-repair',
          nodePath: request.nodePath,
          payload: {
            adapterCallId: request.adapterCallId,
            attemptId: request.attemptId,
            providerId,
            classification: decision.classification,
          },
        });
      }
      if (!(await reassertBudgetBeforeNextAttempt(plugin))) break;
      continue;
    }
    if (decision.action === 'fallback') {
      const requestedTargetIdx = decision.target
        ? allCandidates.indexOf(decision.target, candidateIndex + 1)
        : candidateIndex + 1;
      if (requestedTargetIdx < 0 || requestedTargetIdx >= allCandidates.length) {
        break; // no remaining candidate
      }
      const resolvedFallback = await resolveRunnableFallbackCandidate({
        allCandidates,
        startIndex: requestedTargetIdx,
        request,
        beforeAttempt,
        fromProviderId: providerId,
        classification: decision.classification,
        triggerReason: decision.reason,
      });
      if (resolvedFallback.error) {
        dispatchError = resolvedFallback.error;
        break;
      }
      const targetIdx = resolvedFallback.targetIdx;
      if (typeof onFallback === 'function') {
        await onFallback({
          eventType: 'adapter.attempt.fallback',
          nodePath: request.nodePath,
          payload: {
            adapterCallId: request.adapterCallId,
            attemptId: request.attemptId,
            fromProviderId: providerId,
            requestedProviderId: candidateProviderId(allCandidates[requestedTargetIdx]),
            toProviderId: candidateProviderId(resolvedFallback.candidate),
            classification: decision.classification,
            reason: decision.reason,
            consumed: targetIdx,
            skippedProviderIds: resolvedFallback.skippedProviders.map(item => item.providerId),
            skippedProviders: resolvedFallback.skippedProviders,
          },
        });
      }
      candidateIndex = targetIdx;
      candidate = resolvedFallback.candidate;
      providerId = candidateProviderId(candidate);
      plugin = resolvedFallback.plugin;
      sameCandidateAttempts = 0;
      selfRepairAttempts = 0;
      if (!(await reassertBudgetBeforeNextAttempt(plugin))) break;
      continue;
    }
    break;
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
