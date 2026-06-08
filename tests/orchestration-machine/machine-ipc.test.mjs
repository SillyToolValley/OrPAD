import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
  MACHINE_RUN_PROGRESS_CHANNEL,
  appendMachineEvent,
  appendRunLifecycleStatus,
  clearRunControlToken,
  claimNextQueuedItem,
  editQueueItem,
  findQueueItem,
  ingestCandidateProposal,
  patchReviewStateFromEvents,
  projectQueueStateFromEvents,
  readMachineEvents,
  readRunControlToken,
  registerPatchArtifact,
  registerMachineHandlers,
  repairDerivedQueueFilesFromEvents,
  transitionQueueItem,
} = require('../../src/main/orchestration-machine');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

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

function createIpcHarness(featureGate = { enabled: true, mutatingCapabilityToken: 'test-token' }, options = {}) {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
  const authority = createAuthorityManager();
  registerMachineHandlers({ ipcMain, authority, featureGate, ...options });
  return { handlers, authority };
}

function senderEvent(url = 'file:///C:/OrPAD/src/renderer/index.html') {
  return {
    sender: { id: 1001 },
    senderFrame: { url },
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

async function updateHarnessGraphNodeConfig(pipelineDir, nodeId, patch) {
  const graphPath = path.join(pipelineDir, 'graphs/main.or-graph');
  const graph = JSON.parse(await fs.readFile(graphPath, 'utf8'));
  const node = graph.graph.nodes.find(entry => entry.id === nodeId);
  if (!node) throw new Error(`Graph node not found: ${nodeId}`);
  node.config = { ...(node.config || {}), ...patch };
  await fs.writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
}

async function appendHarnessPatchReviewNode(pipelineDir) {
  const graphPath = path.join(pipelineDir, 'graphs/main.or-graph');
  const graph = JSON.parse(await fs.readFile(graphPath, 'utf8'));
  graph.graph.nodes.push({
    id: 'patch-review',
    type: 'orpad.patchReview',
    label: 'Review patch results',
    config: { reviewMode: 'user-selected-files' },
  });
  await fs.writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
}

test('Machine IPC registers only typed channels and preload exposes no generic machine invoke', async () => {
  const { handlers } = createIpcHarness();
  const preloadSource = await fs.readFile(path.join(repoRoot, 'src/main/preload.js'), 'utf8');

  assert.deepEqual([...handlers.keys()].sort(), Object.values(MACHINE_IPC_CHANNELS).sort());
  assert.equal(preloadSource.includes('machine-enable-session'), true);
  assert.equal(preloadSource.includes('machine-validate-pipeline'), true);
  assert.equal(preloadSource.includes('machine-resume-run'), true);
  assert.equal(preloadSource.includes('machine-pause-run'), true);
  assert.equal(preloadSource.includes('machine-reject-item'), true);
  assert.equal(preloadSource.includes('machine-reprioritize-item'), true);
  assert.equal(preloadSource.includes('machine-inject-item'), true);
  assert.equal(preloadSource.includes('machine-edit-item'), true);
  // PUSH STREAM: a one-way main->renderer progress channel exposed via onRunProgress.
  assert.equal(preloadSource.includes('machine-run-progress'), true);
  assert.equal(preloadSource.includes('onRunProgress'), true);
  assert.equal(MACHINE_RUN_PROGRESS_CHANNEL, 'machine-run-progress');
  assert.equal(preloadSource.includes('machine-cancel-claim'), true);
  assert.equal(preloadSource.includes('machine-decide-approval'), true);
  assert.equal(preloadSource.includes('machine-review-patch'), true);
  assert.equal(preloadSource.includes('machine-approve-patch'), true);
  assert.equal(preloadSource.includes('machine-apply-approved-patches'), true);
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

test('Machine IPC can enable managed runs for an unpackaged session', async () => {
  const { handlers } = createIpcHarness(
    { enabled: false, mutatingCapabilityToken: '' },
    { allowSessionEnable: true },
  );

  const before = await handlers.get(MACHINE_IPC_CHANNELS.status)(senderEvent());
  assert.equal(before.success, true);
  assert.equal(before.enabled, false);
  assert.equal(before.mutatingCapabilityConfigured, false);
  assert.equal(before.sessionEnableAvailable, true);

  const enabled = await handlers.get(MACHINE_IPC_CHANNELS.enableSession)(senderEvent());
  assert.equal(enabled.success, true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.enabledBy, 'session');
  assert.equal(enabled.mutatingCapabilityConfigured, true);
  assert.match(enabled.capabilityToken, /^orpad-session-/);

  const after = await handlers.get(MACHINE_IPC_CHANNELS.status)(senderEvent());
  assert.equal(after.success, true);
  assert.equal(after.enabled, true);
  assert.equal(after.enabledBy, 'session');
  assert.equal(after.mutatingCapabilityConfigured, true);

  const envTokenHarness = createIpcHarness(
    { enabled: false, mutatingCapabilityToken: 'env-token' },
    { allowSessionEnable: true },
  );
  const envTokenEnabled = await envTokenHarness.handlers.get(MACHINE_IPC_CHANNELS.enableSession)(senderEvent());
  assert.equal(envTokenEnabled.success, true);
  assert.equal(envTokenEnabled.mutatingCapabilityConfigured, true);
  assert.equal(envTokenEnabled.capabilityToken, undefined);
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

test('Machine IPC rejects symlinked pipeline files before validation', async t => {
  const { workspaceRoot } = await makeWorkspace();
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/ipc-symlink-pipeline');
  await fs.mkdir(pipelineDir, { recursive: true });
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-ipc-symlink-target-'));
  const outsidePipeline = path.join(outsideRoot, 'pipeline.or-pipeline');
  await fs.writeFile(outsidePipeline, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'outside-pipeline',
  }, null, 2), 'utf8');
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  if (!await createTestSymlink(t, outsidePipeline, pipelinePath, 'file')) return;

  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);

  const result = await handlers.get(MACHINE_IPC_CHANNELS.validatePipeline)(event, {
    workspacePath: workspaceRoot,
    pipelinePath,
  });

  assert.equal(result.success, false);
  assert.equal(result.code, 'MACHINE_PIPELINE_SYMLINK_UNSAFE');
});

test('Machine IPC rejects symlinked run stores before listing runs', async t => {
  const { workspaceRoot, pipelinePath, pipelineDir } = await makeWorkspace();
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-ipc-symlink-runs-'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  if (!await createTestSymlink(t, outsideRoot, path.join(pipelineDir, 'runs'), linkType)) return;

  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);

  const result = await handlers.get(MACHINE_IPC_CHANNELS.listRuns)(event, {
    workspacePath: workspaceRoot,
    pipelinePath,
  });

  assert.equal(result.success, false);
  assert.equal(result.code, 'MACHINE_RUN_ROOT_SYMLINK_UNSAFE');
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
  assert.equal(validation.canMachineExecuteStep, false);
  assert.equal(validation.validation.canExecute, true);
  assert.equal(validation.validation.canMachineExecuteStep, false);
  assert.deepEqual(validation.validation.machineStepBlockedReasons, ['machine-harness-required']);

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

  const resumed = await handlers.get(MACHINE_IPC_CHANNELS.resumeRun)(event, {
    ...baseRequest,
    runId: 'run_20260430_ipc',
    capabilityToken: 'test-token',
    exportLatestRun: false,
  });
  assert.equal(resumed.success, true);
  assert.equal(resumed.runState.lifecycleStatus, 'waiting');
  assert.equal(resumed.runState.summaryStatus, 'partial');
  assert.equal(resumed.resume.staleClaimCount, 0);
  assert.equal(resumed.resume.inventory.activeCount, 0);
  assert.equal(resumed.approvals.pendingCount, 0);
  assert.equal(resumed.exported, null);

  const exported = await handlers.get(MACHINE_IPC_CHANNELS.exportLatestRun)(event, {
    ...baseRequest,
    runId: 'run_20260430_ipc',
    capabilityToken: 'test-token',
  });
  assert.equal(exported.success, true);
  assert.equal(exported.targetRoot, path.join(pipelineDir, 'harness/generated/latest-run'));
  assert.equal((await fs.stat(path.join(exported.targetRoot, 'run-metadata.json'))).isFile(), true);
});

test('Machine IPC resume reports orphaned adapter recovery as autonomous continuation', async () => {
  const { workspaceRoot, pipelinePath } = await makeWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260430_ipc_orphaned_adapter_resume',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  const itemId = 'ipc-orphaned-adapter-resume';
  await ingestCandidateProposal(created.runRoot, {
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: 'proposal-ipc-orphaned-adapter-resume',
    suggestedWorkItemId: itemId,
    sourceNode: 'probe/ipc-orphaned-adapter',
    title: 'Exercise orphaned adapter recovery',
    fingerprint: 'ipc:orphaned-adapter-resume',
    evidence: [{ id: 'ipc-orphaned-adapter-source', file: 'src/smoke-target.md' }],
    acceptanceCriteria: ['Resume reports recovered adapter work as continuable.'],
    sourceOfTruthTargets: ['src/smoke-target.md'],
  }, {
    runId: created.runId,
    transitionId: 'ingest:ipc-orphaned-adapter-resume',
  });
  await transitionQueueItem(created.runRoot, {
    runId: created.runId,
    itemId,
    toState: 'queued',
    transitionId: 'triage:ipc-orphaned-adapter-resume',
  });
  const claimed = await claimNextQueuedItem(created.runRoot, {
    runId: created.runId,
    claimId: 'claim-ipc-orphaned-adapter-resume',
    leaseMs: 30 * 60 * 1000,
    now: '2026-04-30T00:00:10.000Z',
  });
  assert.equal(claimed.claimed, true);
  await appendRunLifecycleStatus(created.runRoot, {
    runId: created.runId,
    toState: 'running',
    reason: 'test.running-before-orphaned-adapter',
  });
  await appendMachineEvent(created.runRoot, {
    runId: created.runId,
    actor: 'machine',
    eventType: 'node.started',
    nodePath: 'main/worker',
    payload: {
      nodeExecutionId: `${created.runId}:main/worker:attempt-1`,
      nodeType: 'orpad.workerLoop',
      status: 'started',
      attempt: 1,
      itemId,
      claimId: 'claim-ipc-orphaned-adapter-resume',
    },
  });
  await appendMachineEvent(created.runRoot, {
    runId: created.runId,
    timestamp: '2026-04-30T00:00:12.000Z',
    actor: 'machine',
    eventType: 'adapter.requested',
    nodePath: 'main/worker',
    payload: {
      adapter: 'cli-agent-overlay',
      adapterCallId: 'claim-ipc-orphaned-adapter-resume-graph-cli',
      attemptId: 'claim-ipc-orphaned-adapter-resume-graph-cli-attempt-1',
      idempotencyKey: 'claim-ipc-orphaned-adapter-resume-graph-cli:attempt-1',
      taskKind: 'workerLoop',
      workspaceMode: 'read-only-plus-overlay',
      inputArtifacts: [`queue/claimed/${itemId}.json`],
      outputContract: 'orpad.workerResult.v1',
      adapterResultPath: 'adapters/claim-ipc-orphaned-adapter-resume-graph-cli.result.json',
    },
  });
  await appendMachineEvent(created.runRoot, {
    runId: created.runId,
    timestamp: '2026-04-30T00:00:13.000Z',
    actor: 'machine',
    eventType: 'adapter.process.finished',
    nodePath: 'main/worker',
    payload: {
      adapter: 'cli-agent-overlay',
      adapterCallId: 'claim-ipc-orphaned-adapter-resume-graph-cli',
      attemptId: 'claim-ipc-orphaned-adapter-resume-graph-cli-attempt-1',
      idempotencyKey: 'claim-ipc-orphaned-adapter-resume-graph-cli:attempt-1',
      taskKind: 'workerLoop',
      pid: 999999,
      processKey: 'claim-ipc-orphaned-adapter-resume-graph-cli',
      code: 0,
      timedOut: false,
      cancelled: false,
      startedAt: '2026-04-30T00:00:12.000Z',
      finishedAt: '2026-04-30T00:00:13.000Z',
    },
  });

  const resumed = await handlers.get(MACHINE_IPC_CHANNELS.resumeRun)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    exportLatestRun: false,
    now: '2026-04-30T00:03:00.000Z',
  });

  assert.equal(resumed.success, true);
  assert.equal(resumed.runState.lifecycleStatus, 'waiting');
  assert.equal(resumed.resume.staleClaimCount, 1);
  assert.equal(resumed.resume.orphanedAdapterRecoveryCount, 1);
  assert.equal(resumed.resume.shouldContinueAfterRecovery, true);
  assert.equal(resumed.resume.cancelledNodeCount, 1);
  assert.equal((await findQueueItem(created.runRoot, itemId)).state, 'queued');
});

test('Machine IPC snapshots expose active claims and cancel a claimed item', async () => {
  const { workspaceRoot, pipelinePath } = await makeWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const validation = await handlers.get(MACHINE_IPC_CHANNELS.validatePipeline)(event, baseRequest);
  assert.equal(validation.success, true);
  assert.equal(validation.canMachineExecute, true);
  assert.equal(validation.canMachineExecuteStep, false);

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260430_ipc_cancel_claim',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  const candidate = {
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: 'proposal-ipc-cancel-claim',
    suggestedWorkItemId: 'ipc-cancel-claim',
    sourceNode: 'probe/ipc-cancel',
    title: 'Exercise Machine IPC claim cancellation',
    fingerprint: 'ipc-cancel:claim',
    evidence: [{ id: 'ipc-cancel-source', file: 'src/smoke-target.md' }],
    acceptanceCriteria: ['Claim cancellation is Machine-owned.'],
    sourceOfTruthTargets: ['src/smoke-target.md'],
  };
  await ingestCandidateProposal(created.runRoot, candidate, {
    runId: created.runId,
    transitionId: 'ingest:ipc-cancel-claim',
  });
  await transitionQueueItem(created.runRoot, {
    runId: created.runId,
    itemId: 'ipc-cancel-claim',
    toState: 'queued',
    transitionId: 'triage:ipc-cancel-claim',
  });
  const claimed = await claimNextQueuedItem(created.runRoot, {
    runId: created.runId,
    claimId: 'claim-ipc-cancel-claim',
    now: '2026-04-30T00:00:20.000Z',
  });
  assert.equal(claimed.claimed, true);

  const snapshot = await handlers.get(MACHINE_IPC_CHANNELS.getRun)(event, {
    ...baseRequest,
    runId: created.runId,
  });
  assert.equal(snapshot.success, true);
  assert.equal(snapshot.activeClaims.length, 1);
  assert.equal(snapshot.activeClaims[0].claimId, 'claim-ipc-cancel-claim');
  assert.equal(snapshot.activeWriteSets.length, 1);

  const listed = await handlers.get(MACHINE_IPC_CHANNELS.listRuns)(event, baseRequest);
  assert.equal(listed.runs.find(run => run.runId === created.runId).activeClaimCount, 1);

  const invalidClaimId = await handlers.get(MACHINE_IPC_CHANNELS.cancelClaim)(event, {
    ...baseRequest,
    runId: created.runId,
    claimId: '../claim-ipc-cancel-claim',
    itemId: 'ipc-cancel-claim',
    capabilityToken: 'test-token',
  });
  assert.equal(invalidClaimId.success, false);
  assert.equal(invalidClaimId.code, 'MACHINE_IPC_SCHEMA_INVALID');

  const cancelled = await handlers.get(MACHINE_IPC_CHANNELS.cancelClaim)(event, {
    ...baseRequest,
    runId: created.runId,
    claimId: 'claim-ipc-cancel-claim',
    itemId: 'ipc-cancel-claim',
    toState: 'blocked',
    now: '2026-04-30T00:00:30.000Z',
    capabilityToken: 'test-token',
  });
  assert.equal(cancelled.success, true);
  assert.equal(cancelled.runState.lifecycleStatus, 'cancelled');
  assert.equal(cancelled.runState.summaryStatus, 'blocked');
  assert.equal(cancelled.activeClaims.length, 0);
  assert.equal(cancelled.activeWriteSets.length, 0);
  assert.equal(cancelled.cancellation.toState, 'blocked');
  assert.equal((await findQueueItem(created.runRoot, 'ipc-cancel-claim')).state, 'blocked');
  const audit = runMachineAudit(created.runRoot, cancelled.exported.targetRoot);
  assert.equal(audit.exitCode, 0, audit.stderr || audit.stdout);
  assert.equal(audit.json.ok, true);
});

test('Machine IPC snapshots do not follow symlinked artifact summary refs', async t => {
  const { workspaceRoot, pipelinePath } = await makeWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const validation = await handlers.get(MACHINE_IPC_CHANNELS.validatePipeline)(event, baseRequest);
  assert.equal(validation.success, true);
  assert.equal(validation.canMachineExecute, true);
  assert.equal(validation.canMachineExecuteStep, false);

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260430_ipc_symlink_inventory',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-ipc-inventory-outside-'));
  const outsideInventory = path.join(outsideRoot, 'candidate-inventory.json');
  await fs.writeFile(outsideInventory, JSON.stringify({
    candidateCount: 99,
    emptyPassCount: 0,
  }), 'utf8');
  await fs.mkdir(path.join(created.runRoot, 'artifacts/discovery'), { recursive: true });
  const inventoryPath = path.join(created.runRoot, 'artifacts/discovery/candidate-inventory.json');
  if (!await createTestSymlink(t, outsideInventory, inventoryPath, 'file')) return;
  await appendMachineEvent(created.runRoot, {
    runId: created.runId,
    actor: 'machine',
    eventType: 'artifact.registered',
    artifactRefs: ['artifacts/discovery/candidate-inventory.json'],
    payload: {
      file: {
        path: 'artifacts/discovery/candidate-inventory.json',
        schemaVersion: 'orpad.machineCandidateInventory.v1',
        producedBy: 'orpad.machine.candidate-inventory',
      },
    },
  });

  const snapshot = await handlers.get(MACHINE_IPC_CHANNELS.getRun)(event, {
    ...baseRequest,
    runId: created.runId,
  });

  assert.equal(snapshot.success, true);
  assert.equal(snapshot.candidateInventory, null);
});

test('Machine IPC execute step runs dispatcher, worker loop, and CLI overlay adapter with a harness grant', async () => {
  const { workspaceRoot, pipelinePath, pipelineDir } = await makeHarnessWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const validation = await handlers.get(MACHINE_IPC_CHANNELS.validatePipeline)(event, baseRequest);
  assert.equal(validation.success, true);
  assert.equal(validation.canMachineExecute, true);
  assert.equal(validation.canMachineExecuteStep, true);

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

test('Machine IPC PUSH STREAM nudges the requesting renderer after each completed step of an autonomous drive', async () => {
  const { workspaceRoot, pipelinePath } = await makeHarnessWorkspace();
  const captured = [];
  const event = senderEvent();
  // Attach a capturing webContents so the driver's per-step pusher fires.
  event.sender.send = (channel, payload) => captured.push({ channel, payload });
  event.sender.isDestroyed = () => false;
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260601_push_stream',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  // Drive to a human decision — this runs >=1 step inside ONE IPC call, which is
  // exactly when the renderer would otherwise be blind until the invoke resolves.
  const driven = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    options: { runUntil: 'human-decision' },
  });
  assert.equal(driven.success, true);
  assert.ok(driven.drive, 'the human-decision driver ran');

  // At least one machine-run-progress nudge was pushed to the requesting renderer.
  const progress = captured.filter(c => c.channel === MACHINE_RUN_PROGRESS_CHANNEL);
  assert.ok(progress.length >= 1, `expected >=1 progress push, got ${progress.length}`);
  for (const { payload } of progress) {
    assert.equal(payload.runId, created.runId);
    assert.equal(typeof payload.sequence, 'number');
    assert.equal(typeof payload.stepIndex, 'number');
    assert.equal(payload.phase, 'step');
    // The nudge must NOT smuggle full run state — events.jsonl stays the source of
    // truth and the renderer re-fetches via the gated getRun handler.
    assert.equal(payload.events, undefined);
    assert.equal(payload.runState, undefined);
  }
  // Sequences strictly advance across pushes (each push = one event-log advance).
  for (let i = 1; i < progress.length; i += 1) {
    assert.ok(
      progress[i].payload.sequence > progress[i - 1].payload.sequence,
      'event sequence advances per push',
    );
  }
});

test('Machine IPC autonomous drive without a live webContents pushes nothing and still completes (PUSH STREAM gating)', async () => {
  const { workspaceRoot, pipelinePath } = await makeHarnessWorkspace();
  const event = senderEvent(); // the default sender has no .send → pusher is null
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260601_push_stream_nosender',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  const driven = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    options: { runUntil: 'human-decision' },
  });
  // makeRunProgressPusher returns null without a live sender; the drive is unaffected.
  assert.equal(driven.success, true);
  assert.ok(driven.drive, 'the drive completed without a push channel');
});

test('Machine IPC autonomous drive ignores pause intent after terminal completion', async () => {
  const { workspaceRoot, pipelinePath } = await makeHarnessWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };
  const runId = 'run_20260607_pause_after_terminal';
  try {
    const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
      ...baseRequest,
      runId,
      capabilityToken: 'test-token',
    });
    assert.equal(created.success, true);

    const completed = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
      ...baseRequest,
      runId,
      capabilityToken: 'test-token',
      options: { runUntil: 'human-decision' },
    });
    assert.equal(completed.success, true);
    assert.equal(completed.runState.lifecycleStatus, 'completed');

    const pauseIntent = await handlers.get(MACHINE_IPC_CHANNELS.pauseRun)(event, {
      ...baseRequest,
      runId,
      capabilityToken: 'test-token',
    });
    assert.equal(pauseIntent.success, true);

    const redriven = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
      ...baseRequest,
      runId,
      capabilityToken: 'test-token',
      options: { runUntil: 'human-decision' },
    });
    assert.equal(redriven.success, true);
    assert.equal(redriven.drive.stopReason, 'terminal');
    assert.equal(redriven.runState.lifecycleStatus, 'completed');
    assert.equal(redriven.events.some(item => item.eventType === 'run.status' && item.toState === 'paused'), false);
  } finally {
    clearRunControlToken(runId);
  }
});

test('Machine IPC apply patch returns refreshed evidence on base mismatch', async () => {
  const { workspaceRoot, pipelinePath } = await makeHarnessWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260430_ipc_patch_mismatch',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  const executed = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
  });
  assert.equal(executed.success, true);
  const patchArtifact = executed.worker.event.payload.patchArtifact;
  assert.equal(typeof patchArtifact, 'string');
  assert.notEqual(patchArtifact, '');

  await fs.writeFile(path.join(workspaceRoot, 'src/smoke-target.md'), 'changed before review\n', 'utf8');
  const applied = await handlers.get(MACHINE_IPC_CHANNELS.applyPatch)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    patchArtifact,
    selectedFiles: ['src/smoke-target.md'],
  });

  assert.equal(applied.success, false);
  assert.equal(applied.code, 'PATCH_BASE_MISMATCH');
  assert.equal(applied.mismatches[0].path, 'src/smoke-target.md');
  assert.equal(applied.events.at(-1).eventType, 'patch.apply_conflict');
  assert.equal(applied.runState.eventSequence, applied.events.at(-1).sequence);
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'src/smoke-target.md'), 'utf8'), 'changed before review\n');
});

test('Machine IPC approve+applyApproved defers writes until batch and emits sequenced events', async () => {
  const { workspaceRoot, pipelinePath } = await makeHarnessWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };
  const targetPath = path.join(workspaceRoot, 'src/smoke-target.md');

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260504_approve_batch_apply',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  const executed = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
  });
  assert.equal(executed.success, true);
  const patchArtifact = executed.worker.event.payload.patchArtifact;

  const approved = await handlers.get(MACHINE_IPC_CHANNELS.approvePatch)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    patchArtifact,
    selectedFiles: ['src/smoke-target.md'],
  });
  assert.equal(approved.success, true);
  assert.equal(approved.events.at(-1).eventType, 'patch.approved');
  assert.equal(approved.runState.eventSequence, approved.events.at(-1).sequence);
  assert.equal(approved.events.at(-1).payload.patchArtifact, patchArtifact);
  assert.deepEqual(approved.events.at(-1).payload.selectedFiles, ['src/smoke-target.md']);
  assert.equal(await fs.readFile(targetPath, 'utf8'), 'before\n', 'workspace must remain untouched until batch apply runs');

  const reapproved = await handlers.get(MACHINE_IPC_CHANNELS.approvePatch)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    patchArtifact,
    selectedFiles: ['src/smoke-target.md'],
  });
  assert.equal(reapproved.success, true);
  assert.equal(reapproved.idempotent, true, 'duplicate approve clicks with the same selection must not append duplicate events');
  assert.equal(reapproved.decision, 'approved');
  assert.equal(
    reapproved.events.filter(item => item.eventType === 'patch.approved' && item.payload.patchArtifact === patchArtifact).length,
    1,
    'same-selection reapprove keeps the original approval event',
  );

  const applied = await handlers.get(MACHINE_IPC_CHANNELS.applyApprovedPatches)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
  });
  assert.equal(applied.success, true);
  assert.equal(applied.appliedCount, 1);
  assert.equal(applied.conflictCount, 0);
  assert.equal(applied.runState.eventSequence, applied.events.at(-1).sequence);
  assert.equal(await fs.readFile(targetPath, 'utf8'), 'after from Machine IPC harness\n');

  const eventTypes = applied.events.map(item => item.eventType);
  const startedIdx = eventTypes.lastIndexOf('patches.apply_started');
  const finishedIdx = eventTypes.lastIndexOf('patches.apply_finished');
  const appliedIdx = eventTypes.lastIndexOf('patch.applied');
  assert.notEqual(startedIdx, -1);
  assert.notEqual(finishedIdx, -1);
  assert.notEqual(appliedIdx, -1);
  assert.ok(startedIdx < appliedIdx && appliedIdx < finishedIdx, 'patch.applied must sit between apply_started and apply_finished');

  const noop = await handlers.get(MACHINE_IPC_CHANNELS.applyApprovedPatches)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
  });
  assert.equal(noop.success, true);
  assert.equal(noop.appliedCount, 0);
  assert.equal(noop.idempotent, true);

  const reapproveAfterApplied = await handlers.get(MACHINE_IPC_CHANNELS.approvePatch)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    patchArtifact,
    selectedFiles: ['src/smoke-target.md'],
  });
  assert.equal(reapproveAfterApplied.success, true);
  assert.equal(reapproveAfterApplied.idempotent, true, 'already-applied patch must not append a new approval event');
  assert.equal(reapproveAfterApplied.decision, 'applied');
});

test('Machine IPC approve+applyApproved applies reviewable blocked worker patch artifacts', async () => {
  const { workspaceRoot, pipelinePath } = await makeHarnessWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };
  const targetPath = path.join(workspaceRoot, 'src/smoke-target.md');
  const afterContent = 'after from blocked worker review\n';

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260523_blocked_patch_apply',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  const patchArtifact = 'artifacts/patches/blocked-review.patch.json';
  await registerPatchArtifact(created.runRoot, {
    runId: created.runId,
    artifactPath: patchArtifact,
    producedBy: 'test.blocked-worker-review',
    patch: {
      schemaVersion: 'orpad.patchArtifact.v1',
      createdAt: '2026-05-23T00:00:00.000Z',
      allowedFiles: ['src/smoke-target.md'],
      changes: [{
        path: 'src/smoke-target.md',
        beforeExists: true,
        afterExists: true,
        beforeSha256: sha256Text('before\n'),
        afterSha256: sha256Text(afterContent),
        beforeContent: 'before\n',
        afterContent,
      }],
      violations: [],
    },
  });
  await appendMachineEvent(created.runRoot, {
    runId: created.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId: 'ipc-blocked-review',
    reason: 'worker-result.accepted',
    artifactRefs: [patchArtifact],
    payload: {
      claimId: 'claim-ipc-blocked-review',
      status: 'blocked',
      toState: 'blocked',
      patchArtifact,
      changedFiles: ['src/smoke-target.md'],
    },
  });

  const initialReview = patchReviewStateFromEvents(await readMachineEvents(created.runRoot));
  assert.equal(initialReview.required, true);
  assert.equal(initialReview.pendingCount, 1);
  assert.equal(initialReview.autoApplyPendingCount, 0);

  const approved = await handlers.get(MACHINE_IPC_CHANNELS.approvePatch)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    patchArtifact,
    selectedFiles: ['src/smoke-target.md'],
  });
  assert.equal(approved.success, true);
  assert.equal(approved.runState.eventSequence, approved.events.at(-1).sequence);
  assert.equal(await fs.readFile(targetPath, 'utf8'), 'before\n');

  const applied = await handlers.get(MACHINE_IPC_CHANNELS.applyApprovedPatches)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
  });
  assert.equal(applied.success, true);
  assert.equal(applied.appliedCount, 1);
  assert.equal(applied.conflictCount, 0);
  assert.equal(applied.runState.eventSequence, applied.events.at(-1).sequence);
  assert.equal(await fs.readFile(targetPath, 'utf8'), afterContent);
});

test('Machine IPC rejects approval overlap before batch apply creates avoidable conflicts', async () => {
  const { workspaceRoot, pipelinePath } = await makeHarnessWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260508_approve_overlap_guard',
    capabilityToken: 'test-token',
  });
  const executed = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
  });
  const firstPatchArtifact = executed.worker.event.payload.patchArtifact;
  const firstPatchPath = path.join(created.runRoot, ...firstPatchArtifact.split('/'));
  const secondPatchArtifact = 'artifacts/patches/overlap-second.patch.json';
  const secondPatch = JSON.parse(await fs.readFile(firstPatchPath, 'utf8'));
  secondPatch.createdAt = '2026-05-08T00:00:00.000Z';
  secondPatch.changes[0].afterContent = 'second overlapping edit\n';
  secondPatch.changes[0].afterSha256 = sha256Text('second overlapping edit\n');
  await registerPatchArtifact(created.runRoot, {
    runId: created.runId,
    patch: secondPatch,
    artifactPath: secondPatchArtifact,
    producedBy: 'test.overlap-guard',
  });
  await appendMachineEvent(created.runRoot, {
    runId: created.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId: 'ipc-harness-overlap',
    reason: 'worker-result.accepted',
    artifactRefs: [secondPatchArtifact],
    payload: {
      status: 'done',
      toState: 'done',
      patchArtifact: secondPatchArtifact,
      changedFiles: ['src/smoke-target.md'],
      verification: [{ command: 'overlap fixture', status: 'passed' }],
    },
  });

  const firstApproval = await handlers.get(MACHINE_IPC_CHANNELS.approvePatch)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    patchArtifact: firstPatchArtifact,
    selectedFiles: ['src\\smoke-target.md'],
  });
  assert.equal(firstApproval.success, true);
  assert.deepEqual(firstApproval.events.at(-1).payload.selectedFiles, ['src/smoke-target.md']);

  const secondApproval = await handlers.get(MACHINE_IPC_CHANNELS.approvePatch)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    patchArtifact: secondPatchArtifact,
    selectedFiles: ['src/smoke-target.md'],
  });
  assert.equal(secondApproval.success, false);
  assert.equal(secondApproval.code, 'MACHINE_PATCH_APPROVAL_OVERLAP');
  assert.equal(secondApproval.conflicts[0].path, 'src/smoke-target.md');
  assert.equal(
    secondApproval.events.filter(item => item.eventType === 'patch.approved').length,
    1,
    'overlap rejection must not record a second approval event',
  );
});

test('Machine IPC applyApprovedPatches surfaces SHA conflict per patch without aborting batch', async () => {
  const { workspaceRoot, pipelinePath } = await makeHarnessWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };
  const targetPath = path.join(workspaceRoot, 'src/smoke-target.md');

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260504_batch_conflict',
    capabilityToken: 'test-token',
  });
  const executed = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
  });
  const patchArtifact = executed.worker.event.payload.patchArtifact;

  await handlers.get(MACHINE_IPC_CHANNELS.approvePatch)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    patchArtifact,
    selectedFiles: ['src/smoke-target.md'],
  });
  await fs.writeFile(targetPath, 'changed before batch apply\n', 'utf8');

  const applied = await handlers.get(MACHINE_IPC_CHANNELS.applyApprovedPatches)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
  });
  assert.equal(applied.success, true);
  assert.equal(applied.appliedCount, 0);
  assert.equal(applied.conflictCount, 1);
  assert.equal(applied.results[0].ok, false);
  assert.equal(applied.results[0].code, 'PATCH_BASE_MISMATCH');
  assert.equal(applied.results[0].eventType, 'patch.apply_conflict');
  assert.equal(await fs.readFile(targetPath, 'utf8'), 'changed before batch apply\n');

  const eventTypes = applied.events.map(item => item.eventType);
  assert.ok(eventTypes.includes('patches.apply_started'));
  assert.ok(eventTypes.includes('patches.apply_finished'));
  assert.ok(eventTypes.includes('patch.apply_conflict'));
});

test('Machine IPC carries external research mode into selector execution', async () => {
  const { workspaceRoot, pipelinePath, pipelineDir } = await makeHarnessWorkspace();
  const graphPath = path.join(pipelineDir, 'graphs/main.or-graph');
  const graph = JSON.parse(await fs.readFile(graphPath, 'utf8'));
  graph.graph.nodes.unshift({
    id: 'external-research-mode',
    type: 'orpad.selector',
    config: {
      selector: 'externalResearchMode',
      options: ['local-only-research-gap', 'approved-or-attached-evidence'],
      default: 'local-only-research-gap',
    },
  });
  await fs.writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };
  const externalResearch = {
    schemaVersion: 'orpad.externalResearchRun.v1',
    intentDetected: true,
    mode: 'local-only-research-gap',
  };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260430_ipc_external_research_selector',
    capabilityToken: 'test-token',
    options: {
      taskText: 'Search for competing products and verify benchmarks.',
      externalResearch,
    },
  });
  assert.equal(created.success, true);
  assert.equal(created.runState.metadata.externalResearch.mode, 'local-only-research-gap');

  const executed = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    exportLatestRun: false,
    options: {
      taskText: 'Search for competing products and verify benchmarks.',
      externalResearch,
    },
  });
  assert.equal(executed.success, true, executed.error);
  const selectorEvent = executed.events.find(item => (
    item.eventType === 'node.completed'
    && item.nodePath === 'main/external-research-mode'
  ));
  assert.equal(selectorEvent?.payload?.selectedRoute, 'local-only-research-gap');
  assert.equal(selectorEvent?.payload?.source, 'user-prelaunch-choice');
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
  assert.equal(executed.runState.summaryStatus, 'partial');
  assert.equal(executed.finalization.summaryStatus, 'partial');
  assert.equal(executed.finalization.approvalRequired, true);
  assert.equal(executed.worker, null);

  const snapshot = await handlers.get(MACHINE_IPC_CHANNELS.getRun)(event, {
    ...baseRequest,
    runId: created.runId,
  });
  assert.equal(snapshot.runState.lifecycleStatus, 'approval-required');
  assert.equal(snapshot.runState.summaryStatus, 'partial');
  assert.equal(snapshot.approvals.pendingCount, 1);
  assert.equal(snapshot.approvals.pending[0].status, 'requested');

  const resumePending = await handlers.get(MACHINE_IPC_CHANNELS.resumeRun)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
  });
  assert.equal(resumePending.success, false);
  assert.equal(resumePending.code, 'MACHINE_APPROVAL_PENDING');
  assert.equal(resumePending.runState.lifecycleStatus, 'approval-required');
  assert.equal(resumePending.runState.summaryStatus, 'partial');
  assert.equal(resumePending.approvals.pendingCount, 1);

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

test('Machine IPC autonomous run auto-approves bypassable approvals and stops at patch review', async () => {
  const { workspaceRoot, pipelinePath, pipelineDir } = await makeHarnessWorkspace();
  const source = JSON.parse(await fs.readFile(pipelinePath, 'utf8'));
  source.run.machineHarness.candidateProposal.approvalRequired = true;
  await fs.writeFile(pipelinePath, `${JSON.stringify(source, null, 2)}\n`, 'utf8');
  await updateHarnessGraphNodeConfig(pipelineDir, 'worker', { reviewRequired: true });
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260512_ipc_autonomous_bypass',
    capabilityToken: 'test-token',
    options: { llmApprovalMode: 'bypass' },
  });
  assert.equal(created.success, true);
  assert.equal(created.runState.metadata.llmApprovalMode, 'bypass');

  const executed = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    options: {
      llmApprovalMode: 'bypass',
      runUntil: 'human-decision',
    },
  });

  assert.equal(executed.success, true);
  assert.equal(executed.drive.mode, 'human-decision');
  assert.equal(executed.drive.stopReason, 'patch-review');
  assert.equal(executed.drive.stepsRun, 2);
  assert.equal(executed.drive.autoApprovedApprovalCount, 1);
  assert.equal(executed.approvals.pendingCount, 0);
  assert.equal(executed.approvals.all[0].status, 'approved');
  assert.equal(executed.events.some(item => item.eventType === 'approval.decided' && item.reason === 'machine-autonomous.approval.bypass'), true);
  assert.equal(executed.worker.event.payload.status, 'done');
  assert.ok(executed.worker.event.payload.patchArtifact, 'autonomous run should stop with a patch ready for user review');
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'src/smoke-target.md'), 'utf8'), 'before\n');
});

test('Machine IPC autonomous run with patchReviewMode auto-apply approves and applies pending patches without halting', async () => {
  const { workspaceRoot, pipelinePath, pipelineDir } = await makeHarnessWorkspace();
  await updateHarnessGraphNodeConfig(pipelineDir, 'worker', { reviewRequired: true });
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260516_ipc_auto_apply_patches',
    capabilityToken: 'test-token',
    options: { llmApprovalMode: 'bypass' },
  });
  assert.equal(created.success, true);

  const executed = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    options: {
      llmApprovalMode: 'bypass',
      runUntil: 'human-decision',
      patchReviewMode: 'auto-apply',
    },
  });

  assert.equal(executed.success, true);
  assert.equal(executed.drive.mode, 'human-decision');
  assert.notEqual(executed.drive.stopReason, 'patch-review', 'auto-apply must clear patch-review without halting');
  assert.equal(executed.drive.autoAppliedPatchCount, 1);
  assert.equal(executed.drive.autoApplyConflictCount, 0);
  assert.equal(executed.drive.autoAppliedPatches[0].patchArtifact.endsWith('.patch.json'), true);
  assert.equal(executed.runState.eventSequence, executed.events.at(-1).sequence);

  const eventTypes = executed.events.map(item => item.eventType);
  assert.ok(eventTypes.includes('patch.approved'), 'driver emits patch.approved');
  assert.ok(eventTypes.includes('patches.apply_started'), 'driver emits patches.apply_started');
  assert.ok(eventTypes.includes('patch.applied'), 'driver emits patch.applied');
  assert.ok(eventTypes.includes('patches.apply_finished'), 'driver emits patches.apply_finished');

  const driverPatchEvents = executed.events.filter(item => (
    item.actor === 'machine-autonomous-driver'
    && ['patch.approved', 'patch.applied', 'patches.apply_started', 'patches.apply_finished'].includes(item.eventType)
  ));
  assert.ok(driverPatchEvents.length >= 4, 'patch lifecycle events are attributed to the autonomous driver');

  const after = await fs.readFile(path.join(workspaceRoot, 'src/smoke-target.md'), 'utf8');
  assert.equal(after, 'after from Machine IPC harness\n');
});

test('Machine IPC autonomous run with patchReviewMode auto-apply applies routine auto-pending patches', async () => {
  const { workspaceRoot, pipelinePath } = await makeHarnessWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260521_ipc_auto_apply_routine_patches',
    capabilityToken: 'test-token',
    options: { llmApprovalMode: 'bypass' },
  });
  assert.equal(created.success, true);

  const executed = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    options: {
      llmApprovalMode: 'bypass',
      runUntil: 'human-decision',
      patchReviewMode: 'auto-apply',
    },
  });

  assert.equal(executed.success, true);
  assert.equal(executed.drive.mode, 'human-decision');
  assert.equal(executed.drive.autoAppliedPatchCount, 1);
  assert.notEqual(executed.drive.stopReason, 'patch-review');
  assert.equal(executed.runState.eventSequence, executed.events.at(-1).sequence);
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'src/smoke-target.md'), 'utf8'), 'after from Machine IPC harness\n');

  const review = patchReviewStateFromEvents(await readMachineEvents(path.join(path.dirname(pipelinePath), 'runs', created.runId)));
  assert.equal(review.autoApplyPendingCount, 0);
  assert.equal(review.appliedCount, 1);
});

test('Machine IPC executeRunStep inherits auto patch mode from run metadata', async () => {
  const { workspaceRoot, pipelinePath } = await makeHarnessWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260521_ipc_inherits_auto_patch_mode',
    capabilityToken: 'test-token',
    options: {
      llmApprovalMode: 'bypass',
      patchReviewMode: 'auto-apply',
    },
  });
  assert.equal(created.success, true);
  assert.equal(created.runState.metadata.patchReviewMode, 'auto-apply');

  const executed = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    options: {
      runUntil: 'human-decision',
    },
  });

  assert.equal(executed.success, true);
  assert.equal(executed.drive.autoAppliedPatchCount, 1);
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'src/smoke-target.md'), 'utf8'), 'after from Machine IPC harness\n');
  const review = patchReviewStateFromEvents(await readMachineEvents(path.join(path.dirname(pipelinePath), 'runs', created.runId)));
  assert.equal(review.autoApplyPendingCount, 0);
});

test('Machine IPC auto-apply records preflight base mismatches as patch conflicts', async () => {
  const { workspaceRoot, pipelinePath } = await makeWorkspace();
  await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'src/smoke-target.md'), 'before\n', 'utf8');
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260521_ipc_auto_apply_preflight_conflict',
    capabilityToken: 'test-token',
    options: {
      llmApprovalMode: 'bypass',
      patchReviewMode: 'auto-apply',
    },
  });
  assert.equal(created.success, true);

  const patch = {
    schemaVersion: 'orpad.patchArtifact.v1',
    createdAt: new Date('2026-05-21T00:00:00.000Z').toISOString(),
    allowedFiles: ['src/smoke-target.md'],
    changes: [{
      path: 'src/smoke-target.md',
      beforeContent: 'before\n',
      afterContent: 'after\n',
      beforeSha256: sha256Text('before\n'),
      afterSha256: sha256Text('after\n'),
      beforeExists: true,
      afterExists: true,
    }],
    violations: [],
  };
  const registered = await registerPatchArtifact(created.runRoot, {
    runId: created.runId,
    patch,
    artifactPath: 'artifacts/patches/preflight-conflict.patch.json',
    producedBy: 'test.auto-apply-preflight',
  });
  await appendMachineEvent(created.runRoot, {
    runId: created.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId: 'preflight-conflict',
    reason: 'worker-result.accepted',
    artifactRefs: [registered.file.path],
    payload: {
      status: 'done',
      toState: 'done',
      patchArtifact: registered.file.path,
      changedFiles: ['src/smoke-target.md'],
      declaredTargetFiles: ['src/smoke-target.md'],
      lockTargetFiles: ['src/smoke-target.md'],
      reviewRequired: false,
      verification: [{ writeSetViolationCount: 0 }],
    },
  });
  await appendRunLifecycleStatus(created.runRoot, {
    runId: created.runId,
    toState: 'waiting',
    reason: 'test.waiting-with-auto-pending-patch',
  });
  await fs.writeFile(path.join(workspaceRoot, 'src/smoke-target.md'), 'changed outside\n', 'utf8');

  const executed = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    options: {
      runUntil: 'human-decision',
    },
  });

  assert.equal(executed.success, true);
  assert.equal(executed.drive.autoAppliedPatchCount, 0);
  assert.equal(executed.drive.autoApplyConflictCount, 1);
  assert.equal(executed.runState.eventSequence, executed.events.at(-1).sequence);
  const events = await readMachineEvents(created.runRoot);
  assert.equal(events.some(item => (
    item.eventType === 'patch.apply_conflict'
    && item.payload?.patchArtifact === registered.file.path
    && item.payload?.code === 'PATCH_BASE_MISMATCH'
  )), true);
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'src/smoke-target.md'), 'utf8'), 'changed outside\n');
});

test('Machine IPC autonomous run continues after routine pending-patch overlap without a second Continue', async () => {
  const { workspaceRoot, pipelinePath, pipelineDir } = await makeHarnessWorkspace();
  await updateHarnessGraphNodeConfig(pipelineDir, 'worker', { targetFiles: ['src/smoke-target.md'] });
  await appendHarnessPatchReviewNode(pipelineDir);
  const pipeline = JSON.parse(await fs.readFile(pipelinePath, 'utf8'));
  const first = pipeline.run.machineHarness.candidateProposal;
  pipeline.run.machineHarness.candidateProposals = [
    first,
    {
      ...first,
      proposalId: 'proposal-ipc-harness-smoke-second',
      suggestedWorkItemId: 'ipc-harness-smoke-second',
      title: 'Exercise Machine IPC worker execution again',
      fingerprint: 'ipc-harness:src/smoke-target.md:second',
    },
  ];
  delete pipeline.run.machineHarness.candidateProposal;
  await fs.writeFile(pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`, 'utf8');

  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260520_ipc_pending_patch_overlap_continues',
    capabilityToken: 'test-token',
    options: { llmApprovalMode: 'bypass' },
  });
  assert.equal(created.success, true);

  const executed = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    options: {
      llmApprovalMode: 'bypass',
      runUntil: 'human-decision',
      patchReviewMode: 'auto-apply',
      maxAutonomousSteps: 5,
    },
  });

  assert.equal(executed.success, true);
  assert.equal(executed.drive.mode, 'human-decision');
  assert.ok(executed.drive.stepsRun >= 2, 'one IPC call should drive the step after pending-patch-overlap resolution');
  assert.notEqual(executed.drive.stopReason, 'patch-review');
  assert.equal(executed.events.some(event => (
    event.eventType === 'patch.applied'
    && event.reason === 'machine.patch-review.auto-apply-routine'
  )), true);
  assert.equal(executed.events.some(event => (
    event.eventType === 'worker.result'
    && event.itemId === 'ipc-harness-smoke-second'
  )), true);

  const firstItem = await findQueueItem(path.join(path.dirname(pipelinePath), 'runs', created.runId), 'ipc-harness-smoke');
  const secondItem = await findQueueItem(path.join(path.dirname(pipelinePath), 'runs', created.runId), 'ipc-harness-smoke-second');
  assert.equal(firstItem.state, 'done');
  assert.notEqual(secondItem.state, 'queued');
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'src/smoke-target.md'), 'utf8'), 'after from Machine IPC harness\n');
});

test('Machine IPC denied approval decisions cancel blocked work without grants', async () => {
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
    runId: 'run_20260430_ipc_harness_approval_denied',
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
  assert.equal(executed.approvals.pending[0].approvalId, 'approval-ipc-harness-smoke');
  assert.equal(executed.runState.lifecycleStatus, 'approval-required');
  assert.equal(executed.runState.summaryStatus, 'partial');
  assert.equal(executed.worker, null);

  const denied = await handlers.get(MACHINE_IPC_CHANNELS.decideApproval)(event, {
    ...baseRequest,
    runId: created.runId,
    approvalId: 'approval-ipc-harness-smoke',
    decision: 'denied',
    capabilityToken: 'test-token',
  });
  assert.equal(denied.success, true);
  assert.deepEqual(denied.grants, []);
  assert.equal(denied.approvals.pendingCount, 0);
  assert.equal(denied.approvals.all[0].status, 'denied');
  assert.equal(denied.runState.lifecycleStatus, 'cancelled');
  assert.equal(denied.runState.summaryStatus, 'blocked');

  const listed = await handlers.get(MACHINE_IPC_CHANNELS.listRuns)(event, baseRequest);
  const listedRun = listed.runs.find(run => run.runId === created.runId);
  assert.equal(listedRun.pendingApprovalCount, 0);

  const resumeDenied = await handlers.get(MACHINE_IPC_CHANNELS.resumeRun)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
  });
  assert.equal(resumeDenied.success, false);
  assert.equal(resumeDenied.code, 'MACHINE_RUN_TERMINAL');
  assert.equal(resumeDenied.runState.lifecycleStatus, 'cancelled');
  assert.equal(resumeDenied.runState.summaryStatus, 'blocked');

  const executeDenied = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
  });
  assert.equal(executeDenied.success, false);
  assert.equal(executeDenied.code, 'MACHINE_RUN_TERMINAL');
  assert.equal(executeDenied.runState.lifecycleStatus, 'cancelled');
  assert.equal(executeDenied.runState.summaryStatus, 'blocked');
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'src/smoke-target.md'), 'utf8'), 'before\n');
});

test('Machine IPC rejects concurrent executeRunStep calls with MACHINE_RUN_BUSY', async () => {
  const { workspaceRoot, pipelinePath } = await makeHarnessWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260507_busy_guard',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  // Fire two executeRunStep calls back-to-back. The first acquires the
  // lifecycle lock; the second must reject with MACHINE_RUN_BUSY rather
  // than queue silently and corrupt run-state.json.
  const first = handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
  });
  const second = handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
  });

  const [firstResult, secondResult] = await Promise.all([first, second]);
  // Exactly one of the two must observe MACHINE_RUN_BUSY; the other must
  // succeed. Promise.all does not guarantee enqueue order on its own, so we
  // assert the disjunction instead of pinning ordering.
  const busy = [firstResult, secondResult].find(r => r.code === 'MACHINE_RUN_BUSY');
  const succeeded = [firstResult, secondResult].find(r => r.success === true);
  assert.ok(busy, 'expected MACHINE_RUN_BUSY rejection on concurrent executeRunStep');
  assert.ok(succeeded, 'expected one executeRunStep to succeed');
  assert.equal(busy.success, false);
  assert.equal(busy.ok, false);
});

test('Machine IPC retryNode appends node.scheduled at attempt N+1 to invalidate prior node.completed', async () => {
  const { workspaceRoot, pipelinePath } = await makeWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260507_retry_node',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  // Seed history: a probe completed at attempt 1 (the wrapper finished
  // successfully, even though the wrapped adapter result might have
  // returned status='failed'). retryNode must invalidate it.
  const { recordNodeLifecycleEvent } = require('../../src/main/orchestration-machine');
  await recordNodeLifecycleEvent(created.runRoot, {
    runId: created.runId,
    nodePath: 'main/probe',
    nodeType: 'orpad.probe',
    status: 'started',
    attempt: 1,
  });
  await recordNodeLifecycleEvent(created.runRoot, {
    runId: created.runId,
    nodePath: 'main/probe',
    nodeType: 'orpad.probe',
    status: 'completed',
    attempt: 1,
  });

  const retried = await handlers.get(MACHINE_IPC_CHANNELS.retryNode)(event, {
    ...baseRequest,
    runId: created.runId,
    nodePath: 'main/probe',
    nodeType: 'orpad.probe',
    capabilityToken: 'test-token',
  });
  assert.equal(retried.success, true);
  assert.equal(retried.attempt, 2);
  // The latest node.* event for the path is now node.scheduled — the
  // dispatcher's latestNodeResolvedEvent will return null and re-run.
  const snapshot = await handlers.get(MACHINE_IPC_CHANNELS.getRun)(event, {
    ...baseRequest,
    runId: created.runId,
  });
  const nodeEvents = snapshot.events.filter(e => (e.nodePath || '') === 'main/probe' && String(e.eventType).startsWith('node.'));
  const latest = nodeEvents[nodeEvents.length - 1];
  assert.equal(latest.eventType, 'node.scheduled');
  assert.equal(latest.payload.attempt, 2);
  assert.equal(latest.payload.reason, 'user-retry-requested');
});

test('Machine IPC retryNode requeues active worker claims after a failed worker attempt', async () => {
  const { workspaceRoot, pipelinePath } = await makeWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260519_retry_worker_requeues_claim',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  const candidate = {
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: 'proposal-retry-worker-requeue',
    suggestedWorkItemId: 'retry-worker-requeue',
    sourceNode: 'probe/retry-worker',
    title: 'Exercise worker retry requeue',
    fingerprint: 'retry-worker:claim',
    evidence: [{ id: 'retry-worker-source', file: 'src/smoke-target.md' }],
    acceptanceCriteria: ['Worker retry requeues the claimed item.'],
    sourceOfTruthTargets: ['src/smoke-target.md'],
  };
  await ingestCandidateProposal(created.runRoot, candidate, {
    runId: created.runId,
    transitionId: 'ingest:retry-worker-requeue',
  });
  await transitionQueueItem(created.runRoot, {
    runId: created.runId,
    itemId: 'retry-worker-requeue',
    toState: 'queued',
    transitionId: 'triage:retry-worker-requeue',
  });
  const claimed = await claimNextQueuedItem(created.runRoot, {
    runId: created.runId,
    claimId: 'claim-retry-worker-requeue',
    now: '2999-01-01T00:00:00.000Z',
    leaseMs: 60 * 60 * 1000,
  });
  assert.equal(claimed.claimed, true);
  await appendRunLifecycleStatus(created.runRoot, {
    runId: created.runId,
    toState: 'waiting',
    reason: 'test.worker-failed',
  });

  const retried = await handlers.get(MACHINE_IPC_CHANNELS.retryNode)(event, {
    ...baseRequest,
    runId: created.runId,
    nodePath: 'main/worker',
    nodeType: 'orpad.workerLoop',
    capabilityToken: 'test-token',
  });
  assert.equal(retried.success, true);
  assert.equal(retried.recoveredClaimCount, 1);
  assert.equal((await findQueueItem(created.runRoot, 'retry-worker-requeue')).state, 'queued');

  const snapshot = await handlers.get(MACHINE_IPC_CHANNELS.getRun)(event, {
    ...baseRequest,
    runId: created.runId,
  });
  assert.equal(snapshot.activeClaims.length, 0);
});

test('Machine IPC retryNode requeues a blocked worker item when itemId is provided', async () => {
  const { workspaceRoot, pipelinePath } = await makeWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260519_retry_worker_requeues_blocked_item',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  await ingestCandidateProposal(created.runRoot, {
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: 'proposal-retry-worker-blocked',
    suggestedWorkItemId: 'retry-worker-blocked',
    sourceNode: 'probe/retry-worker',
    title: 'Exercise blocked worker retry',
    fingerprint: 'retry-worker:blocked',
    evidence: [{ id: 'retry-worker-source', file: 'src/smoke-target.md' }],
    acceptanceCriteria: ['Blocked worker retry returns the item to queued.'],
    sourceOfTruthTargets: ['src/smoke-target.md'],
  }, {
    runId: created.runId,
    transitionId: 'ingest:retry-worker-blocked',
  });
  await transitionQueueItem(created.runRoot, {
    runId: created.runId,
    itemId: 'retry-worker-blocked',
    toState: 'blocked',
    reason: 'test.worker-blocked',
    transitionId: 'block:retry-worker-blocked',
  });
  await appendMachineEvent(created.runRoot, {
    runId: created.runId,
    actor: 'machine',
    nodePath: 'main/worker',
    eventType: 'node.completed',
    payload: {
      nodeType: 'orpad.workerLoop',
      status: 'completed',
      attempt: 1,
      workerStatus: 'blocked',
      itemId: 'retry-worker-blocked',
    },
  });

  const retried = await handlers.get(MACHINE_IPC_CHANNELS.retryNode)(event, {
    ...baseRequest,
    runId: created.runId,
    nodePath: 'main/worker',
    nodeType: 'orpad.workerLoop',
    itemId: 'retry-worker-blocked',
    capabilityToken: 'test-token',
  });
  assert.equal(retried.success, true);
  assert.equal(retried.requeuedBlockedItemId, 'retry-worker-blocked');
  assert.equal((await findQueueItem(created.runRoot, 'retry-worker-blocked')).state, 'queued');
});

test('Machine IPC retryNode requeues a done worker item when itemId is provided', async () => {
  const { workspaceRoot, pipelinePath } = await makeWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260519_retry_worker_requeues_done_item',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  await ingestCandidateProposal(created.runRoot, {
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: 'proposal-retry-worker-done',
    suggestedWorkItemId: 'retry-worker-done',
    sourceNode: 'probe/retry-worker',
    title: 'Exercise done worker retry',
    fingerprint: 'retry-worker:done',
    evidence: [{ id: 'retry-worker-source', file: 'src/smoke-target.md' }],
    acceptanceCriteria: ['Done worker retry returns the item to queued.'],
    sourceOfTruthTargets: ['src/smoke-target.md'],
  }, {
    runId: created.runId,
    transitionId: 'ingest:retry-worker-done',
  });
  await transitionQueueItem(created.runRoot, {
    runId: created.runId,
    itemId: 'retry-worker-done',
    toState: 'queued',
    transitionId: 'triage:retry-worker-done',
  });
  await transitionQueueItem(created.runRoot, {
    runId: created.runId,
    itemId: 'retry-worker-done',
    toState: 'claimed',
    transitionId: 'claim:retry-worker-done',
    itemPatch: {
      claimId: 'claim-retry-worker-done',
      claimedBy: 'test-worker',
    },
  });
  await transitionQueueItem(created.runRoot, {
    runId: created.runId,
    itemId: 'retry-worker-done',
    toState: 'done',
    transitionId: 'done:retry-worker-done',
    itemPatch: {
      closedByClaimId: 'claim-retry-worker-done',
      workerResultStatus: 'done',
    },
  });

  const retried = await handlers.get(MACHINE_IPC_CHANNELS.retryNode)(event, {
    ...baseRequest,
    runId: created.runId,
    nodePath: 'main/worker',
    nodeType: 'orpad.workerLoop',
    itemId: 'retry-worker-done',
    capabilityToken: 'test-token',
  });
  assert.equal(retried.success, true);
  assert.equal(retried.requeuedBlockedItemId, 'retry-worker-done');
  const stored = await findQueueItem(created.runRoot, 'retry-worker-done');
  assert.equal(stored.state, 'queued');
  assert.equal(stored.item.claimId, undefined);
  assert.equal(stored.item.closedByClaimId, undefined);
  assert.equal(stored.item.workerResultStatus, undefined);
});

test('Machine IPC retryNode rejects when nodePath is missing', async () => {
  const { workspaceRoot, pipelinePath } = await makeWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260507_retry_node_missing',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  const rejected = await handlers.get(MACHINE_IPC_CHANNELS.retryNode)(event, {
    ...baseRequest,
    runId: created.runId,
    capabilityToken: 'test-token',
    // nodePath intentionally omitted
  });
  assert.equal(rejected.success, false);
  assert.equal(rejected.code, 'MACHINE_IPC_NODE_PATH_REQUIRED');
});

// ---------------------------------------------------------------------------
// RC-IPC: supervised-autonomy pause / resume / cancel-intent over IPC.
// These exercise the channels exposed in this increment on top of RC-1's
// run-control core. The pre-existing autonomous auto-approve / auto-apply tests
// above double as the regression guard that, with NO control token set, the
// driver boundary check is a no-op.
// ---------------------------------------------------------------------------

test('Machine IPC pause records intent + token and the autonomous driver suspends at the next step boundary', async () => {
  const { workspaceRoot, pipelinePath } = await makeHarnessWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };
  const runId = 'run_20260531_rcipc_pause';
  try {
    const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
      ...baseRequest,
      runId,
      capabilityToken: 'test-token',
      options: { llmApprovalMode: 'bypass' },
    });
    assert.equal(created.success, true);

    // Request pause BEFORE driving. The in-process token is set synchronously,
    // so the very first driver boundary observes it and suspends with zero steps
    // run — in-flight work is never interrupted.
    const paused = await handlers.get(MACHINE_IPC_CHANNELS.pauseRun)(event, {
      ...baseRequest,
      runId,
      capabilityToken: 'test-token',
    });
    assert.equal(paused.success, true);
    assert.equal(paused.pause.intent.present, true);
    assert.equal(paused.pause.intent.pauseRequested, true);
    assert.equal(paused.events.some(e => e.eventType === 'run.pause-requested'), true);

    const executed = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
      ...baseRequest,
      runId,
      capabilityToken: 'test-token',
      options: { llmApprovalMode: 'bypass', runUntil: 'human-decision' },
    });
    assert.equal(executed.success, true);
    assert.equal(executed.drive.mode, 'human-decision');
    assert.equal(executed.drive.stopReason, 'paused');
    assert.equal(executed.drive.stepsRun, 0, 'driver halts at the boundary before running any step');
    assert.equal(executed.runState.lifecycleStatus, 'paused');
    assert.equal(executed.events.some(e => e.eventType === 'run.status' && e.toState === 'paused'), true);
  } finally {
    clearRunControlToken(runId);
  }
});

test('Machine IPC resume of a paused run clears intent, returns to waiting, and the driver re-advances to its real decision point', async () => {
  const { workspaceRoot, pipelinePath, pipelineDir } = await makeHarnessWorkspace();
  // reviewRequired makes the worker stop at a patch-review decision, giving the
  // run GENUINE pending work to preserve across the pause/resume round-trip.
  await updateHarnessGraphNodeConfig(pipelineDir, 'worker', { reviewRequired: true });
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };
  const runId = 'run_20260531_rcipc_resume';
  try {
    const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
      ...baseRequest,
      runId,
      capabilityToken: 'test-token',
      options: { llmApprovalMode: 'bypass' },
    });
    assert.equal(created.success, true);

    // Prime via a single step-mode call (token-agnostic) so the run reaches a
    // realistic mid-flight state: waiting with a pending patch review.
    const primed = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
      ...baseRequest,
      runId,
      capabilityToken: 'test-token',
      options: { llmApprovalMode: 'bypass' },
    });
    assert.equal(primed.runState.lifecycleStatus, 'waiting');

    // Pause, then drive: the boundary check halts the run with its pending work
    // intact, taking precedence over the pending patch-review decision.
    await handlers.get(MACHINE_IPC_CHANNELS.pauseRun)(event, {
      ...baseRequest,
      runId,
      capabilityToken: 'test-token',
    });
    const drivenPaused = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
      ...baseRequest,
      runId,
      capabilityToken: 'test-token',
      options: { llmApprovalMode: 'bypass', runUntil: 'human-decision' },
    });
    assert.equal(drivenPaused.drive.stopReason, 'paused');
    assert.equal(drivenPaused.runState.lifecycleStatus, 'paused');

    // machine-resume-run is unified: a paused run takes the RC path
    // (clear token + run.resume-requested + paused -> waiting); a non-paused run
    // keeps the original idle-recovery behavior.
    const resumed = await handlers.get(MACHINE_IPC_CHANNELS.resumeRun)(event, {
      ...baseRequest,
      runId,
      capabilityToken: 'test-token',
    });
    assert.equal(resumed.success, true);
    assert.equal(resumed.resume.pausedResume, true, 'resume took the RC (paused) path');
    assert.equal(resumed.runState.lifecycleStatus, 'waiting');
    assert.equal(resumed.events.some(e => e.eventType === 'run.resume-requested'), true);
    // The in-process pause token is cleared so the re-entering driver does not re-pause.
    assert.equal(readRunControlToken(runId).pauseRequested, false);

    // Re-drive: the resumed run is NOT stuck paused — it re-advances to surface
    // its genuine pending decision (patch-review), exactly where it left off.
    const reDriven = await handlers.get(MACHINE_IPC_CHANNELS.executeRunStep)(event, {
      ...baseRequest,
      runId,
      capabilityToken: 'test-token',
      options: { llmApprovalMode: 'bypass', runUntil: 'human-decision' },
    });
    assert.equal(reDriven.success, true);
    assert.notEqual(reDriven.drive.stopReason, 'paused', 'cleared pause intent must not re-pause the resumed run');
    assert.equal(reDriven.drive.stopReason, 'patch-review', 'resume restores the run to its real decision point');
    assert.notEqual(reDriven.runState.lifecycleStatus, 'paused');
  } finally {
    clearRunControlToken(runId);
  }
});

test('Machine IPC cancel records run.cancel-requested intent before the cancelled ack', async () => {
  const { workspaceRoot, pipelinePath } = await makeWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };
  const runId = 'run_20260531_rcipc_cancel_intent';
  try {
    const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
      ...baseRequest,
      runId,
      capabilityToken: 'test-token',
    });
    assert.equal(created.success, true);

    const cancelled = await handlers.get(MACHINE_IPC_CHANNELS.cancelRun)(event, {
      ...baseRequest,
      runId,
      capabilityToken: 'test-token',
    });
    assert.equal(cancelled.success, true);
    assert.equal(cancelled.runState.lifecycleStatus, 'cancelled');

    const events = cancelled.events;
    const intentIdx = events.findIndex(e => e.eventType === 'run.cancel-requested');
    const ackIdx = events.findIndex(e => e.eventType === 'run.status' && e.toState === 'cancelled');
    assert.ok(intentIdx >= 0, 'cancel records a durable run.cancel-requested intent');
    assert.ok(ackIdx >= 0, 'cancel still records the cancelled lifecycle ack');
    assert.ok(intentIdx < ackIdx, 'intent-then-ack: cancel intent precedes the cancelled status');
    assert.equal(readRunControlToken(runId).cancelRequested, true);
  } finally {
    clearRunControlToken(runId);
  }
});

test('Machine IPC reject-item rejects a pending queue item via a replayable queue.transition (STEER)', async () => {
  const { workspaceRoot, pipelinePath } = await makeWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260601_steer_reject',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  await ingestCandidateProposal(created.runRoot, {
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: 'proposal-steer-reject',
    suggestedWorkItemId: 'steer-reject-item',
    sourceNode: 'probe/steer',
    title: 'Exercise STEER reject',
    fingerprint: 'steer:reject',
    evidence: [{ id: 'steer-src', file: 'src/smoke-target.md' }],
    acceptanceCriteria: ['Reject is a Machine-owned queue transition.'],
    sourceOfTruthTargets: ['src/smoke-target.md'],
  }, { runId: created.runId, transitionId: 'ingest:steer-reject' });
  await transitionQueueItem(created.runRoot, {
    runId: created.runId,
    itemId: 'steer-reject-item',
    toState: 'queued',
    transitionId: 'triage:steer-reject',
  });

  // Mutating op requires a capability token.
  const denied = await handlers.get(MACHINE_IPC_CHANNELS.rejectItem)(event, {
    ...baseRequest,
    runId: created.runId,
    itemId: 'steer-reject-item',
  });
  assert.equal(denied.success, false);

  // Unknown item is reported, not silently ignored.
  const missing = await handlers.get(MACHINE_IPC_CHANNELS.rejectItem)(event, {
    ...baseRequest,
    runId: created.runId,
    itemId: 'no-such-item',
    capabilityToken: 'test-token',
  });
  assert.equal(missing.success, false);
  assert.equal(missing.code, 'MACHINE_QUEUE_ITEM_NOT_FOUND');

  // Reject the queued item.
  const rejected = await handlers.get(MACHINE_IPC_CHANNELS.rejectItem)(event, {
    ...baseRequest,
    runId: created.runId,
    itemId: 'steer-reject-item',
    capabilityToken: 'test-token',
  });
  assert.equal(rejected.success, true);
  assert.equal(rejected.steer.op, 'reject');
  assert.equal(rejected.steer.fromState, 'queued');

  const item = await findQueueItem(created.runRoot, 'steer-reject-item', { canonicalOnly: false });
  assert.equal(item.item.state, 'rejected', 'the item is now rejected');
  const events = await readMachineEvents(created.runRoot);
  assert.equal(
    events.some(e => e.eventType === 'queue.transition' && e.toState === 'rejected'
      && (e.itemId === 'steer-reject-item' || e.payload?.itemId === 'steer-reject-item')),
    true,
    'reject is a standard queue.transition (replayable)',
  );

  // An already-rejected item is not re-rejectable (state gate).
  const again = await handlers.get(MACHINE_IPC_CHANNELS.rejectItem)(event, {
    ...baseRequest,
    runId: created.runId,
    itemId: 'steer-reject-item',
    capabilityToken: 'test-token',
  });
  assert.equal(again.success, false);
  assert.equal(again.code, 'MACHINE_STEER_NOT_REJECTABLE');
});

test('Machine IPC reprioritize-item pulls a queued item to the front of the dispatcher claim order (STEER)', async () => {
  const { workspaceRoot, pipelinePath } = await makeWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260601_steer_reprioritize',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  // Two queued items: A is higher severity (P0 -> claimed first by default), B is P3.
  for (const [id, severity] of [['steer-item-a', 'P0'], ['steer-item-b', 'P3']]) {
    await ingestCandidateProposal(created.runRoot, {
      schemaVersion: 'orpad.candidateProposal.v1',
      proposalId: `proposal-${id}`,
      suggestedWorkItemId: id,
      sourceNode: 'probe/steer',
      title: `Item ${id}`,
      fingerprint: `steer:${id}`,
      severity,
      evidence: [{ id: `${id}-src`, file: 'src/smoke-target.md' }],
      acceptanceCriteria: ['Reprioritize is a Machine-owned, replayable steer.'],
      sourceOfTruthTargets: ['src/smoke-target.md'],
    }, { runId: created.runId, transitionId: `ingest:${id}` });
    await transitionQueueItem(created.runRoot, {
      runId: created.runId,
      itemId: id,
      toState: 'queued',
      transitionId: `triage:${id}`,
    });
  }

  // Mutating op requires a capability token.
  const denied = await handlers.get(MACHINE_IPC_CHANNELS.reprioritizeItem)(event, {
    ...baseRequest,
    runId: created.runId,
    itemId: 'steer-item-b',
  });
  assert.equal(denied.success, false);

  // Reprioritize B ("do this first").
  const reprioritized = await handlers.get(MACHINE_IPC_CHANNELS.reprioritizeItem)(event, {
    ...baseRequest,
    runId: created.runId,
    itemId: 'steer-item-b',
    capabilityToken: 'test-token',
  });
  assert.equal(reprioritized.success, true);
  assert.equal(reprioritized.steer.op, 'reprioritize');
  const events = await readMachineEvents(created.runRoot);
  assert.equal(
    events.some(e => e.eventType === 'queue.reprioritized'
      && (e.itemId === 'steer-item-b' || e.payload?.itemId === 'steer-item-b')),
    true,
    'reprioritize is a durable queue.reprioritized event (replayable)',
  );

  // The dispatcher now claims B first despite A's higher severity.
  const claimed = await claimNextQueuedItem(created.runRoot, {
    runId: created.runId,
    claimId: 'claim-steer-reprioritize',
    now: '2026-06-01T00:00:05.000Z',
  });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.item.id, 'steer-item-b', 'the reprioritized item is claimed before the higher-severity one');

  // A now-claimed item is no longer reprioritizable (queued-only state gate).
  const notQueued = await handlers.get(MACHINE_IPC_CHANNELS.reprioritizeItem)(event, {
    ...baseRequest,
    runId: created.runId,
    itemId: 'steer-item-b',
    capabilityToken: 'test-token',
  });
  assert.equal(notQueued.success, false);
  assert.equal(notQueued.code, 'MACHINE_STEER_NOT_REPRIORITIZABLE');
});

test('Machine IPC inject-item adds a human work item to the queue via ingest + triage (STEER)', async () => {
  const { workspaceRoot, pipelinePath } = await makeWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260601_steer_inject',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  // A title is required.
  const noTitle = await handlers.get(MACHINE_IPC_CHANNELS.injectItem)(event, {
    ...baseRequest,
    runId: created.runId,
    title: '   ',
    capabilityToken: 'test-token',
  });
  assert.equal(noTitle.success, false);
  assert.equal(noTitle.code, 'MACHINE_STEER_TITLE_REQUIRED');

  // Inject a task with a target file.
  const injected = await handlers.get(MACHINE_IPC_CHANNELS.injectItem)(event, {
    ...baseRequest,
    runId: created.runId,
    title: 'Fix the README typo',
    targetFiles: ['README.md'],
    capabilityToken: 'test-token',
  });
  assert.equal(injected.success, true);
  assert.equal(injected.steer.op, 'inject');
  const newItemId = injected.steer.itemId;
  assert.match(newItemId, /^steer-fix-the-readme-typo-/);

  // The injected item is queued (claimable), with the human title + target.
  const item = await findQueueItem(created.runRoot, newItemId, { canonicalOnly: false });
  assert.equal(item.item.state, 'queued');
  assert.equal(item.item.title, 'Fix the README typo');
  assert.ok((item.item.targetFiles || []).length >= 1, 'the injected target files are recorded');

  // Both transitions are recorded (replayable): inbox->candidate then candidate->queued.
  const events = await readMachineEvents(created.runRoot);
  assert.equal(
    events.some(e => e.eventType === 'queue.transition' && e.toState === 'candidate'
      && (e.itemId === newItemId || e.payload?.itemId === newItemId)),
    true,
    'ingest recorded inbox->candidate',
  );
  assert.equal(
    events.some(e => e.eventType === 'queue.transition' && e.toState === 'queued'
      && (e.itemId === newItemId || e.payload?.itemId === newItemId)),
    true,
    'triage recorded candidate->queued',
  );

  // The injected item is a normal queued item the dispatcher can claim.
  const claimed = await claimNextQueuedItem(created.runRoot, {
    runId: created.runId,
    claimId: 'claim-inject',
    now: '2026-06-01T00:00:05.000Z',
  });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.item.id, newItemId, 'the injected item can be claimed');
});

test('Machine IPC edit-item edits a queued item in place, re-validating and preserving the edit through repair (STEER)', async () => {
  const { workspaceRoot, pipelinePath } = await makeWorkspace();
  const event = senderEvent();
  const { handlers, authority } = createIpcHarness();
  authority.grantWorkspace(event.sender, workspaceRoot);
  const baseRequest = { workspacePath: workspaceRoot, pipelinePath };

  const created = await handlers.get(MACHINE_IPC_CHANNELS.createRun)(event, {
    ...baseRequest,
    runId: 'run_20260601_steer_edit',
    capabilityToken: 'test-token',
  });
  assert.equal(created.success, true);

  await ingestCandidateProposal(created.runRoot, {
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: 'proposal-edit',
    suggestedWorkItemId: 'steer-edit-item',
    sourceNode: 'probe/steer',
    title: 'Original title',
    fingerprint: 'steer:edit-item',
    severity: 'P2',
    evidence: [{ id: 'edit-src', file: 'src/original-target.md' }],
    acceptanceCriteria: ['Original acceptance criterion.'],
    sourceOfTruthTargets: ['src/original-target.md'],
  }, { runId: created.runId, transitionId: 'ingest:edit-item' });
  await transitionQueueItem(created.runRoot, {
    runId: created.runId,
    itemId: 'steer-edit-item',
    toState: 'queued',
    transitionId: 'triage:edit-item',
  });

  // Mutating op requires a capability token.
  const denied = await handlers.get(MACHINE_IPC_CHANNELS.editItem)(event, {
    ...baseRequest,
    runId: created.runId,
    itemId: 'steer-edit-item',
    title: 'Should be denied',
  });
  assert.equal(denied.success, false);

  // An edit with no editable fields is rejected.
  const empty = await handlers.get(MACHINE_IPC_CHANNELS.editItem)(event, {
    ...baseRequest,
    runId: created.runId,
    itemId: 'steer-edit-item',
    capabilityToken: 'test-token',
  });
  assert.equal(empty.success, false);
  assert.equal(empty.code, 'MACHINE_STEER_EDIT_EMPTY');

  // Edit the title, target files, and acceptance criteria.
  const edited = await handlers.get(MACHINE_IPC_CHANNELS.editItem)(event, {
    ...baseRequest,
    runId: created.runId,
    itemId: 'steer-edit-item',
    title: 'Corrected title',
    targetFiles: ['src/corrected-target.md', '   '],
    acceptanceCriteria: ['Corrected acceptance criterion.', ''],
    capabilityToken: 'test-token',
  });
  assert.equal(edited.success, true);
  assert.equal(edited.steer.op, 'edit');
  assert.deepEqual([...edited.steer.fields].sort(), ['acceptanceCriteria', 'targetFiles', 'title']);

  // The snapshot reflects the edit; the item stays queued (edit is not a state change).
  const item = await findQueueItem(created.runRoot, 'steer-edit-item', { canonicalOnly: false });
  assert.equal(item.item.state, 'queued');
  assert.equal(item.item.title, 'Corrected title');
  assert.deepEqual(item.item.targetFiles, ['src/corrected-target.md'], 'blank target entries are dropped');
  assert.deepEqual(item.item.acceptanceCriteria, ['Corrected acceptance criterion.'], 'blank criteria are dropped');

  // The edit is a durable queue.edited event carrying the patch (replay-of-intent).
  const events = await readMachineEvents(created.runRoot);
  const editEvent = events.find(e => e.eventType === 'queue.edited' && e.itemId === 'steer-edit-item');
  assert.ok(editEvent, 'a queue.edited event was recorded');
  assert.equal(editEvent.payload?.patch?.title, 'Corrected title');
  // The event is self-documenting about which snapshot file holds the edit.
  assert.deepEqual(editEvent.artifactRefs, ['queue/queued/steer-edit-item.json']);

  // Edit is NOT a state transition — the queue-state projection still reads 'queued'.
  assert.equal(projectQueueStateFromEvents(events).get('steer-edit-item'), 'queued');

  // The edit survives the resume repair path (snapshot content is preserved).
  await repairDerivedQueueFilesFromEvents(created.runRoot);
  const afterRepair = await findQueueItem(created.runRoot, 'steer-edit-item', { canonicalOnly: false });
  assert.equal(afterRepair.item.title, 'Corrected title', 'the edit survives a queue repair/replay');
  assert.equal(afterRepair.item.state, 'queued');

  // editQueueItem re-validates against the workItem schema: an empty title is rejected
  // (defense-in-depth below the handler's field sanitization).
  await assert.rejects(
    () => editQueueItem(created.runRoot, {
      runId: created.runId,
      itemId: 'steer-edit-item',
      patch: { title: '' },
    }),
    (err) => err.code === 'MACHINE_QUEUE_ITEM_INVALID',
    'an edit that would write a malformed item is rejected before persisting',
  );

  // A claimed (in-flight) item is no longer editable.
  const claimed = await claimNextQueuedItem(created.runRoot, {
    runId: created.runId,
    claimId: 'claim-edit',
    now: '2026-06-01T00:00:05.000Z',
  });
  assert.equal(claimed.claimed, true);
  const notEditable = await handlers.get(MACHINE_IPC_CHANNELS.editItem)(event, {
    ...baseRequest,
    runId: created.runId,
    itemId: 'steer-edit-item',
    title: 'Too late',
    capabilityToken: 'test-token',
  });
  assert.equal(notEditable.success, false);
  assert.equal(notEditable.code, 'MACHINE_STEER_NOT_EDITABLE');
});
