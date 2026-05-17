import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  approvalGrantForItem,
  appendMachineEvent,
  appendRunLifecycleStatus,
  appendRunSummaryStatus,
  assertNoActiveInventoryForDone,
  claimNextQueuedItem,
  createMachineRun,
  finalizeRunFromInventory,
  findQueueItem,
  ingestCandidateProposal,
  patchReviewResumeStateFromEvents,
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
  });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.item.id, itemId);
});

test('run lifecycle and summary statuses are validated before event append', async () => {
  const run = await makeRun('run_20260430_lifecycle_invalid_status');
  const eventsBefore = await readMachineEvents(run.runRoot);

  await assert.rejects(
    appendRunLifecycleStatus(run.runRoot, {
      runId: run.runId,
      toState: 'bogus',
    }),
    error => error?.code === 'MACHINE_RUN_LIFECYCLE_STATUS_INVALID',
  );
  await assert.rejects(
    appendRunSummaryStatus(run.runRoot, {
      runId: run.runId,
      summaryStatus: 'bogus',
    }),
    error => error?.code === 'MACHINE_RUN_SUMMARY_STATUS_INVALID',
  );

  assert.equal((await readMachineEvents(run.runRoot)).length, eventsBefore.length);

  const runState = await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'partial',
    payload: { summaryStatus: 'bogus' },
  });
  assert.equal(runState.summaryStatus, 'partial');
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

  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'cancelled',
    reason: 'test.terminal-before-approval-decision',
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

test('approval decisions are accepted only once for a requested approval', async () => {
  const run = await makeRun('run_20260430_approval_single_use');
  const itemId = await queueProposal(run, proposal({
    suggestedWorkItemId: 'approval-single-use-item',
    fingerprint: 'lifecycle:approval-single-use-item',
    approvalRequired: true,
  }));

  const paused = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    now: '2026-04-30T00:00:20.000Z',
  });
  assert.equal(paused.stopReason, 'approval-required');

  await assert.rejects(
    recordApprovalDecision(run.runRoot, {
      runId: run.runId,
      approvalId: paused.approval.approvalId,
      itemId: 'other-item',
      decision: 'approved',
      grants: [approvalGrantForItem('other-item', paused.approval.approvalId)],
    }),
    error => error?.code === 'MACHINE_APPROVAL_ITEM_MISMATCH',
  );
  await assert.rejects(
    recordApprovalDecision(run.runRoot, {
      runId: run.runId,
      approvalId: paused.approval.approvalId,
      itemId,
      decision: 'approved',
      grants: [true],
    }),
    error => error?.code === 'MACHINE_APPROVAL_APPROVED_GRANT_MISSING',
  );
  await assert.rejects(
    recordApprovalDecision(run.runRoot, {
      runId: run.runId,
      approvalId: paused.approval.approvalId,
      itemId,
      decision: 'approved',
      grants: [approvalGrantForItem(itemId, paused.approval.approvalId), true],
    }),
    error => error?.code === 'MACHINE_APPROVAL_GRANT_INVALID',
  );
  await assert.rejects(
    recordApprovalDecision(run.runRoot, {
      runId: run.runId,
      approvalId: paused.approval.approvalId,
      itemId,
      decision: 'approved',
      grants: [{
        ...approvalGrantForItem(itemId, paused.approval.approvalId),
        scope: 'all',
      }],
    }),
    error => error?.code === 'MACHINE_APPROVAL_APPROVED_GRANT_MISSING',
  );
  await assert.rejects(
    recordApprovalDecision(run.runRoot, {
      runId: run.runId,
      approvalId: paused.approval.approvalId,
      itemId,
      decision: 'denied',
      grants: [approvalGrantForItem(itemId, paused.approval.approvalId)],
    }),
    error => error?.code === 'MACHINE_APPROVAL_DENIED_GRANT_PRESENT',
  );

  await recordApprovalDecision(run.runRoot, {
    runId: run.runId,
    approvalId: paused.approval.approvalId,
    itemId,
    decision: 'approved',
    grants: [approvalGrantForItem(itemId, paused.approval.approvalId)],
  });
  const eventCount = (await readMachineEvents(run.runRoot)).length;

  await assert.rejects(
    recordApprovalDecision(run.runRoot, {
      runId: run.runId,
      approvalId: paused.approval.approvalId,
      itemId,
      decision: 'approved',
      grants: [approvalGrantForItem(itemId, paused.approval.approvalId)],
    }),
    error => error?.code === 'MACHINE_APPROVAL_ALREADY_DECIDED',
  );
  assert.equal((await readMachineEvents(run.runRoot)).length, eventCount);

  await assert.rejects(
    recordApprovalDecision(run.runRoot, {
      runId: run.runId,
      approvalId: 'approval-missing',
      itemId,
      decision: 'approved',
      grants: [approvalGrantForItem(itemId, 'approval-missing')],
    }),
    error => error?.code === 'MACHINE_APPROVAL_NOT_REQUESTED',
  );
});

test('resume cannot bypass a pending approval request', async () => {
  const run = await makeRun('run_20260430_resume_pending_approval');
  const itemId = await queueProposal(run, proposal({
    suggestedWorkItemId: 'resume-approval-item',
    fingerprint: 'lifecycle:resume-approval-item',
    approvalRequired: true,
  }));

  const paused = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    now: '2026-04-30T00:00:20.000Z',
  });
  assert.equal(paused.stopReason, 'approval-required');
  const eventCount = (await readMachineEvents(run.runRoot)).length;

  await assert.rejects(
    resumeMachineRun(run.runRoot, {
      runId: run.runId,
      now: '2026-04-30T00:00:30.000Z',
    }),
    error => error?.code === 'MACHINE_APPROVAL_PENDING',
  );

  assert.equal((await findQueueItem(run.runRoot, itemId)).state, 'queued');
  assert.equal((await readRunState(run.runRoot)).lifecycleStatus, 'approval-required');
  assert.equal((await readRunState(run.runRoot)).summaryStatus, 'blocked');
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

test('patch review resume state reports applied skipped and conflict history', () => {
  const state = patchReviewResumeStateFromEvents([
    {
      eventType: 'worker.result',
      sequence: 1,
      payload: {
        patchArtifact: 'artifacts/patches/a.patch.json',
        changedFiles: ['src/a.txt'],
      },
    },
    {
      eventType: 'worker.result',
      sequence: 2,
      payload: {
        patchArtifact: 'artifacts/patches/b.patch.json',
        changedFiles: ['src/b.txt'],
      },
    },
    {
      eventType: 'patch.apply_conflict',
      sequence: 3,
      payload: {
        patchArtifact: 'artifacts/patches/b.patch.json',
        selectedFiles: ['src/b.txt'],
      },
    },
    {
      eventType: 'patch.applied',
      sequence: 4,
      payload: {
        patchArtifact: 'artifacts/patches/a.patch.json',
        selectedFiles: ['src/a.txt'],
        applied: [{ path: 'src/a.txt' }],
      },
    },
    {
      eventType: 'patch.review_skipped',
      sequence: 5,
      payload: {
        patchArtifact: 'artifacts/patches/b.patch.json',
      },
    },
  ]);

  assert.equal(state.required, false);
  assert.equal(state.resolved, true);
  assert.equal(state.patchCount, 2);
  assert.equal(state.appliedCount, 1);
  assert.equal(state.skippedCount, 1);
  assert.equal(state.historicalConflictCount, 1);
  assert.deepEqual(state.appliedFiles, ['src/a.txt']);
  assert.deepEqual(state.pendingPatchArtifacts, []);
});

test('patch review resume state blocks patch artifacts with empty changedFiles', () => {
  const state = patchReviewResumeStateFromEvents([
    {
      eventType: 'worker.result',
      sequence: 1,
      payload: {
        patchArtifact: 'artifacts/patches/empty-changed-files.patch.json',
        changedFiles: [],
      },
    },
  ]);

  assert.equal(state.required, true);
  assert.equal(state.resolved, false);
  assert.equal(state.pendingPatchArtifacts[0], 'artifacts/patches/empty-changed-files.patch.json');
});

test('finalize keeps run blocked when review-required patch has not emitted node.blocked', async () => {
  const run = await makeRun('run_20260517_finalize_patch_review_crash_window');
  const itemId = await queueProposal(run, proposal({
    suggestedWorkItemId: 'finalize-patch-review-crash-window',
    fingerprint: 'lifecycle:finalize-patch-review-crash-window',
  }));
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId,
    toState: 'claimed',
    transitionId: 'claim:finalize-patch-review-crash-window',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId,
    toState: 'done',
    transitionId: 'close:finalize-patch-review-crash-window',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId,
    reason: 'worker-result.accepted',
    payload: {
      status: 'done',
      toState: 'done',
      patchArtifact: 'artifacts/patches/finalize-crash-window.patch.json',
      changedFiles: [],
    },
  });

  const finalized = await finalizeRunFromInventory(run.runRoot, { runId: run.runId });

  assert.equal(finalized.patchReview.required, true);
  assert.equal(finalized.summaryStatus, 'blocked');
  assert.equal(finalized.runState.lifecycleStatus, 'waiting');
  assert.equal((await readRunState(run.runRoot)).summaryStatus, 'blocked');
});

test('finalize honors patch.review_required emitted before node.blocked', async () => {
  const run = await makeRun('run_20260517_finalize_patch_review_request_window');
  const itemId = await queueProposal(run, proposal({
    suggestedWorkItemId: 'finalize-patch-review-request-window',
    fingerprint: 'lifecycle:finalize-patch-review-request-window',
  }));
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId,
    toState: 'claimed',
    transitionId: 'claim:finalize-patch-review-request-window',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId,
    toState: 'done',
    transitionId: 'close:finalize-patch-review-request-window',
  });
  const patchArtifact = 'artifacts/patches/request-window.patch.json';
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId,
    reason: 'worker-result.accepted',
    payload: {
      status: 'done',
      toState: 'done',
      patchArtifact,
      changedFiles: ['src/routine.txt'],
      lockTargetFiles: ['src/routine.txt'],
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'patch.review_required',
    reason: 'patch-review.destructive_scope',
    artifactRefs: [patchArtifact],
    payload: {
      patchArtifact,
      reason: 'destructive_scope',
      reasons: ['destructive_scope'],
      changedFiles: ['src/routine.txt'],
      declaredTargetFiles: ['src/routine.txt'],
      outsideTargetFiles: ['src/unplanned.txt'],
    },
  });

  const finalized = await finalizeRunFromInventory(run.runRoot, { runId: run.runId });

  assert.equal(finalized.patchReview.required, true);
  assert.equal(finalized.summaryStatus, 'blocked');
  assert.equal(finalized.runState.lifecycleStatus, 'waiting');
  assert.equal((await readRunState(run.runRoot)).summaryStatus, 'blocked');
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

  assert.equal((await findQueueItem(run.runRoot, itemId, { canonicalOnly: false })).state, 'candidate');
  assert.equal(await findQueueItem(run.runRoot, itemId), null);

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

test('resume keeps run blocked while approved patch review is not applied', async () => {
  const run = await makeRun('run_20260430_resume_patch_review_blocked');
  const itemId = await queueProposal(run);
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId,
    toState: 'claimed',
    transitionId: 'claim:lifecycle-patch-review-item',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId,
    toState: 'done',
    transitionId: 'close:lifecycle-patch-review-item',
  });
  const patchArtifact = 'artifacts/patches/lifecycle-patch-review.patch.json';
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId,
    reason: 'worker-result.accepted',
    payload: {
      status: 'done',
      toState: 'done',
      patchArtifact,
      changedFiles: ['src/lifecycle.txt'],
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'renderer',
    eventType: 'patch.approved',
    reason: 'machine-ui.patch-review.approve',
    artifactRefs: [patchArtifact],
    payload: {
      patchArtifact,
      selectedFiles: ['src/lifecycle.txt'],
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/patch-review',
    eventType: 'node.blocked',
    reason: 'patch-review.required',
    payload: {
      nodeType: 'orpad.patchReview',
      status: 'blocked',
      reason: 'patch-review.required',
      patchCount: 1,
      pendingCount: 1,
    },
  });

  const resumed = await resumeMachineRun(run.runRoot, {
    runId: run.runId,
    now: '2026-04-30T00:00:20.000Z',
  });

  assert.equal(resumed.inventory.activeCount, 0);
  assert.equal(resumed.patchReview.required, true);
  assert.equal(resumed.patchReview.resolved, false);
  assert.equal(resumed.runState.lifecycleStatus, 'waiting');
  assert.equal(resumed.runState.summaryStatus, 'blocked');
  assert.equal((await readRunState(run.runRoot)).summaryStatus, 'blocked');
});

test('resume keeps run blocked when review-required patch predates patchReview node blocking', async () => {
  const run = await makeRun('run_20260517_resume_patch_review_crash_window');
  const itemId = await queueProposal(run, proposal({
    suggestedWorkItemId: 'resume-patch-review-crash-window',
    fingerprint: 'lifecycle:resume-patch-review-crash-window',
  }));
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId,
    toState: 'claimed',
    transitionId: 'claim:resume-patch-review-crash-window',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId,
    toState: 'done',
    transitionId: 'close:resume-patch-review-crash-window',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId,
    reason: 'worker-result.accepted',
    payload: {
      status: 'done',
      toState: 'done',
      patchArtifact: 'artifacts/patches/resume-crash-window.patch.json',
      changedFiles: [],
    },
  });

  const resumed = await resumeMachineRun(run.runRoot, {
    runId: run.runId,
    now: '2026-04-30T00:00:20.000Z',
  });

  assert.equal(resumed.inventory.activeCount, 0);
  assert.equal(resumed.patchReview.required, true);
  assert.equal(resumed.runState.lifecycleStatus, 'waiting');
  assert.equal(resumed.runState.summaryStatus, 'blocked');
  assert.equal((await readRunState(run.runRoot)).summaryStatus, 'blocked');
});
