import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const fixtureRoot = path.join(repoRoot, 'tests/fixtures/orchestration-machine/maintenance-workstream');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function readFixtureJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, fileName), 'utf8'));
}

function graphNodes(graphDoc) {
  if (Array.isArray(graphDoc?.nodes)) return graphDoc.nodes;
  if (Array.isArray(graphDoc?.graph?.nodes)) return graphDoc.graph.nodes;
  return [];
}

function countNodeTypes(graphPaths) {
  const counts = {};
  let totalNodeCount = 0;
  for (const graphPath of graphPaths) {
    const graphDoc = readJson(`.orpad/pipelines/orpad-maintenance-quality-workstream-20260429/${graphPath}`);
    for (const node of graphNodes(graphDoc)) {
      totalNodeCount += 1;
      counts[node.type] = (counts[node.type] || 0) + 1;
    }
  }
  return { totalNodeCount, nodeTypeCounts: Object.fromEntries(Object.entries(counts).sort()) };
}

test('Machine PR 0 uses the Node built-in test harness without new dependencies', () => {
  const packageJson = readJson('package.json');

  assert.equal(
    packageJson.scripts['test:machine'],
    'node --test tests/orchestration-machine/*.test.mjs',
  );
});

test('maintenance workstream fixture tracks source shape without generated run output', () => {
  const manifest = readFixtureJson('fixture-manifest.json');
  const pipeline = readJson(manifest.sourcePipeline);

  assert.equal(manifest.schemaVersion, 'orpad.machineFixtureBaseline.v1');
  assert.equal(pipeline.kind, manifest.pipelineKind);
  assert.equal(pipeline.version, manifest.pipelineVersion);
  assert.equal(pipeline.id, manifest.pipelineId);
  assert.equal(pipeline.entryGraph, manifest.entryGraph);

  const nodePackIds = pipeline.nodePacks.map(pack => pack.id).sort();
  assert.deepEqual(nodePackIds, [...manifest.nodePacks].sort());

  for (const sourcePath of manifest.trackedSourcePaths) {
    assert.equal(fs.existsSync(path.join(repoRoot, sourcePath)), true, `${sourcePath} should exist`);
    assert.equal(sourcePath.includes('harness/generated'), false, `${sourcePath} must not be generated evidence`);
    assert.equal(sourcePath.includes('/runs/') || sourcePath.includes('\\runs\\'), false, `${sourcePath} must not be a run output`);
  }

  assert.equal(manifest.generatedEvidencePolicy.copiedIntoFixture, false);
  assert.deepEqual(manifest.generatedEvidencePolicy.ignoredPatterns, [
    '.orpad/**/runs/',
    '.orpad/**/harness/generated/**',
  ]);

  const actualGraphSummary = countNodeTypes(manifest.sourceGraphs);
  assert.equal(manifest.graphSummary.graphCount, manifest.sourceGraphs.length);
  assert.equal(manifest.graphSummary.totalNodeCount, actualGraphSummary.totalNodeCount);
  assert.deepEqual(manifest.graphSummary.nodeTypeCounts, actualGraphSummary.nodeTypeCounts);
});

test('current audit snapshot records the expected pre-Machine baseline', () => {
  const snapshot = readFixtureJson('current-audit-snapshot.json');
  const diagnostics = new Set(snapshot.commands.runAudit.representativeDiagnosticCodes);

  assert.equal(snapshot.schemaVersion, 'orpad.machineAuditSnapshot.v1');
  assert.equal(snapshot.commands.queueAudit.expectedExitCode, 0);
  assert.equal(snapshot.commands.queueAudit.expectedOk, true);
  assert.equal(snapshot.commands.queueAudit.summary.journalActions.ingest, 1);
  assert.equal(snapshot.commands.queueAudit.summary.journalActions.close, 1);
  assert.equal(snapshot.commands.runAudit.expectedExitCode, 1);
  assert.equal(snapshot.commands.runAudit.expectedOk, false);
  assert.equal(snapshot.commands.runAudit.queueAuditOk, true);
  assert.equal(snapshot.commands.runAudit.nodeSchemaAuditOk, true);

  for (const code of [
    'RUN_METADATA_HEAD_STALE',
    'RUN_METADATA_WORKTREE_STALE',
    'RUN_METADATA_ARTIFACT_MANIFEST_HASH_MISMATCH',
    'CANDIDATE_INVENTORY_EMPTY_PASS_REASON_WEAK',
  ]) {
    assert.equal(diagnostics.has(code), true, `${code} should stay documented in the baseline snapshot`);
  }

  assert.equal(snapshot.commands.runAudit.inventorySummary.totalItems, 36);
  assert.equal(snapshot.commands.runAudit.inventorySummary.statuses['empty-pass'], 34);
});
