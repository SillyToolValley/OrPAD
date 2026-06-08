// Worker-path budget governance (R4): estimate + pre-spawn guard + estimated
// ledger recording for flat-rate CLI workers that report no usage.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertWorkerBudget,
  estimateWorkerBudget,
  recordWorkerBudgetEstimate,
  workerPromptForEstimate,
} from '../../src/main/orchestration-machine/router/worker-budget.js';
import {
  appendBudgetEntry,
  readBudgetLedger,
  summarizeLedger,
} from '../../src/main/orchestration-machine/router/budget-ledger.js';

async function makeRunRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'orpad-worker-budget-'));
}

// A priced (API-like) plugin and a $0 (CLI-like) plugin.
const PRICED_PLUGIN = {
  id: 'anthropic',
  family: 'api',
  estimateCost: ({ promptTokens = 0, completionTokens = 0 } = {}) =>
    (promptTokens / 1e6) * 3 + (completionTokens / 1e6) * 15,
};
const CLI_PLUGIN = { id: 'codex-cli', family: 'cli', defaultModel: 'codex' };

test('workerPromptForEstimate composes stdin + args + task text length-faithfully', () => {
  const prompt = workerPromptForEstimate(
    { commandSpec: { stdin: 'PROMPT BODY', args: ['--flag', 'value'] } },
    'do the MSW task',
  );
  assert.ok(prompt.includes('PROMPT BODY'));
  assert.ok(prompt.includes('--flag value'));
  assert.ok(prompt.includes('do the MSW task'));
});

test('workerPromptForEstimate tolerates a missing commandSpec', () => {
  assert.equal(workerPromptForEstimate({}, ''), '');
  assert.equal(workerPromptForEstimate(undefined, 'only task'), 'only task');
});

test('estimateWorkerBudget prices a measurable cost for API-family plugins', () => {
  const est = estimateWorkerBudget({
    plugin: PRICED_PLUGIN, model: 'claude-3-5-sonnet-latest',
    prompt: 'a'.repeat(4000), expectedCompletionTokens: 1000,
  });
  assert.equal(est.estimateTokens, 1000 + 1000); // 4000/4 prompt + 1000 completion
  assert.ok(est.estimateUsd > 0, 'API plugin yields a non-zero $ estimate');
  assert.equal(est.usage.totalTokens, est.estimateTokens);
});

test('estimateWorkerBudget yields $0 but real tokens for CLI plugins', () => {
  const est = estimateWorkerBudget({
    plugin: CLI_PLUGIN, model: 'codex', prompt: 'a'.repeat(8000),
  });
  assert.equal(est.estimateUsd, 0);
  assert.equal(est.usage.promptTokens, 2000); // 8000/4
  assert.ok(est.estimateTokens >= 2000);
});

test('assertWorkerBudget is a no-op (ok) without runRoot or budget', async () => {
  const a = await assertWorkerBudget({});
  assert.equal(a.ok, true);
  const runRoot = await makeRunRoot();
  try {
    const b = await assertWorkerBudget({ runRoot, budgetConfig: null, estimateTokens: 9_999_999 });
    assert.equal(b.ok, true);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('assertWorkerBudget warns (no throw) on a soft token ceiling and hard-stops a hard one', async () => {
  const runRoot = await makeRunRoot();
  try {
    // Seed prior estimated tokens so the per-run ceiling is in reach.
    await appendBudgetEntry(runRoot, {
      runId: 'r', adapterCallId: 's', attemptId: 's', providerId: 'codex-cli',
      family: 'cli', usageSource: 'estimated',
      usage: { promptTokens: 6000, completionTokens: 0, totalTokens: 6000, costEstimateUsd: 0 },
    });
    const soft = await assertWorkerBudget({
      runRoot, budgetConfig: { perRunTokens: 10000, hardStop: false },
      estimateUsd: 0, estimateTokens: 5000,
    });
    assert.equal(soft.ok, false);
    assert.ok(soft.violations.some(v => v.kind === 'per-run-tokens'));

    await assert.rejects(
      assertWorkerBudget({
        runRoot, budgetConfig: { perRunTokens: 10000, hardStop: true },
        estimateUsd: 0, estimateTokens: 5000,
      }),
      error => error.code === 'BUDGET_EXCEEDED',
    );
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('recordWorkerBudgetEstimate appends an estimated entry the summary keeps separable', async () => {
  const runRoot = await makeRunRoot();
  try {
    const est = estimateWorkerBudget({ plugin: CLI_PLUGIN, model: 'codex', prompt: 'a'.repeat(4000) });
    const out = await recordWorkerBudgetEstimate({
      runRoot, runId: 'r',
      request: { adapterCallId: 'w1', attemptId: 'w1-attempt-1', nodePath: 'main/worker' },
      providerId: 'codex-cli', model: 'codex', family: 'cli',
      usage: est.usage, sourceEventSequence: 7,
    });
    assert.equal(out.duplicate, false);
    const ledger = await readBudgetLedger(runRoot);
    assert.equal(ledger.entries.length, 1);
    const entry = ledger.entries[0];
    assert.equal(entry.usageSource, 'estimated');
    assert.equal(entry.providerId, 'codex-cli');
    assert.equal(entry.nodePath, 'main/worker');
    assert.equal(entry.sourceEventSequence, 7);
    const summary = summarizeLedger(ledger);
    assert.equal(summary.estimatedEntryCount, 1);
    assert.equal(summary.measuredEntryCount, 0);
    assert.equal(summary.estimatedTokens, entry.totalTokens);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('recordWorkerBudgetEstimate is idempotent on (adapterCallId, attemptId)', async () => {
  const runRoot = await makeRunRoot();
  try {
    const usage = { promptTokens: 1000, completionTokens: 512, totalTokens: 1512, costEstimateUsd: 0 };
    const args = {
      runRoot, runId: 'r',
      request: { adapterCallId: 'w1', attemptId: 'w1-attempt-1', nodePath: 'main/worker' },
      providerId: 'codex-cli', model: 'codex', family: 'cli', usage,
    };
    const first = await recordWorkerBudgetEstimate(args);
    const second = await recordWorkerBudgetEstimate(args);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    const ledger = await readBudgetLedger(runRoot);
    assert.equal(ledger.entries.length, 1);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('recordWorkerBudgetEstimate no-ops without a runRoot', async () => {
  const out = await recordWorkerBudgetEstimate({ usage: { totalTokens: 1 } });
  assert.equal(out, null);
});
