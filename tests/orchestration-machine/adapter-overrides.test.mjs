import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const orchestration = require('../../src/main/orchestration-machine');
const {
  MACHINE_IPC_CHANNELS,
  adapterOverridesPathFor,
  createMachineRun,
  executeMachineRunStep,
  registerMachineHandlers,
} = orchestration;

function makeFakeIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, fn) { handlers.set(channel, fn); },
    invoke(channel, request = {}, event = makeFakeEvent()) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn(event, request);
    },
  };
}

function makeFakeEvent() {
  return {
    senderFrame: { url: 'file:///orpad/index.html', parent: null },
    sender: { id: 1 },
  };
}

const fakeAuthority = {
  assertWorkspaceContains() {},
};

async function makePipelineFixture(runId) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-overrides-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/sample');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'sample',
    entryGraph: 'graphs/main.or-graph',
    nodePacks: [
      { id: 'orpad.core' },
      { id: 'orpad.workstream' },
    ],
    run: {
      machineAdapter: {
        type: 'codex-cli',
        enabled: true,
        sandbox: 'read-only',
        workerSandbox: 'workspace-write',
        approvalPolicy: 'never',
        proposalTimeoutMs: 600000,
        workerTimeoutMs: 900000,
        probeNodePaths: ['main/probe'],
      },
    },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'sample',
      nodes: [
        { id: 'probe', type: 'orpad.probe', config: {} },
        { id: 'triage', type: 'orpad.triage', config: {} },
        { id: 'dispatcher', type: 'orpad.dispatcher', config: {} },
        { id: 'worker', type: 'orpad.workerLoop', config: {} },
      ],
      transitions: [
        { from: 'probe', to: 'triage' },
        { from: 'triage', to: 'dispatcher' },
        { from: 'dispatcher', to: 'worker' },
      ],
    },
  }, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId,
    now: new Date('2026-05-06T00:00:00.000Z'),
  });
  return { workspaceRoot, pipelineDir, pipelinePath, run };
}

test('setProviderSelection IPC writes a sibling adapter-overrides.json next to the pipeline', async () => {
  const { workspaceRoot, pipelinePath } = await makePipelineFixture('run_overrides_persist_001');
  try {
    const ipcMain = makeFakeIpcMain();
    registerMachineHandlers({
      ipcMain,
      authority: fakeAuthority,
      featureGate: { enabled: true, mutatingCapabilityToken: 'token' },
    });
    const expectedPath = adapterOverridesPathFor(pipelinePath);
    // Sanity: file must not exist before the handler runs.
    await assert.rejects(fs.stat(expectedPath), { code: 'ENOENT' });
    const response = await ipcMain.invoke(MACHINE_IPC_CHANNELS.setProviderSelection, {
      capabilityToken: 'token',
      scope: 'pipeline',
      pipelinePath,
      selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
    });
    assert.equal(response.ok, true);
    assert.equal(typeof response.persistedTo, 'string');
    assert.equal(response.persistedTo, expectedPath);
    const written = JSON.parse(await fs.readFile(expectedPath, 'utf8'));
    assert.equal(written.schemaVersion, 'orpad.adapterOverrides.v1');
    assert.equal(written.pipelineDefault.providerId, 'anthropic');
    assert.equal(written.pipelineDefault.model, 'claude-3-5-sonnet-latest');
    assert.equal(written.pipelineDefault.family, 'api');
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('setProviderSelection IPC merges sequential pipeline-default + node-override edits', async () => {
  const { workspaceRoot, pipelinePath } = await makePipelineFixture('run_overrides_persist_002');
  try {
    const ipcMain = makeFakeIpcMain();
    registerMachineHandlers({
      ipcMain,
      authority: fakeAuthority,
      featureGate: { enabled: true, mutatingCapabilityToken: 'token' },
    });
    await ipcMain.invoke(MACHINE_IPC_CHANNELS.setProviderSelection, {
      capabilityToken: 'token',
      scope: 'pipeline',
      pipelinePath,
      selection: { providerId: 'codex-cli', model: 'codex' },
    });
    await ipcMain.invoke(MACHINE_IPC_CHANNELS.setProviderSelection, {
      capabilityToken: 'token',
      scope: 'node',
      target: 'main/probe',
      pipelinePath,
      selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
    });
    const written = JSON.parse(await fs.readFile(adapterOverridesPathFor(pipelinePath), 'utf8'));
    assert.equal(written.pipelineDefault.providerId, 'codex-cli');
    assert.equal(written.nodeOverrides['main/probe'].providerId, 'anthropic');
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('applyAdapterOverridesToPipelineAdapter carries pipeline orchestration fields across provider swap', async () => {
  const { applyAdapterOverridesToPipelineAdapter } = orchestration;
  const v1Adapter = {
    type: 'codex-cli',
    enabled: true,
    command: process.execPath,
    commandPrefixArgs: ['fake-codex.js'],
    sandbox: 'read-only',
    workerSandbox: 'workspace-write',
    approvalPolicy: 'never',
    parallelProbes: true,
    probeConcurrency: 'all',
    probeNodePaths: ['main/probe', 'main/probe-2', 'main/probe-3'],
    candidateLimit: 5,
    proposalTimeoutMs: 600000,
    workerTimeoutMs: 900000,
    claimLeaseMs: 1800000,
    claimPolicy: { concurrency: 1, maxClaims: 2 },
    workerConcurrency: 1,
    maxParallelWorkers: 3,
    parallelWorkers: false,
    continueAfterReviewableBlockedPatch: true,
    supportNodePolicy: 'record-gate-warnings-and-mark-artifact-partial',
  };
  const overrides = {
    schemaVersion: 'orpad.adapterOverrides.v1',
    pipelineDefault: {
      providerId: 'claude-code',
      model: 'claude-code',
      family: 'cli',
      qualityTier: 'standard',
      sessionStrategy: 'none',
      toolPolicy: 'none',
    },
    nodeOverrides: {},
  };
  const lifted = applyAdapterOverridesToPipelineAdapter(v1Adapter, overrides);
  assert.equal(lifted.schemaVersion, 'orpad.machineAdapter.v2');
  assert.equal(lifted.default.providerId, 'claude-code');
  assert.equal(lifted.parallelProbes, true);
  assert.equal(lifted.probeConcurrency, 'all');
  assert.deepEqual(lifted.probeNodePaths, ['main/probe', 'main/probe-2', 'main/probe-3']);
  assert.equal(lifted.candidateLimit, 5);
  assert.equal(lifted.workerTimeoutMs, 900000);
  assert.equal(lifted.claimLeaseMs, 1800000);
  assert.deepEqual(lifted.claimPolicy, { concurrency: 1, maxClaims: 2 });
  assert.equal(lifted.workerConcurrency, 1);
  assert.equal(lifted.maxParallelWorkers, 3);
  assert.equal(lifted.parallelWorkers, false);
  assert.equal(lifted.continueAfterReviewableBlockedPatch, true);
  // Provider-specific fields must NOT carry over (claude-code uses its own).
  assert.equal(lifted.workerSandbox, undefined);
  assert.equal(lifted.command, undefined);
});

test('applyAdapterOverridesToPipelineAdapter lets provider timeout override legacy probe and worker caps', async () => {
  const { applyAdapterOverridesToPipelineAdapter } = orchestration;
  const v1Adapter = {
    type: 'codex-cli',
    enabled: true,
    probeNodePaths: ['main/probe'],
    proposalTimeoutMs: 240000,
    workerTimeoutMs: 300000,
    claimLeaseMs: 600000,
  };
  const overrides = {
    schemaVersion: 'orpad.adapterOverrides.v1',
    pipelineDefault: {
      providerId: 'codex-cli',
      model: 'codex',
      family: 'cli',
      timeoutMs: 600000,
    },
    nodeOverrides: {},
  };
  const lifted = applyAdapterOverridesToPipelineAdapter(v1Adapter, overrides);
  assert.equal(lifted.default.timeoutMs, 600000);
  assert.equal(lifted.proposalTimeoutMs, 600000);
  assert.equal(lifted.workerTimeoutMs, 600000);
  assert.equal(lifted.claimLeaseMs, 600000);
});

test('applyAdapterOverridesToPipelineAdapter preserves custom command when provider stays the same', async () => {
  const { applyAdapterOverridesToPipelineAdapter } = orchestration;
  const v1Adapter = {
    type: 'codex-cli',
    enabled: true,
    command: process.execPath,
    commandPrefixArgs: ['fake-codex.js'],
    probeNodePaths: ['main/probe'],
    workerNodePath: 'main/worker',
  };
  const overrides = {
    schemaVersion: 'orpad.adapterOverrides.v1',
    pipelineDefault: {
      providerId: 'codex-cli',
      model: 'codex',
      family: 'cli',
    },
    nodeOverrides: {},
  };
  const lifted = applyAdapterOverridesToPipelineAdapter(v1Adapter, overrides);
  assert.equal(lifted.default.providerId, 'codex-cli');
  assert.equal(lifted.command, process.execPath);
  assert.deepEqual(lifted.commandPrefixArgs, ['fake-codex.js']);
});

test('executeMachineRunStep refuses to dispatch when the override picks a stub API provider', async () => {
  const { workspaceRoot, pipelinePath, pipelineDir, run } = await makePipelineFixture('run_overrides_api_gate_001');
  try {
    // openai plugin is registered but invokeApi is a stub — should reject up
    // front with MACHINE_API_PLUGIN_STUB before any traversal work.
    await fs.writeFile(
      adapterOverridesPathFor(pipelinePath),
      JSON.stringify({
        schemaVersion: 'orpad.adapterOverrides.v1',
        updatedAt: '2026-05-06T00:00:00.000Z',
        pipelineDefault: {
          providerId: 'openai',
          model: 'gpt-4o-mini',
          family: 'api',
          qualityTier: 'standard',
          sessionStrategy: 'none',
          toolPolicy: 'none',
        },
        nodeOverrides: {},
      }, null, 2),
      'utf8',
    );
    await assert.rejects(
      executeMachineRunStep({
        workspaceRoot,
        pipelinePath,
        pipelineDir,
        runRoot: run.runRoot,
        runId: run.runId,
      }),
      error => error?.code === 'MACHINE_API_PLUGIN_STUB' && /openai/.test(error.message || ''),
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
