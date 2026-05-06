import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  MACHINE_IPC_CHANNELS,
  registerMachineHandlers,
} = require('../../src/main/orchestration-machine');

function makeFakeIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
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

test('listProviders IPC returns plugin and catalog inventory', async () => {
  const ipcMain = makeFakeIpcMain();
  registerMachineHandlers({
    ipcMain,
    authority: fakeAuthority,
    featureGate: { enabled: true, mutatingCapabilityToken: 'token' },
  });
  const response = await ipcMain.invoke(MACHINE_IPC_CHANNELS.listProviders, {});
  assert.equal(response.ok, true);
  assert.equal(Array.isArray(response.plugins), true);
  assert.equal(Array.isArray(response.catalog), true);
  const ids = response.plugins.map(p => p.id);
  for (const expected of ['codex-cli', 'anthropic', 'claude-code', 'openai', 'ollama']) {
    assert.equal(ids.includes(expected), true, `plugins should include ${expected}`);
  }
  const codex = response.plugins.find(p => p.id === 'codex-cli');
  assert.equal(codex.family, 'cli');
  assert.equal(Array.isArray(codex.dangerousArgs), true);
  assert.equal(codex.dangerousArgs.includes('--dangerously-bypass-approvals-and-sandbox'), true);
});

test('listModels IPC returns catalog rows for a known provider', async () => {
  const ipcMain = makeFakeIpcMain();
  registerMachineHandlers({
    ipcMain,
    authority: fakeAuthority,
    featureGate: { enabled: true, mutatingCapabilityToken: 'token' },
  });
  const response = await ipcMain.invoke(MACHINE_IPC_CHANNELS.listModels, { providerId: 'anthropic' });
  assert.equal(response.ok, true);
  assert.equal(response.providerId, 'anthropic');
  assert.equal(response.pluginRegistered, true);
  assert.equal(response.models.length > 0, true);
  for (const model of response.models) {
    assert.equal(typeof model.id, 'string');
    assert.equal(typeof model.qualityTier, 'string');
    assert.equal(typeof model.costPerMTokensIn, 'number');
    assert.equal(typeof model.costPerMTokensOut, 'number');
  }
});

test('listModels IPC rejects unknown providers', async () => {
  const ipcMain = makeFakeIpcMain();
  registerMachineHandlers({
    ipcMain,
    authority: fakeAuthority,
    featureGate: { enabled: true, mutatingCapabilityToken: 'token' },
  });
  const response = await ipcMain.invoke(MACHINE_IPC_CHANNELS.listModels, { providerId: 'mystery' });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'MACHINE_IPC_PROVIDER_UNKNOWN');
});

test('setProviderSelection IPC re-validates plugin registry membership', async () => {
  const ipcMain = makeFakeIpcMain();
  registerMachineHandlers({
    ipcMain,
    authority: fakeAuthority,
    featureGate: { enabled: true, mutatingCapabilityToken: 'token' },
  });
  // Renderer compromise scenario: try to set an unregistered provider id.
  const rejected = await ipcMain.invoke(MACHINE_IPC_CHANNELS.setProviderSelection, {
    capabilityToken: 'token',
    scope: 'pipeline',
    selection: { providerId: 'mystery-provider', model: 'mystery-1' },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'MACHINE_IPC_PROVIDER_NOT_REGISTERED');
  // Happy path: a known provider returns the canonicalized selection.
  const accepted = await ipcMain.invoke(MACHINE_IPC_CHANNELS.setProviderSelection, {
    capabilityToken: 'token',
    scope: 'pipeline',
    selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.selection.providerId, 'anthropic');
  assert.equal(accepted.selection.family, 'api');
});

test('setProviderSelection IPC requires target for node-scope changes', async () => {
  const ipcMain = makeFakeIpcMain();
  registerMachineHandlers({
    ipcMain,
    authority: fakeAuthority,
    featureGate: { enabled: true, mutatingCapabilityToken: 'token' },
  });
  const response = await ipcMain.invoke(MACHINE_IPC_CHANNELS.setProviderSelection, {
    capabilityToken: 'token',
    scope: 'node',
    selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'MACHINE_IPC_TARGET_REQUIRED');
});

test('setProviderSelection IPC rejects invalid scope', async () => {
  const ipcMain = makeFakeIpcMain();
  registerMachineHandlers({
    ipcMain,
    authority: fakeAuthority,
    featureGate: { enabled: true, mutatingCapabilityToken: 'token' },
  });
  const response = await ipcMain.invoke(MACHINE_IPC_CHANNELS.setProviderSelection, {
    capabilityToken: 'token',
    scope: 'global',
    selection: { providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
  });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'MACHINE_IPC_SCOPE_INVALID');
});

test('readBudgetLedger IPC returns ledger and summary, requiring runRoot', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const orchestration = require('../../src/main/orchestration-machine');
  const runRoot = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'orpad-meter-'));
  try {
    await orchestration.appendBudgetEntry(runRoot, {
      runId: 'run_x',
      adapterCallId: 'a1',
      attemptId: 'att1',
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, costEstimateUsd: 0.5 },
    });
    const ipcMain = makeFakeIpcMain();
    registerMachineHandlers({
      ipcMain,
      authority: fakeAuthority,
      featureGate: { enabled: true, mutatingCapabilityToken: 'token' },
    });
    const missing = await ipcMain.invoke(MACHINE_IPC_CHANNELS.readBudgetLedger, {});
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'MACHINE_IPC_RUN_ROOT_REQUIRED');
    const response = await ipcMain.invoke(MACHINE_IPC_CHANNELS.readBudgetLedger, { runRoot });
    assert.equal(response.ok, true);
    assert.equal(response.ledger.entries.length, 1);
    assert.equal(response.summary.totalCostUsd, 0.5);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});
