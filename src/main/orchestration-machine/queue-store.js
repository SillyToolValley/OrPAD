const fs = require('fs');
const path = require('path');

const { appendMachineEvent, readMachineEvents } = require('./events');
const { assertMachineStorageId } = require('./ids');
const { atomicWriteFile, ensureDir, writeJsonAtomic } = require('./metadata-store');
const { normalizeCandidateProposal } = require('./work-item-normalizer');
const { createContractValidator } = require('./contracts');

const fsp = fs.promises;
// STEER edit: re-validate a human-patched work item against the schema before
// persisting, so an edit can never write a malformed item.
const workItemValidator = createContractValidator();

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
  'claimed->rejected': 'close',
  'blocked->queued': 'retry',
  'blocked->rejected': 'triage',
  'done->queued': 'retry',
  // STEER: a human can reject a still-queued item ("leave this out"). Routed
  // through transitionQueueItem so it is a standard, replayable queue.transition
  // (candidate->rejected and blocked->rejected already exist for triage-time
  // rejection; this adds the queued case for in-run human steering).
  'queued->rejected': 'reject',
});
const LEGACY_ACTORS = Object.freeze({
  ingest: 'orpad.workQueue',
  triage: 'orpad.triage',
  claim: 'orpad.dispatcher',
  close: 'orpad.workerLoop',
  retry: 'orpad.workerLoop',
  reject: 'orpad.triage',
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

function legacyJournalRecordsFromEvents(events = []) {
  return events
    .filter(event => event?.eventType === 'queue.transition')
    .map(legacyJournalFromEvent)
    .filter(record => record.action);
}

async function appendLegacyJournal(runRoot, event) {
  const action = event.payload?.action || transitionAction(event.fromState, event.toState);
  if (!action) return null;
  const record = legacyJournalFromEvent(event);
  await assertQueueJournalPathSafe(runRoot);
  await fsp.appendFile(queueJournalPath(runRoot), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

async function writeLegacyJournalProjection(runRoot, options = {}) {
  const events = Array.isArray(options.events) ? options.events : await readMachineEvents(runRoot);
  const records = legacyJournalRecordsFromEvents(events);
  await ensureQueueLayout(runRoot);
  await assertQueueJournalPathSafe(runRoot);
  await atomicWriteFile(
    queueJournalPath(runRoot),
    records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''),
  );
  return {
    path: queueJournalPath(runRoot),
    records,
    recordCount: records.length,
  };
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
  let action = transitionAction(current.state, safeToState);
  if (!action && options.allowRejectedRetry === true && current.state === 'rejected' && safeToState === 'queued') {
    action = 'retry';
  }
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

// STEER "do this first": record a human reprioritization as a durable
// `queue.reprioritized` event. It is NOT a state change (the item stays queued),
// so it never touches projectQueueStateFromEvents — the dispatcher's claim order
// reads it separately (see projectQueueSteerPriorityFromEvents). The event's
// SEQUENCE is the priority (monotonic, replay-deterministic): later = claimed
// sooner. No snapshot mutation and no new persisted item field, so it is fully
// replayable from events with zero schema/migration concerns.
async function reprioritizeQueueItem(runRoot, options = {}) {
  const safeItemId = assertMachineStorageId(options.itemId, 'itemId');
  if (!options.runId) throw new Error('runId is required.');
  const event = await appendMachineEvent(runRoot, {
    runId: options.runId,
    actor: options.actor || 'machine',
    eventType: 'queue.reprioritized',
    itemId: safeItemId,
    reason: options.reason || 'queue.reprioritized',
    payload: { itemId: safeItemId, ...(options.payload || {}) },
  });
  return { event };
}

// STEER "fix this": edit a pending work item's content in place (NOT a state
// change — it stays in its current state). Records a durable `queue.edited` event
// carrying the patch (audit + replay-of-intent) and rewrites the snapshot. id and
// state are never editable; the patched item is re-validated against the workItem
// schema so a steer edit can never persist a malformed item. The repair path
// (lifecycle.repairDerivedQueueFilesFromEvents) preserves snapshot content, so the
// edit is as durable as the original ingested content.
async function editQueueItem(runRoot, options = {}) {
  const safeItemId = assertMachineStorageId(options.itemId, 'itemId');
  if (!options.runId) throw new Error('runId is required.');
  const patch = (options.patch && typeof options.patch === 'object' && !Array.isArray(options.patch))
    ? options.patch
    : {};
  const current = await findQueueItem(runRoot, safeItemId, { canonicalOnly: false });
  if (!current) {
    throw queueStoreError('MACHINE_QUEUE_ITEM_NOT_FOUND', `Queue item not found: ${safeItemId}`);
  }
  const now = options.now instanceof Date ? options.now.toISOString() : (options.now || new Date().toISOString());
  const nextItem = {
    ...current.item,
    ...patch,
    id: safeItemId,
    state: current.state,
    updatedAt: now,
  };
  try {
    workItemValidator.assertValid('workItem', nextItem);
  } catch (validationErr) {
    throw queueStoreError('MACHINE_QUEUE_ITEM_INVALID', `Edited work item failed schema validation: ${validationErr.message}`);
  }
  await writeQueueItem(runRoot, nextItem);
  // An edit updates the snapshot in place (state is unchanged), so there is no new
  // queue.transition. Record the same artifactRef the last transition used so the
  // queue.edited event is self-documenting about which snapshot file holds the edit.
  const event = await appendMachineEvent(runRoot, {
    runId: options.runId,
    actor: options.actor || 'machine',
    eventType: 'queue.edited',
    itemId: safeItemId,
    reason: options.reason || 'queue.edited',
    artifactRefs: [`queue/${current.state}/${safeItemId}.json`],
    payload: { itemId: safeItemId, patch, state: current.state },
  });
  return { event, item: nextItem };
}

function projectQueueStateFromEvents(events) {
  const states = new Map();
  for (const event of events) {
    if (event.eventType !== 'queue.transition') continue;
    states.set(event.itemId, event.toState);
  }
  return states;
}

// STEER: fold `queue.reprioritized` events into itemId -> latest priority (the
// event sequence; higher = more recently steered "do this first"). The dispatcher
// sorts queued items by this BEFORE severity. An empty map (no reprioritizations)
// leaves claim order identical to the default, so the feature is gated by data.
function projectQueueSteerPriorityFromEvents(events = []) {
  const priority = new Map();
  let fallback = 0;
  for (const event of events || []) {
    if (event?.eventType !== 'queue.reprioritized') continue;
    const itemId = String(event.itemId || event.payload?.itemId || '').trim();
    if (!itemId) continue;
    fallback += 1;
    const seq = Number(event.sequence);
    priority.set(itemId, Number.isFinite(seq) ? seq : fallback);
  }
  return priority;
}

module.exports = {
  QUEUE_STATES,
  TRANSITION_ACTIONS,
  assertQueueItemPathSafe,
  appendLegacyJournal,
  assertQueueJournalPathSafe,
  editQueueItem,
  ensureQueueLayout,
  findQueueItem,
  ingestCandidateProposal,
  legacyJournalFromEvent,
  legacyJournalRecordsFromEvents,
  projectQueueStateFromEvents,
  projectQueueSteerPriorityFromEvents,
  reprioritizeQueueItem,
  assertQueueState,
  queueItemPath,
  queueJournalPath,
  queueRoot,
  queueStateDir,
  readQueueItems,
  transitionAction,
  transitionQueueItem,
  writeLegacyJournalProjection,
  writeQueueItem,
};
