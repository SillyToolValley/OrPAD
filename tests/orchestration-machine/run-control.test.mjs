// RC-1: cooperative run-control (pause/resume/cancel intent + 'paused' state).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  RUN_CONTROL_EVENT_TYPES,
  clearRunControlToken,
  evaluateBoundaryControl,
  markCancelRequested,
  markPauseRequested,
  markResumeRequested,
  pauseRunAtBoundary,
  projectRunControlFromEvents,
  readRunControlToken,
  requestRunCancel,
  requestRunPause,
  requestRunResume,
  resolveRunControlIntent,
} from '../../src/main/orchestration-machine/run-control.js';
import {
  RUN_LIFECYCLE_STATES,
  TERMINAL_RUN_LIFECYCLE_STATES,
  appendRunLifecycleStatus,
  assertRunLifecycleCanTransition,
} from '../../src/main/orchestration-machine/lifecycle.js';
import {
  appendMachineEvent,
  projectRunStateFromEvents,
  readMachineEvents,
} from '../../src/main/orchestration-machine/events.js';

// Temp run root whose basename does NOT start with 'run_', so the event log's
// runId<->run-root assertion is skipped and we can use a synthetic runId.
function makeRunRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-rc-'));
}

async function seedCreatedRun(runRoot, runId) {
  await appendMachineEvent(runRoot, {
    runId,
    actor: 'machine',
    eventType: 'run.created',
    payload: {
      pipelineId: 'p',
      pipelinePath: 'p/pipeline.or-pipeline',
      runRoot: path.basename(runRoot),
      latestRunExportPath: 'p/latest-run',
      lifecycleStatus: 'created',
      summaryStatus: 'pending',
      canonicalStoreKind: 'jsonl',
      metadata: {},
    },
  });
}

// --- lifecycle state machine -------------------------------------------------

test("'paused' is a known lifecycle state and is NOT terminal", () => {
  assert.equal(RUN_LIFECYCLE_STATES.has('paused'), true);
  assert.equal(TERMINAL_RUN_LIFECYCLE_STATES.has('paused'), false);
});

test('lifecycle allows running->paused and paused->running/waiting', async () => {
  const runRoot = makeRunRoot();
  const runId = 'run_rc_transition';
  try {
    await seedCreatedRun(runRoot, runId);
    await appendRunLifecycleStatus(runRoot, { runId, toState: 'running' });
    // running -> paused
    const toPaused = await assertRunLifecycleCanTransition(runRoot, 'paused', 'test');
    assert.equal(toPaused.lifecycleStatus, 'running');
    await appendRunLifecycleStatus(runRoot, { runId, toState: 'paused' });
    // paused -> running and paused -> waiting both permitted (non-terminal)
    const fromPaused = await assertRunLifecycleCanTransition(runRoot, 'running', 'test');
    assert.equal(fromPaused.lifecycleStatus, 'paused');
    await assert.doesNotReject(assertRunLifecycleCanTransition(runRoot, 'waiting', 'test'));
  } finally {
    clearRunControlToken(runId);
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

// --- pure projection ---------------------------------------------------------

test('projectRunControlFromEvents: last-writer-wins pause/resume, cancel latches', () => {
  const base = (type, sequence) => ({ eventType: type, sequence });
  // pause then nothing
  assert.equal(projectRunControlFromEvents([base(RUN_CONTROL_EVENT_TYPES.pauseRequested, 1)]).shouldPause, true);
  // pause then resume -> not paused
  assert.equal(
    projectRunControlFromEvents([
      base(RUN_CONTROL_EVENT_TYPES.pauseRequested, 1),
      base(RUN_CONTROL_EVENT_TYPES.resumeRequested, 2),
    ]).shouldPause,
    false,
  );
  // resume then pause -> paused (last writer wins)
  assert.equal(
    projectRunControlFromEvents([
      base(RUN_CONTROL_EVENT_TYPES.resumeRequested, 1),
      base(RUN_CONTROL_EVENT_TYPES.pauseRequested, 2),
    ]).shouldPause,
    true,
  );
  // cancel latches
  const c = projectRunControlFromEvents([base(RUN_CONTROL_EVENT_TYPES.cancelRequested, 1)]);
  assert.equal(c.cancelRequested, true);
  assert.equal(c.cancelRequestSequence, 1);
  // empty -> default run
  assert.deepEqual(
    { shouldPause: projectRunControlFromEvents([]).shouldPause, cancel: projectRunControlFromEvents([]).cancelRequested },
    { shouldPause: false, cancel: false },
  );
});

// --- in-memory token + resolution -------------------------------------------

test('resolveRunControlIntent prefers the in-process token, falls back to events', () => {
  const runId = 'run_rc_token';
  try {
    // token absent -> falls back to events
    const fromEvents = resolveRunControlIntent({
      runId,
      events: [{ eventType: RUN_CONTROL_EVENT_TYPES.pauseRequested, sequence: 1 }],
    });
    assert.equal(fromEvents.shouldPause, true);
    assert.equal(fromEvents.source, 'events');
    // token present -> token wins even if events say otherwise
    markPauseRequested(runId);
    const fromToken = resolveRunControlIntent({ runId, events: [] });
    assert.equal(fromToken.shouldPause, true);
    assert.equal(fromToken.source, 'token');
    // resume clears pause in token, leaves cancel
    markCancelRequested(runId);
    markResumeRequested(runId);
    const after = readRunControlToken(runId);
    assert.equal(after.pauseRequested, false);
    assert.equal(after.cancelRequested, true);
    // clearing the token removes the fast-path entirely
    clearRunControlToken(runId);
    assert.equal(readRunControlToken(runId).present, false);
  } finally {
    clearRunControlToken(runId);
  }
});

// --- pure boundary decision --------------------------------------------------

test('evaluateBoundaryControl: cancel beats pause beats continue', () => {
  assert.deepEqual(evaluateBoundaryControl({ cancelRequested: true, shouldPause: true }), { stop: true, stopReason: 'cancel-requested' });
  assert.deepEqual(evaluateBoundaryControl({ shouldPause: true }), { stop: true, stopReason: 'paused' });
  assert.deepEqual(evaluateBoundaryControl({}), { stop: false, stopReason: '' });
});

// --- request/ack integration on a real run root ------------------------------

test('requestRunPause appends the intent event and sets the token (no lifecycle change yet)', async () => {
  const runRoot = makeRunRoot();
  const runId = 'run_rc_pausereq';
  try {
    await seedCreatedRun(runRoot, runId);
    await appendRunLifecycleStatus(runRoot, { runId, toState: 'running' });
    const { event } = await requestRunPause(runRoot, { runId });
    assert.equal(event.eventType, RUN_CONTROL_EVENT_TYPES.pauseRequested);
    assert.equal(readRunControlToken(runId).pauseRequested, true);
    // intent recorded, but lifecycle is still running until the driver acks it
    const state = projectRunStateFromEvents(await readMachineEvents(runRoot));
    assert.equal(state.lifecycleStatus, 'running');
  } finally {
    clearRunControlToken(runId);
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test('pauseRunAtBoundary records the run.status -> paused ack; replay reconstructs it', async () => {
  const runRoot = makeRunRoot();
  const runId = 'run_rc_pauseack';
  try {
    await seedCreatedRun(runRoot, runId);
    await appendRunLifecycleStatus(runRoot, { runId, toState: 'running' });
    await requestRunPause(runRoot, { runId });
    await pauseRunAtBoundary(runRoot, { runId });
    // replay from the event log ALONE reconstructs lifecycleStatus = paused
    const replayed = projectRunStateFromEvents(await readMachineEvents(runRoot));
    assert.equal(replayed.lifecycleStatus, 'paused');
  } finally {
    clearRunControlToken(runId);
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test('requestRunResume clears the token, emits resume-requested, and transitions paused->waiting', async () => {
  const runRoot = makeRunRoot();
  const runId = 'run_rc_resume';
  try {
    await seedCreatedRun(runRoot, runId);
    await appendRunLifecycleStatus(runRoot, { runId, toState: 'running' });
    await requestRunPause(runRoot, { runId });
    await pauseRunAtBoundary(runRoot, { runId });
    const { resumeEvent, transition } = await requestRunResume(runRoot, { runId });
    assert.equal(resumeEvent.eventType, RUN_CONTROL_EVENT_TYPES.resumeRequested);
    assert.equal(readRunControlToken(runId).pauseRequested, false);
    assert.equal(transition.duplicate, undefined); // an actual transition happened
    const state = projectRunStateFromEvents(await readMachineEvents(runRoot));
    assert.equal(state.lifecycleStatus, 'waiting');
  } finally {
    clearRunControlToken(runId);
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test('requestRunResume on a non-paused run records intent without forcing a transition', async () => {
  const runRoot = makeRunRoot();
  const runId = 'run_rc_resume_norun';
  try {
    await seedCreatedRun(runRoot, runId);
    await appendRunLifecycleStatus(runRoot, { runId, toState: 'running' });
    const { transition } = await requestRunResume(runRoot, { runId });
    assert.equal(transition.duplicate, true); // not paused -> no transition
    const state = projectRunStateFromEvents(await readMachineEvents(runRoot));
    assert.equal(state.lifecycleStatus, 'running');
  } finally {
    clearRunControlToken(runId);
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test('requestRunResume refuses a terminal run', async () => {
  const runRoot = makeRunRoot();
  const runId = 'run_rc_terminal';
  try {
    await seedCreatedRun(runRoot, runId);
    await appendRunLifecycleStatus(runRoot, { runId, toState: 'completed' });
    await assert.rejects(requestRunResume(runRoot, { runId }), err => err?.code === 'MACHINE_RUN_TERMINAL');
  } finally {
    clearRunControlToken(runId);
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test('requestRunCancel records cancel intent and sets the token', async () => {
  const runRoot = makeRunRoot();
  const runId = 'run_rc_cancel';
  try {
    await seedCreatedRun(runRoot, runId);
    await appendRunLifecycleStatus(runRoot, { runId, toState: 'running' });
    const { event } = await requestRunCancel(runRoot, { runId });
    assert.equal(event.eventType, RUN_CONTROL_EVENT_TYPES.cancelRequested);
    assert.equal(readRunControlToken(runId).cancelRequested, true);
    // the boundary decision now says stop with cancel precedence
    const intent = resolveRunControlIntent({ runId, events: await readMachineEvents(runRoot) });
    assert.deepEqual(evaluateBoundaryControl(intent), { stop: true, stopReason: 'cancel-requested' });
  } finally {
    clearRunControlToken(runId);
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});
