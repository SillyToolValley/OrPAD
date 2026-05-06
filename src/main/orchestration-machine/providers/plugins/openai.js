// OpenAI provider plugin — metadata stub.
//
// PR M7 registers openai so the fallback router can land on it through
// `pipeline.run.machineAdapter.fallback`. The full Chat Completions
// invokeApi implementation is intentionally deferred (mirrors the anthropic
// plugin from PR M3 once the OpenAI request shape is exercised end-to-end).
// Any caller that hits this plugin without supplying a `providerClient`
// override sees a clear OPENAI_INVOKE_NOT_IMPLEMENTED error so the gap is
// loud rather than silent.

const { getProviderEntry } = require('../../../../shared/ai/provider-catalog');

const CATALOG_ENTRY = getProviderEntry('openai');

function modelRates(modelId) {
  const entry = CATALOG_ENTRY || getProviderEntry('openai');
  const modelEntry = entry?.models.find(model => model.id === modelId);
  const inRate = modelEntry?.costPerMTokensIn ?? entry?.costs?.input ?? 0;
  const outRate = modelEntry?.costPerMTokensOut ?? entry?.costs?.output ?? 0;
  return { inRate, outRate };
}

function parseUsage(rawResponse) {
  const usage = rawResponse?.usage || {};
  const promptTokens = Number(usage.prompt_tokens || usage.promptTokens || 0);
  const completionTokens = Number(usage.completion_tokens || usage.completionTokens || 0);
  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    totalTokens: (Number.isFinite(promptTokens) ? promptTokens : 0)
      + (Number.isFinite(completionTokens) ? completionTokens : 0),
  };
}

function estimateCost(input = {}) {
  const promptTokens = Number(input.promptTokens) || 0;
  const completionTokens = Number(
    input.completionTokens != null ? input.completionTokens : input.expectedCompletionTokens,
  ) || 0;
  const { inRate, outRate } = modelRates(String(input.model || ''));
  const promptCost = (promptTokens / 1_000_000) * inRate;
  const completionCost = (completionTokens / 1_000_000) * outRate;
  return Number((promptCost + completionCost).toFixed(8));
}

async function invokeApi() {
  const err = new Error('OpenAI provider plugin invokeApi is not implemented yet.');
  err.code = 'OPENAI_INVOKE_NOT_IMPLEMENTED';
  err.classification = 'FATAL';
  throw err;
}

module.exports = {
  id: CATALOG_ENTRY?.id || 'openai',
  displayName: CATALOG_ENTRY?.displayName || 'OpenAI',
  family: CATALOG_ENTRY?.family || 'api',
  needsKey: CATALOG_ENTRY ? Boolean(CATALOG_ENTRY.needsKey) : true,
  implementationStatus: CATALOG_ENTRY?.implementationStatus || 'stub',
  statusNote: CATALOG_ENTRY?.statusNote || '',
  capabilities: Object.freeze({
    sessionStrategies: ['none'],
    toolPolicies: ['none'],
    streaming: false,
    structuredOutput: 'json-mode',
    sandbox: null,
  }),
  models: CATALOG_ENTRY?.models || Object.freeze([]),
  defaultModel: CATALOG_ENTRY?.defaultModel || '',
  dangerousArgs: Object.freeze([]),
  invokeApi,
  parseUsage,
  estimateCost,
};
