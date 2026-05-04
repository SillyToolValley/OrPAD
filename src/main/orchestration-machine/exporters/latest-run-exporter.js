const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { writeArtifactManifest } = require('../artifacts');
const { readMachineEvents } = require('../events');
const { atomicWriteFile, ensureDir, writeJsonAtomic } = require('../metadata-store');
const { latestRunExportRoot } = require('../path-resolver');

const fsp = fs.promises;
const LATEST_RUN_EXPORT_RELATIVE_PATH = 'harness/generated/latest-run';
const RUN_METADATA_SCHEMA = 'orpad.runEvidence.v1';
const STATUS_MARKER_RE = /## Status: (done|partial|blocked)\s*$/;

function unsafeLatestRunExportSymlink(relativePath) {
  const err = new Error(`Evidence snapshot path crosses a symbolic link: ${relativePath}`);
  err.code = 'LATEST_RUN_EXPORT_SYMLINK_UNSAFE';
  err.path = relativePath;
  return err;
}

async function assertNoSymlinkInPipelinePath(pipelineDir, relativePath) {
  const segments = String(relativePath || '').split('/').filter(Boolean);
  let current = path.resolve(pipelineDir);
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
      throw unsafeLatestRunExportSymlink(segments.slice(0, index + 1).join('/'));
    }
  }
}

async function copyIfExists(source, target) {
  try {
    await fsp.cp(source, target, { recursive: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

function tryGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function gitStatusDigest(statusText) {
  return createHash('sha256').update(String(statusText || '').replace(/\r\n/g, '\n')).digest('hex');
}

function normalizeManifestPath(relativePath) {
  return `${LATEST_RUN_EXPORT_RELATIVE_PATH}/${String(relativePath || '').replace(/\\/g, '/')}`;
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function readSummaryStatus(filePath) {
  try {
    const summary = await fsp.readFile(filePath, 'utf8');
    return summary.match(STATUS_MARKER_RE)?.[1] || '';
  } catch (err) {
    if (err?.code === 'ENOENT') return '';
    throw err;
  }
}

function eventTimestamp(event) {
  const value = event?.timestamp || event?.createdAt || event?.at || event?.time;
  if (typeof value !== 'string') return '';
  return Number.isFinite(Date.parse(value)) ? value : '';
}

async function collectSnapshotFiles(root, current = root, results = []) {
  let entries = [];
  try {
    entries = await fsp.readdir(current, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return results;
    throw err;
  }
  for (const entry of entries) {
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectSnapshotFiles(root, entryPath, results);
    } else if (entry.isFile()) {
      const bytes = await fsp.readFile(entryPath);
      const relativePath = path.relative(root, entryPath).replace(/\\/g, '/');
      results.push({
        path: normalizeManifestPath(relativePath),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      });
    }
  }
  return results;
}

async function exportLatestRun(options = {}) {
  const {
    runRoot,
    pipelineDir,
    allowOverwrite = false,
    exportedAt = new Date().toISOString(),
    startedAt,
    endedAt,
    status,
    pipelineId,
    headSha,
    workspaceStatusDigest,
    auditCommands = [],
  } = options;
  if (!runRoot) throw new Error('runRoot is required.');
  if (!pipelineDir) throw new Error('pipelineDir is required.');

  const targetRoot = latestRunExportRoot(pipelineDir);
  await assertNoSymlinkInPipelinePath(pipelineDir, LATEST_RUN_EXPORT_RELATIVE_PATH);
  try {
    await fsp.access(targetRoot);
    if (!allowOverwrite) {
      const err = new Error(`Evidence snapshot already exists: ${targetRoot}`);
      err.code = 'LATEST_RUN_EXPORT_EXISTS';
      throw err;
    }
  } catch (err) {
    if (err?.code !== 'ENOENT' && err?.code !== 'LATEST_RUN_EXPORT_EXISTS') throw err;
    if (err?.code === 'LATEST_RUN_EXPORT_EXISTS') throw err;
  }

  const tempRoot = path.join(path.dirname(targetRoot), `.latest-run-export-${process.pid}-${Date.now()}`);
  await ensureDir(tempRoot);
  try {
    const manifest = await writeArtifactManifest(runRoot);
    await copyIfExists(path.join(runRoot, 'artifacts'), path.join(tempRoot, 'artifacts'));
    await copyIfExists(path.join(runRoot, 'queue'), path.join(tempRoot, 'queue'));
    await copyIfExists(path.join(runRoot, 'summary.md'), path.join(tempRoot, 'summary.md'));
    const events = await readMachineEvents(runRoot);
    const sourceEventSequence = events.length ? events[events.length - 1].sequence : 0;
    const pipeline = await readJsonIfExists(path.join(pipelineDir, 'pipeline.or-pipeline'));
    const currentHead = tryGit(['rev-parse', 'HEAD'], pipelineDir);
    const currentStatus = tryGit(['status', '--short'], pipelineDir);
    const snapshotFiles = await collectSnapshotFiles(tempRoot);
    const firstEventAt = eventTimestamp(events[0]);
    const lastEventAt = eventTimestamp(events[events.length - 1]);
    const summaryStatus = await readSummaryStatus(path.join(tempRoot, 'summary.md'));
    const metadata = {
      schemaVersion: RUN_METADATA_SCHEMA,
      pipelineId: pipelineId || pipeline?.id || path.basename(path.resolve(pipelineDir)),
      runId: manifest.runId,
      startedAt: startedAt || firstEventAt || exportedAt,
      endedAt: endedAt || lastEventAt || exportedAt,
      status: status || summaryStatus || 'partial',
      headSha: headSha || currentHead || 'unavailable',
      workspaceStatusDigest: workspaceStatusDigest || gitStatusDigest(currentStatus),
      sourceRunRoot: path.resolve(runRoot),
      sourceEventSequence,
      exportedAt,
      auditCommands,
      artifactManifest: {
        schemaVersion: manifest.schemaVersion,
        sourceEventSequence: manifest.sourceEventSequence,
        files: snapshotFiles.map(file => {
          const durablePath = file.path.slice(`${LATEST_RUN_EXPORT_RELATIVE_PATH}/`.length);
          const registered = manifest.files.find(item => item.path === durablePath);
          return {
            path: file.path,
            sha256: file.sha256,
            size: file.size,
            producedBy: registered?.producedBy,
            registeredBy: registered?.registeredBy,
          };
        }),
      },
    };
    await writeJsonAtomic(path.join(tempRoot, 'run-metadata.json'), metadata);
    await atomicWriteFile(path.join(tempRoot, 'export-status.json'), `${JSON.stringify({
      runId: manifest.runId,
      sourceEventSequence,
      exportedAt,
      status: 'trusted-export',
    }, null, 2)}\n`);

    if (allowOverwrite) await fsp.rm(targetRoot, { recursive: true, force: true });
    await ensureDir(path.dirname(targetRoot));
    await fsp.rename(tempRoot, targetRoot);
    return { targetRoot, metadata };
  } catch (err) {
    await fsp.rm(tempRoot, { recursive: true, force: true });
    throw err;
  }
}

module.exports = {
  assertNoSymlinkInPipelinePath,
  exportLatestRun,
};
