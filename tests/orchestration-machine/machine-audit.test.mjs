import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  appendMachineEvent,
  createMachineRun,
  exportLatestRun,
  ingestCandidateProposal,
  repairRunStateFromEvents,
  recordNodeLifecycleEvent,
  registerArtifact,
  registerCandidateInventoryArtifact,
  transitionQueueItem,
} = require('../../src/main/orchestration-machine');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const fixedNow = new Date('2026-04-30T00:00:00.000Z');

function proposal() {
  return {
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: 'proposal-graph-node-types',
    suggestedWorkItemId: 'graph-editor-graph-specific-node-types',
    sourceNode: 'ux-ui-probe',
    title: 'Show graph-specific node types in the graph editor picker',
    fingerprint: 'ux:graph-editor:graph-specific-node-types',
    evidence: [{ id: 'ux-graph-editor-source', file: 'src/renderer/renderer.js' }],
    acceptanceCriteria: ['Graph editor type picker includes graph-specific node types.'],
    sourceOfTruthTargets: ['src/renderer/renderer.js'],
  };
}

async function makeAuditableRun() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-audit-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/sample-machine-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'sample-machine-pipeline',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId: 'run_20260430_audit',
    now: fixedNow,
  });
  await ingestCandidateProposal(run.runRoot, proposal(), {
    runId: run.runId,
    transitionId: 'ingest:item',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: 'graph-editor-graph-specific-node-types',
    toState: 'queued',
    transitionId: 'triage:item',
  });
  await registerArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: 'artifacts/queue/triage-log.md',
    content: '# Triage log\n',
    producedBy: 'adapter:proposal-only',
    registeredBy: 'machine',
  });
  await recordNodeLifecycleEvent(run.runRoot, {
    runId: run.runId,
    nodePath: 'main/probe',
    nodeType: 'orpad.probe',
    status: 'scheduled',
  });
  await recordNodeLifecycleEvent(run.runRoot, {
    runId: run.runId,
    nodePath: 'main/probe',
    nodeType: 'orpad.probe',
    status: 'started',
  });
  await recordNodeLifecycleEvent(run.runRoot, {
    runId: run.runId,
    nodePath: 'main/probe',
    nodeType: 'orpad.probe',
    status: 'completed',
    payload: { proposalCount: 1 },
  });
  await registerCandidateInventoryArtifact(run.runRoot, {
    runId: run.runId,
    probes: [
      {
        nodePath: 'main/probe',
        candidateProposals: [proposal()],
      },
    ],
  });
  await repairRunStateFromEvents(run.runRoot);
  const exportResult = await exportLatestRun({
    runRoot: run.runRoot,
    pipelineDir,
    exportedAt: '2026-04-30T00:00:10.000Z',
  });
  return { ...run, pipelineDir, latestRunExportRoot: exportResult.targetRoot };
}

function runAudit(runRoot, latestRunExportRoot = '') {
  const args = ['scripts/audit-orpad-machine-run.mjs', runRoot];
  if (latestRunExportRoot) args.push(latestRunExportRoot);
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: result.stdout ? JSON.parse(result.stdout) : null,
  };
}

test('audit-orpad-machine-run passes on a durable Machine run and export', async () => {
  const run = await makeAuditableRun();
  const result = runAudit(run.runRoot, run.latestRunExportRoot);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.eventCount, 8);
  assert.equal(result.json.artifactCount, 2);
  assert.equal(result.json.candidateInventoryCount, 1);
  assert.equal(result.json.candidateInventoryItemCount, 1);
  assert.equal(result.json.projectedQueueItemCount, 1);
  assert.equal(result.json.legacyJournalCount, 2);
});

test('audit-orpad-machine-run fails when artifact content no longer matches manifest', async () => {
  const run = await makeAuditableRun();
  await fs.writeFile(path.join(run.runRoot, 'artifacts/queue/triage-log.md'), '# changed\n', 'utf8');

  const result = runAudit(run.runRoot, run.latestRunExportRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(result.json.ok, false);
  assert.equal(codes.has('MACHINE_ARTIFACT_HASH_MISMATCH'), true);
  assert.equal(codes.has('MACHINE_ARTIFACT_SIZE_MISMATCH'), true);
});

test('audit-orpad-machine-run fails when latest-run export is stale', async () => {
  const run = await makeAuditableRun();
  const metadataPath = path.join(run.latestRunExportRoot, 'run-metadata.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  metadata.sourceEventSequence = 0;
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

  const result = runAudit(run.runRoot, run.latestRunExportRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_LATEST_RUN_EXPORT_SEQUENCE_STALE'), true);
});

test('audit-orpad-machine-run fails when candidate inventory counts are corrupted', async () => {
  const run = await makeAuditableRun();
  const inventoryPath = path.join(run.runRoot, 'artifacts/discovery/candidate-inventory.json');
  const inventory = JSON.parse(await fs.readFile(inventoryPath, 'utf8'));
  inventory.candidateCount = 0;
  await fs.writeFile(inventoryPath, JSON.stringify(inventory, null, 2), 'utf8');

  const result = runAudit(run.runRoot, run.latestRunExportRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_CANDIDATE_INVENTORY_COUNT_MISMATCH'), true);
});

test('audit-orpad-machine-run fails when candidate inventory names a probe that did not complete', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-audit-probe-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/sample-machine-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'sample-machine-pipeline',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId: 'run_20260430_audit_probe_missing',
    now: fixedNow,
  });
  await registerCandidateInventoryArtifact(run.runRoot, {
    runId: run.runId,
    probes: [
      {
        nodePath: 'main/probe',
        candidateProposals: [proposal()],
      },
    ],
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_CANDIDATE_INVENTORY_PROBE_NOT_COMPLETED'), true);
});

test('audit-orpad-machine-run fails when node lifecycle terminal events skip started', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-audit-lifecycle-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/sample-machine-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'sample-machine-pipeline',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId: 'run_20260430_audit_bad_lifecycle',
    now: fixedNow,
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/probe',
    eventType: 'node.completed',
    payload: {
      nodeExecutionId: `${run.runId}:main/probe:attempt-1`,
      nodeType: 'orpad.probe',
      status: 'completed',
      attempt: 1,
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_NODE_TERMINAL_WITHOUT_STARTED'), true);
});

test('audit-orpad-machine-run fails when adapter result has no matching request identity', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-audit-adapter-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/sample-machine-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'sample-machine-pipeline',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId: 'run_20260430_audit_bad_adapter',
    now: fixedNow,
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/probe',
    eventType: 'adapter.result',
    payload: {
      adapterCallId: 'missing-request-call',
      attemptId: 'missing-request-attempt-1',
      idempotencyKey: 'missing-request-call:missing-request-attempt-1',
      status: 'done',
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_ADAPTER_RESULT_WITHOUT_REQUEST'), true);
});

test('audit-orpad-machine-run fails when done worker result has no proof', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-audit-worker-proof-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/sample-machine-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'sample-machine-pipeline',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId: 'run_20260430_audit_worker_no_proof',
    now: fixedNow,
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/worker',
    eventType: 'adapter.requested',
    payload: {
      adapter: 'worker-fixture',
      adapterCallId: 'worker-no-proof-call',
      attemptId: 'worker-no-proof-attempt-1',
      idempotencyKey: 'worker-no-proof-call:worker-no-proof-attempt-1',
      taskKind: 'workerLoop',
      workspaceMode: 'read-only-plus-overlay',
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/worker',
    eventType: 'worker.result',
    itemId: 'worker-no-proof',
    payload: {
      claimId: 'claim-worker-no-proof',
      adapterCallId: 'worker-no-proof-call',
      attemptId: 'worker-no-proof-attempt-1',
      idempotencyKey: 'worker-no-proof-call:worker-no-proof-attempt-1',
      status: 'done',
      verification: [],
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_WORKER_DONE_PROOF_MISSING'), true);
});

test('audit-orpad-machine-run fails when queue claim transition has no prior lease', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-audit-claim-causality-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/sample-machine-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'sample-machine-pipeline',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId: 'run_20260430_audit_claim_without_lease',
    now: fixedNow,
  });
  await ingestCandidateProposal(run.runRoot, proposal(), {
    runId: run.runId,
    transitionId: 'ingest:claim-without-lease',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: 'graph-editor-graph-specific-node-types',
    toState: 'queued',
    transitionId: 'triage:claim-without-lease',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: 'graph-editor-graph-specific-node-types',
    toState: 'claimed',
    transitionId: 'claim:graph-editor-graph-specific-node-types:missing-lease',
    payload: {
      claimId: 'missing-lease',
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_QUEUE_CLAIM_WITHOUT_LEASE'), true);
});

test('audit-orpad-machine-run fails when queue done transition has no prior worker result', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-audit-done-causality-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/sample-machine-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'sample-machine-pipeline',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId: 'run_20260430_audit_done_without_worker',
    now: fixedNow,
  });
  const claimId = 'claim-without-worker-result';
  await ingestCandidateProposal(run.runRoot, proposal(), {
    runId: run.runId,
    transitionId: 'ingest:done-without-worker',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: 'graph-editor-graph-specific-node-types',
    toState: 'queued',
    transitionId: 'triage:done-without-worker',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'claim.lease-created',
    itemId: 'graph-editor-graph-specific-node-types',
    reason: 'dispatcher.claim-lease',
    payload: {
      claimId,
      workerId: 'worker-audit',
      leaseMs: 300000,
      expiresAt: '2026-04-30T00:05:00.000Z',
    },
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: 'graph-editor-graph-specific-node-types',
    toState: 'claimed',
    transitionId: `claim:graph-editor-graph-specific-node-types:${claimId}`,
    payload: {
      claimId,
      workerId: 'worker-audit',
    },
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: 'graph-editor-graph-specific-node-types',
    toState: 'done',
    transitionId: `close:${claimId}:missing-worker-result`,
    payload: {
      claimId,
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_QUEUE_DONE_WITHOUT_WORKER_RESULT'), true);
  assert.equal(codes.has('MACHINE_QUEUE_CLAIM_WITHOUT_LEASE'), false);
});
