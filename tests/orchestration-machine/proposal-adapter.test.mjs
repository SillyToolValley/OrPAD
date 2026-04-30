import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  applyProposalAdapterResult,
  createAdapterRequest,
  createMachineRun,
  findQueueItem,
  readMachineEvents,
  readQueueItems,
  readRunState,
  runProposalProbe,
  runProposalTriage,
} = require('../../src/main/orchestration-machine');

const fixedNow = new Date('2026-04-30T00:00:00.000Z');

async function makeRun() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-proposal-adapter-'));
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
    runId: 'run_20260430_proposal_adapter',
    now: fixedNow,
  });
}

function proposal(overrides = {}) {
  return {
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: 'proposal-graph-node-types',
    suggestedWorkItemId: 'graph-editor-graph-specific-node-types',
    sourceNode: 'discovery/ux-probe',
    title: 'Show graph-specific node types in the graph editor picker',
    fingerprint: 'ux:graph-editor:graph-specific-node-types',
    evidence: [{ id: 'ux-graph-editor-source', file: 'src/renderer/renderer.js' }],
    acceptanceCriteria: ['Graph editor type picker includes graph-specific node types.'],
    sourceOfTruthTargets: ['src/renderer/renderer.js'],
    ...overrides,
  };
}

function adapterResult(request, overrides = {}) {
  return {
    schemaVersion: 'orpad.workerResult.v1',
    adapterCallId: request.adapterCallId,
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    status: 'done',
    summary: 'Submitted proposal candidates.',
    artifacts: [],
    candidateProposals: [proposal()],
    ...overrides,
  };
}

test('proposal-only probe ingests candidates without letting adapter close the run as done', async () => {
  const run = await makeRun();
  const request = createAdapterRequest({
    runId: run.runId,
    nodePath: 'discovery/ux-probe',
    taskKind: 'probe',
    workspaceRoot: run.workspaceRoot,
  });

  const applied = await runProposalProbe({
    runRoot: run.runRoot,
    request,
    fixtureResult: adapterResult(request),
    now: '2026-04-30T00:00:01.000Z',
  });

  assert.equal(applied.summaryStatus, 'partial');
  assert.equal(applied.proposals.length, 1);
  assert.equal((await findQueueItem(run.runRoot, 'graph-editor-graph-specific-node-types')).state, 'candidate');

  const runState = await readRunState(run.runRoot);
  assert.equal(runState.summaryStatus, 'partial');
  assert.notEqual(runState.summaryStatus, 'done');

  const events = await readMachineEvents(run.runRoot);
  assert.equal(events.some(event => event.eventType === 'adapter.requested'), true);
  assert.equal(events.some(event => event.eventType === 'adapter.result'), true);
  assert.equal(events.some(event => event.eventType === 'run.summary' && event.payload?.summaryStatus === 'partial'), true);
});

test('proposal-only triage performs Machine-owned queue transitions', async () => {
  const run = await makeRun();
  const probeRequest = createAdapterRequest({
    runId: run.runId,
    nodePath: 'discovery/ux-probe',
    taskKind: 'probe',
    workspaceRoot: run.workspaceRoot,
  });
  await runProposalProbe({
    runRoot: run.runRoot,
    request: probeRequest,
    fixtureResult: adapterResult(probeRequest),
  });

  const request = createAdapterRequest({
    runId: run.runId,
    nodePath: 'queue/triage',
    taskKind: 'triage',
    workspaceRoot: run.workspaceRoot,
  });

  await runProposalTriage({
    runRoot: run.runRoot,
    request,
    fixtureResult: adapterResult(request, {
      candidateProposals: [],
      triageTransitions: [{
        itemId: 'graph-editor-graph-specific-node-types',
        toState: 'queued',
        reason: 'triage.accepted-by-policy',
      }],
    }),
  });

  const queued = await findQueueItem(run.runRoot, 'graph-editor-graph-specific-node-types');
  assert.equal(queued.state, 'queued');

  const transitionEvents = (await readMachineEvents(run.runRoot))
    .filter(event => event.eventType === 'queue.transition');
  assert.deepEqual(transitionEvents.map(event => event.toState), ['candidate', 'queued']);
  assert.equal(transitionEvents.every(event => event.actor === 'machine'), true);
});

test('generic empty-pass result is rejected before queue mutation', async () => {
  const run = await makeRun();
  const request = createAdapterRequest({
    runId: run.runId,
    nodePath: 'discovery/empty-probe',
    taskKind: 'probe',
  });

  await assert.rejects(
    applyProposalAdapterResult(run.runRoot, request, adapterResult(request, {
      summary: 'No candidates found.',
      candidateProposals: [],
    })),
    error => error?.code === 'PROPOSAL_EMPTY_PASS_UNPROVEN',
  );

  assert.equal((await readQueueItems(run.runRoot)).length, 0);
  assert.equal((await readMachineEvents(run.runRoot)).some(event => event.eventType === 'adapter.result'), false);
});

test('proposal-only adapter result idempotency prevents duplicate mutation on retry', async () => {
  const run = await makeRun();
  const request = createAdapterRequest({
    runId: run.runId,
    nodePath: 'discovery/retry-probe',
    taskKind: 'probe',
  });
  const result = adapterResult(request);

  const first = await applyProposalAdapterResult(run.runRoot, request, result);
  const second = await applyProposalAdapterResult(run.runRoot, request, result);

  assert.equal(first.duplicate, undefined);
  assert.equal(second.duplicate, true);
  assert.equal((await readQueueItems(run.runRoot)).length, 1);
  assert.equal((await readMachineEvents(run.runRoot)).filter(event => event.eventType === 'adapter.result').length, 1);
});

test('candidate proposal missing proof is rejected by the adapter result contract', async () => {
  const run = await makeRun();
  const request = createAdapterRequest({
    runId: run.runId,
    nodePath: 'discovery/bad-probe',
    taskKind: 'probe',
  });

  await assert.rejects(
    applyProposalAdapterResult(run.runRoot, request, adapterResult(request, {
      candidateProposals: [proposal({ evidence: [] })],
    })),
    /Invalid Orchestration Machine adapterResult contract/,
  );

  assert.equal((await readQueueItems(run.runRoot)).length, 0);
});

test('deferred or negative proposal-only result leaves the run blocked without queue items', async () => {
  const run = await makeRun();
  const request = createAdapterRequest({
    runId: run.runId,
    nodePath: 'discovery/deferred-probe',
    taskKind: 'probe',
  });

  const applied = await applyProposalAdapterResult(run.runRoot, request, adapterResult(request, {
    status: 'blocked',
    summary: 'Probe deferred because the required evidence is unavailable.',
    candidateProposals: [],
    deferredReason: 'evidence-unavailable',
  }));

  assert.equal(applied.summaryStatus, 'blocked');
  assert.equal((await readRunState(run.runRoot)).summaryStatus, 'blocked');
  assert.equal((await readQueueItems(run.runRoot)).length, 0);
});
