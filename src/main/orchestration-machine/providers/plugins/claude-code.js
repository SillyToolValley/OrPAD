// Claude Code CLI plugin.
//
// PR M8: parallels the codex-cli plugin from M1 — same `family: 'cli'`,
// same proposal-adapter + buildWorkerCommandSpec contract, same overlay
// containment pattern. The wire-format differs only in the CLI args. The
// plugin declares its own `dangerousArgs` so the M1 process-containment
// gate enforces it independently of codex-cli.

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

const fsp = fs.promises;
const DEFAULT_CLAUDE_CODE_TIMEOUT_MS = 10 * 60 * 1000;
const DANGEROUS_CLAUDE_BYPASS_ARG = '--dangerously-skip-permissions';
const CATALOG_ENTRY = getProviderEntry('claude-code');

function pathEntries() {
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean);
}

function fileExists(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function findOnPath(name) {
  for (const entry of pathEntries()) {
    const candidate = path.join(entry, name);
    if (fileExists(candidate)) return candidate;
  }
  return '';
}

function claudeCodeCommand() {
  return process.env.ORPAD_CLAUDE_CODE_CLI_PATH || 'claude';
}

function claudeCodeInvocation(command = claudeCodeCommand(), prefixArgs = []) {
  const configured = String(command || '').trim() || claudeCodeCommand();
  const configuredPrefixArgs = Array.isArray(prefixArgs) ? prefixArgs.map(arg => String(arg)) : [];
  if (configuredPrefixArgs.length) {
    return { command: configured, prefixArgs: configuredPrefixArgs };
  }
  if (/\.js$/i.test(configured) && fileExists(configured)) {
    const node = process.execPath;
    return { command: node, prefixArgs: [configured] };
  }
  // Windows shim variants for `claude` (`.cmd` / `.exe`) work without help.
  return { command: configured, prefixArgs: [] };
}

function normalizeClaudeOutputFormat(value, fallback = 'json') {
  const normalized = String(value || fallback).trim();
  if (['text', 'json', 'stream-json'].includes(normalized)) return normalized;
  return fallback;
}

function claudeCodeExecArgs(options = {}) {
  const args = [
    ...(Array.isArray(options.prefixArgs) ? options.prefixArgs.map(arg => String(arg)) : []),
    '--print',
    '--output-format',
    normalizeClaudeOutputFormat(options.outputFormat),
  ];
  if (options.allowedTools) args.push('--allowed-tools', String(options.allowedTools));
  if (options.disallowedTools) args.push('--disallowed-tools', String(options.disallowedTools));
  if (options.cd) args.push('--cd', String(options.cd));
  args.push(String(options.prompt || ''));
  return args;
}

function extractJsonText(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Claude Code CLI did not write an adapter result.');
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
  throw new Error('Claude Code CLI adapter result was not valid JSON.');
}

function parseClaudeAdapterResultFromStdout(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('Claude Code CLI did not produce stdout.');
  // Claude Code with --output-format json wraps the result in an envelope:
  //   {"type":"result","result":"<assistant text>","session_id":"...", ...}
  // Try to read the envelope first; if shape is different, fall through.
  let envelope = null;
  try { envelope = JSON.parse(text); } catch {}
  const innerText = isPlainObject(envelope) && typeof envelope.result === 'string'
    ? envelope.result
    : text;
  return JSON.parse(extractJsonText(innerText));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resultStatusForClaudeProcess(processResult, parsedResult) {
  if (processResult.timedOut) return 'failed';
  if (processResult.code !== 0) return 'failed';
  const status = parsedResult?.status;
  if (['done', 'blocked', 'queued', 'failed', 'approval-required', 'rejected'].includes(status)) return status;
  return 'blocked';
}

function createProposalAdapter(options = {}) {
  return {
    adapter: 'claude-code-proposal',
    async invoke(request) {
      const runRoot = options.runRoot || '';
      const runId = options.runId || request.runId;
      const workspaceRoot = options.workspaceRoot || request.workspaceRoot;
      if (!runRoot) throw new Error('runRoot is required.');
      if (!workspaceRoot) throw new Error('workspaceRoot is required.');

      const resultDir = path.join(path.resolve(runRoot), 'adapters', 'results');
      await fsp.mkdir(resultDir, { recursive: true });
      const prompt = typeof options.prompt === 'function'
        ? await options.prompt(request)
        : String(options.prompt || '');
      if (!prompt.trim()) throw new Error('Claude Code CLI proposal adapter prompt is required.');

      const invocation = claudeCodeInvocation(options.command || claudeCodeCommand(), options.commandPrefixArgs);
      const commandSpec = {
        command: invocation.command,
        args: claudeCodeExecArgs({
          prefixArgs: invocation.prefixArgs,
          outputFormat: options.outputFormat || 'json',
          allowedTools: options.allowedTools,
          disallowedTools: options.disallowedTools,
          prompt,
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
          timeoutMs: options.timeoutMs || DEFAULT_CLAUDE_CODE_TIMEOUT_MS,
          maxOutputBytes: options.maxOutputBytes || 64 * 1024,
        });
      } catch (err) {
        processResult = failedProcessResult(commandSpec, err);
      }

      let parsed = null;
      let parseError = null;
      try {
        parsed = parseClaudeAdapterResultFromStdout(processResult.stdout);
      } catch (err) {
        parseError = err;
      }

      const artifacts = [];
      const transcriptArtifact = await registerJsonArtifact(runRoot, {
        runId,
        artifactPath: `artifacts/adapters/${request.adapterCallId}.transcript.json`,
        producedBy: 'claude-code-proposal',
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
          parseError: parseError ? {
            message: parseError.message,
            code: parseError.code || '',
          } : null,
        },
      });
      if (transcriptArtifact?.file?.path) artifacts.push(transcriptArtifact.file.path);

      if (!parsed) {
        return {
          schemaVersion: 'orpad.workerResult.v1',
          adapterCallId: request.adapterCallId,
          attemptId: request.attemptId,
          idempotencyKey: request.idempotencyKey,
          status: 'failed',
          summary: parseError
            ? `Claude Code CLI proposal adapter did not return valid JSON: ${parseError.message}`
            : 'Claude Code CLI proposal adapter did not return a result.',
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
        status: resultStatusForClaudeProcess(processResult, parsed),
        summary: parsed.summary || 'Claude Code CLI proposal adapter returned a Machine result.',
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
  const invocation = claudeCodeInvocation(adapter.command || claudeCodeCommand(), adapter.commandPrefixArgs);
  return {
    command: invocation.command,
    args: claudeCodeExecArgs({
      prefixArgs: invocation.prefixArgs,
      outputFormat: adapter.outputFormat || 'json',
      allowedTools: adapter.allowedTools,
      disallowedTools: adapter.disallowedTools,
      prompt,
    }),
    cwd: overlayRoot,
  };
}

module.exports = {
  id: CATALOG_ENTRY?.id || 'claude-code',
  displayName: CATALOG_ENTRY?.displayName || 'Anthropic Claude Code CLI',
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
  models: CATALOG_ENTRY?.models || Object.freeze([]),
  defaultModel: CATALOG_ENTRY?.defaultModel || 'claude-code',
  dangerousArgs: Object.freeze([DANGEROUS_CLAUDE_BYPASS_ARG]),
  buildWorkerCommandSpec,
  createProposalAdapter,
  // Named exports for tests and direct callers.
  claudeCodeCommand,
  claudeCodeExecArgs,
  claudeCodeInvocation,
  normalizeClaudeOutputFormat,
  parseClaudeAdapterResultFromStdout,
  DANGEROUS_CLAUDE_BYPASS_ARG,
};
