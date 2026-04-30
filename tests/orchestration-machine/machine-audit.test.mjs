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
  createMachineRun,
  exportLatestRun,
  ingestCandidateProposal,
  repairRunStateFromEvents,
  registerArtifact,
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
  assert.equal(result.json.eventCount, 4);
  assert.equal(result.json.artifactCount, 1);
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
