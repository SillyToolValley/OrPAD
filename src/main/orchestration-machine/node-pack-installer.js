const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const {
  MACHINE_STORAGE_ID_PATTERN,
} = require('./ids');
const {
  ensureDir,
  readJsonIfExists,
  writeJsonAtomic,
} = require('./metadata-store');
const {
  auditDiscoveredNodePackDirectory,
  createNodePackLockEntry,
  declaredNodePackFilePaths,
  declaredNodeTypes,
  discoverNodePackManifests,
  validateNodePackManifest,
} = require('./node-packs');
const {
  latestRegistryVersion,
  loadNodePackRegistrySource,
} = require('./node-pack-registry');

const NODE_PACK_INSTALL_LOCK_KIND = 'orpad.nodePackInstallLock';
const NODE_PACK_INSTALL_LOCK_SCHEMA_VERSION = '1.0';
const NODE_PACK_INSTALL_LOCK_FILE = 'orpad-node-packs.lock.json';
const NODE_PACK_INSTALL_STAGING_DIR = 'node-pack-install-staging';
const NODE_PACK_INSTALL_BACKUP_DIR = 'node-pack-install-backups';
const DEFAULT_NODE_PACK_INSTALL_FILE_BYTE_LIMIT = 2 * 1024 * 1024;
const DEFAULT_NODE_PACK_INSTALL_TIMEOUT_MS = 10_000;

function diagnostic(level, code, message, details = {}) {
  return { level, code, message, ...details };
}

function errorDiagnostic(code, message, details = {}) {
  return diagnostic('error', code, message, details);
}

function warningDiagnostic(code, message, details = {}) {
  return diagnostic('warning', code, message, details);
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseStrictSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version || '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || '',
  };
}

function comparePrerelease(left = '', right = '') {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const length = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < length; i += 1) {
    const a = leftParts[i];
    const b = rightParts[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const delta = Number(a) - Number(b);
      if (delta) return delta > 0 ? 1 : -1;
      continue;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    const delta = a.localeCompare(b);
    if (delta) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function compareStrictSemverVersions(left, right) {
  const a = parseStrictSemver(left);
  const b = parseStrictSemver(right);
  if (!a || !b) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function normalizeSha256Hex(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function verifyExpectedSha256(buffer, expectedSha256, options = {}) {
  const expected = normalizeSha256Hex(expectedSha256);
  const actual = sha256Hex(buffer);
  if (!expectedSha256) {
    return {
      ok: true,
      checked: false,
      verified: false,
      sha256: actual,
      expectedSha256: '',
      diagnostics: [],
    };
  }
  if (!expected) {
    return {
      ok: false,
      checked: true,
      verified: false,
      sha256: actual,
      expectedSha256: String(expectedSha256 || ''),
      diagnostics: [
        errorDiagnostic(options.invalidCode || 'NODE_PACK_INSTALL_CHECKSUM_INVALID', 'Expected SHA-256 checksum must be a 64-character hex string.', {
          ...(options.details || {}),
          expectedSha256: String(expectedSha256 || ''),
        }),
      ],
    };
  }
  if (actual !== expected) {
    return {
      ok: false,
      checked: true,
      verified: false,
      sha256: actual,
      expectedSha256: expected,
      diagnostics: [
        errorDiagnostic(options.mismatchCode || 'NODE_PACK_INSTALL_CHECKSUM_MISMATCH', options.mismatchMessage || 'Fetched node pack file checksum does not match the registry checksum.', {
          ...(options.details || {}),
          expectedSha256: expected,
          actualSha256: actual,
        }),
      ],
    };
  }
  return {
    ok: true,
    checked: true,
    verified: true,
    sha256: actual,
    expectedSha256: expected,
    diagnostics: [],
  };
}

function normalizePackRelativePath(value) {
  const portable = String(value || '').trim().replace(/\\/g, '/');
  if (!portable) return '';
  const segments = portable.split('/');
  const hasUnsafeSegment = segments.some(segment => (
    !segment
    || segment === '.'
    || segment === '..'
    || /^[a-zA-Z]:$/.test(segment)
  ));
  const normalized = portable.replace(/\/+/g, '/');
  if (
    portable.startsWith('/')
    || /^[a-zA-Z]:\//.test(portable)
    || hasUnsafeSegment
    || normalized.startsWith('../')
  ) {
    return null;
  }
  return normalized;
}

function safePathSegment(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 160) || 'node-pack';
}

function validatePackIdForInstall(packId) {
  const id = String(packId || '').trim();
  if (!id || !MACHINE_STORAGE_ID_PATTERN.test(id)) {
    return {
      ok: false,
      id,
      diagnostic: errorDiagnostic('NODE_PACK_INSTALL_ID_UNSAFE', 'Installed node pack ids must be safe storage ids.', {
        packId: id,
      }),
    };
  }
  return { ok: true, id };
}

function userNodePacksRoot(options = {}) {
  const root = options.userNodePacksRoot
    || (options.userDataDir ? path.join(options.userDataDir, 'nodes') : '');
  return root ? path.resolve(String(root)) : '';
}

function installMetadataRoot(options = {}) {
  if (options.userDataDir) return path.resolve(String(options.userDataDir));
  const root = userNodePacksRoot(options);
  return root ? path.dirname(root) : '';
}

function nodePackInstallLockPath(options = {}) {
  const root = userNodePacksRoot(options);
  return root ? path.join(root, NODE_PACK_INSTALL_LOCK_FILE) : '';
}

function pathInsideRoot(root, relativePath) {
  const normalized = normalizePackRelativePath(relativePath);
  if (!normalized) {
    return {
      ok: false,
      normalized: '',
      path: '',
      diagnostic: errorDiagnostic('NODE_PACK_INSTALL_PATH_UNSAFE', 'Node pack install paths must be pack-relative portable paths.', {
        path: relativePath,
      }),
    };
  }
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(rootPath, ...normalized.split('/'));
  if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
    return {
      ok: false,
      normalized,
      path: targetPath,
      diagnostic: errorDiagnostic('NODE_PACK_INSTALL_PATH_ESCAPE', 'Node pack install path escaped the expected root.', {
        path: relativePath,
      }),
    };
  }
  return { ok: true, normalized, path: targetPath };
}

async function readJsonObjectFile(filePath, codeBase, label) {
  let text = '';
  let parsed;
  try {
    text = await fs.readFile(filePath, 'utf-8');
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      value: null,
      buffer: null,
      diagnostics: [
        errorDiagnostic(`${codeBase}_READ_FAILED`, `${label} could not be read as JSON.`, {
          path: filePath,
          error: err.message,
        }),
      ],
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      value: null,
      buffer: Buffer.from(text, 'utf-8'),
      diagnostics: [
        errorDiagnostic(`${codeBase}_INVALID`, `${label} must be a JSON object.`, {
          path: filePath,
        }),
      ],
    };
  }
  return { ok: true, value: parsed, buffer: Buffer.from(text, 'utf-8'), diagnostics: [] };
}

function installFailure(action, diagnostics, extra = {}) {
  return {
    success: false,
    ok: false,
    action,
    diagnostics,
    ...extra,
  };
}

function installSuccess(action, diagnostics, extra = {}) {
  return {
    success: true,
    ok: true,
    action,
    diagnostics,
    ...extra,
  };
}

function capabilitiesForPack(pack, options = {}) {
  const packId = String(pack?.id || '').trim();
  const byPack = options.grantedCapabilitiesByPack
    || options.nodePackGrantedCapabilitiesByPack
    || options.nodePackCapabilityGrants
    || {};
  if (packId && Object.prototype.hasOwnProperty.call(byPack, packId)) return byPack[packId];
  if (Object.prototype.hasOwnProperty.call(options, 'grantedCapabilities')) return options.grantedCapabilities;
  return [];
}

function hasExplicitCapabilityGrantInput(pack, options = {}) {
  const packId = String(pack?.id || '').trim();
  const byPack = options.grantedCapabilitiesByPack
    || options.nodePackGrantedCapabilitiesByPack
    || options.nodePackCapabilityGrants
    || {};
  return Boolean(
    (packId && Object.prototype.hasOwnProperty.call(byPack, packId))
    || Object.prototype.hasOwnProperty.call(options, 'grantedCapabilities')
  );
}

function validateInstallPack(pack, directoryAuditDiagnostics, options = {}) {
  return validateNodePackManifest(pack, {
    currentOrpadVersion: options.currentOrpadVersion,
    installMode: options.installMode || 'normal',
    grantedCapabilities: capabilitiesForPack(pack, options),
    explicitCapabilityGrants: hasExplicitCapabilityGrantInput(pack, options),
    directoryAuditDiagnostics,
    trustEvidence: options.trustEvidence,
    trustEvidenceByPack: options.trustEvidenceByPack || options.nodePackTrustEvidenceByPack || options.nodePackTrustEvidence,
    highRiskCapabilityReview: options.highRiskCapabilityReview || options.nodePackCapabilityReview || options.capabilityReview,
    highRiskCapabilityReviewByPack: options.highRiskCapabilityReviewByPack
      || options.nodePackCapabilityReviewByPack
      || options.nodePackCapabilityReviews
      || options.capabilityReviewByPack
      || options.securityReviewByPack,
  });
}

function sourceAuditDiagnostics(pack, packDir, options = {}) {
  return auditDiscoveredNodePackDirectory(pack, {
    rootKind: 'user',
    packDir,
    manifestPath: path.join(packDir, 'orpad.node-pack.json'),
  }, {
    installMode: options.installMode || 'normal',
  });
}

function declaredFileList(pack) {
  return [...declaredNodePackFilePaths(pack)].sort((left, right) => left.localeCompare(right));
}

function versionChecksums(versionInfo = {}) {
  return isPlainObject(versionInfo.checksums) ? versionInfo.checksums : {};
}

function versionFileChecksums(versionInfo = {}) {
  const checksums = versionChecksums(versionInfo);
  return isPlainObject(checksums.files) ? checksums.files : {};
}

function expectedChecksumForDeclaredFile(versionInfo, relativePath) {
  const normalized = normalizePackRelativePath(relativePath);
  if (!normalized) return '';
  const checksums = versionChecksums(versionInfo);
  if (normalized === 'orpad.node-pack.json') return checksums.manifestSha256 || '';
  const fileChecksums = versionFileChecksums(versionInfo);
  return fileChecksums[normalized] || checksums[normalized] || '';
}

function mergePackTrustEvidence(baseEvidence = {}, registryEvidence = {}) {
  const base = isPlainObject(baseEvidence) ? baseEvidence : {};
  const next = { ...base, ...registryEvidence };
  for (const key of ['signature', 'checksum', 'review', 'capabilityReview']) {
    if (isPlainObject(base[key]) || isPlainObject(registryEvidence[key])) {
      next[key] = {
        ...(isPlainObject(base[key]) ? base[key] : {}),
        ...(isPlainObject(registryEvidence[key]) ? registryEvidence[key] : {}),
      };
    }
  }
  return next;
}

function optionsWithRegistryTrustEvidence(options = {}, pack = {}, registryEvidence = {}) {
  if (!isPlainObject(registryEvidence) || !Object.keys(registryEvidence).length) return options;
  const packId = String(pack?.id || '').trim();
  if (!packId) return options;
  const baseByPack = options.trustEvidenceByPack
    || options.nodePackTrustEvidenceByPack
    || options.nodePackTrustEvidence
    || {};
  const nextByPack = {
    ...(isPlainObject(baseByPack) ? baseByPack : {}),
    [packId]: mergePackTrustEvidence(isPlainObject(baseByPack?.[packId]) ? baseByPack[packId] : {}, registryEvidence),
  };
  return {
    ...options,
    trustEvidenceByPack: nextByPack,
  };
}

function approvedRegistryReview(versionInfo = {}) {
  const review = isPlainObject(versionInfo.review) ? versionInfo.review : null;
  const status = String(review?.status || '').trim().toLowerCase();
  return status === 'approved' ? review : null;
}

function registryTrustEvidenceForPack(pack, registry, versionInfo, checksumState = {}) {
  if (registry?.signature?.verified !== true) return {};
  const registrySource = registry?.registryId ? `registry:${registry.registryId}` : 'registry';
  const evidence = {};
  if (versionInfo?.signature?.value) {
    evidence.signature = {
      verified: true,
      scheme: versionInfo.signature.scheme || 'ed25519',
      keyId: versionInfo.signature.keyId || registry?.signature?.keyId || '',
      fingerprint: versionInfo.signature.fingerprint || registry?.signature?.fingerprint || '',
      source: registrySource,
    };
  }
  if (
    checksumState?.manifest?.verified === true
    && checksumState.declaredFilesVerified === true
    && checksumState.declaredFileChecksumsComplete === true
  ) {
    evidence.checksum = {
      verified: true,
      manifestSha256: checksumState.manifest.sha256 || '',
      filesVerified: Object.keys(checksumState.files || {}).sort(),
      source: registrySource,
    };
  }
  const review = approvedRegistryReview(versionInfo);
  if (review) {
    const approvedCapabilities = Array.isArray(review.approvedCapabilities)
      ? review.approvedCapabilities.map(item => String(item || '').trim()).filter(Boolean)
      : [];
    evidence.review = {
      status: 'approved',
      reviewedAt: review.reviewedAt || '',
      reviewId: review.reviewId || review.decisionId || '',
      approvedCapabilities,
      source: registrySource,
    };
    evidence.capabilityReview = {
      status: 'approved',
      reviewedAt: review.reviewedAt || '',
      reviewId: review.reviewId || review.decisionId || '',
      approvedCapabilities,
      source: registrySource,
    };
  }
  return evidence;
}

async function createInstallStagingRoot(options = {}) {
  const metadataRoot = installMetadataRoot(options);
  if (!metadataRoot) {
    return {
      ok: false,
      stagingRoot: '',
      diagnostics: [
        errorDiagnostic('NODE_PACK_INSTALL_USER_ROOT_MISSING', 'Node pack install requires --user-data or --user-node-packs.'),
      ],
    };
  }
  const stamp = `${Date.now()}.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  const stagingRoot = path.join(metadataRoot, NODE_PACK_INSTALL_STAGING_DIR, stamp);
  await ensureDir(stagingRoot);
  return { ok: true, stagingRoot, diagnostics: [] };
}

async function cleanupPath(targetPath) {
  if (!targetPath) return;
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function copyDeclaredLocalFiles(sourceDir, stagingPackDir, pack) {
  const diagnostics = [];
  const sourceRoot = path.resolve(sourceDir);
  const declaredPaths = declaredFileList(pack);
  for (const relativePath of declaredPaths) {
    const sourceTarget = pathInsideRoot(sourceRoot, relativePath);
    const destinationTarget = pathInsideRoot(stagingPackDir, relativePath);
    if (!sourceTarget.ok || !destinationTarget.ok) {
      diagnostics.push(sourceTarget.diagnostic || destinationTarget.diagnostic);
      continue;
    }

    let stat;
    try {
      stat = await fs.lstat(sourceTarget.path);
    } catch (err) {
      diagnostics.push(errorDiagnostic('NODE_PACK_INSTALL_DECLARED_FILE_MISSING', 'Declared node pack file is missing from the source pack.', {
        filePath: relativePath,
        sourcePath: sourceTarget.path,
        error: err.message,
      }));
      continue;
    }
    if (stat.isSymbolicLink()) {
      diagnostics.push(errorDiagnostic('NODE_PACK_INSTALL_DECLARED_FILE_SYMLINK', 'Declared node pack files cannot be symlinks during normal install.', {
        filePath: relativePath,
        sourcePath: sourceTarget.path,
      }));
      continue;
    }
    if (!stat.isFile()) {
      diagnostics.push(errorDiagnostic('NODE_PACK_INSTALL_DECLARED_FILE_NOT_FILE', 'Declared node pack path must resolve to a file.', {
        filePath: relativePath,
        sourcePath: sourceTarget.path,
      }));
      continue;
    }
    await ensureDir(path.dirname(destinationTarget.path));
    await fs.copyFile(sourceTarget.path, destinationTarget.path);
  }
  return diagnostics;
}

async function fetchUrlBytes(urlText, options = {}) {
  let url;
  try {
    url = new URL(String(urlText || ''));
  } catch {
    return {
      ok: false,
      buffer: Buffer.alloc(0),
      diagnostics: [
        errorDiagnostic('NODE_PACK_INSTALL_FETCH_URL_INVALID', 'Node pack install URL is invalid.', {
          url: urlText,
        }),
      ],
    };
  }
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      buffer: Buffer.alloc(0),
      diagnostics: [
        errorDiagnostic('NODE_PACK_INSTALL_FETCH_URL_UNSAFE', 'Node pack install URL must use https.', {
          url: urlText,
        }),
      ],
    };
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      buffer: Buffer.alloc(0),
      diagnostics: [
        errorDiagnostic('NODE_PACK_INSTALL_FETCH_UNAVAILABLE', 'Node pack install URL fetch is unavailable in this runtime.', {
          url: urlText,
        }),
      ],
    };
  }

  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, options.timeoutMs)
    : DEFAULT_NODE_PACK_INSTALL_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url.href, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain;q=0.8, application/octet-stream;q=0.5, */*;q=0.1',
      },
    });
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      buffer: Buffer.alloc(0),
      diagnostics: [
        errorDiagnostic(err?.name === 'AbortError' ? 'NODE_PACK_INSTALL_FETCH_TIMEOUT' : 'NODE_PACK_INSTALL_FETCH_FAILED', 'Node pack install URL could not be fetched.', {
          url: url.href,
          error: err.message,
        }),
      ],
    };
  }
  clearTimeout(timer);

  if (!response || response.ok !== true) {
    return {
      ok: false,
      buffer: Buffer.alloc(0),
      diagnostics: [
        errorDiagnostic('NODE_PACK_INSTALL_FETCH_STATUS', 'Node pack install URL returned a non-success status.', {
          url: url.href,
          status: response?.status || 0,
        }),
      ],
    };
  }

  let arrayBuffer;
  try {
    arrayBuffer = await response.arrayBuffer();
  } catch (err) {
    return {
      ok: false,
      buffer: Buffer.alloc(0),
      diagnostics: [
        errorDiagnostic('NODE_PACK_INSTALL_FETCH_BODY_FAILED', 'Node pack install response body could not be read.', {
          url: url.href,
          error: err.message,
        }),
      ],
    };
  }

  const buffer = Buffer.from(arrayBuffer);
  const byteLimit = Number.isFinite(options.byteLimit)
    ? Math.max(0, options.byteLimit)
    : DEFAULT_NODE_PACK_INSTALL_FILE_BYTE_LIMIT;
  if (buffer.byteLength > byteLimit) {
    return {
      ok: false,
      buffer: Buffer.alloc(0),
      diagnostics: [
        errorDiagnostic('NODE_PACK_INSTALL_FETCH_TOO_LARGE', 'Node pack install response exceeds the safe file read limit.', {
          url: url.href,
          size: buffer.byteLength,
          byteLimit,
        }),
      ],
    };
  }
  return { ok: true, buffer, diagnostics: [] };
}

function parseManifestBuffer(buffer, manifestUrl = '') {
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf-8'));
  } catch (err) {
    return {
      ok: false,
      manifest: null,
      diagnostics: [
        errorDiagnostic('NODE_PACK_INSTALL_MANIFEST_JSON_INVALID', 'Fetched node pack manifest must be valid JSON.', {
          manifestUrl,
          error: err.message,
        }),
      ],
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      manifest: null,
      diagnostics: [
        errorDiagnostic('NODE_PACK_INSTALL_MANIFEST_INVALID', 'Fetched node pack manifest must be a JSON object.', {
          manifestUrl,
        }),
      ],
    };
  }
  return { ok: true, manifest: parsed, diagnostics: [] };
}

function joinPortablePath(...parts) {
  return parts
    .map(part => String(part || '').trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/');
}

function encodePortableUrlPath(relativePath) {
  return String(relativePath || '')
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

function githubRawUrl(versionInfo, relativePath) {
  let sourceUrl;
  try {
    sourceUrl = new URL(versionInfo.sourceRepository);
  } catch {
    return '';
  }
  if (sourceUrl.hostname !== 'github.com') return '';
  const parts = sourceUrl.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return '';
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  const remotePath = joinPortablePath(versionInfo.sourceRoot, relativePath);
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodePortableUrlPath(versionInfo.sourceRef)}/${encodePortableUrlPath(remotePath)}`;
}

function registryVersionFileUrl(versionInfo, relativePath) {
  const remotePath = joinPortablePath(versionInfo.sourceRoot, relativePath);
  const manifestRemotePath = joinPortablePath(versionInfo.sourceRoot, versionInfo.manifestPath);
  try {
    const manifestUrl = new URL(versionInfo.manifestUrl);
    const suffixes = [
      `/${encodePortableUrlPath(manifestRemotePath)}`,
      `/${manifestRemotePath}`,
      `/${encodePortableUrlPath(versionInfo.manifestPath)}`,
      `/${versionInfo.manifestPath}`,
    ].filter(Boolean);
    const pathname = manifestUrl.pathname.replace(/\/+/g, '/');
    for (const suffix of suffixes) {
      if (!pathname.endsWith(suffix)) continue;
      const base = pathname.slice(0, -suffix.length);
      manifestUrl.pathname = `${base}/${encodePortableUrlPath(remotePath)}`;
      return manifestUrl.href;
    }
  } catch {
    return '';
  }
  return githubRawUrl(versionInfo, relativePath);
}

async function fetchDeclaredRegistryFiles(stagingPackDir, pack, versionInfo, options = {}) {
  const diagnostics = [];
  const checksumState = {
    manifest: options.manifestChecksumState || {
      checked: false,
      verified: false,
      sha256: '',
      expectedSha256: '',
    },
    files: {},
    declaredFileChecksumsComplete: true,
    declaredFilesVerified: true,
  };
  for (const relativePath of declaredFileList(pack)) {
    const destinationTarget = pathInsideRoot(stagingPackDir, relativePath);
    if (!destinationTarget.ok) {
      diagnostics.push(destinationTarget.diagnostic);
      continue;
    }
    let buffer;
    if (relativePath === 'orpad.node-pack.json') {
      buffer = options.manifestBuffer || Buffer.from(`${JSON.stringify(pack, null, 2)}\n`, 'utf-8');
    } else {
      const fileUrl = registryVersionFileUrl(versionInfo, relativePath);
      if (!fileUrl) {
        diagnostics.push(errorDiagnostic('NODE_PACK_INSTALL_REGISTRY_FILE_URL_UNRESOLVED', 'Declared registry node pack file URL could not be resolved.', {
          filePath: relativePath,
          manifestUrl: versionInfo.manifestUrl,
          sourceRepository: versionInfo.sourceRepository,
        }));
        continue;
      }
      const fetched = await fetchUrlBytes(fileUrl, options);
      diagnostics.push(...fetched.diagnostics);
      if (!fetched.ok) continue;
      buffer = fetched.buffer;
      const checksum = verifyExpectedSha256(buffer, expectedChecksumForDeclaredFile(versionInfo, relativePath), {
        invalidCode: 'NODE_PACK_INSTALL_DECLARED_FILE_CHECKSUM_INVALID',
        mismatchCode: 'NODE_PACK_INSTALL_DECLARED_FILE_CHECKSUM_MISMATCH',
        mismatchMessage: 'Declared registry node pack file checksum does not match the registry checksum.',
        details: {
          filePath: relativePath,
          url: fileUrl,
        },
      });
      diagnostics.push(...checksum.diagnostics);
      checksumState.files[relativePath] = {
        checked: checksum.checked,
        verified: checksum.verified,
        sha256: checksum.sha256,
        expectedSha256: checksum.expectedSha256,
      };
      if (!checksum.checked) checksumState.declaredFileChecksumsComplete = false;
      if (!checksum.ok) {
        checksumState.declaredFilesVerified = false;
        continue;
      }
    }
    await ensureDir(path.dirname(destinationTarget.path));
    await fs.writeFile(destinationTarget.path, buffer);
  }
  for (const relativePath of declaredFileList(pack)) {
    if (relativePath === 'orpad.node-pack.json') continue;
    if (!checksumState.files[relativePath]) {
      checksumState.files[relativePath] = {
        checked: false,
        verified: false,
        sha256: '',
        expectedSha256: '',
      };
      checksumState.declaredFileChecksumsComplete = false;
    }
  }
  return { diagnostics, checksumState };
}

function discoveryOptionsForUserRoot(userRoot, options = {}) {
  return {
    builtInNodePacksRoot: options.builtInNodePacksRoot,
    userNodePacksRoot: userRoot,
    currentOrpadVersion: options.currentOrpadVersion,
    installMode: options.installMode || 'normal',
    trustEvidenceByPack: options.trustEvidenceByPack || options.nodePackTrustEvidenceByPack || options.nodePackTrustEvidence,
    grantedCapabilitiesByPack: options.grantedCapabilitiesByPack || options.nodePackGrantedCapabilitiesByPack || options.nodePackCapabilityGrants,
    highRiskCapabilityReview: options.highRiskCapabilityReview || options.nodePackCapabilityReview || options.capabilityReview,
    highRiskCapabilityReviewByPack: options.highRiskCapabilityReviewByPack
      || options.nodePackCapabilityReviewByPack
      || options.nodePackCapabilityReviews
      || options.capabilityReviewByPack
      || options.securityReviewByPack,
  };
}

function discoveryOptionsForStagingRoot(stagingRoot, options = {}) {
  return {
    ...discoveryOptionsForUserRoot(stagingRoot, options),
    builtInNodePacksRoot: false,
  };
}

function findInstalledNodeTypeConflicts(candidatePack, options = {}) {
  const root = userNodePacksRoot(options);
  if (!root) return [];
  const candidateId = String(candidatePack?.id || '').trim();
  const candidateTypes = new Set(declaredNodeTypes(candidatePack));
  if (!candidateTypes.size) return [];
  const discovered = discoverNodePackManifests(discoveryOptionsForUserRoot(root, options));
  const conflicts = [];
  for (const pack of discovered.nodePacks || []) {
    const packId = String(pack?.id || '').trim();
    if (!packId || packId === candidateId) continue;
    for (const nodeType of declaredNodeTypes(pack)) {
      if (!candidateTypes.has(nodeType)) continue;
      conflicts.push({
        nodeType,
        installedPackId: packId,
        installingPackId: candidateId,
        installedManifestPath: pack.discovery?.manifestPath || '',
      });
    }
  }
  return conflicts;
}

function lockEntryForPack(pack, options = {}) {
  const validation = pack.validation && typeof pack.validation === 'object' ? pack.validation : {};
  const base = createNodePackLockEntry(pack, {
    source: options.source || pack.source || pack.origin || 'unknown',
    checksum: options.checksum || options.manifestSha256 || '',
    signature: options.signature || '',
  });
  return {
    ...base,
    enabled: pack.enabled !== false,
    sourceRepository: options.sourceRepository || '',
    sourceRef: options.sourceRef || '',
    manifestPath: options.manifestPath || 'orpad.node-pack.json',
    manifestSha256: options.manifestSha256 || options.checksum || '',
    trustLevel: pack.trustLevel || '',
    pinned: options.pinned === true || pack.pinned === true,
    installedAt: options.installedAt || new Date().toISOString(),
    installedBy: options.installedBy || 'orpad-cli',
    resolvedGraphExports: Array.isArray(pack.graphs)
      ? pack.graphs.map(graph => String(graph?.id || '').trim()).filter(Boolean).sort()
      : [],
    capabilities: Array.isArray(pack.capabilities) ? [...pack.capabilities] : [],
    resolutionState: pack.resolutionState || validation.resolutionState || '',
    validationStatus: pack.validationStatus || validation.status || '',
    diagnostics: Array.isArray(validation.diagnostics) ? validation.diagnostics : [],
  };
}

function emptyNodePackInstallLock(now = new Date().toISOString()) {
  return {
    kind: NODE_PACK_INSTALL_LOCK_KIND,
    schemaVersion: NODE_PACK_INSTALL_LOCK_SCHEMA_VERSION,
    updatedAt: now,
    packs: [],
  };
}

async function readNodePackInstallLock(options = {}) {
  const lockPath = nodePackInstallLockPath(options);
  if (!lockPath) {
    return {
      ok: false,
      lock: emptyNodePackInstallLock(),
      path: '',
      diagnostics: [
        errorDiagnostic('NODE_PACK_INSTALL_LOCK_ROOT_MISSING', 'Node pack install lock requires a user node pack root.'),
      ],
    };
  }
  let lock;
  try {
    lock = await readJsonIfExists(lockPath, null);
  } catch (err) {
    return {
      ok: false,
      lock: emptyNodePackInstallLock(),
      path: lockPath,
      diagnostics: [
        errorDiagnostic('NODE_PACK_INSTALL_LOCK_INVALID', 'Node pack install lock could not be read.', {
          path: lockPath,
          error: err.message,
        }),
      ],
    };
  }
  if (lock === null) {
    return {
      ok: true,
      lock: emptyNodePackInstallLock(),
      path: lockPath,
      diagnostics: [],
    };
  }
  if (
    !isPlainObject(lock)
    || lock.kind !== NODE_PACK_INSTALL_LOCK_KIND
    || lock.schemaVersion !== NODE_PACK_INSTALL_LOCK_SCHEMA_VERSION
    || !Array.isArray(lock.packs)
  ) {
    return {
      ok: false,
      lock: emptyNodePackInstallLock(),
      path: lockPath,
      diagnostics: [
        errorDiagnostic('NODE_PACK_INSTALL_LOCK_INVALID', 'Node pack install lock has an unsupported shape.', {
          path: lockPath,
        }),
      ],
    };
  }
  return {
    ok: true,
    lock: {
      ...lock,
      packs: lock.packs.filter(isPlainObject),
    },
    path: lockPath,
    diagnostics: [],
  };
}

async function writeNodePackInstallLock(lock, options = {}) {
  const lockPath = nodePackInstallLockPath(options);
  if (!lockPath) {
    return {
      ok: false,
      path: '',
      diagnostics: [
        errorDiagnostic('NODE_PACK_INSTALL_LOCK_ROOT_MISSING', 'Node pack install lock requires a user node pack root.'),
      ],
    };
  }
  const nextLock = {
    kind: NODE_PACK_INSTALL_LOCK_KIND,
    schemaVersion: NODE_PACK_INSTALL_LOCK_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    packs: (Array.isArray(lock?.packs) ? lock.packs : [])
      .filter(isPlainObject)
      .sort((left, right) => String(left.id || '').localeCompare(String(right.id || ''))),
  };
  await ensureDir(path.dirname(lockPath));
  await writeJsonAtomic(lockPath, nextLock);
  return { ok: true, path: lockPath, lock: nextLock, diagnostics: [] };
}

async function upsertNodePackInstallLockEntry(entry, options = {}) {
  const current = await readNodePackInstallLock(options);
  if (!current.ok) return current;
  const packs = (current.lock.packs || []).filter(item => item.id !== entry.id);
  packs.push(entry);
  return writeNodePackInstallLock({ ...current.lock, packs }, options);
}

async function removeNodePackInstallLockEntry(packId, options = {}) {
  const current = await readNodePackInstallLock(options);
  if (!current.ok) return current;
  const packs = (current.lock.packs || []).filter(item => item.id !== packId);
  return writeNodePackInstallLock({ ...current.lock, packs }, options);
}

async function moveActivePackToBackup(packId, options = {}) {
  const root = userNodePacksRoot(options);
  const targetPath = path.join(root, packId);
  let stat = null;
  try {
    stat = await fs.lstat(targetPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return { existed: false, targetPath, backupPath: '' };
    throw err;
  }
  if (!stat.isDirectory() && !stat.isSymbolicLink()) {
    throw new Error(`Installed node pack target is not a directory: ${targetPath}`);
  }
  const metadataRoot = installMetadataRoot(options);
  const backupRoot = path.join(metadataRoot, NODE_PACK_INSTALL_BACKUP_DIR);
  const backupPath = path.join(backupRoot, `${safePathSegment(packId)}.${Date.now()}.${process.pid}`);
  await ensureDir(backupRoot);
  await fs.rename(targetPath, backupPath);
  return { existed: true, targetPath, backupPath };
}

async function restoreBackup(backupInfo) {
  if (!backupInfo?.backupPath) return;
  await cleanupPath(backupInfo.targetPath);
  await fs.rename(backupInfo.backupPath, backupInfo.targetPath);
}

async function activateStagedNodePack(stagingPackDir, pack, lockEntry, options = {}) {
  const packId = String(pack.id || '').trim();
  const root = userNodePacksRoot(options);
  if (!root) {
    return {
      ok: false,
      diagnostics: [
        errorDiagnostic('NODE_PACK_INSTALL_USER_ROOT_MISSING', 'Node pack install requires --user-data or --user-node-packs.'),
      ],
    };
  }
  await ensureDir(root);
  const targetPath = path.join(root, packId);
  const currentLock = await readNodePackInstallLock(options);
  const previousEntry = currentLock.ok
    ? (currentLock.lock.packs || []).find(item => item.id === packId) || null
    : null;
  const backupInfo = await moveActivePackToBackup(packId, options);
  let activated = false;
  try {
    await fs.rename(stagingPackDir, targetPath);
    activated = true;
    const nextLockEntry = {
      ...lockEntry,
      ...(backupInfo.existed ? {
        previousInstall: {
          backupPath: backupInfo.backupPath || '',
          replacedAt: lockEntry.installedAt || new Date().toISOString(),
          previousEntry: previousEntry || null,
        },
      } : {}),
    };
    const lockWrite = await upsertNodePackInstallLockEntry(nextLockEntry, options);
    if (!lockWrite.ok) {
      throw new Error(lockWrite.diagnostics.map(item => item.message).join('; ') || 'Node pack install lock write failed.');
    }
    return {
      ok: true,
      installedPath: targetPath,
      backupPath: backupInfo.backupPath || '',
      lockPath: lockWrite.path,
      lockEntry: nextLockEntry,
      diagnostics: lockWrite.diagnostics || [],
    };
  } catch (err) {
    if (activated) await cleanupPath(targetPath);
    await restoreBackup(backupInfo);
    return {
      ok: false,
      installedPath: targetPath,
      backupPath: backupInfo.backupPath || '',
      diagnostics: [
        errorDiagnostic('NODE_PACK_INSTALL_ACTIVATION_FAILED', 'Node pack install activation failed and previous active pack was restored.', {
          packId,
          error: err.message,
        }),
      ],
    };
  }
}

function selectedStagedPack(discovery, packId) {
  return (discovery.nodePacks || []).find(pack => String(pack.id || '').trim() === packId) || null;
}

function validationFailureDiagnostics(pack, fallbackCode = 'NODE_PACK_INSTALL_VALIDATION_FAILED') {
  const validation = pack?.validation || {};
  return [
    errorDiagnostic(fallbackCode, 'Node pack install validation failed.', {
      packId: pack?.id || validation.packId || '',
      resolutionState: validation.resolutionState || pack?.resolutionState || '',
      validationStatus: validation.status || pack?.validationStatus || '',
    }),
    ...(Array.isArray(validation.diagnostics) ? validation.diagnostics : []),
  ];
}

function conflictDiagnostics(conflicts) {
  return conflicts.map(conflict => errorDiagnostic(
    'NODE_PACK_INSTALL_NODE_TYPE_CONFLICT',
    'Installed node pack already declares a node type from the candidate pack.',
    conflict,
  ));
}

async function prepareLocalNodePackStaging(sourceDir, options = {}) {
  const sourceRoot = path.resolve(String(sourceDir || ''));
  const manifestPath = path.join(sourceRoot, 'orpad.node-pack.json');
  const manifestRead = await readJsonObjectFile(manifestPath, 'NODE_PACK_INSTALL_MANIFEST', 'Node pack manifest');
  if (!manifestRead.ok) return { ok: false, diagnostics: manifestRead.diagnostics };

  const pack = manifestRead.value;
  const idCheck = validatePackIdForInstall(pack.id);
  if (!idCheck.ok) return { ok: false, diagnostics: [idCheck.diagnostic] };

  const auditDiagnostics = sourceAuditDiagnostics(pack, sourceRoot, options);
  const sourceValidation = validateInstallPack(pack, auditDiagnostics, options);
  if (!sourceValidation.ok) {
    return {
      ok: false,
      pack,
      validation: sourceValidation,
      diagnostics: [
        errorDiagnostic('NODE_PACK_INSTALL_SOURCE_VALIDATION_FAILED', 'Local node pack source failed safe install validation before staging.', {
          packId: pack.id || '',
          resolutionState: sourceValidation.resolutionState,
        }),
        ...sourceValidation.diagnostics,
      ],
    };
  }

  const staging = await createInstallStagingRoot(options);
  if (!staging.ok) return { ok: false, diagnostics: staging.diagnostics };
  const stagingPackDir = path.join(staging.stagingRoot, idCheck.id);
  await ensureDir(stagingPackDir);
  const copyDiagnostics = await copyDeclaredLocalFiles(sourceRoot, stagingPackDir, pack);
  if (copyDiagnostics.some(item => item.level === 'error')) {
    await cleanupPath(staging.stagingRoot);
    return {
      ok: false,
      pack,
      validation: sourceValidation,
      stagingRoot: staging.stagingRoot,
      diagnostics: copyDiagnostics,
    };
  }
  return {
    ok: true,
    pack,
    validation: sourceValidation,
    stagingRoot: staging.stagingRoot,
    stagingPackDir,
    diagnostics: copyDiagnostics,
    manifestSha256: sha256Hex(manifestRead.buffer || Buffer.from(`${JSON.stringify(pack, null, 2)}\n`, 'utf-8')),
  };
}

async function finalizePreparedInstall(prepared, sourceInfo, options = {}) {
  const diagnostics = [...(prepared.diagnostics || [])];
  const packId = String(prepared.pack?.id || '').trim();
  const validationOptions = prepared.validationOptions || options;
  const stagedDiscovery = discoverNodePackManifests(discoveryOptionsForStagingRoot(prepared.stagingRoot, validationOptions));
  diagnostics.push(...(stagedDiscovery.diagnostics || []));
  const stagedPack = selectedStagedPack(stagedDiscovery, packId);
  if (!stagedPack) {
    await cleanupPath(prepared.stagingRoot);
    return installFailure(sourceInfo.action, [
      ...diagnostics,
      errorDiagnostic('NODE_PACK_INSTALL_STAGED_PACK_MISSING', 'Staged node pack could not be discovered before activation.', {
        packId,
      }),
    ]);
  }
  if (stagedPack.validation?.ok !== true) {
    await cleanupPath(prepared.stagingRoot);
    return installFailure(sourceInfo.action, [
      ...diagnostics,
      ...validationFailureDiagnostics(stagedPack),
    ], {
      nodePack: stagedPack,
    });
  }

  const conflicts = findInstalledNodeTypeConflicts(stagedPack, validationOptions);
  if (conflicts.length) {
    await cleanupPath(prepared.stagingRoot);
    return installFailure(sourceInfo.action, [
      ...diagnostics,
      ...conflictDiagnostics(conflicts),
    ], {
      nodePack: stagedPack,
    });
  }

  const lockEntry = lockEntryForPack(stagedPack, {
    ...sourceInfo,
    manifestSha256: sourceInfo.manifestSha256 || prepared.manifestSha256 || '',
  });
  const activation = await activateStagedNodePack(prepared.stagingPackDir, stagedPack, lockEntry, options);
  await cleanupPath(prepared.stagingRoot);
  if (!activation.ok) {
    return installFailure(sourceInfo.action, [
      ...diagnostics,
      ...(activation.diagnostics || []),
    ], {
      nodePack: stagedPack,
      installedPath: activation.installedPath || '',
      backupPath: activation.backupPath || '',
    });
  }

  const activeDiscovery = discoverNodePackManifests(discoveryOptionsForUserRoot(userNodePacksRoot(options), validationOptions));
  const activePack = selectedStagedPack(activeDiscovery, packId) || stagedPack;
  return installSuccess(sourceInfo.action, [
    ...diagnostics,
    ...(activation.diagnostics || []),
  ], {
    nodePack: activePack,
    installedPath: activation.installedPath,
    backupPath: activation.backupPath,
    lockPath: activation.lockPath,
    lockEntry: activation.lockEntry,
    discovery: activeDiscovery,
  });
}

async function installLocalNodePack(sourceDir, options = {}) {
  const root = userNodePacksRoot(options);
  if (!root) {
    return installFailure('install-local', [
      errorDiagnostic('NODE_PACK_INSTALL_USER_ROOT_MISSING', 'Node pack install requires --user-data or --user-node-packs.'),
    ]);
  }
  const prepared = await prepareLocalNodePackStaging(sourceDir, options);
  if (!prepared.ok) {
    return installFailure('install-local', prepared.diagnostics || [], {
      nodePack: prepared.pack || null,
      validation: prepared.validation || null,
    });
  }
  return finalizePreparedInstall(prepared, {
    action: 'install-local',
    source: 'local',
    sourceRepository: '',
    sourceRef: '',
    manifestPath: 'orpad.node-pack.json',
    installedBy: options.installedBy || 'orpad-cli',
  }, options);
}

function findRegistryEntryVersion(registry, packId, version = '') {
  const entry = (registry.entries || []).find(item => item.id === packId) || null;
  if (!entry) return { entry: null, versionInfo: null };
  if (version) {
    return {
      entry,
      versionInfo: (entry.versions || []).find(item => item.version === version) || null,
    };
  }
  return { entry, versionInfo: latestRegistryVersion(entry) };
}

async function prepareRegistryNodePackStaging(versionInfo, expectedPackId, options = {}) {
  const manifestFetch = await fetchUrlBytes(versionInfo.manifestUrl, options);
  if (!manifestFetch.ok) return { ok: false, diagnostics: manifestFetch.diagnostics };
  const manifestChecksum = verifyExpectedSha256(manifestFetch.buffer, versionChecksums(versionInfo).manifestSha256, {
    invalidCode: 'NODE_PACK_INSTALL_MANIFEST_CHECKSUM_INVALID',
    mismatchCode: 'NODE_PACK_INSTALL_MANIFEST_CHECKSUM_MISMATCH',
    mismatchMessage: 'Registry node pack manifest checksum does not match the registry checksum.',
    details: {
      manifestUrl: versionInfo.manifestUrl,
      filePath: 'orpad.node-pack.json',
    },
  });
  if (!manifestChecksum.ok) return { ok: false, diagnostics: manifestChecksum.diagnostics };
  const manifestParse = parseManifestBuffer(manifestFetch.buffer, versionInfo.manifestUrl);
  if (!manifestParse.ok) return { ok: false, diagnostics: manifestParse.diagnostics };
  const pack = manifestParse.manifest;
  if (String(pack.id || '').trim() !== expectedPackId) {
    return {
      ok: false,
      pack,
      diagnostics: [
        errorDiagnostic('NODE_PACK_INSTALL_REGISTRY_MANIFEST_ID_MISMATCH', 'Registry manifest id does not match the requested node pack.', {
          expectedPackId,
          actualPackId: pack.id || '',
          manifestUrl: versionInfo.manifestUrl,
        }),
      ],
    };
  }
  const idCheck = validatePackIdForInstall(pack.id);
  if (!idCheck.ok) return { ok: false, diagnostics: [idCheck.diagnostic] };

  const preliminaryChecksumState = {
    manifest: manifestChecksum,
    files: {},
    declaredFileChecksumsComplete: true,
    declaredFilesVerified: true,
  };
  const preliminaryOptions = optionsWithRegistryTrustEvidence(
    options,
    pack,
    registryTrustEvidenceForPack(pack, options.registry, versionInfo, preliminaryChecksumState),
  );
  const manifestValidation = validateInstallPack(pack, [], preliminaryOptions);
  if (!manifestValidation.ok) {
    return {
      ok: false,
      pack,
      validation: manifestValidation,
      diagnostics: [
        errorDiagnostic('NODE_PACK_INSTALL_REGISTRY_MANIFEST_VALIDATION_FAILED', 'Registry node pack manifest failed safe install validation before staging.', {
          packId: pack.id || '',
          resolutionState: manifestValidation.resolutionState,
        }),
        ...manifestValidation.diagnostics,
      ],
    };
  }

  const staging = await createInstallStagingRoot(options);
  if (!staging.ok) return { ok: false, diagnostics: staging.diagnostics };
  const stagingPackDir = path.join(staging.stagingRoot, idCheck.id);
  await ensureDir(stagingPackDir);
  const fetchResult = await fetchDeclaredRegistryFiles(stagingPackDir, pack, versionInfo, {
    ...options,
    manifestBuffer: manifestFetch.buffer,
    manifestChecksumState: manifestChecksum,
  });
  const fetchDiagnostics = fetchResult.diagnostics || [];
  if (fetchDiagnostics.some(item => item.level === 'error')) {
    await cleanupPath(staging.stagingRoot);
    return {
      ok: false,
      pack,
      validation: manifestValidation,
      stagingRoot: staging.stagingRoot,
      diagnostics: fetchDiagnostics,
    };
  }
  const validationOptions = optionsWithRegistryTrustEvidence(
    options,
    pack,
    registryTrustEvidenceForPack(pack, options.registry, versionInfo, fetchResult.checksumState || preliminaryChecksumState),
  );
  return {
    ok: true,
    pack,
    validation: manifestValidation,
    stagingRoot: staging.stagingRoot,
    stagingPackDir,
    diagnostics: fetchDiagnostics,
    manifestSha256: sha256Hex(manifestFetch.buffer),
    checksumState: fetchResult.checksumState || preliminaryChecksumState,
    validationOptions,
  };
}

async function installRegistryNodePack(request = {}, options = {}) {
  const registrySource = request.registry || options.registry || '';
  const packId = String(request.packId || request.id || '').trim();
  const requestedVersion = String(request.version || '').trim();
  const idCheck = validatePackIdForInstall(packId);
  if (!idCheck.ok) return installFailure('install', [idCheck.diagnostic]);
  if (!registrySource) {
    return installFailure('install', [
      errorDiagnostic('NODE_PACK_INSTALL_REGISTRY_MISSING', 'Registry node pack install requires a registry source.'),
    ]);
  }
  if (!userNodePacksRoot(options)) {
    return installFailure('install', [
      errorDiagnostic('NODE_PACK_INSTALL_USER_ROOT_MISSING', 'Node pack install requires --user-data or --user-node-packs.'),
    ]);
  }

  const registryResult = await loadNodePackRegistrySource(registrySource, options);
  if (!registryResult.ok) {
    return installFailure('install', registryResult.diagnostics || [], {
      registry: registryResult.registry || null,
    });
  }
  const { entry, versionInfo } = findRegistryEntryVersion(registryResult.registry, idCheck.id, requestedVersion);
  if (!entry) {
    return installFailure('install', [
      errorDiagnostic('NODE_PACK_INSTALL_REGISTRY_ENTRY_MISSING', 'Registry does not contain the requested node pack.', {
        packId: idCheck.id,
        registry: registryResult.registry.registryId,
      }),
    ], {
      registry: registryResult.registry,
    });
  }
  if (!versionInfo) {
    return installFailure('install', [
      errorDiagnostic('NODE_PACK_INSTALL_REGISTRY_VERSION_MISSING', 'Registry node pack version was not found.', {
        packId: idCheck.id,
        version: requestedVersion || entry.latestVersion || '',
      }),
    ], {
      registry: registryResult.registry,
      entry,
    });
  }

  const prepared = await prepareRegistryNodePackStaging(versionInfo, idCheck.id, {
    ...options,
    registry: registryResult.registry,
    registryEntry: entry,
  });
  if (!prepared.ok) {
    return installFailure('install', prepared.diagnostics || [], {
      registry: registryResult.registry,
      entry,
      version: versionInfo,
      nodePack: prepared.pack || null,
      validation: prepared.validation || null,
    });
  }
  return finalizePreparedInstall(prepared, {
    action: 'install',
    source: `registry:${registryResult.registry.registryId}`,
    sourceRepository: versionInfo.sourceRepository || '',
    sourceRef: versionInfo.sourceRef || '',
    manifestPath: versionInfo.manifestPath || 'orpad.node-pack.json',
    manifestSha256: versionChecksums(versionInfo).manifestSha256 || prepared.manifestSha256 || '',
    signature: versionInfo.signature?.value || '',
    installedBy: options.installedBy || 'orpad-cli',
    pinned: request.pinned === true || options.pinned === true,
  }, options);
}

function registryIdFromLockSource(source) {
  const text = String(source || '').trim();
  return text.startsWith('registry:') ? text.slice('registry:'.length) : '';
}

function updateCandidateForEntry(installed, registryEntry, options = {}) {
  const latest = latestRegistryVersion(registryEntry);
  const installedVersion = String(installed.version || '').trim();
  const latestVersion = String(latest?.version || registryEntry?.latestVersion || '').trim();
  const pinned = installed.pinned === true;
  const base = {
    id: installed.id || registryEntry?.id || '',
    installedVersion,
    latestVersion,
    pinned,
    source: installed.source || '',
    sourceRepository: latest?.sourceRepository || installed.sourceRepository || '',
    sourceRef: latest?.sourceRef || '',
    manifestPath: latest?.manifestPath || '',
    updateAvailable: false,
    skipped: false,
    reason: '',
  };
  if (!latest) {
    return {
      ...base,
      skipped: true,
      reason: 'registry-version-missing',
    };
  }
  const comparison = compareStrictSemverVersions(latestVersion, installedVersion);
  if (comparison === null) {
    return {
      ...base,
      skipped: true,
      reason: 'version-not-strict-semver',
    };
  }
  if (comparison <= 0) return base;
  if (pinned && options.includePinned !== true) {
    return {
      ...base,
      updateAvailable: true,
      skipped: true,
      reason: 'pinned',
    };
  }
  return {
    ...base,
    updateAvailable: true,
  };
}

async function listNodePackUpdateCandidates(request = {}, options = {}) {
  const registrySource = request.registry || options.registry || '';
  if (!registrySource) {
    return installFailure('update-candidates', [
      errorDiagnostic('NODE_PACK_UPDATE_REGISTRY_MISSING', 'Node pack update requires a registry source.'),
    ]);
  }
  const current = await readNodePackInstallLock(options);
  if (!current.ok) {
    return installFailure('update-candidates', current.diagnostics || [], {
      lockPath: current.path || '',
    });
  }
  const registryResult = await loadNodePackRegistrySource(registrySource, options);
  if (!registryResult.ok) {
    return installFailure('update-candidates', registryResult.diagnostics || [], {
      lockPath: current.path || '',
      registry: registryResult.registry || null,
    });
  }
  const packId = String(request.packId || request.id || '').trim();
  const diagnostics = [];
  const candidates = [];
  const entriesById = new Map((registryResult.registry.entries || []).map(entry => [entry.id, entry]));
  for (const installed of current.lock.packs || []) {
    if (packId && installed.id !== packId) continue;
    const installedRegistryId = registryIdFromLockSource(installed.source);
    if (installedRegistryId && installedRegistryId !== registryResult.registry.registryId) {
      diagnostics.push(warningDiagnostic('NODE_PACK_UPDATE_REGISTRY_SOURCE_MISMATCH', 'Installed node pack came from a different registry id.', {
        packId: installed.id,
        installedSource: installed.source || '',
        requestedRegistryId: registryResult.registry.registryId,
      }));
      continue;
    }
    const entry = entriesById.get(installed.id);
    if (!entry) {
      diagnostics.push(warningDiagnostic('NODE_PACK_UPDATE_REGISTRY_ENTRY_MISSING', 'Installed node pack is not present in the registry.', {
        packId: installed.id,
        registryId: registryResult.registry.registryId,
      }));
      continue;
    }
    candidates.push(updateCandidateForEntry(installed, entry, {
      includePinned: request.includePinned === true || options.includePinned === true,
    }));
  }
  if (packId && !(current.lock.packs || []).some(item => item.id === packId)) {
    diagnostics.push(errorDiagnostic('NODE_PACK_UPDATE_INSTALLED_PACK_MISSING', 'Installed node pack was not found in the install lock.', {
      packId,
    }));
  }
  return installSuccess('update-candidates', [
    ...(registryResult.diagnostics || []),
    ...diagnostics,
  ], {
    lockPath: current.path || '',
    registry: registryResult.registry,
    candidates,
  });
}

async function updateInstalledNodePacks(request = {}, options = {}) {
  const candidatesResult = await listNodePackUpdateCandidates(request, {
    ...options,
    includePinned: request.includePinned === true || options.includePinned === true,
  });
  if (!candidatesResult.ok) return candidatesResult;
  const updateCandidates = (candidatesResult.candidates || [])
    .filter(candidate => candidate.updateAvailable && !candidate.skipped);
  if (!updateCandidates.length) {
    return installSuccess('update', candidatesResult.diagnostics || [], {
      registry: candidatesResult.registry || null,
      candidates: candidatesResult.candidates || [],
      results: [],
    });
  }
  const results = [];
  const diagnostics = [...(candidatesResult.diagnostics || [])];
  for (const candidate of updateCandidates) {
    const result = await installRegistryNodePack({
      registry: request.registry || options.registry || '',
      packId: candidate.id,
      version: candidate.latestVersion,
      pinned: candidate.pinned,
    }, {
      ...options,
      registry: request.registry || options.registry || '',
      pinned: candidate.pinned,
    });
    results.push(result);
    diagnostics.push(...(result.diagnostics || []));
  }
  const failed = results.filter(result => result.success === false);
  return {
    success: failed.length === 0,
    ok: failed.length === 0,
    action: 'update',
    diagnostics,
    registry: candidatesResult.registry || null,
    candidates: candidatesResult.candidates || [],
    results,
    nodePack: results.length === 1 ? results[0].nodePack || null : null,
  };
}

async function exportInstalledNodePackList(options = {}) {
  const current = await readNodePackInstallLock(options);
  if (!current.ok) {
    return installFailure('export-list', current.diagnostics || [], {
      lockPath: current.path || '',
      packs: [],
    });
  }
  const root = userNodePacksRoot(options);
  const discovery = root
    ? discoverNodePackManifests(discoveryOptionsForUserRoot(root, {
      ...options,
      builtInNodePacksRoot: false,
    }))
    : { ok: true, nodePacks: [], diagnostics: [], conflicts: [] };
  return installSuccess('export-list', [
    ...(current.diagnostics || []),
    ...(discovery.diagnostics || []),
  ], {
    lockPath: current.path || '',
    packs: current.lock.packs || [],
    discovery: {
      ok: discovery.ok,
      diagnostics: discovery.diagnostics || [],
      conflicts: discovery.conflicts || [],
      nodePackIds: (discovery.nodePacks || []).map(pack => pack.id).filter(Boolean).sort(),
    },
  });
}

async function rollbackInstalledNodePack(packId, options = {}) {
  const idCheck = validatePackIdForInstall(packId);
  if (!idCheck.ok) return installFailure('rollback', [idCheck.diagnostic]);
  const root = userNodePacksRoot(options);
  if (!root) {
    return installFailure('rollback', [
      errorDiagnostic('NODE_PACK_INSTALL_USER_ROOT_MISSING', 'Node pack install requires --user-data or --user-node-packs.'),
    ]);
  }
  const current = await readNodePackInstallLock(options);
  if (!current.ok) return installFailure('rollback', current.diagnostics || []);
  const entry = (current.lock.packs || []).find(item => item.id === idCheck.id) || null;
  const previousInstall = entry?.previousInstall && isPlainObject(entry.previousInstall)
    ? entry.previousInstall
    : null;
  const previousBackupPath = previousInstall?.backupPath || '';
  if (!entry || !previousBackupPath) {
    return installFailure('rollback', [
      errorDiagnostic('NODE_PACK_ROLLBACK_UNAVAILABLE', 'Installed node pack does not have rollback metadata.', {
        packId: idCheck.id,
      }),
    ]);
  }
  try {
    const backupStat = await fs.lstat(previousBackupPath);
    if (!backupStat.isDirectory() && !backupStat.isSymbolicLink()) {
      return installFailure('rollback', [
        errorDiagnostic('NODE_PACK_ROLLBACK_BACKUP_INVALID', 'Rollback backup path is not a directory.', {
          packId: idCheck.id,
          backupPath: previousBackupPath,
        }),
      ]);
    }
  } catch (err) {
    return installFailure('rollback', [
      errorDiagnostic('NODE_PACK_ROLLBACK_BACKUP_MISSING', 'Rollback backup path could not be found.', {
        packId: idCheck.id,
        backupPath: previousBackupPath,
        error: err.message,
      }),
    ]);
  }

  const targetPath = path.join(root, idCheck.id);
  const currentBackup = await moveActivePackToBackup(idCheck.id, options);
  let restored = false;
  try {
    await fs.rename(previousBackupPath, targetPath);
    restored = true;
    const discovery = discoverNodePackManifests(discoveryOptionsForUserRoot(root, options));
    const restoredPack = selectedStagedPack(discovery, idCheck.id);
    const restoredEntry = isPlainObject(previousInstall.previousEntry)
      ? {
        ...previousInstall.previousEntry,
        previousInstall: {
          backupPath: currentBackup.backupPath || '',
          replacedAt: new Date().toISOString(),
          previousEntry: entry,
        },
      }
      : lockEntryForPack(restoredPack || { id: idCheck.id }, {
        source: entry.source || 'local',
        installedBy: options.installedBy || 'orpad-cli',
      });
    const lockWrite = await upsertNodePackInstallLockEntry(restoredEntry, options);
    if (!lockWrite.ok) {
      throw new Error(lockWrite.diagnostics.map(item => item.message).join('; ') || 'Node pack rollback lock write failed.');
    }
    return installSuccess('rollback', [
      warningDiagnostic('NODE_PACK_ROLLBACK_RESTORED_BACKUP', 'Installed node pack was restored from rollback backup.', {
        packId: idCheck.id,
        backupPath: previousBackupPath,
      }),
      ...(discovery.diagnostics || []),
    ], {
      nodePack: restoredPack || null,
      installedPath: targetPath,
      backupPath: currentBackup.backupPath || '',
      lockPath: lockWrite.path || '',
      lockEntry: restoredEntry,
      discovery,
    });
  } catch (err) {
    if (restored) {
      await fs.rename(targetPath, previousBackupPath).catch(() => {});
    }
    await restoreBackup(currentBackup);
    return installFailure('rollback', [
      errorDiagnostic('NODE_PACK_ROLLBACK_FAILED', 'Node pack rollback failed and current active pack was restored.', {
        packId: idCheck.id,
        error: err.message,
      }),
    ]);
  }
}

async function setInstalledNodePackEnabled(packId, enabled, options = {}) {
  const idCheck = validatePackIdForInstall(packId);
  if (!idCheck.ok) {
    return installFailure(enabled ? 'enable' : 'disable', [idCheck.diagnostic]);
  }
  const root = userNodePacksRoot(options);
  if (!root) {
    return installFailure(enabled ? 'enable' : 'disable', [
      errorDiagnostic('NODE_PACK_INSTALL_USER_ROOT_MISSING', 'Node pack install requires --user-data or --user-node-packs.'),
    ]);
  }
  const manifestPath = path.join(root, idCheck.id, 'orpad.node-pack.json');
  const read = await readJsonObjectFile(manifestPath, 'NODE_PACK_INSTALL_MANIFEST', 'Installed node pack manifest');
  if (!read.ok) return installFailure(enabled ? 'enable' : 'disable', read.diagnostics);
  const pack = {
    ...read.value,
    enabled: enabled ? true : false,
  };
  await writeJsonAtomic(manifestPath, pack);
  const discovery = discoverNodePackManifests(discoveryOptionsForUserRoot(root, options));
  const discoveredPack = selectedStagedPack(discovery, idCheck.id) || pack;
  const current = await readNodePackInstallLock(options);
  const existing = current.ok
    ? (current.lock.packs || []).find(item => item.id === idCheck.id)
    : null;
  const entry = {
    ...(existing || lockEntryForPack(discoveredPack, {
      source: 'local',
      installedBy: options.installedBy || 'orpad-cli',
    })),
    enabled: enabled ? true : false,
    resolutionState: discoveredPack.resolutionState || '',
    validationStatus: discoveredPack.validationStatus || '',
    diagnostics: discoveredPack.validation?.diagnostics || [],
  };
  const lockWrite = await upsertNodePackInstallLockEntry(entry, options);
  if (!lockWrite.ok) {
    return installFailure(enabled ? 'enable' : 'disable', [
      ...(current.diagnostics || []),
      ...(lockWrite.diagnostics || []),
    ], {
      nodePack: discoveredPack,
      lockEntry: entry,
      discovery,
    });
  }
  return installSuccess(enabled ? 'enable' : 'disable', [
    ...(current.diagnostics || []),
    ...(lockWrite.diagnostics || []),
  ], {
    nodePack: discoveredPack,
    lockPath: lockWrite.path || '',
    lockEntry: entry,
    discovery,
  });
}

async function removeInstalledNodePack(packId, options = {}) {
  const idCheck = validatePackIdForInstall(packId);
  if (!idCheck.ok) return installFailure('remove', [idCheck.diagnostic]);
  const root = userNodePacksRoot(options);
  if (!root) {
    return installFailure('remove', [
      errorDiagnostic('NODE_PACK_INSTALL_USER_ROOT_MISSING', 'Node pack install requires --user-data or --user-node-packs.'),
    ]);
  }
  const targetPath = path.join(root, idCheck.id);
  try {
    await fs.lstat(targetPath);
  } catch (err) {
    return installFailure('remove', [
      errorDiagnostic('NODE_PACK_INSTALL_REMOVE_MISSING', 'Installed node pack could not be found for removal.', {
        packId: idCheck.id,
        path: targetPath,
        error: err.message,
      }),
    ]);
  }
  const backupInfo = await moveActivePackToBackup(idCheck.id, options);
  const lockWrite = await removeNodePackInstallLockEntry(idCheck.id, options);
  if (!lockWrite.ok) {
    await restoreBackup(backupInfo);
    return installFailure('remove', lockWrite.diagnostics || [], {
      installedPath: targetPath,
      backupPath: backupInfo.backupPath || '',
    });
  }
  const discovery = discoverNodePackManifests(discoveryOptionsForUserRoot(root, options));
  return installSuccess('remove', [
    warningDiagnostic('NODE_PACK_INSTALL_REMOVED_TO_BACKUP', 'Installed node pack was moved to a backup directory instead of being deleted.', {
      packId: idCheck.id,
      backupPath: backupInfo.backupPath || '',
    }),
  ], {
    installedPath: targetPath,
    backupPath: backupInfo.backupPath || '',
    lockPath: lockWrite.path || '',
    discovery,
  });
}

module.exports = {
  DEFAULT_NODE_PACK_INSTALL_FILE_BYTE_LIMIT,
  DEFAULT_NODE_PACK_INSTALL_TIMEOUT_MS,
  NODE_PACK_INSTALL_BACKUP_DIR,
  NODE_PACK_INSTALL_LOCK_FILE,
  NODE_PACK_INSTALL_LOCK_KIND,
  NODE_PACK_INSTALL_LOCK_SCHEMA_VERSION,
  NODE_PACK_INSTALL_STAGING_DIR,
  compareStrictSemverVersions,
  exportInstalledNodePackList,
  installLocalNodePack,
  installRegistryNodePack,
  listNodePackUpdateCandidates,
  nodePackInstallLockPath,
  readNodePackInstallLock,
  registryVersionFileUrl,
  removeInstalledNodePack,
  rollbackInstalledNodePack,
  setInstalledNodePackEnabled,
  updateInstalledNodePacks,
  writeNodePackInstallLock,
};
