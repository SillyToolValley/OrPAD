const RESERVED_TYPE_PREFIX = 'orpad.';
const SAFE_TRUST_LEVELS = new Set(['official', 'signed', 'local']);
const BLOCKED_LIFECYCLE_SCRIPTS = new Set(['preinstall', 'install', 'postinstall', 'prepare']);
const EXECUTABLE_HANDLER_KINDS = new Set(['executable', 'unsafe-executable', 'native', 'process']);
const PACK_ASSET_COLLECTIONS = ['graphs', 'trees', 'skills', 'rules', 'examples'];
const BUILT_IN_NODE_PACK_MANIFESTS = [
  {
    kind: 'orpad.nodePack',
    schemaVersion: '1.0',
    id: 'orpad.core',
    name: 'OrPAD Core Node Pack',
    version: '1.0.0-beta.3',
    origin: 'built-in',
    trustLevel: 'official',
    compatibility: {
      orpad: '>=1.0.0-beta.3',
      packFormat: 'orpad.nodePack.v1',
    },
    capabilities: [],
    installPolicy: {
      allowLifecycleScripts: false,
      allowExecutableHandlers: false,
    },
    nodes: [
      'orpad.context',
      'orpad.gate',
      'orpad.graph',
      'orpad.rule',
      'orpad.selector',
      'orpad.skill',
      'orpad.tree',
    ].map(type => ({
      type,
      path: `nodes/${type.slice('orpad.'.length)}.or-node`,
      runtimeHandlerKind: 'metadata-only',
      capabilities: [],
    })),
  },
  {
    kind: 'orpad.nodePack',
    schemaVersion: '1.0',
    id: 'orpad.workstream',
    name: 'OrPAD Workstream Node Pack',
    version: '1.0.0-beta.3',
    origin: 'built-in',
    trustLevel: 'official',
    compatibility: {
      orpad: '>=1.0.0-beta.3',
      packFormat: 'orpad.nodePack.v1',
    },
    capabilities: [],
    installPolicy: {
      allowLifecycleScripts: false,
      allowExecutableHandlers: false,
    },
    nodes: [
      'orpad.artifactContract',
      'orpad.barrier',
      'orpad.dispatcher',
      'orpad.entry',
      'orpad.exit',
      'orpad.patchReview',
      'orpad.probe',
      'orpad.triage',
      'orpad.workQueue',
      'orpad.workerLoop',
    ].map(type => ({
      type,
      path: `nodes/${type.slice('orpad.'.length)}.or-node`,
      runtimeHandlerKind: 'metadata-only',
      capabilities: [],
    })),
  },
];

function diagnostic(level, code, message, details = {}) {
  return { level, code, message, ...details };
}

function parseVersion(value) {
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return match.slice(1).map(Number);
}

function compareVersion(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function satisfiesSimpleRange(version, range) {
  const value = String(range || '').trim();
  if (!value || value === '*') return true;
  if (value.startsWith('>=')) return compareVersion(version, value.slice(2).trim()) >= 0;
  return compareVersion(version, value) === 0;
}

function declaredNodeTypes(pack) {
  return (Array.isArray(pack?.nodes) ? pack.nodes : [])
    .map(node => String(node?.type || '').trim())
    .filter(Boolean);
}

function lifecycleScriptNames(pack) {
  const scripts = {
    ...(pack?.packageScripts || {}),
    ...(pack?.scripts || {}),
  };
  return Object.keys(scripts).filter(name => BLOCKED_LIFECYCLE_SCRIPTS.has(name));
}

function hasExecutableHandler(node) {
  const kind = String(node?.runtimeHandlerKind || '').trim();
  return EXECUTABLE_HANDLER_KINDS.has(kind) || Boolean(node?.handler || node?.main);
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

function validatePackAssetPath(diagnostics, pack, assetKind, assetId, assetPath) {
  if (!assetPath) return '';
  const normalized = normalizePackRelativePath(assetPath);
  if (normalized) return normalized;
  diagnostics.push(diagnostic('error', 'NODE_PACK_ASSET_PATH_UNSAFE', 'Node pack asset paths must be pack-relative portable paths.', {
    packId: pack.id,
    assetKind,
    assetId,
    path: assetPath,
  }));
  return '';
}

function validateNodePackManifest(pack, options = {}) {
  const diagnostics = [];
  const currentOrpadVersion = options.currentOrpadVersion || '1.0.0-beta.3';
  const installMode = options.installMode || 'normal';
  const grantedCapabilities = new Set(options.grantedCapabilities || []);
  const builtIn = pack?.origin === 'built-in' || pack?.trustLevel === 'official';

  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    return {
      ok: false,
      resolutionState: 'incompatible',
      nodeTypeMap: {},
      diagnostics: [diagnostic('error', 'NODE_PACK_INVALID', 'Node pack manifest must be an object.')],
    };
  }

  if (pack.enabled === false) {
    diagnostics.push(diagnostic('warning', 'NODE_PACK_DISABLED', 'Node pack is disabled.', { packId: pack.id }));
  }
  if (!pack.id) diagnostics.push(diagnostic('error', 'NODE_PACK_ID_MISSING', 'Node pack id is required.'));
  if (!pack.version) diagnostics.push(diagnostic('error', 'NODE_PACK_VERSION_MISSING', 'Node pack version is required.', { packId: pack.id }));
  if (!Array.isArray(pack.nodes)) diagnostics.push(diagnostic('error', 'NODE_PACK_NODES_MISSING', 'Node pack must declare a nodes array.', { packId: pack.id }));
  if (!builtIn && String(pack.id || '').startsWith(RESERVED_TYPE_PREFIX)) {
    diagnostics.push(diagnostic('error', 'NODE_PACK_RESERVED_ID', 'Community node packs cannot use the reserved orpad.* id namespace.', { packId: pack.id }));
  }

  const format = pack.compatibility?.packFormat || pack.packFormat || '';
  if (format && format !== 'orpad.nodePack.v1') {
    diagnostics.push(diagnostic('error', 'NODE_PACK_FORMAT_INCOMPATIBLE', 'Node pack format is not supported.', { packId: pack.id, format }));
  }
  const orpadRange = pack.compatibility?.orpad || '';
  if (orpadRange && !satisfiesSimpleRange(currentOrpadVersion, orpadRange)) {
    diagnostics.push(diagnostic('error', 'NODE_PACK_ORPAD_VERSION_INCOMPATIBLE', 'Node pack does not support this OrPAD version.', {
      packId: pack.id,
      required: orpadRange,
      current: currentOrpadVersion,
    }));
  }

  const blockedScripts = lifecycleScriptNames(pack);
  if (installMode === 'normal' && blockedScripts.length) {
    diagnostics.push(diagnostic('error', 'NODE_PACK_LIFECYCLE_SCRIPT_BLOCKED', 'Normal node pack install rejects npm lifecycle scripts.', {
      packId: pack.id,
      scripts: blockedScripts,
    }));
  }

  const trustLevel = pack.trustLevel || 'unknown';
  if (!SAFE_TRUST_LEVELS.has(trustLevel)) {
    diagnostics.push(diagnostic('warning', 'NODE_PACK_UNTRUSTED', 'Node pack trust level requires review before execution.', {
      packId: pack.id,
      trustLevel,
    }));
  }

  const packCapabilities = new Set(pack.capabilities || []);
  const nodeTypeMap = {};
  for (const node of Array.isArray(pack.nodes) ? pack.nodes : []) {
    const type = String(node?.type || '').trim();
    if (!type) {
      diagnostics.push(diagnostic('error', 'NODE_PACK_NODE_TYPE_MISSING', 'Node declaration must include a type.', { packId: pack.id }));
      continue;
    }
    if (!builtIn && type.startsWith(RESERVED_TYPE_PREFIX)) {
      diagnostics.push(diagnostic('error', 'NODE_PACK_RESERVED_NODE_TYPE', 'Community node packs cannot override orpad.* node types.', { packId: pack.id, nodeType: type }));
    }
    if (installMode === 'normal' && hasExecutableHandler(node)) {
      diagnostics.push(diagnostic('error', 'NODE_PACK_EXECUTABLE_HANDLER_BLOCKED', 'Normal node pack install rejects executable handlers.', { packId: pack.id, nodeType: type }));
    }
    const nodePath = validatePackAssetPath(diagnostics, pack, 'node', type, node.path || '');
    for (const capability of node.capabilities || []) {
      if (!packCapabilities.has(capability)) {
        diagnostics.push(diagnostic('error', 'NODE_PACK_NODE_CAPABILITY_UNDECLARED', 'Node capability must be pack-declared.', { packId: pack.id, nodeType: type, capability }));
      }
      if (grantedCapabilities.size && !grantedCapabilities.has(capability)) {
        diagnostics.push(diagnostic('warning', 'NODE_PACK_CAPABILITY_DENIED', 'Node capability is not granted for this install.', { packId: pack.id, nodeType: type, capability }));
      }
    }
    nodeTypeMap[type] = {
      packId: pack.id,
      packVersion: pack.version,
      path: nodePath,
      runtimeHandlerKind: node.runtimeHandlerKind || '',
      capabilities: node.capabilities || [],
    };
  }
  for (const collectionName of PACK_ASSET_COLLECTIONS) {
    for (const asset of Array.isArray(pack[collectionName]) ? pack[collectionName] : []) {
      validatePackAssetPath(diagnostics, pack, collectionName, asset?.id || asset?.type || '', asset?.path || '');
    }
  }

  const hasError = diagnostics.some(item => item.level === 'error');
  const hasCapabilityDenied = diagnostics.some(item => item.code === 'NODE_PACK_CAPABILITY_DENIED');
  const hasUntrusted = diagnostics.some(item => item.code === 'NODE_PACK_UNTRUSTED');
  const disabled = diagnostics.some(item => item.code === 'NODE_PACK_DISABLED');
  let resolutionState = 'resolved';
  if (disabled) resolutionState = 'disabled';
  else if (hasError) resolutionState = 'incompatible';
  else if (hasCapabilityDenied) resolutionState = 'capability-denied';
  else if (hasUntrusted) resolutionState = 'untrusted';

  return {
    ok: !hasError,
    packId: pack.id || '',
    packVersion: pack.version || '',
    resolutionState,
    declaredNodeTypes: declaredNodeTypes(pack),
    nodeTypeMap,
    diagnostics,
  };
}

function resolveNodeTypeCompatibility(nodeType, packResults = []) {
  for (const result of packResults) {
    if (result.nodeTypeMap?.[nodeType]) {
      return {
        state: result.resolutionState,
        nodeType,
        packId: result.packId,
        packVersion: result.packVersion,
        declaration: result.nodeTypeMap[nodeType],
      };
    }
  }
  return {
    state: 'missing',
    nodeType,
  };
}

function createLosslessNodePlaceholder(node, resolution) {
  return {
    schemaVersion: 'orpad.nodePlaceholder.v1',
    resolution,
    originalNode: JSON.parse(JSON.stringify(node || null)),
  };
}

function createNodePackLockEntry(pack, options = {}) {
  return {
    id: pack.id,
    version: pack.version,
    source: options.source || pack.origin || 'unknown',
    checksum: options.checksum || '',
    signature: options.signature || '',
    resolvedNodeTypes: declaredNodeTypes(pack).sort(),
  };
}

function normalizeNodePackDeclaration(value, path = 'nodePacks') {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? { id: trimmed, path } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const id = String(value.id || value.packId || '').trim();
  const versionRange = String(
    value.versionRange
      || value.range
      || value.requiredVersion
      || value.version
      || '',
  ).trim();
  const origin = String(value.origin || value.source || '').trim();
  return {
    ...value,
    id,
    versionRange,
    origin,
    path,
  };
}

function collectNodePackDeclarations(nodePacks) {
  if (Array.isArray(nodePacks)) {
    return nodePacks
      .map((item, index) => normalizeNodePackDeclaration(item, `nodePacks[${index}]`))
      .filter(Boolean);
  }
  if (nodePacks && typeof nodePacks === 'object') {
    return Object.entries(nodePacks)
      .map(([id, item]) => {
        if (item === true) return normalizeNodePackDeclaration({ id }, `nodePacks.${id}`);
        if (typeof item === 'string') return normalizeNodePackDeclaration({ id, versionRange: item }, `nodePacks.${id}`);
        return normalizeNodePackDeclaration({ id, ...item }, `nodePacks.${id}`);
      })
      .filter(Boolean);
  }
  return [];
}

function validatePipelineNodePacks(nodePacks, options = {}) {
  const diagnostics = [];
  const declarations = collectNodePackDeclarations(nodePacks);
  const availablePacks = options.availableNodePacks
    || options.nodePackManifests
    || options.builtInNodePacks
    || BUILT_IN_NODE_PACK_MANIFESTS;
  const availableById = new Map((Array.isArray(availablePacks) ? availablePacks : [])
    .filter(pack => pack && typeof pack === 'object' && !Array.isArray(pack))
    .map(pack => [String(pack.id || '').trim(), pack])
    .filter(([id]) => id));
  const resolved = [];

  for (const declaration of declarations) {
    if (!declaration.id) {
      diagnostics.push(diagnostic(
        'error',
        'PIPELINE_NODE_PACK_ID_MISSING',
        'Pipeline nodePacks entries must include a pack id.',
        { path: declaration.path },
      ));
      continue;
    }

    const pack = availableById.get(declaration.id);
    if (!pack) {
      diagnostics.push(diagnostic(
        'error',
        'PIPELINE_NODE_PACK_UNKNOWN',
        'Pipeline declares a node pack that is not available.',
        { path: declaration.path, packId: declaration.id },
      ));
      resolved.push({ id: declaration.id, resolutionState: 'missing' });
      continue;
    }

    const packResult = validateNodePackManifest(pack, {
      currentOrpadVersion: options.currentOrpadVersion,
      installMode: options.installMode || 'normal',
      grantedCapabilities: options.grantedCapabilities || pack.capabilities || [],
    });
    const origin = String(pack.origin || '').trim();
    const result = {
      id: declaration.id,
      requestedVersion: declaration.versionRange,
      requestedOrigin: declaration.origin,
      version: pack.version || '',
      origin,
      resolutionState: packResult.resolutionState,
      declaredNodeTypes: packResult.declaredNodeTypes || [],
    };
    resolved.push(result);

    if (declaration.origin && origin && declaration.origin !== origin) {
      diagnostics.push(diagnostic(
        'error',
        'PIPELINE_NODE_PACK_ORIGIN_MISMATCH',
        'Pipeline nodePacks origin must match the resolved pack origin.',
        { path: declaration.path, packId: declaration.id, expectedOrigin: declaration.origin, actualOrigin: origin },
      ));
    }
    if (declaration.versionRange && !satisfiesSimpleRange(pack.version, declaration.versionRange)) {
      diagnostics.push(diagnostic(
        'error',
        'PIPELINE_NODE_PACK_VERSION_INCOMPATIBLE',
        'Pipeline nodePacks version range is not satisfied by the resolved pack.',
        { path: declaration.path, packId: declaration.id, required: declaration.versionRange, current: pack.version || '' },
      ));
    }
    if (packResult.resolutionState === 'disabled') {
      diagnostics.push(diagnostic(
        'error',
        'PIPELINE_NODE_PACK_DISABLED',
        'Pipeline declares a disabled node pack.',
        { path: declaration.path, packId: declaration.id },
      ));
    } else if (!packResult.ok || packResult.resolutionState !== 'resolved') {
      diagnostics.push(diagnostic(
        'error',
        'PIPELINE_NODE_PACK_INCOMPATIBLE',
        'Pipeline declares a node pack that is not launch-compatible.',
        {
          path: declaration.path,
          packId: declaration.id,
          resolutionState: packResult.resolutionState,
          packDiagnostics: packResult.diagnostics,
        },
      ));
    }
  }

  return {
    ok: !diagnostics.some(item => item.level === 'error'),
    nodePacks: resolved,
    diagnostics,
  };
}

module.exports = {
  BLOCKED_LIFECYCLE_SCRIPTS,
  BUILT_IN_NODE_PACK_MANIFESTS,
  EXECUTABLE_HANDLER_KINDS,
  PACK_ASSET_COLLECTIONS,
  RESERVED_TYPE_PREFIX,
  collectNodePackDeclarations,
  createLosslessNodePlaceholder,
  createNodePackLockEntry,
  declaredNodeTypes,
  resolveNodeTypeCompatibility,
  satisfiesSimpleRange,
  validatePipelineNodePacks,
  validateNodePackManifest,
};
