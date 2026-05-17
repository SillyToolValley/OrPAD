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
  createMachineRun,
  executeMachineRunStep,
  readMachineEvents,
  __test_isParallelizableSupportNode: isParallelizableSupportNode,
  __test_detectArtifactPathConflicts: detectArtifactPathConflicts,
} = require(path.join(repoRoot, 'src/main/orchestration-machine'));

// Unit tests for the helpers that gate Step 2 fan-out. The integration
// tests below cover the end-to-end behavior; these prove the
// decision logic in isolation so regressions show up at the helper
// boundary.

test('isParallelizableSupportNode excludes canonical-rail paths and patchReview', () => {
  const canonicalRailPaths = new Set(['main/probe', 'main/triage', 'main/dispatch', 'main/worker']);
  // Canonical-rail nodes never parallelize — their internal logic
  // manages shared state (probeFanoutExecuted, claim queue, etc.).
  for (const path of canonicalRailPaths) {
    assert.equal(
      isParallelizableSupportNode({ nodePath: path, nodeType: 'orpad.probe' }, canonicalRailPaths),
      false,
      `${path} (canonical rail) must NOT be parallelizable`,
    );
  }
  // patchReview's blocked status decides whether to halt the run, so
  // it stays serial even though it's in SUPPORT_NODE_TYPES.
  assert.equal(
    isParallelizableSupportNode({ nodePath: 'main/patch-review', nodeType: 'orpad.patchReview' }, canonicalRailPaths),
    false,
  );
  // Codex S3-Fix2: barriers run serially so the waitFor check
  // against schedulerVisited reflects the true visited set (the
  // parallel-batch path pre-marks every node as visited before
  // dispatch, which would race against a barrier-in-batch whose
  // waitFor references a batch-mate).
  assert.equal(
    isParallelizableSupportNode({ nodePath: 'main/barrier', nodeType: 'orpad.barrier' }, canonicalRailPaths),
    false,
  );
  // Support node types whose dispatch is event-log-only are safe.
  for (const nodeType of [
    'orpad.entry',
    'orpad.context',
    'orpad.workQueue',
    'orpad.gate',
    'orpad.selector',
    'orpad.artifactContract',
    'orpad.exit',
    'orpad.graph',
    'orpad.tree',
  ]) {
    assert.equal(
      isParallelizableSupportNode({ nodePath: `main/${nodeType}`, nodeType }, canonicalRailPaths),
      true,
      `${nodeType} should be parallelizable`,
    );
  }
  // Node types outside SUPPORT_NODE_TYPES (e.g. probe / skill) are not.
  assert.equal(
    isParallelizableSupportNode({ nodePath: 'main/skill', nodeType: 'orpad.skill' }, canonicalRailPaths),
    false,
  );
});

test('detectArtifactPathConflicts flags shared artifactRoot / queueRoot / required paths across the batch', () => {
  // Same artifactRoot -> conflict.
  const sharedRoot = detectArtifactPathConflicts([
    { nodePath: 'main/a', config: { artifactRoot: 'harness/foo' } },
    { nodePath: 'main/b', config: { artifactRoot: 'harness/foo' } },
  ]);
  assert.equal(sharedRoot.length, 1);
  assert.equal(sharedRoot[0].path, 'harness/foo');
  assert.equal(sharedRoot[0].ownerA, 'main/a');
  assert.equal(sharedRoot[0].ownerB, 'main/b');

  // Different roots -> no conflict.
  const distinct = detectArtifactPathConflicts([
    { nodePath: 'main/a', config: { artifactRoot: 'harness/foo' } },
    { nodePath: 'main/b', config: { artifactRoot: 'harness/bar' } },
  ]);
  assert.equal(distinct.length, 0);

  // Same required[] entry across two artifactContracts -> conflict on
  // that specific file. This is the realistic Phase 5-precursor case
  // (two contracts claim the same evidence file).
  const sharedRequired = detectArtifactPathConflicts([
    { nodePath: 'main/verify-a', config: { required: ['evidence/shared.md', 'evidence/own-a.md'] } },
    { nodePath: 'main/verify-b', config: { required: ['evidence/shared.md', 'evidence/own-b.md'] } },
  ]);
  assert.equal(sharedRequired.length, 1);
  assert.equal(sharedRequired[0].path, 'evidence/shared.md');

  // Trailing slash + backslash normalization: 'foo/' and 'foo\\' both
  // collapse to 'foo' so authors who get inconsistent on path
  // separators still get the conflict caught.
  const normalized = detectArtifactPathConflicts([
    { nodePath: 'main/a', config: { artifactRoot: 'harness\\foo\\' } },
    { nodePath: 'main/b', config: { artifactRoot: 'harness/foo' } },
  ]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].path, 'harness/foo');

  // queueRoot conflicts too.
  const queueConflict = detectArtifactPathConflicts([
    { nodePath: 'main/queue-a', config: { queueRoot: 'harness/queue' } },
    { nodePath: 'main/queue-b', config: { queueRoot: 'harness/queue' } },
  ]);
  assert.equal(queueConflict.length, 1);
  assert.equal(queueConflict[0].path, 'harness/queue');
});

// Fork-Join Phase 3 Step 2: the scheduler now batches parallelizable
// support nodes (everything in SUPPORT_NODE_TYPES except patchReview,
// minus the canonical-rail probe/triage/dispatcher/worker) via
// `mapWithConcurrency`. Eligible batches are those where every node
// has a non-empty forward predecessor set (= Pattern J fan-out from a
// shared upstream). Initial-ready nodes with empty preds stay on the
// single-pick path so Phase 1 inline-expansion visit order is
// preserved.
//
// We exercise the fan-out path by building a harness pipeline with a
// classic synthesize → { plan-a, plan-b, plan-c } → barrier shape and
// asserting (a) all three plan contexts complete, (b) their started
// events interleave (proof of parallel dispatch, not serial), and
// (c) the barrier completes after all three plans.

async function buildFanOutPipeline(t) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-fan-out-'));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/fan-out');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  // Hand-authored pipeline: harness-driven so no live adapter is
  // needed. The synthesize context unlocks three sibling context
  // nodes; the barrier waits for all three.
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'fan-out-main',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        { id: 'synthesize', type: 'orpad.context', label: 'Synthesize gap map' },
        // Three sibling plan units — Pattern J fan-out target.
        { id: 'plan-a', type: 'orpad.context', label: 'Plan A' },
        { id: 'plan-b', type: 'orpad.context', label: 'Plan B' },
        { id: 'plan-c', type: 'orpad.context', label: 'Plan C' },
        { id: 'join', type: 'orpad.barrier', label: 'Join plans', config: { waitFor: ['plan-a', 'plan-b', 'plan-c'] } },
        { id: 'probe', type: 'orpad.probe', label: 'Probe (harness)', config: { lens: 'fan-out-tutorial' } },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', label: 'Triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Worker', config: { queueRef: 'queue' } },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'synthesize' },
        // Pattern J: synthesize unlocks all three siblings unconditionally.
        { from: 'synthesize', to: 'plan-a' },
        { from: 'synthesize', to: 'plan-b' },
        { from: 'synthesize', to: 'plan-c' },
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
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(workspaceRoot, 'target.md'), 'before\n', 'utf8');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'fan-out',
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
        candidateProposal: {
          schemaVersion: 'orpad.candidateProposal.v1',
          proposalId: 'fan-out-proposal',
          suggestedWorkItemId: 'fan-out-item',
          sourceNode: 'main/probe',
          title: 'Update target.md',
          fingerprint: 'fan-out:target.md',
          evidence: [{ id: 'target-before', file: 'target.md' }],
          acceptanceCriteria: ['Patch artifact records the change.'],
          sourceOfTruthTargets: ['target.md'],
        },
        expectedChangedFiles: ['target.md'],
        nodeCliPatch: {
          file: 'target.md',
          content: 'Updated by fan-out fixture.\n',
        },
      },
    },
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
  }, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId: 'run_fan_out_001',
  });
  return { workspaceRoot, pipelineDir, pipelinePath, run };
}

test('Phase 3 Step 2: synthesize → {plan-a, plan-b, plan-c} → barrier runs all three siblings in parallel', async (t) => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await buildFanOutPipeline(t);
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

  // (a) All three sibling plan contexts must complete in this run-step.
  const planACompleted = events.find(event => (
    event.eventType === 'node.completed' && event.nodePath === 'main/plan-a'
  ));
  const planBCompleted = events.find(event => (
    event.eventType === 'node.completed' && event.nodePath === 'main/plan-b'
  ));
  const planCCompleted = events.find(event => (
    event.eventType === 'node.completed' && event.nodePath === 'main/plan-c'
  ));
  assert.ok(planACompleted, 'plan-a should have completed');
  assert.ok(planBCompleted, 'plan-b should have completed');
  assert.ok(planCCompleted, 'plan-c should have completed');

  // (b) The three siblings must have been DISPATCHED as a batch — the
  // proof is that their `node.scheduled` events appear consecutively
  // (the batch is sorted by orderedIndex inside mapWithConcurrency and
  // appendMachineEvent serializes writes globally so the schedule
  // burst is contiguous in the log). Under serial single-pick, OTHER
  // unrelated events would interleave between sibling schedules.
  const scheduledEvents = events.filter(event => event.eventType === 'node.scheduled');
  const planAScheduledIdx = scheduledEvents.findIndex(e => e.nodePath === 'main/plan-a');
  const planBScheduledIdx = scheduledEvents.findIndex(e => e.nodePath === 'main/plan-b');
  const planCScheduledIdx = scheduledEvents.findIndex(e => e.nodePath === 'main/plan-c');
  assert.ok(planAScheduledIdx >= 0 && planBScheduledIdx >= 0 && planCScheduledIdx >= 0);
  const scheduledIndices = [planAScheduledIdx, planBScheduledIdx, planCScheduledIdx].sort((a, b) => a - b);
  // Consecutive iff max - min === 2 (i.e. they form a 3-event burst
  // without anything in between).
  assert.equal(
    scheduledIndices[2] - scheduledIndices[0],
    2,
    `plan-a/b/c schedule events should be consecutive (got indices ${JSON.stringify(scheduledIndices)})`,
  );

  // (c) The barrier completes AFTER all three plans.
  const joinCompleted = events.find(event => (
    event.eventType === 'node.completed' && event.nodePath === 'main/join'
  ));
  assert.ok(joinCompleted, 'join barrier should have completed');
  assert.ok(joinCompleted.sequence > planACompleted.sequence);
  assert.ok(joinCompleted.sequence > planBCompleted.sequence);
  assert.ok(joinCompleted.sequence > planCCompleted.sequence);

  // (d) No artifact-path conflict diagnostic was emitted — the
  // sibling contexts don't declare conflicting artifactRoot / queueRoot.
  const conflicts = events.filter(event => event.eventType === 'scheduler.parallelArtifactConflict');
  assert.equal(conflicts.length, 0, `unexpected artifact conflict events: ${JSON.stringify(conflicts)}`);
});

test('Phase 3 Step 2 stopgap: parallel batch with conflicting artifactRoot emits scheduler.parallelArtifactConflict and serializes', async (t) => {
  // Hand-authored pipeline where two siblings declare the SAME
  // artifact required path. Step 2 must (a) detect the conflict via
  // `detectArtifactPathConflicts`, (b) emit a
  // `scheduler.parallelArtifactConflict` diagnostic with the
  // conflicting path, and (c) fall back to single-pick so the run
  // doesn't silently corrupt parallel writes. Phase 5 (file-lock
  // queue) replaces this with proper acquire/wait semantics.
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-fan-out-conflict-'));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/fan-out-conflict');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'fan-out-conflict-main',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        { id: 'synthesize', type: 'orpad.context', label: 'Synthesize' },
        // Both sibling artifactContracts CLAIM the same required file —
        // a real Phase 2/3 conflict the stopgap must catch. Use
        // `onMissing: 'mark-partial'` so the artifactContract reports
        // the missing file without aborting the run; we want to
        // observe the conflict DIAGNOSTIC, not the validation throw.
        { id: 'verify-a', type: 'orpad.artifactContract', label: 'Verify A', config: { artifactRoot: 'harness/generated/latest-run/artifacts', required: ['evidence/shared-claim.md'], onMissing: 'mark-partial' } },
        { id: 'verify-b', type: 'orpad.artifactContract', label: 'Verify B', config: { artifactRoot: 'harness/generated/latest-run/artifacts', required: ['evidence/shared-claim.md'], onMissing: 'mark-partial' } },
        { id: 'probe', type: 'orpad.probe', label: 'Probe', config: { lens: 'conflict-tutorial' } },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', label: 'Triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Worker', config: { queueRef: 'queue' } },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'synthesize' },
        { from: 'synthesize', to: 'verify-a' },
        { from: 'synthesize', to: 'verify-b' },
        { from: 'verify-a', to: 'probe' },
        { from: 'verify-b', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'exit' },
      ],
    },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(workspaceRoot, 'target.md'), 'before\n', 'utf8');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'fan-out-conflict',
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
        candidateProposal: {
          schemaVersion: 'orpad.candidateProposal.v1',
          proposalId: 'conflict-proposal',
          suggestedWorkItemId: 'conflict-item',
          sourceNode: 'main/probe',
          title: 'Update target.md',
          fingerprint: 'conflict:target.md',
          evidence: [{ id: 'target-before', file: 'target.md' }],
          acceptanceCriteria: ['Patch records change.'],
          sourceOfTruthTargets: ['target.md'],
        },
        expectedChangedFiles: ['target.md'],
        nodeCliPatch: { file: 'target.md', content: 'Updated.\n' },
      },
    },
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
  }, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId: 'run_fan_out_conflict_001',
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
  const conflicts = events.filter(event => event.eventType === 'scheduler.parallelArtifactConflict');
  assert.equal(conflicts.length, 1, 'expected exactly one parallelArtifactConflict diagnostic');
  assert.equal(conflicts[0].payload.phase, 'phase-3-step-2-stopgap');
  assert.equal(conflicts[0].payload.fallbackMode, 'serialize-via-single-pick');
  // Conflict payload must name the actual contested path.
  const conflictPaths = conflicts[0].payload.conflicts.map(c => c.path);
  assert.ok(conflictPaths.includes('evidence/shared-claim.md'));
  // Both verify nodes must still complete — fall-back serializes them
  // through single-pick, doesn't drop them.
  const verifyACompleted = events.find(event => (
    event.eventType === 'node.completed' && event.nodePath === 'main/verify-a'
  ));
  const verifyBCompleted = events.find(event => (
    event.eventType === 'node.completed' && event.nodePath === 'main/verify-b'
  ));
  assert.ok(verifyACompleted, 'verify-a should have completed serially');
  assert.ok(verifyBCompleted, 'verify-b should have completed serially');
});
