import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const {
  exportInstalledNodePackList,
  installLocalNodePack,
  installRegistryNodePack,
  listNodePackUpdateCandidates,
  readNodePackInstallLock,
  registryVersionFileUrl,
  rollbackInstalledNodePack,
  updateInstalledNodePacks,
} = require('../../src/main/orchestration-machine/node-pack-installer.js');
const {
  canonicalNodePackRegistrySignaturePayload,
} = require('../../src/main/orchestration-machine/node-pack-registry.js');
const {
  discoverNodePackManifests,
} = require('../../src/main/orchestration-machine/node-packs.js');

const repoRoot = path.resolve('.');
const cliPath = path.join(repoRoot, 'bin/orpad-cli.mjs');

function communityPack(overrides = {}) {
  return {
    kind: 'orpad.nodePack',
    schemaVersion: '1.0',
    id: 'community.safe-install',
    name: 'Safe Install Pack',
    version: '0.1.0',
    description: 'Safe declarative node pack install fixture.',
    origin: 'community',
    author: {
      name: 'Fixture Author',
      repository: 'https://github.com/example/orpad-safe-install',
    },
    license: 'MIT',
    trustLevel: 'signed',
    compatibility: {
      orpad: '^1.0.0-beta.3',
      packFormat: 'orpad.nodePack.v1',
    },
    capabilities: ['read.workspace'],
    nodes: [{
      type: 'community.safeInstall.node',
      path: 'nodes/safe.or-node',
      runtimeHandlerKind: 'metadata-only',
      capabilities: ['read.workspace'],
    }],
    skills: [{
      id: 'safe-install-skill',
      path: 'skills/safe-install.md',
    }],
    ...overrides,
  };
}

function trustEvidenceFor(packId) {
  return {
    trustEvidenceByPack: {
      [packId]: {
        signature: {
          verified: true,
          scheme: 'ed25519',
          signer: 'Fixture Author',
          fingerprint: 'fixture-signature',
        },
      },
    },
  };
}

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writePack(sourceDir, pack, files = {}) {
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, 'orpad.node-pack.json'),
    `${JSON.stringify(pack, null, 2)}\n`,
    'utf-8',
  );
  const declaredFiles = {
    'nodes/safe.or-node': '{"kind":"orpad.node"}\n',
    'skills/safe-install.md': '# Safe install skill\n',
    ...files,
  };
  for (const [relativePath, contents] of Object.entries(declaredFiles)) {
    const target = path.join(sourceDir, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf-8');
  }
}

function diagnosticCodes(result) {
  return new Set((result.diagnostics || []).map(item => item.code));
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function fetchImplForBuffers(fetchMap) {
  return async (url) => {
    const buffer = fetchMap.get(url);
    return {
      ok: Boolean(buffer),
      status: buffer ? 200 : 404,
      arrayBuffer: async () => (buffer || Buffer.alloc(0)).buffer.slice(
        (buffer || Buffer.alloc(0)).byteOffset,
        (buffer || Buffer.alloc(0)).byteOffset + (buffer || Buffer.alloc(0)).byteLength,
      ),
    };
  };
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

function registryForPack(pack, versionInfo, overrides = {}) {
  return {
    kind: 'orpad.nodePackRegistry',
    schemaVersion: '1.0',
    registryId: overrides.registryId || 'orpad.test',
    name: overrides.name || 'Test Registry',
    entries: [{
      id: pack.id,
      name: pack.name,
      description: pack.description,
      latestVersion: overrides.latestVersion || versionInfo.version,
      versions: overrides.versions || [versionInfo],
      author: pack.author,
      license: pack.license,
      trustLevel: pack.trustLevel,
      capabilities: pack.capabilities,
      keywords: ['registry'],
      categories: ['Testing'],
    }],
  };
}

function registryVersionForPack(pack, version, repositoryName = 'orpad-registry-safe') {
  return {
    version,
    manifestUrl: `https://raw.githubusercontent.com/example/${repositoryName}/v${version}/orpad.node-pack.json`,
    sourceRepository: `https://github.com/example/${repositoryName}`,
    sourceRef: `v${version}`,
    sourceRoot: '',
    manifestPath: 'orpad.node-pack.json',
    checksums: {},
  };
}

function buffersForPack(pack) {
  return {
    manifest: Buffer.from(`${JSON.stringify(pack, null, 2)}\n`, 'utf-8'),
    node: Buffer.from('{"kind":"orpad.node"}\n', 'utf-8'),
    skill: Buffer.from('# Safe install skill\n', 'utf-8'),
  };
}

function addPackVersionFetches(fetchMap, versionInfo, buffers) {
  fetchMap.set(versionInfo.manifestUrl, buffers.manifest);
  fetchMap.set(registryVersionFileUrl(versionInfo, 'nodes/safe.or-node'), buffers.node);
  fetchMap.set(registryVersionFileUrl(versionInfo, 'skills/safe-install.md'), buffers.skill);
}

async function readInstalledManifest(userDataDir, packId) {
  return JSON.parse(await fs.readFile(
    path.join(userDataDir, 'nodes', packId, 'orpad.node-pack.json'),
    'utf-8',
  ));
}

test('installLocalNodePack stages declared files, activates under user data, and writes install lock', async () => {
  const userDataDir = await makeTempDir('orpad-node-pack-install-user-data-');
  const sourceDir = await makeTempDir('orpad-node-pack-install-source-');
  const pack = communityPack();
  await writePack(sourceDir, pack, {
    'README.md': '# Not declared but inert\n',
  });

  const result = await installLocalNodePack(sourceDir, {
    userDataDir,
    ...trustEvidenceFor(pack.id),
  });

  assert.equal(result.success, true, JSON.stringify(result.diagnostics, null, 2));
  assert.equal(result.nodePack.id, pack.id);
  assert.equal(result.nodePack.resolutionState, 'resolved');

  const installedRoot = path.join(userDataDir, 'nodes', pack.id);
  assert.equal((await fs.stat(path.join(installedRoot, 'nodes/safe.or-node'))).isFile(), true);
  assert.equal((await fs.stat(path.join(installedRoot, 'skills/safe-install.md'))).isFile(), true);
  await assert.rejects(fs.stat(path.join(installedRoot, 'README.md')), /ENOENT/);

  const lock = await readNodePackInstallLock({ userDataDir });
  assert.equal(lock.ok, true);
  assert.equal(lock.lock.packs.length, 1);
  assert.equal(lock.lock.packs[0].id, pack.id);
  assert.equal(lock.lock.packs[0].source, 'local');
  assert.equal(lock.lock.packs[0].enabled, true);

  const discovered = discoverNodePackManifests({
    userDataDir,
    ...trustEvidenceFor(pack.id),
  });
  assert.equal(discovered.nodePacks.some(item => item.id === pack.id), true);
});

test('installLocalNodePack records the original manifest checksum in the install lock', async () => {
  const userDataDir = await makeTempDir('orpad-node-pack-install-checksum-user-data-');
  const sourceDir = await makeTempDir('orpad-node-pack-install-checksum-source-');
  const pack = communityPack({ id: 'community.local-checksum' });
  await writePack(sourceDir, pack);
  const compactManifest = Buffer.from(JSON.stringify(pack), 'utf-8');
  await fs.writeFile(path.join(sourceDir, 'orpad.node-pack.json'), compactManifest);

  const result = await installLocalNodePack(sourceDir, {
    userDataDir,
    ...trustEvidenceFor(pack.id),
  });

  assert.equal(result.success, true, JSON.stringify(result.diagnostics, null, 2));
  const installedManifest = await fs.readFile(path.join(userDataDir, 'nodes', pack.id, 'orpad.node-pack.json'));
  const lock = await readNodePackInstallLock({ userDataDir });
  assert.equal(lock.lock.packs[0].manifestSha256, sha256Hex(compactManifest));
  assert.equal(lock.lock.packs[0].manifestSha256, sha256Hex(installedManifest));
});

test('local install pre-audits source lifecycle scripts before activation', async () => {
  const userDataDir = await makeTempDir('orpad-node-pack-install-lifecycle-user-data-');
  const sourceDir = await makeTempDir('orpad-node-pack-install-lifecycle-source-');
  const pack = communityPack({ id: 'community.lifecycle-blocked' });
  await writePack(sourceDir, pack);
  await fs.writeFile(
    path.join(sourceDir, 'package.json'),
    JSON.stringify({ scripts: { postinstall: 'node scripts/install.js' } }, null, 2),
    'utf-8',
  );

  const result = await installLocalNodePack(sourceDir, {
    userDataDir,
    ...trustEvidenceFor(pack.id),
  });

  assert.equal(result.success, false);
  assert.equal(diagnosticCodes(result).has('NODE_PACK_PACKAGE_LIFECYCLE_SCRIPT_QUARANTINED'), true);
  await assert.rejects(fs.stat(path.join(userDataDir, 'nodes', pack.id)), /ENOENT/);
});

test('local install blocks undeclared runnable source files before activation', async () => {
  const userDataDir = await makeTempDir('orpad-node-pack-install-runnable-user-data-');
  const sourceDir = await makeTempDir('orpad-node-pack-install-runnable-source-');
  const pack = communityPack({ id: 'community.runnable-blocked' });
  await writePack(sourceDir, pack, {
    'scripts/side-effect.js': 'console.log("blocked");\n',
  });

  const result = await installLocalNodePack(sourceDir, {
    userDataDir,
    ...trustEvidenceFor(pack.id),
  });

  assert.equal(result.success, false);
  assert.equal(diagnosticCodes(result).has('NODE_PACK_UNDECLARED_RUNNABLE_FILE_QUARANTINED'), true);
  await assert.rejects(fs.stat(path.join(userDataDir, 'nodes', pack.id)), /ENOENT/);
});

test('local install blocks executable handlers and unsafe asset paths', async () => {
  const userDataDir = await makeTempDir('orpad-node-pack-install-invalid-user-data-');
  const executableSource = await makeTempDir('orpad-node-pack-install-executable-source-');
  const executablePack = communityPack({
    id: 'community.executable-blocked',
    nodes: [{
      type: 'community.executableBlocked.node',
      path: 'nodes/safe.or-node',
      runtimeHandlerKind: 'executable',
      handler: 'handlers/run.js',
      capabilities: ['read.workspace'],
    }],
  });
  await writePack(executableSource, executablePack, {
    'handlers/run.js': 'console.log("blocked");\n',
  });

  const executableResult = await installLocalNodePack(executableSource, {
    userDataDir,
    ...trustEvidenceFor(executablePack.id),
  });

  assert.equal(executableResult.success, false);
  assert.equal(diagnosticCodes(executableResult).has('NODE_PACK_EXECUTABLE_HANDLER_BLOCKED'), true);

  const traversalSource = await makeTempDir('orpad-node-pack-install-traversal-source-');
  const traversalPack = communityPack({
    id: 'community.traversal-blocked',
    graphs: [{
      id: 'escape',
      path: '../escape.or-graph',
    }],
  });
  await writePack(traversalSource, traversalPack);

  const traversalResult = await installLocalNodePack(traversalSource, {
    userDataDir,
    ...trustEvidenceFor(traversalPack.id),
  });

  assert.equal(traversalResult.success, false);
  assert.equal(diagnosticCodes(traversalResult).has('NODE_PACK_ASSET_PATH_UNSAFE'), true);
});

test('failed replacement leaves the previous active pack untouched', async () => {
  const userDataDir = await makeTempDir('orpad-node-pack-install-replace-user-data-');
  const firstSource = await makeTempDir('orpad-node-pack-install-replace-first-');
  const packId = 'community.replace-safe';
  const firstPack = communityPack({
    id: packId,
    version: '0.1.0',
    nodes: [{
      type: 'community.replaceSafe.node',
      path: 'nodes/safe.or-node',
      runtimeHandlerKind: 'metadata-only',
      capabilities: ['read.workspace'],
    }],
  });
  await writePack(firstSource, firstPack);

  const firstResult = await installLocalNodePack(firstSource, {
    userDataDir,
    ...trustEvidenceFor(packId),
  });
  assert.equal(firstResult.success, true, JSON.stringify(firstResult.diagnostics, null, 2));

  const secondSource = await makeTempDir('orpad-node-pack-install-replace-second-');
  const secondPack = communityPack({
    id: packId,
    version: '0.2.0',
    nodes: [{
      type: 'community.replaceSafe.node',
      path: 'nodes/safe.or-node',
      runtimeHandlerKind: 'executable',
      handler: 'handlers/run.js',
      capabilities: ['read.workspace'],
    }],
  });
  await writePack(secondSource, secondPack, {
    'handlers/run.js': 'console.log("blocked");\n',
  });

  const secondResult = await installLocalNodePack(secondSource, {
    userDataDir,
    ...trustEvidenceFor(packId),
  });

  assert.equal(secondResult.success, false);
  const activeManifest = await readInstalledManifest(userDataDir, packId);
  assert.equal(activeManifest.version, '0.1.0');
});

test('install detects node type conflicts with already installed packs before activation', async () => {
  const userDataDir = await makeTempDir('orpad-node-pack-install-conflict-user-data-');
  const firstSource = await makeTempDir('orpad-node-pack-install-conflict-first-');
  const firstPack = communityPack({
    id: 'community.conflict-left',
    nodes: [{
      type: 'community.conflict.shared',
      path: 'nodes/safe.or-node',
      runtimeHandlerKind: 'metadata-only',
      capabilities: ['read.workspace'],
    }],
  });
  await writePack(firstSource, firstPack);
  const firstResult = await installLocalNodePack(firstSource, {
    userDataDir,
    ...trustEvidenceFor(firstPack.id),
  });
  assert.equal(firstResult.success, true, JSON.stringify(firstResult.diagnostics, null, 2));

  const secondSource = await makeTempDir('orpad-node-pack-install-conflict-second-');
  const secondPack = communityPack({
    id: 'community.conflict-right',
    nodes: [{
      type: 'community.conflict.shared',
      path: 'nodes/safe.or-node',
      runtimeHandlerKind: 'metadata-only',
      capabilities: ['read.workspace'],
    }],
  });
  await writePack(secondSource, secondPack);
  const secondResult = await installLocalNodePack(secondSource, {
    userDataDir,
    ...trustEvidenceFor(secondPack.id),
  });

  assert.equal(secondResult.success, false);
  assert.equal(diagnosticCodes(secondResult).has('NODE_PACK_INSTALL_NODE_TYPE_CONFLICT'), true);
  await assert.rejects(fs.stat(path.join(userDataDir, 'nodes', secondPack.id)), /ENOENT/);
});

test('installRegistryNodePack fetches declared raw files and records registry source in the lock', async () => {
  const userDataDir = await makeTempDir('orpad-node-pack-install-registry-user-data-');
  const registryDir = await makeTempDir('orpad-node-pack-install-registry-');
  const pack = communityPack({
    id: 'community.registry-safe',
    nodes: [{
      type: 'community.registrySafe.node',
      path: 'nodes/safe.or-node',
      runtimeHandlerKind: 'metadata-only',
      capabilities: ['read.workspace'],
    }],
  });
  const versionInfo = {
    version: '0.1.0',
    manifestUrl: 'https://raw.githubusercontent.com/example/orpad-registry-safe/v0.1.0/orpad.node-pack.json',
    sourceRepository: 'https://github.com/example/orpad-registry-safe',
    sourceRef: 'v0.1.0',
    sourceRoot: '',
    manifestPath: 'orpad.node-pack.json',
    checksums: {},
  };
  const registry = {
    kind: 'orpad.nodePackRegistry',
    schemaVersion: '1.0',
    registryId: 'orpad.test',
    name: 'Test Registry',
    entries: [{
      id: pack.id,
      name: pack.name,
      description: pack.description,
      latestVersion: versionInfo.version,
      versions: [versionInfo],
      author: pack.author,
      license: pack.license,
      trustLevel: pack.trustLevel,
      capabilities: pack.capabilities,
      keywords: ['registry'],
      categories: ['Testing'],
    }],
  };
  const registryPath = path.join(registryDir, 'registry.json');
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');

  const manifestBuffer = Buffer.from(`${JSON.stringify(pack, null, 2)}\n`, 'utf-8');
  const nodeBuffer = Buffer.from('{"kind":"orpad.node"}\n', 'utf-8');
  const skillBuffer = Buffer.from('# Safe install skill\n', 'utf-8');
  const fetchMap = new Map([
    [versionInfo.manifestUrl, manifestBuffer],
    [registryVersionFileUrl(versionInfo, 'nodes/safe.or-node'), nodeBuffer],
    [registryVersionFileUrl(versionInfo, 'skills/safe-install.md'), skillBuffer],
  ]);

  const result = await installRegistryNodePack({
    registry: registryPath,
    packId: pack.id,
  }, {
    userDataDir,
    fetchImpl: fetchImplForBuffers(fetchMap),
    ...trustEvidenceFor(pack.id),
  });

  assert.equal(result.success, true, JSON.stringify(result.diagnostics, null, 2));
  assert.equal((await fs.stat(path.join(userDataDir, 'nodes', pack.id, 'nodes/safe.or-node'))).isFile(), true);
  const lock = await readNodePackInstallLock({ userDataDir });
  assert.equal(lock.lock.packs[0].source, 'registry:orpad.test');
  assert.equal(lock.lock.packs[0].sourceRepository, versionInfo.sourceRepository);
});

test('installRegistryNodePack rejects a tampered manifest checksum before activation', async () => {
  const userDataDir = await makeTempDir('orpad-node-pack-install-manifest-checksum-user-data-');
  const registryDir = await makeTempDir('orpad-node-pack-install-manifest-checksum-registry-');
  const pack = communityPack({ id: 'community.registry-tampered-manifest' });
  const versionInfo = {
    version: '0.1.0',
    manifestUrl: 'https://raw.githubusercontent.com/example/orpad-registry-tampered/v0.1.0/orpad.node-pack.json',
    sourceRepository: 'https://github.com/example/orpad-registry-tampered',
    sourceRef: 'v0.1.0',
    sourceRoot: '',
    manifestPath: 'orpad.node-pack.json',
    checksums: {
      manifestSha256: '0'.repeat(64),
    },
  };
  const registry = {
    kind: 'orpad.nodePackRegistry',
    schemaVersion: '1.0',
    registryId: 'orpad.test',
    name: 'Test Registry',
    entries: [{
      id: pack.id,
      name: pack.name,
      latestVersion: versionInfo.version,
      versions: [versionInfo],
      author: pack.author,
      license: pack.license,
      trustLevel: pack.trustLevel,
      capabilities: pack.capabilities,
    }],
  };
  const registryPath = path.join(registryDir, 'registry.json');
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
  const manifestBuffer = Buffer.from(`${JSON.stringify(pack, null, 2)}\n`, 'utf-8');

  const result = await installRegistryNodePack({
    registry: registryPath,
    packId: pack.id,
  }, {
    userDataDir,
    fetchImpl: fetchImplForBuffers(new Map([[versionInfo.manifestUrl, manifestBuffer]])),
    ...trustEvidenceFor(pack.id),
  });

  assert.equal(result.success, false);
  assert.equal(diagnosticCodes(result).has('NODE_PACK_INSTALL_MANIFEST_CHECKSUM_MISMATCH'), true);
  await assert.rejects(fs.stat(path.join(userDataDir, 'nodes', pack.id)), /ENOENT/);
});

test('installRegistryNodePack rejects a tampered declared asset checksum before activation', async () => {
  const userDataDir = await makeTempDir('orpad-node-pack-install-asset-checksum-user-data-');
  const registryDir = await makeTempDir('orpad-node-pack-install-asset-checksum-registry-');
  const pack = communityPack({ id: 'community.registry-tampered-asset' });
  const manifestBuffer = Buffer.from(`${JSON.stringify(pack, null, 2)}\n`, 'utf-8');
  const nodeBuffer = Buffer.from('{"kind":"orpad.node"}\n', 'utf-8');
  const skillBuffer = Buffer.from('# Safe install skill\n', 'utf-8');
  const versionInfo = {
    version: '0.1.0',
    manifestUrl: 'https://raw.githubusercontent.com/example/orpad-registry-tampered-asset/v0.1.0/orpad.node-pack.json',
    sourceRepository: 'https://github.com/example/orpad-registry-tampered-asset',
    sourceRef: 'v0.1.0',
    sourceRoot: '',
    manifestPath: 'orpad.node-pack.json',
    checksums: {
      manifestSha256: sha256Hex(manifestBuffer),
      files: {
        'nodes/safe.or-node': '1'.repeat(64),
        'skills/safe-install.md': sha256Hex(skillBuffer),
      },
    },
  };
  const registry = {
    kind: 'orpad.nodePackRegistry',
    schemaVersion: '1.0',
    registryId: 'orpad.test',
    name: 'Test Registry',
    entries: [{
      id: pack.id,
      name: pack.name,
      latestVersion: versionInfo.version,
      versions: [versionInfo],
      author: pack.author,
      license: pack.license,
      trustLevel: pack.trustLevel,
      capabilities: pack.capabilities,
    }],
  };
  const registryPath = path.join(registryDir, 'registry.json');
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
  const fetchMap = new Map([
    [versionInfo.manifestUrl, manifestBuffer],
    [registryVersionFileUrl(versionInfo, 'nodes/safe.or-node'), nodeBuffer],
    [registryVersionFileUrl(versionInfo, 'skills/safe-install.md'), skillBuffer],
  ]);

  const result = await installRegistryNodePack({
    registry: registryPath,
    packId: pack.id,
  }, {
    userDataDir,
    fetchImpl: fetchImplForBuffers(fetchMap),
    ...trustEvidenceFor(pack.id),
  });

  assert.equal(result.success, false);
  assert.equal(diagnosticCodes(result).has('NODE_PACK_INSTALL_DECLARED_FILE_CHECKSUM_MISMATCH'), true);
  await assert.rejects(fs.stat(path.join(userDataDir, 'nodes', pack.id)), /ENOENT/);
});

test('installRegistryNodePack converts verified registry signature checksum and review into Machine trust evidence', async () => {
  const userDataDir = await makeTempDir('orpad-node-pack-install-verified-registry-user-data-');
  const registryDir = await makeTempDir('orpad-node-pack-install-verified-registry-');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const pack = communityPack({
    id: 'community.registry-verified',
    trustLevel: 'verified',
    nodes: [{
      type: 'community.registryVerified.node',
      path: 'nodes/safe.or-node',
      runtimeHandlerKind: 'metadata-only',
      capabilities: ['read.workspace'],
    }],
  });
  const manifestBuffer = Buffer.from(`${JSON.stringify(pack, null, 2)}\n`, 'utf-8');
  const nodeBuffer = Buffer.from('{"kind":"orpad.node"}\n', 'utf-8');
  const skillBuffer = Buffer.from('# Safe install skill\n', 'utf-8');
  const versionInfo = {
    version: '0.1.0',
    manifestUrl: 'https://raw.githubusercontent.com/example/orpad-registry-verified/v0.1.0/orpad.node-pack.json',
    sourceRepository: 'https://github.com/example/orpad-registry-verified',
    sourceRef: 'v0.1.0',
    sourceRoot: '',
    manifestPath: 'orpad.node-pack.json',
    checksums: {
      manifestSha256: sha256Hex(manifestBuffer),
      files: {
        'nodes/safe.or-node': sha256Hex(nodeBuffer),
        'skills/safe-install.md': sha256Hex(skillBuffer),
      },
    },
    signature: {
      scheme: 'ed25519',
      value: 'registry-reviewed-version-signature',
    },
    review: {
      status: 'approved',
      reviewedAt: '2026-05-25T00:00:00.000Z',
      reviewId: 'orpad-review-verified-registry',
    },
  };
  const unsignedRegistry = {
    kind: 'orpad.nodePackRegistry',
    schemaVersion: '1.0',
    registryId: 'orpad.verified',
    name: 'Verified Registry',
    entries: [{
      id: pack.id,
      name: pack.name,
      description: pack.description,
      latestVersion: versionInfo.version,
      versions: [versionInfo],
      author: pack.author,
      license: pack.license,
      trustLevel: pack.trustLevel,
      capabilities: pack.capabilities,
      keywords: ['verified'],
      categories: ['Testing'],
    }],
  };
  const registry = signRegistry(unsignedRegistry, 'orpad-registry-test-key', privateKey);
  const registryPath = path.join(registryDir, 'registry.json');
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
  const fetchMap = new Map([
    [versionInfo.manifestUrl, manifestBuffer],
    [registryVersionFileUrl(versionInfo, 'nodes/safe.or-node'), nodeBuffer],
    [registryVersionFileUrl(versionInfo, 'skills/safe-install.md'), skillBuffer],
  ]);

  const result = await installRegistryNodePack({
    registry: registryPath,
    packId: pack.id,
  }, {
    userDataDir,
    fetchImpl: fetchImplForBuffers(fetchMap),
    trustedRegistryPublicKeys: {
      'orpad-registry-test-key': publicPem,
    },
  });

  assert.equal(result.success, true, JSON.stringify(result.diagnostics, null, 2));
  assert.equal(result.nodePack.resolutionState, 'resolved');
  assert.equal(result.nodePack.validationStatus, 'valid');
  assert.equal(diagnosticCodes(result).has('NODE_PACK_SELF_DECLARED_TRUST_REQUIRES_PROOF'), false);
  const lock = await readNodePackInstallLock({ userDataDir });
  assert.equal(lock.lock.packs[0].source, 'registry:orpad.verified');
  assert.equal(lock.lock.packs[0].validationStatus, 'valid');
});

test('node pack update candidates compare registry latest versions and skip pinned installs by default', async () => {
  const userDataDir = await makeTempDir('orpad-node-pack-update-candidates-user-data-');
  const registryDir = await makeTempDir('orpad-node-pack-update-candidates-registry-');
  const registryPath = path.join(registryDir, 'registry.json');
  const packV1 = communityPack({
    id: 'community.update-pinned',
    version: '0.1.0',
    nodes: [{
      type: 'community.updatePinned.node',
      path: 'nodes/safe.or-node',
      runtimeHandlerKind: 'metadata-only',
      capabilities: ['read.workspace'],
    }],
  });
  const packV2 = { ...packV1, version: '0.2.0' };
  const versionV1 = registryVersionForPack(packV1, '0.1.0', 'orpad-update-pinned');
  const versionV2 = registryVersionForPack(packV2, '0.2.0', 'orpad-update-pinned');
  await fs.writeFile(registryPath, `${JSON.stringify(registryForPack(packV1, versionV1), null, 2)}\n`, 'utf-8');
  const fetchMap = new Map();
  addPackVersionFetches(fetchMap, versionV1, buffersForPack(packV1));
  addPackVersionFetches(fetchMap, versionV2, buffersForPack(packV2));

  const installResult = await installRegistryNodePack({
    registry: registryPath,
    packId: packV1.id,
    pinned: true,
  }, {
    userDataDir,
    fetchImpl: fetchImplForBuffers(fetchMap),
    ...trustEvidenceFor(packV1.id),
  });
  assert.equal(installResult.success, true, JSON.stringify(installResult.diagnostics, null, 2));

  await fs.writeFile(registryPath, `${JSON.stringify(registryForPack(packV2, versionV2, {
    latestVersion: versionV2.version,
    versions: [versionV1, versionV2],
  }), null, 2)}\n`, 'utf-8');
  const candidates = await listNodePackUpdateCandidates({
    registry: registryPath,
  }, {
    userDataDir,
  });
  const candidate = candidates.candidates.find(item => item.id === packV1.id);

  assert.equal(candidates.success, true, JSON.stringify(candidates.diagnostics, null, 2));
  assert.equal(candidate.updateAvailable, true);
  assert.equal(candidate.skipped, true);
  assert.equal(candidate.reason, 'pinned');

  const updateResult = await updateInstalledNodePacks({
    registry: registryPath,
  }, {
    userDataDir,
    fetchImpl: fetchImplForBuffers(fetchMap),
    ...trustEvidenceFor(packV1.id),
  });
  assert.equal(updateResult.success, true, JSON.stringify(updateResult.diagnostics, null, 2));
  assert.equal(updateResult.results.length, 0);
  assert.equal((await readInstalledManifest(userDataDir, packV1.id)).version, '0.1.0');
});

test('node pack update failure leaves the previous active version untouched', async () => {
  const userDataDir = await makeTempDir('orpad-node-pack-update-failure-user-data-');
  const registryDir = await makeTempDir('orpad-node-pack-update-failure-registry-');
  const registryPath = path.join(registryDir, 'registry.json');
  const packV1 = communityPack({
    id: 'community.update-failure',
    version: '0.1.0',
    nodes: [{
      type: 'community.updateFailure.node',
      path: 'nodes/safe.or-node',
      runtimeHandlerKind: 'metadata-only',
      capabilities: ['read.workspace'],
    }],
  });
  const packV2 = { ...packV1, version: '0.2.0' };
  const versionV1 = registryVersionForPack(packV1, '0.1.0', 'orpad-update-failure');
  const versionV2 = registryVersionForPack(packV2, '0.2.0', 'orpad-update-failure');
  const buffersV1 = buffersForPack(packV1);
  const buffersV2 = buffersForPack(packV2);
  versionV2.checksums = {
    manifestSha256: sha256Hex(buffersV2.manifest),
    files: {
      'nodes/safe.or-node': '2'.repeat(64),
      'skills/safe-install.md': sha256Hex(buffersV2.skill),
    },
  };
  await fs.writeFile(registryPath, `${JSON.stringify(registryForPack(packV1, versionV1), null, 2)}\n`, 'utf-8');
  const fetchMap = new Map();
  addPackVersionFetches(fetchMap, versionV1, buffersV1);
  addPackVersionFetches(fetchMap, versionV2, buffersV2);

  const installResult = await installRegistryNodePack({
    registry: registryPath,
    packId: packV1.id,
  }, {
    userDataDir,
    fetchImpl: fetchImplForBuffers(fetchMap),
    ...trustEvidenceFor(packV1.id),
  });
  assert.equal(installResult.success, true, JSON.stringify(installResult.diagnostics, null, 2));
  await fs.writeFile(registryPath, `${JSON.stringify(registryForPack(packV2, versionV2, {
    latestVersion: versionV2.version,
    versions: [versionV1, versionV2],
  }), null, 2)}\n`, 'utf-8');

  const updateResult = await updateInstalledNodePacks({
    registry: registryPath,
    packId: packV1.id,
  }, {
    userDataDir,
    fetchImpl: fetchImplForBuffers(fetchMap),
    ...trustEvidenceFor(packV1.id),
  });

  assert.equal(updateResult.success, false);
  assert.equal(diagnosticCodes(updateResult).has('NODE_PACK_INSTALL_DECLARED_FILE_CHECKSUM_MISMATCH'), true);
  assert.equal((await readInstalledManifest(userDataDir, packV1.id)).version, '0.1.0');
});

test('node pack update records rollback metadata and rollback restores the previous version', async () => {
  const userDataDir = await makeTempDir('orpad-node-pack-rollback-user-data-');
  const registryDir = await makeTempDir('orpad-node-pack-rollback-registry-');
  const registryPath = path.join(registryDir, 'registry.json');
  const packV1 = communityPack({
    id: 'community.rollback-safe',
    version: '0.1.0',
    nodes: [{
      type: 'community.rollbackSafe.node',
      path: 'nodes/safe.or-node',
      runtimeHandlerKind: 'metadata-only',
      capabilities: ['read.workspace'],
    }],
  });
  const packV2 = { ...packV1, version: '0.2.0' };
  const versionV1 = registryVersionForPack(packV1, '0.1.0', 'orpad-rollback-safe');
  const versionV2 = registryVersionForPack(packV2, '0.2.0', 'orpad-rollback-safe');
  await fs.writeFile(registryPath, `${JSON.stringify(registryForPack(packV1, versionV1), null, 2)}\n`, 'utf-8');
  const fetchMap = new Map();
  addPackVersionFetches(fetchMap, versionV1, buffersForPack(packV1));
  addPackVersionFetches(fetchMap, versionV2, buffersForPack(packV2));
  const evidence = trustEvidenceFor(packV1.id);

  const installResult = await installRegistryNodePack({
    registry: registryPath,
    packId: packV1.id,
  }, {
    userDataDir,
    fetchImpl: fetchImplForBuffers(fetchMap),
    ...evidence,
  });
  assert.equal(installResult.success, true, JSON.stringify(installResult.diagnostics, null, 2));
  await fs.writeFile(registryPath, `${JSON.stringify(registryForPack(packV2, versionV2, {
    latestVersion: versionV2.version,
    versions: [versionV1, versionV2],
  }), null, 2)}\n`, 'utf-8');

  const updateResult = await updateInstalledNodePacks({
    registry: registryPath,
    packId: packV1.id,
  }, {
    userDataDir,
    fetchImpl: fetchImplForBuffers(fetchMap),
    ...evidence,
  });
  assert.equal(updateResult.success, true, JSON.stringify(updateResult.diagnostics, null, 2));
  assert.equal((await readInstalledManifest(userDataDir, packV1.id)).version, '0.2.0');
  let lock = await readNodePackInstallLock({ userDataDir });
  assert.ok(lock.lock.packs[0].previousInstall?.backupPath);

  const rollbackResult = await rollbackInstalledNodePack(packV1.id, {
    userDataDir,
    ...evidence,
  });

  assert.equal(rollbackResult.success, true, JSON.stringify(rollbackResult.diagnostics, null, 2));
  assert.equal((await readInstalledManifest(userDataDir, packV1.id)).version, '0.1.0');
  lock = await readNodePackInstallLock({ userDataDir });
  assert.equal(lock.lock.packs[0].version, '0.1.0');
  assert.ok(lock.lock.packs[0].previousInstall?.backupPath);
});

test('exportInstalledNodePackList returns lock entries with discovery diagnostics for sharing', async () => {
  const userDataDir = await makeTempDir('orpad-node-pack-export-user-data-');
  const sourceDir = await makeTempDir('orpad-node-pack-export-source-');
  const pack = communityPack({
    id: 'community.export-safe',
    nodes: [{
      type: 'community.exportSafe.node',
      path: 'nodes/safe.or-node',
      runtimeHandlerKind: 'metadata-only',
      capabilities: ['read.workspace'],
    }],
  });
  await writePack(sourceDir, pack);
  const installResult = await installLocalNodePack(sourceDir, {
    userDataDir,
    ...trustEvidenceFor(pack.id),
  });
  assert.equal(installResult.success, true, JSON.stringify(installResult.diagnostics, null, 2));

  const exported = await exportInstalledNodePackList({
    userDataDir,
    ...trustEvidenceFor(pack.id),
  });

  assert.equal(exported.success, true, JSON.stringify(exported.diagnostics, null, 2));
  assert.equal(exported.packs.length, 1);
  assert.equal(exported.packs[0].id, pack.id);
  assert.deepEqual(exported.discovery.nodePackIds, [pack.id]);
});

async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

test('CLI install-local disable enable and remove operate through the safe installer', async () => {
  const userDataDir = await makeTempDir('orpad-node-pack-install-cli-user-data-');
  const sourceDir = await makeTempDir('orpad-node-pack-install-cli-source-');
  const pack = communityPack({
    id: 'community.cli-safe',
    nodes: [{
      type: 'community.cliSafe.node',
      path: 'nodes/safe.or-node',
      runtimeHandlerKind: 'metadata-only',
      capabilities: ['read.workspace'],
    }],
  });
  await writePack(sourceDir, pack);
  const evidence = JSON.stringify(trustEvidenceFor(pack.id).trustEvidenceByPack);

  const installResult = await runCli([
    'node-packs',
    'install-local',
    sourceDir,
    '--user-data',
    userDataDir,
    '--node-pack-trust-evidence',
    evidence,
    '--json',
  ]);
  assert.equal(installResult.success, true, JSON.stringify(installResult.diagnostics, null, 2));

  const disableResult = await runCli([
    'node-packs',
    'disable',
    pack.id,
    '--user-data',
    userDataDir,
    '--node-pack-trust-evidence',
    evidence,
    '--json',
  ]);
  assert.equal(disableResult.success, true, JSON.stringify(disableResult.diagnostics, null, 2));
  assert.equal((await readInstalledManifest(userDataDir, pack.id)).enabled, false);

  const enableResult = await runCli([
    'node-packs',
    'enable',
    pack.id,
    '--user-data',
    userDataDir,
    '--node-pack-trust-evidence',
    evidence,
    '--json',
  ]);
  assert.equal(enableResult.success, true, JSON.stringify(enableResult.diagnostics, null, 2));
  assert.equal((await readInstalledManifest(userDataDir, pack.id)).enabled, true);

  const exportResult = await runCli([
    'node-packs',
    'export-list',
    '--user-data',
    userDataDir,
    '--node-pack-trust-evidence',
    evidence,
    '--json',
  ]);
  assert.equal(exportResult.success, true, JSON.stringify(exportResult.diagnostics, null, 2));
  assert.equal(exportResult.packs.some(item => item.id === pack.id), true);

  const removeResult = await runCli([
    'node-packs',
    'remove',
    pack.id,
    '--user-data',
    userDataDir,
    '--json',
  ]);
  assert.equal(removeResult.success, true, JSON.stringify(removeResult.diagnostics, null, 2));
  await assert.rejects(fs.stat(path.join(userDataDir, 'nodes', pack.id)), /ENOENT/);
  assert.equal((await fs.stat(removeResult.backupPath)).isDirectory(), true);

  const lock = await readNodePackInstallLock({ userDataDir });
  assert.equal(lock.lock.packs.some(item => item.id === pack.id), false);
});
