import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  BUILT_IN_NODE_PACK_MANIFESTS,
  createLosslessNodePlaceholder,
  createNodePackLockEntry,
  resolveNodeTypeCompatibility,
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
