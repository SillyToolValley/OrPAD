// Anthropic Messages API plugin.
//
// Provider-neutral M3 plugin that gives the Machine an end-to-end API
// adapter path without pulling in an SDK. All HTTP calls go through Node
// `fetch` / `undici`. Streaming is intentionally disabled in M3 — the
// router (M4) and structured adapter result parsing prefer single-shot
// JSON. PR M10 is where conversation-id sessions and streaming usage
// reconciliation land.

const { getProviderEntry } = require('../../../../shared/ai/provider-catalog');

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

const CATALOG_ENTRY = getProviderEntry('anthropic');

function classifyAnthropicHttpStatus(status) {
  if (status === 401 || status === 403) return 'KEY_MISSING';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 408 || status === 502 || status === 503 || status === 504) return 'RETRYABLE';
  if (status === 400 || status === 422) return 'OUTPUT_VIOLATES_CONTRACT';
  if (status >= 500) return 'RETRYABLE';
  return 'FATAL';
}

function buildAnthropicMessages(prompt) {
  const userContent = typeof prompt === 'string'
    ? prompt
    : JSON.stringify(prompt, null, 2);
  return [
    {
      role: 'user',
      content: userContent,
    },
  ];
}

function buildSystemPrompt(prompt, instructions) {
  const head = [
    'You are the OrPAD managed-run API adapter.',
    'The orchestration Machine has selected you to satisfy a single adapter request.',
    `Return exactly one JSON object that conforms to ${prompt?.outputContract || 'orpad.workerResult.v1'}.`,
    'Do not include markdown fences or commentary outside the JSON object.',
  ];
  if (instructions && typeof instructions === 'string') head.push(instructions);
  return head.filter(Boolean).join('\n');
}

function extractAssistantText(json) {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  return blocks
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
    .trim();
}

function parseAdapterResultJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    const err = new Error('Anthropic returned no text content.');
    err.code = 'OUTPUT_VIOLATES_CONTRACT';
    throw err;
  }
  try {
    return JSON.parse(trimmed);
  } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  }
  const err = new Error('Anthropic response was not valid JSON.');
  err.code = 'OUTPUT_VIOLATES_CONTRACT';
  throw err;
}

function parseUsage(rawResponse) {
  const usage = rawResponse?.usage
    || rawResponse?.message_delta?.usage
    || rawResponse?.metadata?.usage
    || {};
  const promptTokens = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const completionTokens = Number(usage.output_tokens || usage.completion_tokens || 0);
  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    totalTokens: (Number.isFinite(promptTokens) ? promptTokens : 0)
      + (Number.isFinite(completionTokens) ? completionTokens : 0),
  };
}

function modelRates(modelId) {
  const entry = CATALOG_ENTRY || getProviderEntry('anthropic');
  const modelEntry = entry?.models.find(model => model.id === modelId);
  const inRate = modelEntry?.costPerMTokensIn ?? entry?.costs?.input ?? 0;
  const outRate = modelEntry?.costPerMTokensOut ?? entry?.costs?.output ?? 0;
  return { inRate, outRate };
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

async function invokeApi(input = {}) {
  const {
    request,
    prompt,
    selection = {},
    session,
    keyAccess,
    signal,
    onUsage,
    providerKey,
    fetchImpl,
    instructions,
    maxTokens,
  } = input;
  if (!request) {
    const err = new Error('Anthropic invokeApi requires an adapter request.');
    err.code = 'OUTPUT_VIOLATES_CONTRACT';
    throw err;
  }
  const apiKey = String(providerKey || '').trim();
  if (!apiKey) {
    const err = new Error('Anthropic API key is required.');
    err.code = 'KEY_MISSING';
    throw err;
  }
  if (!selection.model) {
    const err = new Error('Anthropic invokeApi requires selection.model.');
    err.code = 'OUTPUT_VIOLATES_CONTRACT';
    throw err;
  }
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : fetch;

  const body = {
    model: selection.model,
    max_tokens: Number(maxTokens || DEFAULT_MAX_TOKENS),
    system: buildSystemPrompt(prompt, instructions),
    messages: buildAnthropicMessages(prompt),
    stream: false,
  };

  let response;
  try {
    response = await fetchFn(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const wrapped = new Error(`Anthropic transport error: ${err?.message || err}`);
    wrapped.code = 'RETRYABLE';
    wrapped.cause = err;
    throw wrapped;
  }
  if (!response.ok) {
    const err = new Error(`Anthropic request failed (${response.status} ${response.statusText || ''}).`);
    err.code = classifyAnthropicHttpStatus(response.status);
    err.status = response.status;
    throw err;
  }
  const json = await response.json();
  const text = extractAssistantText(json);
  const adapterResult = parseAdapterResultJson(text);
  const usage = parseUsage(json);
  if (typeof onUsage === 'function') onUsage(usage);
  const traceId = (typeof response.headers?.get === 'function'
    ? (response.headers.get('request-id') || response.headers.get('anthropic-request-id') || '')
    : '');
  return {
    result: adapterResult,
    usage,
    traceId,
    metadata: {
      stopReason: typeof json?.stop_reason === 'string' ? json.stop_reason : '',
      providerId: 'anthropic',
      model: selection.model,
      sessionStrategy: session?.sessionStrategy || selection.sessionStrategy || 'none',
      keyRuntime: keyAccess?.runtime || 'desktop',
    },
  };
}

module.exports = {
  id: CATALOG_ENTRY?.id || 'anthropic',
  displayName: CATALOG_ENTRY?.displayName || 'Anthropic',
  family: CATALOG_ENTRY?.family || 'api',
  needsKey: CATALOG_ENTRY ? Boolean(CATALOG_ENTRY.needsKey) : true,
  implementationStatus: CATALOG_ENTRY?.implementationStatus || 'ready',
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
  classifyAnthropicHttpStatus,
};
