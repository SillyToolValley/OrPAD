import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  appendMachineEvent,
  createMachineRun,
  durableRunRoot,
  eventsPath,
  isLegacyLatestRunRef,
  latestRunExportRoot,
  readMachineEvents,
  readRunState,
  repairRunStateFromEvents,
  resolveRunRef,
} = require('../../src/main/orchestration-machine');

const fixedNow = new Date('2026-04-30T00:00:00.000Z');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

async function makeWorkspace() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/sample-machine-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'sample-machine-pipeline',
    entryGraph: 'graphs/main.or-graph',
    run: {
      queueRoot: 'harness/generated/latest-run/queue',
      artifactRoot: 'harness/generated/latest-run/artifacts',
    },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    graph: { nodes: [] },
  }, null, 2), 'utf8');
  return { workspaceRoot, pipelineDir, pipelinePath };
}

test('path resolver treats legacy latest-run refs as durable run aliases', async () => {
  const { pipelineDir } = await makeWorkspace();
  const runRoot = durableRunRoot(pipelineDir, 'run_20260430_000001');
  const queueRef = 'harness/generated/latest-run/queue';

  assert.equal(isLegacyLatestRunRef(queueRef), true);
  assert.equal(latestRunExportRoot(pipelineDir), path.join(pipelineDir, 'harness/generated/latest-run'));

  const resolved = resolveRunRef({ pipelineDir, runRoot, ref: queueRef });

  assert.equal(resolved.kind, 'legacy-latest-run-alias');
  assert.equal(resolved.runRelativePath, 'queue');
  assert.equal(resolved.resolvedPath, path.join(runRoot, 'queue'));
  assert.throws(
    () => durableRunRoot(pipelineDir, '../run_20260430_escape'),
    error => error?.code === 'MACHINE_RUN_ID_INVALID',
  );
});

test('current maintenance pipeline latest-run refs resolve to durable run paths', async () => {
  const sourcePipeline = path.join(
    repoRoot,
    '.orpad/pipelines/orpad-maintenance-quality-workstream-20260429/pipeline.or-pipeline',
  );
  const pipeline = JSON.parse(await fs.readFile(sourcePipeline, 'utf8'));
  const pipelineDir = path.dirname(sourcePipeline);
  const runRoot = durableRunRoot(pipelineDir, 'run_20260430_000010');

  for (const ref of [
    pipeline.run.queueRoot,
    pipeline.run.artifactRoot,
    pipeline.run.probeInboxRoot,
    pipeline.run.workItemArtifactRoot,
    pipeline.run.summaryPath,
    pipeline.run.metadataPath,
  ]) {
    const resolved = resolveRunRef({ pipelineDir, runRoot, ref });
    assert.equal(resolved.kind, 'legacy-latest-run-alias');
    assert.equal(resolved.resolvedPath.startsWith(runRoot), true, `${ref} must resolve under durable run root`);
  }
});

test('createMachineRun writes durable run root and leaves latest-run as export-only', async () => {
  const { workspaceRoot, pipelineDir, pipelinePath } = await makeWorkspace();
  const runId = 'run_20260430_000001';
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId,
    now: fixedNow,
  });

  assert.equal(run.runRoot, path.join(pipelineDir, 'runs', runId));
  assert.equal(run.latestRunExportPath, path.join(pipelineDir, 'harness/generated/latest-run'));

  const events = await readMachineEvents(run.runRoot);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'run.created');
  assert.equal(events[0].sequence, 0);

  const runState = await readRunState(run.runRoot);
  assert.equal(runState.runId, runId);
  assert.equal(runState.lifecycleStatus, 'created');
  assert.equal(runState.summaryStatus, 'pending');
  assert.equal(runState.eventSequence, 0);

  await assert.rejects(
    fs.stat(run.latestRunExportPath),
    error => error?.code === 'ENOENT',
    'createMachineRun must not materialize latest-run export',
  );
  await assert.rejects(
    createMachineRun({
      workspaceRoot,
      pipelinePath,
      runId,
      now: fixedNow,
    }),
    error => error?.code === 'MACHINE_RUN_ALREADY_EXISTS',
  );
  assert.equal((await readMachineEvents(run.runRoot)).length, 1);
});

test('createMachineRun rejects pipeline paths outside the workspace root', async () => {
  const { workspaceRoot } = await makeWorkspace();
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-outside-pipeline-'));
  const outsidePipelinePath = path.join(outsideRoot, 'outside.or-pipeline');
  await fs.writeFile(outsidePipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'outside-pipeline',
  }, null, 2), 'utf8');

  await assert.rejects(
    createMachineRun({
      workspaceRoot,
      pipelinePath: outsidePipelinePath,
      runId: 'run_20260430_outside_pipeline',
      now: fixedNow,
    }),
    error => error?.code === 'MACHINE_PIPELINE_OUTSIDE_WORKSPACE',
  );
});

test('Machine event append is monotonic and validates contract shape', async () => {
  const { workspaceRoot, pipelinePath } = await makeWorkspace();
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId: 'run_20260430_000002',
    now: fixedNow,
  });

  const statusEvent = await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    timestamp: '2026-04-30T00:00:01.000Z',
    actor: 'machine',
    eventType: 'run.status',
    fromState: 'created',
    toState: 'running',
  });

  assert.equal(statusEvent.sequence, 1);
  const events = await readMachineEvents(run.runRoot);
  assert.deepEqual(events.map(event => event.sequence), [0, 1]);

  await assert.rejects(
    appendMachineEvent(run.runRoot, {
      runId: 'run_20260430_other',
      timestamp: '2026-04-30T00:00:02.000Z',
      actor: 'machine',
      eventType: 'run.status',
      fromState: 'running',
      toState: 'completed',
    }),
    error => error?.code === 'MACHINE_EVENT_RUN_ID_MISMATCH',
  );
  assert.equal((await readMachineEvents(run.runRoot)).length, 2);

  await assert.rejects(
    appendMachineEvent(run.runRoot, {
      runId: run.runId,
      sequence: 99,
      timestamp: '2026-04-30T00:00:03.000Z',
      actor: 'machine',
      eventType: 'run.status',
      fromState: 'running',
      toState: 'completed',
    }),
    error => error?.code === 'MACHINE_EVENT_SEQUENCE_OWNED',
  );
  assert.equal((await readMachineEvents(run.runRoot)).length, 2);

  await assert.rejects(
    appendMachineEvent(run.runRoot, {
      runId: run.runId,
      actor: 'machine',
      toState: 'completed',
    }),
    /Invalid Orchestration Machine machineEvent contract/,
  );
});

test('Machine event append requires run.created as the first durable event', async () => {
  const { pipelineDir } = await makeWorkspace();
  await assert.rejects(
    appendMachineEvent(durableRunRoot(pipelineDir, 'run_20260430_orphan'), {
      runId: 'run_20260430_orphan',
      timestamp: '2026-04-30T00:00:00.000Z',
      actor: 'machine',
      eventType: 'run.status',
      toState: 'running',
    }),
    error => error?.code === 'MACHINE_EVENT_RUN_CREATED_REQUIRED',
  );
});

test('Machine event append binds run.created to the durable run root id', async () => {
  const { pipelineDir } = await makeWorkspace();
  await assert.rejects(
    appendMachineEvent(durableRunRoot(pipelineDir, 'run_20260430_bound'), {
      runId: 'run_20260430_other',
      timestamp: '2026-04-30T00:00:00.000Z',
      actor: 'machine',
      eventType: 'run.created',
    }),
    error => error?.code === 'MACHINE_EVENT_RUN_ROOT_MISMATCH',
  );
});

test('run-state can be repaired from committed Machine events', async () => {
  const { workspaceRoot, pipelinePath } = await makeWorkspace();
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId: 'run_20260430_000003',
    now: fixedNow,
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    timestamp: '2026-04-30T00:00:02.000Z',
    actor: 'machine',
    eventType: 'run.status',
    fromState: 'created',
    toState: 'running',
  });
  await fs.rm(path.join(run.runRoot, 'run-state.json'));

  const repaired = await repairRunStateFromEvents(run.runRoot);

  assert.equal(repaired.lifecycleStatus, 'running');
  assert.equal(repaired.eventSequence, 1);
  assert.equal((await fs.stat(eventsPath(run.runRoot))).isFile(), true);
  assert.equal((await readRunState(run.runRoot)).lifecycleStatus, 'running');
});
