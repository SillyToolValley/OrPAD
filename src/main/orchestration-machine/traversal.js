const { buildNodeInventory } = require('./graph-loader');

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

  return {
    graphCount: graphSet.graphs.length,
    nodeCount: inventory.length,
    graphPlans,
    inventory,
  };
}

module.exports = {
  buildTraversalPlan,
  topologicalOrder,
};
