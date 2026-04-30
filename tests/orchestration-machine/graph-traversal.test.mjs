import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  buildNodeInventory,
  buildTraversalPlan,
  createMachineRun,
  loadPipelineGraphSet,
  readMachineEvents,
  recordNodeLifecycleEvent,
  runtimeHandlerKind,
  topologicalOrder,
} = require('../../src/main/orchestration-machine');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const maintenancePipelinePath = path.join(
  repoRoot,
  '.orpad/pipelines/orpad-maintenance-quality-workstream-20260429/pipeline.or-pipeline',
);

test('graph loader reads the current maintenance pipeline graph set', async () => {
  const graphSet = await loadPipelineGraphSet({ pipelinePath: maintenancePipelinePath });
  const inventory = buildNodeInventory(graphSet);

  assert.equal(graphSet.graphs.length, 4);
  assert.equal(inventory.length, 24);
  assert.equal(inventory.some(node => node.nodePath === 'main/reference-context'), true);
  assert.equal(inventory.some(node => node.nodePath === 'worker-loop/worker'), true);
  assert.equal(inventory.find(node => node.nodePath === 'main/reference-context').runtimeHandlerKind, 'machine-builtin');
  assert.equal(inventory.find(node => node.nodePath === 'discovery-lenses/ux-ui-probe').runtimeHandlerKind, 'adapter-required');
});

test('traversal plan uses stable topological order per graph', async () => {
  const graphSet = await loadPipelineGraphSet({ pipelinePath: maintenancePipelinePath });
  const plan = buildTraversalPlan(graphSet);
  const mainPlan = plan.graphPlans.find(graph => graph.graphKey === 'main');

  assert.equal(plan.graphCount, 4);
  assert.equal(plan.nodeCount, 24);
  assert.equal(mainPlan.nodePaths[0], 'main/reference-context');
  assert.equal(mainPlan.nodePaths.at(-1), 'main/artifact-contract');
});

test('topological order falls back to source order for cyclic leftovers', () => {
  const ordered = topologicalOrder(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
  );

  assert.deepEqual(ordered, ['c', 'a', 'b']);
});

test('node lifecycle events are recorded as Machine events', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-graph-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/sample-machine-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'sample-machine-pipeline',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId: 'run_20260430_graph',
    now: new Date('2026-04-30T00:00:00.000Z'),
  });

  await recordNodeLifecycleEvent(run.runRoot, {
    runId: run.runId,
    nodePath: 'main/reference-context',
    nodeType: 'orpad.context',
    status: 'scheduled',
    timestamp: '2026-04-30T00:00:01.000Z',
  });
  await recordNodeLifecycleEvent(run.runRoot, {
    runId: run.runId,
    nodePath: 'main/reference-context',
    nodeType: 'orpad.context',
    status: 'completed',
    timestamp: '2026-04-30T00:00:02.000Z',
  });

  const events = await readMachineEvents(run.runRoot);
  assert.deepEqual(events.map(event => event.eventType), ['run.created', 'node.scheduled', 'node.completed']);
  assert.equal(events[1].payload.nodeExecutionId, 'run_20260430_graph:main/reference-context:attempt-1');
});

test('runtime handler kind classification is explicit for known node families', () => {
  assert.equal(runtimeHandlerKind('orpad.context'), 'machine-builtin');
  assert.equal(runtimeHandlerKind('orpad.workQueue'), 'machine-builtin');
  assert.equal(runtimeHandlerKind('orpad.workerLoop'), 'adapter-required');
  assert.equal(runtimeHandlerKind('custom.unknown'), 'render-validate-only');
});
