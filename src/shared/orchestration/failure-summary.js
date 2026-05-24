// Failure summary helpers shared between renderer and node tests.
//
// Renderer pipeline-preview run-bar uses these to surface failed adapter
// calls under the run controls; node tests use the same helpers to verify
// detection against synthetic / fixture event records.

const FAILED_STATUSES = Object.freeze(['failed', 'blocked', 'rejected', 'approval-required']);
const RESULT_EVENT_TYPES = Object.freeze(['adapter.result', 'worker.result', 'probe.result']);
const NODE_FAILURE_EVENT_TYPES = Object.freeze(['node.failed', 'node.blocked']);
const SUPPRESSED_LIFECYCLE_STATES = Object.freeze([
  'cancelled', 'canceled', 'cancelling',
  'created', 'running', 'waiting',
]);
// Gate-style nodes block as part of normal lifecycle (waiting for evidence,
// approval, barrier merge, patch review). Their node.blocked events are not
// system failures — they belong on the lifecycle banner, not the failure
// card list.
// Node types whose `node.blocked` events represent normal lifecycle
// gating (waiting for evidence, approval, barrier merge, selector
// decision) rather than a system failure. Their `node.blocked` events
// are filtered out of the failure-card list and surfaced via
// gateBlockedNodesFromRecord instead.
//
// IMPORTANT: this list ONLY suppresses node.blocked. node.failed for
// these types still surfaces as a system failure card — a gate that
// crashes (selector validator threw, exit gate evaluator threw) is a
// real bug, not a normal block. The Pass 2 filter checks event type
// before checking nodeType.
const LIFECYCLE_GATE_NODE_TYPES = Object.freeze([
  'orpad.exit',
  'orpad.gate',
  'orpad.barrier',
  'orpad.artifactContract',
  'orpad.patchReview',
  'orpad.workQueue',
  'orpad.selector',
]);
// worker.result statuses that classify a work item rather than report a
// system failure. The Machine returns these as part of normal queue state
// transitions (queued / blocked / rejected / approval-required) and they
// do not require user intervention through the failure card.
const WORKER_CLASSIFICATION_STATUSES = Object.freeze(['blocked', 'rejected', 'approval-required', 'queued']);

const FAILED_STATUSES_SET = new Set(FAILED_STATUSES);
const RESULT_EVENT_TYPES_SET = new Set(RESULT_EVENT_TYPES);
const LIFECYCLE_GATE_NODE_TYPES_SET = new Set(LIFECYCLE_GATE_NODE_TYPES);
const WORKER_CLASSIFICATION_STATUSES_SET = new Set(WORKER_CLASSIFICATION_STATUSES);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function failureKeyFor(event) {
  if (!event) return '';
  // Build the key from EVERY identifier we have, not OR-fallback through
  // them. Two events that share a nodePath but have different
  // payload.itemId values must produce different keys; otherwise they
  // collapse into a single row. (Caught by codex review v3.)
  const item = event.itemId || event.payload?.itemId || '';
  return event.payload?.adapterCallId
    || event.payload?.nodeExecutionId
    || `${event.eventType}:${event.nodePath || ''}:${item}:${event.payload?.attemptId || event.payload?.attempt || event.sequence || ''}`;
}

function failureLabelFor(event) {
  return event.nodePath
    || event.itemId
    || event.payload?.itemId
    || event.payload?.adapterCallId
    || event.payload?.claimId
    || '(unknown work item)';
}

function extractArtifactRefs(event) {
  const refs = Array.isArray(event?.artifactRefs) ? event.artifactRefs : [];
  return {
    transcriptRef: refs.find(ref => /transcript\.json$/i.test(ref)) || '',
    lastMessageRef: refs.find(ref => /last-message\.json$/i.test(ref)) || '',
    patchRef: refs.find(ref => /\.patch\.json$/i.test(ref)) || '',
    allRefs: refs,
  };
}

function proposalOnlyApprovalProgress(event, status) {
  if (event?.eventType !== 'adapter.result') return false;
  if (status !== 'approval-required') return false;
  if (!String(event.reason || '').startsWith('proposal-only-result.')) return false;
  const proposalCount = Number(event.payload?.proposalCount) || 0;
  const triageTransitionCount = Number(event.payload?.triageTransitionCount) || 0;
  return proposalCount > 0 || triageTransitionCount > 0;
}

function failedAdapterCallsFromRecord(record) {
  const events = Array.isArray(record?.events) ? record.events : [];
  const seen = new Map();

  // Collect the highest sequence at which each nodePath was explicitly
  // dismissed by the user (node.skipped). node.completed alone is NOT a
  // resolution — probe nodes emit node.completed even when their adapter
  // call failed (the wrapper finished, not the work). Failures recorded
  // BEFORE a later node.skipped are considered handled and should not
  // surface as still-open failure cards.
  const resolvedAtSequence = new Map();
  for (const event of events) {
    if (!event) continue;
    if (event.eventType !== 'node.skipped') continue;
    const nodePath = event.nodePath || '';
    if (!nodePath) continue;
    const sequence = Number(event.sequence) || 0;
    const prior = resolvedAtSequence.get(nodePath) || 0;
    if (sequence > prior) resolvedAtSequence.set(nodePath, sequence);
  }

  function priorResultForNode(nodePath, beforeIndex) {
    if (!nodePath) return null;
    for (let j = beforeIndex; j >= 0; j -= 1) {
      const candidate = events[j];
      if (!candidate || !RESULT_EVENT_TYPES_SET.has(candidate.eventType)) continue;
      if ((candidate.nodePath || '') !== nodePath) continue;
      return candidate;
    }
    return null;
  }

  function isResolvedAfter(nodePath, sequence) {
    const resolvedAt = resolvedAtSequence.get(nodePath || '') || 0;
    return resolvedAt > (Number(sequence) || 0);
  }

  function eventMessage(event) {
    const payload = event?.payload || {};
    return String(payload.summary || payload.message || payload.errorMessage || payload.error || '').trim();
  }

  function resultSummaryMessage(event, eventIndex) {
    const direct = eventMessage(event);
    if (direct) return direct;
    const adapterCallId = String(event?.payload?.adapterCallId || '');
    const nodePath = event?.nodePath || '';
    const eventSequence = Number(event?.sequence) || 0;
    for (let j = eventIndex + 1; j < events.length; j += 1) {
      const candidate = events[j];
      if (!candidate || candidate.eventType !== 'run.summary') continue;
      const candidateSequence = Number(candidate.sequence) || 0;
      if (eventSequence && candidateSequence && candidateSequence < eventSequence) continue;
      const payload = candidate.payload || {};
      const matchesAdapter = adapterCallId && String(payload.adapterCallId || '') === adapterCallId;
      const matchesNode = !adapterCallId && nodePath && candidate.nodePath === nodePath;
      if (!matchesAdapter && !matchesNode) continue;
      const message = eventMessage(candidate);
      if (message) return message;
    }
    return '';
  }

  // Pass 1: explicit adapter/worker/probe result events with failure status.
  // worker.result statuses that classify a work item (blocked / rejected /
  // approval-required / queued) are normal queue transitions, not system
  // failures — they should not appear as failure cards.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || !RESULT_EVENT_TYPES_SET.has(event.eventType)) continue;
    const status = String(event.payload?.status || '').toLowerCase();
    if (!FAILED_STATUSES_SET.has(status)) continue;
    if (event.eventType === 'worker.result' && WORKER_CLASSIFICATION_STATUSES_SET.has(status)) continue;
    if (proposalOnlyApprovalProgress(event, status)) continue;
    if (isResolvedAfter(event.nodePath, event.sequence)) continue;
    const key = failureKeyFor(event);
    if (seen.has(key)) continue;
    const refs = extractArtifactRefs(event);
    seen.set(key, {
      nodePath: event.nodePath || '',
      label: failureLabelFor(event),
      itemId: event.itemId || event.payload?.itemId || '',
      adapterCallId: event.payload?.adapterCallId || '',
      attemptId: event.payload?.attemptId || '',
      taskKind: event.payload?.taskKind || '',
      status,
      reason: event.reason || '',
      message: resultSummaryMessage(event, i),
      adapter: event.payload?.adapter || event.eventType,
      eventType: event.eventType,
      timestamp: event.timestamp || '',
      sequence: event.sequence || 0,
      ...refs,
    });
  }

  // Pass 2: node lifecycle failures without adapter result coverage.
  // Suppress ONLY node.blocked for gate-style node types — their
  // blocked status is normal lifecycle (waiting on evidence, approval,
  // barrier merge, selector decision) and is reflected in the lifecycle
  // banner. node.failed for the same node types is still a real
  // failure (the gate's evaluator threw) and must surface as a card.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) continue;
    if (!NODE_FAILURE_EVENT_TYPES.includes(event.eventType)) continue;
    const nodeType = String(event.payload?.nodeType || '').trim();
    if (event.eventType === 'node.blocked' && LIFECYCLE_GATE_NODE_TYPES_SET.has(nodeType)) continue;
    const nodePath = event.nodePath || '';
    if (isResolvedAfter(nodePath, event.sequence)) continue;
    if ([...seen.values()].some(f => f.nodePath === nodePath)) continue;
    const key = failureKeyFor(event);
    if (seen.has(key)) continue;
    const prior = priorResultForNode(nodePath, i - 1);
    const refs = extractArtifactRefs(prior || event);
    seen.set(key, {
      nodePath,
      label: failureLabelFor(event),
      itemId: event.itemId || event.payload?.itemId || '',
      adapterCallId: prior?.payload?.adapterCallId || event.payload?.adapterCallId || '',
      attemptId: prior?.payload?.attemptId || event.payload?.attemptId || '',
      taskKind: prior?.payload?.taskKind || event.payload?.taskKind || '',
      status: event.eventType === 'node.blocked' ? 'blocked' : 'failed',
      reason: event.payload?.reason || event.reason || '',
      message: eventMessage(event) || eventMessage(prior),
      adapter: prior?.payload?.adapter || event.eventType,
      eventType: event.eventType,
      nodeType,
      timestamp: event.timestamp || '',
      sequence: event.sequence || 0,
      ...refs,
    });
  }

  return [...seen.values()].sort((a, b) => (a.nodePath || '').localeCompare(b.nodePath || ''));
}

function runArtifactAbsPath(record, ref) {
  if (!ref || !record) return '';
  const runRoot = record.runRoot || record.runState?.runRoot || '';
  if (!runRoot) return '';
  const cleanRoot = String(runRoot).replace(/[\\/]+$/, '');
  const cleanRef = String(ref).replace(/^[\\/]+/, '');
  return `${cleanRoot}/${cleanRef}`;
}

function lifecycleSuppressesFallback(lifecycleStatus) {
  return SUPPRESSED_LIFECYCLE_STATES.includes(String(lifecycleStatus || '').toLowerCase());
}

function shouldShowFailureFallback(record, failures) {
  if (failures && failures.length > 0) return false;
  const lifecycleStatus = String(record?.runState?.lifecycleStatus || '').toLowerCase();
  const summaryStatus = String(record?.runState?.summaryStatus || '').toLowerCase();
  if (lifecycleSuppressesFallback(lifecycleStatus)) return false;
  return lifecycleStatus === 'failed' || summaryStatus === 'blocked';
}

// Lifecycle events that supersede a prior node.blocked. A `node.started`
// or `node.running` event is NOT a resolution — a retry that has not
// produced a terminal result yet should leave the gate marked as
// blocked. (Caught by codex review.) Only terminal lifecycle events
// resolve a block.
const NODE_BLOCK_RESOLUTION_EVENT_TYPES = new Set([
  'node.skipped', 'node.completed', 'node.failed', 'node.cancelled',
]);

const PATCH_REVIEW_DECISION_EVENT_TYPES = new Set([
  'patch.approved',
  'patch.review_skipped',
  'patch.applied',
  'patch.apply_conflict',
  'patch.apply_failed',
]);
const PATCH_REVIEW_RESOLUTION_EVENT_TYPES = new Set(['patch.applied', 'patch.review_skipped']);

function patchReviewGateStateFromEvents(events = []) {
  const patchArtifacts = [];
  const seen = new Set();
  for (const event of events) {
    if (event?.eventType !== 'worker.result') continue;
    const payload = event.payload || {};
    const patchArtifact = String(payload.patchArtifact || '').trim();
    const changedFiles = Array.isArray(payload.changedFiles) ? payload.changedFiles.filter(Boolean) : [];
    if (!patchArtifact || !changedFiles.length || seen.has(patchArtifact)) continue;
    seen.add(patchArtifact);
    patchArtifacts.push(patchArtifact);
  }

  const decisions = new Map();
  for (const event of events) {
    const type = String(event?.eventType || '');
    if (!PATCH_REVIEW_DECISION_EVENT_TYPES.has(type)) continue;
    const patchArtifact = String(event?.payload?.patchArtifact || '').trim();
    if (!patchArtifact) continue;
    decisions.set(patchArtifact, type);
  }

  const pending = patchArtifacts.filter(patchArtifact => (
    !PATCH_REVIEW_RESOLUTION_EVENT_TYPES.has(decisions.get(patchArtifact) || '')
  ));
  return {
    required: patchArtifacts.length > 0,
    resolved: pending.length === 0,
    pendingCount: pending.length,
  };
}

function gateBlockedNodesFromRecord(record) {
  const events = Array.isArray(record?.events) ? record.events : [];
  const patchReviewGateState = patchReviewGateStateFromEvents(events);
  // Track the latest blocked AND the latest resolution per nodePath. A
  // gate is currently blocked when its latest blocked sequence is
  // greater than its latest resolution sequence.
  const latestBlock = new Map();
  const latestResolution = new Map();
  for (const event of events) {
    if (!event || !event.nodePath) continue;
    const sequence = Number(event.sequence) || 0;
    if (event.eventType === 'node.blocked') {
      const prior = latestBlock.get(event.nodePath);
      if (!prior || sequence > prior.sequence) {
        latestBlock.set(event.nodePath, { event, sequence });
      }
    } else if (NODE_BLOCK_RESOLUTION_EVENT_TYPES.has(event.eventType)) {
      const prior = latestResolution.get(event.nodePath) || 0;
      if (sequence > prior) latestResolution.set(event.nodePath, sequence);
    }
  }
  const out = [];
  for (const [nodePath, { event, sequence }] of latestBlock.entries()) {
    if ((latestResolution.get(nodePath) || 0) >= sequence) continue;
    const nodeType = String(event.payload?.nodeType || '').trim();
    if (!LIFECYCLE_GATE_NODE_TYPES_SET.has(nodeType)) continue;
    if (
      nodeType === 'orpad.patchReview'
      && (!patchReviewGateState.required || patchReviewGateState.resolved)
    ) {
      continue;
    }
    out.push({
      nodePath,
      nodeType,
      reason: event.payload?.reason || event.reason || '',
      artifactContracts: Array.isArray(event.payload?.artifactContracts) ? event.payload.artifactContracts : [],
      sequence,
      timestamp: event.timestamp || '',
    });
  }
  // Sort by recency (newest blocker first) so the lifecycle banner
  // surfaces the freshest issue at the top.
  return out.sort((a, b) => b.sequence - a.sequence);
}

module.exports = {
  FAILED_STATUSES,
  FAILED_STATUSES_SET,
  LIFECYCLE_GATE_NODE_TYPES,
  LIFECYCLE_GATE_NODE_TYPES_SET,
  NODE_FAILURE_EVENT_TYPES,
  RESULT_EVENT_TYPES,
  RESULT_EVENT_TYPES_SET,
  SUPPRESSED_LIFECYCLE_STATES,
  WORKER_CLASSIFICATION_STATUSES,
  WORKER_CLASSIFICATION_STATUSES_SET,
  extractArtifactRefs,
  failedAdapterCallsFromRecord,
  failureKeyFor,
  failureLabelFor,
  gateBlockedNodesFromRecord,
  isPlainObject,
  lifecycleSuppressesFallback,
  patchReviewGateStateFromEvents,
  runArtifactAbsPath,
  shouldShowFailureFallback,
};
