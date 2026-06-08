// Model tier resolver — deterministic, provider-neutral model selection.
//
// The adapter router historically resolved a provider+model purely from the
// explicit `model` string declared on a pipeline/node/fallback selection. The
// shared provider catalog already tags every model with a `qualityTier`
// (draft < fast < standard < deep) and per-MTokens cost rates, but nothing
// consumed that data to *pick* a model. This module closes that gap:
//
//   1. Given a provider + quality tier, choose the cheapest catalog model that
//      satisfies the tier ("smart model pairing" — cheap models for cheap
//      tiers, capable models only when the tier asks for them).
//   2. Under per-run budget pressure, demote the tier by one step and pick the
//      cheapest model at-or-below that tier (budget-aware downgrade).
//
// Design constraints (OrPAD core values):
//   - Pure + deterministic: no I/O, no clock, no randomness. Same inputs ->
//     same model, so run replay/audit stays reproducible.
//   - Provider-neutral: operates only on shared catalog metadata. No SDKs.
//   - Non-destructive to explicit choices: an explicit, real catalog model is
//     preserved unless the selection opts into `modelPolicy: 'cost-optimized'`.
//   - Decisions are reportable (`resolvedBy`, `requestedTier`, blended cost) so
//     the Machine can log an auditable routing event.

const catalog = require('../../../shared/ai/provider-catalog');

// Lower rank = cheaper/weaker capability tier. `draft` is the floor used when a
// budget downgrade pushes below `fast`; the catalog ships no `draft` models, so
// resolution at that rank falls through to the cheapest available model.
const TIER_RANK = Object.freeze({ draft: 0, fast: 1, standard: 2, deep: 3 });
const TIER_BY_RANK = Object.freeze(['draft', 'fast', 'standard', 'deep']);
const DEFAULT_TIER = 'standard';
const DEFAULT_DOWNGRADE_UTILIZATION = 0.8;

const MODEL_POLICIES = Object.freeze(['explicit', 'cost-optimized']);

function normalizeTier(tier) {
  const value = String(tier || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TIER_RANK, value) ? value : DEFAULT_TIER;
}

function rankTier(tier) {
  return TIER_RANK[normalizeTier(tier)];
}

function tierForRank(rank) {
  const clamped = Math.max(0, Math.min(TIER_BY_RANK.length - 1, Math.round(rank)));
  return TIER_BY_RANK[clamped];
}

function demoteTier(tier, steps = 1) {
  const n = Number.isFinite(steps) ? steps : 1;
  return tierForRank(rankTier(tier) - Math.max(0, n));
}

function normalizeModelPolicy(policy) {
  const value = String(policy || 'explicit').trim().toLowerCase();
  return MODEL_POLICIES.includes(value) ? value : 'explicit';
}

function isCostOptimized(policy) {
  return normalizeModelPolicy(policy) === 'cost-optimized';
}

// Blended per-MTokens cost used to rank models within a tier. Output tokens are
// weighted 3x because completions dominate real cost; the ratio is deterministic
// and documented so audits can reproduce the ranking. Missing/negative rates are
// treated as 0 (e.g. local/keyless providers) so they sort cheapest.
function blendedCostPerMTokens(modelEntry) {
  if (!modelEntry) return Infinity;
  const inRate = Number(modelEntry.costPerMTokensIn);
  const outRate = Number(modelEntry.costPerMTokensOut);
  const safeIn = Number.isFinite(inRate) && inRate > 0 ? inRate : 0;
  const safeOut = Number.isFinite(outRate) && outRate > 0 ? outRate : 0;
  return safeIn + safeOut * 3;
}

function providerModels(providerId) {
  const entry = catalog.getProviderEntry(providerId);
  return entry && Array.isArray(entry.models) ? entry.models : [];
}

function pickCheapest(models) {
  if (!Array.isArray(models) || models.length === 0) return null;
  return [...models].sort((a, b) => {
    const ca = blendedCostPerMTokens(a);
    const cb = blendedCostPerMTokens(b);
    if (ca !== cb) return ca - cb;
    return String(a.id).localeCompare(String(b.id));
  })[0];
}

function cheapestModelForTier(providerId, tier) {
  const want = normalizeTier(tier);
  const models = providerModels(providerId).filter(m => normalizeTier(m.qualityTier) === want);
  return pickCheapest(models);
}

function cheapestModelAtOrBelowTier(providerId, tier) {
  const maxRank = rankTier(tier);
  const models = providerModels(providerId).filter(m => rankTier(m.qualityTier) <= maxRank);
  return pickCheapest(models);
}

// Returns { downgrade, utilization, threshold, reason } from a budget config and
// the current ledger summary. No per-run budget => never downgrade.
//
// `projectedNextCostUsd` (optional, default 0) folds a forward estimate of the
// upcoming call into utilization, so the downgrade can fire BEFORE the spend is
// recorded rather than only after it accumulates. Default 0 preserves the
// purely reactive (ledger-only) behavior.
function computeBudgetPressure({ budgetConfig = {}, ledgerSummary = {}, downgradeAtUtilization, projectedNextCostUsd = 0 } = {}) {
  const perRunUsd = Number(budgetConfig?.perRunUsd);
  const totalCostUsd = Number(ledgerSummary?.totalCostUsd) || 0;
  const projected = Number(projectedNextCostUsd);
  const safeProjected = Number.isFinite(projected) && projected > 0 ? projected : 0;
  const configuredThreshold = downgradeAtUtilization !== undefined
    ? downgradeAtUtilization
    : budgetConfig?.downgradeAtUtilization;
  const threshold = Number.isFinite(configuredThreshold) && configuredThreshold > 0
    ? configuredThreshold
    : DEFAULT_DOWNGRADE_UTILIZATION;
  if (!Number.isFinite(perRunUsd) || perRunUsd <= 0) {
    return { downgrade: false, utilization: 0, threshold, reason: 'no-per-run-budget', projectedNextCostUsd: safeProjected };
  }
  const utilization = (totalCostUsd + safeProjected) / perRunUsd;
  const downgrade = utilization >= threshold;
  return {
    downgrade,
    utilization,
    threshold,
    projectedNextCostUsd: safeProjected,
    reason: downgrade
      ? (safeProjected > 0 ? 'projected-per-run-budget-pressure' : 'per-run-budget-pressure')
      : 'within-budget',
  };
}

// Core resolution. Given a provider, a (possibly empty/"auto") model, a tier,
// and a model policy, decide the concrete model id and report how it was chosen.
//
// resolvedBy:
//   'explicit'         - caller pinned a model and did not opt into optimization
//   'tier-cheapest'    - cheapest catalog model satisfying the requested tier
//   'budget-downgrade' - tier was demoted under budget pressure, then resolved
//   'provider-default' - provider has no catalog models (e.g. CLI); kept default
//   'unresolved'       - nothing to resolve to (no model, no catalog, no default)
function resolveModel({ providerId, model, qualityTier, modelPolicy, budgetPressure } = {}) {
  const tier = normalizeTier(qualityTier);
  const requestedModel = String(model || '').trim();
  const isAuto = !requestedModel || requestedModel.toLowerCase() === 'auto';
  const costOptimized = isCostOptimized(modelPolicy);
  const entry = catalog.getProviderEntry(providerId);

  // An explicit, caller-pinned model wins unless cost optimization is requested.
  if (!isAuto && !costOptimized) {
    return { providerId, model: requestedModel, qualityTier: tier, requestedTier: tier, resolvedBy: 'explicit' };
  }

  // Providers without a catalog model list (single fixed CLI model, custom
  // endpoint, etc.) cannot be tier-resolved; keep the caller model or default.
  if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) {
    const fallbackModel = requestedModel || String(entry?.defaultModel || '');
    return {
      providerId,
      model: fallbackModel,
      qualityTier: tier,
      requestedTier: tier,
      resolvedBy: fallbackModel ? 'provider-default' : 'unresolved',
    };
  }

  let effectiveTier = tier;
  let resolvedBy = 'tier-cheapest';
  if (costOptimized && budgetPressure && budgetPressure.downgrade) {
    effectiveTier = demoteTier(tier, 1);
    resolvedBy = 'budget-downgrade';
  }

  let chosen = cheapestModelForTier(providerId, effectiveTier)
    || cheapestModelAtOrBelowTier(providerId, effectiveTier)
    || pickCheapest(entry.models);

  if (!chosen) {
    const fallbackModel = requestedModel || String(entry.defaultModel || '');
    return {
      providerId,
      model: fallbackModel,
      qualityTier: tier,
      requestedTier: tier,
      resolvedBy: fallbackModel ? 'provider-default' : 'unresolved',
    };
  }

  return {
    providerId,
    model: chosen.id,
    qualityTier: effectiveTier,
    requestedTier: tier,
    resolvedBy,
    blendedCostPerMTokens: blendedCostPerMTokens(chosen),
  };
}

module.exports = {
  DEFAULT_DOWNGRADE_UTILIZATION,
  DEFAULT_TIER,
  MODEL_POLICIES,
  TIER_RANK,
  blendedCostPerMTokens,
  cheapestModelAtOrBelowTier,
  cheapestModelForTier,
  computeBudgetPressure,
  demoteTier,
  isCostOptimized,
  normalizeModelPolicy,
  normalizeTier,
  rankTier,
  resolveModel,
  tierForRank,
};
