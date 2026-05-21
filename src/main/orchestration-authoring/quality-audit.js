const fs = require('fs');
const path = require('path');
const { validateRunbookFile } = require('../runbooks/validator');
const { loadPipelineGraphSet } = require('../orchestration-machine/graph-loader');
const { buildTraversalPlan } = require('../orchestration-machine/traversal');

const GATE_CONDITIONS = new Set([
  'pass',
  'continue',
  'accept',
  'accepted',
  'ok',
  'success',
  'revise',
  'reject',
  'rejected',
  'fail',
  'retry',
  'queue-empty',
  'queue-not-empty',
]);
const PATCH_REVIEW_CONDITIONS = new Set(['accepted', 'accept', 'pass', 'continue', 'rejected', 'reject', 'revise']);
const BARRIER_CONDITIONS = new Set(['pass', 'continue', 'partial', 'fail']);
const DECISION_TYPES = new Set(['orpad.selector', 'orpad.gate', 'orpad.patchReview', 'orpad.barrier']);
const PLACEHOLDER_PATTERN = /TODO\s*(?:\u2014|-)?\s*author|Placeholder created by generator|Placeholder leaf|TODO placeholder/i;
const CONTENT_QA_NODE_PACK_ID = 'orpad.starter.content-qa';
const CONTENT_GRAPH_INTENT_PATTERN = /\b(readme|docs?|documentation|markdown|content|tutorial|lesson|lecture|course|slides?|copy|localization|locale|onboarding|learning material|course material)\b|\uBB38\uC11C|\uAC15\uC758|\uC790\uB8CC|\uC2AC\uB77C\uC774\uB4DC|\uD559\uC2B5|\uAD50\uC721|\uC218\uC5C5|\uD29C\uD1A0\uB9AC\uC5BC|\uB9C8\uD06C\uB2E4\uC6B4|\uBC88\uC5ED|\uD604\uC9C0\uD654/i;
const EDITORIAL_GATE_PATTERN = /\b(editorial|voice|tone|style|density|readability|audience|duplicate|duplication|repetition|rewrite|polish|presentation|slide|role[-\s]?separat|human-authored|ai-sounding|model meta|over-explanation)\b/i;
const EDITORIAL_DIMENSION_PATTERNS = {
  voice: /\b(voice|tone|style|human-authored|ai-sounding|model meta|generic model|summary phrases|copy)\b/i,
  density: /\b(density|repetition|duplicate|duplication|over-explanation|checklist|one main|edited down|concise|slide|section)\b/i,
  role: /\b(role[-\s]?separat|README|slides?|presentation|audience|readability|examples?|acceptance criteria|learner|user-facing)\b/i,
  evidence: /\b(before\/after|removed|consolidated|rewritten|rewrote|merged|evidence|not only what was added)\b/i,
};

function diagnostic(level, code, message, details = {}) {
  return { level, code, message, ...details };
}

function toPortable(value) {
  return String(value || '').replace(/\\/g, '/');
}

function flattenTraversalNodes(plan) {
  const byPath = new Map(plan.inventory.map(node => [node.nodePath, node]));
  const nodePaths = plan.inlinePlan?.nodePaths?.length
    ? plan.inlinePlan.nodePaths
    : plan.graphPlans.flatMap(graphPlan => graphPlan.nodePaths);
  return nodePaths.map(nodePath => byPath.get(nodePath)).filter(Boolean);
}

function graphDir(graphRef) {
  const portable = toPortable(graphRef);
  const index = portable.lastIndexOf('/');
  return index >= 0 ? portable.slice(0, index) : '';
}

function resolveGraphRelativeRef(parentGraphRef, ref) {
  const parentDir = graphDir(parentGraphRef);
  return path.posix.normalize(parentDir ? `${parentDir}/${toPortable(ref)}` : toPortable(ref)).replace(/^\.\//, '');
}

function graphByResolvedRef(graphSet) {
  const byRef = new Map();
  for (const graph of graphSet.graphs || []) {
    byRef.set(toPortable(graph.graphRef), graph);
    byRef.set(path.posix.basename(toPortable(graph.graphRef)), graph);
    if (graph.graphId) byRef.set(String(graph.graphId), graph);
  }
  return byRef;
}

function nodeType(node) {
  return String(node?.type || '').trim();
}

function nodeId(node) {
  return String(node?.id || '').trim();
}

function transitionCondition(edge) {
  return String(edge?.condition || '').trim();
}

function nodeText(node) {
  const config = node?.config || {};
  return [
    node?.id,
    node?.label,
    node?.type,
    config.summary,
    config.evaluationMode,
    ...(Array.isArray(config.criteria) ? config.criteria : []),
    ...(Array.isArray(config.reviewChecklist) ? config.reviewChecklist : []),
    ...(Array.isArray(config.qualityDimensions) ? config.qualityDimensions : []),
  ].map(item => String(item || '')).join('\n');
}

function gateIdentityText(node) {
  const config = node?.config || {};
  return [
    node?.id,
    node?.label,
    config.summary,
    config.evaluationMode,
    config.sourceNodePack,
    ...(Array.isArray(config.reviewChecklist) ? config.reviewChecklist : []),
    ...(Array.isArray(config.qualityDimensions) ? config.qualityDimensions : []),
  ].map(item => String(item || '')).join('\n');
}

function selectedNodePackMetadata(pipeline, packId) {
  const selection = Array.isArray(pipeline?.metadata?.orchestrationAuthoring?.nodePackSelection)
    ? pipeline.metadata.orchestrationAuthoring.nodePackSelection
    : [];
  return selection.find(pack => String(pack?.id || '').trim() === packId) || null;
}

function pipelineDeclaresNodePack(pipeline, packId) {
  return (Array.isArray(pipeline?.nodePacks) ? pipeline.nodePacks : [])
    .some(pack => String(pack?.id || '').trim() === packId);
}

function nodePackPromptMatched(selection) {
  return (Array.isArray(selection?.matchedSignals) ? selection.matchedSignals : [])
    .some(signal => (
      String(signal || '').startsWith('prompt:')
      || String(signal || '') === 'combined:prompt+workspace'
    ));
}

function pipelineIntentText(pipeline) {
  return [
    pipeline?.title,
    pipeline?.description,
    pipeline?.metadata?.orchestrationAuthoring?.prompt,
    pipeline?.metadata?.orchestrationAuthoring?.taskText,
  ].map(item => String(item || '')).join('\n');
}

function contentQualityContractApplies(pipeline) {
  if (!pipelineDeclaresNodePack(pipeline, CONTENT_QA_NODE_PACK_ID)) return false;
  const selection = selectedNodePackMetadata(pipeline, CONTENT_QA_NODE_PACK_ID);
  if (nodePackPromptMatched(selection)) return true;
  return CONTENT_GRAPH_INTENT_PATTERN.test(pipelineIntentText(pipeline));
}

function editorialDimensionMatches(node) {
  const text = nodeText(node);
  return Object.entries(EDITORIAL_DIMENSION_PATTERNS)
    .filter(([, pattern]) => pattern.test(text))
    .map(([key]) => key);
}

function editorialEvaluationArtifactPaths(node) {
  const config = node?.config || {};
  return [
    ...(Array.isArray(config.expectedEvaluationArtifacts) ? config.expectedEvaluationArtifacts : []),
    ...(Array.isArray(config.evaluationArtifacts) ? config.evaluationArtifacts : []),
    ...(Array.isArray(config.evaluationArtifactPaths) ? config.evaluationArtifactPaths : []),
  ].map(item => String(item || '').trim()).filter(Boolean);
}

function editorialJudgeArtifactPaths(node) {
  const config = node?.config || {};
  return [
    config.judgeArtifact,
    config.judgeResultArtifact,
    config.expectedJudgeArtifact,
    ...(Array.isArray(config.judgeArtifacts) ? config.judgeArtifacts : []),
    ...(Array.isArray(config.judgeResultArtifacts) ? config.judgeResultArtifacts : []),
    ...(Array.isArray(config.expectedJudgeArtifacts) ? config.expectedJudgeArtifacts : []),
  ].map(item => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') return item.path || item.artifactPath || '';
    return '';
  }).map(item => String(item || '').trim()).filter(Boolean);
}

function editorialGateEvaluationContract(node) {
  const config = node?.config || {};
  const judgePolicy = String(config.judgePolicy || '').trim();
  const expectedJudgeArtifacts = editorialJudgeArtifactPaths(node);
  return {
    evaluationMode: String(config.evaluationMode || '').trim(),
    judgePolicy,
    judgePolicyValid: ['rule-only', 'rule-then-llm', 'llm-required'].includes(judgePolicy),
    expectedEvaluationArtifacts: editorialEvaluationArtifactPaths(node),
    expectedJudgeArtifacts,
    llmJudgeConfigured: judgePolicy === 'rule-only'
      || expectedJudgeArtifacts.some(item => /artifacts\/evaluations\/content-editorial\/judges\//.test(item))
      || Boolean(config.judgeAdapter || config.judgeAdapterRef || config.judgeProvider),
    nodePackRubricCount: Array.isArray(config.nodePackRubric) ? config.nodePackRubric.length : 0,
  };
}

function gateIsEditorial(node) {
  return nodeType(node) === 'orpad.gate'
    && EDITORIAL_GATE_PATTERN.test(gateIdentityText(node));
}

function gateAppearsBeforeArtifact(graph, gate) {
  const nodes = graph.nodes || [];
  const gateIndex = nodes.findIndex(node => nodeId(node) === nodeId(gate));
  const artifactIndex = nodes.findIndex(node => nodeType(node) === 'orpad.artifactContract');
  return gateIndex >= 0 && (artifactIndex < 0 || gateIndex < artifactIndex);
}

function auditGraphRuntimeContracts(graph, graphSet, diagnostics) {
  const nodeById = new Map((graph.nodes || []).map(node => [nodeId(node), node]));
  const graphRefs = graphByResolvedRef(graphSet);

  for (const node of graph.nodes || []) {
    const type = nodeType(node);
    const id = nodeId(node);
    const config = node.config || {};

    if (type === 'orpad.barrier') {
      const waitFor = Array.isArray(config.waitFor) ? config.waitFor.map(String).filter(Boolean) : [];
      if (!waitFor.length) {
        diagnostics.push(diagnostic('error', 'AUTHORING_BARRIER_WAIT_FOR_MISSING', 'Barrier nodes must declare config.waitFor.', { graphRef: graph.graphRef, nodeId: id }));
      }
      for (const alias of ['joinSources', 'sources', 'branches', 'dependsOn']) {
        if (config[alias] !== undefined) {
          diagnostics.push(diagnostic('error', 'AUTHORING_BARRIER_ALIAS_LEFTOVER', `Barrier alias config.${alias} must be normalized to waitFor.`, { graphRef: graph.graphRef, nodeId: id }));
        }
      }
      for (const dep of waitFor) {
        if (!nodeById.has(String(dep))) {
          diagnostics.push(diagnostic('error', 'AUTHORING_BARRIER_WAIT_FOR_UNKNOWN', 'Barrier waitFor entry must reference a node in the same graph.', { graphRef: graph.graphRef, nodeId: id, dependency: dep }));
        }
      }
    }

    if (type === 'orpad.graph') {
      const ref = String(config.graphRef || '').trim();
      if (!ref) {
        diagnostics.push(diagnostic('error', 'AUTHORING_GRAPH_REF_MISSING', 'orpad.graph nodes must declare config.graphRef.', { graphRef: graph.graphRef, nodeId: id }));
      } else {
        if (/^graphs[\\/]/i.test(ref) || !ref.endsWith('.or-graph')) {
          diagnostics.push(diagnostic('error', 'AUTHORING_GRAPH_REF_NON_CANONICAL', 'Sub-graph refs must be bare .or-graph filenames relative to the parent graph directory.', { graphRef: graph.graphRef, nodeId: id, ref }));
        }
        const resolved = resolveGraphRelativeRef(graph.graphRef, ref);
        const child = graphRefs.get(resolved) || graphRefs.get(path.posix.basename(resolved));
        if (!child) {
          diagnostics.push(diagnostic('error', 'AUTHORING_GRAPH_REF_UNMATERIALIZED', 'orpad.graph ref must resolve to a materialized graph file.', { graphRef: graph.graphRef, nodeId: id, ref }));
        } else {
          const childTypes = (child.nodes || []).map(item => nodeType(item));
          const hasStructuralValue = childTypes.some(item => !['orpad.entry', 'orpad.exit'].includes(item));
          if (!hasStructuralValue) {
            diagnostics.push(diagnostic('error', 'AUTHORING_SUBGRAPH_DECORATIVE', 'Sub-graphs must contain structural work beyond entry/exit.', { graphRef: child.graphRef, parentNodeId: id }));
          }
        }
      }
    }

    if (type === 'orpad.tree') {
      const ref = String(config.treeRef || '').trim();
      if (!ref.startsWith('../trees/') || !ref.endsWith('.or-tree')) {
        diagnostics.push(diagnostic('error', 'AUTHORING_TREE_REF_NON_CANONICAL', 'Tree refs must use ../trees/<name>.or-tree from graphs/main.or-graph.', { graphRef: graph.graphRef, nodeId: id, ref }));
      }
    }

    if (type === 'orpad.gate') {
      const criteria = Array.isArray(config.criteria) ? config.criteria.map(String).filter(Boolean) : [];
      if (!criteria.length || criteria.some(item => /task-specific checks pass|checks pass/i.test(item))) {
        diagnostics.push(diagnostic('error', 'AUTHORING_GATE_CRITERIA_WEAK', 'Gate criteria must be concrete and task-specific.', { graphRef: graph.graphRef, nodeId: id }));
      }
    }
  }

  for (const edge of graph.transitions || []) {
    const source = nodeById.get(String(edge.from || ''));
    const sourceType = nodeType(source);
    const condition = transitionCondition(edge);
    if (!condition) continue;
    let ok = false;
    if (sourceType === 'orpad.selector') {
      const options = Array.isArray(source?.config?.options) ? source.config.options.map(String) : [];
      ok = options.includes(condition);
    } else if (sourceType === 'orpad.gate') {
      ok = GATE_CONDITIONS.has(condition);
    } else if (sourceType === 'orpad.patchReview') {
      ok = PATCH_REVIEW_CONDITIONS.has(condition);
    } else if (sourceType === 'orpad.barrier') {
      ok = BARRIER_CONDITIONS.has(condition);
    } else if (!DECISION_TYPES.has(sourceType)) {
      ok = false;
    }
    if (!ok) {
      diagnostics.push(diagnostic('error', 'AUTHORING_RUNTIME_CONDITION_UNSAFE', 'Transition conditions must be runtime-canonical and originate from decision-emitting nodes.', {
        graphRef: graph.graphRef,
        from: edge.from,
        to: edge.to,
        sourceType,
        condition,
      }));
    }
  }
}

function auditPatchReviewContracts(graph, diagnostics) {
  for (const node of graph.nodes || []) {
    if (nodeType(node) !== 'orpad.patchReview') continue;
    const outgoing = (graph.transitions || []).filter(edge => edge.from === node.id);
    const conditions = new Set(outgoing.map(transitionCondition));
    if (!conditions.has('accepted') || !conditions.has('rejected')) {
      diagnostics.push(diagnostic('error', 'AUTHORING_PATCH_REVIEW_BRANCHING_MISSING', 'patchReview must have accepted and rejected outgoing branches.', {
        graphRef: graph.graphRef,
        nodeId: node.id,
        conditions: [...conditions].filter(Boolean),
      }));
    }
  }
}

function auditQueueDrain(graph, diagnostics) {
  const nodes = graph.nodes || [];
  const hasQueue = nodes.some(node => nodeType(node) === 'orpad.workQueue');
  const hasDispatcher = nodes.some(node => nodeType(node) === 'orpad.dispatcher');
  if (!hasQueue || !hasDispatcher) return;
  const artifactIndex = nodes.findIndex(node => nodeType(node) === 'orpad.artifactContract');
  const gates = nodes.filter((node, index) => nodeType(node) === 'orpad.gate' && (artifactIndex < 0 || index < artifactIndex));
  const gate = gates[gates.length - 1];
  if (!gate) {
    diagnostics.push(diagnostic('error', 'AUTHORING_QUEUE_DRAIN_GATE_MISSING', 'workQueue + dispatcher pipelines need a final gate before artifactContract.', { graphRef: graph.graphRef }));
    return;
  }
  const outgoing = (graph.transitions || []).filter(edge => edge.from === gate.id);
  const conditions = new Set(outgoing.map(transitionCondition));
  if (!conditions.has('queue-empty') || !conditions.has('queue-not-empty')) {
    diagnostics.push(diagnostic('error', 'AUTHORING_QUEUE_DRAIN_LOOP_MISSING', 'Final gate must branch on queue-empty and queue-not-empty.', { graphRef: graph.graphRef, nodeId: gate.id }));
  }
}

function auditMachineAdapter(pipeline, orderedNodes, diagnostics) {
  const adapter = pipeline?.run?.machineAdapter || {};
  if (!adapter || adapter.enabled === false) return;
  const byPath = new Map(orderedNodes.map(node => [node.nodePath, node]));
  const adapterProbePaths = new Set(Array.isArray(adapter.probeNodePaths)
    ? adapter.probeNodePaths.map(String).filter(Boolean)
    : []);
  const required = [
    ...(Array.isArray(adapter.probeNodePaths) ? adapter.probeNodePaths.map(path => [path, 'orpad.probe']) : []),
    [adapter.triageNodePath, 'orpad.triage'],
    [adapter.dispatcherNodePath, 'orpad.dispatcher'],
    [adapter.workerNodePath, 'orpad.workerLoop'],
  ].filter(([nodePath]) => nodePath);
  for (const [nodePath, expectedType] of required) {
    const node = byPath.get(nodePath);
    if (!node) {
      diagnostics.push(diagnostic('error', 'AUTHORING_ADAPTER_PATH_MISSING', 'machineAdapter node path must exist after inline traversal.', { nodePath, expectedType }));
    } else if (node.nodeType !== expectedType) {
      diagnostics.push(diagnostic('error', 'AUTHORING_ADAPTER_PATH_TYPE_MISMATCH', 'machineAdapter node path points to the wrong node type.', { nodePath, expectedType, actualType: node.nodeType }));
    }
  }
  const allProbePaths = orderedNodes
    .filter(node => node.nodeType === 'orpad.probe')
    .map(node => node.nodePath);
  const missingProbePaths = allProbePaths.filter(nodePath => !adapterProbePaths.has(nodePath));
  if (missingProbePaths.length) {
    diagnostics.push(diagnostic('error', 'AUTHORING_ADAPTER_PROBES_INCOMPLETE', 'machineAdapter.probeNodePaths must include every probe in the generated inline traversal so candidate discovery does not silently skip sub-graph probes.', {
      missingProbePaths,
      configuredProbeNodePaths: [...adapterProbePaths],
    }));
  }
  const entryWorkerCount = orderedNodes.filter(node => node.graphKey === 'main' && node.nodeType === 'orpad.workerLoop').length;
  if (adapter.workerNodePath && !Array.isArray(adapter.workerNodePaths) && entryWorkerCount > 1) {
    diagnostics.push(diagnostic('error', 'AUTHORING_WORKER_LOOP_CONTRACT_MISMATCH', 'Current managed-run adapter has a single workerNodePath, so generated entry graphs must not keep multiple workerLoop nodes.', { workerLoopCount: entryWorkerCount }));
  }
  const adapterConcurrency = adapter?.claimPolicy?.concurrency;
  if (adapter.workerNodePath && adapterConcurrency !== 1) {
    diagnostics.push(diagnostic('error', 'AUTHORING_WORKER_CONCURRENCY_UNSAFE', 'Generated live Machine adapters must default to serial worker claims until file-lock parallelism is explicitly authored and covered by lifecycle tests.', { configured: adapterConcurrency ?? null }));
  }
  const queueConcurrency = pipeline?.run?.queueProtocol?.claimPolicy?.concurrency;
  if (pipeline?.run?.queueProtocol && queueConcurrency !== 1) {
    diagnostics.push(diagnostic('error', 'AUTHORING_QUEUE_PROTOCOL_CONCURRENCY_UNSAFE', 'Generated queueProtocol.claimPolicy.concurrency must default to 1 so generated pipelines do not claim overlapping worker items in parallel.', { configured: queueConcurrency ?? null }));
  }
}

function auditDeclaredNodePackReferences(pipeline, graphSet, diagnostics) {
  const declared = new Set((Array.isArray(pipeline?.nodePacks) ? pipeline.nodePacks : [])
    .map(pack => String(pack?.id || '').trim())
    .filter(Boolean));
  const referenced = new Map();
  for (const graph of graphSet.graphs || []) {
    for (const node of graph.nodes || []) {
      const config = node.config || {};
      const values = [
        config.sourceNodePack,
        ...(Array.isArray(config.supportingNodePacks) ? config.supportingNodePacks : []),
      ].map(item => String(item || '').trim()).filter(Boolean);
      for (const value of values) {
        if (!referenced.has(value)) referenced.set(value, []);
        referenced.get(value).push({ graphRef: graph.graphRef, nodeId: node.id });
      }
    }
  }
  for (const [packId, locations] of referenced) {
    if (declared.has(packId)) continue;
    diagnostics.push(diagnostic('error', 'AUTHORING_NODE_PACK_REFERENCE_UNDECLARED', 'Graph nodes must not reference a node pack that is missing from pipeline.nodePacks.', {
      nodePackId: packId,
      locations,
    }));
  }
}

function auditContentEditorialContract(pipeline, graphSet, diagnostics) {
  if (!contentQualityContractApplies(pipeline)) return;
  const editorialGates = [];
  for (const graph of graphSet.graphs || []) {
    for (const node of graph.nodes || []) {
      if (gateIsEditorial(node) && gateAppearsBeforeArtifact(graph, node)) {
        editorialGates.push({
          graphRef: graph.graphRef,
          nodeId: nodeId(node),
          dimensions: editorialDimensionMatches(node),
          evaluationContract: editorialGateEvaluationContract(node),
        });
      }
    }
  }
  if (!editorialGates.length) {
    diagnostics.push(diagnostic('error', 'AUTHORING_CONTENT_EDITORIAL_GATE_MISSING', 'Content, docs, slide, tutorial, or learning-material pipelines must include a final editorial quality gate before artifact recording.', {
      nodePackId: CONTENT_QA_NODE_PACK_ID,
    }));
    return;
  }
  const strongest = editorialGates.reduce((best, item) => (
    item.dimensions.length > best.dimensions.length ? item : best
  ), editorialGates[0]);
  if (strongest.dimensions.length < 3) {
    diagnostics.push(diagnostic('error', 'AUTHORING_CONTENT_EDITORIAL_GATE_WEAK', 'The content editorial gate must explicitly check voice/tone, density/repetition, audience/role separation, and before/after editing evidence.', {
      nodePackId: CONTENT_QA_NODE_PACK_ID,
      gates: editorialGates,
    }));
  }
  const weakEvaluationContract = editorialGates.filter(gate => (
    gate.evaluationContract.evaluationMode !== 'content-editorial-quality'
    || !gate.evaluationContract.judgePolicyValid
    || !gate.evaluationContract.expectedEvaluationArtifacts.some(item => /artifacts\/evaluations\/content-editorial\/workers\//.test(item))
    || !gate.evaluationContract.llmJudgeConfigured
    || gate.evaluationContract.nodePackRubricCount === 0
  ));
  if (weakEvaluationContract.length) {
    diagnostics.push(diagnostic('error', 'AUTHORING_CONTENT_EDITORIAL_EVALUATOR_CONTRACT_WEAK', 'Content editorial gates must declare OrPAD-owned diff evaluation mode, judgePolicy, expected worker evaluation artifacts, judge artifacts when judgePolicy uses LLM, and node-pack rubric.', {
      nodePackId: CONTENT_QA_NODE_PACK_ID,
      gates: weakEvaluationContract,
    }));
  }
}

async function auditTreeFiles(graphSet, diagnostics) {
  for (const graph of graphSet.graphs || []) {
    for (const node of graph.nodes || []) {
      if (nodeType(node) !== 'orpad.tree') continue;
      const ref = String(node.config?.treeRef || '').trim();
      if (!ref) continue;
      const treePath = path.resolve(path.dirname(graph.graphPath), ref);
      const rel = path.relative(graphSet.pipelineDir, treePath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        diagnostics.push(diagnostic('error', 'AUTHORING_TREE_REF_ESCAPES_PIPELINE', 'Tree refs must stay inside the pipeline directory.', { graphRef: graph.graphRef, nodeId: node.id, ref }));
        continue;
      }
      let treeText = '';
      try {
        treeText = await fs.promises.readFile(treePath, 'utf8');
      } catch {
        diagnostics.push(diagnostic('error', 'AUTHORING_TREE_REF_UNMATERIALIZED', 'orpad.tree ref must resolve to a materialized tree file.', { graphRef: graph.graphRef, nodeId: node.id, ref }));
        continue;
      }
      try {
        const tree = JSON.parse(treeText);
        if (!tree.root) {
          diagnostics.push(diagnostic('error', 'AUTHORING_TREE_ROOT_MISSING', 'Tree files must define a root tick.', { treeRef: toPortable(rel) }));
        }
      } catch (err) {
        diagnostics.push(diagnostic('error', 'AUTHORING_TREE_JSON_INVALID', `Tree file must parse as JSON: ${err.message}`, { treeRef: toPortable(rel) }));
      }
      if (PLACEHOLDER_PATTERN.test(treeText)) {
        diagnostics.push(diagnostic('error', 'AUTHORING_TREE_PLACEHOLDER_LEFTOVER', 'Tree files must not contain TODO/placeholder scaffolding.', { treeRef: toPortable(rel) }));
      }
    }
  }
}

async function auditPlaceholderText(graphSet, diagnostics) {
  for (const graph of graphSet.graphs || []) {
    const text = await fs.promises.readFile(graph.graphPath, 'utf8');
    if (PLACEHOLDER_PATTERN.test(text)) {
      diagnostics.push(diagnostic('error', 'AUTHORING_GRAPH_PLACEHOLDER_LEFTOVER', 'Graph files must not contain TODO/placeholder scaffolding.', { graphRef: graph.graphRef }));
    }
  }
}

async function auditGeneratedPipelineQuality(pipelinePath, options = {}) {
  const diagnostics = [];
  const resolvedPipelinePath = path.resolve(String(pipelinePath || ''));
  let validation = null;
  try {
    validation = await validateRunbookFile(resolvedPipelinePath, { trustLevel: 'local-authored' });
    if (!validation.ok) {
      diagnostics.push(diagnostic('error', 'AUTHORING_VALIDATION_FAILED', 'Generated pipeline must validate without errors.', {
        errors: validation.diagnostics.filter(item => item.level === 'error').map(item => item.code),
      }));
    }
    if (!validation.canMachineExecuteStep) {
      diagnostics.push(diagnostic('error', 'AUTHORING_MACHINE_STEP_UNAVAILABLE', 'Generated pipeline must be machine-step executable.', {
        machineStepBlockedReasons: validation.machineStepBlockedReasons || [],
      }));
    }
  } catch (err) {
    diagnostics.push(diagnostic('error', 'AUTHORING_VALIDATION_EXCEPTION', `Generated pipeline validation threw: ${err.message}`));
  }

  let graphSet = null;
  let orderedNodes = [];
  try {
    graphSet = await loadPipelineGraphSet({ pipelinePath: resolvedPipelinePath });
    const plan = buildTraversalPlan(graphSet);
    orderedNodes = flattenTraversalNodes(plan);
    const pipeline = graphSet.pipeline || {};
    if (/[,;:\-]$/.test(String(pipeline.description || '').trim())) {
      diagnostics.push(diagnostic('error', 'AUTHORING_DESCRIPTION_TRUNCATED', 'Pipeline description must not end with dangling punctuation.', { description: pipeline.description || '' }));
    }
    if (pipeline.metadata?.graphComplexity?.isLinearChain === true) {
      diagnostics.push(diagnostic('error', 'AUTHORING_GRAPH_LINEAR_UNDERFIT', 'Generated graph must not be a flat linear chain for managed orchestration.', { graphComplexity: pipeline.metadata.graphComplexity }));
    }
    for (const graph of graphSet.graphs || []) {
      auditGraphRuntimeContracts(graph, graphSet, diagnostics);
      auditPatchReviewContracts(graph, diagnostics);
      auditQueueDrain(graph, diagnostics);
    }
    auditMachineAdapter(pipeline, orderedNodes, diagnostics);
    auditDeclaredNodePackReferences(pipeline, graphSet, diagnostics);
    auditContentEditorialContract(pipeline, graphSet, diagnostics);
    await auditTreeFiles(graphSet, diagnostics);
    await auditPlaceholderText(graphSet, diagnostics);
  } catch (err) {
    diagnostics.push(diagnostic('error', 'AUTHORING_GRAPHSET_AUDIT_FAILED', `Generated graph set failed quality audit: ${err.message}`, { code: err.code || '' }));
  }

  const errors = diagnostics.filter(item => item.level === 'error');
  return {
    ok: errors.length === 0,
    diagnostics,
    summary: {
      errorCount: errors.length,
      warningCount: diagnostics.filter(item => item.level === 'warning').length,
      validationOk: validation?.ok === true,
      canMachineExecuteStep: validation?.canMachineExecuteStep === true,
      graphCount: graphSet?.graphs?.length || 0,
      flattenedNodeCount: orderedNodes.length,
    },
    ...(options.includeValidation ? { validation } : {}),
  };
}

function assertGeneratedPipelineQuality(audit) {
  if (audit?.ok) return audit;
  const codes = (audit?.diagnostics || [])
    .filter(item => item.level === 'error')
    .map(item => item.code)
    .join(', ');
  const err = new Error(`Generated pipeline failed authoring quality audit: ${codes || 'unknown'}`);
  err.code = 'ORCHESTRATION_AUTHORING_QUALITY_FAILED';
  err.qualityAudit = audit;
  throw err;
}

module.exports = {
  auditGeneratedPipelineQuality,
  assertGeneratedPipelineQuality,
};
