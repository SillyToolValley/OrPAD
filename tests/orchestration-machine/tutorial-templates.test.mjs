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

  await fs.rm(workspaceRoot, { recursive: true, force: true });
});
