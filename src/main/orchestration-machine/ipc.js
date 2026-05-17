const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { isInsidePath } = require('../authority');
const { validateRunbookFile } = require('../runbooks/validator');
const {
  approvalGrantForItem,
  recordApprovalDecision,
  summarizeApprovalsFromEvents,
} = require('./approvals');
const { readActiveClaimLeases } = require('./claims');
const { SCHEMA_VERSIONS } = require('./contracts');
const { readMachineEvents, projectRunStateFromEvents } = require('./events');
const { assertNoSymlinkInRunPath, assertRunRelativePath } = require('./artifacts');
const {
  applyPatchArtifact,
  inspectPatchBase,
  loadRunPatchArtifact: loadRegisteredRunPatchArtifact,
} = require('./patches');
const { recoverStaleClaims } = require('./dispatcher');
const { normalizeLockPath } = require('./file-lock-manager');
const { batchApplyStateFromEvents, executeMachineRunStep, patchReviewStateFromEvents } = require('./machine');
const { appendMachineEvent } = require('./events');
const {
  appendRunLifecycleStatus,
  appendRunSummaryStatus,
  resumeMachineRun,
  summarizeQueueInventory,
} = require('./lifecycle');
const {
  assertNoSymlinkInWorkspacePath,
  latestRunExportRoot,
  durableRunRoot,
} = require('./path-resolver');
const { createMachineRun, normalizeRunLlmApprovalMode, readRunState } = require('./run-store');
const { exportLatestRun } = require('./exporters/latest-run-exporter');
const { cancelClaimedItem, emitNodeCancelledForInflight } = require('./worker-loop');
const { readActiveWriteSetLocks } = require('./write-sets');
const { cancelMachineProcessRun } = require('./adapters/process-runner');
const {
  getProviderPlugin,
  hasProviderPlugin,
  listProviderPlugins,
} = require('./providers/registry');
const { getProviderEntry, listProviderEntries } = require('../../shared/ai/provider-catalog');
const { readBudgetLedger, summarizeLedger } = require('./router/budget-ledger');
const { recordNodeLifecycleEvent } = require('./node-lifecycle');

const fsp = fs.promises;

const MACHINE_IPC_CHANNELS = Object.freeze({
  status: 'machine-status',
  enableSession: 'machine-enable-session',
  validatePipeline: 'machine-validate-pipeline',
  createRun: 'machine-create-run',
  getRun: 'machine-get-run',
  listRuns: 'machine-list-runs',
  executeRunStep: 'machine-execute-run-step',
  resumeRun: 'machine-resume-run',
  cancelRun: 'machine-cancel-run',
  cancelClaim: 'machine-cancel-claim',
  decideApproval: 'machine-decide-approval',
  exportLatestRun: 'machine-export-latest-run',
  applyPatch: 'machine-apply-patch',
  approvePatch: 'machine-approve-patch',
  applyApprovedPatches: 'machine-apply-approved-patches',
  reviewPatch: 'machine-review-patch',
  listProviders: 'machine-list-providers',
  listModels: 'machine-list-models',
  setProviderSelection: 'machine-set-provider-selection',
  readBudgetLedger: 'machine-read-budget-ledger',
  skipNode: 'machine-skip-node',
  retryNode: 'machine-retry-node',
});

const APPLY_BATCH_MUTEXES = new Map();
const RUN_LIFECYCLE_QUEUE = new Map();
// Reference counter (not Set) so two queued+exclusive tasks for the same
// runRoot do not clobber each other's busy state when the inner task
// completes — Set.delete from one would falsely clear "busy" while the
// other is still running.
const RUN_LIFECYCLE_INFLIGHT = new Map();

function withRunRootQueue(map, runRoot, task) {
  const previous = map.get(runRoot) || Promise.resolve();
  const next = previous.then(task, task);
  // Track the latest tail so we can clean up the map entry once it
  // settles; otherwise long-lived processes leak one entry per distinct
  // runRoot they ever touch.
  const tail = next.catch(() => null);
  map.set(runRoot, tail);
  tail.then(() => {
    if (map.get(runRoot) === tail) map.delete(runRoot);
  });
  return next;
}

function withBatchApplyMutex(runRoot, task) {
  return withRunRootQueue(APPLY_BATCH_MUTEXES, runRoot, task);
}

function incrLifecycleInflight(runRoot) {
  RUN_LIFECYCLE_INFLIGHT.set(runRoot, (RUN_LIFECYCLE_INFLIGHT.get(runRoot) || 0) + 1);
}

function decrLifecycleInflight(runRoot) {
  const next = (RUN_LIFECYCLE_INFLIGHT.get(runRoot) || 0) - 1;
  if (next <= 0) RUN_LIFECYCLE_INFLIGHT.delete(runRoot);
  else RUN_LIFECYCLE_INFLIGHT.set(runRoot, next);
}

// Fail-fast lifecycle guard: rejects with MACHINE_RUN_BUSY when another
// mutating lifecycle handler (executeRunStep / resumeRun / skipNode) is
// already in flight OR queued for the same runRoot. Used to block
// accidental double clicks at the IPC layer in case the renderer's own
// pending guard is bypassed. Increments inflight counter EAGERLY so the
// next caller observes the busy state before it reaches the queue.
async function withRunLifecycleExclusive(runRoot, task) {
  if ((RUN_LIFECYCLE_INFLIGHT.get(runRoot) || 0) > 0) {
    throw machineError(
      'MACHINE_RUN_BUSY',
      'Another lifecycle operation is in progress for this run. Wait for it to finish before retrying.',
    );
  }
  incrLifecycleInflight(runRoot);
  try {
    return await withRunRootQueue(RUN_LIFECYCLE_QUEUE, runRoot, () => task());
  } finally {
    decrLifecycleInflight(runRoot);
  }
}

// Queued lifecycle guard: always runs, but waits for any in-flight
// exclusive task to finish first. Cancel paths must call
// cancelMachineProcessRun BEFORE acquiring this so the in-flight step's
// child processes are signalled and the queue drains quickly.
async function withRunLifecycleQueued(runRoot, task) {
  incrLifecycleInflight(runRoot);
  try {
    return await withRunRootQueue(RUN_LIFECYCLE_QUEUE, runRoot, () => task());
  } finally {
    decrLifecycleInflight(runRoot);
  }
}

function featureGateFromEnv(env = process.env) {
  return {
    enabled: env.ORPAD_MACHINE_IPC === '1',
    mutatingCapabilityToken: String(env.ORPAD_MACHINE_IPC_TOKEN || ''),
  };
}

function normalizeFeatureGate(featureGate = featureGateFromEnv()) {
  return {
    enabled: featureGate.enabled === true,
    mutatingCapabilityToken: String(featureGate.mutatingCapabilityToken || ''),
    enabledBy: featureGate.enabled === true ? 'environment' : 'disabled',
  };
}

function machineError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function rejectResponse(err) {
  return {
    success: false,
    ok: false,
    code: err?.code || 'MACHINE_IPC_REJECTED',
    error: err?.message || 'Machine IPC request was rejected.',
  };
}

function assertMachineGate(featureGate) {
  if (!featureGate.enabled) {
    throw machineError(
      'MACHINE_IPC_FEATURE_DISABLED',
      'Orchestration Machine IPC is behind the ORPAD_MACHINE_IPC feature gate.',
    );
  }
}

function assertSenderFrame(event) {
  if (!event?.sender) {
    throw machineError('MACHINE_IPC_SENDER_INVALID', 'Machine IPC sender is unavailable.');
  }
  const frameUrl = event?.senderFrame?.url;
  if (!frameUrl) {
    throw machineError('MACHINE_IPC_SENDER_FRAME_REQUIRED', 'Machine IPC requires senderFrame validation.');
  }
  let parsed;
  try {
    parsed = new URL(frameUrl);
  } catch {
    throw machineError('MACHINE_IPC_SENDER_FRAME_INVALID', 'Machine IPC senderFrame URL is invalid.');
  }
  if (parsed.protocol !== 'file:') {
    throw machineError('MACHINE_IPC_SENDER_FRAME_DENIED', 'Machine IPC accepts only OrPAD file:// renderer frames.');
  }
}

function assertPlainObject(value, label = 'Request') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw machineError('MACHINE_IPC_SCHEMA_INVALID', `${label} must be an object.`);
  }
  return value;
}

function optionalString(value, label) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') {
    throw machineError('MACHINE_IPC_SCHEMA_INVALID', `${label} must be a string.`);
  }
  return value;
}

function optionalTaskText(options) {
  return optionalString(options.taskText, 'options.taskText').trim().replace(/\s+/g, ' ').slice(0, 2000);
}

function optionalExternalResearch(options) {
  if (options.externalResearch == null) return null;
  return assertPlainObject(options.externalResearch, 'options.externalResearch');
}

function optionalLlmApprovalMode(options) {
  if (options.llmApprovalMode == null || options.llmApprovalMode === '') return 'ask';
  const mode = optionalString(options.llmApprovalMode, 'options.llmApprovalMode').trim().toLowerCase();
  if (mode !== 'ask' && mode !== 'bypass') {
    throw machineError('MACHINE_IPC_SCHEMA_INVALID', 'options.llmApprovalMode must be ask or bypass.');
  }
  return normalizeRunLlmApprovalMode(mode);
}

function optionalRunUntil(options) {
  if (options.runUntil == null || options.runUntil === '') return 'step';
  const mode = optionalString(options.runUntil, 'options.runUntil').trim().toLowerCase();
  if (!['step', 'human-decision'].includes(mode)) {
    throw machineError('MACHINE_IPC_SCHEMA_INVALID', 'options.runUntil must be step or human-decision.');
  }
  return mode;
}

function optionalPatchReviewMode(options) {
  if (options.patchReviewMode == null || options.patchReviewMode === '') return 'manual';
  const mode = optionalString(options.patchReviewMode, 'options.patchReviewMode').trim().toLowerCase();
  if (!['manual', 'auto-apply'].includes(mode)) {
    throw machineError('MACHINE_IPC_SCHEMA_INVALID', 'options.patchReviewMode must be manual or auto-apply.');
  }
  return mode;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw machineError('MACHINE_IPC_SCHEMA_INVALID', `${label} is required.`);
  }
  return value;
}

function assertRunId(value) {
  const runId = requiredString(value, 'runId').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(runId)) {
    throw machineError('MACHINE_IPC_SCHEMA_INVALID', 'runId contains unsupported characters.');
  }
  return runId;
}

function assertOpaqueId(value, label) {
  const id = requiredString(value, label).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,191}$/.test(id)) {
    throw machineError('MACHINE_IPC_SCHEMA_INVALID', `${label} contains unsupported characters.`);
  }
  return id;
}

function assertOptionalRunId(value) {
  if (value == null || value === '') return '';
  return assertRunId(value);
}

function assertApprovalDecision(value) {
  if (value !== 'approved' && value !== 'denied') {
    throw machineError('MACHINE_IPC_SCHEMA_INVALID', 'decision must be approved or denied.');
  }
  return value;
}

function assertMutatingCapability(request, featureGate) {
  const expected = featureGate.mutatingCapabilityToken;
  if (!expected) {
    throw machineError(
      'MACHINE_IPC_CAPABILITY_UNCONFIGURED',
      'Machine mutating IPC requires ORPAD_MACHINE_IPC_TOKEN to be configured.',
    );
  }
  if (request.capabilityToken !== expected) {
    throw machineError('MACHINE_IPC_CAPABILITY_DENIED', 'Machine mutating IPC capability token is invalid.');
  }
}

function assertBoolean(value, label, fallback = false) {
  if (value == null) return fallback;
  if (typeof value !== 'boolean') {
    throw machineError('MACHINE_IPC_SCHEMA_INVALID', `${label} must be a boolean.`);
  }
  return value;
}

function assertCancelToState(value) {
  if (value == null || value === '') return 'blocked';
  if (value !== 'queued' && value !== 'blocked') {
    throw machineError('MACHINE_IPC_SCHEMA_INVALID', 'toState must be queued or blocked.');
  }
  return value;
}

function normalizeTrustLevel(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return 'local-authored';
  return typeof options.trustLevel === 'string' ? options.trustLevel : 'local-authored';
}

function latestEvent(events, eventType, predicate = () => true) {
  return [...(events || [])].reverse().find(event => (
    event?.eventType === eventType
    && predicate(event)
  )) || null;
}

async function runRelativeArtifactPath(runRoot, artifactPath) {
  let safePath = '';
  try {
    safePath = assertRunRelativePath(artifactPath);
    await assertNoSymlinkInRunPath(runRoot, safePath);
  } catch {
    return '';
  }
  const absolutePath = path.resolve(runRoot, ...safePath.split('/'));
  return isInsidePath(absolutePath, path.resolve(runRoot)) ? absolutePath : '';
}

async function readCandidateInventorySummary(runRoot, events) {
  const event = latestEvent(events, 'artifact.registered', item => (
    item.payload?.file?.schemaVersion === SCHEMA_VERSIONS.candidateInventory
    || item.payload?.file?.producedBy === 'orpad.machine.candidate-inventory'
  ));
  const artifactPath = event?.payload?.file?.path || '';
  const absolutePath = await runRelativeArtifactPath(runRoot, artifactPath);
  if (!absolutePath) return null;
  try {
    const inventory = JSON.parse(await fsp.readFile(absolutePath, 'utf8'));
    return {
      artifactPath,
      candidateCount: Number(inventory?.candidateCount) || 0,
      emptyPassCount: Number(inventory?.emptyPassCount) || 0,
    };
  } catch {
    return { artifactPath, candidateCount: 0, emptyPassCount: 0, unreadable: true };
  }
}

function latestWorkerResult(events) {
  const event = latestEvent(events, 'worker.result');
  return event ? { event } : null;
}

async function resolveMachinePipelineContext(event, authority, request) {
  const workspacePath = optionalString(request.workspacePath, 'workspacePath');
  const requestedWorkspaceRoot = workspacePath || authority.getWorkspaceRoot(event.sender);
  const workspaceRoot = authority.assertWorkspacePath(event.sender, requestedWorkspaceRoot, {
    label: 'Machine workspace',
  });
  const pipelinePath = authority.assertWorkspacePath(event.sender, requiredString(request.pipelinePath, 'pipelinePath'), {
    label: 'Machine pipeline file',
  });
  if (!isInsidePath(pipelinePath, workspaceRoot)) {
    throw machineError('MACHINE_IPC_PATH_DENIED', 'Machine pipeline file must stay inside the Machine workspace.');
  }
  if (!/\.or-pipeline$/i.test(pipelinePath)) {
    throw machineError('MACHINE_IPC_SCHEMA_INVALID', 'Machine pipeline file must be an .or-pipeline file.');
  }
  await assertNoSymlinkInWorkspacePath(workspaceRoot, pipelinePath, {
    code: 'MACHINE_PIPELINE_SYMLINK_UNSAFE',
    label: 'Machine pipeline file',
  });
  return {
    workspaceRoot,
    pipelinePath,
    pipelineDir: path.dirname(pipelinePath),
  };
}

async function readRunSnapshot(runRoot) {
  const events = await readMachineEvents(runRoot);
  const storedRunState = await readRunState(runRoot);
  const projectedRunState = projectRunStateFromEvents(events);
  const runState = storedRunState && projectedRunState
    ? {
      ...projectedRunState,
      ...storedRunState,
      lifecycleStatus: projectedRunState.lifecycleStatus,
      summaryStatus: projectedRunState.summaryStatus,
      updatedAt: projectedRunState.updatedAt,
      eventSequence: projectedRunState.eventSequence,
      metadata: {
        ...(projectedRunState.metadata || {}),
        ...(storedRunState.metadata || {}),
      },
    }
    : storedRunState || projectedRunState;
  if (!runState) return null;
  return {
    runState,
    events,
    candidateInventory: await readCandidateInventorySummary(runRoot, events),
    worker: latestWorkerResult(events),
    approvals: summarizeApprovalsFromEvents(events),
    activeClaims: await readActiveClaimLeases(runRoot),
    activeWriteSets: await readActiveWriteSetLocks(runRoot),
  };
}

async function listRunSummaries(pipelineDir) {
  const runsRoot = path.join(pipelineDir, 'runs');
  let entries = [];
  try {
    entries = await fsp.readdir(runsRoot, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }

  const summaries = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runRoot = durableRunRoot(pipelineDir, entry.name);
    const snapshot = await readRunSnapshot(runRoot);
    if (!snapshot) continue;
    summaries.push({
      runId: snapshot.runState.runId,
      runRoot,
      lifecycleStatus: snapshot.runState.lifecycleStatus,
      summaryStatus: snapshot.runState.summaryStatus,
      createdAt: snapshot.runState.createdAt,
      updatedAt: snapshot.runState.updatedAt,
      eventSequence: snapshot.runState.eventSequence,
      pendingApprovalCount: snapshot.approvals.pendingCount,
      activeClaimCount: snapshot.activeClaims.length,
    });
  }
  return summaries.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function assertMachineRunStorePath(context, targetPath, label) {
  await assertNoSymlinkInWorkspacePath(context.workspaceRoot, targetPath, {
    code: 'MACHINE_RUN_ROOT_SYMLINK_UNSAFE',
    label,
  });
}

async function resolveMachineRunRoot(context, runId) {
  const runRoot = durableRunRoot(context.pipelineDir, runId);
  const runsRoot = path.join(context.pipelineDir, 'runs');
  if (!isInsidePath(runRoot, runsRoot)) {
    throw machineError('MACHINE_IPC_PATH_DENIED', 'Machine run must stay inside the pipeline runs directory.');
  }
  await assertMachineRunStorePath(context, runRoot, 'Machine run root');
  return runRoot;
}

async function validatePipelineHandler(event, authority, request) {
  const context = await resolveMachinePipelineContext(event, authority, request);
  const options = assertPlainObject(request.options == null ? {} : request.options, 'options');
  const validation = await validateRunbookFile(context.pipelinePath, {
    trustLevel: normalizeTrustLevel(options),
    checkFiles: options.checkFiles !== false,
  });
  return {
    success: true,
    ok: validation.ok,
    canMachineExecute: validation.canMachineExecute === true,
    canMachineExecuteStep: validation.canMachineExecuteStep === true,
    validation,
  };
}

async function createRunHandler(event, authority, request) {
  const context = await resolveMachinePipelineContext(event, authority, request);
  const options = assertPlainObject(request.options == null ? {} : request.options, 'options');
  const taskText = optionalTaskText(options);
  const externalResearch = optionalExternalResearch(options);
  const llmApprovalMode = optionalLlmApprovalMode(options);
  const validation = await validateRunbookFile(context.pipelinePath, {
    trustLevel: normalizeTrustLevel(options),
    checkFiles: options.checkFiles !== false,
  });
  if (!validation.ok || validation.canMachineExecute !== true) {
    return {
      success: false,
      ok: false,
      code: 'MACHINE_PIPELINE_NOT_EXECUTABLE',
      error: 'Pipeline is not Machine-executable.',
      validation,
    };
  }
  const run = await createMachineRun({
    workspaceRoot: context.workspaceRoot,
    pipelinePath: context.pipelinePath,
    runId: assertOptionalRunId(request.runId) || undefined,
    taskText,
    externalResearch,
    llmApprovalMode,
  });
  return {
    success: true,
    ok: true,
    runId: run.runId,
    runRoot: run.runRoot,
    latestRunExportPath: run.latestRunExportPath,
    runState: run.runState,
    validation,
  };
}

async function getRunHandler(event, authority, request) {
  const context = await resolveMachinePipelineContext(event, authority, request);
  const runId = assertRunId(request.runId);
  const runRoot = await resolveMachineRunRoot(context, runId);
  const snapshot = await readRunSnapshot(runRoot);
  if (!snapshot) {
    throw machineError('MACHINE_RUN_NOT_FOUND', 'Machine run was not found.');
  }
  return {
    success: true,
    ok: true,
    runId,
    runRoot,
    runState: snapshot.runState,
    events: snapshot.events,
    candidateInventory: snapshot.candidateInventory,
    worker: snapshot.worker,
    approvals: snapshot.approvals,
    activeClaims: snapshot.activeClaims,
    activeWriteSets: snapshot.activeWriteSets,
  };
}

async function listRunsHandler(event, authority, request) {
  const context = await resolveMachinePipelineContext(event, authority, request);
  await assertMachineRunStorePath(context, path.join(context.pipelineDir, 'runs'), 'Machine runs directory');
  return {
    success: true,
    ok: true,
    runs: await listRunSummaries(context.pipelineDir),
  };
}

async function exportLatestRunHandler(event, authority, request) {
  const context = await resolveMachinePipelineContext(event, authority, request);
  const runId = assertRunId(request.runId);
  const runRoot = await resolveMachineRunRoot(context, runId);
  const snapshot = await readRunSnapshot(runRoot);
  if (!snapshot) {
    throw machineError('MACHINE_RUN_NOT_FOUND', 'Machine run was not found.');
  }
  const exported = await exportLatestRun({
    runRoot,
    pipelineDir: context.pipelineDir,
    allowOverwrite: assertBoolean(request.allowOverwrite, 'allowOverwrite', false),
  });
  return {
    success: true,
    ok: true,
    runId,
    targetRoot: exported.targetRoot,
    latestRunExportPath: latestRunExportRoot(context.pipelineDir),
    metadata: exported.metadata,
  };
}

function normalizeSelectedFiles(value) {
  return Array.isArray(value)
    ? [...new Set(value
      .map(item => normalizeLockPath(optionalString(item, 'selectedFiles[]')))
      .filter(Boolean))]
      .sort()
    : [];
}

function sameSelectedFiles(left = [], right = []) {
  const normalizedLeft = normalizeSelectedFiles(left);
  const normalizedRight = normalizeSelectedFiles(right);
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((item, index) => item === normalizedRight[index]);
}

async function loadRunPatchArtifact(runRoot, patchArtifact) {
  try {
    return await loadRegisteredRunPatchArtifact(runRoot, patchArtifact);
  } catch (err) {
    throw machineError(
      err?.code || 'MACHINE_PATCH_ARTIFACT_DENIED',
      err?.message || 'Patch artifact path is not readable for this run.',
    );
  }
}

function selectPatchSubset(patch, selectedFiles) {
  const wanted = new Set((selectedFiles || []).map(file => normalizeLockPath(file)).filter(Boolean));
  const available = new Set((patch.changes || []).map(change => normalizeLockPath(change?.path)).filter(Boolean));
  const missing = [...wanted].filter(file => !available.has(file));
  if (missing.length) {
    throw machineError('MACHINE_PATCH_SELECTION_INVALID', `Patch selection includes unknown files: ${missing.join(', ')}`);
  }
  return {
    ...patch,
    changes: (patch.changes || []).filter(change => wanted.has(normalizeLockPath(change?.path))),
  };
}

function selectedFilesForLoadedPatch(patch, fallbackFiles = []) {
  const patchFiles = [...new Set((patch?.changes || [])
    .map(change => normalizeLockPath(change?.path))
    .filter(Boolean))].sort();
  if (patchFiles.length) return patchFiles;
  return [...new Set((Array.isArray(fallbackFiles) ? fallbackFiles : [])
    .map(file => normalizeLockPath(file))
    .filter(Boolean))].sort();
}

function approvalSnapshotForChanges(changes = []) {
  const snapshot = {};
  for (const change of changes) {
    if (!change?.path) continue;
    snapshot[change.path] = {
      beforeSha256: change.beforeSha256 || '',
      afterSha256: change.afterSha256 || '',
      beforeExists: change.beforeExists !== false,
      afterExists: change.afterExists !== false,
    };
  }
  return snapshot;
}

function approvedSelectedFileConflicts(reviewState, patchArtifact, selectedFiles) {
  const wanted = new Set(normalizeSelectedFiles(selectedFiles));
  const conflicts = [];
  for (const review of reviewState?.reviews || []) {
    if (!review?.patchArtifact || review.patchArtifact === patchArtifact) continue;
    if (review.status !== 'approved') continue;
    const files = Array.isArray(review.decision?.selectedFiles) && review.decision.selectedFiles.length
      ? review.decision.selectedFiles
      : review.changedFiles || [];
    for (const file of files) {
      const normalized = normalizeLockPath(file);
      if (!wanted.has(normalized)) continue;
      conflicts.push({
        path: normalized,
        patchArtifact: review.patchArtifact,
      });
    }
  }
  return conflicts;
}

function snapshotResponseFields(snapshot) {
  return {
    runState: snapshot.runState,
    events: snapshot.events,
    candidateInventory: snapshot.candidateInventory,
    worker: snapshot.worker,
    approvals: snapshot.approvals,
    activeClaims: snapshot.activeClaims,
    activeWriteSets: snapshot.activeWriteSets,
  };
}

async function applyOnePatchToWorkspace({
  workspaceRoot,
  runRoot,
  runId,
  patchArtifact,
  patch,
  selectedFiles,
  reason,
  actor = 'renderer',
}) {
  const selectedPatch = selectPatchSubset(patch, selectedFiles);
  try {
    const result = await applyPatchArtifact({
      workspaceRoot,
      patch: selectedPatch,
      allowedFiles: patch.allowedFiles || [],
      treatAlreadyAppliedAsSuccess: true,
    });
    const appliedEvent = await appendMachineEvent(runRoot, {
      runId,
      actor,
      eventType: 'patch.applied',
      reason,
      artifactRefs: [patchArtifact],
      payload: {
        patchArtifact,
        selectedFiles,
        applied: result.applied,
      },
    });
    return { ok: true, appliedEvent, applied: result.applied };
  } catch (err) {
    const isMismatch = err?.code === 'PATCH_BASE_MISMATCH';
    const eventType = isMismatch ? 'patch.apply_conflict' : 'patch.apply_failed';
    const conflictEvent = await appendMachineEvent(runRoot, {
      runId,
      actor,
      eventType,
      reason,
      artifactRefs: [patchArtifact],
      payload: {
        patchArtifact,
        selectedFiles,
        code: err?.code || 'MACHINE_PATCH_APPLY_FAILED',
        message: err?.message || 'Patch could not be applied.',
        path: err?.path || '',
        mismatches: Array.isArray(err?.mismatches) ? err.mismatches : [],
      },
    }).catch(() => null);
    return {
      ok: false,
      conflictEvent,
      code: err?.code || 'MACHINE_PATCH_APPLY_FAILED',
      message: err?.message || 'Patch could not be applied.',
      mismatches: Array.isArray(err?.mismatches) ? err.mismatches : [],
      path: err?.path || '',
      eventType,
    };
  }
}

async function applyPatchHandler(event, authority, request) {
  const context = await resolveMachinePipelineContext(event, authority, request);
  const runId = assertRunId(request.runId);
  const patchArtifact = requiredString(request.patchArtifact, 'patchArtifact').trim();
  const selectedFiles = normalizeSelectedFiles(request.selectedFiles);
  if (!selectedFiles.length) {
    throw machineError('MACHINE_PATCH_SELECTION_REQUIRED', 'Select at least one patch file to apply.');
  }
  const runRoot = await resolveMachineRunRoot(context, runId);
  const snapshot = await readRunSnapshot(runRoot);
  if (!snapshot) {
    throw machineError('MACHINE_RUN_NOT_FOUND', 'Machine run was not found.');
  }
  const patch = await loadRunPatchArtifact(runRoot, patchArtifact);
  const outcome = await withBatchApplyMutex(runRoot, () => applyOnePatchToWorkspace({
    workspaceRoot: context.workspaceRoot,
    runRoot,
    runId,
    patchArtifact,
    patch,
    selectedFiles,
    reason: 'machine-ui.patch-review.apply',
  }));
  const updated = await readRunSnapshot(runRoot) || snapshot;
  const exported = outcome.ok && request.exportLatestRun !== false
    ? await exportLatestRun({
      runRoot,
      pipelineDir: context.pipelineDir,
      allowOverwrite: true,
    })
    : null;
  if (!outcome.ok) {
    return {
      success: false,
      ok: false,
      code: outcome.code,
      error: outcome.message,
      runId,
      patchArtifact,
      selectedFiles,
      path: outcome.path,
      mismatches: outcome.mismatches,
      ...snapshotResponseFields(updated),
    };
  }
  return {
    success: true,
    ok: true,
    runId,
    patchArtifact,
    applied: outcome.applied,
    appliedEvent: outcome.appliedEvent,
    ...snapshotResponseFields(updated),
    exported,
  };
}

async function approvePatchHandler(event, authority, request) {
  const context = await resolveMachinePipelineContext(event, authority, request);
  const runId = assertRunId(request.runId);
  const patchArtifact = requiredString(request.patchArtifact, 'patchArtifact').trim();
  const selectedFiles = normalizeSelectedFiles(request.selectedFiles);
  if (!selectedFiles.length) {
    throw machineError('MACHINE_PATCH_SELECTION_REQUIRED', 'Select at least one patch file to approve.');
  }
  const runRoot = await resolveMachineRunRoot(context, runId);
  return withBatchApplyMutex(runRoot, async () => {
    const snapshot = await readRunSnapshot(runRoot);
    if (!snapshot) {
      throw machineError('MACHINE_RUN_NOT_FOUND', 'Machine run was not found.');
    }
    const patch = await loadRunPatchArtifact(runRoot, patchArtifact);
    const reviewState = patchReviewStateFromEvents(snapshot.events);
    const review = reviewState.reviews.find(item => item.patchArtifact === patchArtifact);
    if (review?.status === 'applied' || review?.status === 'skipped') {
      return {
        success: true,
        ok: true,
        runId,
        patchArtifact,
        idempotent: true,
        decision: review.status,
        ...snapshotResponseFields(snapshot),
      };
    }
    if (review?.status === 'approved' && sameSelectedFiles(review.decision?.selectedFiles, selectedFiles)) {
      return {
        success: true,
        ok: true,
        runId,
        patchArtifact,
        idempotent: true,
        decision: 'approved',
        selectedFiles,
        ...snapshotResponseFields(snapshot),
      };
    }
    // Validate selection up front so we fail before recording an unusable approval.
    const selectedPatch = selectPatchSubset(patch, selectedFiles);
    const overlapConflicts = approvedSelectedFileConflicts(reviewState, patchArtifact, selectedFiles);
    if (overlapConflicts.length) {
      return {
        success: false,
        ok: false,
        code: 'MACHINE_PATCH_APPROVAL_OVERLAP',
        error: `Selected files are already approved in another patch: ${overlapConflicts.map(item => item.path).join(', ')}`,
        runId,
        patchArtifact,
        selectedFiles,
        conflicts: overlapConflicts,
        ...snapshotResponseFields(snapshot),
      };
    }
    const base = await inspectPatchBase({
      workspaceRoot: context.workspaceRoot,
      patch: selectedPatch,
      allowedFiles: patch.allowedFiles || [],
    });
    const blockingMismatches = base.mismatches.filter(item => !item.alreadyApplied);
    if (blockingMismatches.length) {
      return {
        success: false,
        ok: false,
        code: 'PATCH_BASE_MISMATCH',
        error: `Patch base mismatch for ${blockingMismatches[0].path}.`,
        runId,
        patchArtifact,
        selectedFiles,
        path: blockingMismatches[0].path,
        mismatches: blockingMismatches,
        ...snapshotResponseFields(snapshot),
      };
    }
    const approvalSnapshot = approvalSnapshotForChanges(
      (patch.changes || []).filter(change => selectedFiles.includes(normalizeLockPath(change?.path))),
    );
    const approvedEvent = await appendMachineEvent(runRoot, {
      runId,
      actor: 'renderer',
      eventType: 'patch.approved',
      reason: 'machine-ui.patch-review.approve',
      artifactRefs: [patchArtifact],
      payload: {
        patchArtifact,
        selectedFiles,
        approvalSnapshot,
      },
    });
    const updated = await readRunSnapshot(runRoot) || snapshot;
    const exported = request.exportLatestRun === false
      ? null
      : await exportLatestRun({
        runRoot,
        pipelineDir: context.pipelineDir,
        allowOverwrite: true,
      });
    return {
      success: true,
      ok: true,
      runId,
      patchArtifact,
      approvedEvent,
      selectedFiles,
      ...snapshotResponseFields(updated),
      exported,
    };
  });
}

async function applyApprovedPatchesHandler(event, authority, request) {
  const context = await resolveMachinePipelineContext(event, authority, request);
  const runId = assertRunId(request.runId);
  const runRoot = await resolveMachineRunRoot(context, runId);
  return withBatchApplyMutex(runRoot, async () => {
    const snapshot = await readRunSnapshot(runRoot);
    if (!snapshot) {
      throw machineError('MACHINE_RUN_NOT_FOUND', 'Machine run was not found.');
    }
    const review = patchReviewStateFromEvents(snapshot.events);
    if (review.batch.inFlight) {
      return {
        success: false,
        ok: false,
        code: 'BATCH_APPLY_IN_FLIGHT',
        error: 'A batch apply is already in progress for this run.',
        runId,
        ...snapshotResponseFields(snapshot),
      };
    }
    const approvedReviews = review.reviews.filter(item => item.status === 'approved');
    if (!approvedReviews.length) {
      return {
        success: true,
        ok: true,
        runId,
        appliedCount: 0,
        conflictCount: 0,
        idempotent: true,
        results: [],
        ...snapshotResponseFields(snapshot),
        exported: null,
      };
    }

    const startedEvent = await appendMachineEvent(runRoot, {
      runId,
      actor: 'renderer',
      eventType: 'patches.apply_started',
      reason: 'machine-ui.patch-review.apply-approved',
      artifactRefs: approvedReviews.map(item => item.patchArtifact),
      payload: {
        approvedPatchArtifacts: approvedReviews.map(item => item.patchArtifact),
      },
    });

    const results = [];
    let appliedCount = 0;
    let conflictCount = 0;
    for (const item of approvedReviews) {
      const patchArtifact = item.patchArtifact;
      const selectedFiles = Array.isArray(item.decision?.selectedFiles) && item.decision.selectedFiles.length
        ? item.decision.selectedFiles
        : item.changedFiles;
      let patch;
      try {
        patch = await loadRunPatchArtifact(runRoot, patchArtifact);
      } catch (err) {
        const failedEvent = await appendMachineEvent(runRoot, {
          runId,
          actor: 'renderer',
          eventType: 'patch.apply_failed',
          reason: 'machine-ui.patch-review.apply-approved',
          artifactRefs: [patchArtifact],
          payload: {
            patchArtifact,
            selectedFiles,
            code: err?.code || 'MACHINE_PATCH_APPLY_FAILED',
            message: err?.message || 'Patch artifact could not be loaded.',
          },
        }).catch(() => null);
        results.push({
          patchArtifact,
          ok: false,
          code: err?.code || 'MACHINE_PATCH_APPLY_FAILED',
          message: err?.message || 'Patch artifact could not be loaded.',
          eventType: 'patch.apply_failed',
          event: failedEvent,
        });
        conflictCount += 1;
        continue;
      }
      const outcome = await applyOnePatchToWorkspace({
        workspaceRoot: context.workspaceRoot,
        runRoot,
        runId,
        patchArtifact,
        patch,
        selectedFiles,
        reason: 'machine-ui.patch-review.apply-approved',
      });
      if (outcome.ok) {
        appliedCount += 1;
        results.push({
          patchArtifact,
          ok: true,
          applied: outcome.applied,
          event: outcome.appliedEvent,
        });
      } else {
        conflictCount += 1;
        results.push({
          patchArtifact,
          ok: false,
          code: outcome.code,
          message: outcome.message,
          mismatches: outcome.mismatches,
          eventType: outcome.eventType,
          event: outcome.conflictEvent,
        });
      }
    }

    const finishedEvent = await appendMachineEvent(runRoot, {
      runId,
      actor: 'renderer',
      eventType: 'patches.apply_finished',
      reason: 'machine-ui.patch-review.apply-approved',
      artifactRefs: approvedReviews.map(item => item.patchArtifact),
      payload: {
        appliedCount,
        conflictCount,
        startedEventSequence: startedEvent?.sequence ?? null,
      },
    });

    const updated = await readRunSnapshot(runRoot) || snapshot;
    const exported = request.exportLatestRun === false
      ? null
      : await exportLatestRun({
        runRoot,
        pipelineDir: context.pipelineDir,
        allowOverwrite: true,
      });
    return {
      success: true,
      ok: true,
      runId,
      appliedCount,
      conflictCount,
      results,
      startedEvent,
      finishedEvent,
      ...snapshotResponseFields(updated),
      exported,
    };
  });
}

async function reviewPatchHandler(event, authority, request) {
  const context = await resolveMachinePipelineContext(event, authority, request);
  const runId = assertRunId(request.runId);
  const patchArtifact = requiredString(request.patchArtifact, 'patchArtifact').trim();
  const decision = optionalString(request.decision, 'decision').trim() || 'skipped';
  if (!['skipped', 'follow-up'].includes(decision)) {
    throw machineError('MACHINE_PATCH_REVIEW_DECISION_INVALID', 'Patch review decision must be skipped or follow-up.');
  }
  const runRoot = await resolveMachineRunRoot(context, runId);
  const patch = await loadRunPatchArtifact(runRoot, patchArtifact);
  const reviewedEvent = await appendMachineEvent(runRoot, {
    runId,
    actor: 'renderer',
    eventType: 'patch.review_skipped',
    reason: 'machine-ui.patch-review.skip',
    artifactRefs: [patchArtifact],
    payload: {
      patchArtifact,
      decision,
      changeCount: Array.isArray(patch.changes) ? patch.changes.length : 0,
    },
  });
  const updated = await readRunSnapshot(runRoot);
  const exported = request.exportLatestRun === false
    ? null
    : await exportLatestRun({
      runRoot,
      pipelineDir: context.pipelineDir,
      allowOverwrite: true,
    });
  return {
    success: true,
    ok: true,
    runId,
    patchArtifact,
    decision,
    reviewedEvent,
    runState: updated.runState,
    events: updated.events,
    candidateInventory: updated.candidateInventory,
    worker: updated.worker,
    approvals: updated.approvals,
    activeClaims: updated.activeClaims,
    activeWriteSets: updated.activeWriteSets,
    exported,
  };
}

async function decideApprovalHandler(event, authority, request) {
  const context = await resolveMachinePipelineContext(event, authority, request);
  const runId = assertRunId(request.runId);
  const approvalId = requiredString(request.approvalId, 'approvalId').trim();
  const decision = assertApprovalDecision(request.decision);
  const runRoot = await resolveMachineRunRoot(context, runId);
  const snapshot = await readRunSnapshot(runRoot);
  if (!snapshot) {
    throw machineError('MACHINE_RUN_NOT_FOUND', 'Machine run was not found.');
  }
  const pendingApproval = snapshot.approvals.pending.find(item => item.approvalId === approvalId);
  if (!pendingApproval) {
    throw machineError('MACHINE_APPROVAL_NOT_PENDING', 'Machine approval is not pending for this run.');
  }
  const grants = decision === 'approved'
    ? [approvalGrantForItem(pendingApproval.itemId, approvalId)]
    : [];
  const result = await recordApprovalDecision(runRoot, {
    runId,
    approvalId,
    decision,
    itemId: pendingApproval.itemId,
    grants,
    decidedBy: 'renderer',
    reason: `machine-ui.approval.${decision}`,
  });
  const updated = await readRunSnapshot(runRoot);
  const exported = request.exportLatestRun === false
    ? null
    : await exportLatestRun({
      runRoot,
      pipelineDir: context.pipelineDir,
      allowOverwrite: true,
    });
  return {
    success: true,
    ok: true,
    runId,
    decision,
    decisionEvent: result.event,
    grants,
    runState: updated.runState,
    events: updated.events,
    candidateInventory: updated.candidateInventory,
    worker: updated.worker,
    approvals: updated.approvals,
    activeClaims: updated.activeClaims,
    activeWriteSets: updated.activeWriteSets,
    exported,
  };
}

async function resumeRunHandler(event, authority, request) {
  const context = await resolveMachinePipelineContext(event, authority, request);
  const runId = assertRunId(request.runId);
  const runRoot = await resolveMachineRunRoot(context, runId);
  const snapshot = await readRunSnapshot(runRoot);
  if (!snapshot) {
    throw machineError('MACHINE_RUN_NOT_FOUND', 'Machine run was not found.');
  }

  return withRunLifecycleExclusive(runRoot, async () => {
    try {
      const resumed = await resumeMachineRun(runRoot, {
        runId,
        now: optionalString(request.now, 'now') || undefined,
        recoverStaleClaims,
      });
      const updated = await readRunSnapshot(runRoot);
      const exported = request.exportLatestRun === false
        ? null
        : await exportLatestRun({
          runRoot,
          pipelineDir: context.pipelineDir,
          allowOverwrite: true,
        });
      return {
        success: true,
        ok: true,
        runId,
        runState: updated.runState,
        events: updated.events,
        candidateInventory: updated.candidateInventory,
        worker: updated.worker,
        approvals: updated.approvals,
        activeClaims: updated.activeClaims,
        activeWriteSets: updated.activeWriteSets,
        resume: {
          queueRepair: resumed.queueRepair,
          staleClaimCount: resumed.staleClaims.length,
          inventory: resumed.inventory,
        },
        exported,
      };
    } catch (err) {
      const code = String(err?.code || '');
      if (code) {
        const failureSnapshot = await readRunSnapshot(runRoot) || snapshot;
        return {
          success: false,
          ok: false,
          code,
          error: err.message,
          runId,
          runState: failureSnapshot.runState,
          events: failureSnapshot.events,
          candidateInventory: failureSnapshot.candidateInventory,
          worker: failureSnapshot.worker,
          approvals: failureSnapshot.approvals,
          activeClaims: failureSnapshot.activeClaims,
          activeWriteSets: failureSnapshot.activeWriteSets,
        };
      }
      throw err;
    }
  });
}

async function cancelClaimHandler(event, authority, request) {
  // cancelMachineProcessRun must run BEFORE we wait on the lifecycle queue so
  // an in-flight executeRunStep's child process is signalled immediately and
  // the queue drains quickly. When cancelRunHandler delegates here it has
  // already issued the abort; honor its `_priorAbortedProcessCount` so we
  // don't double-call (which would falsely report 0 aborts).
  const earlyRunId = assertRunId(request.runId);
  const abortedProcessCount = typeof request._priorAbortedProcessCount === 'number'
    ? request._priorAbortedProcessCount
    : cancelMachineProcessRun(earlyRunId);
  const context = await resolveMachinePipelineContext(event, authority, request);
  const runId = earlyRunId;
  const claimId = assertOpaqueId(request.claimId, 'claimId');
  const itemId = assertOpaqueId(request.itemId, 'itemId');
  const toState = assertCancelToState(request.toState);
  const runRoot = await resolveMachineRunRoot(context, runId);
  const snapshot = await readRunSnapshot(runRoot);
  if (!snapshot) {
    throw machineError('MACHINE_RUN_NOT_FOUND', 'Machine run was not found.');
  }

  return withRunLifecycleQueued(runRoot, async () => {
    try {
      const cancelled = await cancelClaimedItem(runRoot, {
        runId,
        claimId,
        itemId,
        toState,
        now: optionalString(request.now, 'now') || undefined,
      });
      const updated = await readRunSnapshot(runRoot);
      const exported = request.exportLatestRun === false
        ? null
        : await exportLatestRun({
          runRoot,
          pipelineDir: context.pipelineDir,
          allowOverwrite: true,
        });
      return {
        success: true,
        ok: true,
        runId,
        runState: updated.runState,
        events: updated.events,
        candidateInventory: updated.candidateInventory,
        worker: updated.worker,
        approvals: updated.approvals,
        activeClaims: updated.activeClaims,
        activeWriteSets: updated.activeWriteSets,
        cancellation: {
          claimId,
          itemId,
          toState,
          abortedProcessCount,
          transition: cancelled.transition,
        },
        exported,
      };
    } catch (err) {
      const code = String(err?.code || '');
      if (code) {
        const failureSnapshot = await readRunSnapshot(runRoot) || snapshot;
        return {
          success: false,
          ok: false,
          code,
          error: err.message,
          runId,
          runState: failureSnapshot.runState,
          events: failureSnapshot.events,
          candidateInventory: failureSnapshot.candidateInventory,
          worker: failureSnapshot.worker,
          approvals: failureSnapshot.approvals,
          activeClaims: failureSnapshot.activeClaims,
          activeWriteSets: failureSnapshot.activeWriteSets,
        };
      }
      throw err;
    }
  });
}

async function cancelRunHandler(event, authority, request) {
  // Signal in-flight subprocesses BEFORE any await so they exit fast and the
  // lifecycle queue (held by an executeRunStep) drains.
  const earlyRunId = assertRunId(request.runId);
  const abortedProcessCount = cancelMachineProcessRun(earlyRunId);
  const context = await resolveMachinePipelineContext(event, authority, request);
  const runId = earlyRunId;
  const runRoot = await resolveMachineRunRoot(context, runId);
  const snapshot = await readRunSnapshot(runRoot);
  if (!snapshot) {
    throw machineError('MACHINE_RUN_NOT_FOUND', 'Machine run was not found.');
  }
  const firstClaim = (snapshot.activeClaims || [])[0] || null;
  if (firstClaim?.claimId && firstClaim?.itemId) {
    return cancelClaimHandler(event, authority, {
      ...request,
      claimId: firstClaim.claimId,
      itemId: firstClaim.itemId,
      toState: request.toState || 'blocked',
      _priorAbortedProcessCount: abortedProcessCount,
    });
  }
  return withRunLifecycleQueued(runRoot, async () => {
    // Surface node.cancelled for any node that was still in flight when the
    // user pressed Cancel — without this the renderer's runtime projection
    // (which filters on node.completed/failed/blocked/skipped/cancelled)
    // would keep a stale "Running" badge on a probe whose subprocess has
    // already been killed by cancelMachineProcessRun.
    const cancelledNodes = await emitNodeCancelledForInflight(
      runRoot,
      runId,
      'machine-ui.cancel-run',
    );
    await appendRunLifecycleStatus(runRoot, {
      runId,
      toState: 'cancelled',
      reason: 'machine-ui.cancel-run',
      payload: { abortedProcessCount, cancelledNodeCount: cancelledNodes.length },
    });
    await appendRunSummaryStatus(runRoot, {
      runId,
      summaryStatus: 'blocked',
      reason: 'machine-ui.cancel-run',
      payload: { abortedProcessCount, cancelledNodeCount: cancelledNodes.length },
    });
    const updated = await readRunSnapshot(runRoot);
    const exported = request.exportLatestRun === false
      ? null
      : await exportLatestRun({
        runRoot,
        pipelineDir: context.pipelineDir,
        allowOverwrite: true,
      });
    return {
      success: true,
      ok: true,
      runId,
      runState: updated.runState,
      events: updated.events,
      candidateInventory: updated.candidateInventory,
      worker: updated.worker,
      approvals: updated.approvals,
      activeClaims: updated.activeClaims,
      activeWriteSets: updated.activeWriteSets,
      cancellation: {
        runId,
        abortedProcessCount,
        toState: 'cancelled',
      },
      exported,
    };
  });
}

function runStateIsTerminal(runState = {}) {
  const lifecycle = String(runState.lifecycleStatus || '').toLowerCase();
  const summary = String(runState.summaryStatus || '').toLowerCase();
  return ['completed', 'cancelled', 'canceled', 'failed'].includes(lifecycle) || summary === 'done';
}

function pendingPatchDecisionReviews(events = []) {
  return patchReviewStateFromEvents(events).reviews.filter(review => (
    review?.patchArtifact
    && review.reviewRequired
    && !review.resolved
    && review.status !== 'approved'
  ));
}

function activeQueueCount(inventory = {}) {
  return Number(inventory.activeCount) || 0;
}

function hasBlockedPatchReviewNodeAwaitingResume(events = []) {
  const latestByPath = new Map();
  for (const event of events || []) {
    if (!String(event?.eventType || '').startsWith('node.')) continue;
    if (!event?.nodePath) continue;
    latestByPath.set(event.nodePath, event);
  }
  for (const event of latestByPath.values()) {
    if (event?.eventType === 'node.blocked'
        && event?.payload?.nodeType === 'orpad.patchReview') {
      return true;
    }
  }
  return false;
}

function autoDecisionStopReason(snapshot, inventory) {
  if (!snapshot) return 'missing-run';
  if (pendingPatchDecisionReviews(snapshot.events).length) return 'patch-review';
  if ((snapshot.approvals?.pending || []).length) return 'approval-required';
  if (runStateIsTerminal(snapshot.runState)) return 'terminal';
  const lifecycle = String(snapshot.runState?.lifecycleStatus || '').toLowerCase();
  if (activeQueueCount(inventory) <= 0 && ['waiting', 'approval-required'].includes(lifecycle)) {
    // A blocked patchReview node whose pending reviews are all now
    // resolved (no patch-review stop reason fired above) must be
    // re-attempted so the orchestrator can mark it completed and
    // finalize the run. Without this bypass the driver short-circuits
    // before executeMachineRunStep runs, and the run sits in waiting
    // forever even though there is no remaining decision to make.
    if (hasBlockedPatchReviewNodeAwaitingResume(snapshot.events)) {
      return '';
    }
    return 'no-active-work';
  }
  return '';
}

async function autoApprovePendingApprovals(runRoot, runId, approvals = []) {
  const decisions = [];
  for (const approval of approvals) {
    if (!approval?.approvalId || !approval?.itemId) continue;
    const result = await recordApprovalDecision(runRoot, {
      runId,
      approvalId: approval.approvalId,
      decision: 'approved',
      itemId: approval.itemId,
      grants: [approvalGrantForItem(approval.itemId, approval.approvalId)],
      decidedBy: 'machine-autonomous-driver',
      reason: 'machine-autonomous.approval.bypass',
    });
    decisions.push({
      approvalId: approval.approvalId,
      itemId: approval.itemId,
      eventSequence: result.event?.sequence ?? null,
    });
  }
  return decisions;
}

// Auto-Apply Patches mode: emits the same `patch.approved` →
// `patches.apply_started` → per-patch apply → `patches.apply_finished`
// event sequence that the renderer-driven Approve & Apply flow would
// produce, but originates from the autonomous driver instead of a UI
// click. Each pending review is approved over its full `changedFiles`
// set; base-mismatched patches fall through to `patch.apply_conflict`
// (same as the supervised path) so the run stays auditable.
async function autoApplyPendingPatches(runRoot, runId, context) {
  return withBatchApplyMutex(runRoot, async () => {
    const snapshot = await readRunSnapshot(runRoot);
    if (!snapshot) {
      return { approved: [], applied: [], conflicts: [], skipped: 'missing-run' };
    }
    const review = patchReviewStateFromEvents(snapshot.events);
    if (review.batch.inFlight) {
      return { approved: [], applied: [], conflicts: [], skipped: 'batch-in-flight' };
    }

    const approved = [];
    let workingReview = review;
    for (const item of review.reviews) {
      if (item.status !== 'pending') continue;
      const patchArtifact = item.patchArtifact;
      let patch;
      try {
        patch = await loadRunPatchArtifact(runRoot, patchArtifact);
      } catch (err) {
        approved.push({ patchArtifact, ok: false, code: err?.code || 'MACHINE_PATCH_LOAD_FAILED', message: err?.message || '' });
        continue;
      }
      const selectedFiles = selectedFilesForLoadedPatch(patch, item.changedFiles);
      if (!selectedFiles.length) continue;
      const overlap = approvedSelectedFileConflicts(workingReview, patchArtifact, selectedFiles);
      if (overlap.length) {
        approved.push({ patchArtifact, ok: false, code: 'MACHINE_PATCH_APPROVAL_OVERLAP', conflicts: overlap });
        continue;
      }
      const selectedPatch = selectPatchSubset(patch, selectedFiles);
      const base = await inspectPatchBase({
        workspaceRoot: context.workspaceRoot,
        patch: selectedPatch,
        allowedFiles: patch.allowedFiles || [],
      });
      const blocking = base.mismatches.filter(entry => !entry.alreadyApplied);
      if (blocking.length) {
        approved.push({ patchArtifact, ok: false, code: 'PATCH_BASE_MISMATCH', mismatches: blocking });
        continue;
      }
      const approvalSnapshot = approvalSnapshotForChanges(
        selectedPatch.changes || [],
      );
      const approvedEvent = await appendMachineEvent(runRoot, {
        runId,
        actor: 'machine-autonomous-driver',
        eventType: 'patch.approved',
        reason: 'machine-autonomous.patch-review.auto-apply',
        artifactRefs: [patchArtifact],
        payload: { patchArtifact, selectedFiles, approvalSnapshot },
      });
      approved.push({ patchArtifact, ok: true, selectedFiles, eventSequence: approvedEvent?.sequence ?? null });
      const refreshed = await readRunSnapshot(runRoot);
      if (refreshed) workingReview = patchReviewStateFromEvents(refreshed.events);
    }

    const postApproveSnapshot = await readRunSnapshot(runRoot);
    const postApproveReview = postApproveSnapshot
      ? patchReviewStateFromEvents(postApproveSnapshot.events)
      : workingReview;
    const approvedReviews = postApproveReview.reviews.filter(entry => entry.status === 'approved');
    if (!approvedReviews.length) {
      return { approved, applied: [], conflicts: [], skipped: 'no-approved' };
    }

    const startedEvent = await appendMachineEvent(runRoot, {
      runId,
      actor: 'machine-autonomous-driver',
      eventType: 'patches.apply_started',
      reason: 'machine-autonomous.patch-review.auto-apply',
      artifactRefs: approvedReviews.map(entry => entry.patchArtifact),
      payload: { approvedPatchArtifacts: approvedReviews.map(entry => entry.patchArtifact) },
    });

    const applied = [];
    const conflicts = [];
    for (const entry of approvedReviews) {
      const patchArtifact = entry.patchArtifact;
      const fallbackSelectedFiles = Array.isArray(entry.decision?.selectedFiles) && entry.decision.selectedFiles.length
        ? entry.decision.selectedFiles
        : entry.changedFiles;
      let patch;
      try {
        patch = await loadRunPatchArtifact(runRoot, patchArtifact);
      } catch (err) {
        await appendMachineEvent(runRoot, {
          runId,
          actor: 'machine-autonomous-driver',
          eventType: 'patch.apply_failed',
          reason: 'machine-autonomous.patch-review.auto-apply',
          artifactRefs: [patchArtifact],
          payload: {
            patchArtifact,
            selectedFiles: fallbackSelectedFiles,
            code: err?.code || 'MACHINE_PATCH_APPLY_FAILED',
            message: err?.message || 'Patch artifact could not be loaded.',
          },
        }).catch(() => null);
        conflicts.push({ patchArtifact, ok: false, code: err?.code || 'MACHINE_PATCH_APPLY_FAILED', message: err?.message || '' });
        continue;
      }
      const selectedFiles = selectedFilesForLoadedPatch(
        patch,
        fallbackSelectedFiles,
      );
      const outcome = await applyOnePatchToWorkspace({
        workspaceRoot: context.workspaceRoot,
        runRoot,
        runId,
        patchArtifact,
        patch,
        selectedFiles,
        reason: 'machine-autonomous.patch-review.auto-apply',
        actor: 'machine-autonomous-driver',
      });
      if (outcome.ok) {
        applied.push({ patchArtifact, applied: outcome.applied });
      } else {
        conflicts.push({ patchArtifact, ok: false, code: outcome.code, message: outcome.message, mismatches: outcome.mismatches });
      }
    }

    await appendMachineEvent(runRoot, {
      runId,
      actor: 'machine-autonomous-driver',
      eventType: 'patches.apply_finished',
      reason: 'machine-autonomous.patch-review.auto-apply',
      artifactRefs: approvedReviews.map(entry => entry.patchArtifact),
      payload: {
        appliedCount: applied.length,
        conflictCount: conflicts.length,
        startedEventSequence: startedEvent?.sequence ?? null,
      },
    });

    return { approved, applied, conflicts, skipped: '' };
  });
}

function driveResponseFields({ steps = [], autoApprovedApprovals = [], autoAppliedPatchBatches = [], stopReason = '', maxSteps = 0 } = {}) {
  const autoAppliedPatches = autoAppliedPatchBatches.flatMap(batch => batch.applied || []);
  const autoApplyConflicts = autoAppliedPatchBatches.flatMap(batch => batch.conflicts || []);
  return {
    mode: 'human-decision',
    stepsRun: steps.length,
    maxSteps,
    stopReason,
    autoApprovedApprovalCount: autoApprovedApprovals.length,
    autoApprovedApprovals,
    autoAppliedPatchCount: autoAppliedPatches.length,
    autoAppliedPatches,
    autoApplyConflictCount: autoApplyConflicts.length,
    autoApplyConflicts,
  };
}

async function executeMachineRunToHumanDecision({
  context,
  runRoot,
  runId,
  request,
  taskText,
  externalResearch,
  llmApprovalMode,
  patchReviewMode,
  runtimeOptions,
}) {
  const maxSteps = Math.max(1, Math.min(50, Number(request.options?.maxAutonomousSteps) || 20));
  const steps = [];
  const autoApprovedApprovals = [];
  const autoAppliedPatchBatches = [];
  let lastStep = null;
  let stopReason = '';

  for (let index = 0; index < maxSteps; index += 1) {
    let snapshot = await readRunSnapshot(runRoot);
    const inventory = await summarizeQueueInventory(runRoot);
    stopReason = autoDecisionStopReason(snapshot, inventory);
    if (stopReason === 'approval-required' && llmApprovalMode === 'bypass') {
      const decisions = await autoApprovePendingApprovals(runRoot, runId, snapshot.approvals.pending || []);
      autoApprovedApprovals.push(...decisions);
      snapshot = await readRunSnapshot(runRoot);
      const afterApprovalInventory = await summarizeQueueInventory(runRoot);
      stopReason = autoDecisionStopReason(snapshot, afterApprovalInventory);
      if (stopReason === 'approval-required') break;
    }
    if (stopReason === 'patch-review' && patchReviewMode === 'auto-apply') {
      const batch = await autoApplyPendingPatches(runRoot, runId, context);
      autoAppliedPatchBatches.push(batch);
      // Stop if no patches were actually applied this cycle — prevents
      // an infinite loop when every pending review is blocked by base
      // mismatch, missing artifact, or already-in-flight apply.
      if (!batch.applied.length) break;
      snapshot = await readRunSnapshot(runRoot);
      const afterPatchInventory = await summarizeQueueInventory(runRoot);
      stopReason = autoDecisionStopReason(snapshot, afterPatchInventory);
      if (stopReason === 'patch-review') break;
    }
    if (stopReason) break;

    const beforeSequence = Number(snapshot?.runState?.eventSequence ?? snapshot?.events?.at?.(-1)?.sequence ?? 0);
    lastStep = await executeMachineRunStep({
      workspaceRoot: context.workspaceRoot,
      pipelinePath: context.pipelinePath,
      pipelineDir: context.pipelineDir,
      runRoot,
      runId,
      exportLatestRunAfterStep: request.exportLatestRun !== false,
      taskText,
      externalResearch,
      llmApprovalMode,
      loadProviderKey: runtimeOptions?.loadProviderKey || null,
      fetchImpl: runtimeOptions?.fetchImpl || null,
    });
    steps.push(lastStep);

    snapshot = await readRunSnapshot(runRoot);
    const afterSequence = Number(snapshot?.runState?.eventSequence ?? snapshot?.events?.at?.(-1)?.sequence ?? 0);
    if (afterSequence <= beforeSequence) {
      stopReason = 'no-progress';
      break;
    }
  }

  if (!stopReason) {
    const snapshot = await readRunSnapshot(runRoot);
    const inventory = await summarizeQueueInventory(runRoot);
    stopReason = autoDecisionStopReason(snapshot, inventory) || 'max-steps';
  }

  return {
    ...(lastStep || {}),
    drive: driveResponseFields({
      steps,
      autoApprovedApprovals,
      autoAppliedPatchBatches,
      stopReason,
      maxSteps,
    }),
  };
}

async function executeRunStepWithHarnessHandler(event, authority, request, runtimeOptions = {}) {
  const context = await resolveMachinePipelineContext(event, authority, request);
  const runId = assertRunId(request.runId);
  const options = assertPlainObject(request.options == null ? {} : request.options, 'options');
  const taskText = optionalTaskText(options);
  const externalResearch = optionalExternalResearch(options);
  const llmApprovalMode = optionalLlmApprovalMode(options);
  const runUntil = optionalRunUntil(options);
  const patchReviewMode = optionalPatchReviewMode(options);
  const runRoot = await resolveMachineRunRoot(context, runId);
  const snapshot = await readRunSnapshot(runRoot);
  if (!snapshot) {
    throw machineError('MACHINE_RUN_NOT_FOUND', 'Machine run was not found.');
  }

  return withRunLifecycleExclusive(runRoot, async () => {
    try {
      const executed = runUntil === 'human-decision'
        ? await executeMachineRunToHumanDecision({
          context,
          runRoot,
          runId,
          request,
          taskText,
          externalResearch,
          llmApprovalMode,
          patchReviewMode,
          runtimeOptions,
        })
        : await executeMachineRunStep({
          workspaceRoot: context.workspaceRoot,
          pipelinePath: context.pipelinePath,
          pipelineDir: context.pipelineDir,
          runRoot,
          runId,
          exportLatestRunAfterStep: request.exportLatestRun !== false,
          taskText,
          externalResearch,
          llmApprovalMode,
          loadProviderKey: runtimeOptions?.loadProviderKey || null,
          fetchImpl: runtimeOptions?.fetchImpl || null,
        });
      const updatedSnapshot = await readRunSnapshot(runRoot);
      return {
        success: true,
        ok: true,
        runId,
        runState: updatedSnapshot?.runState || executed.runState,
        events: updatedSnapshot?.events || executed.events,
        graphPlan: executed.graphPlan,
        selectedNodes: executed.selectedNodes,
        selectedProbeNodes: executed.selectedProbeNodes,
        supportNodes: executed.supportNodes,
        candidateInventory: executed.candidateInventory || updatedSnapshot?.candidateInventory || null,
        worker: executed.worker?.result || updatedSnapshot?.worker || null,
        finalization: executed.finalization,
        exported: executed.exported,
        drive: executed.drive || { mode: 'step', stepsRun: 1, stopReason: 'step-complete' },
        approvals: updatedSnapshot?.approvals || summarizeApprovalsFromEvents(executed.events),
        activeClaims: updatedSnapshot?.activeClaims || [],
        activeWriteSets: updatedSnapshot?.activeWriteSets || [],
      };
    } catch (err) {
      const code = String(err?.code || '');
      if (code) {
        const failureSnapshot = await readRunSnapshot(runRoot) || snapshot;
        return {
          success: false,
          ok: false,
          code,
          error: err.message,
          runId,
          runState: failureSnapshot.runState,
          events: failureSnapshot.events,
          candidateInventory: failureSnapshot.candidateInventory,
          worker: failureSnapshot.worker,
          approvals: failureSnapshot.approvals,
          activeClaims: failureSnapshot.activeClaims,
          activeWriteSets: failureSnapshot.activeWriteSets,
          failure: {
            contract: err.contract || null,
            barrier: err.barrier || null,
            gate: err.gate || null,
          },
        };
      }
      throw err;
    }
  });
}

function createSessionCapabilityToken() {
  return `orpad-session-${crypto.randomBytes(18).toString('base64url')}`;
}

function registerMachineHandlers({
  ipcMain,
  authority,
  featureGate = featureGateFromEnv(),
  allowSessionEnable = false,
  loadProviderKey = null,
  fetchImpl = null,
} = {}) {
  if (!ipcMain?.handle) throw new Error('ipcMain.handle is required.');
  if (!authority) throw new Error('Machine IPC requires an authority manager.');

  const gate = normalizeFeatureGate(featureGate);
  const sessionEnableAllowed = allowSessionEnable === true;
  let sessionCapabilityToken = '';
  const machineRuntimeOptions = { loadProviderKey, fetchImpl };

  function handle(channel, handler, { mutating = false } = {}) {
    ipcMain.handle(channel, async (event, request = {}) => {
      try {
        assertSenderFrame(event);
        assertMachineGate(gate);
        assertPlainObject(request);
        if (mutating) assertMutatingCapability(request, gate);
        return await handler(event, authority, request, machineRuntimeOptions);
      } catch (err) {
        return rejectResponse(err);
      }
    });
  }

  ipcMain.handle(MACHINE_IPC_CHANNELS.status, async (event) => {
    try {
      assertSenderFrame(event);
      return {
        success: true,
        ok: true,
        enabled: gate.enabled,
        mutatingCapabilityConfigured: !!gate.mutatingCapabilityToken,
        sessionEnableAvailable: sessionEnableAllowed,
        enabledBy: gate.enabledBy,
      };
    } catch (err) {
      return rejectResponse(err);
    }
  });
  ipcMain.handle(MACHINE_IPC_CHANNELS.enableSession, async (event) => {
    try {
      assertSenderFrame(event);
      if (!sessionEnableAllowed) {
        throw machineError(
          'MACHINE_IPC_SESSION_ENABLE_UNAVAILABLE',
          'Managed runs cannot be enabled from this session. Relaunch OrPAD with managed-run support enabled.',
        );
      }
      gate.enabled = true;
      gate.enabledBy = 'session';
      if (!gate.mutatingCapabilityToken) {
        sessionCapabilityToken = createSessionCapabilityToken();
        gate.mutatingCapabilityToken = sessionCapabilityToken;
      }
      return {
        success: true,
        ok: true,
        enabled: gate.enabled,
        mutatingCapabilityConfigured: !!gate.mutatingCapabilityToken,
        sessionEnableAvailable: sessionEnableAllowed,
        enabledBy: gate.enabledBy,
        capabilityToken: sessionCapabilityToken || undefined,
      };
    } catch (err) {
      return rejectResponse(err);
    }
  });
  handle(MACHINE_IPC_CHANNELS.validatePipeline, validatePipelineHandler);
  handle(MACHINE_IPC_CHANNELS.createRun, createRunHandler, { mutating: true });
  handle(MACHINE_IPC_CHANNELS.getRun, getRunHandler);
  handle(MACHINE_IPC_CHANNELS.listRuns, listRunsHandler);
  handle(MACHINE_IPC_CHANNELS.executeRunStep, executeRunStepWithHarnessHandler, { mutating: true });
  handle(MACHINE_IPC_CHANNELS.resumeRun, resumeRunHandler, { mutating: true });
  handle(MACHINE_IPC_CHANNELS.cancelRun, cancelRunHandler, { mutating: true });
  handle(MACHINE_IPC_CHANNELS.cancelClaim, cancelClaimHandler, { mutating: true });
  handle(MACHINE_IPC_CHANNELS.decideApproval, decideApprovalHandler, { mutating: true });
  handle(MACHINE_IPC_CHANNELS.exportLatestRun, exportLatestRunHandler, { mutating: true });
  handle(MACHINE_IPC_CHANNELS.applyPatch, applyPatchHandler, { mutating: true });
  handle(MACHINE_IPC_CHANNELS.approvePatch, approvePatchHandler, { mutating: true });
  handle(MACHINE_IPC_CHANNELS.applyApprovedPatches, applyApprovedPatchesHandler, { mutating: true });
  handle(MACHINE_IPC_CHANNELS.reviewPatch, reviewPatchHandler, { mutating: true });
  handle(MACHINE_IPC_CHANNELS.listProviders, listProvidersHandler);
  handle(MACHINE_IPC_CHANNELS.listModels, listModelsHandler);
  handle(MACHINE_IPC_CHANNELS.setProviderSelection, setProviderSelectionHandler, { mutating: true });
  handle(MACHINE_IPC_CHANNELS.readBudgetLedger, readBudgetLedgerHandler);
  handle(MACHINE_IPC_CHANNELS.skipNode, skipNodeHandler, { mutating: true });
  handle(MACHINE_IPC_CHANNELS.retryNode, retryNodeHandler, { mutating: true });

  return { channels: MACHINE_IPC_CHANNELS, featureGate: gate };
}

async function skipNodeHandler(event, authority, request = {}) {
  // Validate nodePath up front so renderer typos surface a precise error code
  // before we touch the workspace / pipeline files.
  const nodePath = String(request.nodePath || '').trim();
  if (!nodePath) {
    throw machineError('MACHINE_IPC_NODE_PATH_REQUIRED', 'nodePath is required.');
  }
  const context = await resolveMachinePipelineContext(event, authority, request);
  const runId = assertRunId(request.runId);
  const runRoot = await resolveMachineRunRoot(context, runId);
  const reason = String(request.reason || 'user-skipped').trim() || 'user-skipped';
  return withRunLifecycleExclusive(runRoot, () => skipNodeBody({
    runRoot,
    runId,
    nodePath,
    reason,
    request,
  }));
}

async function skipNodeBody({ runRoot, runId, nodePath, reason, request }) {
  const events = await readMachineEvents(runRoot);
  // Prefer the attempt that is currently in flight: if there is a
  // node.started for this nodePath at attempt N with no terminal event
  // (completed/failed/blocked/skipped) for that attempt yet, the user
  // is skipping THAT attempt. Recording a skipped event under the
  // same attempt cleans up the active execution. If nothing is in
  // flight, fall back to max(attempt) + 1 so the skip still records
  // as a fresh decision marker.
  let activeAttempt = 0;
  let maxAttempt = 0;
  const attemptStatus = new Map();
  for (const e of events) {
    if (!e || (e.nodePath || '') !== nodePath) continue;
    const a = Number(e.payload?.attempt || 0);
    if (!Number.isFinite(a) || a <= 0) continue;
    if (a > maxAttempt) maxAttempt = a;
    if (e.eventType === 'node.started') {
      attemptStatus.set(a, 'started');
    } else if (['node.completed', 'node.failed', 'node.blocked', 'node.skipped', 'node.cancelled'].includes(e.eventType)) {
      attemptStatus.set(a, 'terminal');
    }
  }
  for (const [a, status] of attemptStatus.entries()) {
    if (status === 'started' && a > activeAttempt) activeAttempt = a;
  }
  const attempt = activeAttempt > 0 ? activeAttempt : maxAttempt + 1;
  const skippedEvent = await recordNodeLifecycleEvent(runRoot, {
    runId,
    nodePath,
    nodeType: String(request.nodeType || '').trim() || 'orpad.unknown',
    status: 'skipped',
    attempt,
    payload: {
      reason,
      decidedBy: 'renderer',
      decidedAt: new Date().toISOString(),
    },
  });
  // After the skip, fix up a stale 'running' lifecycle if there are no
  // active node executions left. Without this the run can stay stuck
  // in lifecycleStatus='running' even though every probe / gate has
  // resolved, and assertRunCanExecuteStep will refuse the next Continue
  // click. We do this only on a clean transition (running → waiting)
  // and only when activeNodeExecutionsFromEvents agrees the run is
  // idle.
  try {
    const updatedEvents = await readMachineEvents(runRoot);
    const runStateNow = await readRunState(runRoot);
    const lifecycle = runStateNow?.lifecycleStatus;
    if (lifecycle === 'running') {
      const machineModule = require('./machine');
      const active = typeof machineModule.__test_activeNodeExecutionsFromEvents === 'function'
        ? machineModule.__test_activeNodeExecutionsFromEvents(updatedEvents)
        : [];
      if (active.length === 0) {
        await appendRunLifecycleStatus(runRoot, {
          runId,
          toState: 'waiting',
          reason: 'machine.skip-node.idle',
          payload: { nodePath, attempt },
        }).catch(() => null);
      }
    }
  } catch { /* best-effort cleanup; do not fail the skip if this fails */ }
  return {
    success: true,
    ok: true,
    runId,
    nodePath,
    attempt,
    eventSequence: skippedEvent?.sequence,
  };
}

// Retry a previously-completed-but-failed node (typically a probe whose
// adapter returned status='failed'). The renderer wraps each Failed
// adapter card with a "Retry probe" button that hits this handler.
//
// Mechanism: append a fresh `node.scheduled` event for the same nodePath
// at attempt N+1. Because `latestNodeResolvedEvent` only treats
// `node.completed` / `node.skipped` as resolutions, a later
// `node.scheduled` invalidates the prior `node.completed` and the
// dispatcher will re-evaluate the node on the next executeRunStep call.
async function retryNodeHandler(event, authority, request = {}) {
  const nodePath = String(request.nodePath || '').trim();
  if (!nodePath) {
    throw machineError('MACHINE_IPC_NODE_PATH_REQUIRED', 'nodePath is required.');
  }
  const context = await resolveMachinePipelineContext(event, authority, request);
  const runId = assertRunId(request.runId);
  const runRoot = await resolveMachineRunRoot(context, runId);
  return withRunLifecycleExclusive(runRoot, async () => {
    const events = await readMachineEvents(runRoot);
    let maxAttempt = 0;
    let lastNodeType = '';
    for (const e of events) {
      if (!e || (e.nodePath || '') !== nodePath) continue;
      if (!String(e.eventType || '').startsWith('node.')) continue;
      const a = Number(e.payload?.attempt || 0);
      if (Number.isFinite(a) && a > maxAttempt) maxAttempt = a;
      if (e.payload?.nodeType) lastNodeType = String(e.payload.nodeType);
    }
    const nodeType = String(request.nodeType || '').trim() || lastNodeType || 'orpad.unknown';
    const nextAttempt = maxAttempt + 1;
    const scheduledEvent = await recordNodeLifecycleEvent(runRoot, {
      runId,
      nodePath,
      nodeType,
      status: 'scheduled',
      attempt: nextAttempt,
      payload: {
        reason: 'user-retry-requested',
        decidedBy: 'renderer',
        decidedAt: new Date().toISOString(),
      },
    });
    return {
      success: true,
      ok: true,
      runId,
      nodePath,
      attempt: nextAttempt,
      eventSequence: scheduledEvent?.sequence,
    };
  });
}

async function listProvidersHandler(event, authority, request = {}) {
  const plugins = listProviderPlugins().map(plugin => {
    const catalogEntry = getProviderEntry(plugin.id);
    return {
      id: plugin.id,
      displayName: plugin.displayName,
      family: plugin.family,
      needsKey: plugin.needsKey === true,
      defaultModel: plugin.defaultModel || '',
      implementationStatus: plugin.implementationStatus
        || catalogEntry?.implementationStatus
        || 'unknown',
      statusNote: plugin.statusNote || catalogEntry?.statusNote || '',
      capabilities: {
        sessionStrategies: [...(plugin.capabilities?.sessionStrategies || ['none'])],
        toolPolicies: [...(plugin.capabilities?.toolPolicies || ['none'])],
        streaming: plugin.capabilities?.streaming === true,
        structuredOutput: plugin.capabilities?.structuredOutput || 'free-text',
        sandbox: plugin.capabilities?.sandbox || null,
      },
      dangerousArgs: [...(plugin.dangerousArgs || [])],
    };
  });
  const catalog = listProviderEntries().map(entry => ({
    id: entry.id,
    displayName: entry.displayName,
    family: entry.family,
    needsKey: Boolean(entry.needsKey),
    defaultModel: entry.defaultModel,
    implementationStatus: entry.implementationStatus || 'unknown',
    statusNote: entry.statusNote || '',
    models: entry.models.map(model => model.id),
  }));
  return { success: true, ok: true, plugins, catalog };
}

async function listModelsHandler(event, authority, request = {}) {
  const providerId = String(request.providerId || '').trim();
  if (!providerId) {
    throw machineError('MACHINE_IPC_PROVIDER_ID_REQUIRED', 'providerId is required.');
  }
  const entry = getProviderEntry(providerId);
  if (!entry) {
    throw machineError('MACHINE_IPC_PROVIDER_UNKNOWN', `Unknown provider id: ${providerId}`);
  }
  const plugin = getProviderPlugin(providerId);
  return {
    success: true,
    ok: true,
    providerId,
    defaultModel: entry.defaultModel,
    models: entry.models.map(model => ({
      id: model.id,
      qualityTier: model.qualityTier || 'standard',
      contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : 0,
      costPerMTokensIn: Number.isFinite(model.costPerMTokensIn) ? model.costPerMTokensIn : 0,
      costPerMTokensOut: Number.isFinite(model.costPerMTokensOut) ? model.costPerMTokensOut : 0,
    })),
    pluginRegistered: Boolean(plugin),
  };
}

async function setProviderSelectionHandler(event, authority, request = {}) {
  const scope = String(request.scope || '').trim();
  if (scope !== 'pipeline' && scope !== 'node') {
    throw machineError('MACHINE_IPC_SCOPE_INVALID', "scope must be 'pipeline' or 'node'.");
  }
  const selection = request.selection;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw machineError('MACHINE_IPC_SELECTION_INVALID', 'selection must be an object.');
  }
  const providerId = String(selection.providerId || '').trim();
  if (!providerId) {
    throw machineError('MACHINE_IPC_PROVIDER_ID_REQUIRED', 'selection.providerId is required.');
  }
  if (!hasProviderPlugin(providerId)) {
    throw machineError(
      'MACHINE_IPC_PROVIDER_NOT_REGISTERED',
      `Provider plugin "${providerId}" is not registered. Renderer-supplied provider ids are validated against the plugin registry.`,
    );
  }
  const entry = getProviderEntry(providerId);
  if (!entry) {
    throw machineError(
      'MACHINE_IPC_PROVIDER_NOT_IN_CATALOG',
      `Provider "${providerId}" is not in the shared catalog.`,
    );
  }
  const model = String(selection.model || entry.defaultModel || '').trim();
  if (!model) {
    throw machineError('MACHINE_IPC_MODEL_REQUIRED', 'selection.model is required.');
  }
  const target = scope === 'node' ? String(request.target || '').trim() : null;
  if (scope === 'node' && !target) {
    throw machineError('MACHINE_IPC_TARGET_REQUIRED', 'target nodePath is required for node-scope selection.');
  }
  const canonical = {
    providerId,
    model,
    family: entry.family,
    qualityTier: selection.qualityTier || 'standard',
    sessionStrategy: selection.sessionStrategy || 'none',
    toolPolicy: selection.toolPolicy || 'none',
    sandbox: selection.sandbox ?? null,
    approvalPolicy: selection.approvalPolicy || 'never',
    timeoutMs: Number.isFinite(selection.timeoutMs) ? selection.timeoutMs : 600000,
    ephemeral: selection.ephemeral !== false,
  };

  let persistedTo = null;
  const pipelinePath = String(request.pipelinePath || '').trim();
  if (pipelinePath) {
    authority?.assertWorkspaceContains?.(pipelinePath);
    persistedTo = await writeAdapterOverridesFile(pipelinePath, scope, target, canonical);
  }
  return {
    success: true,
    ok: true,
    scope,
    target,
    selection: canonical,
    persistedTo,
  };
}

async function writeAdapterOverridesFile(pipelinePath, scope, target, selection) {
  const overridesPath = adapterOverridesPathFor(pipelinePath);
  let existing = null;
  try {
    const raw = await fsp.readFile(overridesPath, 'utf8');
    existing = JSON.parse(raw);
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
  const next = {
    schemaVersion: 'orpad.adapterOverrides.v1',
    updatedAt: new Date().toISOString(),
    pipelineDefault: scope === 'pipeline'
      ? selection
      : (existing?.pipelineDefault || null),
    nodeOverrides: {
      ...(existing?.nodeOverrides || {}),
      ...(scope === 'node' && target ? { [target]: selection } : {}),
    },
  };
  await fsp.mkdir(path.dirname(overridesPath), { recursive: true });
  await fsp.writeFile(overridesPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return overridesPath;
}

function adapterOverridesPathFor(pipelinePath) {
  const dir = path.dirname(pipelinePath);
  const base = path.basename(pipelinePath);
  // Sibling file e.g. pipeline.or-pipeline → pipeline.adapter-overrides.json
  // Keeps the user's own pipeline.or-pipeline untouched.
  const stem = base.replace(/\.[^.]+$/, '');
  return path.join(dir, `${stem}.adapter-overrides.json`);
}

async function readAdapterOverridesIfPresent(pipelinePath) {
  try {
    const raw = await fsp.readFile(adapterOverridesPathFor(pipelinePath), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.schemaVersion === 'orpad.adapterOverrides.v1') return parsed;
    return null;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return null;
  }
}

async function readBudgetLedgerHandler(event, authority, request = {}) {
  const runRoot = String(request.runRoot || '').trim();
  if (!runRoot) {
    throw machineError('MACHINE_IPC_RUN_ROOT_REQUIRED', 'runRoot is required.');
  }
  authority?.assertWorkspaceContains?.(runRoot);
  const ledger = await readBudgetLedger(runRoot);
  return {
    success: true,
    ok: true,
    ledger,
    summary: summarizeLedger(ledger),
  };
}

module.exports = {
  MACHINE_IPC_CHANNELS,
  adapterOverridesPathFor,
  featureGateFromEnv,
  readAdapterOverridesIfPresent,
  registerMachineHandlers,
};
