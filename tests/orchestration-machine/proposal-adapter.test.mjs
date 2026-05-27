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
  recordAdapterRequest,
  runProposalOnlyAdapter,
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

test('proposal-only adapter result records status-specific event reasons', async () => {
  const run = await makeRun();
  const failedRequest = createAdapterRequest({
    runId: run.runId,
    nodePath: 'discovery/failing-probe',
    taskKind: 'probe',
    workspaceRoot: run.workspaceRoot,
  });

  const failed = await applyProposalAdapterResult(run.runRoot, failedRequest, adapterResult(failedRequest, {
    status: 'failed',
    summary: 'Codex CLI proposal adapter timed out before writing last-message.json.',
    candidateProposals: [],
  }));

  assert.equal(failed.summaryStatus, 'blocked');

  const doneRequest = createAdapterRequest({
    runId: run.runId,
    nodePath: 'discovery/done-probe',
    taskKind: 'probe',
    workspaceRoot: run.workspaceRoot,
  });
  await applyProposalAdapterResult(run.runRoot, doneRequest, adapterResult(doneRequest));

  const events = await readMachineEvents(run.runRoot);
  const failedEvent = events.find(event => event.eventType === 'adapter.result' && event.payload?.adapterCallId === failedRequest.adapterCallId);
  const doneEvent = events.find(event => event.eventType === 'adapter.result' && event.payload?.adapterCallId === doneRequest.adapterCallId);

  assert.equal(failedEvent?.reason, 'proposal-only-result.failed');
  assert.equal(failedEvent?.payload?.status, 'failed');
  assert.equal(failedEvent?.payload?.taskKind, 'probe');
  assert.equal(doneEvent?.reason, 'proposal-only-result.accepted');
});

test('proposal-only probe preserves candidate targetFiles on ingested work items', async () => {
  const run = await makeRun();
  const request = createAdapterRequest({
    runId: run.runId,
    nodePath: 'discovery/ux-probe',
    taskKind: 'probe',
    workspaceRoot: run.workspaceRoot,
  });

  await runProposalProbe({
    runRoot: run.runRoot,
    request,
    fixtureResult: adapterResult(request, {
      candidateProposals: [proposal({
        sourceOfTruthTargets: ['src/renderer/renderer.js'],
        targetFiles: ['src/./renderer/renderer.js', 'tests\\renderer.test.mjs'],
      })],
    }),
    now: '2026-04-30T00:00:01.000Z',
  });

  const item = await findQueueItem(run.runRoot, 'graph-editor-graph-specific-node-types');
  assert.deepEqual(item.item.targetFiles, [
    'src/renderer/renderer.js',
    'tests/renderer.test.mjs',
  ]);
});

test('proposal-only adapter rejects Unity-generated meta proposals as non-runnable', async () => {
  const run = await makeRun();
  const request = createAdapterRequest({
    runId: run.runId,
    nodePath: 'discovery/unity-meta-probe',
    taskKind: 'probe',
    workspaceRoot: run.workspaceRoot,
  });

  const applied = await applyProposalAdapterResult(run.runRoot, request, adapterResult(request, {
    candidateProposals: [proposal({
      proposalId: 'proposal-package-tests-generated-meta',
      suggestedWorkItemId: 'package-tests-generated-meta',
      title: 'Make package tests Unity-importable with generated meta files',
      fingerprint: 'unity:package-tests-generated-meta',
      evidence: [{ id: 'agent-rule', file: 'AGENTS.md' }],
      acceptanceCriteria: [
        'Unity has imported Packages/com.example/Tests so .meta files exist for the Tests folder.',
        'No .meta files are hand-authored; they are generated by Unity import as required by project guidance.',
      ],
      sourceOfTruthTargets: ['AGENTS.md'],
      targetFiles: [
        'Packages/com.example/Tests',
        'Packages/com.example/Tests.meta',
      ],
      verificationPlan: 'Open Unity to let it generate meta files, then verify the generated .meta files are committed.',
    })],
  }));

  assert.equal(applied.proposals.length, 1);
  assert.equal(applied.rejectedProposals.length, 1);
  const item = await findQueueItem(run.runRoot, 'package-tests-generated-meta');
  assert.equal(item.state, 'rejected');
  assert.equal(item.item.machineRejected, true);

  const resultEvent = (await readMachineEvents(run.runRoot))
    .find(event => event.eventType === 'adapter.result' && event.payload?.adapterCallId === request.adapterCallId);
  assert.equal(resultEvent.payload.rejectedProposalCount, 1);
});

test('adapter requests reject unsafe ids and run-relative refs before Machine events', async () => {
  const run = await makeRun();

  assert.throws(
    () => createAdapterRequest({
      runId: run.runId,
      nodePath: 'discovery/unsafe-probe',
      taskKind: 'probe',
      adapterCallId: '../adapter-call',
    }),
    error => error?.code === 'MACHINE_STORAGE_ID_INVALID' && error?.field === 'adapterCallId',
  );

  const request = createAdapterRequest({
    runId: run.runId,
    nodePath: 'discovery/unsafe-probe',
    taskKind: 'probe',
  });
  await assert.rejects(
    recordAdapterRequest(run.runRoot, {
      ...request,
      adapterResultPath: '../outside.result.json',
    }),
    /Invalid Orchestration Machine adapterRequest contract/,
  );

  assert.equal((await readMachineEvents(run.runRoot)).some(event => event.eventType === 'adapter.requested'), false);
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

test('proposal-only adapter retry does not duplicate adapter request events', async () => {
  const run = await makeRun();
  const request = createAdapterRequest({
    runId: run.runId,
    nodePath: 'discovery/retry-request-probe',
    taskKind: 'probe',
  });
  const result = adapterResult(request);

  const first = await runProposalOnlyAdapter({
    runRoot: run.runRoot,
    request,
    fixtureResult: result,
  });
  const second = await runProposalOnlyAdapter({
    runRoot: run.runRoot,
    request,
    fixtureResult: () => {
      throw new Error('duplicate result should not invoke adapter');
    },
  });
  const events = await readMachineEvents(run.runRoot);

  assert.equal(first.duplicate, undefined);
  assert.equal(second.duplicate, true);
  assert.equal(events.filter(event => event.eventType === 'adapter.requested').length, 1);
  assert.equal(events.filter(event => event.eventType === 'adapter.result').length, 1);
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

test('runProposalOnlyAdapter with retryOnInvalidContract retries once and recovers from contract error', async () => {
  const run = await makeRun();
  const request = createAdapterRequest({
    runId: run.runId,
    nodePath: 'discovery/retry-probe',
    taskKind: 'probe',
  });

  let calls = 0;
  const adapter = {
    adapter: 'fake-llm',
    async invoke(req, ctx) {
      calls += 1;
      if (calls === 1) {
        // First call: malformed — wrong status enum (LLM hallucinated 'success').
        return adapterResult(req, { status: 'success' });
      }
      // Second call: must have received the correction context.
      assert.equal(ctx.attempt, 2);
      assert.ok(ctx.previousValidationError);
      assert.equal(ctx.previousValidationError.code, 'INVALID_ADAPTER_CONTRACT');
      return adapterResult(req, {
        status: 'done',
        summary: 'After retry, returned valid contract.',
      });
    },
  };

  const applied = await runProposalOnlyAdapter({
    runRoot: run.runRoot,
    request,
    adapter,
    retryOnInvalidContract: true,
  });

  assert.equal(calls, 2);
  assert.equal(applied.summaryStatus, 'partial');
});

test('runProposalOnlyAdapter without retryOnInvalidContract surfaces INVALID_ADAPTER_CONTRACT immediately', async () => {
  const run = await makeRun();
  const request = createAdapterRequest({
    runId: run.runId,
    nodePath: 'discovery/no-retry-probe',
    taskKind: 'probe',
  });

  let calls = 0;
  const adapter = {
    adapter: 'fake-llm',
    async invoke(req) {
      calls += 1;
      return adapterResult(req, { status: 'success' });
    },
  };

  await assert.rejects(
    runProposalOnlyAdapter({
      runRoot: run.runRoot,
      request,
      adapter,
    }),
    err => err?.code === 'INVALID_ADAPTER_CONTRACT',
  );
  assert.equal(calls, 1);
});

test('proposal-only result with status=blocked and no work + no justification is rejected', async () => {
  const run = await makeRun();
  const request = createAdapterRequest({
    runId: run.runId,
    nodePath: 'discovery/silent-blocked',
    taskKind: 'triage',
  });

  await assert.rejects(
    applyProposalAdapterResult(run.runRoot, request, adapterResult(request, {
      status: 'blocked',
      summary: 'LLM produced nothing actionable but did not say why.',
      candidateProposals: [],
      // intentionally no triageTransitions, no emptyPass, no deferredReason
    })),
    err => err?.code === 'PROPOSAL_EMPTY_PASS_UNPROVEN' && err?.status === 'blocked',
  );

  // No transitions / proposals were committed.
  assert.equal((await readQueueItems(run.runRoot)).length, 0);
});

test('proposal-only result with status=blocked accepts emptyPass.reason as justification', async () => {
  const run = await makeRun();
  const request = createAdapterRequest({
    runId: run.runId,
    nodePath: 'discovery/silent-blocked-reasoned',
    taskKind: 'triage',
  });

  const applied = await applyProposalAdapterResult(run.runRoot, request, adapterResult(request, {
    status: 'blocked',
    summary: 'LLM saw nothing actionable; explained why.',
    candidateProposals: [],
    emptyPass: {
      reason: 'No candidate proposals matched the triage filter for this run.',
      evidence: [`node:${request.nodePath}`],
    },
  }));

  assert.equal(applied.summaryStatus, 'blocked');
});

test('proposal-only empty-pass caused by local tool failure is recorded as blocked', async () => {
  const run = await makeRun();
  const request = createAdapterRequest({
    runId: run.runId,
    nodePath: 'discovery/tool-blocked-probe',
    taskKind: 'probe',
  });

  const applied = await applyProposalAdapterResult(run.runRoot, request, adapterResult(request, {
    status: 'done',
    summary: 'No candidate proposals were emitted because local workspace inspection was blocked.',
    candidateProposals: [],
    emptyPass: {
      reason: 'Read-only terminal commands failed before execution with windows sandbox: spawn setup refresh.',
      evidence: ['rg --files failed before execution with windows sandbox: spawn setup refresh'],
    },
  }));

  const events = await readMachineEvents(run.runRoot);
  const resultEvent = events.find(event => event.eventType === 'adapter.result');
  assert.equal(applied.summaryStatus, 'blocked');
  assert.equal(resultEvent.payload.status, 'blocked');
  assert.equal(resultEvent.payload.infrastructureBlocked, true);
  assert.equal(resultEvent.payload.deferredReason, 'adapter-local-tool-unavailable');
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
