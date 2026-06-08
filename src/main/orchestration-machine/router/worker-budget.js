// Worker-path budget governance (R4).
//
// The probe/support path runs through dispatchAdapter, which guards and records
// budget from the provider's MEASURED usage envelope. The worker path does not:
// workers are always CLI-family agents (codex-cli / claude-code) that spawn a
// subprocess to edit files via an overlay. Those agents report no token usage
// and the provider catalog prices them at $0 (flat-rate subscription tools), so
// the worker — the single largest token consumer in a run — never moved the
// budget ledger at all.
//
// This module closes that gap WITHOUT pretending the numbers are measured:
//   - It derives a deterministic ESTIMATE of the worker call's tokens/cost from
//     the prompt it is about to send (token-estimator), records it in the ledger
//     marked usageSource:'estimated', and guards a pre-spawn token/USD ceiling.
//   - Provenance is explicit end to end: estimated entries are tagged and the
//     summary keeps them separable, so the budget meter never blends an estimate
//     into a measured $ total. When a provider DOES report real usage (API
//     families via dispatchAdapter), that path keeps recording 'measured'.
//
// Pure where it can be (prompt composition, estimate); the two ledger wrappers
// do the same fs the rest of the router already does, against runs/<id>/.

const { estimateUsageEnvelope } = require('./token-estimator');
const {
  appendBudgetEntry,
  assertWithinBudget,
  readBudgetLedger,
} = require('./budget-ledger');

// Compose a representative prompt string for estimating a worker invocation.
// The worker's real instruction payload is the command it spawns (codex-cli
// reads the prompt from stdin; other CLIs pass it as args), plus the run's task
// text. Joining them gives a length-faithful estimate of what the agent ingests.
function workerPromptForEstimate(request = {}, taskText = '') {
  const parts = [];
  const cmd = (request && request.commandSpec) || {};
  if (typeof cmd.stdin === 'string' && cmd.stdin) parts.push(cmd.stdin);
  if (Array.isArray(cmd.args)) {
    const argText = cmd.args.filter(arg => typeof arg === 'string').join(' ');
    if (argText) parts.push(argText);
  }
  if (taskText) parts.push(String(taskText));
  return parts.join('\n');
}

// Deterministic forward estimate for one worker invocation. Returns the usage
// envelope plus the two scalars the budget guard needs.
function estimateWorkerBudget({ plugin, model, prompt, expectedCompletionTokens } = {}) {
  const usage = estimateUsageEnvelope({ plugin, model, prompt, expectedCompletionTokens });
  return {
    usage,
    estimateUsd: usage.costEstimateUsd,
    estimateTokens: usage.totalTokens,
  };
}

// Pre-spawn guard. Mirrors the probe path's assertWithinBudget semantics: when
// budget.hardStop is true a violation throws BUDGET_EXCEEDED (so the worker never
// spawns); otherwise it returns { ok, violations } so the caller can emit a
// non-fatal budget.warning and proceed. No-op (ok) without a runRoot/config.
async function assertWorkerBudget({ runRoot, budgetConfig, estimateUsd, estimateTokens } = {}) {
  if (!runRoot || !budgetConfig) return { ok: true, hardStop: false, violations: [] };
  const ledger = await readBudgetLedger(runRoot);
  return assertWithinBudget(budgetConfig, ledger, estimateUsd, estimateTokens);
}

// Record the worker's estimated spend in the ledger, tagged estimated. Idempotent
// on (adapterCallId + attemptId) via appendBudgetEntry's dedupe.
async function recordWorkerBudgetEstimate({
  runRoot,
  runId,
  request,
  providerId,
  model,
  family,
  usage,
  sourceEventSequence,
} = {}) {
  if (!runRoot || !usage) return null;
  return appendBudgetEntry(runRoot, {
    runId,
    adapterCallId: (request && request.adapterCallId) || '',
    attemptId: (request && request.attemptId) || '',
    nodePath: (request && request.nodePath) || '',
    providerId: providerId || '',
    model: model || '',
    family: family || '',
    usageSource: 'estimated',
    usage,
    sourceEventSequence: Number.isFinite(sourceEventSequence) ? sourceEventSequence : null,
  });
}

module.exports = {
  assertWorkerBudget,
  estimateWorkerBudget,
  recordWorkerBudgetEstimate,
  workerPromptForEstimate,
};
