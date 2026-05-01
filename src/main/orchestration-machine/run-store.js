const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { SCHEMA_VERSIONS, createContractValidator } = require('./contracts');
const { appendMachineEvent, projectRunStateFromEvents, readMachineEvents } = require('./events');
const { ensureRunLayout, readJsonIfExists, writeJsonAtomic } = require('./metadata-store');
const {
  assertNoSymlinkInWorkspacePath,
  durableRunRoot,
  latestRunExportRoot,
  resolvePipelineContext,
} = require('./path-resolver');

const fsp = fs.promises;
const validator = createContractValidator();

function createRunId(date = new Date(), randomBytes = crypto.randomBytes(3).toString('hex')) {
  const stamp = date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
    .replace('T', '_')
    .replace('Z', '');
  return `run_${stamp}_${randomBytes}`;
}

function runStatePath(runRoot) {
  return path.join(path.resolve(runRoot), 'run-state.json');
}

function assertRunStoreError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function assertRunStatePathSafe(runRoot) {
  try {
    const stats = await fsp.lstat(runStatePath(runRoot));
    if (stats.isSymbolicLink()) {
      throw assertRunStoreError('MACHINE_RUN_STATE_SYMLINK_UNSAFE', 'Machine run-state.json must not be a symlink.');
    }
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
}

async function readPipeline(pipelinePath) {
  return JSON.parse(await fsp.readFile(pipelinePath, 'utf8'));
}

function runStoreError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function assertRunRootAvailable(runRoot) {
  try {
    await fsp.lstat(runRoot);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  throw runStoreError('MACHINE_RUN_ALREADY_EXISTS', `Machine run already exists: ${path.basename(runRoot)}`);
}

async function writeRunState(runRoot, runState) {
  validator.assertValid('machineRun', runState);
  await assertRunStatePathSafe(runRoot);
  await writeJsonAtomic(runStatePath(runRoot), runState);
  return runState;
}

async function readRunState(runRoot) {
  await assertRunStatePathSafe(runRoot);
  return readJsonIfExists(runStatePath(runRoot), null);
}

async function createMachineRun(options = {}) {
  const {
    workspaceRoot,
    pipelinePath,
    runId = createRunId(),
    now = new Date(),
    canonicalStoreKind = 'jsonl',
  } = options;
  const context = resolvePipelineContext({ workspaceRoot, pipelinePath });
  await assertNoSymlinkInWorkspacePath(context.workspaceRoot, context.pipelinePath, {
    code: 'MACHINE_PIPELINE_SYMLINK_UNSAFE',
    label: 'Machine pipeline file',
  });
  const pipeline = await readPipeline(context.pipelinePath);
  const targetRunRoot = durableRunRoot(context.pipelineDir, runId);
  await assertNoSymlinkInWorkspacePath(context.workspaceRoot, targetRunRoot, {
    code: 'MACHINE_RUN_ROOT_SYMLINK_UNSAFE',
    label: 'Machine run root',
  });
  const exportRoot = latestRunExportRoot(context.pipelineDir);
  const timestamp = now.toISOString();

  await assertRunRootAvailable(targetRunRoot);
  await ensureRunLayout(targetRunRoot);
  const createdEvent = await appendMachineEvent(targetRunRoot, {
    runId,
    timestamp,
    actor: 'machine',
    eventType: 'run.created',
    payload: {
      pipelineId: pipeline.id || path.basename(context.pipelineDir),
      pipelinePath: path.relative(context.workspaceRoot, context.pipelinePath).replace(/\\/g, '/'),
      runRoot: path.relative(context.workspaceRoot, targetRunRoot).replace(/\\/g, '/'),
      latestRunExportPath: path.relative(context.workspaceRoot, exportRoot).replace(/\\/g, '/'),
      lifecycleStatus: 'created',
      summaryStatus: 'pending',
      canonicalStoreKind,
      metadata: {
        pipelineKind: pipeline.kind || '',
        pipelineVersion: pipeline.version || '',
        entryGraph: pipeline.entryGraph || '',
      },
    },
  });

  const runState = projectRunStateFromEvents([createdEvent]);
  await writeRunState(targetRunRoot, runState);

  return {
    ...context,
    runId,
    runRoot: targetRunRoot,
    latestRunExportPath: exportRoot,
    event: createdEvent,
    runState,
  };
}

async function repairRunStateFromEvents(runRoot) {
  const events = await readMachineEvents(runRoot);
  const runState = projectRunStateFromEvents(events);
  if (!runState) throw new Error('Cannot repair run-state.json without a run.created event.');
  await writeRunState(runRoot, runState);
  return runState;
}

module.exports = {
  assertRunStatePathSafe,
  createMachineRun,
  createRunId,
  readRunState,
  repairRunStateFromEvents,
  runStatePath,
  writeRunState,
};
