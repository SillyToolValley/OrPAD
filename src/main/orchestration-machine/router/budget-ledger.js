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
  for (const entry of view.entries || []) {
    const cost = normalizeUsageNumber(entry.costEstimateUsd);
    totalCostUsd += cost;
    attemptCount += 1;
    if (entry.cacheHit) cacheHitCount += 1;
    totalPromptTokens += normalizeUsageNumber(entry.promptTokens);
    totalCompletionTokens += normalizeUsageNumber(entry.completionTokens);
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
    attemptCount,
    cacheHitCount,
    totalPromptTokens,
    totalCompletionTokens,
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

function budgetViolations(budgetConfig, ledger, nextEstimateUsd) {
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
  return violations;
}

function assertWithinBudget(budgetConfig, ledger, nextEstimateUsd) {
  const config = isPlainObject(budgetConfig) ? budgetConfig : {};
  const violations = budgetViolations(config, ledger, nextEstimateUsd);
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
