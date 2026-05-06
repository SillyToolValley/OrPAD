import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  SCHEMA_VERSIONS,
  createContractValidator,
  liftMachineAdapterV1ToV2,
} = require('../../src/main/orchestration-machine');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(__dirname, '../fixtures/orchestration-machine/machine-adapter');

function readFixture(fileName) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, fileName), 'utf8'));
}

test('machineAdapter SCHEMA_VERSIONS is pinned to v2', () => {
  assert.equal(SCHEMA_VERSIONS.machineAdapter, 'orpad.machineAdapter.v2');
});

test('v2 default fixture validates against machineAdapter schema', () => {
  const validator = createContractValidator();
  const result = validator.validate('machineAdapter', readFixture('v2-default.json'));
  assert.equal(result.ok, true, `v2-default should validate: ${JSON.stringify(result.errors)}`);
});

test('v2 fixture with fallback, budget, and cache validates', () => {
  const validator = createContractValidator();
  const result = validator.validate('machineAdapter', readFixture('v2-with-fallback.json'));
  assert.equal(result.ok, true, `v2-with-fallback should validate: ${JSON.stringify(result.errors)}`);
});

test('liftMachineAdapterV1ToV2 lifts the legacy codex-cli envelope into v2', () => {
  const lifted = liftMachineAdapterV1ToV2(readFixture('v1-codex-cli.json'));
  const expected = readFixture('lift-expected-v1-codex-cli.json');
  assert.deepEqual(lifted, expected);
});

test('liftMachineAdapterV1ToV2 output validates as v2', () => {
  const validator = createContractValidator();
  const lifted = liftMachineAdapterV1ToV2(readFixture('v1-codex-cli.json'));
  const result = validator.validate('machineAdapter', lifted);
  assert.equal(result.ok, true, `lifted output should validate: ${JSON.stringify(result.errors)}`);
});

test('liftMachineAdapterV1ToV2 is idempotent on v2 input', () => {
  const v2 = readFixture('v2-default.json');
  assert.equal(liftMachineAdapterV1ToV2(v2), v2);
});

test('liftMachineAdapterV1ToV2 returns non-object input unchanged', () => {
  assert.equal(liftMachineAdapterV1ToV2(null), null);
  assert.equal(liftMachineAdapterV1ToV2(undefined), undefined);
  assert.equal(liftMachineAdapterV1ToV2('codex-cli'), 'codex-cli');
});

test('liftMachineAdapterV1ToV2 preserves enabled:false', () => {
  const lifted = liftMachineAdapterV1ToV2({ type: 'codex-cli', enabled: false });
  assert.equal(lifted.enabled, false);
  assert.equal(lifted.default.providerId, 'codex-cli');
});

test('machineAdapter schema rejects envelope missing schemaVersion', () => {
  const validator = createContractValidator();
  const sample = readFixture('v2-default.json');
  delete sample.schemaVersion;
  const result = validator.validate('machineAdapter', sample);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some(error => error.keyword === 'required' && error.params?.missingProperty === 'schemaVersion'), true);
});

test('machineAdapter schema rejects envelope missing default', () => {
  const validator = createContractValidator();
  const sample = readFixture('v2-default.json');
  delete sample.default;
  const result = validator.validate('machineAdapter', sample);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some(error => error.keyword === 'required' && error.params?.missingProperty === 'default'), true);
});

test('machineAdapter schema rejects default selection missing required fields', () => {
  const validator = createContractValidator();
  const sample = readFixture('v2-default.json');
  delete sample.default.providerId;
  const result = validator.validate('machineAdapter', sample);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some(error => error.params?.missingProperty === 'providerId'), true);
});

test('machineAdapter schema rejects unknown family', () => {
  const validator = createContractValidator();
  const sample = readFixture('v2-default.json');
  sample.default.family = 'mystery';
  const result = validator.validate('machineAdapter', sample);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some(error => error.keyword === 'enum'), true);
});

test('machineAdapter schema rejects unknown cache mode', () => {
  const validator = createContractValidator();
  const sample = readFixture('v2-with-fallback.json');
  sample.cache.mode = 'unknown';
  const result = validator.validate('machineAdapter', sample);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some(error => error.keyword === 'enum'), true);
});

test('adapter-request schema accepts optional providerSelection / routing / costBudget / cacheKey', () => {
  const validator = createContractValidator();
  const request = {
    schemaVersion: SCHEMA_VERSIONS.adapterRequest,
    adapter: 'cli-agent',
    runId: 'run_20260506_000001',
    adapterCallId: 'adapter_call_001',
    attemptId: 'attempt_001',
    idempotencyKey: 'run_20260506_000001:worker:attempt_001',
    nodePath: 'main/worker-loop/worker',
    taskKind: 'worker-loop',
    workspaceMode: 'read-only-plus-overlay',
    inputArtifacts: ['queue/claimed/item.json'],
    adapterResultPath: 'runs/run_20260506_000001/adapters/adapter_call_001/response.json',
    outputContract: SCHEMA_VERSIONS.adapterResult,
    providerSelection: {
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      family: 'api',
      qualityTier: 'standard',
      sessionStrategy: 'none',
      toolPolicy: 'none',
    },
    routing: {
      chosenBy: 'pipeline',
      attemptIndex: 0,
    },
    costBudget: {
      perCallUsd: 0.5,
      perRunRemainingUsd: 4.5,
    },
    cacheKey: 'sha256:abc123',
  };
  const result = validator.validate('adapterRequest', request);
  assert.equal(result.ok, true, `adapterRequest with routing fields should validate: ${JSON.stringify(result.errors)}`);
});

test('adapter-request schema rejects unknown chosenBy', () => {
  const validator = createContractValidator();
  const request = {
    schemaVersion: SCHEMA_VERSIONS.adapterRequest,
    adapter: 'cli-agent',
    runId: 'run_20260506_000001',
    adapterCallId: 'adapter_call_001',
    attemptId: 'attempt_001',
    idempotencyKey: 'run_20260506_000001:worker:attempt_001',
    nodePath: 'main/worker-loop/worker',
    taskKind: 'worker-loop',
    workspaceMode: 'read-only-plus-overlay',
    inputArtifacts: ['queue/claimed/item.json'],
    adapterResultPath: 'runs/run_20260506_000001/adapters/adapter_call_001/response.json',
    outputContract: SCHEMA_VERSIONS.adapterResult,
    routing: {
      chosenBy: 'random-roulette',
      attemptIndex: 0,
    },
  };
  const result = validator.validate('adapterRequest', request);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some(error => error.keyword === 'enum'), true);
});

test('adapter-result schema accepts optional usage / cacheHit / routingDecision', () => {
  const validator = createContractValidator();
  const result = validator.validate('adapterResult', {
    schemaVersion: SCHEMA_VERSIONS.adapterResult,
    adapterCallId: 'adapter_call_001',
    attemptId: 'attempt_001',
    idempotencyKey: 'run_20260506_000001:worker:attempt_001',
    status: 'done',
    summary: 'Implemented graph node type exposure.',
    artifacts: ['artifacts/work-items/item/proof.md'],
    usage: {
      promptTokens: 1200,
      completionTokens: 350,
      totalTokens: 1550,
      costEstimateUsd: 0.012,
      currency: 'USD',
    },
    cacheHit: false,
    routingDecision: {
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      family: 'api',
      fallbackChainConsumed: 0,
    },
  });
  assert.equal(result.ok, true, `adapterResult with usage/routingDecision should validate: ${JSON.stringify(result.errors)}`);
});

test('adapter-result schema rejects negative cost estimate', () => {
  const validator = createContractValidator();
  const result = validator.validate('adapterResult', {
    schemaVersion: SCHEMA_VERSIONS.adapterResult,
    adapterCallId: 'adapter_call_001',
    attemptId: 'attempt_001',
    idempotencyKey: 'run_20260506_000001:worker:attempt_001',
    status: 'done',
    summary: 'Negative cost should fail.',
    artifacts: ['artifacts/work-items/item/proof.md'],
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costEstimateUsd: -1,
      currency: 'USD',
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some(error => error.keyword === 'minimum'), true);
});

test('lift round-trip: every legacy field is preserved under default.legacy', () => {
  const v1 = readFixture('v1-codex-cli.json');
  const lifted = liftMachineAdapterV1ToV2(v1);
  for (const key of Object.keys(v1)) {
    if (key === 'enabled') continue;
    assert.equal(
      Object.prototype.hasOwnProperty.call(lifted.default.legacy, key),
      true,
      `legacy passthrough must preserve v1 field: ${key}`,
    );
  }
});

test('maintenance pipeline live machineAdapter lifts and validates', () => {
  const validator = createContractValidator();
  const pipelinePath = path.resolve(
    __dirname,
    '../../.orpad/pipelines/orpad-maintenance-quality-workstream-20260429/pipeline.or-pipeline',
  );
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf8'));
  const liveAdapter = pipeline.run?.machineAdapter;
  assert.equal(typeof liveAdapter, 'object');
  assert.equal(liveAdapter.type, 'codex-cli');
  const lifted = liftMachineAdapterV1ToV2(liveAdapter);
  const result = validator.validate('machineAdapter', lifted);
  assert.equal(result.ok, true, `live pipeline lift should validate: ${JSON.stringify(result.errors)}`);
  assert.equal(lifted.default.providerId, 'codex-cli');
  assert.equal(lifted.default.family, 'cli');
});
