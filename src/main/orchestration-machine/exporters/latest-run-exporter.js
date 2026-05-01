const fs = require('fs');
const path = require('path');

const { buildArtifactManifest, writeArtifactManifest } = require('../artifacts');
const { readMachineEvents } = require('../events');
const { atomicWriteFile, ensureDir, writeJsonAtomic } = require('../metadata-store');
const { latestRunExportRoot } = require('../path-resolver');

const fsp = fs.promises;
const LATEST_RUN_EXPORT_RELATIVE_PATH = 'harness/generated/latest-run';

function unsafeLatestRunExportSymlink(relativePath) {
  const err = new Error(`Latest-run export path crosses a symbolic link: ${relativePath}`);
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

async function exportLatestRun(options = {}) {
  const {
    runRoot,
    pipelineDir,
    allowOverwrite = false,
    exportedAt = new Date().toISOString(),
  } = options;
  if (!runRoot) throw new Error('runRoot is required.');
  if (!pipelineDir) throw new Error('pipelineDir is required.');

  const targetRoot = latestRunExportRoot(pipelineDir);
  await assertNoSymlinkInPipelinePath(pipelineDir, LATEST_RUN_EXPORT_RELATIVE_PATH);
  try {
    await fsp.access(targetRoot);
    if (!allowOverwrite) {
      const err = new Error(`Latest-run export already exists: ${targetRoot}`);
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
    const events = await readMachineEvents(runRoot);
    const sourceEventSequence = events.length ? events[events.length - 1].sequence : 0;
    const metadata = {
      schemaVersion: 'orpad.machineLatestRunExport.v1',
      runId: manifest.runId,
      sourceRunRoot: path.resolve(runRoot),
      sourceEventSequence,
      exportedAt,
      status: 'exported',
      artifactManifest: {
        schemaVersion: manifest.schemaVersion,
        sourceEventSequence: manifest.sourceEventSequence,
        files: manifest.files.map(file => ({
          path: file.path,
          sha256: file.sha256,
          size: file.size,
          producedBy: file.producedBy,
          registeredBy: file.registeredBy,
        })),
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
