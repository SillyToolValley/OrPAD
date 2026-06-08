// Cooperative run-control: pause / resume / cancel intent for supervised autonomy.
//
// OrPAD already has an autonomous driver loop (ipc.js executeMachineRunToHumanDecision)
// that advances executeMachineRunStep until a human decision is needed. For
// SUPERVISED AUTONOMY the human must be able to PAUSE / RESUME / CANCEL that
// loop from the live graph at any time. This module is the load-bearing
// foundation for that control surface.
//
// Design (matches OrPAD core values):
//   - The Machine stays the OWNER of state transitions; control is event-sourced.
//     A pause request is a durable `run.pause-requested` event (audit + survives
//     a crash); the ack is the existing run.status transition to the new,
//     NON-terminal `paused` lifecycle state. Resume emits `run.resume-requested`
//     and transitions back. Cancel-intent emits `run.cancel-requested` before the
//     existing cancelling/cancelled ack (intent-then-ack).
//   - Interrupts are COOPERATIVE CHECKPOINTS, never corrupting kills: the driver
//     checks intent at the SAFE BOUNDARY *between* run-steps, so the in-flight
//     step always finishes gracefully before the run suspends. (Mid-step abort
//     is a later increment, RC-2.)
//   - Deadlock-free: requesting a pause must NOT take the run-lifecycle lock that
//     the running driver holds. requestRunPause only (a) sets an in-memory token
//     and (b) appends an event through the event log's own append queue — neither
//     needs the lifecycle lock. The driver reads the token between steps.
//   - Replayable: with the token map empty (fresh process after a crash), intent
//     is reconstructed from the event log via projectRunControlFromEvents.

const { appendMachineEvent, projectRunStateFromEvents, readMachineEvents } = require('./events');
const { appendRunLifecycleStatus, TERMINAL_RUN_LIFECYCLE_STATES } = require('./lifecycle');
const { readRunState } = require('./run-store');
// RC-4: claim-lease keepalive across a pause. claims.js depends only on
// events/ids/metadata-store, so this require is acyclic.
const { heartbeatClaimLease, readActiveClaimLeases } = require('./claims');

const RUN_CONTROL_EVENT_TYPES = Object.freeze({
  pauseRequested: 'run.pause-requested',
  resumeRequested: 'run.resume-requested',
  cancelRequested: 'run.cancel-requested',
});

// Non-authoritative, in-process fast-path cache of control intent keyed by runId.
// The event log is the durable source of truth; this lets the live driver loop
// check intent each iteration without re-reading the log. Cleared on resume.
const controlTokens = new Map();

function controlToken(runId) {
  if (!runId) throw new Error('runId is required.');
  let token = controlTokens.get(runId);
  if (!token) {
    token = { pauseRequested: false, cancelRequested: false };
    controlTokens.set(runId, token);
  }
  return token;
}

function markPauseRequested(runId) {
  controlToken(runId).pauseRequested = true;
}

function markResumeRequested(runId) {
  // Resume clears the pause intent so a re-driven loop does not immediately
  // re-pause. Cancel intent is intentionally left untouched.
  controlToken(runId).pauseRequested = false;
}

function markCancelRequested(runId) {
  controlToken(runId).cancelRequested = true;
}

function clearRunControlToken(runId) {
  controlTokens.delete(runId);
  clearRunAbortSignal(runId);
}

function readRunControlToken(runId) {
  const token = controlTokens.get(runId);
  return token
    ? { pauseRequested: token.pauseRequested, cancelRequested: token.cancelRequested, present: true }
    : { pauseRequested: false, cancelRequested: false, present: false };
}

// RC-2: per-run cooperative abort. RC-1 made cancel a step-BOUNDARY checkpoint
// (the driver breaks between steps). RC-2 bridges the same cancel intent to an
// AbortSignal that the in-flight run-step threads through its scheduler / worker
// / triage paths, so a cancel bails cooperatively MID-step (clean unwind via the
// MACHINE_RUN_CANCELLED error that withNodeLifecycle already turns into
// node.cancelled + waiting) instead of relying solely on subprocess SIGKILL +
// post-hoc node.cancelled. The controller is created lazily, aborted when cancel
// is requested, and discarded on resume (an aborted signal stays aborted, so a
// resumed run must get a fresh one).
const runAbortControllers = new Map();

function getRunAbortController(runId) {
  if (!runId) throw new Error('runId is required.');
  let controller = runAbortControllers.get(runId);
  if (!controller) {
    controller = new AbortController();
    runAbortControllers.set(runId, controller);
  }
  return controller;
}

// The signal the driver passes into executeMachineRunStep. Same process as the
// cancel request, so an abort fired by requestRunCancel is observed by the
// in-flight step at its next checkpoint.
function getRunAbortSignal(runId) {
  return getRunAbortController(runId).signal;
}

function abortRunSignal(runId, reason = 'run-control.cancel-requested') {
  const controller = runAbortControllers.get(runId);
  if (controller && !controller.signal.aborted) {
    try { controller.abort(reason); } catch { controller.abort(); }
  }
}

function clearRunAbortSignal(runId) {
  runAbortControllers.delete(runId);
}

function isRunAbortSignalAborted(signal) {
  return Boolean(signal && typeof signal === 'object' && signal.aborted === true);
}

// Standalone copies of machine.js's cancellation-error helpers so worker-loop.js
// (which cannot import machine.js without a cycle) can throw/normalize the SAME
// MACHINE_RUN_CANCELLED error machine.js's isRunCancellationError recognizes.
function createRunCancellationError(signal, cause = null, message = 'Run cancellation stopped work before completion.') {
  const err = new Error(message);
  err.code = 'MACHINE_RUN_CANCELLED';
  err.classification = 'CANCELLED';
  err.cancelled = true;
  err.retryable = false;
  err.fallbackAllowed = false;
  err.selfRepairAllowed = false;
  err.terminal = true;
  if (cause) err.cause = cause;
  return err;
}

function isRunCancellationLikeError(err) {
  let current = err;
  let depth = 0;
  while (current && depth < 5) {
    if (err && (current.cancelled === true || current.classification === 'CANCELLED'
      || current.code === 'MACHINE_RUN_CANCELLED' || current.code === 'CANCELLED')) return true;
    const code = String(current.code || '');
    const name = String(current.name || '');
    if (code === 'ABORT_ERR' || code === 'AbortError' || name === 'AbortError') return true;
    current = current.cause;
    depth += 1;
  }
  return false;
}

function throwIfRunSignalAborted(signal, message) {
  if (isRunAbortSignalAborted(signal)) throw createRunCancellationError(signal, null, message);
}

// Map an error thrown by aborted work (e.g. a SIGKILLed subprocess) into a clean
// cancellation when the run's signal is aborted, so the caller records
// node.cancelled rather than node.failed.
function normalizeRunCancellationError(err, signal, message) {
  if (isRunCancellationLikeError(err)) {
    if (err && !err.code) err.code = 'MACHINE_RUN_CANCELLED';
    if (err) { err.cancelled = true; err.classification = err.classification || 'CANCELLED'; err.terminal = true; err.retryable = false; }
    return err;
  }
  if (isRunAbortSignalAborted(signal)) return createRunCancellationError(signal, err, message);
  return err;
}

// Pure projection of durable control intent from the event log. Last-writer-wins
// between pause-requested and resume-requested; cancel-requested latches true.
function projectRunControlFromEvents(events = []) {
  let desire = 'run';
  let cancelRequested = false;
  let pauseRequestSequence = null;
  let resumeRequestSequence = null;
  let cancelRequestSequence = null;
  for (const event of events || []) {
    const type = String(event?.eventType || '');
    if (type === RUN_CONTROL_EVENT_TYPES.pauseRequested) {
      desire = 'pause';
      pauseRequestSequence = event.sequence ?? pauseRequestSequence;
    } else if (type === RUN_CONTROL_EVENT_TYPES.resumeRequested) {
      desire = 'run';
      resumeRequestSequence = event.sequence ?? resumeRequestSequence;
    } else if (type === RUN_CONTROL_EVENT_TYPES.cancelRequested) {
      cancelRequested = true;
      cancelRequestSequence = event.sequence ?? cancelRequestSequence;
    }
  }
  return {
    shouldPause: desire === 'pause',
    cancelRequested,
    pauseRequestSequence,
    resumeRequestSequence,
    cancelRequestSequence,
  };
}

// Resolve effective intent for the running driver. Prefers the in-process token
// (set synchronously when the request arrives); falls back to the durable event
// log when the token is absent (fresh process after a crash/restart).
function resolveRunControlIntent({ runId, events } = {}) {
  const token = controlTokens.get(runId);
  if (token) {
    return { shouldPause: token.pauseRequested, cancelRequested: token.cancelRequested, source: 'token' };
  }
  const projected = projectRunControlFromEvents(events || []);
  return { shouldPause: projected.shouldPause, cancelRequested: projected.cancelRequested, source: 'events' };
}

// Pure boundary decision: given resolved intent, should the driver loop stop and,
// if so, why. Cancel takes precedence over pause.
function evaluateBoundaryControl(intent = {}) {
  if (intent.cancelRequested) return { stop: true, stopReason: 'cancel-requested' };
  if (intent.shouldPause) return { stop: true, stopReason: 'paused' };
  return { stop: false, stopReason: '' };
}

async function readAuthoritativeRunState(runRoot) {
  return await readRunState(runRoot) || projectRunStateFromEvents(await readMachineEvents(runRoot));
}

// Request a pause. Lock-free: sets the in-process token and appends the durable
// intent event. Safe to call while the driver loop holds the run-lifecycle lock.
async function requestRunPause(runRoot, options = {}) {
  const { runId, actor = 'user', reason = 'run-control.pause-requested', payload = {} } = options;
  if (!runId) throw new Error('runId is required.');
  markPauseRequested(runId);
  const event = await appendMachineEvent(runRoot, {
    runId,
    actor,
    eventType: RUN_CONTROL_EVENT_TYPES.pauseRequested,
    reason,
    payload,
  });
  return { event, intent: readRunControlToken(runId) };
}

// Request a cancel (intent). The actual cancelling/cancelled transition + process
// teardown remains the existing cancelRunHandler's job (the ack). Lock-free.
async function requestRunCancel(runRoot, options = {}) {
  const { runId, actor = 'user', reason = 'run-control.cancel-requested', payload = {} } = options;
  if (!runId) throw new Error('runId is required.');
  markCancelRequested(runId);
  // RC-2: fire the cooperative abort so an in-flight step bails mid-flight at its
  // next checkpoint, not only when the driver reaches the next step boundary.
  abortRunSignal(runId, reason);
  const event = await appendMachineEvent(runRoot, {
    runId,
    actor,
    eventType: RUN_CONTROL_EVENT_TYPES.cancelRequested,
    reason,
    payload,
  });
  return { event, intent: readRunControlToken(runId) };
}

// Driver-side ack of a pause: records the run.status transition to `paused`.
// Called from inside the driver loop (which already holds the lifecycle lock) at
// the safe boundary between steps. No-op-safe if already paused.
async function pauseRunAtBoundary(runRoot, options = {}) {
  const { runId, reason = 'run-control.paused', payload = {} } = options;
  if (!runId) throw new Error('runId is required.');
  return appendRunLifecycleStatus(runRoot, {
    runId,
    toState: 'paused',
    reason,
    payload,
  });
}

// Resume a paused run: clears the pause token, records the resume intent, and (if
// the run is currently paused) transitions it back to the idle `waiting` state
// from which the driver re-enters. Refuses to resume a terminal run.
async function requestRunResume(runRoot, options = {}) {
  const { runId, actor = 'user', reason = 'run-control.resume-requested', toState = 'waiting', payload = {} } = options;
  if (!runId) throw new Error('runId is required.');
  markResumeRequested(runId);
  // RC-2: an aborted AbortSignal stays aborted forever, so a resumed run must get
  // a fresh controller — otherwise the re-driven step would see signal.aborted
  // and immediately bail. (Cancel is terminal, so this matters for pause/resume.)
  clearRunAbortSignal(runId);
  const resumeEvent = await appendMachineEvent(runRoot, {
    runId,
    actor,
    eventType: RUN_CONTROL_EVENT_TYPES.resumeRequested,
    reason,
    payload,
  });
  const current = await readAuthoritativeRunState(runRoot);
  if (current && TERMINAL_RUN_LIFECYCLE_STATES.has(current.lifecycleStatus)) {
    const err = new Error(`Cannot resume a terminal run (${current.lifecycleStatus}).`);
    err.code = 'MACHINE_RUN_TERMINAL';
    err.lifecycleStatus = current.lifecycleStatus;
    throw err;
  }
  let transition = { duplicate: true };
  let renewedLeaseCount = 0;
  if (current && current.lifecycleStatus === 'paused') {
    // RC-4: a long pause must not let an active claim's lease expire into
    // stale-claim recovery (which would re-queue the item and discard the held
    // work). Heartbeat every active lease so the paused duration doesn't count
    // toward expiry, BEFORE the resume's recoverStaleClaims runs. This is a
    // resume-time renewal — no background keepalive ticker (no-daemon value).
    // Scoped to the in-process pause->resume path, so a true crash-recovery
    // (cross-process Recover) still lets genuinely stale claims be reclaimed.
    const activeLeases = await readActiveClaimLeases(runRoot);
    for (const lease of activeLeases) {
      try {
        await heartbeatClaimLease(runRoot, lease.claimId, { now: options.now });
        renewedLeaseCount += 1;
      } catch {
        // A lease that flipped inactive mid-resume is fine to skip.
      }
    }
    transition = await appendRunLifecycleStatus(runRoot, {
      runId,
      toState,
      reason: 'run-control.resumed',
      payload,
    });
  }
  return { resumeEvent, transition, renewedLeaseCount, intent: readRunControlToken(runId) };
}

module.exports = {
  RUN_CONTROL_EVENT_TYPES,
  abortRunSignal,
  clearRunAbortSignal,
  clearRunControlToken,
  createRunCancellationError,
  evaluateBoundaryControl,
  getRunAbortSignal,
  isRunAbortSignalAborted,
  markCancelRequested,
  markPauseRequested,
  markResumeRequested,
  normalizeRunCancellationError,
  pauseRunAtBoundary,
  projectRunControlFromEvents,
  readRunControlToken,
  requestRunCancel,
  requestRunPause,
  requestRunResume,
  resolveRunControlIntent,
  throwIfRunSignalAborted,
};
