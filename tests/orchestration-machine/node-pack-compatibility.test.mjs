import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  createLosslessNodePlaceholder,
  createNodePackLockEntry,
  resolveNodeTypeCompatibility,
  validateNodePackManifest,
} = require('../../src/main/orchestration-machine');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const workstreamNodePackPath = path.join(repoRoot, 'nodes/orpad.workstream/orpad.node-pack.json');

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

test('built-in workstream node pack validates with safe install policy and lock metadata', async () => {
  const nodePack = JSON.parse(await fs.readFile(workstreamNodePackPath, 'utf8'));
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
