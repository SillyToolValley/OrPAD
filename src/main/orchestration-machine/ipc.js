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
const { recoverStaleClaims } = require('./dispatcher');
const { executeMachineRunStep } = require('./machine');
const { resumeMachineRun } = require('./lifecycle');
const {
  assertNoSymlinkInWorkspacePath,
  latestRunExportRoot,
  durableRunRoot,
} = require('./path-resolver');
const { createMachineRun, readRunState } = require('./run-store');
const { exportLatestRun } = require('./exporters/latest-run-exporter');
const { cancelClaimedItem } = require('./worker-loop');
const { readActiveWriteSetLocks } = require('./write-sets');

const fsp = fs.promises;

const MACHINE_IPC_CHANNELS = Object.freeze({
  validatePipeline: 'machine-validate-pipeline',
  createRun: 'machine-create-run',
  getRun: 'machine-get-run',
  listRuns: 'machine-list-runs',
  executeRunStep: 'machine-execute-run-step',
  resumeRun: 'machine-resume-run',
  cancelClaim: 'machine-cancel-claim',
  decideApproval: 'machine-decide-approval',
  exportLatestRun: 'machine-export-latest-run',
});

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
  const runState = await readRunState(runRoot) || projectRunStateFromEvents(events);
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
    validation,
  };
}

async function createRunHandler(event, authority, request) {
  const context = await resolveMachinePipelineContext(event, authority, request);
  const options = assertPlainObject(request.options == null ? {} : request.options, 'options');
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
  const runRoot = durableRunRoot(context.pipelineDir, runId);
  const runsRoot = path.join(context.pipelineDir, 'runs');
  if (!isInsidePath(runRoot, runsRoot)) {
    throw machineError('MACHINE_IPC_PATH_DENIED', 'Machine run must stay inside the pipeline runs directory.');
  }
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
  return {
    success: true,
    ok: true,
    runs: await listRunSummaries(context.pipelineDir),
  };
}

async function exportLatestRunHandler(event, authority, request) {
  const context = await resolveMachinePipelineContext(event, authority, request);
  const runId = assertRunId(request.runId);
  const runRoot = durableRunRoot(context.pipelineDir, runId);
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

async function decideApprovalHandler(event, authority, request) {
  const context = await resolveMachinePipelineContext(event, authority, request);
  const runId = assertRunId(request.runId);
  const approvalId = requiredString(request.approvalId, 'approvalId').trim();
  const decision = assertApprovalDecision(request.decision);
  const runRoot = durableRunRoot(context.pipelineDir, runId);
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
  const runRoot = durableRunRoot(context.pipelineDir, runId);
  const snapshot = await readRunSnapshot(runRoot);
  if (!snapshot) {
    throw machineError('MACHINE_RUN_NOT_FOUND', 'Machine run was not found.');
  }

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
}

async function cancelClaimHandler(event, authority, request) {
  const context = await resolveMachinePipelineContext(event, authority, request);
  const runId = assertRunId(request.runId);
  const claimId = assertOpaqueId(request.claimId, 'claimId');
  const itemId = assertOpaqueId(request.itemId, 'itemId');
  const toState = assertCancelToState(request.toState);
  const runRoot = durableRunRoot(context.pipelineDir, runId);
  const snapshot = await readRunSnapshot(runRoot);
  if (!snapshot) {
    throw machineError('MACHINE_RUN_NOT_FOUND', 'Machine run was not found.');
  }

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
}

async function executeRunStepWithHarnessHandler(event, authority, request) {
  const context = await resolveMachinePipelineContext(event, authority, request);
  const runId = assertRunId(request.runId);
  const runRoot = durableRunRoot(context.pipelineDir, runId);
  const snapshot = await readRunSnapshot(runRoot);
  if (!snapshot) {
    throw machineError('MACHINE_RUN_NOT_FOUND', 'Machine run was not found.');
  }

  try {
    const executed = await executeMachineRunStep({
      workspaceRoot: context.workspaceRoot,
      pipelinePath: context.pipelinePath,
      pipelineDir: context.pipelineDir,
      runRoot,
      runId,
      exportLatestRunAfterStep: request.exportLatestRun !== false,
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
}

function registerMachineHandlers({ ipcMain, authority, featureGate = featureGateFromEnv() }) {
  if (!ipcMain?.handle) throw new Error('ipcMain.handle is required.');
  if (!authority) throw new Error('Machine IPC requires an authority manager.');

  const gate = normalizeFeatureGate(featureGate);

  function handle(channel, handler, { mutating = false } = {}) {
    ipcMain.handle(channel, async (event, request = {}) => {
      try {
        assertSenderFrame(event);
        assertMachineGate(gate);
        assertPlainObject(request);
        if (mutating) assertMutatingCapability(request, gate);
        return await handler(event, authority, request);
      } catch (err) {
        return rejectResponse(err);
      }
    });
  }

  handle(MACHINE_IPC_CHANNELS.validatePipeline, validatePipelineHandler);
  handle(MACHINE_IPC_CHANNELS.createRun, createRunHandler, { mutating: true });
  handle(MACHINE_IPC_CHANNELS.getRun, getRunHandler);
  handle(MACHINE_IPC_CHANNELS.listRuns, listRunsHandler);
  handle(MACHINE_IPC_CHANNELS.executeRunStep, executeRunStepWithHarnessHandler, { mutating: true });
  handle(MACHINE_IPC_CHANNELS.resumeRun, resumeRunHandler, { mutating: true });
  handle(MACHINE_IPC_CHANNELS.cancelClaim, cancelClaimHandler, { mutating: true });
  handle(MACHINE_IPC_CHANNELS.decideApproval, decideApprovalHandler, { mutating: true });
  handle(MACHINE_IPC_CHANNELS.exportLatestRun, exportLatestRunHandler, { mutating: true });

  return { channels: MACHINE_IPC_CHANNELS, featureGate: gate };
}

module.exports = {
  MACHINE_IPC_CHANNELS,
  featureGateFromEnv,
  registerMachineHandlers,
};
