#!/usr/bin/env node
// Direct codex CLI runner for non-authoring prompts (review/research/etc.).
// The generate-via-claude-cli harness is hard-wired to the OrPAD authoring
// spec contract; this script just shells out to `codex exec` with a raw
// prompt and writes the response to disk.

import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const {
  codexCliCommand,
  codexCliInvocation,
  codexCliExecArgs,
} = require(path.join(repoRoot, 'src/main/orchestration-machine/providers/plugins/codex-cli.js'));

const { runMachineProcess } = require(path.join(
  repoRoot,
  'src/main/orchestration-machine/adapters/process-runner.js',
));

function parseArgs(argv) {
  const args = { promptFile: '', out: '', workspace: '', reasoning: 'medium', timeoutMin: 15 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--prompt-file') { args.promptFile = next; i += 1; }
    else if (arg === '--out') { args.out = next; i += 1; }
    else if (arg === '--workspace') { args.workspace = next; i += 1; }
    else if (arg === '--reasoning') { args.reasoning = next; i += 1; }
    else if (arg === '--timeout-min') { args.timeoutMin = Number(next) || 15; i += 1; }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.promptFile) throw new Error('--prompt-file required');
  if (!args.out) throw new Error('--out required');
  if (!args.workspace) throw new Error('--workspace required');
  const prompt = await fs.readFile(args.promptFile, 'utf-8');
  await fs.mkdir(args.out, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').toLowerCase();
  const outputLastMessagePath = path.join(args.out, `codex-response-${stamp}.txt`);
  const stderrPath = path.join(args.out, `codex-stderr-${stamp}.txt`);

  const invocation = codexCliInvocation(codexCliCommand(), []);
  const baseArgs = codexCliExecArgs({
    prefixArgs: invocation.prefixArgs,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    outputLastMessagePath,
    prompt,
    ephemeral: true,
    json: false,
    cd: args.workspace,
  });
  const finalArgs = [...baseArgs.slice(0, -1), '-c', `model_reasoning_effort='${args.reasoning}'`, baseArgs[baseArgs.length - 1]];

  console.error(`[codex-raw] invoking codex (${invocation.command})`);
  console.error(`[codex-raw] workspace=${args.workspace}`);
  console.error(`[codex-raw] reasoning=${args.reasoning} timeoutMin=${args.timeoutMin}`);
  console.error(`[codex-raw] prompt length: ${prompt.length} chars`);

  const startedAt = Date.now();
  const processResult = await runMachineProcess({
    command: invocation.command,
    args: finalArgs,
    cwd: args.workspace,
    timeoutMs: args.timeoutMin * 60 * 1000,
    maxOutputBytes: 8 * 1024 * 1024,
    processKey: `codex-raw:${stamp}`,
  });
  console.error(`[codex-raw] exit code=${processResult.code} timedOut=${processResult.timedOut} ms=${Date.now() - startedAt}`);
  if (processResult.stderr) await fs.writeFile(stderrPath, processResult.stderr, 'utf-8');
  if (processResult.code !== 0 || processResult.timedOut) {
    throw new Error(`codex failed: code=${processResult.code} timedOut=${processResult.timedOut} stderr=${(processResult.stderr || '').slice(0, 400)}`);
  }

  let answer = '';
  try { answer = await fs.readFile(outputLastMessagePath, 'utf-8'); } catch {}
  if (!answer.trim()) answer = processResult.stdout || '';
  console.log(JSON.stringify({ outputPath: outputLastMessagePath, stderrPath, length: answer.length }, null, 2));
}

main().catch(err => {
  console.error(`[codex-raw] ERROR: ${err.message}`);
  process.exit(1);
});
