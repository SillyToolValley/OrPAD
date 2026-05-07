import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  appendMachineEvent,
  appendRunLifecycleStatus,
  createMachineRun,
  executeMachineRunStep,
  findQueueItem,
  readMachineEvents,
  readActiveClaimLeases,
  readActiveWriteSetLocks,
  readRunState,
  validateArtifactContract,
  validateBarrierNode,
  validateGateNode,
  validateSelectorNode,
} = require('../../src/main/orchestration-machine');
const {
  batchApplyStateFromEvents,
  effectiveProbeCandidateLimit,
  liveProbePrompt,
  patchReviewStateFromEvents,
} = require('../../src/main/orchestration-machine/machine.js');

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

async function readRunArtifactJson(runRoot, artifactPath) {
  return JSON.parse(await fs.readFile(path.join(runRoot, ...String(artifactPath || '').split('/')), 'utf8'));
}

async function makeGraphHarnessWorkspace(runId = 'run_20260430_graph_harness') {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-graph-harness-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/graph-harness-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(path.join(workspaceRoot, 'src/target.md'), 'before\n', 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'graph-harness',
      nodes: [
        { id: 'context', type: 'orpad.context', config: { summary: 'Context.' } },
        { id: 'probe', type: 'orpad.probe', config: { lens: 'smoke' } },
        { id: 'barrier', type: 'orpad.barrier', config: { waitFor: ['probe'], mergePolicy: 'all' } },
        { id: 'queue', type: 'orpad.workQueue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', config: { queueRef: 'queue' } },
        { id: 'verification-gate', type: 'orpad.gate', config: { criteria: ['worker proof accepted', 'queue empty'] } },
        {
          id: 'artifact',
          type: 'orpad.artifactContract',
          config: {
            artifactRoot: 'harness/generated/latest-run/artifacts',
            queueRoot: 'harness/generated/latest-run/queue',
            required: ['discovery/candidate-inventory.json'],
            requiredQueue: ['journal.jsonl'],
          },
        },
      ],
      transitions: [
        { from: 'context', to: 'probe' },
        { from: 'probe', to: 'barrier' },
        { from: 'barrier', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'verification-gate' },
        { from: 'verification-gate', to: 'artifact' },
      ],
    },
  }, null, 2), 'utf8');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'graph-harness-pipeline',
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
          proposalId: 'proposal-graph-harness-target',
          suggestedWorkItemId: 'graph-harness-target',
          sourceNode: 'main/probe',
          title: 'Exercise graph-driven Machine harness execution',
          fingerprint: 'graph-harness:src/target.md',
          evidence: [{ id: 'target-before', file: 'src/target.md' }],
          acceptanceCriteria: ['Patch artifact records src/target.md.'],
          sourceOfTruthTargets: ['src/target.md'],
        },
        expectedChangedFiles: ['src/target.md'],
        nodeCliPatch: {
          file: 'src/target.md',
          content: 'after from graph harness\n',
        },
      },
    },
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
  }, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId,
  });
  return { workspaceRoot, pipelineDir, pipelinePath, run };
}

async function addPatchReviewAndExitNodes(pipelineDir) {
  const graphPath = path.join(pipelineDir, 'graphs/main.or-graph');
  const graph = JSON.parse(await fs.readFile(graphPath, 'utf8'));
  const nodes = graph.graph.nodes;
  const verificationIndex = nodes.findIndex(node => node.id === 'verification-gate');
  nodes.splice(verificationIndex, 0, {
    id: 'patch-review',
    type: 'orpad.patchReview',
    label: 'Review patch results',
    config: { reviewMode: 'user-selected-files' },
  });
  nodes.push({
    id: 'exit',
    type: 'orpad.exit',
    label: 'Exit',
    config: { summary: 'Close after patch review and evidence checks.' },
  });
  graph.graph.transitions = graph.graph.transitions
    .filter(edge => !(edge.from === 'worker' && edge.to === 'verification-gate'));
  graph.graph.transitions.push(
    { from: 'worker', to: 'patch-review' },
    { from: 'patch-review', to: 'verification-gate' },
    { from: 'artifact', to: 'exit' },
  );
  await fs.writeFile(graphPath, JSON.stringify(graph, null, 2), 'utf8');
}

async function makeNestedGraphHarnessWorkspace(runId = 'run_20260430_nested_graph_harness') {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-nested-graph-harness-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/nested-graph-harness-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(path.join(workspaceRoot, 'src/nested-target.md'), 'before nested\n', 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'nested-main',
      nodes: [
        { id: 'context', type: 'orpad.context', config: { summary: 'Nested context.' } },
        { id: 'discovery', type: 'orpad.graph', config: { graphRef: 'discovery.or-graph', executionMode: 'inline' } },
        { id: 'queue-stage', type: 'orpad.graph', config: { graphRef: 'queue.or-graph', executionMode: 'inline' } },
        { id: 'worker-stage', type: 'orpad.graph', config: { graphRef: 'worker.or-graph', executionMode: 'inline' } },
        {
          id: 'artifact',
          type: 'orpad.artifactContract',
          config: {
            required: ['discovery/candidate-inventory.json'],
            requiredQueue: ['journal.jsonl'],
          },
        },
      ],
      transitions: [
        { from: 'context', to: 'discovery' },
        { from: 'discovery', to: 'queue-stage' },
        { from: 'queue-stage', to: 'worker-stage' },
        { from: 'worker-stage', to: 'artifact' },
      ],
    },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/discovery.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'nested-discovery',
      nodes: [
        { id: 'probe-a', type: 'orpad.probe', config: { lens: 'a' } },
        { id: 'probe-b', type: 'orpad.probe', config: { lens: 'b' } },
        { id: 'barrier', type: 'orpad.barrier', config: { waitFor: ['probe-a', 'probe-b'], mergePolicy: 'all' } },
      ],
      transitions: [
        { from: 'probe-a', to: 'barrier' },
        { from: 'probe-b', to: 'barrier' },
      ],
    },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/queue.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'nested-queue',
      nodes: [
        { id: 'queue', type: 'orpad.workQueue', config: { queueRef: 'queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', config: { queueRef: 'queue' } },
      ],
      transitions: [{ from: 'queue', to: 'triage' }],
    },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/worker.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'nested-worker',
      nodes: [
        { id: 'dispatch', type: 'orpad.dispatcher', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', config: { queueRef: 'queue' } },
        { id: 'gate', type: 'orpad.gate', config: { criteria: ['worker proof accepted', 'queue empty'] } },
      ],
      transitions: [
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'gate' },
      ],
    },
  }, null, 2), 'utf8');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'nested-graph-harness-pipeline',
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
          proposalId: 'proposal-nested-graph-target',
          suggestedWorkItemId: 'nested-graph-target',
          sourceNode: 'discovery/probe-a',
          title: 'Exercise nested inline graph Machine harness execution',
          fingerprint: 'nested-graph:src/nested-target.md',
          evidence: [{ id: 'nested-target-before', file: 'src/nested-target.md' }],
          acceptanceCriteria: ['Patch artifact records src/nested-target.md.'],
          sourceOfTruthTargets: ['src/nested-target.md'],
        },
        expectedChangedFiles: ['src/nested-target.md'],
        nodeCliPatch: {
          file: 'src/nested-target.md',
          content: 'after from nested graph harness\n',
        },
      },
    },
    graphs: {
      main: { file: 'graphs/main.or-graph' },
      discovery: { file: 'graphs/discovery.or-graph' },
      queue: { file: 'graphs/queue.or-graph' },
      worker: { file: 'graphs/worker.or-graph' },
    },
  }, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId,
  });
  return { workspaceRoot, pipelineDir, pipelinePath, run };
}

async function updateMainArtifactContract(pipelineDir, config) {
  await updateMainNodeConfig(pipelineDir, 'artifact', config);
}

async function updateMainNodeConfig(pipelineDir, nodeId, config) {
  const graphPath = path.join(pipelineDir, 'graphs/main.or-graph');
  const graph = JSON.parse(await fs.readFile(graphPath, 'utf8'));
  const node = graph.graph.nodes.find(entry => entry.id === nodeId);
  node.config = {
    ...(node.config || {}),
    ...config,
  };
  await fs.writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
}

async function writeFakeCodexCliScript(dir) {
  const scriptPath = path.join(dir, 'fake-codex-cli.mjs');
  await fs.writeFile(scriptPath, [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'const args = process.argv.slice(2);',
    'const outputIndex = args.indexOf("--output-last-message");',
    'const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : "";',
    'const prompt = args.at(-1) || "";',
    'function field(name) {',
    '  const match = prompt.match(new RegExp(`${name}:\\\\s*([^\\\\n]+)`));',
    '  return match ? match[1].trim() : "";',
    '}',
    'const adapterCallId = field("adapterCallId");',
    'const attemptId = field("attemptId");',
    'const idempotencyKey = field("idempotencyKey");',
    'let result;',
    'if (prompt.includes("managed-run worker adapter")) {',
    '  fs.mkdirSync(path.join(process.cwd(), "src"), { recursive: true });',
    '  fs.writeFileSync(path.join(process.cwd(), "src/target.md"), "after from live adapter\\n", "utf8");',
    '  result = {',
    '    schemaVersion: "orpad.workerResult.v1",',
    '    adapterCallId,',
    '    attemptId,',
    '    idempotencyKey,',
    '    status: "done",',
    '    summary: "Fake Codex worker changed the overlay target.",',
    '    artifacts: []',
    '  };',
    '} else {',
    '  result = {',
    '    schemaVersion: "orpad.workerResult.v1",',
    '    adapterCallId,',
    '    attemptId,',
    '    idempotencyKey,',
    '    status: "done",',
    '    summary: "Fake Codex proposal found a target.",',
    '    artifacts: [],',
    '    candidateProposals: [{',
    '      schemaVersion: "orpad.candidateProposal.v1",',
    '      proposalId: "proposal-live-adapter-target",',
    '      suggestedWorkItemId: "live-adapter-target",',
    '      sourceNode: "main/probe",',
    '      title: "Exercise live adapter execution",',
    '      fingerprint: "live-adapter:src/target.md",',
    '      evidence: [{ id: "live-target-before", file: "src/target.md" }],',
    '      acceptanceCriteria: ["Patch artifact records src/target.md."],',
    '      sourceOfTruthTargets: ["src/target.md"]',
    '    }]',
    '  };',
    '}',
    'if (outputPath) {',
    '  fs.mkdirSync(path.dirname(outputPath), { recursive: true });',
    '  fs.writeFileSync(outputPath, `${JSON.stringify(result)}\\n`, "utf8");',
    '}',
  ].join('\n'), 'utf8');
  return scriptPath;
}

test('live proposal prompt gives collect-all-visible probes the managed safe candidate cap', () => {
  const request = {
    adapterCallId: 'proposal-call',
    attemptId: 'proposal-call-attempt-1',
    idempotencyKey: 'proposal-call:attempt-1',
  };
  const adapter = { candidateLimit: 1 };
  const node = {
    nodePath: 'discovery-lenses/pipeline-quality-probe',
    nodeType: 'orpad.probe',
    config: { candidateLimitPolicy: 'collect-all-visible' },
  };
  const pipeline = {
    id: 'maintenance-quality',
    run: {
      runSelection: {
        collectAllVisibleCandidates: true,
        queueAllActionableCandidates: true,
      },
    },
  };

  assert.equal(effectiveProbeCandidateLimit({ adapter, node, pipeline }), 5);

  const prompt = liveProbePrompt({
    request,
    adapter,
    node,
    pipeline,
    pipelinePath: '.orpad/pipelines/maintenance/pipeline.or-pipeline',
  });

  assert.equal(prompt.includes('Return at most 5 candidateProposals.'), true);
  assert.equal(prompt.includes('Return at most 1 candidateProposals.'), false);
});

test('graph-driven execute step runs probe, triage, dispatcher, and worker nodes in graph order', async () => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await makeGraphHarnessWorkspace();

  const executed = await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    nodeExecutable: process.execPath,
  });

  assert.deepEqual(executed.selectedNodes, {
    probe: 'main/probe',
    triage: 'main/triage',
    dispatcher: 'main/dispatch',
    worker: 'main/worker',
  });
  assert.deepEqual(executed.supportNodes.map(node => node.nodePath), [
    'main/context',
    'main/barrier',
    'main/queue',
    'main/verification-gate',
    'main/artifact',
  ]);
  assert.equal(executed.worker.result.event.payload.status, 'done');
  assert.deepEqual(executed.candidateInventory, {
    artifactPath: 'artifacts/discovery/candidate-inventory.json',
    candidateCount: 1,
    emptyPassCount: 0,
  });
  const inventory = JSON.parse(await fs.readFile(
    path.join(run.runRoot, ...executed.candidateInventory.artifactPath.split('/')),
    'utf8',
  ));
  assert.equal(inventory.schemaVersion, 'orpad.machineCandidateInventory.v1');
  assert.equal(inventory.items[0].suggestedWorkItemId, 'graph-harness-target');
  assert.deepEqual(inventory.selectedProbeNodes, ['main/probe']);
  assert.equal((await findQueueItem(run.runRoot, 'graph-harness-target')).state, 'done');
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'src/target.md'), 'utf8'), 'before\n');
  assert.equal((await fs.stat(path.join(pipelineDir, 'harness/generated/latest-run/run-metadata.json'))).isFile(), true);
  assert.equal(executed.finalization.summaryStatus, 'done');
  assert.equal(executed.runState.lifecycleStatus, 'completed');

  const eventTypes = executed.events.map(event => event.eventType);
  assert.equal(executed.runState.eventSequence, executed.events.at(-1).sequence);
  assert.equal(executed.events.some(event => event.eventType === 'run.status' && event.toState === 'running'), true);
  assert.equal(eventTypes.filter(type => type === 'node.started').length, 9);
  assert.equal(eventTypes.filter(type => type === 'node.completed').length, 9);
  const adapterRequest = executed.events.find(event => event.eventType === 'adapter.requested' && event.payload?.taskKind === 'workerLoop');
  assert.equal(adapterRequest.nodePath, 'main/worker');
  const triageRequest = executed.events.find(event => event.eventType === 'adapter.requested' && event.payload?.taskKind === 'triage');
  assert.deepEqual(triageRequest.payload.inputArtifacts, ['artifacts/discovery/candidate-inventory.json']);
  const barrierEvent = executed.events.find(event => event.eventType === 'node.completed' && event.nodePath === 'main/barrier');
  assert.equal(barrierEvent.payload.valid, true);
  assert.equal(barrierEvent.payload.dependencies[0].completed, true);
  const gateEvent = executed.events.find(event => event.eventType === 'node.completed' && event.nodePath === 'main/verification-gate');
  assert.equal(gateEvent.payload.valid, true);
  assert.deepEqual(gateEvent.payload.evaluations.map(entry => entry.passed), [true, true]);

  const eventCountAfterCompletion = (await readMachineEvents(run.runRoot)).length;
  await assert.rejects(
    executeMachineRunStep({
      workspaceRoot,
      pipelinePath,
      pipelineDir,
      runRoot: run.runRoot,
      runId: run.runId,
      nodeExecutable: process.execPath,
    }),
    error => error?.code === 'MACHINE_RUN_TERMINAL',
  );
  assert.equal((await readMachineEvents(run.runRoot)).length, eventCountAfterCompletion);

  await fs.rm(path.join(run.runRoot, 'run-state.json'), { force: true });
  await assert.rejects(
    executeMachineRunStep({
      workspaceRoot,
      pipelinePath,
      pipelineDir,
      runRoot: run.runRoot,
      runId: run.runId,
      nodeExecutable: process.execPath,
    }),
    error => error?.code === 'MACHINE_RUN_TERMINAL',
  );
  assert.equal((await readMachineEvents(run.runRoot)).length, eventCountAfterCompletion);
});

test('graph-driven execute step waits at patch review before exit', async () => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await makeGraphHarnessWorkspace('run_20260430_patch_review_exit');
  await addPatchReviewAndExitNodes(pipelineDir);

  const first = await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });

  const workerEvent = first.events.find(event => event.eventType === 'worker.result');
  const patchArtifact = workerEvent?.payload?.patchArtifact;
  assert.equal(first.finalization.summaryStatus, 'blocked');
  assert.equal(first.finalization.supportBlocked.nodePath, 'main/patch-review');
  assert.equal(first.events.some(event => event.eventType === 'node.blocked' && event.nodePath === 'main/patch-review'), true);
  assert.equal(first.events.some(event => event.eventType === 'node.completed' && event.nodePath === 'main/exit'), false);
  assert.equal(typeof patchArtifact, 'string');

  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'renderer',
    eventType: 'patch.review_skipped',
    reason: 'machine-ui.patch-review.skip',
    artifactRefs: [patchArtifact],
    payload: {
      patchArtifact,
      decision: 'skipped',
    },
  });

  const second = await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });

  assert.equal(second.finalization.summaryStatus, 'done');
  assert.equal(second.events.filter(event => event.eventType === 'worker.result').length, 1);
  assert.equal(second.events.some(event => event.eventType === 'node.completed' && event.nodePath === 'main/patch-review'), true);
  assert.equal(second.events.some(event => event.eventType === 'node.completed' && event.nodePath === 'main/exit'), true);

  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

test('patch review gate keeps blocking after approval until batch apply finishes', async () => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await makeGraphHarnessWorkspace('run_20260504_approve_gate_blocked');
  await addPatchReviewAndExitNodes(pipelineDir);

  const first = await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });
  const workerEvent = first.events.find(event => event.eventType === 'worker.result');
  const patchArtifact = workerEvent?.payload?.patchArtifact;
  assert.equal(typeof patchArtifact, 'string');
  assert.equal(first.finalization.summaryStatus, 'blocked');

  // Approval alone must not unblock the gate; batch apply must run first.
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'renderer',
    eventType: 'patch.approved',
    reason: 'machine-ui.patch-review.approve',
    artifactRefs: [patchArtifact],
    payload: {
      patchArtifact,
      selectedFiles: ['src/target.md'],
    },
  });
  const afterApprove = patchReviewStateFromEvents(await readMachineEvents(run.runRoot));
  assert.equal(afterApprove.resolved, false, 'approved patches still block until applied');
  assert.equal(afterApprove.approvedCount, 1);
  assert.equal(afterApprove.appliedCount, 0);
  assert.equal(afterApprove.batch.inFlight, false);

  const blocked = await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });
  assert.equal(blocked.finalization.summaryStatus, 'blocked');
  assert.equal(blocked.events.some(event => event.eventType === 'node.completed' && event.nodePath === 'main/exit'), false);

  // Simulate the batch apply IPC writing its three event types.
  const startedEvent = await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'renderer',
    eventType: 'patches.apply_started',
    reason: 'machine-ui.patch-review.apply-approved',
    artifactRefs: [patchArtifact],
    payload: { approvedPatchArtifacts: [patchArtifact] },
  });
  const inFlightState = batchApplyStateFromEvents(await readMachineEvents(run.runRoot));
  assert.equal(inFlightState.inFlight, true);

  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'renderer',
    eventType: 'patch.applied',
    reason: 'machine-ui.patch-review.apply-approved',
    artifactRefs: [patchArtifact],
    payload: { patchArtifact, selectedFiles: ['src/target.md'], applied: [{ path: 'src/target.md' }] },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'renderer',
    eventType: 'patches.apply_finished',
    reason: 'machine-ui.patch-review.apply-approved',
    artifactRefs: [patchArtifact],
    payload: { appliedCount: 1, conflictCount: 0, startedEventSequence: startedEvent.sequence },
  });
  const finishedState = batchApplyStateFromEvents(await readMachineEvents(run.runRoot));
  assert.equal(finishedState.inFlight, false);
  const afterApply = patchReviewStateFromEvents(await readMachineEvents(run.runRoot));
  assert.equal(afterApply.resolved, true);
  assert.equal(afterApply.appliedCount, 1);

  const finalStep = await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });
  assert.equal(finalStep.finalization.summaryStatus, 'done');
  assert.equal(finalStep.events.some(event => event.eventType === 'node.completed' && event.nodePath === 'main/patch-review'), true);
  assert.equal(finalStep.events.some(event => event.eventType === 'node.completed' && event.nodePath === 'main/exit'), true);

  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

test('emitGraphDriftWarningIfChanged emits run.graph-drift on orphan + new node paths', async () => {
  const { run } = await makeGraphHarnessWorkspace('run_20260507_graph_drift_unit');
  // Seed historical lifecycle events for two nodePaths: one that will
  // remain in the current graph (main/probe) and one that will be
  // missing (main/old-probe) — simulating a rename/delete since the
  // last run-step.
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'node.skipped',
    nodePath: 'main/old-probe',
    payload: { reason: 'user-skipped', attempt: 1 },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'node.completed',
    nodePath: 'main/probe',
    payload: { attempt: 1 },
  });

  const machineModule = require('../../src/main/orchestration-machine/machine.js');
  const driftEmitter = machineModule.__test_emitGraphDriftWarningIfChanged;

  const events = await readMachineEvents(run.runRoot);
  // Current graph contains main/probe and main/new-probe; main/old-probe
  // has been removed (orphaned lifecycle entry).
  const orderedNodes = [
    { nodePath: 'main/probe', nodeType: 'orpad.probe' },
    { nodePath: 'main/new-probe', nodeType: 'orpad.probe' },
  ];

  const driftEvent = await driftEmitter(run.runRoot, run.runId, events, orderedNodes);
  assert.ok(driftEvent, 'expected a run.graph-drift event to be emitted');
  assert.equal(driftEvent.eventType, 'run.graph-drift');
  assert.deepEqual(driftEvent.payload.orphanedLifecyclePaths, ['main/old-probe']);
  assert.deepEqual(driftEvent.payload.newNodePaths, ['main/new-probe']);

  // De-dupe: calling again with same shape returns null (no second event).
  const eventsAfter = await readMachineEvents(run.runRoot);
  const driftEventAgain = await driftEmitter(run.runRoot, run.runId, eventsAfter, orderedNodes);
  assert.equal(driftEventAgain, null, 'duplicate drift detection must not re-emit');
});

test('graph-driven execute step rejects overlapping running executions', async () => {
  const { workspaceRoot, pipelinePath, run } = await makeGraphHarnessWorkspace('run_20260502_graph_harness_running');
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'running',
    reason: 'test.in-progress',
  });

  await assert.rejects(
    executeMachineRunStep({
      workspaceRoot,
      pipelinePath,
      runRoot: run.runRoot,
      runId: run.runId,
    }),
    error => error?.code === 'MACHINE_RUN_IN_PROGRESS',
  );
});

test('graph-driven execute step rejects overlapping active node executions', async () => {
  const { workspaceRoot, pipelinePath, run } = await makeGraphHarnessWorkspace('run_20260502_graph_harness_active_node');
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'node.started',
    nodePath: 'main/probe',
    payload: {
      nodeExecutionId: `${run.runId}:main/probe:attempt-1`,
      nodeType: 'orpad.probe',
      status: 'started',
      attempt: 1,
    },
  });

  await assert.rejects(
    executeMachineRunStep({
      workspaceRoot,
      pipelinePath,
      runRoot: run.runRoot,
      runId: run.runId,
    }),
    error => (
      error?.code === 'MACHINE_RUN_IN_PROGRESS'
      && error.activeNodeExecutions?.[0]?.nodePath === 'main/probe'
    ),
  );
});

test('graph-driven execute step runs a live Codex CLI adapter declaration through worker overlay', async () => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await makeGraphHarnessWorkspace('run_20260502_live_adapter');
  const fakeCodexDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-fake-codex-cli-'));
  const fakeCodexScript = await writeFakeCodexCliScript(fakeCodexDir);
  const taskText = 'Find competitor gaps and improve Pipes.';
  const pipeline = JSON.parse(await fs.readFile(pipelinePath, 'utf8'));
  delete pipeline.run.machineHarness;
  pipeline.run.machineAdapter = {
    type: 'codex-cli',
    enabled: true,
    command: process.execPath,
    commandPrefixArgs: [fakeCodexScript],
    proposalSandbox: 'read-only',
    workerSandbox: 'workspace-write',
    approvalPolicy: 'never',
    probeNodePaths: ['main/probe'],
    candidateLimit: 1,
    proposalTimeoutMs: 30_000,
    workerTimeoutMs: 30_000,
    claimLeaseMs: 123_456,
  };
  await fs.writeFile(pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`, 'utf8');

  const executed = await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    taskText,
  });

  assert.equal(executed.worker.result.event.payload.status, 'done');
  assert.deepEqual(executed.candidateInventory, {
    artifactPath: 'artifacts/discovery/candidate-inventory.json',
    candidateCount: 1,
    emptyPassCount: 0,
  });
  assert.equal((await findQueueItem(run.runRoot, 'live-adapter-target')).state, 'done');
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'src/target.md'), 'utf8'), 'before\n');
  assert.equal(executed.finalization.summaryStatus, 'done');

  const proposalRequest = executed.events.find(event => event.eventType === 'adapter.requested' && event.payload?.adapter === 'codex-cli-proposal');
  assert.equal(proposalRequest.nodePath, 'main/probe');
  const proposalResult = executed.events.find(event => event.eventType === 'adapter.result' && event.payload?.adapter === 'codex-cli-proposal');
  const proposalTranscriptPath = proposalResult.artifactRefs.find(item => item.endsWith('.transcript.json'));
  const proposalTranscript = await readRunArtifactJson(run.runRoot, proposalTranscriptPath);
  assert.equal(proposalTranscript.command.args.at(-1).includes(taskText), true);
  const workerResult = executed.events.find(event => event.eventType === 'worker.result');
  const workerTranscriptPath = workerResult.artifactRefs.find(item => item.endsWith('.transcript.json'));
  const workerTranscript = await readRunArtifactJson(run.runRoot, workerTranscriptPath);
  assert.equal(workerTranscript.process.args.at(-1).includes(taskText), true);
  const workerVerification = executed.worker.result.event.payload.verification[0];
  assert.equal(workerVerification.cwdKind, 'overlay');
  assert.equal(workerVerification.expectedChangedFiles.includes('src/target.md'), true);
  assert.equal(workerVerification.missingExpectedChanges.length, 0);
  const leaseCreated = executed.events.find(event => event.eventType === 'claim.lease-created');
  assert.equal(leaseCreated.payload.leaseMs, 123_456);
});

test('graph-driven worker spawn failures close claimed work as blocked instead of leaving the run active', async () => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await makeGraphHarnessWorkspace('run_20260504_worker_spawn_failure');
  await updateMainNodeConfig(pipelineDir, 'verification-gate', {
    onFail: 'warn',
  });

  const missingNodeExecutable = process.platform === 'win32'
    ? 'C:\\orpad-missing-node\\node.exe'
    : '/orpad-missing-node/node';
  const executed = await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    nodeExecutable: missingNodeExecutable,
    exportLatestRunAfterStep: false,
  });

  assert.equal(executed.worker.result.event.payload.status, 'failed');
  assert.equal((await findQueueItem(run.runRoot, 'graph-harness-target')).state, 'blocked');
  assert.equal(executed.runState.lifecycleStatus, 'waiting');
  assert.equal(executed.runState.summaryStatus, 'blocked');
  assert.equal((await readActiveClaimLeases(run.runRoot)).length, 0);
  assert.equal((await readActiveWriteSetLocks(run.runRoot)).length, 0);
  assert.equal(executed.events.some(event => event.eventType === 'node.failed' && event.nodePath === 'main/worker'), false);

  const workerEvent = executed.events.find(event => event.eventType === 'worker.result');
  const transcriptPath = workerEvent.artifactRefs.find(item => item.endsWith('.transcript.json'));
  const transcript = await readRunArtifactJson(run.runRoot, transcriptPath);
  assert.equal(transcript.process.spawnError.code, 'ENOENT');
  assert.equal(transcript.process.command, missingNodeExecutable);
});

test('graph-driven execute step rejects pipelines without a deterministic MVP harness', async () => {
  const { workspaceRoot, pipelinePath, run } = await makeGraphHarnessWorkspace('run_20260430_graph_harness_missing');
  const source = JSON.parse(await fs.readFile(pipelinePath, 'utf8'));
  delete source.run.machineHarness;
  await fs.writeFile(pipelinePath, `${JSON.stringify(source, null, 2)}\n`, 'utf8');

  await assert.rejects(
    executeMachineRunStep({
      workspaceRoot,
      pipelinePath,
      pipelineDir: path.dirname(pipelinePath),
      runRoot: run.runRoot,
      runId: run.runId,
      nodeExecutable: process.execPath,
    }),
    error => error?.code === 'MACHINE_EXECUTION_HARNESS_REQUIRED',
  );
});

test('ArtifactContract fail-run blocks completion when required artifacts are missing', async () => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await makeGraphHarnessWorkspace('run_20260430_artifact_contract_fail');
  await updateMainArtifactContract(pipelineDir, {
    required: ['discovery/missing-inventory.json'],
    requiredQueue: ['journal.jsonl'],
    onMissing: 'fail-run',
  });

  await assert.rejects(
    executeMachineRunStep({
      workspaceRoot,
      pipelinePath,
      pipelineDir,
      runRoot: run.runRoot,
      runId: run.runId,
      nodeExecutable: process.execPath,
    }),
    error => error?.code === 'MACHINE_ARTIFACT_CONTRACT_MISSING',
  );

  const events = await readMachineEvents(run.runRoot);
  const failed = events.find(event => event.eventType === 'node.failed' && event.nodePath === 'main/artifact');
  assert.equal(failed.payload.code, 'MACHINE_ARTIFACT_CONTRACT_MISSING');
  assert.equal(events.some(event => event.eventType === 'run.status' && event.toState === 'completed'), false);
  const state = await readRunState(run.runRoot);
  assert.equal(state.lifecycleStatus, 'waiting');
  assert.equal(state.summaryStatus, 'blocked');
});

test('ArtifactContract rejects symlinked queue requirements before treating them as present', async t => {
  const { run } = await makeGraphHarnessWorkspace('run_20260430_artifact_contract_symlink');
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-contract-outside-'));
  const outsideFile = path.join(outsideRoot, 'journal.jsonl');
  await fs.writeFile(outsideFile, '{"outside":true}\n', 'utf8');
  await fs.mkdir(path.join(run.runRoot, 'queue'), { recursive: true });
  if (!await createTestSymlink(t, outsideFile, path.join(run.runRoot, 'queue/link.jsonl'), 'file')) return;

  await assert.rejects(
    validateArtifactContract(run.runRoot, {
      queueRoot: 'queue',
      requiredQueue: ['link.jsonl'],
      onMissing: 'warn',
    }),
    error => error?.code === 'MACHINE_ARTIFACT_SYMLINK_UNSAFE',
  );
});

test('runtime support nodes reject non-string contract arrays before coercion', async () => {
  const { run } = await makeGraphHarnessWorkspace('run_20260430_support_array_type_invalid');

  await assert.rejects(
    validateArtifactContract(run.runRoot, {
      required: [{ path: 'discovery/candidate-inventory.json' }],
      onMissing: 'warn',
    }),
    error => error?.code === 'MACHINE_ARTIFACT_CONTRACT_INVALID',
  );

  await assert.rejects(
    validateBarrierNode(
      run.runRoot,
      { graphKey: 'main', nodePath: 'main/barrier', nodeType: 'orpad.barrier' },
      { waitFor: [{ node: 'probe' }], onPartialFailure: 'continue-with-warning' },
    ),
    error => error?.code === 'MACHINE_CONFIG_INVALID',
  );

  await assert.rejects(
    validateGateNode(run.runRoot, {
      criteria: [{ criterion: 'queue empty' }],
      onFail: 'warn',
    }),
    error => error?.code === 'MACHINE_CONFIG_INVALID',
  );
});

test('external research selector records local-only mode without failing the graph', async () => {
  const { run } = await makeGraphHarnessWorkspace('run_20260430_external_research_selector');
  const config = {
    selector: 'externalResearchMode',
    options: ['local-only-research-gap', 'approved-or-attached-evidence'],
    default: 'local-only-research-gap',
  };

  const localTask = await validateSelectorNode(run.runRoot, config, {
    taskText: 'Improve local graph rendering.',
  });
  assert.equal(localTask.valid, true);
  assert.equal(localTask.selectedRoute, 'not-needed');

  const defaulted = await validateSelectorNode(run.runRoot, config, {
    taskText: 'Search for competing products and verify benchmarks.',
  });
  assert.equal(defaulted.valid, true);
  assert.equal(defaulted.selectedRoute, 'local-only-research-gap');
  assert.equal(defaulted.source, 'safe-local-only-default');

  const selected = await validateSelectorNode(run.runRoot, config, {
    taskText: 'Search for competing products and verify benchmarks.',
    externalResearch: {
      schemaVersion: 'orpad.externalResearchRun.v1',
      intentDetected: true,
      mode: 'local-only-research-gap',
    },
  });
  assert.equal(selected.valid, true);
  assert.equal(selected.selectedRoute, 'local-only-research-gap');
  assert.equal(selected.source, 'user-prelaunch-choice');
});

test('Barrier fail policy rejects when declared dependencies have not completed', async () => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await makeGraphHarnessWorkspace('run_20260430_barrier_wait_fail');
  await updateMainNodeConfig(pipelineDir, 'barrier', {
    waitFor: ['missing-probe'],
    onPartialFailure: 'fail',
  });

  await assert.rejects(
    executeMachineRunStep({
      workspaceRoot,
      pipelinePath,
      pipelineDir,
      runRoot: run.runRoot,
      runId: run.runId,
      nodeExecutable: process.execPath,
    }),
    error => error?.code === 'MACHINE_BARRIER_WAIT_INCOMPLETE',
  );

  const events = await readMachineEvents(run.runRoot);
  const failed = events.find(event => event.eventType === 'node.failed' && event.nodePath === 'main/barrier');
  assert.equal(failed.payload.code, 'MACHINE_BARRIER_WAIT_INCOMPLETE');
  assert.equal(events.some(event => event.nodePath === 'main/triage'), false);
});

test('Gate rejects unsupported or unmet criteria instead of passing by prompt text', async () => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await makeGraphHarnessWorkspace('run_20260430_gate_criteria_fail');
  await updateMainNodeConfig(pipelineDir, 'verification-gate', {
    criteria: ['worker proof accepted', 'unsupported product decision'],
    onFail: 'block',
  });

  await assert.rejects(
    executeMachineRunStep({
      workspaceRoot,
      pipelinePath,
      pipelineDir,
      runRoot: run.runRoot,
      runId: run.runId,
      nodeExecutable: process.execPath,
    }),
    error => error?.code === 'MACHINE_GATE_CRITERIA_UNMET',
  );

  const events = await readMachineEvents(run.runRoot);
  const failed = events.find(event => event.eventType === 'node.failed' && event.nodePath === 'main/verification-gate');
  assert.equal(failed.payload.code, 'MACHINE_GATE_CRITERIA_UNMET');
  assert.equal(events.some(event => event.nodePath === 'main/artifact'), false);
});

test('Gate rejects unsupported onFail policy even when criteria pass', async () => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await makeGraphHarnessWorkspace('run_20260430_gate_invalid_onfail');
  await updateMainNodeConfig(pipelineDir, 'verification-gate', {
    criteria: ['work result accepted', 'queue empty'],
    onFail: 'agent-decides',
  });

  await assert.rejects(
    executeMachineRunStep({
      workspaceRoot,
      pipelinePath,
      pipelineDir,
      runRoot: run.runRoot,
      runId: run.runId,
      nodeExecutable: process.execPath,
    }),
    error => error?.code === 'MACHINE_GATE_CONFIG_INVALID',
  );

  const events = await readMachineEvents(run.runRoot);
  const failed = events.find(event => event.eventType === 'node.failed' && event.nodePath === 'main/verification-gate');
  assert.equal(failed.payload.code, 'MACHINE_GATE_CONFIG_INVALID');
  assert.equal(events.some(event => event.nodePath === 'main/artifact'), false);
});

test('ArtifactContract mark-partial keeps done queue work from becoming a completed run', async () => {
  const { workspaceRoot, pipelineDir, pipelinePath, run } = await makeGraphHarnessWorkspace('run_20260430_artifact_contract_partial');
  await updateMainArtifactContract(pipelineDir, {
    required: ['discovery/missing-inventory.json'],
    requiredQueue: ['journal.jsonl'],
    onMissing: 'mark-partial',
  });

  const executed = await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir,
    runRoot: run.runRoot,
    runId: run.runId,
    nodeExecutable: process.execPath,
  });

  assert.equal((await findQueueItem(run.runRoot, 'graph-harness-target')).state, 'done');
  assert.equal(executed.finalization.summaryStatus, 'partial');
  assert.equal(executed.runState.lifecycleStatus, 'waiting');
  assert.equal(executed.finalization.artifactContracts.partial, true);
  assert.equal(executed.finalization.artifactContracts.contracts[0].missingArtifactCount, 1);
});

test('graph-driven execute step expands inline nested graphs and runs every reachable probe', async () => {
  const { workspaceRoot, pipelinePath, run } = await makeNestedGraphHarnessWorkspace();

  const executed = await executeMachineRunStep({
    workspaceRoot,
    pipelinePath,
    pipelineDir: path.dirname(pipelinePath),
    runRoot: run.runRoot,
    runId: run.runId,
    nodeExecutable: process.execPath,
  });

  assert.deepEqual(executed.selectedProbeNodes, ['discovery/probe-a', 'discovery/probe-b']);
  assert.deepEqual(executed.selectedNodes, {
    probe: 'discovery/probe-a',
    triage: 'queue/triage',
    dispatcher: 'worker/dispatch',
    worker: 'worker/worker',
  });
  assert.deepEqual(executed.supportNodes.map(node => node.nodePath), [
    'main/context',
    'main/discovery',
    'discovery/barrier',
    'main/queue-stage',
    'queue/queue',
    'main/worker-stage',
    'worker/gate',
    'main/artifact',
  ]);
  assert.equal(executed.probes.length, 2);
  assert.equal(executed.probes[1].result.proposals.length, 0);
  assert.deepEqual(executed.candidateInventory, {
    artifactPath: 'artifacts/discovery/candidate-inventory.json',
    candidateCount: 1,
    emptyPassCount: 1,
  });
  const inventory = JSON.parse(await fs.readFile(
    path.join(run.runRoot, ...executed.candidateInventory.artifactPath.split('/')),
    'utf8',
  ));
  assert.deepEqual(inventory.items.map(item => item.status), ['candidate', 'empty-pass']);
  assert.deepEqual(inventory.selectedProbeNodes, ['discovery/probe-a', 'discovery/probe-b']);
  assert.equal(executed.finalization.summaryStatus, 'done');
  assert.equal((await findQueueItem(run.runRoot, 'nested-graph-target')).state, 'done');
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'src/nested-target.md'), 'utf8'), 'before nested\n');

  const eventTypes = executed.events.map(event => event.eventType);
  assert.equal(eventTypes.filter(type => type === 'node.started').length, 13);
  assert.equal(eventTypes.filter(type => type === 'node.completed').length, 13);
});
