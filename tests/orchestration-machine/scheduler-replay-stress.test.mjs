import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const {
  buildTraversalPlan,
  createMachineRun,
  executeMachineRunStep,
  flattenTraversalNodes,
  loadPipelineGraphSet,
  readMachineEvents,
  supportNodesForExecution,
  __test_buildReadySetMaps: buildReadySetMaps,
  __test_pickNextReadyNode: pickNextReadyNode,
} = require(path.join(repoRoot, 'src/main/orchestration-machine'));

const maintenancePipelinePath = path.join(
  repoRoot,
  '.orpad/pipelines/orpad-maintenance-quality-workstream-20260429/pipeline.or-pipeline',
);
const maintenanceHistoricalEventsPath = path.join(
  repoRoot,
  '.orpad/pipelines/orpad-maintenance-quality-workstream-20260429/runs/run_20260507_101530_d8bf95/events.jsonl',
);

async function readJsonl(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function simulateReadySetVisitOrder(orderedNodes, graphSet, inlinePlan) {
  const { orderedIndex, forwardPredecessors, forwardSuccessors } = buildReadySetMaps(
    orderedNodes,
    graphSet,
    inlinePlan,
  );
  const ready = new Set();
  for (const node of orderedNodes) {
    if ((forwardPredecessors.get(node.nodePath) || new Set()).size === 0) {
      ready.add(node.nodePath);
    }
  }
  const visited = new Set();
  const visitOrder = [];
  while (ready.size > 0) {
    const nodePath = pickNextReadyNode(ready, orderedIndex);
    if (!nodePath) break;
    ready.delete(nodePath);
    visited.add(nodePath);
    visitOrder.push(nodePath);
    for (const succPath of forwardSuccessors.get(nodePath) || []) {
      if (visited.has(succPath) || ready.has(succPath)) continue;
      const preds = forwardPredecessors.get(succPath) || new Set();
      if ([...preds].every(pred => visited.has(pred))) {
        ready.add(succPath);
      }
    }
  }
  return visitOrder;
}

function replayScheduledOrderFromVisitOrder(visitOrder, orderedNodes, recordedRunStartPayload) {
  const byPath = new Map(orderedNodes.map(node => [node.nodePath, node]));
  const probeNodePaths = recordedRunStartPayload.selectedProbeNodes || [];
  const operationNodes = [
    ...probeNodePaths.map(nodePath => byPath.get(nodePath)),
    byPath.get(recordedRunStartPayload.triageNode),
    byPath.get(recordedRunStartPayload.dispatcherNode),
    byPath.get(recordedRunStartPayload.workerNode),
  ].filter(Boolean);
  assert.equal(operationNodes.length, probeNodePaths.length + 3, 'recorded operation nodes must still exist in the graph');

  const executablePaths = new Set([
    ...operationNodes.map(node => node.nodePath),
    ...supportNodesForExecution(orderedNodes, operationNodes).map(node => node.nodePath),
  ]);
  const probeSet = new Set(probeNodePaths);
  let probeFanoutEmitted = false;
  const scheduledOrder = [];
  for (const nodePath of visitOrder) {
    if (!executablePaths.has(nodePath)) continue;
    if (probeSet.has(nodePath)) {
      if (!probeFanoutEmitted) {
        scheduledOrder.push(...probeNodePaths);
        probeFanoutEmitted = true;
      }
      continue;
    }
    scheduledOrder.push(nodePath);
  }
  return scheduledOrder;
}

function firstAttemptScheduledOrder(events) {
  return events
    .filter(event => event.eventType === 'node.scheduled' && event.payload?.attempt === 1)
    .map(event => event.nodePath);
}

test('maintenance historical run first-attempt schedule replays in ready-set visit order', async t => {
  try {
    await fs.access(maintenanceHistoricalEventsPath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      t.skip('historical maintenance run snapshot is not present in this checkout');
      return;
    }
    throw err;
  }
  const [graphSet, historicalEvents] = await Promise.all([
    loadPipelineGraphSet({ pipelinePath: maintenancePipelinePath }),
    readJsonl(maintenanceHistoricalEventsPath),
  ]);
  const runStart = historicalEvents.find(event => event.eventType === 'run.status' && event.reason === 'machine-graph-step.start');
  assert.ok(runStart, 'historical events fixture must include the machine step start payload');

  const plan = buildTraversalPlan(graphSet);
  const orderedNodes = flattenTraversalNodes(plan);
  const readySetVisitOrder = simulateReadySetVisitOrder(orderedNodes, graphSet, plan.inlinePlan);
  const replayedSchedule = replayScheduledOrderFromVisitOrder(readySetVisitOrder, orderedNodes, runStart.payload);

  assert.deepEqual(replayedSchedule, firstAttemptScheduledOrder(historicalEvents));
});

function mainGraphNode(id, type = 'orpad.context', config = {}) {
  return { id, type, label: id, ...(Object.keys(config).length ? { config } : {}) };
}

function makeStressSubgraph(index) {
  const prefix = `sg${index}`;
  const fanout = Array.from({ length: 5 }, (_, fanoutIndex) => `${prefix}-fanout-${fanoutIndex + 1}`);
  return {
    file: `graphs/${prefix}.or-graph`,
    doc: {
      kind: 'orpad.graph',
      version: '1.0',
      graph: {
        id: prefix,
        nodes: [
          mainGraphNode('start'),
          ...fanout.map(id => mainGraphNode(id)),
          mainGraphNode('join', 'orpad.barrier', { waitFor: fanout }),
          mainGraphNode('finish'),
        ],
        transitions: [
          ...fanout.map(id => ({ from: 'start', to: id })),
          ...fanout.map(id => ({ from: id, to: 'join' })),
          { from: 'join', to: 'finish' },
        ],
      },
    },
  };
}

async function buildLargeStressPipeline(t) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-scheduler-stress-'));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/scheduler-stress');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  const subgraphs = Array.from({ length: 4 }, (_, index) => makeStressSubgraph(index + 1));

  const wrapperIds = subgraphs.map((_, index) => `section-${index + 1}`);
  const mainNodes = [
    mainGraphNode('entry', 'orpad.entry'),
    mainGraphNode('prep'),
    ...wrapperIds.map((id, index) => mainGraphNode(id, 'orpad.graph', {
      graphRef: path.basename(subgraphs[index].file),
      executionMode: 'inline',
    })),
    mainGraphNode('probe', 'orpad.probe'),
    mainGraphNode('queue', 'orpad.workQueue', {
      queueRoot: 'harness/generated/latest-run/queue',
      schema: 'orpad.workItem.v1',
    }),
    mainGraphNode('triage', 'orpad.triage', { queueRef: 'queue' }),
    mainGraphNode('dispatch', 'orpad.dispatcher', { queueRef: 'queue', workerLoopRef: 'worker' }),
    mainGraphNode('worker', 'orpad.workerLoop', { queueRef: 'queue' }),
    mainGraphNode('exit', 'orpad.exit'),
  ];
  const chain = ['entry', 'prep', ...wrapperIds, 'probe', 'queue', 'triage', 'dispatch', 'worker', 'exit'];
  const mainGraph = {
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'scheduler-stress-main',
      nodes: mainNodes,
      transitions: chain.slice(0, -1).map((from, index) => ({ from, to: chain[index + 1] })),
    },
  };
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify(mainGraph, null, 2), 'utf8');
  for (const subgraph of subgraphs) {
    await fs.writeFile(path.join(pipelineDir, subgraph.file), JSON.stringify(subgraph.doc, null, 2), 'utf8');
  }
  await fs.writeFile(path.join(workspaceRoot, 'target.md'), 'before\n', 'utf8');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'scheduler-stress',
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
          proposalId: 'stress-proposal',
          suggestedWorkItemId: 'stress-item',
          sourceNode: 'main/probe',
          title: 'Update target.md',
          fingerprint: 'stress:target.md',
          evidence: [{ id: 'target-before', file: 'target.md' }],
          acceptanceCriteria: ['Patch artifact records the change.'],
          sourceOfTruthTargets: ['target.md'],
        },
        expectedChangedFiles: ['target.md'],
        nodeCliPatch: { file: 'target.md', content: 'Updated by scheduler stress fixture.\n' },
      },
    },
    graphs: {
      main: { file: 'graphs/main.or-graph' },
      sg1: { file: 'graphs/sg1.or-graph' },
      sg2: { file: 'graphs/sg2.or-graph' },
      sg3: { file: 'graphs/sg3.or-graph' },
      sg4: { file: 'graphs/sg4.or-graph' },
    },
  }, null, 2), 'utf8');

  const run = await createMachineRun({ workspaceRoot, pipelinePath, runId: 'run_scheduler_stress_001' });
  return { workspaceRoot, pipelineDir, pipelinePath, run };
}

test('large inline-subgraph scheduler stress run completes with sane lifecycle order', async (t) => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await buildLargeStressPipeline(t);
  const graphSet = await loadPipelineGraphSet({ pipelinePath });
  const plan = buildTraversalPlan(graphSet);
  assert.ok(plan.nodeCount >= 30, `expected a large graph, got ${plan.nodeCount} nodes`);
  assert.equal(plan.inlinePlan.expansions.filter(expansion => !expansion.skipped).length, 4);

  const start = performance.now();
  await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });
  const elapsedMs = performance.now() - start;
  assert.ok(elapsedMs < 10_000, `scheduler stress run took ${Math.round(elapsedMs)}ms`);

  const events = await readMachineEvents(run.runRoot);
  const completedPaths = new Set(events
    .filter(event => event.eventType === 'node.completed')
    .map(event => event.nodePath));
  assert.ok(completedPaths.has('main/exit'), 'run should reach exit');
  assert.ok(completedPaths.has('sg4/finish'), 'last inline subgraph should complete');

  const lifecycleEvents = events.filter(event => (
    event.nodePath && ['node.scheduled', 'node.started', 'node.completed'].includes(event.eventType)
  ));
  for (const nodePath of ['main/section-1', 'sg1/start', 'sg1/join', 'sg4/finish', 'main/probe', 'main/exit']) {
    const scheduled = lifecycleEvents.find(event => event.nodePath === nodePath && event.eventType === 'node.scheduled');
    const started = lifecycleEvents.find(event => event.nodePath === nodePath && event.eventType === 'node.started');
    const completed = lifecycleEvents.find(event => event.nodePath === nodePath && event.eventType === 'node.completed');
    assert.ok(scheduled, `${nodePath} should be scheduled`);
    assert.ok(started, `${nodePath} should be started`);
    assert.ok(completed, `${nodePath} should complete`);
    assert.ok(scheduled.sequence < started.sequence, `${nodePath} scheduled before started`);
    assert.ok(started.sequence < completed.sequence, `${nodePath} started before completed`);
  }

  const wrapperCompleted = events.find(event => (
    event.eventType === 'node.completed' && event.nodePath === 'main/section-1'
  ));
  const childStarted = events.find(event => (
    event.eventType === 'node.started' && event.nodePath === 'sg1/start'
  ));
  assert.ok(wrapperCompleted.sequence < childStarted.sequence, 'inline child must not start before wrapper completes');
});
