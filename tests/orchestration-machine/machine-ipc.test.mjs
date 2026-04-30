import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createAuthorityManager } = require('../../src/main/authority');
const {
  MACHINE_IPC_CHANNELS,
  registerMachineHandlers,
} = require('../../src/main/orchestration-machine');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

function runMachineAudit(runRoot, latestRunExportRoot = '') {
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

function createIpcHarness(featureGate = { enabled: true, mutatingCapabilityToken: 'test-token' }) {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
  const authority = createAuthorityManager();
  registerMachineHandlers({ ipcMain, authority, featureGate });
  return { handlers, authority };
}

function senderEvent(url = 'file:///C:/OrPAD/src/renderer/index.html') {
  return {
    sender: { id: 1001 },
    senderFrame: { url },
  };
}

async function makeWorkspace() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-ipc-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/sample-machine-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'sample-machine-pipeline',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      nodes: [{ id: 'context', type: 'orpad.context' }],
      edges: [],
    },
  }, null, 2), 'utf8');
  return { workspaceRoot, pipelineDir, pipelinePath };
}

async function makeHarnessWorkspace() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-ipc-harness-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/harness-machine-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(path.join(workspaceRoot, 'src/smoke-target.md'), 'before\n', 'utf8');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'harness-machine-pipeline',
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
          proposalId: 'proposal-ipc-harness-smoke',
          suggestedWorkItemId: 'ipc-harness-smoke',
          sourceNode: 'probe/ipc-harness',
          title: 'Exercise Machine IPC worker execution',
          fingerprint: 'ipc-harness:src/smoke-target.md',
          evidence: [{ id: 'target-before', file: 'src/smoke-target.md' }],
          acceptanceCriteria: ['Patch artifact records the target file change.'],
          sourceOfTruthTargets: ['src/smoke-target.md'],
        },
        expectedChangedFiles: ['src/smoke-target.md'],
        nodeCliPatch: {
          file: 'src/smoke-target.md',
          content: 'after from Machine IPC harness\n',
        },
      },
    },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      nodes: [
        { id: 'probe', type: 'orpad.probe', config: { lens: 'ipc-harness' } },
        { id: 'queue', type: 'orpad.workQueue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', config: { queueRef: 'queue' } },
        { id: 'dispatcher', type: 'orpad.dispatcher', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', config: { queueRef: 'queue' } },
      ],
      edges: [],
    },
  }, null, 2), 'utf8');
  return { workspaceRoot, pipelineDir, pipelinePath };
}

async function appendHarnessArtifactContract(pipelineDir, config) {
  const graphPath = path.join(pipelineDir, 'graphs/main.or-graph');
  const graph = JSON.parse(await fs.readFile(graphPath, 'utf8'));
  graph.graph.nodes.push({
    id: 'artifact',
    type: 'orpad.artifactContract',
    config,
  });
  await fs.writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
}

test('Machine IPC registers only typed channels and preload exposes no generic machine invoke', async () => {
  const { handlers } = createIpcHarness();
  const preloadSource = await fs.readFile(path.join(repoRoot, 'src/main/preload.js'), 'utf8');

  assert.deepEqual([...handlers.keys()].sort(), Object.values(MACHINE_IPC_CHANNELS).sort());
  assert.equal(preloadSource.includes('machine-validate-pipeline'), true);
  assert.equal(preloadSource.includes('machine-decide-approval'), true);
  assert.equal(preloadSource.includes('machine.invoke'), false);
  assert.equal(preloadSource.includes("ipcRenderer.invoke(channel"), false);
});

test('Machine IPC rejects disabled feature gates, invalid sender frames, and invalid schemas', async () => {
  const disabled = createIpcHarness({ enabled: false, mutatingCapabilityToken: 'test-token' });
  const disabledResult = await disabled.handlers.get(MACHINE_IPC_CHANNELS.validatePipeline)(
    senderEvent(),
    { pipelinePath: 'pipeline.or-pipeline' },
  );
  assert.equal(disabledResult.success, false);
  assert.equal(disabledResult.code, 'MACHINE_IPC_FEATURE_DISABLED');

  const enabled = createIpcHarness();
  const invalidSender = await enabled.handlers.get(MACHINE_IPC_CHANNELS.validatePipeline)(
    senderEvent('https://example.test/renderer.html'),
    { pipelinePath: 'pipeline.or-pipeline' },
  );
  assert.equal(invalidSender.success, false);
  assert.equal(invalidSender.code, 'MACHINE_IPC_SENDER_FRAME_DENIED');

  const invalidSchema = await enabled.handlers.get(MACHINE_IPC_CHANNELS.validatePipeline)(senderEvent(), null);
  assert.equal(invalidSchema.success, false);
  assert.equal(invalidSchema.code, 'MACHINE_IPC_SCHEMA_INVALID');
});

test('Machine IPC rejects pipeline paths outside the approved workspace', async () => {
  const { workspaceRoot } = await makeWorkspace();
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-ipc-outside-'));
  const outsidePipeline = path.join(outsideRoot, 'pipeline.or-pipeline');
  await fs.writeFile(outsidePipeline, JSON.stringify({ kind: 'orpad.pipeline', version: '1.0' }), 'utf8');

  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);

  const result = await handlers.get(MACHINE_IPC_CHANNELS.validatePipeline)(event, {
    workspacePath: workspaceRoot,
    pipelinePath: outsidePipeline,
  });

  assert.equal(result.success, false);
  assert.match(result.error, /outside workspace/i);
});

test('Machine IPC validates, creates, reads, lists, and exports a Machine run with capability token', async () => {
  const { workspaceRoot, pipelinePath, pipelineDir } = await makeWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);

  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };
  const validation = await handlers.get(MACHINE_IPC_CHANNELS.validatePipeline)(event, baseRequest);
  assert.equal(validation.success, true);
  assert.equal(validation.canMachineExecute, true);
  assert.equal(validation.validation.canExecute, true);

  const deniedCreate = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260430_ipc',
  });
  assert.equal(deniedCreate.success, false);
  assert.equal(deniedCreate.code, 'MACHINE_IPC_CAPABILITY_DENIED');

  const invalidRunId = await handlers.get(MACHINE_IPC_CHANNELS.getRun)(event, {
    ...baseRequest,
    runId: '../run_20260430_ipc',
  });
  assert.equal(invalidRunId.success, false);
  assert.equal(invalidRunId.code, 'MACHINE_IPC_SCHEMA_INVALID');

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260430_ipc',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);
  assert.equal(created.runId, 'run_20260430_ipc');

  const duplicateCreate = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260430_ipc',
    capabilityToken: 'test-token',
  });
  assert.equal(duplicateCreate.success, false);
  assert.equal(duplicateCreate.code, 'MACHINE_RUN_ALREADY_EXISTS');

  const listed = await handlers.get(MACHINE_IPC_CHANNELS.listRuns)(event, baseRequest);
  assert.equal(listed.success, true);
  assert.deepEqual(listed.runs.map(run => run.runId), ['run_20260430_ipc']);

  const snapshot = await handlers.get(MACHINE_IPC_CHANNELS.getRun)(event, {
    ...baseRequest,
    runId: 'run_20260430_ipc',
  });
  assert.equal(snapshot.success, true);
  assert.equal(snapshot.runState.lifecycleStatus, 'created');
  assert.equal(snapshot.events.length, 1);

  const exported = await handlers.get(MACHINE_IPC_CHANNELS.exportLatestRun)(event, {
    ...baseRequest,
    runId: 'run_20260430_ipc',
    capabilityToken: 'test-token',
  });
  assert.equal(exported.success, true);
  assert.equal(exported.targetRoot, path.join(pipelineDir, 'harness/generated/latest-run'));
  assert.equal((await fs.stat(path.join(exported.targetRoot, 'run-metadata.json'))).isFile(), true);
});

test('Machine IPC execute step runs dispatcher, worker loop, and CLI overlay adapter with a harness grant', async () => {
  const { workspaceRoot, pipelinePath, pipelineDir } = await makeHarnessWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260430_ipc_harness',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  const executed = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
  });

  assert.equal(executed.success, true);
  assert.equal(executed.worker.event.payload.status, 'done');
  assert.deepEqual(executed.selectedProbeNodes, ['main/probe']);
  assert.deepEqual(executed.supportNodes.map(node => node.nodePath), ['main/queue']);
  assert.deepEqual(executed.candidateInventory, {
    artifactPath: 'artifacts/discovery/candidate-inventory.json',
    candidateCount: 1,
    emptyPassCount: 0,
  });
  assert.equal(executed.finalization.summaryStatus, 'done');
  assert.equal(executed.runState.lifecycleStatus, 'completed');
  assert.equal(executed.events.some(item => item.eventType === 'adapter.requested'), true);
  assert.equal(executed.events.some(item => item.eventType === 'worker.result'), true);
  assert.equal(executed.events.some(item => item.eventType === 'queue.transition' && item.toState === 'done'), true);
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'src/smoke-target.md'), 'utf8'), 'before\n');
  assert.equal((await fs.stat(path.join(pipelineDir, 'harness/generated/latest-run/run-metadata.json'))).isFile(), true);

  const snapshot = await handlers.get(MACHINE_IPC_CHANNELS.getRun)(event, {
    ...baseRequest,
    runId: created.runId,
  });
  assert.deepEqual(snapshot.candidateInventory, {
    artifactPath: 'artifacts/discovery/candidate-inventory.json',
    candidateCount: 1,
    emptyPassCount: 0,
  });
  assert.equal(snapshot.worker.event.payload.status, 'done');
  assert.equal(snapshot.worker.event.artifactRefs.length, 2);

  const repeated = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
  });
  assert.equal(repeated.success, false);
  assert.equal(repeated.code, 'MACHINE_RUN_TERMINAL');
  assert.equal(repeated.runState.eventSequence, snapshot.runState.eventSequence);
});

test('Machine IPC execute step returns refreshed run evidence when a runtime node fails', async () => {
  const { workspaceRoot, pipelinePath, pipelineDir } = await makeHarnessWorkspace();
  await appendHarnessArtifactContract(pipelineDir, {
    required: ['missing-proof.md'],
    onMissing: 'fail-run',
  });
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260430_ipc_harness_failure',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  const executed = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
  });

  assert.equal(executed.success, false);
  assert.equal(executed.code, 'MACHINE_ARTIFACT_CONTRACT_MISSING');
  assert.equal(executed.failure.contract.missingArtifactCount, 1);
  assert.equal(executed.events.some(item => item.eventType === 'node.failed' && item.nodePath === 'main/artifact'), true);
  assert.equal(executed.events.some(item => item.eventType === 'worker.result'), true);
  assert.equal(executed.runState.eventSequence, executed.events.at(-1).sequence);
});

test('Machine IPC snapshots expose pending approval summaries', async () => {
  const { workspaceRoot, pipelinePath } = await makeHarnessWorkspace();
  const source = JSON.parse(await fs.readFile(pipelinePath, 'utf8'));
  source.run.machineHarness.candidateProposal.approvalRequired = true;
  await fs.writeFile(pipelinePath, `${JSON.stringify(source, null, 2)}\n`, 'utf8');
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260430_ipc_harness_approval',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  const executed = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
  });
  assert.equal(executed.success, true);
  assert.equal(executed.approvals.pendingCount, 1);
  assert.equal(executed.approvals.pending[0].itemId, 'ipc-harness-smoke');
  assert.equal(executed.approvals.pending[0].approvalId, 'approval-ipc-harness-smoke');
  assert.equal(executed.runState.lifecycleStatus, 'approval-required');
  assert.equal(executed.runState.summaryStatus, 'blocked');
  assert.equal(executed.finalization.summaryStatus, 'blocked');
  assert.equal(executed.finalization.approvalRequired, true);
  assert.equal(executed.worker, null);

  const snapshot = await handlers.get(MACHINE_IPC_CHANNELS.getRun)(event, {
    ...baseRequest,
    runId: created.runId,
  });
  assert.equal(snapshot.runState.lifecycleStatus, 'approval-required');
  assert.equal(snapshot.runState.summaryStatus, 'blocked');
  assert.equal(snapshot.approvals.pendingCount, 1);
  assert.equal(snapshot.approvals.pending[0].status, 'requested');

  const listed = await handlers.get(MACHINE_IPC_CHANNELS.listRuns)(event, baseRequest);
  assert.equal(listed.runs.find(run => run.runId === created.runId).pendingApprovalCount, 1);

  const missingDecision = await handlers.get(MACHINE_IPC_CHANNELS.decideApproval)(event, {
    ...baseRequest,
    runId: created.runId,
    approvalId: 'approval-missing',
    decision: 'approved',
    capabilityToken: 'test-token',
  });
  assert.equal(missingDecision.success, false);
  assert.equal(missingDecision.code, 'MACHINE_APPROVAL_NOT_PENDING');

  const approved = await handlers.get(MACHINE_IPC_CHANNELS.decideApproval)(event, {
    ...baseRequest,
    runId: created.runId,
    approvalId: 'approval-ipc-harness-smoke',
    decision: 'approved',
    capabilityToken: 'test-token',
  });
  assert.equal(approved.success, true);
  assert.equal(approved.approvals.pendingCount, 0);
  assert.equal(approved.approvals.all[0].status, 'approved');
  assert.equal(approved.grants[0].itemId, 'ipc-harness-smoke');
  assert.equal(approved.runState.lifecycleStatus, 'waiting');
  assert.equal(approved.runState.summaryStatus, 'partial');

  const resumed = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
  });
  assert.equal(resumed.success, true);
  assert.equal(resumed.worker.event.payload.status, 'done');
  assert.equal(resumed.candidateInventory.candidateCount, 1);
  assert.equal(resumed.runState.lifecycleStatus, 'completed');
  assert.equal(resumed.runState.summaryStatus, 'done');
  const audit = runMachineAudit(created.runRoot, resumed.exported.targetRoot);
  assert.equal(audit.exitCode, 0, audit.stderr || audit.stdout);
  assert.equal(audit.json.ok, true);
});
