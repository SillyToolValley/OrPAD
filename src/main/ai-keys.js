const fs = require('fs');
const path = require('path');

const {
  PROVIDER_IDS,
  defaultEndpointFor,
  getProviderEntry,
  hasProviderEntry,
  isKeylessProvider,
  summarizeForIpc,
} = require('../shared/ai/provider-catalog');

const STREAMING_PROVIDERS = Object.freeze(['openai', 'anthropic', 'openrouter', 'openai-compatible']);
const PROVIDER_RE = /^[a-z0-9-]{1,48}$/;
const DEFAULT_ENDPOINTS = {
  openai: defaultEndpointFor('openai'),
  anthropic: defaultEndpointFor('anthropic'),
  openrouter: defaultEndpointFor('openrouter'),
  'openai-compatible': defaultEndpointFor('openai-compatible'),
};

const chatControllers = new Map();

function storePath(app) {
  return path.join(app.getPath('userData'), 'ai-keys.json');
}

function readStore(app) {
  try {
    const raw = fs.readFileSync(storePath(app), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(app, store) {
  const filePath = storePath(app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

function validateProvider(provider) {
  if (typeof provider !== 'string' || !PROVIDER_RE.test(provider)) {
    throw new Error('Invalid provider id');
  }
  if (!hasProviderEntry(provider)) {
    throw new Error(`Unknown provider id: ${provider}`);
  }
}

function validateStreamingProvider(provider) {
  validateProvider(provider);
  if (!STREAMING_PROVIDERS.includes(provider)) {
    throw new Error(`Provider does not support sidebar streaming chat: ${provider}`);
  }
}

function normalizeEndpoint(endpoint, fallback = '') {
  const raw = String(endpoint || fallback || '').trim();
  if (!raw) return '';
  const parsed = new URL(raw);
  const isLocalHttp = parsed.protocol === 'http:'
    && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('AI provider endpoint must use HTTPS, except localhost.');
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed.href.replace(/\/+$/, '');
}

function chatCompletionsEndpoint(endpoint) {
  const base = normalizeEndpoint(endpoint, DEFAULT_ENDPOINTS['openai-compatible']);
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function keyMask(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) return '';
  const prefix = trimmed.startsWith('sk-') ? 'sk-' : trimmed.slice(0, Math.min(3, trimmed.length));
  const last4 = trimmed.slice(-4);
  return `${prefix}****${last4}`;
}

function providerStatus(store) {
  const ids = new Set([...PROVIDER_IDS, ...Object.keys(store || {})]);
  const providers = {};
  for (const id of ids) {
    const entry = store[id];
    const catalog = getProviderEntry(id);
    providers[id] = {
      hasKey: !!entry?.ciphertext,
      mask: entry?.mask || '',
      updatedAt: entry?.updatedAt || null,
      endpoint: entry?.endpoint || (catalog?.defaultEndpoint || null),
      family: catalog?.family || 'unknown',
      needsKey: catalog ? Boolean(catalog.needsKey) : true,
      configurableEndpoint: Boolean(catalog?.configurableEndpoint),
      defaultModel: catalog?.defaultModel || '',
      models: catalog?.models?.map(model => model.id) || [],
      costs: catalog?.costs ? { input: catalog.costs.input, output: catalog.costs.output } : { input: 0, output: 0 },
    };
  }
  return providers;
}

function decryptStoredKey(app, safeStorage, provider) {
  validateProvider(provider);
  if (!safeStorage?.isEncryptionAvailable?.()) {
    throw new Error('OS key encryption is not available on this device.');
  }
  const entry = readStore(app)[provider];
  if (!entry?.ciphertext) return { key: '', entry: null };
  try {
    return {
      key: safeStorage.decryptString(Buffer.from(entry.ciphertext, 'base64')),
      entry,
    };
  } catch {
    throw new Error('Stored API key could not be decrypted.');
  }
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) throw new Error('AI messages are required.');
  return messages.slice(0, 80).map((message) => ({
    role: ['system', 'assistant', 'user'].includes(message?.role) ? message.role : 'user',
    content: String(message?.content || '').slice(0, 200_000),
  }));
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return JSON.parse(JSON.stringify(tools.slice(0, 64)));
}

function redactSecret(text, secret) {
  let output = String(text || '');
  if (secret) output = output.split(secret).join('<redacted>');
  return output.replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '<redacted>');
}

async function readError(res, label, secret) {
  let body = '';
  try { body = await res.text(); } catch {}
  const suffix = body ? `: ${redactSecret(body, secret).slice(0, 500)}` : '';
  throw new Error(`${label} request failed (${res.status} ${res.statusText})${suffix}`);
}

function splitSystem(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const rest = [];
  for (const msg of messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))) {
    const prev = rest[rest.length - 1];
    if (prev?.role === msg.role) prev.content += `\n\n${msg.content}`;
    else rest.push(msg);
  }
  return { system, messages: rest };
}

function toAnthropicTools(tools = []) {
  return tools.map(tool => ({
    name: tool.function?.name || tool.name,
    description: tool.function?.description || tool.description || '',
    input_schema: tool.function?.parameters || tool.input_schema || { type: 'object', properties: {} },
  })).filter(tool => tool.name);
}

async function streamSse(res, onJson) {
  if (!res.body) throw new Error('AI provider did not return a stream.');
  let buffer = '';
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || '';
    for (const part of parts) {
      const data = part
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n');
      if (!data) continue;
      if (data === '[DONE]') {
        await onJson({ done: true });
        return;
      }
      try { await onJson(JSON.parse(data)); } catch {}
    }
  }
}

async function streamOpenAICompatible({ endpoint, apiKey, messages, model, tools, signal, extraHeaders, emit }) {
  const body = {
    model,
    messages,
    stream: true,
  };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const headers = {
    'Content-Type': 'application/json',
    ...(extraHeaders || {}),
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(chatCompletionsEndpoint(endpoint), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) await readError(res, 'Provider', apiKey);

  const toolCalls = new Map();
  function captureToolCalls(deltas) {
    for (const delta of deltas || []) {
      const index = delta.index || 0;
      const current = toolCalls.get(index) || { id: '', name: '', arguments: '' };
      if (delta.id) current.id = delta.id;
      if (delta.function?.name) current.name = delta.function.name;
      if (delta.function?.arguments) current.arguments += delta.function.arguments;
      toolCalls.set(index, current);
    }
  }
  function flushToolCalls() {
    for (const call of toolCalls.values()) {
      if (call.name) emit({ type: 'tool_call', ...call });
    }
  }

  await streamSse(res, async (json) => {
    if (json.done) {
      flushToolCalls();
      emit({ type: 'done' });
      return;
    }
    const choice = json.choices?.[0] || {};
    const delta = choice.delta?.content || '';
    if (delta) emit({ type: 'text', delta });
    captureToolCalls(choice.delta?.tool_calls);
    if (json.usage) emit({ type: 'usage', usage: json.usage });
  });
}

async function streamAnthropic({ apiKey, messages, model, tools, signal, emit }) {
  if (!apiKey) throw new Error('Anthropic API key is not set.');
  const converted = splitSystem(messages);
  const anthropicTools = toAnthropicTools(tools);
  const body = {
    model,
    system: converted.system || undefined,
    messages: converted.messages,
    max_tokens: 4096,
    stream: true,
  };
  if (anthropicTools.length) body.tools = anthropicTools;

  const res = await fetch(DEFAULT_ENDPOINTS.anthropic, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) await readError(res, 'Anthropic', apiKey);

  const toolCalls = new Map();
  await streamSse(res, async (json) => {
    if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
      toolCalls.set(json.index || 0, {
        id: json.content_block.id || '',
        name: json.content_block.name || '',
        arguments: '',
      });
    }
    if (json.type === 'content_block_delta' && json.delta?.text) {
      emit({ type: 'text', delta: json.delta.text });
    }
    if (json.type === 'content_block_delta' && json.delta?.type === 'input_json_delta') {
      const current = toolCalls.get(json.index || 0) || { id: '', name: '', arguments: '' };
      current.arguments += json.delta.partial_json || '';
      toolCalls.set(json.index || 0, current);
    }
    if (json.type === 'message_delta' && json.usage) emit({ type: 'usage', usage: json.usage });
    if (json.type === 'message_stop') {
      for (const call of toolCalls.values()) if (call.name) emit({ type: 'tool_call', ...call });
      emit({ type: 'done' });
    }
  });
}

async function runProviderChat({ app, safeStorage, request, signal, emit }) {
  const provider = String(request?.provider || '');
  validateStreamingProvider(provider);
  const model = String(request?.model || '').trim();
  if (!model) throw new Error('AI model is required.');
  const messages = normalizeMessages(request?.messages);
  const tools = normalizeTools(request?.tools);
  const { key, entry } = decryptStoredKey(app, safeStorage, provider);
  const keyless = isKeylessProvider(provider);

  if (!keyless && provider !== 'openai-compatible' && !key) {
    throw new Error(`${provider} API key is not set.`);
  }

  if (provider === 'anthropic') {
    await streamAnthropic({ apiKey: key, messages, model, tools, signal, emit });
    return;
  }

  if (provider === 'openai') {
    await streamOpenAICompatible({
      endpoint: DEFAULT_ENDPOINTS.openai,
      apiKey: key,
      messages,
      model,
      tools,
      signal,
      emit,
    });
    return;
  }

  if (provider === 'openrouter') {
    await streamOpenAICompatible({
      endpoint: DEFAULT_ENDPOINTS.openrouter,
      apiKey: key,
      messages,
      model,
      tools,
      signal,
      emit,
      extraHeaders: {
        'HTTP-Referer': 'https://orpad.local',
        'X-Title': 'OrPAD',
      },
    });
    return;
  }

  if (provider === 'openai-compatible') {
    const requestedEndpoint = normalizeEndpoint(request?.endpoint, DEFAULT_ENDPOINTS['openai-compatible']);
    if (key) {
      const boundEndpoint = normalizeEndpoint(entry?.endpoint, DEFAULT_ENDPOINTS['openai-compatible']);
      if (requestedEndpoint !== boundEndpoint) {
        throw new Error('Saved OpenAI-compatible key is bound to a different endpoint. Re-save the key for this endpoint.');
      }
    }
    await streamOpenAICompatible({
      endpoint: requestedEndpoint,
      apiKey: key,
      messages,
      model,
      tools,
      signal,
      emit,
    });
  }
}

function registerAiKeyHandlers({ ipcMain, app, safeStorage }) {
  ipcMain.handle('ai-keys-status', () => {
    const store = readStore(app);
    return {
      encryptionAvailable: !!safeStorage?.isEncryptionAvailable?.(),
      catalog: summarizeForIpc(),
      providers: providerStatus(store),
    };
  });

  ipcMain.handle('ai-key-set', (_event, provider, key, metadata = {}) => {
    validateProvider(provider);
    if (isKeylessProvider(provider)) {
      return { error: `Provider "${provider}" does not require an API key.` };
    }
    const trimmed = String(key || '').trim();
    if (!trimmed) return { error: 'API key is empty' };
    if (!safeStorage?.isEncryptionAvailable?.()) {
      return { error: 'OS key encryption is not available on this device.' };
    }

    const store = readStore(app);
    let endpoint = null;
    if (provider === 'openai-compatible') {
      try {
        endpoint = normalizeEndpoint(metadata?.endpoint, DEFAULT_ENDPOINTS['openai-compatible']);
      } catch (err) {
        return { error: err.message };
      }
    }
    store[provider] = {
      ciphertext: safeStorage.encryptString(trimmed).toString('base64'),
      mask: keyMask(trimmed),
      updatedAt: new Date().toISOString(),
      endpoint,
    };
    writeStore(app, store);
    return { success: true, providers: providerStatus(store) };
  });

  ipcMain.handle('ai-key-get-decrypted', () => {
    return { error: 'Stored AI keys cannot be exported to the renderer.' };
  });

  ipcMain.handle('ai-key-remove', (_event, provider) => {
    validateProvider(provider);
    const store = readStore(app);
    delete store[provider];
    writeStore(app, store);
    return { success: true, providers: providerStatus(store) };
  });

  ipcMain.handle('ai-provider-chat', async (event, request = {}) => {
    const requestId = String(request.requestId || '');
    if (!requestId) return { error: 'AI request id is required.' };
    if (chatControllers.has(requestId)) return { error: 'AI request id is already active.' };

    const controller = new AbortController();
    chatControllers.set(requestId, { controller, senderId: event.sender.id });
    const emit = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai-provider-event', { requestId, ...payload });
    };

    runProviderChat({
      app,
      safeStorage,
      request,
      signal: controller.signal,
      emit,
    }).catch((err) => {
      if (controller.signal.aborted) emit({ type: 'error', message: 'AI request canceled.' });
      else emit({ type: 'error', message: redactSecret(err?.message || String(err), '') });
    }).finally(() => {
      chatControllers.delete(requestId);
    });

    return { success: true, requestId };
  });

  ipcMain.handle('ai-provider-cancel', (event, requestId) => {
    const id = String(requestId || '');
    const entry = chatControllers.get(id);
    if (!entry || entry.senderId !== event.sender.id) return false;
    entry.controller.abort();
    chatControllers.delete(id);
    return true;
  });
}

function createMachineProviderKeyLoader({ app, safeStorage }) {
  return async function loadProviderKey(providerId) {
    if (!providerId) return '';
    if (!hasProviderEntry(providerId)) return '';
    if (isKeylessProvider(providerId)) return '';
    if (!safeStorage?.isEncryptionAvailable?.()) {
      const err = new Error('safeStorage encryption is not available on this device.');
      err.code = 'KEY_MISSING';
      throw err;
    }
    const { key } = decryptStoredKey(app, safeStorage, providerId);
    return key || '';
  };
}

module.exports = {
  createMachineProviderKeyLoader,
  keyMask,
  providerStatus,
  registerAiKeyHandlers,
  validateProvider,
  validateStreamingProvider,
};
