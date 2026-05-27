import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  claudeCodeInvocation,
  nodeExecutableForHarness,
} = require('../../src/main/orchestration-machine');

async function withTempPathNode(fn) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-packaged-runtime-'));
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const nodePath = path.join(tempRoot, nodeName);
  await fs.writeFile(nodePath, '', { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = [tempRoot, originalPath || ''].filter(Boolean).join(path.delimiter);
  try {
    return await fn({ tempRoot, nodePath });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function withElectronRuntime(fn) {
  const original = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  Object.defineProperty(process.versions, 'electron', {
    value: '33.0.0',
    configurable: true,
  });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(process.versions, 'electron', original);
    else delete process.versions.electron;
  }
}

async function withNodeEnvCleared(fn) {
  const keys = ['ORPAD_MACHINE_NODE_EXEC_PATH', 'npm_node_execpath', 'NODE'];
  const original = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    return await fn();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('packaged Electron harness node resolution does not use the app executable', async () => {
  await withNodeEnvCleared(async () => withTempPathNode(async ({ nodePath }) => withElectronRuntime(async () => {
    assert.equal(nodeExecutableForHarness(), nodePath);
    assert.notEqual(nodeExecutableForHarness(), process.execPath);
  })));
});

test('packaged Electron Claude JS invocation resolves an external Node executable', async () => {
  await withNodeEnvCleared(async () => withTempPathNode(async ({ tempRoot, nodePath }) => withElectronRuntime(async () => {
    const scriptPath = path.join(tempRoot, 'fake-claude.js');
    await fs.writeFile(scriptPath, 'console.log("ok");\n', 'utf-8');
    const invocation = claudeCodeInvocation(scriptPath);
    assert.equal(invocation.command, nodePath);
    assert.deepEqual(invocation.prefixArgs, [scriptPath]);
    assert.notEqual(invocation.command, process.execPath);
  })));
});
