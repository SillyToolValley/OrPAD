import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { validateRunbookFile } = require('../../src/main/runbooks/validator');
const {
  createMachineRun,
  executeMachineRunStep,
  readMachineEvents,
} = require('../../src/main/orchestration-machine');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const TUTORIALS = [
  {
    label: 'gate-decision',
    pipelinePath: 'nodes/orpad.core/examples/tutorial-gate-decision/pipeline.or-pipeline',
    expectExecutable: false,
  },
  {
    label: 'selector-branching',
    pipelinePath: 'nodes/orpad.core/examples/tutorial-selector-branching/pipeline.or-pipeline',
    expectExecutable: false,
  },
  {
    label: 'worker-patch-review',
    pipelinePath: 'nodes/orpad.workstream/examples/tutorial-worker-patch-review/pipeline.or-pipeline',
    expectExecutable: true,
  },
];

test('tutorial pipelines validate without errors', async () => {
  for (const tutorial of TUTORIALS) {
    const result = await validateRunbookFile(path.join(repoRoot, tutorial.pipelinePath), {
      trustLevel: 'local-authored',
      checkFiles: true,
    });
    const errors = (result.diagnostics || []).filter(item => item.level === 'error');
    assert.equal(errors.length, 0, `${tutorial.label}: ${JSON.stringify(errors)}`);
    assert.equal(result.ok, true, `${tutorial.label} should be ok`);
  }
});

test('tutorial templates flag template-only execution policy', async () => {
  for (const tutorial of TUTORIALS) {
    const raw = await fs.readFile(path.join(repoRoot, tutorial.pipelinePath), 'utf8');
    const pipeline = JSON.parse(raw);
    assert.equal(pipeline.template, true, `${tutorial.label} must declare template: true`);
    assert.equal(pipeline.executionPolicy?.mode, 'template-only', `${tutorial.label} must use template-only execution policy`);
    assert.equal(pipeline.executionPolicy?.copyBeforeRun, true, `${tutorial.label} must copy before run`);
    assert.equal(pipeline.trustLevel, 'local-authored', `${tutorial.label} must be local-authored`);
  }
});

test('worker patch review tutorial runs to completion against its harness fixture', async () => {
  const sourceDir = path.join(repoRoot, 'nodes/orpad.workstream/examples/tutorial-worker-patch-review');
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-tutorial-worker-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/tutorial-worker-patch-review');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  await fs.copyFile(
    path.join(sourceDir, 'pipeline.or-pipeline'),
    path.join(pipelineDir, 'pipeline.or-pipeline'),
  );
  await fs.copyFile(
    path.join(sourceDir, 'graphs/main.or-graph'),
    path.join(pipelineDir, 'graphs/main.or-graph'),
  );
  await fs.writeFile(
    path.join(workspaceRoot, 'tutorial-target.md'),
    'before tutorial run\n',
    'utf8',
  );

  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId: 'run_20260505_tutorial_worker',
  });

  const executed = await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });

  const events = await readMachineEvents(run.runRoot);
  const workerResult = events.find(event => event.eventType === 'worker.result');
  assert.ok(workerResult, 'tutorial run must produce a worker.result event');
  assert.equal(workerResult.payload.status, 'done');
  assert.deepEqual(workerResult.payload.changedFiles, ['tutorial-target.md']);
  assert.equal(executed.finalization.summaryStatus, 'blocked');
  assert.equal(executed.finalization.supportBlocked.nodePath, 'main/patch-review');

  // Fork-Join Phase 2 dry-run diagnostic: when a support node
  // completes (non-blocked) the scheduler emits a
  // `scheduler.edgeEvaluation` event listing fired/dropped outgoing
  // edges. Codex cross-review 2026-05-16 caught that the original
  // wiring emitted the diagnostic even for BLOCKED patchReview,
  // surfacing "exit would fire" on a node that hadn't actually
  // decided anything. The fix skips the diagnostic when
  // `supportResult.blocked === true`. The tutorial pipeline has no
  // labelled edges and only one decision-emitting source
  // (patch-review) which blocks here, so no diagnostics fire on this
  // particular run — that's the EXPECTED outcome and pins the
  // blocked-source skip behavior. The active-wiring path is covered
  // by the edge-evaluator unit tests.
  const edgeEvalEvents = events.filter(event => event.eventType === 'scheduler.edgeEvaluation');
  const reviewEval = edgeEvalEvents.find(event => event.nodePath === 'main/patch-review');
  assert.equal(reviewEval, undefined, 'patchReview that BLOCKS must NOT emit a scheduler.edgeEvaluation diagnostic');
  for (const event of edgeEvalEvents) {
    assert.equal(event.payload.phase, 'phase-2-dry-run');
    assert.equal(typeof event.payload.firedCount, 'number');
    assert.equal(typeof event.payload.droppedCount, 'number');
  }

  // Fork-Join Phase 3 Step 1 (ready-set scheduler refactor) replay
  // guard: the scheduler must produce the SAME visit sequence the
  // pre-refactor for-loop produced. Codex cross-review caught that
  // the original assertion only checked the first 4 nodes and was
  // too loose — it allowed multiple post-triage reorderings. The
  // tightened version pins the FULL lifecycle subsequence so any
  // Step 2 fan-out enabling shows up as a visible failure.
  const completedSequence = events
    .filter(event => event.eventType === 'node.completed')
    .map(event => event.nodePath);
  // Required prefix (single-threaded harness mode): entry → probe →
  // queue → triage. These must appear in this exact order at the
  // start of the run.
  assert.deepEqual(completedSequence.slice(0, 4), [
    'main/entry',
    'main/probe',
    'main/queue',
    'main/triage',
  ], `expected entry -> probe -> queue -> triage prefix, got ${JSON.stringify(completedSequence)}`);

  // Strict ordering after triage: dispatcher must appear before
  // worker, and BOTH must appear before patch-review's
  // node.blocked event. This locks Phase 3 Step 1's per-node forward
  // predecessor gating against accidental Step 2 fan-out leakage.
  const dispatcherIdx = completedSequence.indexOf('main/dispatcher');
  const workerIdx = completedSequence.indexOf('main/worker');
  assert.ok(dispatcherIdx >= 0, 'dispatcher should have completed at least once');
  assert.ok(workerIdx >= 0, 'worker should have completed at least once');
  assert.ok(dispatcherIdx < workerIdx, `dispatcher (${dispatcherIdx}) must come before worker (${workerIdx})`);

  // patch-review doesn't fire a node.completed because it blocks.
  const reviewIdx = completedSequence.indexOf('main/patch-review');
  assert.equal(reviewIdx, -1, 'patch-review blocks rather than completing');
  const blockedEvents = events.filter(event => (
    event.eventType === 'node.blocked' && event.nodePath === 'main/patch-review'
  ));
  assert.equal(blockedEvents.length, 1, 'patch-review should emit exactly one node.blocked event');

  // File-Lock Queue Phase 1: the worker-loop now acquires/releases
  // file locks around adapter.invoke. The tutorial's worker fixture
  // ran once, so we expect exactly one lock.granted/lock.released
  // pair tagged with the file-lock-queue-phase-1 phase.
  const lockGrantedEvents = events.filter(event => event.eventType === 'lock.granted');
  const lockReleasedEvents = events.filter(event => event.eventType === 'lock.released');
  assert.equal(lockGrantedEvents.length, 1, 'tutorial worker run should emit exactly one lock.granted event');
  assert.equal(lockReleasedEvents.length, 1, 'tutorial worker run should emit exactly one lock.released event');
  assert.equal(lockGrantedEvents[0].payload.phase, 'file-lock-queue-phase-1');
  // First worker run has no contention so it should NOT have waited.
  assert.equal(lockGrantedEvents[0].payload.waited, false);
  // Granted must come BEFORE released.
  assert.ok(lockGrantedEvents[0].sequence < lockReleasedEvents[0].sequence);
  // The blocked event must come AFTER the worker's last completion
  // — Step 1's forward-predecessor gating guarantees this.
  const lastWorkerCompleted = events.findLast(event => (
    event.eventType === 'node.completed' && event.nodePath === 'main/worker'
  ));
  assert.ok(lastWorkerCompleted, 'worker must have at least one completion event');
  assert.ok(
    blockedEvents[0].sequence > lastWorkerCompleted.sequence,
    `patch-review blocked sequence (${blockedEvents[0].sequence}) must come after last worker completed (${lastWorkerCompleted.sequence})`,
  );

  await fs.rm(workspaceRoot, { recursive: true, force: true });
});
