const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerArtifact } = require('../artifacts');
const { assertCommandGranted } = require('../command-grants');
const { assertCliProcessContainment } = require('./process-containment');
const { redactCommandArgs, runMachineProcess } = require('./process-runner');
const {
  collectOverlayPatch,
  copyAllowedFilesToOverlay,
  registerPatchArtifact,
} = require('../patches');

const fsp = fs.promises;

function createCliAgentProposalOnlyAdapter(options = {}) {
  const { fixtureResult = null } = options;
  return {
    adapter: 'cli-agent-proposal-only',
    async invoke(request) {
      if (!fixtureResult) {
        throw new Error('Real CLI adapter execution is disabled; provide a proposal-only fixture result.');
      }
      return typeof fixtureResult === 'function' ? fixtureResult(request) : fixtureResult;
    },
  };
}

function failedProcessResult(commandSpec = {}, err) {
  const redactedArgs = redactCommandArgs(commandSpec.args || []);
  const now = new Date().toISOString();
  return {
    command: commandSpec.command || '',
    args: redactedArgs.args,
    cwd: commandSpec.cwd || '',
    code: null,
    signal: null,
    timedOut: false,
    cancelled: false,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    redactedArgCount: redactedArgs.redactedCount,
    maskedEnvCount: 0,
    maskedEnvNames: [],
    startedAt: now,
    finishedAt: now,
    spawnError: {
      code: err?.code || '',
      message: err?.message || 'Process failed before Machine could collect output.',
    },
  };
}

function idSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'cli-agent';
}

function cliOverlayRoot(runRoot, request) {
  if (!runRoot) return '';
  return path.join(path.resolve(runRoot), 'adapters', 'overlays', idSegment(request?.adapterCallId));
}

function comparablePath(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameResolvedPath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function isInsideResolvedPath(parent, child) {
  const parentPath = comparablePath(parent);
  const childPath = comparablePath(child);
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function unsafeOverlayRoot(overlayRoot, reason) {
  const err = new Error(`CLI overlay root is not Machine-owned: ${reason}`);
  err.code = 'MACHINE_CLI_OVERLAY_ROOT_UNSAFE';
  err.overlayRoot = overlayRoot;
  return err;
}

function assertCliOverlayRootAllowed(options = {}) {
  const {
    overlayRoot,
    overlayRootMode = 'run-root',
    runRoot = '',
    workspaceRoot = '',
  } = options;
  if (!overlayRoot) throw unsafeOverlayRoot('', 'overlay root is required');
  const resolvedOverlayRoot = path.resolve(overlayRoot);
  const mode = overlayRootMode === 'system-temp' ? 'system-temp' : 'run-root';

  if (mode === 'system-temp') {
    const tempRoot = path.resolve(os.tmpdir());
    if (
      sameResolvedPath(resolvedOverlayRoot, tempRoot)
      || !isInsideResolvedPath(tempRoot, resolvedOverlayRoot)
      || !path.basename(resolvedOverlayRoot).startsWith('orpad-machine-')
    ) {
      throw unsafeOverlayRoot(resolvedOverlayRoot, 'system-temp overlays must be isolated orpad-machine-* temp directories');
    }
    if (workspaceRoot && isInsideResolvedPath(workspaceRoot, resolvedOverlayRoot)) {
      throw unsafeOverlayRoot(resolvedOverlayRoot, 'system-temp overlays must stay outside the canonical workspace');
    }
    return resolvedOverlayRoot;
  }

  if (!runRoot) throw unsafeOverlayRoot(resolvedOverlayRoot, 'run-root overlays require runRoot');
  const overlayParent = path.join(path.resolve(runRoot), 'adapters', 'overlays');
  if (
    sameResolvedPath(resolvedOverlayRoot, overlayParent)
    || !isInsideResolvedPath(overlayParent, resolvedOverlayRoot)
  ) {
    throw unsafeOverlayRoot(resolvedOverlayRoot, 'run-root overlays must live below runRoot/adapters/overlays');
  }
  return resolvedOverlayRoot;
}

async function prepareCliOverlayWorkspace(options = {}) {
  const {
    runRoot = '',
    request,
    workspaceRoot = request?.workspaceRoot || '',
  } = options;
  if (!request) throw new Error('adapter request is required.');
  if (!workspaceRoot) throw new Error('workspaceRoot is required.');
  const requestedOverlayMode = options.overlayRootMode || request.overlayRootMode || 'run-root';
  let overlayRootMode = requestedOverlayMode === 'system-temp' ? 'system-temp' : 'run-root';
  let overlayRoot = options.overlayRoot || request.overlayRoot || '';
  if (!overlayRoot && overlayRootMode === 'system-temp') {
    overlayRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-cli-overlay-'));
  }
  if (!overlayRoot && runRoot) {
    overlayRoot = cliOverlayRoot(runRoot, request);
  }
  if (!overlayRoot) {
    overlayRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-cli-overlay-'));
    overlayRootMode = 'system-temp';
  }
  overlayRoot = assertCliOverlayRootAllowed({
    overlayRoot,
    overlayRootMode,
    runRoot,
    workspaceRoot,
  });

  await fsp.rm(overlayRoot, { recursive: true, force: true });
  await fsp.mkdir(overlayRoot, { recursive: true });
  const copied = await copyAllowedFilesToOverlay({
    workspaceRoot,
    overlayRoot,
    allowedFiles: request.allowedFiles || [],
  });
  return {
    workspaceRoot: path.resolve(workspaceRoot),
    overlayRoot,
    overlayRootMode,
    copied,
  };
}

async function registerJsonArtifact(runRoot, options = {}) {
  if (!runRoot) return null;
  return registerArtifact(runRoot, {
    runId: options.runId,
    artifactPath: options.artifactPath,
    content: `${JSON.stringify(options.value, null, 2)}\n`,
    producedBy: options.producedBy,
    registeredBy: 'machine',
    schemaVersion: options.schemaVersion || '',
  });
}

function normalizeExpectedChangedFiles(request = {}) {
  return (request.expectedChangedFiles || [])
    .filter(item => typeof item === 'string' && item.trim())
    .map(item => item.replace(/\\/g, '/'));
}

function missingExpectedChangedFiles(patch, expectedChangedFiles = []) {
  const changed = new Set((patch.changes || []).map(change => String(change.path || '').replace(/\\/g, '/')));
  return expectedChangedFiles.filter(file => !changed.has(file));
}

function resultStatusForProcess(processResult, patch, request = {}) {
  if ((patch.violations || []).length) return 'blocked';
  if (processResult.code !== 0 || processResult.timedOut) return 'failed';
  if (missingExpectedChangedFiles(patch, normalizeExpectedChangedFiles(request)).length) return 'blocked';
  return 'done';
}

function createCliAgentAdapter(options = {}) {
  return {
    adapter: 'cli-agent-overlay',
    async invoke(request) {
      if (!options.enabled) {
        const err = new Error('CLI adapter execution is disabled.');
        err.code = 'CLI_ADAPTER_DISABLED';
        throw err;
      }
      if (request.workspaceMode !== 'read-only-plus-overlay') {
        throw new Error('CLI adapter requires read-only-plus-overlay workspace mode.');
      }

      const runRoot = options.runRoot || '';
      const runId = options.runId || request.runId;
      const overlay = await prepareCliOverlayWorkspace({
        runRoot,
        request,
        workspaceRoot: options.workspaceRoot || request.workspaceRoot,
        overlayRoot: options.overlayRoot,
        overlayRootMode: options.overlayRootMode,
      });
      const cleanupSystemOverlay = overlay.overlayRootMode === 'system-temp' && options.keepOverlay !== true;
      try {
        const commandSpec = {
          ...(options.commandSpec || request.commandSpec || {}),
          cwd: (options.commandSpec || request.commandSpec || {}).cwd || overlay.overlayRoot,
        };
        const grant = assertCommandGranted(options.commandGrants || request.commandGrants || [], commandSpec, {
          now: options.now,
        });
        const containment = assertCliProcessContainment({
          commandSpec,
          grant,
          overlayRoot: overlay.overlayRoot,
          workspaceRoot: overlay.workspaceRoot,
          request,
          allowDangerousSandboxBypass: options.allowDangerousSandboxBypass === true,
          dangerousArgs: options.dangerousArgs,
        });

        let processResult;
        try {
          processResult = await runMachineProcess({
            command: commandSpec.command,
            args: commandSpec.args || [],
            cwd: commandSpec.cwd,
            runId,
            adapterCallId: request.adapterCallId,
            env: options.env,
            extraEnv: options.extraEnv,
            timeoutMs: options.timeoutMs,
            maxOutputBytes: options.maxOutputBytes,
          });
        } catch (err) {
          processResult = failedProcessResult(commandSpec, err);
        }
        const patch = await collectOverlayPatch({
          workspaceRoot: overlay.workspaceRoot,
          overlayRoot: overlay.overlayRoot,
          allowedFiles: request.allowedFiles || [],
          now: options.now,
        });

        const artifacts = [];
        const transcriptArtifact = await registerJsonArtifact(runRoot, {
          runId,
          artifactPath: `artifacts/adapters/${request.adapterCallId}.transcript.json`,
          producedBy: 'cli-agent-overlay',
          value: {
            request: {
              adapterCallId: request.adapterCallId,
              attemptId: request.attemptId,
              idempotencyKey: request.idempotencyKey,
            },
            overlay: {
              ...overlay,
              cleanupPlanned: cleanupSystemOverlay,
            },
            containment,
            process: processResult,
          },
        });
        if (transcriptArtifact?.file?.path) artifacts.push(transcriptArtifact.file.path);

        let patchArtifactPath = '';
        if ((patch.changes || []).length || (patch.violations || []).length) {
          const patchArtifact = await registerPatchArtifact(runRoot, {
            runId,
            patch,
            artifactPath: `artifacts/patches/${request.adapterCallId}.patch.json`,
            producedBy: 'cli-agent-overlay',
          });
          patchArtifactPath = patchArtifact?.file?.path || '';
          if (patchArtifactPath) artifacts.push(patchArtifactPath);
        }

        const expectedChangedFiles = normalizeExpectedChangedFiles(request);
        const missingExpectedChanges = missingExpectedChangedFiles(patch, expectedChangedFiles);
        const status = resultStatusForProcess(processResult, patch, request);
        return {
          schemaVersion: 'orpad.workerResult.v1',
          adapterCallId: request.adapterCallId,
          attemptId: request.attemptId,
          idempotencyKey: request.idempotencyKey,
          status,
          summary: status === 'done'
            ? 'CLI adapter completed in overlay and produced a Machine-owned result.'
            : (
              processResult.spawnError
                ? `CLI adapter process could not start: ${processResult.spawnError.message}`
                : 'CLI adapter result requires Machine review before any canonical mutation.'
            ),
          artifacts,
          patchArtifact: patchArtifactPath,
          changedFiles: (patch.changes || []).map(change => change.path),
          verification: [{
            command: commandSpec.command,
            args: processResult.args || [],
            cwdKind: 'overlay',
            containment,
            exitCode: processResult.code,
            spawnErrorCode: processResult.spawnError?.code || '',
            spawnErrorMessage: processResult.spawnError?.message || '',
            timedOut: processResult.timedOut,
            stdoutTruncated: processResult.stdoutTruncated,
            stderrTruncated: processResult.stderrTruncated,
            redactedArgCount: processResult.redactedArgCount || 0,
            writeSetViolationCount: (patch.violations || []).length,
            expectedChangedFiles,
            missingExpectedChanges,
          }],
        };
      } finally {
        if (cleanupSystemOverlay) {
          await fsp.rm(overlay.overlayRoot, { recursive: true, force: true }).catch(() => {});
        }
      }
    },
  };
}

module.exports = {
  assertCliOverlayRootAllowed,
  cliOverlayRoot,
  comparablePath,
  createCliAgentAdapter,
  createCliAgentProposalOnlyAdapter,
  failedProcessResult,
  idSegment,
  isInsideResolvedPath,
  missingExpectedChangedFiles,
  normalizeExpectedChangedFiles,
  prepareCliOverlayWorkspace,
  registerJsonArtifact,
  resultStatusForProcess,
  sameResolvedPath,
};
