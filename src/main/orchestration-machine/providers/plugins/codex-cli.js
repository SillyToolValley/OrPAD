const fs = require('fs');
const path = require('path');

const { registerArtifact } = require('../../artifacts');
const {
  failedProcessResult,
  idSegment,
  registerJsonArtifact,
} = require('../../adapters/cli-agent');
const { runMachineProcess } = require('../../adapters/process-runner');
const { getProviderEntry } = require('../../../../shared/ai/provider-catalog');

const CATALOG_ENTRY = getProviderEntry('codex-cli');

const fsp = fs.promises;
const DEFAULT_CODEX_CLI_TIMEOUT_MS = 10 * 60 * 1000;
const DANGEROUS_CODEX_BYPASS_ARG = '--dangerously-bypass-approvals-and-sandbox';

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

function codexCliCommand() {
  return process.env.ORPAD_CODEX_CLI_PATH || 'codex';
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

function nodeExecutableForCli() {
  const candidates = [
    process.env.ORPAD_MACHINE_NODE_EXEC_PATH,
    process.env.npm_node_execpath,
    process.env.NODE,
    findOnPath(process.platform === 'win32' ? 'node.exe' : 'node'),
    findOnPath('node'),
    process.versions?.electron ? '' : process.execPath,
  ].filter(Boolean);
  return candidates.find(fileExists) || '';
}

function nodeInvocationForScript(scriptPath) {
  const nodeExecutable = nodeExecutableForCli();
  if (nodeExecutable) return { command: nodeExecutable, prefixArgs: [scriptPath] };
  const err = new Error('Codex CLI JavaScript entrypoint requires a Node.js executable, but none was found.');
  err.code = 'MACHINE_CODEX_CLI_NODE_NOT_FOUND';
  err.scriptPath = scriptPath;
  throw err;
}

function codexCliInvocation(command = codexCliCommand(), prefixArgs = []) {
  const configured = String(command || '').trim() || codexCliCommand();
  const configuredPrefixArgs = Array.isArray(prefixArgs) ? prefixArgs.map(arg => String(arg)) : [];
  if (configuredPrefixArgs.length) {
    return { command: configured, prefixArgs: configuredPrefixArgs };
  }
  if (/\.js$/i.test(configured) && fileExists(configured)) {
    return nodeInvocationForScript(configured);
  }
  if (process.platform === 'win32') {
    const base = path.basename(configured).toLowerCase();
    if (['codex', 'codex.cmd', 'codex.ps1', 'codex.exe'].includes(base)) {
      const script = codexScriptFromShim(base === 'codex.exe' ? 'codex.cmd' : configured);
      if (script) return nodeInvocationForScript(script);
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

function createProposalAdapter(options = {}) {
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
      let processResult;
      try {
        processResult = await runMachineProcess({
          command: commandSpec.command,
          args: commandSpec.args,
          cwd: commandSpec.cwd,
          runId,
          adapterCallId: request.adapterCallId,
          env: options.env,
          extraEnv: options.extraEnv,
          timeoutMs: options.timeoutMs || DEFAULT_CODEX_CLI_TIMEOUT_MS,
          maxOutputBytes: options.maxOutputBytes || 64 * 1024,
        });
      } catch (err) {
        processResult = failedProcessResult(commandSpec, err);
      }

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
            spawnErrorCode: processResult.spawnError?.code || '',
            spawnErrorMessage: processResult.spawnError?.message || '',
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
          spawnErrorCode: processResult.spawnError?.code || '',
          spawnErrorMessage: processResult.spawnError?.message || '',
          timedOut: processResult.timedOut,
          stdoutTruncated: processResult.stdoutTruncated,
          stderrTruncated: processResult.stderrTruncated,
        }],
      };
    },
  };
}

function buildWorkerCommandSpec(input = {}) {
  const { adapter = {}, prompt = '', overlayRoot = '' } = input;
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

module.exports = {
  id: CATALOG_ENTRY?.id || 'codex-cli',
  displayName: CATALOG_ENTRY?.displayName || 'OpenAI Codex CLI',
  family: CATALOG_ENTRY?.family || 'cli',
  needsKey: CATALOG_ENTRY ? Boolean(CATALOG_ENTRY.needsKey) : false,
  implementationStatus: CATALOG_ENTRY?.implementationStatus || 'ready',
  statusNote: CATALOG_ENTRY?.statusNote || '',
  capabilities: Object.freeze({
    sessionStrategies: ['none'],
    toolPolicies: ['none'],
    streaming: false,
    structuredOutput: 'free-text',
    sandbox: 'workspace-write',
  }),
  models: CATALOG_ENTRY?.models || Object.freeze([
    Object.freeze({
      id: 'codex',
      qualityTier: 'standard',
      contextWindow: 0,
      costPerMTokensIn: 0,
      costPerMTokensOut: 0,
    }),
  ]),
  defaultModel: CATALOG_ENTRY?.defaultModel || 'codex',
  dangerousArgs: Object.freeze([DANGEROUS_CODEX_BYPASS_ARG]),
  buildWorkerCommandSpec,
  createProposalAdapter,
  // Legacy named exports kept for tests and backward compat.
  codexCliCommand,
  codexCliExecArgs,
  codexCliInvocation,
  createCodexCliProposalAdapter: createProposalAdapter,
  nodeExecutableForCli,
  readCodexAdapterResult,
  DANGEROUS_CODEX_BYPASS_ARG,
};
