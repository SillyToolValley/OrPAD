import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const repoRoot = path.resolve('.');
const cliPath = path.join(repoRoot, 'bin/orpad-cli.mjs');
const fixtureDir = path.join(repoRoot, 'tests/fixtures/orchestration-machine/node-pack-authoring/shareable-pack');

const {
  createNodePackRegistryEntryDraft,
  validateNodePackFolder,
} = require('../../src/main/orchestration-machine');

function diagnosticCodes(result) {
  return new Set((result.diagnostics || []).map(item => item.code));
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeInvalidPack(sourceDir) {
  await fs.mkdir(path.join(sourceDir, 'nodes'), { recursive: true });
  const pack = {
    kind: 'orpad.nodePack',
    schemaVersion: '1.0',
    id: 'community.invalid-authoring',
    name: 'Invalid Authoring Pack',
    version: '0.1.0',
    description: 'Invalid fixture with executable content.',
    origin: 'community',
    author: {
      name: 'Fixture Author',
      repository: 'https://github.com/example/orpad-invalid-authoring',
    },
    license: 'MIT',
    trustLevel: 'community',
    compatibility: {
      orpad: '>=1.0.0-beta.3',
      packFormat: 'orpad.nodePack.v1',
    },
    capabilities: ['read.workspace'],
    nodes: [{
      type: 'community.invalidAuthoring.exec',
      path: 'nodes/exec.or-node',
      runtimeHandlerKind: 'executable',
      handler: 'tools/run.js',
      capabilities: ['read.workspace'],
    }],
  };
  await fs.writeFile(path.join(sourceDir, 'orpad.node-pack.json'), `${JSON.stringify(pack, null, 2)}\n`, 'utf-8');
  await fs.writeFile(path.join(sourceDir, 'package.json'), '{"scripts":{"postinstall":"node tools/run.js"}}\n', 'utf-8');
  await fs.writeFile(path.join(sourceDir, 'nodes/exec.or-node'), '{"kind":"orpad.node"}\n', 'utf-8');
}

test('validateNodePackFolder accepts a shareable declarative pack fixture', async () => {
  const result = await validateNodePackFolder(fixtureDir);
  const codes = diagnosticCodes(result);

  assert.equal(result.success, true, JSON.stringify(result.diagnostics, null, 2));
  assert.equal(result.pack.id, 'community.shareable-review');
  assert.equal(result.readme.exists, true);
  assert.equal(codes.has('NODE_PACK_AUTHOR_README_MISSING'), false);
  assert.equal(result.declaredFiles.some(file => file.path === 'orpad.node-pack.json'), true);
  assert.equal(result.declaredFiles.some(file => file.path === 'nodes/review-note.or-node'), true);
  assert.equal(result.declaredFiles.some(file => file.path === 'skills/shareable-review.md'), true);
});

test('createNodePackRegistryEntryDraft generates a checksum-backed community draft entry', async () => {
  const manifestBuffer = await fs.readFile(path.join(fixtureDir, 'orpad.node-pack.json'));
  const result = await createNodePackRegistryEntryDraft(fixtureDir, {
    sourceRepository: 'https://github.com/example/orpad-shareable-review',
    sourceRef: 'v0.1.0',
    sourceRoot: 'packs/shareable-review',
  });

  assert.equal(result.success, true, JSON.stringify(result.diagnostics, null, 2));
  assert.equal(result.registryValidation.ok, true);
  assert.equal(result.entry.id, 'community.shareable-review');
  assert.equal(result.entry.trustLevel, 'community');
  assert.deepEqual(result.entry.nodeTypes, ['community.shareableReview.note']);
  assert.equal(result.entry.versions[0].review.status, 'community');
  assert.equal(Object.prototype.hasOwnProperty.call(result.entry.versions[0], 'signature'), false);
  assert.notEqual(result.entry.versions[0].review.status, 'approved');
  assert.equal(result.entry.versions[0].checksums.manifestSha256, sha256Hex(manifestBuffer));
  assert.match(
    result.entry.versions[0].manifestUrl,
    /^https:\/\/raw\.githubusercontent\.com\/example\/orpad-shareable-review\/v0\.1\.0\/packs\/shareable-review\/orpad\.node-pack\.json$/,
  );
  assert.equal(typeof result.entry.versions[0].checksums.files['nodes/review-note.or-node'], 'string');
  assert.equal(result.entry.versions[0].checksums.files['nodes/review-note.or-node'].length, 64);
});

test('validateNodePackFolder reports deterministic authoring diagnostics for unsafe packs', async () => {
  const sourceDir = await makeTempDir('orpad-node-pack-authoring-invalid-');
  await writeInvalidPack(sourceDir);

  const result = await validateNodePackFolder(sourceDir);
  const codes = diagnosticCodes(result);

  assert.equal(result.success, false);
  assert.equal(codes.has('NODE_PACK_EXECUTABLE_HANDLER_BLOCKED'), true);
  assert.equal(codes.has('NODE_PACK_PACKAGE_LIFECYCLE_SCRIPT_QUARANTINED'), true);
  assert.equal(codes.has('NODE_PACK_AUTHOR_README_MISSING'), true);
});

test('orpad node-packs validate and registry-entry create expose authoring results as JSON', async () => {
  const validate = await execFileAsync(process.execPath, [
    cliPath,
    'node-packs',
    'validate',
    fixtureDir,
    '--json',
  ], { encoding: 'utf-8' });
  const validateResult = JSON.parse(validate.stdout);

  assert.equal(validateResult.success, true, JSON.stringify(validateResult.diagnostics, null, 2));
  assert.equal(validateResult.pack.id, 'community.shareable-review');

  const draft = await execFileAsync(process.execPath, [
    cliPath,
    'node-packs',
    'registry-entry',
    'create',
    fixtureDir,
    '--source-repository',
    'https://github.com/example/orpad-shareable-review',
    '--source-ref',
    'v0.1.0',
    '--json',
  ], { encoding: 'utf-8' });
  const draftResult = JSON.parse(draft.stdout);

  assert.equal(draftResult.success, true, JSON.stringify(draftResult.diagnostics, null, 2));
  assert.equal(draftResult.entry.id, 'community.shareable-review');
  assert.equal(draftResult.entry.trustLevel, 'community');
  assert.equal(draftResult.entry.versions[0].review.status, 'community');
});
