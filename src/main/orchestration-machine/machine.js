const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  cliOverlayRoot,
  codexCliCommand,
  codexCliExecArgs,
  codexCliInvocation,
  createCliAgentAdapter,
  createCodexCliProposalAdapter,
} = require('./adapters/cli-agent');
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
const SUPPORT_NODE_TYPES = new Set([
  'orpad.context',
  'orpad.workQueue',
  'orpad.gate',
  'orpad.barrier',
  'orpad.artifactContract',
  'orpad.graph',
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

function isRunnableMachineAdapter(adapter) {
  return adapter
    && typeof adapter === 'object'
    && !Array.isArray(adapter)
    && adapter.enabled !== false
    && adapter.type === 'codex-cli';
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

function liveProbePrompt(input = {}) {
  const { request, node, pipelinePath, pipeline, adapter } = input;
  const taskText = normalizeRuntimeTaskText(input.taskText);
  const candidateLimit = Number.isFinite(Number(adapter.candidateLimit))
    ? Math.max(0, Math.min(5, Math.trunc(Number(adapter.candidateLimit))))
    : 1;
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

async function codexCliWorkerCommandSpec(input = {}) {
  const {
    adapter,
    request,
    overlayRoot,
    claim,
    candidate,
    workerNode,
    runRoot,
  } = input;
  const taskText = normalizeRuntimeTaskText(input.taskText);
  const prompt = [
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
  const invocation = codexCliInvocation(adapter.command || codexCliCommand(), adapter.commandPrefixArgs);
  return {
    command: invocation.command,
    args: codexCliExecArgs({
      prefixArgs: invocation.prefixArgs,
      sandbox: adapter.workerSandbox || adapter.sandbox || 'workspace-write',
      approvalPolicy: adapter.approvalPolicy || 'never',
      prompt,
      ephemeral: adapter.ephemeral,
    }),
    cwd: overlayRoot,
  };
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
    await recordNodeLifecycleEvent(runRoot, {
      runId,
      nodePath: node.nodePath,
      nodeType: node.nodeType,
      attempt,
      status: 'failed',
      payload: {
        code: err?.code || 'MACHINE_NODE_FAILED',
        message: err?.message || String(err),
      },
    });
    throw err;
  }
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
    const completedEvent = latestNodeCompletedEvent(events, nodePath);
    return {
      ref,
      nodePath,
      completed: Boolean(completedEvent),
      eventSequence: completedEvent?.sequence ?? null,
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

async function validateGateNode(runRoot, config = {}) {
  const criteria = stringArrayConfig(config.criteria, 'Gate.criteria');
  const onFail = config.onFail || 'block';
  if (!['block', 'warn', 'continue', 'continue-with-warning'].includes(onFail)) {
    throw machineExecutionError('MACHINE_GATE_CONFIG_INVALID', `Unsupported Gate onFail policy: ${onFail}`);
  }
  const events = await readMachineEvents(runRoot);
  const inventory = await summarizeQueueInventory(runRoot);
  const evaluations = criteria.map(criterion => evaluateGateCriterion(criterion, { events, inventory }));
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

async function executeSupportNode(runRoot, node, options = {}) {
  const { runId, attempt = 1 } = options;
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
      return validateGateNode(runRoot, config);
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

function candidateInventoryRowForProposal(probeEntry, candidateProposal) {
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
    sourceOfTruthTargets: candidateProposal.sourceOfTruthTargets || [],
  };
}

function emptyPassInventoryRow(probeEntry) {
  return {
    id: `empty-pass-${idSegment(probeEntry.nodePath)}`,
    status: 'empty-pass',
    nodePath: probeEntry.nodePath,
    reason: 'No deterministic harness candidate was assigned to this probe node.',
    evidence: [`node:${probeEntry.nodePath}`],
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
  const adapterSource = machineAdapterFromPipeline(pipeline);
  const hasHarness = Boolean(harnessSource);
  const hasLiveAdapter = isRunnableMachineAdapter(adapterSource);
  const usingLiveAdapter = !hasHarness && hasLiveAdapter;
  const runtimeTaskText = normalizeRuntimeTaskText(taskText);
  if (!hasHarness && !hasLiveAdapter) {
    throw machineExecutionError(
      'MACHINE_EXECUTION_HARNESS_REQUIRED',
      'This execute step requires a deterministic run.machineHarness fixture or a runnable run.machineAdapter.',
    );
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
  const initialEvents = await readMachineEvents(runRoot);
  const approvalGrants = summarizeApprovalsFromEvents(initialEvents)
    .all
    .filter(approval => approval.status === 'approved')
    .flatMap(approval => approval.grants || []);
  const resumeAfterApproval = approvalGrants.length > 0;
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
        adapter: createCodexCliProposalAdapter({
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
      })
      : (hasHarness
        ? nodeCliPatchCommandSpec(patchConfig, adapterRequest.overlayRoot, { nodeExecutable })
        : await codexCliWorkerCommandSpec({
          adapter,
          request: adapterRequest,
          overlayRoot: adapterRequest.overlayRoot,
          claim: currentClaim,
          candidate: workerCandidate,
          workerNode,
          runRoot,
          taskText: runtimeTaskText,
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

  for (const node of orderedNodes) {
    if (!executablePaths.has(node.nodePath)) continue;
    if (
      resumeAfterApproval
      && node.nodePath !== dispatcherNode.nodePath
      && node.nodePath !== workerNode.nodePath
      && latestNodeCompletedEvent(initialEvents, node.nodePath)
    ) {
      continue;
    }
    const attempt = nextNodeAttempt(initialEvents, node.nodePath);
    if (probeNodePaths.has(node.nodePath)) {
      if (!probeFanoutExecuted) {
        const runnableProbeNodes = resumeAfterApproval
          ? probeNodes.filter(probeEntry => !latestNodeCompletedEvent(initialEvents, probeEntry.nodePath))
          : probeNodes;
        const probeResults = await mapWithConcurrency(runnableProbeNodes, probeConcurrency, executeProbeNode);
        probes.push(...probeResults);
        if (!probe && probeResults[0]) probe = probeResults[0].result;
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
      support.push({
        nodePath: node.nodePath,
        nodeType: node.nodeType,
        result: await executeSupportNode(runRoot, node, {
          runId,
          attempt,
          supportMode: usingLiveAdapter ? 'live-adapter' : 'harness',
        }),
      });
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
  if (claim?.stopReason === 'approval-required') {
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
  executeMachineRunStep,
  flattenTraversalNodes,
  harnessFromPipeline,
  registerCandidateInventoryArtifact,
  validateBarrierNode,
  validateArtifactContract,
  validateGateNode,
  nodeCliPatchCommandSpec,
  nodeExecutableForHarness,
  proposalResultForRequest,
  selectNode,
  selectNodes,
  supportNodesForExecution,
};
