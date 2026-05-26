import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixturePath = path.join(
  repoRoot,
  'tests/fixtures/orchestration-machine/node-pack-registry/valid-registry.json',
);
const bundledRegistryPath = path.join(repoRoot, 'registry/node-packs.json');
const rendererPath = path.join(repoRoot, 'src/renderer/renderer.js');
const officialRegistrySource = 'https://raw.githubusercontent.com/OrPAD-Lab/orpad-registry/main/registry/node-packs.json';

const {
  SCHEMA_VERSIONS,
  canonicalNodePackRegistrySignaturePayload,
  createContractValidator,
  fetchNodePackRegistryUrl,
  latestRegistryVersion,
  loadNodePackRegistrySource,
  normalizeNodePackRegistryIndex,
  nodePackRegistryCachePath,
  readNodePackRegistryFile,
  searchNodePackRegistryEntries,
  findNodePackRegistryCandidates,
  summarizeNodePackRegistry,
  summarizeNodePackRegistryEntry,
} = require('../../src/main/orchestration-machine');

async function fixtureRegistry(overrides = {}) {
  const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf-8'));
  return {
    ...fixture,
    ...overrides,
  };
}

function codes(result) {
  return new Set(result.diagnostics.map(item => item.code));
}

function signRegistry(rawRegistry, keyId, privateKey) {
  const payload = Buffer.from(canonicalNodePackRegistrySignaturePayload(rawRegistry), 'utf-8');
  return {
    ...rawRegistry,
    signature: {
      scheme: 'ed25519',
      keyId,
      value: sign(null, payload, privateKey).toString('base64'),
    },
  };
}

test('node pack registry fixture validates as a Machine contract and renderer-safe summary', async () => {
  const raw = await fixtureRegistry();
  const contract = createContractValidator().validate('nodePackRegistry', raw);
  const result = normalizeNodePackRegistryIndex(raw, { sourcePath: fixturePath });

  assert.equal(SCHEMA_VERSIONS.nodePackRegistry, 'orpad.nodePackRegistry.v1');
  assert.equal(contract.ok, true, JSON.stringify(contract.errors, null, 2));
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2));
  assert.equal(result.registry.registryId, 'orpad.community');
  assert.equal(result.registry.governance.reviewModel, 'orpad-pr-reviewed');
  assert.equal(result.registry.governance.registryTrust, 'official');
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].id, 'community.electron-maintenance');
  assert.equal(latestRegistryVersion(result.entries[1]).version, '0.2.0');

  const summary = summarizeNodePackRegistry(result.registry);
  assert.deepEqual(summary.entries.map(entry => entry.id), [
    'community.electron-maintenance',
    'community.content-review',
  ]);
  assert.equal(summary.entries[0].installable, true);
  assert.equal(summary.entries[0].sourceRepository, 'https://github.com/example/orpad-electron-maintenance-pack');
  assert.equal(summary.entries[0].reviewStatus, 'approved');
  assert.equal(summary.entries[0].reviewId, 'orpad-registry-pr-42');
  assert.equal(summary.entries[0].metadataTrust, 'orpad-official-registry-reviewed');
  assert.equal(summary.entries[1].metadataTrust, 'registry-discovery-only');
  assert.deepEqual(summary.entries[0].capabilities, ['read.workspace']);
  assert.deepEqual(summary.entries[0].nodeTypes, ['community.electronMaintenance.review']);
});

test('bundled official node pack registry points submissions at OrPAD-Lab registry repo', async () => {
  const raw = JSON.parse(await fs.readFile(bundledRegistryPath, 'utf-8'));
  const contract = createContractValidator().validate('nodePackRegistry', raw);
  const result = normalizeNodePackRegistryIndex(raw, { sourcePath: bundledRegistryPath });
  const summary = summarizeNodePackRegistry(result.registry);

  assert.equal(contract.ok, true, JSON.stringify(contract.errors, null, 2));
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2));
  assert.equal(summary.registryId, 'orpad.official');
  assert.equal(summary.governance.registryTrust, 'official');
  assert.equal(summary.governance.reviewModel, 'orpad-pr-reviewed');
  assert.equal(summary.governance.submissions.url, 'https://github.com/OrPAD-Lab/orpad-registry/pulls');
  assert.equal(summary.governance.reviewPolicyUrl, 'https://github.com/OrPAD-Lab/orpad-registry/blob/main/REGISTRY_POLICY.md');
});

test('package manager default registry source uses OrPAD-Lab registry raw index', async () => {
  const renderer = await fs.readFile(rendererPath, 'utf-8');

  assert.match(renderer, new RegExp(`NODE_PACK_MANAGER_DEFAULT_REGISTRY_SOURCE = '${officialRegistrySource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
});

test('node pack registry file reader loads local fixture registries without network access', async () => {
  const result = await readNodePackRegistryFile(fixturePath);

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2));
  assert.equal(result.registry.sourcePath, path.resolve(fixturePath));
  assert.equal(result.entries.length, 2);
});

test('node pack registry URL loader accepts mocked HTTPS JSON without depending on content-type', async () => {
  const raw = await fixtureRegistry();
  const result = await fetchNodePackRegistryUrl('https://registry.example.test/index.json', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(raw),
    }),
  });

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2));
  assert.equal(result.entries.length, 2);
});

test('node pack registry verifies a signed registry when a trusted public key is configured', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const raw = await fixtureRegistry();
  delete raw.signature;
  const signed = signRegistry(raw, 'orpad-registry-test-key', privateKey);

  const result = normalizeNodePackRegistryIndex(signed, {
    trustedRegistryPublicKeys: {
      'orpad-registry-test-key': publicPem,
    },
  });
  const summary = summarizeNodePackRegistry(result.registry);

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2));
  assert.equal(result.registry.signature.verified, true);
  assert.equal(summary.signature.verified, true);
  assert.equal(summary.signature.keyId, 'orpad-registry-test-key');
});

test('node pack registry rejects a bad signature when a trusted public key is configured', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const raw = await fixtureRegistry();
  delete raw.signature;
  const signed = signRegistry(raw, 'orpad-registry-test-key', privateKey);
  signed.entries[0].name = 'Tampered Registry Entry';

  const result = normalizeNodePackRegistryIndex(signed, {
    trustedRegistryPublicKeys: {
      'orpad-registry-test-key': publicPem,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(codes(result).has('NODE_PACK_REGISTRY_SIGNATURE_INVALID'), true);
  assert.equal(result.registry.signature.verified, false);
});

test('node pack registry rejects unsupported schema versions before install work', async () => {
  const result = normalizeNodePackRegistryIndex(await fixtureRegistry({ schemaVersion: '2.0' }));

  assert.equal(result.ok, false);
  assert.equal(codes(result).has('NODE_PACK_REGISTRY_SCHEMA_VERSION_INVALID'), true);
});

test('node pack registry URL loader rejects non-HTTPS sources', async () => {
  const result = await fetchNodePackRegistryUrl('http://registry.example.test/index.json', {
    fetchImpl: async () => {
      throw new Error('fetch should not run for unsafe URLs');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(codes(result).has('NODE_PACK_REGISTRY_SOURCE_URL_UNSAFE'), true);
});

test('node pack registry rejects malformed root shapes', () => {
  const result = normalizeNodePackRegistryIndex([]);

  assert.equal(result.ok, false);
  assert.equal(codes(result).has('NODE_PACK_REGISTRY_INVALID'), true);
});

test('node pack registry reports duplicate entry ids deterministically', async () => {
  const raw = await fixtureRegistry();
  raw.entries = [raw.entries[0], { ...raw.entries[0], name: 'Duplicate Electron Pack' }];

  const result = normalizeNodePackRegistryIndex(raw);

  assert.equal(result.ok, false);
  assert.equal(codes(result).has('NODE_PACK_REGISTRY_ENTRY_DUPLICATE_ID'), true);
  const duplicate = result.diagnostics.find(item => item.code === 'NODE_PACK_REGISTRY_ENTRY_DUPLICATE_ID');
  assert.equal(duplicate.entryId, 'community.electron-maintenance');
  assert.equal(duplicate.path, 'entries[1].id');
});

test('node pack registry reports duplicate versions inside one entry', async () => {
  const raw = await fixtureRegistry();
  raw.entries[1].versions = [raw.entries[1].versions[0], { ...raw.entries[1].versions[0] }];

  const result = normalizeNodePackRegistryIndex(raw);

  assert.equal(result.ok, false);
  assert.equal(codes(result).has('NODE_PACK_REGISTRY_VERSION_DUPLICATE'), true);
});

test('node pack registry rejects unsafe manifest URLs and source metadata', async () => {
  const raw = await fixtureRegistry();
  raw.entries[0].versions[0].manifestUrl = 'http://example.test/orpad.node-pack.json';
  raw.entries[0].versions[0].sourceRepository = 'ssh://example.test/repo.git';
  raw.entries[0].versions[0].manifestPath = '../orpad.node-pack.json';
  raw.entries[0].versions[0].sourceRoot = '../pack';

  const result = normalizeNodePackRegistryIndex(raw);
  const resultCodes = codes(result);

  assert.equal(result.ok, false);
  assert.equal(resultCodes.has('NODE_PACK_REGISTRY_MANIFEST_URL_UNSAFE'), true);
  assert.equal(resultCodes.has('NODE_PACK_REGISTRY_SOURCE_REPOSITORY_UNSAFE'), true);
  assert.equal(resultCodes.has('NODE_PACK_REGISTRY_MANIFEST_PATH_UNSAFE'), true);
  assert.equal(resultCodes.has('NODE_PACK_REGISTRY_SOURCE_ROOT_UNSAFE'), true);
});

test('node pack registry bounds entry count before registry browse surfaces it', async () => {
  const raw = await fixtureRegistry();
  const result = normalizeNodePackRegistryIndex(raw, { maxEntries: 1 });

  assert.equal(result.ok, false);
  assert.equal(codes(result).has('NODE_PACK_REGISTRY_ENTRIES_TOO_MANY'), true);
  const diagnostic = result.diagnostics.find(item => item.code === 'NODE_PACK_REGISTRY_ENTRIES_TOO_MANY');
  assert.equal(diagnostic.entryCount, 2);
  assert.equal(diagnostic.maxEntries, 1);
});

test('node pack registry file reader enforces byte limits before parsing', async () => {
  const result = await readNodePackRegistryFile(fixturePath, { byteLimit: 10 });

  assert.equal(result.ok, false);
  assert.equal(codes(result).has('NODE_PACK_REGISTRY_FILE_TOO_LARGE'), true);
});

test('node pack registry rejects entries missing install source metadata', async () => {
  const raw = await fixtureRegistry();
  delete raw.entries[0].versions[0].manifestUrl;
  delete raw.entries[0].versions[0].sourceRepository;
  delete raw.entries[0].versions[0].sourceRef;
  delete raw.entries[0].versions[0].manifestPath;

  const result = normalizeNodePackRegistryIndex(raw);
  const resultCodes = codes(result);

  assert.equal(result.ok, false);
  assert.equal(resultCodes.has('NODE_PACK_REGISTRY_VERSION_SOURCE_MISSING'), true);
  assert.equal(resultCodes.has('NODE_PACK_REGISTRY_MANIFEST_URL_MISSING'), true);
  assert.equal(resultCodes.has('NODE_PACK_REGISTRY_SOURCE_REPOSITORY_MISSING'), true);
  assert.equal(resultCodes.has('NODE_PACK_REGISTRY_SOURCE_REF_MISSING'), true);
  assert.equal(resultCodes.has('NODE_PACK_REGISTRY_MANIFEST_PATH_MISSING'), true);
});

test('node pack registry summary exposes sanitized immutable version review metadata', async () => {
  const result = normalizeNodePackRegistryIndex(await fixtureRegistry());
  const entry = result.entries[0];
  const summary = summarizeNodePackRegistryEntry(entry);

  assert.equal(Array.isArray(summary.versions), true);
  assert.equal(summary.versions[0].version, '0.1.0');
  assert.equal(Object.prototype.hasOwnProperty.call(summary.versions[0], 'manifestUrl'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'manifestUrl'), false);
  assert.equal(summary.versions[0].reviewStatus, 'approved');
  assert.equal(summary.versions[0].reviewId, 'orpad-registry-pr-42');
  assert.deepEqual(summary.versions[0].approvedCapabilities, ['read.workspace']);
  assert.deepEqual(summary.keywords, ['electron', 'maintenance']);
  summary.versions[0].sourceRef = 'mutated';
  assert.equal(entry.versions[0].sourceRef, 'v0.1.0');
  summary.keywords.push('mutated');
  assert.deepEqual(entry.keywords, ['electron', 'maintenance']);
});

test('node pack registry search matches text category and capability filters', async () => {
  const result = normalizeNodePackRegistryIndex(await fixtureRegistry());

  assert.deepEqual(
    searchNodePackRegistryEntries(result.entries, 'electron').map(entry => entry.id),
    ['community.electron-maintenance'],
  );
  assert.deepEqual(
    searchNodePackRegistryEntries(result.entries, 'community.contentReview.note').map(entry => entry.id),
    ['community.content-review'],
  );
  assert.deepEqual(
    searchNodePackRegistryEntries(result.entries, 'review', { category: 'Content' }).map(entry => entry.id),
    ['community.content-review'],
  );
  assert.deepEqual(
    searchNodePackRegistryEntries(result.entries, 'review', { capability: 'write.workspace' }).map(entry => entry.id),
    [],
  );
});

test('node pack registry candidates match missing pack ids and graph node types', async () => {
  const result = normalizeNodePackRegistryIndex(await fixtureRegistry());
  const candidates = findNodePackRegistryCandidates(result.entries, {
    registry: result.registry,
    diagnostics: [
      { code: 'PIPELINE_NODE_PACK_UNKNOWN', packId: 'community.electron-maintenance' },
      { code: 'GRAPH_NODE_TYPE_UNKNOWN', nodeType: 'community.contentReview.note' },
    ],
  });

  assert.equal(candidates.success, true);
  assert.deepEqual(candidates.candidates.map(entry => entry.id), [
    'community.electron-maintenance',
    'community.content-review',
  ]);
  assert.deepEqual(candidates.candidates[0].matchReasons, [
    { kind: 'pack-id', packId: 'community.electron-maintenance' },
  ]);
  assert.equal(candidates.candidates[0].metadataTrust, 'orpad-official-registry-reviewed');
  assert.equal(candidates.candidates[1].metadataTrust, 'registry-discovery-only');
  assert.deepEqual(candidates.candidates[1].matchReasons, [
    { kind: 'node-type', nodeType: 'community.contentReview.note' },
  ]);
});

test('node pack registry source loader writes cache for successful local registries', async (t) => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-registry-cache-'));
  t.after(() => fs.rm(userDataDir, { recursive: true, force: true }));

  const result = await loadNodePackRegistrySource(fixturePath, { userDataDir });
  const cachePath = nodePackRegistryCachePath(userDataDir, fixturePath);
  const cache = JSON.parse(await fs.readFile(cachePath, 'utf-8'));

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2));
  assert.equal(result.fromCache, false);
  assert.equal(cache.kind, 'orpad.nodePackRegistryCache');
  assert.equal(cache.source, fixturePath);
  assert.equal(cache.registry.registryId, 'orpad.community');
});

test('node pack registry source loader falls back to last valid cache when source fails', async (t) => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-registry-cache-fallback-'));
  const registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-registry-source-'));
  t.after(() => fs.rm(userDataDir, { recursive: true, force: true }));
  t.after(() => fs.rm(registryDir, { recursive: true, force: true }));
  const registryPath = path.join(registryDir, 'registry.json');
  await fs.copyFile(fixturePath, registryPath);

  const first = await loadNodePackRegistrySource(registryPath, { userDataDir });
  await fs.rm(registryPath, { force: true });
  const fallback = await loadNodePackRegistrySource(registryPath, { userDataDir });

  assert.equal(first.ok, true, JSON.stringify(first.diagnostics, null, 2));
  assert.equal(fallback.ok, true, JSON.stringify(fallback.diagnostics, null, 2));
  assert.equal(fallback.fromCache, true);
  assert.equal(fallback.diagnostics[0].code, 'NODE_PACK_REGISTRY_SOURCE_FAILED_CACHE_USED');
  assert.deepEqual(fallback.entries.map(entry => entry.id), [
    'community.electron-maintenance',
    'community.content-review',
  ]);
});

test('node pack registry source loader diagnoses corrupt cache and leaves source failure intact', async (t) => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-registry-cache-corrupt-'));
  const registryPath = path.join(userDataDir, 'missing-registry.json');
  t.after(() => fs.rm(userDataDir, { recursive: true, force: true }));
  const cachePath = nodePackRegistryCachePath(userDataDir, registryPath);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, '{not json', 'utf-8');

  const result = await loadNodePackRegistrySource(registryPath, { userDataDir });
  const resultCodes = codes(result);

  assert.equal(result.ok, false);
  assert.equal(result.fromCache, false);
  assert.equal(resultCodes.has('NODE_PACK_REGISTRY_FILE_UNREADABLE'), true);
  assert.equal(resultCodes.has('NODE_PACK_REGISTRY_CACHE_INVALID'), true);
});
