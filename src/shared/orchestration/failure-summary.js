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

const FAILED_STATUSES_SET = new Set(FAILED_STATUSES);
const RESULT_EVENT_TYPES_SET = new Set(RESULT_EVENT_TYPES);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function failureKeyFor(event) {
  if (!event) return '';
  return event.payload?.adapterCallId
    || event.payload?.nodeExecutionId
    || `${event.eventType}:${event.nodePath || ''}:${event.payload?.attemptId || event.payload?.attempt || event.sequence || ''}`;
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

  // Pass 1: explicit adapter/worker/probe result events with failure status.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || !RESULT_EVENT_TYPES_SET.has(event.eventType)) continue;
    const status = String(event.payload?.status || '').toLowerCase();
    if (!FAILED_STATUSES_SET.has(status)) continue;
    const key = failureKeyFor(event);
    if (seen.has(key)) continue;
    const refs = extractArtifactRefs(event);
    seen.set(key, {
      nodePath: event.nodePath || '',
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

  // Pass 2: node lifecycle failures without adapter result coverage.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) continue;
    if (!NODE_FAILURE_EVENT_TYPES.includes(event.eventType)) continue;
    const nodePath = event.nodePath || '';
    if ([...seen.values()].some(f => f.nodePath === nodePath)) continue;
    const key = failureKeyFor(event);
    if (seen.has(key)) continue;
    const prior = priorResultForNode(nodePath, i - 1);
    const refs = extractArtifactRefs(prior || event);
    seen.set(key, {
      nodePath,
      adapterCallId: prior?.payload?.adapterCallId || event.payload?.adapterCallId || '',
      attemptId: prior?.payload?.attemptId || event.payload?.attemptId || '',
      status: event.eventType === 'node.blocked' ? 'blocked' : 'failed',
      reason: event.payload?.reason || event.reason || '',
      adapter: prior?.payload?.adapter || event.eventType,
      eventType: event.eventType,
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

module.exports = {
  FAILED_STATUSES,
  FAILED_STATUSES_SET,
  NODE_FAILURE_EVENT_TYPES,
  RESULT_EVENT_TYPES,
  RESULT_EVENT_TYPES_SET,
  SUPPRESSED_LIFECYCLE_STATES,
  extractArtifactRefs,
  failedAdapterCallsFromRecord,
  failureKeyFor,
  isPlainObject,
  lifecycleSuppressesFallback,
  runArtifactAbsPath,
  shouldShowFailureFallback,
};
