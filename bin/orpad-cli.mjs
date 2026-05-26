#!/usr/bin/env node
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  discoverNodePackManifests,
} = require('../src/main/orchestration-machine/node-packs.js');
const {
  exportInstalledNodePackList,
  installLocalNodePack,
  installRegistryNodePack,
  listNodePackUpdateCandidates,
  removeInstalledNodePack,
  rollbackInstalledNodePack,
  setInstalledNodePackEnabled,
  updateInstalledNodePacks,
} = require('../src/main/orchestration-machine/node-pack-installer.js');
const {
  createNodePackRegistryEntryDraft,
  validateNodePackFolder,
} = require('../src/main/orchestration-machine/node-pack-authoring.js');
const {
  loadNodePackRegistrySource,
  searchNodePackRegistryEntries,
  summarizeNodePackRegistry,
} = require('../src/main/orchestration-machine/node-pack-registry.js');

let generatorModule = null;

function loadGeneratorModule() {
  if (!generatorModule) {
    generatorModule = require('../src/main/orchestration-authoring/generator.js');
  }
  return generatorModule;
}

function usage() {
  return [
    'Usage:',
    '  orpad generate --workspace <path> --prompt <text> [--authoring-spec-file <file>] [--user-node-packs <path>] [--json]',
    '  orpad generate --workspace <path> --prompt-file <file> [--authoring-spec-file <file>] [--user-node-packs <path>] [--json]',
    '  orpad generate --workspace <path> --prompt <text> --emit-authoring-prompt',
    '  orpad node-packs list [--user-node-packs <path>] [--user-data <path>] [--node-pack-trust-evidence <json>|--node-pack-trust-evidence-file <file>] [--node-pack-granted-capabilities <json>|--node-pack-granted-capabilities-file <file>] [--json]',
    '  orpad node-packs registry list --registry <url-or-file> [--user-data <path>] [--json]',
    '  orpad node-packs registry search <query> --registry <url-or-file> [--category <name>] [--capability <capability>] [--user-data <path>] [--json]',
    '  orpad node-packs install <id> --registry <url-or-file> [--version <version>] [--pin] [--user-data <path>] [--json]',
    '  orpad node-packs install-local <folder> [--user-data <path>] [--user-node-packs <path>] [--json]',
    '  orpad node-packs update [id] --registry <url-or-file> [--include-pinned] [--dry-run] [--user-data <path>] [--json]',
    '  orpad node-packs rollback <id> [--user-data <path>] [--user-node-packs <path>] [--json]',
    '  orpad node-packs validate <folder> [--json]',
    '  orpad node-packs registry-entry create <folder> --source-repository <url> --source-ref <ref> [--source-root <path>] [--manifest-url <url>] [--json]',
    '  orpad node-packs enable <id> [--user-data <path>] [--user-node-packs <path>] [--json]',
    '  orpad node-packs disable <id> [--user-data <path>] [--user-node-packs <path>] [--json]',
    '  orpad node-packs remove <id> [--user-data <path>] [--user-node-packs <path>] [--json]',
    '  orpad node-packs export-list [--user-data <path>] [--user-node-packs <path>] [--json]',
    '',
    'Commands:',
    '  generate          Define an OrPAD orchestration package for the prompt.',
    '  node-packs list   List discovered built-in and user node packs.',
    '  node-packs registry list/search   Browse a read-only node pack registry.',
    '  node-packs install/install-local  Safely stage, validate, and activate user node packs.',
    '  node-packs validate/registry-entry create  Prepare a shareable node pack registry draft.',
  ].join('\n');
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (['json', 'help', 'emit-authoring-prompt', 'pin', 'pinned', 'include-pinned', 'dry-run'].includes(key)) {
      parsed[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    parsed[key] = value;
    i += 1;
  }
  return parsed;
}

async function readPrompt(args) {
  if (args.prompt) return args.prompt;
  if (args['prompt-file']) return fs.readFile(args['prompt-file'], 'utf-8');
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const input = Buffer.concat(chunks).toString('utf-8').trim();
    if (input) return input;
  }
  return '';
}

async function readAuthoringSpec(args) {
  const { parseAuthoringSpecText } = loadGeneratorModule();
  const file = args['authoring-spec-file'] || args['spec-file'];
  if (file) return parseAuthoringSpecText(await fs.readFile(file, 'utf-8'));
  if (args['authoring-spec']) return parseAuthoringSpecText(args['authoring-spec']);
  return null;
}

function hasOwnOption(args, key) {
  return Object.prototype.hasOwnProperty.call(args, key);
}

function splitOptionList(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

async function readJsonObjectOption(args, inlineKey, fileKey) {
  const inline = args[inlineKey];
  const file = args[fileKey];
  if (!inline && !file) return undefined;
  const text = inline ? String(inline) : await fs.readFile(file, 'utf-8');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--${inline ? inlineKey : fileKey} must be a JSON object.`);
  }
  return parsed;
}

async function generateNodePackOptions(args) {
  const hasDiscoveryOptions = [
    'built-in-root',
    'user-node-packs',
    'user-data',
    'node-pack-trust-evidence',
    'node-pack-trust-evidence-file',
    'node-pack-granted-capabilities',
    'node-pack-granted-capabilities-file',
    'required-node-pack',
    'required-node-packs',
    'required-node-pack-ids',
    'max-authoring-node-packs',
  ].some(key => hasOwnOption(args, key));
  if (!hasDiscoveryOptions) return {};

  const trustEvidenceByPack = await readJsonObjectOption(
    args,
    'node-pack-trust-evidence',
    'node-pack-trust-evidence-file',
  );
  const grantedCapabilitiesByPack = await readJsonObjectOption(
    args,
    'node-pack-granted-capabilities',
    'node-pack-granted-capabilities-file',
  );
  const requiredNodePackIds = [
    ...splitOptionList(args['required-node-pack']),
    ...splitOptionList(args['required-node-packs']),
    ...splitOptionList(args['required-node-pack-ids']),
  ];
  const maxAuthoringNodePacks = hasOwnOption(args, 'max-authoring-node-packs')
    ? Math.max(0, Number(args['max-authoring-node-packs']) || 0)
    : undefined;
  const discovery = discoverNodePackManifests({
    builtInNodePacksRoot: hasOwnOption(args, 'built-in-root') ? args['built-in-root'] : undefined,
    userDataDir: args['user-data'] || '',
    userNodePacksRoot: args['user-node-packs'] || '',
    currentOrpadVersion: args['current-orpad-version'],
    installMode: args['node-pack-install-mode'] || args['install-mode'] || 'normal',
    trustEvidenceByPack,
    grantedCapabilitiesByPack,
  });
  const cliDiscovery = {
    ...discovery,
    nodePacks: Array.isArray(discovery.nodePacks)
      ? discovery.nodePacks.map(pack => {
        if (!pack || typeof pack !== 'object' || pack.discovery?.rootKind !== 'user') return pack;
        return {
          ...pack,
          origin: 'user',
          source: 'user',
        };
      })
      : discovery.nodePacks,
  };

  return {
    nodePackPool: cliDiscovery,
    nodePackDiagnostics: discovery.diagnostics,
    nodePackConflicts: discovery.conflicts,
    nodePackTrustEvidenceByPack: trustEvidenceByPack,
    nodePackGrantedCapabilitiesByPack: grantedCapabilitiesByPack,
    requiredNodePackIds,
    ...(maxAuthoringNodePacks === undefined ? {} : { maxAuthoringNodePacks }),
    currentOrpadVersion: args['current-orpad-version'],
    nodePackInstallMode: args['node-pack-install-mode'] || args['install-mode'] || 'normal',
  };
}

async function nodePackDiscoveryOptionsFromArgs(args) {
  const trustEvidenceByPack = await readJsonObjectOption(
    args,
    'node-pack-trust-evidence',
    'node-pack-trust-evidence-file',
  );
  const grantedCapabilitiesByPack = await readJsonObjectOption(
    args,
    'node-pack-granted-capabilities',
    'node-pack-granted-capabilities-file',
  );
  return {
    builtInNodePacksRoot: hasOwnOption(args, 'built-in-root') ? args['built-in-root'] : undefined,
    userDataDir: args['user-data'] || '',
    userNodePacksRoot: args['user-node-packs'] || '',
    currentOrpadVersion: args['current-orpad-version'],
    installMode: args['node-pack-install-mode'] || args['install-mode'] || 'normal',
    trustEvidenceByPack,
    grantedCapabilitiesByPack,
  };
}

async function collectWorkspaceSnapshot(workspaceRoot, maxFiles = 120) {
  const root = path.resolve(String(workspaceRoot || ''));
  const files = [];
  const skip = new Set(['.git', '.orpad', '.vs', 'node_modules', 'dist', 'build', 'out', 'coverage', 'bin', 'obj', 'release', 'playwright-report', 'test-results']);
  async function walk(dir, depth = 0) {
    if (files.length >= maxFiles || depth > 5) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  }
  await walk(root);
  return { files };
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write(`Generated OrPAD pipeline: ${result.pipelinePath}\n`);
  process.stdout.write(`Entry graph: ${result.graphPath}\n`);
}

function uniqueStrings(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function validationDiagnostics(validation) {
  return validation && Array.isArray(validation.diagnostics) ? validation.diagnostics : [];
}

function diagnosticCapabilities(diagnostics, code) {
  return uniqueStrings(diagnostics
    .filter(item => item?.code === code)
    .map(item => item.capability));
}

function diagnosticMissingTrustFields(diagnostics) {
  return uniqueStrings(diagnostics.flatMap(item => {
    if (item?.code !== 'NODE_PACK_SELF_DECLARED_TRUST_REQUIRES_PROOF') return [];
    if (Array.isArray(item.missingProofFields)) return item.missingProofFields;
    return [item.missingProofField];
  }));
}

function blockedNextActionForNodePack(pack, validation, resolutionState) {
  const diagnostics = validationDiagnostics(validation);
  const packId = String(pack.id || validation.packId || 'node pack').trim();
  const missingReviewCapabilities = diagnosticCapabilities(
    diagnostics,
    'NODE_PACK_HIGH_RISK_CAPABILITY_REVIEW_REQUIRED',
  );
  const missingGrantCapabilities = diagnosticCapabilities(
    diagnostics,
    'NODE_PACK_HIGH_RISK_CAPABILITY_REQUIRES_APPROVAL',
  );
  const deniedCapabilities = diagnosticCapabilities(diagnostics, 'NODE_PACK_CAPABILITY_DENIED');
  const missingTrustFields = diagnosticMissingTrustFields(diagnostics);
  const untrusted = diagnostics.some(item => item?.code === 'NODE_PACK_UNTRUSTED');

  if (missingReviewCapabilities.length || missingGrantCapabilities.length) {
    const actions = [];
    if (missingReviewCapabilities.length) {
      actions.push(`record an approved OrPAD high-risk capability review scoped to ${missingReviewCapabilities.join(', ')}`);
    }
    if (missingGrantCapabilities.length) {
      actions.push(`supply exact Machine-owned capability grants for ${missingGrantCapabilities.join(', ')} with --node-pack-granted-capabilities-file`);
    }
    return `${packId}: ${actions.join(' and ')}.`;
  }

  if (deniedCapabilities.length || resolutionState === 'capability-denied') {
    const capabilityText = deniedCapabilities.length ? ` for ${deniedCapabilities.join(', ')}` : '';
    return `${packId}: supply matching Machine-owned capability grants${capabilityText} with --node-pack-granted-capabilities-file or remove the denied capabilities from the pack manifest.`;
  }

  if (missingTrustFields.length) {
    return `${packId}: provide OrPAD-controlled trust evidence (${missingTrustFields.join(', ')}) with --node-pack-trust-evidence-file.`;
  }

  if (untrusted || resolutionState === 'untrusted') {
    return `${packId}: provide OrPAD-controlled trust evidence with --node-pack-trust-evidence-file or move the pack through manual review.`;
  }

  if (resolutionState === 'incompatible') {
    return `${packId}: fix the node pack manifest diagnostics before activation.`;
  }

  if (resolutionState === 'conflict') {
    return `${packId}: resolve duplicate node type ownership before activation.`;
  }

  if (resolutionState === 'disabled') {
    return `${packId}: enable the node pack before activation.`;
  }

  return '';
}

function summarizeNodePack(pack) {
  const validation = pack.validation && typeof pack.validation === 'object' ? pack.validation : {};
  const resolutionState = String(pack.resolutionState || validation.resolutionState || 'resolved').trim() || 'resolved';
  const validationStatus = String(pack.validationStatus || validation.status || (resolutionState === 'resolved' ? 'valid' : resolutionState)).trim();
  const validationOk = Object.prototype.hasOwnProperty.call(validation, 'ok')
    ? validation.ok === true
    : resolutionState === 'resolved';
  const blockedNextAction = blockedNextActionForNodePack(pack, validation, resolutionState);
  return {
    id: pack.id || '',
    name: pack.name || '',
    version: pack.version || '',
    origin: pack.origin || '',
    source: pack.discovery?.rootKind || pack.source || pack.origin || '',
    trustLevel: pack.trustLevel || '',
    capabilities: Array.isArray(pack.capabilities) ? pack.capabilities : [],
    capabilityRiskSummary: blockedNextAction
      ? `${resolutionState}: ${blockedNextAction}`
      : (resolutionState === 'resolved' ? 'no blocked activation action' : resolutionState),
    resolutionState,
    validationStatus,
    ...(blockedNextAction ? { blockedNextAction } : {}),
    validation: {
      ok: validationOk,
      resolutionState,
      status: validationStatus,
      diagnostics: Array.isArray(validation.diagnostics) ? validation.diagnostics : [],
    },
    nodeTypes: Array.isArray(pack.nodes)
      ? pack.nodes.map(node => String(node?.type || '').trim()).filter(Boolean)
      : [],
    graphs: Array.isArray(pack.graphs)
      ? pack.graphs.map(graph => ({ id: graph.id || '', path: graph.path || '', role: graph.role || '' }))
      : [],
    skills: Array.isArray(pack.skills)
      ? pack.skills.map(skill => ({ id: skill.id || '', path: skill.path || '' }))
      : [],
    rules: Array.isArray(pack.rules)
      ? pack.rules.map(rule => ({ id: rule.id || '', path: rule.path || '' }))
      : [],
    location: pack.discovery?.packDir || '',
    manifestPath: pack.discovery?.manifestPath || '',
  };
}

async function listNodePacks(args) {
  const discovered = discoverNodePackManifests(await nodePackDiscoveryOptionsFromArgs(args));
  return {
    success: true,
    ok: discovered.ok,
    command: 'node-packs list',
    roots: discovered.roots,
    nodePacks: discovered.nodePacks.map(summarizeNodePack),
    diagnostics: discovered.diagnostics,
    conflicts: discovered.conflicts,
  };
}

async function registryOptionsFromArgs(args) {
  const registry = args.registry || args['registry-file'] || args['registry-url'] || '';
  if (!registry) throw new Error('Missing --registry for node-packs registry command.');
  return {
    registry,
    userDataDir: args['user-data'] || '',
    timeoutMs: args['registry-timeout-ms'] ? Math.max(1, Number(args['registry-timeout-ms']) || 0) : undefined,
  };
}

async function nodePackInstallOptionsFromArgs(args) {
  const trustEvidenceByPack = await readJsonObjectOption(
    args,
    'node-pack-trust-evidence',
    'node-pack-trust-evidence-file',
  );
  const grantedCapabilitiesByPack = await readJsonObjectOption(
    args,
    'node-pack-granted-capabilities',
    'node-pack-granted-capabilities-file',
  );
  return {
    userDataDir: args['user-data'] || '',
    userNodePacksRoot: args['user-node-packs'] || '',
    currentOrpadVersion: args['current-orpad-version'],
    installMode: args['node-pack-install-mode'] || args['install-mode'] || 'normal',
    trustEvidenceByPack,
    grantedCapabilitiesByPack,
    registry: args.registry || args['registry-file'] || args['registry-url'] || '',
    timeoutMs: args['registry-timeout-ms'] ? Math.max(1, Number(args['registry-timeout-ms']) || 0) : undefined,
    installedBy: 'orpad-cli',
    pinned: args.pin === true || args.pinned === true,
    includePinned: args['include-pinned'] === true,
  };
}

function nodePackAuthoringOptionsFromArgs(args) {
  return {
    currentOrpadVersion: args['current-orpad-version'],
    installMode: args['node-pack-install-mode'] || args['install-mode'] || 'normal',
    sourceRepository: args['source-repository'] || args.repository || '',
    sourceRef: args['source-ref'] || args.ref || '',
    sourceRoot: args['source-root'] || '',
    manifestUrl: args['manifest-url'] || '',
    docsUrl: args['docs-url'] || args.docs || '',
    issuesUrl: args['issues-url'] || args.issues || '',
    changelogUrl: args['changelog-url'] || args.changelog || '',
    registryId: args['registry-id'] || '',
    registryName: args['registry-name'] || '',
    generatedAt: args['generated-at'] || '',
  };
}

function registryResultBase(args, sourceResult, command) {
  return {
    success: sourceResult.ok,
    ok: sourceResult.ok,
    command,
    registry: sourceResult.registry ? summarizeNodePackRegistry(sourceResult.registry) : null,
    source: sourceResult.source || args.registry || args['registry-file'] || args['registry-url'] || '',
    sourceKind: sourceResult.sourceKind || '',
    fromCache: sourceResult.fromCache === true,
    diagnostics: sourceResult.diagnostics || [],
  };
}

async function listNodePackRegistry(args) {
  const options = await registryOptionsFromArgs(args);
  const sourceResult = await loadNodePackRegistrySource(options.registry, options);
  return {
    ...registryResultBase(args, sourceResult, 'node-packs registry list'),
    entries: sourceResult.ok ? summarizeNodePackRegistry(sourceResult.registry).entries : [],
  };
}

async function searchNodePackRegistry(args) {
  const options = await registryOptionsFromArgs(args);
  const query = args._.slice(3).join(' ').trim() || args.query || '';
  if (!query) throw new Error('Missing registry search query.');
  const sourceResult = await loadNodePackRegistrySource(options.registry, options);
  const entries = sourceResult.ok
    ? searchNodePackRegistryEntries(sourceResult.entries, query, {
      category: splitOptionList(args.category || args.categories),
      capability: splitOptionList(args.capability || args.capabilities),
    })
    : [];
  return {
    ...registryResultBase(args, sourceResult, 'node-packs registry search'),
    query,
    entries,
  };
}

function printNodePacksResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write(`Discovered ${result.nodePacks.length} OrPAD node pack(s)\n`);
  for (const pack of result.nodePacks) {
    const scope = [pack.origin || 'unknown', pack.trustLevel || 'unknown'].join('/');
    const state = pack.resolutionState && pack.resolutionState !== 'resolved'
      ? ` [${pack.resolutionState}]`
      : '';
    const assets = [
      `${pack.nodeTypes.length} node(s)`,
      `${pack.graphs.length} graph(s)`,
      `${pack.skills.length} skill(s)`,
      `${pack.rules.length} rule(s)`,
    ].join(', ');
    process.stdout.write(`- ${pack.id}@${pack.version || '(no version)'}${state} (${scope}) - ${assets}\n`);
  }
  if (result.conflicts.length) {
    process.stdout.write(`\nConflicts: ${result.conflicts.length}\n`);
    for (const conflict of result.conflicts) {
      process.stdout.write(`- ${conflict.nodeType}: ${conflict.firstPackId} vs ${conflict.secondPackId}\n`);
    }
  }
  const warnings = result.diagnostics.filter(item => item.level !== 'error');
  if (warnings.length) {
    process.stdout.write(`\nDiagnostics: ${warnings.length}\n`);
    for (const item of warnings) {
      const scope = [item.packId, item.resolutionState].filter(Boolean).join(' ');
      process.stdout.write(`- ${item.code}${scope ? ` (${scope})` : ''}: ${item.message}\n`);
    }
  }
}

function printNodePackRegistryResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const registryName = result.registry?.name || result.source || 'node pack registry';
  const cacheText = result.fromCache ? ' (cached)' : '';
  process.stdout.write(`${registryName}${cacheText}: ${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'}\n`);
  if (result.query) process.stdout.write(`Query: ${result.query}\n`);
  for (const entry of result.entries) {
    const tags = [
      entry.trustLevel || 'community',
      entry.latestVersion ? `latest ${entry.latestVersion}` : '',
      entry.categories?.length ? entry.categories.join(', ') : '',
    ].filter(Boolean).join(' / ');
    process.stdout.write(`- ${entry.id} - ${entry.name}${tags ? ` (${tags})` : ''}\n`);
    if (entry.description) process.stdout.write(`  ${entry.description}\n`);
    if (entry.sourceRepository) process.stdout.write(`  ${entry.sourceRepository}\n`);
  }
  const warnings = (result.diagnostics || []).filter(item => item.level !== 'error');
  if (warnings.length) {
    process.stdout.write(`\nDiagnostics: ${warnings.length}\n`);
    for (const item of warnings) process.stdout.write(`- ${item.code}: ${item.message}\n`);
  }
}

function printNodePackInstallResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const state = result.success ? 'succeeded' : 'failed';
  process.stdout.write(`Node pack ${result.action || 'install'} ${state}\n`);
  if (result.nodePack) {
    const pack = summarizeNodePack(result.nodePack);
    process.stdout.write(`- ${pack.id}@${pack.version || '(no version)'} (${pack.resolutionState || 'unknown'})\n`);
    if (pack.location || result.installedPath) {
      process.stdout.write(`  ${pack.location || result.installedPath}\n`);
    }
  }
  if (result.lockPath) process.stdout.write(`Lock: ${result.lockPath}\n`);
  if (result.backupPath) process.stdout.write(`Backup: ${result.backupPath}\n`);
  const diagnostics = result.diagnostics || [];
  if (diagnostics.length) {
    process.stdout.write(`\nDiagnostics: ${diagnostics.length}\n`);
    for (const item of diagnostics) {
      const scope = [item.packId, item.nodeType, item.filePath, item.resolutionState].filter(Boolean).join(' ');
      process.stdout.write(`- ${item.code}${scope ? ` (${scope})` : ''}: ${item.message}\n`);
    }
  }
}

function printNodePackUpdateResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.action === 'update-candidates') {
    process.stdout.write(`Node pack update candidates: ${(result.candidates || []).length}\n`);
  } else {
    process.stdout.write(`Node pack update ${result.success ? 'succeeded' : 'failed'}\n`);
  }
  for (const candidate of result.candidates || []) {
    const state = candidate.updateAvailable
      ? (candidate.skipped ? `skipped:${candidate.reason}` : 'available')
      : 'current';
    process.stdout.write(`- ${candidate.id}: ${candidate.installedVersion || '(unknown)'} -> ${candidate.latestVersion || '(none)'} [${state}]\n`);
  }
  for (const item of result.results || []) {
    process.stdout.write(`- ${item.action || 'update'} ${item.success ? 'ok' : 'failed'}${item.nodePack?.id ? `: ${item.nodePack.id}` : ''}\n`);
  }
  const diagnostics = result.diagnostics || [];
  if (diagnostics.length) {
    process.stdout.write(`\nDiagnostics: ${diagnostics.length}\n`);
    for (const item of diagnostics) process.stdout.write(`- ${item.code}: ${item.message}\n`);
  }
}

function printNodePackExportResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write(`Installed node pack export: ${(result.packs || []).length} pack${(result.packs || []).length === 1 ? '' : 's'}\n`);
  if (result.lockPath) process.stdout.write(`Lock: ${result.lockPath}\n`);
  for (const pack of result.packs || []) {
    const flags = [
      pack.enabled === false ? 'disabled' : 'enabled',
      pack.pinned === true ? 'pinned' : '',
      pack.source || '',
    ].filter(Boolean).join(', ');
    process.stdout.write(`- ${pack.id}@${pack.version || '(unknown)'}${flags ? ` (${flags})` : ''}\n`);
  }
}

function printNodePackAuthoringResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const state = result.success ? 'succeeded' : 'failed';
  process.stdout.write(`Node pack ${result.action || 'authoring'} ${state}\n`);
  const pack = result.pack || (result.nodePack ? {
    id: result.nodePack.id,
    version: result.nodePack.version,
    name: result.nodePack.name,
  } : null);
  if (pack) {
    process.stdout.write(`- ${pack.id || '(missing id)'}@${pack.version || '(missing version)'}${pack.name ? ` - ${pack.name}` : ''}\n`);
  }
  if (result.readme) process.stdout.write(`README: ${result.readme.exists ? result.readme.path : 'missing'}\n`);
  if (Array.isArray(result.declaredFiles)) process.stdout.write(`Declared files: ${result.declaredFiles.length}\n`);
  if (result.entry) {
    process.stdout.write('\nDraft registry entry:\n');
    process.stdout.write(`${JSON.stringify(result.entry, null, 2)}\n`);
  }
  const diagnostics = result.diagnostics || [];
  if (diagnostics.length) {
    process.stdout.write(`\nDiagnostics: ${diagnostics.length}\n`);
    for (const item of diagnostics) {
      const scope = [item.packId, item.capability, item.filePath, item.path].filter(Boolean).join(' ');
      process.stdout.write(`- ${item.code}${scope ? ` (${scope})` : ''}: ${item.message}\n`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || '';
  if (args.help || !command) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === 'node-packs') {
    const subcommand = args._[1] || 'list';
    if (subcommand === 'list') {
      printNodePacksResult(await listNodePacks(args), !!args.json);
      return;
    }
    if (subcommand === 'registry') {
      const registryCommand = args._[2] || 'list';
      if (registryCommand === 'list') {
        const result = await listNodePackRegistry(args);
        printNodePackRegistryResult(result, !!args.json);
        if (!result.success) process.exitCode = 1;
        return;
      }
      if (registryCommand === 'search') {
        const result = await searchNodePackRegistry(args);
        printNodePackRegistryResult(result, !!args.json);
        if (!result.success) process.exitCode = 1;
        return;
      }
      throw new Error(`Unknown node-packs registry command: ${registryCommand}`);
    }
    if (subcommand === 'install') {
      const packId = args._[2] || args.id || args.pack || '';
      if (!packId) throw new Error('Missing node pack id for node-packs install.');
      const options = await nodePackInstallOptionsFromArgs(args);
      const result = await installRegistryNodePack({
        registry: options.registry,
        packId,
        version: args.version || '',
        pinned: args.pin === true || args.pinned === true,
      }, options);
      printNodePackInstallResult(result, !!args.json);
      if (!result.success) process.exitCode = 1;
      return;
    }
    if (subcommand === 'update') {
      const packId = args._[2] || args.id || args.pack || '';
      const options = await nodePackInstallOptionsFromArgs(args);
      const request = {
        registry: options.registry,
        packId,
        includePinned: args['include-pinned'] === true,
      };
      const result = args['dry-run']
        ? await listNodePackUpdateCandidates(request, options)
        : await updateInstalledNodePacks(request, options);
      printNodePackUpdateResult(result, !!args.json);
      if (!result.success) process.exitCode = 1;
      return;
    }
    if (subcommand === 'rollback') {
      const packId = args._[2] || args.id || args.pack || '';
      if (!packId) throw new Error('Missing node pack id for node-packs rollback.');
      const result = await rollbackInstalledNodePack(packId, await nodePackInstallOptionsFromArgs(args));
      printNodePackInstallResult(result, !!args.json);
      if (!result.success) process.exitCode = 1;
      return;
    }
    if (subcommand === 'validate') {
      const folder = args._[2] || args.folder || args.path || '';
      if (!folder) throw new Error('Missing folder for node-packs validate.');
      const result = await validateNodePackFolder(folder, nodePackAuthoringOptionsFromArgs(args));
      printNodePackAuthoringResult(result, !!args.json);
      if (!result.success) process.exitCode = 1;
      return;
    }
    if (subcommand === 'pack-manifest') {
      const manifestCommand = args._[2] || 'check';
      if (manifestCommand !== 'check') throw new Error(`Unknown node-packs pack-manifest command: ${manifestCommand}`);
      const folder = args._[3] || args.folder || args.path || '';
      if (!folder) throw new Error('Missing folder for node-packs pack-manifest check.');
      const result = await validateNodePackFolder(folder, nodePackAuthoringOptionsFromArgs(args));
      printNodePackAuthoringResult(result, !!args.json);
      if (!result.success) process.exitCode = 1;
      return;
    }
    if (subcommand === 'registry-entry') {
      const registryEntryCommand = args._[2] || 'create';
      if (registryEntryCommand !== 'create') throw new Error(`Unknown node-packs registry-entry command: ${registryEntryCommand}`);
      const folder = args._[3] || args.folder || args.path || '';
      if (!folder) throw new Error('Missing folder for node-packs registry-entry create.');
      const result = await createNodePackRegistryEntryDraft(folder, nodePackAuthoringOptionsFromArgs(args));
      printNodePackAuthoringResult(result, !!args.json);
      if (!result.success) process.exitCode = 1;
      return;
    }
    if (subcommand === 'install-local') {
      const folder = args._[2] || args.folder || args.path || '';
      if (!folder) throw new Error('Missing folder for node-packs install-local.');
      const result = await installLocalNodePack(folder, await nodePackInstallOptionsFromArgs(args));
      printNodePackInstallResult(result, !!args.json);
      if (!result.success) process.exitCode = 1;
      return;
    }
    if (subcommand === 'enable' || subcommand === 'disable') {
      const packId = args._[2] || args.id || args.pack || '';
      if (!packId) throw new Error(`Missing node pack id for node-packs ${subcommand}.`);
      const result = await setInstalledNodePackEnabled(
        packId,
        subcommand === 'enable',
        await nodePackInstallOptionsFromArgs(args),
      );
      printNodePackInstallResult(result, !!args.json);
      if (!result.success) process.exitCode = 1;
      return;
    }
    if (subcommand === 'remove') {
      const packId = args._[2] || args.id || args.pack || '';
      if (!packId) throw new Error('Missing node pack id for node-packs remove.');
      const result = await removeInstalledNodePack(packId, await nodePackInstallOptionsFromArgs(args));
      printNodePackInstallResult(result, !!args.json);
      if (!result.success) process.exitCode = 1;
      return;
    }
    if (subcommand === 'export-list') {
      const result = await exportInstalledNodePackList(await nodePackInstallOptionsFromArgs(args));
      printNodePackExportResult(result, !!args.json);
      if (!result.success) process.exitCode = 1;
      return;
    }
    if (subcommand !== 'list') {
      throw new Error(`Unknown node-packs command: ${subcommand}`);
    }
  }
  if (command !== 'generate' && command !== 'generate-orchestration') {
    throw new Error(`Unknown command: ${command}`);
  }
  if (!args.workspace) {
    throw new Error('Missing --workspace');
  }
  const prompt = await readPrompt(args);
  if (!prompt.trim()) {
    throw new Error('Missing --prompt, --prompt-file, or stdin prompt');
  }
  const workspaceSnapshot = await collectWorkspaceSnapshot(args.workspace);
  const nodePackOptions = await generateNodePackOptions(args);
  const {
    createOrchestrationPipeline,
    orchestrationAuthoringSpecPrompt,
  } = loadGeneratorModule();
  if (args['emit-authoring-prompt']) {
    process.stdout.write(`${orchestrationAuthoringSpecPrompt(prompt, workspaceSnapshot, nodePackOptions)}\n`);
    return;
  }
  const authoringSpec = await readAuthoringSpec(args);
  const result = await createOrchestrationPipeline({
    workspaceRoot: args.workspace,
    prompt,
    authoringSpec,
    timestamp: args.timestamp,
    workspaceSnapshot,
    ...nodePackOptions,
  });
  printResult(result, !!args.json);
}

main().catch((err) => {
  const json = process.argv.includes('--json');
  if (json) {
    process.stdout.write(`${JSON.stringify({ success: false, ok: false, error: err?.message || String(err) })}\n`);
  } else {
    process.stderr.write(`${err?.message || err}\n\n${usage()}\n`);
  }
  process.exitCode = 1;
});
