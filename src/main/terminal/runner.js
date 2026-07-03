const { spawn } = require('child_process');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const SHELL_TOKENS = new Set(['&&', '||', ';', '|', '>', '>>', '<', '&']);

const active = new Map();

function normalizeForCompare(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInsidePath(child, parent) {
  if (!child || !parent) return false;
  const resolvedChild = normalizeForCompare(child);
  const resolvedParent = normalizeForCompare(parent);
  if (resolvedChild === resolvedParent) return true;
  const rel = path.relative(resolvedParent, resolvedChild);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function assertSafeCwd({ cwd, workspaceRoot, allowOutsideWorkspace }) {
  if (!cwd) throw new Error('Command Runner requires a working directory.');
  if (!workspaceRoot) {
    if (allowOutsideWorkspace) return path.resolve(cwd);
    throw new Error('Command Runner requires a workspace root, or explicit one-time outside-workspace approval.');
  }
  if (!isInsidePath(cwd, workspaceRoot)) {
    if (allowOutsideWorkspace) return path.resolve(cwd);
    throw new Error('Working directory is outside the workspace. Confirm one-time outside-workspace execution first.');
  }
  return path.resolve(cwd);
}

function isSecretEnvName(name) {
  return /(^SENTRY_DSN$|^GITHUB_TOKEN$|(^|_)(KEY|TOKEN|SECRET)$|PASSWORD)/i.test(String(name || ''));
}

function filterSecrets(env = process.env, { allowNames = null } = {}) {
  const filtered = {};
  let maskedCount = 0;
  for (const [key, value] of Object.entries(env || {})) {
    if (isSecretEnvName(key) && !(allowNames && allowNames.test(String(key)))) {
      maskedCount += 1;
      continue;
    }
    filtered[key] = String(value ?? '');
  }
  return { env: filtered, maskedCount };
}

function validateCommand({ command, args }) {
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('Command is required.');
  if (SHELL_TOKENS.has(cmd)) throw new Error('Shell operators are not supported. Run one explicit command with args.');
  const safeArgs = Array.isArray(args) ? args.map(arg => String(arg)) : [];
  const op = safeArgs.find(arg => SHELL_TOKENS.has(arg));
  if (op) {
    throw new Error(`Shell operator "${op}" is not supported. Command Runner uses shell:false; run one command at a time.`);
  }
  return { command: cmd, args: safeArgs };
}

function normalizeTimeout(timeoutMs) {
  const value = Number(timeoutMs);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(1000, Math.trunc(value)), MAX_TIMEOUT_MS);
}

function cancel(runId, ownerId = null) {
  const entry = active.get(runId);
  if (!entry) return false;
  if (entry.done) return false;
  if (ownerId != null && entry.ownerId !== ownerId) return false;
  entry.cancelled = true;
  try {
    entry.proc.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
  } catch {}
  if (process.platform !== 'win32') {
    setTimeout(() => {
      const latest = active.get(runId);
      if (!latest || latest.done) return;
      try { latest.proc.kill('SIGKILL'); } catch {}
    }, 2000);
  }
  return true;
}

function cancelAll() {
  for (const runId of Array.from(active.keys())) cancel(runId);
}

function runCommand(runId, input, onEvent, options = {}) {
  if (active.size > 0) throw new Error('Command Runner supports one command at a time.');
  if (!runId) throw new Error('runId is required.');

  const { command, args } = validateCommand(input || {});
  const cwd = assertSafeCwd({
    cwd: input.cwd,
    workspaceRoot: input.workspaceRoot,
    allowOutsideWorkspace: input.allowOutsideWorkspace === true,
  });
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const mergedEnv = { ...process.env, ...(input.env && typeof input.env === 'object' ? input.env : {}) };
  const { env, maskedCount } = filterSecrets(mergedEnv);

  const proc = spawn(command, args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
  });

  const entry = {
    proc,
    ownerId: options.ownerId ?? null,
    done: false,
    cancelled: false,
    timeout: null,
  };
  active.set(runId, entry);

  onEvent({
    type: 'start',
    runId,
    command,
    args,
    cwd,
    maskedEnvCount: maskedCount,
    timeoutMs,
  });

  proc.stdout.on('data', chunk => {
    onEvent({ type: 'chunk', runId, stream: 'out', chunk: chunk.toString('utf8') });
  });
  proc.stderr.on('data', chunk => {
    onEvent({ type: 'chunk', runId, stream: 'err', chunk: chunk.toString('utf8') });
  });
  function finish(code, signal) {
    if (entry.done) return;
    entry.done = true;
    if (entry.timeout) clearTimeout(entry.timeout);
    active.delete(runId);
    onEvent({
      type: 'exit',
      runId,
      code: typeof code === 'number' ? code : null,
      signal: signal || null,
      cancelled: entry.cancelled,
    });
  }

  proc.on('error', err => {
    onEvent({ type: 'error', runId, message: err.message || String(err) });
    finish(1, null);
  });
  proc.on('close', (code, signal) => {
    finish(code, signal);
  });

  entry.timeout = setTimeout(() => {
    if (entry.done) return;
    entry.cancelled = true;
    onEvent({ type: 'timeout', runId, timeoutMs });
    cancel(runId);
  }, timeoutMs);

  return {
    runId,
    command,
    args,
    cwd,
    maskedEnvCount: maskedCount,
    timeoutMs,
  };
}

function activeRunCount() {
  return active.size;
}

module.exports = {
  runCommand,
  cancel,
  cancelAll,
  activeRunCount,
  filterSecrets,
  isInsidePath,
  validateCommand,
};
