import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  createMachineRun,
  findQueueItem,
  ingestCandidateProposal,
  projectQueueStateFromEvents,
  queueItemPath,
  queueJournalPath,
  readMachineEvents,
  readQueueItems,
  transitionQueueItem,
} = require('../../src/main/orchestration-machine');

const fixedNow = new Date('2026-04-30T00:00:00.000Z');

function proposal(overrides = {}) {
  return {
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: 'proposal-graph-node-types',
    suggestedWorkItemId: 'graph-editor-graph-specific-node-types',
    sourceNode: 'ux-ui-probe',
    title: 'Show graph-specific node types in the graph editor picker',
    fingerprint: 'ux:graph-editor:graph-specific-node-types',
    contentArea: 'graph editor node type filtering',
    issueType: 'renderer-validator-parity',
    severity: 'P2',
    confidence: 0.84,
    evidence: [{ id: 'ux-graph-editor-source', file: 'src/renderer/renderer.js' }],
    acceptanceCriteria: ['Graph editor type picker includes graph-specific node types.'],
    sourceOfTruthTargets: ['src/renderer/renderer.js'],
    coverageEvidenceIds: ['ux-graph-editor-source'],
    ...overrides,
  };
}

async function makeRun() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-queue-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/sample-machine-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'sample-machine-pipeline',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');
  return createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId: 'run_20260430_queue',
    now: fixedNow,
  });
}

async function createTestSymlink(testContext, target, linkPath, type = 'file') {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch (err) {
    if (['EACCES', 'EPERM', 'ENOTSUP', 'EINVAL'].includes(err?.code)) {
      testContext.skip(`symlink creation is unavailable in this environment: ${err.code}`);
      return false;
    }
    throw err;
  }
}

async function readJournal(runRoot) {
  const source = await fs.readFile(queueJournalPath(runRoot), 'utf8');
  return source.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

test('candidate proposals normalize into Machine-owned candidate work items', async () => {
  const run = await makeRun();
  const result = await ingestCandidateProposal(run.runRoot, proposal(), {
    runId: run.runId,
    now: '2026-04-30T00:00:01.000Z',
    transitionId: 'ingest:graph-editor-graph-specific-node-types',
  });

  assert.equal(result.item.schemaVersion, 'orpad.workItem.v1');
  assert.equal(result.item.state, 'candidate');
  assert.equal(result.item.id, 'graph-editor-graph-specific-node-types');
  assert.equal(result.event.eventType, 'queue.transition');
  assert.equal(result.event.fromState, 'inbox');
  assert.equal(result.event.toState, 'candidate');

  const stored = await findQueueItem(run.runRoot, result.item.id);
  assert.equal(stored.state, 'candidate');
  assert.equal(stored.item.fingerprint, result.item.fingerprint);

  const journal = await readJournal(run.runRoot);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].actor, 'orpad.workQueue');
  assert.equal(journal[0].action, 'ingest');
});

test('candidate ingest dedupes by fingerprint without creating another canonical item', async () => {
  const run = await makeRun();
  await ingestCandidateProposal(run.runRoot, proposal(), {
    runId: run.runId,
    transitionId: 'ingest:first',
  });
  const duplicate = await ingestCandidateProposal(run.runRoot, proposal({
    proposalId: 'proposal-duplicate',
    suggestedWorkItemId: 'graph-editor-graph-specific-node-types-duplicate',
  }), {
    runId: run.runId,
    transitionId: 'ingest:duplicate',
  });

  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.duplicateOf, 'graph-editor-graph-specific-node-types');
  assert.equal((await readQueueItems(run.runRoot)).length, 1);

  const events = await readMachineEvents(run.runRoot);
  assert.equal(events.some(event => event.eventType === 'queue.dedupe'), true);
});

test('queue transitions are Machine-owned and replayable from events', async () => {
  const run = await makeRun();
  await ingestCandidateProposal(run.runRoot, proposal(), {
    runId: run.runId,
    transitionId: 'ingest:item',
  });
  const transition = await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: 'graph-editor-graph-specific-node-types',
    toState: 'queued',
    reason: 'triage.accepted',
    transitionId: 'triage:item:queued',
    now: '2026-04-30T00:00:02.000Z',
  });

  assert.equal(transition.item.state, 'queued');
  await assert.rejects(
    fs.stat(queueItemPath(run.runRoot, 'candidate', transition.item.id)),
    error => error?.code === 'ENOENT',
  );
  assert.equal((await findQueueItem(run.runRoot, transition.item.id)).state, 'queued');

  const projection = projectQueueStateFromEvents(await readMachineEvents(run.runRoot));
  assert.equal(projection.get(transition.item.id), 'queued');

  const journal = await readJournal(run.runRoot);
  assert.deepEqual(journal.map(event => event.action), ['ingest', 'triage']);
});

test('invalid queue transitions fail before mutating state', async () => {
  const run = await makeRun();
  await ingestCandidateProposal(run.runRoot, proposal(), {
    runId: run.runId,
    transitionId: 'ingest:item',
  });

  await assert.rejects(
    transitionQueueItem(run.runRoot, {
      runId: run.runId,
      itemId: 'graph-editor-graph-specific-node-types',
      toState: 'done',
      transitionId: 'invalid:done',
    }),
    /Invalid queue transition: candidate -> done/,
  );

  assert.equal((await findQueueItem(run.runRoot, 'graph-editor-graph-specific-node-types')).state, 'candidate');
  const projection = projectQueueStateFromEvents(await readMachineEvents(run.runRoot));
  assert.equal(projection.get('graph-editor-graph-specific-node-types'), 'candidate');
});

test('unsafe work item ids are rejected before queue storage writes', async () => {
  const run = await makeRun();

  await assert.rejects(
    ingestCandidateProposal(run.runRoot, proposal({
      proposalId: 'proposal-unsafe-id',
      suggestedWorkItemId: '../escape',
      fingerprint: 'ux:unsafe-id',
    }), {
      runId: run.runId,
      transitionId: 'ingest:unsafe-id',
    }),
    error => error?.code === 'MACHINE_STORAGE_ID_INVALID' && error?.field === 'workItem.id',
  );

  assert.equal((await readMachineEvents(run.runRoot)).filter(event => event.eventType === 'queue.transition').length, 0);
  await assert.rejects(
    fs.stat(path.join(run.runRoot, 'queue', 'escape.json')),
    error => error?.code === 'ENOENT',
  );
});

test('unsafe queue transition ids are rejected before mutating state', async () => {
  const run = await makeRun();
  await ingestCandidateProposal(run.runRoot, proposal(), {
    runId: run.runId,
    transitionId: 'ingest:item',
  });

  await assert.rejects(
    transitionQueueItem(run.runRoot, {
      runId: run.runId,
      itemId: '../graph-editor-graph-specific-node-types',
      toState: 'queued',
      transitionId: 'unsafe-transition',
    }),
    error => error?.code === 'MACHINE_STORAGE_ID_INVALID' && error?.field === 'itemId',
  );

  assert.equal((await findQueueItem(run.runRoot, 'graph-editor-graph-specific-node-types')).state, 'candidate');
  assert.equal((await readMachineEvents(run.runRoot)).filter(event => event.eventType === 'queue.transition').length, 1);
});

test('queue journal rejects symlinked append targets before queue mutation', async t => {
  const run = await makeRun();
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-queue-journal-target-'));
  const outsideJournal = path.join(outsideRoot, 'journal.jsonl');
  await fs.writeFile(outsideJournal, '', 'utf8');
  await fs.mkdir(path.dirname(queueJournalPath(run.runRoot)), { recursive: true });
  if (!await createTestSymlink(t, outsideJournal, queueJournalPath(run.runRoot), 'file')) return;

  await assert.rejects(
    ingestCandidateProposal(run.runRoot, proposal({ suggestedWorkItemId: 'journal-symlink-item' }), {
      runId: run.runId,
      now: '2026-04-30T00:00:01.000Z',
      transitionId: 'ingest:journal-symlink-item',
    }),
    error => error?.code === 'MACHINE_QUEUE_JOURNAL_SYMLINK_UNSAFE',
  );

  assert.equal(await fs.readFile(outsideJournal, 'utf8'), '');
  assert.equal((await readMachineEvents(run.runRoot)).some(event => event.payload?.transitionId === 'ingest:journal-symlink-item'), false);
  assert.equal(await findQueueItem(run.runRoot, 'journal-symlink-item'), null);
});

test('queue transition patches cannot rename the Machine-owned work item id', async () => {
  const run = await makeRun();
  await ingestCandidateProposal(run.runRoot, proposal(), {
    runId: run.runId,
    transitionId: 'ingest:item',
  });
  const transition = await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: 'graph-editor-graph-specific-node-types',
    toState: 'queued',
    transitionId: 'triage:item:rename-attempt',
    itemPatch: {
      id: '../renamed-item',
      claimId: 'claim-fixture',
    },
  });

  assert.equal(transition.item.id, 'graph-editor-graph-specific-node-types');
  assert.equal(transition.item.claimId, 'claim-fixture');
  assert.equal((await findQueueItem(run.runRoot, 'graph-editor-graph-specific-node-types')).state, 'queued');
  await assert.rejects(
    findQueueItem(run.runRoot, '../renamed-item'),
    error => error?.code === 'MACHINE_STORAGE_ID_INVALID',
  );
  assert.equal((await readQueueItems(run.runRoot)).length, 1);
});

test('transition ids are idempotent and do not mutate state twice', async () => {
  const run = await makeRun();
  await ingestCandidateProposal(run.runRoot, proposal(), {
    runId: run.runId,
    transitionId: 'ingest:item',
  });
  const first = await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: 'graph-editor-graph-specific-node-types',
    toState: 'queued',
    transitionId: 'triage:item:queued',
  });
  const second = await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: 'graph-editor-graph-specific-node-types',
    toState: 'queued',
    transitionId: 'triage:item:queued',
  });

  assert.equal(first.event.sequence, second.event.sequence);
  assert.equal(second.duplicate, true);
  assert.equal((await readMachineEvents(run.runRoot)).filter(event => event.eventType === 'queue.transition').length, 2);
});

test('direct queue file writes are not canonical without Machine events', async () => {
  const run = await makeRun();
  await fs.mkdir(path.dirname(queueItemPath(run.runRoot, 'candidate', 'rogue-item')), { recursive: true });
  await fs.writeFile(queueItemPath(run.runRoot, 'candidate', 'rogue-item'), JSON.stringify({
    id: 'rogue-item',
    state: 'candidate',
  }), 'utf8');

  const projection = projectQueueStateFromEvents(await readMachineEvents(run.runRoot));

  assert.equal(projection.has('rogue-item'), false);
  assert.equal(await findQueueItem(run.runRoot, 'rogue-item'), null);
  assert.equal((await readQueueItems(run.runRoot)).length, 0);
  await assert.rejects(
    transitionQueueItem(run.runRoot, {
      runId: run.runId,
      itemId: 'rogue-item',
      toState: 'queued',
      transitionId: 'triage:rogue-item',
    }),
    /Queue item not found: rogue-item/,
  );
  assert.equal((await readMachineEvents(run.runRoot)).some(event => event.payload?.transitionId === 'triage:rogue-item'), false);
});
