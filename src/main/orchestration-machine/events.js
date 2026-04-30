const fs = require('fs');
const path = require('path');

const { SCHEMA_VERSIONS, createContractValidator } = require('./contracts');
const { ensureDir } = require('./metadata-store');

const fsp = fs.promises;
const validator = createContractValidator();

function eventsPath(runRoot) {
  return path.join(path.resolve(runRoot), 'events.jsonl');
}

function nowIso() {
  return new Date().toISOString();
}

async function readMachineEvents(runRoot) {
  const filePath = eventsPath(runRoot);
  try {
    const source = await fsp.readFile(filePath, 'utf8');
    return source
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

function nextSequence(events) {
  if (!events.length) return 0;
  return Math.max(...events.map(event => Number(event.sequence) || 0)) + 1;
}

async function appendMachineEvent(runRoot, event) {
  const existing = await readMachineEvents(runRoot);
  const record = {
    schemaVersion: SCHEMA_VERSIONS.machineEvent,
    timestamp: nowIso(),
    artifactRefs: [],
    ...event,
    sequence: event.sequence ?? nextSequence(existing),
  };
  validator.assertValid('machineEvent', record);
  await ensureDir(path.resolve(runRoot));
  await fsp.appendFile(eventsPath(runRoot), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
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

module.exports = {
  appendMachineEvent,
  eventsPath,
  nextSequence,
  projectRunStateFromEvents,
  readMachineEvents,
};
