import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  createMachineRun,
  exportLatestRun,
  exportLegacyJournal,
  ingestCandidateProposal,
  latestRunExportRoot,
  readArtifactManifest,
  registerArtifact,
  transitionQueueItem,
} = require('../../src/main/orchestration-machine');

const fixedNow = new Date('2026-04-30T00:00:00.000Z');

async function makeRun() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-artifacts-'));
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
    runId: 'run_20260430_artifacts',
    now: fixedNow,
  });
  return { ...run, pipelineDir };
}

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

test('artifact registry records producedBy and registeredBy provenance', async () => {
  const run = await makeRun();
  const result = await registerArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: 'artifacts/queue/triage-log.md',
    content: '# Triage log\n',
    producedBy: 'adapter:proposal-only',
    registeredBy: 'machine',
  });

  assert.equal(result.file.path, 'artifacts/queue/triage-log.md');
  assert.equal(result.file.producedBy, 'adapter:proposal-only');
  assert.equal(result.file.registeredBy, 'machine');
  assert.equal(result.file.size, Buffer.byteLength('# Triage log\n'));
  assert.equal(result.file.sha256.length, 64);

  const manifest = await readArtifactManifest(run.runRoot);
  assert.equal(manifest.schemaVersion, 'orpad.artifactManifest.v1');
  assert.equal(manifest.runId, run.runId);
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].path, result.file.path);
});

test('artifact registry rejects absolute or normalized parent paths before writing', async () => {
  const run = await makeRun();
  const unsafePaths = [
    '/tmp/outside.md',
    'C:/tmp/outside.md',
    'artifacts/queue/../outside.md',
    'artifacts/queue/..',
    'artifacts/./queue.md',
    'artifacts//queue.md',
  ];

  for (const artifactPath of unsafePaths) {
    await assert.rejects(
      registerArtifact(run.runRoot, {
        runId: run.runId,
        artifactPath,
        content: 'unsafe\n',
        producedBy: 'test',
      }),
      /Artifact path must be run-relative/,
    );
  }

  await assert.rejects(
    fs.stat(path.join(run.runRoot, 'outside.md')),
    error => error?.code === 'ENOENT',
  );
  await assert.rejects(
    readArtifactManifest(run.runRoot),
    error => error?.code === 'ENOENT',
  );
});

test('artifact registry rejects symlinked run artifact paths before writing', async t => {
  const run = await makeRun();
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-artifact-outside-'));
  const outsideFile = path.join(outsideRoot, 'outside.md');
  await fs.writeFile(outsideFile, 'outside-before\n', 'utf8');
  await fs.mkdir(path.join(run.runRoot, 'artifacts/queue'), { recursive: true });
  const linkPath = path.join(run.runRoot, 'artifacts/queue/link.md');
  if (!await createTestSymlink(t, outsideFile, linkPath, 'file')) return;

  await assert.rejects(
    registerArtifact(run.runRoot, {
      runId: run.runId,
      artifactPath: 'artifacts/queue/link.md',
      content: 'outside-after\n',
      producedBy: 'test',
    }),
    error => error?.code === 'MACHINE_ARTIFACT_SYMLINK_UNSAFE',
  );
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'outside-before\n');
  await assert.rejects(
    readArtifactManifest(run.runRoot),
    error => error?.code === 'ENOENT',
  );
});

test('legacy journal exporter projects Machine queue transition events', async () => {
  const run = await makeRun();
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
  const targetQueueRoot = path.join(run.pipelineDir, 'exported-queue');

  const records = await exportLegacyJournal(run.runRoot, targetQueueRoot);
  const journal = (await fs.readFile(path.join(targetQueueRoot, 'journal.jsonl'), 'utf8'))
    .trim()
    .split(/\r?\n/)
    .map(line => JSON.parse(line));

  assert.deepEqual(records.map(record => record.action), ['ingest', 'triage']);
  assert.deepEqual(journal.map(record => record.actor), ['orpad.workQueue', 'orpad.triage']);
});

test('evidence snapshot materializes provenance from durable run state', async () => {
  const run = await makeRun();
  await ingestCandidateProposal(run.runRoot, proposal(), {
    runId: run.runId,
    transitionId: 'ingest:item',
  });
  await registerArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: 'artifacts/queue/triage-log.md',
    content: '# Triage log\n',
    producedBy: 'adapter:proposal-only',
    registeredBy: 'machine',
  });

  const exported = await exportLatestRun({
    runRoot: run.runRoot,
    pipelineDir: run.pipelineDir,
    exportedAt: '2026-04-30T00:00:10.000Z',
  });
  const metadata = JSON.parse(await fs.readFile(path.join(exported.targetRoot, 'run-metadata.json'), 'utf8'));

  assert.equal(exported.targetRoot, latestRunExportRoot(run.pipelineDir));
  assert.equal(metadata.schemaVersion, 'orpad.machineLatestRunExport.v1');
  assert.equal(metadata.runId, run.runId);
  assert.equal(metadata.status, 'exported');
  assert.equal(metadata.artifactManifest.files.length, 1);
  assert.equal((await fs.stat(path.join(exported.targetRoot, 'artifacts/manifest.json'))).isFile(), true);
  assert.equal((await fs.stat(path.join(exported.targetRoot, 'queue/journal.jsonl'))).isFile(), true);
});

test('artifact registry refuses to continue after registered evidence changes', async () => {
  const run = await makeRun();
  await registerArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: 'artifacts/queue/triage-log.md',
    content: '# Triage log\n',
    producedBy: 'adapter:proposal-only',
    registeredBy: 'machine',
  });
  await fs.writeFile(path.join(run.runRoot, 'artifacts/queue/triage-log.md'), '# changed\n', 'utf8');

  await assert.rejects(
    registerArtifact(run.runRoot, {
      runId: run.runId,
      artifactPath: 'artifacts/queue/next.md',
      content: '# next\n',
      producedBy: 'adapter:proposal-only',
      registeredBy: 'machine',
    }),
    error => (
      error?.code === 'MACHINE_ARTIFACT_INTEGRITY_FAILED'
      && error.diagnostics?.some(item => item.code === 'MACHINE_ARTIFACT_HASH_MISMATCH')
      && error.diagnostics?.some(item => item.code === 'MACHINE_ARTIFACT_SIZE_MISMATCH')
    ),
  );
  await assert.rejects(
    fs.stat(path.join(run.runRoot, 'artifacts/queue/next.md')),
    error => error?.code === 'ENOENT',
  );
});

test('evidence snapshot refuses to export changed registered evidence', async () => {
  const run = await makeRun();
  await registerArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: 'artifacts/queue/triage-log.md',
    content: '# Triage log\n',
    producedBy: 'adapter:proposal-only',
    registeredBy: 'machine',
  });
  await fs.writeFile(path.join(run.runRoot, 'artifacts/queue/triage-log.md'), '# changed\n', 'utf8');

  await assert.rejects(
    exportLatestRun({
      runRoot: run.runRoot,
      pipelineDir: run.pipelineDir,
      exportedAt: '2026-04-30T00:00:10.000Z',
    }),
    error => error?.code === 'MACHINE_ARTIFACT_INTEGRITY_FAILED',
  );
  await assert.rejects(
    fs.stat(latestRunExportRoot(run.pipelineDir)),
    error => error?.code === 'ENOENT',
  );
});

test('evidence snapshot refuses to overwrite an existing export unless explicitly allowed', async () => {
  const run = await makeRun();
  const targetRoot = latestRunExportRoot(run.pipelineDir);
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.writeFile(path.join(targetRoot, 'trusted.txt'), 'keep me', 'utf8');

  await assert.rejects(
    exportLatestRun({ runRoot: run.runRoot, pipelineDir: run.pipelineDir }),
    error => error?.code === 'LATEST_RUN_EXPORT_EXISTS',
  );

  assert.equal(await fs.readFile(path.join(targetRoot, 'trusted.txt'), 'utf8'), 'keep me');
});

test('evidence snapshot rejects symlinked target path segments before writing', async t => {
  const run = await makeRun();
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-export-outside-'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  if (!await createTestSymlink(t, outsideRoot, path.join(run.pipelineDir, 'harness'), linkType)) return;

  await assert.rejects(
    exportLatestRun({
      runRoot: run.runRoot,
      pipelineDir: run.pipelineDir,
      allowOverwrite: true,
    }),
    error => error?.code === 'LATEST_RUN_EXPORT_SYMLINK_UNSAFE',
  );
  await assert.rejects(
    fs.stat(path.join(outsideRoot, 'generated/latest-run/run-metadata.json')),
    error => error?.code === 'ENOENT',
  );
});
