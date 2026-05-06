// Response cache — disk-backed, run-root scoped.
//
// PR M6: when the pipeline declares a `cache` block on the v2 envelope, the
// router consults this layer before invoking the plugin. A hit short-circuits
// the call: the cached adapter-result is returned with `cacheHit: true`,
// usage.costEstimateUsd is forced to 0, and the dispatcher emits a `cache.hit`
// event so replay can re-derive the run's cost without a network call.
//
// Cache files live at `<runRoot>/cache/<sha256>.json`. Keys are content-based
// in 'deterministic' mode (prompt hash + selection tuple + allowed files
// digest) and request-id-based in 'idempotent-only' mode. Raw prompts are
// not stored on disk — only their SHA-256 — so an accidental key in a prompt
// does not become a long-lived cache leak.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { ensureDir, writeJsonAtomic } = require('../metadata-store');

const fsp = fs.promises;
const CACHE_DIR = 'cache';
const SCHEMA_VERSION = 'orpad.responseCache.v1';
const CACHE_MODES = Object.freeze(['off', 'deterministic', 'idempotent-only']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(input) {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

function hashPrompt(prompt) {
  if (prompt === null || prompt === undefined) return sha256('');
  return sha256(prompt);
}

function hashAllowedFiles(allowedFiles) {
  const list = Array.isArray(allowedFiles) ? [...allowedFiles].sort() : [];
  return sha256(list);
}

function cacheKeyFromTuple(tuple) {
  return sha256(tuple);
}

function deterministicTuple({ providerId, model, prompt, allowedFiles, taskKind, outputContract, qualityTier }) {
  return {
    kind: 'deterministic',
    providerId: String(providerId || ''),
    model: String(model || ''),
    promptHash: hashPrompt(prompt),
    allowedFilesHash: hashAllowedFiles(allowedFiles),
    taskKind: String(taskKind || ''),
    outputContract: String(outputContract || ''),
    qualityTier: String(qualityTier || 'standard'),
  };
}

function idempotencyTuple({ providerId, model, idempotencyKey, outputContract }) {
  return {
    kind: 'idempotent-only',
    providerId: String(providerId || ''),
    model: String(model || ''),
    idempotencyKey: String(idempotencyKey || ''),
    outputContract: String(outputContract || ''),
  };
}

function computeCacheKey(input = {}) {
  const mode = input.mode || 'deterministic';
  if (mode === 'idempotent-only') return cacheKeyFromTuple(idempotencyTuple(input));
  return cacheKeyFromTuple(deterministicTuple(input));
}

const NON_DETERMINISTIC_PATTERNS = Object.freeze([
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\brun_\d{8}_\d{6}/,
  /\battempt_\d{17,}/,
]);

function findDeterminismViolations(text) {
  const violations = [];
  const str = String(text || '');
  for (const pattern of NON_DETERMINISTIC_PATTERNS) {
    const match = str.match(pattern);
    if (match) violations.push({ pattern: pattern.source, sample: match[0] });
  }
  return violations;
}

function assertPromptIsDeterministic(prompt) {
  const text = typeof prompt === 'string' ? prompt : JSON.stringify(prompt ?? '');
  const violations = findDeterminismViolations(text);
  return { ok: violations.length === 0, violations };
}

function cacheFilenameFor(cacheKey) {
  return `${cacheKey.replace('sha256:', '')}.json`;
}

function cacheDirFor(runRoot) {
  if (!runRoot) throw new Error('response-cache requires a runRoot.');
  return path.join(path.resolve(runRoot), CACHE_DIR);
}

function cacheEntryPath(runRoot, cacheKey) {
  return path.join(cacheDirFor(runRoot), cacheFilenameFor(cacheKey));
}

async function readCacheEntry(runRoot, cacheKey) {
  try {
    const raw = await fsp.readFile(cacheEntryPath(runRoot, cacheKey), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.schemaVersion === SCHEMA_VERSION && parsed.cacheKey === cacheKey) {
      return parsed;
    }
    return null;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return null;
  }
}

function isExpired(entry, now = Date.now()) {
  if (!entry || !entry.expiresAt) return false;
  const ts = Date.parse(entry.expiresAt);
  return Number.isFinite(ts) && ts <= now;
}

function scrubResultForCache(result) {
  if (!isPlainObject(result)) return result;
  const { apiSession, apiTrace, ...keep } = result;
  return keep;
}

function applyCacheHitToResult(result, cacheKey) {
  if (!isPlainObject(result)) return result;
  const usage = isPlainObject(result.usage) ? { ...result.usage } : {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    currency: 'USD',
  };
  usage.costEstimateUsd = 0;
  usage.currency = usage.currency || 'USD';
  return {
    ...result,
    cacheHit: true,
    cacheKey,
    usage,
  };
}

function buildCacheEntry({
  cacheKey,
  mode,
  ttlSeconds,
  providerId,
  model,
  promptHash,
  allowedFilesHash,
  taskKind,
  outputContract,
  qualityTier,
  idempotencyKey,
  result,
  recordedAt,
}) {
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 0;
  const recorded = recordedAt || new Date().toISOString();
  const expiresAt = ttl > 0 ? new Date(Date.parse(recorded) + ttl * 1000).toISOString() : null;
  return {
    schemaVersion: SCHEMA_VERSION,
    cacheKey,
    mode,
    recordedAt: recorded,
    ttlSeconds: ttl,
    expiresAt,
    request: {
      providerId,
      model,
      promptHash: promptHash || '',
      allowedFilesHash: allowedFilesHash || '',
      taskKind: taskKind || '',
      outputContract: outputContract || '',
      qualityTier: qualityTier || 'standard',
      idempotencyKey: idempotencyKey || '',
    },
    result: scrubResultForCache(result),
  };
}

async function writeCacheEntry(runRoot, entry) {
  if (!entry?.cacheKey) throw new Error('cache entry requires cacheKey.');
  await ensureDir(cacheDirFor(runRoot));
  await writeJsonAtomic(cacheEntryPath(runRoot, entry.cacheKey), entry);
  return entry;
}

async function sweepExpiredEntries(runRoot, now = Date.now()) {
  const dir = cacheDirFor(runRoot);
  let files;
  try {
    files = await fsp.readdir(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { removed: 0, scanned: 0 };
    throw err;
  }
  let removed = 0;
  let scanned = 0;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    scanned += 1;
    const filePath = path.join(dir, file);
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const entry = JSON.parse(raw);
      if (isExpired(entry, now)) {
        await fsp.unlink(filePath).catch(() => {});
        removed += 1;
      }
    } catch {
      // Malformed: leave for debugging.
    }
  }
  return { removed, scanned };
}

function shouldAttemptCacheLookup({ mode, prompt, idempotencyKey }) {
  if (!mode || mode === 'off') return { eligible: false, reason: 'cache-off' };
  if (!CACHE_MODES.includes(mode)) return { eligible: false, reason: `unknown-mode:${mode}` };
  if (mode === 'idempotent-only') {
    if (!idempotencyKey) return { eligible: false, reason: 'no-idempotency-key' };
    return { eligible: true, reason: 'idempotent-only' };
  }
  // deterministic
  const determinism = assertPromptIsDeterministic(prompt);
  if (!determinism.ok) {
    return { eligible: false, reason: 'prompt-not-deterministic', violations: determinism.violations };
  }
  return { eligible: true, reason: 'deterministic' };
}

module.exports = {
  CACHE_MODES,
  RESPONSE_CACHE_SCHEMA_VERSION: SCHEMA_VERSION,
  applyCacheHitToResult,
  assertPromptIsDeterministic,
  buildCacheEntry,
  cacheEntryPath,
  cacheDirFor,
  cacheFilenameFor,
  cacheKeyFromTuple,
  computeCacheKey,
  deterministicTuple,
  findDeterminismViolations,
  hashAllowedFiles,
  hashPrompt,
  idempotencyTuple,
  isExpired,
  readCacheEntry,
  scrubResultForCache,
  shouldAttemptCacheLookup,
  sweepExpiredEntries,
  writeCacheEntry,
};
