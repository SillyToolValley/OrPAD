const RESERVED_TYPE_PREFIX = 'orpad.';
const SAFE_TRUST_LEVELS = new Set(['official', 'signed', 'local']);
const BLOCKED_LIFECYCLE_SCRIPTS = new Set(['preinstall', 'install', 'postinstall', 'prepare']);
const EXECUTABLE_HANDLER_KINDS = new Set(['executable', 'unsafe-executable', 'native', 'process']);

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
      path: node.path || '',
      runtimeHandlerKind: node.runtimeHandlerKind || '',
      capabilities: node.capabilities || [],
    };
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

module.exports = {
  BLOCKED_LIFECYCLE_SCRIPTS,
  EXECUTABLE_HANDLER_KINDS,
  RESERVED_TYPE_PREFIX,
  createLosslessNodePlaceholder,
  createNodePackLockEntry,
  declaredNodeTypes,
  resolveNodeTypeCompatibility,
  satisfiesSimpleRange,
  validateNodePackManifest,
};
