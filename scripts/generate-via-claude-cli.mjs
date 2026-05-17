#!/usr/bin/env node
// Offline harness for the OrPAD Generate authoring path.
//
// Drives the same authoringAgentPrompt + claude/codex CLI + in-process
// generator flow that src/main/orchestration-authoring/ipc.js does, but
// without Electron / IPC. Lets us iterate on the prompt and the generator
// from the terminal until the produced pipeline is satisfactory, and
// cross-check the two CLI authoring agents against each other.
//
// Usage:
//   node scripts/generate-via-claude-cli.mjs --workspace <path> --prompt-file <path> [--out <dir>] [--provider claude|codex]
//   node scripts/generate-via-claude-cli.mjs --workspace <path> --prompt "<text>"  [--out <dir>] [--provider claude|codex]

import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const {
  authoringAgentPrompt,
  collectWorkspaceSnapshot,
  loadAuthoringSpecFromSources,
  materializePipelineFromAuthoringSpec,
  unwrapClaudeCliResult,
  extractJsonText,
} = require(path.join(repoRoot, 'src/main/orchestration-authoring/ipc.js'));

const {
  claudeCodeCommand,
  claudeCodeExecArgs,
  claudeCodeInvocation,
} = require(path.join(repoRoot, 'src/main/orchestration-machine/providers/plugins/claude-code.js'));

const {
  codexCliCommand,
  codexCliExecArgs,
  codexCliInvocation,
} = require(path.join(repoRoot, 'src/main/orchestration-machine/providers/plugins/codex-cli.js'));

const { runMachineProcess } = require(path.join(
  repoRoot,
  'src/main/orchestration-machine/adapters/process-runner.js',
));

function parseArgs(argv) {
  const args = { out: '', workspace: '', prompt: '', promptFile: '', provider: 'claude' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--workspace') { args.workspace = next; i += 1; }
    else if (arg === '--prompt') { args.prompt = next; i += 1; }
    else if (arg === '--prompt-file') { args.promptFile = next; i += 1; }
    else if (arg === '--out') { args.out = next; i += 1; }
    else if (arg === '--provider') { args.provider = next; i += 1; }
  }
  if (!['claude', 'codex'].includes(args.provider)) {
    throw new Error(`--provider must be "claude" or "codex" (got "${args.provider}")`);
  }
  return args;
}

async function readPromptText(args) {
  if (args.prompt) return args.prompt;
  if (args.promptFile) return (await fs.readFile(args.promptFile, 'utf-8')).trim();
  throw new Error('Provide --prompt or --prompt-file.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.workspace) throw new Error('Provide --workspace <path>.');
  const workspaceRoot = path.resolve(args.workspace);
  const prompt = await readPromptText(args);

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').toLowerCase();
  const outRoot = path.resolve(args.out || path.join(os.tmpdir(), `orpad-generate-harness-${stamp}`));
  const authoringRoot = path.join(outRoot, 'authoring');
  await fs.mkdir(authoringRoot, { recursive: true });

  const promptFile = path.join(authoringRoot, 'user-request.txt');
  const authoringSpecPath = path.join(authoringRoot, 'authoring-spec.json');
  const outputLastMessagePath = path.join(authoringRoot, 'authoring-agent-result.json');
  await fs.writeFile(promptFile, `${prompt}\n`, 'utf-8');

  console.error(`[harness] workspace = ${workspaceRoot}`);
  console.error(`[harness] outRoot   = ${outRoot}`);
  console.error('[harness] collecting workspace snapshot…');
  const snapshot = await collectWorkspaceSnapshot(workspaceRoot);
  console.error(`[harness] snapshot files: ${snapshot.files.length}`);

  const appRoot = repoRoot;
  const cliPath = path.join(appRoot, 'bin', 'orpad-cli.mjs');
  const agentPrompt = authoringAgentPrompt({
    workspaceRoot,
    appRoot,
    cliPath,
    promptFile,
    authoringSpecPath,
    prompt,
    snapshot,
  });

  await fs.writeFile(path.join(authoringRoot, 'authoring-agent-prompt.txt'), agentPrompt, 'utf-8');
  console.error(`[harness] agent prompt length: ${agentPrompt.length} chars`);

  let invocation;
  let args2;
  let startedAt;
  let processResult;
  if (args.provider === 'claude') {
    invocation = claudeCodeInvocation(claudeCodeCommand(), []);
    console.error(`[harness] invoking claude (${invocation.command}, prefixArgs: ${JSON.stringify(invocation.prefixArgs)})`);
    args2 = claudeCodeExecArgs({
      prefixArgs: invocation.prefixArgs,
      outputFormat: 'json',
      dangerouslySkipPermissions: false,
      prompt: agentPrompt,
    });
    startedAt = Date.now();
    processResult = await runMachineProcess({
      command: invocation.command,
      args: args2,
      cwd: workspaceRoot,
      timeoutMs: 10 * 60 * 1000,
      maxOutputBytes: 4 * 1024 * 1024,
      processKey: `harness:generate-via-claude-cli:${stamp}`,
    });
  } else {
    invocation = codexCliInvocation(codexCliCommand(), []);
    console.error(`[harness] invoking codex (${invocation.command}, prefixArgs: ${JSON.stringify(invocation.prefixArgs)})`);
    // Use read-only sandbox so codex emits the spec to stdout instead of trying
    // to write it via PowerShell (which fails on Windows sandbox with
    // CreateProcessAsUserW error 206). The harness picks the spec up from
    // outputLastMessagePath (--output-last-message) and the in-process
    // generator materializes the pipeline.
    const baseArgs = codexCliExecArgs({
      prefixArgs: invocation.prefixArgs,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      outputLastMessagePath,
      prompt: agentPrompt,
      ephemeral: true,
      json: false,
      cd: workspaceRoot,
    });
    // codexCliExecArgs places the prompt at the very end. Splice
    // reasoning_effort just before the prompt so codex finishes faster.
    args2 = [...baseArgs.slice(0, -1), '-c', "model_reasoning_effort='medium'", baseArgs[baseArgs.length - 1]];
    startedAt = Date.now();
    processResult = await runMachineProcess({
      command: invocation.command,
      args: args2,
      cwd: workspaceRoot,
      timeoutMs: 15 * 60 * 1000,
      maxOutputBytes: 4 * 1024 * 1024,
      processKey: `harness:generate-via-codex-cli:${stamp}`,
    });
  }
  console.error(`[harness] ${args.provider} exited code=${processResult.code} timedOut=${processResult.timedOut} ms=${Date.now() - startedAt}`);

  if (args.provider === 'claude') {
    // claude has no --output-last-message; capture stdout ourselves.
    await fs.writeFile(outputLastMessagePath, processResult.stdout || '', 'utf-8');
  }
  if (processResult.stderr) {
    await fs.writeFile(path.join(authoringRoot, 'authoring-agent-stderr.txt'), processResult.stderr, 'utf-8');
  }
  if (processResult.code !== 0 || processResult.timedOut) {
    throw new Error(`${args.provider} CLI failed: code=${processResult.code} timedOut=${processResult.timedOut} stderr=${(processResult.stderr || '').slice(0, 400)}`);
  }

  // For codex, the canonical output is the file at outputLastMessagePath
  // (set via --output-last-message). For claude, it's just stdout. Try both.
  let rawOutput = '';
  try { rawOutput = await fs.readFile(outputLastMessagePath, 'utf-8'); } catch {}
  if (!rawOutput.trim()) rawOutput = processResult.stdout || '';
  const unwrapped = args.provider === 'claude'
    ? unwrapClaudeCliResult(rawOutput)
    : rawOutput;
  let generated = null;
  let parseError = null;
  try {
    generated = JSON.parse(extractJsonText(unwrapped));
  } catch (err) {
    parseError = err;
  }

  let usedFallback = false;
  if (!generated || (!generated.success && Array.isArray(generated.graph?.nodes))) {
    // The model emitted an authoring spec instead of an OrPAD CLI response.
    // Materialize via the in-process generator.
    const spec = await loadAuthoringSpecFromSources({
      stdoutSource: unwrapped,
      authoringSpecPath,
    });
    if (!spec) {
      throw new Error(`Could not parse CLI JSON or authoring spec. parseError=${parseError?.message} stdout=${unwrapped.slice(0, 400)}`);
    }
    console.error('[harness] using in-process generator with spec from stdout/disk');
    usedFallback = true;
    generated = await materializePipelineFromAuthoringSpec({
      workspaceRoot,
      prompt,
      authoringSpec: spec,
    });
  }

  if (!generated?.success) {
    throw new Error(`Generator returned failure: ${generated?.error || JSON.stringify(generated).slice(0, 400)}`);
  }

  const report = {
    workspaceRoot,
    outRoot,
    authoringRoot,
    usedFallback,
    pipelinePath: generated.pipelinePath,
    graphPath: generated.graphPath,
    graphComplexity: generated.graphComplexity,
  };
  await fs.writeFile(path.join(outRoot, 'harness-report.json'), JSON.stringify(report, null, 2), 'utf-8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error(`[harness] ERROR: ${err.message}`);
  process.exit(1);
});
