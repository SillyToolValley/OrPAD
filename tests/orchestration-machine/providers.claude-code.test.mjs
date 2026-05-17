import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  assertCliProcessContainment,
  assertGenericCliConfig,
  claudeCodeExecArgs,
  claudeCodeInvocation,
  claudeProcessLooksApprovalRequired,
  commandAllowed,
  createGenericCliPlugin,
  dangerousArgsForProvider,
  getProviderEntry,
  getProviderPlugin,
  hasProviderPlugin,
  parseClaudeAdapterResultFromStdout,
  registerProviderPlugin,
  unregisterProviderPlugin,
} = require('../../src/main/orchestration-machine');

test('claude-code plugin is registered with CLI family metadata', () => {
  assert.equal(hasProviderPlugin('claude-code'), true);
  const plugin = getProviderPlugin('claude-code');
  const entry = getProviderEntry('claude-code');
  assert.equal(plugin.id, 'claude-code');
  assert.equal(plugin.family, 'cli');
  assert.equal(plugin.needsKey, false);
  assert.equal(plugin.displayName, entry.displayName);
  assert.equal(typeof plugin.buildWorkerCommandSpec, 'function');
  assert.equal(typeof plugin.createProposalAdapter, 'function');
  assert.deepEqual([...plugin.dangerousArgs], ['--dangerously-skip-permissions']);
});

test('claudeCodeExecArgs includes --print and --output-format json by default', () => {
  const args = claudeCodeExecArgs({ prompt: 'hello' });
  assert.equal(args[0], '--print');
  assert.equal(args[1], '--output-format');
  assert.equal(args[2], 'json');
  assert.equal(args.at(-1), 'hello');
});

test('claudeCodeExecArgs threads allowedTools/disallowedTools and cwd', () => {
  const args = claudeCodeExecArgs({
    outputFormat: 'json',
    allowedTools: 'Read,Bash',
    disallowedTools: 'Write',
    cd: '/tmp/overlay',
    prompt: 'x',
  });
  assert.equal(args.includes('--allowed-tools'), true);
  assert.equal(args.includes('Read,Bash'), true);
  assert.equal(args.includes('--disallowed-tools'), true);
  assert.equal(args.includes('Write'), true);
  assert.equal(args.includes('--cd'), true);
  assert.equal(args.includes('/tmp/overlay'), true);
});

test('claudeCodeInvocation defers Windows shim to PATH lookup', () => {
  const inv = claudeCodeInvocation('claude');
  assert.equal(typeof inv.command, 'string');
  assert.deepEqual(inv.prefixArgs, []);
});

test('parseClaudeAdapterResultFromStdout handles the --output-format json envelope', () => {
  const innerJson = JSON.stringify({
    schemaVersion: 'orpad.workerResult.v1',
    adapterCallId: 'a1',
    attemptId: 'att1',
    idempotencyKey: 'k',
    status: 'done',
    summary: 'ok',
    artifacts: ['a/b'],
  });
  const envelope = JSON.stringify({
    type: 'result',
    result: innerJson,
    session_id: 'sess-1',
  });
  const parsed = parseClaudeAdapterResultFromStdout(envelope);
  assert.equal(parsed.schemaVersion, 'orpad.workerResult.v1');
  assert.equal(parsed.status, 'done');
});

test('parseClaudeAdapterResultFromStdout falls through fenced JSON', () => {
  const text = '```json\n{"schemaVersion":"orpad.workerResult.v1","adapterCallId":"a","attemptId":"a","idempotencyKey":"k","status":"done","summary":"ok","artifacts":["a/b"]}\n```';
  const parsed = parseClaudeAdapterResultFromStdout(text);
  assert.equal(parsed.summary, 'ok');
});

test('parseClaudeAdapterResultFromStdout throws on empty stdout', () => {
  assert.throws(() => parseClaudeAdapterResultFromStdout(''));
});

test('claude-code dangerousArgs flow into assertCliProcessContainment', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-claude-overlay-'));
  try {
    const overlayParent = path.join(tempRoot, 'adapters', 'overlays');
    const overlayRoot = path.join(overlayParent, 'fake-overlay');
    await fs.mkdir(overlayRoot, { recursive: true });
    const dangerousArgs = dangerousArgsForProvider('claude-code');
    assert.deepEqual(dangerousArgs, ['--dangerously-skip-permissions']);
    assert.throws(
      () => assertCliProcessContainment({
        commandSpec: { command: 'claude', args: ['--print', '--dangerously-skip-permissions', 'go'], cwd: overlayRoot },
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
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('claude-code buildWorkerCommandSpec produces stable args from a generic prompt', () => {
  const plugin = getProviderPlugin('claude-code');
  const spec = plugin.buildWorkerCommandSpec({
    adapter: { command: process.execPath, commandPrefixArgs: ['/tmp/fake-claude.js'] },
    prompt: 'hello worker.',
    overlayRoot: '/tmp/overlay',
  });
  assert.equal(spec.cwd, '/tmp/overlay');
  assert.equal(spec.command, process.execPath);
  assert.equal(spec.args[0], '/tmp/fake-claude.js');
  assert.equal(spec.args.includes('--print'), true);
  assert.equal(spec.args.at(-1), 'hello worker.');
});

test('claude-code buildWorkerCommandSpec adds skip-permissions only for bypass runs', () => {
  const plugin = getProviderPlugin('claude-code');
  const spec = plugin.buildWorkerCommandSpec({
    adapter: {
      command: process.execPath,
      commandPrefixArgs: ['/tmp/fake-claude.js'],
      bypassLlmApprovals: true,
    },
    prompt: 'hello worker.',
    overlayRoot: '/tmp/overlay',
  });
  assert.equal(spec.args.includes('--dangerously-skip-permissions'), true);
});

test('claude-code provider treats sandbox edit denials as approval-required', () => {
  assert.equal(claudeProcessLooksApprovalRequired({
    stdout: JSON.stringify({
      type: 'result',
      result: 'Sandbox denied write to the overlay file; repeated Edit calls returned permission errors.',
      permission_denials: [{ tool_name: 'Edit' }],
    }),
    stderr: '',
  }, { summary: 'No overlay change was produced.' }), true);
});

test('claude-code provider does not treat empty permission_denials metadata as approval-required', () => {
  assert.equal(claudeProcessLooksApprovalRequired({
    stdout: JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify({
        schemaVersion: 'orpad.workerResult.v1',
        status: 'done',
        summary: 'ok',
      }),
      permission_denials: [],
      terminal_reason: 'completed',
    }),
    stderr: '',
  }, { status: 'done', summary: 'ok' }), false);
});

test('createGenericCliPlugin rejects missing config fields', () => {
  assert.throws(() => createGenericCliPlugin(), error => error?.code === 'GENERIC_CLI_CONFIG_REQUIRED');
  assert.throws(
    () => createGenericCliPlugin({ id: '' }),
    error => error?.code === 'GENERIC_CLI_CONFIG_INVALID_ID',
  );
  assert.throws(
    () => createGenericCliPlugin({ id: 'gen', commandAllowlist: [], outputContractParser: () => ({}) }),
    error => error?.code === 'GENERIC_CLI_CONFIG_ALLOWLIST_REQUIRED',
  );
  assert.throws(
    () => createGenericCliPlugin({ id: 'gen', commandAllowlist: [{}], outputContractParser: () => ({}) }),
    error => error?.code === 'GENERIC_CLI_CONFIG_ALLOWLIST_ENTRY_INVALID',
  );
  assert.throws(
    () => createGenericCliPlugin({ id: 'gen', commandAllowlist: [{ command: 'echo' }] }),
    error => error?.code === 'GENERIC_CLI_CONFIG_PARSER_REQUIRED',
  );
});

test('createGenericCliPlugin produces a valid plugin object', () => {
  const plugin = createGenericCliPlugin({
    id: 'sample-generic',
    displayName: 'Sample Generic CLI',
    commandAllowlist: [{ command: 'echo', argsPrefix: ['hello'] }],
    outputContractParser: stdout => ({ status: 'done', summary: stdout, artifacts: [] }),
    dangerousArgs: ['--unsafe'],
  });
  assert.equal(plugin.id, 'sample-generic');
  assert.equal(plugin.family, 'cli');
  assert.equal(plugin.needsKey, false);
  assert.deepEqual([...plugin.dangerousArgs], ['--unsafe']);
});

test('generic plugin assertCommandAllowed rejects out-of-allowlist commands', () => {
  const plugin = createGenericCliPlugin({
    id: 'sample-generic-2',
    commandAllowlist: [{ command: 'echo' }],
    outputContractParser: () => ({ status: 'done', summary: '', artifacts: [] }),
  });
  assert.throws(
    () => plugin.assertCommandAllowed({ command: 'rm', args: [] }),
    error => error?.code === 'GENERIC_CLI_COMMAND_NOT_ALLOWED',
  );
  assert.doesNotThrow(() => plugin.assertCommandAllowed({ command: 'echo', args: ['hi'] }));
});

test('generic plugin assertCommandAllowed checks argsPrefix', () => {
  const plugin = createGenericCliPlugin({
    id: 'sample-generic-3',
    commandAllowlist: [{ command: 'node', argsPrefix: ['--check'] }],
    outputContractParser: () => ({ status: 'done', summary: '', artifacts: [] }),
  });
  assert.throws(
    () => plugin.assertCommandAllowed({ command: 'node', args: ['eval'] }),
    error => error?.code === 'GENERIC_CLI_COMMAND_NOT_ALLOWED',
  );
  assert.doesNotThrow(() => plugin.assertCommandAllowed({ command: 'node', args: ['--check', 'src/x.js'] }));
});

test('generic plugin can be registered, dispatched, and unregistered', () => {
  const id = `sample-generic-runtime-${Date.now()}`;
  const plugin = createGenericCliPlugin({
    id,
    commandAllowlist: [{ command: 'echo' }],
    outputContractParser: () => ({ status: 'done', summary: 'parsed', artifacts: [] }),
  });
  registerProviderPlugin(plugin);
  try {
    assert.equal(hasProviderPlugin(id), true);
    const got = getProviderPlugin(id);
    assert.equal(got.id, id);
    assert.deepEqual([...got.dangerousArgs], []);
  } finally {
    unregisterProviderPlugin(id);
  }
});

test('commandAllowed reports allowlist mismatch reasons explicitly', () => {
  const allow = [{ command: 'echo', argsPrefix: ['greet'] }];
  assert.equal(commandAllowed(allow, { command: 'echo', args: ['greet', 'world'] }).ok, true);
  assert.equal(commandAllowed(allow, { command: 'rm' }).reason, 'command-not-allowlisted');
  assert.equal(commandAllowed(allow, { command: 'echo', args: ['halt'] }).reason, 'args-prefix-mismatch');
});

test('claude-code plugin metadata exposes the dangerous arg consistently', () => {
  const plugin = getProviderPlugin('claude-code');
  assert.equal(plugin.dangerousArgs.includes('--dangerously-skip-permissions'), true);
  // The catalog entry does not include the dangerous arg (it's plugin-specific).
  const entry = getProviderEntry('claude-code');
  assert.equal(entry.id, 'claude-code');
});

test('assertGenericCliConfig is reusable for ad hoc validation', () => {
  assert.throws(() => assertGenericCliConfig(null));
  assert.doesNotThrow(() => assertGenericCliConfig({
    id: 'ok',
    commandAllowlist: [{ command: 'echo' }],
    outputContractParser: () => ({ status: 'done', summary: '', artifacts: [] }),
  }));
});
