import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const summary = require('../../src/shared/orchestration/failure-summary');
const orchestration = require('../../src/main/orchestration-machine');

function syntheticAdapterResult({ sequence, status, nodePath, adapterCallId, transcript = '' }) {
  return {
    sequence,
    eventType: 'adapter.result',
    nodePath,
    timestamp: '2026-05-06T00:00:00.000Z',
    payload: { adapter: 'codex-cli-proposal', adapterCallId, attemptId: `${adapterCallId}-attempt-1`, status, idempotencyKey: `${adapterCallId}:attempt-1` },
    artifactRefs: transcript ? [`artifacts/adapters/${adapterCallId}.transcript.json`, transcript] : [`artifacts/adapters/${adapterCallId}.transcript.json`],
    reason: status === 'failed' ? 'codex-cli-result.spawn-failed' : '',
  };
}

function syntheticNodeFailed({ sequence, nodePath, type = 'node.failed' }) {
  return {
    sequence,
    eventType: type,
    nodePath,
    timestamp: '2026-05-06T00:00:00.001Z',
    payload: { nodeExecutionId: `run:${nodePath}:attempt-1`, attempt: 1, status: type.replace('node.', '') },
    artifactRefs: [],
  };
}

test('failedAdapterCallsFromRecord finds adapter.result with status=failed', () => {
  const record = {
    runRoot: '/run',
    events: [
      syntheticAdapterResult({ sequence: 1, status: 'done', nodePath: 'main/probe-a', adapterCallId: 'a1' }),
      syntheticAdapterResult({ sequence: 2, status: 'failed', nodePath: 'main/probe-b', adapterCallId: 'b1' }),
    ],
  };
  const results = summary.failedAdapterCallsFromRecord(record);
  assert.equal(results.length, 1);
  assert.equal(results[0].nodePath, 'main/probe-b');
  assert.equal(results[0].status, 'failed');
  assert.equal(results[0].transcriptRef, 'artifacts/adapters/b1.transcript.json');
});

test('failedAdapterCallsFromRecord catches blocked / rejected / approval-required', () => {
  const record = {
    events: [
      syntheticAdapterResult({ sequence: 1, status: 'blocked', nodePath: 'main/probe-a', adapterCallId: 'a' }),
      syntheticAdapterResult({ sequence: 2, status: 'rejected', nodePath: 'main/probe-b', adapterCallId: 'b' }),
      syntheticAdapterResult({ sequence: 3, status: 'approval-required', nodePath: 'main/probe-c', adapterCallId: 'c' }),
      syntheticAdapterResult({ sequence: 4, status: 'done', nodePath: 'main/probe-d', adapterCallId: 'd' }),
    ],
  };
  const statuses = summary.failedAdapterCallsFromRecord(record).map(r => r.status).sort();
  assert.deepEqual(statuses, ['approval-required', 'blocked', 'rejected']);
});

test('failedAdapterCallsFromRecord keeps only the latest attempt per adapterCallId', () => {
  const record = {
    events: [
      syntheticAdapterResult({ sequence: 1, status: 'failed', nodePath: 'main/probe', adapterCallId: 'x1' }),
      syntheticAdapterResult({ sequence: 2, status: 'failed', nodePath: 'main/probe', adapterCallId: 'x1' }),
    ],
  };
  const results = summary.failedAdapterCallsFromRecord(record);
  assert.equal(results.length, 1);
});

test('failedAdapterCallsFromRecord falls through to node.failed when no adapter.result is present', () => {
  const record = {
    events: [
      syntheticNodeFailed({ sequence: 1, nodePath: 'main/probe-a' }),
      syntheticNodeFailed({ sequence: 2, nodePath: 'main/probe-b', type: 'node.blocked' }),
    ],
  };
  const results = summary.failedAdapterCallsFromRecord(record);
  assert.equal(results.length, 2);
  const byNode = Object.fromEntries(results.map(r => [r.nodePath, r.status]));
  assert.equal(byNode['main/probe-a'], 'failed');
  assert.equal(byNode['main/probe-b'], 'blocked');
});

test('failedAdapterCallsFromRecord cross-references node.failed with prior adapter.result for transcripts', () => {
  const record = {
    events: [
      syntheticAdapterResult({ sequence: 1, status: 'failed', nodePath: 'main/probe-a', adapterCallId: 'a1' }),
      syntheticNodeFailed({ sequence: 2, nodePath: 'main/probe-a' }),
    ],
  };
  // Node.failed event for the same nodePath should not double-count;
  // the adapter.result entry already covers it.
  const results = summary.failedAdapterCallsFromRecord(record);
  assert.equal(results.length, 1);
  assert.equal(results[0].adapterCallId, 'a1');
  assert.equal(results[0].transcriptRef, 'artifacts/adapters/a1.transcript.json');
});

test('runArtifactAbsPath joins runRoot with relative ref', () => {
  const record = { runRoot: 'C:/runs/run_001' };
  const abs = summary.runArtifactAbsPath(record, 'artifacts/adapters/x.transcript.json');
  assert.equal(abs, 'C:/runs/run_001/artifacts/adapters/x.transcript.json');
});

test('runArtifactAbsPath returns empty for empty input', () => {
  assert.equal(summary.runArtifactAbsPath(null, 'a'), '');
  assert.equal(summary.runArtifactAbsPath({ runRoot: '/r' }, ''), '');
  assert.equal(summary.runArtifactAbsPath({}, 'a/b'), '');
});

test('lifecycleSuppressesFallback hides cancel/in-progress states from fallback rendering', () => {
  for (const state of ['cancelled', 'canceled', 'cancelling', 'created', 'running', 'waiting']) {
    assert.equal(summary.lifecycleSuppressesFallback(state), true, `expected suppression for ${state}`);
  }
  for (const state of ['failed', 'completed', 'blocked']) {
    assert.equal(summary.lifecycleSuppressesFallback(state), false, `expected no suppression for ${state}`);
  }
});

test('shouldShowFailureFallback only fires for failed lifecycle or blocked summary', () => {
  assert.equal(summary.shouldShowFailureFallback({ runState: { lifecycleStatus: 'cancelled' } }, []), false);
  assert.equal(summary.shouldShowFailureFallback({ runState: { lifecycleStatus: 'running' } }, []), false);
  assert.equal(summary.shouldShowFailureFallback({ runState: { lifecycleStatus: 'failed' } }, []), true);
  assert.equal(summary.shouldShowFailureFallback({ runState: { summaryStatus: 'blocked' } }, []), true);
  assert.equal(summary.shouldShowFailureFallback({ runState: { lifecycleStatus: 'failed' } }, [{}]), false);
});

async function makeFailingProbeWorkspace(runId) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-failing-probe-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/failing-probe-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'src/target.md'), 'before\n', 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'failing-probe',
      nodes: [
        { id: 'context', type: 'orpad.context', config: { summary: 'Context.' } },
        { id: 'probe', type: 'orpad.probe', config: { lens: 'fail-on-purpose' } },
        { id: 'barrier', type: 'orpad.barrier', config: { waitFor: ['probe'], mergePolicy: 'all' } },
        { id: 'queue', type: 'orpad.workQueue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', config: { queueRef: 'queue' } },
        { id: 'verification-gate', type: 'orpad.gate', config: { criteria: ['probe-success'] } },
      ],
      transitions: [
        { from: 'context', to: 'probe' },
        { from: 'probe', to: 'barrier' },
        { from: 'barrier', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'verification-gate' },
      ],
    },
  }, null, 2), 'utf8');
  const missingExec = process.platform === 'win32'
    ? 'C:\\orpad-missing-cli\\never-exists.exe'
    : '/orpad-missing-cli/never-exists';
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'failing-probe-pipeline',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    nodePacks: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3', origin: 'built-in' },
      { id: 'orpad.workstream', version: '>=0.1.0', origin: 'built-in' },
    ],
    run: {
      artifactRoot: 'harness/generated/latest-run/artifacts',
      queueRoot: 'harness/generated/latest-run/queue',
      metadataPath: 'harness/generated/latest-run/run-metadata.json',
      summaryPath: 'harness/generated/latest-run/summary.md',
      // Live adapter mode pointing at a binary that does not exist so spawn
      // fails with ENOENT — produces deterministic failure events without
      // needing claude / codex actually installed in the test environment.
      machineAdapter: {
        type: 'codex-cli',
        enabled: true,
        command: missingExec,
        proposalSandbox: 'read-only',
        workerSandbox: 'workspace-write',
        approvalPolicy: 'never',
        probeNodePaths: ['main/probe'],
        candidateLimit: 1,
        proposalTimeoutMs: 5000,
        workerTimeoutMs: 5000,
        claimLeaseMs: 60000,
      },
    },
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
  }, null, 2), 'utf8');
  const run = await orchestration.createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId,
  });
  return { workspaceRoot, pipelineDir, pipelinePath, run };
}

test('end-to-end: fake-failing CLI pipeline produces failure events that pass detection', async () => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await makeFailingProbeWorkspace('run_failing_e2e_001');
  try {
    try {
      await orchestration.executeMachineRunStep({
        workspaceRoot,
        pipelinePath,
        pipelineDir,
        runRoot: run.runRoot,
        runId: run.runId,
        exportLatestRunAfterStep: false,
      });
    } catch {
      // Step may throw or close the run depending on failure depth.
    }
    const events = await orchestration.readMachineEvents(run.runRoot);
    assert.equal(events.length > 0, true, 'expected at least one event');

    const record = {
      runRoot: run.runRoot,
      runState: await orchestration.readRunState(run.runRoot),
      events,
    };
    const failures = summary.failedAdapterCallsFromRecord(record);
    assert.equal(failures.length >= 1, true,
      `expected at least one failure detected, got ${failures.length}. eventTypes seen: ${[...new Set(events.map(e => e.eventType))].join(', ')}`);
    const probeFailure = failures.find(f => f.nodePath === 'main/probe');
    assert.equal(Boolean(probeFailure), true, 'expected the probe node to be flagged');
    if (probeFailure?.transcriptRef) {
      const abs = summary.runArtifactAbsPath(record, probeFailure.transcriptRef);
      assert.equal(abs.startsWith(run.runRoot), true);
      const transcript = JSON.parse(await fs.readFile(abs, 'utf8'));
      assert.equal(typeof transcript.process, 'object');
      assert.equal(transcript.process.spawnError?.code, 'ENOENT', 'transcript should record ENOENT spawn failure');
    }
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
