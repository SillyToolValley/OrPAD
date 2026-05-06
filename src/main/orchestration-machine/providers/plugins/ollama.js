// Ollama provider plugin — metadata stub for the fallback router.
//
// Local Ollama runs cost zero and require no API key. Registering the plugin
// in M7 lets KEY_MISSING fallbacks land on a keyless successor when the
// pipeline declares ollama in the fallback chain. The HTTP invokeApi against
// http://localhost:11434 lands in a later PR.

const { getProviderEntry } = require('../../../../shared/ai/provider-catalog');

const CATALOG_ENTRY = getProviderEntry('ollama');

function parseUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function estimateCost() {
  return 0;
}

async function invokeApi() {
  const err = new Error('Ollama provider plugin invokeApi is not implemented yet.');
  err.code = 'OLLAMA_INVOKE_NOT_IMPLEMENTED';
  err.classification = 'FATAL';
  throw err;
}

module.exports = {
  id: CATALOG_ENTRY?.id || 'ollama',
  displayName: CATALOG_ENTRY?.displayName || 'Ollama (local)',
  family: CATALOG_ENTRY?.family || 'api',
  needsKey: CATALOG_ENTRY ? Boolean(CATALOG_ENTRY.needsKey) : false,
  capabilities: Object.freeze({
    sessionStrategies: ['none'],
    toolPolicies: ['none'],
    streaming: false,
    structuredOutput: 'free-text',
    sandbox: null,
  }),
  models: CATALOG_ENTRY?.models || Object.freeze([]),
  defaultModel: CATALOG_ENTRY?.defaultModel || 'llama3',
  dangerousArgs: Object.freeze([]),
  invokeApi,
  parseUsage,
  estimateCost,
};
