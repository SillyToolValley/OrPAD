const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const REDACTED_ARG = '[redacted]';
const activeMachineProcesses = new Map();

function isSecretEnvName(name) {
  return /(^SENTRY_DSN$|^GITHUB_TOKEN$|^DATABASE_URL$|CONNECTION_STRING|(^|_)(AUTH|COOKIE|CREDENTIALS?|KEY|PASSPHRASE|PRIVATE_KEY|SECRET|SESSION|TOKEN)(_|$)|PASSWORD)/i
    .test(String(name || ''));
}

function isSecretArgName(value) {
  return /^-{1,2}(api[-_]?key|auth|authorization|cookie|credential|key|password|passphrase|secret|session|token)$/i
    .test(String(value || '').trim());
}

function looksLikeSecretArgValue(value) {
  const text = String(value || '').trim();
  return /^(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})/.test(text);
}

function redactCommandArgs(args = []) {
  const normalized = Array.isArray(args) ? args.map(arg => String(arg)) : [];
  const redacted = [];
  let redactNext = false;
  let redactedCount = 0;
  for (const arg of normalized) {
    if (redactNext) {
      redacted.push(REDACTED_ARG);
      redactedCount += 1;
      redactNext = false;
      continue;
    }
    const equalsIndex = arg.indexOf('=');
    if (equalsIndex > 0 && isSecretArgName(arg.slice(0, equalsIndex))) {
      redacted.push(`${arg.slice(0, equalsIndex + 1)}${REDACTED_ARG}`);
      redactedCount += 1;
      continue;
    }
    if (isSecretArgName(arg)) {
      redacted.push(arg);
      redactNext = true;
      continue;
    }
    if (looksLikeSecretArgValue(arg)) {
      redacted.push(REDACTED_ARG);
      redactedCount += 1;
      continue;
    }
    redacted.push(arg);
  }
  return { args: redacted, redactedCount };
}

function sanitizeEnvironment(baseEnv = process.env, extraEnv = {}) {
  const merged = { ...(baseEnv || {}), ...(extraEnv || {}) };
  const env = {};
  const masked = [];
  for (const [key, value] of Object.entries(merged)) {
    if (isSecretEnvName(key)) {
      masked.push(key);
      continue;
    }
    env[key] = String(value ?? '');
  }
  return { env, masked, maskedCount: masked.length };
}

function normalizeTimeout(timeoutMs) {
  const value = Number(timeoutMs);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(100, Math.trunc(value)), MAX_TIMEOUT_MS);
}

function trimOutput(current, chunk, maxBytes) {
  const next = Buffer.concat([Buffer.from(current, 'utf8'), Buffer.from(chunk)]);
  if (next.length <= maxBytes) return { value: next.toString('utf8'), truncated: false };
  return {
    value: next.subarray(0, maxBytes).toString('utf8'),
    truncated: true,
  };
}

function runMachineProcess(input = {}) {
  const command = String(input.command || '').trim();
  if (!command) throw new Error('Process command is required.');
  const args = Array.isArray(input.args) ? input.args.map(arg => String(arg)) : [];
  const cwd = String(input.cwd || '').trim();
  if (!cwd) throw new Error('Process cwd is required.');

  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const maxOutputBytes = Number.isFinite(Number(input.maxOutputBytes))
    ? Math.max(1024, Math.trunc(Number(input.maxOutputBytes)))
    : DEFAULT_MAX_OUTPUT_BYTES;
  const { env, masked, maskedCount } = sanitizeEnvironment(input.env || process.env, input.extraEnv || {});
  const redactedArgs = redactCommandArgs(args);
  const runId = String(input.runId || '').trim();
  const adapterCallId = String(input.adapterCallId || '').trim();
  const processKey = String(input.processKey || adapterCallId || '').trim();

  return new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
    });
    const registryKeys = [runId ? `run:${runId}` : '', processKey ? `process:${processKey}` : ''].filter(Boolean);
    let controller = null;
    const unregister = () => {
      if (!controller) return;
      for (const key of registryKeys) {
        const existing = activeMachineProcesses.get(key);
        if (!existing) continue;
        existing.delete(controller);
        if (!existing.size) activeMachineProcesses.delete(key);
      }
    };
    if (input.stdin == null) {
      child.stdin?.end();
    } else {
      child.stdin?.end(String(input.stdin));
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
      } catch {}
    }, timeoutMs);
    const abort = () => {
      cancelled = true;
      try {
        child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
      } catch {}
    };
    controller = { abort };
    for (const key of registryKeys) {
      const existing = activeMachineProcesses.get(key) || new Set();
      existing.add(controller);
      activeMachineProcesses.set(key, existing);
    }
    input.signal?.addEventListener?.('abort', abort, { once: true });

    child.stdout?.on('data', chunk => {
      const next = trimOutput(stdout, chunk, maxOutputBytes);
      stdout = next.value;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr?.on('data', chunk => {
      const next = trimOutput(stderr, chunk, maxOutputBytes);
      stderr = next.value;
      stderrTruncated ||= next.truncated;
    });
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unregister();
      input.signal?.removeEventListener?.('abort', abort);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unregister();
      input.signal?.removeEventListener?.('abort', abort);
      resolve({
        command,
        args: redactedArgs.args,
        cwd,
        code: typeof code === 'number' ? code : null,
        signal: signal || null,
        timedOut,
        cancelled,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        redactedArgCount: redactedArgs.redactedCount,
        maskedEnvCount: maskedCount,
        maskedEnvNames: masked,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    });
  });
}

function abortRegisteredProcesses(key) {
  const controllers = activeMachineProcesses.get(key);
  if (!controllers?.size) return 0;
  let count = 0;
  for (const controller of [...controllers]) {
    count += 1;
    controller.abort();
  }
  return count;
}

function cancelMachineProcessRun(runId) {
  const id = String(runId || '').trim();
  return id ? abortRegisteredProcesses(`run:${id}`) : 0;
}

function cancelMachineProcess(processKey) {
  const key = String(processKey || '').trim();
  return key ? abortRegisteredProcesses(`process:${key}`) : 0;
}

module.exports = {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  cancelMachineProcess,
  cancelMachineProcessRun,
  isSecretEnvName,
  redactCommandArgs,
  runMachineProcess,
  sanitizeEnvironment,
};
