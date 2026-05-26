const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const {
  BROAD_WRITE_NODE_PACK_CAPABILITIES,
  auditDiscoveredNodePackDirectory,
  declaredNodePackFilePaths,
  declaredNodeTypes,
  validateNodePackManifest,
} = require('./node-packs');
const {
  normalizeNodePackRegistryIndex,
} = require('./node-pack-registry');

const NODE_PACK_MANIFEST_FILE = 'orpad.node-pack.json';
const NODE_PACK_REGISTRY_KIND = 'orpad.nodePackRegistry';
const NODE_PACK_REGISTRY_SCHEMA_VERSION = '1.0';

function diagnostic(level, code, message, details = {}) {
  return { level, code, message, ...details };
}

function errorDiagnostic(code, message, details = {}) {
  return diagnostic('error', code, message, details);
}

function warningDiagnostic(code, message, details = {}) {
  return diagnostic('warning', code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function valueKind(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function optionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
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

function safePackPath(root, relativePath) {
  const normalized = normalizePackRelativePath(relativePath);
  if (!normalized) {
    return {
      ok: false,
      normalized: '',
      path: '',
      diagnostic: errorDiagnostic('NODE_PACK_AUTHOR_DECLARED_FILE_PATH_UNSAFE', 'Declared Package files must be pack-relative portable paths.', {
        filePath: relativePath,
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
      diagnostic: errorDiagnostic('NODE_PACK_AUTHOR_DECLARED_FILE_PATH_ESCAPE', 'Declared Package file escaped the pack folder.', {
        filePath: relativePath,
      }),
    };
  }
  return { ok: true, normalized, path: targetPath };
}

async function readNodePackManifestFile(sourceDir) {
  const root = path.resolve(String(sourceDir || ''));
  if (!sourceDir) {
    return {
      ok: false,
      sourceDir: root,
      manifestPath: '',
      manifestBuffer: null,
      pack: null,
      diagnostics: [
        errorDiagnostic('NODE_PACK_AUTHOR_SOURCE_MISSING', 'A Package folder path is required.'),
      ],
    };
  }

  let stat;
  try {
    stat = await fs.stat(root);
  } catch (err) {
    return {
      ok: false,
      sourceDir: root,
      manifestPath: '',
      manifestBuffer: null,
      pack: null,
      diagnostics: [
        errorDiagnostic('NODE_PACK_AUTHOR_SOURCE_UNREADABLE', 'Package folder could not be read.', {
          sourceDir: root,
          error: err.message,
        }),
      ],
    };
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      sourceDir: root,
      manifestPath: '',
      manifestBuffer: null,
      pack: null,
      diagnostics: [
        errorDiagnostic('NODE_PACK_AUTHOR_SOURCE_NOT_DIRECTORY', 'Package source must be a folder.', {
          sourceDir: root,
        }),
      ],
    };
  }

  const manifestPath = path.join(root, NODE_PACK_MANIFEST_FILE);
  let manifestBuffer;
  try {
    manifestBuffer = await fs.readFile(manifestPath);
  } catch (err) {
    return {
      ok: false,
      sourceDir: root,
      manifestPath,
      manifestBuffer: null,
      pack: null,
      diagnostics: [
        errorDiagnostic('NODE_PACK_AUTHOR_MANIFEST_READ_FAILED', 'Package manifest could not be read.', {
          manifestPath,
          error: err.message,
        }),
      ],
    };
  }

  let pack;
  try {
    pack = JSON.parse(manifestBuffer.toString('utf-8'));
  } catch (err) {
    return {
      ok: false,
      sourceDir: root,
      manifestPath,
      manifestBuffer,
      pack: null,
      diagnostics: [
        errorDiagnostic('NODE_PACK_AUTHOR_MANIFEST_JSON_INVALID', 'Package manifest must be valid JSON.', {
          manifestPath,
          error: err.message,
        }),
      ],
    };
  }
  if (!isPlainObject(pack)) {
    return {
      ok: false,
      sourceDir: root,
      manifestPath,
      manifestBuffer,
      pack: null,
      diagnostics: [
        errorDiagnostic('NODE_PACK_AUTHOR_MANIFEST_INVALID', 'Package manifest must be a JSON object.', {
          manifestPath,
          valueType: valueKind(pack),
        }),
      ],
    };
  }

  return {
    ok: true,
    sourceDir: root,
    manifestPath,
    manifestBuffer,
    pack,
    diagnostics: [],
  };
}

async function readmeInfo(sourceDir) {
  let entries = [];
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch {
    return { exists: false, path: '' };
  }
  const readme = entries
    .filter(entry => entry.isFile())
    .find(entry => /^readme(?:\.(?:md|markdown|txt))?$/i.test(entry.name));
  return readme
    ? { exists: true, path: path.join(sourceDir, readme.name) }
    : { exists: false, path: '' };
}

async function collectDeclaredFileChecksums(sourceDir, pack, manifestBuffer, diagnostics) {
  const records = [{
    path: NODE_PACK_MANIFEST_FILE,
    sha256: sha256Hex(manifestBuffer || Buffer.alloc(0)),
    bytes: manifestBuffer ? manifestBuffer.length : 0,
  }];
  const declaredPaths = [...declaredNodePackFilePaths(pack)]
    .filter(relativePath => relativePath !== NODE_PACK_MANIFEST_FILE)
    .sort((left, right) => left.localeCompare(right));

  for (const relativePath of declaredPaths) {
    const target = safePackPath(sourceDir, relativePath);
    if (!target.ok) {
      diagnostics.push(target.diagnostic);
      continue;
    }
    let stat;
    try {
      stat = await fs.stat(target.path);
    } catch (err) {
      diagnostics.push(errorDiagnostic('NODE_PACK_AUTHOR_DECLARED_FILE_MISSING', 'Manifest-declared Package file is missing.', {
        filePath: target.normalized,
        error: err.message,
      }));
      continue;
    }
    if (!stat.isFile()) {
      diagnostics.push(errorDiagnostic('NODE_PACK_AUTHOR_DECLARED_FILE_NOT_FILE', 'Manifest-declared Package path must be a file.', {
        filePath: target.normalized,
      }));
      continue;
    }
    const buffer = await fs.readFile(target.path);
    records.push({
      path: target.normalized,
      sha256: sha256Hex(buffer),
      bytes: buffer.length,
    });
  }

  return records;
}

function authorFacingDiagnostics(pack, readme) {
  const diagnostics = [];
  const packId = pack?.id || '';
  const officialOrBuiltIn = pack?.origin === 'built-in' || pack?.trustLevel === 'official';
  if (!readme.exists) {
    diagnostics.push(warningDiagnostic('NODE_PACK_AUTHOR_README_MISSING', 'Shareable Packages should include a README for registry review and user inspection.', {
      packId,
      expected: 'README.md',
    }));
  }
  const capabilities = new Set(Array.isArray(pack?.capabilities) ? pack.capabilities : []);
  if (!officialOrBuiltIn) {
    for (const capability of BROAD_WRITE_NODE_PACK_CAPABILITIES) {
      if (!capabilities.has(capability)) continue;
      diagnostics.push(warningDiagnostic('NODE_PACK_AUTHOR_BROAD_CAPABILITY_REVIEW_REQUIRED', 'Broad write or verification capabilities require explicit registry review before users can execute the pack.', {
        packId,
        capability,
      }));
    }
  }
  return diagnostics;
}

function summarizePack(pack) {
  return {
    id: pack?.id || '',
    name: pack?.name || '',
    version: pack?.version || '',
    trustLevel: pack?.trustLevel || '',
    capabilities: Array.isArray(pack?.capabilities) ? [...pack.capabilities] : [],
    nodeTypes: declaredNodeTypes(pack).sort(),
  };
}

async function validateNodePackFolder(sourceDir, options = {}) {
  const read = await readNodePackManifestFile(sourceDir);
  const diagnostics = [...read.diagnostics];
  if (!read.ok) {
    return {
      success: false,
      ok: false,
      action: 'validate',
      sourceDir: read.sourceDir,
      manifestPath: read.manifestPath,
      nodePack: null,
      pack: null,
      validation: null,
      readme: { exists: false, path: '' },
      declaredFiles: [],
      manifestSha256: '',
      diagnostics,
    };
  }

  const installMode = options.installMode || 'normal';
  const directoryAuditDiagnostics = auditDiscoveredNodePackDirectory(read.pack, {
    rootKind: 'user',
    packDir: read.sourceDir,
    manifestPath: read.manifestPath,
  }, { installMode });
  const validation = validateNodePackManifest(read.pack, {
    currentOrpadVersion: options.currentOrpadVersion,
    installMode,
    directoryAuditDiagnostics,
  });
  diagnostics.push(...validation.diagnostics);

  const readme = await readmeInfo(read.sourceDir);
  diagnostics.push(...authorFacingDiagnostics(read.pack, readme));
  const declaredFiles = await collectDeclaredFileChecksums(
    read.sourceDir,
    read.pack,
    read.manifestBuffer,
    diagnostics,
  );
  const success = !diagnostics.some(item => item.level === 'error');

  return {
    success,
    ok: success,
    action: 'validate',
    sourceDir: read.sourceDir,
    manifestPath: read.manifestPath,
    nodePack: read.pack,
    pack: summarizePack(read.pack),
    validation,
    readme,
    declaredFiles,
    manifestSha256: sha256Hex(read.manifestBuffer),
    diagnostics,
  };
}

function normalizeSourceRoot(value) {
  const text = optionalString(value);
  if (!text || text === '.') return '';
  const normalized = normalizePackRelativePath(text);
  return normalized || text;
}

function githubRawManifestUrl(sourceRepository, sourceRef, sourceRoot = '') {
  let url;
  try {
    url = new URL(sourceRepository);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return '';
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (parts.length < 2 || !sourceRef) return '';
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  const root = normalizeSourceRoot(sourceRoot);
  const pathParts = [owner, repo, sourceRef, root, NODE_PACK_MANIFEST_FILE]
    .filter(Boolean)
    .join('/');
  return `https://raw.githubusercontent.com/${pathParts}`;
}

function sourceMetadataDiagnostics(sourceRepository, sourceRef, manifestUrl) {
  const diagnostics = [];
  if (!sourceRepository) {
    diagnostics.push(errorDiagnostic('NODE_PACK_AUTHOR_SOURCE_REPOSITORY_MISSING', 'A registry entry draft requires --source-repository.'));
  }
  if (!sourceRef) {
    diagnostics.push(errorDiagnostic('NODE_PACK_AUTHOR_SOURCE_REF_MISSING', 'A registry entry draft requires --source-ref.'));
  }
  if (!manifestUrl) {
    diagnostics.push(errorDiagnostic('NODE_PACK_AUTHOR_MANIFEST_URL_MISSING', 'A registry entry draft requires --manifest-url when it cannot be derived from a GitHub source repository and source ref.'));
  }
  return diagnostics;
}

function createDraftEntry(pack, validationResult, options = {}) {
  const sourceRepository = optionalString(options.sourceRepository || options.repository);
  const sourceRef = optionalString(options.sourceRef || options.ref);
  const sourceRoot = normalizeSourceRoot(options.sourceRoot);
  const manifestUrl = optionalString(options.manifestUrl)
    || githubRawManifestUrl(sourceRepository, sourceRef, sourceRoot);
  const files = {};
  for (const record of validationResult.declaredFiles || []) {
    if (record.path === NODE_PACK_MANIFEST_FILE) continue;
    files[record.path] = record.sha256;
  }
  const links = {};
  const docsUrl = optionalString(options.docsUrl || options.docs);
  const issuesUrl = optionalString(options.issuesUrl || options.issues);
  const changelogUrl = optionalString(options.changelogUrl || options.changelog);
  if (docsUrl) links.docs = docsUrl;
  if (issuesUrl) links.issues = issuesUrl;
  if (changelogUrl) links.changelog = changelogUrl;

  return {
    entry: {
      id: pack.id || '',
      name: pack.name || pack.id || '',
      description: pack.description || '',
      latestVersion: pack.version || '',
      versions: [{
        version: pack.version || '',
        manifestUrl,
        sourceRepository,
        sourceRef,
        sourceRoot,
        manifestPath: NODE_PACK_MANIFEST_FILE,
        checksums: {
          manifestSha256: validationResult.manifestSha256 || '',
          files,
        },
        review: {
          status: 'community',
        },
      }],
      author: isPlainObject(pack.author) ? { ...pack.author } : {},
      license: pack.license || '',
      trustLevel: 'community',
      capabilities: uniqueStrings(pack.capabilities),
      nodeTypes: declaredNodeTypes(pack).sort(),
      keywords: uniqueStrings(pack.keywords),
      categories: uniqueStrings(pack.categories),
      links,
    },
    sourceRepository,
    sourceRef,
    sourceRoot,
    manifestUrl,
  };
}

async function createNodePackRegistryEntryDraft(sourceDir, options = {}) {
  const validationResult = await validateNodePackFolder(sourceDir, options);
  const diagnostics = [...validationResult.diagnostics];
  const pack = validationResult.nodePack;
  if (!pack) {
    return {
      success: false,
      ok: false,
      action: 'registry-entry-create',
      sourceDir: validationResult.sourceDir,
      entry: null,
      registryValidation: null,
      validation: validationResult.validation,
      diagnostics,
    };
  }

  const draft = createDraftEntry(pack, validationResult, options);
  diagnostics.push(...sourceMetadataDiagnostics(draft.sourceRepository, draft.sourceRef, draft.manifestUrl));
  if (pack.trustLevel && pack.trustLevel !== 'community') {
    diagnostics.push(warningDiagnostic('NODE_PACK_AUTHOR_TRUST_LEVEL_DOWNGRADED_FOR_DRAFT', 'Registry entry drafts start as community trust until OrPAD-owned signature or review evidence is added by the registry process.', {
      packId: pack.id || '',
      declaredTrustLevel: pack.trustLevel,
      draftTrustLevel: 'community',
    }));
  }

  const registryDraft = {
    kind: NODE_PACK_REGISTRY_KIND,
    schemaVersion: NODE_PACK_REGISTRY_SCHEMA_VERSION,
    registryId: optionalString(options.registryId) || 'orpad.community.draft',
    name: optionalString(options.registryName) || 'OrPAD Community Draft Registry',
    governance: {
      registryTrust: 'community',
      reviewModel: 'registry-draft',
      submissions: {
        type: 'pull-request',
        url: optionalString(options.submissionsUrl || options.submissionUrl),
      },
      reviewPolicyUrl: optionalString(options.reviewPolicyUrl || options.policyUrl),
      notes: 'Draft entries are discovery metadata until accepted by an official OrPAD registry review.',
    },
    generatedAt: options.generatedAt || new Date().toISOString(),
    entries: [draft.entry],
  };
  const registryValidation = normalizeNodePackRegistryIndex(registryDraft);
  diagnostics.push(...registryValidation.diagnostics);

  const success = !diagnostics.some(item => item.level === 'error');
  return {
    success,
    ok: success,
    action: 'registry-entry-create',
    sourceDir: validationResult.sourceDir,
    manifestPath: validationResult.manifestPath,
    entry: draft.entry,
    registryDraft,
    registryValidation: {
      ok: registryValidation.ok,
      diagnostics: registryValidation.diagnostics,
    },
    validation: validationResult.validation,
    readme: validationResult.readme,
    declaredFiles: validationResult.declaredFiles,
    diagnostics,
  };
}

module.exports = {
  NODE_PACK_MANIFEST_FILE,
  createNodePackRegistryEntryDraft,
  validateNodePackFolder,
};
