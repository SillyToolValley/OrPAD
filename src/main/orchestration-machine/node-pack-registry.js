const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const {
  MACHINE_STORAGE_ID_PATTERN,
} = require('./ids');
const { ensureDir, writeJsonAtomic } = require('./metadata-store');

const NODE_PACK_REGISTRY_KIND = 'orpad.nodePackRegistry';
const SUPPORTED_NODE_PACK_REGISTRY_SCHEMA_VERSION = '1.0';
const DEFAULT_REGISTRY_BYTE_LIMIT = 1024 * 1024;
const DEFAULT_REGISTRY_ENTRY_LIMIT = 1000;
const NODE_PACK_REGISTRY_CACHE_KIND = 'orpad.nodePackRegistryCache';
const NODE_PACK_REGISTRY_CACHE_SCHEMA_VERSION = '1.0';
const NODE_PACK_REGISTRY_CACHE_DIR = 'node-pack-registry-cache';
const NODE_PACK_REGISTRY_OFFICIAL_REVIEW_MODEL = 'orpad-pr-reviewed';
const NODE_PACK_REGISTRY_METADATA_TRUST_OFFICIAL = 'orpad-official-registry-reviewed';
const NODE_PACK_REGISTRY_METADATA_TRUST_THIRD_PARTY = 'third-party-registry-reviewed';
const NODE_PACK_REGISTRY_METADATA_TRUST_DISCOVERY = 'registry-discovery-only';

function diagnostic(level, code, message, details = {}) {
  return { level, code, message, ...details };
}

function errorDiagnostic(code, message, details = {}) {
  return diagnostic('error', code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function valueKind(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function stringField(value, fieldPath, diagnostics, codeBase, label) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    diagnostics.push(errorDiagnostic(`${codeBase}_MISSING`, `${label} is required.`, { path: fieldPath }));
    return '';
  }
  if (typeof value !== 'string') {
    diagnostics.push(errorDiagnostic(`${codeBase}_INVALID`, `${label} must be a string.`, {
      path: fieldPath,
      valueType: valueKind(value),
    }));
    return '';
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringList(value) {
  const source = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(',') : []);
  const seen = new Set();
  const list = [];
  for (const item of source) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    list.push(text);
  }
  return list;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (isPlainObject(value)) {
    const next = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      next[key] = canonicalJsonValue(value[key]);
    }
    return next;
  }
  return value;
}

function canonicalNodePackRegistrySignaturePayload(registry) {
  const source = isPlainObject(registry) ? registry : {};
  const payload = {};
  for (const key of Object.keys(source).sort()) {
    if (key === 'signature' || key === 'signatureVerification' || key === 'sourcePath') continue;
    if (source[key] === undefined) continue;
    payload[key] = canonicalJsonValue(source[key]);
  }
  return JSON.stringify(payload);
}

function trustedRegistryPublicKeyEntries(options = {}) {
  const sources = [
    options.trustedRegistryPublicKeys,
    options.registryPublicKeys,
    options.nodePackRegistryPublicKeys,
  ].filter(Boolean);
  const entries = new Map();
  for (const source of sources) {
    if (Array.isArray(source)) {
      for (const item of source) {
        if (!isPlainObject(item)) continue;
        const keyId = optionalString(item.keyId || item.id);
        const publicKey = item.publicKey || item.key || item.pem;
        if (keyId && publicKey) entries.set(keyId, publicKey);
      }
      continue;
    }
    if (isPlainObject(source) && source.keyId && (source.publicKey || source.key || source.pem)) {
      entries.set(optionalString(source.keyId), source.publicKey || source.key || source.pem);
      continue;
    }
    if (isPlainObject(source)) {
      for (const [keyId, value] of Object.entries(source)) {
        if (!keyId) continue;
        if (isPlainObject(value)) {
          const publicKey = value.publicKey || value.key || value.pem;
          if (publicKey) entries.set(keyId, publicKey);
        } else if (value) {
          entries.set(keyId, value);
        }
      }
    }
  }
  return entries;
}

function publicKeyFingerprint(publicKey) {
  try {
    const key = crypto.createPublicKey(publicKey);
    return crypto.createHash('sha256')
      .update(key.export({ type: 'spki', format: 'der' }))
      .digest('hex');
  } catch {
    return '';
  }
}

function verifyNodePackRegistrySignature(registry, options = {}) {
  const diagnostics = [];
  const signature = isPlainObject(registry?.signature) ? registry.signature : null;
  const trustedKeys = trustedRegistryPublicKeyEntries(options);
  const requireSignature = trustedKeys.size > 0 || options.requireRegistrySignature === true;
  if (!requireSignature) {
    return {
      verified: false,
      attempted: false,
      signature: signature ? { ...signature } : null,
      keyId: optionalString(signature?.keyId),
      fingerprint: '',
      diagnostics,
    };
  }
  if (!signature) {
    diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_SIGNATURE_MISSING', 'Node pack registry signature is required when trusted registry keys are configured.'));
    return { verified: false, attempted: true, signature: null, keyId: '', fingerprint: '', diagnostics };
  }

  const scheme = optionalString(signature.scheme).toLowerCase();
  const keyId = optionalString(signature.keyId);
  const value = optionalString(signature.value);
  if (scheme !== 'ed25519') {
    diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_SIGNATURE_SCHEME_UNSUPPORTED', 'Node pack registry signature scheme is not supported.', {
      scheme: signature.scheme || '',
      keyId,
    }));
  }
  if (!keyId) {
    diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_SIGNATURE_KEY_ID_MISSING', 'Node pack registry signature must include a key id.'));
  }
  if (!value) {
    diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_SIGNATURE_VALUE_MISSING', 'Node pack registry signature must include a base64 value.', {
      keyId,
    }));
  }
  const publicKey = keyId ? trustedKeys.get(keyId) : null;
  if (keyId && !publicKey) {
    diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_SIGNATURE_KEY_UNTRUSTED', 'Node pack registry signature key is not trusted by this OrPAD build or profile.', {
      keyId,
    }));
  }
  if (diagnostics.some(item => item.level === 'error')) {
    return { verified: false, attempted: true, signature: { ...signature }, keyId, fingerprint: '', diagnostics };
  }

  let verified = false;
  let fingerprint = '';
  try {
    const payload = Buffer.from(canonicalNodePackRegistrySignaturePayload(registry), 'utf-8');
    const signatureBytes = Buffer.from(value, 'base64');
    fingerprint = publicKeyFingerprint(publicKey);
    verified = crypto.verify(null, payload, publicKey, signatureBytes);
  } catch (err) {
    diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_SIGNATURE_VERIFY_FAILED', 'Node pack registry signature could not be verified.', {
      keyId,
      error: err.message,
    }));
    return { verified: false, attempted: true, signature: { ...signature }, keyId, fingerprint, diagnostics };
  }
  if (!verified) {
    diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_SIGNATURE_INVALID', 'Node pack registry signature does not match the registry payload.', {
      keyId,
      fingerprint,
    }));
  }
  return {
    verified,
    attempted: true,
    signature: { ...signature },
    keyId,
    fingerprint,
    diagnostics,
  };
}

function assertRegistryId(value, fieldPath, diagnostics, codeBase, label) {
  const text = stringField(value, fieldPath, diagnostics, codeBase, label);
  if (text && !MACHINE_STORAGE_ID_PATTERN.test(text)) {
    diagnostics.push(errorDiagnostic(`${codeBase}_INVALID`, `${label} must be a safe registry id segment.`, {
      path: fieldPath,
      value: text,
    }));
    return '';
  }
  return text;
}

function unsafeUrlReason(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'url-parse-failed';
  }
  if (url.protocol !== 'https:') return 'manifestUrl must use https';
  if (url.username || url.password) return 'manifestUrl must not include credentials';
  return '';
}

function unsafeRepositoryUrlReason(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'url-parse-failed';
  }
  if (url.protocol !== 'https:') return 'sourceRepository must use https';
  if (url.username || url.password) return 'sourceRepository must not include credentials';
  return '';
}

function isSafePortablePath(value) {
  const text = String(value || '').replace(/\\/g, '/');
  return Boolean(text)
    && !text.startsWith('/')
    && !/^[A-Za-z]:\//.test(text)
    && !text.includes('//')
    && !text.split('/').some(part => part === '.' || part === '..' || !part);
}

function normalizeRegistryVersion(rawVersion, entryPath, diagnostics) {
  if (!isPlainObject(rawVersion)) {
    diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_VERSION_INVALID', 'Registry entry version must be an object.', {
      path: entryPath,
      valueType: valueKind(rawVersion),
    }));
    return null;
  }

  const version = stringField(
    rawVersion.version,
    `${entryPath}.version`,
    diagnostics,
    'NODE_PACK_REGISTRY_VERSION',
    'Node pack registry version',
  );
  const manifestUrl = stringField(
    rawVersion.manifestUrl,
    `${entryPath}.manifestUrl`,
    diagnostics,
    'NODE_PACK_REGISTRY_MANIFEST_URL',
    'Node pack registry manifestUrl',
  );
  const sourceRepository = stringField(
    rawVersion.sourceRepository,
    `${entryPath}.sourceRepository`,
    diagnostics,
    'NODE_PACK_REGISTRY_SOURCE_REPOSITORY',
    'Node pack registry sourceRepository',
  );
  const sourceRef = stringField(
    rawVersion.sourceRef,
    `${entryPath}.sourceRef`,
    diagnostics,
    'NODE_PACK_REGISTRY_SOURCE_REF',
    'Node pack registry sourceRef',
  );
  const manifestPath = stringField(
    rawVersion.manifestPath,
    `${entryPath}.manifestPath`,
    diagnostics,
    'NODE_PACK_REGISTRY_MANIFEST_PATH',
    'Node pack registry manifestPath',
  );

  if (!manifestUrl || !sourceRepository || !sourceRef || !manifestPath) {
    diagnostics.push(errorDiagnostic(
      'NODE_PACK_REGISTRY_VERSION_SOURCE_MISSING',
      'Registry entry version must declare manifest URL, source repository, source ref, and manifest path.',
      { path: entryPath },
    ));
  }

  if (manifestUrl) {
    const reason = unsafeUrlReason(manifestUrl);
    if (reason) {
      diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_MANIFEST_URL_UNSAFE', 'Registry manifestUrl is not safe for remote install.', {
        path: `${entryPath}.manifestUrl`,
        manifestUrl,
        reason,
      }));
    }
  }

  if (sourceRepository) {
    const reason = unsafeRepositoryUrlReason(sourceRepository);
    if (reason) {
      diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_SOURCE_REPOSITORY_UNSAFE', 'Registry sourceRepository is not safe for attribution.', {
        path: `${entryPath}.sourceRepository`,
        sourceRepository,
        reason,
      }));
    }
  }

  if (manifestPath && !isSafePortablePath(manifestPath)) {
    diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_MANIFEST_PATH_UNSAFE', 'Registry manifestPath must be pack-relative and portable.', {
      path: `${entryPath}.manifestPath`,
      manifestPath,
    }));
  }

  const sourceRoot = optionalString(rawVersion.sourceRoot);
  if (sourceRoot && !isSafePortablePath(sourceRoot)) {
    diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_SOURCE_ROOT_UNSAFE', 'Registry sourceRoot must be repository-relative and portable.', {
      path: `${entryPath}.sourceRoot`,
      sourceRoot,
    }));
  }

  return {
    version,
    manifestUrl,
    sourceRepository,
    sourceRef,
    sourceRoot,
    manifestPath,
    checksums: isPlainObject(rawVersion.checksums) ? { ...rawVersion.checksums } : {},
    signature: isPlainObject(rawVersion.signature) ? { ...rawVersion.signature } : null,
    review: isPlainObject(rawVersion.review) ? { ...rawVersion.review } : null,
  };
}

function normalizeRegistryGovernance(rawRegistry = {}) {
  const rawGovernance = isPlainObject(rawRegistry.governance) ? rawRegistry.governance : {};
  const rawSubmissions = isPlainObject(rawGovernance.submissions) ? rawGovernance.submissions : {};
  const reviewModel = optionalString(rawGovernance.reviewModel || rawRegistry.reviewModel);
  const registryTrust = optionalString(rawGovernance.registryTrust || rawRegistry.registryTrust || rawRegistry.trustLevel);
  const submissionsUrl = optionalString(rawSubmissions.url || rawGovernance.submissionsUrl || rawRegistry.submissionsUrl);
  const reviewPolicyUrl = optionalString(rawGovernance.reviewPolicyUrl || rawGovernance.policyUrl || rawRegistry.reviewPolicyUrl);
  return {
    registryTrust: registryTrust || (reviewModel === NODE_PACK_REGISTRY_OFFICIAL_REVIEW_MODEL ? 'official' : 'community'),
    reviewModel: reviewModel || 'registry-discovery-only',
    submissions: {
      type: optionalString(rawSubmissions.type || rawGovernance.submissionType) || 'pull-request',
      url: submissionsUrl,
    },
    reviewPolicyUrl,
    maintainer: optionalString(rawGovernance.maintainer || rawRegistry.maintainer),
    notes: optionalString(rawGovernance.notes),
  };
}

function registryUsesOfficialReview(registry = {}) {
  const governance = registry?.governance || {};
  return governance.reviewModel === NODE_PACK_REGISTRY_OFFICIAL_REVIEW_MODEL
    && governance.registryTrust === 'official';
}

function normalizeRegistryEntry(rawEntry, entryPath, diagnostics) {
  if (!isPlainObject(rawEntry)) {
    diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_ENTRY_INVALID', 'Registry entry must be an object.', {
      path: entryPath,
      valueType: valueKind(rawEntry),
    }));
    return null;
  }

  const id = assertRegistryId(
    rawEntry.id,
    `${entryPath}.id`,
    diagnostics,
    'NODE_PACK_REGISTRY_ENTRY_ID',
    'Node pack registry entry id',
  );
  const name = stringField(
    rawEntry.name,
    `${entryPath}.name`,
    diagnostics,
    'NODE_PACK_REGISTRY_ENTRY_NAME',
    'Node pack registry entry name',
  );
  const latestVersion = stringField(
    rawEntry.latestVersion,
    `${entryPath}.latestVersion`,
    diagnostics,
    'NODE_PACK_REGISTRY_ENTRY_LATEST_VERSION',
    'Node pack registry entry latestVersion',
  );

  if (!Array.isArray(rawEntry.versions) || !rawEntry.versions.length) {
    diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_ENTRY_VERSIONS_MISSING', 'Registry entry must contain at least one version.', {
      path: `${entryPath}.versions`,
    }));
  }

  const versionSeen = new Set();
  const versions = [];
  for (const [index, rawVersion] of (Array.isArray(rawEntry.versions) ? rawEntry.versions : []).entries()) {
    const versionPath = `${entryPath}.versions[${index}]`;
    const normalized = normalizeRegistryVersion(rawVersion, versionPath, diagnostics);
    if (!normalized) continue;
    if (normalized.version) {
      if (versionSeen.has(normalized.version)) {
        diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_VERSION_DUPLICATE', 'Registry entry declares the same version more than once.', {
          path: `${versionPath}.version`,
          entryId: id,
          version: normalized.version,
        }));
      } else {
        versionSeen.add(normalized.version);
      }
    }
    versions.push(normalized);
  }

  if (latestVersion && versions.length && !versionSeen.has(latestVersion)) {
    diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_LATEST_VERSION_MISSING', 'Registry latestVersion must match one declared version.', {
      path: `${entryPath}.latestVersion`,
      entryId: id,
      latestVersion,
    }));
  }

  return {
    id,
    name,
    description: optionalString(rawEntry.description),
    latestVersion,
    versions,
    author: isPlainObject(rawEntry.author) ? { ...rawEntry.author } : {},
    license: optionalString(rawEntry.license),
    trustLevel: optionalString(rawEntry.trustLevel),
    capabilities: normalizeStringList(rawEntry.capabilities),
    nodeTypes: normalizeStringList(rawEntry.nodeTypes || rawEntry.declaredNodeTypes),
    keywords: normalizeStringList(rawEntry.keywords),
    categories: normalizeStringList(rawEntry.categories),
    links: isPlainObject(rawEntry.links) ? { ...rawEntry.links } : {},
  };
}

function normalizeNodePackRegistryIndex(registry, options = {}) {
  const diagnostics = [];
  if (!isPlainObject(registry)) {
    return {
      ok: false,
      registry: null,
      entries: [],
      diagnostics: [
        errorDiagnostic('NODE_PACK_REGISTRY_INVALID', 'Node pack registry index must be a JSON object.', {
          valueType: valueKind(registry),
        }),
      ],
    };
  }

  const kind = stringField(
    registry.kind,
    'kind',
    diagnostics,
    'NODE_PACK_REGISTRY_KIND',
    'Node pack registry kind',
  );
  if (kind && kind !== NODE_PACK_REGISTRY_KIND) {
    diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_KIND_INVALID', 'Node pack registry kind is not supported.', {
      path: 'kind',
      expected: NODE_PACK_REGISTRY_KIND,
      actual: kind,
    }));
  }

  const schemaVersion = stringField(
    registry.schemaVersion,
    'schemaVersion',
    diagnostics,
    'NODE_PACK_REGISTRY_SCHEMA_VERSION',
    'Node pack registry schemaVersion',
  );
  if (schemaVersion && schemaVersion !== SUPPORTED_NODE_PACK_REGISTRY_SCHEMA_VERSION) {
    diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_SCHEMA_VERSION_INVALID', 'Node pack registry schemaVersion is not supported.', {
      path: 'schemaVersion',
      expected: SUPPORTED_NODE_PACK_REGISTRY_SCHEMA_VERSION,
      actual: schemaVersion,
    }));
  }

  const registryId = assertRegistryId(
    registry.registryId,
    'registryId',
    diagnostics,
    'NODE_PACK_REGISTRY_ID',
    'Node pack registry id',
  );
  const name = stringField(
    registry.name,
    'name',
    diagnostics,
    'NODE_PACK_REGISTRY_NAME',
    'Node pack registry name',
  );

  if (!Array.isArray(registry.entries)) {
    diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_ENTRIES_MISSING', 'Node pack registry entries must be an array.', {
      path: 'entries',
      valueType: valueKind(registry.entries),
    }));
  } else {
    const maxEntries = Number.isFinite(options.maxEntries)
      ? Math.max(0, options.maxEntries)
      : DEFAULT_REGISTRY_ENTRY_LIMIT;
    if (registry.entries.length > maxEntries) {
      diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_ENTRIES_TOO_MANY', 'Node pack registry entry count exceeds the safe parse limit.', {
        path: 'entries',
        entryCount: registry.entries.length,
        maxEntries,
      }));
    }
  }

  const entrySeen = new Set();
  const entries = [];
  for (const [index, rawEntry] of (Array.isArray(registry.entries) ? registry.entries : []).entries()) {
    const entry = normalizeRegistryEntry(rawEntry, `entries[${index}]`, diagnostics);
    if (!entry) continue;
    if (entry.id) {
      if (entrySeen.has(entry.id)) {
        diagnostics.push(errorDiagnostic('NODE_PACK_REGISTRY_ENTRY_DUPLICATE_ID', 'Registry declares the same node pack id more than once.', {
          path: `entries[${index}].id`,
          entryId: entry.id,
        }));
      } else {
        entrySeen.add(entry.id);
      }
    }
    entries.push(entry);
  }

  const normalized = {
    kind,
    schemaVersion,
    registryId,
    name,
    governance: normalizeRegistryGovernance(registry),
    generatedAt: optionalString(registry.generatedAt),
    entries,
    sourcePath: options.sourcePath ? path.resolve(String(options.sourcePath)) : '',
  };
  const signatureVerification = verifyNodePackRegistrySignature(registry, options);
  diagnostics.push(...signatureVerification.diagnostics);
  normalized.signature = isPlainObject(registry.signature)
    ? {
      ...registry.signature,
      verified: signatureVerification.verified === true,
      verificationAttempted: signatureVerification.attempted === true,
      fingerprint: signatureVerification.fingerprint || '',
    }
    : null;
  normalized.signatureVerification = {
    verified: signatureVerification.verified === true,
    attempted: signatureVerification.attempted === true,
    keyId: signatureVerification.keyId || '',
    fingerprint: signatureVerification.fingerprint || '',
  };
  const ok = !diagnostics.some(item => item.level === 'error');

  return {
    ok,
    registry: normalized,
    entries,
    diagnostics,
  };
}

async function readNodePackRegistryFile(filePath, options = {}) {
  const targetPath = path.resolve(String(filePath || ''));
  const byteLimit = Number.isFinite(options.byteLimit)
    ? options.byteLimit
    : DEFAULT_REGISTRY_BYTE_LIMIT;
  let stat;
  try {
    stat = await fs.stat(targetPath);
  } catch (err) {
    return {
      ok: false,
      registry: null,
      entries: [],
      diagnostics: [
        errorDiagnostic('NODE_PACK_REGISTRY_FILE_UNREADABLE', 'Node pack registry file could not be read.', {
          path: targetPath,
          error: err.message,
        }),
      ],
    };
  }

  if (!stat.isFile()) {
    return {
      ok: false,
      registry: null,
      entries: [],
      diagnostics: [
        errorDiagnostic('NODE_PACK_REGISTRY_FILE_NOT_FILE', 'Node pack registry path must be a file.', {
          path: targetPath,
        }),
      ],
    };
  }

  if (stat.size > byteLimit) {
    return {
      ok: false,
      registry: null,
      entries: [],
      diagnostics: [
        errorDiagnostic('NODE_PACK_REGISTRY_FILE_TOO_LARGE', 'Node pack registry file exceeds the safe read limit.', {
          path: targetPath,
          size: stat.size,
          byteLimit,
        }),
      ],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(targetPath, 'utf-8'));
  } catch (err) {
    return {
      ok: false,
      registry: null,
      entries: [],
      diagnostics: [
        errorDiagnostic('NODE_PACK_REGISTRY_JSON_INVALID', 'Node pack registry file must contain valid JSON.', {
          path: targetPath,
          error: err.message,
        }),
      ],
    };
  }

  const normalized = normalizeNodePackRegistryIndex(parsed, {
    ...options,
    sourcePath: targetPath,
  });
  return {
    ...normalized,
    rawRegistry: parsed,
  };
}

function isUrlSource(source) {
  try {
    const url = new URL(String(source || ''));
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function registrySourceKind(source) {
  return isUrlSource(source) ? 'url' : 'file';
}

async function fetchNodePackRegistryUrl(source, options = {}) {
  let url;
  try {
    url = new URL(String(source || ''));
  } catch (err) {
    return {
      ok: false,
      registry: null,
      entries: [],
      diagnostics: [
        errorDiagnostic('NODE_PACK_REGISTRY_SOURCE_URL_INVALID', 'Node pack registry source URL is invalid.', {
          source,
          error: err.message,
        }),
      ],
    };
  }
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      registry: null,
      entries: [],
      diagnostics: [
        errorDiagnostic('NODE_PACK_REGISTRY_SOURCE_URL_UNSAFE', 'Node pack registry source URL must use https.', {
          source,
          reason: 'registry source must use https',
        }),
      ],
    };
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      registry: null,
      entries: [],
      diagnostics: [
        errorDiagnostic('NODE_PACK_REGISTRY_FETCH_UNAVAILABLE', 'Node pack registry URL fetch is unavailable in this runtime.', {
          source,
        }),
      ],
    };
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 10_000;
  const byteLimit = Number.isFinite(options.byteLimit) ? options.byteLimit : DEFAULT_REGISTRY_BYTE_LIMIT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url.href, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain;q=0.8, */*;q=0.1',
      },
    });
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      registry: null,
      entries: [],
      diagnostics: [
        errorDiagnostic(err?.name === 'AbortError' ? 'NODE_PACK_REGISTRY_FETCH_TIMEOUT' : 'NODE_PACK_REGISTRY_FETCH_FAILED', 'Node pack registry URL could not be fetched.', {
          source,
          error: err.message,
        }),
      ],
    };
  }
  clearTimeout(timer);

  if (!response || response.ok !== true) {
    return {
      ok: false,
      registry: null,
      entries: [],
      diagnostics: [
        errorDiagnostic('NODE_PACK_REGISTRY_FETCH_STATUS', 'Node pack registry URL returned a non-success status.', {
          source,
          status: response?.status || 0,
        }),
      ],
    };
  }

  let text = '';
  try {
    text = await response.text();
  } catch (err) {
    return {
      ok: false,
      registry: null,
      entries: [],
      diagnostics: [
        errorDiagnostic('NODE_PACK_REGISTRY_FETCH_BODY_FAILED', 'Node pack registry response body could not be read.', {
          source,
          error: err.message,
        }),
      ],
    };
  }

  const size = Buffer.byteLength(text, 'utf-8');
  if (size > byteLimit) {
    return {
      ok: false,
      registry: null,
      entries: [],
      diagnostics: [
        errorDiagnostic('NODE_PACK_REGISTRY_FETCH_TOO_LARGE', 'Node pack registry response exceeds the safe read limit.', {
          source,
          size,
          byteLimit,
        }),
      ],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      registry: null,
      entries: [],
      diagnostics: [
        errorDiagnostic('NODE_PACK_REGISTRY_FETCH_JSON_INVALID', 'Node pack registry URL must return valid JSON.', {
          source,
          error: err.message,
        }),
      ],
    };
  }

  const normalized = normalizeNodePackRegistryIndex(parsed, {
    ...options,
    sourcePath: source,
  });
  return {
    ...normalized,
    rawRegistry: parsed,
  };
}

function nodePackRegistryCacheRoot(userDataDir) {
  if (!userDataDir) return '';
  return path.join(path.resolve(String(userDataDir)), NODE_PACK_REGISTRY_CACHE_DIR);
}

function nodePackRegistryCacheKey(source) {
  return sha256Hex(String(source || ''));
}

function nodePackRegistryCachePath(userDataDir, source) {
  const root = nodePackRegistryCacheRoot(userDataDir);
  if (!root) return '';
  return path.join(root, `${nodePackRegistryCacheKey(source)}.json`);
}

async function writeNodePackRegistryCache(source, rawRegistry, options = {}) {
  const cachePath = nodePackRegistryCachePath(options.userDataDir, source);
  if (!cachePath) return null;
  const cacheEntry = {
    kind: NODE_PACK_REGISTRY_CACHE_KIND,
    schemaVersion: NODE_PACK_REGISTRY_CACHE_SCHEMA_VERSION,
    source: String(source || ''),
    sourceKey: nodePackRegistryCacheKey(source),
    cachedAt: options.now || new Date().toISOString(),
    registry: rawRegistry,
  };
  await ensureDir(path.dirname(cachePath));
  await writeJsonAtomic(cachePath, cacheEntry);
  return {
    path: cachePath,
    entry: cacheEntry,
  };
}

async function readNodePackRegistryCache(source, options = {}) {
  const cachePath = nodePackRegistryCachePath(options.userDataDir, source);
  if (!cachePath) {
    return {
      ok: false,
      registry: null,
      entries: [],
      diagnostics: [
        errorDiagnostic('NODE_PACK_REGISTRY_CACHE_UNAVAILABLE', 'Node pack registry cache requires a user data directory.', {
          source,
        }),
      ],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
  } catch (err) {
    return {
      ok: false,
      registry: null,
      entries: [],
      diagnostics: [
        errorDiagnostic(err?.code === 'ENOENT' ? 'NODE_PACK_REGISTRY_CACHE_MISSING' : 'NODE_PACK_REGISTRY_CACHE_INVALID', 'Node pack registry cache could not be read.', {
          source,
          cachePath,
          error: err.message,
        }),
      ],
    };
  }

  if (!isPlainObject(parsed) || parsed.kind !== NODE_PACK_REGISTRY_CACHE_KIND || parsed.schemaVersion !== NODE_PACK_REGISTRY_CACHE_SCHEMA_VERSION) {
    return {
      ok: false,
      registry: null,
      entries: [],
      diagnostics: [
        errorDiagnostic('NODE_PACK_REGISTRY_CACHE_INVALID', 'Node pack registry cache has an unsupported shape.', {
          source,
          cachePath,
        }),
      ],
    };
  }

  if (parsed.source !== String(source || '') || parsed.sourceKey !== nodePackRegistryCacheKey(source)) {
    return {
      ok: false,
      registry: null,
      entries: [],
      diagnostics: [
        errorDiagnostic('NODE_PACK_REGISTRY_CACHE_SOURCE_MISMATCH', 'Node pack registry cache source does not match the requested registry.', {
          source,
          cachePath,
          cachedSource: parsed.source || '',
        }),
      ],
    };
  }

  const normalized = normalizeNodePackRegistryIndex(parsed.registry, {
    ...options,
    sourcePath: cachePath,
  });
  return {
    ...normalized,
    cachePath,
    cachedAt: parsed.cachedAt || '',
    fromCache: true,
  };
}

function cacheFallbackDiagnostic(source, sourceResult, cacheResult) {
  return diagnostic('warning', 'NODE_PACK_REGISTRY_SOURCE_FAILED_CACHE_USED', 'Node pack registry source failed; using last valid cache.', {
    source,
    sourceDiagnostics: sourceResult.diagnostics || [],
    cachePath: cacheResult.cachePath || '',
    cachedAt: cacheResult.cachedAt || '',
  });
}

async function loadNodePackRegistrySource(source, options = {}) {
  if (!String(source || '').trim()) {
    return {
      ok: false,
      registry: null,
      entries: [],
      diagnostics: [
        errorDiagnostic('NODE_PACK_REGISTRY_SOURCE_MISSING', 'Node pack registry source is required.'),
      ],
    };
  }

  const sourceText = String(source).trim();
  const result = registrySourceKind(sourceText) === 'url'
    ? await fetchNodePackRegistryUrl(sourceText, options)
    : await readNodePackRegistryFile(sourceText, options);

  if (result.ok) {
    if (options.userDataDir) {
      try {
        await writeNodePackRegistryCache(sourceText, result.rawRegistry || result.registry, options);
      } catch (err) {
        result.diagnostics.push(diagnostic('warning', 'NODE_PACK_REGISTRY_CACHE_WRITE_FAILED', 'Node pack registry cache could not be written.', {
          source: sourceText,
          error: err.message,
        }));
      }
    }
    return {
      ...result,
      source: sourceText,
      sourceKind: registrySourceKind(sourceText),
      fromCache: false,
    };
  }

  if (options.userDataDir && options.useCacheOnFailure !== false) {
    const cacheResult = await readNodePackRegistryCache(sourceText, options);
    if (cacheResult.ok) {
      return {
        ...cacheResult,
        source: sourceText,
        sourceKind: registrySourceKind(sourceText),
        fromCache: true,
        diagnostics: [
          cacheFallbackDiagnostic(sourceText, result, cacheResult),
        ],
      };
    }
    return {
      ...result,
      source: sourceText,
      sourceKind: registrySourceKind(sourceText),
      fromCache: false,
      diagnostics: [
        ...(result.diagnostics || []),
        ...(cacheResult.diagnostics || []),
      ],
    };
  }

  return {
    ...result,
    source: sourceText,
    sourceKind: registrySourceKind(sourceText),
    fromCache: false,
  };
}

function latestRegistryVersion(entry) {
  const latest = String(entry?.latestVersion || '').trim();
  if (!latest) return null;
  return (Array.isArray(entry?.versions) ? entry.versions : []).find(item => item.version === latest) || null;
}

function summarizeNodePackRegistryVersion(version = {}, fallback = {}) {
  const manifestSha256 = version?.checksums?.manifestSha256 || '';
  const fileChecksums = isPlainObject(version?.checksums?.files) ? version.checksums.files : {};
  const review = isPlainObject(version?.review) ? version.review : {};
  const reviewStatus = optionalString(review.status);
  return {
    version: version.version || '',
    sourceRepository: version.sourceRepository || fallback.sourceRepository || '',
    sourceRef: version.sourceRef || '',
    manifestPath: version.manifestPath || 'orpad.node-pack.json',
    manifestSha256,
    signatureStatus: version.signature
      ? (version.signature.verified === true ? 'verified' : 'declared')
      : 'missing',
    checksumStatus: manifestSha256
      ? (Object.keys(fileChecksums).length ? 'manifest-and-files-declared' : 'manifest-declared')
      : 'missing',
    reviewStatus: reviewStatus || 'unreviewed',
    reviewedAt: optionalString(review.reviewedAt),
    reviewId: optionalString(review.reviewId || review.decisionId),
    reviewedBy: optionalString(review.reviewedBy || review.reviewer),
    approvedCapabilities: normalizeStringList(review.approvedCapabilities),
  };
}

function nodePackRegistryEntryMetadataTrust(entry = {}, registry = {}) {
  const latest = latestRegistryVersion(entry);
  const reviewStatus = optionalString(latest?.review?.status).toLowerCase();
  if (reviewStatus !== 'approved') return NODE_PACK_REGISTRY_METADATA_TRUST_DISCOVERY;
  return registryUsesOfficialReview(registry)
    ? NODE_PACK_REGISTRY_METADATA_TRUST_OFFICIAL
    : NODE_PACK_REGISTRY_METADATA_TRUST_THIRD_PARTY;
}

function summarizeNodePackRegistryEntry(entry, registry = {}) {
  const latest = latestRegistryVersion(entry);
  const latestSummary = summarizeNodePackRegistryVersion(latest || {}, {
    sourceRepository: entry.author?.repository || '',
  });
  const versions = (Array.isArray(entry.versions) ? entry.versions : [])
    .map(version => summarizeNodePackRegistryVersion(version, {
      sourceRepository: entry.author?.repository || '',
    }))
    .filter(version => version.version);
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    latestVersion: entry.latestVersion,
    versionCount: Array.isArray(entry.versions) ? entry.versions.length : 0,
    versions,
    sourceRepository: latestSummary.sourceRepository || entry.author?.repository || '',
    sourceRef: latestSummary.sourceRef || '',
    manifestPath: latestSummary.manifestPath || '',
    manifestSha256: latestSummary.manifestSha256 || '',
    trustLevel: entry.trustLevel || 'community',
    capabilities: Array.isArray(entry.capabilities) ? [...entry.capabilities] : [],
    nodeTypes: Array.isArray(entry.nodeTypes) ? [...entry.nodeTypes] : [],
    keywords: Array.isArray(entry.keywords) ? [...entry.keywords] : [],
    categories: Array.isArray(entry.categories) ? [...entry.categories] : [],
    author: isPlainObject(entry.author) ? { ...entry.author } : {},
    license: entry.license || '',
    installable: Boolean(latest),
    signatureStatus: latestSummary.signatureStatus,
    checksumStatus: latestSummary.checksumStatus,
    reviewStatus: latestSummary.reviewStatus,
    reviewedAt: latestSummary.reviewedAt,
    reviewId: latestSummary.reviewId,
    reviewedBy: latestSummary.reviewedBy,
    approvedCapabilities: latestSummary.approvedCapabilities,
    metadataTrust: nodePackRegistryEntryMetadataTrust(entry, registry),
  };
}

function summarizeNodePackRegistry(registry) {
  const entries = Array.isArray(registry?.entries) ? registry.entries : [];
  return {
    kind: registry?.kind || NODE_PACK_REGISTRY_KIND,
    schemaVersion: registry?.schemaVersion || SUPPORTED_NODE_PACK_REGISTRY_SCHEMA_VERSION,
    registryId: registry?.registryId || '',
    name: registry?.name || '',
    governance: registry?.governance ? {
      registryTrust: registry.governance.registryTrust || '',
      reviewModel: registry.governance.reviewModel || '',
      submissions: registry.governance.submissions ? { ...registry.governance.submissions } : {},
      reviewPolicyUrl: registry.governance.reviewPolicyUrl || '',
      maintainer: registry.governance.maintainer || '',
      notes: registry.governance.notes || '',
    } : normalizeRegistryGovernance(registry || {}),
    metadataTrust: registryUsesOfficialReview(registry)
      ? NODE_PACK_REGISTRY_METADATA_TRUST_OFFICIAL
      : NODE_PACK_REGISTRY_METADATA_TRUST_DISCOVERY,
    generatedAt: registry?.generatedAt || '',
    sourcePath: registry?.sourcePath || '',
    signature: registry?.signature ? {
      scheme: registry.signature.scheme || '',
      keyId: registry.signature.keyId || '',
      verified: registry.signature.verified === true,
      verificationAttempted: registry.signature.verificationAttempted === true,
      fingerprint: registry.signature.fingerprint || '',
    } : null,
    entries: entries.map(entry => summarizeNodePackRegistryEntry(entry, registry)),
  };
}

function textMatchesQuery(value, query) {
  return String(value || '').toLowerCase().includes(query);
}

function searchNodePackRegistryEntries(entries, query = '', filters = {}) {
  const queryText = String(query || '').trim().toLowerCase();
  const categoryFilters = normalizeStringList(filters.categories || filters.category).map(item => item.toLowerCase());
  const capabilityFilters = normalizeStringList(filters.capabilities || filters.capability).map(item => item.toLowerCase());
  return (Array.isArray(entries) ? entries : [])
    .filter(entry => {
      if (queryText) {
        const haystack = [
          entry.id,
          entry.name,
          entry.description,
          ...(Array.isArray(entry.keywords) ? entry.keywords : []),
          ...(Array.isArray(entry.categories) ? entry.categories : []),
          ...(Array.isArray(entry.nodeTypes) ? entry.nodeTypes : []),
        ];
        if (!haystack.some(value => textMatchesQuery(value, queryText))) return false;
      }
      if (categoryFilters.length) {
        const categories = new Set((Array.isArray(entry.categories) ? entry.categories : []).map(item => String(item).toLowerCase()));
        if (!categoryFilters.every(item => categories.has(item))) return false;
      }
      if (capabilityFilters.length) {
        const capabilities = new Set((Array.isArray(entry.capabilities) ? entry.capabilities : []).map(item => String(item).toLowerCase()));
        if (!capabilityFilters.every(item => capabilities.has(item))) return false;
      }
      return true;
    })
    .map(entry => summarizeNodePackRegistryEntry(entry, filters.registry || {}));
}

function registryCandidateRequestFromDiagnostics(diagnostics = []) {
  const missingPackIds = new Set();
  const missingNodeTypes = new Set();
  for (const issue of Array.isArray(diagnostics) ? diagnostics : []) {
    const code = String(issue?.code || '');
    const packId = optionalString(issue?.packId || issue?.nodePackId || issue?.id);
    const nodeType = optionalString(issue?.nodeType || issue?.type);
    if (code === 'PIPELINE_NODE_PACK_UNKNOWN' || code === 'GRAPH_NODE_PACK_MISSING') {
      if (packId) missingPackIds.add(packId);
    }
    if (code === 'GRAPH_NODE_TYPE_UNKNOWN' || code === 'GRAPH_NODE_PACK_MISSING') {
      if (nodeType) missingNodeTypes.add(nodeType);
    }
  }
  return {
    missingPackIds: [...missingPackIds].sort(),
    missingNodeTypes: [...missingNodeTypes].sort(),
  };
}

function nodePackRegistryCandidateSummary(entry, registry = {}) {
  return Array.isArray(entry?.versions)
    ? summarizeNodePackRegistryEntry(entry, registry)
    : {
      ...entry,
      nodeTypes: Array.isArray(entry?.nodeTypes) ? [...entry.nodeTypes] : [],
      capabilities: Array.isArray(entry?.capabilities) ? [...entry.capabilities] : [],
      keywords: Array.isArray(entry?.keywords) ? [...entry.keywords] : [],
      categories: Array.isArray(entry?.categories) ? [...entry.categories] : [],
    };
}

function findNodePackRegistryCandidates(entries = [], request = {}) {
  const fromDiagnostics = registryCandidateRequestFromDiagnostics(request.diagnostics);
  const missingPackIds = new Set([
    ...normalizeStringList(request.missingPackIds || request.packIds || request.packId),
    ...fromDiagnostics.missingPackIds,
  ]);
  const missingNodeTypes = new Set([
    ...normalizeStringList(request.missingNodeTypes || request.nodeTypes || request.nodeType),
    ...fromDiagnostics.missingNodeTypes,
  ]);
  const candidates = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const summary = nodePackRegistryCandidateSummary(entry, request.registry || {});
    const matchReasons = [];
    if (missingPackIds.has(summary.id)) {
      matchReasons.push({ kind: 'pack-id', packId: summary.id });
    }
    const entryNodeTypes = new Set((Array.isArray(summary.nodeTypes) ? summary.nodeTypes : []).map(item => String(item || '').trim()).filter(Boolean));
    for (const nodeType of missingNodeTypes) {
      if (entryNodeTypes.has(nodeType)) matchReasons.push({ kind: 'node-type', nodeType });
    }
    if (matchReasons.length) {
      candidates.push({
        ...summary,
        matchReasons,
      });
    }
  }
  return {
    ok: true,
    success: true,
    missingPackIds: [...missingPackIds].sort(),
    missingNodeTypes: [...missingNodeTypes].sort(),
    candidates,
    diagnostics: [],
  };
}

module.exports = {
  DEFAULT_REGISTRY_BYTE_LIMIT,
  DEFAULT_REGISTRY_ENTRY_LIMIT,
  NODE_PACK_REGISTRY_METADATA_TRUST_DISCOVERY,
  NODE_PACK_REGISTRY_METADATA_TRUST_OFFICIAL,
  NODE_PACK_REGISTRY_METADATA_TRUST_THIRD_PARTY,
  NODE_PACK_REGISTRY_OFFICIAL_REVIEW_MODEL,
  NODE_PACK_REGISTRY_CACHE_DIR,
  NODE_PACK_REGISTRY_CACHE_KIND,
  NODE_PACK_REGISTRY_CACHE_SCHEMA_VERSION,
  NODE_PACK_REGISTRY_KIND,
  SUPPORTED_NODE_PACK_REGISTRY_SCHEMA_VERSION,
  canonicalNodePackRegistrySignaturePayload,
  fetchNodePackRegistryUrl,
  findNodePackRegistryCandidates,
  latestRegistryVersion,
  loadNodePackRegistrySource,
  nodePackRegistryCacheKey,
  nodePackRegistryCachePath,
  nodePackRegistryCacheRoot,
  normalizeNodePackRegistryIndex,
  readNodePackRegistryCache,
  readNodePackRegistryFile,
  registrySourceKind,
  searchNodePackRegistryEntries,
  summarizeNodePackRegistry,
  summarizeNodePackRegistryEntry,
  verifyNodePackRegistrySignature,
  writeNodePackRegistryCache,
};
