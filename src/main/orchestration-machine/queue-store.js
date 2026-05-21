const fs = require('fs');
const path = require('path');

const { appendMachineEvent, readMachineEvents } = require('./events');
const { assertMachineStorageId } = require('./ids');
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
  'blocked->queued': 'retry',
  'done->queued': 'retry',
});
const LEGACY_ACTORS = Object.freeze({
  ingest: 'orpad.workQueue',
  triage: 'orpad.triage',
  claim: 'orpad.dispatcher',
  close: 'orpad.workerLoop',
  retry: 'orpad.workerLoop',
});

function queueRoot(runRoot) {
  return path.join(path.resolve(runRoot), 'queue');
}

function assertQueueState(state) {
  if (QUEUE_STATES.includes(state)) return state;
  const err = new Error(`Invalid queue state: ${state}`);
  err.code = 'MACHINE_QUEUE_STATE_INVALID';
  err.state = state;
  throw err;
}

function queueStateDir(runRoot, state) {
  return path.join(queueRoot(runRoot), assertQueueState(state));
}

function queueItemPath(runRoot, state, itemId) {
  return path.join(queueStateDir(runRoot, state), `${assertMachineStorageId(itemId, 'itemId')}.json`);
}

function queueJournalPath(runRoot) {
  return path.join(queueRoot(runRoot), 'journal.jsonl');
}

function queueStoreError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function assertQueueJournalPathSafe(runRoot) {
  try {
    const stats = await fsp.lstat(queueJournalPath(runRoot));
    if (stats.isSymbolicLink()) {
      throw queueStoreError('MACHINE_QUEUE_JOURNAL_SYMLINK_UNSAFE', 'Machine queue journal must not be a symlink.');
    }
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
}

async function assertQueueItemPathSafe(filePath) {
  try {
    const stats = await fsp.lstat(filePath);
    if (stats.isSymbolicLink()) {
      throw queueStoreError('MACHINE_QUEUE_ITEM_SYMLINK_UNSAFE', 'Machine queue item snapshot must not be a symlink.');
    }
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
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
  await assertQueueItemPathSafe(filePath);
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function findQueueItem(runRoot, itemId, options = {}) {
  const safeItemId = assertMachineStorageId(itemId, 'itemId');
  const canonicalOnly = options.canonicalOnly !== false;
  if (canonicalOnly) {
    const projectedState = projectQueueStateFromEvents(await readMachineEvents(runRoot)).get(safeItemId);
    if (!projectedState) return null;
    const item = await readJsonIfExists(queueItemPath(runRoot, projectedState, safeItemId), null);
    if (!item || item.id !== safeItemId || item.state !== projectedState) return null;
    return { item, state: projectedState, path: queueItemPath(runRoot, projectedState, safeItemId) };
  }
  for (const state of QUEUE_STATES) {
    const item = await readJsonIfExists(queueItemPath(runRoot, state, safeItemId), null);
    if (item) return { item, state, path: queueItemPath(runRoot, state, safeItemId) };
  }
  return null;
}

async function readQueueItems(runRoot, options = {}) {
  const canonicalOnly = options.canonicalOnly !== false;
  const projected = canonicalOnly
    ? projectQueueStateFromEvents(await readMachineEvents(runRoot))
    : null;
  const items = [];
  for (const state of QUEUE_STATES) {
    let entries = [];
    try {
      entries = await fsp.readdir(queueStateDir(runRoot, state), { withFileTypes: true });
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw queueStoreError('MACHINE_QUEUE_ITEM_SYMLINK_UNSAFE', 'Machine queue item snapshot must not be a symlink.');
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = path.join(queueStateDir(runRoot, state), entry.name);
      const item = await readJsonIfExists(filePath, null);
      if (canonicalOnly && projected.get(item?.id) !== state) continue;
      if (canonicalOnly && item?.state !== state) continue;
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
  await assertQueueJournalPathSafe(runRoot);
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
  await assertQueueJournalPathSafe(runRoot);
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
  await assertQueueJournalPathSafe(runRoot);
  const {
    runId,
    itemId,
    toState,
    reason = 'queue.transition',
    evidence = '',
    expectedFromState = '',
  } = options;
  const safeItemId = assertMachineStorageId(itemId, 'itemId');
  const safeToState = assertQueueState(toState);
  const safeExpectedFromState = expectedFromState ? assertQueueState(expectedFromState) : '';
  const transitionId = options.transitionId || `${safeItemId}:${safeToState}`;
  const duplicateEvent = await findEventByTransitionId(runRoot, transitionId);
  if (duplicateEvent) {
    return {
      duplicate: true,
      event: duplicateEvent,
      item: (await findQueueItem(runRoot, safeItemId))?.item || null,
    };
  }

  const current = await findQueueItem(runRoot, safeItemId);
  if (!current) throw new Error(`Queue item not found: ${safeItemId}`);
  if (safeExpectedFromState && current.state !== safeExpectedFromState) {
    const err = new Error(`Queue item state changed before transition: ${safeItemId} is ${current.state}, expected ${safeExpectedFromState}.`);
    err.code = 'MACHINE_QUEUE_TRANSITION_STALE';
    err.itemId = safeItemId;
    err.actualState = current.state;
    err.expectedState = safeExpectedFromState;
    throw err;
  }
  const action = transitionAction(current.state, safeToState);
  if (!action) throw new Error(`Invalid queue transition: ${current.state} -> ${safeToState}`);

  const itemPatch = typeof options.itemPatch === 'function'
    ? options.itemPatch(current.item)
    : (options.itemPatch || {});
  const nextItem = {
    ...current.item,
    ...itemPatch,
    id: current.item.id,
    state: safeToState,
    updatedAt: options.now || new Date().toISOString(),
  };
  const event = await appendMachineEvent(runRoot, {
    runId,
    actor: 'machine',
    eventType: 'queue.transition',
    itemId: safeItemId,
    fromState: current.state,
    toState: safeToState,
    reason,
    artifactRefs: [`queue/${safeToState}/${safeItemId}.json`],
    payload: {
      action,
      transitionId,
      evidence: evidence || `queue/${safeToState}/${safeItemId}.json`,
      ...(options.payload || {}),
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
  assertQueueItemPathSafe,
  appendLegacyJournal,
  assertQueueJournalPathSafe,
  ensureQueueLayout,
  findQueueItem,
  ingestCandidateProposal,
  legacyJournalFromEvent,
  projectQueueStateFromEvents,
  assertQueueState,
  queueItemPath,
  queueJournalPath,
  queueRoot,
  queueStateDir,
  readQueueItems,
  transitionAction,
  transitionQueueItem,
  writeQueueItem,
};
