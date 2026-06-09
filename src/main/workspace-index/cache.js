const crypto = require('crypto');
const path = require('path');
const fsp = require('fs/promises');

const WORKSPACE_INDEX_CACHE_VERSION = 3;

function normalizeWorkspaceRoot(workspaceRoot) {
  const resolved = path.resolve(String(workspaceRoot || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function workspaceCacheKey(workspaceRoot) {
  return crypto
    .createHash('sha256')
    .update(normalizeWorkspaceRoot(workspaceRoot))
    .digest('hex')
    .slice(0, 24);
}

function cacheRoot(app) {
  return path.join(app.getPath('userData'), 'workspace-index');
}

function cachePath(app, workspaceRoot) {
  return path.join(cacheRoot(app), `${workspaceCacheKey(workspaceRoot)}.json`);
}

function relativePath(workspaceRoot, targetPath) {
  return path.relative(path.resolve(workspaceRoot), path.resolve(targetPath)).replace(/\\/g, '/');
}

function toRelativeItems(workspaceRoot, items = []) {
  return items.slice(0, 500).map(item => ({
    name: item.name || path.basename(item.path || ''),
    path: item.path ? relativePath(workspaceRoot, item.path) : '',
    kind: item.kind || 'file',
  }));
}

function buildWorkspaceIndexSnapshot(workspaceRoot, summary = {}) {
  const cachedAt = new Date().toISOString();
  return {
    version: WORKSPACE_INDEX_CACHE_VERSION,
    cachedAt,
    workspace: {
      key: workspaceCacheKey(workspaceRoot),
      root: path.resolve(workspaceRoot),
      type: summary.workspaceType || 'Project workspace',
      fileCount: summary.fileCount || 0,
      dirCount: summary.dirCount || 0,
      markdownCount: summary.markdownCount || 0,
      dataCount: summary.dataCount || 0,
      diagramCount: summary.diagramCount || 0,
      logCount: summary.logCount || 0,
      hasObsidian: summary.hasObsidian === true,
      hasRuns: summary.hasRuns === true,
      truncated: summary.truncated === true,
    },
    pipelines: toRelativeItems(workspaceRoot, summary.pipelines || []),
    templatePipelines: toRelativeItems(workspaceRoot, summary.templatePipelines || []),
    legacyRunbooks: toRelativeItems(workspaceRoot, summary.legacyRunbooks || []),
    runbooks: toRelativeItems(workspaceRoot, summary.runbooks || []),
    redaction: {
      contentIncluded: false,
      candidates: toRelativeItems(workspaceRoot, summary.risky || []),
      policy: 'Filename-only scan excludes .env, key-like files, and secret/token/password-like paths from default AI context.',
    },
    topExts: Array.isArray(summary.topExts) ? summary.topExts.slice(0, 24) : [],
  };
}

async function writeWorkspaceIndexCache(app, workspaceRoot, summary = {}) {
  if (!app || !workspaceRoot) return null;
  const snapshot = buildWorkspaceIndexSnapshot(workspaceRoot, summary);
  const targetPath = cachePath(app, workspaceRoot);
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.writeFile(targetPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  return {
    key: snapshot.workspace.key,
    cachedAt: snapshot.cachedAt,
    path: targetPath,
    contentIncluded: false,
  };
}

async function readWorkspaceIndexCache(app, workspaceRoot) {
  if (!app || !workspaceRoot) return null;
  const raw = await fsp.readFile(cachePath(app, workspaceRoot), 'utf-8');
  const snapshot = JSON.parse(raw);
  return snapshot?.version === WORKSPACE_INDEX_CACHE_VERSION ? snapshot : null;
}

module.exports = {
  WORKSPACE_INDEX_CACHE_VERSION,
  buildWorkspaceIndexSnapshot,
  cachePath,
  readWorkspaceIndexCache,
  workspaceCacheKey,
  writeWorkspaceIndexCache,
};
