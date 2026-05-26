const path = require('path');

const {
  ensureDir,
  readJsonIfExists,
  writeJsonAtomic,
} = require('./metadata-store');

const NODE_PACK_WORKSPACE_LOCK_KIND = 'orpad.workspaceNodePackLock';
const NODE_PACK_WORKSPACE_LOCK_SCHEMA_VERSION = '1.0';
const NODE_PACK_WORKSPACE_LOCK_DIR = '.orpad';
const NODE_PACK_WORKSPACE_LOCK_FILE = 'orpad-node-packs.lock.json';
const NODE_PACK_WORKSPACE_LOCK_METADATA_TRUST = 'registry-discovery-only';

function diagnostic(level, code, message, details = {}) {
  return { level, code, message, ...details };
}

function errorDiagnostic(code, message, details = {}) {
  return diagnostic('error', code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compactString(value, fallback = '', limit = 1024) {
  const text = String(value ?? fallback ?? '').trim();
  if (!text) return '';
  return text.length > limit ? text.slice(0, limit) : text;
}

function compactStringArray(values, limit = 160) {
  const source = Array.isArray(values) ? values : [];
  const seen = new Set();
  const result = [];
  for (const value of source) {
    const text = compactString(value, '', limit);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result.sort();
}

function diagnosticArray(values) {
  return (Array.isArray(values) ? values : []).filter(item => item && typeof item === 'object');
}

function nodeTypesFromPack(pack = {}) {
  const explicit = compactStringArray(pack.resolvedNodeTypes || pack.nodeTypes);
  if (explicit.length) return explicit;
  if (!Array.isArray(pack.nodes)) return [];
  return compactStringArray(pack.nodes.map(node => node?.type));
}

function workspaceNodePackLockPath(workspacePath) {
  const root = workspacePath ? path.resolve(String(workspacePath)) : '';
  return root ? path.join(root, NODE_PACK_WORKSPACE_LOCK_DIR, NODE_PACK_WORKSPACE_LOCK_FILE) : '';
}

function emptyWorkspaceNodePackLock(now = new Date().toISOString()) {
  return {
    kind: NODE_PACK_WORKSPACE_LOCK_KIND,
    schemaVersion: NODE_PACK_WORKSPACE_LOCK_SCHEMA_VERSION,
    updatedAt: now,
    packs: [],
  };
}

function normalizeWorkspaceNodePackLockEntry(entry = {}) {
  if (!isPlainObject(entry)) return null;
  const id = compactString(entry.id || entry.packId, '', 160);
  if (!id) return null;
  return {
    id,
    version: compactString(entry.version || entry.latestVersion || entry.requiredVersion, '', 120),
    registrySource: compactString(entry.registrySource || entry.registry || entry.registryUrl, '', 2048),
    source: compactString(entry.source, entry.registrySource || entry.registry ? 'registry' : 'workspace-lock', 160),
    sourceRepository: compactString(entry.sourceRepository || entry.repository || entry.author?.repository, '', 2048),
    sourceRef: compactString(entry.sourceRef || entry.ref, '', 240),
    manifestPath: compactString(entry.manifestPath || entry.discovery?.manifestPath, '', 1024),
    manifestSha256: compactString(entry.manifestSha256 || entry.checksum || entry.sha256, '', 160),
    checksum: compactString(entry.checksum || entry.manifestSha256 || entry.sha256, '', 160),
    signatureStatus: compactString(entry.signatureStatus, '', 120),
    checksumStatus: compactString(entry.checksumStatus, '', 120),
    reviewStatus: compactString(entry.reviewStatus, '', 120),
    trustLevel: compactString(entry.trustLevel || entry.trust, '', 120),
    capabilities: compactStringArray(entry.capabilities),
    highRiskCapabilities: compactStringArray(entry.highRiskCapabilities),
    resolvedNodeTypes: compactStringArray(entry.resolvedNodeTypes || entry.nodeTypes),
    installedAt: compactString(entry.installedAt, '', 120),
    installedBy: compactString(entry.installedBy, '', 160),
    resolvedAt: compactString(entry.resolvedAt, '', 120),
    action: compactString(entry.action, '', 80),
    metadataTrust: NODE_PACK_WORKSPACE_LOCK_METADATA_TRUST,
    diagnostics: diagnosticArray(entry.diagnostics),
  };
}

function normalizeWorkspaceNodePackLock(lock = {}) {
  const now = new Date().toISOString();
  const packs = (Array.isArray(lock?.packs) ? lock.packs : [])
    .map(normalizeWorkspaceNodePackLockEntry)
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    kind: NODE_PACK_WORKSPACE_LOCK_KIND,
    schemaVersion: NODE_PACK_WORKSPACE_LOCK_SCHEMA_VERSION,
    updatedAt: compactString(lock?.updatedAt, now, 120),
    packs,
  };
}

async function readWorkspaceNodePackLock(options = {}) {
  const lockPath = workspaceNodePackLockPath(options.workspacePath);
  if (!lockPath) {
    return {
      ok: false,
      success: false,
      path: '',
      lockPath: '',
      lock: emptyWorkspaceNodePackLock(),
      diagnostics: [
        errorDiagnostic('NODE_PACK_WORKSPACE_LOCK_ROOT_MISSING', 'Workspace Package lock requires a workspace path.'),
      ],
    };
  }
  let lock;
  try {
    lock = await readJsonIfExists(lockPath, null);
  } catch (err) {
    return {
      ok: false,
      success: false,
      path: lockPath,
      lockPath,
      lock: emptyWorkspaceNodePackLock(),
      diagnostics: [
        errorDiagnostic('NODE_PACK_WORKSPACE_LOCK_INVALID', 'Workspace Package lock could not be read.', {
          path: lockPath,
          error: err.message,
        }),
      ],
    };
  }
  if (lock === null) {
    return {
      ok: true,
      success: true,
      path: lockPath,
      lockPath,
      lock: emptyWorkspaceNodePackLock(),
      diagnostics: [],
    };
  }
  if (
    !isPlainObject(lock)
    || lock.kind !== NODE_PACK_WORKSPACE_LOCK_KIND
    || lock.schemaVersion !== NODE_PACK_WORKSPACE_LOCK_SCHEMA_VERSION
    || !Array.isArray(lock.packs)
  ) {
    return {
      ok: false,
      success: false,
      path: lockPath,
      lockPath,
      lock: emptyWorkspaceNodePackLock(),
      diagnostics: [
        errorDiagnostic('NODE_PACK_WORKSPACE_LOCK_INVALID', 'Workspace Package lock has an unsupported shape.', {
          path: lockPath,
        }),
      ],
    };
  }
  const normalized = normalizeWorkspaceNodePackLock(lock);
  return {
    ok: true,
    success: true,
    path: lockPath,
    lockPath,
    lock: normalized,
    packs: normalized.packs,
    diagnostics: [],
  };
}

async function writeWorkspaceNodePackLock(lock, options = {}) {
  const lockPath = workspaceNodePackLockPath(options.workspacePath);
  if (!lockPath) {
    return {
      ok: false,
      success: false,
      path: '',
      lockPath: '',
      lock: emptyWorkspaceNodePackLock(),
      diagnostics: [
        errorDiagnostic('NODE_PACK_WORKSPACE_LOCK_ROOT_MISSING', 'Workspace Package lock requires a workspace path.'),
      ],
    };
  }
  const nextLock = normalizeWorkspaceNodePackLock({
    ...(isPlainObject(lock) ? lock : {}),
    updatedAt: new Date().toISOString(),
  });
  await ensureDir(path.dirname(lockPath));
  await writeJsonAtomic(lockPath, nextLock);
  return {
    ok: true,
    success: true,
    path: lockPath,
    lockPath,
    lock: nextLock,
    packs: nextLock.packs,
    diagnostics: [],
  };
}

async function upsertWorkspaceNodePackLockEntry(entry, options = {}) {
  const normalizedEntry = normalizeWorkspaceNodePackLockEntry(entry);
  if (!normalizedEntry) {
    return {
      ok: false,
      success: false,
      path: workspaceNodePackLockPath(options.workspacePath),
      lockPath: workspaceNodePackLockPath(options.workspacePath),
      lock: emptyWorkspaceNodePackLock(),
      diagnostics: [
        errorDiagnostic('NODE_PACK_WORKSPACE_LOCK_ENTRY_INVALID', 'Workspace Package lock entry requires a package id.'),
      ],
    };
  }
  const current = await readWorkspaceNodePackLock(options);
  if (!current.ok) return current;
  const packs = (current.lock.packs || []).filter(item => item.id !== normalizedEntry.id);
  packs.push(normalizedEntry);
  return writeWorkspaceNodePackLock({ ...current.lock, packs }, options);
}

function createWorkspaceNodePackLockEntry(entry = {}, options = {}) {
  const result = isPlainObject(options.result) ? options.result : {};
  const installedPack = isPlainObject(options.installedPack)
    ? options.installedPack
    : (isPlainObject(result.nodePack) ? result.nodePack : {});
  const pack = isPlainObject(entry) ? entry : {};
  const registrySource = compactString(
    options.registrySource || options.registry || pack.registrySource || pack.registry || result.registrySource,
    '',
    2048,
  );
  return normalizeWorkspaceNodePackLockEntry({
    id: options.packId || pack.id || installedPack.id,
    version: options.version || pack.latestVersion || pack.version || installedPack.version,
    registrySource,
    source: registrySource ? 'registry' : (pack.source || installedPack.origin || 'workspace-lock'),
    sourceRepository: pack.sourceRepository || pack.repository || pack.author?.repository || installedPack.sourceRepository,
    sourceRef: pack.sourceRef || installedPack.sourceRef,
    manifestPath: pack.manifestPath || installedPack.manifestPath || installedPack.discovery?.manifestPath,
    manifestSha256: pack.manifestSha256 || installedPack.manifestSha256,
    checksum: pack.checksum || installedPack.checksum,
    signatureStatus: pack.signatureStatus,
    checksumStatus: pack.checksumStatus,
    reviewStatus: pack.reviewStatus,
    trustLevel: pack.trustLevel || installedPack.trustLevel,
    capabilities: pack.capabilities || installedPack.capabilities,
    highRiskCapabilities: pack.highRiskCapabilities || installedPack.highRiskCapabilities,
    resolvedNodeTypes: nodeTypesFromPack(pack).length ? nodeTypesFromPack(pack) : nodeTypesFromPack(installedPack),
    installedAt: installedPack.installedAt || result.installedAt,
    installedBy: options.installedBy || 'node-pack-manager',
    resolvedAt: options.resolvedAt || new Date().toISOString(),
    action: options.action || result.action,
    diagnostics: [
      ...diagnosticArray(pack.diagnostics),
      ...diagnosticArray(result.diagnostics),
    ],
  });
}

module.exports = {
  NODE_PACK_WORKSPACE_LOCK_DIR,
  NODE_PACK_WORKSPACE_LOCK_FILE,
  NODE_PACK_WORKSPACE_LOCK_KIND,
  NODE_PACK_WORKSPACE_LOCK_METADATA_TRUST,
  NODE_PACK_WORKSPACE_LOCK_SCHEMA_VERSION,
  createWorkspaceNodePackLockEntry,
  emptyWorkspaceNodePackLock,
  normalizeWorkspaceNodePackLock,
  normalizeWorkspaceNodePackLockEntry,
  readWorkspaceNodePackLock,
  upsertWorkspaceNodePackLockEntry,
  workspaceNodePackLockPath,
  writeWorkspaceNodePackLock,
};
