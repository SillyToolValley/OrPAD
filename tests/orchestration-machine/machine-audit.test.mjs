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

async function makeAuditableRun(options = {}) {
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
    llmApprovalMode: options.llmApprovalMode || 'ask',
    patchReviewMode: options.patchReviewMode || 'manual',
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

async function appendStartedWorkerRequest(run, options = {}) {
  const nodePath = options.nodePath || 'main/worker';
  const attempt = options.attempt || 1;
  const adapterCallId = options.adapterCallId || 'worker-audit-call';
  const attemptId = options.attemptId || `${adapterCallId}-attempt-1`;
  const idempotencyKey = options.idempotencyKey || `${adapterCallId}:${attemptId}`;
  await recordNodeLifecycleEvent(run.runRoot, {
    runId: run.runId,
    nodePath,
    nodeType: 'orpad.workerLoop',
    status: 'scheduled',
    payload: { attempt },
  });
  await recordNodeLifecycleEvent(run.runRoot, {
    runId: run.runId,
    nodePath,
    nodeType: 'orpad.workerLoop',
    status: 'started',
    payload: { attempt },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath,
    eventType: 'adapter.requested',
    payload: {
      adapter: 'worker-fixture',
      adapterCallId,
      attemptId,
      idempotencyKey,
      taskKind: 'workerLoop',
      workspaceMode: 'read-only-plus-overlay',
      attempt,
    },
  });
  return { nodePath, adapterCallId, attemptId, idempotencyKey, attempt };
}

async function registerPatchArtifactFixture(run, artifactPath, patch) {
  await registerArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath,
    content: `${JSON.stringify(patch, null, 2)}\n`,
    producedBy: 'worker-fixture',
    registeredBy: 'machine',
    schemaVersion: 'orpad.patchArtifact.v1',
  });
}

function patchArtifactFixture(overrides = {}) {
  return {
    schemaVersion: 'orpad.patchArtifact.v1',
    createdAt: fixedNow.toISOString(),
    allowedFiles: ['OrPad/src/renderer/renderer.js'],
    changes: [],
    violations: [],
    ignoredGeneratedFiles: [],
    ...overrides,
  };
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

async function lastEventSequence(runRoot) {
  const eventsPath = path.join(runRoot, 'events.jsonl');
  const lines = (await fs.readFile(eventsPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return 0;
  return JSON.parse(lines[lines.length - 1]).sequence;
}

async function makeCompletedProbeRun(runId) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-audit-empty-pass-'));
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
    runId,
    now: fixedNow,
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
    payload: { proposalCount: 0 },
  });
  await repairRunStateFromEvents(run.runRoot);
  return run;
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

test('audit-orpad-machine-run fails when an event belongs to another run id', async () => {
  const run = await makeAuditableRun();
  const eventsPath = path.join(run.runRoot, 'events.jsonl');
  const events = (await fs.readFile(eventsPath, 'utf8'))
    .trim()
    .split(/\r?\n/)
    .map(line => JSON.parse(line));
  events[1].runId = 'run_20260430_other';
  await fs.writeFile(eventsPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8');

  const result = runAudit(run.runRoot, run.latestRunExportRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_EVENT_RUN_ID_MISMATCH'), true);
});

test('audit-orpad-machine-run fails when artifact manifest violates schema', async () => {
  const run = await makeAuditableRun();
  const manifestPath = path.join(run.runRoot, 'artifacts/manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.schemaVersion = 'orpad.artifactManifest.v0';
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  const result = runAudit(run.runRoot, run.latestRunExportRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_ARTIFACT_MANIFEST_SCHEMA_INVALID'), true);
});

test('audit-orpad-machine-run fails without reading unsafe artifact manifest paths', async () => {
  const run = await makeAuditableRun();
  const manifestPath = path.join(run.runRoot, 'artifacts/manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.files[0].path = '../outside.md';
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  const result = runAudit(run.runRoot, run.latestRunExportRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_ARTIFACT_PATH_INVALID'), true);
});

test('audit-orpad-machine-run fails when evidence snapshot is stale', async () => {
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

test('audit-orpad-machine-run fails when approval decision has no request', async () => {
  const run = await makeAuditableRun();
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'approval.decided',
    itemId: 'graph-editor-graph-specific-node-types',
    payload: {
      approvalId: 'approval-orphan',
      decision: 'approved',
      grants: [{ itemId: 'graph-editor-graph-specific-node-types', approvalId: 'approval-orphan', approved: true }],
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_APPROVAL_DECISION_WITHOUT_REQUEST'), true);
});

test('audit-orpad-machine-run fails when approved approval omits dispatch grant', async () => {
  const run = await makeAuditableRun();
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'approval.requested',
    itemId: 'graph-editor-graph-specific-node-types',
    payload: {
      approvalId: 'approval-graph-editor-graph-specific-node-types',
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'approval.decided',
    itemId: 'graph-editor-graph-specific-node-types',
    payload: {
      approvalId: 'approval-graph-editor-graph-specific-node-types',
      decision: 'approved',
      grants: [],
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_APPROVAL_APPROVED_GRANT_MISSING'), true);
});

test('audit-orpad-machine-run fails when approved approval uses a broad grant', async () => {
  const run = await makeAuditableRun();
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'approval.requested',
    itemId: 'graph-editor-graph-specific-node-types',
    payload: {
      approvalId: 'approval-graph-editor-graph-specific-node-types',
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'approval.decided',
    itemId: 'graph-editor-graph-specific-node-types',
    payload: {
      approvalId: 'approval-graph-editor-graph-specific-node-types',
      decision: 'approved',
      grants: [true],
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_APPROVAL_APPROVED_GRANT_MISSING'), true);
});

test('audit-orpad-machine-run fails when pending approval is resumed without a decision', async () => {
  const run = await makeAuditableRun();
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'approval.requested',
    itemId: 'graph-editor-graph-specific-node-types',
    payload: {
      approvalId: 'approval-graph-editor-graph-specific-node-types',
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'run.status',
    fromState: 'approval-required',
    toState: 'waiting',
    reason: 'test.invalid-resume-with-pending-approval',
    payload: {
      approvalId: 'approval-graph-editor-graph-specific-node-types',
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_APPROVAL_PENDING_RUN_RESUMED'), true);
});

test('audit-orpad-machine-run flags pending approvals left in a bypass run', async () => {
  const run = await makeAuditableRun({ llmApprovalMode: 'bypass' });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'approval.requested',
    itemId: 'graph-editor-graph-specific-node-types',
    payload: {
      approvalId: 'approval-bypass-stuck',
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_BYPASS_APPROVAL_REQUIRED_STUCK'), true);
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

test('audit-orpad-machine-run accepts a candidate inventory file re-registered later in the run', async () => {
  const run = await makeAuditableRun();
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

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(codes.has('MACHINE_CANDIDATE_INVENTORY_SOURCE_SEQUENCE_INVALID'), false);
});

test('audit-orpad-machine-run accepts a concrete risk-check-scoped empty-pass inventory row', async () => {
  const run = await makeCompletedProbeRun('run_20260430_audit_empty_pass_concrete');
  await registerCandidateInventoryArtifact(run.runRoot, {
    runId: run.runId,
    probes: [
      {
        nodePath: 'main/probe',
        candidateProposals: [],
        result: {
          emptyPass: {
            reason: 'Adapter inspected the requested improvement surface and found no deterministic local candidate.',
            evidence: ['adapter:empty-pass:main/probe'],
          },
        },
      },
    ],
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.candidateInventoryItemCount, 1);
});

test('audit-orpad-machine-run rejects a shallow empty-pass inventory row without negativeCheck evidence', async () => {
  const run = await makeCompletedProbeRun('run_20260430_audit_empty_pass_shallow');
  const shallowInventory = {
    schemaVersion: 'orpad.machineCandidateInventory.v1',
    runId: run.runId,
    createdAt: '2026-04-30T00:00:05.000Z',
    sourceEventSequence: await lastEventSequence(run.runRoot),
    selectedProbeNodes: ['main/probe'],
    candidateCount: 0,
    emptyPassCount: 1,
    items: [
      {
        id: 'empty-pass-main-probe',
        status: 'empty-pass',
        nodePath: 'main/probe',
        reason: 'No deterministic harness candidate was assigned to this probe node.',
        evidence: ['node:main/probe'],
      },
    ],
  };
  await registerArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: 'artifacts/discovery/candidate-inventory.json',
    content: `${JSON.stringify(shallowInventory, null, 2)}\n`,
    producedBy: 'orpad.machine.candidate-inventory',
    registeredBy: 'machine',
    schemaVersion: 'orpad.machineCandidateInventory.v1',
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_CANDIDATE_INVENTORY_SCHEMA_INVALID'), true);
  assert.equal(codes.has('MACHINE_CANDIDATE_INVENTORY_TRACEABILITY_MISSING'), true);
  assert.equal(codes.has('MACHINE_CANDIDATE_INVENTORY_EMPTY_PASS_NEGATIVE_CHECK_MISSING'), true);
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

test('audit-orpad-machine-run flags unresolved Machine-owned node failures in bypass runs', async () => {
  const run = await makeAuditableRun({ llmApprovalMode: 'bypass' });
  await recordNodeLifecycleEvent(run.runRoot, {
    runId: run.runId,
    nodePath: 'main/triage',
    nodeType: 'orpad.triage',
    status: 'scheduled',
  });
  await recordNodeLifecycleEvent(run.runRoot, {
    runId: run.runId,
    nodePath: 'main/triage',
    nodeType: 'orpad.triage',
    status: 'started',
  });
  await recordNodeLifecycleEvent(run.runRoot, {
    runId: run.runId,
    nodePath: 'main/triage',
    nodeType: 'orpad.triage',
    status: 'failed',
    payload: {
      code: 'MACHINE_QUEUE_TRANSITION_INVALID',
      message: 'Invalid queue transition: rejected -> queued',
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_BYPASS_INTERNAL_NODE_FAILED'), true);
});

test('audit-orpad-machine-run fails when node-scoped adapter event occurs before node start', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-audit-adapter-node-start-'));
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
    runId: 'run_20260430_audit_adapter_before_node_start',
    now: fixedNow,
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/probe',
    eventType: 'adapter.requested',
    payload: {
      adapter: 'proposal-fixture',
      adapterCallId: 'adapter-before-node-start-call',
      attemptId: 'adapter-before-node-start-attempt-1',
      idempotencyKey: 'adapter-before-node-start-call:adapter-before-node-start-attempt-1',
      taskKind: 'probe',
      workspaceMode: 'read-only',
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_ADAPTER_EVENT_WITHOUT_NODE_START'), true);
});

test('audit-orpad-machine-run fails when node-scoped adapter event occurs after node terminal', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-audit-adapter-after-node-'));
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
    runId: 'run_20260430_audit_adapter_after_node_terminal',
    now: fixedNow,
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
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/probe',
    eventType: 'adapter.requested',
    payload: {
      adapter: 'proposal-fixture',
      adapterCallId: 'adapter-after-node-terminal-call',
      attemptId: 'adapter-after-node-terminal-attempt-1',
      idempotencyKey: 'adapter-after-node-terminal-call:adapter-after-node-terminal-attempt-1',
      taskKind: 'probe',
      workspaceMode: 'read-only',
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_ADAPTER_EVENT_AFTER_NODE_TERMINAL'), true);
});

test('audit-orpad-machine-run accepts adapter events for a later node attempt after an earlier attempt terminal', async () => {
  const run = await makeAuditableRun();
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/worker',
    eventType: 'node.scheduled',
    payload: {
      nodeExecutionId: `${run.runId}:main/worker:attempt-1`,
      nodeType: 'orpad.workerLoop',
      status: 'scheduled',
      attempt: 1,
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/worker',
    eventType: 'node.started',
    payload: {
      nodeExecutionId: `${run.runId}:main/worker:attempt-1`,
      nodeType: 'orpad.workerLoop',
      status: 'started',
      attempt: 1,
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/worker',
    eventType: 'node.scheduled',
    payload: {
      nodeExecutionId: `${run.runId}:main/worker:attempt-2`,
      nodeType: 'orpad.workerLoop',
      status: 'scheduled',
      attempt: 2,
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/worker',
    eventType: 'node.started',
    payload: {
      nodeExecutionId: `${run.runId}:main/worker:attempt-2`,
      nodeType: 'orpad.workerLoop',
      status: 'started',
      attempt: 2,
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/worker',
    eventType: 'lock.granted',
    payload: {
      phase: 'file-lock-queue-phase-1',
      taskId: 'claim-later-attempt',
      attempt: 2,
      targetFiles: ['src/renderer/renderer.js'],
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/worker',
    eventType: 'node.completed',
    payload: {
      nodeExecutionId: `${run.runId}:main/worker:attempt-1`,
      nodeType: 'orpad.workerLoop',
      status: 'completed',
      attempt: 1,
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/worker',
    eventType: 'adapter.requested',
    payload: {
      adapter: 'worker-fixture',
      adapterCallId: 'claim-later-attempt-graph-cli',
      attemptId: 'claim-later-attempt-graph-cli-attempt-1',
      idempotencyKey: 'claim-later-attempt-graph-cli:attempt-1',
      taskKind: 'workerLoop',
      workspaceMode: 'read-only-plus-overlay',
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(codes.has('MACHINE_ADAPTER_EVENT_AFTER_NODE_TERMINAL'), false);
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

test('audit-orpad-machine-run fails when done worker result references unregistered artifact proof', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-audit-worker-artifact-'));
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
    runId: 'run_20260430_audit_worker_unregistered_artifact',
    now: fixedNow,
  });
  await registerArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: 'artifacts/queue/triage-log.md',
    content: '# Triage log\n',
    producedBy: 'adapter:proposal-only',
    registeredBy: 'machine',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/worker',
    eventType: 'adapter.requested',
    payload: {
      adapter: 'worker-fixture',
      adapterCallId: 'worker-unregistered-artifact-call',
      attemptId: 'worker-unregistered-artifact-attempt-1',
      idempotencyKey: 'worker-unregistered-artifact-call:worker-unregistered-artifact-attempt-1',
      taskKind: 'workerLoop',
      workspaceMode: 'read-only-plus-overlay',
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/worker',
    eventType: 'worker.result',
    itemId: 'worker-unregistered-artifact',
    artifactRefs: ['artifacts/patches/unregistered.patch.json'],
    payload: {
      claimId: 'claim-worker-unregistered-artifact',
      adapterCallId: 'worker-unregistered-artifact-call',
      attemptId: 'worker-unregistered-artifact-attempt-1',
      idempotencyKey: 'worker-unregistered-artifact-call:worker-unregistered-artifact-attempt-1',
      status: 'done',
      toState: 'done',
      patchArtifact: 'artifacts/patches/unregistered.patch.json',
      verification: [{ command: 'fixture', ok: true }],
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_WORKER_RESULT_ARTIFACT_UNREGISTERED'), true);
  assert.equal(codes.has('MACHINE_WORKER_DONE_PROOF_MISSING'), false);
});

test('audit-orpad-machine-run flags adapter approval-required blocks in bypass runs', async () => {
  const run = await makeAuditableRun({ llmApprovalMode: 'bypass' });
  const worker = await appendStartedWorkerRequest(run, {
    adapterCallId: 'bypass-adapter-approval-required-call',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: worker.nodePath,
    eventType: 'adapter.result',
    payload: {
      adapterCallId: worker.adapterCallId,
      attemptId: worker.attemptId,
      idempotencyKey: worker.idempotencyKey,
      taskKind: 'workerLoop',
      status: 'approval-required',
      deferredReason: 'provider requested tool permission',
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_BYPASS_ADAPTER_APPROVAL_REQUIRED'), true);
});

test('audit-orpad-machine-run flags unresolved adapter requests in bypass runs', async () => {
  const run = await makeAuditableRun({ llmApprovalMode: 'bypass' });
  await recordNodeLifecycleEvent(run.runRoot, {
    runId: run.runId,
    nodePath: 'main/worker',
    nodeType: 'orpad.workerLoop',
    status: 'scheduled',
  });
  await recordNodeLifecycleEvent(run.runRoot, {
    runId: run.runId,
    nodePath: 'main/worker',
    nodeType: 'orpad.workerLoop',
    status: 'started',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    timestamp: '2026-04-30T00:00:00.000Z',
    actor: 'machine',
    nodePath: 'main/worker',
    eventType: 'adapter.requested',
    payload: {
      adapter: 'cli-agent-overlay',
      adapterCallId: 'unresolved-worker-call',
      attemptId: 'unresolved-worker-attempt-1',
      idempotencyKey: 'unresolved-worker-call:unresolved-worker-attempt-1',
      taskKind: 'workerLoop',
      workspaceMode: 'read-only-plus-overlay',
      inputArtifacts: ['queue/claimed/unresolved-worker-item.json'],
      outputContract: 'orpad.workerResult.v1',
      adapterResultPath: 'adapters/unresolved-worker-call.result.json',
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_BYPASS_UNRESOLVED_ADAPTER_REQUEST'), true);
});

test('audit-orpad-machine-run flags generated validation artifact false write-set blocks', async () => {
  const run = await makeAuditableRun();
  const worker = await appendStartedWorkerRequest(run, {
    adapterCallId: 'generated-artifact-false-block-call',
  });
  const patchArtifact = 'artifacts/patches/generated-artifact-false-block.patch.json';
  await registerPatchArtifactFixture(run, patchArtifact, patchArtifactFixture({
    violations: [{
      path: 'OrPad/test-results/.last-run.json',
      reason: 'outside-write-set',
    }],
  }));
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: worker.nodePath,
    eventType: 'worker.result',
    itemId: 'graph-editor-graph-specific-node-types',
    artifactRefs: [patchArtifact],
    payload: {
      claimId: 'claim-generated-artifact-false-block',
      adapterCallId: worker.adapterCallId,
      attemptId: worker.attemptId,
      idempotencyKey: worker.idempotencyKey,
      attempt: worker.attempt,
      status: 'blocked',
      toState: 'blocked',
      patchArtifact,
      verification: [{
        command: 'npx playwright test',
        status: 'passed',
        writeSetViolationCount: 1,
      }],
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_WORKER_GENERATED_ARTIFACT_FALSE_BLOCK'), true);
  assert.equal(codes.has('MACHINE_WORKER_WRITE_SET_VERIFICATION_MISMATCH'), true);
});

test('audit-orpad-machine-run accepts ignored generated validation artifacts in worker patch verification', async () => {
  const run = await makeAuditableRun();
  const worker = await appendStartedWorkerRequest(run, {
    adapterCallId: 'ignored-generated-artifact-call',
  });
  const patchArtifact = 'artifacts/patches/ignored-generated-artifact.patch.json';
  await registerPatchArtifactFixture(run, patchArtifact, patchArtifactFixture({
    ignoredGeneratedFiles: [{
      path: 'OrPad/test-results/.last-run.json',
      reason: 'overlay-generated-validation-artifact',
    }],
  }));
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: worker.nodePath,
    eventType: 'worker.result',
    itemId: 'graph-editor-graph-specific-node-types',
    artifactRefs: [patchArtifact],
    payload: {
      claimId: 'claim-ignored-generated-artifact',
      adapterCallId: worker.adapterCallId,
      attemptId: worker.attemptId,
      idempotencyKey: worker.idempotencyKey,
      attempt: worker.attempt,
      status: 'done',
      toState: 'done',
      patchArtifact,
      verification: [{
        command: 'npx playwright test',
        status: 'passed',
        writeSetViolationCount: 0,
        ignoredGeneratedFileCount: 1,
      }],
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(result.json.ok, true);
});

test('audit-orpad-machine-run fails when a fatal patch write-set violation is reported done', async () => {
  const run = await makeAuditableRun();
  const worker = await appendStartedWorkerRequest(run, {
    adapterCallId: 'fatal-write-set-reported-done-call',
  });
  const patchArtifact = 'artifacts/patches/fatal-write-set-reported-done.patch.json';
  await registerPatchArtifactFixture(run, patchArtifact, patchArtifactFixture({
    violations: [{
      path: 'OrPad/src/outside-write-set.js',
      reason: 'outside-write-set',
    }],
  }));
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: worker.nodePath,
    eventType: 'worker.result',
    itemId: 'graph-editor-graph-specific-node-types',
    artifactRefs: [patchArtifact],
    payload: {
      claimId: 'claim-fatal-write-set-reported-done',
      adapterCallId: worker.adapterCallId,
      attemptId: worker.attemptId,
      idempotencyKey: worker.idempotencyKey,
      attempt: worker.attempt,
      status: 'done',
      toState: 'done',
      patchArtifact,
      verification: [{
        command: 'npx playwright test',
        status: 'passed',
        writeSetViolationCount: 1,
      }],
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_WORKER_FATAL_WRITE_SET_NOT_BLOCKED'), true);
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

test('audit-orpad-machine-run matches queue done transitions to the latest worker result claim', async () => {
  const run = await makeAuditableRun();
  const itemId = 'graph-editor-graph-specific-node-types';
  const staleClaimId = 'claim-stale-worker-result';
  const freshClaimId = 'claim-fresh-worker-result';
  await registerArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: 'artifacts/patches/stale-worker-result.patch.json',
    content: '{"schemaVersion":"orpad.patchArtifact.v1","changes":[]}\n',
    producedBy: 'worker-fixture',
    registeredBy: 'machine',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'adapter.requested',
    payload: {
      adapter: 'worker-fixture',
      adapterCallId: 'stale-worker-call',
      attemptId: 'stale-worker-attempt-1',
      idempotencyKey: 'stale-worker-call:stale-worker-attempt-1',
      taskKind: 'workerLoop',
      workspaceMode: 'read-only-plus-overlay',
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId,
    artifactRefs: ['artifacts/patches/stale-worker-result.patch.json'],
    payload: {
      claimId: staleClaimId,
      adapterCallId: 'stale-worker-call',
      attemptId: 'stale-worker-attempt-1',
      idempotencyKey: 'stale-worker-call:stale-worker-attempt-1',
      status: 'done',
      toState: 'done',
      patchArtifact: 'artifacts/patches/stale-worker-result.patch.json',
      verification: [{ command: 'fixture', ok: true }],
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'claim.lease-created',
    itemId,
    reason: 'dispatcher.claim-lease',
    payload: {
      claimId: freshClaimId,
      workerId: 'worker-audit',
      leaseMs: 300000,
      expiresAt: '2026-04-30T00:05:00.000Z',
    },
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId,
    toState: 'claimed',
    transitionId: `claim:${itemId}:${freshClaimId}`,
    payload: {
      claimId: freshClaimId,
      workerId: 'worker-audit',
    },
  });
  await registerArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: 'artifacts/patches/fresh-worker-result.patch.json',
    content: '{"schemaVersion":"orpad.patchArtifact.v1","changes":[]}\n',
    producedBy: 'worker-fixture',
    registeredBy: 'machine',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'adapter.requested',
    payload: {
      adapter: 'worker-fixture',
      adapterCallId: 'fresh-worker-call',
      attemptId: 'fresh-worker-attempt-1',
      idempotencyKey: 'fresh-worker-call:fresh-worker-attempt-1',
      taskKind: 'workerLoop',
      workspaceMode: 'read-only-plus-overlay',
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId,
    artifactRefs: ['artifacts/patches/fresh-worker-result.patch.json'],
    payload: {
      claimId: freshClaimId,
      adapterCallId: 'fresh-worker-call',
      attemptId: 'fresh-worker-attempt-1',
      idempotencyKey: 'fresh-worker-call:fresh-worker-attempt-1',
      status: 'done',
      toState: 'done',
      patchArtifact: 'artifacts/patches/fresh-worker-result.patch.json',
      verification: [{ command: 'fixture', ok: true }],
    },
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId,
    toState: 'done',
    transitionId: `close:${freshClaimId}:fresh-worker-call`,
    payload: {
      claimId: freshClaimId,
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'claim.lease-released',
    itemId,
    reason: 'worker-result.done',
    payload: {
      claimId: freshClaimId,
      state: 'released',
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(codes.has('MACHINE_QUEUE_DONE_WORKER_CLAIM_MISMATCH'), false);
});

test('audit-orpad-machine-run fails when claim lease has no prior write-set acquisition', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-audit-lease-write-set-'));
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
    runId: 'run_20260430_audit_lease_without_write_set',
    now: fixedNow,
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'claim.lease-created',
    itemId: 'graph-editor-graph-specific-node-types',
    reason: 'dispatcher.claim-lease',
    payload: {
      claimId: 'claim-without-write-set',
      workerId: 'worker-audit',
      leaseMs: 300000,
      expiresAt: '2026-04-30T00:05:00.000Z',
      writeSetLockId: 'missing-write-set-lock',
      writeSetPaths: ['src/renderer/renderer.js'],
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_CLAIM_LEASE_WITHOUT_WRITE_SET'), true);
});

test('audit-orpad-machine-run fails when closed claim leaves lease and write-set unreleased', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-audit-close-release-'));
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
    runId: 'run_20260430_audit_close_without_release',
    now: fixedNow,
  });
  const claimId = 'claim-without-release';
  const writeSetLockId = 'write-set-without-release';
  await ingestCandidateProposal(run.runRoot, proposal(), {
    runId: run.runId,
    transitionId: 'ingest:close-without-release',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: 'graph-editor-graph-specific-node-types',
    toState: 'queued',
    transitionId: 'triage:close-without-release',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'write-set.acquired',
    itemId: 'graph-editor-graph-specific-node-types',
    reason: 'dispatcher.write-set-lock',
    payload: {
      lockId: writeSetLockId,
      claimId,
      paths: ['src/renderer/renderer.js'],
    },
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
      writeSetLockId,
      writeSetPaths: ['src/renderer/renderer.js'],
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
      writeSetLockId,
    },
  });
  await registerArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: 'artifacts/patches/close-without-release.patch.json',
    content: '{"schemaVersion":"orpad.patchArtifact.v1","changes":[]}\n',
    producedBy: 'worker-fixture',
    registeredBy: 'machine',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/worker',
    eventType: 'adapter.requested',
    payload: {
      adapter: 'worker-fixture',
      adapterCallId: 'close-without-release-call',
      attemptId: 'close-without-release-attempt-1',
      idempotencyKey: 'close-without-release-call:close-without-release-attempt-1',
      taskKind: 'workerLoop',
      workspaceMode: 'read-only-plus-overlay',
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/worker',
    eventType: 'worker.result',
    itemId: 'graph-editor-graph-specific-node-types',
    artifactRefs: ['artifacts/patches/close-without-release.patch.json'],
    payload: {
      claimId,
      adapterCallId: 'close-without-release-call',
      attemptId: 'close-without-release-attempt-1',
      idempotencyKey: 'close-without-release-call:close-without-release-attempt-1',
      status: 'done',
      toState: 'done',
      patchArtifact: 'artifacts/patches/close-without-release.patch.json',
      verification: [{ command: 'fixture', ok: true }],
    },
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: 'graph-editor-graph-specific-node-types',
    toState: 'done',
    transitionId: `close:${claimId}:close-without-release-call`,
    payload: {
      claimId,
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_QUEUE_CLOSE_WITHOUT_CLAIM_RELEASE'), true);
  assert.equal(codes.has('MACHINE_QUEUE_CLOSE_WITHOUT_WRITE_SET_RELEASE'), true);
  assert.equal(codes.has('MACHINE_QUEUE_DONE_WITHOUT_WORKER_RESULT'), false);
});

test('audit-orpad-machine-run fails when terminal run status leaves active queue inventory', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-audit-terminal-active-'));
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
    runId: 'run_20260430_audit_done_with_active_queue',
    now: fixedNow,
  });
  await ingestCandidateProposal(run.runRoot, proposal(), {
    runId: run.runId,
    transitionId: 'ingest:done-with-active-queue',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: 'graph-editor-graph-specific-node-types',
    toState: 'queued',
    transitionId: 'triage:done-with-active-queue',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'run.status',
    fromState: 'running',
    toState: 'completed',
    reason: 'test.invalid-completed',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'run.summary',
    reason: 'test.invalid-done',
    payload: {
      summaryStatus: 'done',
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_RUN_DONE_ACTIVE_QUEUE'), true);
  assert.equal(codes.has('MACHINE_RUN_COMPLETED_ACTIVE_QUEUE'), true);
});

test('audit-orpad-machine-run fails when completed lifecycle lacks done summary', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-audit-completed-summary-'));
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
    runId: 'run_20260430_audit_completed_without_done',
    now: fixedNow,
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'run.status',
    fromState: 'running',
    toState: 'completed',
    reason: 'test.invalid-completed',
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_RUN_COMPLETED_WITHOUT_DONE_SUMMARY'), true);
});

test('audit-orpad-machine-run fails when run inventory snapshot diverges from queue replay', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-audit-inventory-snapshot-'));
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
    runId: 'run_20260430_audit_inventory_snapshot',
    now: fixedNow,
  });
  await ingestCandidateProposal(run.runRoot, proposal(), {
    runId: run.runId,
    transitionId: 'ingest:inventory-snapshot',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: 'graph-editor-graph-specific-node-types',
    toState: 'queued',
    transitionId: 'triage:inventory-snapshot',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'run.summary',
    reason: 'test.invalid-inventory-snapshot',
    payload: {
      summaryStatus: 'partial',
      inventory: {
        counts: { done: 1 },
        activeCount: 0,
        terminalCount: 1,
        blockedCount: 0,
        doneCount: 1,
      },
    },
  });
  await repairRunStateFromEvents(run.runRoot);

  const result = runAudit(run.runRoot);
  const codes = new Set(result.json.diagnostics.map(item => item.code));

  assert.equal(result.exitCode, 1);
  assert.equal(codes.has('MACHINE_RUN_INVENTORY_SNAPSHOT_MISMATCH'), true);
});
