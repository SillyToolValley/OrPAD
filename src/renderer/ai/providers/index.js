import openai from './openai.js';
import anthropic from './anthropic.js';
import ollama from './ollama.js';
import openrouter from './openrouter.js';
import openaiCompatible from './openai-compatible.js';
import { getProviderEntry, summarizeForIpc } from '../../../shared/ai/provider-catalog.js';

// Per-provider modules contribute the streaming chat generator. The shared
// provider catalog supplies display name, models, default model, costs, and
// keyless markers so renderer and main stay aligned.
const CHAT_IMPLEMENTATIONS = {
  openai,
  anthropic,
  ollama,
  openrouter,
  'openai-compatible': openaiCompatible,
};

function buildProvider(id) {
  const catalog = getProviderEntry(id);
  const impl = CHAT_IMPLEMENTATIONS[id];
  if (!catalog || !impl) return null;
  return {
    id: catalog.id,
    displayName: catalog.displayName,
    family: catalog.family,
    needsKey: catalog.needsKey,
    configurableEndpoint: catalog.configurableEndpoint,
    defaultEndpoint: catalog.defaultEndpoint,
    defaultModel: catalog.defaultModel,
    models: catalog.models.map(model => model.id),
    costs: catalog.costs,
    chat: impl.chat?.bind(impl) || impl.chat,
  };
}

export const providers = Object.keys(CHAT_IMPLEMENTATIONS)
  .map(id => buildProvider(id))
  .filter(Boolean);

export function getProvider(id) {
  return providers.find(provider => provider.id === id) || providers[0];
}

export function providerOptions() {
  return summarizeForIpc().filter(entry => CHAT_IMPLEMENTATIONS[entry.id]);
}

export function estimateCostUsd(provider, inputTokens, outputTokens = 1200) {
  const costs = provider?.costs || { input: 0, output: 0 };
  return ((inputTokens / 1_000_000) * costs.input) + ((outputTokens / 1_000_000) * costs.output);
}
