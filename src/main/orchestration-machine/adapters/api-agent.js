const { validateAdapterResultForRequest } = require('./proposal-adapter');
const {
  assertProviderKeySourceAllowed,
  assertTelemetryPolicy,
  createApiSessionEnvelope,
  createNonAuthoritativeTraceRecord,
  normalizeProviderSelection,
} = require('../providers/policy');
const { getProviderPlugin } = require('../providers/registry');

function buildPluginProviderClient(plugin, options) {
  if (!plugin || typeof plugin.invokeApi !== 'function') return null;
  return {
    async invoke(invokeContext) {
      const signal = invokeContext.signal || options.signal;
      try {
        if (isAbortSignalAborted(signal)) throw createApiCancellationError(signal);
        return await plugin.invokeApi({
          ...invokeContext,
          providerKey: options.providerKey,
          fetchImpl: options.fetchImpl,
          signal,
          onUsage: options.onUsage,
          instructions: options.instructions,
          maxTokens: options.maxTokens,
        });
      } catch (err) {
        throw normalizeApiCancellationError(err, signal);
      }
    },
  };
}

function requestSignal(request, options) {
  return request?.signal || request?.abortSignal || options.signal || null;
}

function isAbortSignalAborted(signal) {
  return Boolean(signal && typeof signal === 'object' && signal.aborted === true);
}

function isAbortLikeError(err) {
  let current = err;
  let depth = 0;
  while (current && depth < 5) {
    const code = String(current.code || '');
    const name = String(current.name || '');
    if (code === 'ABORT_ERR' || code === 'AbortError' || name === 'AbortError') return true;
    current = current.cause;
    depth += 1;
  }
  return false;
}

function createApiCancellationError(signal, cause = null) {
  const err = new Error('API provider request was cancelled before completion.');
  err.code = 'MACHINE_RUN_CANCELLED';
  err.classification = 'CANCELLED';
  err.cancelled = true;
  err.retryable = false;
  err.fallbackAllowed = false;
  err.selfRepairAllowed = false;
  err.terminal = true;
  if (cause) err.cause = cause;
  if (signal?.reason) err.abortReason = String(signal.reason?.message || signal.reason).slice(0, 500);
  return err;
}

function normalizeApiCancellationError(err, signal) {
  if (isAbortSignalAborted(signal) || isAbortLikeError(err)) {
    return createApiCancellationError(signal, err);
  }
  return err;
}

function buildApiAdapterPrompt(input = {}) {
  const { request, instructions = '', contextArtifacts = [] } = input;
  if (!request) throw new Error('adapter request is required.');
  return {
    schemaVersion: 'orpad.apiAdapterPrompt.v1',
    adapterCallId: request.adapterCallId,
    attemptId: request.attemptId,
    taskKind: request.taskKind,
    nodePath: request.nodePath,
    workspaceMode: request.workspaceMode,
    allowedFiles: request.allowedFiles || [],
    inputArtifacts: request.inputArtifacts || [],
    contextArtifacts,
    outputContract: request.outputContract,
    instructions,
  };
}

function parseStructuredAdapterResult(response, request) {
  const payload = typeof response === 'string' ? JSON.parse(response) : response;
  const result = payload?.result || payload;
  validateAdapterResultForRequest(request, result);
  return result;
}

function createApiAgentAdapter(options = {}) {
  return {
    adapter: 'api-agent-skeleton',
    async invoke(request) {
      if (!options.enabled) {
        const err = new Error('API adapter execution is disabled.');
        err.code = 'API_ADAPTER_DISABLED';
        throw err;
      }
      const selection = normalizeProviderSelection(options.selection || request.providerSelection || {});
      const keyAccess = assertProviderKeySourceAllowed(options.keyAccess || {
        runtime: 'desktop',
        keySource: 'safeStorage',
      });
      const telemetry = assertTelemetryPolicy(
        options.requestedCapabilities || request.requestedCapabilities || [],
        options.capabilityGrants || request.capabilityGrants || [],
      );
      const session = createApiSessionEnvelope({
        selection,
        adapterCallId: request.adapterCallId,
        ...options.session,
      });
      const signal = requestSignal(request, options);
      if (isAbortSignalAborted(signal)) throw createApiCancellationError(signal);
      const prompt = buildApiAdapterPrompt({
        request,
        instructions: options.instructions || '',
        contextArtifacts: options.contextArtifacts || [],
      });

      let providerClient = options.providerClient || null;
      if (!providerClient && options.useRegistry !== false) {
        const plugin = getProviderPlugin(selection.providerId);
        providerClient = buildPluginProviderClient(plugin, options);
      }

      let rawResponse;
      try {
        rawResponse = providerClient?.invoke
          ? await providerClient.invoke({ request, prompt, selection, telemetry, session, keyAccess, signal })
          : (typeof options.fixtureResponse === 'function'
            ? await options.fixtureResponse({ request, prompt, selection, telemetry, session, keyAccess, signal })
            : options.fixtureResponse);
      } catch (err) {
        throw normalizeApiCancellationError(err, signal);
      }
      if (!rawResponse) throw new Error('API adapter did not return a structured response.');

      const result = parseStructuredAdapterResult(rawResponse, request);
      const traceId = rawResponse?.traceId || rawResponse?.metadata?.traceId || options.traceId || '';
      if (traceId && telemetry.tracingEnabled) {
        result.apiTrace = createNonAuthoritativeTraceRecord({
          providerId: selection.providerId,
          model: selection.model,
          adapterCallId: request.adapterCallId,
          traceId,
          exported: telemetry.telemetryExportEnabled,
        });
      }
      if (rawResponse.usage) {
        const promptTokens = Number(rawResponse.usage.promptTokens || 0);
        const completionTokens = Number(rawResponse.usage.completionTokens || 0);
        const totalTokens = Number(
          rawResponse.usage.totalTokens != null
            ? rawResponse.usage.totalTokens
            : promptTokens + completionTokens,
        );
        const usage = {
          promptTokens,
          completionTokens,
          totalTokens,
          currency: 'USD',
        };
        const plugin = getProviderPlugin(selection.providerId);
        if (plugin && typeof plugin.estimateCost === 'function') {
          usage.costEstimateUsd = plugin.estimateCost({
            model: selection.model,
            promptTokens,
            completionTokens,
            expectedCompletionTokens: completionTokens,
          });
        }
        result.usage = usage;
      }
      result.apiSession = session;
      return result;
    },
  };
}

module.exports = {
  buildApiAdapterPrompt,
  createApiAgentAdapter,
  parseStructuredAdapterResult,
};
