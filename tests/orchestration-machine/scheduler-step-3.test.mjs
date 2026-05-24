import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const {
  appendPatchReviewRejectedEvent,
  createMachineRun,
  executeMachineRunStep,
  readMachineEvents,
} = require(path.join(repoRoot, 'src/main/orchestration-machine'));

// Fork-Join Phase 3 Step 3: conditional pruning (3.A), barrier
// scheduler-side wait (3.B), and loop-back reset events (3.C).
//
// These tests use hand-authored harness pipelines to exercise the new
// scheduler paths without depending on a live LLM adapter. Each test
// asserts a specific Step 3 contract.

async function writePipeline(t, pipelineId, graphDoc, options = {}) {
  const {
    candidateProposals = null,
    machineHarness: machineHarnessOverrides = {},
    ...pipelineOverrides
  } = options;
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), `orpad-${pipelineId}-`));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const pipelineDir = path.join(workspaceRoot, `.orpad/pipelines/${pipelineId}`);
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify(graphDoc, null, 2), 'utf8');
  await fs.writeFile(path.join(workspaceRoot, 'target.md'), 'before\n', 'utf8');
  const pipelineDoc = {
    kind: 'orpad.pipeline',
    version: '1.0',
    id: pipelineId,
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
      machineHarness: {
        ...(candidateProposals
          ? { candidateProposals }
          : {
            candidateProposal: {
              schemaVersion: 'orpad.candidateProposal.v1',
              proposalId: `${pipelineId}-proposal`,
              suggestedWorkItemId: `${pipelineId}-item`,
              sourceNode: 'main/probe',
              title: 'Update target.md',
              fingerprint: `${pipelineId}:target.md`,
              evidence: [{ id: 'target-before', file: 'target.md' }],
              acceptanceCriteria: ['Patch artifact records the change.'],
              sourceOfTruthTargets: ['target.md'],
            },
          }),
        expectedChangedFiles: ['target.md'],
        nodeCliPatch: { file: 'target.md', content: 'Updated.\n' },
        ...machineHarnessOverrides,
      },
    },
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
    ...pipelineOverrides,
  };
  await fs.writeFile(pipelinePath, JSON.stringify(pipelineDoc, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId: `run_${pipelineId}_001`,
  });
  return { workspaceRoot, pipelineDir, pipelinePath, run };
}

// Step 3.A: a selector with two outgoing branches must prune the
// unselected one. Today's `validateSelectorNode` picks a value but
// does NOT prune; Step 3.A wires the Phase 2 evaluator into
// readiness propagation so the unselected branch never runs.
test('Step 3.A: selector prunes unselected branch — only the matching downstream completes', async (t) => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await writePipeline(t, 'selector-prune', {
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'selector-prune-main',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        // Selector picks 'fast' by default — only fast-branch should run.
        { id: 'route', type: 'orpad.selector', label: 'Pick route', config: { selector: 'mode', options: ['fast', 'thorough'], default: 'fast' } },
        { id: 'fast-branch', type: 'orpad.context', label: 'Fast branch' },
        { id: 'thorough-branch', type: 'orpad.context', label: 'Thorough branch (should not run)' },
        // Canonical rail still required for executeMachineRunStep to bind.
        { id: 'probe', type: 'orpad.probe', label: 'Probe' },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', label: 'Triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Worker', config: { queueRef: 'queue' } },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'route' },
        // Pattern: selector → branches with conditions matching options.
        { from: 'route', to: 'fast-branch', condition: 'fast' },
        { from: 'route', to: 'thorough-branch', condition: 'thorough' },
        { from: 'fast-branch', to: 'probe' },
        { from: 'thorough-branch', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'exit' },
      ],
    },
  });
  await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });
  const events = await readMachineEvents(run.runRoot);
  const completed = events
    .filter(event => event.eventType === 'node.completed')
    .map(event => event.nodePath);
  // Selector itself completes; fast-branch (selected) completes;
  // thorough-branch (unselected) MUST NOT complete — that's the prune.
  assert.ok(completed.includes('main/route'), 'selector should have completed');
  assert.ok(completed.includes('main/fast-branch'), 'fast-branch (selected) should have completed');
  assert.equal(
    completed.includes('main/thorough-branch'),
    false,
    'thorough-branch (unselected) MUST NOT complete — Step 3.A prunes it',
  );
  // The Phase 2 dry-run diagnostic should also show the prune.
  const edgeEval = events.find(event => (
    event.eventType === 'scheduler.edgeEvaluation' && event.nodePath === 'main/route'
  ));
  assert.ok(edgeEval, 'selector should emit a scheduler.edgeEvaluation diagnostic');
  const fast = edgeEval.payload.decisions.find(d => d.condition === 'fast');
  const thorough = edgeEval.payload.decisions.find(d => d.condition === 'thorough');
  assert.equal(fast.fired, true);
  assert.equal(thorough.fired, false);
});

// Step 3.B: a barrier with config.waitFor must NOT dispatch until
// every waitFor entry is visited, even when the default
// onPartialFailure='continue-with-warning' would let validateBarrier
// pass through. We exercise this by giving the barrier waitFor for
// nodes that DO get visited — the barrier should wait and then
// complete after all are done. If Step 3.B were missing, the barrier
// could try to dispatch when only the first sibling completed.
test('Step 3.B: barrier defers until every config.waitFor entry is visited', async (t) => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await writePipeline(t, 'barrier-wait', {
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'barrier-wait-main',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        { id: 'fan-source', type: 'orpad.context', label: 'Fan source' },
        { id: 'plan-a', type: 'orpad.context', label: 'Plan A' },
        { id: 'plan-b', type: 'orpad.context', label: 'Plan B' },
        { id: 'plan-c', type: 'orpad.context', label: 'Plan C' },
        // Barrier with explicit waitFor — even though transitions also
        // connect plan-{a,b,c} → join, the waitFor declaration is the
        // contract Step 3.B enforces.
        { id: 'join', type: 'orpad.barrier', label: 'Join plans', config: { waitFor: ['plan-a', 'plan-b', 'plan-c'] } },
        { id: 'probe', type: 'orpad.probe', label: 'Probe' },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', label: 'Triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Worker', config: { queueRef: 'queue' } },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'fan-source' },
        { from: 'fan-source', to: 'plan-a' },
        { from: 'fan-source', to: 'plan-b' },
        { from: 'fan-source', to: 'plan-c' },
        { from: 'plan-a', to: 'join' },
        { from: 'plan-b', to: 'join' },
        { from: 'plan-c', to: 'join' },
        { from: 'join', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'exit' },
      ],
    },
  });
  await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });
  const events = await readMachineEvents(run.runRoot);
  const join = events.find(event => (
    event.eventType === 'node.completed' && event.nodePath === 'main/join'
  ));
  const planA = events.find(event => (
    event.eventType === 'node.completed' && event.nodePath === 'main/plan-a'
  ));
  const planB = events.find(event => (
    event.eventType === 'node.completed' && event.nodePath === 'main/plan-b'
  ));
  const planC = events.find(event => (
    event.eventType === 'node.completed' && event.nodePath === 'main/plan-c'
  ));
  assert.ok(join && planA && planB && planC, 'all plans + join should complete');
  // The barrier completes AFTER every waitFor entry. Sequence-based
  // assertion is robust to parallel dispatch.
  assert.ok(join.sequence > planA.sequence);
  assert.ok(join.sequence > planB.sequence);
  assert.ok(join.sequence > planC.sequence);
});

// Codex cross-review 2026-05-16 (S3-Fix5): a barrier whose
// `config.waitFor` lists a PRUNED (dead) sibling — e.g. an unselected
// selector branch — must still satisfy its wait. Without this fix
// the barrier deferred once, fell through to validateBarrierNode,
// and reported the pruned branch as missing. The scheduler knows the
// pruning was intentional, so `barrierWaitForSatisfied` now treats
// dead deps as satisfied (alongside visited deps).
test('Step 3.B + Codex S3-Fix5: barrier waitFor on a pruned (dead) selector branch is satisfied without falling through', async (t) => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await writePipeline(t, 'barrier-on-pruned', {
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'barrier-on-pruned-main',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        // Selector picks 'fast' — thorough-branch is pruned.
        { id: 'route', type: 'orpad.selector', label: 'Pick route', config: { selector: 'mode', options: ['fast', 'thorough'], default: 'fast' } },
        { id: 'fast-branch', type: 'orpad.context', label: 'Fast branch' },
        { id: 'thorough-branch', type: 'orpad.context', label: 'Thorough branch (pruned)' },
        // Barrier waits on BOTH branches even though one is pruned.
        // S3-Fix5: pruned branch counts as resolved.
        { id: 'join', type: 'orpad.barrier', label: 'Join routes', config: { waitFor: ['fast-branch', 'thorough-branch'] } },
        { id: 'probe', type: 'orpad.probe', label: 'Probe' },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', label: 'Triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Worker', config: { queueRef: 'queue' } },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'route' },
        { from: 'route', to: 'fast-branch', condition: 'fast' },
        { from: 'route', to: 'thorough-branch', condition: 'thorough' },
        { from: 'fast-branch', to: 'join' },
        { from: 'thorough-branch', to: 'join' },
        { from: 'join', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'exit' },
      ],
    },
  });
  await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });
  const events = await readMachineEvents(run.runRoot);
  const join = events.find(event => (
    event.eventType === 'node.completed' && event.nodePath === 'main/join'
  ));
  assert.ok(join, 'barrier should complete cleanly when waitFor includes a pruned branch');
  // The pruned branch must NOT have completed.
  const thoroughCompleted = events.find(event => (
    event.eventType === 'node.completed' && event.nodePath === 'main/thorough-branch'
  ));
  assert.equal(thoroughCompleted, undefined, 'thorough-branch (pruned) must not complete');
  // Barrier must not have failed.
  const joinFailed = events.find(event => (
    event.eventType === 'node.failed' && event.nodePath === 'main/join'
  ));
  assert.equal(joinFailed, undefined, 'barrier must not fail because dead deps are treated as resolved');
});

// Codex cross-review 2026-05-16 (coverage gap): 3-way selector
// drops TWO branches, not just one. The dead-cascade must mark both
// dropped branches dead AND propagate through any shared downstream
// they had (none in this fixture, but the test pins the count).
test('Step 3.A (3-way selector): selector drops two of three branches; only the chosen one completes', async (t) => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await writePipeline(t, 'three-way-selector', {
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'three-way-selector-main',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        { id: 'route', type: 'orpad.selector', label: 'Pick mode', config: { selector: 'mode', options: ['fast', 'thorough', 'paranoid'], default: 'thorough' } },
        { id: 'fast-branch', type: 'orpad.context', label: 'Fast branch' },
        { id: 'thorough-branch', type: 'orpad.context', label: 'Thorough branch' },
        { id: 'paranoid-branch', type: 'orpad.context', label: 'Paranoid branch' },
        { id: 'probe', type: 'orpad.probe', label: 'Probe' },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', label: 'Triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Worker', config: { queueRef: 'queue' } },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'route' },
        { from: 'route', to: 'fast-branch', condition: 'fast' },
        { from: 'route', to: 'thorough-branch', condition: 'thorough' },
        { from: 'route', to: 'paranoid-branch', condition: 'paranoid' },
        { from: 'fast-branch', to: 'probe' },
        { from: 'thorough-branch', to: 'probe' },
        { from: 'paranoid-branch', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'exit' },
      ],
    },
  });
  await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });
  const events = await readMachineEvents(run.runRoot);
  const completedPaths = events
    .filter(event => event.eventType === 'node.completed')
    .map(event => event.nodePath);
  assert.ok(completedPaths.includes('main/thorough-branch'), 'thorough-branch (chosen) should complete');
  assert.equal(completedPaths.includes('main/fast-branch'), false, 'fast-branch (dropped) must NOT complete');
  assert.equal(completedPaths.includes('main/paranoid-branch'), false, 'paranoid-branch (dropped) must NOT complete');
  // probe should still complete — it has multiple incoming forward
  // edges; at least one fired (from thorough-branch), so it enters
  // the ready set.
  assert.ok(completedPaths.includes('main/probe'), 'probe should complete via the live branch');
});

// Step 3.C: a decision node that fires a loop-back edge to an
// earlier-positioned worker must emit a `scheduler.loopBackReset`
// event for audit. Step 3 MVP scope: emission only — re-dispatch
// within the same run-step is deferred to a future increment. The
// event must carry the source and target paths so
// audit consumers can reconstruct the loop-back chain.
test('Step 3.C: barrier partial loop-back redrives worker in the same run-step until queue-empty', async (t) => {
  const candidateProposals = [1, 2].map(index => ({
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: `loop-back-reset-proposal-${index}`,
    suggestedWorkItemId: `loop-back-reset-item-${index}`,
    sourceNode: 'main/probe',
    title: `Update target.md ${index}`,
    fingerprint: `loop-back-reset:target.md:${index}`,
    evidence: [{ id: `target-before-${index}`, file: 'target.md' }],
    acceptanceCriteria: ['Patch artifact records the change.'],
    sourceOfTruthTargets: ['target.md'],
  }));
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await writePipeline(t, 'loop-back-reset', {
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'loop-back-reset-main',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        // Gate that always fails — its 'revise' edge loops back to the
        // canonical worker.
        { id: 'plan', type: 'orpad.context', label: 'Plan' },
        { id: 'probe', type: 'orpad.probe', label: 'Probe' },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', label: 'Triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Worker', config: { queueRef: 'queue' } },
        // Barrier stays partial because one declared predecessor is
        // missing. With continue-with-warning it completes valid:false.
        { id: 'verify-barrier', type: 'orpad.barrier', label: 'Verify', config: { waitFor: ['missing-predecessor'], onPartialFailure: 'continue-with-warning' } },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'plan' },
        { from: 'plan', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'verify-barrier' },
        // Loop-back: barrier partial -> back to worker (earlier
        // in source order, so the scheduler classifies as loop-back).
        { from: 'verify-barrier', to: 'worker', condition: 'partial' },
        { from: 'verify-barrier', to: 'exit', condition: 'pass' },
      ],
    },
  }, {
    candidateProposals,
    machineHarness: {
      claimPolicy: { maxClaims: 1 },
    },
  });
  await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });
  const events = await readMachineEvents(run.runRoot);
  const resetEvents = events.filter(event => event.eventType === 'scheduler.loopBackReset');
  assert.equal(resetEvents.length, 2, 'barrier partial should record the redrive reset and the queue-empty stop reset');
  assert.equal(resetEvents[0].nodePath, 'main/worker');
  assert.equal(resetEvents[0].payload.sourceNodePath, 'main/verify-barrier');
  assert.equal(resetEvents[0].payload.targetNodePath, 'main/worker');
  assert.equal(resetEvents[0].payload.phase, 'phase-3-step-3-loop-back');
  const workerCompleted = events.filter(event => (
    event.eventType === 'node.completed' && event.nodePath === 'main/worker'
  ));
  assert.equal(
    workerCompleted.length,
    2,
    'Step 3 MVP defers automatic loop-back re-dispatch — worker should complete exactly once per run-step',
  );
  const firstResetSequence = resetEvents[0].sequence;
  const postFirstResetWorkerEvents = events.filter(event => (
    event.sequence > firstResetSequence
    && event.nodePath === 'main/worker'
    && ['node.scheduled', 'node.started', 'node.completed'].includes(event.eventType)
  ));
  assert.ok(
    postFirstResetWorkerEvents.length >= 3,
    'worker should be scheduled, started, and completed after the first loop-back reset',
  );
  const resetSequence = resetEvents[1].sequence;
  const postResetWorkerEvents = events.filter(event => (
    event.sequence > resetSequence
    && event.nodePath === 'main/worker'
    && ['node.scheduled', 'node.started', 'node.completed'].includes(event.eventType)
  ));
  assert.equal(
    postResetWorkerEvents.length,
    0,
    `worker must not be re-dispatched after the queue-empty stop reset (got ${postResetWorkerEvents.length} post-reset events)`,
  );
});

test('Step 3.C: queue-not-empty loop-back drains dispatcher without manual continue', async (t) => {
  const candidateProposals = [1, 2, 3].map(index => ({
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: `queue-drain-proposal-${index}`,
    suggestedWorkItemId: `queue-drain-item-${index}`,
    sourceNode: 'main/probe',
    title: `Drain queue item ${index}`,
    fingerprint: `queue-drain:target.md:${index}`,
    evidence: [{ id: `queue-drain-before-${index}`, file: 'target.md' }],
    acceptanceCriteria: ['Patch artifact records the change.'],
    sourceOfTruthTargets: ['target.md'],
  }));
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await writePipeline(t, 'queue-drain-loop-back', {
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'queue-drain-loop-back-main',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        { id: 'probe', type: 'orpad.probe', label: 'Probe' },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', label: 'Triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Worker', config: { queueRef: 'queue' } },
        { id: 'queue-gate', type: 'orpad.gate', label: 'Queue empty?', config: { criteria: ['queue empty'], onFail: 'continue-with-warning' } },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'queue-gate' },
        { from: 'queue-gate', to: 'dispatch', condition: 'queue-not-empty' },
        { from: 'queue-gate', to: 'dispatch', condition: 'fail' },
        { from: 'queue-gate', to: 'exit', condition: 'queue-empty' },
        { from: 'queue-gate', to: 'exit', condition: 'pass' },
      ],
    },
  }, {
    candidateProposals,
    machineHarness: {
      claimPolicy: { maxClaims: 1 },
    },
  });
  await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });
  const events = await readMachineEvents(run.runRoot);
  const workerCompleted = events.filter(event => (
    event.eventType === 'node.completed' && event.nodePath === 'main/worker'
  ));
  assert.equal(workerCompleted.length, 3, 'single run-step should claim and complete all three queued items');
  const dispatchResets = events.filter(event => (
    event.eventType === 'scheduler.loopBackReset'
    && event.payload?.targetNodePath === 'main/dispatch'
  ));
  assert.ok(dispatchResets.length >= 2, 'queue-not-empty should redrive dispatcher after queued items remain');
});

test('Step 3.C: patch-review rejected branch loops back to worker in the same run-step', async (t) => {
  const candidateProposals = [1, 2].map(index => ({
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: `patch-reject-proposal-${index}`,
    suggestedWorkItemId: `patch-reject-item-${index}`,
    sourceNode: 'main/probe',
    title: `Patch review item ${index}`,
    fingerprint: `patch-review-reject:target.md:${index}`,
    evidence: [{ id: `patch-review-before-${index}`, file: 'target.md' }],
    acceptanceCriteria: ['Patch artifact records the change.'],
    sourceOfTruthTargets: ['target.md'],
  }));
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await writePipeline(t, 'patch-review-reject-loop-back', {
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'patch-review-reject-loop-back-main',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        { id: 'probe', type: 'orpad.probe', label: 'Probe' },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', label: 'Triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Worker', config: { queueRef: 'queue' } },
        { id: 'review', type: 'orpad.patchReview', label: 'Review patch', config: { reviewRequired: true } },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'review' },
        { from: 'review', to: 'worker', condition: 'rejected' },
        { from: 'review', to: 'exit', condition: 'accepted' },
      ],
    },
  }, {
    candidateProposals,
    machineHarness: {
      claimPolicy: { maxClaims: 1 },
    },
  });
  await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });
  const firstEvents = await readMachineEvents(run.runRoot);
  const reviewRequired = firstEvents.find(event => event.eventType === 'patch.review_required');
  assert.ok(reviewRequired, 'first step should request patch review for the first item');
  await appendPatchReviewRejectedEvent(run.runRoot, {
    runId: run.runId,
    patchArtifact: reviewRequired.payload.patchArtifact,
    itemId: reviewRequired.payload.itemId,
    selectedFiles: reviewRequired.payload.changedFiles,
    reason: 'test-rejected',
    nextAction: 'revise',
  });
  await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });
  const events = await readMachineEvents(run.runRoot);
  const rejectReset = events.find(event => (
    event.eventType === 'scheduler.loopBackReset'
    && event.payload?.sourceNodePath === 'main/review'
    && event.payload?.targetNodePath === 'main/worker'
  ));
  assert.ok(rejectReset, 'patch-review rejected branch should emit a worker loop-back reset');
  const workerCompletedAfterReject = events.filter(event => (
    event.sequence > rejectReset.sequence
    && event.eventType === 'node.completed'
    && event.nodePath === 'main/worker'
  ));
  assert.equal(workerCompletedAfterReject.length, 1, 'rejected patch review should redrive the worker for the next queued item');
});
