#!/usr/bin/env node
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  createOrchestrationPipeline,
  orchestrationAuthoringSpecPrompt,
  parseAuthoringSpecText,
} = require('../src/main/orchestration-authoring/generator.js');
const {
  discoverNodePackManifests,
} = require('../src/main/orchestration-machine/node-packs.js');

function usage() {
  return [
    'Usage:',
    '  orpad generate --workspace <path> --prompt <text> [--authoring-spec-file <file>] [--json]',
    '  orpad generate --workspace <path> --prompt-file <file> [--authoring-spec-file <file>] [--json]',
    '  orpad generate --workspace <path> --prompt <text> --emit-authoring-prompt',
    '  orpad node-packs list [--user-node-packs <path>] [--user-data <path>] [--json]',
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
  const file = args['authoring-spec-file'] || args['spec-file'];
  if (file) return parseAuthoringSpecText(await fs.readFile(file, 'utf-8'));
  if (args['authoring-spec']) return parseAuthoringSpecText(args['authoring-spec']);
  return null;
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

function summarizeNodePack(pack) {
  return {
    id: pack.id || '',
    name: pack.name || '',
    version: pack.version || '',
    origin: pack.origin || '',
    trustLevel: pack.trustLevel || '',
    capabilities: Array.isArray(pack.capabilities) ? pack.capabilities : [],
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

function listNodePacks(args) {
  const discovered = discoverNodePackManifests({
    builtInNodePacksRoot: args['built-in-root'] || undefined,
    userDataDir: args['user-data'] || '',
    userNodePacksRoot: args['user-node-packs'] || '',
  });
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
    const assets = [
      `${pack.nodeTypes.length} node(s)`,
      `${pack.graphs.length} graph(s)`,
      `${pack.skills.length} skill(s)`,
      `${pack.rules.length} rule(s)`,
    ].join(', ');
    process.stdout.write(`- ${pack.id}@${pack.version || '(no version)'} (${scope}) - ${assets}\n`);
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
      process.stdout.write(`- ${item.code}: ${item.message}\n`);
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
    printNodePacksResult(listNodePacks(args), !!args.json);
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
  if (args['emit-authoring-prompt']) {
    process.stdout.write(`${orchestrationAuthoringSpecPrompt(prompt, workspaceSnapshot)}\n`);
    return;
  }
  const authoringSpec = await readAuthoringSpec(args);
  const result = await createOrchestrationPipeline({
    workspaceRoot: args.workspace,
    prompt,
    authoringSpec,
    timestamp: args.timestamp,
    workspaceSnapshot,
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
