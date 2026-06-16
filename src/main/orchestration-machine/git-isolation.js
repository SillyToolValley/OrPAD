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

const fs = require('fs');
const path = require('path');

const { runMachineProcess } = require('./adapters/process-runner');
const { normalizeWriteSetPath } = require('./write-sets');

const fsp = fs.promises;

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

function safeWorkspaceJoin(root, relPath) {
  let normalized;
  try {
    normalized = normalizeWriteSetPath(relPath);
  } catch {
    return '';
  }
  if (!normalized) return '';
  const abs = path.join(path.resolve(root), ...normalized.split('/'));
  const rel = path.relative(path.resolve(root), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return abs;
}

// Item 3 (rollback-as-git-revert). Capture a pre-apply checkpoint of the
// canonical workspace for a set of paths, anchored to the current git HEAD for
// provenance. Only succeeds inside a git repo (so rollback is git-gated); the
// content snapshot makes the restore precise across tracked/untracked/dirty/
// created/deleted paths without disturbing the user's branch, HEAD, or index.
async function captureWorkspaceCheckpoint(options = {}) {
  const { workspaceRoot, paths = [], runId = '' } = options;
  if (!workspaceRoot) return { ok: false, reason: 'workspace-required' };
  if (!(await isGitRepository(workspaceRoot, { runId }))) return { ok: false, reason: 'not-a-git-repo' };
  const head = await currentCommit(workspaceRoot, { runId });
  const root = path.resolve(workspaceRoot);
  const seen = new Set();
  const files = [];
  for (const rel of (Array.isArray(paths) ? paths : [])) {
    const abs = safeWorkspaceJoin(root, rel);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    let buffer = null;
    try {
      buffer = await fsp.readFile(abs);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    files.push({
      path: normalizeWriteSetPath(rel),
      existed: buffer !== null,
      base64: buffer ? buffer.toString('base64') : '',
    });
  }
  return { ok: true, head, files };
}

// Restore the canonical workspace to a captured checkpoint: rewrite each
// snapshotted path to its captured bytes, or delete it if it did not exist at
// checkpoint time. Reverts a partially-applied patch batch atomically.
async function restoreWorkspaceCheckpoint(options = {}) {
  const { workspaceRoot, checkpoint } = options;
  if (!checkpoint?.ok) return { ok: false, reason: 'no-checkpoint' };
  const root = path.resolve(workspaceRoot);
  const restored = [];
  for (const file of checkpoint.files || []) {
    const abs = safeWorkspaceJoin(root, file.path);
    if (!abs) continue;
    if (file.existed) {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, Buffer.from(file.base64 || '', 'base64'));
    } else {
      await fsp.rm(abs, { force: true });
    }
    restored.push(file.path);
  }
  return { ok: true, restored: restored.sort() };
}

module.exports = {
  GIT_OP_TIMEOUT_MS,
  addWorktree,
  captureWorkspaceCheckpoint,
  currentCommit,
  isGitRepository,
  parseLineList,
  parseNulList,
  removeWorktree,
  resolveGitToplevel,
  restoreWorkspaceCheckpoint,
  runGit,
  worktreeChangedPaths,
};
