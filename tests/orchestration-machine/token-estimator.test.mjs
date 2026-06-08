// Deterministic token/cost estimator + predictive budget guard/downgrade wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_EXPECTED_COMPLETION_TOKENS,
  createCandidateCostEstimator,
  estimateNextCostUsd,
  estimatePromptTokens,
  estimateTokensFromText,
  estimateUsageEnvelope,
  normalizeExpectedCompletionTokens,
  promptToText,
} from '../../src/main/orchestration-machine/router/token-estimator.js';
import { computeBudgetPressure } from '../../src/main/orchestration-machine/router/model-tier-resolver.js';
import { dispatchAdapter } from '../../src/main/orchestration-machine/router/adapter-router.js';
import { appendBudgetEntry } from '../../src/main/orchestration-machine/router/budget-ledger.js';

// A fake plugin priced like the catalog: $1 / Mtok in, $3 / Mtok out.
const FAKE_PLUGIN = {
  estimateCost({ promptTokens = 0, completionTokens = 0 } = {}) {
    return (promptTokens / 1_000_000) * 1 + (completionTokens / 1_000_000) * 3;
  },
};

// --- pure estimator -----------------------------------------------------------

test('estimateTokensFromText is deterministic and ceil-based', () => {
  assert.equal(estimateTokensFromText('', 4), 0);
  assert.equal(estimateTokensFromText('abcd', 4), 1);
  assert.equal(estimateTokensFromText('abcde', 4), 2); // ceil(5/4)
  assert.equal(estimateTokensFromText('a'.repeat(400), 4), 100);
  assert.equal(estimateTokensFromText('hello world', 4), estimateTokensFromText('hello world', 4));
});

test('estimateTokensFromText falls back to default chars/token for bad divisor', () => {
  assert.equal(estimateTokensFromText('abcd', 0), Math.ceil(4 / DEFAULT_CHARS_PER_TOKEN));
  assert.equal(estimateTokensFromText('abcd', -2), 1);
  assert.equal(estimateTokensFromText('abcd', undefined), 1);
});

test('token count is monotonic in prompt length', () => {
  const short = estimatePromptTokens('a short prompt');
  const long = estimatePromptTokens('a short prompt' + ' more text'.repeat(50));
  assert.ok(long > short);
});

test('promptToText handles strings, objects, and nullish', () => {
  assert.equal(promptToText('x'), 'x');
  assert.equal(promptToText(null), '');
  assert.equal(promptToText(undefined), '');
  assert.equal(promptToText({ a: 1 }), '{"a":1}');
});

test('normalizeExpectedCompletionTokens defaults and floors', () => {
  assert.equal(normalizeExpectedCompletionTokens(undefined), DEFAULT_EXPECTED_COMPLETION_TOKENS);
  assert.equal(normalizeExpectedCompletionTokens(-5), DEFAULT_EXPECTED_COMPLETION_TOKENS);
  assert.equal(normalizeExpectedCompletionTokens(10.9), 10);
  assert.equal(normalizeExpectedCompletionTokens(0), 0);
});

test('estimateNextCostUsd prices prompt + completion through the plugin', () => {
  // prompt "abcd" -> 1 prompt token; expectedCompletion 1000 -> cost = 1/1e6 + 1000*3/1e6
  const usd = estimateNextCostUsd({ plugin: FAKE_PLUGIN, model: 'm', prompt: 'abcd', expectedCompletionTokens: 1000 });
  assert.ok(Math.abs(usd - ((1 / 1e6) + (1000 * 3 / 1e6))) < 1e-12);
});

test('estimateNextCostUsd returns 0 for keyless/zero-cost or missing plugins', () => {
  assert.equal(estimateNextCostUsd({ plugin: null, prompt: 'abc' }), 0);
  const zeroPlugin = { estimateCost: () => 0 };
  assert.equal(estimateNextCostUsd({ plugin: zeroPlugin, prompt: 'abc' }), 0);
});

test('createCandidateCostEstimator prices a candidate via its plugin', () => {
  const estimator = createCandidateCostEstimator({ prompt: 'abcd', expectedCompletionTokens: 1000 });
  const usd = estimator({ candidate: { selection: { providerId: 'x', model: 'm' } }, plugin: FAKE_PLUGIN });
  assert.ok(usd > 0);
});

test('estimateUsageEnvelope returns a usage-shaped object with token counts and priced cost', () => {
  // prompt "abcd" -> 1 prompt token; expectedCompletion 1000.
  const env = estimateUsageEnvelope({ plugin: FAKE_PLUGIN, model: 'm', prompt: 'abcd', expectedCompletionTokens: 1000 });
  assert.equal(env.promptTokens, 1);
  assert.equal(env.completionTokens, 1000);
  assert.equal(env.totalTokens, 1001);
  assert.equal(env.currency, 'USD');
  assert.ok(Math.abs(env.costEstimateUsd - ((1 / 1e6) + (1000 * 3 / 1e6))) < 1e-12);
});

test('estimateUsageEnvelope keeps meaningful token counts even when the provider prices at $0 (CLI)', () => {
  // codex-cli-like: no estimateCost -> cost 0, but tokens still counted so the
  // token-budget guard and the meter have a non-zero signal.
  const env = estimateUsageEnvelope({ plugin: { id: 'codex-cli' }, model: 'codex', prompt: 'a'.repeat(4000) });
  assert.equal(env.costEstimateUsd, 0);
  assert.equal(env.promptTokens, 1000); // 4000 chars / 4
  assert.ok(env.totalTokens >= 1000);
});

// --- predictive budget pressure ----------------------------------------------

test('computeBudgetPressure folds the projected next cost into utilization', () => {
  // ledger 0.4 / perRun 1.0 = 0.4 (below 0.5). With projected 0.2 -> 0.6 (>=0.5).
  const reactive = computeBudgetPressure({
    budgetConfig: { perRunUsd: 1, downgradeAtUtilization: 0.5 },
    ledgerSummary: { totalCostUsd: 0.4 },
  });
  assert.equal(reactive.downgrade, false);
  const predictive = computeBudgetPressure({
    budgetConfig: { perRunUsd: 1, downgradeAtUtilization: 0.5 },
    ledgerSummary: { totalCostUsd: 0.4 },
    projectedNextCostUsd: 0.2,
  });
  assert.equal(predictive.downgrade, true);
  assert.equal(predictive.reason, 'projected-per-run-budget-pressure');
  assert.equal(predictive.projectedNextCostUsd, 0.2);
});

test('computeBudgetPressure with zero projection preserves reactive behavior', () => {
  const p = computeBudgetPressure({
    budgetConfig: { perRunUsd: 1, downgradeAtUtilization: 0.5 },
    ledgerSummary: { totalCostUsd: 0.6 },
    projectedNextCostUsd: 0,
  });
  assert.equal(p.downgrade, true);
  assert.equal(p.reason, 'per-run-budget-pressure');
});

// --- router integration: predictive downgrade on an empty ledger -------------

test('dispatchAdapter downgrades predictively from the projected next cost (empty ledger)', async () => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-token-est-'));
  try {
    // Ledger is EMPTY (0 spent). A reactive downgrade could never fire. With a
    // large estimated next call, the projected utilization crosses the
    // threshold and the downgrade fires on the very first call. opus deep ->
    // sonnet standard.
    const pipelineAdapter = {
      schemaVersion: 'orpad.machineAdapter.v2',
      default: { family: 'api', providerId: 'anthropic', qualityTier: 'deep', modelPolicy: 'cost-optimized' },
      budget: { perRunUsd: 1, downgradeAtUtilization: 0.5 },
    };
    const request = {
      runId: 'r', adapterCallId: 'c1', attemptId: 'a1', nodePath: 'main/worker', taskKind: 'worker',
    };
    const events = [];
    let received;
    await dispatchAdapter({
      pipelineAdapter,
      request,
      runRoot,
      // opus deep cheapest is claude-3-opus-latest ($15 in / $75 out). With a
      // big expected completion the projected cost dwarfs the $1 budget.
      expectedCompletionTokens: 100000,
      cachePrompt: 'do the work',
      invoker: async (req) => { received = req; return { status: 'done', usage: { costEstimateUsd: 0 } }; },
      beforeAttempt: async (evt) => { events.push(evt); },
    });
    const downgrade = events.find(e => e.eventType === 'adapter.model.downgraded');
    assert.ok(downgrade, 'expected a predictive adapter.model.downgraded event on an empty ledger');
    assert.equal(downgrade.payload.fromModel, 'claude-3-opus-latest');
    assert.equal(downgrade.payload.toModel, 'claude-3-5-sonnet-latest');
    assert.equal(downgrade.payload.reason, 'projected-per-run-budget-pressure');
    assert.equal(received.providerSelection.model, 'claude-3-5-sonnet-latest');
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test('dispatchAdapter does not predictively downgrade when projected cost stays under budget', async () => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-token-est-'));
  try {
    const pipelineAdapter = {
      schemaVersion: 'orpad.machineAdapter.v2',
      default: { family: 'api', providerId: 'anthropic', qualityTier: 'deep', modelPolicy: 'cost-optimized' },
      budget: { perRunUsd: 1000, downgradeAtUtilization: 0.5 },
    };
    const request = { runId: 'r', adapterCallId: 'c1', attemptId: 'a1', nodePath: 'main/worker', taskKind: 'worker' };
    const events = [];
    let received;
    await dispatchAdapter({
      pipelineAdapter,
      request,
      runRoot,
      expectedCompletionTokens: 100, // tiny -> projected cost << $1000
      cachePrompt: 'do the work',
      invoker: async (req) => { received = req; return { status: 'done', usage: { costEstimateUsd: 0 } }; },
      beforeAttempt: async (evt) => { events.push(evt); },
    });
    assert.equal(events.find(e => e.eventType === 'adapter.model.downgraded'), undefined);
    assert.equal(received.providerSelection.model, 'claude-3-opus-latest'); // deep tier kept
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test('dispatchAdapter pre-call guard now sees a non-zero estimate (budget.warning fires)', async () => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-token-est-'));
  try {
    // Explicit model (no downgrade), soft per-call budget the projected cost
    // exceeds -> the pre-call guard must emit a budget.warning with a non-zero
    // preCallEstimateUsd (previously it estimated $0 and never warned).
    const pipelineAdapter = {
      schemaVersion: 'orpad.machineAdapter.v2',
      default: { family: 'api', providerId: 'anthropic', model: 'claude-3-opus-latest', qualityTier: 'deep' },
      budget: { perCallUsd: 0.0001, hardStop: false },
    };
    const request = { runId: 'r', adapterCallId: 'c1', attemptId: 'a1', nodePath: 'main/worker', taskKind: 'worker' };
    const events = [];
    await dispatchAdapter({
      pipelineAdapter,
      request,
      runRoot,
      expectedCompletionTokens: 5000,
      cachePrompt: 'a fairly long prompt to price'.repeat(5),
      invoker: async () => ({ status: 'done', usage: { costEstimateUsd: 0 } }),
      beforeAttempt: async (evt) => { events.push(evt); },
    });
    const warn = events.find(e => e.eventType === 'budget.warning' && e.payload.phase === 'pre-call');
    assert.ok(warn, 'expected a pre-call budget.warning from a non-zero estimate');
    assert.ok(warn.payload.preCallEstimateUsd > 0, 'pre-call estimate must be non-zero');
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test('caller-supplied estimateNextCostUsd override still wins over the token estimator', async () => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-token-est-'));
  try {
    await appendBudgetEntry(runRoot, { usage: { costEstimateUsd: 0 } });
    const pipelineAdapter = {
      schemaVersion: 'orpad.machineAdapter.v2',
      default: { family: 'api', providerId: 'anthropic', model: 'claude-3-opus-latest', qualityTier: 'deep' },
      budget: { perCallUsd: 0.5, hardStop: false },
    };
    const request = { runId: 'r', adapterCallId: 'c1', attemptId: 'a1', nodePath: 'main/worker', taskKind: 'worker' };
    let sawOverride = false;
    const events = [];
    await dispatchAdapter({
      pipelineAdapter,
      request,
      runRoot,
      estimateNextCostUsd: async () => { sawOverride = true; return 9.99; },
      invoker: async () => ({ status: 'done', usage: { costEstimateUsd: 0 } }),
      beforeAttempt: async (evt) => { events.push(evt); },
    });
    assert.equal(sawOverride, true);
    const warn = events.find(e => e.eventType === 'budget.warning' && e.payload.phase === 'pre-call');
    assert.ok(warn);
    assert.equal(warn.payload.preCallEstimateUsd, 9.99);
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});
