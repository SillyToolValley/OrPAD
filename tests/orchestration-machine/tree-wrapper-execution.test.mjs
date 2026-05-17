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
  readMachineEvents,
  __test_executeTreeWrapper: executeTreeWrapper,
} = require(path.join(repoRoot, 'src/main/orchestration-machine'));

// Fork-Join Phase 1 (Deliverable 5): orpad.tree wrappers used to be
// metadata stubs — the machine for-loop filtered them out of
// executablePaths and they never fired lifecycle events. Phase 1 adds
// `orpad.tree` to SUPPORT_NODE_TYPES and routes the wrapper to
// `executeTreeWrapper`, which loads the referenced .or-tree, walks the
// root, and emits per-tick lifecycle events under
// `${wrapper.nodePath}/${treeNodeId}`. The actual Sequence /
// Selector / Parallel semantics are deferred to Phase 3+; Phase 1's
// contract is "ticks fire," nothing more.
async function setupTreePipeline(t, treeDoc) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-tree-exec-'));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/tree-fixture');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  await fs.mkdir(path.join(pipelineDir, 'trees'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'tree-fixture',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'trees/self-check.or-tree'), JSON.stringify(treeDoc, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId: 'run_tree_fixture',
    now: new Date('2026-05-15T12:00:00.000Z'),
  });
  return { workspaceRoot, pipelineDir, pipelinePath, run };
}

test('executeTreeWrapper emits a lifecycle tick per tree node under the wrapper nodePath', async (t) => {
  const treeDoc = {
    kind: 'orpad.tree',
    root: {
      id: 'root',
      type: 'Sequence',
      label: 'Self-check sequence',
      children: [
        { id: 'inspect', type: 'Context', label: 'Inspect outputs' },
        { id: 'verify', type: 'Gate', label: 'Verify criteria' },
      ],
    },
  };
  const { pipelineDir, run } = await setupTreePipeline(t, treeDoc);

  const wrapper = {
    nodePath: 'main/self-check',
    nodeType: 'orpad.tree',
    graphKey: 'main',
    graphRef: 'graphs/main.or-graph',
    config: { treeRef: '../trees/self-check.or-tree' },
  };
  const result = await executeTreeWrapper(run.runRoot, wrapper, {
    runId: run.runId,
    attempt: 1,
    pipelineDir,
  });
  assert.equal(result.status, 'ticked');
  // Pre-order DFS: root, then inspect, then verify.
  assert.equal(result.tickCount, 3);
  assert.deepEqual(result.ticks.map(t => t.nodePath), [
    'main/self-check/root',
    'main/self-check/inspect',
    'main/self-check/verify',
  ]);
  // Synthetic nodeType prefix keeps tree-internal events distinguishable
  // from graph-level lifecycle events when readers grep eventType +
  // nodeType pairs.
  assert.deepEqual(result.ticks.map(t => t.nodeType), [
    'orpad.tree.Sequence',
    'orpad.tree.Context',
    'orpad.tree.Gate',
  ]);

  const events = await readMachineEvents(run.runRoot);
  const ticked = events.filter(event => String(event.nodePath || '').startsWith('main/self-check/'));
  // Each inner tree node fires scheduled/started/completed -> 3*3 = 9
  // tick lifecycle events. (Wrapper-level lifecycle is recorded by
  // withNodeLifecycle outside this helper, so we don't see it here.)
  assert.equal(ticked.length, 9);
  const completedTicks = ticked.filter(event => event.eventType === 'node.completed');
  assert.equal(completedTicks.length, 3);
  assert.equal(completedTicks[0].payload.phase, 'phase-1-stub-tick');
});

test('executeTreeWrapper returns skipped when the wrapper has no treeRef', async (t) => {
  const { pipelineDir, run } = await setupTreePipeline(t, { kind: 'orpad.tree', root: {} });
  const wrapper = {
    nodePath: 'main/empty-tree',
    nodeType: 'orpad.tree',
    graphKey: 'main',
    graphRef: 'graphs/main.or-graph',
    config: {},
  };
  const result = await executeTreeWrapper(run.runRoot, wrapper, {
    runId: run.runId,
    attempt: 1,
    pipelineDir,
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no-tree-ref');
});

test('executeTreeWrapper surfaces failed-to-load when the tree file is missing', async (t) => {
  const { pipelineDir, run } = await setupTreePipeline(t, { kind: 'orpad.tree', root: { id: 'root', type: 'Sequence' } });
  const wrapper = {
    nodePath: 'main/missing-tree',
    nodeType: 'orpad.tree',
    graphKey: 'main',
    graphRef: 'graphs/main.or-graph',
    config: { treeRef: '../trees/does-not-exist.or-tree' },
  };
  const result = await executeTreeWrapper(run.runRoot, wrapper, {
    runId: run.runId,
    attempt: 1,
    pipelineDir,
  });
  assert.equal(result.status, 'failed-to-load');
  assert.ok(result.error?.code === 'ENOENT' || /ENOENT/.test(result.error?.message || ''));
});

test('executeTreeWrapper walks nested children in DFS pre-order', async (t) => {
  // Phase 1 makes no semantic distinction between Sequence and Selector
  // — every reachable child fires, in source order. Phase 3 will change
  // this (Selector stops at first-success; Sequence stops at first-fail).
  // The test pins the Phase 1 contract so a future Phase 3 change is a
  // deliberate update, not an accidental regression.
  const treeDoc = {
    kind: 'orpad.tree',
    root: {
      id: 'root',
      type: 'Selector',
      children: [
        {
          id: 'branch-a',
          type: 'Sequence',
          children: [
            { id: 'a1', type: 'Gate' },
            { id: 'a2', type: 'Gate' },
          ],
        },
        { id: 'branch-b', type: 'Gate' },
      ],
    },
  };
  const { pipelineDir, run } = await setupTreePipeline(t, treeDoc);
  const wrapper = {
    nodePath: 'main/decision',
    nodeType: 'orpad.tree',
    graphKey: 'main',
    graphRef: 'graphs/main.or-graph',
    config: { treeRef: '../trees/self-check.or-tree' },
  };
  const result = await executeTreeWrapper(run.runRoot, wrapper, {
    runId: run.runId,
    attempt: 1,
    pipelineDir,
  });
  assert.deepEqual(result.ticks.map(t => t.nodePath), [
    'main/decision/root',
    'main/decision/branch-a',
    'main/decision/a1',
    'main/decision/a2',
    'main/decision/branch-b',
  ]);
});
