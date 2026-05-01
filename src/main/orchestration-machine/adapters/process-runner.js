const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

function isSecretEnvName(name) {
  return /(^SENTRY_DSN$|^GITHUB_TOKEN$|^DATABASE_URL$|CONNECTION_STRING|(^|_)(AUTH|COOKIE|CREDENTIALS?|KEY|PASSPHRASE|PRIVATE_KEY|SECRET|SESSION|TOKEN)(_|$)|PASSWORD)/i
    .test(String(name || ''));
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
      input.signal?.removeEventListener?.('abort', abort);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener?.('abort', abort);
      resolve({
        command,
        args,
        cwd,
        code: typeof code === 'number' ? code : null,
        signal: signal || null,
        timedOut,
        cancelled,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        maskedEnvCount: maskedCount,
        maskedEnvNames: masked,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    });
  });
}

module.exports = {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  isSecretEnvName,
  runMachineProcess,
  sanitizeEnvironment,
};
