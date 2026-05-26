import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = path.join(repoRoot, 'bin', 'orpad-cli.mjs');
const fixturePath = path.join(
  repoRoot,
  'tests/fixtures/orchestration-machine/node-pack-registry/valid-registry.json',
);

test('orpad node-packs registry list reads a local registry fixture', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    'node-packs',
    'registry',
    'list',
    '--registry',
    fixturePath,
    '--json',
  ], { encoding: 'utf-8' });
  const result = JSON.parse(stdout);

  assert.equal(result.success, true);
  assert.equal(result.ok, true);
  assert.equal(result.registry.registryId, 'orpad.community');
  assert.deepEqual(result.entries.map(entry => entry.id), [
    'community.electron-maintenance',
    'community.content-review',
  ]);
});

test('orpad node-packs registry search filters local registry entries', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    'node-packs',
    'registry',
    'search',
    'review',
    '--category',
    'Content',
    '--capability',
    'read.workspace',
    '--registry',
    fixturePath,
    '--json',
  ], { encoding: 'utf-8' });
  const result = JSON.parse(stdout);

  assert.equal(result.success, true);
  assert.equal(result.ok, true);
  assert.equal(result.query, 'review');
  assert.deepEqual(result.entries.map(entry => entry.id), ['community.content-review']);
});

test('orpad node-packs registry list reports missing registry source as JSON failure', async () => {
  let error;
  try {
    await execFileAsync(process.execPath, [
      cliPath,
      'node-packs',
      'registry',
      'list',
      '--json',
    ], { encoding: 'utf-8' });
  } catch (err) {
    error = err;
  }
  assert.ok(error, 'missing --registry should exit non-zero');
  const result = JSON.parse(error.stdout);

  assert.equal(result.success, false);
  assert.equal(result.ok, false);
  assert.match(result.error, /Missing --registry/);
});

test('orpad node-packs registry list exits non-zero for invalid registry files', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-invalid-registry-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const registryPath = path.join(dir, 'node-packs.json');
  await fs.writeFile(registryPath, JSON.stringify({
    kind: 'orpad.nodePackRegistry',
    schemaVersion: '2.0',
    registryId: 'orpad.invalid',
    name: 'Invalid Registry',
    entries: [],
  }), 'utf-8');

  let error;
  try {
    await execFileAsync(process.execPath, [
      cliPath,
      'node-packs',
      'registry',
      'list',
      '--registry',
      registryPath,
      '--json',
    ], { encoding: 'utf-8' });
  } catch (err) {
    error = err;
  }
  assert.ok(error, 'invalid registry should exit non-zero');
  const result = JSON.parse(error.stdout);

  assert.equal(result.success, false);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.some(item => item.code === 'NODE_PACK_REGISTRY_SCHEMA_VERSION_INVALID'), true);
});
