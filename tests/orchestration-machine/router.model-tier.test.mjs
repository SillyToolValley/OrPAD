// Tier-aware + budget-aware model selection (model-tier-resolver + router wiring).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  blendedCostPerMTokens,
  cheapestModelForTier,
  computeBudgetPressure,
  demoteTier,
  normalizeModelPolicy,
  normalizeTier,
  rankTier,
  resolveModel,
} from '../../src/main/orchestration-machine/router/model-tier-resolver.js';
import {
  decideAttempts,
  dispatchAdapter,
  resolveSelectionModel,
} from '../../src/main/orchestration-machine/router/adapter-router.js';
import { createContractValidator } from '../../src/main/orchestration-machine/contracts.js';
import { appendBudgetEntry } from '../../src/main/orchestration-machine/router/budget-ledger.js';

// --- pure resolver primitives -------------------------------------------------

test('tier ranking and demotion are deterministic and clamped', () => {
  assert.equal(normalizeTier('Standard'), 'standard');
  assert.equal(normalizeTier('nonsense'), 'standard');
  assert.ok(rankTier('fast') < rankTier('standard'));
  assert.ok(rankTier('standard') < rankTier('deep'));
  assert.equal(demoteTier('deep', 1), 'standard');
  assert.equal(demoteTier('standard', 1), 'fast');
  assert.equal(demoteTier('fast', 1), 'draft');
  assert.equal(demoteTier('draft', 1), 'draft'); // clamp at floor
  assert.equal(demoteTier('deep', 5), 'draft'); // clamp on large step
});

test('cheapestModelForTier picks the lowest blended-cost model in a tier', () => {
  // OpenAI ships three "standard" models; gpt-4o-mini is the cheapest.
  const openaiStandard = cheapestModelForTier('openai', 'standard');
  assert.equal(openaiStandard.id, 'gpt-4o-mini');
  // Anthropic has one model per tier.
  assert.equal(cheapestModelForTier('anthropic', 'fast').id, 'claude-3-5-haiku-latest');
  assert.equal(cheapestModelForTier('anthropic', 'deep').id, 'claude-3-opus-latest');
});

test('blendedCostPerMTokens weights output and treats keyless/zero as cheapest', () => {
  const mini = blendedCostPerMTokens({ costPerMTokensIn: 0.15, costPerMTokensOut: 0.60 });
  const big = blendedCostPerMTokens({ costPerMTokensIn: 2.5, costPerMTokensOut: 10 });
  assert.ok(mini < big);
  assert.equal(blendedCostPerMTokens({ costPerMTokensIn: 0, costPerMTokensOut: 0 }), 0);
  assert.equal(blendedCostPerMTokens(null), Infinity);
});

test('resolveModel preserves an explicit model when not cost-optimized', () => {
  const decision = resolveModel({ providerId: 'anthropic', model: 'claude-3-5-sonnet-latest', qualityTier: 'standard' });
  assert.equal(decision.resolvedBy, 'explicit');
  assert.equal(decision.model, 'claude-3-5-sonnet-latest');
});

test('resolveModel picks tier-cheapest when model is omitted', () => {
  const decision = resolveModel({ providerId: 'openai', qualityTier: 'standard' });
  assert.equal(decision.resolvedBy, 'tier-cheapest');
  assert.equal(decision.model, 'gpt-4o-mini');
});

test('resolveModel overrides a pinned model when cost-optimized', () => {
  const decision = resolveModel({
    providerId: 'openai',
    model: 'gpt-4o', // pinned but optimization requested
    qualityTier: 'standard',
    modelPolicy: 'cost-optimized',
  });
  assert.equal(decision.resolvedBy, 'tier-cheapest');
  assert.equal(decision.model, 'gpt-4o-mini');
});

test('resolveModel falls back to provider default when no catalog models exist', () => {
  const decision = resolveModel({ providerId: 'openai-compatible', qualityTier: 'standard' });
  assert.equal(decision.resolvedBy, 'provider-default');
  assert.equal(decision.model, 'gpt-4o-mini'); // catalog defaultModel for openai-compatible
});

test('resolveModel demotes a tier under budget pressure', () => {
  const decision = resolveModel({
    providerId: 'anthropic',
    qualityTier: 'deep',
    modelPolicy: 'cost-optimized',
    budgetPressure: { downgrade: true },
  });
  assert.equal(decision.resolvedBy, 'budget-downgrade');
  assert.equal(decision.requestedTier, 'deep');
  assert.equal(decision.qualityTier, 'standard');
  assert.equal(decision.model, 'claude-3-5-sonnet-latest');
});

// --- budget pressure ----------------------------------------------------------

test('computeBudgetPressure never downgrades without a per-run budget', () => {
  const pressure = computeBudgetPressure({ budgetConfig: {}, ledgerSummary: { totalCostUsd: 99 } });
  assert.equal(pressure.downgrade, false);
  assert.equal(pressure.reason, 'no-per-run-budget');
});

test('computeBudgetPressure downgrades at/above the utilization threshold', () => {
  const below = computeBudgetPressure({
    budgetConfig: { perRunUsd: 10, downgradeAtUtilization: 0.8 },
    ledgerSummary: { totalCostUsd: 7 },
  });
  assert.equal(below.downgrade, false);
  const at = computeBudgetPressure({
    budgetConfig: { perRunUsd: 10, downgradeAtUtilization: 0.8 },
    ledgerSummary: { totalCostUsd: 8 },
  });
  assert.equal(at.downgrade, true);
  assert.equal(at.reason, 'per-run-budget-pressure');
});

// --- router integration: decideAttempts --------------------------------------

test('decideAttempts leaves explicit selections byte-identical (no modelResolution)', () => {
  const pipelineAdapter = {
    schemaVersion: 'orpad.machineAdapter.v2',
    default: { family: 'api', providerId: 'anthropic', model: 'claude-3-5-sonnet-latest', qualityTier: 'standard' },
  };
  const [candidate] = decideAttempts({ pipelineAdapter });
  assert.equal(candidate.selection.model, 'claude-3-5-sonnet-latest');
  assert.equal(candidate.modelResolution, undefined);
});

test('decideAttempts resolves a cost-optimized default to the tier-cheapest model', () => {
  const pipelineAdapter = {
    schemaVersion: 'orpad.machineAdapter.v2',
    default: { family: 'api', providerId: 'openai', qualityTier: 'standard', modelPolicy: 'cost-optimized' },
  };
  const [candidate] = decideAttempts({ pipelineAdapter });
  assert.equal(candidate.selection.model, 'gpt-4o-mini');
  assert.equal(candidate.modelResolution.resolvedBy, 'tier-cheapest');
});

test('decideAttempts resolves a node override with an omitted model from its tier', () => {
  const pipelineAdapter = {
    schemaVersion: 'orpad.machineAdapter.v2',
    default: { family: 'api', providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
  };
  const nodeAdapter = { providerId: 'openai', qualityTier: 'standard', modelPolicy: 'cost-optimized' };
  const attempts = decideAttempts({ pipelineAdapter, nodeAdapter });
  assert.equal(attempts[0].chosenBy, 'node-override');
  assert.equal(attempts[0].selection.model, 'gpt-4o-mini');
  assert.equal(attempts[1].chosenBy, 'pipeline');
  assert.equal(attempts[1].selection.model, 'claude-3-5-sonnet-latest');
});

test('resolveSelectionModel is a no-op for explicit non-optimized selections', () => {
  const selection = { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest', qualityTier: 'standard' };
  const { selection: out, decision } = resolveSelectionModel(selection);
  assert.equal(out, selection);
  assert.equal(decision, null);
});

// --- router integration: dispatchAdapter budget-aware downgrade ---------------

test('dispatchAdapter downgrades the model under per-run budget pressure', async () => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-model-tier-'));
  try {
    // Seed the ledger so utilization (0.6 / 1.0) exceeds the 0.5 threshold.
    await appendBudgetEntry(runRoot, { usage: { costEstimateUsd: 0.6 } });

    const pipelineAdapter = {
      schemaVersion: 'orpad.machineAdapter.v2',
      default: { family: 'api', providerId: 'anthropic', qualityTier: 'deep', modelPolicy: 'cost-optimized' },
      budget: { perRunUsd: 1, downgradeAtUtilization: 0.5 },
    };
    const request = {
      runId: 'run-model-tier',
      adapterCallId: 'call-1',
      attemptId: 'attempt-1',
      nodePath: 'main/worker',
      taskKind: 'worker',
    };
    const events = [];
    let received;
    const result = await dispatchAdapter({
      pipelineAdapter,
      request,
      runRoot,
      invoker: async (req) => {
        received = req;
        return { status: 'done', usage: { promptTokens: 0, completionTokens: 0, costEstimateUsd: 0 } };
      },
      beforeAttempt: async (evt) => { events.push(evt); },
    });

    const downgrade = events.find(e => e.eventType === 'adapter.model.downgraded');
    assert.ok(downgrade, 'expected an adapter.model.downgraded event');
    assert.equal(downgrade.payload.fromModel, 'claude-3-opus-latest');
    assert.equal(downgrade.payload.toModel, 'claude-3-5-sonnet-latest');
    assert.equal(downgrade.payload.requestedTier, 'deep');
    assert.equal(downgrade.payload.effectiveTier, 'standard');
    // The actual invoke used the downgraded model.
    assert.equal(received.providerSelection.model, 'claude-3-5-sonnet-latest');
    assert.equal(result.routingDecision.model, 'claude-3-5-sonnet-latest');
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test('dispatchAdapter keeps the tier model when the run is within budget', async () => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-model-tier-'));
  try {
    await appendBudgetEntry(runRoot, { usage: { costEstimateUsd: 0.1 } }); // 10% utilization
    const pipelineAdapter = {
      schemaVersion: 'orpad.machineAdapter.v2',
      default: { family: 'api', providerId: 'anthropic', qualityTier: 'deep', modelPolicy: 'cost-optimized' },
      budget: { perRunUsd: 1, downgradeAtUtilization: 0.5 },
    };
    const request = { runId: 'r', adapterCallId: 'c', attemptId: 'a', nodePath: 'main/worker', taskKind: 'worker' };
    let received;
    await dispatchAdapter({
      pipelineAdapter,
      request,
      runRoot,
      invoker: async (req) => { received = req; return { status: 'done', usage: { costEstimateUsd: 0 } }; },
    });
    // deep tier cheapest = opus; no downgrade because utilization < threshold.
    assert.equal(received.providerSelection.model, 'claude-3-opus-latest');
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

// --- schema acceptance --------------------------------------------------------

test('v2 schema accepts modelPolicy and budget.downgradeAtUtilization', () => {
  const validator = createContractValidator();
  const adapter = {
    schemaVersion: 'orpad.machineAdapter.v2',
    // Cost-optimized authoring uses model:"auto" as a placeholder; the resolver
    // replaces it with the tier-cheapest concrete model at run time.
    default: { family: 'api', providerId: 'openai', model: 'auto', qualityTier: 'standard', modelPolicy: 'cost-optimized' },
    budget: { perRunUsd: 5, downgradeAtUtilization: 0.75 },
  };
  const result = validator.validate('machineAdapter', adapter);
  assert.equal(result.ok, true, `expected valid adapter, got: ${JSON.stringify(result.errors)}`);
});

test('normalizeModelPolicy coerces unknown policies to explicit (runtime contract)', () => {
  // The schema is intentionally permissive (additionalProperties:true), matching
  // how qualityTier is handled; unknown policies are normalized at run time.
  assert.equal(normalizeModelPolicy('free-for-all'), 'explicit');
  assert.equal(normalizeModelPolicy('cost-optimized'), 'cost-optimized');
  const decision = resolveModel({ providerId: 'openai', model: 'gpt-4o', qualityTier: 'standard', modelPolicy: 'free-for-all' });
  assert.equal(decision.resolvedBy, 'explicit');
  assert.equal(decision.model, 'gpt-4o');
});
