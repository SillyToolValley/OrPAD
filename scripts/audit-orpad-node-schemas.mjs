import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// Static (not createRequire) import so esbuild can inline ajv when this module is
// bundled for packaging; identical behaviour when run standalone under node.
import Ajv from 'ajv';

function usage() {
  return 'Usage: node scripts/audit-orpad-node-schemas.mjs <pipeline.or-pipeline> [workspace-root]';
}

function diagnostic(code, message, details = {}) {
  return { code, message, ...details };
}

function normalizeRef(baseDir, ref) {
  return path.resolve(baseDir, String(ref || '').replace(/\\/g, path.sep));
}

function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function realpathIfExists(targetPath) {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return null;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf-8'));
}

async function listFiles(dirPath, predicate, results = []) {
  let entries = [];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) await listFiles(entryPath, predicate, results);
    else if (entry.isFile() && predicate(entryPath)) results.push(entryPath);
  }
  return results;
}

async function loadNodeSchemas(workspaceRoot) {
  const schemaFiles = await listFiles(path.join(workspaceRoot, 'nodes'), filePath => filePath.endsWith('.or-node'));
  const schemas = new Map();
  const diagnostics = [];
  const ajv = new Ajv({ allErrors: true, schemaId: 'auto' });
  for (const filePath of schemaFiles) {
    let doc;
    try {
      doc = await readJson(filePath);
    } catch (err) {
      diagnostics.push(diagnostic('NODE_SCHEMA_JSON_INVALID', 'Node schema must contain valid JSON.', {
        path: path.relative(workspaceRoot, filePath),
        error: err.message,
      }));
      continue;
    }
    if (!doc?.type) continue;
    const properties = doc.configSchema?.properties && typeof doc.configSchema.properties === 'object'
      ? new Set(Object.keys(doc.configSchema.properties))
      : new Set();
    let validate = null;
    if (doc.configSchema && typeof doc.configSchema === 'object' && !Array.isArray(doc.configSchema)) {
      try {
        validate = ajv.compile(doc.configSchema);
      } catch (err) {
        diagnostics.push(diagnostic('NODE_CONFIG_SCHEMA_INVALID', 'Node configSchema must be a valid JSON Schema.', {
          nodeType: String(doc.type),
          path: path.relative(workspaceRoot, filePath),
          error: err.message,
        }));
      }
    }
    schemas.set(String(doc.type), {
      path: filePath,
      properties,
      validate,
    });
  }
  return { schemas, diagnostics };
}

function graphEntriesFromPipeline(pipeline) {
  const refs = [];
  if (typeof pipeline?.entryGraph === 'string' && pipeline.entryGraph.trim()) refs.push(pipeline.entryGraph);
  const graphs = pipeline?.graphs;
  if (Array.isArray(graphs)) {
    graphs.forEach(item => {
      if (typeof item === 'string') refs.push(item);
      else if (item?.file) refs.push(item.file);
    });
  } else if (graphs && typeof graphs === 'object') {
    Object.values(graphs).forEach(item => {
      if (typeof item === 'string') refs.push(item);
      else if (item?.file) refs.push(item.file);
    });
  }
  return [...new Set(refs.filter(Boolean).map(String))];
}

function nodePackGraphPath(workspaceRoot, ref) {
  const match = String(ref || '').match(/^([a-z0-9_.-]+):([a-z0-9_.-]+)$/i);
  if (!match) return '';
  return path.join(workspaceRoot, 'nodes', match[1], 'graphs', `${match[2]}.or-graph`);
}

function graphRefFromNode(node) {
  if (node?.type !== 'orpad.graph') return '';
  return node.graphRef || node.config?.graphRef || node.ref || node.config?.ref || '';
}

async function collectGraphFiles({ pipelinePath, workspaceRoot, diagnostics }) {
  const pipelineDir = path.dirname(pipelinePath);
  const pipeline = await readJson(pipelinePath);
  const nodePackRoot = path.join(workspaceRoot, 'nodes');
  const queue = graphEntriesFromPipeline(pipeline).map(ref => ({
    path: normalizeRef(pipelineDir, ref),
    allowNodePack: false,
  }));
  const visited = new Set();
  const graphFiles = [];

  while (queue.length) {
    const item = queue.shift();
    const graphPath = item.path;
    const allowNodePack = item.allowNodePack && isInside(graphPath, nodePackRoot);
    const key = path.resolve(graphPath).toLowerCase();
    if (visited.has(key)) continue;
    visited.add(key);
    const boundaryRoot = allowNodePack ? nodePackRoot : pipelineDir;
    if (!isInside(graphPath, boundaryRoot)) {
      diagnostics.push(diagnostic('GRAPH_REF_OUTSIDE_PIPELINE', 'Graph refs must stay inside the pipeline directory.', {
        path: path.relative(workspaceRoot, graphPath),
      }));
      continue;
    }
    const realGraphPath = await realpathIfExists(graphPath);
    if (realGraphPath) {
      const realBoundaryRoot = await realpathIfExists(boundaryRoot) || path.resolve(boundaryRoot);
      if (!isInside(realGraphPath, realBoundaryRoot)) {
        diagnostics.push(diagnostic('GRAPH_REF_OUTSIDE_PIPELINE', 'Graph refs must stay inside the pipeline directory.', {
          path: path.relative(workspaceRoot, graphPath),
          realPath: path.relative(workspaceRoot, realGraphPath),
        }));
        continue;
      }
    }
    let doc;
    try {
      doc = await readJson(graphPath);
    } catch (err) {
      diagnostics.push(diagnostic('GRAPH_JSON_INVALID', 'Referenced graph must contain valid JSON.', {
        path: path.relative(workspaceRoot, graphPath),
        error: err.message,
      }));
      continue;
    }
    graphFiles.push({ path: graphPath, doc });
    const nodes = Array.isArray(doc?.graph?.nodes) ? doc.graph.nodes : Array.isArray(doc?.nodes) ? doc.nodes : [];
    for (const node of nodes) {
      const ref = graphRefFromNode(node);
      if (!ref) continue;
      const nodePackPath = nodePackGraphPath(workspaceRoot, ref);
      if (nodePackPath) {
        queue.push({ path: nodePackPath, allowNodePack: true });
      } else {
        queue.push({
          path: normalizeRef(path.dirname(graphPath), ref),
          allowNodePack,
        });
      }
    }
  }

  return graphFiles;
}

function auditGraphConfigs({ graphFiles, schemas, workspaceRoot }) {
  const diagnostics = [];
  const checkedNodes = [];
  for (const graph of graphFiles) {
    const nodes = Array.isArray(graph.doc?.graph?.nodes) ? graph.doc.graph.nodes : Array.isArray(graph.doc?.nodes) ? graph.doc.nodes : [];
    nodes.forEach((node, index) => {
      const type = String(node?.type || '');
      const nodeId = String(node?.id || '');
      if (!type.startsWith('orpad.')) return;
      const schema = schemas.get(type);
      const graphPath = path.relative(workspaceRoot, graph.path);
      if (!schema) {
        diagnostics.push(diagnostic('NODE_SCHEMA_MISSING', 'OrPAD graph node type must have a node-pack schema.', {
          graph: graphPath,
          nodeId,
          nodeType: type,
          path: `graph.nodes[${index}]`,
        }));
        return;
      }

      const config = node?.config && typeof node.config === 'object' && !Array.isArray(node.config) ? node.config : {};
      const configKeys = Object.keys(config);
      const unknownKeys = configKeys.filter(key => !schema.properties.has(key));
      checkedNodes.push({ graph: graphPath, nodeId, nodeType: type, configKeys });
      for (const key of unknownKeys) {
        diagnostics.push(diagnostic('NODE_CONFIG_SCHEMA_DRIFT', 'Graph node config key is not declared by its node schema.', {
          graph: graphPath,
          nodeId,
          nodeType: type,
          configKey: key,
          path: `graph.nodes[${index}].config.${key}`,
          schema: path.relative(workspaceRoot, schema.path),
        }));
      }
      if (schema.validate && !schema.validate(config)) {
        for (const error of schema.validate.errors || []) {
          diagnostics.push(diagnostic('NODE_CONFIG_SCHEMA_VIOLATION', 'Graph node config does not satisfy its node configSchema.', {
            graph: graphPath,
            nodeId,
            nodeType: type,
            path: `graph.nodes[${index}].config${error.dataPath || error.instancePath || ''}`,
            schema: path.relative(workspaceRoot, schema.path),
            schemaPath: error.schemaPath,
            message: error.message,
          }));
        }
      }
    });
  }
  return { checkedNodes, diagnostics };
}

async function auditNodeSchemas(pipelinePath, workspaceRoot = process.cwd()) {
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const resolvedPipeline = path.resolve(pipelinePath);
  const diagnostics = [];
  const { schemas, diagnostics: schemaDiagnostics } = await loadNodeSchemas(resolvedWorkspace);
  diagnostics.push(...schemaDiagnostics);
  const graphFiles = await collectGraphFiles({
    pipelinePath: resolvedPipeline,
    workspaceRoot: resolvedWorkspace,
    diagnostics,
  });
  const graphAudit = auditGraphConfigs({ graphFiles, schemas, workspaceRoot: resolvedWorkspace });
  diagnostics.push(...graphAudit.diagnostics);
  return {
    ok: diagnostics.length === 0,
    pipelinePath: resolvedPipeline,
    workspaceRoot: resolvedWorkspace,
    graphCount: graphFiles.length,
    checkedNodeCount: graphAudit.checkedNodes.length,
    checkedNodes: graphAudit.checkedNodes,
    diagnostics,
  };
}

const [, , pipelineArg, workspaceArg] = process.argv;
// The endsWith check keeps this CLI from firing when the module is BUNDLED into
// another script (e.g. audit-orpad-run.mjs for packaging): in a single esbuild
// bundle every module shares one import.meta.url, so without this the sibling's
// run-audit entry and this schema-audit entry would both match argv[1].
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && import.meta.url.endsWith('audit-orpad-node-schemas.mjs')) {
  if (!pipelineArg) {
    console.error(usage());
    process.exit(2);
  }
  try {
    const result = await auditNodeSchemas(pipelineArg, workspaceArg || process.cwd());
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    console.error(err?.message || String(err));
    process.exit(2);
  }
}

export { auditNodeSchemas };
