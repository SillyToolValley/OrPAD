#!/usr/bin/env node
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';

const require = createRequire(import.meta.url);
const {
  createOrchestrationPipeline,
  orchestrationAuthoringSpecPrompt,
  parseAuthoringSpecText,
} = require('../src/main/orchestration-authoring/generator.js');

function usage() {
  return [
    'Usage:',
    '  orpad generate --workspace <path> --prompt <text> [--authoring-spec-file <file>] [--json]',
    '  orpad generate --workspace <path> --prompt-file <file> [--authoring-spec-file <file>] [--json]',
    '  orpad generate --workspace <path> --prompt <text> --emit-authoring-prompt',
    '',
    'Commands:',
    '  generate    Define an OrPAD orchestration package for the prompt.',
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

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write(`Generated OrPAD pipeline: ${result.pipelinePath}\n`);
  process.stdout.write(`Entry graph: ${result.graphPath}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || '';
  if (args.help || !command) {
    process.stdout.write(`${usage()}\n`);
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
  if (args['emit-authoring-prompt']) {
    process.stdout.write(`${orchestrationAuthoringSpecPrompt(prompt)}\n`);
    return;
  }
  const authoringSpec = await readAuthoringSpec(args);
  const result = await createOrchestrationPipeline({
    workspaceRoot: args.workspace,
    prompt,
    authoringSpec,
    timestamp: args.timestamp,
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
