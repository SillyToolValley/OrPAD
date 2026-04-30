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

async function makeNestedGraphHarnessWorkspace(runId = 'run_20260430_nested_graph_harness') {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-nested-graph-harness-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/nested-graph-harness-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(path.join(workspaceRoot, 'src/nested-target.md'), 'before nested\n', 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'nested-main',
      nodes: [
        { id: 'context', type: 'orpad.context', config: { summary: 'Nested context.' } },
        { id: 'discovery', type: 'orpad.graph', config: { graphRef: 'discovery.or-graph', executionMode: 'inline' } },
        { id: 'queue-stage', type: 'orpad.graph', config: { graphRef: 'queue.or-graph', executionMode: 'inline' } },
        { id: 'worker-stage', type: 'orpad.graph', config: { graphRef: 'worker.or-graph', executionMode: 'inline' } },
        { id: 'artifact', type: 'orpad.artifactContract', config: { required: [], requiredQueue: [] } },
      ],
      transitions: [
        { from: 'context', to: 'discovery' },
        { from: 'discovery', to: 'queue-stage' },
        { from: 'queue-stage', to: 'worker-stage' },
        { from: 'worker-stage', to: 'artifact' },
      ],
    },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/discovery.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'nested-discovery',
      nodes: [
        { id: 'probe-a', type: 'orpad.probe', config: { lens: 'a' } },
        { id: 'probe-b', type: 'orpad.probe', config: { lens: 'b' } },
        { id: 'barrier', type: 'orpad.barrier', config: { waitFor: ['probe-a', 'probe-b'], mergePolicy: 'all' } },
      ],
      transitions: [
        { from: 'probe-a', to: 'barrier' },
        { from: 'probe-b', to: 'barrier' },
      ],
    },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/queue.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'nested-queue',
      nodes: [
        { id: 'queue', type: 'orpad.workQueue', config: { queueRef: 'queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', config: { queueRef: 'queue' } },
      ],
      transitions: [{ from: 'queue', to: 'triage' }],
    },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/worker.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'nested-worker',
      nodes: [
        { id: 'dispatch', type: 'orpad.dispatcher', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', config: { queueRef: 'queue' } },
        { id: 'gate', type: 'orpad.gate', config: { criteria: ['worker proof accepted'] } },
      ],
      transitions: [
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'gate' },
      ],
    },
  }, null, 2), 'utf8');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'nested-graph-harness-pipeline',
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
          proposalId: 'proposal-nested-graph-target',
          suggestedWorkItemId: 'nested-graph-target',
          sourceNode: 'discovery/probe-a',
          title: 'Exercise nested inline graph Machine harness execution',
          fingerprint: 'nested-graph:src/nested-target.md',
          evidence: [{ id: 'nested-target-before', file: 'src/nested-target.md' }],
          acceptanceCriteria: ['Patch artifact records src/nested-target.md.'],
          sourceOfTruthTargets: ['src/nested-target.md'],
        },
        expectedChangedFiles: ['src/nested-target.md'],
        nodeCliPatch: {
          file: 'src/nested-target.md',
          content: 'after from nested graph harness\n',
        },
      },
    },
    graphs: {
      main: { file: 'graphs/main.or-graph' },
      discovery: { file: 'graphs/discovery.or-graph' },
      queue: { file: 'graphs/queue.or-graph' },
      worker: { file: 'graphs/worker.or-graph' },
    },
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

test('graph-driven execute step expands inline nested graphs and runs every reachable probe', async () => {
  const { workspaceRoot, pipelinePath, run } = await makeNestedGraphHarnessWorkspace();

  const executed = await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir: path.dirname(pipelinePath),
    runRoot: run.runRoot,
    runId: run.runId,
    nodeExecutable: process.execPath,
  });

  assert.deepEqual(executed.selectedProbeNodes, ['discovery/probe-a', 'discovery/probe-b']);
  assert.deepEqual(executed.selectedNodes, {
    probe: 'discovery/probe-a',
    triage: 'queue/triage',
    dispatcher: 'worker/dispatch',
    worker: 'worker/worker',
  });
  assert.deepEqual(executed.supportNodes.map(node => node.nodePath), [
    'main/context',
    'main/discovery',
    'discovery/barrier',
    'main/queue-stage',
    'queue/queue',
    'main/worker-stage',
    'worker/gate',
    'main/artifact',
  ]);
  assert.equal(executed.probes.length, 2);
  assert.equal(executed.probes[1].result.proposals.length, 0);
  assert.equal(executed.finalization.summaryStatus, 'done');
  assert.equal((await findQueueItem(run.runRoot, 'nested-graph-target')).state, 'done');
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'src/nested-target.md'), 'utf8'), 'before nested\n');

  const eventTypes = executed.events.map(event => event.eventType);
  assert.equal(eventTypes.filter(type => type === 'node.started').length, 13);
  assert.equal(eventTypes.filter(type => type === 'node.completed').length, 13);
});
