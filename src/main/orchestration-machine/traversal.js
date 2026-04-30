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
    return {
      graphKey: graph.graphKey,
      graphId: graph.graphId,
      graphRef: graph.graphRef,
      nodePaths: orderedIds.map(id => byId.get(id)?.nodePath).filter(Boolean),
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
  resolveInlineGraphKey,
  topologicalOrder,
};
