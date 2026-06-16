import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const machine = require(path.join(repoRoot, 'src/main/orchestration-machine'));
const {
  __test_applyRoutinePatchReviews: applyRoutinePatchReviews,
  createMachineRun,
  registerPatchArtifact,
  readMachineEvents,
  sha256Text,
} = machine;

function makePatch(file, beforeContent, afterContent, beforeShaOverride) {
  return {
    schemaVersion: 'orpad.patchArtifact.v1',
    createdAt: '2026-06-16T00:00:00.000Z',
    allowedFiles: [file],
    changes: [{
      path: file,
      beforeExists: beforeContent !== null,
      afterExists: afterContent !== null,
      beforeSha256: beforeShaOverride ?? (beforeContent === null ? '' : sha256Text(beforeContent)),
      afterSha256: afterContent === null ? '' : sha256Text(afterContent),
      beforeContent: beforeContent ?? '',
      afterContent: afterContent ?? '',
    }],
    violations: [],
    ignoredGeneratedFiles: [],
  };
}

function review(patchArtifact, file) {
  return {
    patchArtifact,
    changedFiles: [file],
    declaredTargetFiles: [file],
    lockTargetFiles: [file],
    reviewRequired: false,
    sourceEvent: {
      eventType: 'worker.result',
      payload: { patchArtifact, changedFiles: [file], declaredTargetFiles: [file], status: 'done' },
    },
  };
}

// Two auto-applyable patches: A applies cleanly to a.txt; B base-mismatches on
// b.txt (its recorded beforeSha does not match canonical) so applyPatchArtifact
// throws PATCH_BASE_MISMATCH.
async function setup() {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-rollback-'));
  await fs.writeFile(path.join(ws, 'a.txt'), 'A\n', 'utf8');
  await fs.writeFile(path.join(ws, 'b.txt'), 'B\n', 'utf8');
  const git = (args) => execFileP('git', args, { cwd: ws, windowsHide: true });
  await git(['init']);
  await git(['add', '-A']);
  await git(['-c', 'user.email=o@t.local', '-c', 'user.name=O', '-c', 'commit.gpgsign=false', 'commit', '-m', 'init']);

  const pipelineDir = path.join(ws, '.orpad', 'pipelines', 'rollback-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline', version: '1.0', id: 'rollback-pipeline', entryGraph: 'graphs/main.or-graph',
  }), 'utf8');

  const run = await createMachineRun({ workspaceRoot: ws, pipelinePath });
  const regA = await registerPatchArtifact(run.runRoot, {
    runId: run.runId, patch: makePatch('a.txt', 'A\n', 'A2\n'), artifactPath: 'artifacts/patches/a.patch.json',
  });
  const regB = await registerPatchArtifact(run.runRoot, {
    runId: run.runId,
    patch: makePatch('b.txt', 'WRONG\n', 'B2\n', sha256Text('WRONG\n')),
    artifactPath: 'artifacts/patches/b.patch.json',
  });
  return {
    ws,
    run,
    reviews: [
      review(regA?.file?.path || 'artifacts/patches/a.patch.json', 'a.txt'),
      review(regB?.file?.path || 'artifacts/patches/b.patch.json', 'b.txt'),
    ],
  };
}

test('rollbackOnFailure: a mid-batch apply failure reverts the whole batch atomically', async () => {
  const { ws, run, reviews } = await setup();
  try {
    const result = await applyRoutinePatchReviews(run.runRoot, {
      runId: run.runId,
      workspaceRoot: ws,
      reviews,
      rollbackOnFailure: 'git-checkpoint',
    });

    assert.equal(result.applied.length, 0, 'no patch remains applied after atomic rollback');
    assert.equal(result.rolledBack.length, 1, 'the cleanly-applied patch was rolled back');
    assert.ok(result.conflicts.length >= 1, 'the base-mismatch patch is a conflict');

    assert.equal(await fs.readFile(path.join(ws, 'a.txt'), 'utf8'), 'A\n', 'a.txt reverted to pre-batch content');
    assert.equal(await fs.readFile(path.join(ws, 'b.txt'), 'utf8'), 'B\n', 'b.txt unchanged');

    const events = await readMachineEvents(run.runRoot);
    const types = events.map(e => e.eventType);
    assert.ok(types.includes('patch.checkpoint_captured'), 'a checkpoint was captured');
    assert.ok(types.includes('patch.rolled_back'), 'a rollback was recorded');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('default (no rollbackOnFailure): an applied patch survives a sibling failure (behavior unchanged)', async () => {
  const { ws, run, reviews } = await setup();
  try {
    const result = await applyRoutinePatchReviews(run.runRoot, {
      runId: run.runId,
      workspaceRoot: ws,
      reviews,
    });

    assert.equal(result.applied.length, 1, 'the clean patch stays applied without rollback');
    assert.ok(result.conflicts.length >= 1, 'the base-mismatch patch is still a conflict');
    assert.equal(result.rolledBack?.length || 0, 0, 'nothing is rolled back');

    assert.equal(await fs.readFile(path.join(ws, 'a.txt'), 'utf8'), 'A2\n', 'a.txt remains applied (no rollback)');

    const events = await readMachineEvents(run.runRoot);
    assert.ok(!events.some(e => e.eventType === 'patch.rolled_back'), 'no rollback event in default mode');
    assert.ok(!events.some(e => e.eventType === 'patch.checkpoint_captured'), 'no checkpoint captured in default mode');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('rollbackOnFailure degrades cleanly on a non-git workspace', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-rollback-nogit-'));
  try {
    await fs.writeFile(path.join(ws, 'a.txt'), 'A\n', 'utf8');
    await fs.writeFile(path.join(ws, 'b.txt'), 'B\n', 'utf8');
    const pipelineDir = path.join(ws, '.orpad', 'pipelines', 'rollback-pipeline');
    await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
    const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
    await fs.writeFile(pipelinePath, JSON.stringify({
      kind: 'orpad.pipeline', version: '1.0', id: 'rollback-pipeline', entryGraph: 'graphs/main.or-graph',
    }), 'utf8');
    const run = await createMachineRun({ workspaceRoot: ws, pipelinePath });
    const regA = await registerPatchArtifact(run.runRoot, {
      runId: run.runId, patch: makePatch('a.txt', 'A\n', 'A2\n'), artifactPath: 'artifacts/patches/a.patch.json',
    });
    const regB = await registerPatchArtifact(run.runRoot, {
      runId: run.runId,
      patch: makePatch('b.txt', 'WRONG\n', 'B2\n', sha256Text('WRONG\n')),
      artifactPath: 'artifacts/patches/b.patch.json',
    });
    const result = await applyRoutinePatchReviews(run.runRoot, {
      runId: run.runId,
      workspaceRoot: ws,
      reviews: [
        review(regA?.file?.path || 'artifacts/patches/a.patch.json', 'a.txt'),
        review(regB?.file?.path || 'artifacts/patches/b.patch.json', 'b.txt'),
      ],
      rollbackOnFailure: 'git-checkpoint',
    });
    // No git → no atomic rollback → behaves like the default (a.txt stays applied).
    assert.equal(result.applied.length, 1, 'clean patch stays applied (no git, degraded)');
    assert.equal(await fs.readFile(path.join(ws, 'a.txt'), 'utf8'), 'A2\n', 'a.txt remains applied');
    const events = await readMachineEvents(run.runRoot);
    assert.ok(events.some(e => e.eventType === 'patch.rollback_unavailable'), 'records that rollback was unavailable');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});
