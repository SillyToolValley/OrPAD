import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  BUDGET_LEDGER_SCHEMA_VERSION,
  appendBudgetEntry,
  assertWithinBudget,
  budgetViolations,
  dispatchAdapter,
  readBudgetLedger,
  SCHEMA_VERSIONS,
  summarizeLedger,
} = require('../../src/main/orchestration-machine');

async function makeRunRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'orpad-budget-ledger-'));
}

function buildAdapterRequest(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSIONS.adapterRequest,
    adapter: 'router-test',
    runId: 'run_20260506_budget',
    adapterCallId: 'adapter_call_001',
    attemptId: 'attempt_001',
    idempotencyKey: 'run_20260506_budget:probe:attempt_001',
    nodePath: 'main/probe',
    taskKind: 'probe',
    workspaceMode: 'read-only',
    inputArtifacts: ['queue/inbox/x.json'],
    adapterResultPath: 'runs/run_20260506_budget/adapters/adapter_call_001/response.json',
    outputContract: SCHEMA_VERSIONS.adapterResult,
    ...overrides,
  };
}

function v2Pipeline(overrides = {}) {
  return {
    schemaVersion: 'orpad.machineAdapter.v2',
    enabled: true,
    default: {
      family: 'api',
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      qualityTier: 'standard',
      sessionStrategy: 'none',
      toolPolicy: 'none',
      sandbox: null,
      approvalPolicy: 'never',
      timeoutMs: 600000,
      ephemeral: true,
    },
    budget: {
      perCallUsd: 1.0,
      perRunUsd: 2.0,
      hardStop: true,
    },
    ...overrides,
  };
}

function workerResult(usage) {
  return {
    schemaVersion: 'orpad.workerResult.v1',
    adapterCallId: 'adapter_call_001',
    attemptId: 'attempt_001',
    idempotencyKey: 'run_20260506_budget:probe:attempt_001',
    status: 'done',
    summary: 'ok',
    artifacts: ['a/b'],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, currency: 'USD', ...usage },
  };
}

test('appendBudgetEntry persists usage in atomic JSON file with monotonic sequence', async () => {
  const runRoot = await makeRunRoot();
  try {
    await appendBudgetEntry(runRoot, {
      runId: 'run_x',
      adapterCallId: 'a1',
      attemptId: 'att1',
      nodePath: 'main/probe',
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, costEstimateUsd: 0.5 },
    });
    await appendBudgetEntry(runRoot, {
      runId: 'run_x',
      adapterCallId: 'a2',
      attemptId: 'att2',
      nodePath: 'main/worker',
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300, costEstimateUsd: 1.0 },
    });
    const ledger = await readBudgetLedger(runRoot);
    assert.equal(ledger.schemaVersion, BUDGET_LEDGER_SCHEMA_VERSION);
    assert.equal(ledger.entries.length, 2);
    assert.equal(ledger.entries[0].sequence, 0);
    assert.equal(ledger.entries[1].sequence, 1);
    assert.equal(ledger.entries[0].costEstimateUsd, 0.5);
    assert.equal(ledger.entries[1].costEstimateUsd, 1.0);
    assert.equal(ledger.entries[0].providerId, 'anthropic');
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('appendBudgetEntry is idempotent on (adapterCallId, attemptId)', async () => {
  const runRoot = await makeRunRoot();
  try {
    const inputs = {
      runId: 'run_x',
      adapterCallId: 'a1',
      attemptId: 'att1',
      nodePath: 'main/probe',
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, costEstimateUsd: 0.5 },
    };
    const first = await appendBudgetEntry(runRoot, inputs);
    const second = await appendBudgetEntry(runRoot, inputs);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    const ledger = await readBudgetLedger(runRoot);
    assert.equal(ledger.entries.length, 1);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('summarizeLedger aggregates totals and per-provider rollups', () => {
  const ledger = {
    schemaVersion: BUDGET_LEDGER_SCHEMA_VERSION,
    runId: 'run_x',
    entries: [
      { providerId: 'anthropic', costEstimateUsd: 0.5, promptTokens: 100, completionTokens: 50, cacheHit: false },
      { providerId: 'anthropic', costEstimateUsd: 1.5, promptTokens: 200, completionTokens: 75, cacheHit: false },
      { providerId: 'codex-cli', costEstimateUsd: 0, promptTokens: 0, completionTokens: 0, cacheHit: false },
      { providerId: 'anthropic', costEstimateUsd: 0, promptTokens: 100, completionTokens: 50, cacheHit: true },
    ],
  };
  const summary = summarizeLedger(ledger);
  assert.equal(summary.totalCostUsd, 2.0);
  assert.equal(summary.attemptCount, 4);
  assert.equal(summary.cacheHitCount, 1);
  assert.equal(summary.totalPromptTokens, 400);
  assert.equal(summary.totalCompletionTokens, 175);
  const anthropic = summary.byProvider.find(p => p.providerId === 'anthropic');
  assert.equal(anthropic.attemptCount, 3);
  assert.equal(anthropic.totalCostUsd, 2.0);
});

test('budgetViolations reports per-call and per-run breaches separately', () => {
  const ledger = { entries: [{ costEstimateUsd: 1.0 }] };
  const viol = budgetViolations({ perCallUsd: 0.5, perRunUsd: 1.5, hardStop: true }, ledger, 0.6);
  assert.equal(viol.length, 2);
  assert.equal(viol[0].kind, 'per-call');
  assert.equal(viol[1].kind, 'per-run');
  assert.equal(viol[1].priorTotalUsd, 1.0);
});

test('assertWithinBudget throws BUDGET_EXCEEDED when hardStop is true', () => {
  const ledger = { entries: [{ costEstimateUsd: 0.5 }] };
  assert.throws(
    () => assertWithinBudget({ perCallUsd: 1.0, perRunUsd: 1.0, hardStop: true }, ledger, 0.7),
    error => error.code === 'BUDGET_EXCEEDED' && error.classification === 'BUDGET_EXCEEDED' && Array.isArray(error.violations),
  );
});

test('assertWithinBudget returns ok=false but does not throw when hardStop is false', () => {
  const ledger = { entries: [{ costEstimateUsd: 0.5 }] };
  const guard = assertWithinBudget({ perCallUsd: 1.0, perRunUsd: 1.0, hardStop: false }, ledger, 0.7);
  assert.equal(guard.ok, false);
  assert.equal(guard.hardStop, false);
  assert.equal(guard.violations.length, 1);
});

test('dispatchAdapter writes a ledger entry when the invoker returns usage', async () => {
  const runRoot = await makeRunRoot();
  try {
    const result = await dispatchAdapter({
      runRoot,
      pipelineAdapter: v2Pipeline(),
      request: buildAdapterRequest(),
      invoker: async () => workerResult({ promptTokens: 100, completionTokens: 50, totalTokens: 150, costEstimateUsd: 0.5 }),
    });
    assert.equal(result.routingDecision.providerId, 'anthropic');
    const ledger = await readBudgetLedger(runRoot);
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].costEstimateUsd, 0.5);
    assert.equal(ledger.entries[0].providerId, 'anthropic');
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('dispatchAdapter blocks an attempt that would exceed perRunUsd with hardStop true', async () => {
  const runRoot = await makeRunRoot();
  try {
    const pipeline = v2Pipeline({ budget: { perCallUsd: 5, perRunUsd: 1, hardStop: true } });
    // Seed the ledger up to 0.9 USD so the next call's pre-call estimate triggers per-run breach.
    await appendBudgetEntry(runRoot, {
      runId: 'run_x',
      adapterCallId: 'seed',
      attemptId: 'seed',
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costEstimateUsd: 0.9 },
    });

    let invokerCalls = 0;
    await assert.rejects(
      dispatchAdapter({
        runRoot,
        pipelineAdapter: pipeline,
        request: buildAdapterRequest({ adapterCallId: 'next', attemptId: 'next', idempotencyKey: 'next' }),
        invoker: async () => {
          invokerCalls += 1;
          return workerResult({ promptTokens: 100, completionTokens: 50, totalTokens: 150, costEstimateUsd: 0.5 });
        },
        // Force the pre-call estimate to a value the budget will reject.
        estimateNextCostUsd: () => 0.5,
      }),
      error => error?.code === 'BUDGET_EXCEEDED' && error?.classification === 'BUDGET_EXCEEDED',
    );
    assert.equal(invokerCalls, 0, 'invoker must not run when hardStop blocks the attempt');
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('dispatchAdapter emits a budget.warning instead of throwing when hardStop is false', async () => {
  const runRoot = await makeRunRoot();
  try {
    const pipeline = v2Pipeline({ budget: { perCallUsd: 5, perRunUsd: 1, hardStop: false } });
    await appendBudgetEntry(runRoot, {
      runId: 'run_x',
      adapterCallId: 'seed',
      attemptId: 'seed',
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costEstimateUsd: 0.9 },
    });
    const events = [];
    const result = await dispatchAdapter({
      runRoot,
      pipelineAdapter: pipeline,
      request: buildAdapterRequest({ adapterCallId: 'next', attemptId: 'next', idempotencyKey: 'next' }),
      invoker: async () => workerResult({ promptTokens: 0, completionTokens: 0, totalTokens: 0, costEstimateUsd: 0.5 }),
      estimateNextCostUsd: () => 0.5,
      beforeAttempt: e => events.push(e),
      afterAttempt: e => events.push(e),
    });
    assert.equal(result.routingDecision.providerId, 'anthropic');
    const warnings = events.filter(e => e.eventType === 'budget.warning');
    assert.equal(warnings.length >= 1, true, 'expected at least one budget.warning event');
    assert.equal(warnings[0].payload.violations.length >= 1, true);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('dispatchAdapter records cacheHit=true entries with zero cost', async () => {
  const runRoot = await makeRunRoot();
  try {
    await dispatchAdapter({
      runRoot,
      pipelineAdapter: v2Pipeline(),
      request: buildAdapterRequest(),
      invoker: async () => ({
        ...workerResult({ promptTokens: 0, completionTokens: 0, totalTokens: 0, costEstimateUsd: 0 }),
        cacheHit: true,
      }),
    });
    const ledger = await readBudgetLedger(runRoot);
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].cacheHit, true);
    assert.equal(ledger.entries[0].costEstimateUsd, 0);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('readBudgetLedger returns empty schema when no file exists', async () => {
  const runRoot = await makeRunRoot();
  try {
    const ledger = await readBudgetLedger(runRoot);
    assert.equal(ledger.schemaVersion, BUDGET_LEDGER_SCHEMA_VERSION);
    assert.deepEqual(ledger.entries, []);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('budget ledger never embeds raw API key material', async () => {
  const runRoot = await makeRunRoot();
  try {
    await appendBudgetEntry(runRoot, {
      runId: 'run_x',
      adapterCallId: 'a1',
      attemptId: 'att1',
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        costEstimateUsd: 0.5,
        // Even if a buggy caller smuggles a key into usage, the ledger writer
        // must drop it because ledgerEntryFromUsage only copies known fields.
        apiKey: 'sk-LEDGER-LEAK-CHECK-1234',
      },
    });
    const raw = await fs.readFile(path.join(runRoot, 'budget-ledger.json'), 'utf8');
    assert.equal(raw.includes('sk-LEDGER-LEAK-CHECK-1234'), false);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});
