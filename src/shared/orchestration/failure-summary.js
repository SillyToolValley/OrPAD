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
const LIFECYCLE_GATE_NODE_TYPES = Object.freeze([
  'orpad.exit',
  'orpad.gate',
  'orpad.barrier',
  'orpad.artifactContract',
  'orpad.patchReview',
  'orpad.workQueue',
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
  return event.payload?.adapterCallId
    || event.payload?.nodeExecutionId
    || `${event.eventType}:${event.nodePath || event.itemId || ''}:${event.payload?.attemptId || event.payload?.attempt || event.sequence || ''}`;
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
      status,
      reason: event.reason || '',
      adapter: event.payload?.adapter || event.eventType,
      eventType: event.eventType,
      timestamp: event.timestamp || '',
      sequence: event.sequence || 0,
      ...refs,
    });
  }

  // Pass 2: node lifecycle failures without adapter result coverage. Skip
  // gate-style nodes (orpad.exit / gate / barrier / artifactContract / patchReview /
  // workQueue) — their blocked status is part of normal lifecycle (waiting on
  // evidence, approval, barrier merge) and is reflected in the lifecycle
  // banner, not as a system failure card.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) continue;
    if (!NODE_FAILURE_EVENT_TYPES.includes(event.eventType)) continue;
    const nodeType = String(event.payload?.nodeType || '').trim();
    if (LIFECYCLE_GATE_NODE_TYPES_SET.has(nodeType)) continue;
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
      status: event.eventType === 'node.blocked' ? 'blocked' : 'failed',
      reason: event.payload?.reason || event.reason || '',
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

// node lifecycle events that supersede a prior node.blocked — once the
// dispatcher records any of these for a node at a higher sequence, the
// node is no longer "currently blocked".
const NODE_BLOCK_RESOLUTION_EVENT_TYPES = new Set([
  'node.skipped', 'node.completed', 'node.started', 'node.running',
  'node.failed', 'node.cancelled',
]);

function gateBlockedNodesFromRecord(record) {
  const events = Array.isArray(record?.events) ? record.events : [];
  // Walk forward, tracking the latest lifecycle event per nodePath. A gate
  // is currently blocked only if its most recent lifecycle event is
  // `node.blocked` and the nodeType is gate-style.
  const latest = new Map();
  for (const event of events) {
    if (!event) continue;
    const isBlock = event.eventType === 'node.blocked';
    const isResolution = NODE_BLOCK_RESOLUTION_EVENT_TYPES.has(event.eventType);
    if (!isBlock && !isResolution) continue;
    const nodePath = event.nodePath || '';
    if (!nodePath) continue;
    const sequence = Number(event.sequence) || 0;
    const prior = latest.get(nodePath);
    if (!prior || sequence > prior.sequence) {
      latest.set(nodePath, { event, sequence });
    }
  }
  const out = [];
  for (const { event } of latest.values()) {
    if (event.eventType !== 'node.blocked') continue;
    const nodeType = String(event.payload?.nodeType || '').trim();
    if (!LIFECYCLE_GATE_NODE_TYPES_SET.has(nodeType)) continue;
    out.push({
      nodePath: event.nodePath,
      nodeType,
      reason: event.payload?.reason || event.reason || '',
      sequence: Number(event.sequence) || 0,
      timestamp: event.timestamp || '',
    });
  }
  return out.sort((a, b) => a.nodePath.localeCompare(b.nodePath));
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
  runArtifactAbsPath,
  shouldShowFailureFallback,
};
