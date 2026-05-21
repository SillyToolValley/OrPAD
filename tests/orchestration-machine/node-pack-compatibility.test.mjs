import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  BUILT_IN_NODE_PACK_MANIFESTS,
  STARTER_NODE_PACK_MANIFESTS,
  createLosslessNodePlaceholder,
  createNodePackLockEntry,
  resolveNodeTypeCompatibility,
  discoverNodePackManifests,
  selectAuthoringNodePacks,
  validatePipelineNodePacks,
  validateNodePackManifest,
} = require('../../src/main/orchestration-machine/node-packs');

const originalLoad = Module._load;
Module._load = function loadWithWorkItemFallback(request, parent, isMain) {
  if (request === './work-items' && parent?.filename?.endsWith(path.join('src', 'main', 'runbooks', 'validator.js'))) {
    return {
      WORK_ITEM_SCHEMA_VERSION: 'orpad.workItem.v1',
      WORK_ITEM_STATES: ['open', 'claimed', 'done', 'blocked'],
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  validateRunbookSource,
} = require('../../src/main/runbooks/validator');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

function communityPack(overrides = {}) {
  return {
    kind: 'orpad.nodePack',
    schemaVersion: '1.0',
    id: 'community.safe-pack',
    name: 'Community Safe Pack',
    version: '0.1.0',
    origin: 'community',
    trustLevel: 'signed',
    compatibility: {
      orpad: '>=1.0.0',
      packFormat: 'orpad.nodePack.v1',
    },
    capabilities: ['read.workspace'],
    nodes: [{
      type: 'community.safeNode',
      path: 'nodes/safe.or-node',
      runtimeHandlerKind: 'metadata-only',
      capabilities: ['read.workspace'],
    }],
    ...overrides,
  };
}

test('built-in workstream node pack validates with safe install policy and lock metadata', () => {
  const nodePack = BUILT_IN_NODE_PACK_MANIFESTS.find(pack => pack.id === 'orpad.workstream');
  const result = validateNodePackManifest(nodePack, {
    installMode: 'normal',
    grantedCapabilities: nodePack.capabilities,
  });
  const lock = createNodePackLockEntry(nodePack, {
    source: 'built-in',
    checksum: 'built-in',
    signature: 'built-in',
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolutionState, 'resolved');
  assert.equal(nodePack.installPolicy.allowLifecycleScripts, false);
  assert.equal(nodePack.installPolicy.allowExecutableHandlers, false);
  assert.equal(result.nodeTypeMap['orpad.workerLoop'].packId, 'orpad.workstream');
  assert.equal(lock.id, 'orpad.workstream');
  assert.equal(lock.resolvedNodeTypes.includes('orpad.workerLoop'), true);
});

test('starter situation node packs are portable metadata-only packs on disk', async () => {
  assert.equal(STARTER_NODE_PACK_MANIFESTS.length >= 3, true);

  for (const nodePack of STARTER_NODE_PACK_MANIFESTS) {
    const result = validateNodePackManifest(nodePack, {
      installMode: 'normal',
      grantedCapabilities: nodePack.capabilities,
    });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2));
    assert.equal(result.resolutionState, 'resolved');
    assert.equal(nodePack.installPolicy.allowLifecycleScripts, false);
    assert.equal(nodePack.installPolicy.allowExecutableHandlers, false);
    assert.deepEqual(nodePack.nodes, []);

    const packRoot = path.join(repoRoot, 'nodes', nodePack.id);
    const diskManifest = JSON.parse(await fs.readFile(path.join(packRoot, 'orpad.node-pack.json'), 'utf-8'));
    assert.equal(diskManifest.id, nodePack.id);
    assert.equal(diskManifest.version, nodePack.version);
    assert.equal(diskManifest.trustLevel, nodePack.trustLevel);

    for (const collection of ['graphs', 'skills', 'rules']) {
      for (const asset of nodePack[collection] || []) {
        const stat = await fs.stat(path.join(packRoot, asset.path));
        assert.equal(stat.isFile(), true, `${nodePack.id} declares missing ${collection} asset ${asset.path}`);
      }
    }
  }
});

test('node pack discovery loads built-in and user pools in deterministic order', async (t) => {
  const userRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-user-node-packs-'));
  t.after(() => fs.rm(userRoot, { recursive: true, force: true }));
  const userPackDir = path.join(userRoot, 'community.safe-pack');
  await fs.mkdir(userPackDir, { recursive: true });
  await fs.writeFile(path.join(userPackDir, 'orpad.node-pack.json'), JSON.stringify(communityPack({
    origin: 'user',
    trustLevel: 'signed',
  }), null, 2), 'utf-8');

  const duplicateDir = path.join(userRoot, 'orpad.core-duplicate');
  await fs.mkdir(duplicateDir, { recursive: true });
  await fs.writeFile(path.join(duplicateDir, 'orpad.node-pack.json'), JSON.stringify({
    kind: 'orpad.nodePack',
    schemaVersion: '1.0',
    id: 'orpad.core',
    name: 'Duplicate Core',
    version: '9.9.9',
    origin: 'user',
    trustLevel: 'signed',
    compatibility: { packFormat: 'orpad.nodePack.v1' },
    capabilities: [],
    nodes: [],
  }, null, 2), 'utf-8');

  const result = discoverNodePackManifests({
    builtInNodePacksRoot: path.join(repoRoot, 'nodes'),
    userNodePacksRoot: userRoot,
  });
  const ids = result.nodePacks.map(pack => pack.id);

  assert.equal(ids.includes('orpad.core'), true);
  assert.equal(ids.includes('orpad.starter.electron-maintenance'), true);
  assert.equal(ids.includes('community.safe-pack'), true);
  assert.ok(ids.indexOf('orpad.core') < ids.indexOf('community.safe-pack'));
  assert.equal(ids.filter(id => id === 'orpad.core').length, 1);
  assert.equal(result.diagnostics.some(item => item.code === 'NODE_PACK_DISCOVERY_DUPLICATE_ID'), true);
});

test('node pack discovery reports node type conflicts for manager review', async (t) => {
  const builtInRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-conflict-builtins-'));
  t.after(() => fs.rm(builtInRoot, { recursive: true, force: true }));
  for (const pack of [
    communityPack({ id: 'community.left', nodes: [{ type: 'community.conflictNode', path: 'nodes/a.or-node', capabilities: [] }] }),
    communityPack({ id: 'community.right', nodes: [{ type: 'community.conflictNode', path: 'nodes/b.or-node', capabilities: [] }] }),
  ]) {
    const dir = path.join(builtInRoot, pack.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'orpad.node-pack.json'), JSON.stringify(pack, null, 2), 'utf-8');
  }

  const result = discoverNodePackManifests({
    builtInNodePacksRoot: builtInRoot,
    userNodePacksRoot: false,
  });

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].nodeType, 'community.conflictNode');
  assert.equal(result.diagnostics.some(item => item.code === 'NODE_PACK_TYPE_CONFLICT'), true);
});

test('authoring node pack selector chooses packs from prompt and workspace signals', () => {
  const selected = selectAuthoringNodePacks(
    'Review Electron preload IPC security before release and verify renderer packaging risks.',
    {
      files: [
        'src/main/main.js',
        'src/main/preload.js',
        'src/renderer/renderer.js',
        'electron-builder.yml',
        'SECURITY.md',
      ],
    },
    { maxPacks: 3 },
  );
  const ids = selected.map(pack => pack.id);

  assert.equal(ids.includes('orpad.starter.electron-maintenance'), true);
  assert.equal(ids.includes('orpad.starter.security-review'), true);
  assert.equal(ids.includes('orpad.starter.release-readiness'), true);
  assert.equal(selected.every(pack => pack.matchedSignals.length > 0), true);
});

test('maintenance pipeline node pack declarations validate before launch', () => {
  const result = validateRunbookSource(JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'orpad-maintenance-quality-workstream',
    entryGraph: 'graphs/maintenance.or-graph',
    nodePacks: [
      { id: 'orpad.core', version: '>=1.0.0', origin: 'built-in' },
      { id: 'orpad.workstream', version: '>=1.0.0', origin: 'built-in' },
    ],
  }), {
    checkFiles: false,
    suppressTrustWarning: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.nodePacks.map(pack => pack.id), ['orpad.core', 'orpad.workstream']);
  assert.equal(result.diagnostics.some(item => item.code?.startsWith('PIPELINE_NODE_PACK_')), false);
});

test('pipeline node pack declarations reject missing or incompatible packs before launch', () => {
  const result = validateRunbookSource(JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'node-pack-negative',
    entryGraph: 'graphs/entry.or-graph',
    nodePacks: [
      { id: 'orpad.unknown', version: '>=1.0.0', origin: 'built-in' },
      { id: 'orpad.core', version: '>=9.0.0', origin: 'built-in' },
    ],
  }), {
    checkFiles: false,
    suppressTrustWarning: true,
  });
  const codes = new Set(result.diagnostics.map(item => item.code));

  assert.equal(result.ok, false);
  assert.equal(codes.has('PIPELINE_NODE_PACK_UNKNOWN'), true);
  assert.equal(codes.has('PIPELINE_NODE_PACK_VERSION_INCOMPATIBLE'), true);
});

test('pipeline node pack resolver reports disabled and origin-mismatched packs', () => {
  const availableNodePacks = [
    {
      ...BUILT_IN_NODE_PACK_MANIFESTS.find(pack => pack.id === 'orpad.core'),
      enabled: false,
    },
    BUILT_IN_NODE_PACK_MANIFESTS.find(pack => pack.id === 'orpad.workstream'),
  ];
  const result = validatePipelineNodePacks([
    { id: 'orpad.core', version: '>=1.0.0', origin: 'built-in' },
    { id: 'orpad.workstream', version: '>=1.0.0', origin: 'community' },
  ], {
    availableNodePacks,
  });
  const codes = new Set(result.diagnostics.map(item => item.code));

  assert.equal(result.ok, false);
  assert.equal(codes.has('PIPELINE_NODE_PACK_DISABLED'), true);
  assert.equal(codes.has('PIPELINE_NODE_PACK_ORIGIN_MISMATCH'), true);
});

test('community packs cannot override reserved orpad namespace', () => {
  const result = validateNodePackManifest(communityPack({
    id: 'orpad.malicious',
    nodes: [{
      type: 'orpad.probe',
      path: 'nodes/probe.or-node',
      runtimeHandlerKind: 'metadata-only',
      capabilities: ['read.workspace'],
    }],
  }), {
    installMode: 'normal',
    grantedCapabilities: ['read.workspace'],
  });
  const codes = new Set(result.diagnostics.map(item => item.code));

  assert.equal(result.ok, false);
  assert.equal(codes.has('NODE_PACK_RESERVED_ID'), true);
  assert.equal(codes.has('NODE_PACK_RESERVED_NODE_TYPE'), true);
});

test('node type resolution distinguishes missing disabled incompatible denied and untrusted states', () => {
  const disabled = validateNodePackManifest(communityPack({
    id: 'community.disabled',
    enabled: false,
    nodes: [{ type: 'community.disabledNode', path: 'nodes/a.or-node', capabilities: [] }],
  }));
  const incompatible = validateNodePackManifest(communityPack({
    id: 'community.future',
    compatibility: { orpad: '>=9.0.0', packFormat: 'orpad.nodePack.v1' },
    nodes: [{ type: 'community.futureNode', path: 'nodes/a.or-node', capabilities: [] }],
  }));
  const denied = validateNodePackManifest(communityPack({
    id: 'community.denied',
    capabilities: ['write.workspace'],
    nodes: [{ type: 'community.deniedNode', path: 'nodes/a.or-node', capabilities: ['write.workspace'] }],
  }), {
    grantedCapabilities: ['read.workspace'],
  });
  const untrusted = validateNodePackManifest(communityPack({
    id: 'community.untrusted',
    trustLevel: 'unknown',
    nodes: [{ type: 'community.untrustedNode', path: 'nodes/a.or-node', capabilities: [] }],
  }));
  const packResults = [disabled, incompatible, denied, untrusted];

  assert.equal(resolveNodeTypeCompatibility('community.disabledNode', packResults).state, 'disabled');
  assert.equal(resolveNodeTypeCompatibility('community.futureNode', packResults).state, 'incompatible');
  assert.equal(resolveNodeTypeCompatibility('community.deniedNode', packResults).state, 'capability-denied');
  assert.equal(resolveNodeTypeCompatibility('community.untrustedNode', packResults).state, 'untrusted');
  assert.equal(resolveNodeTypeCompatibility('community.missingNode', packResults).state, 'missing');
});

test('missing community nodes preserve original graph node losslessly', () => {
  const original = {
    id: 'missing',
    type: 'community.missingNode',
    config: {
      nested: { value: 1 },
      ports: ['in', 'out'],
    },
    position: { x: 10, y: 20 },
  };
  const resolution = resolveNodeTypeCompatibility('community.missingNode', []);
  const placeholder = createLosslessNodePlaceholder(original, resolution);

  assert.equal(placeholder.resolution.state, 'missing');
  assert.deepEqual(placeholder.originalNode, original);
});

test('normal node pack install rejects lifecycle scripts and executable handlers', () => {
  const result = validateNodePackManifest(communityPack({
    packageScripts: {
      postinstall: 'node install.js',
    },
    nodes: [{
      type: 'community.execNode',
      path: 'nodes/exec.or-node',
      runtimeHandlerKind: 'executable',
      handler: 'dist/handler.js',
      capabilities: ['read.workspace'],
    }],
  }), {
    installMode: 'normal',
    grantedCapabilities: ['read.workspace'],
  });
  const codes = new Set(result.diagnostics.map(item => item.code));

  assert.equal(result.ok, false);
  assert.equal(codes.has('NODE_PACK_LIFECYCLE_SCRIPT_BLOCKED'), true);
  assert.equal(codes.has('NODE_PACK_EXECUTABLE_HANDLER_BLOCKED'), true);
});

test('node pack asset paths must stay pack-relative and portable', () => {
  const result = validateNodePackManifest(communityPack({
    nodes: [{
      type: 'community.unsafePathNode',
      path: '../outside.or-node',
      runtimeHandlerKind: 'metadata-only',
      capabilities: ['read.workspace'],
    }],
    graphs: [{
      id: 'unsafe-graph',
      path: 'C:/outside/graph.or-graph',
    }],
  }), {
    installMode: 'normal',
    grantedCapabilities: ['read.workspace'],
  });
  const unsafePaths = result.diagnostics.filter(item => item.code === 'NODE_PACK_ASSET_PATH_UNSAFE');

  assert.equal(result.ok, false);
  assert.equal(unsafePaths.length, 2);
  assert.deepEqual(unsafePaths.map(item => item.assetKind), ['node', 'graphs']);
});
