// Budget ledger — derived view, not authoritative.
//
// PR M5: each adapter attempt that returns a usage envelope appends a single
// entry to runs/<runId>/budget-ledger.json. The router consults
// assertWithinBudget(config, ledger, nextEstimate) before invoking. When
// hardStop is true a violation throws BUDGET_EXCEEDED and the attempt is
// rejected; when false the router only emits a warning event and proceeds.
// Cost is the plugin's reported estimate -- provider invoice reconcile is
// out of scope for this PR.

const fs = require('fs');
const path = require('path');

const { ensureDir, writeJsonAtomic } = require('../metadata-store');

const fsp = fs.promises;
const LEDGER_FILE = 'budget-ledger.json';
const SCHEMA_VERSION = 'orpad.budgetLedger.v1';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ledgerPath(runRoot) {
  if (!runRoot) {
    throw new Error('budget-ledger requires a runRoot.');
  }
  return path.join(path.resolve(runRoot), LEDGER_FILE);
}

function emptyLedger(runId = '') {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    entries: [],
  };
}

async function readBudgetLedger(runRoot) {
  try {
    const raw = await fsp.readFile(ledgerPath(runRoot), 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Malformed file: treat as empty so the run can continue, but keep the
      // raw bytes on disk for forensics rather than silently overwriting.
      return emptyLedger();
    }
    if (parsed && parsed.schemaVersion === SCHEMA_VERSION && Array.isArray(parsed.entries)) {
      return parsed;
    }
    return emptyLedger();
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyLedger();
    throw err;
  }
}

function normalizeUsageNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Provenance of an entry's usage numbers. 'measured' = the provider reported a
// real usage envelope after the call (API families). 'estimated' = the numbers
// are a deterministic forward estimate (e.g. CLI worker agents that never report
// tokens, and whose catalog cost is $0). The distinction is surfaced verbatim in
// the budget meter so an estimated total is never presented as a measured one.
function normalizeUsageSource(value) {
  return value === 'estimated' ? 'estimated' : 'measured';
}

function ledgerEntryFromUsage(input = {}) {
  const usage = isPlainObject(input.usage) ? input.usage : {};
  return {
    sequence: 0, // assigned on append
    sourceEventSequence: Number.isFinite(input.sourceEventSequence) ? input.sourceEventSequence : null,
    adapterCallId: String(input.adapterCallId || ''),
    attemptId: String(input.attemptId || ''),
    nodePath: String(input.nodePath || ''),
    providerId: String(input.providerId || ''),
    model: String(input.model || ''),
    family: input.family || '',
    // Default 'measured' preserves the meaning of every pre-existing entry
    // (all prior callers recorded real provider usage); only the worker-path
    // estimator passes usageSource:'estimated'.
    usageSource: normalizeUsageSource(input.usageSource),
    promptTokens: normalizeUsageNumber(usage.promptTokens),
    completionTokens: normalizeUsageNumber(usage.completionTokens),
    totalTokens: normalizeUsageNumber(usage.totalTokens || (
      normalizeUsageNumber(usage.promptTokens) + normalizeUsageNumber(usage.completionTokens)
    )),
    costEstimateUsd: normalizeUsageNumber(usage.costEstimateUsd),
    currency: usage.currency || 'USD',
    cacheHit: input.cacheHit === true,
    recordedAt: input.recordedAt || new Date().toISOString(),
  };
}

async function appendBudgetEntry(runRoot, input = {}) {
  const ledger = await readBudgetLedger(runRoot);
  const entry = ledgerEntryFromUsage(input);
  // Idempotency: skip when (adapterCallId + attemptId) is already recorded.
  const duplicate = ledger.entries.find(existing =>
    existing.adapterCallId === entry.adapterCallId
    && existing.attemptId === entry.attemptId,
  );
  if (duplicate) {
    return { ledger, entry: duplicate, duplicate: true };
  }
  entry.sequence = ledger.entries.length;
  ledger.runId = ledger.runId || input.runId || '';
  ledger.entries.push(entry);
  await ensureDir(path.dirname(ledgerPath(runRoot)));
  await writeJsonAtomic(ledgerPath(runRoot), ledger);
  return { ledger, entry, duplicate: false };
}

function summarizeLedger(ledger) {
  const view = isPlainObject(ledger) && Array.isArray(ledger.entries)
    ? ledger
    : { entries: Array.isArray(ledger) ? ledger : [] };
  const byProvider = new Map();
  let totalCostUsd = 0;
  let attemptCount = 0;
  let cacheHitCount = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  // Provenance split (R4): keep measured and estimated spend separable so the
  // UI can mark estimated totals honestly and never blend them into a measured $.
  let measuredCostUsd = 0;
  let estimatedCostUsd = 0;
  let measuredTokens = 0;
  let estimatedTokens = 0;
  let measuredEntryCount = 0;
  let estimatedEntryCount = 0;
  for (const entry of view.entries || []) {
    const cost = normalizeUsageNumber(entry.costEstimateUsd);
    const entryTokens = normalizeUsageNumber(entry.totalTokens || (
      normalizeUsageNumber(entry.promptTokens) + normalizeUsageNumber(entry.completionTokens)
    ));
    const estimated = normalizeUsageSource(entry.usageSource) === 'estimated';
    totalCostUsd += cost;
    attemptCount += 1;
    if (entry.cacheHit) cacheHitCount += 1;
    totalPromptTokens += normalizeUsageNumber(entry.promptTokens);
    totalCompletionTokens += normalizeUsageNumber(entry.completionTokens);
    if (estimated) {
      estimatedCostUsd += cost;
      estimatedTokens += entryTokens;
      estimatedEntryCount += 1;
    } else {
      measuredCostUsd += cost;
      measuredTokens += entryTokens;
      measuredEntryCount += 1;
    }
    const slot = byProvider.get(entry.providerId || 'unknown') || {
      providerId: entry.providerId || 'unknown',
      attemptCount: 0,
      totalCostUsd: 0,
    };
    slot.attemptCount += 1;
    slot.totalCostUsd += cost;
    byProvider.set(slot.providerId, slot);
  }
  return {
    totalCostUsd: Number(totalCostUsd.toFixed(8)),
    measuredCostUsd: Number(measuredCostUsd.toFixed(8)),
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(8)),
    attemptCount,
    cacheHitCount,
    totalPromptTokens,
    totalCompletionTokens,
    // Sum of each entry's total (which honours an entry that only carries
    // totalTokens, e.g. an estimated worker entry), not prompt+completion.
    totalTokens: measuredTokens + estimatedTokens,
    measuredTokens,
    estimatedTokens,
    measuredEntryCount,
    estimatedEntryCount,
    byProvider: [...byProvider.values()].map(slot => ({
      providerId: slot.providerId,
      attemptCount: slot.attemptCount,
      totalCostUsd: Number(slot.totalCostUsd.toFixed(8)),
    })),
  };
}

function nextEstimateFromUsage(usage = {}) {
  return normalizeUsageNumber(usage.costEstimateUsd);
}

function budgetViolations(budgetConfig, ledger, nextEstimateUsd, nextTokens = 0) {
  const config = isPlainObject(budgetConfig) ? budgetConfig : {};
  const summary = summarizeLedger(ledger);
  const violations = [];
  const next = normalizeUsageNumber(nextEstimateUsd);
  if (Number.isFinite(config.perCallUsd) && config.perCallUsd > 0 && next > config.perCallUsd) {
    violations.push({
      kind: 'per-call',
      limitUsd: config.perCallUsd,
      observedUsd: next,
    });
  }
  if (Number.isFinite(config.perRunUsd) && config.perRunUsd > 0
    && (summary.totalCostUsd + next) > config.perRunUsd) {
    violations.push({
      kind: 'per-run',
      limitUsd: config.perRunUsd,
      observedUsd: Number((summary.totalCostUsd + next).toFixed(8)),
      priorTotalUsd: summary.totalCostUsd,
    });
  }
  // Token-based ceilings (R4): provider-neutral governance for the worker path,
  // where flat-rate CLI agents report no usage and price at $0 — so the USD
  // limits above never fire and tokens are the only meaningful budget signal.
  // Counted against combined measured+estimated tokens so the dominant consumer
  // (the worker) actually moves the meter.
  const nextTok = normalizeUsageNumber(nextTokens);
  if (Number.isFinite(config.perCallTokens) && config.perCallTokens > 0 && nextTok > config.perCallTokens) {
    violations.push({
      kind: 'per-call-tokens',
      limitTokens: config.perCallTokens,
      observedTokens: nextTok,
    });
  }
  if (Number.isFinite(config.perRunTokens) && config.perRunTokens > 0
    && (summary.totalTokens + nextTok) > config.perRunTokens) {
    violations.push({
      kind: 'per-run-tokens',
      limitTokens: config.perRunTokens,
      observedTokens: summary.totalTokens + nextTok,
      priorTotalTokens: summary.totalTokens,
    });
  }
  return violations;
}

function assertWithinBudget(budgetConfig, ledger, nextEstimateUsd, nextTokens = 0) {
  const config = isPlainObject(budgetConfig) ? budgetConfig : {};
  const violations = budgetViolations(config, ledger, nextEstimateUsd, nextTokens);
  if (!violations.length) {
    return { ok: true, hardStop: config.hardStop === true, violations: [] };
  }
  if (config.hardStop === true) {
    const err = new Error(`Budget exceeded: ${violations.map(v => v.kind).join(', ')}.`);
    err.code = 'BUDGET_EXCEEDED';
    err.classification = 'BUDGET_EXCEEDED';
    err.violations = violations;
    throw err;
  }
  return { ok: false, hardStop: false, violations };
}

module.exports = {
  BUDGET_LEDGER_SCHEMA_VERSION: SCHEMA_VERSION,
  appendBudgetEntry,
  assertWithinBudget,
  budgetViolations,
  emptyLedger,
  ledgerEntryFromUsage,
  ledgerPath,
  nextEstimateFromUsage,
  readBudgetLedger,
  summarizeLedger,
};
