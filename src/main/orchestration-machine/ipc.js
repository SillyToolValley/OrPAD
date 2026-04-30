const fs = require('fs');
const path = require('path');

const { isInsidePath } = require('../authority');
const { validateRunbookFile } = require('../runbooks/validator');
const { createAdapterRequest } = require('./adapters/proposal-adapter');
const { createCliAgentAdapter, cliOverlayRoot } = require('./adapters/cli-agent');
const { createCommandGrant } = require('./command-grants');
const { claimNextQueuedItem } = require('./dispatcher');
const { readMachineEvents, projectRunStateFromEvents } = require('./events');
const { latestRunExportRoot, durableRunRoot } = require('./path-resolver');
const { ingestCandidateProposal, transitionQueueItem } = require('./queue-store');
const { createMachineRun, readRunState } = require('./run-store');
const { exportLatestRun } = require('./exporters/latest-run-exporter');
const { normalizeWriteSetPath } = require('./write-sets');
const { runWorkerLoopOnce } = require('./worker-loop');

const fsp = fs.promises;

const MACHINE_IPC_CHANNELS = Object.freeze({
  validatePipeline: 'machine-validate-pipeline',
  createRun: 'machine-create-run',
  getRun: 'machine-get-run',
  listRuns: 'machine-list-runs',
  executeRunStep: 'machine-execute-run-step',
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

function assertOptionalRunId(value) {
  if (value == null || value === '') return '';
  return assertRunId(value);
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

async function readJsonFile(filePath, label) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (err) {
    throw machineError('MACHINE_IPC_SCHEMA_INVALID', `${label} must be valid JSON.`);
  }
}

function optionalObject(value, label) {
  if (value == null) return null;
  return assertPlainObject(value, label);
}

function normalizeTrustLevel(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return 'local-authored';
  return typeof options.trustLevel === 'string' ? options.trustLevel : 'local-authored';
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

function harnessFromPipeline(pipeline) {
  return pipeline?.run && typeof pipeline.run === 'object' && !Array.isArray(pipeline.run)
    ? pipeline.run.machineHarness
    : null;
}

function nodeExecutableForHarness() {
  return process.env.ORPAD_MACHINE_NODE_EXEC_PATH
    || process.env.npm_node_execpath
    || process.env.NODE
    || process.execPath;
}

function nodeCliPatchCommandSpec(patchConfig, cwd) {
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
    command: nodeExecutableForHarness(),
    args: ['-e', script],
    cwd,
    file,
  };
}

async function executeRunStepWithHarnessHandler(event, authority, request) {
  const context = await resolveMachinePipelineContext(event, authority, request);
  const runId = assertRunId(request.runId);
  const runRoot = durableRunRoot(context.pipelineDir, runId);
  const snapshot = await readRunSnapshot(runRoot);
  if (!snapshot) {
    throw machineError('MACHINE_RUN_NOT_FOUND', 'Machine run was not found.');
  }

  const pipeline = await readJsonFile(context.pipelinePath, 'Machine pipeline');
  const harness = optionalObject(harnessFromPipeline(pipeline), 'run.machineHarness');
  if (!harness) {
    return {
      success: false,
      ok: false,
      code: 'MACHINE_EXECUTION_HARNESS_REQUIRED',
      error: 'This MVP execute step requires a local deterministic run.machineHarness fixture.',
      runId,
      runState: snapshot.runState,
      events: snapshot.events,
    };
  }

  const candidate = assertPlainObject(harness.candidateProposal, 'machineHarness.candidateProposal');
  const expectedChangedFiles = (harness.expectedChangedFiles || candidate.sourceOfTruthTargets || [])
    .map(file => normalizeWriteSetPath(file));
  const patchConfig = assertPlainObject(harness.nodeCliPatch, 'machineHarness.nodeCliPatch');
  const patchFile = normalizeWriteSetPath(requiredString(patchConfig.file, 'machineHarness.nodeCliPatch.file'));
  if (!expectedChangedFiles.includes(patchFile)) {
    throw machineError(
      'MACHINE_EXECUTION_HARNESS_INVALID',
      'machineHarness.nodeCliPatch.file must be listed in expectedChangedFiles or candidate.sourceOfTruthTargets.',
    );
  }

  const itemResult = await ingestCandidateProposal(runRoot, candidate, {
    runId,
    transitionId: `harness:${runId}:ingest:${candidate.proposalId || candidate.suggestedWorkItemId}`,
  });
  await transitionQueueItem(runRoot, {
    runId,
    itemId: itemResult.item.id,
    toState: 'queued',
    reason: 'machine-harness.triage.accepted',
    transitionId: `harness:${runId}:triage:${itemResult.item.id}`,
  });

  const claim = await claimNextQueuedItem(runRoot, {
    runId,
    claimId: request.claimId || `claim-${itemResult.item.id}`,
  });
  if (!claim.claimed) {
    const current = await readRunSnapshot(runRoot);
    return {
      success: true,
      ok: true,
      runId,
      stopReason: claim.stopReason,
      runState: current.runState,
      events: current.events,
    };
  }

  const adapterCallId = request.adapterCallId || `${claim.claim.claimId}-harness-cli`;
  const adapterRequest = createAdapterRequest({
    adapter: 'cli-agent-overlay',
    runId,
    nodePath: 'machine-ui/harness-worker',
    taskKind: 'workerLoop',
    workspaceRoot: context.workspaceRoot,
    workspaceMode: 'read-only-plus-overlay',
    allowedFiles: claim.writeSet.paths,
    inputArtifacts: [`queue/claimed/${claim.item.id}.json`],
    outputContract: 'orpad.workerResult.v1',
    adapterCallId,
    attemptId: `${adapterCallId}-attempt-1`,
    idempotencyKey: `${adapterCallId}:attempt-1`,
  });
  adapterRequest.expectedChangedFiles = expectedChangedFiles;
  adapterRequest.overlayRoot = cliOverlayRoot(runRoot, adapterRequest);
  adapterRequest.overlayRootMode = 'run-root';
  const commandSpec = nodeCliPatchCommandSpec(patchConfig, adapterRequest.overlayRoot);
  adapterRequest.commandSpec = {
    command: commandSpec.command,
    args: commandSpec.args,
    cwd: commandSpec.cwd,
  };
  adapterRequest.commandGrants = [createCommandGrant({
    ...adapterRequest.commandSpec,
    grantId: `grant-${adapterCallId}`,
    scope: 'machine-ui-harness',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    reason: 'explicit Machine UI execute-step harness command',
  })];

  const worker = await runWorkerLoopOnce({
    runRoot,
    runId,
    workspaceRoot: context.workspaceRoot,
    claim,
    request: adapterRequest,
    adapter: createCliAgentAdapter({
      enabled: true,
      runRoot,
      workspaceRoot: context.workspaceRoot,
      timeoutMs: 60_000,
      maxOutputBytes: 64 * 1024,
    }),
  });
  let exported = null;
  if (request.exportLatestRun !== false) {
    exported = await exportLatestRun({
      runRoot,
      pipelineDir: context.pipelineDir,
      allowOverwrite: true,
    });
  }
  const current = await readRunSnapshot(runRoot);
  return {
    success: true,
    ok: true,
    runId,
    runState: current.runState,
    events: current.events,
    worker: worker.result,
    exported,
  };
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
  handle(MACHINE_IPC_CHANNELS.exportLatestRun, exportLatestRunHandler, { mutating: true });

  return { channels: MACHINE_IPC_CHANNELS, featureGate: gate };
}

module.exports = {
  MACHINE_IPC_CHANNELS,
  featureGateFromEnv,
  registerMachineHandlers,
};
