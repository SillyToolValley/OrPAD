import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { writeMachineSmokeWorkspace } from '../../scripts/smoke-orpad-machine-run.mjs';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { createMachineRun, executeMachineRunStep } = require(path.join(repoRoot, 'src/main/orchestration-machine'));

// Default smoke graph + an orpad.pullRequest support node after the evidence
// contract, proving the new node type is recognized, dispatched, and executed
// by the real Machine.
function graphWithPullRequest() {
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
        { id: 'worker', type: 'orpad.workerLoop', label: 'Worker', config: { queueRef: 'queue', adapter: 'cli-agent-overlay' } },
        { id: 'artifact', type: 'orpad.artifactContract', label: 'Evidence Contract', config: { manifest: 'harness/generated/latest-run/run-metadata.json' } },
        { id: 'pullrequest', type: 'orpad.pullRequest', label: 'Pull Request', config: { title: 'OrPAD smoke PR', requireChecks: false } },
      ],
      transitions: [
        { from: 'context', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'artifact' },
        { from: 'artifact', to: 'pullrequest' },
      ],
    },
  };
}

function successGitGhRunner() {
  return async ({ command, args }) => {
    if (command === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: 'true', stderr: '' };
    if (command === 'git' && args[0] === 'status') return { code: 0, stdout: ' M src/smoke-target.md\n', stderr: '' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
      return { code: 0, stdout: 'https://github.com/o/r/pull/42\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

function pullRequestEvent(events) {
  return [...events].reverse().find(e => (
    e.eventType === 'node.completed' && e.payload?.nodeType === 'orpad.pullRequest'
  ));
}

function pullRequestBlockedEvent(events) {
  return [...events].reverse().find(e => (
    e.eventType === 'node.blocked' && e.payload?.nodeType === 'orpad.pullRequest'
  ));
}

test('orpad.pullRequest executes in the Machine and opens a PR with an injected git/gh runner', async () => {
  const ws = await writeMachineSmokeWorkspace({ graph: graphWithPullRequest(), marker: 'after pull-request machine run' });
  try {
    const run = await createMachineRun({ workspaceRoot: ws.workspaceRoot, pipelinePath: ws.pipelinePath });
    const executed = await executeMachineRunStep({
      workspaceRoot: ws.workspaceRoot,
      pipelinePath: ws.pipelinePath,
      pipelineDir: ws.pipelineDir,
      runRoot: run.runRoot,
      runId: run.runId,
      nodeExecutable: process.execPath,
      timeoutMs: 60_000,
      pullRequestProcessRunner: successGitGhRunner(),
      pullRequestSleep: async () => {},
    });

    const prEvent = pullRequestEvent(executed.events);
    assert.ok(prEvent, 'the pullRequest node completed');
    assert.equal(prEvent.payload?.valid, true, 'the PR node reports success');
    assert.equal(prEvent.payload?.prUrl, 'https://github.com/o/r/pull/42', 'the PR url is captured');

    // Evidence artifact was registered under the run.
    const prArtifacts = await fs.readdir(path.join(run.runRoot, 'artifacts', 'pull-request')).catch(() => []);
    assert.ok(prArtifacts.length >= 1, 'a pull-request evidence artifact was written');
  } finally {
    await fs.rm(ws.workspaceRoot, { recursive: true, force: true });
  }
});

test('orpad.pullRequest blocks with a typed reason on a non-git workspace (real-git degrade)', async () => {
  const ws = await writeMachineSmokeWorkspace({ graph: graphWithPullRequest(), marker: 'after pull-request degrade' });
  try {
    const run = await createMachineRun({ workspaceRoot: ws.workspaceRoot, pipelinePath: ws.pipelinePath });
    const executed = await executeMachineRunStep({
      workspaceRoot: ws.workspaceRoot,
      pipelinePath: ws.pipelinePath,
      pipelineDir: ws.pipelineDir,
      runRoot: run.runRoot,
      runId: run.runId,
      nodeExecutable: process.execPath,
      timeoutMs: 60_000,
      // No injected runner: the PR node runs real git in a non-git workspace.
    });

    const blocked = pullRequestBlockedEvent(executed.events);
    assert.ok(blocked, 'the pullRequest node blocked');
    assert.equal(blocked.payload?.reason, 'pull-request.not-a-git-repo', 'typed not-a-git-repo block');
  } finally {
    await fs.rm(ws.workspaceRoot, { recursive: true, force: true });
  }
});
