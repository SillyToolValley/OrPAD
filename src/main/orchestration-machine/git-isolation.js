// git-isolation.js — machine-side git primitives shared by the opt-in
// git-worktree isolation backend (Item 1), the rollback-as-git-revert
// checkpoint (Item 3), and the PR/CI loop node (Item 2).
//
// Every operation runs `git` through runMachineProcess (same posture as
// provision-node.js: timeouts, output caps, secret-env masking). Nothing here
// throws for an expected git outcome — operations return a typed
// `{ ok, ... , reason? }` result so callers can degrade gracefully when the
// workspace is not a git repo or `git` is unavailable. The default OrPAD
// behavior (overlay isolation, no git) never touches this module.

const path = require('path');

const { runMachineProcess } = require('./adapters/process-runner');

const GIT_OP_TIMEOUT_MS = 2 * 60 * 1000;
const GIT_OUTPUT_BYTES = 512 * 1024;
const STDERR_TAIL_CHARS = 1000;

function tail(value) {
  return String(value || '').slice(-STDERR_TAIL_CHARS);
}

// Run a single git invocation. Resolves (never rejects) with a normalized
// result; a spawn failure (git not installed) surfaces as ok:false with a
// spawnErrorCode instead of throwing.
async function runGit(args, cwd, options = {}) {
  if (!cwd) return { ok: false, code: null, timedOut: false, stdout: '', stderr: '', spawnErrorCode: 'EINVAL', reason: 'cwd-required' };
  try {
    const result = await runMachineProcess({
      command: 'git',
      args: Array.isArray(args) ? args.map(String) : [],
      cwd,
      runId: options.runId || '',
      adapterCallId: options.adapterCallId || '',
      timeoutMs: options.timeoutMs || GIT_OP_TIMEOUT_MS,
      maxOutputBytes: GIT_OUTPUT_BYTES,
    });
    return {
      ok: result.code === 0 && !result.timedOut,
      code: typeof result.code === 'number' ? result.code : null,
      timedOut: Boolean(result.timedOut),
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      spawnErrorCode: '',
    };
  } catch (err) {
    return {
      ok: false,
      code: null,
      timedOut: false,
      stdout: '',
      stderr: err?.message || '',
      spawnErrorCode: err?.code || 'EUNKNOWN',
    };
  }
}

async function isGitRepository(dir, options = {}) {
  const res = await runGit(['rev-parse', '--is-inside-work-tree'], dir, options);
  return res.ok && res.stdout.trim() === 'true';
}

// Absolute path of the git working-tree top for `dir`, or '' if not a repo.
async function resolveGitToplevel(dir, options = {}) {
  const res = await runGit(['rev-parse', '--show-toplevel'], dir, options);
  if (!res.ok) return '';
  const top = res.stdout.trim();
  return top ? path.resolve(top) : '';
}

async function currentCommit(dir, options = {}) {
  const res = await runGit(['rev-parse', 'HEAD'], dir, options);
  return res.ok ? res.stdout.trim() : '';
}

// Create a detached worktree of `ref` (default HEAD) at worktreePath. The
// path must not already exist (git creates it). The worktree's metadata lives
// in the source repo's .git/worktrees and is removed by removeWorktree.
async function addWorktree(options = {}) {
  const { repoRoot, worktreePath, ref = 'HEAD', runId = '', adapterCallId = '' } = options;
  if (!repoRoot) return { ok: false, reason: 'repo-root-required' };
  if (!worktreePath) return { ok: false, reason: 'worktree-path-required' };
  const res = await runGit(
    ['worktree', 'add', '--detach', worktreePath, ref],
    repoRoot,
    { runId, adapterCallId },
  );
  if (!res.ok) {
    return {
      ok: false,
      reason: res.spawnErrorCode ? 'git-unavailable' : 'worktree-add-failed',
      code: res.code,
      stderr: tail(res.stderr),
      spawnErrorCode: res.spawnErrorCode,
    };
  }
  return { ok: true, worktreePath: path.resolve(worktreePath), repoRoot: path.resolve(repoRoot), ref };
}

// Remove a worktree and prune its registration. Best-effort: returns ok:false
// with a reason on failure but never throws (callers also fs.rm the parent).
async function removeWorktree(options = {}) {
  const { repoRoot, worktreePath, runId = '', adapterCallId = '' } = options;
  if (!repoRoot || !worktreePath) return { ok: false, reason: 'missing-args' };
  const res = await runGit(
    ['worktree', 'remove', '--force', worktreePath],
    repoRoot,
    { runId, adapterCallId },
  );
  // Always prune so a force-removed directory does not leave a dangling
  // registration in .git/worktrees.
  await runGit(['worktree', 'prune'], repoRoot, { runId, adapterCallId });
  if (res.ok) return { ok: true };
  return { ok: false, reason: 'worktree-remove-failed', code: res.code, stderr: tail(res.stderr) };
}

function parseNulList(text) {
  return String(text || '')
    .split('\0')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function parseLineList(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .filter(Boolean);
}

// Workspace-relative paths the worker actually changed inside the worktree,
// computed against the worktree's own HEAD (the worktree started as a clean
// HEAD checkout, so this is exactly the worker's delta — independent of any
// dirty state in the canonical workspace). Covers tracked modifications +
// deletions (`git diff`) and brand-new untracked files (`git ls-files
// --others`). Returns { ok, paths } or { ok:false, reason } on git failure.
async function worktreeChangedPaths(worktreeRoot, options = {}) {
  const diff = await runGit(['diff', '--name-only', '-z', 'HEAD'], worktreeRoot, options);
  if (!diff.ok) {
    return { ok: false, reason: diff.spawnErrorCode ? 'git-unavailable' : 'git-diff-failed', stderr: tail(diff.stderr) };
  }
  const others = await runGit(['ls-files', '--others', '--exclude-standard', '-z'], worktreeRoot, options);
  if (!others.ok) {
    return { ok: false, reason: 'git-ls-files-failed', stderr: tail(others.stderr) };
  }
  const paths = [...new Set([
    ...parseNulList(diff.stdout),
    ...parseNulList(others.stdout),
  ].map(p => p.replace(/\\/g, '/')))].sort();
  return { ok: true, paths };
}

module.exports = {
  GIT_OP_TIMEOUT_MS,
  addWorktree,
  currentCommit,
  isGitRepository,
  parseLineList,
  parseNulList,
  removeWorktree,
  resolveGitToplevel,
  runGit,
  worktreeChangedPaths,
};
