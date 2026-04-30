const fs = require('fs');
const path = require('path');

const { appendMachineEvent, readMachineEvents } = require('./events');
const { ensureDir, writeJsonAtomic } = require('./metadata-store');
const { normalizeCandidateProposal } = require('./work-item-normalizer');

const fsp = fs.promises;

const QUEUE_STATES = Object.freeze(['candidate', 'queued', 'claimed', 'done', 'blocked', 'rejected']);
const TRANSITION_ACTIONS = Object.freeze({
  'inbox->candidate': 'ingest',
  'candidate->queued': 'triage',
  'candidate->blocked': 'triage',
  'candidate->rejected': 'triage',
  'queued->claimed': 'claim',
  'claimed->done': 'close',
  'claimed->blocked': 'close',
  'claimed->queued': 'close',
});
const LEGACY_ACTORS = Object.freeze({
  ingest: 'orpad.workQueue',
  triage: 'orpad.triage',
  claim: 'orpad.dispatcher',
  close: 'orpad.workerLoop',
});

function queueRoot(runRoot) {
  return path.join(path.resolve(runRoot), 'queue');
}

function queueStateDir(runRoot, state) {
  return path.join(queueRoot(runRoot), state);
}

function queueItemPath(runRoot, state, itemId) {
  return path.join(queueStateDir(runRoot, state), `${itemId}.json`);
}

function queueJournalPath(runRoot) {
  return path.join(queueRoot(runRoot), 'journal.jsonl');
}

function transitionAction(fromState, toState) {
  return TRANSITION_ACTIONS[`${fromState}->${toState}`] || '';
}

async function ensureQueueLayout(runRoot) {
  await ensureDir(queueRoot(runRoot));
  await ensureDir(path.join(queueRoot(runRoot), 'inbox'));
  for (const state of QUEUE_STATES) await ensureDir(queueStateDir(runRoot, state));
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function findQueueItem(runRoot, itemId) {
  for (const state of QUEUE_STATES) {
    const item = await readJsonIfExists(queueItemPath(runRoot, state, itemId), null);
    if (item) return { item, state, path: queueItemPath(runRoot, state, itemId) };
  }
  return null;
}

async function readQueueItems(runRoot) {
  const items = [];
  for (const state of QUEUE_STATES) {
    let entries = [];
    try {
      entries = await fsp.readdir(queueStateDir(runRoot, state), { withFileTypes: true });
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = path.join(queueStateDir(runRoot, state), entry.name);
      const item = await readJsonIfExists(filePath, null);
      if (item) items.push({ item, state, path: filePath });
    }
  }
  return items;
}

async function removeStateFiles(runRoot, itemId, exceptState = '') {
  for (const state of QUEUE_STATES) {
    if (state === exceptState) continue;
    try {
      await fsp.rm(queueItemPath(runRoot, state, itemId));
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
}

function legacyJournalFromEvent(event) {
  const action = event.payload?.action || transitionAction(event.fromState, event.toState);
  return {
    actor: event.payload?.legacyActor || LEGACY_ACTORS[action] || 'orpad.machine',
    action,
    itemId: event.itemId,
    fromState: event.fromState,
    toState: event.toState,
    timestamp: event.timestamp,
    evidence: event.payload?.evidence || event.artifactRefs?.[0] || `queue/${event.toState}/${event.itemId}.json`,
  };
}

async function appendLegacyJournal(runRoot, event) {
  const action = event.payload?.action || transitionAction(event.fromState, event.toState);
  if (!action) return null;
  const record = legacyJournalFromEvent(event);
  await fsp.appendFile(queueJournalPath(runRoot), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

async function findEventByTransitionId(runRoot, transitionId) {
  if (!transitionId) return null;
  const events = await readMachineEvents(runRoot);
  return events.find(event => event.payload?.transitionId === transitionId) || null;
}

async function writeQueueItem(runRoot, item) {
  await ensureQueueLayout(runRoot);
  await removeStateFiles(runRoot, item.id, item.state);
  await writeJsonAtomic(queueItemPath(runRoot, item.state, item.id), item);
  return item;
}

async function ingestCandidateProposal(runRoot, proposal, options = {}) {
  await ensureQueueLayout(runRoot);
  const item = normalizeCandidateProposal(proposal, { now: options.now });
  const transitionId = options.transitionId || `ingest:${item.id}`;
  const duplicateEvent = await findEventByTransitionId(runRoot, transitionId);
  if (duplicateEvent) {
    return {
      duplicate: true,
      event: duplicateEvent,
      item: (await findQueueItem(runRoot, item.id))?.item || item,
    };
  }

  const existing = (await readQueueItems(runRoot)).find(entry => entry.item.fingerprint === item.fingerprint);
  if (existing) {
    const event = await appendMachineEvent(runRoot, {
      runId: options.runId,
      actor: 'machine',
      eventType: 'queue.dedupe',
      itemId: item.id,
      reason: 'fingerprint.duplicate',
      payload: {
        transitionId,
        duplicateOf: existing.item.id,
        fingerprint: item.fingerprint,
      },
    });
    return {
      deduped: true,
      duplicateOf: existing.item.id,
      event,
      item: existing.item,
    };
  }

  const event = await appendMachineEvent(runRoot, {
    runId: options.runId,
    actor: 'machine',
    eventType: 'queue.transition',
    itemId: item.id,
    fromState: 'inbox',
    toState: 'candidate',
    reason: 'candidate.ingested',
    artifactRefs: [`queue/candidate/${item.id}.json`],
    payload: {
      action: 'ingest',
      transitionId,
      evidence: `queue/candidate/${item.id}.json`,
    },
  });
  await writeQueueItem(runRoot, item);
  const journal = await appendLegacyJournal(runRoot, event);
  return { event, item, journal };
}

async function transitionQueueItem(runRoot, options = {}) {
  await ensureQueueLayout(runRoot);
  const { runId, itemId, toState, reason = 'queue.transition', evidence = '', transitionId = `${itemId}:${toState}` } = options;
  const duplicateEvent = await findEventByTransitionId(runRoot, transitionId);
  if (duplicateEvent) {
    return {
      duplicate: true,
      event: duplicateEvent,
      item: (await findQueueItem(runRoot, itemId))?.item || null,
    };
  }

  const current = await findQueueItem(runRoot, itemId);
  if (!current) throw new Error(`Queue item not found: ${itemId}`);
  const action = transitionAction(current.state, toState);
  if (!action) throw new Error(`Invalid queue transition: ${current.state} -> ${toState}`);

  const nextItem = {
    ...current.item,
    state: toState,
    updatedAt: options.now || new Date().toISOString(),
  };
  const event = await appendMachineEvent(runRoot, {
    runId,
    actor: 'machine',
    eventType: 'queue.transition',
    itemId,
    fromState: current.state,
    toState,
    reason,
    artifactRefs: [`queue/${toState}/${itemId}.json`],
    payload: {
      action,
      transitionId,
      evidence: evidence || `queue/${toState}/${itemId}.json`,
    },
  });
  await writeQueueItem(runRoot, nextItem);
  const journal = await appendLegacyJournal(runRoot, event);
  return { event, item: nextItem, journal };
}

function projectQueueStateFromEvents(events) {
  const states = new Map();
  for (const event of events) {
    if (event.eventType !== 'queue.transition') continue;
    states.set(event.itemId, event.toState);
  }
  return states;
}

module.exports = {
  QUEUE_STATES,
  TRANSITION_ACTIONS,
  appendLegacyJournal,
  ensureQueueLayout,
  findQueueItem,
  ingestCandidateProposal,
  legacyJournalFromEvent,
  projectQueueStateFromEvents,
  queueItemPath,
  queueJournalPath,
  queueRoot,
  queueStateDir,
  readQueueItems,
  transitionAction,
  transitionQueueItem,
  writeQueueItem,
};
