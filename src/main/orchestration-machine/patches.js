const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { assertNoSymlinkInRunPath, assertRegisteredArtifactFilesUnchanged, registerArtifact } = require('./artifacts');
const { readMachineEvents } = require('./events');
const { normalizeWriteSetPath, normalizeWriteSetPaths, pathsOverlap } = require('./write-sets');

const fsp = fs.promises;

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function bufferIsUtf8Text(buffer) {
  const text = buffer.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buffer);
}

function snapshotFromBuffer(buffer) {
  const text = buffer.toString('utf8');
  const isText = bufferIsUtf8Text(buffer);
  return {
    sha256: sha256Buffer(buffer),
    isText,
    text: isText ? text : '',
    base64: isText ? '' : buffer.toString('base64'),
  };
}

function isPathAllowedByWriteSet(filePath, allowedFiles = []) {
  const normalized = normalizeWriteSetPath(filePath);
  const allowed = normalizeWriteSetPaths(allowedFiles);
  return allowed.some(allowedPath => pathsOverlap(normalized, allowedPath));
}

function resolveWorkspacePath(root, relativePath) {
  const normalized = normalizeWriteSetPath(relativePath);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...normalized.split('/'));
  const rel = path.relative(resolvedRoot, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root: ${relativePath}`);
  }
  return target;
}

async function readTextIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function readFileSnapshotIfExists(filePath) {
  try {
    const buffer = await fsp.readFile(filePath);
    return snapshotFromBuffer(buffer);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function unsafeWorkspaceSymlink(relativePath) {
  const err = new Error(`Workspace path crosses a symbolic link: ${relativePath}`);
  err.code = 'MACHINE_WORKSPACE_SYMLINK_UNSAFE';
  err.path = relativePath;
  return err;
}

async function assertNoSymlinkInWorkspacePath(root, relativePath, options = {}) {
  const { includeLeaf = true } = options;
  const normalized = normalizeWriteSetPath(relativePath);
  const segments = normalized.split('/').filter(Boolean);
  const limit = includeLeaf ? segments.length : Math.max(segments.length - 1, 0);
  let current = path.resolve(root);
  for (let index = 0; index < limit; index += 1) {
    current = path.join(current, segments[index]);
    let stat = null;
    try {
      stat = await fsp.lstat(current);
    } catch (err) {
      if (err?.code === 'ENOENT') break;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw unsafeWorkspaceSymlink(segments.slice(0, index + 1).join('/'));
    }
  }
  return normalized;
}

async function readWorkspaceTextIfExists(root, relativePath) {
  await assertNoSymlinkInWorkspacePath(root, relativePath);
  return readTextIfExists(resolveWorkspacePath(root, relativePath));
}

async function readWorkspaceFileSnapshotIfExists(root, relativePath) {
  await assertNoSymlinkInWorkspacePath(root, relativePath);
  return readFileSnapshotIfExists(resolveWorkspacePath(root, relativePath));
}

function patchChangeFromSnapshots(relPath, before, after) {
  const binary = Boolean(before && !before.isText) || Boolean(after && !after.isText);
  const change = {
    path: relPath,
    beforeExists: before !== null,
    afterExists: after !== null,
    beforeSha256: before === null ? '' : before.sha256,
    afterSha256: after === null ? '' : after.sha256,
  };
  if (binary) {
    return {
      ...change,
      contentEncoding: 'base64',
      beforeContentBase64: before === null ? '' : (before.isText ? Buffer.from(before.text, 'utf8').toString('base64') : before.base64),
      afterContentBase64: after === null ? '' : (after.isText ? Buffer.from(after.text, 'utf8').toString('base64') : after.base64),
    };
  }
  return {
    ...change,
    beforeContent: before === null ? '' : before.text,
    afterContent: after === null ? '' : after.text,
  };
}

function patchChangeUsesBase64(change = {}) {
  return change.contentEncoding === 'base64'
    || Object.prototype.hasOwnProperty.call(change, 'afterContentBase64')
    || Object.prototype.hasOwnProperty.call(change, 'beforeContentBase64');
}

async function walkFiles(root) {
  const files = [];
  async function visit(dir) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  await visit(root);
  return files;
}

function relativePortable(root, filePath) {
  return path.relative(path.resolve(root), path.resolve(filePath)).replace(/\\/g, '/');
}

async function copyAllowedFilesToOverlay(options = {}) {
  const { workspaceRoot, overlayRoot, allowedFiles = [], readOnlyFiles = [] } = options;
  if (!workspaceRoot) throw new Error('workspaceRoot is required.');
  if (!overlayRoot) throw new Error('overlayRoot is required.');
  const copied = [];
  const overlaySeedFiles = normalizeWriteSetPaths([...allowedFiles, ...readOnlyFiles]);
  for (const seedFile of overlaySeedFiles) {
    await assertNoSymlinkInWorkspacePath(workspaceRoot, seedFile);
    const source = resolveWorkspacePath(workspaceRoot, seedFile);
    const stat = await fsp.stat(source).catch(err => (err?.code === 'ENOENT' ? null : Promise.reject(err)));
    if (!stat) continue;
    if (stat.isDirectory()) {
      const sourceFiles = await walkFiles(source);
      for (const sourceFile of sourceFiles) {
        const rel = relativePortable(workspaceRoot, sourceFile);
        const target = path.join(path.resolve(overlayRoot), ...rel.split('/'));
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(sourceFile, target);
        copied.push(rel);
      }
      continue;
    }
    if (!stat.isFile()) continue;
    const target = path.join(path.resolve(overlayRoot), ...seedFile.split('/'));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(source, target);
    copied.push(seedFile);
  }
  return copied.sort();
}

async function collectOverlayPatch(options = {}) {
  const {
    workspaceRoot,
    overlayRoot,
    allowedFiles = [],
    now = new Date().toISOString(),
  } = options;
  if (!workspaceRoot) throw new Error('workspaceRoot is required.');
  if (!overlayRoot) throw new Error('overlayRoot is required.');

  const overlayFiles = await walkFiles(overlayRoot);
  const overlayRelPaths = new Set(overlayFiles.map(file => relativePortable(overlayRoot, file)));
  const allowed = normalizeWriteSetPaths(allowedFiles);
  const changes = [];
  const violations = [];

  for (const relPath of [...overlayRelPaths].sort()) {
    const allowedPath = isPathAllowedByWriteSet(relPath, allowed);
    const before = await readWorkspaceFileSnapshotIfExists(workspaceRoot, relPath);
    const after = await readFileSnapshotIfExists(resolveWorkspacePath(overlayRoot, relPath));
    if (!allowedPath) {
      if ((before?.sha256 || '') !== (after?.sha256 || '')) {
        violations.push({
          path: relPath,
          reason: 'outside-write-set',
        });
      }
      continue;
    }
    if ((before?.sha256 || '') === (after?.sha256 || '')) continue;
    changes.push(patchChangeFromSnapshots(relPath, before, after));
  }

  const deletionCandidates = [];
  for (const relPath of allowed) {
    await assertNoSymlinkInWorkspacePath(workspaceRoot, relPath);
    const sourcePath = resolveWorkspacePath(workspaceRoot, relPath);
    const stat = await fsp.stat(sourcePath).catch(err => (err?.code === 'ENOENT' ? null : Promise.reject(err)));
    if (!stat) continue;
    if (stat.isDirectory()) {
      const sourceFiles = await walkFiles(sourcePath);
      deletionCandidates.push(...sourceFiles.map(file => relativePortable(workspaceRoot, file)));
    } else if (stat.isFile()) {
      deletionCandidates.push(relPath);
    }
  }

  for (const relPath of [...new Set(deletionCandidates)].sort()) {
    const source = await readWorkspaceFileSnapshotIfExists(workspaceRoot, relPath);
    if (source === null || overlayRelPaths.has(relPath)) continue;
    changes.push(patchChangeFromSnapshots(relPath, source, null));
  }

  return {
    schemaVersion: 'orpad.patchArtifact.v1',
    createdAt: now,
    allowedFiles: allowed,
    changes: changes.sort((a, b) => a.path.localeCompare(b.path)),
    violations: violations.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function assertPatchWithinWriteSet(patch, allowedFiles = patch?.allowedFiles || []) {
  if (!patch || patch.schemaVersion !== 'orpad.patchArtifact.v1') {
    throw new Error('Invalid OrPAD patch artifact.');
  }
  if ((patch.violations || []).length) {
    const err = new Error('Patch contains out-of-write-set violations.');
    err.code = 'PATCH_WRITE_SET_VIOLATION';
    err.violations = patch.violations;
    throw err;
  }
  const violation = (patch.changes || []).find(change => !isPathAllowedByWriteSet(change.path, allowedFiles));
  if (violation) {
    const err = new Error(`Patch changes a path outside the allowed write set: ${violation.path}`);
    err.code = 'PATCH_WRITE_SET_VIOLATION';
    err.violations = [violation];
    throw err;
  }
  return patch;
}

async function inspectPatchBase(options = {}) {
  const {
    workspaceRoot,
    patch,
    allowedFiles = patch?.allowedFiles || [],
  } = options;
  if (!workspaceRoot) throw new Error('workspaceRoot is required.');
  assertPatchWithinWriteSet(patch, allowedFiles);

  const prepared = [];
  const mismatches = [];
  const alreadyApplied = [];
  for (const change of patch.changes || []) {
    await assertNoSymlinkInWorkspacePath(workspaceRoot, change.path);
    const target = resolveWorkspacePath(workspaceRoot, change.path);
    const current = patchChangeUsesBase64(change)
      ? await readFileSnapshotIfExists(target)
      : await readTextIfExists(target);
    const currentSha = current === null
      ? ''
      : (patchChangeUsesBase64(change) ? current.sha256 : sha256Text(current));
    const expectedSha = change.beforeExists === false ? '' : change.beforeSha256;
    const afterSha = change.afterExists === false ? '' : change.afterSha256;
    if (currentSha !== expectedSha) {
      const mismatch = {
        path: change.path,
        expectedSha256: expectedSha,
        currentSha256: currentSha,
        afterSha256: afterSha,
        alreadyApplied: currentSha === afterSha,
      };
      mismatches.push(mismatch);
      if (mismatch.alreadyApplied) {
        alreadyApplied.push({ change, target });
        continue;
      }
    }
    prepared.push({ change, target });
  }
  return { prepared, mismatches, alreadyApplied };
}

async function applyPatchArtifact(options = {}) {
  const {
    workspaceRoot,
    patch,
    allowedFiles = patch?.allowedFiles || [],
    now = new Date().toISOString(),
    treatAlreadyAppliedAsSuccess = false,
  } = options;
  const inspection = await inspectPatchBase({ workspaceRoot, patch, allowedFiles });
  const blockingMismatches = treatAlreadyAppliedAsSuccess
    ? inspection.mismatches.filter(item => !item.alreadyApplied)
    : inspection.mismatches;
  if (blockingMismatches.length) {
    const err = new Error(`Patch base mismatch for ${blockingMismatches[0].path}.`);
    err.code = 'PATCH_BASE_MISMATCH';
    err.path = blockingMismatches[0].path;
    err.mismatches = blockingMismatches;
    throw err;
  }

  const applied = [];
  for (const { change, target } of inspection.prepared) {
    if (change.afterExists === false) {
      await fsp.rm(target);
    } else {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      if (patchChangeUsesBase64(change)) {
        await fsp.writeFile(target, Buffer.from(change.afterContentBase64 || '', 'base64'));
      } else {
        await fsp.writeFile(target, change.afterContent || '', 'utf8');
      }
    }
    applied.push({ path: change.path, appliedAt: now });
  }
  if (treatAlreadyAppliedAsSuccess) {
    for (const { change } of inspection.alreadyApplied) {
      applied.push({ path: change.path, appliedAt: now, alreadyApplied: true });
    }
  }
  return { applied };
}

async function registerPatchArtifact(runRoot, options = {}) {
  const { runId, patch, artifactPath, producedBy = 'machine.patch' } = options;
  if (!runId) throw new Error('runId is required.');
  if (!patch) throw new Error('patch is required.');
  return registerArtifact(runRoot, {
    runId,
    artifactPath: artifactPath || `artifacts/patches/${Date.now()}.patch.json`,
    content: `${JSON.stringify(patch, null, 2)}\n`,
    producedBy,
    registeredBy: 'machine',
    schemaVersion: patch.schemaVersion,
  });
}

async function loadRunPatchArtifact(runRoot, patchArtifact) {
  if (!runRoot) throw new Error('runRoot is required.');
  await assertRegisteredArtifactFilesUnchanged(runRoot);
  const safePath = await assertNoSymlinkInRunPath(runRoot, patchArtifact);
  const events = await readMachineEvents(runRoot);
  const registered = events.find(event => (
    event?.eventType === 'artifact.registered'
    && event?.payload?.file?.path === safePath
    && event?.payload?.file?.schemaVersion === 'orpad.patchArtifact.v1'
  ));
  if (!registered) {
    const err = new Error(`Patch artifact is not registered for this run: ${patchArtifact}`);
    err.code = 'MACHINE_PATCH_ARTIFACT_UNREGISTERED';
    err.patchArtifact = safePath;
    throw err;
  }
  const filePath = path.join(path.resolve(runRoot), ...safePath.split('/'));
  const patch = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  if (patch?.schemaVersion !== 'orpad.patchArtifact.v1') {
    const err = new Error('Patch artifact schema is not recognized.');
    err.code = 'MACHINE_PATCH_SCHEMA_INVALID';
    throw err;
  }
  return patch;
}

module.exports = {
  applyPatchArtifact,
  assertNoSymlinkInWorkspacePath,
  assertPatchWithinWriteSet,
  collectOverlayPatch,
  copyAllowedFilesToOverlay,
  inspectPatchBase,
  isPathAllowedByWriteSet,
  loadRunPatchArtifact,
  readTextIfExists,
  registerPatchArtifact,
  resolveWorkspacePath,
  sha256Text,
};
