const fs = require('fs');
const os = require('os');
const path = require('path');

const { assertNoSymlinkInRunPath, registerArtifact } = require('../artifacts');
const { assertCommandGranted } = require('../command-grants');
const { appendMachineEvent } = require('../events');
const { assertCliProcessContainment } = require('./process-containment');
const { redactCommandArgs, runMachineProcess } = require('./process-runner');
const {
  collectOverlayPatch,
  collectWorktreePatch,
  copyAllowedFilesToOverlay,
  fatalPatchWriteSetViolations,
  registerPatchArtifact,
} = require('../patches');
const {
  addWorktree,
  isGitRepository,
  removeWorktree,
  resolveGitToplevel,
  worktreeChangedPaths,
} = require('../git-isolation');

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

async function recordCliAdapterProcessEvent(runRoot, request, eventType, payload = {}) {
  if (!runRoot || !request?.runId || !request?.adapterCallId) return null;
  return appendMachineEvent(runRoot, {
    runId: request.runId,
    actor: 'machine',
    nodePath: request.nodePath,
    eventType,
    payload: {
      adapter: request.adapter,
      adapterCallId: request.adapterCallId,
      attemptId: request.attemptId,
      idempotencyKey: request.idempotencyKey,
      taskKind: request.taskKind,
      ...payload,
    },
  }).catch(() => null);
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
  const mode = overlayRootMode === 'system-temp'
    ? 'system-temp'
    : (overlayRootMode === 'git-worktree' ? 'git-worktree' : 'run-root');

  if (mode === 'git-worktree') {
    // git-worktree isolation checks a real `git worktree add` checkout out into
    // an isolated orpad-machine-worktree-*/wt temp directory, fully outside the
    // canonical workspace so the worker gets a full-repo view without touching
    // canonical. Same safety envelope as system-temp overlays.
    const tempRoot = path.resolve(os.tmpdir());
    if (
      sameResolvedPath(resolvedOverlayRoot, tempRoot)
      || !isInsideResolvedPath(tempRoot, resolvedOverlayRoot)
      || !path.basename(path.dirname(resolvedOverlayRoot)).startsWith('orpad-machine-worktree-')
    ) {
      throw unsafeOverlayRoot(resolvedOverlayRoot, 'git-worktree isolation must use an isolated orpad-machine-worktree-* temp directory');
    }
    if (workspaceRoot && isInsideResolvedPath(workspaceRoot, resolvedOverlayRoot)) {
      throw unsafeOverlayRoot(resolvedOverlayRoot, 'git-worktree isolation must stay outside the canonical workspace');
    }
    return resolvedOverlayRoot;
  }

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

// Opt-in isolation backend selector. 'overlay' (default) is today's write-set
// sliced overlay; 'git-worktree' gives the worker a full clean HEAD checkout
// with real git context. Anything unrecognized resolves to 'overlay'.
function normalizeIsolationStrategy(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (['git-worktree', 'worktree', 'git'].includes(normalized)) return 'git-worktree';
  return 'overlay';
}

// Build a real git worktree as the worker workspace. Returns either a prepared
// workspace descriptor (overlayRootMode: 'git-worktree') or { fallback:true,
// reason } so the caller can degrade to the overlay backend without failing the
// run. Only a git repo whose toplevel IS the canonical workspace root qualifies,
// so worktree-relative paths stay identical to workspace-relative write sets.
async function prepareCliWorktreeWorkspace(options = {}) {
  const { runRoot = '', request, workspaceRoot } = options;
  const resolvedWorkspace = path.resolve(workspaceRoot);
  if (!(await isGitRepository(resolvedWorkspace, { runId: request.runId }))) {
    return { fallback: true, reason: 'not-a-git-repo' };
  }
  const toplevel = await resolveGitToplevel(resolvedWorkspace, { runId: request.runId });
  if (!toplevel || !sameResolvedPath(toplevel, resolvedWorkspace)) {
    return { fallback: true, reason: 'workspace-not-git-toplevel' };
  }
  const worktreeParent = await fsp.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-worktree-'));
  const worktreeRoot = path.join(worktreeParent, 'wt');
  const added = await addWorktree({
    repoRoot: toplevel,
    worktreePath: worktreeRoot,
    ref: 'HEAD',
    runId: request.runId,
    adapterCallId: request.adapterCallId,
  });
  if (!added.ok) {
    await fsp.rm(worktreeParent, { recursive: true, force: true }).catch(() => {});
    return { fallback: true, reason: added.reason || 'worktree-add-failed', detail: added.stderr || '' };
  }
  const overlayRoot = assertCliOverlayRootAllowed({
    overlayRoot: worktreeRoot,
    overlayRootMode: 'git-worktree',
    runRoot,
    workspaceRoot: resolvedWorkspace,
  });
  return {
    workspaceRoot: resolvedWorkspace,
    overlayRoot,
    overlayRootMode: 'git-worktree',
    worktreeParent,
    worktreeRepoRoot: toplevel,
    readOnlyFiles: request.readOnlyFiles || [],
    copied: [],
    isolation: { strategy: 'git-worktree', backend: 'git-worktree' },
  };
}

async function prepareCliOverlayWorkspace(options = {}) {
  const {
    runRoot = '',
    request,
    workspaceRoot = request?.workspaceRoot || '',
  } = options;
  if (!request) throw new Error('adapter request is required.');
  if (!workspaceRoot) throw new Error('workspaceRoot is required.');
  // Adopt a worktree the Machine already prepared (so the pre-built worker
  // command spec's cwd matches the checkout); fall through otherwise.
  const preparedWorkspace = options.preparedWorkspace || request.preparedWorkspace;
  if (preparedWorkspace && !preparedWorkspace.fallback) return preparedWorkspace;
  const isolationStrategy = normalizeIsolationStrategy(options.isolationStrategy || request.isolationStrategy);
  let isolationFallbackReason = request.isolationFallbackReason || '';
  if (isolationStrategy === 'git-worktree') {
    const worktree = await prepareCliWorktreeWorkspace({ runRoot, request, workspaceRoot });
    if (!worktree.fallback) return worktree;
    isolationFallbackReason = worktree.reason || 'git-worktree-unavailable';
  }
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
    readOnlyFiles: request.readOnlyFiles || [],
  });
  return {
    workspaceRoot: path.resolve(workspaceRoot),
    overlayRoot,
    overlayRootMode,
    readOnlyFiles: request.readOnlyFiles || [],
    copied,
    isolation: {
      strategy: 'overlay',
      backend: 'overlay',
      ...(isolationFallbackReason
        ? { requestedStrategy: 'git-worktree', fallbackReason: isolationFallbackReason }
        : {}),
    },
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
  const fencePattern = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  for (const match of raw.matchAll(fencePattern)) {
    const candidate = String(match[1] || '').trim();
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
  if (processHasSuccessfulDoneWorkerResult(processResult, parsedResult)) return false;
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

function processHasSuccessfulDoneWorkerResult(processResult = {}, parsedResult = null) {
  if (processResult?.code !== 0 || processResult?.timedOut || processResult?.spawnError) return false;
  const workerResult = workerResultDocumentFromValue(parsedResult)
    || workerResultDocumentFromProcessStdout(processResult);
  return normalizeWorkerResultStatus(workerResult?.status) === 'done';
}

function resultStatusForProcess(processResult, patch, request = {}, parsedWorkerResult = null) {
  if (processLooksApprovalRequired(processResult, parsedWorkerResult)) return 'approval-required';
  if (fatalPatchWriteSetViolations(patch).length) return 'blocked';
  if (processResult.timedOut) {
    return (patch.changes || []).length ? 'blocked' : 'failed';
  }
  if (processResult.code !== 0) return 'failed';
  if (missingExpectedChangedFiles(patch, normalizeExpectedChangedFiles(request)).length) return 'blocked';
  return 'done';
}

function normalizeWorkerResultStatus(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
  if (!normalized) return '';
  if (normalized === 'done') return 'done';
  if (['blocked', 'partial', 'incomplete', 'needs-action', 'needs-review'].includes(normalized)) return 'blocked';
  if (['failed', 'failure', 'error'].includes(normalized)) return 'failed';
  if (['approval-required', 'approvalrequired', 'requires-approval', 'permission-required'].includes(normalized)) {
    return 'approval-required';
  }
  if (['queued', 'queue'].includes(normalized)) return 'queued';
  if (['requeued', 're-queued', 'requeue'].includes(normalized)) return 'requeued';
  if (['rejected', 'reject'].includes(normalized)) return 'rejected';
  return '';
}

function workerResultDocumentFromValue(value, depth = 0, seen = new Set()) {
  if (!value || depth > 4) return null;
  if (typeof value === 'string') {
    for (const doc of parseJsonDocuments(value)) {
      const found = workerResultDocumentFromValue(doc, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  const status = normalizeWorkerResultStatus(value.status);
  if (status && (
    value.schemaVersion === 'orpad.workerResult.v1'
    || value.summary !== undefined
    || value.changedFiles !== undefined
    || value.patchArtifact !== undefined
  )) {
    return value;
  }
  for (const key of ['workerResult', 'result', 'payload', 'data', 'message']) {
    const nested = value[key];
    const found = workerResultDocumentFromValue(nested, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function workerResultDocumentFromProcessStdout(processResult = {}) {
  for (const doc of parseJsonDocuments(processResult.stdout)) {
    const result = workerResultDocumentFromValue(doc);
    if (result) return result;
  }
  return null;
}

function mergeWorkerStatus(processStatus, parsedStatus) {
  const normalizedProcess = normalizeWorkerResultStatus(processStatus) || 'failed';
  const normalizedParsed = normalizeWorkerResultStatus(parsedStatus);
  if (!normalizedParsed) return normalizedProcess;
  if (normalizedProcess === 'approval-required' || normalizedProcess === 'failed') return normalizedProcess;
  if (normalizedProcess !== 'done') return normalizedProcess;
  return normalizedParsed;
}

function summaryForCliAgentResult({ status, approvalRequired, parsedSummary, processResult = {}, patch = {} } = {}) {
  if (approvalRequired) {
    return 'CLI provider requested tool permission. Approve to retry this work item with the run bypass option, or decline to keep it blocked.';
  }
  if (parsedSummary) return parsedSummary;
  if (status === 'done') return 'CLI adapter completed in overlay and produced a Machine-owned result.';
  if (fatalPatchWriteSetViolations(patch).length) {
    return 'CLI adapter produced overlay changes outside the allowed write set; no canonical mutation is allowed until the work item is narrowed or retried.';
  }
  if (processResult.spawnError) {
    return `CLI adapter process could not start: ${processResult.spawnError.message}`;
  }
  if (processResult.timedOut) {
    const hasPatch = (patch.changes || []).length > 0;
    return hasPatch
      ? 'CLI adapter timed out before emitting the required worker result JSON. The captured overlay diff is audit-only and will not be auto-applied; split or retry the work item.'
      : 'CLI adapter timed out before emitting the required worker result JSON. Split or retry the work item with a smaller scope.';
  }
  if (processResult.code !== 0) {
    return `CLI adapter exited with code ${processResult.code}; inspect the transcript and retry or narrow the work item.`;
  }
  return 'CLI adapter did not produce a valid worker result contract; inspect the transcript and retry or narrow the work item.';
}

function safeOverlayArtifactRelativePath(value) {
  const portable = String(value || '').replace(/\\/g, '/').trim();
  if (!portable || portable.startsWith('/') || /^[a-zA-Z]:\//.test(portable)) return '';
  const segments = portable.split('/').filter(Boolean);
  if (!segments.length || segments.some(segment => segment === '.' || segment === '..' || /^[a-zA-Z]:$/.test(segment))) return '';
  return segments.join('/');
}

async function registerIgnoredGeneratedArtifacts(runRoot, options = {}) {
  const {
    runId,
    adapterCallId,
    overlayRoot,
    ignoredGeneratedFiles = [],
  } = options;
  if (!runRoot || !runId || !overlayRoot || !ignoredGeneratedFiles.length) return [];
  const registered = [];
  const artifactStem = idSegment(adapterCallId);
  for (const ignored of ignoredGeneratedFiles) {
    if (ignored?.reason !== 'overlay-generated-validation-artifact') continue;
    const sourceRel = safeOverlayArtifactRelativePath(ignored?.path);
    if (!sourceRel) continue;
    const sourcePath = path.resolve(overlayRoot, ...sourceRel.split('/'));
    if (!isInsideResolvedPath(overlayRoot, sourcePath)) continue;
    const stat = await fsp.stat(sourcePath).catch(err => (err?.code === 'ENOENT' ? null : Promise.reject(err)));
    if (!stat?.isFile()) continue;
    const artifactPath = `artifacts/work-items/${artifactStem}/validation/${sourceRel}`;
    await assertNoSymlinkInRunPath(runRoot, artifactPath);
    const targetPath = path.join(path.resolve(runRoot), ...artifactPath.split('/'));
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.copyFile(sourcePath, targetPath);
    const artifact = await registerArtifact(runRoot, {
      runId,
      artifactPath,
      producedBy: 'cli-agent-overlay-validation',
      registeredBy: 'machine',
    });
    if (artifact?.file?.path) registered.push(artifact.file.path);
  }
  return registered;
}

function cliOutputLastMessagePath(commandSpec = {}, overlayRoot = '') {
  const args = Array.isArray(commandSpec.args) ? commandSpec.args.map(arg => String(arg)) : [];
  const index = args.findIndex(arg => arg === '--output-last-message');
  const rawPath = index >= 0 ? String(args[index + 1] || '').trim() : '';
  if (!rawPath || !overlayRoot) return null;
  const base = commandSpec.cwd || overlayRoot;
  const sourcePath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(base, rawPath);
  if (!isInsideResolvedPath(overlayRoot, sourcePath)) return null;
  const sourceRel = path.relative(path.resolve(overlayRoot), sourcePath).replace(/\\/g, '/');
  const safeRel = safeOverlayArtifactRelativePath(sourceRel);
  if (!safeRel) return null;
  return { sourcePath, sourceRel: safeRel };
}

async function readCliOutputLastMessage(commandSpec = {}, overlayRoot = '') {
  const outputPath = cliOutputLastMessagePath(commandSpec, overlayRoot);
  if (!outputPath) return null;
  let raw = '';
  try {
    raw = await fsp.readFile(outputPath.sourcePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ...outputPath, raw: '', parsedWorkerResult: null, parseError: 'output-last-message-file-missing' };
    }
    throw err;
  }
  const parsedWorkerResult = workerResultDocumentFromValue(raw);
  return {
    ...outputPath,
    raw,
    parsedWorkerResult,
    parseError: parsedWorkerResult ? '' : 'output-last-message-did-not-contain-worker-result-json',
  };
}

function parsedWorkerVerificationEntries(parsedWorkerResult = {}) {
  if (!Array.isArray(parsedWorkerResult?.verification)) return [];
  return parsedWorkerResult.verification
    .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map(entry => ({ ...entry, source: entry.source || 'worker-result' }));
}

function nonEmptyString(value) {
  const text = String(value || '').trim();
  return text || '';
}

async function directoryExists(dirPath) {
  try {
    return (await fsp.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

function defaultPlaywrightBrowsersPath() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'ms-playwright');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  }
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}

async function workspaceHasPlaywright(nodeModules) {
  return directoryExists(path.join(nodeModules, 'playwright'))
    || directoryExists(path.join(nodeModules, 'playwright-core'));
}

async function exposePlaywrightBrowsersToValidationEnv(options = {}) {
  const { workspaceRoot = '', extraEnv = {} } = options;
  if (!workspaceRoot) return extraEnv;
  const nodeModules = path.join(path.resolve(workspaceRoot), 'node_modules');
  if (!(await workspaceHasPlaywright(nodeModules))) return extraEnv;

  const configuredBrowsersPath = String(
    extraEnv.PLAYWRIGHT_BROWSERS_PATH || process.env.PLAYWRIGHT_BROWSERS_PATH || '',
  ).trim();
  if (configuredBrowsersPath === '0') return extraEnv;

  const browserCache = path.resolve(configuredBrowsersPath || defaultPlaywrightBrowsersPath());
  if (!(await directoryExists(browserCache))) return extraEnv;

  return {
    ...extraEnv,
    PLAYWRIGHT_BROWSERS_PATH: browserCache,
  };
}

async function canonicalDependencyEnv(workspaceRoot, baseExtraEnv = {}, options = {}) {
  const extraEnv = { ...(baseExtraEnv || {}) };
  const nodeModules = path.join(path.resolve(workspaceRoot || ''), 'node_modules');
  try {
    const stats = await fsp.stat(nodeModules);
    if (!stats.isDirectory()) return extraEnv;
  } catch {
    return extraEnv;
  }
  const nodePathParts = [
    nodeModules,
    ...(String(extraEnv.NODE_PATH || process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)),
  ];
  const pathParts = [
    path.join(nodeModules, '.bin'),
    ...(String(extraEnv.PATH || process.env.PATH || '').split(path.delimiter).filter(Boolean)),
  ];
  extraEnv.NODE_PATH = [...new Set(nodePathParts)].join(path.delimiter);
  extraEnv.PATH = [...new Set(pathParts)].join(path.delimiter);
  return exposePlaywrightBrowsersToValidationEnv({
    workspaceRoot,
    extraEnv,
  });
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || '').trim()).filter(Boolean);
}

function extractedWorkerEvidenceFields(parsed = {}, actualChangedFiles = []) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const evidence = {};
  for (const field of [
    'failingSymptom',
    'failureSymptom',
    'rootCause',
    'rootCauses',
    'verificationCommands',
    'validationCommands',
    'residualRisk',
    'residualRisks',
    'workerEvidence',
    'itemEvidence',
    'contractEvidence',
    'evidence',
    'blockedReason',
    'deferredReason',
    'nextAction',
  ]) {
    if (parsed[field] !== undefined) evidence[field] = parsed[field];
  }
  if (actualChangedFiles.length) {
    evidence.filesChanged = actualChangedFiles;
  } else if (parsed.filesChanged !== undefined) {
    evidence.reportedFilesChanged = parsed.filesChanged;
  }
  if (parsed.status !== undefined) evidence.reportedStatus = String(parsed.status || '');
  return evidence;
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
      const isWorktreeBackend = overlay.overlayRootMode === 'git-worktree';
      const cleanupSystemOverlay = overlay.overlayRootMode === 'system-temp' && options.keepOverlay !== true;
      const cleanupWorktree = isWorktreeBackend && options.keepOverlay !== true;
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
        let processExtraEnv = {};
        try {
          processExtraEnv = await canonicalDependencyEnv(overlay.workspaceRoot, options.extraEnv, {
            overlayRoot: overlay.overlayRoot,
          });
          processResult = await runMachineProcess({
            command: commandSpec.command,
            args: commandSpec.args || [],
            stdin: commandSpec.stdin,
            cwd: commandSpec.cwd,
            runId,
            adapterCallId: request.adapterCallId,
            env: options.env,
            extraEnv: processExtraEnv,
            timeoutMs: options.timeoutMs,
            maxOutputBytes: options.maxOutputBytes,
            onStarted: processInfo => recordCliAdapterProcessEvent(runRoot, request, 'adapter.process.started', {
              processKey: processInfo.processKey,
              pid: processInfo.pid,
              command: processInfo.command,
              args: processInfo.args,
              cwd: processInfo.cwd,
              startedAt: processInfo.startedAt,
            }),
            onFinished: processInfo => recordCliAdapterProcessEvent(runRoot, request, 'adapter.process.finished', {
              processKey: processInfo.processKey,
              pid: processInfo.pid,
              code: processInfo.code ?? null,
              signal: processInfo.signal || null,
              timedOut: processInfo.timedOut === true,
              cancelled: processInfo.cancelled === true,
              startedAt: processInfo.startedAt,
              finishedAt: processInfo.finishedAt,
              ...(processInfo.spawnErrorCode ? { spawnErrorCode: processInfo.spawnErrorCode } : {}),
              ...(processInfo.spawnErrorMessage ? { spawnErrorMessage: processInfo.spawnErrorMessage } : {}),
            }),
          });
        } catch (err) {
          processResult = failedProcessResult(commandSpec, err);
        }
        const outputLastMessage = await readCliOutputLastMessage(commandSpec, overlay.overlayRoot);
        let worktreeChangedPathsError = '';
        let patch;
        if (isWorktreeBackend) {
          const changed = await worktreeChangedPaths(overlay.overlayRoot, {
            runId,
            adapterCallId: request.adapterCallId,
          });
          if (!changed.ok) worktreeChangedPathsError = changed.reason || 'git-change-detection-failed';
          patch = await collectWorktreePatch({
            workspaceRoot: overlay.workspaceRoot,
            worktreeRoot: overlay.overlayRoot,
            changedPaths: changed.ok ? changed.paths : [],
            allowedFiles: request.allowedFiles || [],
            now: options.now,
          });
        } else {
          patch = await collectOverlayPatch({
            workspaceRoot: overlay.workspaceRoot,
            overlayRoot: overlay.overlayRoot,
            allowedFiles: request.allowedFiles || [],
            now: options.now,
          });
        }

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
              allowedFiles: request.allowedFiles || [],
              readOnlyFiles: request.readOnlyFiles || [],
            },
            overlay: {
              ...overlay,
              cleanupPlanned: cleanupSystemOverlay || cleanupWorktree,
              isolationStrategy: overlay.isolation?.strategy || 'overlay',
              ...(worktreeChangedPathsError ? { worktreeChangedPathsError } : {}),
              canonicalNodeModulesAvailable: Boolean(processExtraEnv.NODE_PATH),
              playwrightBrowsersPathAvailable: Boolean(
                processExtraEnv.PLAYWRIGHT_BROWSERS_PATH,
              ),
              playwrightBrowsersPathBridged: Boolean(
                processExtraEnv.PLAYWRIGHT_BROWSERS_PATH,
              ),
            },
            containment,
            process: processResult,
            outputLastMessage: outputLastMessage ? {
              sourceRel: outputLastMessage.sourceRel,
              byteLength: Buffer.byteLength(outputLastMessage.raw || '', 'utf8'),
              parsedWorkerResultDetected: Boolean(outputLastMessage.parsedWorkerResult),
              parseError: outputLastMessage.parseError || '',
            } : null,
          },
        });
        if (transcriptArtifact?.file?.path) artifacts.push(transcriptArtifact.file.path);

        if (outputLastMessage?.raw) {
          const lastMessageArtifact = await registerArtifact(runRoot, {
            runId,
            artifactPath: `artifacts/adapters/${request.adapterCallId}.last-message.json`,
            content: outputLastMessage.raw.endsWith('\n') ? outputLastMessage.raw : `${outputLastMessage.raw}\n`,
            producedBy: 'cli-agent-overlay',
            registeredBy: 'machine',
            schemaVersion: outputLastMessage.parsedWorkerResult?.schemaVersion || '',
          });
          if (lastMessageArtifact?.file?.path) artifacts.push(lastMessageArtifact.file.path);
        }

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
        const generatedValidationArtifacts = await registerIgnoredGeneratedArtifacts(runRoot, {
          runId,
          adapterCallId: request.adapterCallId,
          overlayRoot: overlay.overlayRoot,
          ignoredGeneratedFiles: patch.ignoredGeneratedFiles || [],
        });
        artifacts.push(...generatedValidationArtifacts);

        const expectedChangedFiles = normalizeExpectedChangedFiles(request);
        const missingExpectedChanges = missingExpectedChangedFiles(patch, expectedChangedFiles);
        const parsedWorkerResult = workerResultDocumentFromProcessStdout(processResult)
          || outputLastMessage?.parsedWorkerResult
          || null;
        const processStatus = resultStatusForProcess(processResult, patch, request, parsedWorkerResult);
        const status = mergeWorkerStatus(processStatus, parsedWorkerResult?.status);
        const approvalRequired = status === 'approval-required';
        const changedFiles = (patch.changes || []).map(change => change.path);
        const timedOutWithPatch = processResult.timedOut === true && changedFiles.length > 0;
        const parsedSummary = nonEmptyString(parsedWorkerResult?.summary);
        const summary = summaryForCliAgentResult({
          status,
          approvalRequired,
          parsedSummary,
          processResult,
          patch,
        });
        const processVerification = {
          command: commandSpec.command,
          args: processResult.args || [],
          status,
          phase: 'cli-process',
          cwdKind: 'overlay',
          containment,
          exitCode: processResult.code,
          spawnErrorCode: processResult.spawnError?.code || '',
          spawnErrorMessage: processResult.spawnError?.message || '',
          timedOut: processResult.timedOut,
          stdoutTruncated: processResult.stdoutTruncated,
          stderrTruncated: processResult.stderrTruncated,
          redactedArgCount: processResult.redactedArgCount || 0,
          writeSetViolationCount: fatalPatchWriteSetViolations(patch).length,
          ignoredGeneratedFileCount: (patch.ignoredGeneratedFiles || []).length,
          expectedChangedFiles,
          missingExpectedChanges,
          parsedWorkerStatus: parsedWorkerResult?.status || '',
          parsedWorkerResultStatus: status,
          parsedWorkerResultDetected: Boolean(parsedWorkerResult),
          parsedWorkerResultSummary: parsedSummary,
        };
        return {
          schemaVersion: 'orpad.workerResult.v1',
          adapterCallId: request.adapterCallId,
          attemptId: request.attemptId,
          idempotencyKey: request.idempotencyKey,
          status,
          summary,
          artifacts,
          patchArtifact: patchArtifactPath,
          changedFiles,
          ...(timedOutWithPatch ? {
            blockedReason: summary,
            deferredReason: summary,
            nextAction: 'review-timeout-patch-or-retry-smaller-scope',
          } : {}),
          ...(status === 'failed' ? {
            deferredReason: summary,
            nextAction: processResult.timedOut
              ? 'split-or-retry-worker-item-after-timeout'
              : 'inspect-worker-failure-and-retry-or-requeue',
          } : {}),
          ...extractedWorkerEvidenceFields(parsedWorkerResult, changedFiles),
          ...(parsedWorkerResult?.verificationCommands !== undefined ? {
            verificationCommands: parsedWorkerResult.verificationCommands,
          } : {}),
          ...(parsedWorkerResult?.validationCommands !== undefined ? {
            validationCommands: parsedWorkerResult.validationCommands,
          } : {}),
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
          verification: [
            ...parsedWorkerVerificationEntries(parsedWorkerResult),
            processVerification,
          ],
        };
      } finally {
        if (cleanupWorktree) {
          await removeWorktree({
            repoRoot: overlay.worktreeRepoRoot,
            worktreePath: overlay.overlayRoot,
            runId,
            adapterCallId: request.adapterCallId,
          }).catch(() => {});
          if (overlay.worktreeParent) {
            await fsp.rm(overlay.worktreeParent, { recursive: true, force: true }).catch(() => {});
          }
        } else if (cleanupSystemOverlay) {
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
  canonicalDependencyEnv,
  missingExpectedChangedFiles,
  normalizeExpectedChangedFiles,
  normalizeIsolationStrategy,
  prepareCliOverlayWorkspace,
  prepareCliWorktreeWorkspace,
  processLooksApprovalRequired,
  registerJsonArtifact,
  resultStatusForProcess,
  workerResultDocumentFromProcessStdout,
  sameResolvedPath,
};
