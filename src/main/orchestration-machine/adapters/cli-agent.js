const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerArtifact } = require('../artifacts');
const { assertCommandGranted } = require('../command-grants');
const { assertCliProcessContainment } = require('./process-containment');
const { runMachineProcess } = require('./process-runner');
const {
  collectOverlayPatch,
  copyAllowedFilesToOverlay,
  registerPatchArtifact,
} = require('../patches');

const fsp = fs.promises;
const DEFAULT_CODEX_CLI_TIMEOUT_MS = 10 * 60 * 1000;

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

function codexCliCommand() {
  return process.env.ORPAD_CODEX_CLI_PATH || 'codex';
}

function pathEntries() {
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean);
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findOnPath(name) {
  for (const entry of pathEntries()) {
    const candidate = path.join(entry, name);
    if (fileExists(candidate)) return candidate;
  }
  return '';
}

function knownWindowsNpmShim(name) {
  const candidates = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', name) : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm', name) : '',
  ].filter(Boolean);
  return candidates.find(fileExists) || '';
}

function codexScriptFromShim(command) {
  const commandPath = path.isAbsolute(command)
    ? command
    : (
      findOnPath(command)
      || (path.extname(command) ? '' : findOnPath(`${command}.cmd`))
      || knownWindowsNpmShim(path.extname(command) ? command : `${command}.cmd`)
    );
  if (!commandPath) return '';
  const scriptPath = path.join(path.dirname(commandPath), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return fileExists(scriptPath) ? scriptPath : '';
}

function codexCliInvocation(command = codexCliCommand(), prefixArgs = []) {
  const configured = String(command || '').trim() || codexCliCommand();
  const configuredPrefixArgs = Array.isArray(prefixArgs) ? prefixArgs.map(arg => String(arg)) : [];
  if (configuredPrefixArgs.length) {
    return { command: configured, prefixArgs: configuredPrefixArgs };
  }
  if (/\.js$/i.test(configured) && fileExists(configured)) {
    return { command: process.execPath, prefixArgs: [configured] };
  }
  if (process.platform === 'win32') {
    const base = path.basename(configured).toLowerCase();
    if (['codex', 'codex.cmd', 'codex.ps1', 'codex.exe'].includes(base)) {
      const script = codexScriptFromShim(base === 'codex.exe' ? 'codex.cmd' : configured);
      if (script) return { command: process.execPath, prefixArgs: [script] };
    }
  }
  return { command: configured, prefixArgs: [] };
}

function normalizeCodexSandbox(value, fallback = 'read-only') {
  const normalized = String(value || fallback).trim();
  if (['read-only', 'workspace-write', 'danger-full-access'].includes(normalized)) return normalized;
  return fallback;
}

function normalizeApprovalPolicy(value) {
  const normalized = String(value || 'never').trim();
  if (['never', 'on-request', 'on-failure', 'untrusted'].includes(normalized)) return normalized;
  return 'never';
}

function codexCliExecArgs(options = {}) {
  const args = [
    ...(Array.isArray(options.prefixArgs) ? options.prefixArgs.map(arg => String(arg)) : []),
    'exec',
    '--sandbox',
    normalizeCodexSandbox(options.sandbox),
    '-c',
    `approval_policy='${normalizeApprovalPolicy(options.approvalPolicy)}'`,
    '--skip-git-repo-check',
  ];
  if (options.outputLastMessagePath) {
    args.push('--output-last-message', options.outputLastMessagePath);
  }
  if (options.ephemeral !== false) args.push('--ephemeral');
  if (options.json === true) args.push('--json');
  if (options.cd) args.push('-C', options.cd);
  args.push(String(options.prompt || ''));
  return args;
}

function extractJsonText(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Codex CLI did not write an adapter result.');
  try {
    JSON.parse(raw);
    return raw;
  } catch {}

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const candidate = fenced[1].trim();
    JSON.parse(candidate);
    return candidate;
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const candidate = raw.slice(start, end + 1);
    JSON.parse(candidate);
    return candidate;
  }
  throw new Error('Codex CLI adapter result was not valid JSON.');
}

async function readCodexAdapterResult(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return {
    raw,
    value: JSON.parse(extractJsonText(raw)),
  };
}

function resultStatusForCodexProcess(processResult, parsedResult) {
  if (processResult.timedOut) return 'failed';
  if (processResult.code !== 0) return 'failed';
  const status = parsedResult?.status;
  if (['done', 'blocked', 'queued', 'failed', 'approval-required', 'rejected'].includes(status)) return status;
  return 'blocked';
}

function createCodexCliProposalAdapter(options = {}) {
  return {
    adapter: 'codex-cli-proposal',
    async invoke(request) {
      const runRoot = options.runRoot || '';
      const runId = options.runId || request.runId;
      const workspaceRoot = options.workspaceRoot || request.workspaceRoot;
      if (!runRoot) throw new Error('runRoot is required.');
      if (!workspaceRoot) throw new Error('workspaceRoot is required.');

      const resultDir = path.join(path.resolve(runRoot), 'adapters', 'results');
      await fsp.mkdir(resultDir, { recursive: true });
      const outputLastMessagePath = path.join(resultDir, `${idSegment(request.adapterCallId)}.last-message.json`);
      const prompt = typeof options.prompt === 'function'
        ? await options.prompt(request, { outputLastMessagePath })
        : String(options.prompt || '');
      if (!prompt.trim()) throw new Error('Codex CLI proposal adapter prompt is required.');

      const invocation = codexCliInvocation(options.command || codexCliCommand(), options.commandPrefixArgs);
      const commandSpec = {
        command: invocation.command,
        args: codexCliExecArgs({
          prefixArgs: invocation.prefixArgs,
          sandbox: options.sandbox || 'read-only',
          approvalPolicy: options.approvalPolicy || 'never',
          outputLastMessagePath,
          prompt,
          ephemeral: options.ephemeral,
          json: options.json,
        }),
        cwd: workspaceRoot,
      };
      const processResult = await runMachineProcess({
        command: commandSpec.command,
        args: commandSpec.args,
        cwd: commandSpec.cwd,
        env: options.env,
        extraEnv: options.extraEnv,
        timeoutMs: options.timeoutMs || DEFAULT_CODEX_CLI_TIMEOUT_MS,
        maxOutputBytes: options.maxOutputBytes || 64 * 1024,
      });

      let parsed = null;
      let rawLastMessage = '';
      let parseError = null;
      try {
        const result = await readCodexAdapterResult(outputLastMessagePath);
        parsed = result.value;
        rawLastMessage = result.raw;
      } catch (err) {
        parseError = err;
      }

      const artifacts = [];
      const transcriptArtifact = await registerJsonArtifact(runRoot, {
        runId,
        artifactPath: `artifacts/adapters/${request.adapterCallId}.transcript.json`,
        producedBy: 'codex-cli-proposal',
        value: {
          request: {
            adapterCallId: request.adapterCallId,
            attemptId: request.attemptId,
            idempotencyKey: request.idempotencyKey,
            taskKind: request.taskKind,
          },
          command: {
            command: commandSpec.command,
            args: processResult.args || [],
            cwdKind: 'canonical-readonly',
          },
          process: processResult,
          outputLastMessagePath,
          parseError: parseError ? {
            message: parseError.message,
            code: parseError.code || '',
          } : null,
        },
      });
      if (transcriptArtifact?.file?.path) artifacts.push(transcriptArtifact.file.path);

      if (rawLastMessage) {
        const lastMessageArtifact = await registerArtifact(runRoot, {
          runId,
          artifactPath: `artifacts/adapters/${request.adapterCallId}.last-message.json`,
          content: rawLastMessage.endsWith('\n') ? rawLastMessage : `${rawLastMessage}\n`,
          producedBy: 'codex-cli-proposal',
          registeredBy: 'machine',
          schemaVersion: parsed?.schemaVersion || '',
        });
        if (lastMessageArtifact?.file?.path) artifacts.push(lastMessageArtifact.file.path);
      }

      if (!parsed) {
        return {
          schemaVersion: 'orpad.workerResult.v1',
          adapterCallId: request.adapterCallId,
          attemptId: request.attemptId,
          idempotencyKey: request.idempotencyKey,
          status: 'failed',
          summary: parseError
            ? `Codex CLI proposal adapter did not return valid JSON: ${parseError.message}`
            : 'Codex CLI proposal adapter did not return a result.',
          artifacts,
          verification: [{
            command: commandSpec.command,
            args: processResult.args || [],
            cwdKind: 'canonical-readonly',
            exitCode: processResult.code,
            timedOut: processResult.timedOut,
            stdoutTruncated: processResult.stdoutTruncated,
            stderrTruncated: processResult.stderrTruncated,
          }],
        };
      }

      return {
        schemaVersion: 'orpad.workerResult.v1',
        adapterCallId: request.adapterCallId,
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        status: resultStatusForCodexProcess(processResult, parsed),
        summary: parsed.summary || 'Codex CLI proposal adapter returned a Machine result.',
        artifacts: [...new Set([...(parsed.artifacts || []), ...artifacts])],
        candidateProposals: Array.isArray(parsed.candidateProposals) ? parsed.candidateProposals : [],
        triageTransitions: Array.isArray(parsed.triageTransitions) ? parsed.triageTransitions : [],
        ...(parsed.emptyPass ? { emptyPass: parsed.emptyPass } : {}),
        ...(parsed.deferredReason ? { deferredReason: parsed.deferredReason } : {}),
        verification: [{
          command: commandSpec.command,
          args: processResult.args || [],
          cwdKind: 'canonical-readonly',
          exitCode: processResult.code,
          timedOut: processResult.timedOut,
          stdoutTruncated: processResult.stdoutTruncated,
          stderrTruncated: processResult.stderrTruncated,
        }],
      };
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
            : 'CLI adapter result requires Machine review before any canonical mutation.',
          artifacts,
          patchArtifact: patchArtifactPath,
          changedFiles: (patch.changes || []).map(change => change.path),
          verification: [{
            command: commandSpec.command,
            args: processResult.args || [],
            cwdKind: 'overlay',
            containment,
            exitCode: processResult.code,
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
  codexCliCommand,
  codexCliExecArgs,
  codexCliInvocation,
  createCliAgentAdapter,
  createCliAgentProposalOnlyAdapter,
  createCodexCliProposalAdapter,
  readCodexAdapterResult,
  missingExpectedChangedFiles,
  prepareCliOverlayWorkspace,
  resultStatusForProcess,
};
