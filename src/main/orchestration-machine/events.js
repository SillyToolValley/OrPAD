const fs = require('fs');
const path = require('path');

const { SCHEMA_VERSIONS, createContractValidator } = require('./contracts');
const { ensureDir, writeJsonAtomic } = require('./metadata-store');

const fsp = fs.promises;
const validator = createContractValidator();
const eventAppendQueues = new Map();

function eventsPath(runRoot) {
  return path.join(path.resolve(runRoot), 'events.jsonl');
}

function projectedRunStatePath(runRoot) {
  return path.join(path.resolve(runRoot), 'run-state.json');
}

async function assertEventLogPathSafe(runRoot) {
  const filePath = eventsPath(runRoot);
  try {
    const stats = await fsp.lstat(filePath);
    if (stats.isSymbolicLink()) {
      throw eventLogError('MACHINE_EVENT_LOG_SYMLINK_UNSAFE', 'Machine event log must not be a symlink.');
    }
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
}

async function assertProjectedRunStatePathSafe(runRoot) {
  const filePath = projectedRunStatePath(runRoot);
  try {
    const stats = await fsp.lstat(filePath);
    if (stats.isSymbolicLink()) {
      throw eventLogError('MACHINE_RUN_STATE_SYMLINK_UNSAFE', 'Machine run-state.json must not be a symlink.');
    }
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function readMachineEvents(runRoot) {
  const filePath = eventsPath(runRoot);
  await assertEventLogPathSafe(runRoot);
  try {
    const source = await fsp.readFile(filePath, 'utf8');
    const lines = source.split(/\r?\n/).filter(Boolean);
    return lines.map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (parseErr) {
        // Appends are serialized (eventAppendQueues) and only ever add a complete
        // "<json>\n" at EOF, so a torn read from a concurrent append can corrupt
        // ONLY the final line. Tolerate a partial trailing line — the next read
        // sees the completed record. A parse failure on any interior line is
        // genuine corruption (not a torn read): surface it rather than silently
        // dropping a durable event.
        if (index === lines.length - 1) return null;
        throw parseErr;
      }
    }).filter(Boolean);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

function nextSequence(events) {
  if (!events.length) return 0;
  return Math.max(...events.map(event => Number(event.sequence) || 0)) + 1;
}

function eventLogError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertEventMatchesRunRoot(runRoot, event) {
  const runRootId = path.basename(path.resolve(runRoot));
  if (runRootId.startsWith('run_') && event.runId !== runRootId) {
    throw eventLogError('MACHINE_EVENT_RUN_ROOT_MISMATCH', 'Machine event runId must match the durable run root id.');
  }
}

function assertEventBelongsToRun(existing, event) {
  if (!existing.length) {
    if (event.eventType !== 'run.created') {
      throw eventLogError('MACHINE_EVENT_RUN_CREATED_REQUIRED', 'First Machine event must be run.created.');
    }
    return;
  }
  const runId = existing.find(item => item.eventType === 'run.created')?.runId || existing[0]?.runId;
  if (runId && event.runId !== runId) {
    throw eventLogError('MACHINE_EVENT_RUN_ID_MISMATCH', 'Machine event runId must match the durable run root.');
  }
}

async function appendMachineEventUnlocked(runRoot, event) {
  const existing = await readMachineEvents(runRoot);
  if (event.sequence != null) {
    throw eventLogError('MACHINE_EVENT_SEQUENCE_OWNED', 'Machine event sequence is assigned by the durable event log.');
  }
  assertEventBelongsToRun(existing, event);
  assertEventMatchesRunRoot(runRoot, event);
  const record = {
    schemaVersion: SCHEMA_VERSIONS.machineEvent,
    timestamp: nowIso(),
    artifactRefs: [],
    ...event,
    sequence: nextSequence(existing),
  };
  validator.assertValid('machineEvent', record);
  const projectedRunState = projectValidRunStateFromEvents([...existing, record]);
  if (projectedRunState) await assertProjectedRunStatePathSafe(runRoot);
  await ensureDir(path.resolve(runRoot));
  await assertEventLogPathSafe(runRoot);
  await fsp.appendFile(eventsPath(runRoot), `${JSON.stringify(record)}\n`, 'utf8');
  if (projectedRunState) {
    await writeJsonAtomic(projectedRunStatePath(runRoot), projectedRunState);
  }
  return record;
}

async function appendMachineEvent(runRoot, event) {
  const key = path.resolve(runRoot);
  const previous = eventAppendQueues.get(key) || Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(() => appendMachineEventUnlocked(runRoot, event));
  eventAppendQueues.set(key, operation);
  try {
    return await operation;
  } finally {
    if (eventAppendQueues.get(key) === operation) eventAppendQueues.delete(key);
  }
}

function projectRunStateFromEvents(events) {
  const created = events.find(event => event.eventType === 'run.created');
  if (!created) return null;
  const latest = events[events.length - 1];
  const statusEvent = [...events].reverse().find(event => event.eventType === 'run.status');
  const summaryEvent = [...events].reverse().find(event => event.eventType === 'run.summary');
  const payload = created.payload || {};
  return {
    schemaVersion: SCHEMA_VERSIONS.machineRun,
    runId: created.runId,
    pipelineId: payload.pipelineId,
    pipelinePath: payload.pipelinePath,
    runRoot: payload.runRoot,
    latestRunExportPath: payload.latestRunExportPath,
    lifecycleStatus: statusEvent?.toState || payload.lifecycleStatus || 'created',
    summaryStatus: summaryEvent?.payload?.summaryStatus || payload.summaryStatus || 'pending',
    createdAt: created.timestamp,
    updatedAt: latest?.timestamp || created.timestamp,
    eventSequence: latest?.sequence ?? created.sequence,
    canonicalStoreKind: payload.canonicalStoreKind || 'jsonl',
    metadata: payload.metadata || {},
  };
}

function projectValidRunStateFromEvents(events) {
  const runState = projectRunStateFromEvents(events);
  if (!runState) return null;
  try {
    validator.assertValid('machineRun', runState);
    return runState;
  } catch {
    return null;
  }
}

module.exports = {
  assertEventLogPathSafe,
  appendMachineEvent,
  eventsPath,
  nextSequence,
  projectRunStateFromEvents,
  readMachineEvents,
};
