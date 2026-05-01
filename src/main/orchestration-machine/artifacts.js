const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { SCHEMA_VERSIONS, createContractValidator } = require('./contracts');
const { appendMachineEvent, readMachineEvents } = require('./events');
const { ensureDir, writeJsonAtomic } = require('./metadata-store');

const fsp = fs.promises;
const validator = createContractValidator();

function toPortablePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function assertRunRelativePath(artifactPath) {
  const portable = toPortablePath(artifactPath).trim();
  const segments = portable.split('/');
  const hasUnsafeSegment = segments.some(segment => (
    !segment
    || segment === '.'
    || segment === '..'
    || /^[a-zA-Z]:$/.test(segment)
  ));
  const normalized = path.posix.normalize(portable);
  if (
    !portable
    || portable.startsWith('/')
    || /^[a-zA-Z]:\//.test(portable)
    || hasUnsafeSegment
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    throw new Error(`Artifact path must be run-relative: ${artifactPath}`);
  }
  return normalized;
}

function artifactManifestPath(runRoot) {
  return path.join(path.resolve(runRoot), 'artifacts', 'manifest.json');
}

function unsafeArtifactSymlink(relativePath) {
  const err = new Error(`Artifact path crosses a symbolic link: ${relativePath}`);
  err.code = 'MACHINE_ARTIFACT_SYMLINK_UNSAFE';
  err.path = relativePath;
  return err;
}

async function assertNoSymlinkInRunPath(runRoot, relativePath) {
  const safePath = assertRunRelativePath(relativePath);
  const segments = safePath.split('/').filter(Boolean);
  let current = path.resolve(runRoot);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat = null;
    try {
      stat = await fsp.lstat(current);
    } catch (err) {
      if (err?.code === 'ENOENT') break;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw unsafeArtifactSymlink(segments.slice(0, index + 1).join('/'));
    }
  }
  return safePath;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function fileDigest(filePath) {
  const bytes = await fsp.readFile(filePath);
  return {
    sha256: sha256(bytes),
    size: bytes.length,
  };
}

async function buildArtifactManifest(runRoot) {
  const events = await readMachineEvents(runRoot);
  const filesByPath = new Map();
  let runId = '';
  let sourceEventSequence = 0;
  let createdAt = new Date(0).toISOString();

  for (const event of events) {
    if (event.runId) runId = event.runId;
    sourceEventSequence = Math.max(sourceEventSequence, Number(event.sequence) || 0);
    if (event.timestamp) createdAt = event.timestamp;
    if (event.eventType !== 'artifact.registered' || !event.payload?.file) continue;
    filesByPath.set(event.payload.file.path, event.payload.file);
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSIONS.artifactManifest,
    runId,
    createdAt,
    sourceEventSequence,
    files: [...filesByPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
  validator.assertValid('artifactManifest', manifest);
  return manifest;
}

async function writeArtifactManifest(runRoot) {
  const manifest = await buildArtifactManifest(runRoot);
  await assertNoSymlinkInRunPath(runRoot, 'artifacts/manifest.json');
  await writeJsonAtomic(artifactManifestPath(runRoot), manifest);
  return manifest;
}

async function readArtifactManifest(runRoot) {
  await assertNoSymlinkInRunPath(runRoot, 'artifacts/manifest.json');
  return JSON.parse(await fsp.readFile(artifactManifestPath(runRoot), 'utf8'));
}

async function registerArtifact(runRoot, options = {}) {
  const {
    runId,
    artifactPath,
    content,
    producedBy,
    registeredBy = 'machine',
    schemaVersion = '',
  } = options;
  if (!runId) throw new Error('runId is required.');
  if (!producedBy) throw new Error('producedBy is required.');

  const relativePath = assertRunRelativePath(artifactPath);
  await assertNoSymlinkInRunPath(runRoot, relativePath);
  const absolutePath = path.join(path.resolve(runRoot), ...relativePath.split('/'));
  if (content !== undefined) {
    await ensureDir(path.dirname(absolutePath));
    await fsp.writeFile(absolutePath, content, 'utf8');
  }
  const digest = await fileDigest(absolutePath);
  const file = {
    path: relativePath,
    sha256: digest.sha256,
    size: digest.size,
    producedBy,
    registeredBy,
    ...(schemaVersion ? { schemaVersion } : {}),
  };
  const event = await appendMachineEvent(runRoot, {
    runId,
    actor: 'machine',
    eventType: 'artifact.registered',
    artifactRefs: [relativePath],
    payload: { file },
  });
  const manifest = await writeArtifactManifest(runRoot);
  return { event, file, manifest };
}

module.exports = {
  artifactManifestPath,
  assertNoSymlinkInRunPath,
  assertRunRelativePath,
  buildArtifactManifest,
  fileDigest,
  readArtifactManifest,
  registerArtifact,
  sha256,
  writeArtifactManifest,
};
