import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createOrchestrationPipeline } = require(path.join(repoRoot, 'src/main/orchestration-authoring/generator.js'));

// P2b regression: when an authoring spec includes orpad.graph nodes with
// config.graphRef (or orpad.tree with config.treeRef), the generator must
// materialize the referenced sub-graph / sub-tree as a real file on disk
// instead of leaving the parent node dangling. Otherwise double-click
// drill-down has nothing to open and the LLM's hierarchical decomposition
// is decorative only.
test('generator writes a sub-graph file when an orpad.graph node references one', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-subgraph-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const authoringSpec = {
    title: 'Refactor with per-service verify sub-graph',
    description: 'Test spec with one orpad.graph reference.',
    graph: {
      id: 'parent',
      label: 'Parent graph',
      start: 'entry',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Apply refactor' },
        { id: 'per-service-verify', type: 'orpad.graph', label: 'Per-service verification', config: { graphRef: 'graphs/per-service-verify.or-graph' } },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'worker' },
        { from: 'worker', to: 'per-service-verify' },
        { from: 'per-service-verify', to: 'exit' },
      ],
    },
    subgraphs: [
      {
        ref: 'graphs/per-service-verify.or-graph',
        graph: {
          id: 'per-service-verify',
          label: 'Per-service verification',
          start: 'sg-entry',
          nodes: [
            { id: 'sg-entry', type: 'orpad.entry', label: 'Sub entry' },
            { id: 'sg-gate', type: 'orpad.gate', label: 'Service smoke check', config: { criteria: ['service starts cleanly', 'health endpoint returns 200'] } },
            { id: 'sg-exit', type: 'orpad.exit', label: 'Sub exit' },
          ],
          transitions: [
            { from: 'sg-entry', to: 'sg-gate' },
            { from: 'sg-gate', to: 'sg-exit' },
          ],
        },
      },
    ],
  };

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Refactor with per-service verify sub-graph',
    maxAuthoringNodePacks: 0,
    authoringSpec,
    timestamp: '2026-05-15T01:00:00.000Z',
  });
  assert.equal(result.success, true);

  const subgraphPath = path.join(result.pipelineDir, 'graphs', 'per-service-verify.or-graph');
  const stat = await fs.stat(subgraphPath);
  assert.equal(stat.isFile(), true, 'sub-graph file should be written under pipelineDir/graphs/');
  const subgraph = JSON.parse(await fs.readFile(subgraphPath, 'utf-8'));
  assert.equal(subgraph.kind, 'orpad.graph');
  assert.equal(subgraph.graph.id, 'per-service-verify');
  assert.deepEqual(subgraph.graph.nodes.map(n => n.type), ['orpad.entry', 'orpad.gate', 'orpad.exit']);
  // The sub-graph criteria are passed through unchanged.
  const gateNode = subgraph.graph.nodes.find(n => n.type === 'orpad.gate');
  assert.deepEqual(gateNode.config.criteria, ['service starts cleanly', 'health endpoint returns 200']);

  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  const entry = pipeline.graphs.find(g => g.file === 'graphs/per-service-verify.or-graph');
  assert.ok(entry, 'pipeline.graphs should list the new sub-graph file');
  assert.equal(entry.id, 'per-service-verify');
});

test('generator writes a sub-tree file when an orpad.tree node references one', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-subtree-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const authoringSpec = {
    title: 'Behavior tree decomposition',
    description: 'Test spec with one orpad.tree reference.',
    graph: {
      id: 'parent',
      label: 'Parent',
      start: 'entry',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        { id: 'self-check', type: 'orpad.tree', label: 'Self-check tree', config: { treeRef: 'trees/self-check.or-tree' } },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'self-check' },
        { from: 'self-check', to: 'exit' },
      ],
    },
    subtrees: [
      {
        ref: 'trees/self-check.or-tree',
        tree: {
          id: 'self-check',
          label: 'Self-check sequence',
          root: {
            id: 'root',
            type: 'Sequence',
            label: 'Self-check sequence',
            children: [
              { id: 'inspect', type: 'Context', label: 'Inspect outputs' },
              { id: 'verify', type: 'Gate', label: 'Verify acceptance criteria' },
            ],
          },
        },
      },
    ],
  };

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Behavior tree decomposition',
    maxAuthoringNodePacks: 0,
    authoringSpec,
    timestamp: '2026-05-15T01:00:00.000Z',
  });

  const subtreePath = path.join(result.pipelineDir, 'trees', 'self-check.or-tree');
  const subtree = JSON.parse(await fs.readFile(subtreePath, 'utf-8'));
  assert.equal(subtree.kind, 'orpad.tree');
  assert.equal(subtree.root.type, 'Sequence');
  assert.equal(subtree.root.children.length, 2);
  assert.equal(subtree.root.children[0].type, 'Context');
  assert.equal(subtree.root.children[1].type, 'Gate');
});

test('generator auto-materializes an executable sub-graph when the spec forgot a subgraphs entry', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-subgraph-stub-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  // orpad.graph node references a ref but spec has no matching subgraphs entry
  // — the generator should still create a placeholder so drill-down works
  // and the gap is visible.
  const authoringSpec = {
    title: 'Forgot to author the sub-graph',
    graph: {
      id: 'parent',
      label: 'Parent',
      start: 'entry',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        { id: 'missing-sub', type: 'orpad.graph', label: 'Missing sub-graph', config: { graphRef: 'graphs/orphan.or-graph' } },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'missing-sub' },
        { from: 'missing-sub', to: 'exit' },
      ],
    },
    // intentionally no subgraphs[]
  };

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Forgot to author the sub-graph',
    maxAuthoringNodePacks: 0,
    authoringSpec,
    timestamp: '2026-05-15T01:00:00.000Z',
  });

  const stubPath = path.join(result.pipelineDir, 'graphs', 'orphan.or-graph');
  const stub = JSON.parse(await fs.readFile(stubPath, 'utf-8'));
  assert.deepEqual(stub.graph.nodes.map(n => n.type), [
    'orpad.entry',
    'orpad.context',
    'orpad.probe',
    'orpad.gate',
    'orpad.exit',
  ]);
  assert.ok(stub.graph.nodes.find(n => n.id === 'collect-parent-scope'));
  assert.ok(stub.graph.nodes.find(n => n.id === 'draft-subgraph-plan'));
  assert.ok(stub.graph.nodes.find(n => n.id === 'verify-subgraph-plan'));
  assert.equal(/TODO|Placeholder/.test(JSON.stringify(stub)), false);
  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  assert.ok(
    pipeline.run.machineAdapter.probeNodePaths.includes(`${stub.graph.id}/draft-subgraph-plan`),
    'auto-materialized sub-graph probes must be part of machineAdapter fanout',
  );
});

// Real-world regression: the Threading Lecture pipeline generated on
// 2026-05-15 included four `orpad.graph` and one `orpad.tree` node where
// the LLM left config.graphRef / config.treeRef BLANK and used those node
// types as semantic markers only. The user reported "여전히 빈 behaviour
// tree 그래프노드가 만들어진다" — generator silently dropped them. Fix:
// auto-fill `graphRef`/`treeRef` from the node id and surface the parent
// node's authoring hints inside the placeholder so the user can pick up
// where the LLM left off.
test('generator auto-fills missing graphRef/treeRef and preserves parent hints', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-autofill-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const authoringSpec = {
    title: 'LLM forgot every graphRef/treeRef',
    graph: {
      id: 'parent',
      label: 'Parent',
      start: 'entry',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        {
          id: 'plan-unit1-thread-foundations',
          type: 'orpad.graph',
          label: 'Unit1 sub-graph: thread foundations repair plan',
          config: {
            summary: 'Plan Unit1 repairs for process/thread and stack/heap sharing.',
            subGraphScope: 'Unit1 only',
            unitKey: 'unit1',
            difficultyPath: ['Beginner: thread vs process', 'Core: ThreadPool', 'Advanced: scheduler states'],
          },
        },
        {
          id: 'self-check-teaching-slice-tree',
          type: 'orpad.tree',
          label: 'Behavior tree for teaching-slice completeness',
          config: {
            summary: 'Cross-slice behavior-tree check before patch review.',
            leaves: [
              'Every newly introduced concept has a preceding bridge or definition.',
              'Every touched slide names why the concept matters.',
            ],
          },
        },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'plan-unit1-thread-foundations' },
        { from: 'plan-unit1-thread-foundations', to: 'self-check-teaching-slice-tree' },
        { from: 'self-check-teaching-slice-tree', to: 'exit' },
      ],
    },
    // intentionally no subgraphs[] or subtrees[]
  };

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'LLM forgot every graphRef/treeRef',
    maxAuthoringNodePacks: 0,
    authoringSpec,
    timestamp: '2026-05-15T20:00:00.000Z',
  });

  // (a) main.or-graph: the orpad.graph node should now have its graphRef
  // filled in, marked as auto-filled so future loops can audit it. Refs
  // are graph-file-relative (main.or-graph lives in graphs/, so sub-graph
  // is a bare filename; sub-tree steps out via `../trees/...`).
  const mainGraph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const planNode = mainGraph.graph.nodes.find(n => n.id === 'plan-unit1-thread-foundations');
  assert.equal(planNode.config.graphRef, 'plan-unit1-thread-foundations.or-graph');
  assert.equal(planNode.config.graphRefAutoFilled, true);
  // Fork-Join Phase 1: every sanitized orpad.graph node defaults to
  // inline execution so buildInlinePlan flattens the inner graph and
  // the wrapper stops firing empty payload events at runtime.
  assert.equal(planNode.config.executionMode, 'inline');
  const treeNode = mainGraph.graph.nodes.find(n => n.id === 'self-check-teaching-slice-tree');
  assert.equal(treeNode.config.treeRef, '../trees/self-check-teaching-slice-tree.or-tree');
  assert.equal(treeNode.config.treeRefAutoFilled, true);

  // (b) the sub-graph file was actually written under graphs/...
  const subgraphPath = path.join(result.pipelineDir, 'graphs', 'plan-unit1-thread-foundations.or-graph');
  const subgraph = JSON.parse(await fs.readFile(subgraphPath, 'utf-8'));
  assert.equal(subgraph.kind, 'orpad.graph');
  // (c) parent hints are preserved inside an executable scaffold instead of
  // a dead TODO-only sub-graph.
  const context = subgraph.graph.nodes.find(n => n.id === 'collect-parent-scope');
  const probe = subgraph.graph.nodes.find(n => n.id === 'draft-subgraph-plan');
  const gate = subgraph.graph.nodes.find(n => n.id === 'verify-subgraph-plan');
  assert.ok(context, 'auto-materialized sub-graph should collect parent scope');
  assert.ok(probe, 'auto-materialized sub-graph should draft concrete candidates');
  assert.ok(gate, 'auto-materialized sub-graph should verify the scoped plan');
  const contextSummary = String(context.config?.summary || '');
  assert.match(contextSummary, /Plan Unit1 repairs/);
  assert.match(contextSummary, /Beginner: thread vs process/);
  assert.match(contextSummary, /Unit1 only/);
  assert.ok(gate.config.criteria.some(item => /ThreadPool/.test(item)));

  // (d) the sub-tree file was written under trees/...
  const subtreePath = path.join(result.pipelineDir, 'trees', 'self-check-teaching-slice-tree.or-tree');
  const subtree = JSON.parse(await fs.readFile(subtreePath, 'utf-8'));
  assert.equal(subtree.kind, 'orpad.tree');
  // (e) the parent node's `leaves` array was promoted to real Gate
  // children — one Gate per leaf — so the tree is no longer a single
  // placeholder node. Each Gate carries the full check sentence in
  // config.check (the label is capped at 96 chars).
  const treeChildren = subtree.root.children || [];
  assert.equal(treeChildren.length, 2, 'each leaf becomes a Gate child');
  assert.equal(treeChildren[0].type, 'Gate');
  assert.equal(treeChildren[1].type, 'Gate');
  assert.equal(treeChildren[0].config.check, 'Every newly introduced concept has a preceding bridge or definition.');
  assert.equal(treeChildren[1].config.check, 'Every touched slide names why the concept matters.');
  // (e.2) the root Sequence's summary still preserves the original parent
  // hints so the user can see what the LLM intended.
  const rootSummary = String(subtree.root.config?.summary || '');
  assert.match(rootSummary, /Cross-slice behavior-tree check/);
  assert.match(rootSummary, /Auto-materialized from the parent/);

  // (f) pipeline.graphs should now list the new sub-graph alongside main.
  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  const entry = pipeline.graphs.find(g => g.file === 'graphs/plan-unit1-thread-foundations.or-graph');
  assert.ok(entry, 'pipeline.graphs should include the auto-materialized sub-graph');
});

// Fork-Join Phase 1 (Deliverable 1): the generator must stamp
// `config.executionMode = 'inline'` on every authored orpad.graph node
// so `buildInlinePlan` (traversal.js) flattens the inner graph into the
// parent's orderedNodes. Without this, plan/repair/self-check wrappers
// fire empty `node.completed` payloads back-to-back and the user sees
// sub-graph wrappers turn green with no actual work happening inside.
// The author may still override (e.g. `'module'`) — sanitization must
// preserve explicit values rather than blindly overwriting.
test('generator defaults orpad.graph executionMode to inline and preserves explicit overrides', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-execution-mode-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const authoringSpec = {
    title: 'executionMode default + override',
    graph: {
      id: 'parent',
      label: 'Parent',
      start: 'entry',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        // (1) graphRef set, executionMode unset -> default to 'inline'.
        { id: 'plan-default', type: 'orpad.graph', label: 'Plan default', config: { graphRef: 'graphs/plan-default.or-graph' } },
        // (2) graphRef + executionMode unset -> autofill ref AND default to inline.
        { id: 'plan-autofill', type: 'orpad.graph', label: 'Plan autofill' },
        // (3) graphRef set, executionMode explicitly 'module' -> preserve it.
        { id: 'plan-module', type: 'orpad.graph', label: 'Plan module', config: { graphRef: 'graphs/plan-module.or-graph', executionMode: 'module' } },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'plan-default' },
        { from: 'plan-default', to: 'plan-autofill' },
        { from: 'plan-autofill', to: 'plan-module' },
        { from: 'plan-module', to: 'exit' },
      ],
    },
    subgraphs: [
      {
        ref: 'graphs/plan-default.or-graph',
        graph: {
          id: 'pd',
          label: 'pd',
          start: 'e',
          nodes: [
            { id: 'e', type: 'orpad.entry', label: 'e' },
            { id: 'check', type: 'orpad.gate', label: 'Check default plan', config: { criteria: ['default sub-graph executes a concrete check'] } },
          ],
          transitions: [{ from: 'e', to: 'check' }],
        },
      },
      {
        ref: 'graphs/plan-module.or-graph',
        graph: {
          id: 'pm',
          label: 'pm',
          start: 'e',
          nodes: [
            { id: 'e', type: 'orpad.entry', label: 'e' },
            { id: 'check', type: 'orpad.gate', label: 'Check module plan', config: { criteria: ['module sub-graph executes a concrete check'] } },
          ],
          transitions: [{ from: 'e', to: 'check' }],
        },
      },
    ],
  };

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'executionMode default + override',
    maxAuthoringNodePacks: 0,
    authoringSpec,
    timestamp: '2026-05-15T10:00:00.000Z',
  });
  assert.equal(result.success, true);

  const mainGraph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const planDefault = mainGraph.graph.nodes.find(n => n.id === 'plan-default');
  const planAutofill = mainGraph.graph.nodes.find(n => n.id === 'plan-autofill');
  const planModule = mainGraph.graph.nodes.find(n => n.id === 'plan-module');

  assert.equal(planDefault.config.executionMode, 'inline');
  assert.equal(planAutofill.config.executionMode, 'inline');
  assert.equal(planAutofill.config.graphRefAutoFilled, true);
  // Explicit author choice survives sanitization. This is the escape
  // hatch for any wrapper that wants the rev. 3 'module' (metadata stub)
  // semantics. Don't change this behavior without updating the design.
  assert.equal(planModule.config.executionMode, 'module');
});

// Fork-Join Phase 1 (Deliverable 2): under `executionMode: 'inline'`,
// `buildInlinePlan` (traversal.js) flattens inner-graph nodes into the
// parent's orderedNodes with nodePaths keyed `${childGraphKey}/${nodeId}`.
// If two orpad.graph parents reference the same child .or-graph file
// the loader collapses them to one graphKey and their inner lifecycle
// events collide. The generator must rewrite duplicate refs so each
// parent gets its own invocation identity. We surface the original
// under `graphRefCollisionOriginal` so future audits can see what
// happened — silent rewrite would be worse than the original collision.
test('generator rewrites duplicate orpad.graph refs so each parent gets a unique invocation identity', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-dup-graphref-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const authoringSpec = {
    title: 'Two parents reference the same sub-graph file',
    graph: {
      id: 'parent',
      label: 'Parent',
      start: 'entry',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        // Two distinct parent wrappers, BOTH pointing at the same ref.
        // The generator must keep one as-authored and rewrite the other.
        { id: 'plan-a', type: 'orpad.graph', label: 'Plan A', config: { graphRef: 'graphs/shared.or-graph' } },
        { id: 'plan-b', type: 'orpad.graph', label: 'Plan B', config: { graphRef: 'graphs/shared.or-graph' } },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'plan-a' },
        { from: 'plan-a', to: 'plan-b' },
        { from: 'plan-b', to: 'exit' },
      ],
    },
    subgraphs: [
      {
        ref: 'graphs/shared.or-graph',
        graph: {
          id: 'shared',
          label: 'shared',
          start: 'e',
          nodes: [
            { id: 'e', type: 'orpad.entry', label: 'e' },
            { id: 'check', type: 'orpad.gate', label: 'Check shared plan', config: { criteria: ['shared sub-graph executes a concrete check'] } },
          ],
          transitions: [{ from: 'e', to: 'check' }],
        },
      },
    ],
  };

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'duplicate graphRef',
    maxAuthoringNodePacks: 0,
    authoringSpec,
    timestamp: '2026-05-15T11:00:00.000Z',
  });
  assert.equal(result.success, true);

  const mainGraph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const planA = mainGraph.graph.nodes.find(n => n.id === 'plan-a');
  const planB = mainGraph.graph.nodes.find(n => n.id === 'plan-b');
  assert.ok(planA && planB, 'both parent wrappers should remain in the main graph');
  assert.notEqual(planA.config.graphRef, planB.config.graphRef);
  // One parent keeps the original (it was seen first); the other is
  // rewritten with collision audit fields. We don't lock down which one
  // — generator iteration order is the contract — but we DO assert the
  // rewrite leaves an audit trail.
  const rewritten = [planA, planB].find(n => n.config.graphRefCollisionRewrite);
  assert.ok(rewritten, 'one parent should be marked as a collision rewrite');
  assert.equal(rewritten.config.graphRefCollisionOriginal, 'shared.or-graph');
  // The rewrite follows the auto-fill convention so the parent's node
  // id participates in the new ref. This keeps the file naming
  // consistent with the rest of the generator.
  assert.match(rewritten.config.graphRef, new RegExp(`${rewritten.id}.*\\.or-graph$`));

  // The pipeline must now list BOTH the original shared sub-graph AND a
  // freshly-materialized one for the rewritten parent so each has a
  // real file to drill into.
  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  const refs = pipeline.graphs.map(g => g.file);
  assert.ok(refs.includes('graphs/shared.or-graph'));
  assert.ok(refs.some(file => file === `graphs/${rewritten.config.graphRef}`));
});

test('generator canonicalizes runtime-facing orchestration contracts from LLM prose', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-contract-normalize-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const authoringSpec = {
    title: 'LLM prose contracts need runtime normalization',
    description: 'A long but complete description that should survive generation without being cut after a dangling comma in the final pipeline manifest.',
    graph: {
      id: 'parent',
      label: 'Parent',
      start: 'entry',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        { id: 'probe-a', type: 'orpad.probe', label: 'Probe A' },
        { id: 'probe-b', type: 'orpad.probe', label: 'Probe B' },
        { id: 'join-findings', type: 'orpad.barrier', label: 'Join findings', config: { joinSources: ['probe-a', 'probe-b'] } },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue slices' },
        { id: 'triage', type: 'orpad.triage', label: 'Triage slices' },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch slice' },
        { id: 'select-slice', type: 'orpad.selector', label: 'Select repair slice', config: { routes: [{ id: 'unit1' }, { id: 'unit2' }] } },
        { id: 'worker-a', type: 'orpad.workerLoop', label: 'Repair Unit1' },
        { id: 'worker-b', type: 'orpad.workerLoop', label: 'Repair Unit2' },
        {
          id: 'tree-check',
          type: 'orpad.tree',
          label: 'Teaching slice completeness',
          config: {
            treeRef: 'teaching-slice-completeness',
            leaves: ['Every new concept has a bridge.', 'Every touched lab has runnable evidence.'],
          },
        },
        { id: 'review', type: 'orpad.patchReview', label: 'Review patches' },
        { id: 'verify', type: 'orpad.gate', label: 'Verify learner balance', config: { criteria: ['learner balance passes'], onFail: 'warn' } },
        { id: 'artifact', type: 'orpad.artifactContract', label: 'Evidence' },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'probe-a' },
        { from: 'entry', to: 'probe-b' },
        { from: 'probe-a', to: 'join-findings' },
        { from: 'probe-b', to: 'join-findings' },
        { from: 'join-findings', to: 'queue', condition: 'all-audit-findings-ready' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'select-slice' },
        { from: 'select-slice', to: 'worker-a', condition: 'unit1' },
        { from: 'select-slice', to: 'worker-b', condition: 'unit2' },
        { from: 'worker-a', to: 'tree-check' },
        { from: 'worker-b', to: 'tree-check' },
        { from: 'tree-check', to: 'review', condition: 'teaching-slice-complete' },
        { from: 'review', to: 'verify', condition: 'patch-accepted' },
        { from: 'review', to: 'worker-a', condition: 'reject-unit1-thread-foundation' },
        { from: 'verify', to: 'tree-check', condition: 'unit1-thread-slice-revise' },
        { from: 'verify', to: 'artifact', condition: 'queue-empty-and-aligned' },
        { from: 'artifact', to: 'exit' },
      ],
    },
  };

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'normalize LLM prose contracts',
    maxAuthoringNodePacks: 0,
    authoringSpec,
    timestamp: '2026-05-18T01:00:00.000Z',
  });

  const mainGraph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const join = mainGraph.graph.nodes.find(n => n.id === 'join-findings');
  assert.deepEqual(join.config.waitFor, ['probe-a', 'probe-b']);
  assert.equal(join.config.joinSources, undefined);
  assert.deepEqual(join.config.authoredJoinSources, ['probe-a', 'probe-b']);

  assert.equal(mainGraph.graph.nodes.some(n => n.id === 'worker-b'), false);
  assert.equal(mainGraph.graph.nodes.some(n => n.id === 'select-slice'), false);
  const primaryWorker = mainGraph.graph.nodes.find(n => n.id === 'worker-a');
  assert.deepEqual(primaryWorker.config.authoredWorkerLanes.map(lane => lane.id), ['worker-a', 'worker-b']);
  assert.deepEqual(primaryWorker.config.authoredWorkerSelectors.map(selector => selector.id), ['select-slice']);

  const tree = mainGraph.graph.nodes.find(n => n.id === 'tree-check');
  assert.equal(tree.config.treeRef, '../trees/teaching-slice-completeness.or-tree');
  const subtreePath = path.join(result.pipelineDir, 'trees', 'teaching-slice-completeness.or-tree');
  const subtree = JSON.parse(await fs.readFile(subtreePath, 'utf-8'));
  assert.equal(subtree.kind, 'orpad.tree');
  assert.equal(subtree.root.children.length, 2);
  assert.equal(subtree.title.startsWith('Auto-materialized tree'), true);

  const transitions = mainGraph.graph.transitions;
  const joinEdge = transitions.find(edge => edge.from === 'join-findings' && edge.to === 'queue');
  assert.equal(joinEdge.condition, 'pass');
  assert.equal(joinEdge.authoredCondition, 'all-audit-findings-ready');

  const treeEdge = transitions.find(edge => edge.from === 'tree-check' && edge.to === 'review');
  assert.equal(treeEdge.condition, undefined);
  assert.equal(treeEdge.authoredCondition, 'teaching-slice-complete');

  const reviewConditions = transitions.filter(edge => edge.from === 'review').map(edge => edge.condition);
  assert.ok(reviewConditions.includes('accepted'));
  assert.ok(reviewConditions.includes('rejected'));
  assert.equal(reviewConditions.includes('patch-accepted'), false);
  assert.equal(reviewConditions.includes('reject-unit1-thread-foundation'), false);

  const verifyEdges = transitions.filter(edge => edge.from === 'verify');
  assert.ok(verifyEdges.some(edge => edge.to === 'tree-check' && edge.condition === 'revise'));
  assert.ok(verifyEdges.some(edge => edge.to === 'artifact' && edge.condition === 'queue-empty'));
  assert.equal(verifyEdges.some(edge => edge.condition === 'unit1-thread-slice-revise'), false);
  assert.equal(verifyEdges.some(edge => edge.condition === 'queue-empty-and-aligned'), false);

  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  assert.equal(pipeline.description.endsWith(','), false);
});

test('safeRefPath rejects refs that climb out of the pipeline directory', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-subgraph-escape-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const authoringSpec = {
    title: 'Escape attempt',
    graph: {
      id: 'parent',
      label: 'Parent',
      start: 'entry',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        { id: 'sub', type: 'orpad.graph', label: 'Outside ref', config: { graphRef: '../../etc/escape.or-graph' } },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'sub' },
        { from: 'sub', to: 'exit' },
      ],
    },
    subgraphs: [
      { ref: '../../etc/escape.or-graph', graph: { id: 'escape', label: 'escape', start: 'e', nodes: [{ id: 'e', type: 'orpad.entry', label: 'e' }], transitions: [] } },
    ],
  };

  let rejection = null;
  await assert.rejects(
    createOrchestrationPipeline({
      workspaceRoot: workspace,
      taskText: 'Escape attempt',
      maxAuthoringNodePacks: 0,
      authoringSpec,
      timestamp: '2026-05-15T01:00:00.000Z',
    }),
    err => {
      rejection = err;
      return err?.code === 'ORCHESTRATION_AUTHORING_QUALITY_FAILED'
        && err.qualityAudit?.diagnostics?.some(item => item.code === 'AUTHORING_GRAPH_REF_UNMATERIALIZED');
    },
  );
  assert.equal(rejection.failedPipelineRemoved, true);
  // The unsafe ref must NOT have produced a file anywhere outside pipelineDir.
  // We don't enumerate the entire filesystem; we just assert no file was
  // written under pipelineDir for that ref.
  const failedPipelineDir = path.join(workspace, '.orpad', 'pipelines', 'escape-attempt-20260515t010000z');
  await assert.rejects(fs.stat(failedPipelineDir), { code: 'ENOENT' });
});
