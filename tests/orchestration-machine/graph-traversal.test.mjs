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
  detectGraphCycles,
  loadPipelineGraphSet,
  readMachineEvents,
  readRunState,
  recordNodeLifecycleEvent,
  runtimeHandlerKind,
  selectNode,
  selectNodes,
  topologicalOrder,
} = require('../../src/main/orchestration-machine');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const maintenancePipelinePath = path.join(
  repoRoot,
  '.orpad/pipelines/orpad-maintenance-quality-workstream-20260429/pipeline.or-pipeline',
);

async function createTestSymlink(testContext, target, linkPath, type = 'file') {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch (err) {
    if (['EACCES', 'EPERM', 'ENOTSUP', 'EINVAL'].includes(err?.code)) {
      testContext.skip(`symlink creation is unavailable in this environment: ${err.code}`);
      return false;
    }
    throw err;
  }
}

test('graph loader reads the current maintenance pipeline graph set', async () => {
  const graphSet = await loadPipelineGraphSet({ pipelinePath: maintenancePipelinePath });
  const inventory = buildNodeInventory(graphSet);

  assert.equal(graphSet.graphs.length, 4);
  assert.equal(inventory.length, 28);
  assert.equal(inventory.some(node => node.nodePath === 'main/entry'), true);
  assert.equal(inventory.some(node => node.nodePath === 'main/reference-context'), true);
  assert.equal(inventory.some(node => node.nodePath === 'main/external-research-mode'), true);
  assert.equal(inventory.some(node => node.nodePath === 'main/patch-review'), true);
  assert.equal(inventory.some(node => node.nodePath === 'main/exit'), true);
  assert.equal(inventory.some(node => node.nodePath === 'worker-loop/worker'), true);
  assert.equal(inventory.find(node => node.nodePath === 'main/reference-context').runtimeHandlerKind, 'machine-builtin');
  assert.equal(inventory.find(node => node.nodePath === 'discovery-lenses/ux-ui-probe').runtimeHandlerKind, 'adapter-required');
});

test('graph loader rejects graph refs outside the pipeline directory', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-graph-ref-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/ref-boundary');
  await fs.mkdir(pipelineDir, { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');

  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'ref-boundary',
    entryGraph: '../outside.or-graph',
  }, null, 2), 'utf8');
  await assert.rejects(
    loadPipelineGraphSet({ pipelinePath }),
    error => error?.code === 'MACHINE_GRAPH_REF_INVALID',
  );

  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'ref-boundary',
    entryGraph: 'graphs/main.or-graph',
    graphs: {
      outside: {
        file: path.resolve(workspaceRoot, 'outside.or-graph'),
      },
    },
  }, null, 2), 'utf8');
  await assert.rejects(
    loadPipelineGraphSet({ pipelinePath }),
    error => error?.code === 'MACHINE_GRAPH_REF_INVALID',
  );
});

test('graph loader rejects symlinked graph refs before reading targets', async t => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-graph-ref-symlink-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/ref-symlink');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const outsideGraph = path.join(workspaceRoot, 'outside.or-graph');
  await fs.writeFile(outsideGraph, JSON.stringify({ id: 'outside', nodes: [] }, null, 2), 'utf8');
  if (!await createTestSymlink(t, outsideGraph, path.join(pipelineDir, 'graphs/main.or-graph'), 'file')) return;
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'ref-symlink',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');

  await assert.rejects(
    loadPipelineGraphSet({ pipelinePath }),
    error => error?.code === 'MACHINE_GRAPH_REF_SYMLINK_UNSAFE',
  );
});

test('traversal plan uses stable topological order per graph', async () => {
  const graphSet = await loadPipelineGraphSet({ pipelinePath: maintenancePipelinePath });
  const plan = buildTraversalPlan(graphSet);
  const mainPlan = plan.graphPlans.find(graph => graph.graphKey === 'main');

  assert.equal(plan.graphCount, 4);
  assert.equal(plan.nodeCount, 28);
  assert.equal(mainPlan.nodePaths[0], 'main/entry');
  assert.equal(mainPlan.nodePaths.at(-1), 'main/exit');
});

test('traversal plan expands inline nested graph containers at their source position', async () => {
  const graphSet = await loadPipelineGraphSet({ pipelinePath: maintenancePipelinePath });
  const plan = buildTraversalPlan(graphSet);
  const paths = plan.inlinePlan.nodePaths;

  assert.equal(plan.inlinePlan.entryGraphKey, 'main');
  assert.deepEqual(paths.slice(0, 5), [
    'main/entry',
    'main/reference-context',
    'main/authority-gate',
    'main/external-research-mode',
    'main/discovery-lenses',
  ]);
  assert.equal(paths.indexOf('discovery-lenses/discovery-barrier') < paths.indexOf('main/queue-and-triage'), true);
  assert.equal(paths.indexOf('queue-and-triage/scope-gate') < paths.indexOf('main/worker-loop'), true);
  assert.equal(paths.indexOf('worker-loop/retrospective') < paths.indexOf('main/patch-review'), true);
  assert.equal(paths.indexOf('main/patch-review') < paths.indexOf('main/done-gate'), true);
  assert.equal(paths.at(-1), 'main/exit');
});

// Fork-Join Phase 1 (Deliverable 3): once orpad.graph wrappers default
// to inline execution, an inner graph that authored its own
// canonical-rail node (orpad.probe / orpad.triage / orpad.dispatcher /
// orpad.workerLoop) will appear in orderedNodes alongside the main
// rail's nodes. The explicit-path branch of selectNode/selectNodes is
// unaffected because it's an exact-path lookup, but the unscoped
// fallback used to return "first match by nodeType" — which could land
// on an inner-graph node if it preceded the main one in topological
// order. After Phase 1 the fallback must bias toward the entry graph.
test('selectNode/selectNodes fallback prefers the entry-graph node when an inner graph contains the same nodeType', () => {
  const orderedNodes = [
    // The first ordered node always lives in the entry graph. Phase 1
    // uses its graphKey as the entry-graph hint.
    { nodePath: 'main/entry', nodeType: 'orpad.entry', graphKey: 'main' },
    { nodePath: 'main/per-service-verify', nodeType: 'orpad.graph', graphKey: 'main' },
    // Inner-graph nodes inlined right after the wrapper. The inner
    // graph happens to author its own orpad.dispatcher — Phase 1's
    // entry-graph bias keeps this from hijacking the main dispatcher.
    { nodePath: 'per-service-verify/inner-dispatch', nodeType: 'orpad.dispatcher', graphKey: 'per-service-verify' },
    { nodePath: 'per-service-verify/inner-worker', nodeType: 'orpad.workerLoop', graphKey: 'per-service-verify' },
    // Main rail.
    { nodePath: 'main/triage', nodeType: 'orpad.triage', graphKey: 'main' },
    { nodePath: 'main/dispatch', nodeType: 'orpad.dispatcher', graphKey: 'main' },
    { nodePath: 'main/worker', nodeType: 'orpad.workerLoop', graphKey: 'main' },
    { nodePath: 'main/exit', nodeType: 'orpad.exit', graphKey: 'main' },
  ];

  // No explicit path -> falls back. Without entry-graph bias the inner
  // dispatcher (appears earlier in orderedNodes) would win and break
  // the canonical rail.
  assert.equal(selectNode(orderedNodes, 'orpad.dispatcher').nodePath, 'main/dispatch');
  assert.equal(selectNode(orderedNodes, 'orpad.workerLoop').nodePath, 'main/worker');
  // selectNodes with no explicit path returns only entry-graph matches
  // so probe/triage discovery does not accidentally fan out into
  // sub-graph internals.
  const dispatchers = selectNodes(orderedNodes, 'orpad.dispatcher');
  assert.deepEqual(dispatchers.map(node => node.nodePath), ['main/dispatch']);

  // Explicit path still works in both directions, so any pipeline that
  // *wants* to bind an inner-graph node (e.g. a future sub-graph
  // executor) can still do so by passing the full nodePath.
  assert.equal(selectNode(orderedNodes, 'orpad.dispatcher', 'per-service-verify/inner-dispatch').nodePath, 'per-service-verify/inner-dispatch');
});

test('topological order falls back to source order for cyclic leftovers', () => {
  const ordered = topologicalOrder(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
  );

  assert.deepEqual(ordered, ['c', 'a', 'b']);
});

// Fork-Join Phase 1 (Deliverable 4): cycle detection.
// `topologicalOrder` returning cyclic nodes in source order hides
// legitimate loop-backs (Pattern B / Pattern I / Pattern K — every
// Ralph loop, queue-drain, and patchReview reject) and authored cycle
// bugs under the same bucket. Machine execution rejects the latter
// while preserving the former; traversal surfaces the distinction so
// runtime validation can fail with graph-repair diagnostics.
// Codex CLI cross-review 2026-05-16 found two bugs in the original
// cycle detector: Kahn-in-both-directions over-reports cycle membership
// for path nodes between SCCs, and `nonLoopBackCycleNodeIds` was
// permanently `[]` because removing back-edges always leaves a DAG. The
// detector now uses Tarjan's SCC + per-SCC back-edge classification.
test('detectGraphCycles reports exact SCC membership and per-SCC back-edge classification', () => {
  // Pattern B: worker -> gate, gate -> worker. Exact SCC = {worker,gate}.
  // gate appears later in source order so gate->worker is the back edge.
  // Exactly one back edge -> isCleanLoopBack = true (the shape Phase 3
  // will allow via node.resetForLoopBack events).
  const loopBackOnly = detectGraphCycles(
    [{ id: 'worker' }, { id: 'gate' }, { id: 'exit' }],
    [
      { from: 'worker', to: 'gate' },
      { from: 'gate', to: 'worker' },
      { from: 'gate', to: 'exit' },
    ],
  );
  assert.equal(loopBackOnly.hasCycle, true);
  // Exact SCC membership — exit is NOT included, even though earlier
  // Kahn-based approaches falsely marked it cyclic.
  assert.deepEqual(loopBackOnly.cyclicNodeIds.sort(), ['gate', 'worker']);
  assert.equal(loopBackOnly.cyclicSCCs.length, 1);
  assert.deepEqual(loopBackOnly.cyclicSCCs[0].nodeIds.sort(), ['gate', 'worker']);
  assert.equal(loopBackOnly.cyclicSCCs[0].backEdges.length, 1);
  assert.equal(loopBackOnly.cyclicSCCs[0].forwardEdges.length, 1);
  assert.equal(loopBackOnly.cyclicSCCs[0].isCleanLoopBack, true);
  assert.deepEqual(loopBackOnly.tangledCycleNodeIds, []);
  assert.equal(loopBackOnly.loopBackEdges.length, 1);
  assert.equal(loopBackOnly.loopBackEdges[0].from, 'gate');
  assert.equal(loopBackOnly.loopBackEdges[0].to, 'worker');
});

test('detectGraphCycles flags unlabelled multi-back-edge cycles as non-clean-loop-back', () => {
  // Three-node cycle a -> b -> c -> a, c -> b (extra back edge).
  // SCC = {a,b,c}. Back edges = c->a, c->b. Without explicit
  // loop-back labels, 2 back edges -> tangled.
  const tangled = detectGraphCycles(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' }, // back edge
      { from: 'c', to: 'b' }, // back edge
    ],
  );
  assert.equal(tangled.hasCycle, true);
  assert.equal(tangled.cyclicSCCs.length, 1);
  assert.deepEqual(tangled.cyclicSCCs[0].nodeIds.sort(), ['a', 'b', 'c']);
  assert.equal(tangled.cyclicSCCs[0].backEdges.length, 2);
  assert.equal(tangled.cyclicSCCs[0].isCleanLoopBack, false);
  assert.deepEqual(tangled.tangledCycleNodeIds.sort(), ['a', 'b', 'c']);
});

test('detectGraphCycles accepts explicitly labelled multi-back-edge loop-backs', () => {
  const queueRedrive = detectGraphCycles(
    [{ id: 'dispatch' }, { id: 'worker' }, { id: 'queue-gate' }],
    [
      { from: 'dispatch', to: 'worker' },
      { from: 'worker', to: 'queue-gate' },
      { from: 'queue-gate', to: 'dispatch', condition: 'queue-not-empty' },
      { from: 'queue-gate', to: 'dispatch', condition: 'fail' },
    ],
  );

  assert.equal(queueRedrive.hasCycle, true);
  assert.equal(queueRedrive.cyclicSCCs.length, 1);
  assert.equal(queueRedrive.cyclicSCCs[0].backEdges.length, 2);
  assert.equal(queueRedrive.cyclicSCCs[0].isCleanLoopBack, true);
  assert.deepEqual(queueRedrive.tangledCycleNodeIds, []);
});

test('detectGraphCycles does not over-report path nodes between two distinct SCCs', () => {
  // SCC #1 = {a, b}. SCC #2 = {d, e}. The bridge node `c` is on the
  // path from SCC #1 to SCC #2 but is NOT in either SCC. Codex caught
  // that the previous Kahn-both-directions approach would falsely mark
  // `c` as cyclic because it fails to drain forward (b never drains)
  // AND fails to drain reverse (d never drains).
  const twoCyclesWithBridge = detectGraphCycles(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }],
    [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' }, // SCC #1
      { from: 'b', to: 'c' }, // bridge into c
      { from: 'c', to: 'd' }, // bridge into SCC #2
      { from: 'd', to: 'e' },
      { from: 'e', to: 'd' }, // SCC #2
    ],
  );
  assert.equal(twoCyclesWithBridge.hasCycle, true);
  // c is NOT included in cyclicNodeIds. Two distinct SCCs detected.
  assert.deepEqual(twoCyclesWithBridge.cyclicNodeIds.sort(), ['a', 'b', 'd', 'e']);
  assert.equal(twoCyclesWithBridge.cyclicSCCs.length, 2);
  const sccByMember = (id) => twoCyclesWithBridge.cyclicSCCs.find(s => s.nodeIds.includes(id));
  assert.deepEqual(sccByMember('a').nodeIds.sort(), ['a', 'b']);
  assert.deepEqual(sccByMember('d').nodeIds.sort(), ['d', 'e']);
});

test('detectGraphCycles recognizes a single-node self-loop as a cycle', () => {
  // Degenerate case: a -> a. Tarjan reports {a} as an SCC, but a
  // singleton is only "a cycle" if it has a self-loop. Without this
  // guard, every node would be reported as a trivial cycle.
  const selfLoop = detectGraphCycles(
    [{ id: 'a' }, { id: 'b' }],
    [
      { from: 'a', to: 'a' },
      { from: 'a', to: 'b' },
    ],
  );
  assert.equal(selfLoop.hasCycle, true);
  assert.deepEqual(selfLoop.cyclicNodeIds, ['a']);
  assert.equal(selfLoop.cyclicSCCs.length, 1);
  assert.deepEqual(selfLoop.cyclicSCCs[0].nodeIds, ['a']);
});

test('detectGraphCycles returns empty cycle data for a pure DAG', () => {
  const dag = detectGraphCycles(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ],
  );
  assert.equal(dag.hasCycle, false);
  assert.deepEqual(dag.cyclicNodeIds, []);
  assert.deepEqual(dag.cyclicSCCs, []);
  assert.deepEqual(dag.tangledCycleNodeIds, []);
  assert.deepEqual(dag.loopBackEdges, []);
});

test('buildTraversalPlan surfaces per-graph cycle metadata for runtime rejection diagnostics', async () => {
  const graphSet = await loadPipelineGraphSet({ pipelinePath: maintenancePipelinePath });
  const plan = buildTraversalPlan(graphSet);
  for (const graphPlan of plan.graphPlans) {
    assert.ok(graphPlan.cycles, `graph ${graphPlan.graphKey} should carry a cycles report`);
    assert.equal(typeof graphPlan.cycles.hasCycle, 'boolean');
    assert.ok(Array.isArray(graphPlan.cycles.cyclicNodeIds));
    assert.ok(Array.isArray(graphPlan.cycles.cyclicSCCs));
    assert.ok(Array.isArray(graphPlan.cycles.loopBackEdges));
    assert.ok(Array.isArray(graphPlan.cycles.tangledCycleNodeIds));
  }
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
  assert.equal((await readRunState(run.runRoot)).eventSequence, events.at(-1).sequence);
});

test('runtime handler kind classification is explicit for known node families', () => {
  assert.equal(runtimeHandlerKind('orpad.context'), 'machine-builtin');
  assert.equal(runtimeHandlerKind('orpad.selector'), 'machine-builtin');
  assert.equal(runtimeHandlerKind('orpad.patchReview'), 'machine-builtin');
  assert.equal(runtimeHandlerKind('orpad.exit'), 'machine-builtin');
  assert.equal(runtimeHandlerKind('orpad.workQueue'), 'machine-builtin');
  assert.equal(runtimeHandlerKind('orpad.workerLoop'), 'adapter-required');
  assert.equal(runtimeHandlerKind('custom.unknown'), 'render-validate-only');
});
