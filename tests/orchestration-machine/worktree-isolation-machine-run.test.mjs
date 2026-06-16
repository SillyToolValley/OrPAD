import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { writeMachineSmokeWorkspace } from '../../scripts/smoke-orpad-machine-run.mjs';

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
  createMachineRun,
  executeMachineRunStep,
  findQueueItem,
} = require(path.join(repoRoot, 'src/main/orchestration-machine'));

// Item 1 (opt-in git-worktree isolation). The default smoke graph, but the
// worker node declares config.isolation: 'git-worktree' so the worker runs in a
// real `git worktree add` checkout (full repo) instead of the write-set-sliced
// overlay. The deterministic node-cli fixture still drives it (no LLM/CLI/git
// agent), proving the backend is wired through the real Machine.
function worktreeGraph() {
  return {
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'machine-smoke-workstream',
      nodes: [
        { id: 'context', type: 'orpad.context', label: 'Context', config: { summary: 'Prepare smoke context.' } },
        { id: 'probe', type: 'orpad.probe', label: 'Probe', config: { queueRef: 'queue', lens: 'smoke' } },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', label: 'Triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Worker', config: { queueRef: 'queue', adapter: 'cli-agent-overlay', isolation: 'git-worktree' } },
        { id: 'artifact', type: 'orpad.artifactContract', label: 'Evidence Contract', config: { manifest: 'harness/generated/latest-run/run-metadata.json' } },
      ],
      transitions: [
        { from: 'context', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'artifact' },
      ],
    },
  };
}

async function gitInitAndCommit(workspaceRoot) {
  const git = (args) => execFileP('git', args, { cwd: workspaceRoot, windowsHide: true });
  await git(['init']);
  await git(['add', '-A']);
  await git([
    '-c', 'user.email=orpad@test.local',
    '-c', 'user.name=OrPAD Test',
    '-c', 'commit.gpgsign=false',
    'commit', '-m', 'init smoke workspace',
  ]);
}

async function readAdapterTranscript(runRoot) {
  const adaptersDir = path.join(runRoot, 'artifacts', 'adapters');
  const entries = await fs.readdir(adaptersDir).catch(() => []);
  const transcriptName = entries.find(name => name.endsWith('.transcript.json'));
  if (!transcriptName) return null;
  return JSON.parse(await fs.readFile(path.join(adaptersDir, transcriptName), 'utf8'));
}

test('git-worktree isolation: worker runs in a real worktree and patches only its write-set', async () => {
  const ws = await writeMachineSmokeWorkspace({
    graph: worktreeGraph(),
    marker: 'after from git-worktree isolation backend',
  });
  try {
    await gitInitAndCommit(ws.workspaceRoot);

    const run = await createMachineRun({ workspaceRoot: ws.workspaceRoot, pipelinePath: ws.pipelinePath });
    const executed = await executeMachineRunStep({
      workspaceRoot: ws.workspaceRoot,
      pipelinePath: ws.pipelinePath,
      pipelineDir: ws.pipelineDir,
      runRoot: run.runRoot,
      runId: run.runId,
      nodeExecutable: process.execPath,
      timeoutMs: 60_000,
      overlayRootMode: 'run-root',
    });

    const workerEvent = executed.worker?.result?.event;
    assert.equal(workerEvent?.payload?.status, 'done', 'worker reaches done on the git-worktree backend');

    // The patch artifact captured exactly the write-set change, with no violations.
    const patchArtifact = workerEvent?.payload?.patchArtifact || '';
    assert.ok(patchArtifact, 'a patch artifact was produced');
    const patch = JSON.parse(await fs.readFile(path.join(run.runRoot, ...patchArtifact.split('/')), 'utf8'));
    const changed = (patch.changes || []).map(c => c.path);
    assert.deepEqual(changed, ['src/smoke-target.md'], 'only the declared write-set file changed');
    assert.equal((patch.violations || []).length, 0, 'no out-of-write-set violations');
    assert.equal(
      (patch.changes[0].afterContent || '').replace(/\r\n/g, '\n'),
      'after from git-worktree isolation backend\n',
      'the worker edit is captured against the canonical baseline',
    );

    // Proof the worktree backend was actually used (not the overlay fallback).
    const transcript = await readAdapterTranscript(run.runRoot);
    assert.equal(transcript?.overlay?.isolationStrategy, 'git-worktree', 'transcript records the git-worktree backend');
    assert.equal(transcript?.overlay?.overlayRootMode, 'git-worktree', 'overlay root mode is git-worktree');
    assert.ok(
      String(transcript?.overlay?.overlayRoot || '').replace(/\\/g, '/').includes('orpad-machine-worktree-'),
      'the worker ran inside an isolated orpad-machine-worktree-* checkout',
    );

    // Least privilege: the canonical workspace file is untouched (patch stays staged in the run).
    const canonical = await fs.readFile(path.join(ws.workspaceRoot, 'src', 'smoke-target.md'), 'utf8');
    assert.equal(canonical, 'before from OrPAD Machine smoke workspace\n', 'canonical workspace is unchanged');

    const queueItem = await findQueueItem(run.runRoot, 'machine-smoke-target');
    assert.equal(queueItem?.state, 'done', 'the queued item drained to done');

    // The temporary worktree is cleaned up after the worker finishes.
    const worktreeRoot = transcript?.overlay?.overlayRoot || '';
    if (worktreeRoot) {
      const stillThere = await fs.stat(worktreeRoot).then(() => true).catch(() => false);
      assert.equal(stillThere, false, 'the worktree checkout is removed after the run');
    }
  } finally {
    await fs.rm(ws.workspaceRoot, { recursive: true, force: true });
  }
});

test('git-worktree isolation degrades to the overlay backend on a non-git workspace', async () => {
  const ws = await writeMachineSmokeWorkspace({
    graph: worktreeGraph(),
    marker: 'after from worktree fallback to overlay',
  });
  try {
    // No git init — the workspace is not a repo, so worktree creation must fall back.
    const run = await createMachineRun({ workspaceRoot: ws.workspaceRoot, pipelinePath: ws.pipelinePath });
    const executed = await executeMachineRunStep({
      workspaceRoot: ws.workspaceRoot,
      pipelinePath: ws.pipelinePath,
      pipelineDir: ws.pipelineDir,
      runRoot: run.runRoot,
      runId: run.runId,
      nodeExecutable: process.execPath,
      timeoutMs: 60_000,
      overlayRootMode: 'run-root',
    });

    const workerEvent = executed.worker?.result?.event;
    assert.equal(workerEvent?.payload?.status, 'done', 'worker still reaches done via the overlay fallback');

    const transcript = await readAdapterTranscript(run.runRoot);
    assert.equal(transcript?.overlay?.isolationStrategy, 'overlay', 'fell back to the overlay backend');
    assert.equal(transcript?.overlay?.isolation?.requestedStrategy, 'git-worktree', 'records that worktree was requested');
    assert.equal(transcript?.overlay?.isolation?.fallbackReason, 'not-a-git-repo', 'records why it fell back');

    const canonical = await fs.readFile(path.join(ws.workspaceRoot, 'src', 'smoke-target.md'), 'utf8');
    assert.equal(canonical, 'before from OrPAD Machine smoke workspace\n', 'canonical workspace is unchanged');
  } finally {
    await fs.rm(ws.workspaceRoot, { recursive: true, force: true });
  }
});
