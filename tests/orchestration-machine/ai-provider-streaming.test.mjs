import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setImmediate as waitImmediate } from 'node:timers/promises';

const encoder = new TextEncoder();

async function importProvider(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const { streamOpenAICompatible } = await importProvider('../../src/renderer/ai/providers/openai-compatible.js');
const anthropicProvider = (await importProvider('../../src/renderer/ai/providers/anthropic.js')).default;

async function withFetch(fetchImpl, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function streamResponse(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, statusText: 'OK' });
}

function pendingResponse(cancelReasons) {
  return new Response(new ReadableStream({
    cancel(reason) {
      cancelReasons.push(reason);
    },
  }), { status: 200, statusText: 'OK' });
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function expectAbortAfterHeaders(makeIterator) {
  const cancelReasons = [];
  const abort = new AbortController();

  await withFetch(async () => pendingResponse(cancelReasons), async () => {
    const iterator = makeIterator(abort.signal);
    const pendingRead = iterator.next();
    await waitImmediate();

    abort.abort();

    await assert.rejects(
      pendingRead,
      err => err?.name === 'AbortError',
      'pending stream read should reject with AbortError',
    );
  });

  assert.equal(cancelReasons.length, 1, 'stream reader should be canceled on abort');
}

test('provider readers resolve pending reads when aborted after response headers', async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await expectAbortAfterHeaders(abortSignal => streamOpenAICompatible({
      endpoint: 'http://localhost:11434/v1',
      apiKey: '',
      messages: [{ role: 'user', content: 'hello' }],
      model: 'fake-model',
      abortSignal,
    }));

    await expectAbortAfterHeaders(abortSignal => anthropicProvider.chat({
      apiKey: 'test-key',
      messages: [{ role: 'user', content: 'hello' }],
      model: 'claude-test',
      abortSignal,
    }));
  }
});

test('OpenAI-compatible streaming emits bounded malformed JSON diagnostics', async () => {
  await withFetch(async () => streamResponse([
    ': keep-alive\n\n',
    'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
    'data: not-json sk-secret-value\n\n',
    'data: still-not-json\n\n',
    'data: {"type":"provider_specific_ping"}\n\n',
    'data: [DONE]\n\n',
  ]), async () => {
    const events = await collect(streamOpenAICompatible({
      endpoint: 'http://localhost:11434/v1',
      apiKey: '',
      messages: [{ role: 'user', content: 'hello' }],
      model: 'fake-model',
    }));

    assert.deepEqual(events.map(event => event.type), ['text', 'error', 'done']);
    assert.equal(events[1].code, 'PROVIDER_STREAM_MALFORMED_JSON');
    assert.equal(events[1].diagnostic.provider, 'OpenAI-compatible');
    assert.equal(JSON.stringify(events[1]).includes('sk-secret-value'), false);
  });
});

test('Anthropic streaming emits bounded malformed JSON diagnostics', async () => {
  await withFetch(async () => streamResponse([
    ': keep-alive\n\n',
    'data: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n',
    'data: not-json sk-secret-value\n\n',
    'data: still-not-json\n\n',
    'data: {"type":"ping"}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ]), async () => {
    const events = await collect(anthropicProvider.chat({
      apiKey: 'test-key',
      messages: [{ role: 'user', content: 'hello' }],
      model: 'claude-test',
    }));

    assert.deepEqual(events.map(event => event.type), ['text', 'error', 'done']);
    assert.equal(events[1].code, 'PROVIDER_STREAM_MALFORMED_JSON');
    assert.equal(events[1].diagnostic.provider, 'Anthropic');
    assert.equal(JSON.stringify(events[1]).includes('sk-secret-value'), false);
  });
});
