import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  createMachineRun,
  executeMachineRunStep,
  findQueueItem,
} = require('../../src/main/orchestration-machine');

async function makeGraphHarnessWorkspace(runId = 'run_20260430_graph_harness') {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-graph-harness-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/graph-harness-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(path.join(workspaceRoot, 'src/target.md'), 'before\n', 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'graph-harness',
      nodes: [
        { id: 'context', type: 'orpad.context', config: { summary: 'Context.' } },
        { id: 'probe', type: 'orpad.probe', config: { lens: 'smoke' } },
        { id: 'barrier', type: 'orpad.barrier', config: { waitFor: ['probe'], mergePolicy: 'all' } },
        { id: 'queue', type: 'orpad.workQueue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', config: { queueRef: 'queue' } },
        { id: 'verification-gate', type: 'orpad.gate', config: { criteria: ['worker proof accepted'] } },
        { id: 'artifact', type: 'orpad.artifactContract', config: { required: [], requiredQueue: [] } },
      ],
      transitions: [
        { from: 'context', to: 'probe' },
        { from: 'probe', to: 'barrier' },
        { from: 'barrier', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'verification-gate' },
        { from: 'verification-gate', to: 'artifact' },
      ],
    },
  }, null, 2), 'utf8');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'graph-harness-pipeline',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    nodePacks: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3', origin: 'built-in' },
      { id: 'orpad.workstream', version: '>=0.1.0', origin: 'built-in' },
    ],
    run: {
      artifactRoot: 'harness/generated/latest-run/artifacts',
      queueRoot: 'harness/generated/latest-run/queue',
      metadataPath: 'harness/generated/latest-run/run-metadata.json',
      summaryPath: 'harness/generated/latest-run/summary.md',
      machineHarness: {
        candidateProposal: {
          schemaVersion: 'orpad.candidateProposal.v1',
          proposalId: 'proposal-graph-harness-target',
          suggestedWorkItemId: 'graph-harness-target',
          sourceNode: 'main/probe',
          title: 'Exercise graph-driven Machine harness execution',
          fingerprint: 'graph-harness:src/target.md',
          evidence: [{ id: 'target-before', file: 'src/target.md' }],
          acceptanceCriteria: ['Patch artifact records src/target.md.'],
          sourceOfTruthTargets: ['src/target.md'],
        },
        expectedChangedFiles: ['src/target.md'],
        nodeCliPatch: {
          file: 'src/target.md',
          content: 'after from graph harness\n',
        },
      },
    },
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
  }, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId,
  });
  return { workspaceRoot, pipelineDir, pipelinePath, run };
}

test('graph-driven execute step runs probe, triage, dispatcher, and worker nodes in graph order', async () => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await makeGraphHarnessWorkspace();

  const executed = await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    nodeExecutable: process.execPath,
  });

  assert.deepEqual(executed.selectedNodes, {
    probe: 'main/probe',
    triage: 'main/triage',
    dispatcher: 'main/dispatch',
    worker: 'main/worker',
  });
  assert.deepEqual(executed.supportNodes.map(node => node.nodePath), [
    'main/context',
    'main/barrier',
    'main/queue',
    'main/verification-gate',
    'main/artifact',
  ]);
  assert.equal(executed.worker.result.event.payload.status, 'done');
  assert.equal((await findQueueItem(run.runRoot, 'graph-harness-target')).state, 'done');
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'src/target.md'), 'utf8'), 'before\n');
  assert.equal((await fs.stat(path.join(pipelineDir, 'harness/generated/latest-run/run-metadata.json'))).isFile(), true);
  assert.equal(executed.finalization.summaryStatus, 'done');
  assert.equal(executed.runState.lifecycleStatus, 'completed');

  const eventTypes = executed.events.map(event => event.eventType);
  assert.equal(executed.runState.eventSequence, executed.events.at(-1).sequence);
  assert.equal(eventTypes.filter(type => type === 'node.started').length, 9);
  assert.equal(eventTypes.filter(type => type === 'node.completed').length, 9);
  const adapterRequest = executed.events.find(event => event.eventType === 'adapter.requested' && event.payload?.taskKind === 'workerLoop');
  assert.equal(adapterRequest.nodePath, 'main/worker');
});

test('graph-driven execute step rejects pipelines without a deterministic MVP harness', async () => {
  const { workspaceRoot, pipelinePath, run } = await makeGraphHarnessWorkspace('run_20260430_graph_harness_missing');
  const source = JSON.parse(await fs.readFile(pipelinePath, 'utf8'));
  delete source.run.machineHarness;
  await fs.writeFile(pipelinePath, `${JSON.stringify(source, null, 2)}\n`, 'utf8');

  await assert.rejects(
    executeMachineRunStep({
      workspaceRoot,
      pipelinePath,
      pipelineDir: path.dirname(pipelinePath),
      runRoot: run.runRoot,
      runId: run.runId,
      nodeExecutable: process.execPath,
    }),
    error => error?.code === 'MACHINE_EXECUTION_HARNESS_REQUIRED',
  );
});
