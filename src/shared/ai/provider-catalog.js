// Shared OrPAD provider catalog.
//
// This module is metadata-only. It intentionally has no I/O, no network,
// no SDK dependencies, and no ciphertext or raw API keys. Both the renderer
// AI sidebar (`src/renderer/ai/providers/*`) and the Machine adapter
// registry (`src/main/orchestration-machine/providers/*`) reference these
// entries so display names, model lists, default models, cost rates, and
// keyless markers stay consistent.
//
// Renderer streaming chat and Machine structured-result adapters keep
// independent execution layers; only this catalog is shared.

// Implementation status flags drive the picker UX:
//   ready   — invoke path is fully implemented in this PR cycle
//   stub    — plugin is registered but invokeApi/invokeCli throws NOT_IMPLEMENTED
//   host    — plugin is keyless / endpoint-supplied; ready when host is reachable
const PROVIDER_CATALOG = Object.freeze({
  openai: Object.freeze({
    id: 'openai',
    displayName: 'OpenAI',
    family: 'api',
    needsKey: true,
    configurableEndpoint: false,
    defaultEndpoint: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    implementationStatus: 'stub',
    statusNote: 'Chat Completions invokeApi 미구현 — 다음 PR.',
    models: Object.freeze([
      Object.freeze({ id: 'gpt-4o-mini', qualityTier: 'standard', costPerMTokensIn: 0.15, costPerMTokensOut: 0.60 }),
      Object.freeze({ id: 'gpt-4o', qualityTier: 'standard', costPerMTokensIn: 2.50, costPerMTokensOut: 10.00 }),
      Object.freeze({ id: 'gpt-4.1-mini', qualityTier: 'standard', costPerMTokensIn: 0.40, costPerMTokensOut: 1.60 }),
      Object.freeze({ id: 'gpt-4.1', qualityTier: 'deep', costPerMTokensIn: 2.00, costPerMTokensOut: 8.00 }),
    ]),
    costs: Object.freeze({ input: 0.15, output: 0.60 }),
  }),
  anthropic: Object.freeze({
    id: 'anthropic',
    displayName: 'Anthropic',
    family: 'api',
    needsKey: true,
    configurableEndpoint: false,
    defaultEndpoint: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-3-5-haiku-latest',
    implementationStatus: 'ready',
    statusNote: 'Messages API invokeApi 구현됨 (PR M3). API key를 ai-keys safeStorage에 저장해야 호출 성공.',
    models: Object.freeze([
      Object.freeze({ id: 'claude-3-5-haiku-latest', qualityTier: 'fast', costPerMTokensIn: 0.80, costPerMTokensOut: 4.00 }),
      Object.freeze({ id: 'claude-3-5-sonnet-latest', qualityTier: 'standard', costPerMTokensIn: 3.00, costPerMTokensOut: 15.00 }),
      Object.freeze({ id: 'claude-3-opus-latest', qualityTier: 'deep', costPerMTokensIn: 15.00, costPerMTokensOut: 75.00 }),
    ]),
    costs: Object.freeze({ input: 0.80, output: 4.00 }),
  }),
  openrouter: Object.freeze({
    id: 'openrouter',
    displayName: 'OpenRouter',
    family: 'api',
    needsKey: true,
    configurableEndpoint: false,
    defaultEndpoint: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    implementationStatus: 'stub',
    statusNote: 'plugin 미등록 — 사이드바 streaming만 지원.',
    models: Object.freeze([
      Object.freeze({ id: 'openrouter/auto', qualityTier: 'standard', costPerMTokensIn: 0, costPerMTokensOut: 0 }),
    ]),
    costs: Object.freeze({ input: 0, output: 0 }),
  }),
  'openai-compatible': Object.freeze({
    id: 'openai-compatible',
    displayName: 'OpenAI-compatible (custom endpoint)',
    family: 'api',
    needsKey: false,
    configurableEndpoint: true,
    defaultEndpoint: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    implementationStatus: 'stub',
    statusNote: 'plugin 미등록 — 사이드바 streaming만 지원.',
    models: Object.freeze([]),
    costs: Object.freeze({ input: 0, output: 0 }),
  }),
  ollama: Object.freeze({
    id: 'ollama',
    displayName: 'Ollama (local)',
    family: 'api',
    needsKey: false,
    configurableEndpoint: true,
    defaultEndpoint: 'http://localhost:11434',
    defaultModel: 'llama3',
    implementationStatus: 'stub',
    statusNote: 'plugin 등록됨, invokeApi 미구현. ollama 서비스 호출 path는 추후 PR.',
    models: Object.freeze([
      Object.freeze({ id: 'llama3', qualityTier: 'standard', costPerMTokensIn: 0, costPerMTokensOut: 0 }),
      Object.freeze({ id: 'llama3.1', qualityTier: 'standard', costPerMTokensIn: 0, costPerMTokensOut: 0 }),
    ]),
    costs: Object.freeze({ input: 0, output: 0 }),
  }),
  'codex-cli': Object.freeze({
    id: 'codex-cli',
    displayName: 'OpenAI Codex CLI',
    family: 'cli',
    needsKey: false,
    configurableEndpoint: false,
    defaultEndpoint: '',
    defaultModel: 'codex',
    implementationStatus: 'ready',
    statusNote: 'codex CLI를 실제로 spawn (PR M1). Windows shim 자동 탐지.',
    models: Object.freeze([
      Object.freeze({ id: 'codex', qualityTier: 'standard', costPerMTokensIn: 0, costPerMTokensOut: 0 }),
    ]),
    costs: Object.freeze({ input: 0, output: 0 }),
  }),
  'claude-code': Object.freeze({
    id: 'claude-code',
    displayName: 'Anthropic Claude Code CLI',
    family: 'cli',
    needsKey: false,
    configurableEndpoint: false,
    defaultEndpoint: '',
    defaultModel: 'claude-code',
    implementationStatus: 'ready',
    statusNote: 'claude CLI를 실제로 spawn (PR M8). PATH에 claude 바이너리 필요.',
    models: Object.freeze([
      Object.freeze({ id: 'claude-code', qualityTier: 'standard', costPerMTokensIn: 0, costPerMTokensOut: 0 }),
    ]),
    costs: Object.freeze({ input: 0, output: 0 }),
  }),
});

const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDER_CATALOG));

function listProviderIds() {
  return [...PROVIDER_IDS];
}

function listProviderEntries() {
  return PROVIDER_IDS.map(id => PROVIDER_CATALOG[id]);
}

function getProviderEntry(id) {
  if (typeof id !== 'string') return null;
  return PROVIDER_CATALOG[id] || null;
}

function hasProviderEntry(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_CATALOG, id);
}

function isKeylessProvider(id) {
  const entry = getProviderEntry(id);
  return Boolean(entry) && entry.needsKey === false;
}

function defaultEndpointFor(id) {
  const entry = getProviderEntry(id);
  return entry?.defaultEndpoint || '';
}

function defaultModelFor(id) {
  const entry = getProviderEntry(id);
  return entry?.defaultModel || '';
}

function modelEntryFor(providerId, modelId) {
  const entry = getProviderEntry(providerId);
  if (!entry) return null;
  return entry.models.find(model => model.id === modelId) || null;
}

function summarizeForIpc() {
  return PROVIDER_IDS.map(id => {
    const entry = PROVIDER_CATALOG[id];
    return {
      id: entry.id,
      displayName: entry.displayName,
      family: entry.family,
      needsKey: entry.needsKey,
      configurableEndpoint: entry.configurableEndpoint,
      defaultEndpoint: entry.defaultEndpoint,
      defaultModel: entry.defaultModel,
      implementationStatus: entry.implementationStatus || 'unknown',
      statusNote: entry.statusNote || '',
      models: entry.models.map(model => model.id),
      costs: { input: entry.costs.input, output: entry.costs.output },
    };
  });
}

module.exports = {
  PROVIDER_CATALOG,
  PROVIDER_IDS,
  defaultEndpointFor,
  defaultModelFor,
  getProviderEntry,
  hasProviderEntry,
  isKeylessProvider,
  listProviderEntries,
  listProviderIds,
  modelEntryFor,
  summarizeForIpc,
};
