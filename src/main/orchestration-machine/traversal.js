const { buildNodeInventory } = require('./graph-loader');

function toPortablePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function dirnamePortable(filePath) {
  const portable = toPortablePath(filePath);
  const index = portable.lastIndexOf('/');
  return index === -1 ? '' : portable.slice(0, index);
}

function basenamePortable(filePath) {
  const portable = toPortablePath(filePath);
  const index = portable.lastIndexOf('/');
  return index === -1 ? portable : portable.slice(index + 1);
}

function topologicalOrder(nodes, transitions) {
  const nodeIds = nodes.map(node => node.id).filter(Boolean);
  const originalIndex = new Map(nodeIds.map((id, index) => [id, index]));
  const indegree = new Map(nodeIds.map(id => [id, 0]));
  const outgoing = new Map(nodeIds.map(id => [id, []]));

  for (const edge of transitions || []) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
    indegree.set(edge.to, indegree.get(edge.to) + 1);
    outgoing.get(edge.from).push(edge.to);
  }

  const ready = nodeIds.filter(id => indegree.get(id) === 0)
    .sort((a, b) => originalIndex.get(a) - originalIndex.get(b));
  const ordered = [];

  while (ready.length) {
    const id = ready.shift();
    ordered.push(id);
    for (const next of outgoing.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) {
        ready.push(next);
        ready.sort((a, b) => originalIndex.get(a) - originalIndex.get(b));
      }
    }
  }

  if (ordered.length !== nodeIds.length) {
    const emitted = new Set(ordered);
    for (const id of nodeIds) {
      if (!emitted.has(id)) ordered.push(id);
    }
  }
  return ordered;
}

// Fork-Join Phase 1 (Deliverable 4): cycle detection. `topologicalOrder`
// silently appends nodes whose indegree never drained to zero, which
// hides legitimate loop-back cycles (Pattern B / Pattern I / Pattern K)
// AND truly malformed cycles (LLM authoring errors) under the same
// "cyclic leftover" bucket. Phase 3's ready-set scheduler will treat
// these two cases very differently — loop-back cycles re-enter the
// ready set via an explicit `node.resetForLoopBack` event, while
// non-loop-back cycles must reject the pipeline. Phase 1 surfaces the
// information so callers can make that distinction.
//
// Codex CLI cross-review 2026-05-16 caught that the previous approach
// (Kahn drain forward+reverse, then check residual cycle after stripping
// back edges) had TWO bugs:
//   1) Kahn-both-directions over-reports cycle membership when a path
//      links two distinct SCCs — middle nodes survive both drains
//      despite not being in any SCC.
//   2) Stripping back edges (`fromIdx >= toIdx`) leaves an
//      always-acyclic-by-construction subgraph because remaining edges
//      are strictly increasing in source order. So
//      `nonLoopBackCycleNodeIds` was permanently `[]` — the field
//      promised malformed-cycle detection but never did anything.
//
// The fix: compute exact SCCs via Tarjan's algorithm. An SCC of size
// >=2 (or a single node with a self-loop) is a real cycle. Per SCC we
// classify its internal edges into back-edges (`toIdx <= fromIdx`) and
// forward-edges (`toIdx > fromIdx`). A "clean" loop-back SCC has
// exactly one back-edge; SCCs with >=2 back-edges are tangled cycles
// that Phase 3 must reject (Pattern B/I/K all have exactly one).
function detectGraphCycles(nodes, transitions) {
  const nodeIds = nodes.map(node => node.id).filter(Boolean);
  const idSet = new Set(nodeIds);
  const originalIndex = new Map(nodeIds.map((id, index) => [id, index]));
  const validEdges = (transitions || []).filter(edge => (
    idSet.has(edge?.from) && idSet.has(edge?.to)
  ));

  const sccs = findStronglyConnectedComponents(nodeIds, validEdges);
  const cyclicSCCs = [];
  const cyclicNodeIds = [];
  for (const scc of sccs) {
    const isCycle = scc.size > 1 || hasSelfLoop(scc, validEdges);
    if (!isCycle) continue;
    const sccNodeIds = [...scc];
    cyclicNodeIds.push(...sccNodeIds);
    const sccSet = new Set(sccNodeIds);
    const internalBackEdges = [];
    const internalForwardEdges = [];
    for (const edge of validEdges) {
      if (!sccSet.has(edge.from) || !sccSet.has(edge.to)) continue;
      const fromIdx = originalIndex.get(edge.from);
      const toIdx = originalIndex.get(edge.to);
      if (toIdx <= fromIdx) internalBackEdges.push(edge);
      else internalForwardEdges.push(edge);
    }
    cyclicSCCs.push({
      nodeIds: sccNodeIds,
      backEdges: internalBackEdges,
      forwardEdges: internalForwardEdges,
      // Pattern B/I/K cycles have exactly one back-edge. Tangled
      // multi-back-edge cycles are the LLM-authoring-error class
      // Phase 3 will reject.
      isCleanLoopBack: internalBackEdges.length === 1,
    });
  }

  const loopBackEdges = validEdges.filter(edge => {
    const fromIdx = originalIndex.get(edge.from);
    const toIdx = originalIndex.get(edge.to);
    return toIdx <= fromIdx;
  });

  // Phase 1 surfaces tangled cycles via cyclicSCCs[i].isCleanLoopBack.
  // The previous `nonLoopBackCycleNodeIds` was structurally wrong; we
  // expose the same intent now via `tangledCycleNodeIds` derived
  // honestly from the per-SCC classification.
  const tangledCycleNodeIds = cyclicSCCs
    .filter(scc => !scc.isCleanLoopBack)
    .flatMap(scc => scc.nodeIds);

  return {
    hasCycle: cyclicNodeIds.length > 0,
    cyclicNodeIds,
    cyclicSCCs,
    loopBackEdges,
    tangledCycleNodeIds,
  };
}

function hasSelfLoop(nodeSet, edges) {
  for (const edge of edges) {
    if (edge.from === edge.to && nodeSet.has(edge.from)) return true;
  }
  return false;
}

// Tarjan's strongly-connected-components algorithm (iterative to avoid
// stack overflow on large graphs). Returns an array of Set<nodeId>,
// one per SCC. Singleton SCCs without self-loops are NOT cycles —
// callers must filter via size>1 or self-loop check.
function findStronglyConnectedComponents(nodeIds, edges) {
  const adjacency = new Map(nodeIds.map(id => [id, []]));
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) continue;
    adjacency.get(edge.from).push(edge.to);
  }
  const indices = new Map();
  const lowlinks = new Map();
  const onStack = new Set();
  const stack = [];
  let nextIndex = 0;
  const sccs = [];

  function strongConnect(rootId) {
    // Iterative emulation of Tarjan's recursion. Frame state: { id,
    // adjacencyIndex }. `adjacencyIndex` is the next successor to
    // process for that node.
    const work = [{ id: rootId, adjacencyIndex: 0 }];
    indices.set(rootId, nextIndex);
    lowlinks.set(rootId, nextIndex);
    nextIndex += 1;
    stack.push(rootId);
    onStack.add(rootId);
    while (work.length) {
      const frame = work[work.length - 1];
      const successors = adjacency.get(frame.id) || [];
      if (frame.adjacencyIndex < successors.length) {
        const succ = successors[frame.adjacencyIndex];
        frame.adjacencyIndex += 1;
        if (!indices.has(succ)) {
          indices.set(succ, nextIndex);
          lowlinks.set(succ, nextIndex);
          nextIndex += 1;
          stack.push(succ);
          onStack.add(succ);
          work.push({ id: succ, adjacencyIndex: 0 });
        } else if (onStack.has(succ)) {
          lowlinks.set(frame.id, Math.min(lowlinks.get(frame.id), indices.get(succ)));
        }
      } else {
        // Finished processing this node — pop and propagate lowlink.
        work.pop();
        if (lowlinks.get(frame.id) === indices.get(frame.id)) {
          const scc = new Set();
          let popped;
          do {
            popped = stack.pop();
            onStack.delete(popped);
            scc.add(popped);
          } while (popped !== frame.id);
          sccs.push(scc);
        }
        if (work.length) {
          const parent = work[work.length - 1];
          lowlinks.set(parent.id, Math.min(lowlinks.get(parent.id), lowlinks.get(frame.id)));
        }
      }
    }
  }

  for (const id of nodeIds) {
    if (!indices.has(id)) strongConnect(id);
  }
  return sccs;
}

function buildTraversalPlan(graphSet) {
  const inventory = buildNodeInventory(graphSet);
  const nodesByGraph = new Map();
  for (const node of inventory) {
    if (!nodesByGraph.has(node.graphKey)) nodesByGraph.set(node.graphKey, []);
    nodesByGraph.get(node.graphKey).push(node);
  }

  const graphPlans = graphSet.graphs.map(graph => {
    const orderedIds = topologicalOrder(graph.nodes, graph.transitions);
    const graphNodes = nodesByGraph.get(graph.graphKey) || [];
    const byId = new Map(graphNodes.map(node => [node.nodeId, node]));
    const cycles = detectGraphCycles(graph.nodes, graph.transitions);
    return {
      graphKey: graph.graphKey,
      graphId: graph.graphId,
      graphRef: graph.graphRef,
      nodePaths: orderedIds.map(id => byId.get(id)?.nodePath).filter(Boolean),
      cycles,
    };
  });
  const graphPlanByKey = new Map(graphPlans.map(plan => [plan.graphKey, plan]));
  const graphByKey = new Map(graphSet.graphs.map(graph => [graph.graphKey, graph]));
  const graphKeyByRef = buildGraphKeyByRef(graphSet);
  const entryGraphKey = entryGraphKeyForPlan(graphSet, graphKeyByRef);
  const inlinePlan = buildInlinePlan({
    entryGraphKey,
    graphByKey,
    graphPlanByKey,
    graphKeyByRef,
    nodesByGraph,
  });

  return {
    graphCount: graphSet.graphs.length,
    nodeCount: inventory.length,
    graphPlans,
    inlinePlan,
    inventory,
  };
}

function buildGraphKeyByRef(graphSet) {
  const byRef = new Map();
  for (const graph of graphSet.graphs || []) {
    for (const ref of [
      graph.graphRef,
      basenamePortable(graph.graphRef),
      graph.graphId,
      graph.graphKey,
    ]) {
      const normalized = toPortablePath(ref);
      if (normalized && !byRef.has(normalized)) byRef.set(normalized, graph.graphKey);
    }
  }
  return byRef;
}

function entryGraphKeyForPlan(graphSet, graphKeyByRef) {
  const entryGraph = toPortablePath(graphSet.pipeline?.entryGraph || '');
  if (entryGraph && graphKeyByRef.has(entryGraph)) return graphKeyByRef.get(entryGraph);
  return graphSet.graphs[0]?.graphKey || '';
}

function resolveInlineGraphKey(graphSet, parentGraph, node, graphKeyByRef = buildGraphKeyByRef(graphSet)) {
  const graphRef = toPortablePath(node?.config?.graphRef || '');
  if (!graphRef) return '';
  const parentDir = dirnamePortable(parentGraph?.graphRef || '');
  const candidates = [
    graphRef,
    parentDir ? `${parentDir}/${graphRef}` : graphRef,
    basenamePortable(graphRef),
  ];
  for (const candidate of candidates) {
    const normalized = toPortablePath(candidate);
    if (graphKeyByRef.has(normalized)) return graphKeyByRef.get(normalized);
  }
  return '';
}

function buildInlinePlan(input = {}) {
  const {
    entryGraphKey,
    graphByKey,
    graphPlanByKey,
    graphKeyByRef,
    nodesByGraph,
  } = input;
  const expansions = [];

  function expandGraph(graphKey, stack = []) {
    const graph = graphByKey.get(graphKey);
    const plan = graphPlanByKey.get(graphKey);
    if (!graph || !plan) return [];
    if (stack.includes(graphKey)) {
      expansions.push({ graphKey, skipped: true, reason: 'recursive-inline-graph' });
      return [];
    }
    const graphNodes = nodesByGraph.get(graphKey) || [];
    const byPath = new Map(graphNodes.map(node => [node.nodePath, node]));
    const nodePaths = [];
    const nextStack = [...stack, graphKey];
    for (const nodePath of plan.nodePaths) {
      nodePaths.push(nodePath);
      const node = byPath.get(nodePath);
      if (node?.nodeType !== 'orpad.graph') continue;
      if (node.config?.executionMode !== 'inline') continue;
      const childGraphKey = resolveInlineGraphKey(
        { graphs: [...graphByKey.values()] },
        graph,
        node,
        graphKeyByRef,
      );
      if (!childGraphKey) {
        expansions.push({ nodePath, skipped: true, reason: 'inline-graph-not-found' });
        continue;
      }
      expansions.push({ nodePath, graphKey, childGraphKey, mode: 'inline' });
      nodePaths.push(...expandGraph(childGraphKey, nextStack));
    }
    return nodePaths;
  }

  const nodePaths = entryGraphKey
    ? expandGraph(entryGraphKey, [])
    : [...graphPlanByKey.values()].flatMap(plan => plan.nodePaths);
  return {
    entryGraphKey,
    nodePaths,
    expansions,
  };
}

module.exports = {
  buildGraphKeyByRef,
  buildInlinePlan,
  buildTraversalPlan,
  detectGraphCycles,
  resolveInlineGraphKey,
  topologicalOrder,
};
