const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  cliOverlayRoot,
  createCliAgentAdapter,
} = require('./adapters/cli-agent');
const {
  getProviderPlugin,
  getProviderPluginForAdapter,
  hasProviderPlugin,
  resolveProviderIdFromAdapter,
} = require('./providers/registry');
const { createAdapterRequest } = require('./adapters/proposal-adapter');
const { summarizeApprovalsFromEvents } = require('./approvals');
const { assertNoSymlinkInRunPath, registerArtifact, writeArtifactManifest } = require('./artifacts');
const { claimNextQueuedItem } = require('./dispatcher');
const { createCommandGrant } = require('./command-grants');
const { SCHEMA_VERSIONS, createContractValidator } = require('./contracts');
const { exportLatestRun } = require('./exporters/latest-run-exporter');
const { buildTraversalPlan } = require('./traversal');
const { loadPipelineGraphSet } = require('./graph-loader');
const {
  appendRunLifecycleStatus,
  appendRunSummaryStatus,
  finalizeRunFromInventory,
  summarizeQueueInventory,
} = require('./lifecycle');
const { projectRunStateFromEvents, readMachineEvents } = require('./events');
const { readRunState } = require('./run-store');
const { recordNodeLifecycleEvent } = require('./node-lifecycle');
const { runProposalProbe } = require('./probe-runner');
const { runProposalTriage } = require('./triage-runner');
const { runWorkerLoopOnce } = require('./worker-loop');
const { normalizeWriteSetPath } = require('./write-sets');

const fsp = fs.promises;
const contractValidator = createContractValidator();
const MACHINE_CANDIDATE_INVENTORY_SCHEMA = SCHEMA_VERSIONS.candidateInventory;
const TERMINAL_RUN_LIFECYCLE_STATUSES = new Set(['completed', 'cancelled', 'failed']);
const EXTERNAL_RESEARCH_INTENT_PATTERN = /\b(competing products?|competitors?|competition|market|benchmark|benchmarks|web research|browse|internet|online|search for competing|external research)\b/i;
const MANAGED_PROPOSAL_CANDIDATE_SAFE_CAP = 5;
const SUPPORT_NODE_TYPES = new Set([
  'orpad.entry',
  'orpad.context',
  'orpad.workQueue',
  'orpad.gate',
  'orpad.selector',
  'orpad.barrier',
  'orpad.artifactContract',
  'orpad.patchReview',
  'orpad.exit',
  'orpad.graph',
]);
const PATCH_REVIEW_RESOLUTION_EVENT_TYPES = new Set(['patch.applied', 'patch.review_skipped']);
const PATCH_REVIEW_EVENT_TYPES = new Set([
  ...PATCH_REVIEW_RESOLUTION_EVENT_TYPES,
  'patch.approved',
  'patch.apply_failed',
  'patch.apply_conflict',
]);
const PATCH_BATCH_APPLY_EVENT_TYPES = new Set([
  'patches.apply_started',
  'patches.apply_finished',
]);
const PATCH_REVIEW_STATUS_BY_EVENT = new Map([
  ['patch.applied', 'applied'],
  ['patch.review_skipped', 'skipped'],
  ['patch.approved', 'approved'],
  ['patch.apply_conflict', 'conflict'],
  ['patch.apply_failed', 'failed'],
]);

function machineExecutionError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function assertRunCanExecuteStep(runRoot) {
  const events = await readMachineEvents(runRoot);
  const runState = await readRunState(runRoot) || projectRunStateFromEvents(events);
  if (
    TERMINAL_RUN_LIFECYCLE_STATUSES.has(runState?.lifecycleStatus)
    || runState?.summaryStatus === 'done'
  ) {
    throw machineExecutionError(
      'MACHINE_RUN_TERMINAL',
      `Machine run is terminal (${runState.lifecycleStatus}/${runState.summaryStatus}) and cannot execute another step.`,
    );
  }
  if (['running', 'cancelling'].includes(runState?.lifecycleStatus)) {
    throw machineExecutionError(
      'MACHINE_RUN_IN_PROGRESS',
      `Machine run is already ${runState.lifecycleStatus} and cannot execute another step.`,
    );
  }
  const activeNodeExecutions = activeNodeExecutionsFromEvents(events);
  if (activeNodeExecutions.length) {
    const err = machineExecutionError(
      'MACHINE_RUN_IN_PROGRESS',
      'Machine run already has an active node execution and cannot execute another step.',
    );
    err.activeNodeExecutions = activeNodeExecutions;
    throw err;
  }
}

function nodeExecutionKey(event) {
  return event?.payload?.nodeExecutionId
    || `${event?.nodePath || ''}:attempt-${event?.payload?.attempt || 1}`;
}

function activeNodeExecutionsFromEvents(events = []) {
  const active = new Map();
  for (const event of events) {
    if (!String(event?.eventType || '').startsWith('node.')) continue;
    const key = nodeExecutionKey(event);
    if (!key) continue;
    if (event.eventType === 'node.started') {
      active.set(key, {
        nodeExecutionId: key,
        nodePath: event.nodePath || '',
        startedSequence: event.sequence,
      });
    } else if (['node.completed', 'node.failed', 'node.blocked', 'node.skipped'].includes(event.eventType)) {
      active.delete(key);
    }
  }
  return [...active.values()];
}

async function readJsonFile(filePath, label = 'JSON file') {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    throw machineExecutionError('MACHINE_EXECUTION_SCHEMA_INVALID', `${label} must be valid JSON.`);
  }
}

function harnessFromPipeline(pipeline) {
  return pipeline?.run && typeof pipeline.run === 'object' && !Array.isArray(pipeline.run)
    ? pipeline.run.machineHarness
    : null;
}

function machineAdapterFromPipeline(pipeline) {
  return pipeline?.run && typeof pipeline.run === 'object' && !Array.isArray(pipeline.run)
    ? pipeline.run.machineAdapter
    : null;
}

function adapterOverridesPathForPipeline(pipelinePath) {
  if (!pipelinePath) return '';
  const dir = path.dirname(pipelinePath);
  const base = path.basename(pipelinePath);
  const stem = base.replace(/\.[^.]+$/, '');
  return path.join(dir, `${stem}.adapter-overrides.json`);
}

async function readAdapterOverridesForPipeline(pipelinePath) {
  if (!pipelinePath) return null;
  const overridesPath = adapterOverridesPathForPipeline(pipelinePath);
  try {
    const raw = await fsp.readFile(overridesPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.schemaVersion === 'orpad.adapterOverrides.v1') return parsed;
    return null;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return null;
  }
}

// Pipeline-orchestration fields that are not provider-specific. The picker
// only changes provider/model selection, so these fields must survive an
// override (otherwise probe fanout, claim limits, and timeouts collapse to
// defaults — e.g. parallelProbes:true gets dropped → only 1 probe runs).
const PIPELINE_ORCHESTRATION_FIELDS = Object.freeze([
  'probeNodePaths',
  'probeNodePath',
  'probeConcurrency',
  'parallelProbes',
  'triageNodePath',
  'dispatcherNodePath',
  'workerNodePath',
  'candidateLimit',
  'proposalTimeoutMs',
  'workerTimeoutMs',
  'claimLeaseMs',
  'workerClaimLimit',
  'maxWorkerClaims',
  'claimLimit',
  'continueAfterReviewableBlockedPatch',
  'supportNodePolicy',
]);

function applyAdapterOverridesToPipelineAdapter(adapter, overrides) {
  if (!overrides) return adapter;
  if (!overrides.pipelineDefault) return adapter;
  const baseSelection = {
    family: 'cli',
    providerId: 'codex-cli',
    model: 'codex',
    qualityTier: 'standard',
    sessionStrategy: 'none',
    toolPolicy: 'none',
    sandbox: null,
    approvalPolicy: 'never',
    timeoutMs: 600000,
    ephemeral: true,
  };
  const merged = { ...baseSelection, ...overrides.pipelineDefault };
  // Carry over orchestration fields from the original v1 envelope so the
  // picker's provider/model swap does not also reset the pipeline's probe
  // fanout, timeouts, claim leases, etc.
  const carried = {};
  if (adapter && typeof adapter === 'object' && !Array.isArray(adapter)) {
    for (const field of PIPELINE_ORCHESTRATION_FIELDS) {
      if (adapter[field] !== undefined) carried[field] = adapter[field];
    }
  }
  return {
    schemaVersion: 'orpad.machineAdapter.v2',
    enabled: true,
    default: merged,
    nodeOverrides: overrides.nodeOverrides || {},
    legacy: adapter || null,
    ...carried,
  };
}

function isRunnableMachineAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) return false;
  if (adapter.enabled === false) return false;
  const providerId = resolveProviderIdFromAdapter(adapter);
  if (!providerId) return false;
  const plugin = getProviderPlugin(providerId);
  if (!plugin) return false;
  return plugin.family === 'cli' || plugin.family === 'api';
}

function nodeExecutableForHarness() {
  return process.env.ORPAD_MACHINE_NODE_EXEC_PATH
    || process.env.npm_node_execpath
    || process.env.NODE
    || process.execPath;
}

function idSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'item';
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw machineExecutionError('MACHINE_EXECUTION_SCHEMA_INVALID', `${label} must be an object.`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw machineExecutionError('MACHINE_EXECUTION_SCHEMA_INVALID', `${label} is required.`);
  }
  return value;
}

function candidateProposalsFromHarness(harness) {
  const candidates = Array.isArray(harness.candidateProposals)
    ? harness.candidateProposals
    : (harness.candidateProposal ? [harness.candidateProposal] : []);
  if (!candidates.length) {
    throw machineExecutionError('MACHINE_EXECUTION_SCHEMA_INVALID', 'machineHarness.candidateProposal is required.');
  }
  return candidates.map((candidate, index) => assertPlainObject(candidate, `machineHarness.candidateProposals[${index}]`));
}

function expectedChangedFilesFromHarness(harness, candidates) {
  const files = harness.expectedChangedFiles || candidates.flatMap(candidate => candidate.sourceOfTruthTargets || []);
  return [...new Set(files.map(file => normalizeWriteSetPath(file)))];
}

function nodeCliPatchCommandSpec(patchConfig, cwd, options = {}) {
  const patch = assertPlainObject(patchConfig, 'machineHarness.nodeCliPatch');
  const file = normalizeWriteSetPath(requiredString(patch.file, 'machineHarness.nodeCliPatch.file'));
  const content = typeof patch.content === 'string' ? patch.content : `${String(patch.content ?? '')}`;
  const script = [
    'const fs=require("fs");',
    'const path=require("path");',
    `const file=${JSON.stringify(file)};`,
    `const content=${JSON.stringify(content)};`,
    'fs.mkdirSync(path.dirname(file),{recursive:true});',
    'fs.writeFileSync(file,content,"utf8");',
  ].join('');
  return {
    command: options.nodeExecutable || nodeExecutableForHarness(),
    args: ['-e', script],
    cwd,
    file,
  };
}

function candidateProposalFromWorkItem(item) {
  if (!item) return null;
  return {
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: `proposal-${item.id}`,
    suggestedWorkItemId: item.id,
    sourceNode: item.sourceNode,
    title: item.title,
    fingerprint: item.fingerprint,
    contentArea: item.contentArea,
    issueType: item.issueType,
    severity: item.severity,
    confidence: item.confidence,
    evidence: item.evidence || [],
    acceptanceCriteria: item.acceptanceCriteria || [],
    sourceOfTruthTargets: item.sourceOfTruthTargets || [],
    userImpact: item.userImpact,
    reproSteps: item.reproSteps || [],
    expectedBehavior: item.expectedBehavior,
    actualBehavior: item.actualBehavior,
    verificationPlan: item.verificationPlan,
    coverageEvidenceIds: item.coverageEvidenceIds || [],
    approvalRequired: item.approvalRequired === true,
  };
}

function adapterProbeNodePaths(adapter) {
  const configured = Array.isArray(adapter.probeNodePaths)
    ? adapter.probeNodePaths
    : (adapter.probeNodePath ? [adapter.probeNodePath] : []);
  return configured.filter(Boolean);
}

function configuredProbeConcurrency(config = {}, probeCount = 1) {
  const configured = config.probeConcurrency ?? config.maxParallelProbes;
  if (String(configured || '').toLowerCase() === 'all') return Math.max(1, probeCount);
  const parsed = Number(configured);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.max(1, Math.min(probeCount, Math.trunc(parsed)));
  }
  return config.parallelProbes === true ? Math.max(1, probeCount) : 1;
}

function configuredWorkerClaimLimit(config = {}, fallbackCount = 1) {
  const configured = config.workerClaimLimit ?? config.maxWorkerClaims ?? config.claimLimit;
  if (String(configured || '').toLowerCase() === 'all') return Math.max(1, fallbackCount);
  const parsed = Number(configured);
  if (Number.isFinite(parsed) && parsed > 0) return Math.max(1, Math.trunc(parsed));
  return Math.max(1, fallbackCount);
}

function isReviewableBlockedPatch(step) {
  const status = String(step?.result?.event?.payload?.status || '').toLowerCase();
  if (status !== 'blocked') return false;
  const payload = step?.result?.event?.payload || {};
  const hasPatch = Boolean(payload.patchArtifact) && (payload.changedFiles || []).length > 0;
  const hasWriteSetViolation = (payload.verification || [])
    .some(entry => (Number(entry?.writeSetViolationCount) || 0) > 0);
  return hasPatch && !hasWriteSetViolation;
}

function shouldStopWorkerLoopAfterStep(step, config = {}) {
  const status = String(step?.result?.event?.payload?.status || '').toLowerCase();
  if (config.continueAfterReviewableBlockedPatch === true && isReviewableBlockedPatch(step)) return false;
  const toState = String(step?.result?.toState || step?.result?.event?.payload?.toState || '').toLowerCase();
  return ['approval-required', 'blocked', 'failed', 'rejected'].includes(status) || toState === 'queued';
}

async function mapWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Math.min(items.length || 1, concurrency || 1));
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  const settled = await Promise.allSettled(workers);
  const rejected = settled.find(result => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  return results;
}

function normalizeRuntimeTaskText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 2000);
}

function hasMachineExternalResearchIntent(taskText) {
  return EXTERNAL_RESEARCH_INTENT_PATTERN.test(normalizeRuntimeTaskText(taskText));
}

function normalizeExternalResearchState(value) {
  if (!value || typeof value !== 'object' || value.intentDetected !== true) return null;
  const mode = value.mode === 'approved-or-attached-evidence'
    ? 'approved-or-attached-evidence'
    : 'local-only-research-gap';
  return {
    schemaVersion: 'orpad.externalResearchRun.v1',
    intentDetected: true,
    mode,
    evidence: {
      status: mode === 'approved-or-attached-evidence' ? 'approved-or-attached' : 'not-provided',
      source: String(value.evidence?.source || 'user-prelaunch-choice').slice(0, 160),
    },
    limitation: String(value.limitation || '').slice(0, 1000),
    requiredEvidence: String(value.requiredEvidence || '').slice(0, 500),
    fallback: String(value.fallback || '').slice(0, 500),
    downstreamInstruction: String(value.downstreamInstruction || '').slice(0, 1000),
  };
}

function externalResearchPromptLines(externalResearch) {
  if (!externalResearch?.intentDetected) return [];
  const localOnly = externalResearch.mode === 'local-only-research-gap';
  return [
    '',
    'External research launch state:',
    JSON.stringify(externalResearch, null, 2),
    localOnly
      ? 'This run is local-only research-gap mode. Do not present competitor, market, benchmark, web, or online claims as verified; report the external research gap and use only local workspace evidence.'
      : 'This run declares approved browsing or attached research evidence. Use only that approved or attached evidence for external claims; do not invent competitor claims.',
  ];
}

function configuredProbeCandidateLimit(adapter = {}) {
  return Number.isFinite(Number(adapter.candidateLimit))
    ? Math.max(0, Math.min(MANAGED_PROPOSAL_CANDIDATE_SAFE_CAP, Math.trunc(Number(adapter.candidateLimit))))
    : 1;
}

function effectiveProbeCandidateLimit(input = {}) {
  const configuredLimit = configuredProbeCandidateLimit(input.adapter);
  const runSelection = input.pipeline?.run?.runSelection || {};
  const collectAllVisiblePolicy = input.node?.config?.candidateLimitPolicy === 'collect-all-visible';
  const queueAllBacklog = (
    runSelection.collectAllVisibleCandidates === true
    && runSelection.queueAllActionableCandidates === true
  );
  if (collectAllVisiblePolicy && queueAllBacklog) {
    return Math.max(configuredLimit, MANAGED_PROPOSAL_CANDIDATE_SAFE_CAP);
  }
  return configuredLimit;
}

function liveProbePrompt(input = {}) {
  const { request, node, pipelinePath, pipeline, adapter } = input;
  const taskText = normalizeRuntimeTaskText(input.taskText);
  const externalResearch = normalizeExternalResearchState(input.externalResearch);
  const candidateLimit = effectiveProbeCandidateLimit({ adapter, node, pipeline });
  return [
    'You are the OrPAD managed-run proposal adapter.',
    'Inspect the local workspace from the current working directory, but do not modify files.',
    'Return exactly one JSON object and no markdown.',
    '',
    'Machine-owned fields for this call:',
    `adapterCallId: ${request.adapterCallId}`,
    `attemptId: ${request.attemptId}`,
    `idempotencyKey: ${request.idempotencyKey}`,
    `pipelinePath: ${pipelinePath}`,
    `pipelineId: ${pipeline.id || ''}`,
    `nodePath: ${node.nodePath}`,
    `nodeType: ${node.nodeType}`,
    `nodeConfig: ${JSON.stringify(node.config || {})}`,
    ...(taskText ? [
      '',
      'User requested work:',
      '<user-task>',
      taskText,
      '</user-task>',
      'Use this request as the primary prioritization context when ranking candidate proposals.',
      'If the request needs external competitor research and this adapter has no approved browsing capability, do not invent external claims; propose only evidence-backed local work or report the research gap.',
    ] : []),
    ...externalResearchPromptLines(externalResearch),
    '',
    'Result contract:',
    JSON.stringify({
      schemaVersion: 'orpad.workerResult.v1',
      adapterCallId: request.adapterCallId,
      attemptId: request.attemptId,
      idempotencyKey: request.idempotencyKey,
      status: 'done',
      summary: 'short result summary',
      artifacts: [],
      candidateProposals: [{
        schemaVersion: 'orpad.candidateProposal.v1',
        proposalId: 'stable-proposal-id',
        suggestedWorkItemId: 'stable-work-item-id',
        sourceNode: node.nodePath,
        title: 'bounded actionable finding',
        fingerprint: 'stable-dedupe-fingerprint',
        contentArea: 'product|ux|bug|security|test|pipeline',
        issueType: 'specific issue type',
        severity: 'P1|P2|P3',
        confidence: 0.75,
        evidence: [{ id: 'evidence-id', file: 'relative/path', summary: 'current evidence' }],
        acceptanceCriteria: ['specific done criterion'],
        sourceOfTruthTargets: ['relative/path/to/source'],
        userImpact: 'why this matters',
        reproSteps: ['how to observe it'],
        expectedBehavior: 'expected behavior',
        actualBehavior: 'actual behavior',
        verificationPlan: 'focused verification command or check',
        coverageEvidenceIds: ['evidence-id'],
        approvalRequired: false,
      }],
      emptyPass: {
        reason: 'required when candidateProposals is empty',
        evidence: ['file, command, or inspected surface'],
      },
    }, null, 2),
    '',
    `Return at most ${candidateLimit} candidateProposals.`,
    'Use current, concrete evidence only. Prefer a small user-visible, source-of-truth fix.',
    'If no actionable current finding is visible for this node, return status "done", candidateProposals: [], and an evidence-backed emptyPass.',
    'Do not create broad refactor candidates. Do not make generated latest-run evidence files the only sourceOfTruthTargets.',
  ].join('\n');
}

function buildLiveWorkerPrompt(input = {}) {
  const { request, claim, candidate, workerNode } = input;
  const taskText = normalizeRuntimeTaskText(input.taskText);
  const externalResearch = normalizeExternalResearchState(input.externalResearch);
  return [
    'You are the OrPAD managed-run worker adapter.',
    'The current working directory is a temporary Machine overlay containing only the active write set.',
    'Modify only files that already exist in this overlay or are explicitly part of the active write set.',
    'Do not access the canonical workspace. Do not run destructive commands. Do not install dependencies.',
    'The Machine will collect the overlay diff and decide whether any canonical write is allowed.',
    'Return exactly one JSON object and no markdown when finished.',
    '',
    'Machine-owned fields for this call:',
    `adapterCallId: ${request.adapterCallId}`,
    `attemptId: ${request.attemptId}`,
    `idempotencyKey: ${request.idempotencyKey}`,
    `nodePath: ${workerNode.nodePath}`,
    `claimId: ${claim.claim.claimId}`,
    `itemId: ${claim.item.id}`,
    `allowedFiles: ${JSON.stringify(request.allowedFiles || [])}`,
    ...(taskText ? [
      '',
      'User requested work:',
      '<user-task>',
      taskText,
      '</user-task>',
      'Use this request to preserve product intent while implementing the claimed work item. Do not expand beyond the Machine-approved write set.',
    ] : []),
    ...externalResearchPromptLines(externalResearch),
    '',
    'Claimed work item:',
    JSON.stringify(claim.item || candidate || {}, null, 2),
    '',
    'Return this shape:',
    JSON.stringify({
      schemaVersion: 'orpad.workerResult.v1',
      adapterCallId: request.adapterCallId,
      attemptId: request.attemptId,
      idempotencyKey: request.idempotencyKey,
      status: 'done',
      summary: 'short implementation summary, or why the item is blocked',
      artifacts: [],
    }, null, 2),
    '',
    'Use status "done" only if you changed the overlay toward the acceptance criteria.',
    'Use status "blocked" if the allowed files are insufficient or the change is unsafe.',
  ].join('\n');
}

function defaultModelForLiveAdapter(adapter) {
  if (adapter && typeof adapter === 'object' && adapter.default && typeof adapter.default === 'object') {
    return String(adapter.default.model || '').trim();
  }
  return '';
}

function selectionForLiveApiPlugin(adapter, plugin) {
  const defaults = (adapter && typeof adapter === 'object' && adapter.default && typeof adapter.default === 'object')
    ? adapter.default
    : {};
  return {
    providerId: plugin.id,
    family: plugin.family,
    model: defaults.model || plugin.defaultModel || '',
    qualityTier: defaults.qualityTier || 'standard',
    sessionStrategy: defaults.sessionStrategy || 'none',
    toolPolicy: defaults.toolPolicy || 'none',
  };
}

function createApiProbeInvocationAdapter(input = {}) {
  const {
    plugin,
    adapter,
    node,
    pipelinePath,
    pipeline,
    taskText,
    externalResearch,
    loadProviderKey,
    fetchImpl,
  } = input;
  return {
    adapter: `${plugin.id}-api-proposal`,
    async invoke(request) {
      const prompt = liveProbePrompt({
        request,
        node,
        pipelinePath,
        pipeline,
        adapter,
        taskText,
        externalResearch,
      });
      const selection = selectionForLiveApiPlugin(adapter, plugin);
      let providerKey = '';
      if (typeof loadProviderKey === 'function') {
        try {
          providerKey = String(await loadProviderKey(plugin.id) || '').trim();
        } catch (err) {
          const wrapped = new Error(`Could not load provider key for ${plugin.id}: ${err?.message || err}`);
          wrapped.code = 'KEY_MISSING';
          wrapped.classification = 'KEY_MISSING';
          throw wrapped;
        }
      }
      if (plugin.needsKey && !providerKey) {
        const err = new Error(`Provider "${plugin.id}" requires an API key. Save one through Settings → AI Keys, then retry.`);
        err.code = 'KEY_MISSING';
        err.classification = 'KEY_MISSING';
        throw err;
      }
      const out = await plugin.invokeApi({
        request,
        prompt,
        selection,
        providerKey,
        fetchImpl,
      });
      return out?.result || out;
    },
  };
}

async function liveWorkerCommandSpec(input = {}) {
  const { adapter, request, overlayRoot } = input;
  const plugin = getProviderPluginForAdapter(adapter);
  if (!plugin || typeof plugin.buildWorkerCommandSpec !== 'function') {
    const providerId = resolveProviderIdFromAdapter(adapter) || 'unknown';
    throw machineExecutionError(
      'MACHINE_PROVIDER_PLUGIN_MISSING',
      `Provider plugin "${providerId}" does not implement buildWorkerCommandSpec.`,
    );
  }
  const prompt = buildLiveWorkerPrompt(input);
  return plugin.buildWorkerCommandSpec({ adapter, request, prompt, overlayRoot });
}

function flattenTraversalNodes(plan) {
  const byPath = new Map(plan.inventory.map(node => [node.nodePath, node]));
  const ordered = [];
  const nodePaths = plan.inlinePlan?.nodePaths?.length
    ? plan.inlinePlan.nodePaths
    : plan.graphPlans.flatMap(graphPlan => graphPlan.nodePaths);
  for (const nodePath of nodePaths) {
    const node = byPath.get(nodePath);
    if (node) ordered.push(node);
  }
  return ordered;
}

function selectNode(orderedNodes, nodeType, explicitNodePath = '') {
  if (explicitNodePath) {
    const explicit = orderedNodes.find(node => node.nodePath === explicitNodePath);
    if (!explicit) {
      throw machineExecutionError('MACHINE_EXECUTION_NODE_NOT_FOUND', `Machine execution node not found: ${explicitNodePath}`);
    }
    if (explicit.nodeType !== nodeType) {
      throw machineExecutionError('MACHINE_EXECUTION_NODE_TYPE_MISMATCH', `Machine execution node ${explicitNodePath} is not ${nodeType}.`);
    }
    return explicit;
  }
  return orderedNodes.find(node => node.nodeType === nodeType) || null;
}

function selectNodes(orderedNodes, nodeType, explicitNodePaths = []) {
  const explicitPaths = Array.isArray(explicitNodePaths)
    ? explicitNodePaths.filter(Boolean)
    : (explicitNodePaths ? [explicitNodePaths] : []);
  if (!explicitPaths.length) return orderedNodes.filter(node => node.nodeType === nodeType);
  return explicitPaths.map(nodePath => selectNode(orderedNodes, nodeType, nodePath));
}

function supportNodesForExecution(orderedNodes, operationNodes) {
  const operationPaths = new Set(operationNodes.filter(Boolean).map(node => node.nodePath));
  return orderedNodes.filter(node => (
    SUPPORT_NODE_TYPES.has(node.nodeType)
    && !operationPaths.has(node.nodePath)
  ));
}

function proposalResultForRequest(request, options = {}) {
  return {
    schemaVersion: 'orpad.workerResult.v1',
    adapterCallId: request.adapterCallId,
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    status: options.status || 'done',
    summary: options.summary || 'Machine graph harness submitted a proposal result.',
    artifacts: options.artifacts || [],
    candidateProposals: options.candidateProposals || [],
    triageTransitions: options.triageTransitions || [],
    ...(options.emptyPass ? { emptyPass: options.emptyPass } : {}),
  };
}

async function withNodeLifecycle(runRoot, node, options = {}, fn) {
  const { runId } = options;
  const attempt = options.attempt || 1;
  await recordNodeLifecycleEvent(runRoot, {
    runId,
    nodePath: node.nodePath,
    nodeType: node.nodeType,
    attempt,
    status: 'scheduled',
    payload: options.scheduledPayload || {},
  });
  await recordNodeLifecycleEvent(runRoot, {
    runId,
    nodePath: node.nodePath,
    nodeType: node.nodeType,
    attempt,
    status: 'started',
    payload: options.startedPayload || {},
  });
  try {
    const result = await fn();
    await recordNodeLifecycleEvent(runRoot, {
      runId,
      nodePath: node.nodePath,
      nodeType: node.nodeType,
      attempt,
      status: 'completed',
      payload: typeof options.completedPayload === 'function'
        ? options.completedPayload(result)
        : (options.completedPayload || {}),
    });
    return result;
  } catch (err) {
    const failurePayload = {
      code: err?.code || 'MACHINE_NODE_FAILED',
      message: err?.message || String(err),
    };
    await recordNodeLifecycleEvent(runRoot, {
      runId,
      nodePath: node.nodePath,
      nodeType: node.nodeType,
      attempt,
      status: 'failed',
      payload: failurePayload,
    });
    await appendRunLifecycleStatus(runRoot, {
      runId,
      toState: 'waiting',
      reason: 'machine-node.failed',
      payload: {
        nodePath: node.nodePath,
        nodeType: node.nodeType,
        attempt,
        ...failurePayload,
      },
    }).catch(() => null);
    await appendRunSummaryStatus(runRoot, {
      runId,
      summaryStatus: 'blocked',
      reason: 'machine-node.failed',
      payload: {
        nodePath: node.nodePath,
        nodeType: node.nodeType,
        attempt,
        ...failurePayload,
      },
    }).catch(() => null);
    throw err;
  }
}

async function executeBlockingSupportNode(runRoot, node, options = {}, evaluate) {
  const { runId } = options;
  const attempt = options.attempt || 1;
  await recordNodeLifecycleEvent(runRoot, {
    runId,
    nodePath: node.nodePath,
    nodeType: node.nodeType,
    attempt,
    status: 'scheduled',
    payload: options.scheduledPayload || {},
  });
  await recordNodeLifecycleEvent(runRoot, {
    runId,
    nodePath: node.nodePath,
    nodeType: node.nodeType,
    attempt,
    status: 'started',
    payload: options.startedPayload || {},
  });
  try {
    const result = await evaluate();
    if (result?.blocked) {
      await recordNodeLifecycleEvent(runRoot, {
        runId,
        nodePath: node.nodePath,
        nodeType: node.nodeType,
        attempt,
        status: 'blocked',
        payload: result,
      });
      return result;
    }
    await recordNodeLifecycleEvent(runRoot, {
      runId,
      nodePath: node.nodePath,
      nodeType: node.nodeType,
      attempt,
      status: 'completed',
      payload: result || {},
    });
    return result || {};
  } catch (err) {
    const failurePayload = {
      code: err?.code || 'MACHINE_NODE_FAILED',
      message: err?.message || String(err),
    };
    await recordNodeLifecycleEvent(runRoot, {
      runId,
      nodePath: node.nodePath,
      nodeType: node.nodeType,
      attempt,
      status: 'failed',
      payload: failurePayload,
    });
    await appendRunLifecycleStatus(runRoot, {
      runId,
      toState: 'waiting',
      reason: 'machine-node.failed',
      payload: {
        nodePath: node.nodePath,
        nodeType: node.nodeType,
        attempt,
        ...failurePayload,
      },
    }).catch(() => null);
    await appendRunSummaryStatus(runRoot, {
      runId,
      summaryStatus: 'blocked',
      reason: 'machine-node.failed',
      payload: {
        nodePath: node.nodePath,
        nodeType: node.nodeType,
        attempt,
        ...failurePayload,
      },
    }).catch(() => null);
    throw err;
  }
}

async function executePatchReviewNode(runRoot, node, options = {}) {
  return executeBlockingSupportNode(runRoot, node, options, async () => {
    const review = patchReviewStateFromEvents(await readMachineEvents(runRoot));
    if (review.required && !review.resolved) {
      return {
        blocked: true,
        summaryStatus: 'blocked',
        reason: review.failedCount ? 'patch-review.apply-failed' : 'patch-review.required',
        status: 'blocked',
        reviewRequired: true,
        patchCount: review.patchCount,
        pendingCount: review.pendingCount,
        appliedCount: review.appliedCount,
        skippedCount: review.skippedCount,
        failedCount: review.failedCount,
        pendingPatchArtifacts: review.pending.map(entry => entry.patchArtifact),
      };
    }
    return {
      status: review.required ? 'reviewed' : 'not-required',
      reviewRequired: false,
      patchCount: review.patchCount,
      appliedCount: review.appliedCount,
      skippedCount: review.skippedCount,
    };
  });
}

function latestLifecycleStatusByNode(events = []) {
  const statuses = new Map();
  for (const event of events) {
    const type = String(event?.eventType || '');
    if (!type.startsWith('node.')) continue;
    const nodePath = String(event?.nodePath || '').trim();
    if (!nodePath) continue;
    statuses.set(nodePath, event);
  }
  return statuses;
}

function latestArtifactContractPartials(events = []) {
  return [...latestLifecycleStatusByNode(events).values()]
    .filter(event => (
      event?.eventType === 'node.completed'
      && event?.payload?.nodeType === 'orpad.artifactContract'
      && event?.payload?.valid === false
      && event?.payload?.onMissing === 'mark-partial'
    ))
    .map(event => ({
      nodePath: event.nodePath,
      missingArtifactCount: event.payload.missingArtifactCount,
      missingQueueCount: event.payload.missingQueueCount,
      missingArtifacts: event.payload.missingArtifacts,
      missingQueue: event.payload.missingQueue,
    }));
}

async function executeExitNode(runRoot, node, options = {}) {
  return executeBlockingSupportNode(runRoot, node, options, async () => {
    const events = await readMachineEvents(runRoot);
    const review = patchReviewStateFromEvents(events);
    if (review.required && !review.resolved) {
      return {
        blocked: true,
        summaryStatus: 'blocked',
        reason: 'exit.patch-review-required',
        status: 'blocked',
        patchCount: review.patchCount,
        pendingPatchArtifacts: review.pending.map(entry => entry.patchArtifact),
      };
    }
    const partialContracts = latestArtifactContractPartials(events);
    if (partialContracts.length) {
      return {
        blocked: true,
        summaryStatus: 'partial',
        reason: 'exit.evidence-incomplete',
        status: 'blocked',
        artifactContracts: partialContracts,
      };
    }
    return {
      status: 'completed',
      patchCount: review.patchCount,
      appliedCount: review.appliedCount,
      skippedCount: review.skippedCount,
    };
  });
}

function outputRefs(config = {}) {
  return Array.isArray(config.outputs) ? config.outputs : [];
}

function inputRefs(config = {}) {
  return Array.isArray(config.inputs) ? config.inputs : [];
}

function arrayConfig(value, label, code = 'MACHINE_CONFIG_INVALID') {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  throw machineExecutionError(code, `${label} must be an array.`);
}

function stringArrayConfig(value, label, code = 'MACHINE_CONFIG_INVALID') {
  return arrayConfig(value, label, code).map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw machineExecutionError(code, `${label}[${index}] must be a non-empty string.`);
    }
    return entry.trim();
  });
}

function artifactContractOnMissing(value) {
  const policy = value || 'fail-run';
  if (['fail-run', 'mark-partial', 'warn'].includes(policy)) return policy;
  throw machineExecutionError('MACHINE_ARTIFACT_CONTRACT_INVALID', `Unsupported ArtifactContract onMissing policy: ${policy}`);
}

function canonicalContractRoot(root, fallback) {
  if (!root) return fallback;
  const normalized = normalizeWriteSetPath(root);
  const latestRunPrefix = 'harness/generated/latest-run/';
  const latestRunIndex = normalized.indexOf(latestRunPrefix);
  const stripped = latestRunIndex >= 0
    ? normalized.slice(latestRunIndex + latestRunPrefix.length)
    : normalized;
  if (!stripped || stripped === fallback || stripped.endsWith(`/${fallback}`)) return fallback;
  return stripped;
}

function contractExpectedPath(root, requiredPath, fallbackRoot) {
  const required = normalizeWriteSetPath(requiredPath);
  if (!required) return '';
  if (required === fallbackRoot || required.startsWith(`${fallbackRoot}/`)) return required;
  return path.posix.join(canonicalContractRoot(root, fallbackRoot), required);
}

async function runRelativeFileExists(runRoot, relativePath) {
  try {
    await assertNoSymlinkInRunPath(runRoot, relativePath);
    const stats = await fsp.stat(path.join(path.resolve(runRoot), ...relativePath.split('/')));
    return stats.isFile();
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

async function validateArtifactContract(runRoot, config = {}) {
  const manifest = await writeArtifactManifest(runRoot);
  const inventory = await summarizeQueueInventory(runRoot);
  const manifestPaths = new Set(manifest.files.map(file => file.path));
  const onMissing = artifactContractOnMissing(config.onMissing);
  const requiredArtifacts = stringArrayConfig(
    config.required,
    'ArtifactContract.required',
    'MACHINE_ARTIFACT_CONTRACT_INVALID',
  ).map(required => ({
    declared: required,
    path: contractExpectedPath(config.artifactRoot, required, 'artifacts'),
  })).filter(entry => entry.path);
  const requiredQueue = [
    ...stringArrayConfig(config.requiredQueue, 'ArtifactContract.requiredQueue', 'MACHINE_ARTIFACT_CONTRACT_INVALID'),
    ...stringArrayConfig(config.requiredQueueArtifacts, 'ArtifactContract.requiredQueueArtifacts', 'MACHINE_ARTIFACT_CONTRACT_INVALID'),
  ].map(required => ({
    declared: required,
    path: contractExpectedPath(config.queueRoot, required, 'queue'),
  })).filter(entry => entry.path);

  const missingArtifacts = requiredArtifacts.filter(entry => !manifestPaths.has(entry.path));
  const missingQueue = [];
  for (const entry of requiredQueue) {
    if (!(await runRelativeFileExists(runRoot, entry.path))) missingQueue.push(entry);
  }

  const result = {
    valid: missingArtifacts.length === 0 && missingQueue.length === 0,
    onMissing,
    artifactCount: manifest.files.length,
    manifestSourceEventSequence: manifest.sourceEventSequence,
    requiredCount: requiredArtifacts.length,
    requiredQueueCount: requiredQueue.length,
    missingArtifactCount: missingArtifacts.length,
    missingQueueCount: missingQueue.length,
    requiredArtifacts,
    requiredQueue,
    missingArtifacts,
    missingQueue,
    inventory,
  };
  if (!result.valid && result.onMissing === 'fail-run') {
    const err = machineExecutionError(
      'MACHINE_ARTIFACT_CONTRACT_MISSING',
      'Evidence contract required files or queue files are missing.',
    );
    err.contract = result;
    throw err;
  }
  return result;
}

function resolveNodeRefFromConfig(node, ref) {
  const value = String(ref || '').trim();
  if (!value) return '';
  if (value.includes('/')) return value;
  return `${node.graphKey}/${value}`;
}

function latestNodeCompletedEvent(events, nodePath) {
  return [...events].reverse().find(event => (
    event.eventType === 'node.completed'
    && event.nodePath === nodePath
  )) || null;
}

// A node is "resolved" for this run when its latest lifecycle event is
// either node.completed (success) or node.skipped (user dismissed). The
// dispatcher must NOT re-attempt a resolved node — otherwise clicking
// Skip on a failing probe would just re-fire the same probe on the next
// run-step and surface the same failure card again.
function latestNodeResolvedEvent(events, nodePath) {
  return [...events].reverse().find(event => (
    (event.eventType === 'node.completed' || event.eventType === 'node.skipped')
    && event.nodePath === nodePath
  )) || null;
}

function hasUnresolvedSupportBlock(events, orderedNodes) {
  const supportBlockPaths = new Set(
    orderedNodes
      .filter(node => ['orpad.patchReview', 'orpad.exit'].includes(node.nodeType))
      .map(node => node.nodePath),
  );
  if (!supportBlockPaths.size) return false;
  const latestByPath = latestLifecycleStatusByNode(events);
  return [...supportBlockPaths].some(nodePath => latestByPath.get(nodePath)?.eventType === 'node.blocked');
}

function nextNodeAttempt(events, nodePath) {
  const attempts = events
    .filter(event => String(event.eventType || '').startsWith('node.') && event.nodePath === nodePath)
    .map(event => Number(event.payload?.attempt) || 1);
  return attempts.length ? Math.max(...attempts) + 1 : 1;
}

async function validateBarrierNode(runRoot, node, config = {}) {
  const waitFor = stringArrayConfig(config.waitFor, 'Barrier.waitFor');
  const onPartialFailure = config.onPartialFailure || 'continue-with-warning';
  if (!['fail', 'continue-with-warning', 'block'].includes(onPartialFailure)) {
    throw machineExecutionError('MACHINE_BARRIER_CONFIG_INVALID', `Unsupported Barrier onPartialFailure policy: ${onPartialFailure}`);
  }
  const events = await readMachineEvents(runRoot);
  const dependencies = waitFor.map(ref => {
    const nodePath = resolveNodeRefFromConfig(node, ref);
    // A barrier dependency is satisfied either when it completed
    // successfully or when the user explicitly skipped it. Treating skip
    // as still-pending would block the barrier forever.
    const resolvedEvent = latestNodeResolvedEvent(events, nodePath);
    return {
      ref,
      nodePath,
      completed: Boolean(resolvedEvent),
      eventSequence: resolvedEvent?.sequence ?? null,
      resolution: resolvedEvent?.eventType === 'node.skipped' ? 'skipped' : (resolvedEvent ? 'completed' : 'pending'),
    };
  });
  const missing = dependencies.filter(entry => !entry.completed);
  const result = {
    valid: missing.length === 0,
    waitForCount: waitFor.length,
    mergePolicy: config.mergePolicy || '',
    onPartialFailure,
    outputCount: outputRefs(config).length,
    dependencies,
    missing,
  };
  if (!result.valid && ['fail', 'block'].includes(onPartialFailure)) {
    const err = machineExecutionError(
      'MACHINE_BARRIER_WAIT_INCOMPLETE',
      'Barrier waitFor nodes must complete before the barrier can continue.',
    );
    err.barrier = result;
    throw err;
  }
  return result;
}

function acceptedWorkerProof(events) {
  return events.find(event => (
    event.eventType === 'worker.result'
    && event.payload?.status === 'done'
    && (
      (event.artifactRefs || []).length > 0
      || Boolean(event.payload?.patchArtifact)
    )
    && (event.payload?.verification || []).length > 0
  )) || null;
}

function patchReviewStateFromEvents(events = []) {
  const patchArtifacts = [];
  const seen = new Set();
  for (const event of events) {
    if (event?.eventType !== 'worker.result') continue;
    const payload = event.payload || {};
    const patchArtifact = String(payload.patchArtifact || '').trim();
    const changedFiles = Array.isArray(payload.changedFiles) ? payload.changedFiles.filter(Boolean) : [];
    if (!patchArtifact || !changedFiles.length || seen.has(patchArtifact)) continue;
    seen.add(patchArtifact);
    patchArtifacts.push({
      patchArtifact,
      itemId: event.itemId || payload.itemId || '',
      workerStatus: payload.status || '',
      changedFiles,
      sourceSequence: event.sequence ?? null,
    });
  }

  const decisions = new Map();
  for (const event of events) {
    const type = String(event?.eventType || '');
    if (!PATCH_REVIEW_EVENT_TYPES.has(type)) continue;
    const patchArtifact = String(event?.payload?.patchArtifact || '').trim();
    if (!patchArtifact) continue;
    decisions.set(patchArtifact, {
      eventType: type,
      sequence: event.sequence ?? null,
      decision: event?.payload?.decision || PATCH_REVIEW_STATUS_BY_EVENT.get(type) || '',
      code: event?.payload?.code || '',
      message: event?.payload?.message || '',
      selectedFiles: Array.isArray(event?.payload?.selectedFiles) ? event.payload.selectedFiles : [],
      mismatches: Array.isArray(event?.payload?.mismatches) ? event.payload.mismatches : [],
    });
  }

  const reviews = patchArtifacts.map(review => {
    const decision = decisions.get(review.patchArtifact) || null;
    const resolved = decision && PATCH_REVIEW_RESOLUTION_EVENT_TYPES.has(decision.eventType);
    const status = decision
      ? (PATCH_REVIEW_STATUS_BY_EVENT.get(decision.eventType) || 'pending')
      : 'pending';
    return {
      ...review,
      decision,
      status,
      resolved: Boolean(resolved),
    };
  });
  const pending = reviews.filter(review => !review.resolved);
  const approved = reviews.filter(review => review.status === 'approved');
  const conflict = reviews.filter(review => review.status === 'conflict');
  const failed = pending.filter(review => review.decision?.eventType === 'patch.apply_failed');
  const batch = batchApplyStateFromEvents(events);
  return {
    required: reviews.length > 0,
    resolved: pending.length === 0,
    patchCount: reviews.length,
    pendingCount: pending.length,
    appliedCount: reviews.filter(review => review.status === 'applied').length,
    skippedCount: reviews.filter(review => review.status === 'skipped').length,
    approvedCount: approved.length,
    conflictCount: conflict.length,
    failedCount: failed.length,
    reviews,
    pending,
    approved,
    conflict,
    failed,
    batch,
  };
}

function batchApplyStateFromEvents(events = []) {
  let lastStarted = null;
  let lastFinished = null;
  for (const event of events) {
    const type = String(event?.eventType || '');
    if (!PATCH_BATCH_APPLY_EVENT_TYPES.has(type)) continue;
    if (type === 'patches.apply_started') lastStarted = event;
    else if (type === 'patches.apply_finished') lastFinished = event;
  }
  const inFlight = Boolean(
    lastStarted
    && (!lastFinished || (lastFinished.sequence ?? 0) < (lastStarted.sequence ?? 0)),
  );
  return {
    inFlight,
    lastStartedSequence: lastStarted?.sequence ?? null,
    lastFinishedSequence: lastFinished?.sequence ?? null,
  };
}

function normalizeCriterion(value) {
  return String(value || '').trim().toLowerCase();
}

function evaluateGateCriterion(criterion, input = {}) {
  const normalized = normalizeCriterion(criterion);
  if (!normalized) {
    return { criterion, supported: false, passed: false, reason: 'empty-criterion' };
  }
  if (normalized.includes('worker proof accepted') || normalized.includes('work result accepted')) {
    const event = acceptedWorkerProof(input.events);
    return {
      criterion,
      supported: true,
      passed: Boolean(event),
      reason: event ? 'worker-proof-accepted' : 'worker-proof-missing',
      eventSequence: event?.sequence ?? null,
    };
  }
  if (normalized.includes('queue empty') || normalized.includes('active queue empty')) {
    return {
      criterion,
      supported: true,
      passed: input.inventory.activeCount === 0,
      reason: input.inventory.activeCount === 0 ? 'queue-empty' : 'queue-active',
      activeCount: input.inventory.activeCount,
    };
  }
  return {
    criterion,
    supported: false,
    passed: false,
    reason: 'unsupported-criterion',
  };
}

async function validateGateNode(runRoot, config = {}, options = {}) {
  const criteria = stringArrayConfig(config.criteria, 'Gate.criteria');
  const onFail = config.onFail || 'block';
  if (!['block', 'warn', 'continue', 'continue-with-warning'].includes(onFail)) {
    throw machineExecutionError('MACHINE_GATE_CONFIG_INVALID', `Unsupported Gate onFail policy: ${onFail}`);
  }
  const events = await readMachineEvents(runRoot);
  const inventory = await summarizeQueueInventory(runRoot);
  const evaluations = criteria.map(criterion => evaluateGateCriterion(criterion, {
    events,
    inventory,
    taskText: options.taskText || '',
    externalResearch: options.externalResearch || null,
  }));
  const failed = evaluations.filter(entry => !entry.passed);
  const result = {
    valid: failed.length === 0,
    onFail,
    criteriaCount: criteria.length,
    inputCount: inputRefs(config).length,
    outputCount: outputRefs(config).length,
    evaluations,
    failed,
    inventory,
  };
  if (!result.valid && !['warn', 'continue', 'continue-with-warning'].includes(onFail)) {
    const err = machineExecutionError(
      'MACHINE_GATE_CRITERIA_UNMET',
      'Gate criteria are not satisfied by Machine-owned run evidence.',
    );
    err.gate = result;
    throw err;
  }
  return result;
}

function selectExternalResearchMode(input = {}) {
  const externalIntent = hasMachineExternalResearchIntent(input.taskText);
  if (!externalIntent) {
    return {
      selected: 'not-needed',
      selectedRoute: 'not-needed',
      source: 'task-intent',
      intentDetected: false,
      valid: true,
    };
  }
  const mode = input.externalResearch?.mode === 'approved-or-attached-evidence'
    ? 'approved-or-attached-evidence'
    : 'local-only-research-gap';
  return {
    selected: mode,
    selectedRoute: mode,
    source: input.externalResearch?.intentDetected === true ? 'user-prelaunch-choice' : 'safe-local-only-default',
    intentDetected: true,
    valid: true,
    localOnly: mode === 'local-only-research-gap',
  };
}

async function validateSelectorNode(runRoot, config = {}, options = {}) {
  const selectorKind = config.selector || config.selectorKind || config.modeSource || '';
  if (selectorKind === 'externalResearchMode') {
    return {
      selectorKind,
      options: Array.isArray(config.options) ? config.options : ['local-only-research-gap', 'approved-or-attached-evidence'],
      ...selectExternalResearchMode(options),
    };
  }
  const configuredOptions = Array.isArray(config.options) ? config.options.map(item => String(item || '').trim()).filter(Boolean) : [];
  const selected = String(config.selected || config.default || configuredOptions[0] || '').trim();
  return {
    selectorKind: selectorKind || 'static',
    options: configuredOptions,
    selected,
    selectedRoute: selected,
    source: selected ? 'config' : 'none',
    valid: Boolean(selected),
  };
}

async function executeSupportNode(runRoot, node, options = {}) {
  const { runId, attempt = 1 } = options;
  if (node.nodeType === 'orpad.patchReview') {
    return executePatchReviewNode(runRoot, node, options);
  }
  if (node.nodeType === 'orpad.exit') {
    return executeExitNode(runRoot, node, options);
  }
  return withNodeLifecycle(runRoot, node, {
    runId,
    attempt,
    completedPayload: result => result,
  }, async () => {
    const config = { ...(node.config || {}) };
    if (options.supportMode === 'live-adapter') {
      if (node.nodeType === 'orpad.gate' && !config.onFail) config.onFail = 'warn';
      if (node.nodeType === 'orpad.artifactContract' && !config.onMissing) config.onMissing = 'mark-partial';
    }
    if (node.nodeType === 'orpad.entry') {
      return {
        summary: config.summary || 'Run entered.',
        outputCount: outputRefs(config).length,
      };
    }
    if (node.nodeType === 'orpad.context') {
      return {
        summary: config.summary || '',
        outputCount: outputRefs(config).length,
      };
    }
    if (node.nodeType === 'orpad.workQueue') {
      const inventory = await summarizeQueueInventory(runRoot);
      return {
        queueRef: config.queueRef || '',
        schema: config.schema || '',
        inventory,
      };
    }
    if (node.nodeType === 'orpad.barrier') {
      return validateBarrierNode(runRoot, node, config);
    }
    if (node.nodeType === 'orpad.gate') {
      return validateGateNode(runRoot, config, options);
    }
    if (node.nodeType === 'orpad.selector') {
      return validateSelectorNode(runRoot, config, options);
    }
    if (node.nodeType === 'orpad.artifactContract') {
      return validateArtifactContract(runRoot, config);
    }
    if (node.nodeType === 'orpad.graph') {
      return {
        graphRef: config.graphRef || '',
        executionMode: config.executionMode || '',
        viewMode: config.viewMode || '',
      };
    }
    return {};
  });
}

function candidatesForProbeNode(probeNode, probeNodes, candidates) {
  const probePaths = new Set(probeNodes.map(node => node.nodePath));
  const matching = candidates.filter(candidate => candidate.sourceNode === probeNode.nodePath);
  if (matching.length) return matching;
  const hasAnyExplicitProbeMatch = candidates.some(candidate => probePaths.has(candidate.sourceNode));
  if (!hasAnyExplicitProbeMatch && probeNode.nodePath === probeNodes[0]?.nodePath) return candidates;
  return [];
}

function uniqueStrings(values = []) {
  return [...new Set(values
    .flat()
    .map(value => String(value || '').trim())
    .filter(Boolean))];
}

function evidenceIdsFromEvidence(evidence = []) {
  return uniqueStrings((Array.isArray(evidence) ? evidence : []).map((entry) => {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return '';
    return entry.id || entry.file || entry.path || '';
  }));
}

function candidateEvidenceIds(candidateProposal) {
  return uniqueStrings([
    candidateProposal.coverageEvidenceIds || [],
    evidenceIdsFromEvidence(candidateProposal.evidence || []),
    candidateProposal.proposalId || '',
    candidateProposal.suggestedWorkItemId || '',
  ]);
}

function inspectedTargets(targetIds, evidenceIds, status) {
  return targetIds.map(targetId => ({
    targetId,
    status,
    evidenceIds,
  }));
}

function candidateInventoryRowForProposal(probeEntry, candidateProposal) {
  const evidenceIds = candidateEvidenceIds(candidateProposal);
  const targetIds = uniqueStrings([
    candidateProposal.sourceOfTruthTargets || [],
    candidateProposal.sourceNode || '',
    probeEntry.nodePath || '',
  ]);
  const riskCheckIds = uniqueStrings([
    candidateProposal.coverageEvidenceIds || [],
    candidateProposal.fingerprint || '',
    candidateProposal.proposalId || candidateProposal.suggestedWorkItemId || '',
  ]);
  return {
    id: candidateProposal.proposalId || candidateProposal.suggestedWorkItemId,
    status: 'candidate',
    nodePath: probeEntry.nodePath,
    proposalId: candidateProposal.proposalId || '',
    suggestedWorkItemId: candidateProposal.suggestedWorkItemId || '',
    fingerprint: candidateProposal.fingerprint || '',
    title: candidateProposal.title || '',
    severity: candidateProposal.severity || '',
    confidence: candidateProposal.confidence ?? null,
    evidence: candidateProposal.evidence || [],
    evidenceIds,
    targetIds,
    riskCheckIds,
    checkResult: 'candidate',
    inspectedTargets: inspectedTargets(targetIds, evidenceIds, 'candidate-found'),
    sourceOfTruthTargets: candidateProposal.sourceOfTruthTargets || [],
  };
}

function emptyPassInventoryRow(probeEntry) {
  const resultEmptyPass = probeEntry.result?.emptyPass || {};
  const evidence = Array.isArray(resultEmptyPass.evidence) && resultEmptyPass.evidence.length
    ? resultEmptyPass.evidence
    : [`node:${probeEntry.nodePath}`];
  const evidenceIds = uniqueStrings([
    `node:${probeEntry.nodePath}`,
    evidenceIdsFromEvidence(evidence),
  ]);
  const targetIds = [`node:${probeEntry.nodePath}`];
  const riskCheckIds = [`risk-check:${idSegment(probeEntry.nodePath)}:no-candidate`];
  return {
    id: `empty-pass-${idSegment(probeEntry.nodePath)}`,
    status: 'empty-pass',
    nodePath: probeEntry.nodePath,
    reason: resultEmptyPass.reason || 'No deterministic harness candidate was assigned to this probe node.',
    evidence,
    evidenceIds,
    targetIds,
    riskCheckIds,
    checkResult: 'empty-pass',
    inspectedTargets: inspectedTargets(targetIds, evidenceIds, 'no-candidate-found'),
    negativeCheck: {
      method: 'candidate-proposal-result-count',
      expected: 'At least one candidate proposal should be returned when the probe finds actionable discovery coverage.',
      observed: `No candidate proposals were returned for probe node ${probeEntry.nodePath}.`,
      evidenceIds,
    },
  };
}

async function registerCandidateInventoryArtifact(runRoot, options = {}) {
  const {
    runId,
    probes = [],
    artifactPath = 'artifacts/discovery/candidate-inventory.json',
  } = options;
  const rows = [];
  for (const probeEntry of probes) {
    const proposals = probeEntry.candidateProposals || [];
    if (proposals.length) {
      rows.push(...proposals.map(candidateProposal => candidateInventoryRowForProposal(probeEntry, candidateProposal)));
    } else {
      rows.push(emptyPassInventoryRow(probeEntry));
    }
  }
  const events = await readMachineEvents(runRoot);
  const sourceEventSequence = events.length ? events[events.length - 1].sequence : 0;
  const inventory = {
    schemaVersion: MACHINE_CANDIDATE_INVENTORY_SCHEMA,
    runId,
    createdAt: new Date().toISOString(),
    sourceEventSequence,
    selectedProbeNodes: probes.map(probeEntry => probeEntry.nodePath),
    candidateCount: rows.filter(row => row.status === 'candidate').length,
    emptyPassCount: rows.filter(row => row.status === 'empty-pass').length,
    items: rows,
  };
  contractValidator.assertValid('candidateInventory', inventory);
  const artifact = await registerArtifact(runRoot, {
    runId,
    artifactPath,
    content: `${JSON.stringify(inventory, null, 2)}\n`,
    producedBy: 'orpad.machine.candidate-inventory',
    registeredBy: 'machine',
    schemaVersion: MACHINE_CANDIDATE_INVENTORY_SCHEMA,
  });
  return { artifact, inventory };
}

async function executeMachineRunStep(options = {}) {
  const {
    workspaceRoot,
    pipelinePath,
    pipelineDir = pipelinePath ? path.dirname(path.resolve(pipelinePath)) : '',
    runRoot,
    runId,
    exportLatestRunAfterStep = true,
    nodeExecutable = '',
    createWorkerCommandSpec = null,
    overlayRoot = '',
    overlayRootMode = 'run-root',
    dangerousSandboxBypassApproval = null,
    allowDangerousSandboxBypass = false,
    timeoutMs = 60_000,
    taskText = '',
    externalResearch = null,
    loadProviderKey = null,
    fetchImpl = null,
  } = options;
  if (!workspaceRoot) throw new Error('workspaceRoot is required.');
  if (!pipelinePath) throw new Error('pipelinePath is required.');
  if (!pipelineDir) throw new Error('pipelineDir is required.');
  if (!runRoot) throw new Error('runRoot is required.');
  if (!runId) throw new Error('runId is required.');

  await assertRunCanExecuteStep(runRoot);
  const graphSet = await loadPipelineGraphSet({ pipelinePath });
  const plan = buildTraversalPlan(graphSet);
  const orderedNodes = flattenTraversalNodes(plan);
  const pipeline = graphSet.pipeline || await readJsonFile(pipelinePath, 'Machine pipeline');
  const harnessSource = harnessFromPipeline(pipeline);
  const rawAdapterSource = machineAdapterFromPipeline(pipeline);
  const adapterOverrides = await readAdapterOverridesForPipeline(pipelinePath);
  const adapterSource = adapterOverrides
    ? applyAdapterOverridesToPipelineAdapter(rawAdapterSource, adapterOverrides)
    : rawAdapterSource;
  const hasHarness = Boolean(harnessSource);
  const hasLiveAdapter = isRunnableMachineAdapter(adapterSource);
  const usingLiveAdapter = !hasHarness && hasLiveAdapter;
  const runtimeTaskText = normalizeRuntimeTaskText(taskText);
  const runStateBeforeStep = await readRunState(runRoot);
  const runtimeExternalResearch = normalizeExternalResearchState(externalResearch)
    || normalizeExternalResearchState(runStateBeforeStep?.metadata?.externalResearch);
  if (!hasHarness && !hasLiveAdapter) {
    throw machineExecutionError(
      'MACHINE_EXECUTION_HARNESS_REQUIRED',
      'This execute step requires a deterministic run.machineHarness fixture or a runnable run.machineAdapter.',
    );
  }
  // Live API-family providers route the probe through plugin.invokeApi via the
  // router. Worker overlay execution is still CLI-only — when the lifted v2
  // envelope chose an API plugin, the worker site honest-fails with a clear
  // message so the user knows to switch back to a CLI provider for that step.
  let liveApiPlugin = null;
  if (hasLiveAdapter && !hasHarness) {
    const liveProviderId = resolveProviderIdFromAdapter(adapterSource);
    const livePlugin = liveProviderId ? getProviderPlugin(liveProviderId) : null;
    if (livePlugin && livePlugin.family === 'api') {
      const isStub = typeof livePlugin.invokeApi !== 'function'
        || String(livePlugin.implementationStatus || '').toLowerCase() === 'stub';
      if (isStub) {
        const overlaySource = adapterOverrides?.pipelineDefault?.providerId === liveProviderId
          ? `<pipeline-stem>.adapter-overrides.json`
          : 'pipeline.run.machineAdapter';
        throw machineExecutionError(
          'MACHINE_API_PLUGIN_STUB',
          `Provider plugin "${liveProviderId}" is registered as family:api but invokeApi is a stub (status: ${livePlugin.implementationStatus || 'unknown'}). `
            + `Override source: ${overlaySource}. Pick a different provider in the AI Provider picker.`,
        );
      }
      liveApiPlugin = livePlugin;
    }
  }
  const harness = hasHarness ? assertPlainObject(harnessSource, 'run.machineHarness') : null;
  const adapter = hasLiveAdapter ? assertPlainObject(adapterSource, 'run.machineAdapter') : null;
  const candidates = hasHarness ? candidateProposalsFromHarness(harness) : [];
  let expectedChangedFiles = hasHarness ? expectedChangedFilesFromHarness(harness, candidates) : [];
  const patchConfig = hasHarness ? assertPlainObject(harness.nodeCliPatch, 'machineHarness.nodeCliPatch') : null;
  if (hasHarness) {
    const patchFile = normalizeWriteSetPath(requiredString(patchConfig.file, 'machineHarness.nodeCliPatch.file'));
    if (!expectedChangedFiles.includes(patchFile)) {
      throw machineExecutionError(
        'MACHINE_EXECUTION_HARNESS_INVALID',
        'machineHarness.nodeCliPatch.file must be listed in expectedChangedFiles or candidate.sourceOfTruthTargets.',
      );
    }
  }

  const probeNodes = selectNodes(
    orderedNodes,
    'orpad.probe',
    hasHarness ? (harness.probeNodePaths || harness.probeNodePath) : adapterProbeNodePaths(adapter),
  );
  const triageNode = selectNode(orderedNodes, 'orpad.triage', hasHarness ? harness.triageNodePath : adapter.triageNodePath);
  const dispatcherNode = selectNode(orderedNodes, 'orpad.dispatcher', hasHarness ? harness.dispatcherNodePath : adapter.dispatcherNodePath);
  const workerNode = selectNode(orderedNodes, 'orpad.workerLoop', hasHarness ? harness.workerNodePath : adapter.workerNodePath);
  if (!probeNodes.length) {
    throw machineExecutionError('MACHINE_EXECUTION_NODE_NOT_FOUND', 'Machine graph harness could not find probeNode.');
  }
  const probeNode = probeNodes[0];
  const probeNodePaths = new Set(probeNodes.map(node => node.nodePath));
  const probeConcurrency = configuredProbeConcurrency(hasHarness ? harness : adapter, probeNodes.length);
  for (const [label, node] of Object.entries({ triageNode, dispatcherNode, workerNode })) {
    if (!node) throw machineExecutionError('MACHINE_EXECUTION_NODE_NOT_FOUND', `Machine graph harness could not find ${label}.`);
  }
  await appendRunLifecycleStatus(runRoot, {
    runId,
    toState: 'running',
    reason: 'machine-graph-step.start',
    payload: {
      selectedProbeNodes: probeNodes.map(node => node.nodePath),
      probeConcurrency,
      triageNode: triageNode.nodePath,
      dispatcherNode: dispatcherNode.nodePath,
      workerNode: workerNode.nodePath,
    },
  });

  const operationNodes = [...probeNodes, triageNode, dispatcherNode, workerNode];
  const supportNodes = supportNodesForExecution(orderedNodes, operationNodes);
  const executablePaths = new Set([
    ...operationNodes.map(node => node.nodePath),
    ...supportNodes.map(node => node.nodePath),
  ]);
  let probe = null;
  const probes = [];
  let triage = null;
  let claim = null;
  const claims = [];
  let worker = null;
  const workers = [];
  let workerLoop = null;
  let candidateInventory = null;
  const support = [];
  let blockedSupport = null;
  const initialEvents = await readMachineEvents(runRoot);
  const approvalGrants = summarizeApprovalsFromEvents(initialEvents)
    .all
    .filter(approval => approval.status === 'approved')
    .flatMap(approval => approval.grants || []);
  const resumeAfterApproval = approvalGrants.length > 0;
  const resumeAfterSupportBlock = hasUnresolvedSupportBlock(initialEvents, orderedNodes);
  let probeFanoutExecuted = false;
  const executeProbeNode = async (currentProbeNode) => {
    const attempt = nextNodeAttempt(initialEvents, currentProbeNode.nodePath);
    const harnessProbeCandidates = hasHarness
      ? candidatesForProbeNode(currentProbeNode, probeNodes, candidates)
      : [];
    const probeResult = await withNodeLifecycle(runRoot, currentProbeNode, {
      runId,
      attempt,
      completedPayload: result => ({
        proposalCount: result.proposals?.length || 0,
        summaryStatus: result.summaryStatus,
      }),
    }, () => (hasHarness
      ? runProposalProbe({
        runRoot,
        runId,
        nodePath: currentProbeNode.nodePath,
        workspaceRoot,
        fixtureResult: request => proposalResultForRequest(request, {
          summary: harnessProbeCandidates.length
            ? 'Machine graph probe produced harness candidate proposal.'
            : 'Machine graph probe completed with no harness candidate for this node.',
          candidateProposals: harnessProbeCandidates,
          ...(harnessProbeCandidates.length ? {} : {
            emptyPass: {
              reason: 'No deterministic harness candidate was assigned to this probe node.',
              evidence: [`node:${currentProbeNode.nodePath}`],
            },
          }),
        }),
      })
      : runProposalProbe({
        runRoot,
        runId,
        nodePath: currentProbeNode.nodePath,
        workspaceRoot,
        adapter: liveApiPlugin
          ? createApiProbeInvocationAdapter({
            plugin: liveApiPlugin,
            adapter,
            node: currentProbeNode,
            pipelinePath,
            pipeline,
            taskText: runtimeTaskText,
            externalResearch: runtimeExternalResearch,
            loadProviderKey,
            fetchImpl,
          })
          : getProviderPluginForAdapter(adapter).createProposalAdapter({
            runRoot,
            runId,
            workspaceRoot,
            command: adapter.command,
            commandPrefixArgs: adapter.commandPrefixArgs,
            sandbox: adapter.proposalSandbox || adapter.sandbox || 'read-only',
            approvalPolicy: adapter.approvalPolicy || 'never',
            timeoutMs: adapter.proposalTimeoutMs || timeoutMs,
            maxOutputBytes: 64 * 1024,
            ephemeral: adapter.ephemeral,
            prompt: request => liveProbePrompt({
              request,
              node: currentProbeNode,
              pipelinePath,
              pipeline,
              adapter,
              taskText: runtimeTaskText,
              externalResearch: runtimeExternalResearch,
            }),
          }),
      })));
    const probeCandidates = hasHarness
      ? harnessProbeCandidates
      : (probeResult.proposals || []).map(entry => candidateProposalFromWorkItem(entry.item)).filter(Boolean);
    return {
      nodePath: currentProbeNode.nodePath,
      candidateProposals: probeCandidates,
      result: probeResult,
    };
  };
  const candidateForClaim = currentClaim => {
    if (!hasHarness) return candidateProposalFromWorkItem(currentClaim.item);
    return candidates.find(candidate => candidate.suggestedWorkItemId === currentClaim.item?.id)
      || candidateProposalFromWorkItem(currentClaim.item)
      || candidates[0];
  };
  const executeWorkerClaim = async (currentClaim, workerIndex = 0) => {
    const adapterCallId = options.adapterCallId && workerIndex === 0
      ? options.adapterCallId
      : `${currentClaim.claim.claimId}-graph-cli`;
    const workerCandidate = candidateForClaim(currentClaim);
    const workerExpectedChangedFiles = hasHarness ? expectedChangedFiles : (currentClaim.writeSet?.paths || []);
    const adapterRequest = createAdapterRequest({
      adapter: 'cli-agent-overlay',
      runId,
      nodePath: workerNode.nodePath,
      taskKind: 'workerLoop',
      workspaceRoot,
      workspaceMode: 'read-only-plus-overlay',
      allowedFiles: currentClaim.writeSet.paths,
      inputArtifacts: [`queue/claimed/${currentClaim.item.id}.json`],
      outputContract: 'orpad.workerResult.v1',
      adapterCallId,
      attemptId: `${adapterCallId}-attempt-1`,
      idempotencyKey: `${adapterCallId}:attempt-1`,
    });
    adapterRequest.expectedChangedFiles = workerExpectedChangedFiles;
    adapterRequest.overlayRootMode = overlayRootMode === 'system-temp' ? 'system-temp' : 'run-root';
    adapterRequest.overlayRoot = overlayRoot
      || (adapterRequest.overlayRootMode === 'system-temp'
        ? await fsp.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-cli-overlay-'))
        : cliOverlayRoot(runRoot, adapterRequest));
    if (dangerousSandboxBypassApproval) {
      adapterRequest.dangerousSandboxBypassApproval = dangerousSandboxBypassApproval;
    }
    const commandSpec = createWorkerCommandSpec
      ? await createWorkerCommandSpec({
        request: adapterRequest,
        overlayRoot: adapterRequest.overlayRoot,
        claim: currentClaim,
        candidate: workerCandidate,
        workerNode,
        harness,
        patchConfig,
        taskText: runtimeTaskText,
        externalResearch: runtimeExternalResearch,
      })
      : (hasHarness
        ? nodeCliPatchCommandSpec(patchConfig, adapterRequest.overlayRoot, { nodeExecutable })
        : await liveWorkerCommandSpec({
          adapter,
          request: adapterRequest,
          overlayRoot: adapterRequest.overlayRoot,
          claim: currentClaim,
          candidate: workerCandidate,
          workerNode,
          runRoot,
          taskText: runtimeTaskText,
          externalResearch: runtimeExternalResearch,
        }));
    adapterRequest.commandSpec = {
      command: commandSpec.command,
      args: commandSpec.args,
      cwd: commandSpec.cwd,
    };
    adapterRequest.commandGrants = [createCommandGrant({
      ...adapterRequest.commandSpec,
      grantId: `grant-${adapterCallId}`,
      scope: 'machine-graph-harness',
      allowDangerousSandboxBypass: allowDangerousSandboxBypass === true,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      reason: 'explicit Machine graph harness command',
    })];
    return runWorkerLoopOnce({
      runRoot,
      runId,
      workspaceRoot,
      claim: currentClaim,
      request: adapterRequest,
      adapter: createCliAgentAdapter({
        enabled: true,
        runRoot,
        workspaceRoot,
        allowDangerousSandboxBypass: allowDangerousSandboxBypass === true,
        timeoutMs: hasHarness ? timeoutMs : (adapter.workerTimeoutMs || timeoutMs),
        maxOutputBytes: 64 * 1024,
        dangerousArgs: hasHarness
          ? undefined
          : (getProviderPluginForAdapter(adapter)?.dangerousArgs || undefined),
      }),
    });
  };
  const executeSerialWorkerLoop = async (dispatchAttempt) => {
    const machineConfig = hasHarness ? harness : adapter;
    const initialWorkerInventory = await summarizeQueueInventory(runRoot);
    const initialQueuedCount = initialWorkerInventory.counts.queued || candidateInventory?.inventory?.candidateCount || 1;
    const workerClaimLimit = configuredWorkerClaimLimit(
      machineConfig,
      initialQueuedCount,
    );
    const steps = [];
    let stopReason = 'claim-limit';
    for (let index = 0; index < workerClaimLimit; index += 1) {
      const currentClaim = await withNodeLifecycle(runRoot, dispatcherNode, {
        runId,
        attempt: dispatchAttempt + index,
        completedPayload: result => ({
          claimed: result.claimed === true,
          stopReason: result.stopReason || '',
          itemId: result.item?.id || '',
          claimIndex: index + 1,
        }),
      }, () => claimNextQueuedItem(runRoot, {
        runId,
        claimId: index === 0 ? options.claimId : undefined,
        leaseMs: usingLiveAdapter ? (adapter.claimLeaseMs || adapter.workerTimeoutMs || undefined) : undefined,
        approvalGrants,
      }));
      claim = currentClaim;
      if (!currentClaim?.claimed) {
        stopReason = currentClaim?.stopReason || 'not-claimed';
        break;
      }
      claims.push(currentClaim);

      const currentWorker = await withNodeLifecycle(runRoot, workerNode, {
        runId,
        attempt: nextNodeAttempt(await readMachineEvents(runRoot), workerNode.nodePath),
        completedPayload: result => ({
          workerStatus: result.result?.event?.payload?.status || '',
          itemId: currentClaim.item?.id || '',
          claimIndex: index + 1,
        }),
      }, () => executeWorkerClaim(currentClaim, index));
      worker = currentWorker;
      workers.push(currentWorker);
      steps.push({ claim: currentClaim, worker: currentWorker });

      if (shouldStopWorkerLoopAfterStep(currentWorker, machineConfig)) {
        stopReason = currentWorker.result?.event?.payload?.status || currentWorker.result?.toState || 'worker-stop';
        break;
      }
    }
    return {
      steps,
      stopReason,
      maxClaims: workerClaimLimit,
      initialQueuedCount,
      claimCount: claims.length,
      workerCount: workers.length,
    };
  };
  let workerLoopExecuted = false;

  // Index of the latest lifecycle event per nodePath — used to honor
  // user-initiated node.skipped decisions across run-steps. A node the
  // user explicitly skipped must NOT be re-evaluated by the dispatcher,
  // even for one-shot support gates (exit / artifactContract) that
  // would otherwise re-emit node.blocked at attempt N+1 and surface the
  // same gate card again immediately.
  const latestLifecycleByPath = latestLifecycleStatusByNode(initialEvents);

  for (const node of orderedNodes) {
    if (!executablePaths.has(node.nodePath)) continue;
    // User-skipped nodes are terminal for this run, regardless of node
    // type. This is what makes the Skip / Skip gate UI actions stick:
    // without it, the for-loop would re-enter the support node,
    // re-evaluate evidence, and re-emit node.blocked.
    if (latestLifecycleByPath.get(node.nodePath)?.eventType === 'node.skipped') continue;
    if (
      resumeAfterSupportBlock
      && latestNodeResolvedEvent(initialEvents, node.nodePath)
    ) {
      continue;
    }
    if (
      resumeAfterApproval
      && node.nodePath !== dispatcherNode.nodePath
      && node.nodePath !== workerNode.nodePath
      && latestNodeResolvedEvent(initialEvents, node.nodePath)
    ) {
      continue;
    }
    const attempt = nextNodeAttempt(initialEvents, node.nodePath);
    if (probeNodePaths.has(node.nodePath)) {
      if (!probeFanoutExecuted) {
        // Always exclude probes whose latest lifecycle event is already
        // node.completed or node.skipped. A user who clicks Skip on a
        // failing probe should not see it re-attempted (and re-failed) on
        // the next run-step — the skip is the user's terminal decision.
        const runnableProbeNodes = probeNodes.filter(probeEntry => (
          !latestNodeResolvedEvent(initialEvents, probeEntry.nodePath)
        ));
        if (runnableProbeNodes.length) {
          const probeResults = await mapWithConcurrency(runnableProbeNodes, probeConcurrency, executeProbeNode);
          probes.push(...probeResults);
          if (!probe && probeResults[0]) probe = probeResults[0].result;
        }
        probeFanoutExecuted = true;
      }
    } else if (node.nodePath === triageNode.nodePath) {
      candidateInventory = await registerCandidateInventoryArtifact(runRoot, {
        runId,
        probes,
      });
      const triageCandidates = hasHarness
        ? candidates
        : probes.flatMap(entry => entry.candidateProposals || []);
      triage = await withNodeLifecycle(runRoot, triageNode, {
        runId,
        attempt,
        completedPayload: result => ({
          triageTransitionCount: result.triage?.length || 0,
          summaryStatus: result.summaryStatus,
        }),
      }, () => runProposalTriage({
        runRoot,
        runId,
        nodePath: triageNode.nodePath,
        workspaceRoot,
        inputArtifacts: [candidateInventory.artifact.file.path],
        fixtureResult: request => proposalResultForRequest(request, {
          summary: hasHarness
            ? 'Machine graph triage accepted harness candidate.'
            : 'Machine graph triage queued live adapter candidates.',
          artifacts: [candidateInventory.artifact.file.path],
          triageTransitions: triageCandidates.map(candidateProposal => ({
            itemId: candidateProposal.suggestedWorkItemId,
            toState: 'queued',
            reason: hasHarness
              ? 'machine-graph-harness.triage.accepted'
              : 'machine-adapter.triage.accepted',
          })),
          ...(triageCandidates.length ? {} : {
            emptyPass: {
              reason: 'No live adapter candidates were available for triage.',
              evidence: [candidateInventory.artifact.file.path],
            },
          }),
        }),
      }));
    } else if (node.nodePath === dispatcherNode.nodePath) {
      if (!workerLoopExecuted) {
        workerLoop = await executeSerialWorkerLoop(attempt);
        workerLoopExecuted = true;
      }
      if (claim?.stopReason === 'approval-required') break;
    } else if (node.nodePath === workerNode.nodePath) {
      if (!workerLoopExecuted) {
        workerLoop = await executeSerialWorkerLoop(nextNodeAttempt(initialEvents, dispatcherNode.nodePath));
        workerLoopExecuted = true;
      }
    } else {
      const supportResult = await executeSupportNode(runRoot, node, {
        runId,
        attempt,
        supportMode: usingLiveAdapter ? 'live-adapter' : 'harness',
        taskText: runtimeTaskText,
        externalResearch: runtimeExternalResearch,
      });
      const supportEntry = {
        nodePath: node.nodePath,
        nodeType: node.nodeType,
        result: supportResult,
      };
      support.push(supportEntry);
      if (supportResult?.blocked) {
        blockedSupport = supportEntry;
        break;
      }
    }
  }

  const partialArtifactContracts = support
    .filter(entry => (
      entry.nodeType === 'orpad.artifactContract'
      && entry.result?.valid === false
      && entry.result?.onMissing === 'mark-partial'
    ))
    .map(entry => ({
      nodePath: entry.nodePath,
      missingArtifactCount: entry.result.missingArtifactCount,
      missingQueueCount: entry.result.missingQueueCount,
      missingArtifacts: entry.result.missingArtifacts,
      missingQueue: entry.result.missingQueue,
    }));
  let finalization = null;
  if (blockedSupport) {
    const inventory = await summarizeQueueInventory(runRoot);
    await appendRunLifecycleStatus(runRoot, {
      runId,
      toState: 'waiting',
      reason: blockedSupport.result?.reason || 'support-node.blocked',
      payload: {
        nodePath: blockedSupport.nodePath,
        nodeType: blockedSupport.nodeType,
        result: blockedSupport.result,
      },
    });
    const summaryStatus = blockedSupport.result?.summaryStatus || 'blocked';
    const runState = await appendRunSummaryStatus(runRoot, {
      runId,
      summaryStatus,
      reason: blockedSupport.result?.reason || 'support-node.blocked',
      payload: {
        nodePath: blockedSupport.nodePath,
        nodeType: blockedSupport.nodeType,
        result: blockedSupport.result,
      },
    });
    finalization = {
      inventory,
      summaryStatus,
      runState,
      supportBlocked: blockedSupport,
    };
  } else if (claim?.stopReason === 'approval-required') {
    const inventory = await summarizeQueueInventory(runRoot);
    finalization = {
      inventory,
      summaryStatus: 'blocked',
      runState: await readRunState(runRoot),
      approvalRequired: true,
      approval: claim.approval || null,
      ...(partialArtifactContracts.length ? {
        artifactContracts: {
          partial: true,
          contracts: partialArtifactContracts,
        },
      } : {}),
    };
  } else if (partialArtifactContracts.length) {
    const inventory = await summarizeQueueInventory(runRoot);
    await appendRunLifecycleStatus(runRoot, {
      runId,
      toState: 'waiting',
      reason: 'artifact-contract.mark-partial',
      payload: { artifactContracts: partialArtifactContracts },
    });
    const runState = await appendRunSummaryStatus(runRoot, {
      runId,
      summaryStatus: 'partial',
      reason: 'artifact-contract.mark-partial',
      payload: { artifactContracts: partialArtifactContracts },
    });
    finalization = {
      inventory,
      summaryStatus: 'partial',
      runState,
      artifactContracts: {
        partial: true,
        contracts: partialArtifactContracts,
      },
    };
  } else {
    finalization = await finalizeRunFromInventory(runRoot, {
      runId,
      reason: 'machine-graph-step.finalize',
    });
  }

  let exported = null;
  if (exportLatestRunAfterStep) {
    exported = await exportLatestRun({
      runRoot,
      pipelineDir,
      allowOverwrite: true,
    });
  }

  return {
    runId,
    graphPlan: plan,
    selectedNodes: {
      probe: probeNode.nodePath,
      triage: triageNode.nodePath,
      dispatcher: dispatcherNode.nodePath,
      worker: workerNode.nodePath,
    },
    selectedProbeNodes: probeNodes.map(node => node.nodePath),
    supportNodes: support.map(entry => ({
      nodePath: entry.nodePath,
      nodeType: entry.nodeType,
    })),
    probe,
    probes,
    candidateInventory: candidateInventory ? {
      artifactPath: candidateInventory.artifact.file.path,
      candidateCount: candidateInventory.inventory.candidateCount,
      emptyPassCount: candidateInventory.inventory.emptyPassCount,
    } : null,
    triage,
    claim,
    claims,
    worker,
    workers,
    workerLoop,
    finalization,
    exported,
    runState: await readRunState(runRoot),
    events: await readMachineEvents(runRoot),
  };
}

module.exports = {
  PIPELINE_ORCHESTRATION_FIELDS,
  applyAdapterOverridesToPipelineAdapter,
  batchApplyStateFromEvents,
  buildLiveWorkerPrompt,
  createApiProbeInvocationAdapter,
  executeMachineRunStep,
  effectiveProbeCandidateLimit,
  flattenTraversalNodes,
  harnessFromPipeline,
  isRunnableMachineAdapter,
  liveProbePrompt,
  liveWorkerCommandSpec,
  machineAdapterFromPipeline,
  patchReviewStateFromEvents,
  readAdapterOverridesForPipeline,
  registerCandidateInventoryArtifact,
  validateBarrierNode,
  validateArtifactContract,
  validateGateNode,
  validateSelectorNode,
  nodeCliPatchCommandSpec,
  nodeExecutableForHarness,
  proposalResultForRequest,
  selectNode,
  selectNodes,
  supportNodesForExecution,
};
