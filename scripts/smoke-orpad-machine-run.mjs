#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const execFileP = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  createMachineRun,
  executeMachineRunStep,
  findQueueItem,
} = require('../src/main/orchestration-machine');
const { validateRunbookFile } = require('../src/main/runbooks/validator');

const DEFAULT_MARKER = 'after from OrPAD Machine smoke adapter';

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    adapter: 'node-cli',
    approveDangerousBypass: false,
    codexCommand: 'codex',
    codexBypassSandbox: false,
    json: false,
    keep: false,
    marker: DEFAULT_MARKER,
    timeoutMs: 300_000,
    workspaceRoot: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--adapter') options.adapter = argv[++index] || options.adapter;
    else if (arg === '--approve-dangerous-bypass') options.approveDangerousBypass = true;
    else if (arg === '--codex-cli') options.adapter = 'codex-cli';
    else if (arg === '--codex-bypass-sandbox') options.codexBypassSandbox = true;
    else if (arg === '--codex-command') options.codexCommand = argv[++index] || options.codexCommand;
    else if (arg === '--json') options.json = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--marker') options.marker = argv[++index] || options.marker;
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++index]) || options.timeoutMs;
    else if (arg === '--workspace') options.workspaceRoot = argv[++index] || options.workspaceRoot;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/smoke-orpad-machine-run.mjs [--adapter node-cli|codex-cli] [--codex-bypass-sandbox --approve-dangerous-bypass] [--keep] [--json]',
    '',
    'Creates a temporary .or-pipeline, runs the Orchestration Machine queue/dispatcher/worker loop,',
    'executes the CLI adapter in an overlay, exports latest-run evidence, and audits the run.',
    'Codex dangerous sandbox bypass requires --approve-dangerous-bypass and uses a system temp overlay.',
  ].join('\n');
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeMachineSmokeWorkspace(options = {}) {
  const workspaceRoot = options.workspaceRoot
    ? path.resolve(options.workspaceRoot)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-smoke-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad', 'pipelines', 'machine-smoke-workstream');
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  const graphPath = path.join(pipelineDir, 'graphs', 'main.or-graph');
  const targetPath = path.join(workspaceRoot, 'src', 'smoke-target.md');

  await fs.mkdir(path.dirname(graphPath), { recursive: true });
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, 'before from OrPAD Machine smoke workspace\n', 'utf8');

  await writeJson(graphPath, {
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'machine-smoke-workstream',
      nodes: [
        { id: 'context', type: 'orpad.context', label: 'Context', config: { summary: 'Prepare smoke context.' } },
        { id: 'probe', type: 'orpad.probe', label: 'Probe', config: { queueRef: 'queue', lens: 'smoke' } },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', label: 'Triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Worker', config: { queueRef: 'queue', adapter: 'cli-agent-overlay' } },
        { id: 'artifact', type: 'orpad.artifactContract', label: 'Artifact Contract', config: { manifest: 'harness/generated/latest-run/run-metadata.json' } },
      ],
      transitions: [
        { from: 'context', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'artifact' },
      ],
    },
  });

  await writeJson(pipelinePath, {
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'machine-smoke-workstream',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    nodePacks: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3', origin: 'built-in' },
      { id: 'orpad.workstream', version: '>=0.1.0', origin: 'built-in' },
    ],
    run: {
      artifactRoot: 'harness/generated/latest-run/artifacts',
      queueRoot: 'harness/generated/latest-run/queue',
      queueProtocol: {
        schema: 'orpad.workItem.v1',
        states: ['candidate', 'queued', 'claimed', 'done', 'blocked', 'rejected'],
      },
      metadataPath: 'harness/generated/latest-run/run-metadata.json',
      summaryPath: 'harness/generated/latest-run/summary.md',
      machineHarness: {
        candidateProposal: smokeCandidateProposal(),
        expectedChangedFiles: ['src/smoke-target.md'],
        nodeCliPatch: {
          file: 'src/smoke-target.md',
          content: `${options.marker}\n`,
        },
      },
    },
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
  });

  return {
    workspaceRoot,
    pipelineDir,
    pipelinePath,
    graphPath,
    targetPath,
    createdWorkspace: !options.workspaceRoot,
  };
}

function smokeCandidateProposal() {
  return {
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: 'proposal-machine-smoke-target',
    suggestedWorkItemId: 'machine-smoke-target',
    sourceNode: 'main/probe',
    title: 'Exercise Machine-owned CLI worker overlay',
    fingerprint: 'machine-smoke:src/smoke-target.md',
    contentArea: 'orchestration-machine',
    issueType: 'smoke-validation',
    severity: 'P3',
    confidence: 0.95,
    evidence: [{
      id: 'smoke-target-before',
      file: 'src/smoke-target.md',
      excerpt: 'before from OrPAD Machine smoke workspace',
    }],
    acceptanceCriteria: ['The Machine stores a patch artifact for src/smoke-target.md and leaves the canonical workspace unchanged.'],
    sourceOfTruthTargets: ['src/smoke-target.md'],
    verificationPlan: 'Run scripts/audit-orpad-machine-run.mjs against the durable run and latest-run export.',
  };
}

async function defaultCodexCommandPrefix(codexCommand = 'codex') {
  if (codexCommand !== 'codex') return { command: codexCommand, argsPrefix: [] };
  if (process.platform !== 'win32') return { command: codexCommand, argsPrefix: [] };

  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const codexJs = path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  try {
    await fs.access(codexJs);
    return { command: process.execPath, argsPrefix: [codexJs] };
  } catch {
    return { command: codexCommand, argsPrefix: [] };
  }
}

async function codexCliCommandSpec(options, cwd) {
  const prompt = [
    'You are running inside an OrPAD Machine overlay workspace.',
    'Edit exactly one file: src/smoke-target.md.',
    'Replace the complete file contents with exactly this single line, followed by one newline:',
    options.marker,
    'Do not create, rename, delete, or modify any other file.',
    'Do not modify .orpad, queue, run-state, or artifact files.',
    'Finish immediately after the edit.',
  ].join('\n');
  const commandPrefix = await defaultCodexCommandPrefix(options.codexCommand || 'codex');
  return {
    command: commandPrefix.command,
    args: [
      ...commandPrefix.argsPrefix,
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      ...(options.codexBypassSandbox
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['--sandbox', 'workspace-write']),
      prompt,
    ],
    cwd,
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function runAudit(runRoot, latestRunExportRoot) {
  const { stdout } = await execFileP(process.execPath, [
    path.join(repoRoot, 'scripts', 'audit-orpad-machine-run.mjs'),
    runRoot,
    latestRunExportRoot,
  ], {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024 * 8,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

function assertSmoke(condition, message, details = {}) {
  if (condition) return;
  const err = new Error(message);
  err.details = details;
  throw err;
}

async function runMachineSmoke(input = {}) {
  const options = {
    ...parseArgs([]),
    ...input,
  };
  const workspace = await writeMachineSmokeWorkspace(options);
  let cleanup = workspace.createdWorkspace && !options.keep;
  try {
    const validation = await validateRunbookFile(workspace.pipelinePath, {
      trustLevel: 'local-authored',
      checkFiles: true,
    });
    assertSmoke(validation.ok, 'Smoke pipeline validation failed.', { diagnostics: validation.diagnostics });
    assertSmoke(validation.canMachineExecute === true, 'Smoke pipeline is not Machine-executable.', {
      machineBlockedReasons: validation.machineBlockedReasons,
      diagnostics: validation.diagnostics,
    });

    const run = await createMachineRun({
      workspaceRoot: workspace.workspaceRoot,
      pipelinePath: workspace.pipelinePath,
    });
    const candidate = smokeCandidateProposal();
    const executed = await executeMachineRunStep({
      workspaceRoot: workspace.workspaceRoot,
      pipelinePath: workspace.pipelinePath,
      pipelineDir: workspace.pipelineDir,
      runRoot: run.runRoot,
      runId: run.runId,
      nodeExecutable: process.execPath,
      timeoutMs: options.timeoutMs,
      overlayRootMode: options.adapter === 'codex-cli' && options.codexBypassSandbox ? 'system-temp' : 'run-root',
      allowDangerousSandboxBypass: options.adapter === 'codex-cli'
        && options.codexBypassSandbox
        && options.approveDangerousBypass,
      dangerousSandboxBypassApproval: options.adapter === 'codex-cli' && options.codexBypassSandbox
        ? {
          approved: options.approveDangerousBypass === true,
          reason: options.approveDangerousBypass
            ? 'explicit smoke approval for Codex dangerous sandbox bypass in a system temp overlay'
            : '',
        }
        : null,
      createWorkerCommandSpec: options.adapter === 'codex-cli'
        ? ({ overlayRoot }) => codexCliCommandSpec(options, overlayRoot)
        : null,
    });
    const worker = executed.worker;
    const workerEvent = worker.result?.event;
    const patchArtifact = workerEvent?.payload?.patchArtifact || '';
    const patch = patchArtifact ? await readJson(path.join(run.runRoot, ...patchArtifact.split('/'))) : null;
    const changedFiles = (patch?.changes || []).map(change => change.path);
    assertSmoke(workerEvent?.payload?.status === 'done', 'WorkerLoop did not accept a done result.', {
      workerPayload: workerEvent?.payload,
      patch,
    });
    assertSmoke(changedFiles.length === 1 && changedFiles[0] === 'src/smoke-target.md', 'Patch artifact did not capture the expected write-set change.', {
      changedFiles,
      patch,
    });
    assertSmoke((patch?.violations || []).length === 0, 'Patch artifact contains write-set violations.', {
      violations: patch?.violations || [],
    });
    assertSmoke(patch.changes[0]?.afterContent === `${options.marker}\n`, 'Patch artifact content did not match the smoke marker.', {
      afterContent: patch.changes[0]?.afterContent,
      expected: `${options.marker}\n`,
    });

    const queueItem = await findQueueItem(run.runRoot, candidate.suggestedWorkItemId);
    const exported = executed.exported;
    const audit = await runAudit(run.runRoot, exported.targetRoot);
    assertSmoke(audit.ok, 'Machine run audit failed after smoke export.', { audit });

    const canonicalContent = await fs.readFile(workspace.targetPath, 'utf8');
    const events = executed.events;
    cleanup = workspace.createdWorkspace && !options.keep;
    return {
      ok: true,
      adapter: options.adapter,
      codexBypassSandbox: options.codexBypassSandbox === true,
      approveDangerousBypass: options.approveDangerousBypass === true,
      workspaceRoot: workspace.workspaceRoot,
      pipelinePath: workspace.pipelinePath,
      runId: run.runId,
      runRoot: run.runRoot,
      latestRunExportRoot: exported.targetRoot,
      selectedNodes: executed.selectedNodes,
      validation: {
        ok: validation.ok,
        canMachineExecute: validation.canMachineExecute,
        nodeTypes: validation.nodeTypes,
        diagnostics: validation.diagnostics,
      },
      eventTypes: events.map(event => event.eventType),
      eventCount: events.length,
      workerStatus: workerEvent.payload.status,
      queueState: queueItem?.state || '',
      patchArtifact,
      patchChangedFiles: changedFiles,
      canonicalWorkspaceUnchanged: canonicalContent === 'before from OrPAD Machine smoke workspace\n',
      audit,
    };
  } catch (err) {
    cleanup = false;
    err.smokeWorkspaceRoot = workspace.workspaceRoot;
    throw err;
  } finally {
    if (cleanup) {
      await fs.rm(workspace.workspaceRoot, { recursive: true, force: true });
    }
  }
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }
  try {
    const result = await runMachineSmoke(options);
    const output = JSON.stringify(result, null, 2);
    console.log(output);
  } catch (err) {
    const payload = {
      ok: false,
      error: err?.message || String(err),
      details: err?.details || {},
      smokeWorkspaceRoot: err?.smokeWorkspaceRoot || '',
    };
    console.error(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export {
  runMachineSmoke,
  writeMachineSmokeWorkspace,
};
