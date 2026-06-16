const fs = require('fs');
const path = require('path');
const { validateRunbookFile } = require('../runbooks/validator');
const { loadPipelineGraphSet } = require('../orchestration-machine/graph-loader');
const { normalizeProvisionConfig } = require('../orchestration-machine/provision-node');
const { buildTraversalPlan, detectGraphCycles } = require('../orchestration-machine/traversal');

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
const PATCH_ACCEPT_CONDITIONS = new Set(['accepted', 'accept', 'pass', 'continue']);
const PATCH_REJECT_CONDITIONS = new Set(['rejected', 'reject', 'revise']);
const BARRIER_CONDITIONS = new Set(['pass', 'continue', 'partial', 'fail']);
const BARRIER_PARTIAL_FAILURE_POLICIES = new Set(['fail', 'continue-with-warning', 'block']);
const DECISION_TYPES = new Set(['orpad.selector', 'orpad.gate', 'orpad.patchReview', 'orpad.barrier']);
const PLACEHOLDER_PATTERN = /TODO\s*(?:\u2014|-)?\s*author|Placeholder created by generator|Placeholder leaf|TODO placeholder/i;
const REQUIRED_NODE_PACK_UNAVAILABLE_CODE = 'NODE_PACK_AUTHORING_REQUIRED_UNAVAILABLE';
const CONTENT_QA_NODE_PACK_ID = 'orpad.starter.content-qa';
const WORKER_RESULT_SCHEMA_VERSION = 'orpad.workerResult.v1';
const REQUIRED_ITEM_EVIDENCE_FIELDS = Object.freeze([
  'failingSymptom',
  'rootCause',
  'filesChanged',
  'verificationCommands',
  'residualRisk',
]);
const HARD_ITEM_EVIDENCE_ENFORCEMENT = 'hard-required-by-artifact-contract';
const CONTENT_GRAPH_INTENT_PATTERN = /\b(readme|docs?|documentation|markdown|content|tutorial|lesson|lecture|course|slides?|copy|localization|locale|onboarding|learning material|course material)\b|\uBB38\uC11C|\uAC15\uC758|\uC790\uB8CC|\uC2AC\uB77C\uC774\uB4DC|\uD559\uC2B5|\uAD50\uC721|\uC218\uC5C5|\uD29C\uD1A0\uB9AC\uC5BC|\uB9C8\uD06C\uB2E4\uC6B4|\uBC88\uC5ED|\uD604\uC9C0\uD654/i;
const FORK_JOIN_DISCOVERY_INTENT_PATTERN = /\bfork[-\s]?join\b|\bindependent probes?\b|\bparallel probes?\b|\bfork[-\s]?join discovery\b/i;
const EDITORIAL_GATE_PATTERN = /\b(editorial|voice|tone|style|density|readability|audience|duplicate|duplication|repetition|rewrite|polish|presentation|slide|role[-\s]?separat|human-authored|ai-sounding|model meta|over-explanation)\b/i;
const APPROVAL_GATE_IDENTITY_PATTERN = /\b(approval|approve|capabilit(?:y|ies)|permission|authoriz\w*|sandbox|isolated[-\s]?(?:repo[-\s]?)?execution|repo[-\s]?execution|execution[-\s]?approval|clone|network[-\s]?access|credential)\b/i;
const EXTERNAL_REPO_INTENT_PATTERN = /(https?:\/\/(?:www\.)?(?:github|gitlab|bitbucket)\.(?:com|org)\/[^\s'")]+|git@[\w.-]+:[\w./~-]+|\bgit\s+clone\b)/i;
const MEDIA_GENERATION_INTENT_PATTERN = /\b(sprite(?:s|sheet)?|sprite[-\s]?sheets?|spritesheets?|animation[-\s]?sheets?|animated[-\s]?sprites?|frames?|texture[-\s]?atlas|character[-\s]?sheets?|image[-\s]?generation|asset[-\s]?generation|generate\s+(?:an?\s+)?images?|create\s+(?:an?\s+)?images?|make\s+(?:an?\s+)?images?|render\s+(?:an?\s+)?images?|draw\s+(?:an?\s+)?images?|video|gif)\b|\uC2A4\uD504\uB77C\uC774\uD2B8|\uC560\uB2C8\uBA54\uC774\uC158|\uD504\uB808\uC784|\uC601\uC0C1|\uBE44\uB514\uC624|\uB80C\uB354|(?:\uC774\uBBF8\uC9C0\s*(?:\uC0DD\uC131|\uB9CC\uB4E4|\uADF8\uB9AC|\uD544\uC694))|(?:(?:\uC0DD\uC131|\uB9CC\uB4E4|\uADF8\uB9AC)\s*\uC774\uBBF8\uC9C0)/i;
const STANDARD_TIMEOUT_CAPS = Object.freeze({
  profile: 'standard',
  proposalTimeoutMs: 240000,
  workerTimeoutMs: 300000,
});
const MEDIA_GENERATION_TIMEOUT_CAPS = Object.freeze({
  profile: 'media-generation',
  proposalTimeoutMs: 600000,
  workerTimeoutMs: 1800000,
});
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

const SELECTOR_ALL_ROUTE_SENTINELS = new Set(['all', 'all-lanes', 'all-routes', '*']);

function normalizeSelectorRoute(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

function selectorFanoutAll(config = {}) {
  return SELECTOR_ALL_ROUTE_SENTINELS.has(normalizeSelectorRoute(config.fanout));
}

function nodeId(node) {
  return String(node?.id || '').trim();
}

function transitionCondition(edge) {
  return String(edge?.condition || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
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

// Approval identity must come from what the gate IS, not from criteria text —
// mirrors the generator's gateApprovalIdentityText so audit and escalation
// can never disagree about which gates are approval gates.
function nodeApprovalIdentityText(node) {
  const config = node?.config || {};
  return [
    node?.id,
    node?.label,
    config.summary,
    config.kind,
    config.gateKind,
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

function selectedNodePackIds(pipeline) {
  const selection = Array.isArray(pipeline?.metadata?.orchestrationAuthoring?.nodePackSelection)
    ? pipeline.metadata.orchestrationAuthoring.nodePackSelection
    : [];
  return [...new Set(selection
    .map(pack => String(pack?.id || '').trim())
    .filter(Boolean))];
}

function nodePackSelectionDiagnostics(pipeline) {
  return Array.isArray(pipeline?.metadata?.orchestrationAuthoring?.nodePackSelectionDiagnostics)
    ? pipeline.metadata.orchestrationAuthoring.nodePackSelectionDiagnostics
    : [];
}

function auditRequiredNodePackSelectionDiagnostics(pipeline, diagnostics) {
  const requiredUnavailable = nodePackSelectionDiagnostics(pipeline)
    .filter(item => item?.code === REQUIRED_NODE_PACK_UNAVAILABLE_CODE);
  for (const item of requiredUnavailable) {
    const packId = String(item.packId || item.nodePackId || '').trim();
    diagnostics.push(diagnostic(
      'error',
      REQUIRED_NODE_PACK_UNAVAILABLE_CODE,
      packId
        ? `Required Package ${packId} was not available or eligible for Generate authoring.`
        : 'A required Package was not available or eligible for Generate authoring.',
      {
        ...(packId ? { packId } : {}),
        selectionDiagnostic: item,
      },
    ));
  }
}

function nodePackReferenceIds(node) {
  const config = node?.config || {};
  return [...new Set([
    config.sourceNodePack,
    ...(Array.isArray(config.supportingNodePacks) ? config.supportingNodePacks : []),
  ].map(item => String(item || '').trim()).filter(Boolean))];
}

function nodeReferencesPack(node, packId) {
  return nodePackReferenceIds(node).includes(String(packId || '').trim());
}

function nodeLocation(graph, node) {
  return { graphRef: graph.graphRef, nodeId: node.id, nodeType: nodeType(node) };
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.map(item => String(item || '').trim()).filter(Boolean)
    : [];
}

function artifactContractNodes(graphSet) {
  const out = [];
  for (const graph of graphSet.graphs || []) {
    for (const node of graph.nodes || []) {
      if (nodeType(node) === 'orpad.artifactContract') out.push({ graph, node });
    }
  }
  return out;
}

function itemEvidenceContractForNode(node) {
  const contract = node?.config?.itemEvidenceContract;
  return contract && typeof contract === 'object' && !Array.isArray(contract) ? contract : null;
}

function auditItemEvidenceContracts(graphSet, diagnostics) {
  const artifactNodes = artifactContractNodes(graphSet);
  const hasWorkerLoop = (graphSet.graphs || [])
    .some(graph => (graph.nodes || []).some(node => nodeType(node) === 'orpad.workerLoop'));
  if (!artifactNodes.length && hasWorkerLoop) {
    diagnostics.push(diagnostic(
      'error',
      'AUTHORING_ITEM_EVIDENCE_CONTRACT_MISSING',
      'Pipelines with workerLoop nodes must include an artifactContract with config.itemEvidenceContract.',
    ));
    return;
  }
  for (const { graph, node } of artifactNodes) {
    const contract = itemEvidenceContractForNode(node);
    if (!contract) {
      diagnostics.push(diagnostic(
        'error',
        'AUTHORING_ITEM_EVIDENCE_CONTRACT_MISSING',
        'artifactContract nodes must declare config.itemEvidenceContract for completed worker task evidence.',
        nodeLocation(graph, node),
      ));
      continue;
    }
    const requiredPerCompletedTask = stringArray(contract.requiredPerCompletedTask);
    const missing = REQUIRED_ITEM_EVIDENCE_FIELDS.filter(field => !requiredPerCompletedTask.includes(field));
    if (missing.length) {
      diagnostics.push(diagnostic(
        'error',
        'AUTHORING_ITEM_EVIDENCE_CONTRACT_REQUIRED_FIELDS_MISSING',
        'artifactContract config.itemEvidenceContract.requiredPerCompletedTask must hard-require completed task evidence fields.',
        {
          ...nodeLocation(graph, node),
          missingFields: missing,
          requiredFields: REQUIRED_ITEM_EVIDENCE_FIELDS,
        },
      ));
    }
    if (String(contract.enforcement || '').trim() !== HARD_ITEM_EVIDENCE_ENFORCEMENT) {
      diagnostics.push(diagnostic(
        'error',
        'AUTHORING_ITEM_EVIDENCE_CONTRACT_ENFORCEMENT_WEAK',
        'artifactContract config.itemEvidenceContract.enforcement must mark per-task evidence as hard-required by the artifact contract.',
        {
          ...nodeLocation(graph, node),
          enforcement: contract.enforcement ?? null,
          expected: HARD_ITEM_EVIDENCE_ENFORCEMENT,
        },
      ));
    }
    if (String(contract.workerResultSchema || '').trim() !== WORKER_RESULT_SCHEMA_VERSION) {
      diagnostics.push(diagnostic(
        'error',
        'AUTHORING_ITEM_EVIDENCE_CONTRACT_SCHEMA_MISMATCH',
        'artifactContract config.itemEvidenceContract.workerResultSchema must match the managed worker result schema.',
        {
          ...nodeLocation(graph, node),
          workerResultSchema: contract.workerResultSchema ?? null,
          expected: WORKER_RESULT_SCHEMA_VERSION,
        },
      ));
    }
  }

  if (!artifactNodes.length) return;
  const acceptableRefs = new Set([
    'orpad.artifactContract.itemEvidenceContract',
    ...artifactNodes.map(({ node }) => `${node.id}.itemEvidenceContract`),
  ]);
  const artifactRequiredFields = new Set(REQUIRED_ITEM_EVIDENCE_FIELDS);
  for (const graph of graphSet.graphs || []) {
    for (const node of graph.nodes || []) {
      if (nodeType(node) !== 'orpad.workerLoop') continue;
      const config = node.config || {};
      const workerFields = stringArray(config.requiredResultFields);
      const missing = REQUIRED_ITEM_EVIDENCE_FIELDS.filter(field => !workerFields.includes(field));
      const evidenceContractRef = String(config.evidenceContractRef || '').trim();
      if (
        String(config.resultSchema || '').trim() !== WORKER_RESULT_SCHEMA_VERSION
        || !acceptableRefs.has(evidenceContractRef)
        || missing.some(field => artifactRequiredFields.has(field))
      ) {
        diagnostics.push(diagnostic(
          'error',
          'AUTHORING_WORKER_EVIDENCE_CONTRACT_MISMATCH',
          'workerLoop output schema and requiredResultFields must match artifactContract itemEvidenceContract.',
          {
            ...nodeLocation(graph, node),
            resultSchema: config.resultSchema ?? null,
            expectedResultSchema: WORKER_RESULT_SCHEMA_VERSION,
            evidenceContractRef: evidenceContractRef || null,
            acceptedEvidenceContractRefs: [...acceptableRefs],
            missingFields: missing,
          },
        ));
      }
    }
  }
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
    pipeline?.metadata?.orchestrationAuthoring?.authoringNotes,
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
      const onPartialFailure = String(config.onPartialFailure || 'continue-with-warning').trim();
      if (!BARRIER_PARTIAL_FAILURE_POLICIES.has(onPartialFailure)) {
        diagnostics.push(diagnostic('error', 'AUTHORING_BARRIER_ON_PARTIAL_FAILURE_UNSUPPORTED', 'Barrier config.onPartialFailure must be one of fail, continue-with-warning, or block.', { graphRef: graph.graphRef, nodeId: id, onPartialFailure }));
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
      if (config.criteriaAutoFilled === true) {
        diagnostics.push(diagnostic('warning', 'AUTHORING_GATE_CRITERIA_AUTOFILLED', 'Gate shipped with machine-backfilled generic criteria; it can verify queue plumbing but not task quality. Author task-specific criteria on this gate.', { graphRef: graph.graphRef, nodeId: id, label: node.label || '' }));
      }
      const gateIndex = (graph.nodes || []).indexOf(node);
      const firstWorkerIndex = (graph.nodes || []).findIndex(item => nodeType(item) === 'orpad.workerLoop');
      const runsBeforeWorker = firstWorkerIndex < 0 || gateIndex < firstWorkerIndex;
      if (
        runsBeforeWorker
        && APPROVAL_GATE_IDENTITY_PATTERN.test(nodeApprovalIdentityText(node))
        && config.advisory !== true
        && config.auditOnly !== true
        && String(config.onFail || '') !== 'block'
      ) {
        diagnostics.push(diagnostic('warning', 'AUTHORING_APPROVAL_GATE_NOT_BLOCKING', 'Pre-execution approval/capability gates should use onFail block so a missing core capability stops the run instead of warn-passing into execution.', { graphRef: graph.graphRef, nodeId: id, onFail: String(config.onFail || '') }));
      }
    }

    if (type === 'orpad.provision') {
      // Static check shares the machine's normalizer so authoring and runtime
      // can never disagree about what a valid provision step is.
      const { problems } = normalizeProvisionConfig(config);
      for (const problem of problems) {
        diagnostics.push(diagnostic('error', 'AUTHORING_PROVISION_CONFIG_INVALID', `Provision node config must be executable as authored: ${problem.message}`, {
          graphRef: graph.graphRef,
          nodeId: id,
          problemCode: problem.code,
          ...(problem.stepIndex !== undefined ? { stepIndex: problem.stepIndex } : {}),
        }));
      }
      const provisionIndex = (graph.nodes || []).indexOf(node);
      const firstWorkerIndex = (graph.nodes || []).findIndex(item => nodeType(item) === 'orpad.workerLoop');
      if (firstWorkerIndex >= 0 && provisionIndex > firstWorkerIndex) {
        diagnostics.push(diagnostic('warning', 'AUTHORING_PROVISION_AFTER_WORKER', 'Provision nodes should run before worker fan-out so provisioned checkouts exist when work items execute.', { graphRef: graph.graphRef, nodeId: id }));
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

  const outgoingByDecisionCondition = new Map();
  for (const edge of graph.transitions || []) {
    const source = nodeById.get(String(edge.from || ''));
    const sourceType = nodeType(source);
    const condition = transitionCondition(edge);
    if (!condition || !DECISION_TYPES.has(sourceType)) continue;
    const key = `${edge.from}\u0000${condition}`;
    if (!outgoingByDecisionCondition.has(key)) {
      outgoingByDecisionCondition.set(key, {
        condition,
        edges: [],
        nodeId: edge.from,
        sourceType,
        targets: new Set(),
      });
    }
    const group = outgoingByDecisionCondition.get(key);
    group.edges.push(edge);
    group.targets.add(String(edge.to || ''));
  }
  for (const group of outgoingByDecisionCondition.values()) {
    if (group.targets.size <= 1) continue;
    diagnostics.push(diagnostic(
      'error',
      'AUTHORING_DECISION_CONDITION_AMBIGUOUS',
      'Decision-emitting nodes must not route the same condition to multiple targets.',
      {
        graphRef: graph.graphRef,
        nodeId: group.nodeId,
        sourceType: group.sourceType,
        condition: group.condition,
        targets: [...group.targets].filter(Boolean),
        transitionIds: group.edges.map(edge => String(edge.id || '')).filter(Boolean),
      },
    ));
  }
}

function auditPatchReviewContracts(graph, diagnostics) {
  const nodeById = new Map((graph.nodes || []).map(node => [nodeId(node), node]));
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
    const rejectedEdges = outgoing.filter(edge => transitionCondition(edge) === 'rejected');
    for (const edge of rejectedEdges) {
      const target = nodeById.get(String(edge.to || ''));
      if (patchReviewRejectedTargetRepairsWork(node, target, graph, nodeById)) continue;
      diagnostics.push(diagnostic(
        'error',
        'AUTHORING_PATCH_REVIEW_REJECT_TARGET_UNSAFE',
        'patchReview rejected branches must route back to a worker repair loop instead of artifact, exit, or non-repair flow.',
        {
          graphRef: graph.graphRef,
          nodeId: node.id,
          targetId: edge.to || null,
          targetType: nodeType(target) || null,
          acceptedTargets: [
            'orpad.workerLoop',
            'config.repairWorkerRef',
            'config.repairTargetRefs',
            'config.patchRevisionLoopRefs',
          ],
        },
      ));
    }
  }
}

function patchReviewRepairTargetRefs(node) {
  const config = node?.config || {};
  return new Set([
    config.repairWorkerRef,
    config.rejectedTargetRef,
    config.patchRevisionLoopRef,
    ...(Array.isArray(config.repairWorkerRefs) ? config.repairWorkerRefs : []),
    ...(Array.isArray(config.repairTargetRefs) ? config.repairTargetRefs : []),
    ...(Array.isArray(config.patchRevisionLoopRefs) ? config.patchRevisionLoopRefs : []),
  ].map(item => String(item || '').trim()).filter(Boolean));
}

function targetCanReachWorkerLoop(target, graph, nodeById) {
  const terminalTypes = new Set(['orpad.artifactContract', 'orpad.exit']);
  const queue = [nodeId(target)];
  const seen = new Set();
  while (queue.length) {
    const currentId = queue.shift();
    if (!currentId || seen.has(currentId)) continue;
    seen.add(currentId);
    const current = nodeById.get(currentId);
    const type = nodeType(current);
    if (type === 'orpad.workerLoop') return true;
    if (terminalTypes.has(type)) continue;
    for (const edge of graph.transitions || []) {
      if (String(edge.from || '') === currentId) queue.push(String(edge.to || ''));
    }
  }
  return false;
}

function patchReviewRejectedTargetRepairsWork(reviewNode, target, graph, nodeById) {
  if (!target) return false;
  if (nodeType(target) === 'orpad.workerLoop') return true;
  const targetId = nodeId(target);
  if (!targetId || !patchReviewRepairTargetRefs(reviewNode).has(targetId)) return false;
  return targetCanReachWorkerLoop(target, graph, nodeById);
}

function patchReviewAcceptedCondition(condition) {
  return PATCH_ACCEPT_CONDITIONS.has(transitionCondition({ condition }));
}

function patchReviewRejectedCondition(condition) {
  return PATCH_REJECT_CONDITIONS.has(transitionCondition({ condition }));
}

function analyzeGraphComplexity(nodes, transitions) {
  const graphNodes = Array.isArray(nodes) ? nodes : [];
  const graphTransitions = Array.isArray(transitions) ? transitions : [];
  const nodeIds = graphNodes.map(node => nodeId(node));
  const nodeIndex = new Map(nodeIds.map((id, index) => [id, index]));
  const nodeById = new Map(graphNodes.map((node, index) => [nodeIds[index], node]));
  const typesSet = new Set(graphNodes.map(node => nodeType(node)).filter(Boolean));
  const outDegree = new Map();
  const outgoingByNode = new Map();
  for (const transition of graphTransitions) {
    const from = String(transition?.from || '').trim();
    if (!from) continue;
    outDegree.set(from, (outDegree.get(from) || 0) + 1);
    if (!outgoingByNode.has(from)) outgoingByNode.set(from, []);
    outgoingByNode.get(from).push(transition);
  }

  const branchNodes = graphNodes.filter(node => (outDegree.get(nodeId(node)) || 0) > 1);
  const loopBackCount = graphTransitions.filter(transition => {
    const fromIdx = nodeIndex.get(String(transition?.from || '').trim());
    const toIdx = nodeIndex.get(String(transition?.to || '').trim());
    return typeof fromIdx === 'number' && typeof toIdx === 'number' && toIdx <= fromIdx;
  }).length;
  const subGraphCount = graphNodes.filter(node => ['orpad.graph', 'orpad.tree'].includes(nodeType(node))).length;
  const barrierCount = graphNodes.filter(node => nodeType(node) === 'orpad.barrier').length;
  const gateCount = graphNodes.filter(node => nodeType(node) === 'orpad.gate').length;
  const selectorCount = graphNodes.filter(node => nodeType(node) === 'orpad.selector').length;
  const workerLoopCount = graphNodes.filter(node => nodeType(node) === 'orpad.workerLoop').length;
  const workQueueCount = graphNodes.filter(node => nodeType(node) === 'orpad.workQueue').length;
  const dispatcherCount = graphNodes.filter(node => nodeType(node) === 'orpad.dispatcher').length;
  const patchReviewNodes = graphNodes.filter(node => nodeType(node) === 'orpad.patchReview');
  const patchReviewCount = patchReviewNodes.length;

  const drainTargets = new Set(
    graphNodes
      .filter(node => ['orpad.dispatcher', 'orpad.triage', 'orpad.workQueue'].includes(nodeType(node)))
      .map(node => nodeId(node)),
  );
  const hasQueueDrainLoop = graphTransitions.some(transition => {
    const fromNode = nodeById.get(String(transition?.from || '').trim());
    return nodeType(fromNode) === 'orpad.gate' && drainTargets.has(String(transition?.to || '').trim());
  });

  const patchReviewsWithRejectLoop = patchReviewNodes.filter(node => {
    const outgoing = outgoingByNode.get(nodeId(node)) || [];
    return outgoing.some(transition => patchReviewAcceptedCondition(transitionCondition(transition)))
      && outgoing.some(transition => (
        patchReviewRejectedCondition(transitionCondition(transition))
        && patchReviewRejectedTargetRepairsWork(
          node,
          nodeById.get(String(transition?.to || '').trim()),
          { transitions: graphTransitions },
          nodeById,
        )
      ));
  });
  const patchReviewsLackingRejectLoop = patchReviewNodes.filter(node => !patchReviewsWithRejectLoop.includes(node));

  const selectorsConvergingImmediately = graphNodes
    .filter(node => nodeType(node) === 'orpad.selector')
    .filter(node => !selectorFanoutAll(node.config))
    .filter(node => {
      const out = outgoingByNode.get(nodeId(node)) || [];
      if (out.length < 2) return false;
      const downstreamTargets = out.map(transition => {
        const nextOut = outgoingByNode.get(String(transition?.to || '').trim()) || [];
        return nextOut.length === 1 ? String(nextOut[0]?.to || '').trim() : String(transition?.to || '').trim();
      });
      return new Set(downstreamTargets).size === 1;
    })
    .map(node => nodeId(node));

  const patternsDetected = [];
  if (loopBackCount > 0) patternsDetected.push('ralph-loop');
  if (barrierCount > 0 || (selectorCount > 0 && workerLoopCount > 1)) patternsDetected.push('fork-join');
  if (gateCount >= 2 || (gateCount >= 1 && loopBackCount > 0)) patternsDetected.push('cross-validation');
  if (subGraphCount > 0) patternsDetected.push('subgraph-composition');
  if (workerLoopCount > 1) patternsDetected.push('multi-worker');
  if (hasQueueDrainLoop) patternsDetected.push('queue-drain-loop');
  if (patchReviewsWithRejectLoop.length > 0) patternsDetected.push('patch-review-reject-loop');

  const branchPointCount = branchNodes.length;
  const isLinearChain = (
    graphNodes.length > 0
    && branchPointCount === 0
    && loopBackCount === 0
    && subGraphCount === 0
    && barrierCount === 0
    && selectorCount === 0
  );

  const warnings = [];
  if (isLinearChain) {
    warnings.push('Generated graph is a flat linear chain. If the user request involves iteration, parallel sub-scopes, verification, retrieval, hierarchy, or multi-agent reasoning, the pipeline likely under-fits the task.');
  }
  if (workQueueCount > 0 && dispatcherCount > 0 && !hasQueueDrainLoop) {
    warnings.push('Pipeline has a workQueue + dispatcher chain but no outer queue-drain loop.');
  }
  if (patchReviewsLackingRejectLoop.length > 0) {
    warnings.push(`patchReview node(s) ${patchReviewsLackingRejectLoop.map(node => nodeId(node)).join(', ')} lack an accepted branch plus a rejected branch that routes back to worker repair.`);
  }
  if (selectorsConvergingImmediately.length > 0) {
    warnings.push(`Selector node(s) ${selectorsConvergingImmediately.join(', ')} have multiple outgoing transitions that converge into the same downstream node.`);
  }

  return {
    nodeCount: graphNodes.length,
    uniqueNodeTypes: typesSet.size,
    branchPointCount,
    loopBackCount,
    subGraphCount,
    barrierCount,
    gateCount,
    selectorCount,
    workerLoopCount,
    workQueueCount,
    dispatcherCount,
    patchReviewCount,
    hasQueueDrainLoop,
    patternsDetected,
    isLinearChain,
    ...(warnings.length ? { warnings } : {}),
    ...(isLinearChain ? { simplicityWarning: warnings[0] } : {}),
  };
}

function analyzeGraphSetComplexity(graphSet) {
  const graphs = Array.isArray(graphSet?.graphs) ? graphSet.graphs : [];
  const graphAnalyses = graphs.map(graph => ({
    graphRef: graph.graphRef,
    ...analyzeGraphComplexity(graph.nodes || [], graph.transitions || []),
  }));
  const typeSet = new Set();
  for (const graph of graphs) {
    for (const node of graph.nodes || []) {
      const type = nodeType(node);
      if (type) typeSet.add(type);
    }
  }
  const sum = key => graphAnalyses.reduce((total, item) => total + (Number(item[key]) || 0), 0);
  const patternsDetected = [...new Set(graphAnalyses.flatMap(item => item.patternsDetected || []))];
  const warnings = graphAnalyses.flatMap(item => (
    Array.isArray(item.warnings)
      ? item.warnings.map(message => `${item.graphRef || 'graph'}: ${message}`)
      : []
  ));
  const linearGraphRefs = graphAnalyses
    .filter(item => item.isLinearChain)
    .map(item => item.graphRef)
    .filter(Boolean);
  const isLinearChain = graphAnalyses.length > 0 && graphAnalyses.every(item => item.isLinearChain);

  return {
    nodeCount: sum('nodeCount'),
    uniqueNodeTypes: typeSet.size,
    branchPointCount: sum('branchPointCount'),
    loopBackCount: sum('loopBackCount'),
    subGraphCount: sum('subGraphCount'),
    barrierCount: sum('barrierCount'),
    gateCount: sum('gateCount'),
    selectorCount: sum('selectorCount'),
    workerLoopCount: sum('workerLoopCount'),
    workQueueCount: sum('workQueueCount'),
    dispatcherCount: sum('dispatcherCount'),
    patchReviewCount: sum('patchReviewCount'),
    hasQueueDrainLoop: graphAnalyses.some(item => item.hasQueueDrainLoop),
    patternsDetected,
    isLinearChain,
    graphCount: graphAnalyses.length,
    linearGraphRefs,
    ...(warnings.length ? { warnings } : {}),
    ...(isLinearChain && warnings.length ? { simplicityWarning: warnings[0] } : {}),
  };
}

function auditGraphComplexity(pipeline, graphSet, diagnostics) {
  const graphComplexity = analyzeGraphSetComplexity(graphSet);
  if (graphComplexity.isLinearChain) {
    diagnostics.push(diagnostic(
      'error',
      'AUTHORING_GRAPH_LINEAR_UNDERFIT',
      'Generated graph must not be a flat linear chain for managed orchestration.',
      {
        graphComplexity,
        metadataGraphComplexity: pipeline?.metadata?.graphComplexity || null,
      },
    ));
  }
  return graphComplexity;
}

// Catch tangled (non-clean-loop-back) cycles at AUTHORING time. The Machine rejects
// these at run start (MACHINE_GRAPH_TANGLED_CYCLE) via the same detector; surfacing it
// in the quality audit fails generation early (which triggers the deterministic fallback)
// instead of letting a doomed pipeline reach the run.
function auditGraphTangledCycles(graph, diagnostics) {
  const cycles = detectGraphCycles(graph.nodes || [], graph.transitions || []);
  if (cycles.tangledCycleNodeIds && cycles.tangledCycleNodeIds.length) {
    diagnostics.push(diagnostic('error', 'AUTHORING_GRAPH_TANGLED_CYCLE', 'Generated graph contains a tangled (non-clean-loop-back) cycle the Machine rejects at run start.', {
      graphRef: graph.graphRef,
      tangledNodeIds: cycles.tangledCycleNodeIds,
    }));
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

function auditRequestedForkJoinDiscovery(pipeline, graphSet, diagnostics) {
  if (!FORK_JOIN_DISCOVERY_INTENT_PATTERN.test(pipelineIntentText(pipeline))) return;
  const barriers = [];
  const probes = [];
  for (const graph of graphSet.graphs || []) {
    for (const node of graph.nodes || []) {
      if (nodeType(node) === 'orpad.barrier') barriers.push({ graph, node });
      if (nodeType(node) === 'orpad.probe') probes.push({ graph, node });
    }
  }
  const discoveryBarrier = barriers.find(({ node }) => (
    Array.isArray(node.config?.waitFor) && node.config.waitFor.length >= 2
  ));
  if (!discoveryBarrier || probes.length < 2) {
    diagnostics.push(diagnostic(
      'error',
      'AUTHORING_REQUESTED_FORK_JOIN_MISSING',
      'The task explicitly requested fork-join or independent probes, so the generated graph must include at least two probe branches joined by a barrier.',
      {
        barrierCount: barriers.length,
        probeCount: probes.length,
        requestedBy: 'pipeline intent text',
      },
    ));
  }
}

function timeoutCapsForPipeline(pipeline = {}) {
  const adapter = pipeline?.run?.machineAdapter || {};
  const explicitProfile = String(
    adapter.timeoutProfile
      || pipeline?.metadata?.orchestrationAuthoring?.timeoutProfile?.id
      || '',
  ).trim().toLowerCase();
  const taskText = [
    pipeline?.metadata?.orchestrationAuthoring?.taskText,
    pipeline?.title,
    pipeline?.description,
  ].map(value => String(value || '')).join(' ');
  if (explicitProfile === MEDIA_GENERATION_TIMEOUT_CAPS.profile
    || MEDIA_GENERATION_INTENT_PATTERN.test(taskText)) {
    return MEDIA_GENERATION_TIMEOUT_CAPS;
  }
  return STANDARD_TIMEOUT_CAPS;
}

function auditExternalRepoProvision(pipeline, graphSet, diagnostics) {
  // Workers execute in a write-set-sliced overlay with no clone capability:
  // a task that targets an external repository can only progress when an
  // orpad.provision node brings the checkout into the canonical workspace
  // before fan-out (SpriteGenTest runs blocked exactly here).
  const taskText = [
    pipeline?.metadata?.orchestrationAuthoring?.taskText,
    pipeline?.title,
    pipeline?.description,
  ].map(value => String(value || '')).join(' ');
  const match = taskText.match(EXTERNAL_REPO_INTENT_PATTERN);
  if (!match) return;
  const hasProvision = (graphSet.graphs || []).some(graph =>
    (graph.nodes || []).some(node => nodeType(node) === 'orpad.provision'));
  if (hasProvision) return;
  diagnostics.push(diagnostic('warning', 'AUTHORING_PROVISION_MISSING', 'Task text references an external repository but no orpad.provision node exists; workers cannot clone from their sliced overlay, so the run will block on a missing checkout.', {
    matchedReference: match[0].slice(0, 200),
  }));
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
  const adapterMaxClaims = adapter?.claimPolicy?.maxClaims
    ?? adapter?.claimPolicy?.claimLimit
    ?? adapter?.workerClaimLimit
    ?? adapter?.maxWorkerClaims
    ?? adapter?.claimLimit;
  if (adapter.workerNodePath && Number(adapterMaxClaims) !== 1) {
    diagnostics.push(diagnostic('error', 'AUTHORING_WORKER_CLAIM_LIMIT_UNBOUNDED', 'Generated live Machine adapters must default to one worker claim per scheduler visit so broad UI/reference runs cannot expand into long-running queue drains.', { configured: adapterMaxClaims ?? null }));
  }
  const adapterLoopBackLimit = adapter?.loopBackRedriveLimit
    ?? adapter?.maxLoopBackRedrives
    ?? adapter?.schedulerLoopBackRedriveLimit;
  if (adapter.workerNodePath && Number(adapterLoopBackLimit) !== 1) {
    diagnostics.push(diagnostic('error', 'AUTHORING_LOOPBACK_REDRIVE_UNBOUNDED', 'Generated live Machine adapters must cap loop-back redrives at one so failed verification or queue-drain loops end as partial/blocked instead of running indefinitely.', { configured: adapterLoopBackLimit ?? null }));
  }
  const adapterProcessUntil = Array.isArray(adapter?.processUntil)
    ? adapter.processUntil
    : (Array.isArray(adapter?.claimPolicy?.processUntil) ? adapter.claimPolicy.processUntil : []);
  if (adapter.workerNodePath && !adapterProcessUntil.includes('verification-blocked')) {
    diagnostics.push(diagnostic('error', 'AUTHORING_PROCESS_UNTIL_VERIFICATION_BLOCKED_MISSING', 'Generated live Machine adapters must carry processUntil=verification-blocked into the adapter config, not only queueProtocol metadata.', { configured: adapterProcessUntil }));
  }
  const timeoutCaps = timeoutCapsForPipeline(pipeline);
  const proposalTimeoutMs = Number(adapter?.proposalTimeoutMs);
  if (adapter.workerNodePath && (!Number.isFinite(proposalTimeoutMs) || proposalTimeoutMs > timeoutCaps.proposalTimeoutMs)) {
    diagnostics.push(diagnostic('error', 'AUTHORING_PROPOSAL_TIMEOUT_UNBOUNDED', 'Generated live Machine adapters must cap proposal discovery according to the task timeout profile so small managed runs fail fast while media-generation runs have enough discovery time.', {
      configured: adapter?.proposalTimeoutMs ?? null,
      profile: timeoutCaps.profile,
      maxAllowedMs: timeoutCaps.proposalTimeoutMs,
    }));
  }
  const workerTimeoutMs = Number(adapter?.workerTimeoutMs);
  if (adapter.workerNodePath && (!Number.isFinite(workerTimeoutMs) || workerTimeoutMs > timeoutCaps.workerTimeoutMs)) {
    diagnostics.push(diagnostic('error', 'AUTHORING_WORKER_TIMEOUT_UNBOUNDED', 'Generated live Machine adapters must cap individual workers according to the task timeout profile; larger work should split or hand off instead of running without bounds.', {
      configured: adapter?.workerTimeoutMs ?? null,
      profile: timeoutCaps.profile,
      maxAllowedMs: timeoutCaps.workerTimeoutMs,
    }));
  }
  const queueConcurrency = pipeline?.run?.queueProtocol?.claimPolicy?.concurrency;
  if (pipeline?.run?.queueProtocol && queueConcurrency !== 1) {
    diagnostics.push(diagnostic('error', 'AUTHORING_QUEUE_PROTOCOL_CONCURRENCY_UNSAFE', 'Generated queueProtocol.claimPolicy.concurrency must default to 1 so generated pipelines do not claim overlapping worker items in parallel.', { configured: queueConcurrency ?? null }));
  }
  const queueMaxClaims = pipeline?.run?.queueProtocol?.claimPolicy?.maxClaims
    ?? pipeline?.run?.queueProtocol?.claimPolicy?.claimLimit;
  if (pipeline?.run?.queueProtocol && Number(queueMaxClaims) !== 1) {
    diagnostics.push(diagnostic('error', 'AUTHORING_QUEUE_PROTOCOL_CLAIM_LIMIT_UNBOUNDED', 'Generated queueProtocol.claimPolicy must cap worker claims at one so the runtime can inherit bounded queue-drain behavior.', { configured: queueMaxClaims ?? null }));
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
      for (const value of nodePackReferenceIds({ config })) {
        if (!referenced.has(value)) referenced.set(value, []);
        referenced.get(value).push({ graphRef: graph.graphRef, nodeId: node.id });
      }
    }
  }
  for (const [packId, locations] of referenced) {
    if (declared.has(packId)) continue;
    diagnostics.push(diagnostic('error', 'AUTHORING_NODE_PACK_REFERENCE_UNDECLARED', 'Graph nodes must not reference a Package that is missing from pipeline.nodePacks.', {
      nodePackId: packId,
      locations,
    }));
  }
}

function graphVerificationGateNodes(graph) {
  const nodes = graph.nodes || [];
  const artifactIndex = nodes.findIndex(node => nodeType(node) === 'orpad.artifactContract');
  const beforeArtifactLimit = artifactIndex >= 0 ? artifactIndex : nodes.length;
  const gatesBeforeArtifact = nodes.filter((node, index) => (
    nodeType(node) === 'orpad.gate'
    && index < beforeArtifactLimit
  ));
  if (gatesBeforeArtifact.length) return [gatesBeforeArtifact[gatesBeforeArtifact.length - 1]];
  return nodes.filter(node => nodeType(node) === 'orpad.gate');
}

function collectProvenanceSurfaceNodes(graphSet, surfaceType) {
  const out = [];
  for (const graph of graphSet.graphs || []) {
    const nodes = surfaceType === 'verification-gate'
      ? graphVerificationGateNodes(graph)
      : (graph.nodes || []).filter(node => nodeType(node) === surfaceType);
    for (const node of nodes) out.push({ graph, node });
  }
  return out;
}

function auditSelectedNodePackProvenance(pipeline, graphSet, diagnostics) {
  const selectedIds = selectedNodePackIds(pipeline);
  if (!selectedIds.length) return;
  const declared = new Set((Array.isArray(pipeline?.nodePacks) ? pipeline.nodePacks : [])
    .map(pack => String(pack?.id || '').trim())
    .filter(Boolean));
  for (const packId of selectedIds) {
    if (!declared.has(packId)) {
      diagnostics.push(diagnostic('error', 'AUTHORING_NODE_PACK_SELECTION_UNDECLARED', 'Selected packages must be declared in pipeline.nodePacks.', {
        nodePackId: packId,
      }));
    }
  }

  const surfaces = [
    { key: 'context', type: 'orpad.context' },
    { key: 'probe', type: 'orpad.probe' },
    { key: 'verification-gate', type: 'verification-gate' },
    { key: 'worker', type: 'orpad.workerLoop' },
    { key: 'artifact', type: 'orpad.artifactContract' },
  ];
  for (const surface of surfaces) {
    const entries = collectProvenanceSurfaceNodes(graphSet, surface.type);
    for (const packId of selectedIds) {
      const matching = entries.filter(({ node }) => nodeReferencesPack(node, packId));
      if (matching.length) continue;
      diagnostics.push(diagnostic('error', 'AUTHORING_NODE_PACK_PROVENANCE_MISSING', 'Selected packages must be represented on context, probe, verification gate, worker, and artifact metadata.', {
        nodePackId: packId,
        surface: surface.key,
        expectedFields: ['config.sourceNodePack', 'config.supportingNodePacks'],
        inspectedLocations: entries.map(({ graph, node }) => nodeLocation(graph, node)),
      }));
    }
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
    validation = await validateRunbookFile(resolvedPipelinePath, {
      ...options,
      trustLevel: options.trustLevel || 'local-authored',
    });
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
  let graphComplexity = null;
  try {
    graphSet = await loadPipelineGraphSet({ pipelinePath: resolvedPipelinePath });
    const plan = buildTraversalPlan(graphSet);
    orderedNodes = flattenTraversalNodes(plan);
    const pipeline = graphSet.pipeline || {};
    auditRequiredNodePackSelectionDiagnostics(pipeline, diagnostics);
    if (/[,;:\-]$/.test(String(pipeline.description || '').trim())) {
      diagnostics.push(diagnostic('error', 'AUTHORING_DESCRIPTION_TRUNCATED', 'Pipeline description must not end with dangling punctuation.', { description: pipeline.description || '' }));
    }
    graphComplexity = auditGraphComplexity(pipeline, graphSet, diagnostics);
    for (const graph of graphSet.graphs || []) {
      auditGraphRuntimeContracts(graph, graphSet, diagnostics);
      auditPatchReviewContracts(graph, diagnostics);
      auditQueueDrain(graph, diagnostics);
      auditGraphTangledCycles(graph, diagnostics);
    }
    auditRequestedForkJoinDiscovery(pipeline, graphSet, diagnostics);
    auditExternalRepoProvision(pipeline, graphSet, diagnostics);
    auditMachineAdapter(pipeline, orderedNodes, diagnostics);
    auditDeclaredNodePackReferences(pipeline, graphSet, diagnostics);
    auditSelectedNodePackProvenance(pipeline, graphSet, diagnostics);
    auditItemEvidenceContracts(graphSet, diagnostics);
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
      graphComplexity,
    },
    ...(options.includeValidation ? { validation } : {}),
  };
}

function assertGeneratedPipelineQuality(audit) {
  if (audit?.ok) return audit;
  const codes = (audit?.diagnostics || [])
    .filter(item => item.level === 'error')
    .map(item => {
      const code = String(item.code || '').trim() || 'unknown';
      const packId = String(item.packId || item.nodePackId || item.selectionDiagnostic?.packId || '').trim();
      return packId ? `${code}(${packId})` : code;
    })
    .join(', ');
  const err = new Error(`Generated pipeline failed authoring quality audit: ${codes || 'unknown'}`);
  err.code = 'ORCHESTRATION_AUTHORING_QUALITY_FAILED';
  err.qualityAudit = audit;
  throw err;
}

module.exports = {
  analyzeGraphComplexity,
  analyzeGraphSetComplexity,
  auditGeneratedPipelineQuality,
  assertGeneratedPipelineQuality,
};
