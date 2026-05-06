import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
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
  assert.equal(classifyAnthropicHttpStatus(400), 'CONTRACT_VIOLATION');
  assert.equal(classifyAnthropicHttpStatus(422), 'CONTRACT_VIOLATION');
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
    error => error?.code === 'CONTRACT_VIOLATION',
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
  const fetchImpl = async (url, init) => {
    capturedBody = init?.body || '';
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
});
