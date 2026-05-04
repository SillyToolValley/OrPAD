const fs = require('fs');
const path = require('path');
const {
  WORK_ITEM_SCHEMA_VERSION,
  WORK_ITEM_STATES,
} = require('./work-items');

const BUILT_IN_ORPAD_NODE_TYPES = new Set([
  'orpad.artifactContract',
  'orpad.barrier',
  'orpad.context',
  'orpad.dispatcher',
  'orpad.gate',
  'orpad.probe',
  'orpad.rule',
  'orpad.selector',
  'orpad.skill',
  'orpad.graph',
  'orpad.tree',
  'orpad.triage',
  'orpad.workQueue',
  'orpad.workerLoop',
]);

const ALL_NODE_TYPES = new Set([
  'Sequence',
  'Selector',
  'Parallel',
  'Discuss',
  'Loop',
  'Gate',
  'Context',
  'Timeout',
  'Retry',
  'Catch',
  'CrossCheck',
  'Skill',
  'Planner',
  'OrchTree',
  ...BUILT_IN_ORPAD_NODE_TYPES,
]);

const GRAPH_NODE_TYPES = new Set([
  ...ALL_NODE_TYPES,
  'State',
  'Tool',
  'Human',
  'Wait',
]);

const MVP_EXECUTABLE_NODE_TYPES = new Set([
  'Sequence',
  'Skill',
  'Gate',
  'Context',
  'Retry',
  'Timeout',
  'OrchTree',
  'orpad.context',
  'orpad.gate',
  'orpad.selector',
  'orpad.skill',
  'orpad.tree',
]);

const GRAPH_EXECUTABLE_NODE_TYPES = new Set([
  ...MVP_EXECUTABLE_NODE_TYPES,
  'OrchTree',
]);

const AGENT_ORCHESTRATED_NODE_TYPES = new Set([
  'orpad.artifactContract',
  'orpad.barrier',
  'orpad.dispatcher',
  'orpad.graph',
  'orpad.probe',
  'orpad.triage',
  'orpad.workQueue',
  'orpad.workerLoop',
]);

const MACHINE_EXECUTABLE_NODE_TYPES = new Set([
  ...MVP_EXECUTABLE_NODE_TYPES,
  ...AGENT_ORCHESTRATED_NODE_TYPES,
  'orpad.skill',
  'orpad.tree',
]);

const RENDER_VALIDATE_ONLY_NODE_TYPES = new Set(
  [...ALL_NODE_TYPES].filter(type => !MVP_EXECUTABLE_NODE_TYPES.has(type)),
);

function isSkillNodeType(type) {
  return type === 'Skill' || type === 'orpad.skill';
}

function isTreeNodeType(type) {
  return type === 'OrchTree' || type === 'orpad.tree';
}

function isGraphNodeType(type) {
  return type === 'orpad.graph';
}

function isNodePackRef(ref) {
  const { file } = splitRefAnchor(ref);
  return /^[a-z0-9_.-]+:[a-z0-9_.-]+$/i.test(String(file || ''));
}

const TRUST_LEVELS = new Set([
  'local-authored',
  'imported-review',
  'signed-template',
  'generated-draft',
  'unknown',
]);

function diagnostic(level, code, message, details = {}) {
  return {
    level,
    code,
    message,
    ...details,
  };
}

function splitRefAnchor(ref) {
  const raw = String(ref || '');
  const hashIndex = raw.indexOf('#');
  if (hashIndex === -1) return { file: raw, anchor: '' };
  return {
    file: raw.slice(0, hashIndex),
    anchor: raw.slice(hashIndex + 1),
  };
}

function isUrlRef(ref) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(ref || ''));
}

function isInsideResolvedPath(child, parent) {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  if (resolvedChild === resolvedParent) return true;
  const relative = path.relative(resolvedParent, resolvedChild);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function realpathIfExists(targetPath) {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return null;
  }
}

function resolveRefInsideBase(baseDir, ref, allowedRootDir = baseDir) {
  const { file } = splitRefAnchor(ref);
  if (!file || isUrlRef(file)) return null;
  const resolved = path.resolve(baseDir, file);
  const allowedRoot = path.resolve(allowedRootDir || baseDir);
  if (!isInsideResolvedPath(resolved, allowedRoot)) return null;

  const realResolved = realpathIfExists(resolved);
  if (realResolved) {
    const realAllowedRoot = realpathIfExists(allowedRoot) || allowedRoot;
    if (!isInsideResolvedPath(realResolved, realAllowedRoot)) return null;
  }

  return resolved;
}

function maybeArray(value) {
  return Array.isArray(value) ? value : [];
}

function nodePath(parentPath, index) {
  return parentPath ? `${parentPath}.children[${index}]` : `root.children[${index}]`;
}

function pipelineSkillFileRef(skillRef, options = {}) {
  const key = String(skillRef || '').trim();
  if (!key || !options.pipelineSkills) return '';
  return options.pipelineSkills.get(key) || '';
}

function validateSkillFile(node, currentPath, options, diagnostics) {
  const skillRef = node.skillRef || node.config?.skillRef || '';
  if (skillRef && isNodePackRef(skillRef)) return;
  const ref = node.file || node.config?.file || pipelineSkillFileRef(skillRef, options);
  if (!ref) {
    diagnostics.push(diagnostic(
      'error',
      'SKILL_FILE_MISSING',
      'Skill node must reference a Markdown skill file or pipeline skill id.',
      { nodeId: node.id, path: currentPath, skillRef: skillRef || undefined },
    ));
    return;
  }

  if (isUrlRef(ref)) {
    diagnostics.push(diagnostic(
      'error',
      'SKILL_FILE_REMOTE_REF',
      'Remote skill file references are not executable in the local MVP.',
      { nodeId: node.id, path: currentPath, ref },
    ));
    return;
  }

  const { file } = splitRefAnchor(ref);
  if (!file) {
    diagnostics.push(diagnostic(
      'error',
      'SKILL_FILE_EMPTY_REF',
      'Skill file reference must include a file path.',
      { nodeId: node.id, path: currentPath, ref },
    ));
    return;
  }

  if (options.baseDir) {
    const resolved = resolveRefInsideBase(options.baseDir, ref, options.refRootDir || options.baseDir);
    if (!resolved) {
      diagnostics.push(diagnostic(
        'error',
        'SKILL_FILE_OUTSIDE_BASE',
        'Skill file reference must stay inside the pipeline or runbook directory.',
        { nodeId: node.id, path: currentPath, ref },
      ));
      return;
    }

    if (options.checkFiles && !fs.existsSync(resolved)) {
      diagnostics.push(diagnostic(
        'error',
        'SKILL_FILE_NOT_FOUND',
        'Referenced skill file does not exist.',
        { nodeId: node.id, path: currentPath, ref },
      ));
    }
  }
}

function validateRequiredConfig(node, currentPath, requiredKeys, diagnostics) {
  const config = node.config && typeof node.config === 'object' && !Array.isArray(node.config)
    ? node.config
    : {};
  for (const key of requiredKeys) {
    if (config[key] === undefined || config[key] === null || String(config[key]).trim() === '') {
      diagnostics.push(diagnostic(
        'error',
        'GRAPH_NODE_CONFIG_MISSING',
        `Graph node config must include ${key}.`,
        { nodeId: node.id || undefined, path: `${currentPath}.config.${key}`, configKey: key },
      ));
    }
  }
}

function validateWorkQueueSchema(node, currentPath, diagnostics) {
  const config = node.config && typeof node.config === 'object' && !Array.isArray(node.config)
    ? node.config
    : {};
  const schema = String(config.schema || '').trim();
  if (!schema || schema === WORK_ITEM_SCHEMA_VERSION) return;
  diagnostics.push(diagnostic(
    'error',
    'WORK_QUEUE_SCHEMA_UNSUPPORTED',
    `WorkQueue schema must be ${WORK_ITEM_SCHEMA_VERSION}.`,
    { nodeId: node.id || undefined, path: `${currentPath}.config.schema`, schema },
  ));
}

function validateNode(node, currentPath, state, options, diagnostics) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    diagnostics.push(diagnostic(
      'error',
      'NODE_INVALID',
      'Runbook node must be an object.',
      { path: currentPath },
    ));
    return;
  }

  const id = typeof node.id === 'string' ? node.id.trim() : '';
  const type = typeof node.type === 'string' ? node.type.trim() : '';
  if (!id) {
    diagnostics.push(diagnostic(
      'error',
      'NODE_ID_MISSING',
      'Runbook node must have a non-empty id.',
      { path: currentPath },
    ));
  } else if (state.ids.has(id)) {
    diagnostics.push(diagnostic(
      'error',
      'NODE_ID_DUPLICATE',
      'Runbook node id must be unique within a tree.',
      { nodeId: id, path: currentPath },
    ));
  } else {
    state.ids.add(id);
  }

  if (!type) {
    diagnostics.push(diagnostic(
      'error',
      'NODE_TYPE_MISSING',
      'Runbook node must have a type.',
      { nodeId: id || undefined, path: currentPath },
    ));
  } else if (!ALL_NODE_TYPES.has(type)) {
    diagnostics.push(diagnostic(
      'error',
      'NODE_TYPE_UNKNOWN',
      `Unknown runbook node type: ${type}.`,
      { nodeId: id || undefined, path: currentPath, nodeType: type },
    ));
  } else {
    state.nodeCount += 1;
    state.nodeTypes.add(type);
    if (RENDER_VALIDATE_ONLY_NODE_TYPES.has(type)) {
      state.renderOnlyNodeTypes.add(type);
      diagnostics.push(diagnostic(
        'warning',
        'NODE_RENDER_VALIDATE_ONLY',
        `${type} nodes are render/validate-only in the local MVP executor.`,
        { nodeId: id || undefined, path: currentPath, nodeType: type },
      ));
    }
    if (isSkillNodeType(type)) validateSkillFile(node, currentPath, options, diagnostics);
    if (isTreeNodeType(type)) {
      const embeddedTree = node.tree || node.config?.tree || null;
      const ref = node.treeRef || node.config?.treeRef || node.ref || node.config?.ref || '';
      if (embeddedTree && typeof embeddedTree === 'object' && !Array.isArray(embeddedTree)) {
        const treeIds = state.ids;
        validateTreeEntry(embeddedTree, `${currentPath}.tree`, state, options, diagnostics);
        state.ids = treeIds;
      } else if (ref) {
        validateReferencedTree(ref, currentPath, state, options, diagnostics, id || undefined);
      }
    }
  }

  const outputs = maybeArray(node.config?.outputs);
  outputs.forEach((output, index) => {
    if (!output?.ref) {
      diagnostics.push(diagnostic(
        'warning',
        'OUTPUT_REF_MISSING',
        'Node output entry should include a ref path.',
        { nodeId: id || undefined, path: `${currentPath}.config.outputs[${index}]` },
      ));
    }
  });

  maybeArray(node.children).forEach((child, index) => {
    validateNode(child, nodePath(currentPath, index), state, options, diagnostics);
  });
}

function normalizeTrustLevel(trustLevel, fallback = 'unknown') {
  const normalized = String(trustLevel || fallback);
  return TRUST_LEVELS.has(normalized) ? normalized : 'unknown';
}

function trustLevelFromOptions(options) {
  return normalizeTrustLevel(options.trustLevel, 'local-authored');
}

function trustLevelFromDocument(runbook, options) {
  const declaredTrustLevel = runbook?.trustLevel || runbook?.security?.trustLevel || runbook?.metadata?.trustLevel;
  const trustLevel = declaredTrustLevel || options.trustLevel || 'local-authored';
  return TRUST_LEVELS.has(trustLevel) ? trustLevel : 'unknown';
}

function pushTrustWarning(diagnostics, trustLevel) {
  diagnostics.push(diagnostic(
    'warning',
    'TRUST_REVIEW_REQUIRED',
    `Pipeline trust level "${trustLevel}" requires review before execution.`,
    { trustLevel },
  ));
}

function summarizeCanExecute(diagnostics, trustLevel, renderOnlyNodeTypes) {
  if (diagnostics.some(item => item.level === 'error')) return false;
  if (trustLevel !== 'local-authored' && trustLevel !== 'signed-template') return false;
  return renderOnlyNodeTypes.size === 0;
}

function summarizeMachineExecution(diagnostics, trustLevel, nodeTypes) {
  const blockedReasons = [];
  if (diagnostics.some(item => item.level === 'error')) blockedReasons.push('validation-error');
  if (trustLevel !== 'local-authored' && trustLevel !== 'signed-template') blockedReasons.push('trust-review-required');
  const unsupportedNodeTypes = [...nodeTypes]
    .filter(type => !MACHINE_EXECUTABLE_NODE_TYPES.has(type))
    .sort();
  if (unsupportedNodeTypes.length) blockedReasons.push('unsupported-node-type');
  return {
    canMachineExecute: blockedReasons.length === 0,
    machineBlockedReasons: blockedReasons,
    machineUnsupportedNodeTypes: unsupportedNodeTypes,
  };
}

function summarizeMachineStepExecution(machineExecution, pipeline) {
  const blockedReasons = [];
  if (!machineExecution.canMachineExecute) blockedReasons.push(...machineExecution.machineBlockedReasons);
  const harness = pipeline?.run && typeof pipeline.run === 'object' && !Array.isArray(pipeline.run)
    ? pipeline.run.machineHarness
    : null;
  const adapter = pipeline?.run && typeof pipeline.run === 'object' && !Array.isArray(pipeline.run)
    ? pipeline.run.machineAdapter
    : null;
  const hasHarness = harness && typeof harness === 'object' && !Array.isArray(harness);
  const hasRunnableAdapter = adapter
    && typeof adapter === 'object'
    && !Array.isArray(adapter)
    && adapter.type === 'codex-cli'
    && adapter.enabled !== false;
  if (!hasHarness && !hasRunnableAdapter) {
    blockedReasons.push('machine-harness-required');
  }
  return {
    canMachineExecuteStep: blockedReasons.length === 0,
    machineStepBlockedReasons: [...new Set(blockedReasons)],
  };
}

function executionModesFor({ canExecute, canMachineExecute, agentOrchestratedTypes = [] }) {
  const modes = [];
  if (canExecute) modes.push('local');
  if (canMachineExecute) modes.push('machine');
  if (agentOrchestratedTypes.length) modes.push('handoff');
  return modes;
}

function handoffCompatibility(agentOrchestratedTypes = []) {
  return {
    available: agentOrchestratedTypes.length > 0,
    mode: agentOrchestratedTypes.length ? 'path-only-agent-handoff' : 'not-needed',
    nodeTypes: agentOrchestratedTypes,
  };
}

function validateTreeEntry(tree, treePath, state, options, diagnostics) {
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) {
    diagnostics.push(diagnostic('error', 'TREE_INVALID', 'Tree entry must be an object.', { path: treePath }));
    return;
  }
  if (!tree.id) {
    diagnostics.push(diagnostic('error', 'TREE_ID_MISSING', 'Tree must include an id.', { path: treePath }));
  }
  if (!tree.root) {
    diagnostics.push(diagnostic('error', 'TREE_ROOT_MISSING', 'Tree must include a root node.', { path: treePath }));
    return;
  }
  state.ids = new Set();
  validateNode(tree.root, `${treePath}.root`, state, options, diagnostics);
  delete state.ids;
}

function validateGraphNode(node, currentPath, state, options, diagnostics) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    diagnostics.push(diagnostic('error', 'GRAPH_NODE_INVALID', 'Graph node must be an object.', { path: currentPath }));
    return;
  }

  const id = typeof node.id === 'string' ? node.id.trim() : '';
  const type = typeof node.type === 'string' ? node.type.trim() : '';
  if (!id) {
    diagnostics.push(diagnostic('error', 'GRAPH_NODE_ID_MISSING', 'Graph node must have a non-empty id.', { path: currentPath }));
  } else if (state.ids.has(id)) {
    diagnostics.push(diagnostic('error', 'GRAPH_NODE_ID_DUPLICATE', 'Graph node id must be unique within a graph.', { nodeId: id, path: currentPath }));
  } else {
    state.ids.add(id);
  }

  if (!type) {
    diagnostics.push(diagnostic('error', 'GRAPH_NODE_TYPE_MISSING', 'Graph node must have a type.', { nodeId: id || undefined, path: currentPath }));
    return;
  }
  if (!GRAPH_NODE_TYPES.has(type)) {
    diagnostics.push(diagnostic('error', 'GRAPH_NODE_TYPE_UNKNOWN', `Unknown graph node type: ${type}.`, { nodeId: id || undefined, path: currentPath, nodeType: type }));
    return;
  }

  state.nodeCount += 1;
  state.nodeTypes.add(type);
  if (!GRAPH_EXECUTABLE_NODE_TYPES.has(type)) {
    state.renderOnlyNodeTypes.add(type);
    diagnostics.push(diagnostic(
      'warning',
      'GRAPH_NODE_RENDER_VALIDATE_ONLY',
      `${type} graph nodes are render/validate-only in the local MVP executor.`,
      { nodeId: id || undefined, path: currentPath, nodeType: type },
    ));
  }
  if (isSkillNodeType(type)) validateSkillFile(node, currentPath, options, diagnostics);
  if (type === 'orpad.dispatcher') validateRequiredConfig(node, currentPath, ['queueRef', 'workerLoopRef'], diagnostics);
  if (type === 'orpad.workQueue') {
    validateRequiredConfig(node, currentPath, ['queueRoot', 'schema'], diagnostics);
    validateWorkQueueSchema(node, currentPath, diagnostics);
  }
  if (type === 'orpad.triage' || type === 'orpad.workerLoop') validateRequiredConfig(node, currentPath, ['queueRef'], diagnostics);
  if (isGraphNodeType(type)) {
    const embeddedGraph = node.graph || node.config?.graph || null;
    const ref = node.graphRef || node.config?.graphRef || node.ref || node.config?.ref || '';
    if (embeddedGraph && typeof embeddedGraph === 'object' && !Array.isArray(embeddedGraph)) {
      const nestedDiagnostics = [];
      const nested = validateGraphRunbookObject(
        { kind: 'orpad.graph', version: '1.0', graph: embeddedGraph },
        options,
        'local-authored',
        '1.0',
        nestedDiagnostics,
      );
      mergeNestedValidation(nested, state, diagnostics, `${currentPath}.graph`);
    } else if (ref) {
      validateReferencedGraph(ref, currentPath, state, options, diagnostics, id);
    } else {
      diagnostics.push(diagnostic(
        'warning',
        'ORPAD_GRAPH_REF_MISSING',
        'Graph node should embed a graph or reference an .or-graph file.',
        { nodeId: id || undefined, path: currentPath },
      ));
    }
  }
  if (!isTreeNodeType(type)) return;

  const embeddedTree = node.tree || node.config?.tree || null;
  const ref = node.treeRef || node.config?.treeRef || node.ref || node.config?.ref || '';
  if (embeddedTree && typeof embeddedTree === 'object' && !Array.isArray(embeddedTree)) {
    state.treeCount += 1;
    const graphIds = state.ids;
    validateTreeEntry(embeddedTree, `${currentPath}.tree`, state, options, diagnostics);
    state.ids = graphIds;
  } else if (ref) {
    validateReferencedTree(ref, currentPath, state, options, diagnostics, id);
  } else if (!ref) {
    diagnostics.push(diagnostic(
      'warning',
      'ORCH_TREE_REF_MISSING',
      'Tree graph node should embed a tree or reference an .or-tree or .orch-tree.json file.',
      { nodeId: id || undefined, path: currentPath },
    ));
  }
}

function mergeNestedValidation(result, state, diagnostics, refPath) {
  if (!result) return;
  if (result.canExecute === false) state.nestedCanExecuteBlocked = true;
  state.graphCount = (state.graphCount || 0) + (result.graphCount || 0);
  state.treeCount = (state.treeCount || 0) + (result.treeCount || 0);
  state.nodeCount = (state.nodeCount || 0) + (result.nodeCount || 0);
  for (const type of result.nodeTypes || []) state.nodeTypes.add(type);
  for (const type of result.renderOnlyNodeTypes || []) state.renderOnlyNodeTypes.add(type);
  for (const item of result.diagnostics || []) {
    diagnostics.push({
      ...item,
      path: item.path ? `${refPath}:${item.path}` : refPath,
      refPath: item.refPath ? `${refPath}:${item.refPath}` : refPath,
    });
  }
}

function validateReferencedTree(ref, currentPath, state, options, diagnostics, nodeId) {
  if (isUrlRef(ref)) {
    diagnostics.push(diagnostic(
      'error',
      'ORCH_TREE_REMOTE_REF',
      'Remote tree references are not executable in the local MVP.',
      { nodeId, path: currentPath, ref },
    ));
    return;
  }
  if (!options.baseDir) return;
  const resolved = resolveRefInsideBase(options.baseDir, ref, options.refRootDir || options.baseDir);
  if (!resolved) {
    diagnostics.push(diagnostic(
      'error',
      'ORCH_TREE_OUTSIDE_BASE',
      'Tree reference must stay inside the pipeline or runbook directory.',
      { nodeId, path: currentPath, ref },
    ));
    return;
  }
  if (options.checkFiles && !fs.existsSync(resolved)) {
    diagnostics.push(diagnostic(
      'error',
      'ORCH_TREE_NOT_FOUND',
      'Referenced tree file does not exist.',
      { nodeId, path: currentPath, ref },
    ));
    return;
  }
  if (!options.checkFiles) return;

  const stack = new Set(options.treeValidationStack || []);
  const realResolved = realpathIfExists(resolved) || path.resolve(resolved);
  if (stack.has(realResolved)) {
    diagnostics.push(diagnostic(
      'error',
      'ORCH_TREE_REF_CYCLE',
      'Tree references must not form a cycle.',
      { nodeId, path: currentPath, ref },
    ));
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
    const nested = validateRunbookObject(parsed, {
      ...options,
      baseDir: path.dirname(resolved),
      refRootDir: options.refRootDir || options.baseDir,
      filePath: resolved,
      suppressTrustWarning: true,
      treeValidationStack: new Set([...stack, realResolved]),
    });
    mergeNestedValidation(nested, state, diagnostics, ref);
  } catch (err) {
    diagnostics.push(diagnostic(
      'error',
      'ORCH_TREE_PARSE_FAILED',
      `Referenced tree file could not be parsed: ${err.message}`,
      { nodeId, path: currentPath, ref },
    ));
  }
}

function validateReferencedGraph(ref, currentPath, state, options, diagnostics, nodeId) {
  if (isUrlRef(ref)) {
    diagnostics.push(diagnostic(
      'error',
      'ORPAD_GRAPH_REMOTE_REF',
      'Remote graph references are not executable in the local MVP.',
      { nodeId, path: currentPath, ref },
    ));
    return;
  }
  if (isNodePackRef(ref)) return;
  if (!options.baseDir) return;
  const resolved = resolveRefInsideBase(options.baseDir, ref, options.refRootDir || options.baseDir);
  if (!resolved) {
    diagnostics.push(diagnostic(
      'error',
      'ORPAD_GRAPH_OUTSIDE_BASE',
      'Graph reference must stay inside the pipeline directory.',
      { nodeId, path: currentPath, ref },
    ));
    return;
  }
  if (options.checkFiles && !fs.existsSync(resolved)) {
    diagnostics.push(diagnostic(
      'error',
      'ORPAD_GRAPH_NOT_FOUND',
      'Referenced graph file does not exist.',
      { nodeId, path: currentPath, ref },
    ));
    return;
  }
  if (!options.checkFiles) return;

  const stack = new Set(options.validationStack || []);
  const realResolved = realpathIfExists(resolved) || path.resolve(resolved);
  if (stack.has(realResolved)) {
    diagnostics.push(diagnostic(
      'error',
      'ORPAD_GRAPH_REF_CYCLE',
      'Graph references must not form a cycle.',
      { nodeId, path: currentPath, ref },
    ));
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
    const nested = validateRunbookObject(parsed, {
      ...options,
      baseDir: path.dirname(resolved),
      refRootDir: options.refRootDir || options.baseDir,
      filePath: resolved,
      suppressTrustWarning: true,
      validationStack: new Set([...stack, realResolved]),
    });
    mergeNestedValidation(nested, state, diagnostics, ref);
  } catch (err) {
    diagnostics.push(diagnostic(
      'error',
      'ORPAD_GRAPH_PARSE_FAILED',
      `Referenced graph file could not be parsed: ${err.message}`,
      { nodeId, path: currentPath, ref },
    ));
  }
}

function graphQueueNamespaces(runbook, nodes) {
  const namespaces = new Set(maybeArray(runbook.interface?.queueNamespaces).map(String));
  for (const node of nodes) {
    if (node?.type === 'orpad.workQueue') {
      if (node.config?.queueRef) namespaces.add(String(node.config.queueRef));
      if (node.id) namespaces.add(String(node.id));
    }
  }
  return namespaces;
}

function validateGraphNodeRefs(nodes, runbook, diagnostics) {
  const ids = new Set(nodes.map(node => node?.id).filter(Boolean).map(String));
  const nodeTypesById = new Map(nodes
    .filter(node => node?.id)
    .map(node => [String(node.id), String(node.type || '')]));
  const queues = graphQueueNamespaces(runbook, nodes);

  nodes.forEach((node, index) => {
    if (!node || typeof node !== 'object') return;
    const nodeId = String(node.id || '');
    const type = String(node.type || '');
    const config = node.config && typeof node.config === 'object' && !Array.isArray(node.config)
      ? node.config
      : {};
    const currentPath = `graph.nodes[${index}]`;

    if (['orpad.probe', 'orpad.triage', 'orpad.dispatcher', 'orpad.workerLoop'].includes(type) && config.queueRef) {
      const queueRef = String(config.queueRef);
      if (!queues.has(queueRef)) {
        diagnostics.push(diagnostic(
          'error',
          ids.has(queueRef) ? 'GRAPH_QUEUE_REF_INVALID_TARGET' : 'GRAPH_QUEUE_REF_UNKNOWN',
          'queueRef must reference a WorkQueue node id or declared graph queue namespace.',
          { nodeId: nodeId || undefined, path: `${currentPath}.config.queueRef`, ref: queueRef },
        ));
      }
    }

    if (type === 'orpad.dispatcher' && config.workerLoopRef) {
      const workerLoopRef = String(config.workerLoopRef);
      const workerLoopType = nodeTypesById.get(workerLoopRef);
      if (workerLoopType !== 'orpad.workerLoop') {
        diagnostics.push(diagnostic(
          'error',
          workerLoopType ? 'GRAPH_WORKER_LOOP_REF_INVALID_TARGET' : 'GRAPH_WORKER_LOOP_REF_UNKNOWN',
          'workerLoopRef must reference an existing worker loop node in the graph.',
          { nodeId: nodeId || undefined, path: `${currentPath}.config.workerLoopRef`, ref: workerLoopRef },
        ));
      }
    }
  });
}

function validateGraphRunbookObject(runbook, options, trustLevel, schemaVersion, diagnostics) {
  const graph = runbook.graph || (Array.isArray(runbook.nodes) ? runbook : null);
  const state = {
    ids: new Set(),
    graphCount: 0,
    treeCount: 0,
    nodeCount: 0,
    nodeTypes: new Set(),
    renderOnlyNodeTypes: new Set(),
  };

  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    diagnostics.push(diagnostic('error', 'GRAPH_INVALID', 'Graph runbook must include a graph object.'));
  }

  const nodes = maybeArray(graph?.nodes);
  const transitions = maybeArray(graph?.transitions);
  if (!nodes.length) {
    diagnostics.push(diagnostic('error', 'GRAPH_NODES_MISSING', 'Graph must include at least one node.'));
  }
  nodes.forEach((node, index) => validateGraphNode(node, `graph.nodes[${index}]`, state, options, diagnostics));
  validateGraphNodeRefs(nodes, runbook, diagnostics);

  const ids = new Set(nodes.map(node => node?.id).filter(Boolean).map(String));
  transitions.forEach((transition, index) => {
    const transitionPath = `graph.transitions[${index}]`;
    const from = String(transition?.from || '');
    const to = String(transition?.to || '');
    if (!from || !to) {
      diagnostics.push(diagnostic('error', 'GRAPH_TRANSITION_ENDPOINT_MISSING', 'Graph transition must include from and to node ids.', { path: transitionPath }));
      return;
    }
    if (!ids.has(from)) {
      diagnostics.push(diagnostic('error', 'GRAPH_TRANSITION_FROM_UNKNOWN', 'Graph transition source must reference an existing node.', { path: transitionPath, ref: from }));
    }
    if (!ids.has(to)) {
      diagnostics.push(diagnostic('error', 'GRAPH_TRANSITION_TO_UNKNOWN', 'Graph transition target must reference an existing node.', { path: transitionPath, ref: to }));
    }
  });

  if (!options.suppressTrustWarning && trustLevel !== 'local-authored' && trustLevel !== 'signed-template') {
    pushTrustWarning(diagnostics, trustLevel);
  }

  const canExecute = summarizeCanExecute(diagnostics, trustLevel, state.renderOnlyNodeTypes)
    && !state.nestedCanExecuteBlocked;
  const agentOrchestratedTypes = [...state.renderOnlyNodeTypes]
    .filter(type => AGENT_ORCHESTRATED_NODE_TYPES.has(type))
    .sort();
  const machineExecution = summarizeMachineExecution(diagnostics, trustLevel, state.nodeTypes);
  const machineStepExecution = {
    canMachineExecuteStep: false,
    machineStepBlockedReasons: ['pipeline-required'],
  };

  return {
    ok: !diagnostics.some(item => item.level === 'error'),
    canExecute,
    canMachineExecute: machineExecution.canMachineExecute,
    canMachineExecuteStep: machineStepExecution.canMachineExecuteStep,
    executionModes: executionModesFor({ canExecute, canMachineExecute: machineExecution.canMachineExecute, agentOrchestratedTypes }),
    machineBlockedReasons: machineExecution.machineBlockedReasons,
    machineStepBlockedReasons: machineStepExecution.machineStepBlockedReasons,
    machineUnsupportedNodeTypes: machineExecution.machineUnsupportedNodeTypes,
    handoffCompatibility: handoffCompatibility(agentOrchestratedTypes),
    trustLevel,
    schemaVersion,
    format: runbook.kind === 'orpad.graph' ? 'or-graph' : 'orch-graph',
    graphCount: (graph && typeof graph === 'object' && !Array.isArray(graph) ? 1 : 0) + (state.graphCount || 0),
    treeCount: state.treeCount,
    nodeCount: state.nodeCount,
    nodeTypes: [...state.nodeTypes].sort(),
    executableNodeTypes: [...state.nodeTypes].filter(type => GRAPH_EXECUTABLE_NODE_TYPES.has(type)).sort(),
    renderOnlyNodeTypes: [...state.renderOnlyNodeTypes].sort(),
    diagnostics,
  };
}

function validateTreeRunbookObject(runbook, options, trustLevel, schemaVersion, diagnostics) {
  const hasInlineRoot = runbook.root && typeof runbook.root === 'object' && !Array.isArray(runbook.root);
  const trees = hasInlineRoot
    ? [{ id: runbook.id || 'tree', label: runbook.label || runbook.id || 'Tree', root: runbook.root }]
    : maybeArray(runbook.trees);
  if (trees.length === 0) {
    diagnostics.push(diagnostic('error', 'TREES_MISSING', 'Pipeline tree must include a root node or at least one tree.'));
  }

  const state = {
    nodeCount: 0,
    nodeTypes: new Set(),
    renderOnlyNodeTypes: new Set(),
  };

  trees.forEach((tree, treeIndex) => {
    validateTreeEntry(tree, hasInlineRoot ? 'root' : `trees[${treeIndex}]`, state, options, diagnostics);
  });

  if (!options.suppressTrustWarning && trustLevel !== 'local-authored' && trustLevel !== 'signed-template') {
    pushTrustWarning(diagnostics, trustLevel);
  }

  const canExecute = summarizeCanExecute(diagnostics, trustLevel, state.renderOnlyNodeTypes)
    && !state.nestedCanExecuteBlocked;
  const machineExecution = summarizeMachineExecution(diagnostics, trustLevel, state.nodeTypes);
  const machineStepExecution = {
    canMachineExecuteStep: false,
    machineStepBlockedReasons: ['pipeline-required'],
  };
  return {
    ok: !diagnostics.some(item => item.level === 'error'),
    canExecute,
    canMachineExecute: machineExecution.canMachineExecute,
    canMachineExecuteStep: machineStepExecution.canMachineExecuteStep,
    executionModes: executionModesFor({ canExecute, canMachineExecute: machineExecution.canMachineExecute }),
    machineBlockedReasons: machineExecution.machineBlockedReasons,
    machineStepBlockedReasons: machineStepExecution.machineStepBlockedReasons,
    machineUnsupportedNodeTypes: machineExecution.machineUnsupportedNodeTypes,
    handoffCompatibility: handoffCompatibility([]),
    trustLevel,
    schemaVersion,
    format: hasInlineRoot || runbook.kind === 'orpad.tree' ? 'or-tree' : 'orch-tree',
    graphCount: 0,
    treeCount: trees.length,
    nodeCount: state.nodeCount,
    nodeTypes: [...state.nodeTypes].sort(),
    executableNodeTypes: [...state.nodeTypes].filter(type => MVP_EXECUTABLE_NODE_TYPES.has(type)).sort(),
    renderOnlyNodeTypes: [...state.renderOnlyNodeTypes].sort(),
    diagnostics,
  };
}

function normalizeRefItem(item, fallbackId = '') {
  if (!item) return null;
  if (typeof item === 'string') return { id: fallbackId || path.basename(item), file: item };
  if (typeof item !== 'object' || Array.isArray(item)) return null;
  const file = item.file || item.path || item.ref || '';
  const id = item.id || item.name || fallbackId || (file ? path.basename(file) : '');
  return file ? { ...item, id: String(id), file: String(file) } : null;
}

function collectPipelineRefItems(value) {
  if (Array.isArray(value)) return value.map(item => normalizeRefItem(item)).filter(Boolean);
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([id, item]) => normalizeRefItem(typeof item === 'string' ? item : { id, ...item }, id))
      .filter(Boolean);
  }
  return [];
}

function validatePipelineQueueProtocol(pipeline, diagnostics) {
  const protocol = pipeline.run?.queueProtocol;
  if (!protocol || typeof protocol !== 'object' || Array.isArray(protocol)) return;

  const schema = String(protocol.schema || '').trim();
  if (!schema) {
    diagnostics.push(diagnostic(
      'error',
      'PIPELINE_QUEUE_PROTOCOL_SCHEMA_MISSING',
      'Pipeline run.queueProtocol must declare a work item schema.',
      { path: 'run.queueProtocol.schema' },
    ));
  } else if (schema !== WORK_ITEM_SCHEMA_VERSION) {
    diagnostics.push(diagnostic(
      'error',
      'PIPELINE_QUEUE_PROTOCOL_SCHEMA_UNSUPPORTED',
      `Pipeline run.queueProtocol schema must be ${WORK_ITEM_SCHEMA_VERSION}.`,
      { path: 'run.queueProtocol.schema', schema },
    ));
  }

  const states = Array.isArray(protocol.states) ? protocol.states.map(item => String(item)) : [];
  const missingStates = WORK_ITEM_STATES.filter(state => !states.includes(state));
  if (missingStates.length) {
    diagnostics.push(diagnostic(
      'error',
      'PIPELINE_QUEUE_PROTOCOL_STATES_INCOMPLETE',
      'Pipeline run.queueProtocol states must include every canonical work item state.',
      { path: 'run.queueProtocol.states', missingStates },
    ));
  }
}

function validatePipelineLocalFile(item, kind, baseDir, diagnostics, options) {
  const resolved = resolveRefInsideBase(baseDir, item.file, baseDir);
  if (!resolved) {
    diagnostics.push(diagnostic('error', `${kind.toUpperCase()}_REF_OUTSIDE_PIPELINE`, `${kind} reference must stay inside the pipeline directory.`, { ref: item.file, id: item.id }));
    return null;
  }
  if (options.checkFiles && !fs.existsSync(resolved)) {
    diagnostics.push(diagnostic('error', `${kind.toUpperCase()}_REF_NOT_FOUND`, `Referenced ${kind} file does not exist.`, { ref: item.file, id: item.id }));
  }
  return resolved;
}

function validatePipelineObject(pipeline, options, trustLevel, schemaVersion, diagnostics) {
  const pipelineDir = options.baseDir || (options.filePath ? path.dirname(options.filePath) : '');
  const graphRefs = collectPipelineRefItems(pipeline.graphs);
  const treeRefs = collectPipelineRefItems(pipeline.trees);
  const skillRefs = collectPipelineRefItems(pipeline.skills);
  const ruleRefs = collectPipelineRefItems(pipeline.rules);
  const entryGraph = pipeline.entryGraph
    || pipeline.entry?.graph
    || pipeline.graph?.file
    || graphRefs[0]?.file
    || '';

  if (!pipeline.id) diagnostics.push(diagnostic('warning', 'PIPELINE_ID_MISSING', 'Pipeline should include an id field.'));
  if (!entryGraph) diagnostics.push(diagnostic('error', 'PIPELINE_ENTRY_GRAPH_MISSING', 'Pipeline must include an entryGraph file reference.'));
  validatePipelineQueueProtocol(pipeline, diagnostics);
  if (entryGraph && graphRefs.length && !graphRefs.some(item => splitRefAnchor(item.file).file === splitRefAnchor(entryGraph).file)) {
    diagnostics.push(diagnostic(
      'warning',
      'PIPELINE_ENTRY_GRAPH_NOT_DECLARED',
      'Pipeline entryGraph should also be listed in graphs for clearer replay and editing.',
      { ref: entryGraph },
    ));
  }

  const state = {
    graphCount: 0,
    treeCount: 0,
    nodeCount: 0,
    nodeTypes: new Set(),
    renderOnlyNodeTypes: new Set(),
  };
  const pipelineSkills = new Map();

  for (const item of skillRefs) {
    const resolved = validatePipelineLocalFile(item, 'skill', pipelineDir, diagnostics, options);
    if (resolved) pipelineSkills.set(item.id, resolved);
  }
  for (const item of ruleRefs) validatePipelineLocalFile(item, 'rule', pipelineDir, diagnostics, options);
  for (const item of treeRefs) validatePipelineLocalFile(item, 'tree', pipelineDir, diagnostics, options);
  for (const item of graphRefs) validatePipelineLocalFile(item, 'graph', pipelineDir, diagnostics, options);

  if (entryGraph && pipelineDir) {
    const resolvedEntry = resolveRefInsideBase(pipelineDir, entryGraph, pipelineDir);
    if (!resolvedEntry) {
      diagnostics.push(diagnostic('error', 'PIPELINE_ENTRY_GRAPH_OUTSIDE_PIPELINE', 'Pipeline entryGraph must stay inside the pipeline directory.', { ref: entryGraph }));
    } else if (options.checkFiles && !fs.existsSync(resolvedEntry)) {
      diagnostics.push(diagnostic('error', 'PIPELINE_ENTRY_GRAPH_NOT_FOUND', 'Pipeline entryGraph file does not exist.', { ref: entryGraph }));
    } else if (options.checkFiles) {
      try {
        const graphDoc = JSON.parse(fs.readFileSync(resolvedEntry, 'utf-8'));
        const nested = validateRunbookObject(graphDoc, {
          ...options,
          baseDir: path.dirname(resolvedEntry),
          refRootDir: pipelineDir,
          filePath: resolvedEntry,
          pipeline,
          pipelineSkills,
          suppressTrustWarning: true,
          validationStack: new Set([realpathIfExists(resolvedEntry) || path.resolve(resolvedEntry)]),
        });
        mergeNestedValidation(nested, state, diagnostics, entryGraph);
      } catch (err) {
        diagnostics.push(diagnostic('error', 'PIPELINE_ENTRY_GRAPH_PARSE_FAILED', `Pipeline entryGraph could not be parsed: ${err.message}`, { ref: entryGraph }));
      }
    }
  }

  if (!options.suppressTrustWarning && trustLevel !== 'local-authored' && trustLevel !== 'signed-template') {
    pushTrustWarning(diagnostics, trustLevel);
  }

  const agentOrchestratedTypes = [...state.renderOnlyNodeTypes]
    .filter(type => AGENT_ORCHESTRATED_NODE_TYPES.has(type))
    .sort();
  if (agentOrchestratedTypes.length && !diagnostics.some(item => item.code === 'PIPELINE_AGENT_ORCHESTRATED')) {
    diagnostics.push(diagnostic(
      'warning',
      'PIPELINE_AGENT_ORCHESTRATED',
      'This pipeline validates for a path-launched agent; the local MVP runner does not execute advanced workstream steps.',
      { nodeTypes: agentOrchestratedTypes },
    ));
  }

  const canExecute = summarizeCanExecute(diagnostics, trustLevel, state.renderOnlyNodeTypes)
    && !state.nestedCanExecuteBlocked;
  const machineExecution = summarizeMachineExecution(diagnostics, trustLevel, state.nodeTypes);
  const machineStepExecution = summarizeMachineStepExecution(machineExecution, pipeline);
  return {
    ok: !diagnostics.some(item => item.level === 'error'),
    canExecute,
    canMachineExecute: machineExecution.canMachineExecute,
    canMachineExecuteStep: machineStepExecution.canMachineExecuteStep,
    executionModes: executionModesFor({ canExecute, canMachineExecute: machineExecution.canMachineExecute, agentOrchestratedTypes }),
    machineBlockedReasons: machineExecution.machineBlockedReasons,
    machineStepBlockedReasons: machineStepExecution.machineStepBlockedReasons,
    machineUnsupportedNodeTypes: machineExecution.machineUnsupportedNodeTypes,
    handoffCompatibility: handoffCompatibility(agentOrchestratedTypes),
    trustLevel,
    schemaVersion,
    format: 'or-pipeline',
    pipelineCount: 1,
    graphCount: state.graphCount || (entryGraph ? 1 : 0),
    treeCount: state.treeCount,
    nodeCount: state.nodeCount,
    nodeTypes: [...state.nodeTypes].sort(),
    executableNodeTypes: [...state.nodeTypes].filter(type => GRAPH_EXECUTABLE_NODE_TYPES.has(type) || MVP_EXECUTABLE_NODE_TYPES.has(type)).sort(),
    renderOnlyNodeTypes: [...state.renderOnlyNodeTypes].sort(),
    entryGraph,
    skillCount: skillRefs.length,
    ruleCount: ruleRefs.length,
    diagnostics,
  };
}

function validateRunbookObject(runbook, options = {}) {
  const diagnostics = [];
  const trustLevel = trustLevelFromDocument(runbook, options);

  if (!runbook || typeof runbook !== 'object' || Array.isArray(runbook)) {
    diagnostics.push(diagnostic('error', 'RUNBOOK_INVALID', 'Pipeline, graph, or tree file must be a JSON object.'));
    return {
      ok: false,
      canExecute: false,
      canMachineExecute: false,
      canMachineExecuteStep: false,
      executionModes: [],
      machineBlockedReasons: ['validation-error'],
      machineStepBlockedReasons: ['validation-error'],
      machineUnsupportedNodeTypes: [],
      handoffCompatibility: handoffCompatibility([]),
      trustLevel,
      schemaVersion: '',
      graphCount: 0,
      treeCount: 0,
      nodeCount: 0,
      nodeTypes: [],
      renderOnlyNodeTypes: [],
      diagnostics,
    };
  }

  const schemaVersion = String(runbook.version || '');
  if (!schemaVersion) {
    diagnostics.push(diagnostic('warning', 'VERSION_MISSING', 'OrPAD pipeline files should include a version field.'));
  }

  if (runbook.kind === 'orpad.pipeline' || runbook.entryGraph) {
    return validatePipelineObject(runbook, options, trustLevel, schemaVersion, diagnostics);
  }

  if (runbook.kind === 'orpad.graph' || (runbook.graph && typeof runbook.graph === 'object' && !Array.isArray(runbook.graph)) || Array.isArray(runbook.nodes)) {
    return validateGraphRunbookObject(runbook, options, trustLevel, schemaVersion, diagnostics);
  }

  return validateTreeRunbookObject(runbook, options, trustLevel, schemaVersion, diagnostics);
}

function validateRunbookSource(source, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(source || ''));
  } catch (err) {
    const trustLevel = trustLevelFromOptions(options);
    return {
      ok: false,
      canExecute: false,
      canMachineExecute: false,
      canMachineExecuteStep: false,
      executionModes: [],
      machineBlockedReasons: ['validation-error'],
      machineStepBlockedReasons: ['validation-error'],
      machineUnsupportedNodeTypes: [],
      handoffCompatibility: handoffCompatibility([]),
      trustLevel,
      schemaVersion: '',
      treeCount: 0,
      nodeCount: 0,
      nodeTypes: [],
      executableNodeTypes: [],
      renderOnlyNodeTypes: [],
      diagnostics: [
        diagnostic('error', 'JSON_PARSE_ERROR', `Runbook JSON parse failed: ${err.message}`),
      ],
    };
  }
  return validateRunbookObject(parsed, options);
}

async function validateRunbookFile(filePath, options = {}) {
  const resolved = path.resolve(String(filePath || ''));
  const source = await fs.promises.readFile(resolved, 'utf-8');
  return validateRunbookSource(source, {
    ...options,
    filePath: resolved,
    baseDir: options.baseDir || path.dirname(resolved),
    checkFiles: options.checkFiles !== false,
  });
}

module.exports = {
  ALL_NODE_TYPES,
  BUILT_IN_ORPAD_NODE_TYPES,
  MVP_EXECUTABLE_NODE_TYPES,
  RENDER_VALIDATE_ONLY_NODE_TYPES,
  TRUST_LEVELS,
  validatePipelineObject,
  validateRunbookObject,
  validateRunbookSource,
  validateRunbookFile,
};
