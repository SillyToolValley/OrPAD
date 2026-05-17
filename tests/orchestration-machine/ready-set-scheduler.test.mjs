import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const {
  __test_buildReadySetMaps: buildReadySetMaps,
  __test_pickNextReadyNode: pickNextReadyNode,
} = require(path.join(repoRoot, 'src/main/orchestration-machine'));

// Fork-Join Phase 3 Step 1: ready-set scheduler refactor. The previous
// for-loop walked orderedNodes in fixed topological order. The
// ready-set driver in machine.js maintains a Set<nodePath> of nodes
// whose forward predecessors have all been visited and picks the one
// with the lowest orderedIndex. With no fan-out enabled (Step 1's
// contract), this produces the same visit sequence the for-loop did —
// but expresses dispatch as a ready-set so Step 2 can swap the single
// pick for `mapWithConcurrency` and Step 3 can add loop-back resets
// and conditional pruning without re-rewriting the whole block.

function makeNode(graphKey, nodeId) {
  return {
    nodePath: `${graphKey}/${nodeId}`,
    nodeId,
    graphKey,
    nodeType: 'orpad.context',
    label: '',
    config: {},
    order: 0,
    graphId: graphKey,
    graphRef: `${graphKey}.or-graph`,
    runtimeHandlerKind: 'machine-builtin',
  };
}

test('buildReadySetMaps ignores loop-back edges (target index <= source index) when computing readiness', () => {
  // Pattern B (Ralph loop): worker -> gate, gate -> worker. Source
  // order is [worker, gate], so gate -> worker is a loop-back edge.
  // Phase 3 Step 1 excludes loop-backs from readiness gating so
  // worker is still reachable; Step 3 will replace this with explicit
  // node.resetForLoopBack events.
  const orderedNodes = [makeNode('main', 'worker'), makeNode('main', 'gate'), makeNode('main', 'exit')];
  const graphSet = {
    graphs: [{
      graphKey: 'main',
      transitions: [
        { from: 'worker', to: 'gate' },
        { from: 'gate', to: 'worker' }, // loop-back, ignored
        { from: 'gate', to: 'exit' },
      ],
    }],
  };
  const { orderedIndex, forwardPredecessors, forwardSuccessors } = buildReadySetMaps(orderedNodes, graphSet);

  assert.equal(orderedIndex.get('main/worker'), 0);
  assert.equal(orderedIndex.get('main/gate'), 1);
  assert.equal(orderedIndex.get('main/exit'), 2);

  // worker has NO forward predecessors -> in initial ready set.
  assert.equal(forwardPredecessors.get('main/worker').size, 0);
  // gate has worker as its only forward predecessor.
  assert.deepEqual([...forwardPredecessors.get('main/gate')], ['main/worker']);
  // exit has gate as its only forward predecessor.
  assert.deepEqual([...forwardPredecessors.get('main/exit')], ['main/gate']);

  // Forward successors include the loop-back's reverse direction
  // omitted: gate's successors = [exit] only (NOT [exit, worker]).
  assert.deepEqual([...forwardSuccessors.get('main/gate')].sort(), ['main/exit']);
  assert.deepEqual([...forwardSuccessors.get('main/worker')], ['main/gate']);
});

test('buildReadySetMaps handles cross-graph paths created by inline expansion', () => {
  // Phase 1 inline expansion produces orderedNodes spanning multiple
  // graphKeys: main + child sub-graphs. Predecessor edges live inside
  // each graph's transitions list, keyed by `${graphKey}/${nodeId}`.
  const orderedNodes = [
    makeNode('main', 'entry'),
    makeNode('main', 'plan'),
    makeNode('plan-graph', 'sub-entry'),
    makeNode('plan-graph', 'sub-gate'),
    makeNode('main', 'exit'),
  ];
  const graphSet = {
    graphs: [
      {
        graphKey: 'main',
        transitions: [
          { from: 'entry', to: 'plan' },
          { from: 'plan', to: 'exit' },
        ],
      },
      {
        graphKey: 'plan-graph',
        transitions: [
          { from: 'sub-entry', to: 'sub-gate' },
        ],
      },
    ],
  };
  const { orderedIndex, forwardPredecessors, forwardSuccessors } = buildReadySetMaps(orderedNodes, graphSet);

  // Phase 1 inline expansion places sub-graph nodes inside the outer
  // orderedNodes but does NOT bridge cross-graph wrapper edges. So
  // sub-entry has NO forward predecessor in our reduced map. Codex
  // cross-review 2026-05-16 flagged that the original comment said
  // `executablePaths` would gate this — that's misleading; what
  // ACTUALLY preserves the for-loop's visit order is the driver's
  // lowest-orderedIndex pick (sub-entry has a higher orderedIndex
  // than main/entry and main/plan, so it's picked after them).
  assert.equal(forwardPredecessors.get('plan-graph/sub-entry').size, 0);
  assert.deepEqual([...forwardPredecessors.get('plan-graph/sub-gate')], ['plan-graph/sub-entry']);
  assert.deepEqual([...forwardSuccessors.get('plan-graph/sub-entry')], ['plan-graph/sub-gate']);

  // Drive the picker by hand to prove visit order matches source
  // order. We start with every node that has no forward predecessor
  // (entry + sub-entry + exit-style isolated nodes), pick lowest
  // index, then mark visited and queue successors. The sequence
  // produced must match the topological order of orderedNodes.
  const visited = new Set();
  const ready = new Set();
  for (const node of orderedNodes) {
    if (forwardPredecessors.get(node.nodePath).size === 0) ready.add(node.nodePath);
  }
  const visitOrder = [];
  while (ready.size > 0) {
    const next = pickNextReadyNode(ready, orderedIndex);
    if (!next) break;
    ready.delete(next);
    visited.add(next);
    visitOrder.push(next);
    for (const succ of forwardSuccessors.get(next) || []) {
      if (visited.has(succ) || ready.has(succ)) continue;
      const preds = forwardPredecessors.get(succ);
      if ([...preds].every(p => visited.has(p))) ready.add(succ);
    }
  }
  // Visit order must include ALL orderedNodes in their source order
  // — Phase 1's inline expansion places sub-graph nodes at fixed
  // positions, and the ready-set driver respects those positions.
  assert.deepEqual(visitOrder, orderedNodes.map(n => n.nodePath));
});

test('pickNextReadyNode chooses the lowest orderedIndex (tie-breaker = source order)', () => {
  // The tie-breaker is what makes Step 1's visit order identical to
  // the for-loop's. When multiple nodes are ready, we pick the one
  // that came earliest in topological order — same as the for-loop.
  const orderedIndex = new Map([
    ['main/entry', 0],
    ['main/branch-b', 1],
    ['main/branch-a', 2],
    ['main/exit', 3],
  ]);
  // Both branch-a and branch-b are ready; branch-b's orderedIndex is
  // lower so it must be picked first.
  const ready = new Set(['main/branch-a', 'main/branch-b']);
  assert.equal(pickNextReadyNode(ready, orderedIndex), 'main/branch-b');

  // After branch-b is removed, branch-a is picked.
  ready.delete('main/branch-b');
  assert.equal(pickNextReadyNode(ready, orderedIndex), 'main/branch-a');

  // Empty ready set returns '' (driver's outer loop handles termination).
  ready.delete('main/branch-a');
  assert.equal(pickNextReadyNode(ready, orderedIndex), '');
});

test('pickNextReadyNode tolerates paths not in orderedIndex (drops them silently)', () => {
  // Defensive: if the ready set somehow contains a path the
  // scheduler doesn't know about (renames, drift), don't crash — just
  // skip. The outer driver's `if (!nodePath) break;` then terminates.
  const orderedIndex = new Map([['main/entry', 0]]);
  const ready = new Set(['ghost/node', 'main/entry']);
  assert.equal(pickNextReadyNode(ready, orderedIndex), 'main/entry');

  const onlyGhost = new Set(['ghost/node']);
  assert.equal(pickNextReadyNode(onlyGhost, orderedIndex), '');
});
