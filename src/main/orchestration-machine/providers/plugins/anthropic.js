// Anthropic Messages API plugin.
//
// Provider-neutral M3 plugin that gives the Machine an end-to-end API
// adapter path without pulling in an SDK. All HTTP calls go through Node
// `fetch` / `undici`. Single-shot JSON remains the default; an explicit
// streaming mode exists for deterministic fixture replay and provider
// stream normalization coverage.

const { TextDecoder } = require('util');
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

function streamContractError(phase, message, cause) {
  const err = new Error(`Anthropic stream parsing failed during ${phase}: ${message}`);
  err.code = 'OUTPUT_VIOLATES_CONTRACT';
  err.phase = `anthropic.stream.${phase}`;
  if (cause) err.cause = cause;
  return err;
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

function firstFiniteNumber(values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function parseUsage(rawResponse) {
  const usage = rawResponse?.usage || {};
  const deltaUsage = rawResponse?.message_delta?.usage || {};
  const metadataUsage = rawResponse?.metadata?.usage || {};
  const promptTokens = firstFiniteNumber([
    usage.input_tokens,
    usage.prompt_tokens,
    deltaUsage.input_tokens,
    deltaUsage.prompt_tokens,
    metadataUsage.input_tokens,
    metadataUsage.prompt_tokens,
  ]);
  const completionTokens = firstFiniteNumber([
    deltaUsage.output_tokens,
    deltaUsage.completion_tokens,
    usage.output_tokens,
    usage.completion_tokens,
    metadataUsage.output_tokens,
    metadataUsage.completion_tokens,
  ]);
  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    totalTokens: (Number.isFinite(promptTokens) ? promptTokens : 0)
      + (Number.isFinite(completionTokens) ? completionTokens : 0),
  };
}

function mergeAnthropicUsage(target, usage = {}) {
  if (!usage || typeof usage !== 'object') return;
  for (const key of ['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens']) {
    if (usage[key] != null) target[key] = usage[key];
  }
}

async function readAnthropicStreamText(response) {
  const decoder = new TextDecoder();
  const decode = value => {
    if (value == null) return '';
    return typeof value === 'string' ? value : decoder.decode(value, { stream: true });
  };
  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    let text = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decode(value);
      }
      text += decoder.decode();
      return text;
    } catch (err) {
      throw streamContractError('read', err?.message || String(err), err);
    }
  }
  if (response?.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    let text = '';
    try {
      for await (const value of response.body) {
        text += decode(value);
      }
      text += decoder.decode();
      return text;
    } catch (err) {
      throw streamContractError('read', err?.message || String(err), err);
    }
  }
  if (typeof response?.text === 'function') {
    try {
      return await response.text();
    } catch (err) {
      throw streamContractError('read', err?.message || String(err), err);
    }
  }
  throw streamContractError('body', 'response did not include a readable SSE body.');
}

function parseAnthropicSseFrame(frame, state) {
  const dataLines = [];
  let eventName = '';
  for (const rawLine of String(frame || '').split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const colon = rawLine.indexOf(':');
    const field = colon >= 0 ? rawLine.slice(0, colon) : rawLine;
    let value = colon >= 0 ? rawLine.slice(colon + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value.trim();
    if (field === 'data') dataLines.push(value);
  }
  if (!dataLines.length) return;
  const data = dataLines.join('\n').trim();
  if (!data) return;
  if (data === '[DONE]') return;

  let json;
  try {
    json = JSON.parse(data);
  } catch (err) {
    throw streamContractError('event-json', `invalid SSE data JSON${eventName ? ` for ${eventName}` : ''}.`, err);
  }
  if (eventName === 'error' || json?.type === 'error') {
    const providerMessage = json?.error?.message || json?.message || 'provider emitted an error event.';
    throw streamContractError('event-error', providerMessage);
  }
  if (json?.type === 'message_start') {
    mergeAnthropicUsage(state.usage, json.message?.usage);
    if (typeof json.message?.model === 'string') state.model = json.message.model;
    return;
  }
  if (json?.type === 'content_block_start' && json.content_block?.type === 'text') {
    if (typeof json.content_block.text === 'string') state.text += json.content_block.text;
    return;
  }
  if (json?.type === 'content_block_delta') {
    if (typeof json.delta?.text === 'string') state.text += json.delta.text;
    return;
  }
  if (json?.type === 'message_delta') {
    mergeAnthropicUsage(state.usage, json.usage);
    if (typeof json.delta?.stop_reason === 'string') state.stopReason = json.delta.stop_reason;
    return;
  }
  if (json?.type === 'message_stop') {
    state.sawStop = true;
  }
}

async function parseAnthropicStreamResponse(response) {
  const sseText = await readAnthropicStreamText(response);
  const state = {
    text: '',
    usage: {},
    model: '',
    stopReason: '',
    sawStop: false,
  };
  const frames = String(sseText || '').split(/\r?\n\r?\n/).filter(frame => frame.trim());
  for (const frame of frames) parseAnthropicSseFrame(frame, state);
  if (!state.sawStop) {
    throw streamContractError('finish', 'stream ended before message_stop.');
  }
  return {
    text: state.text.trim(),
    usage: parseUsage({ usage: state.usage }),
    model: state.model,
    stopReason: state.stopReason,
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

function isAnthropicStreamingRequested(input = {}) {
  return [
    input.stream,
    input.streaming,
    input.request?.stream,
    input.request?.streaming,
    input.request?.providerOptions?.stream,
    input.request?.providerOptions?.streaming,
    input.request?.adapterOptions?.stream,
    input.request?.adapterOptions?.streaming,
    input.selection?.stream,
    input.selection?.streaming,
  ].some(value => value === true);
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
  const shouldStream = isAnthropicStreamingRequested(input);

  const body = {
    model: selection.model,
    max_tokens: Number(maxTokens || DEFAULT_MAX_TOKENS),
    system: buildSystemPrompt(prompt, instructions),
    messages: buildAnthropicMessages(prompt),
    stream: shouldStream,
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
  const parsed = shouldStream ? await parseAnthropicStreamResponse(response) : null;
  const json = parsed ? null : await response.json();
  const text = parsed ? parsed.text : extractAssistantText(json);
  let adapterResult;
  try {
    adapterResult = parseAdapterResultJson(text);
  } catch (err) {
    if (parsed && err?.code === 'OUTPUT_VIOLATES_CONTRACT') {
      throw streamContractError('adapter-json', err.message, err);
    }
    throw err;
  }
  const usage = parsed ? parsed.usage : parseUsage(json);
  if (typeof onUsage === 'function') onUsage(usage);
  const traceId = (typeof response.headers?.get === 'function'
    ? (response.headers.get('request-id') || response.headers.get('anthropic-request-id') || '')
    : '');
  return {
    result: adapterResult,
    usage,
    traceId,
    metadata: {
      stopReason: parsed?.stopReason || (typeof json?.stop_reason === 'string' ? json.stop_reason : ''),
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
    streaming: true,
    structuredOutput: 'json-mode',
    sandbox: null,
  }),
  models: CATALOG_ENTRY?.models || Object.freeze([]),
  defaultModel: CATALOG_ENTRY?.defaultModel || '',
  dangerousArgs: Object.freeze([]),
  invokeApi,
  parseAnthropicStreamResponse,
  parseUsage,
  estimateCost,
  classifyAnthropicHttpStatus,
};
