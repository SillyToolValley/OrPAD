import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  approvalGrantForItem,
  assertNoActiveInventoryForDone,
  claimNextQueuedItem,
  createMachineRun,
  finalizeRunFromInventory,
  findQueueItem,
  ingestCandidateProposal,
  queueItemPath,
  readMachineEvents,
  readRunState,
  recordApprovalDecision,
  resumeMachineRun,
  transitionQueueItem,
} = require('../../src/main/orchestration-machine');

const fixedNow = new Date('2026-04-30T00:00:00.000Z');

async function makeRun(runId = 'run_20260430_lifecycle') {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-lifecycle-'));
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
    runId,
    now: fixedNow,
  });
}

function proposal(overrides = {}) {
  return {
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: 'proposal-lifecycle-item',
    suggestedWorkItemId: 'lifecycle-item',
    sourceNode: 'discovery/lifecycle-probe',
    title: 'Exercise lifecycle handling',
    fingerprint: `lifecycle:${overrides.suggestedWorkItemId || 'item'}`,
    evidence: [{ id: 'lifecycle-source', file: 'src/lifecycle.txt' }],
    acceptanceCriteria: ['Lifecycle state remains canonical.'],
    sourceOfTruthTargets: ['src/lifecycle.txt'],
    ...overrides,
  };
}

async function queueProposal(run, item = proposal()) {
  await ingestCandidateProposal(run.runRoot, item, {
    runId: run.runId,
    transitionId: `ingest:${item.suggestedWorkItemId}`,
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: item.suggestedWorkItemId,
    toState: 'queued',
    transitionId: `triage:${item.suggestedWorkItemId}`,
  });
  return item.suggestedWorkItemId;
}

test('approval-required pause creates Machine approval artifact and approved decision resumes claim eligibility', async () => {
  const run = await makeRun('run_20260430_approval');
  const itemId = await queueProposal(run, proposal({
    suggestedWorkItemId: 'approval-item',
    fingerprint: 'lifecycle:approval-item',
    approvalRequired: true,
  }));

  const paused = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    now: '2026-04-30T00:00:20.000Z',
  });

  assert.equal(paused.claimed, false);
  assert.equal(paused.stopReason, 'approval-required');
  assert.equal(paused.approval.request.itemId, itemId);
  assert.equal((await readRunState(run.runRoot)).lifecycleStatus, 'approval-required');
  assert.equal((await readRunState(run.runRoot)).summaryStatus, 'blocked');
  assert.equal((await readMachineEvents(run.runRoot)).some(event => event.eventType === 'approval.requested'), true);
  await fs.stat(path.join(run.runRoot, paused.approval.artifact.file.path));

  const decision = await recordApprovalDecision(run.runRoot, {
    runId: run.runId,
    approvalId: paused.approval.approvalId,
    itemId,
    decision: 'approved',
    grants: [approvalGrantForItem(itemId, paused.approval.approvalId)],
  });
  assert.equal(decision.runState.lifecycleStatus, 'waiting');

  const claimed = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-approved-item',
    approvalGrants: [approvalGrantForItem(itemId, paused.approval.approvalId)],
  });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.item.id, itemId);
});

test('approval decisions cannot reopen a terminal cancelled run', async () => {
  const run = await makeRun('run_20260430_approval_terminal');
  const itemId = await queueProposal(run, proposal({
    suggestedWorkItemId: 'approval-terminal-item',
    fingerprint: 'lifecycle:approval-terminal-item',
    approvalRequired: true,
  }));

  const paused = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    now: '2026-04-30T00:00:20.000Z',
  });
  assert.equal(paused.stopReason, 'approval-required');

  await recordApprovalDecision(run.runRoot, {
    runId: run.runId,
    approvalId: paused.approval.approvalId,
    itemId,
    decision: 'denied',
  });
  assert.equal((await readRunState(run.runRoot)).lifecycleStatus, 'cancelled');
  const eventCount = (await readMachineEvents(run.runRoot)).length;

  await assert.rejects(
    recordApprovalDecision(run.runRoot, {
      runId: run.runId,
      approvalId: paused.approval.approvalId,
      itemId,
      decision: 'approved',
      grants: [approvalGrantForItem(itemId, paused.approval.approvalId)],
    }),
    error => error?.code === 'MACHINE_RUN_TERMINAL',
  );
  assert.equal((await readMachineEvents(run.runRoot)).length, eventCount);
});

test('final lifecycle status cannot become done while active queue inventory remains', async () => {
  const run = await makeRun('run_20260430_done_gate');
  const itemId = await queueProposal(run);

  await assert.rejects(
    assertNoActiveInventoryForDone(run.runRoot),
    error => error?.code === 'RUN_DONE_ACTIVE_INVENTORY',
  );
  const partial = await finalizeRunFromInventory(run.runRoot, { runId: run.runId });
  assert.equal(partial.summaryStatus, 'partial');
  assert.notEqual((await readRunState(run.runRoot)).summaryStatus, 'done');

  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId,
    toState: 'claimed',
    transitionId: 'claim:lifecycle-item',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId,
    toState: 'done',
    transitionId: 'close:lifecycle-item',
  });

  const done = await finalizeRunFromInventory(run.runRoot, { runId: run.runId });
  assert.equal(done.summaryStatus, 'done');
  assert.equal(done.runState.lifecycleStatus, 'completed');
});

test('resume cannot reopen a terminal run even when run-state is missing', async () => {
  const run = await makeRun('run_20260430_resume_terminal');
  const itemId = await queueProposal(run);
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId,
    toState: 'claimed',
    transitionId: 'claim:lifecycle-terminal-item',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId,
    toState: 'done',
    transitionId: 'close:lifecycle-terminal-item',
  });
  await finalizeRunFromInventory(run.runRoot, { runId: run.runId });
  await fs.rm(path.join(run.runRoot, 'run-state.json'), { force: true });
  const eventCount = (await readMachineEvents(run.runRoot)).length;

  await assert.rejects(
    resumeMachineRun(run.runRoot, {
      runId: run.runId,
      now: '2026-04-30T00:00:30.000Z',
    }),
    error => error?.code === 'MACHINE_RUN_TERMINAL',
  );
  assert.equal((await readMachineEvents(run.runRoot)).length, eventCount);
});

test('resume repairs derived queue directories from canonical transition events', async () => {
  const run = await makeRun('run_20260430_resume_repair');
  const itemId = await queueProposal(run);
  await fs.mkdir(path.dirname(queueItemPath(run.runRoot, 'candidate', itemId)), { recursive: true });
  await fs.rename(
    queueItemPath(run.runRoot, 'queued', itemId),
    queueItemPath(run.runRoot, 'candidate', itemId),
  );

  assert.equal((await findQueueItem(run.runRoot, itemId)).state, 'candidate');

  const resumed = await resumeMachineRun(run.runRoot, {
    runId: run.runId,
    now: '2026-04-30T00:00:20.000Z',
  });

  assert.deepEqual(resumed.queueRepair.repaired, [{
    itemId,
    fromState: 'candidate',
    toState: 'queued',
  }]);
  assert.equal((await findQueueItem(run.runRoot, itemId)).state, 'queued');
  assert.equal((await readRunState(run.runRoot)).lifecycleStatus, 'waiting');
});
