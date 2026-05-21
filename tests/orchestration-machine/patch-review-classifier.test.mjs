import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  PATCH_REVIEW_REASONS,
  createMachineRun,
  loadRunPatchArtifact,
  patchReviewStateFromEvents,
  registerPatchArtifact,
  shouldRequestPatchReview,
} = require('../../src/main/orchestration-machine');

async function makeRun(runId) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-patch-review-classifier-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/patch-review-classifier');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'patch-review-classifier',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: { nodes: [{ id: 'entry', type: 'orpad.entry' }], transitions: [] },
  }, null, 2), 'utf8');
  const run = await createMachineRun({ workspaceRoot, pipelinePath, runId });
  return { workspaceRoot, run };
}

test('shouldRequestPatchReview stays silent for targetFiles-contained routine patches', () => {
  const result = shouldRequestPatchReview({
    eventType: 'worker.result',
    payload: {
      changedFiles: ['src/feature.js'],
      declaredTargetFiles: ['src/feature.js'],
    },
  });
  assert.equal(result.requestReview, false);
  assert.deepEqual(result.reasons, []);
});

test('shouldRequestPatchReview accepts claim writeSet fallback when node targetFiles are absent', () => {
  const result = shouldRequestPatchReview({
    eventType: 'worker.result',
    payload: {
      changedFiles: ['src/feature.js'],
      declaredTargetFiles: [],
      lockTargetFiles: ['src/feature.js'],
      targetFilesSource: 'claim-writeset',
    },
  });
  assert.equal(result.requestReview, false);
  assert.deepEqual(result.declaredTargetFiles, ['src/feature.js']);
});

test('shouldRequestPatchReview keeps node targetFiles authoritative over union lock scope', () => {
  const result = shouldRequestPatchReview({
    eventType: 'worker.result',
    payload: {
      changedFiles: ['src/claim-only.js'],
      declaredTargetFiles: ['src/node-target.js'],
      lockTargetFiles: ['src/claim-only.js', 'src/node-target.js'],
      targetFilesSource: 'union',
    },
  });
  assert.equal(result.requestReview, true);
  assert.equal(result.reason, PATCH_REVIEW_REASONS.destructiveScope);
  assert.deepEqual(result.outsideTargetFiles, ['src/claim-only.js']);
});

test('shouldRequestPatchReview flags destructive_scope outside declared targetFiles', () => {
  const result = shouldRequestPatchReview({
    eventType: 'worker.result',
    payload: {
      changedFiles: ['src/feature.js', 'src/unplanned.js'],
      declaredTargetFiles: ['src/feature.js'],
    },
  });
  assert.equal(result.requestReview, true);
  assert.equal(result.reason, PATCH_REVIEW_REASONS.destructiveScope);
  assert.deepEqual(result.outsideTargetFiles, ['src/unplanned.js']);
});

test('shouldRequestPatchReview flags base_mismatch from apply conflict decisions', () => {
  const result = shouldRequestPatchReview({
    eventType: 'worker.result',
    payload: {
      changedFiles: ['src/feature.js'],
      declaredTargetFiles: ['src/feature.js'],
    },
  }, {
    decision: {
      eventType: 'patch.apply_conflict',
      code: 'PATCH_BASE_MISMATCH',
    },
  });
  assert.equal(result.requestReview, true);
  assert.equal(result.reason, PATCH_REVIEW_REASONS.baseMismatch);
});

test('shouldRequestPatchReview honors explicit_review_required on the worker result', () => {
  const result = shouldRequestPatchReview({
    eventType: 'worker.result',
    payload: {
      changedFiles: ['src/feature.js'],
      declaredTargetFiles: ['src/feature.js'],
      reviewRequired: true,
    },
  });
  assert.equal(result.requestReview, true);
  assert.equal(result.reason, PATCH_REVIEW_REASONS.explicitReviewRequired);
});

test('shouldRequestPatchReview escalates generic apply failures as destructive_scope', () => {
  const result = shouldRequestPatchReview({
    eventType: 'worker.result',
    payload: {
      changedFiles: ['src/feature.js'],
      declaredTargetFiles: ['src/feature.js'],
    },
  }, {
    decision: {
      eventType: 'patch.apply_failed',
      code: 'MACHINE_PATCH_LOAD_FAILED',
    },
  });
  assert.equal(result.requestReview, true);
  assert.equal(result.reason, PATCH_REVIEW_REASONS.destructiveScope);
});

test('patchReviewStateFromEvents blocks patch artifacts that omit changedFiles', () => {
  const state = patchReviewStateFromEvents([{
    eventType: 'worker.result',
    sequence: 1,
    payload: {
      patchArtifact: 'artifacts/patches/no-changes.patch.json',
      changedFiles: [],
    },
  }]);
  assert.equal(state.required, true);
  assert.equal(state.pendingCount, 1);
  assert.equal(state.pending[0].reviewReason, PATCH_REVIEW_REASONS.destructiveScope);
});

test('patchReviewStateFromEvents ignores patch artifacts from blocked workers', () => {
  const state = patchReviewStateFromEvents([{
    eventType: 'worker.result',
    sequence: 1,
    payload: {
      status: 'blocked',
      toState: 'blocked',
      patchArtifact: 'artifacts/patches/partial-blocked.patch.json',
      changedFiles: ['src/partial.md'],
    },
  }]);
  assert.equal(state.patchCount, 0);
  assert.equal(state.required, false);
  assert.equal(state.autoApplyPendingCount, 0);
});

test('loadRunPatchArtifact rejects tampered registered patch artifacts before auto-apply', async (t) => {
  const { workspaceRoot, run } = await makeRun('run_patch_review_classifier_integrity');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));

  const patch = {
    schemaVersion: 'orpad.patchArtifact.v1',
    createdAt: new Date('2026-05-17T00:00:00.000Z').toISOString(),
    allowedFiles: ['src/target.md'],
    changes: [],
    violations: [],
  };
  const registered = await registerPatchArtifact(run.runRoot, {
    runId: run.runId,
    patch,
    artifactPath: 'artifacts/patches/tamper.patch.json',
    producedBy: 'test.patch-review-classifier',
  });
  await fs.writeFile(
    path.join(run.runRoot, ...registered.file.path.split('/')),
    `${JSON.stringify({ ...patch, changes: [{ path: 'src/target.md' }] }, null, 2)}\n`,
    'utf8',
  );

  await assert.rejects(
    loadRunPatchArtifact(run.runRoot, registered.file.path),
    error => error?.code === 'MACHINE_ARTIFACT_INTEGRITY_FAILED',
  );
});

test('loadRunPatchArtifact rejects unregistered run-relative patch files', async (t) => {
  const { workspaceRoot, run } = await makeRun('run_patch_review_classifier_unregistered');
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));

  const unregisteredPath = path.join(run.runRoot, 'artifacts', 'patches', 'unregistered.patch.json');
  await fs.mkdir(path.dirname(unregisteredPath), { recursive: true });
  await fs.writeFile(unregisteredPath, JSON.stringify({
    schemaVersion: 'orpad.patchArtifact.v1',
    createdAt: new Date('2026-05-17T00:00:00.000Z').toISOString(),
    allowedFiles: ['src/target.md'],
    changes: [],
    violations: [],
  }, null, 2), 'utf8');

  await assert.rejects(
    loadRunPatchArtifact(run.runRoot, 'artifacts/patches/unregistered.patch.json'),
    error => error?.code === 'MACHINE_PATCH_ARTIFACT_UNREGISTERED',
  );
});
