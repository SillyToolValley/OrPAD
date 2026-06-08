// Deterministic token / cost estimator.
//
// The adapter router's pre-call budget guard previously estimated each upcoming
// call at promptTokens:0 / completionTokens:0, so it always computed ~$0 and
// could only react AFTER spend was recorded in the ledger. This module gives
// the router a forward signal: a deterministic estimate of the next call's cost
// derived from the prompt length plus an expected completion size, fed through
// the provider plugin's own estimateCost(). That makes both the per-call budget
// guard and the budget-aware model downgrade predictive instead of reactive.
//
// Design constraints (OrPAD core values):
//   - Pure + deterministic: a character heuristic, no tokenizer dependency, no
//     I/O, no clock, no randomness. Same prompt -> same token count -> same
//     estimate, so run replay/audit stays reproducible.
//   - Honest about provenance: the result is an ESTIMATE. The authoritative cost
//     remains the provider usage reported after the call (budget-ledger). This
//     only sharpens the pre-call guard; it never replaces recorded usage.
//   - Provider-neutral: cost comes from the plugin's estimateCost(), not from
//     any vendor-specific token API.

// ~4 characters per token is the standard rough heuristic for English-weighted
// text. It is intentionally conservative and deterministic; pricing is dominated
// by the catalog rates, not by sub-token precision.
const DEFAULT_CHARS_PER_TOKEN = 4;
// Default assumed completion size when a node does not declare one. Completions
// dominate cost, so a non-trivial default keeps the guard from under-counting.
const DEFAULT_EXPECTED_COMPLETION_TOKENS = 512;

function promptToText(prompt) {
  if (prompt == null) return '';
  if (typeof prompt === 'string') return prompt;
  try {
    return JSON.stringify(prompt);
  } catch {
    return String(prompt);
  }
}

function safeCharsPerToken(charsPerToken) {
  const n = Number(charsPerToken);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CHARS_PER_TOKEN;
}

// Deterministic token count for a piece of text. Empty/blank -> 0.
function estimateTokensFromText(text, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  const str = typeof text === 'string' ? text : promptToText(text);
  if (!str) return 0;
  return Math.ceil(str.length / safeCharsPerToken(charsPerToken));
}

// Prompt tokens for a string OR a structured prompt object (stringified).
function estimatePromptTokens(prompt, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  return estimateTokensFromText(promptToText(prompt), charsPerToken);
}

function normalizeExpectedCompletionTokens(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_EXPECTED_COMPLETION_TOKENS;
}

// Estimate the USD cost of the next call through the plugin's own estimateCost.
// Returns 0 when the plugin cannot price (e.g. keyless CLI providers report 0),
// which is the safe default — the guard simply does not constrain that call.
function estimateNextCostUsd({
  plugin,
  model,
  prompt,
  expectedCompletionTokens,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
} = {}) {
  if (!plugin || typeof plugin.estimateCost !== 'function') return 0;
  const promptTokens = estimatePromptTokens(prompt, charsPerToken);
  const completionTokens = normalizeExpectedCompletionTokens(expectedCompletionTokens);
  const usd = Number(plugin.estimateCost({ model, promptTokens, completionTokens }));
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}

// Build a usage-shaped envelope from a deterministic estimate, so an estimated
// call can flow through the same budget-ledger entry shape as a measured one.
// The returned object matches the `usage` contract appendBudgetEntry consumes
// (promptTokens / completionTokens / totalTokens / costEstimateUsd / currency).
// costEstimateUsd is 0 for keyless/CLI providers that cannot price — the token
// counts are still meaningful and are what the token-budget guard governs.
function estimateUsageEnvelope({
  plugin,
  model,
  prompt,
  expectedCompletionTokens,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
} = {}) {
  const promptTokens = estimatePromptTokens(prompt, charsPerToken);
  const completionTokens = normalizeExpectedCompletionTokens(expectedCompletionTokens);
  const costEstimateUsd = estimateNextCostUsd({
    plugin,
    model,
    prompt,
    expectedCompletionTokens: completionTokens,
    charsPerToken,
  });
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costEstimateUsd,
    currency: 'USD',
  };
}

// Build an estimator function matching dispatchAdapter's estimateNextCostUsd
// hook signature: ({ candidate, plugin }) => usd. It prices the candidate's
// resolved model against the supplied prompt using the candidate's plugin.
function createCandidateCostEstimator({ pluginFor, prompt, expectedCompletionTokens, charsPerToken } = {}) {
  return ({ candidate, plugin } = {}) => {
    const selection = candidate?.selection || {};
    const resolvedPlugin = plugin
      || (typeof pluginFor === 'function' ? pluginFor(selection.providerId) : null);
    return estimateNextCostUsd({
      plugin: resolvedPlugin,
      model: selection.model,
      prompt,
      expectedCompletionTokens,
      charsPerToken,
    });
  };
}

module.exports = {
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_EXPECTED_COMPLETION_TOKENS,
  createCandidateCostEstimator,
  estimateNextCostUsd,
  estimatePromptTokens,
  estimateTokensFromText,
  estimateUsageEnvelope,
  normalizeExpectedCompletionTokens,
  promptToText,
};
