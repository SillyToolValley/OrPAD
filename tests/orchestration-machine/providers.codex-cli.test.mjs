import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  assertCliProcessContainment,
  codexCliExecArgs,
  codexCliInvocation,
  commandUsesDangerousArg,
  commandUsesDangerousCodexBypass,
  DANGEROUS_CODEX_BYPASS_ARG,
  dangerousArgsForProvider,
  getProviderPlugin,
  getProviderPluginForAdapter,
  hasProviderPlugin,
  listProviderPluginIds,
  registerProviderPlugin,
  resolveProviderIdFromAdapter,
  unregisterProviderPlugin,
} = require('../../src/main/orchestration-machine');

test('codex-cli plugin is registered with correct shape', () => {
  assert.equal(hasProviderPlugin('codex-cli'), true);
  const plugin = getProviderPlugin('codex-cli');
  assert.equal(plugin.id, 'codex-cli');
  assert.equal(plugin.family, 'cli');
  assert.equal(plugin.needsKey, false);
  assert.equal(typeof plugin.buildWorkerCommandSpec, 'function');
  assert.equal(typeof plugin.createProposalAdapter, 'function');
  assert.deepEqual([...plugin.dangerousArgs], [DANGEROUS_CODEX_BYPASS_ARG]);
});

test('listProviderPluginIds includes codex-cli', () => {
  const ids = listProviderPluginIds();
  assert.equal(ids.includes('codex-cli'), true);
});

test('dangerousArgsForProvider returns codex bypass arg for codex-cli', () => {
  const args = dangerousArgsForProvider('codex-cli');
  assert.deepEqual(args, [DANGEROUS_CODEX_BYPASS_ARG]);
});

test('resolveProviderIdFromAdapter handles raw v1 type and lifted v2 envelope', () => {
  assert.equal(resolveProviderIdFromAdapter({ type: 'codex-cli' }), 'codex-cli');
  assert.equal(resolveProviderIdFromAdapter({
    schemaVersion: 'orpad.machineAdapter.v2',
    default: { providerId: 'codex-cli' },
  }), 'codex-cli');
  assert.equal(resolveProviderIdFromAdapter({ providerId: 'anthropic' }), 'anthropic');
  assert.equal(resolveProviderIdFromAdapter(null), '');
});

test('getProviderPluginForAdapter resolves via raw v1 codex-cli type', () => {
  const plugin = getProviderPluginForAdapter({ type: 'codex-cli', enabled: true });
  assert.equal(plugin?.id, 'codex-cli');
});

test('codexCliInvocation routes Windows codex shim through node executable', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-codex-shim-'));
  const fakeNode = path.join(tempRoot, process.platform === 'win32' ? 'node.exe' : 'node');
  const fakeCodexScript = path.join(tempRoot, 'codex.js');
  await fs.writeFile(fakeNode, '', 'utf8');
  await fs.writeFile(fakeCodexScript, '', 'utf8');

  const previousNodeExecPath = process.env.npm_node_execpath;
  const previousMachineNode = process.env.ORPAD_MACHINE_NODE_EXEC_PATH;
  try {
    delete process.env.ORPAD_MACHINE_NODE_EXEC_PATH;
    process.env.npm_node_execpath = fakeNode;
    const invocation = codexCliInvocation(fakeCodexScript);
    assert.equal(invocation.command, fakeNode);
    assert.deepEqual(invocation.prefixArgs, [fakeCodexScript]);
  } finally {
    if (previousNodeExecPath === undefined) delete process.env.npm_node_execpath;
    else process.env.npm_node_execpath = previousNodeExecPath;
    if (previousMachineNode === undefined) delete process.env.ORPAD_MACHINE_NODE_EXEC_PATH;
    else process.env.ORPAD_MACHINE_NODE_EXEC_PATH = previousMachineNode;
  }
});

test('codexCliInvocation lets ORPAD_CODEX_CLI_PATH override the generated codex command', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-codex-env-'));
  const fakeCodexScript = path.join(tempRoot, 'fake-codex.js');
  const fakeNode = path.join(tempRoot, process.platform === 'win32' ? 'node.exe' : 'node');
  await fs.writeFile(fakeCodexScript, '', 'utf8');
  await fs.writeFile(fakeNode, '', 'utf8');

  const previousCodexPath = process.env.ORPAD_CODEX_CLI_PATH;
  const previousMachineNode = process.env.ORPAD_MACHINE_NODE_EXEC_PATH;
  try {
    process.env.ORPAD_CODEX_CLI_PATH = fakeCodexScript;
    process.env.ORPAD_MACHINE_NODE_EXEC_PATH = fakeNode;
    const invocation = codexCliInvocation('codex');
    assert.equal(invocation.command, fakeNode);
    assert.deepEqual(invocation.prefixArgs, [fakeCodexScript]);
  } finally {
    if (previousCodexPath === undefined) delete process.env.ORPAD_CODEX_CLI_PATH;
    else process.env.ORPAD_CODEX_CLI_PATH = previousCodexPath;
    if (previousMachineNode === undefined) delete process.env.ORPAD_MACHINE_NODE_EXEC_PATH;
    else process.env.ORPAD_MACHINE_NODE_EXEC_PATH = previousMachineNode;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('codexCliExecArgs can route long prompts through stdin', () => {
  const args = codexCliExecArgs({
    sandbox: 'read-only',
    approvalPolicy: 'never',
    promptViaStdin: true,
    ephemeral: true,
  });
  assert.equal(args.at(-1), '-');
  assert.equal(args.includes('read-only'), true);
  assert.equal(args.includes('--ephemeral'), true);
});

test('commandUsesDangerousArg detects plugin-declared dangerous args, not just codex', () => {
  const fakePluginArgs = ['--no-sandbox-pretty-please'];
  assert.equal(
    commandUsesDangerousArg(
      { args: ['exec', '--no-sandbox-pretty-please', 'whatever'] },
      fakePluginArgs,
    ),
    true,
  );
  assert.equal(
    commandUsesDangerousArg(
      { args: ['exec', 'safe', 'arg'] },
      fakePluginArgs,
    ),
    false,
  );
});

test('commandUsesDangerousArg falls back to codex bypass when no plugin args supplied', () => {
  assert.equal(
    commandUsesDangerousArg({ args: [DANGEROUS_CODEX_BYPASS_ARG] }),
    true,
  );
  assert.equal(commandUsesDangerousCodexBypass({ args: [DANGEROUS_CODEX_BYPASS_ARG] }), true);
});

test('assertCliProcessContainment enforces dangerous args from a fictitious second plugin', async () => {
  const fakePluginId = `temp-cli-plugin-${Date.now()}`;
  const fakeDangerousArg = '--no-sandbox-pretty-please';
  registerProviderPlugin({
    id: fakePluginId,
    family: 'cli',
    needsKey: false,
    capabilities: {
      sessionStrategies: ['none'],
      toolPolicies: ['none'],
      streaming: false,
      structuredOutput: 'free-text',
      sandbox: 'workspace-write',
    },
    models: [{ id: 'fake', qualityTier: 'standard' }],
    dangerousArgs: [fakeDangerousArg],
    buildWorkerCommandSpec: () => ({ command: 'fake', args: [], cwd: '' }),
  });
  try {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-fake-overlay-'));
    const overlayParent = path.join(tempRoot, 'adapters', 'overlays');
    const overlayRoot = path.join(overlayParent, 'fake-overlay');
    await fs.mkdir(overlayRoot, { recursive: true });
    const dangerousArgs = dangerousArgsForProvider(fakePluginId);
    assert.deepEqual(dangerousArgs, [fakeDangerousArg]);

    assert.throws(
      () => assertCliProcessContainment({
        commandSpec: { command: 'fake', args: ['exec', fakeDangerousArg], cwd: overlayRoot },
        grant: { allowDangerousSandboxBypass: false },
        overlayRoot,
        workspaceRoot: tempRoot,
        request: {},
        allowDangerousSandboxBypass: false,
        dangerousArgs,
      }),
      error => error?.code === 'MACHINE_DANGEROUS_SANDBOX_BYPASS_NOT_APPROVED',
    );
  } finally {
    unregisterProviderPlugin(fakePluginId);
  }
});

test('registerProviderPlugin rejects malformed plugin shapes', () => {
  assert.throws(() => registerProviderPlugin(null));
  assert.throws(() => registerProviderPlugin({ id: 'no-family' }));
  assert.throws(() => registerProviderPlugin({ id: 'bad-family', family: 'mystery' }));
  assert.throws(() => registerProviderPlugin({
    id: 'bad-dangerous',
    family: 'cli',
    dangerousArgs: ['', null],
  }));
});

test('codex plugin buildWorkerCommandSpec produces stable codex CLI args from a generic prompt', () => {
  const plugin = getProviderPlugin('codex-cli');
  const spec = plugin.buildWorkerCommandSpec({
    adapter: {
      command: process.execPath,
      commandPrefixArgs: ['/tmp/fake-codex.js'],
      workerSandbox: 'workspace-write',
      approvalPolicy: 'never',
      ephemeral: true,
    },
    prompt: 'Hello worker.',
    overlayRoot: '/tmp/overlay',
  });
  assert.equal(spec.cwd, '/tmp/overlay');
  assert.equal(spec.command, process.execPath);
  assert.equal(spec.args[0], '/tmp/fake-codex.js');
  assert.equal(spec.args.includes('exec'), true);
  assert.equal(spec.args.includes('--sandbox'), true);
  assert.equal(spec.args.includes('workspace-write'), true);
  assert.equal(spec.args.includes('--output-last-message'), true);
  assert.match(spec.args[spec.args.indexOf('--output-last-message') + 1], /^orpad-worker-result-worker\.json$/);
  assert.equal(spec.args.includes('--ephemeral'), true);
  assert.equal(spec.args.at(-1), '-');
  assert.equal(spec.stdin, 'Hello worker.');
});

test('codex plugin adds dangerous bypass arg only when run bypass is explicit', () => {
  const plugin = getProviderPlugin('codex-cli');
  const spec = plugin.buildWorkerCommandSpec({
    adapter: {
      command: process.execPath,
      commandPrefixArgs: ['/tmp/fake-codex.js'],
      workerSandbox: 'workspace-write',
      approvalPolicy: 'never',
      bypassLlmApprovals: true,
    },
    prompt: 'Hello worker.',
    overlayRoot: '/tmp/overlay',
  });
  assert.equal(spec.args.includes(DANGEROUS_CODEX_BYPASS_ARG), true);
});
