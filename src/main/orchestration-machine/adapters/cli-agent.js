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

const APPROVAL_REQUIRED_TEXT_RE = /\b(approval required|requires approval|permission required|permission denied|permission errors?|sandbox denied|denied write|tool use denied|not approved|not allowed without approval|haven't granted|have not granted|grant(ed)? permission|tool call was not approved)\b/i;

function collectStringValues(value, options = {}) {
  const {
    depth = 0,
    seen = new Set(),
    output = [],
  } = options;
  if (output.length >= 200 || depth > 8 || value == null) return output;
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }
  if (typeof value !== 'object') return output;
  if (seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, { depth: depth + 1, seen, output });
    return output;
  }
  for (const item of Object.values(value)) collectStringValues(item, { depth: depth + 1, seen, output });
  return output;
}

function hasNonEmptyPermissionDenial(value, options = {}) {
  const {
    depth = 0,
    seen = new Set(),
  } = options;
  if (depth > 8 || value == null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const entries = Object.entries(value);
  for (const [key, item] of entries) {
    if (/^permission_?denials?$/i.test(key)) {
      if (Array.isArray(item)) return item.length > 0;
      if (item && typeof item === 'object') return Object.keys(item).length > 0;
      if (typeof item === 'string') {
        const normalized = item.trim().toLowerCase();
        return Boolean(normalized && !['[]', 'null', 'none', 'false'].includes(normalized));
      }
      return Boolean(item);
    }
  }
  for (const [, item] of entries) {
    if (hasNonEmptyPermissionDenial(item, { depth: depth + 1, seen })) return true;
  }
  return false;
}

function parseJsonDocuments(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  try {
    return [JSON.parse(raw)];
  } catch {}
  const parsed = [];
  for (const line of raw.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate || candidate[0] !== '{') continue;
    try {
      parsed.push(JSON.parse(candidate));
    } catch {}
  }
  return parsed;
}

function approvalSearchText(value) {
  if (value == null) return '';
  if (typeof value !== 'string') return collectStringValues(value).join('\n');
  const docs = parseJsonDocuments(value);
  if (!docs.length) return value;
  return docs.flatMap(doc => collectStringValues(doc)).join('\n');
}

function processLooksApprovalRequired(processResult = {}, parsedResult = null) {
  const structuredSources = [
    parsedResult,
    ...parseJsonDocuments(processResult.stdout),
    ...parseJsonDocuments(processResult.stderr),
  ].filter(Boolean);
  if (structuredSources.some(source => hasNonEmptyPermissionDenial(source))) return true;
  const text = [
    approvalSearchText(processResult.stdout),
    approvalSearchText(processResult.stderr),
    processResult.spawnError?.message,
  ].filter(Boolean).join('\n');
  const parsedText = [
    approvalSearchText(parsedResult?.summary),
    approvalSearchText(parsedResult?.deferredReason),
  ].filter(Boolean).join('\n');
  return APPROVAL_REQUIRED_TEXT_RE.test([text, parsedText].filter(Boolean).join('\n'));
}

function resultStatusForProcess(processResult, patch, request = {}) {
  if (processLooksApprovalRequired(processResult)) return 'approval-required';
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
        const approvalRequired = status === 'approval-required';
        return {
          schemaVersion: 'orpad.workerResult.v1',
          adapterCallId: request.adapterCallId,
          attemptId: request.attemptId,
          idempotencyKey: request.idempotencyKey,
          status,
          summary: approvalRequired
            ? 'CLI provider requested tool permission. Approve to retry this work item with the run bypass option, or decline to keep it blocked.'
            : (status === 'done'
              ? 'CLI adapter completed in overlay and produced a Machine-owned result.'
              : (
              processResult.spawnError
                ? `CLI adapter process could not start: ${processResult.spawnError.message}`
                : 'CLI adapter result requires Machine review before any canonical mutation.'
              )),
          artifacts,
          patchArtifact: patchArtifactPath,
          changedFiles: (patch.changes || []).map(change => change.path),
          ...(approvalRequired ? {
            requestedCapabilities: ['llm-cli-tool-permission', 'workspace-overlay-write'],
            approvalRequest: {
              reason: 'llm-cli-permission-required',
              commandSpec: {
                command: commandSpec.command,
                args: processResult.args || [],
                cwdKind: 'overlay',
              },
            },
          } : {}),
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
  processLooksApprovalRequired,
  registerJsonArtifact,
  resultStatusForProcess,
  sameResolvedPath,
};
