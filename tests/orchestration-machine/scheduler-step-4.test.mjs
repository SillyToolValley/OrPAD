import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const {
  createMachineRun,
  executeMachineRunStep,
  readMachineEvents,
  __test_buildReadySetMaps: buildReadySetMaps,
} = require(path.join(repoRoot, 'src/main/orchestration-machine'));

// Fork-Join Phase 3 Step 4: cross-graph edge bridging. Phase 1
// inline-expansion flattens sub-graph nodes into the outer
// orderedNodes but does NOT bridge the parent wrapper → child entry
// or child exit → parent's main-graph successors. Step 1+2 papered
// over this because lowest-orderedIndex tie-break visited sub-graph
// nodes in topological order. Step 2's fan-out path explicitly
// required non-empty forward preds to avoid premature parallel
// dispatch of sub-graph entries. Step 4 closes the gap honestly so
// sub-graph internal Pattern J fan-out works through the existing
// Step 2 parallel batch.

function makeNode(graphKey, nodeId, nodeType = 'orpad.context') {
  return {
    nodePath: `${graphKey}/${nodeId}`,
    nodeId,
    graphKey,
    nodeType,
    label: '',
    config: {},
    order: 0,
    graphId: graphKey,
    graphRef: `${graphKey}.or-graph`,
    runtimeHandlerKind: 'machine-builtin',
  };
}

test('buildReadySetMaps bridges parent wrapper → child entry and child exit → parent successors', () => {
  // Mimic the orderedNodes shape Phase 1 inline-expansion produces:
  // main/context (idx 0), main/plan-unit-wrapper (idx 1, orpad.graph),
  // plan-graph/inner-entry (idx 2), plan-graph/inner-work (idx 3),
  // plan-graph/inner-exit (idx 4), main/join (idx 5).
  const orderedNodes = [
    makeNode('main', 'context'),
    { ...makeNode('main', 'plan-unit-wrapper'), nodeType: 'orpad.graph', config: { graphRef: 'plan.or-graph', executionMode: 'inline' } },
    makeNode('plan-graph', 'inner-entry'),
    makeNode('plan-graph', 'inner-work'),
    makeNode('plan-graph', 'inner-exit'),
    makeNode('main', 'join'),
  ];
  const graphSet = {
    graphs: [
      {
        graphKey: 'main',
        transitions: [
          { from: 'context', to: 'plan-unit-wrapper' },
          { from: 'plan-unit-wrapper', to: 'join' },
        ],
      },
      {
        graphKey: 'plan-graph',
        transitions: [
          { from: 'inner-entry', to: 'inner-work' },
          { from: 'inner-work', to: 'inner-exit' },
        ],
      },
    ],
  };
  const inlinePlan = {
    expansions: [
      { nodePath: 'main/plan-unit-wrapper', graphKey: 'main', childGraphKey: 'plan-graph', mode: 'inline' },
    ],
  };
  const transitionsByFromNodePath = new Map();
  for (const graph of graphSet.graphs) {
    for (const edge of graph.transitions) {
      const fromPath = `${graph.graphKey}/${edge.from}`;
      const toPath = `${graph.graphKey}/${edge.to}`;
      if (!transitionsByFromNodePath.has(fromPath)) transitionsByFromNodePath.set(fromPath, []);
      transitionsByFromNodePath.get(fromPath).push({ from: fromPath, to: toPath });
    }
  }
  const { forwardPredecessors, forwardSuccessors } = buildReadySetMaps(
    orderedNodes,
    graphSet,
    inlinePlan,
    transitionsByFromNodePath,
  );
  // Bridge 1: parent wrapper → child entry.
  assert.ok(forwardSuccessors.get('main/plan-unit-wrapper').has('plan-graph/inner-entry'));
  assert.ok(forwardPredecessors.get('plan-graph/inner-entry').has('main/plan-unit-wrapper'));
  // Bridge 2: child exit → parent's main-graph successor.
  assert.ok(forwardSuccessors.get('plan-graph/inner-exit').has('main/join'));
  assert.ok(forwardPredecessors.get('main/join').has('plan-graph/inner-exit'));
  // main/join's preds = {main/plan-unit-wrapper, plan-graph/inner-exit}.
  // Both must resolve before join becomes ready — the bridge made
  // sub-graph completion part of join's gating.
  assert.deepEqual(
    [...forwardPredecessors.get('main/join')].sort(),
    ['main/plan-unit-wrapper', 'plan-graph/inner-exit'],
  );
  // Synthetic bridges were also added to transitionsByFromNodePath so
  // propagateReadinessAfterVisit fires them. Without this,
  // forwardSuccessors knows about the bridge but propagation
  // wouldn't iterate over it.
  const wrapperOutgoing = transitionsByFromNodePath.get('main/plan-unit-wrapper');
  assert.ok(wrapperOutgoing.some(edge => edge.to === 'plan-graph/inner-entry' && edge.__syntheticBridge === 'parent-to-child-entry'));
  const exitOutgoing = transitionsByFromNodePath.get('plan-graph/inner-exit');
  assert.ok(exitOutgoing.some(edge => edge.to === 'main/join' && edge.__syntheticBridge === 'child-exit-to-parent-successor'));
});

// Codex S4-Fix1 (2026-05-16): multi-entry child graph — Pattern J at
// the very head of the sub-graph. Both top-level entries must gate
// on the parent wrapper. The previous childNodes[0]-only bridging
// left the second entry initial-ready, which would run before the
// wrapper visited AND survive a dead-branch cascade because dead
// cascade can't reach a node that's already initial-ready.
test('buildReadySetMaps bridges parent → EVERY in-child entry (multi-root child graph)', () => {
  // Mimic a sub-graph with two unconditional roots (probe-a, probe-b)
  // → join. Both probes have no in-child predecessor.
  const orderedNodes = [
    makeNode('main', 'context'),
    { ...makeNode('main', 'discovery-wrapper'), nodeType: 'orpad.graph' },
    makeNode('discovery-graph', 'probe-a', 'orpad.probe'),
    makeNode('discovery-graph', 'probe-b', 'orpad.probe'),
    makeNode('discovery-graph', 'join', 'orpad.barrier'),
    makeNode('main', 'next'),
  ];
  const graphSet = {
    graphs: [
      {
        graphKey: 'main',
        transitions: [
          { from: 'context', to: 'discovery-wrapper' },
          { from: 'discovery-wrapper', to: 'next' },
        ],
      },
      {
        graphKey: 'discovery-graph',
        transitions: [
          { from: 'probe-a', to: 'join' },
          { from: 'probe-b', to: 'join' },
        ],
      },
    ],
  };
  const inlinePlan = {
    expansions: [
      { nodePath: 'main/discovery-wrapper', graphKey: 'main', childGraphKey: 'discovery-graph', mode: 'inline' },
    ],
  };
  const transitionsByFromNodePath = new Map();
  for (const graph of graphSet.graphs) {
    for (const edge of graph.transitions) {
      const fromPath = `${graph.graphKey}/${edge.from}`;
      const toPath = `${graph.graphKey}/${edge.to}`;
      if (!transitionsByFromNodePath.has(fromPath)) transitionsByFromNodePath.set(fromPath, []);
      transitionsByFromNodePath.get(fromPath).push({ from: fromPath, to: toPath });
    }
  }
  const { forwardPredecessors, forwardSuccessors } = buildReadySetMaps(
    orderedNodes,
    graphSet,
    inlinePlan,
    transitionsByFromNodePath,
  );
  // Both top-level child entries (probe-a, probe-b) must have the
  // parent wrapper as a forward predecessor — neither stays
  // initial-ready.
  assert.ok(forwardPredecessors.get('discovery-graph/probe-a').has('main/discovery-wrapper'));
  assert.ok(forwardPredecessors.get('discovery-graph/probe-b').has('main/discovery-wrapper'));
  assert.ok(forwardSuccessors.get('main/discovery-wrapper').has('discovery-graph/probe-a'));
  assert.ok(forwardSuccessors.get('main/discovery-wrapper').has('discovery-graph/probe-b'));
});

// Codex S4-Fix2 (2026-05-16): multi-exit child graph — selector at
// the very end produces two terminal branches. Both must gate the
// parent successor; otherwise a pruned terminal's dropped synthetic
// edge plus the wrapper's original fired edge could satisfy
// anyFired and let the parent successor run before the live
// terminal finishes.
test('buildReadySetMaps bridges EVERY in-child exit → parent successor (multi-terminal child graph)', () => {
  // Child graph: entry → selector → {fast, thorough}. Both fast and
  // thorough are terminal (no in-child outgoing edges).
  const orderedNodes = [
    makeNode('main', 'context'),
    { ...makeNode('main', 'plan-wrapper'), nodeType: 'orpad.graph' },
    makeNode('plan-graph', 'entry'),
    { ...makeNode('plan-graph', 'pick'), nodeType: 'orpad.selector', config: { options: ['fast', 'thorough'], default: 'fast' } },
    makeNode('plan-graph', 'fast'),
    makeNode('plan-graph', 'thorough'),
    makeNode('main', 'next'),
  ];
  const graphSet = {
    graphs: [
      {
        graphKey: 'main',
        transitions: [
          { from: 'context', to: 'plan-wrapper' },
          { from: 'plan-wrapper', to: 'next' },
        ],
      },
      {
        graphKey: 'plan-graph',
        transitions: [
          { from: 'entry', to: 'pick' },
          { from: 'pick', to: 'fast', condition: 'fast' },
          { from: 'pick', to: 'thorough', condition: 'thorough' },
        ],
      },
    ],
  };
  const inlinePlan = {
    expansions: [
      { nodePath: 'main/plan-wrapper', graphKey: 'main', childGraphKey: 'plan-graph', mode: 'inline' },
    ],
  };
  const transitionsByFromNodePath = new Map();
  for (const graph of graphSet.graphs) {
    for (const edge of graph.transitions) {
      const fromPath = `${graph.graphKey}/${edge.from}`;
      const toPath = `${graph.graphKey}/${edge.to}`;
      if (!transitionsByFromNodePath.has(fromPath)) transitionsByFromNodePath.set(fromPath, []);
      transitionsByFromNodePath.get(fromPath).push({
        from: fromPath,
        to: toPath,
        ...(edge.condition ? { condition: edge.condition } : {}),
      });
    }
  }
  const { forwardPredecessors, forwardSuccessors } = buildReadySetMaps(
    orderedNodes,
    graphSet,
    inlinePlan,
    transitionsByFromNodePath,
  );
  // Both terminal child nodes (fast, thorough) must bridge to
  // main/next. Without this, only one terminal would gate next —
  // and if the dropped selector branch happened to be the bridged
  // terminal, next could fire prematurely.
  assert.ok(forwardSuccessors.get('plan-graph/fast').has('main/next'));
  assert.ok(forwardSuccessors.get('plan-graph/thorough').has('main/next'));
  assert.ok(forwardPredecessors.get('main/next').has('plan-graph/fast'));
  assert.ok(forwardPredecessors.get('main/next').has('plan-graph/thorough'));
});

// Codex S4-Fix3 (2026-05-16): buildReadySetMaps must be idempotent
// on a reused transitionsByFromNodePath. Each call strips prior
// synthetic bridges before re-adding them so a double-call doesn't
// duplicate edges.
test('buildReadySetMaps idempotent: second call on the same transitionsByFromNodePath does not duplicate synthetic bridges', () => {
  const orderedNodes = [
    makeNode('main', 'context'),
    { ...makeNode('main', 'wrapper'), nodeType: 'orpad.graph' },
    makeNode('child-graph', 'inner'),
    makeNode('main', 'next'),
  ];
  const graphSet = {
    graphs: [
      { graphKey: 'main', transitions: [{ from: 'context', to: 'wrapper' }, { from: 'wrapper', to: 'next' }] },
      { graphKey: 'child-graph', transitions: [] },
    ],
  };
  const inlinePlan = {
    expansions: [
      { nodePath: 'main/wrapper', graphKey: 'main', childGraphKey: 'child-graph', mode: 'inline' },
    ],
  };
  const transitionsByFromNodePath = new Map();
  for (const graph of graphSet.graphs) {
    for (const edge of graph.transitions) {
      const fromPath = `${graph.graphKey}/${edge.from}`;
      const toPath = `${graph.graphKey}/${edge.to}`;
      if (!transitionsByFromNodePath.has(fromPath)) transitionsByFromNodePath.set(fromPath, []);
      transitionsByFromNodePath.get(fromPath).push({ from: fromPath, to: toPath });
    }
  }
  buildReadySetMaps(orderedNodes, graphSet, inlinePlan, transitionsByFromNodePath);
  const wrapperOutgoingFirstPass = transitionsByFromNodePath.get('main/wrapper').slice();
  // Second invocation on the SAME transitionsByFromNodePath.
  buildReadySetMaps(orderedNodes, graphSet, inlinePlan, transitionsByFromNodePath);
  const wrapperOutgoingSecondPass = transitionsByFromNodePath.get('main/wrapper');
  // Same length and same content — no duplicate synthetic bridges.
  assert.equal(wrapperOutgoingSecondPass.length, wrapperOutgoingFirstPass.length);
  const syntheticCount = wrapperOutgoingSecondPass.filter(e => e.__syntheticBridge).length;
  assert.equal(syntheticCount, 1, 'exactly one synthetic bridge from wrapper → inner');
});

test('buildReadySetMaps tolerates inlinePlan expansions for sub-graphs that have no nodes', () => {
  // Defensive: if an inlinePlan expansion references a childGraphKey
  // that has no nodes in orderedNodes (loader skipped, missing file,
  // etc.), bridging must short-circuit gracefully without throwing.
  const orderedNodes = [
    makeNode('main', 'context'),
    { ...makeNode('main', 'orphan-wrapper'), nodeType: 'orpad.graph' },
  ];
  const graphSet = { graphs: [{ graphKey: 'main', transitions: [] }] };
  const inlinePlan = {
    expansions: [
      { nodePath: 'main/orphan-wrapper', graphKey: 'main', childGraphKey: 'orphan-graph', mode: 'inline' },
    ],
  };
  const transitionsByFromNodePath = new Map();
  assert.doesNotThrow(() => {
    buildReadySetMaps(orderedNodes, graphSet, inlinePlan, transitionsByFromNodePath);
  });
});

// Step 4.B: end-to-end check that an inline sub-graph with internal
// Pattern J fan-out (synthesize → {plan-a, plan-b, plan-c}) actually
// dispatches the three siblings concurrently via Step 2's batch path.
// Bridging makes the sub-graph nodes have proper forward predecessors
// — sibling sub-graph nodes share a pred → batched in parallel.
async function buildSubgraphFanOutPipeline(t) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-step4-subgraph-'));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/step4-subgraph');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'step4-subgraph-main',
      nodes: [
        { id: 'entry', type: 'orpad.entry' },
        { id: 'plan-section', type: 'orpad.graph', config: { graphRef: 'plans.or-graph', executionMode: 'inline' } },
        { id: 'probe', type: 'orpad.probe' },
        { id: 'queue', type: 'orpad.workQueue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', config: { queueRef: 'queue' } },
        { id: 'exit', type: 'orpad.exit' },
      ],
      transitions: [
        { from: 'entry', to: 'plan-section' },
        { from: 'plan-section', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'exit' },
      ],
    },
  }, null, 2), 'utf8');
  // Inner plans sub-graph: synthesize → {plan-a, plan-b, plan-c} → join.
  await fs.writeFile(path.join(pipelineDir, 'graphs/plans.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'plans-section',
      nodes: [
        { id: 'synthesize', type: 'orpad.context' },
        { id: 'plan-a', type: 'orpad.context' },
        { id: 'plan-b', type: 'orpad.context' },
        { id: 'plan-c', type: 'orpad.context' },
        { id: 'join', type: 'orpad.barrier', config: { waitFor: ['plan-a', 'plan-b', 'plan-c'] } },
      ],
      transitions: [
        { from: 'synthesize', to: 'plan-a' },
        { from: 'synthesize', to: 'plan-b' },
        { from: 'synthesize', to: 'plan-c' },
        { from: 'plan-a', to: 'join' },
        { from: 'plan-b', to: 'join' },
        { from: 'plan-c', to: 'join' },
      ],
    },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(workspaceRoot, 'target.md'), 'before\n', 'utf8');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'step4-subgraph',
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
          proposalId: 'step4-proposal',
          suggestedWorkItemId: 'step4-item',
          sourceNode: 'main/probe',
          title: 'Update target.md',
          fingerprint: 'step4:target.md',
          evidence: [{ id: 'target-before', file: 'target.md' }],
          acceptanceCriteria: ['Patch records change.'],
          sourceOfTruthTargets: ['target.md'],
        },
        expectedChangedFiles: ['target.md'],
        nodeCliPatch: { file: 'target.md', content: 'Updated.\n' },
      },
    },
    graphs: { main: { file: 'graphs/main.or-graph' }, plans: { file: 'graphs/plans.or-graph' } },
  }, null, 2), 'utf8');
  const run = await createMachineRun({ workspaceRoot, pipelinePath, runId: 'run_step4_subgraph_001' });
  return { workspaceRoot, pipelineDir, pipelinePath, run };
}

// onInnerFailure (Phase 3+ follow-up to Step 4): a sub-graph wrapper
// with `config.onInnerFailure: 'continue'` recovers from inner node
// failures by synthesizing a result that propagates as if the
// failing node had completed. The node.failed event still records
// the failure (audit), and a scheduler.subGraphInnerFailure
// diagnostic event tags the recovery for downstream observability.
test('onInnerFailure=continue: inner gate failure does not halt the run; recovery diagnostic fires', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-on-inner-failure-'));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/on-inner-failure');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  // Main graph: entry → sub-graph wrapper (onInnerFailure='continue')
  // → probe → ... → exit. The sub-graph contains a gate that fails
  // hard via onFail='block'. Without onInnerFailure='continue' the
  // failure would halt the run; with it, the run continues past the
  // failure and the wrapper's downstream still completes.
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'on-inner-failure-main',
      nodes: [
        { id: 'entry', type: 'orpad.entry' },
        { id: 'plan-wrapper', type: 'orpad.graph', config: { graphRef: 'plan.or-graph', executionMode: 'inline', onInnerFailure: 'continue' } },
        { id: 'probe', type: 'orpad.probe' },
        { id: 'queue', type: 'orpad.workQueue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', config: { queueRef: 'queue' } },
        { id: 'exit', type: 'orpad.exit' },
      ],
      transitions: [
        { from: 'entry', to: 'plan-wrapper' },
        { from: 'plan-wrapper', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'exit' },
      ],
    },
  }, null, 2), 'utf8');
  // Inner sub-graph: a single failing gate. onFail='block' makes
  // validateGateNode throw MACHINE_GATE_CRITERIA_UNMET when the
  // criterion isn't satisfied — which is the whole point: simulate
  // a hard inner failure.
  await fs.writeFile(path.join(pipelineDir, 'graphs/plan.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'plan',
      nodes: [
        { id: 'failing-gate', type: 'orpad.gate', config: { criteria: ['never-satisfied-criterion'], onFail: 'block' } },
      ],
      transitions: [],
    },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(workspaceRoot, 'target.md'), 'before\n', 'utf8');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'on-inner-failure',
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
          proposalId: 'oif-proposal',
          suggestedWorkItemId: 'oif-item',
          sourceNode: 'main/probe',
          title: 'Update target.md',
          fingerprint: 'oif:target.md',
          evidence: [{ id: 'target-before', file: 'target.md' }],
          acceptanceCriteria: ['Patch records change.'],
          sourceOfTruthTargets: ['target.md'],
        },
        expectedChangedFiles: ['target.md'],
        nodeCliPatch: { file: 'target.md', content: 'Updated.\n' },
      },
    },
    graphs: { main: { file: 'graphs/main.or-graph' }, plan: { file: 'graphs/plan.or-graph' } },
  }, null, 2), 'utf8');
  const run = await createMachineRun({ workspaceRoot, pipelinePath, runId: 'run_oif_001' });
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
  // The failing gate must have an emitted node.failed event
  // (withNodeLifecycle's catch records it before re-throwing).
  const failed = events.find(event => (
    event.eventType === 'node.failed' && event.nodePath === 'plan/failing-gate'
  ));
  assert.ok(failed, 'inner gate must emit node.failed');
  // A scheduler.subGraphInnerFailure diagnostic must fire keyed on
  // the parent wrapper with the policy and the failing node.
  const recoveryEvent = events.find(event => event.eventType === 'scheduler.subGraphInnerFailure');
  assert.ok(recoveryEvent, 'recovery diagnostic must fire');
  assert.equal(recoveryEvent.payload.policy, 'continue');
  assert.equal(recoveryEvent.payload.failingNodePath, 'plan/failing-gate');
  assert.equal(recoveryEvent.payload.wrapperNodePath, 'main/plan-wrapper');
  // Run did NOT halt: probe completed (downstream of the recovered
  // wrapper).
  const probeCompleted = events.find(event => (
    event.eventType === 'node.completed' && event.nodePath === 'main/probe'
  ));
  assert.ok(probeCompleted, 'probe (downstream of wrapper) must complete despite inner failure');
});

// Codex Fix4 (2026-05-16): a recovered DECISION-EMITTING inner
// failure (gate/selector/barrier) must propagate every forward edge
// unconditionally — NOT through evaluateOutgoingEdges. Without the
// fix a failed gate would fire its 'revise' / 'fail' edges, a
// failed selector would drop every branch, and a failed barrier
// would fire 'partial'. The recovery contract: pretend the inner
// completed successfully for routing purposes.
test('Codex Fix4: recovered decision-emitting inner failure fires every forward edge unconditionally', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-recovered-decision-'));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/recovered-decision');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  // Sub-graph has a gate followed by TWO labelled exits (pass /
  // revise). Under normal failure semantics the gate would fire
  // 'revise' on a failed criterion — but with onInnerFailure=
  // 'continue' the scheduler synthesizes a recovered result that
  // forces BOTH exits to fire unconditionally. We can't easily
  // observe "both bridged successor of the wrapper fired" since
  // there's only one wrapper successor (main/probe). The
  // observable contract is: the wrapper's downstream completes
  // even though the inner failed.
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'recovered-decision-main',
      nodes: [
        { id: 'entry', type: 'orpad.entry' },
        { id: 'plan-wrapper', type: 'orpad.graph', config: { graphRef: 'plan.or-graph', executionMode: 'inline', onInnerFailure: 'continue' } },
        { id: 'probe', type: 'orpad.probe' },
        { id: 'queue', type: 'orpad.workQueue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', config: { queueRef: 'queue' } },
        { id: 'exit', type: 'orpad.exit' },
      ],
      transitions: [
        { from: 'entry', to: 'plan-wrapper' },
        { from: 'plan-wrapper', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'exit' },
      ],
    },
  }, null, 2), 'utf8');
  // Inner: a failing gate with TWO labelled outgoing edges. The
  // recovered result must fire BOTH (= unconditional propagation).
  // The inner sub-graph also has a downstream context that depends
  // on the gate's pass edge — if the recovery wrongly routes
  // through the 'revise' branch, the pass branch's downstream
  // never completes.
  await fs.writeFile(path.join(pipelineDir, 'graphs/plan.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'plan',
      nodes: [
        { id: 'failing-gate', type: 'orpad.gate', config: { criteria: ['never-satisfied'], onFail: 'block' } },
        { id: 'pass-branch', type: 'orpad.context' },
      ],
      transitions: [
        { from: 'failing-gate', to: 'pass-branch', condition: 'pass' },
      ],
    },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(workspaceRoot, 'target.md'), 'before\n', 'utf8');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'recovered-decision',
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
          proposalId: 'rd-proposal',
          suggestedWorkItemId: 'rd-item',
          sourceNode: 'main/probe',
          title: 'Update target.md',
          fingerprint: 'rd:target.md',
          evidence: [{ id: 'target-before', file: 'target.md' }],
          acceptanceCriteria: ['Patch records change.'],
          sourceOfTruthTargets: ['target.md'],
        },
        expectedChangedFiles: ['target.md'],
        nodeCliPatch: { file: 'target.md', content: 'Updated.\n' },
      },
    },
    graphs: { main: { file: 'graphs/main.or-graph' }, plan: { file: 'graphs/plan.or-graph' } },
  }, null, 2), 'utf8');
  const run = await createMachineRun({ workspaceRoot, pipelinePath, runId: 'run_rd_001' });
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
  // pass-branch (downstream of the failing gate's pass edge) MUST
  // complete despite the inner failure. Without Fix4, the
  // recovered gate result would route through 'revise' (gate-failed
  // → revise fires) and pass-branch would be left dead.
  const passBranchCompleted = events.find(event => (
    event.eventType === 'node.completed' && event.nodePath === 'plan/pass-branch'
  ));
  assert.ok(passBranchCompleted, 'pass-branch must complete despite the inner failure — recovery fires every forward edge');
  // Codex Fix5: run-state correction. After the recovery diagnostic,
  // the scheduler emits run.status=running + run.summary=partial to
  // undo withNodeLifecycle's run.status=waiting + summary=blocked
  // side effects. (The lifecycle event type is `run.status` in the
  // event log, named for backwards-compat with pre-Phase-3 audit
  // consumers.)
  const lifecycleEvents = events.filter(event => (
    event.eventType === 'run.status' && event.reason === 'scheduler.innerFailureRecovered'
  ));
  assert.equal(lifecycleEvents.length, 1, 'recovery must emit exactly one corrective run.status event');
  assert.equal(lifecycleEvents[0].toState, 'running');
  // Codex Phase 2 P2 #5 fix: 'continue' policy must NOT downgrade
  // the run summary to 'partial'. 'partial' would falsely mark a
  // normal-progress run. Only the 'partial' policy variant emits
  // the summary downgrade (see partial-policy test below).
  const summaryEvents = events.filter(event => (
    event.eventType === 'run.summary' && event.reason === 'scheduler.innerFailureRecovered'
  ));
  assert.equal(summaryEvents.length, 0, "'continue' policy must NOT emit run.summary=partial — that's reserved for 'partial' policy");
});

// Codex coverage gap: onInnerFailure='partial' is structurally
// similar to 'continue' but also emits scheduler.subGraphPartial.
// That marker is currently informational (finalization-aware-of-
// partial is deferred to a future Phase) — this test pins the
// emission contract so future finalization work knows what to
// consume.
test('onInnerFailure=partial emits scheduler.subGraphPartial in addition to subGraphInnerFailure', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-oif-partial-'));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/oif-partial');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'oif-partial-main',
      nodes: [
        { id: 'entry', type: 'orpad.entry' },
        { id: 'plan-wrapper', type: 'orpad.graph', config: { graphRef: 'plan.or-graph', executionMode: 'inline', onInnerFailure: 'partial' } },
        { id: 'probe', type: 'orpad.probe' },
        { id: 'queue', type: 'orpad.workQueue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', config: { queueRef: 'queue' } },
        { id: 'exit', type: 'orpad.exit' },
      ],
      transitions: [
        { from: 'entry', to: 'plan-wrapper' },
        { from: 'plan-wrapper', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'exit' },
      ],
    },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/plan.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'plan',
      nodes: [
        { id: 'failing-gate', type: 'orpad.gate', config: { criteria: ['never-satisfied'], onFail: 'block' } },
      ],
      transitions: [],
    },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(workspaceRoot, 'target.md'), 'before\n', 'utf8');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'oif-partial',
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
          proposalId: 'oifp-proposal',
          suggestedWorkItemId: 'oifp-item',
          sourceNode: 'main/probe',
          title: 'Update target.md',
          fingerprint: 'oifp:target.md',
          evidence: [{ id: 'target-before', file: 'target.md' }],
          acceptanceCriteria: ['Patch records change.'],
          sourceOfTruthTargets: ['target.md'],
        },
        expectedChangedFiles: ['target.md'],
        nodeCliPatch: { file: 'target.md', content: 'Updated.\n' },
      },
    },
    graphs: { main: { file: 'graphs/main.or-graph' }, plan: { file: 'graphs/plan.or-graph' } },
  }, null, 2), 'utf8');
  const run = await createMachineRun({ workspaceRoot, pipelinePath, runId: 'run_oifp_001' });
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
  const failureEvent = events.find(event => event.eventType === 'scheduler.subGraphInnerFailure');
  const partialEvent = events.find(event => event.eventType === 'scheduler.subGraphPartial');
  assert.ok(failureEvent, 'partial policy emits subGraphInnerFailure diagnostic');
  assert.equal(failureEvent.payload.policy, 'partial');
  assert.ok(partialEvent, 'partial policy ALSO emits subGraphPartial marker for finalization-aware consumers');
  assert.equal(partialEvent.payload.wrapperNodePath, 'main/plan-wrapper');
  // Codex Phase 2 P2 #5 fix: 'partial' policy DOES emit
  // run.summary=partial — that's the difference from 'continue'.
  // Locks the contract so future refactors don't conflate the two.
  const summaryPartial = events.find(event => (
    event.eventType === 'run.summary' && event.reason === 'scheduler.innerFailureRecovered'
  ));
  assert.ok(summaryPartial, "'partial' policy emits a corrective run.summary downgrade");
  assert.equal(summaryPartial.payload.summaryStatus, 'partial');
});

test('Step 4.B: sub-graph internal Pattern J fan-out runs siblings in parallel through the inline expansion', async (t) => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await buildSubgraphFanOutPipeline(t);
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
  const completed = events
    .filter(event => event.eventType === 'node.completed')
    .map(event => event.nodePath);
  // All three plan siblings must complete (sub-graph Pattern J).
  assert.ok(completed.includes('plans/plan-a'), 'plan-a should complete');
  assert.ok(completed.includes('plans/plan-b'), 'plan-b should complete');
  assert.ok(completed.includes('plans/plan-c'), 'plan-c should complete');
  // Inner barrier completes after all three siblings.
  const join = events.find(event => (
    event.eventType === 'node.completed' && event.nodePath === 'plans/join'
  ));
  assert.ok(join, 'inner sub-graph barrier should complete');
  // Step 4.B: the three siblings should have been dispatched as a
  // PARALLEL BATCH, not serially. The proof is consecutive
  // node.scheduled events for the three siblings (Step 2's batched
  // mapWithConcurrency sorts by orderedIndex before dispatching,
  // and appendMachineEvent's global queue produces a contiguous
  // burst in the event log).
  const scheduledEvents = events.filter(event => event.eventType === 'node.scheduled');
  const indices = ['plans/plan-a', 'plans/plan-b', 'plans/plan-c']
    .map(p => scheduledEvents.findIndex(e => e.nodePath === p))
    .sort((a, b) => a - b);
  assert.ok(indices.every(i => i >= 0), 'all three plans must have scheduled events');
  assert.equal(indices[2] - indices[0], 2, `plan schedule events should be consecutive (got ${JSON.stringify(indices)})`);
  // Step 4.A bridging: the parent wrapper (main/plan-section)
  // completes BEFORE any inner plan node. Sub-graph nodes wait for
  // their parent wrapper now.
  const wrapperCompleted = events.find(event => (
    event.eventType === 'node.completed' && event.nodePath === 'main/plan-section'
  ));
  const planACompleted = events.find(event => (
    event.eventType === 'node.completed' && event.nodePath === 'plans/plan-a'
  ));
  assert.ok(wrapperCompleted);
  assert.ok(planACompleted);
  assert.ok(
    wrapperCompleted.sequence < planACompleted.sequence,
    'main/plan-section (parent wrapper) must complete BEFORE plans/plan-a (child entry)',
  );
});
