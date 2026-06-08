import assert from 'node:assert/strict';
import test from 'node:test';

// HUD/VIZ: the renderer budget meter (createBudgetMeter) is now mounted in the
// Latest Run panel, so its cost/utilization math is user-visible. Lock the pure
// helpers (the DOM component itself needs a document and is covered by build/e2e).
import {
  formatPercent,
  formatTokens,
  formatUsd,
  summarizeAgainstBudget,
} from '../../src/renderer/orchestration/budget-meter.js';

test('budget-meter: summarizeAgainstBudget computes utilization, remaining, and overBudget vs perRunUsd', () => {
  const under = summarizeAgainstBudget(
    { totalCostUsd: 0.5, attemptCount: 3, cacheHitCount: 1 },
    { perRunUsd: 2 },
  );
  assert.equal(under.totalCostUsd, 0.5);
  assert.equal(under.perRunRemainingUsd, 1.5);
  assert.equal(under.utilization, 0.25);
  assert.equal(under.overBudget, false);
  assert.equal(under.attemptCount, 3);
  assert.equal(under.cacheHitCount, 1);

  const over = summarizeAgainstBudget({ totalCostUsd: 3 }, { perRunUsd: 2 });
  assert.equal(over.overBudget, true);
  assert.equal(over.utilization, 1, 'utilization clamps to 1');
  assert.equal(over.perRunRemainingUsd, 0, 'remaining clamps to 0');

  const noBudget = summarizeAgainstBudget({ totalCostUsd: 1.2345 }, {});
  assert.equal(noBudget.utilization, 0, 'no perRunUsd => 0 utilization (cost-only meter)');
  assert.equal(noBudget.perRunRemainingUsd, null);
  assert.equal(noBudget.overBudget, false);
});

test('budget-meter: summarizeAgainstBudget splits estimated vs measured and flags hasEstimates', () => {
  const snap = summarizeAgainstBudget(
    {
      totalCostUsd: 0.5, measuredCostUsd: 0.5, estimatedCostUsd: 0,
      totalTokens: 10000, measuredTokens: 1000, estimatedTokens: 9000,
      measuredEntryCount: 1, estimatedEntryCount: 3,
    },
    { perRunUsd: 2 },
  );
  assert.equal(snap.measuredCostUsd, 0.5);
  assert.equal(snap.estimatedTokens, 9000);
  assert.equal(snap.measuredTokens, 1000);
  assert.equal(snap.totalTokens, 10000);
  assert.equal(snap.hasEstimates, true, 'estimated entries present => hasEstimates');

  const measuredOnly = summarizeAgainstBudget(
    { totalCostUsd: 1, measuredCostUsd: 1, estimatedCostUsd: 0, estimatedEntryCount: 0, estimatedTokens: 0 },
    {},
  );
  assert.equal(measuredOnly.hasEstimates, false);
});

test('budget-meter: token budget drives utilization when no USD budget is set (CLI runs)', () => {
  const snap = summarizeAgainstBudget(
    { totalCostUsd: 0, totalTokens: 7500, estimatedTokens: 7500, estimatedEntryCount: 5 },
    { perRunTokens: 10000 },
  );
  // USD utilization is 0 (no perRunUsd), but the token ceiling moves the bar.
  assert.equal(snap.utilization, 0);
  assert.equal(snap.tokenUtilization, 0.75);
  assert.equal(snap.displayUtilization, 0.75);
  assert.equal(snap.perRunTokensRemaining, 2500);
  assert.equal(snap.overTokenBudget, false);

  const over = summarizeAgainstBudget({ totalTokens: 12000 }, { perRunTokens: 10000 });
  assert.equal(over.overTokenBudget, true);
  assert.equal(over.tokenUtilization, 1, 'token utilization clamps to 1');
  assert.equal(over.perRunTokensRemaining, 0);
});

test('budget-meter: estimate marker is gated per displayed dimension (no false mark on all-measured $)', () => {
  // A flat-rate CLI worker contributes estimated TOKENS but $0 estimated cost.
  // The USD cost figure is then 100% measured, so its "≈" marker must be OFF,
  // while the token dimension is estimated.
  const snap = summarizeAgainstBudget(
    {
      totalCostUsd: 0.5, measuredCostUsd: 0.5, estimatedCostUsd: 0,
      totalTokens: 9000, measuredTokens: 0, estimatedTokens: 9000,
      estimatedEntryCount: 3, measuredEntryCount: 0,
    },
    { perRunUsd: 2 },
  );
  assert.equal(snap.hasEstimates, true, 'ledger has estimates overall');
  assert.equal(snap.hasEstimatedCost, false, 'the $ total is fully measured -> no cost marker');
  assert.equal(snap.hasEstimatedTokens, true, 'tokens are estimated -> token marker');

  // When a measured-cost estimate DOES exist (e.g. API usage estimate), the cost
  // dimension is correctly marked.
  const costEst = summarizeAgainstBudget(
    { totalCostUsd: 1, measuredCostUsd: 0.4, estimatedCostUsd: 0.6, estimatedEntryCount: 1 },
    { perRunUsd: 2 },
  );
  assert.equal(costEst.hasEstimatedCost, true);
});

test('budget-meter: displayUtilization is the max of USD and token utilization when both budgets are set', () => {
  // USD utilization 0.8 > token utilization 0.3 -> the bar tracks the larger.
  const snap = summarizeAgainstBudget(
    { totalCostUsd: 8, totalTokens: 3000 },
    { perRunUsd: 10, perRunTokens: 10000 },
  );
  assert.equal(snap.utilization, 0.8);
  assert.equal(snap.tokenUtilization, 0.3);
  assert.equal(snap.displayUtilization, 0.8, 'bar tracks the larger (USD) dimension');
});

test('budget-meter: formatTokens renders compact k/M units', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(2_500_000), '2.5M');
  assert.equal(formatTokens(undefined), '0');
});

test('budget-meter: formatUsd / formatPercent render the labels the meter shows', () => {
  assert.equal(formatUsd(1.23456), '$1.2346');
  assert.equal(formatUsd(0), '$0.0000');
  assert.equal(formatUsd(undefined), '$0.0000');
  assert.equal(formatPercent(0.25), '25%');
  assert.equal(formatPercent(1), '100%');
  assert.equal(formatPercent(undefined), '0%');
});
