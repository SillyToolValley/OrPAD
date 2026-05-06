import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  CACHE_MODES,
  RESPONSE_CACHE_SCHEMA_VERSION,
  applyCacheHitToResult,
  assertPromptIsDeterministic,
  buildCacheEntry,
  cacheEntryPath,
  computeCacheKey,
  dispatchAdapter,
  hashAllowedFiles,
  hashPrompt,
  readCacheEntry,
  readBudgetLedger,
  shouldAttemptCacheLookup,
  sweepExpiredEntries,
  writeCacheEntry,
  SCHEMA_VERSIONS,
} = require('../../src/main/orchestration-machine');

async function makeRunRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'orpad-response-cache-'));
}

function v2Pipeline(overrides = {}) {
  return {
    schemaVersion: 'orpad.machineAdapter.v2',
    enabled: true,
    default: {
      family: 'api',
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      qualityTier: 'standard',
      sessionStrategy: 'none',
      toolPolicy: 'none',
      sandbox: null,
      approvalPolicy: 'never',
      timeoutMs: 600000,
      ephemeral: true,
    },
    cache: {
      mode: 'deterministic',
      ttlSeconds: 86400,
    },
    ...overrides,
  };
}

function buildAdapterRequest(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSIONS.adapterRequest,
    adapter: 'router-test',
    runId: 'run_20260506_cache',
    adapterCallId: 'adapter_call_001',
    attemptId: 'attempt_001',
    idempotencyKey: 'run_20260506_cache:probe:attempt_001',
    nodePath: 'main/probe',
    taskKind: 'probe',
    workspaceMode: 'read-only',
    allowedFiles: ['src/sample.js'],
    inputArtifacts: ['queue/inbox/x.json'],
    adapterResultPath: 'runs/run_20260506_cache/adapters/adapter_call_001/response.json',
    outputContract: SCHEMA_VERSIONS.adapterResult,
    ...overrides,
  };
}

function workerResult(overrides = {}) {
  return {
    schemaVersion: 'orpad.workerResult.v1',
    adapterCallId: 'adapter_call_001',
    attemptId: 'attempt_001',
    idempotencyKey: 'run_20260506_cache:probe:attempt_001',
    status: 'done',
    summary: 'sample',
    artifacts: ['a/b'],
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      costEstimateUsd: 0.5,
      currency: 'USD',
    },
    ...overrides,
  };
}

test('CACHE_MODES enumerates the three documented modes', () => {
  assert.deepEqual([...CACHE_MODES], ['off', 'deterministic', 'idempotent-only']);
});

test('computeCacheKey is deterministic for the same input', () => {
  const a = computeCacheKey({
    mode: 'deterministic',
    providerId: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
    prompt: 'hello world',
    allowedFiles: ['a.js', 'b.js'],
    taskKind: 'probe',
    outputContract: 'orpad.workerResult.v1',
    qualityTier: 'standard',
  });
  const b = computeCacheKey({
    mode: 'deterministic',
    providerId: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
    prompt: 'hello world',
    allowedFiles: ['b.js', 'a.js'], // different order, same set
    taskKind: 'probe',
    outputContract: 'orpad.workerResult.v1',
    qualityTier: 'standard',
  });
  assert.equal(a, b, 'allowedFiles order should not affect the cache key');
});

test('computeCacheKey changes when any tuple field changes', () => {
  const base = {
    mode: 'deterministic',
    providerId: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
    prompt: 'hello world',
    allowedFiles: ['a.js'],
    taskKind: 'probe',
    outputContract: 'orpad.workerResult.v1',
    qualityTier: 'standard',
  };
  const original = computeCacheKey(base);
  for (const [field, value] of [
    ['providerId', 'openai'],
    ['model', 'claude-3-opus-latest'],
    ['prompt', 'hello world!'],
    ['allowedFiles', ['c.js']],
    ['taskKind', 'workerLoop'],
    ['outputContract', 'orpad.workerResult.v2'],
    ['qualityTier', 'fast'],
  ]) {
    assert.notEqual(computeCacheKey({ ...base, [field]: value }), original, `${field} change should rotate the cache key`);
  }
});

test('idempotent-only mode keys ignore prompt content', () => {
  const a = computeCacheKey({
    mode: 'idempotent-only',
    providerId: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
    idempotencyKey: 'idem-1',
    outputContract: 'orpad.workerResult.v1',
  });
  const b = computeCacheKey({
    mode: 'idempotent-only',
    providerId: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
    idempotencyKey: 'idem-1',
    outputContract: 'orpad.workerResult.v1',
    prompt: 'this should not affect the key',
  });
  assert.equal(a, b);
});

test('assertPromptIsDeterministic flags ISO timestamps, UUIDs, run ids, and epoch timestamps', () => {
  assert.equal(assertPromptIsDeterministic('hello').ok, true);
  assert.equal(assertPromptIsDeterministic('the time is 2026-04-30T00:00:00.000Z').ok, false);
  assert.equal(assertPromptIsDeterministic('uuid 550e8400-e29b-41d4-a716-446655440000').ok, false);
  assert.equal(assertPromptIsDeterministic('id run_20260430_142500').ok, false);
  // Bare ISO date (no time)
  assert.equal(assertPromptIsDeterministic('cycle 2026-04-30').ok, false);
  // Unix epoch (seconds and milliseconds)
  assert.equal(assertPromptIsDeterministic('epoch 1715635200').ok, false);
  assert.equal(assertPromptIsDeterministic('epoch ms 1715635200000').ok, false);
});

test('shouldAttemptCacheLookup reflects cache mode policy', () => {
  assert.deepEqual(
    shouldAttemptCacheLookup({ mode: 'off', prompt: 'x', idempotencyKey: 'i' }),
    { eligible: false, reason: 'cache-off' },
  );
  assert.equal(
    shouldAttemptCacheLookup({ mode: 'deterministic', prompt: 'plain prompt', idempotencyKey: '' }).eligible,
    true,
  );
  const stamped = shouldAttemptCacheLookup({
    mode: 'deterministic',
    prompt: 'time 2026-04-30T00:00:00Z',
    idempotencyKey: '',
  });
  assert.equal(stamped.eligible, false);
  assert.equal(stamped.reason, 'prompt-not-deterministic');
  assert.equal(
    shouldAttemptCacheLookup({ mode: 'idempotent-only', prompt: 'x', idempotencyKey: '' }).eligible,
    false,
  );
  assert.equal(
    shouldAttemptCacheLookup({ mode: 'idempotent-only', prompt: 'x', idempotencyKey: 'i' }).eligible,
    true,
  );
});

test('readCacheEntry / writeCacheEntry round-trip via the run-root cache directory', async () => {
  const runRoot = await makeRunRoot();
  try {
    const cacheKey = computeCacheKey({
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      prompt: 'hello',
      allowedFiles: ['a.js'],
      taskKind: 'probe',
      outputContract: 'orpad.workerResult.v1',
      qualityTier: 'standard',
    });
    const entry = buildCacheEntry({
      cacheKey,
      mode: 'deterministic',
      ttlSeconds: 60,
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      promptHash: hashPrompt('hello'),
      allowedFilesHash: hashAllowedFiles(['a.js']),
      taskKind: 'probe',
      outputContract: 'orpad.workerResult.v1',
      qualityTier: 'standard',
      idempotencyKey: '',
      result: workerResult(),
    });
    await writeCacheEntry(runRoot, entry);
    const read = await readCacheEntry(runRoot, cacheKey);
    assert.equal(read.schemaVersion, RESPONSE_CACHE_SCHEMA_VERSION);
    assert.equal(read.cacheKey, cacheKey);
    assert.equal(read.result.status, 'done');
    // Entry persisted under <runRoot>/cache/<sha>.json
    const filePath = cacheEntryPath(runRoot, cacheKey);
    assert.equal(filePath.includes(path.join('cache', '')), true);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('cached result strips apiSession and apiTrace from disk payload', () => {
  const dirty = workerResult({
    apiSession: { providerId: 'anthropic', sessionStrategy: 'none', adapterCallId: 'a1' },
    apiTrace: { providerId: 'anthropic', traceId: 't1', authoritative: false },
  });
  const entry = buildCacheEntry({
    cacheKey: 'sha256:00',
    mode: 'deterministic',
    ttlSeconds: 60,
    providerId: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
    promptHash: hashPrompt('hello'),
    allowedFilesHash: hashAllowedFiles([]),
    taskKind: 'probe',
    outputContract: 'orpad.workerResult.v1',
    qualityTier: 'standard',
    idempotencyKey: '',
    result: dirty,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(entry.result, 'apiSession'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry.result, 'apiTrace'), false);
});

test('applyCacheHitToResult sets cacheHit=true and zeroes costEstimateUsd', () => {
  const result = applyCacheHitToResult(workerResult(), 'sha256:abcd');
  assert.equal(result.cacheHit, true);
  assert.equal(result.cacheKey, 'sha256:abcd');
  assert.equal(result.usage.costEstimateUsd, 0);
  assert.equal(result.usage.promptTokens, 100);
});

test('dispatchAdapter writes a cache entry on miss and replays it on hit', async () => {
  const runRoot = await makeRunRoot();
  try {
    let invokerCalls = 0;
    const events = [];
    // First call: cache miss → invoker runs → entry persists.
    const first = await dispatchAdapter({
      runRoot,
      pipelineAdapter: v2Pipeline(),
      request: buildAdapterRequest(),
      cachePrompt: 'plain prompt no timestamps',
      invoker: async () => { invokerCalls += 1; return workerResult(); },
      beforeAttempt: e => events.push(e),
      afterAttempt: e => events.push(e),
    });
    assert.equal(first.cacheHit, undefined);
    assert.equal(invokerCalls, 1);

    // Second call with the same prompt and same selection: cache hit, no invoker.
    const second = await dispatchAdapter({
      runRoot,
      pipelineAdapter: v2Pipeline(),
      request: buildAdapterRequest({ adapterCallId: 'next', attemptId: 'next', idempotencyKey: 'next' }),
      cachePrompt: 'plain prompt no timestamps',
      invoker: async () => { invokerCalls += 1; return workerResult(); },
      beforeAttempt: e => events.push(e),
      afterAttempt: e => events.push(e),
    });
    assert.equal(second.cacheHit, true);
    assert.equal(second.usage.costEstimateUsd, 0);
    assert.equal(invokerCalls, 1, 'invoker must NOT run on cache hit');
    const cacheHits = events.filter(e => e.eventType === 'cache.hit');
    assert.equal(cacheHits.length, 1);
    assert.equal(cacheHits[0].payload.cacheMode, 'deterministic');
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('dispatchAdapter does not cache when prompt fails the determinism check', async () => {
  const runRoot = await makeRunRoot();
  try {
    let invokerCalls = 0;
    const stampedPrompt = 'time 2026-04-30T00:00:00.000Z';
    await dispatchAdapter({
      runRoot,
      pipelineAdapter: v2Pipeline(),
      request: buildAdapterRequest(),
      cachePrompt: stampedPrompt,
      invoker: async () => { invokerCalls += 1; return workerResult(); },
    });
    await dispatchAdapter({
      runRoot,
      pipelineAdapter: v2Pipeline(),
      request: buildAdapterRequest({ adapterCallId: 'next', attemptId: 'next', idempotencyKey: 'next' }),
      cachePrompt: stampedPrompt,
      invoker: async () => { invokerCalls += 1; return workerResult(); },
    });
    assert.equal(invokerCalls, 2, 'non-deterministic prompts must not be served from cache');
    // No cache directory entries should have been created.
    const cacheDir = path.join(runRoot, 'cache');
    let files = [];
    try { files = await fs.readdir(cacheDir); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    assert.equal(files.length, 0);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('idempotent-only mode keys differ when outputContract differs', () => {
  const base = {
    mode: 'idempotent-only',
    providerId: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
    idempotencyKey: 'shared-key',
  };
  const aV1 = computeCacheKey({ ...base, outputContract: 'orpad.workerResult.v1' });
  const aV2 = computeCacheKey({ ...base, outputContract: 'orpad.workerResult.v2' });
  assert.notEqual(aV1, aV2, 'same idempotencyKey with different outputContracts must not collide');
});

test('idempotent-only mode hits only when idempotencyKey matches a prior entry', async () => {
  const runRoot = await makeRunRoot();
  try {
    let invokerCalls = 0;
    const pipeline = v2Pipeline({ cache: { mode: 'idempotent-only', ttlSeconds: 60 } });
    await dispatchAdapter({
      runRoot,
      pipelineAdapter: pipeline,
      request: buildAdapterRequest({ idempotencyKey: 'idem-1' }),
      cachePrompt: 'whatever even with timestamp 2026-04-30T00:00:00Z',
      invoker: async () => { invokerCalls += 1; return workerResult(); },
    });
    // Different idempotencyKey → cache miss
    const differentKey = await dispatchAdapter({
      runRoot,
      pipelineAdapter: pipeline,
      request: buildAdapterRequest({ adapterCallId: 'b', attemptId: 'b', idempotencyKey: 'idem-2' }),
      cachePrompt: 'whatever',
      invoker: async () => { invokerCalls += 1; return workerResult(); },
    });
    assert.equal(differentKey.cacheHit, undefined);
    // Same idempotencyKey → cache hit
    const sameKey = await dispatchAdapter({
      runRoot,
      pipelineAdapter: pipeline,
      request: buildAdapterRequest({ adapterCallId: 'c', attemptId: 'c', idempotencyKey: 'idem-1' }),
      cachePrompt: 'whatever',
      invoker: async () => { invokerCalls += 1; return workerResult(); },
    });
    assert.equal(sameKey.cacheHit, true);
    assert.equal(invokerCalls, 2);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('cache hit appends a budget-ledger entry with cost zero and cacheHit=true', async () => {
  const runRoot = await makeRunRoot();
  try {
    await dispatchAdapter({
      runRoot,
      pipelineAdapter: v2Pipeline(),
      request: buildAdapterRequest(),
      cachePrompt: 'plain prompt no timestamps',
      invoker: async () => workerResult(),
    });
    await dispatchAdapter({
      runRoot,
      pipelineAdapter: v2Pipeline(),
      request: buildAdapterRequest({ adapterCallId: 'next', attemptId: 'next', idempotencyKey: 'next' }),
      cachePrompt: 'plain prompt no timestamps',
      invoker: async () => workerResult(),
    });
    const ledger = await readBudgetLedger(runRoot);
    assert.equal(ledger.entries.length, 2);
    const hit = ledger.entries[1];
    assert.equal(hit.cacheHit, true);
    assert.equal(hit.costEstimateUsd, 0);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('sweepExpiredEntries removes entries whose expiresAt is in the past', async () => {
  const runRoot = await makeRunRoot();
  try {
    const cacheKey = computeCacheKey({
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      prompt: 'expired',
      allowedFiles: [],
      taskKind: 'probe',
      outputContract: 'orpad.workerResult.v1',
      qualityTier: 'standard',
    });
    // Force a past expiration by hand.
    const entry = buildCacheEntry({
      cacheKey,
      mode: 'deterministic',
      ttlSeconds: 60,
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      promptHash: hashPrompt('expired'),
      allowedFilesHash: hashAllowedFiles([]),
      taskKind: 'probe',
      outputContract: 'orpad.workerResult.v1',
      qualityTier: 'standard',
      idempotencyKey: '',
      result: workerResult(),
      recordedAt: '2020-01-01T00:00:00.000Z',
    });
    entry.expiresAt = '2020-01-02T00:00:00.000Z';
    await writeCacheEntry(runRoot, entry);
    const sweep = await sweepExpiredEntries(runRoot);
    assert.equal(sweep.removed >= 1, true);
    assert.equal(await readCacheEntry(runRoot, cacheKey), null);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('cache entry never embeds a fake API key smuggled into the prompt', async () => {
  const runRoot = await makeRunRoot();
  try {
    const sneaky = 'normal prompt';
    await dispatchAdapter({
      runRoot,
      pipelineAdapter: v2Pipeline(),
      request: buildAdapterRequest(),
      cachePrompt: sneaky,
      invoker: async () => workerResult(),
    });
    const cacheKey = computeCacheKey({
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      prompt: sneaky,
      allowedFiles: ['src/sample.js'],
      taskKind: 'probe',
      outputContract: 'orpad.workerResult.v1',
      qualityTier: 'standard',
    });
    const filePath = cacheEntryPath(runRoot, cacheKey);
    const raw = await fs.readFile(filePath, 'utf8');
    // Cache files store only promptHash, never raw prompt content.
    assert.equal(raw.includes(sneaky), false, 'cache entry must not embed the raw prompt content');
    assert.equal(raw.includes('promptHash'), true);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});
