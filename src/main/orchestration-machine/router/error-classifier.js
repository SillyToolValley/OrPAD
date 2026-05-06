// Error → action mapping for the router fallback loop.
//
// PR M7: dispatchAdapter walks the candidate list returned by decideAttempts
// and consults `decideActionForError` between attempts. Each plugin already
// emits a standard error code (M3+); the classifier converts that into one of
// three actions:
//   - retry      : re-invoke the *same* candidate (RETRYABLE only, with a
//                  bounded attempt count and configurable backoff)
//   - fallback   : drop to the next candidate (RATE_LIMIT / KEY_MISSING for
//                  keyless successors / OUTPUT_VIOLATES_CONTRACT after one
//                  self-repair / RETRYABLE after maxAttempts exhaustion)
//   - self-repair: re-invoke the *same* candidate once with the same prompt;
//                  the M3 plugin contract treats malformed JSON as
//                  OUTPUT_VIOLATES_CONTRACT, so a single retry sometimes
//                  recovers without falling back
//   - fail       : abort with the error untouched (FATAL, BUDGET_EXCEEDED,
//                  KEY_MISSING when no keyless successor is available)

const { classifyAdapterError, ERROR_CLASSES } = require('./adapter-router');
const { getProviderEntry } = require('../../../shared/ai/provider-catalog');

const DEFAULT_RETRY_BUDGET = Object.freeze({
  maxAttempts: 2,
  backoffMs: 250,
  selfRepairAttempts: 1,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nextKeylessCandidate(remainingCandidates) {
  for (const candidate of remainingCandidates) {
    const providerId = candidate?.selection?.providerId;
    if (!providerId) continue;
    const entry = getProviderEntry(providerId);
    if (entry && entry.needsKey === false) return candidate;
  }
  return null;
}

function decideActionForError({
  error,
  candidate,
  remainingCandidates = [],
  attemptCounters = {},
  retryBudget = DEFAULT_RETRY_BUDGET,
}) {
  const classification = classifyAdapterError(error);
  const counters = isPlainObject(attemptCounters) ? attemptCounters : {};
  const sameCandidateAttempts = counters.sameCandidateAttempts || 1;
  const selfRepairAttempts = counters.selfRepairAttempts || 0;
  const maxAttempts = Number(retryBudget.maxAttempts || DEFAULT_RETRY_BUDGET.maxAttempts);
  const maxSelfRepair = Number(retryBudget.selfRepairAttempts || DEFAULT_RETRY_BUDGET.selfRepairAttempts);
  const hasFallback = remainingCandidates.length > 0;

  switch (classification) {
    case 'BUDGET_EXCEEDED':
      return { action: 'fail', classification, reason: 'budget-exceeded' };
    case 'FATAL':
      return { action: 'fail', classification, reason: 'fatal' };
    case 'RETRYABLE':
      if (sameCandidateAttempts < maxAttempts) {
        return { action: 'retry', classification, reason: 'retryable-budget-remaining' };
      }
      return hasFallback
        ? { action: 'fallback', classification, reason: 'retryable-exhausted', target: remainingCandidates[0] }
        : { action: 'fail', classification, reason: 'retryable-no-fallback' };
    case 'RATE_LIMIT':
      return hasFallback
        ? { action: 'fallback', classification, reason: 'rate-limit', target: remainingCandidates[0] }
        : { action: 'fail', classification, reason: 'rate-limit-no-fallback' };
    case 'KEY_MISSING': {
      const target = nextKeylessCandidate(remainingCandidates);
      if (target) {
        return { action: 'fallback', classification, reason: 'key-missing-keyless-fallback', target };
      }
      return { action: 'fail', classification, reason: 'key-missing-no-keyless-fallback' };
    }
    case 'OUTPUT_VIOLATES_CONTRACT':
      if (selfRepairAttempts < maxSelfRepair) {
        return { action: 'self-repair', classification, reason: 'output-violates-contract-self-repair' };
      }
      return hasFallback
        ? { action: 'fallback', classification, reason: 'output-violates-contract-fallback', target: remainingCandidates[0] }
        : { action: 'fail', classification, reason: 'output-violates-contract-no-fallback' };
    default:
      return { action: 'fail', classification: 'FATAL', reason: 'unknown-classification' };
  }
}

function indexOfNextKeylessCandidate(remainingCandidates) {
  for (let i = 0; i < remainingCandidates.length; i += 1) {
    const candidate = remainingCandidates[i];
    const providerId = candidate?.selection?.providerId;
    if (!providerId) continue;
    const entry = getProviderEntry(providerId);
    if (entry && entry.needsKey === false) return i;
  }
  return -1;
}

module.exports = {
  DEFAULT_RETRY_BUDGET,
  ERROR_CLASSES,
  classifyAdapterError,
  decideActionForError,
  indexOfNextKeylessCandidate,
  nextKeylessCandidate,
};
