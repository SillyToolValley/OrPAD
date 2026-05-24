// Fork-Join Phase 2: outgoing-edge evaluator.
//
// Today the machine's for-loop visits every node in topological order
// regardless of edge `condition` strings. The strings are passed
// through by the generator and rendered by the renderer, but neither
// the validator nor the dispatcher reads them. Pattern B (Ralph loop),
// Pattern I (queue-drain), and Pattern K (patchReview reject) appear
// to "work" only because the user manually clicks Continue and each
// click bumps nextNodeAttempt — not because any edge was actually
// evaluated.
//
// Phase 2 introduces a pure evaluator that decides which outgoing
// edges of a source node WOULD fire based on the source's last
// completed result. Phase 2 is a non-mutating dry run: the evaluator
// is called, the decision is logged as a `scheduler.edgeEvaluation`
// event, but the for-loop's dispatch order is unchanged. This shakes
// out spec authors who write conditions the evaluator doesn't
// recognize before Phase 3 starts gating dispatch on those decisions.
//
// The evaluator is intentionally a pure function (no I/O, no event
// log access) so it can be unit-tested in isolation. The wiring
// layer in machine.js reads the latest node.completed payload and
// passes it in as `sourceResult`.

const GATE_PASS_CONDITIONS = new Set(['pass', 'continue', 'accept', 'accepted', 'ok', 'success']);
const GATE_REVISE_CONDITIONS = new Set(['revise', 'reject', 'rejected', 'fail', 'retry']);
const GATE_CONTINUE_ON_FAIL_POLICIES = new Set(['warn', 'continue', 'continue-with-warning']);
const PATCH_ACCEPT_CONDITIONS = new Set(['accepted', 'accept', 'pass', 'continue']);
const PATCH_REJECT_CONDITIONS = new Set(['rejected', 'reject', 'revise', 'revision-requested', 'changes-requested']);
const PATCH_ACCEPT_STATUSES = new Set(['reviewed', 'not-required', 'applied']);
const PATCH_REJECT_STATUSES = new Set([
  'rejected',
  'reject',
  'revise',
  'revision-requested',
  'request-revision',
  'changes-requested',
  'needs-revision',
  'follow-up',
  'followup',
]);

function normalizeCondition(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

function hasDeclaredFailureRouting(value) {
  if (value == null || value === false) return false;
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return value.some(item => hasDeclaredFailureRouting(item));
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

function decideEdgeForSelector(condition, sourceResult) {
  const selected = normalizeCondition(sourceResult?.selected || sourceResult?.selectedRoute || '');
  if (!selected) {
    return { fired: false, reason: 'selector-no-selection' };
  }
  if (condition === selected) {
    return { fired: true, reason: 'selector-match', selectedRoute: selected };
  }
  return { fired: false, reason: 'selector-mismatch', selectedRoute: selected };
}

function decideEdgeForGate(condition, sourceResult) {
  const rawValid = Boolean(sourceResult?.valid);
  const onFail = normalizeCondition(sourceResult?.onFail);
  const hasFailureRouting = hasDeclaredFailureRouting(sourceResult?.failureRouting);
  const warningDoesNotPass = sourceResult?.warningDoesNotPass === true || hasFailureRouting;
  const strictFailure = sourceResult?.strictFailure === true || warningDoesNotPass;
  const strictRoutingReason = sourceResult?.strictFailure === true
    ? 'gate-strict'
    : (hasFailureRouting ? 'gate-failure-routing' : 'gate-warning-does-not-pass');
  const strictRoutingAudit = {
    ...(warningDoesNotPass ? { warningDoesNotPass: true } : {}),
    ...(hasFailureRouting ? { failureRouting: sourceResult.failureRouting } : {}),
  };
  const continueOnFail = !rawValid && !strictFailure && GATE_CONTINUE_ON_FAIL_POLICIES.has(onFail);
  const valid = rawValid || continueOnFail;
  // Queue-state conditions (Pattern I: queue-drain loop).
  if (condition === 'queue-empty' || condition === 'queue-not-empty') {
    // `summarizeQueueInventory` returns `{ counts: { candidate, queued,
    // claimed, ... }, activeCount, ... }` and the gate result spreads
    // that whole object into `result.inventory`. Codex CLI cross-review
    // 2026-05-16 caught that this evaluator originally read the wrong
    // shape (`inventory.candidate` flat) which always read undefined →
    // 0 and surfaced false "queue-empty" decisions for every real run.
    // Read `activeCount` first; fall back to summing `counts.*` for
    // legacy callers (and for the synthetic shape unit tests use); then
    // fall back to the original flat shape for ultra-old callers.
    const inv = sourceResult?.inventory || {};
    const totalActive = (() => {
      if (typeof inv.activeCount === 'number') return inv.activeCount;
      if (inv.counts && typeof inv.counts === 'object') {
        return (inv.counts.candidate || 0) + (inv.counts.queued || 0) + (inv.counts.claimed || 0);
      }
      return (inv.candidate || 0) + (inv.queued || 0) + (inv.claimed || 0);
    })();
    const isEmpty = totalActive === 0;
    if (condition === 'queue-empty') {
      return isEmpty
        ? { fired: true, reason: 'queue-empty', inventoryTotalActive: totalActive }
        : { fired: false, reason: 'queue-not-empty', inventoryTotalActive: totalActive };
    }
    return !isEmpty
      ? { fired: true, reason: 'queue-not-empty', inventoryTotalActive: totalActive }
      : { fired: false, reason: 'queue-empty', inventoryTotalActive: totalActive };
  }
  if (GATE_PASS_CONDITIONS.has(condition)) {
    return valid
      ? { fired: true, reason: rawValid ? 'gate-pass' : 'gate-warning-pass', onFail }
      : { fired: false, reason: strictFailure ? `${strictRoutingReason}-failed` : 'gate-failed', onFail, ...strictRoutingAudit };
  }
  if (GATE_REVISE_CONDITIONS.has(condition)) {
    return valid
      ? { fired: false, reason: rawValid ? 'gate-passed-skip-revise' : 'gate-warning-skip-revise', onFail }
      : { fired: true, reason: strictFailure ? `${strictRoutingReason}-revise` : 'gate-revise', onFail, ...strictRoutingAudit };
  }
  return { fired: true, reason: 'gate-condition-unrecognized-default-fire' };
}

function decideEdgeForPatchReview(condition, sourceResult) {
  const status = normalizeCondition(sourceResult?.status || '');
  const decision = normalizeCondition(sourceResult?.decision || sourceResult?.reviewDecision || '');
  const accepted = PATCH_ACCEPT_STATUSES.has(status);
  const rejected = PATCH_REJECT_STATUSES.has(status) || PATCH_REJECT_STATUSES.has(decision);
  if (PATCH_ACCEPT_CONDITIONS.has(condition)) {
    return accepted
      ? { fired: true, reason: 'patch-review-accepted', reviewStatus: status }
      : { fired: false, reason: 'patch-review-not-accepted', reviewStatus: status };
  }
  if (PATCH_REJECT_CONDITIONS.has(condition)) {
    return rejected
      ? { fired: true, reason: 'patch-review-rejected', reviewStatus: status, reviewDecision: decision }
      : { fired: false, reason: 'patch-review-not-rejected', reviewStatus: status, reviewDecision: decision };
  }
  return { fired: true, reason: 'patch-review-condition-unrecognized-default-fire' };
}

function decideEdgeForBarrier(condition, sourceResult) {
  // Today validateBarrierNode returns `{ valid: bool, ... }`. With the
  // default `onPartialFailure: 'continue-with-warning'` it can return
  // `valid: false` AND complete (not throw), so the barrier's
  // outgoing edges still fire. Phase 3 will switch barriers to
  // scheduler-side wait so the barrier only completes when every
  // waitFor predecessor is resolved — but Phase 2 reads the same
  // valid bit so the dry-run reflects the today-behavior.
  const valid = Boolean(sourceResult?.valid);
  if (condition === 'pass' || condition === 'continue') {
    return valid
      ? { fired: true, reason: 'barrier-pass' }
      : { fired: false, reason: 'barrier-partial', mergePolicy: sourceResult?.mergePolicy };
  }
  if (condition === 'partial' || condition === 'fail') {
    return !valid
      ? { fired: true, reason: 'barrier-partial' }
      : { fired: false, reason: 'barrier-pass-skip-partial' };
  }
  return valid
    ? { fired: true, reason: 'barrier-default-fire' }
    : { fired: false, reason: 'barrier-default-skip' };
}

// Phase 2's contract: every edge is decided. No condition (Pattern J,
// unconditional fan-out) always fires. Unknown source-type conditions
// default-fire so we don't accidentally suppress today-working
// pipelines during the dry-run rollout. Phase 3 may tighten this.
function evaluateOutgoingEdges(sourceNode, edges, sourceResult) {
  const sourceNodeType = String(sourceNode?.nodeType || '');
  return (edges || []).map((edge) => {
    const condition = normalizeCondition(edge?.condition);
    if (!condition) {
      return {
        edge,
        fired: true,
        reason: 'unconditional',
      };
    }
    let decision;
    switch (sourceNodeType) {
      case 'orpad.selector':
        decision = decideEdgeForSelector(condition, sourceResult);
        break;
      case 'orpad.gate':
        decision = decideEdgeForGate(condition, sourceResult);
        break;
      case 'orpad.patchReview':
        decision = decideEdgeForPatchReview(condition, sourceResult);
        break;
      case 'orpad.barrier':
        decision = decideEdgeForBarrier(condition, sourceResult);
        break;
      default:
        // Non-decision-emitting source with a labelled edge. We can't
        // verify the condition, so default-fire and tag for audit.
        decision = { fired: true, reason: 'source-not-decision-emitting' };
        break;
    }
    return { edge, ...decision };
  });
}

// Test helper: edge-evaluator output -> compact representation that's
// easy to assert in unit tests.
function summarizeEdgeEvaluation(decisions) {
  return decisions.map(({ edge, fired, reason }) => ({
    from: edge?.from,
    to: edge?.to,
    condition: normalizeCondition(edge?.condition),
    fired,
    reason,
  }));
}

module.exports = {
  evaluateOutgoingEdges,
  summarizeEdgeEvaluation,
};
