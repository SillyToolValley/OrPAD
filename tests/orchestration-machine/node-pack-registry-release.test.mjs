import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const registryPaths = new Map([
  ['OrPad/registry/packages.json', path.join(repoRoot, 'OrPad', 'registry', 'packages.json')],
  ['OrPad/registry/node-packs.json', path.join(repoRoot, 'OrPad', 'registry', 'node-packs.json')],
  ['orpad-registry/registry/packages.json', path.join(repoRoot, 'orpad-registry', 'registry', 'packages.json')],
  ['orpad-registry/registry/node-packs.json', path.join(repoRoot, 'orpad-registry', 'registry', 'node-packs.json')]
]);

const parityPairs = [
  ['OrPad/registry/packages.json', 'OrPad/registry/node-packs.json'],
  ['orpad-registry/registry/packages.json', 'orpad-registry/registry/node-packs.json'],
  ['OrPad/registry/packages.json', 'orpad-registry/registry/packages.json'],
  ['OrPad/registry/node-packs.json', 'orpad-registry/registry/node-packs.json']
];

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, childValue]) => [key, sortJson(childValue)])
    );
  }

  return value;
}

async function readStableJson(relativePath) {
  const absolutePath = registryPaths.get(relativePath);
  assert.ok(absolutePath, `No registry path fixture configured for ${relativePath}`);

  try {
    const rawJson = await readFile(absolutePath, 'utf8');
    return JSON.stringify(sortJson(JSON.parse(rawJson)), null, 2);
  } catch (error) {
    error.message = `Failed to read registry parity fixture ${relativePath}: ${error.message}`;
    throw error;
  }
}

async function assertRegistryPairParity(leftRelativePath, rightRelativePath) {
  const [leftJson, rightJson] = await Promise.all([
    readStableJson(leftRelativePath),
    readStableJson(rightRelativePath)
  ]);

  assert.strictEqual(
    leftJson,
    rightJson,
    `Registry release drift detected between ${leftRelativePath} and ${rightRelativePath}`
  );
}

test('app-bundled and standalone node-pack registries stay release-parity mirrors', async (t) => {
  for (const [leftRelativePath, rightRelativePath] of parityPairs) {
    await t.test(`${leftRelativePath} matches ${rightRelativePath}`, async () => {
      await assertRegistryPairParity(leftRelativePath, rightRelativePath);
    });
  }
});
