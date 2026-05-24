import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TextEncoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  classifyAnthropicHttpStatus,
  createApiAgentAdapter,
  createContractValidator,
  getProviderEntry,
  getProviderPlugin,
  hasProviderPlugin,
  liftMachineAdapterV1ToV2,
  SCHEMA_VERSIONS,
} = require('../../src/main/orchestration-machine');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(__dirname, '../fixtures/orchestration-machine/anthropic');
const adapterFixtureRoot = path.resolve(__dirname, '../fixtures/orchestration-machine/machine-adapter');

function readFixture(fileName, root = fixtureRoot) {
  return JSON.parse(fs.readFileSync(path.join(root, fileName), 'utf8'));
}

function readTextFixture(fileName, root = fixtureRoot) {
  return fs.readFileSync(path.join(root, fileName), 'utf8');
}

function jsonResponse(payload, { status = 200, statusText = 'OK', headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get(name) {
        const lower = String(name || '').toLowerCase();
        for (const [key, value] of Object.entries(headers)) {
          if (key.toLowerCase() === lower) return value;
        }
        return null;
      },
    },
    async json() { return payload; },
  };
}

function sseResponse(payload, { status = 200, statusText = 'OK', headers = {}, chunkSizes = [] } = {}) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(payload);
  const chunks = [];
  const pattern = Array.isArray(chunkSizes) && chunkSizes.length ? chunkSizes : [bytes.length || 1];
  let offset = 0;
  let patternIndex = 0;
  while (offset < bytes.length) {
    const requestedSize = Number(pattern[patternIndex % pattern.length]);
    const chunkSize = Math.max(1, Number.isFinite(requestedSize) ? Math.floor(requestedSize) : bytes.length);
    chunks.push(bytes.slice(offset, Math.min(offset + chunkSize, bytes.length)));
    offset += chunkSize;
    patternIndex += 1;
  }
  let readIndex = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get(name) {
        const lower = String(name || '').toLowerCase();
        for (const [key, value] of Object.entries(headers)) {
          if (key.toLowerCase() === lower) return value;
        }
        return null;
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            if (readIndex >= chunks.length) return { done: true, value: undefined };
            const value = chunks[readIndex];
            readIndex += 1;
            return { done: false, value };
          },
        };
      },
    },
  };
}

function buildAdapterRequest(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSIONS.adapterRequest,
    adapter: 'api-agent-skeleton',
    runId: 'run_20260506_anthropic',
    adapterCallId: 'adapter_call_001',
    attemptId: 'attempt_001',
    idempotencyKey: 'run_20260506_anthropic:worker:attempt_001',
    nodePath: 'main/worker-loop/worker',
    taskKind: 'workerLoop',
    workspaceMode: 'read-only-plus-overlay',
    inputArtifacts: ['queue/claimed/item.json'],
    adapterResultPath: 'runs/run_20260506_anthropic/adapters/adapter_call_001/response.json',
    outputContract: SCHEMA_VERSIONS.adapterResult,
    ...overrides,
  };
}

test('anthropic plugin is registered with API family metadata', () => {
  assert.equal(hasProviderPlugin('anthropic'), true);
  const plugin = getProviderPlugin('anthropic');
  assert.equal(plugin.id, 'anthropic');
  assert.equal(plugin.family, 'api');
  assert.equal(plugin.needsKey, true);
  assert.equal(typeof plugin.invokeApi, 'function');
  assert.equal(typeof plugin.parseUsage, 'function');
  assert.equal(typeof plugin.estimateCost, 'function');
  assert.equal(plugin.capabilities.streaming, true);
  assert.deepEqual([...plugin.dangerousArgs], []);
  const entry = getProviderEntry('anthropic');
  assert.equal(plugin.displayName, entry.displayName);
  assert.equal(plugin.defaultModel, entry.defaultModel);
});

test('parseUsage extracts input_tokens / output_tokens from Messages API', () => {
  const plugin = getProviderPlugin('anthropic');
  const usage = plugin.parseUsage({ usage: { input_tokens: 1200, output_tokens: 350 } });
  assert.equal(usage.promptTokens, 1200);
  assert.equal(usage.completionTokens, 350);
  assert.equal(usage.totalTokens, 1550);
});

test('parseUsage merges streamed message_delta usage with message_start usage', () => {
  const plugin = getProviderPlugin('anthropic');
  const usage = plugin.parseUsage({
    usage: { input_tokens: 1200, output_tokens: 0 },
    message_delta: { usage: { output_tokens: 350 } },
  });
  assert.equal(usage.promptTokens, 1200);
  assert.equal(usage.completionTokens, 350);
  assert.equal(usage.totalTokens, 1550);
});

test('parseUsage tolerates missing usage payload', () => {
  const plugin = getProviderPlugin('anthropic');
  const usage = plugin.parseUsage({});
  assert.equal(usage.promptTokens, 0);
  assert.equal(usage.completionTokens, 0);
  assert.equal(usage.totalTokens, 0);
});

test('estimateCost uses catalog model rates per million tokens', () => {
  const plugin = getProviderPlugin('anthropic');
  const cost = plugin.estimateCost({
    model: 'claude-3-5-sonnet-latest',
    promptTokens: 1_000_000,
    completionTokens: 500_000,
  });
  // catalog: claude-3-5-sonnet-latest -> in 3.00, out 15.00 per MTok
  // Expected: (1.0 * 3.00) + (0.5 * 15.00) = 3.00 + 7.50 = 10.50
  assert.equal(cost, 10.5);
});

test('estimateCost falls back to provider-level costs for unknown model', () => {
  const plugin = getProviderPlugin('anthropic');
  const entry = getProviderEntry('anthropic');
  const cost = plugin.estimateCost({
    model: 'mystery-model',
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
  });
  const expected = entry.costs.input + entry.costs.output;
  assert.equal(cost, Number(expected.toFixed(8)));
});

test('classifyAnthropicHttpStatus maps known statuses', () => {
  assert.equal(classifyAnthropicHttpStatus(401), 'KEY_MISSING');
  assert.equal(classifyAnthropicHttpStatus(403), 'KEY_MISSING');
  assert.equal(classifyAnthropicHttpStatus(429), 'RATE_LIMIT');
  assert.equal(classifyAnthropicHttpStatus(500), 'RETRYABLE');
  assert.equal(classifyAnthropicHttpStatus(503), 'RETRYABLE');
  assert.equal(classifyAnthropicHttpStatus(400), 'OUTPUT_VIOLATES_CONTRACT');
  assert.equal(classifyAnthropicHttpStatus(422), 'OUTPUT_VIOLATES_CONTRACT');
  assert.equal(classifyAnthropicHttpStatus(418), 'FATAL');
});

test('invokeApi parses recorded Messages API response into structured adapter result', async () => {
  const plugin = getProviderPlugin('anthropic');
  const fixture = readFixture('messages-success.json');
  const fetchImpl = async () => jsonResponse(fixture, { headers: { 'request-id': 'req_test_001' } });
  const out = await plugin.invokeApi({
    request: buildAdapterRequest(),
    prompt: { taskKind: 'workerLoop', allowedFiles: [] },
    selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
    providerKey: 'sk-ant-test-key',
    fetchImpl,
  });
  assert.equal(out.result.schemaVersion, 'orpad.workerResult.v1');
  assert.equal(out.result.status, 'done');
  assert.equal(out.usage.promptTokens, 1200);
  assert.equal(out.usage.completionTokens, 350);
  assert.equal(out.usage.totalTokens, 1550);
  assert.equal(out.traceId, 'req_test_001');
  assert.equal(out.metadata.providerId, 'anthropic');
});

test('invokeApi normalizes streamed Messages API SSE chunks into structured adapter result', async () => {
  const plugin = getProviderPlugin('anthropic');
  const fixture = readTextFixture('messages-stream-success.sse');
  const chunkPlans = [
    [1],
    [2, 3, 5, 7],
    [11, 13, 17],
    [64],
    [fixture.length + 10],
  ];
  assert.equal(chunkPlans.length, 5);

  for (const [index, chunkSizes] of chunkPlans.entries()) {
    let capturedBody = null;
    const usageEvents = [];
    const out = await plugin.invokeApi({
      request: buildAdapterRequest(),
      prompt: { taskKind: 'workerLoop', allowedFiles: [] },
      selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
      providerKey: 'sk-ant-test-key',
      stream: true,
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return sseResponse(fixture, {
          headers: { 'anthropic-request-id': `req_stream_${index}` },
          chunkSizes,
        });
      },
      onUsage: usage => usageEvents.push(usage),
    });
    assert.equal(capturedBody.stream, true);
    assert.equal(out.result.schemaVersion, 'orpad.workerResult.v1');
    assert.equal(out.result.status, 'done');
    assert.equal(out.result.summary, 'Stream fixture normalized by Anthropic Machine adapter.');
    assert.equal(out.usage.promptTokens, 1200);
    assert.equal(out.usage.completionTokens, 350);
    assert.equal(out.usage.totalTokens, 1550);
    assert.equal(out.traceId, `req_stream_${index}`);
    assert.equal(out.metadata.stopReason, 'end_turn');
    assert.equal(usageEvents.length, 1);
    assert.deepEqual(usageEvents[0], out.usage);
  }
});

test('invokeApi maps malformed streamed SSE data to stream parsing contract violation', async () => {
  const plugin = getProviderPlugin('anthropic');
  const fixture = readTextFixture('messages-stream-malformed.sse');
  await assert.rejects(
    plugin.invokeApi({
      request: buildAdapterRequest(),
      prompt: { taskKind: 'workerLoop' },
      selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
      providerKey: 'sk-ant-test-key',
      stream: true,
      fetchImpl: async () => sseResponse(fixture, { chunkSizes: [3, 1, 8] }),
    }),
    error => error?.code === 'OUTPUT_VIOLATES_CONTRACT'
      && error?.phase === 'anthropic.stream.event-json'
      && /Anthropic stream parsing failed/.test(error.message),
  );
});

test('invokeApi maps incomplete streamed SSE data to stream parsing contract violation', async () => {
  const plugin = getProviderPlugin('anthropic');
  const fixture = readTextFixture('messages-stream-success.sse')
    .replace(/event: message_stop[\s\S]*$/m, '');
  await assert.rejects(
    plugin.invokeApi({
      request: buildAdapterRequest(),
      prompt: { taskKind: 'workerLoop' },
      selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
      providerKey: 'sk-ant-test-key',
      stream: true,
      fetchImpl: async () => sseResponse(fixture, { chunkSizes: [13, 2, 5] }),
    }),
    error => error?.code === 'OUTPUT_VIOLATES_CONTRACT'
      && error?.phase === 'anthropic.stream.finish'
      && /message_stop/.test(error.message),
  );
});

test('invokeApi without provider key throws KEY_MISSING', async () => {
  const plugin = getProviderPlugin('anthropic');
  await assert.rejects(
    plugin.invokeApi({
      request: buildAdapterRequest(),
      prompt: { taskKind: 'workerLoop' },
      selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
      providerKey: '',
      fetchImpl: async () => { throw new Error('fetch should not be called'); },
    }),
    error => error?.code === 'KEY_MISSING',
  );
});

test('invokeApi maps HTTP 401 to KEY_MISSING', async () => {
  const plugin = getProviderPlugin('anthropic');
  const fetchImpl = async () => jsonResponse({ error: 'invalid_api_key' }, { status: 401, statusText: 'Unauthorized' });
  await assert.rejects(
    plugin.invokeApi({
      request: buildAdapterRequest(),
      prompt: { taskKind: 'workerLoop' },
      selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
      providerKey: 'sk-ant-bad-key',
      fetchImpl,
    }),
    error => error?.code === 'KEY_MISSING' && error.status === 401,
  );
});

test('invokeApi maps HTTP 429 to RATE_LIMIT', async () => {
  const plugin = getProviderPlugin('anthropic');
  const fetchImpl = async () => jsonResponse({ error: 'rate_limited' }, { status: 429, statusText: 'Too Many Requests' });
  await assert.rejects(
    plugin.invokeApi({
      request: buildAdapterRequest(),
      prompt: { taskKind: 'workerLoop' },
      selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
      providerKey: 'sk-ant-test-key',
      fetchImpl,
    }),
    error => error?.code === 'RATE_LIMIT' && error.status === 429,
  );
});

test('invokeApi maps HTTP 503 to RETRYABLE', async () => {
  const plugin = getProviderPlugin('anthropic');
  const fetchImpl = async () => jsonResponse({ error: 'unavailable' }, { status: 503, statusText: 'Service Unavailable' });
  await assert.rejects(
    plugin.invokeApi({
      request: buildAdapterRequest(),
      prompt: { taskKind: 'workerLoop' },
      selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
      providerKey: 'sk-ant-test-key',
      fetchImpl,
    }),
    error => error?.code === 'RETRYABLE',
  );
});

test('invokeApi flags non-JSON assistant text as CONTRACT_VIOLATION', async () => {
  const plugin = getProviderPlugin('anthropic');
  const fixture = readFixture('messages-malformed.json');
  const fetchImpl = async () => jsonResponse(fixture);
  await assert.rejects(
    plugin.invokeApi({
      request: buildAdapterRequest(),
      prompt: { taskKind: 'workerLoop' },
      selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
      providerKey: 'sk-ant-test-key',
      fetchImpl,
    }),
    error => error?.code === 'OUTPUT_VIOLATES_CONTRACT',
  );
});

test('invokeApi maps fetch transport errors to RETRYABLE', async () => {
  const plugin = getProviderPlugin('anthropic');
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(
    plugin.invokeApi({
      request: buildAdapterRequest(),
      prompt: { taskKind: 'workerLoop' },
      selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
      providerKey: 'sk-ant-test-key',
      fetchImpl,
    }),
    error => error?.code === 'RETRYABLE',
  );
});

test('createApiAgentAdapter forwards per-invoke AbortSignal and classifies cancellation', async () => {
  const controller = new AbortController();
  let fetchCalls = 0;
  let capturedSignal = null;
  const fetchImpl = async (_url, init = {}) => {
    fetchCalls += 1;
    capturedSignal = init.signal;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('fake fetch aborted by test');
        err.name = 'AbortError';
        err.code = 'ABORT_ERR';
        reject(err);
      }, { once: true });
      setImmediate(() => controller.abort(new Error('test cancellation')));
    });
  };
  const adapter = createApiAgentAdapter({
    enabled: true,
    selection: {
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
    },
    providerKey: 'sk-ant-test-key',
    fetchImpl,
  });
  await assert.rejects(
    adapter.invoke({ ...buildAdapterRequest(), signal: controller.signal }),
    error => error?.code === 'MACHINE_RUN_CANCELLED'
      && error?.classification === 'CANCELLED'
      && error?.retryable === false
      && error?.fallbackAllowed === false,
  );
  assert.equal(fetchCalls, 1);
  assert.equal(capturedSignal, controller.signal);
});

test('createApiAgentAdapter routes through registry plugin when no providerClient supplied', async () => {
  const fixture = readFixture('messages-success.json');
  const fetchImpl = async () => jsonResponse(fixture, { headers: { 'request-id': 'req_test_002' } });
  const adapter = createApiAgentAdapter({
    enabled: true,
    selection: {
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
    },
    providerKey: 'sk-ant-test-key',
    fetchImpl,
  });
  const result = await adapter.invoke(buildAdapterRequest());
  assert.equal(result.schemaVersion, 'orpad.workerResult.v1');
  assert.equal(result.status, 'done');
  assert.equal(result.usage.promptTokens, 1200);
  assert.equal(result.usage.completionTokens, 350);
  assert.equal(result.usage.totalTokens, 1550);
  assert.equal(result.usage.currency, 'USD');
  assert.equal(typeof result.usage.costEstimateUsd, 'number');
  assert.equal(result.usage.costEstimateUsd > 0, true);
  assert.equal(result.apiSession.providerId, 'anthropic');
  assert.equal(result.apiSession.sessionStrategy, 'none');
});

test('v2 anthropic pipeline fixture validates against machineAdapter schema and lifts cleanly', () => {
  const validator = createContractValidator();
  const v2 = readFixture('v2-anthropic-pipeline.json', adapterFixtureRoot);
  const result = validator.validate('machineAdapter', v2);
  assert.equal(result.ok, true, `v2 anthropic fixture should validate: ${JSON.stringify(result.errors)}`);
  // liftMachineAdapterV1ToV2 must be idempotent on v2 input.
  assert.equal(liftMachineAdapterV1ToV2(v2), v2);
});

test('Machine accepts an api-family adapter declaration as runnable', () => {
  const orchestration = require('../../src/main/orchestration-machine');
  const v2 = readFixture('v2-anthropic-pipeline.json', adapterFixtureRoot);
  assert.equal(orchestration.isRunnableMachineAdapter(v2), true);
});

test('Anthropic invokeApi never sends the API key in the request body', async () => {
  const plugin = getProviderPlugin('anthropic');
  let capturedBody = null;
  let capturedHeaders = null;
  const fetchImpl = async (url, init) => {
    capturedBody = init?.body || '';
    capturedHeaders = init?.headers || {};
    return jsonResponse(readFixture('messages-success.json'));
  };
  await plugin.invokeApi({
    request: buildAdapterRequest(),
    prompt: { taskKind: 'workerLoop' },
    selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
    providerKey: 'sk-ant-LEAK-CHECK-1234567890',
    fetchImpl,
  });
  assert.equal(typeof capturedBody, 'string');
  assert.equal(capturedBody.includes('sk-ant-LEAK-CHECK-1234567890'), false, 'API key must never appear in request body');
  assert.equal(JSON.parse(capturedBody).stream, false, 'single-shot JSON remains the default request mode');
  // Header surface check: the key is allowed *only* in x-api-key.
  assert.equal(capturedHeaders['x-api-key'], 'sk-ant-LEAK-CHECK-1234567890');
  for (const [name, value] of Object.entries(capturedHeaders)) {
    if (name.toLowerCase() === 'x-api-key') continue;
    assert.equal(
      String(value).includes('sk-ant-LEAK-CHECK-1234567890'),
      false,
      `API key leaked in header ${name}`,
    );
  }
});

test('parseAdapterResultJson tolerates fenced JSON and prose-wrapped JSON', async () => {
  const plugin = getProviderPlugin('anthropic');
  const fencedFixture = {
    id: 'msg_fenced',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-5-sonnet-latest',
    content: [{
      type: 'text',
      text: '```json\n{\"schemaVersion\":\"orpad.workerResult.v1\",\"adapterCallId\":\"adapter_call_001\",\"attemptId\":\"attempt_001\",\"idempotencyKey\":\"k\",\"status\":\"done\",\"summary\":\"fenced\",\"artifacts\":[\"a/b\"]}\n```',
    }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const proseFixture = {
    id: 'msg_prose',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-5-sonnet-latest',
    content: [{
      type: 'text',
      text: 'Here is the result: {\"schemaVersion\":\"orpad.workerResult.v1\",\"adapterCallId\":\"adapter_call_001\",\"attemptId\":\"attempt_001\",\"idempotencyKey\":\"k\",\"status\":\"done\",\"summary\":\"prose\",\"artifacts\":[\"a/b\"]} end',
    }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  for (const [label, payload] of [['fenced', fencedFixture], ['prose', proseFixture]]) {
    const out = await plugin.invokeApi({
      request: buildAdapterRequest(),
      prompt: { taskKind: 'workerLoop' },
      selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
      providerKey: 'sk-ant-test-key',
      fetchImpl: async () => jsonResponse(payload),
    });
    assert.equal(out.result.schemaVersion, 'orpad.workerResult.v1');
    assert.equal(out.result.summary, label);
  }
});

test('estimateCost is exactly zero for zero-token usage and never NaN', () => {
  const plugin = getProviderPlugin('anthropic');
  for (const promptTokens of [0, 100]) {
    for (const completionTokens of [0, 50]) {
      const cost = plugin.estimateCost({
        model: 'claude-3-5-sonnet-latest',
        promptTokens,
        completionTokens,
      });
      assert.equal(Number.isFinite(cost), true, `${promptTokens}/${completionTokens} produced non-finite cost`);
      assert.equal(cost >= 0, true);
    }
  }
  assert.equal(plugin.estimateCost({ model: 'claude-3-5-sonnet-latest', promptTokens: 0, completionTokens: 0 }), 0);
});

test('adapter-result with usage envelope still validates against orpad.workerResult.v1 schema', async () => {
  const validator = createContractValidator();
  const fixture = readFixture('messages-success.json');
  const adapter = createApiAgentAdapter({
    enabled: true,
    selection: {
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
    },
    providerKey: 'sk-ant-test-key',
    fetchImpl: async () => jsonResponse(fixture),
  });
  const result = await adapter.invoke(buildAdapterRequest());
  const validation = validator.validate('adapterResult', result);
  assert.equal(
    validation.ok,
    true,
    `adapter result with usage/apiSession must validate: ${JSON.stringify(validation.errors)}`,
  );
});

test('apiTrace appears only when use.tracing capability is granted', async () => {
  const fixture = readFixture('messages-success.json');
  const fetchImpl = async () => jsonResponse(fixture, { headers: { 'request-id': 'req_trace_test' } });
  // Without tracing capability requested: no apiTrace on the result.
  const baseAdapter = createApiAgentAdapter({
    enabled: true,
    selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
    providerKey: 'sk-ant-test-key',
    fetchImpl,
  });
  const noTrace = await baseAdapter.invoke(buildAdapterRequest());
  assert.equal(noTrace.apiTrace, undefined, 'apiTrace must be absent without explicit tracing capability');

  // With requested capability but no grant: assertTelemetryPolicy throws.
  const ungrantedAdapter = createApiAgentAdapter({
    enabled: true,
    selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
    providerKey: 'sk-ant-test-key',
    fetchImpl,
    requestedCapabilities: ['use.tracing'],
    capabilityGrants: [],
  });
  await assert.rejects(
    ungrantedAdapter.invoke(buildAdapterRequest()),
    error => error?.code === 'API_TRACING_NOT_GRANTED',
  );

  // With explicit grant: apiTrace is recorded as non-authoritative metadata.
  const grantedAdapter = createApiAgentAdapter({
    enabled: true,
    selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
    providerKey: 'sk-ant-test-key',
    fetchImpl,
    requestedCapabilities: ['use.tracing'],
    capabilityGrants: ['use.tracing'],
  });
  const granted = await grantedAdapter.invoke(buildAdapterRequest());
  assert.equal(granted.apiTrace?.providerId, 'anthropic');
  assert.equal(granted.apiTrace?.traceId, 'req_trace_test');
  assert.equal(granted.apiTrace?.authoritative, false);
});

test('createApiAgentAdapter useRegistry:false skips registry lookup and uses providerClient or fixtureResponse', async () => {
  let providerClientCalled = 0;
  const request = buildAdapterRequest();
  const stubResponse = {
    result: {
      schemaVersion: 'orpad.workerResult.v1',
      adapterCallId: request.adapterCallId,
      attemptId: request.attemptId,
      idempotencyKey: request.idempotencyKey,
      status: 'done',
      summary: 'stub',
      artifacts: ['a/b'],
    },
    usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    metadata: {},
    traceId: '',
  };
  const adapter = createApiAgentAdapter({
    enabled: true,
    useRegistry: false,
    selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
    providerClient: {
      async invoke() {
        providerClientCalled += 1;
        return stubResponse;
      },
    },
  });
  const result = await adapter.invoke(request);
  assert.equal(providerClientCalled, 1);
  assert.equal(result.summary, 'stub');
});
