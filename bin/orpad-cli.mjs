#!/usr/bin/env node
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  discoverNodePackManifests,
} = require('../src/main/orchestration-machine/node-packs.js');

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
    '',
    'Commands:',
    '  generate          Define an OrPAD orchestration package for the prompt.',
    '  node-packs list   List discovered built-in and user node packs.',
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
    if (['json', 'help', 'emit-authoring-prompt'].includes(key)) {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || '';
  if (args.help || !command) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === 'node-packs') {
    const subcommand = args._[1] || 'list';
    if (subcommand !== 'list') {
      throw new Error(`Unknown node-packs command: ${subcommand}`);
    }
    printNodePacksResult(await listNodePacks(args), !!args.json);
    return;
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
