const fs = require('fs');
const path = require('path');

const { appendMachineEvent } = require('./events');
const { assertMachineStorageId } = require('./ids');
const { ensureDir, readJsonIfExists, writeJsonAtomic } = require('./metadata-store');

const fsp = fs.promises;

function writeSetRoot(runRoot) {
  return path.join(path.resolve(runRoot), 'locks', 'write-sets');
}

function writeSetLockPath(runRoot, lockId) {
  return path.join(writeSetRoot(runRoot), `${assertMachineStorageId(lockId, 'lockId')}.json`);
}

function writeSetStoreError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function assertWriteSetLockPathSafe(filePath) {
  try {
    const stats = await fsp.lstat(filePath);
    if (stats.isSymbolicLink()) {
      throw writeSetStoreError('MACHINE_WRITE_SET_LOCK_SYMLINK_UNSAFE', 'Machine write-set lock must not be a symlink.');
    }
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
}

function idSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'write-set';
}

function normalizeWriteSetPath(value) {
  const portable = String(value || '').trim().replace(/\\/g, '/');
  if (!portable) return '';
  if (portable.startsWith('/') || portable.match(/^[a-zA-Z]:\//)) {
    throw new Error(`Write-set path must be workspace-relative: ${value}`);
  }
  const normalized = path.posix.normalize(portable);
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    throw new Error(`Write-set path must stay inside the workspace: ${value}`);
  }
  return normalized.replace(/\/+$/g, '');
}

function normalizeWriteSetPaths(paths = []) {
  return [...new Set(paths.map(normalizeWriteSetPath).filter(Boolean))].sort();
}

function pathsOverlap(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

async function readWriteSetLock(runRoot, lockId) {
  const filePath = writeSetLockPath(runRoot, lockId);
  await assertWriteSetLockPathSafe(filePath);
  return readJsonIfExists(filePath, null);
}

async function readWriteSetLocks(runRoot) {
  const root = writeSetRoot(runRoot);
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const locks = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw writeSetStoreError('MACHINE_WRITE_SET_LOCK_SYMLINK_UNSAFE', 'Machine write-set lock must not be a symlink.');
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const lock = await readJsonIfExists(path.join(root, entry.name), null);
    if (lock) locks.push(lock);
  }
  return locks;
}

async function readActiveWriteSetLocks(runRoot) {
  return (await readWriteSetLocks(runRoot)).filter(lock => lock.state === 'active');
}

async function findConflictingWriteSetLock(runRoot, paths, exceptLockId = '') {
  const normalizedPaths = normalizeWriteSetPaths(paths);
  if (!normalizedPaths.length) return null;
  const activeLocks = await readActiveWriteSetLocks(runRoot);
  return activeLocks.find(lock => (
    lock.lockId !== exceptLockId
    && (lock.paths || []).some(lockedPath => normalizedPaths.some(nextPath => pathsOverlap(lockedPath, nextPath)))
  )) || null;
}

async function acquireWriteSetLock(runRoot, options = {}) {
  const {
    runId,
    claimId,
    itemId,
    paths = [],
    now = new Date().toISOString(),
    enforceConflicts = true,
  } = options;
  if (!runId) throw new Error('runId is required.');
  if (!claimId) throw new Error('claimId is required.');
  if (!itemId) throw new Error('itemId is required.');

  const lockId = assertMachineStorageId(options.lockId || `wset-${idSegment(claimId)}`, 'lockId');
  const existing = await readWriteSetLock(runRoot, lockId);
  if (existing?.state === 'active') return { duplicate: true, lock: existing };

  const normalizedPaths = normalizeWriteSetPaths(paths);
  if (enforceConflicts !== false) {
    const conflict = await findConflictingWriteSetLock(runRoot, normalizedPaths, lockId);
    if (conflict) {
      const err = new Error(`Write-set lock conflict with ${conflict.lockId}.`);
      err.code = 'WRITE_SET_LOCK_CONFLICT';
      err.conflict = conflict;
      throw err;
    }
  }

  const lock = {
    schemaVersion: 'orpad.writeSetLock.v1',
    lockId,
    runId,
    claimId,
    itemId,
    state: 'active',
    paths: normalizedPaths,
    createdAt: now,
    updatedAt: now,
  };
  await ensureDir(writeSetRoot(runRoot));
  await writeJsonAtomic(writeSetLockPath(runRoot, lockId), lock);
  const event = await appendMachineEvent(runRoot, {
    runId,
    actor: 'machine',
    eventType: 'write-set.acquired',
    itemId,
    reason: 'dispatcher.write-set-lock',
    payload: {
      lockId,
      claimId,
      paths: normalizedPaths,
      conflictPolicy: enforceConflicts === false ? 'audit-only' : 'enforced',
    },
  });
  return { event, lock };
}

async function releaseWriteSetLock(runRoot, lockId, options = {}) {
  const lock = await readWriteSetLock(runRoot, lockId);
  if (!lock) return null;
  if (lock.state !== 'active') return { duplicate: true, lock };

  const now = options.now || new Date().toISOString();
  const released = {
    ...lock,
    state: options.state || 'released',
    releasedAt: now,
    updatedAt: now,
    releaseReason: options.reason || 'write-set.released',
  };
  await writeJsonAtomic(writeSetLockPath(runRoot, lockId), released);
  const event = await appendMachineEvent(runRoot, {
    runId: lock.runId,
    actor: 'machine',
    eventType: 'write-set.released',
    itemId: lock.itemId,
    reason: released.releaseReason,
    payload: {
      lockId,
      claimId: lock.claimId,
      state: released.state,
      paths: released.paths,
    },
  });
  return { event, lock: released };
}

async function releaseWriteSetLocksForClaim(runRoot, claimId, options = {}) {
  const locks = (await readActiveWriteSetLocks(runRoot)).filter(lock => lock.claimId === claimId);
  const released = [];
  for (const lock of locks) released.push(await releaseWriteSetLock(runRoot, lock.lockId, options));
  return released;
}

module.exports = {
  acquireWriteSetLock,
  assertWriteSetLockPathSafe,
  findConflictingWriteSetLock,
  normalizeWriteSetPath,
  normalizeWriteSetPaths,
  pathsOverlap,
  readActiveWriteSetLocks,
  readWriteSetLock,
  readWriteSetLocks,
  releaseWriteSetLock,
  releaseWriteSetLocksForClaim,
  writeSetLockPath,
  writeSetRoot,
};
