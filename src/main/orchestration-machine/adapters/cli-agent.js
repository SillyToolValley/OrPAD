const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerArtifact } = require('../artifacts');
const { assertCommandGranted } = require('../command-grants');
const { runMachineProcess } = require('./process-runner');
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

async function prepareCliOverlayWorkspace(options = {}) {
  const {
    runRoot = '',
    request,
    workspaceRoot = request?.workspaceRoot || '',
  } = options;
  if (!request) throw new Error('adapter request is required.');
  if (!workspaceRoot) throw new Error('workspaceRoot is required.');
  const overlayRoot = options.overlayRoot
    || cliOverlayRoot(runRoot, request)
    || await fsp.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-cli-overlay-'));

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
      });
      const commandSpec = {
        ...(options.commandSpec || request.commandSpec || {}),
        cwd: (options.commandSpec || request.commandSpec || {}).cwd || overlay.overlayRoot,
      };
      assertCommandGranted(options.commandGrants || request.commandGrants || [], commandSpec, {
        now: options.now,
      });

      const processResult = await runMachineProcess({
        command: commandSpec.command,
        args: commandSpec.args || [],
        cwd: commandSpec.cwd,
        env: options.env,
        extraEnv: options.extraEnv,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
      });
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
          overlay,
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
          : 'CLI adapter result requires Machine review before any canonical mutation.',
        artifacts,
        patchArtifact: patchArtifactPath,
        changedFiles: (patch.changes || []).map(change => change.path),
        verification: [{
          command: commandSpec.command,
          args: commandSpec.args || [],
          cwdKind: 'overlay',
          exitCode: processResult.code,
          timedOut: processResult.timedOut,
          stdoutTruncated: processResult.stdoutTruncated,
          stderrTruncated: processResult.stderrTruncated,
          writeSetViolationCount: (patch.violations || []).length,
          expectedChangedFiles,
          missingExpectedChanges,
        }],
      };
    },
  };
}

module.exports = {
  cliOverlayRoot,
  createCliAgentAdapter,
  createCliAgentProposalOnlyAdapter,
  missingExpectedChangedFiles,
  prepareCliOverlayWorkspace,
  resultStatusForProcess,
};
