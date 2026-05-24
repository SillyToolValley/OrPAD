function cleanEndpoint(endpoint) {
  const raw = String(endpoint || '').trim();
  if (!raw) return 'https://api.openai.com/v1/chat/completions';
  if (raw.endsWith('/chat/completions')) return raw;
  return raw.replace(/\/+$/, '') + '/chat/completions';
}

async function readError(res) {
  let body = '';
  try { body = await res.text(); } catch {}
  const suffix = body ? `: ${body.slice(0, 500)}` : '';
  throw new Error(`Provider request failed (${res.status} ${res.statusText})${suffix}`);
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  if (signal?.reason) {
    const err = new Error(String(signal.reason));
    err.name = 'AbortError';
    return err;
  }
  try {
    return new DOMException('Aborted', 'AbortError');
  } catch {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
  }
}

function malformedStreamEvent(provider, data) {
  return {
    type: 'error',
    code: 'PROVIDER_STREAM_MALFORMED_JSON',
    message: `${provider} stream sent malformed JSON.`,
    diagnostic: {
      provider,
      chunkLength: String(data || '').length,
    },
  };
}

async function readStreamChunk(reader, abortSignal) {
  if (!abortSignal) return reader.read();
  if (abortSignal.aborted) throw abortError(abortSignal);

  let cleanup = null;
  const aborted = new Promise((_, reject) => {
    const onAbort = () => {
      const err = abortError(abortSignal);
      reject(err);
      try { reader.cancel(err).catch(() => {}); } catch {}
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
    cleanup = () => abortSignal.removeEventListener('abort', onAbort);
  });

  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (cleanup) cleanup();
  }
}

async function* streamOpenAIResponse(res, abortSignal) {
  if (!res.ok) await readError(res);
  if (!res.body) throw new Error('Provider did not return a stream.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let malformedReported = false;
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

  function pendingToolCalls() {
    return Array.from(toolCalls.values()).filter(call => call.name);
  }

  while (true) {
    const { value, done } = await readStreamChunk(reader, abortSignal);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() || '';
    for (const chunk of chunks) {
      const data = chunk
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n');
      if (!data) continue;
      if (data === '[DONE]') {
        for (const call of pendingToolCalls()) yield { type: 'tool_call', ...call };
        yield { type: 'done' };
        return;
      }
      let json = null;
      try {
        json = JSON.parse(data);
      } catch {
        if (!malformedReported) {
          malformedReported = true;
          yield malformedStreamEvent('OpenAI-compatible', data);
        }
        continue;
      }
      const choice = json.choices?.[0] || {};
      const delta = choice.delta?.content || '';
      if (delta) yield { type: 'text', delta };
      captureToolCalls(choice.delta?.tool_calls);
      if (json.usage) yield { type: 'usage', usage: json.usage };
    }
  }
  for (const call of pendingToolCalls()) yield { type: 'tool_call', ...call };
  yield { type: 'done' };
}

export async function* streamOpenAICompatible({ endpoint, apiKey, messages, model, abortSignal, extraHeaders = {}, tools = [] }) {
  const headers = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body = {
    model,
    messages,
    stream: true,
  };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch(cleanEndpoint(endpoint), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: abortSignal,
  });
  yield* streamOpenAIResponse(res, abortSignal);
}

export default {
  id: 'openai-compatible',
  displayName: 'OpenAI-compatible',
  models: ['gpt-4o-mini', 'llama3.1', 'qwen2.5-coder'],
  defaultModel: 'gpt-4o-mini',
  needsKey: false,
  configurableEndpoint: true,
  defaultEndpoint: 'https://api.openai.com/v1',
  costs: { input: 0.15, output: 0.60 },
  async *chat(args) {
    yield* streamOpenAICompatible(args);
  },
};
