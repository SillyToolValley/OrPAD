const fs = require('fs');
const path = require('path');

const fsp = fs.promises;

function toPortablePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function graphLoaderError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function normalizeGraphRef(value, label = 'graphRef') {
  if (typeof value !== 'string' || !value.trim()) {
    throw graphLoaderError('MACHINE_GRAPH_REF_INVALID', `${label} must be a non-empty string.`);
  }
  const portable = toPortablePath(value.trim());
  if (portable.startsWith('/') || portable.match(/^[a-zA-Z]:\//)) {
    throw graphLoaderError('MACHINE_GRAPH_REF_INVALID', `${label} must be pipeline-relative.`);
  }
  const normalized = path.posix.normalize(portable).replace(/^\.\//, '');
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw graphLoaderError('MACHINE_GRAPH_REF_INVALID', `${label} must stay inside the pipeline directory.`);
  }
  return normalized;
}

async function assertNoSymlinkInPipelinePath(pipelineDir, relativePath) {
  const segments = normalizeGraphRef(relativePath).split('/').filter(Boolean);
  let current = path.resolve(pipelineDir);
  for (const segment of segments) {
    current = path.join(current, segment);
    let stats = null;
    try {
      stats = await fsp.lstat(current);
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }
    if (stats.isSymbolicLink()) {
      throw graphLoaderError('MACHINE_GRAPH_REF_SYMLINK_UNSAFE', `Graph ref crosses a symlink: ${relativePath}`);
    }
  }
}

function graphNodes(graphDoc) {
  if (Array.isArray(graphDoc?.nodes)) return graphDoc.nodes;
  if (Array.isArray(graphDoc?.graph?.nodes)) return graphDoc.graph.nodes;
  return [];
}

function graphTransitions(graphDoc) {
  if (Array.isArray(graphDoc?.transitions)) return graphDoc.transitions;
  if (Array.isArray(graphDoc?.graph?.transitions)) return graphDoc.graph.transitions;
  return [];
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

function graphRefsFromPipeline(pipeline) {
  const refs = new Map();
  if (pipeline.entryGraph) refs.set('main', normalizeGraphRef(pipeline.entryGraph, 'entryGraph'));
  const graphs = pipeline.graphs || {};
  if (Array.isArray(graphs)) {
    for (const [index, value] of graphs.entries()) {
      if (value?.file) refs.set(value.id || `graph-${index + 1}`, normalizeGraphRef(value.file, `graphs[${index}].file`));
    }
  } else {
    for (const [key, value] of Object.entries(graphs)) {
      if (value?.file) refs.set(key, normalizeGraphRef(value.file, `graphs.${key}.file`));
    }
  }
  return refs;
}

async function loadPipelineGraphSet({ pipelinePath }) {
  if (!pipelinePath) throw new Error('pipelinePath is required.');
  const resolvedPipelinePath = path.resolve(pipelinePath);
  const pipelineDir = path.dirname(resolvedPipelinePath);
  const pipeline = await readJson(resolvedPipelinePath);
  const graphRefs = graphRefsFromPipeline(pipeline);
  const graphs = [];
  const seenFiles = new Set();

  for (const [graphKey, graphRef] of graphRefs.entries()) {
    const graphPath = path.resolve(pipelineDir, graphRef);
    const portableRef = toPortablePath(path.relative(pipelineDir, graphPath));
    if (seenFiles.has(portableRef)) continue;
    seenFiles.add(portableRef);
    await assertNoSymlinkInPipelinePath(pipelineDir, graphRef);
    const graphDoc = await readJson(graphPath);
    graphs.push({
      graphKey,
      graphRef: portableRef,
      graphPath,
      graphId: graphDoc.id || graphKey,
      graphDoc,
      nodes: graphNodes(graphDoc),
      transitions: graphTransitions(graphDoc),
    });
  }

  return {
    pipeline,
    pipelinePath: resolvedPipelinePath,
    pipelineDir,
    graphs,
  };
}

function runtimeHandlerKind(nodeType) {
  if (['orpad.entry', 'orpad.context', 'orpad.gate', 'orpad.selector', 'orpad.barrier', 'orpad.artifactContract', 'orpad.patchReview', 'orpad.provision', 'orpad.pullRequest', 'orpad.exit', 'orpad.graph'].includes(nodeType)) {
    return 'machine-builtin';
  }
  if (['orpad.probe', 'orpad.skill', 'orpad.triage', 'orpad.dispatcher', 'orpad.workerLoop'].includes(nodeType)) {
    return 'adapter-required';
  }
  if (nodeType === 'orpad.workQueue') return 'machine-builtin';
  return 'render-validate-only';
}

function buildNodeInventory(graphSet) {
  const inventory = [];
  for (const graph of graphSet.graphs) {
    for (const [index, node] of graph.nodes.entries()) {
      inventory.push({
        graphKey: graph.graphKey,
        graphId: graph.graphId,
        graphRef: graph.graphRef,
        nodeId: node.id || `node-${index + 1}`,
        nodePath: `${graph.graphKey}/${node.id || `node-${index + 1}`}`,
        nodeType: node.type || 'unknown',
        label: node.label || '',
        runtimeHandlerKind: runtimeHandlerKind(node.type || ''),
        config: node.config || {},
        order: index,
      });
    }
  }
  return inventory;
}

module.exports = {
  assertNoSymlinkInPipelinePath,
  buildNodeInventory,
  graphNodes,
  graphRefsFromPipeline,
  graphTransitions,
  loadPipelineGraphSet,
  normalizeGraphRef,
  runtimeHandlerKind,
};
