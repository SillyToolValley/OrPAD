import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  classifyAdapterError,
  decideAttempts,
  dispatchAdapter,
  executeAttempt,
  ERROR_CLASSES,
  liftMachineAdapterV1ToV2,
  SCHEMA_VERSIONS,
} = require('../../src/main/orchestration-machine');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(__dirname, '../fixtures/orchestration-machine/per-node-selection');

function readFixture(file) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, file), 'utf8'));
}

function buildAdapterRequest(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSIONS.adapterRequest,
    adapter: 'router-test',
    runId: 'run_20260506_router',
    adapterCallId: 'adapter_call_001',
    attemptId: 'attempt_001',
    idempotencyKey: 'run_20260506_router:probe:attempt_001',
    nodePath: 'main/probe',
    taskKind: 'probe',
    workspaceMode: 'read-only',
    inputArtifacts: ['queue/inbox/x.json'],
    adapterResultPath: 'runs/run_20260506_router/adapters/adapter_call_001/response.json',
    outputContract: SCHEMA_VERSIONS.adapterResult,
    ...overrides,
  };
}

test('decideAttempts returns pipeline default when no node override', () => {
  const fixture = readFixture('v2-mixed-pipeline.json');
  const candidates = decideAttempts({ pipelineAdapter: fixture.pipeline });
  assert.equal(candidates[0].chosenBy, 'pipeline');
  assert.equal(candidates[0].selection.providerId, 'anthropic');
  assert.equal(candidates[0].selection.family, 'api');
  // Fallback entries follow the default
  const last = candidates[candidates.length - 1];
  assert.equal(last.chosenBy, 'fallback');
  assert.equal(last.selection.providerId, 'openai');
});

test('decideAttempts puts node override ahead of pipeline default', () => {
  const fixture = readFixture('v2-mixed-pipeline.json');
  const probeOverride = fixture.nodeOverrides['main/probe'];
  const candidates = decideAttempts({
    pipelineAdapter: fixture.pipeline,
    nodeAdapter: probeOverride,
  });
  assert.equal(candidates[0].chosenBy, 'node-override');
  assert.equal(candidates[0].selection.providerId, 'codex-cli');
  assert.equal(candidates[0].selection.family, 'cli');
  assert.equal(candidates[1].chosenBy, 'pipeline');
  assert.equal(candidates[1].selection.providerId, 'anthropic');
});

test('decideAttempts is monotonic: attemptIndex strictly increases', () => {
  const fixture = readFixture('v2-mixed-pipeline.json');
  const candidates = decideAttempts({
    pipelineAdapter: fixture.pipeline,
    nodeAdapter: fixture.nodeOverrides['main/probe'],
  });
  for (let i = 0; i < candidates.length; i += 1) {
    assert.equal(candidates[i].attemptIndex, i);
  }
});

test('decideAttempts lifts v1 codex-cli envelope into a v2 candidate', () => {
  const v1 = {
    type: 'codex-cli',
    enabled: true,
    workerSandbox: 'workspace-write',
    workerTimeoutMs: 900000,
  };
  const candidates = decideAttempts({ pipelineAdapter: v1 });
  assert.equal(candidates[0].chosenBy, 'pipeline');
  assert.equal(candidates[0].selection.providerId, 'codex-cli');
  assert.equal(candidates[0].selection.family, 'cli');
});

test('decideAttempts honors a slice offset for replay reconstruction', () => {
  const fixture = readFixture('v2-mixed-pipeline.json');
  const all = decideAttempts({
    pipelineAdapter: fixture.pipeline,
    nodeAdapter: fixture.nodeOverrides['main/probe'],
  });
  const fromOne = decideAttempts({
    pipelineAdapter: fixture.pipeline,
    nodeAdapter: fixture.nodeOverrides['main/probe'],
    attempt: 1,
  });
  assert.equal(fromOne.length, all.length - 1);
  assert.deepEqual(fromOne[0], all[1]);
});

test('classifyAdapterError maps known plugin codes to standard classes', () => {
  for (const cls of ERROR_CLASSES) {
    assert.equal(classifyAdapterError({ code: cls }), cls);
  }
  assert.equal(classifyAdapterError({ code: 'CONTRACT_VIOLATION' }), 'OUTPUT_VIOLATES_CONTRACT');
  assert.equal(classifyAdapterError({ code: 'API_KEY_LOCAL_STORAGE_FORBIDDEN' }), 'KEY_MISSING');
  assert.equal(classifyAdapterError({ code: 'API_ADAPTER_DISABLED' }), 'FATAL');
  assert.equal(classifyAdapterError({ code: 'CLI_ADAPTER_DISABLED' }), 'FATAL');
});

test('classifyAdapterError falls back to HTTP status codes when needed', () => {
  assert.equal(classifyAdapterError({ status: 401 }), 'KEY_MISSING');
  assert.equal(classifyAdapterError({ status: 403 }), 'KEY_MISSING');
  assert.equal(classifyAdapterError({ status: 429 }), 'RATE_LIMIT');
  assert.equal(classifyAdapterError({ status: 503 }), 'RETRYABLE');
  assert.equal(classifyAdapterError({ status: 502 }), 'RETRYABLE');
  assert.equal(classifyAdapterError({ status: 408 }), 'RETRYABLE');
  assert.equal(classifyAdapterError({ status: 400 }), 'OUTPUT_VIOLATES_CONTRACT');
  assert.equal(classifyAdapterError({ status: 422 }), 'OUTPUT_VIOLATES_CONTRACT');
  assert.equal(classifyAdapterError({}), 'FATAL');
  assert.equal(classifyAdapterError(null), 'FATAL');
});

test('classifyAdapterError preserves explicit classification field', () => {
  assert.equal(classifyAdapterError({ classification: 'BUDGET_EXCEEDED' }), 'BUDGET_EXCEEDED');
  // unknown classification falls through
  assert.equal(classifyAdapterError({ classification: 'NOT_REAL', code: 'KEY_MISSING' }), 'KEY_MISSING');
});

test('executeAttempt stamps routing onto request and routingDecision onto result', async () => {
  const candidate = {
    selection: {
      family: 'api',
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      qualityTier: 'standard',
      sessionStrategy: 'none',
      toolPolicy: 'none',
    },
    chosenBy: 'pipeline',
    attemptIndex: 0,
  };
  let invokedRequest = null;
  const invoker = async (request) => {
    invokedRequest = request;
    return { schemaVersion: 'orpad.workerResult.v1', status: 'done', summary: 'ok', artifacts: [] };
  };
  const events = [];
  const result = await executeAttempt(
    candidate,
    buildAdapterRequest(),
    {
      invoker,
      beforeAttempt: e => events.push(e),
      afterAttempt: e => events.push(e),
    },
  );
  assert.equal(invokedRequest.routing.chosenBy, 'pipeline');
  assert.equal(invokedRequest.routing.attemptIndex, 0);
  assert.equal(invokedRequest.providerSelection.providerId, 'anthropic');
  assert.equal(invokedRequest.providerSelection.family, 'api');
  assert.equal(result.routingDecision.providerId, 'anthropic');
  assert.equal(result.routingDecision.family, 'api');
  assert.equal(result.routingDecision.fallbackChainConsumed, 0);
  assert.equal(events.length, 2);
  assert.equal(events[0].eventType, 'adapter.attempt.started');
  assert.equal(events[1].eventType, 'adapter.attempt.finished');
  assert.equal(events[1].payload.classification, 'OK');
});

test('executeAttempt records attempt.finished with classification on invoker error', async () => {
  const candidate = {
    selection: { family: 'api', providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
    chosenBy: 'pipeline',
    attemptIndex: 0,
  };
  const events = [];
  const failingInvoker = async () => {
    const err = new Error('boom');
    err.code = 'RATE_LIMIT';
    throw err;
  };
  await assert.rejects(
    executeAttempt(candidate, buildAdapterRequest(), {
      invoker: failingInvoker,
      beforeAttempt: e => events.push(e),
      afterAttempt: e => events.push(e),
    }),
    error => error.classification === 'RATE_LIMIT',
  );
  assert.equal(events[1].eventType, 'adapter.attempt.finished');
  assert.equal(events[1].payload.status, 'failed');
  assert.equal(events[1].payload.classification, 'RATE_LIMIT');
});

test('dispatchAdapter routes through the registered plugin and stamps decision', async () => {
  const fixture = readFixture('v2-mixed-pipeline.json');
  const probeOverride = fixture.nodeOverrides['main/probe'];
  let calledFor = null;
  const result = await dispatchAdapter({
    pipelineAdapter: fixture.pipeline,
    nodeAdapter: probeOverride,
    request: buildAdapterRequest(),
    invoker: async (request) => {
      calledFor = request.providerSelection.providerId;
      return { schemaVersion: 'orpad.workerResult.v1', status: 'done', summary: 'ok', artifacts: [] };
    },
  });
  assert.equal(calledFor, 'codex-cli');
  assert.equal(result.routingDecision.providerId, 'codex-cli');
  assert.equal(result.routingDecision.family, 'cli');
  assert.equal(result.routingDecision.fallbackChainConsumed, 0);
});

test('dispatchAdapter without a node override calls the pipeline default plugin', async () => {
  const fixture = readFixture('v2-mixed-pipeline.json');
  let calledFor = null;
  const result = await dispatchAdapter({
    pipelineAdapter: fixture.pipeline,
    request: buildAdapterRequest(),
    invoker: async (request) => {
      calledFor = request.providerSelection.providerId;
      return { schemaVersion: 'orpad.workerResult.v1', status: 'done', summary: 'ok', artifacts: [] };
    },
  });
  assert.equal(calledFor, 'anthropic');
  assert.equal(result.routingDecision.providerId, 'anthropic');
});

test('dispatchAdapter rejects unregistered providers before invoker runs', async () => {
  let invoked = false;
  await assert.rejects(
    dispatchAdapter({
      pipelineAdapter: {
        schemaVersion: 'orpad.machineAdapter.v2',
        default: { family: 'api', providerId: 'mystery-provider', model: 'mystery-1' },
      },
      request: buildAdapterRequest(),
      invoker: async () => { invoked = true; return null; },
    }),
    error => error?.code === 'MACHINE_PROVIDER_PLUGIN_MISSING',
  );
  assert.equal(invoked, false);
});

test('dispatchAdapter requires an adapter request', async () => {
  await assert.rejects(
    dispatchAdapter({ pipelineAdapter: { schemaVersion: 'orpad.machineAdapter.v2', default: { family: 'cli', providerId: 'codex-cli', model: 'codex' } }, invoker: async () => ({}) }),
    error => error?.code === 'ROUTING_REQUEST_MISSING',
  );
});

test('per-node selection fixture exercises both anthropic and codex-cli plugins', async () => {
  const fixture = readFixture('v2-mixed-pipeline.json');
  const calls = [];
  const invoker = async (request) => {
    calls.push(request.providerSelection.providerId);
    return { schemaVersion: 'orpad.workerResult.v1', status: 'done', summary: 'ok', artifacts: [] };
  };
  // main/probe → node-override (codex-cli)
  await dispatchAdapter({
    pipelineAdapter: fixture.pipeline,
    nodeAdapter: fixture.nodeOverrides['main/probe'],
    request: buildAdapterRequest({ nodePath: 'main/probe', adapterCallId: 'probe_call', attemptId: 'probe_attempt', idempotencyKey: 'k1' }),
    invoker,
  });
  // main/worker → pipeline default (anthropic)
  await dispatchAdapter({
    pipelineAdapter: fixture.pipeline,
    nodeAdapter: fixture.nodeOverrides['main/worker'],
    request: buildAdapterRequest({ nodePath: 'main/worker', adapterCallId: 'worker_call', attemptId: 'worker_attempt', idempotencyKey: 'k2' }),
    invoker,
  });
  assert.deepEqual(calls.sort(), ['anthropic', 'codex-cli']);
});

test('adapter-request schema accepts the routing envelope produced by executeAttempt', () => {
  const orchestration = require('../../src/main/orchestration-machine');
  const validator = orchestration.createContractValidator();
  const candidate = {
    selection: {
      family: 'api',
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      qualityTier: 'standard',
      sessionStrategy: 'none',
      toolPolicy: 'none',
    },
    chosenBy: 'pipeline',
    attemptIndex: 0,
  };
  const enriched = orchestration.attachRoutingToRequest(buildAdapterRequest(), candidate);
  const result = validator.validate('adapterRequest', enriched);
  assert.equal(result.ok, true, `enriched request must validate: ${JSON.stringify(result.errors)}`);
});

test('adapter-result schema accepts the routingDecision envelope produced by executeAttempt', () => {
  const orchestration = require('../../src/main/orchestration-machine');
  const validator = orchestration.createContractValidator();
  const candidate = {
    selection: { family: 'api', providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
    chosenBy: 'pipeline',
    attemptIndex: 0,
  };
  const baseResult = {
    schemaVersion: 'orpad.workerResult.v1',
    adapterCallId: 'adapter_call_001',
    attemptId: 'attempt_001',
    idempotencyKey: 'k',
    status: 'done',
    summary: 'ok',
    artifacts: ['a/b'],
  };
  const enriched = orchestration.attachRoutingDecisionToResult(baseResult, candidate);
  const result = validator.validate('adapterResult', enriched);
  assert.equal(result.ok, true, `result with routingDecision must validate: ${JSON.stringify(result.errors)}`);
});
