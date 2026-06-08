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
  findQueueItem,
  readActiveClaimLeases,
  readActiveWriteSetLocks,
  readMachineEvents,
  readBudgetLedger,
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
  {
    label: 'ralph-verify-fix-loop',
    pipelinePath: 'nodes/orpad.workstream/examples/ralph-verify-fix-loop/pipeline.or-pipeline',
    expectExecutable: false,
  },
  {
    label: 'ultraqa-gate-cycle',
    pipelinePath: 'nodes/orpad.workstream/examples/ultraqa-gate-cycle/pipeline.or-pipeline',
    expectExecutable: false,
  },
  {
    label: 'consensus-decision-gate',
    pipelinePath: 'nodes/orpad.core/examples/consensus-decision-gate/pipeline.or-pipeline',
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
  assert.equal(executed.finalization.summaryStatus, 'partial');
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

// R4 integration: exercise the executeWorkerClaim budget wiring end to end on the
// deterministic product-build harness fixture, with a budget injected onto the
// pipeline's machineAdapter. The harness keeps the worker free of CLI cost while
// hasLiveAdapter makes `adapter` (and thus liftedPipelineAdapter(adapter).budget)
// non-null so the R4 block actually runs. This is the spec the QA review flagged
// as missing: helper unit tests cannot prove the guard short-circuits the spawn,
// emits the pre-worker warning, or records the estimated ledger entry.
async function setupBudgetedProductBuild(repoRootDir, budget) {
  const sourceDir = path.join(repoRootDir, 'nodes/orpad.workstream/examples/product-build-workstream');
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-r4-budget-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/product-build-workstream');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipeline = JSON.parse(await fs.readFile(path.join(sourceDir, 'pipeline.or-pipeline'), 'utf8'));
  // Inject a runnable CLI adapter carrying the budget. hasHarness still wins for
  // execution routing (worker uses the nodeCliPatch fixture), but `adapter` is
  // now non-null so the worker-path budget governance activates.
  pipeline.run.machineAdapter = {
    schemaVersion: 'orpad.machineAdapter.v2',
    enabled: true,
    default: {
      family: 'cli', providerId: 'codex-cli', model: 'codex', qualityTier: 'standard',
      sessionStrategy: 'none', toolPolicy: 'none', sandbox: null, approvalPolicy: 'never',
      timeoutMs: 600000, ephemeral: true,
    },
    budget,
  };
  await fs.writeFile(path.join(pipelineDir, 'pipeline.or-pipeline'), JSON.stringify(pipeline, null, 2), 'utf8');
  await fs.copyFile(
    path.join(sourceDir, 'graphs/main.or-graph'),
    path.join(pipelineDir, 'graphs/main.or-graph'),
  );
  await fs.writeFile(path.join(workspaceRoot, 'product-plan.md'), 'before product build run\n', 'utf8');
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  const run = await createMachineRun({ workspaceRoot, pipelinePath, runId: 'run_20260603_r4_budget' });
  return { workspaceRoot, pipelineDir, pipelinePath, run };
}

test('R4: a hardStop token budget blocks the worker BEFORE it spawns and emits a pre-worker budget.warning', async () => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await setupBudgetedProductBuild(
    repoRoot,
    { perRunTokens: 1, hardStop: true },
  );
  // The pre-spawn guard throws BUDGET_EXCEEDED inside the worker node; the run
  // finalizes blocked/failed rather than crashing.
  await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  }).catch(() => {});

  const events = await readMachineEvents(run.runRoot);
  const warning = events.find(e => e.eventType === 'budget.warning' && e.payload?.phase === 'pre-worker');
  assert.ok(warning, 'expected a pre-worker budget.warning');
  assert.equal(warning.payload.hardStop, true);
  assert.equal(warning.payload.usageSource, 'estimated');
  assert.ok((warning.payload.violations || []).some(v => v.kind === 'per-run-tokens'), 'token ceiling breach');

  const workerResult = events.find(e => e.eventType === 'worker.result');
  assert.equal(workerResult, undefined, 'worker fixture must NOT run when the hardStop guard fires before spawn');
  const recovery = events.find(e => e.eventType === 'queue.transition' && e.reason === 'budget.hard-stop');
  assert.ok(recovery, 'budget hard stop must release the claimed queue item through a durable transition');
  assert.equal(recovery.fromState, 'claimed');
  assert.equal(recovery.toState, 'queued');
  assert.equal((await findQueueItem(run.runRoot, recovery.itemId)).state, 'queued');
  assert.equal((await readActiveClaimLeases(run.runRoot)).length, 0);
  assert.equal((await readActiveWriteSetLocks(run.runRoot)).length, 0);
  // The estimate is NOT recorded on a hard stop (recording runs only after the
  // worker loop, which never executes).
  const ledger = await readBudgetLedger(run.runRoot);
  assert.equal(ledger.entries.length, 0, 'no ledger entry on a pre-spawn hard stop');

  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

test('R4: a soft token budget warns, lets the worker run, and records an estimated ledger entry', async () => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await setupBudgetedProductBuild(
    repoRoot,
    { perRunTokens: 1, hardStop: false },
  );
  await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });

  const events = await readMachineEvents(run.runRoot);
  const warning = events.find(e => e.eventType === 'budget.warning' && e.payload?.phase === 'pre-worker');
  assert.ok(warning, 'expected a pre-worker budget.warning on the soft budget too');
  assert.equal(warning.payload.hardStop, false);

  const workerResult = events.find(e => e.eventType === 'worker.result');
  assert.ok(workerResult, 'soft budget must let the worker fixture run');
  assert.equal(workerResult.payload.status, 'done');

  const ledger = await readBudgetLedger(run.runRoot);
  const estimated = ledger.entries.filter(entry => entry.usageSource === 'estimated');
  assert.equal(estimated.length, 1, 'exactly one estimated worker entry is recorded');
  assert.equal(estimated[0].nodePath, 'main/worker');
  assert.ok(estimated[0].totalTokens > 0, 'estimated entry carries token counts');
  assert.ok(Number.isFinite(estimated[0].sourceEventSequence), 'estimate is bound to the worker.result event sequence');

  await fs.rm(workspaceRoot, { recursive: true, force: true });
});
