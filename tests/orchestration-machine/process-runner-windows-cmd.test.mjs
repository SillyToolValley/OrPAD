import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { windowsBatchSpawnSpec, runMachineProcess } = require('../../src/main/orchestration-machine/adapters/process-runner.js');

const isWindows = process.platform === 'win32';

test('windowsBatchSpawnSpec leaves non-batch commands untouched', () => {
  const spec = windowsBatchSpawnSpec('git', ['clone', '--depth', '1', 'https://example/repo', 'vendor/x']);
  assert.equal(spec.command, 'git');
  assert.deepEqual(spec.args, ['clone', '--depth', '1', 'https://example/repo', 'vendor/x']);
  assert.equal(spec.windowsVerbatimArguments, false);
});

test('windowsBatchSpawnSpec wraps a .cmd shim through cmd.exe with a quoted command line', { skip: !isWindows }, () => {
  const spec = windowsBatchSpawnSpec('C:\\Program Files\\nodejs\\npm.cmd', ['install', '--ignore-scripts']);
  assert.match(spec.command, /cmd\.exe$/i);
  assert.equal(spec.args[0], '/d');
  assert.equal(spec.args[1], '/s');
  assert.equal(spec.args[2], '/c');
  // The whole command line is a single verbatim arg, outer-quoted (cmd /s strips
  // exactly the outer pair) with the space-bearing shim path inner-quoted.
  assert.equal(spec.args.length, 4);
  assert.equal(spec.args[3], '""C:\\Program Files\\nodejs\\npm.cmd" install --ignore-scripts"');
  assert.equal(spec.windowsVerbatimArguments, true);
});

test('windowsBatchSpawnSpec also wraps .bat and is case-insensitive', { skip: !isWindows }, () => {
  const spec = windowsBatchSpawnSpec('tool.BAT', ['run']);
  assert.match(spec.command, /cmd\.exe$/i);
  assert.equal(spec.args[3], '"tool.BAT run"');
});

test('windowsBatchSpawnSpec defends against injection metacharacters in args', { skip: !isWindows }, () => {
  const spec = windowsBatchSpawnSpec('npm.cmd', ['install', '&& calc']);
  // The malicious arg is quoted so cmd.exe treats it as one literal token, not a
  // command separator.
  assert.equal(spec.args[3], '"npm.cmd install "&& calc""');
});

test('a Windows .cmd actually executes through runMachineProcess instead of failing EINVAL', { skip: !isWindows }, async () => {
  // Regression for the SpriteGenTest provision install: `spawn EINVAL` because a
  // .cmd was handed to spawn under shell:false. Use an always-present shim
  // (npm --version) and assert it ran rather than spawn-erroring.
  const npmShim = `${process.env.ProgramFiles}\\nodejs\\npm.cmd`;
  const result = await runMachineProcess({
    command: npmShim,
    args: ['--version'],
    cwd: process.cwd(),
    runId: 'run-windows-cmd-smoke',
    adapterCallId: 'windows-cmd-smoke',
    timeoutMs: 60000,
  });
  assert.equal(result.spawnError?.code || '', '', `unexpected spawn error: ${result.spawnError?.message || ''}`);
  assert.equal(result.code, 0, `npm --version exited ${result.code}: ${result.stderr}`);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});
