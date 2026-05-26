import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  NODE_PACK_WORKSPACE_LOCK_KIND,
  NODE_PACK_WORKSPACE_LOCK_METADATA_TRUST,
  createWorkspaceNodePackLockEntry,
  readWorkspaceNodePackLock,
  upsertWorkspaceNodePackLockEntry,
  workspaceNodePackLockPath,
  writeWorkspaceNodePackLock,
} = require('../../src/main/orchestration-machine/node-pack-workspace-lock.js');

async function withTempWorkspace(fn) {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-workspace-lock-'));
  try {
    return await fn(workspacePath);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
}

test('workspace node pack lock reads missing lock as empty shared state', async () => {
  await withTempWorkspace(async (workspacePath) => {
    const result = await readWorkspaceNodePackLock({ workspacePath });
    assert.equal(result.ok, true);
    assert.equal(result.lock.kind, NODE_PACK_WORKSPACE_LOCK_KIND);
    assert.deepEqual(result.lock.packs, []);
    assert.equal(result.path, workspaceNodePackLockPath(workspacePath));
  });
});

test('workspace node pack lock writes and upserts normalized package metadata', async () => {
  await withTempWorkspace(async (workspacePath) => {
    const entry = createWorkspaceNodePackLockEntry({
      id: 'community.shared-pack',
      latestVersion: '1.2.3',
      sourceRepository: 'https://github.com/example/shared-pack',
      sourceRef: 'v1.2.3',
      manifestPath: 'orpad.node-pack.json',
      signatureStatus: 'declared',
      checksumStatus: 'manifest-and-files-declared',
      reviewStatus: 'approved',
      capabilities: ['read.workspace'],
      nodeTypes: ['community.sharedNode'],
    }, {
      action: 'install',
      registrySource: 'https://registry.example/orpad-node-packs.json',
      installedBy: 'node-pack-manager',
    });

    const upserted = await upsertWorkspaceNodePackLockEntry(entry, { workspacePath });
    assert.equal(upserted.ok, true);
    assert.equal(upserted.lock.packs.length, 1);
    assert.equal(upserted.lock.packs[0].id, 'community.shared-pack');
    assert.equal(upserted.lock.packs[0].version, '1.2.3');
    assert.equal(upserted.lock.packs[0].registrySource, 'https://registry.example/orpad-node-packs.json');
    assert.equal(upserted.lock.packs[0].metadataTrust, NODE_PACK_WORKSPACE_LOCK_METADATA_TRUST);
    assert.deepEqual(upserted.lock.packs[0].resolvedNodeTypes, ['community.sharedNode']);

    const readBack = await readWorkspaceNodePackLock({ workspacePath });
    assert.equal(readBack.ok, true);
    assert.deepEqual(readBack.lock.packs, upserted.lock.packs);
  });
});

test('workspace node pack lock rejects unsupported file shape', async () => {
  await withTempWorkspace(async (workspacePath) => {
    const lockPath = workspaceNodePackLockPath(workspacePath);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({ kind: 'wrong', packs: [] }), 'utf8');

    const result = await readWorkspaceNodePackLock({ workspacePath });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0].code, 'NODE_PACK_WORKSPACE_LOCK_INVALID');
  });
});

test('workspace node pack lock write keeps package ids sorted', async () => {
  await withTempWorkspace(async (workspacePath) => {
    const result = await writeWorkspaceNodePackLock({
      packs: [
        { id: 'z.pack', version: '1.0.0' },
        { id: 'a.pack', version: '1.0.0' },
      ],
    }, { workspacePath });

    assert.equal(result.ok, true);
    assert.deepEqual(result.lock.packs.map(entry => entry.id), ['a.pack', 'z.pack']);
  });
});
