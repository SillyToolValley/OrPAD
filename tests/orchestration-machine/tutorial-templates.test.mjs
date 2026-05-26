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

const PIPELINE_TEMPLATES = [
  {
    label: 'product-decision-gate',
    pipelinePath: 'nodes/orpad.core/examples/product-decision-gate/pipeline.or-pipeline',
    expectExecutable: false,
  },
  {
    label: 'release-risk-routing',
    pipelinePath: 'nodes/orpad.core/examples/release-risk-routing/pipeline.or-pipeline',
    expectExecutable: false,
  },
  {
    label: 'product-build-workstream',
    pipelinePath: 'nodes/orpad.workstream/examples/product-build-workstream/pipeline.or-pipeline',
    expectExecutable: true,
  },
  {
    label: 'maintenance-quality-workstream',
    pipelinePath: 'nodes/orpad.workstream/examples/maintenance-workstream.or-pipeline',
    expectExecutable: false,
  },
];

test('built-in product and maintenance pipeline templates validate without errors', async () => {
  for (const template of PIPELINE_TEMPLATES) {
    const result = await validateRunbookFile(path.join(repoRoot, template.pipelinePath), {
      trustLevel: 'local-authored',
      checkFiles: true,
    });
    const errors = (result.diagnostics || []).filter(item => item.level === 'error');
    assert.equal(errors.length, 0, `${template.label}: ${JSON.stringify(errors)}`);
    assert.equal(result.ok, true, `${template.label} should be ok`);
  }
});

test('built-in pipeline templates flag template-only execution policy', async () => {
  for (const template of PIPELINE_TEMPLATES) {
    const raw = await fs.readFile(path.join(repoRoot, template.pipelinePath), 'utf8');
    const pipeline = JSON.parse(raw);
    assert.equal(pipeline.template, true, `${template.label} must declare template: true`);
    assert.equal(pipeline.executionPolicy?.mode, 'template-only', `${template.label} must use template-only execution policy`);
    assert.equal(pipeline.executionPolicy?.copyBeforeRun, true, `${template.label} must copy before run`);
    assert.equal(pipeline.trustLevel, 'local-authored', `${template.label} must be local-authored`);
    assert.doesNotMatch(`${pipeline.id} ${pipeline.title} ${pipeline.description}`, /\btutorial\b/i);
  }
});

test('product build workstream template runs to completion against its harness fixture', async () => {
  const sourceDir = path.join(repoRoot, 'nodes/orpad.workstream/examples/product-build-workstream');
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-product-build-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/product-build-workstream');
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
    path.join(workspaceRoot, 'product-plan.md'),
    'before product build run\n',
    'utf8',
  );

  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId: 'run_20260505_product_build',
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
  assert.ok(workerResult, 'product build run must produce a worker.result event');
  assert.equal(workerResult.payload.status, 'done');
  assert.deepEqual(workerResult.payload.changedFiles, ['product-plan.md']);
  assert.equal(executed.finalization.summaryStatus, 'blocked');
  assert.equal(executed.finalization.supportBlocked.nodePath, 'main/patch-review');

  // Fork-Join Phase 2 dry-run diagnostic: when a support node
  // completes (non-blocked) the scheduler emits a
  // `scheduler.edgeEvaluation` event listing fired/dropped outgoing
  // edges. The product-build template intentionally blocks at
  // patchReview for human approval, so no diagnostics should fire from
  // that blocked source.
  const edgeEvalEvents = events.filter(event => event.eventType === 'scheduler.edgeEvaluation');
  const reviewEval = edgeEvalEvents.find(event => event.nodePath === 'main/patch-review');
  assert.equal(reviewEval, undefined, 'patchReview that BLOCKS must NOT emit a scheduler.edgeEvaluation diagnostic');
  for (const event of edgeEvalEvents) {
    assert.equal(event.payload.phase, 'phase-2-dry-run');
    assert.equal(typeof event.payload.firedCount, 'number');
    assert.equal(typeof event.payload.droppedCount, 'number');
  }

  const completedSequence = events
    .filter(event => event.eventType === 'node.completed')
    .map(event => event.nodePath);
  assert.deepEqual(completedSequence.slice(0, 4), [
    'main/entry',
    'main/probe',
    'main/queue',
    'main/triage',
  ], `expected entry -> probe -> queue -> triage prefix, got ${JSON.stringify(completedSequence)}`);

  const dispatcherIdx = completedSequence.indexOf('main/dispatcher');
  const workerIdx = completedSequence.indexOf('main/worker');
  assert.ok(dispatcherIdx >= 0, 'dispatcher should have completed at least once');
  assert.ok(workerIdx >= 0, 'worker should have completed at least once');
  assert.ok(dispatcherIdx < workerIdx, `dispatcher (${dispatcherIdx}) must come before worker (${workerIdx})`);

  const reviewIdx = completedSequence.indexOf('main/patch-review');
  assert.equal(reviewIdx, -1, 'patch-review blocks rather than completing');
  const blockedEvents = events.filter(event => (
    event.eventType === 'node.blocked' && event.nodePath === 'main/patch-review'
  ));
  assert.equal(blockedEvents.length, 1, 'patch-review should emit exactly one node.blocked event');

  const lockGrantedEvents = events.filter(event => event.eventType === 'lock.granted');
  const lockReleasedEvents = events.filter(event => event.eventType === 'lock.released');
  assert.equal(lockGrantedEvents.length, 1, 'product build run should emit exactly one lock.granted event');
  assert.equal(lockReleasedEvents.length, 1, 'product build run should emit exactly one lock.released event');
  assert.equal(lockGrantedEvents[0].payload.phase, 'file-lock-queue-phase-1');
  assert.equal(lockGrantedEvents[0].payload.waited, false);
  assert.ok(lockGrantedEvents[0].sequence < lockReleasedEvents[0].sequence);

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
