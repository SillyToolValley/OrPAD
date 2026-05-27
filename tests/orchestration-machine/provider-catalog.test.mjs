import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const catalog = require('../../src/shared/ai/provider-catalog');
const aiKeys = require('../../src/main/ai-keys');
const orchestration = require('../../src/main/orchestration-machine');

test('provider catalog includes the documented identifier set', () => {
  const ids = catalog.listProviderIds();
  for (const expected of ['openai', 'anthropic', 'openrouter', 'openai-compatible', 'ollama', 'codex-cli']) {
    assert.equal(ids.includes(expected), true, `catalog should include ${expected}`);
  }
});

test('catalog entries are frozen and metadata-only', () => {
  for (const entry of catalog.listProviderEntries()) {
    assert.equal(Object.isFrozen(entry), true, `${entry.id} entry should be frozen`);
    assert.equal(typeof entry.id, 'string');
    assert.equal(typeof entry.displayName, 'string');
    assert.equal(['api', 'cli'].includes(entry.family), true);
    assert.equal(typeof entry.needsKey, 'boolean');
    assert.equal(typeof entry.defaultEndpoint, 'string');
    assert.equal(typeof entry.defaultModel, 'string');
    assert.equal(Array.isArray(entry.models), true);
    assert.equal(typeof entry.costs.input, 'number');
    assert.equal(typeof entry.costs.output, 'number');
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'apiKey'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'ciphertext'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(entry, 'secret'), false);
  }
});

test('catalog model entries are deeply frozen', () => {
  for (const entry of catalog.listProviderEntries()) {
    assert.equal(Object.isFrozen(entry.models), true, `${entry.id} models array should be frozen`);
    for (const model of entry.models) {
      assert.equal(Object.isFrozen(model), true, `${entry.id}/${model.id} model entry should be frozen`);
      assert.throws(
        () => { model.id = 'mutated'; },
        TypeError,
        `${entry.id}/${model.id} should reject id mutation`,
      );
    }
    assert.equal(Object.isFrozen(entry.costs), true, `${entry.id} costs object should be frozen`);
  }
});

test('isKeylessProvider matches needsKey:false entries', () => {
  assert.equal(catalog.isKeylessProvider('codex-cli'), true);
  assert.equal(catalog.isKeylessProvider('ollama'), true);
  assert.equal(catalog.isKeylessProvider('openai-compatible'), true);
  assert.equal(catalog.isKeylessProvider('anthropic'), false);
  assert.equal(catalog.isKeylessProvider('openai'), false);
  assert.equal(catalog.isKeylessProvider('unknown'), false);
});

test('summarizeForIpc reduces to JSON-safe primitives', () => {
  const summary = catalog.summarizeForIpc();
  assert.equal(Array.isArray(summary), true);
  for (const entry of summary) {
    assert.equal(JSON.parse(JSON.stringify(entry)).id, entry.id);
    assert.equal(Array.isArray(entry.models), true);
    for (const modelId of entry.models) {
      assert.equal(typeof modelId, 'string');
    }
  }
});

test('provider catalog status notes are locale-neutral picker copy', () => {
  const localizedText = /[\u3131-\uD79D]/;
  const replacementGlyph = /\uFFFD/;
  for (const entry of catalog.listProviderEntries()) {
    assert.equal(localizedText.test(entry.statusNote || ''), false, `${entry.id} statusNote must not contain Korean UI copy`);
    assert.equal(replacementGlyph.test(entry.statusNote || ''), false, `${entry.id} statusNote must not contain replacement glyphs`);
  }
});

test('codex-cli plugin sources displayName/models from the catalog', () => {
  const plugin = orchestration.getProviderPlugin('codex-cli');
  const entry = catalog.getProviderEntry('codex-cli');
  assert.equal(plugin.id, entry.id);
  assert.equal(plugin.displayName, entry.displayName);
  assert.equal(plugin.family, entry.family);
  assert.equal(plugin.needsKey, entry.needsKey);
  assert.equal(plugin.defaultModel, entry.defaultModel);
});

test('keyMask never reveals a full key', () => {
  const masked = aiKeys.keyMask('sk-1234567890abcdef');
  assert.equal(masked.includes('1234567890ab'), false);
  assert.equal(masked.endsWith('cdef'), true);
  assert.equal(aiKeys.keyMask('').length, 0);
});

test('validateProvider accepts all catalog ids and rejects others', () => {
  for (const id of catalog.listProviderIds()) {
    aiKeys.validateProvider(id);
  }
  assert.throws(() => aiKeys.validateProvider('not-in-catalog'));
  assert.throws(() => aiKeys.validateProvider(''));
  assert.throws(() => aiKeys.validateProvider(123));
});

test('validateStreamingProvider rejects keyless or non-streaming providers', () => {
  for (const id of ['openai', 'anthropic', 'openrouter', 'openai-compatible']) {
    aiKeys.validateStreamingProvider(id);
  }
  assert.throws(() => aiKeys.validateStreamingProvider('codex-cli'));
  assert.throws(() => aiKeys.validateStreamingProvider('ollama'));
});

test('providerStatus exposes catalog metadata for every catalog id', () => {
  const status = aiKeys.providerStatus({});
  for (const id of catalog.listProviderIds()) {
    assert.equal(typeof status[id], 'object');
    assert.equal(status[id].family, catalog.getProviderEntry(id).family);
    assert.equal(status[id].needsKey, Boolean(catalog.getProviderEntry(id).needsKey));
    assert.equal(Array.isArray(status[id].models), true);
    assert.equal(Object.prototype.hasOwnProperty.call(status[id], 'ciphertext'), false);
  }
});

test('providerStatus does not leak ciphertext from the on-disk store', () => {
  const fakeStore = {
    openai: {
      ciphertext: 'BASE64-FAKE-CIPHERTEXT-DO-NOT-LEAK',
      mask: 'sk-****abcd',
      updatedAt: '2026-04-30T00:00:00.000Z',
      endpoint: null,
    },
  };
  const status = aiKeys.providerStatus(fakeStore);
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes('BASE64-FAKE-CIPHERTEXT-DO-NOT-LEAK'), false);
  assert.equal(status.openai.hasKey, true);
  assert.equal(status.openai.mask, 'sk-****abcd');
});

test('providerStatus reads legacy 4-provider ai-keys.json without losing ciphertext', () => {
  // Legacy on-disk shape predates the catalog: only the original 4 streaming
  // providers, no family/needsKey/models on the entry. The store fields are
  // exactly what the pre-M2 ai-keys.js wrote.
  const legacyStore = {
    openai: {
      ciphertext: 'LEGACY-OPENAI',
      mask: 'sk-****1111',
      updatedAt: '2026-03-01T00:00:00.000Z',
      endpoint: null,
    },
    anthropic: {
      ciphertext: 'LEGACY-ANTHROPIC',
      mask: 'sk-****2222',
      updatedAt: '2026-03-01T00:00:00.000Z',
      endpoint: null,
    },
    openrouter: {
      ciphertext: 'LEGACY-OPENROUTER',
      mask: 'sk-****3333',
      updatedAt: '2026-03-01T00:00:00.000Z',
      endpoint: null,
    },
    'openai-compatible': {
      ciphertext: 'LEGACY-COMPAT',
      mask: 'sk-****4444',
      updatedAt: '2026-03-01T00:00:00.000Z',
      endpoint: 'https://example.test/v1',
    },
  };
  const status = aiKeys.providerStatus(legacyStore);
  for (const id of ['openai', 'anthropic', 'openrouter', 'openai-compatible']) {
    assert.equal(status[id].hasKey, true, `${id} legacy hasKey preserved`);
    assert.equal(typeof status[id].mask, 'string');
    assert.equal(status[id].mask.length > 0, true, `${id} legacy mask preserved`);
  }
  // New catalog providers (codex-cli, ollama) appear with hasKey:false.
  assert.equal(status['codex-cli'].hasKey, false);
  assert.equal(status['codex-cli'].needsKey, false);
  assert.equal(status.ollama.hasKey, false);
  assert.equal(status.ollama.needsKey, false);
  // Serialized output never contains legacy ciphertext.
  const serialized = JSON.stringify(status);
  for (const ciphertext of ['LEGACY-OPENAI', 'LEGACY-ANTHROPIC', 'LEGACY-OPENROUTER', 'LEGACY-COMPAT']) {
    assert.equal(serialized.includes(ciphertext), false, `${ciphertext} must not leak via providerStatus`);
  }
});

test('providerStatus output is the full shape ai-keys-status IPC must return', () => {
  const status = aiKeys.providerStatus({});
  for (const id of catalog.listProviderIds()) {
    const entry = status[id];
    assert.equal(typeof entry.hasKey, 'boolean');
    assert.equal(typeof entry.mask, 'string');
    assert.equal(['object'].includes(typeof entry.updatedAt) || entry.updatedAt === null, true);
    assert.equal(['string', 'object'].includes(typeof entry.endpoint), true);
    assert.equal(['api', 'cli'].includes(entry.family), true);
    assert.equal(typeof entry.needsKey, 'boolean');
    assert.equal(typeof entry.configurableEndpoint, 'boolean');
    assert.equal(typeof entry.defaultModel, 'string');
    assert.equal(Array.isArray(entry.models), true);
    assert.equal(typeof entry.costs.input, 'number');
    assert.equal(typeof entry.costs.output, 'number');
  }
});

test('Machine event/manifest writers do not record raw provider keys', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-key-leak-'));
  const pipelineDir = path.join(tempRoot, '.orpad/pipelines/leak-test');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'leak-test',
    entryGraph: 'graphs/main.or-graph',
  }), 'utf8');
  const run = await orchestration.createMachineRun({
    workspaceRoot: tempRoot,
    pipelinePath,
    runId: 'run_20260506_leak_test',
    now: new Date('2026-05-06T00:00:00.000Z'),
  });
  const fakeKey = 'sk-LEAKCHECK-NEVER-WRITE-THIS-KEY-XYZ-1234567890';
  await orchestration.appendMachineEvent(run.runRoot, {
    runId: run.runId,
    eventType: 'adapter.requested',
    actor: 'machine',
    nodePath: 'main/probe',
    payload: {
      adapter: 'cli-agent-proposal-only',
      providerSelection: {
        providerId: 'openai',
        model: 'gpt-4o-mini',
      },
      // Intentionally rich payload to make sure no helper accidentally pulls a
      // raw API key from a sibling field.
      sandbox: 'read-only',
      mask: aiKeys.keyMask(fakeKey),
    },
  });
  await orchestration.writeArtifactManifest(run.runRoot, {
    runId: run.runId,
    files: [],
  });

  const eventsPath = path.join(run.runRoot, 'events.jsonl');
  const manifestPath = path.join(run.runRoot, 'artifacts', 'manifest.json');
  const eventsContent = await fs.readFile(eventsPath, 'utf8');
  const manifestContent = await fs.readFile(manifestPath, 'utf8');
  assert.equal(eventsContent.includes(fakeKey), false, 'raw key must never reach events.jsonl');
  assert.equal(manifestContent.includes(fakeKey), false, 'raw key must never reach artifacts/manifest.json');
  assert.equal(eventsContent.includes(aiKeys.keyMask(fakeKey)), true, 'masked form is the only acceptable representation');
});
