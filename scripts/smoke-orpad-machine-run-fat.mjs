#!/usr/bin/env node
// "Fat" smoke pipeline for OrPAD UI verification of complex patterns.
//
// Companion to scripts/smoke-orpad-machine-run.mjs (the 1-item linear
// smoke). This one seeds a workspace whose pipeline exercises:
//   * Fork-Join: 3 parallel probes feeding a barrier.
//   * Multi-item queue: 5 candidate proposals → 5 work items → 5
//     dispatcher claims with write-set leases.
//   * Sub-graph composition: orpad.graph node referencing
//     graphs/worker-stage.or-graph (inline execution).
//   * Tree wrapper: orpad.tree node referencing
//     trees/verification.or-tree, executing DFS pre-order ticks.
//   * Patch review reject loop: orpad.patchReview with both
//     `condition: "accepted"` and `condition: "rejected"` outgoing
//     transitions, so the renderer can draw the loop-back edge.
//
// Deterministic harness — no real LLM. Each work item produces a patch
// against src/fat-target.md via machineHarness.nodeCliPatch. After the
// FIRST patch is applied (manually or by Auto-Apply), subsequent patches
// will surface as PATCH_BASE_MISMATCH; that is a legitimate
// demonstration of OrPAD's base-SHA conflict handling, not a script
// bug. Use --keep to seed a workspace for OrPAD desktop UI testing.

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
} = require('../src/main/orchestration-machine');
const { validateRunbookFile } = require('../src/main/runbooks/validator');

const DEFAULT_MARKER = 'after from OrPAD Machine fat-smoke adapter';
const CANDIDATE_COUNT = 5;
const MAX_DRIVER_STEPS = 30;

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    json: false,
    keep: false,
    marker: DEFAULT_MARKER,
    timeoutMs: 300_000,
    workspaceRoot: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
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
    'Usage: node scripts/smoke-orpad-machine-run-fat.mjs [--workspace <path>] [--keep] [--json]',
    '',
    'Seeds a "fat" OrPAD workspace exercising fork-join probes, multi-item queue,',
    'sub-graph composition, tree wrapper, and patch-review reject loop. The pipeline',
    'uses a deterministic harness (no LLM cost) and runs through the machine until',
    'the queue is drained and patch reviews are pending. Use --keep with --workspace',
    'to leave the seeded directory in place for desktop UI testing.',
  ].join('\n');
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fatCandidateProposal(index) {
  const id = `fat-target-${index + 1}`;
  return {
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: `proposal-${id}`,
    suggestedWorkItemId: id,
    sourceNode: ['main/product-probe', 'main/bug-risk-probe', 'main/ux-ui-probe'][index % 3],
    title: `Fat smoke work item ${index + 1} — exercise queue & sub-graph & tree`,
    fingerprint: `fat-smoke:src/fat-target.md:${index + 1}`,
    contentArea: 'orchestration-machine',
    issueType: 'smoke-validation',
    severity: 'P3',
    confidence: 0.95,
    evidence: [{
      id: `fat-target-${index + 1}-before`,
      file: 'src/fat-target.md',
      excerpt: 'before from OrPAD Machine fat-smoke workspace',
    }],
    acceptanceCriteria: [
      `Patch artifact records src/fat-target.md change for work item ${index + 1}.`,
    ],
    sourceOfTruthTargets: ['src/fat-target.md'],
    verificationPlan: 'Visual verification in OrPAD desktop UI.',
  };
}

async function writeFatSmokeWorkspace(options = {}) {
  const workspaceRoot = options.workspaceRoot
    ? path.resolve(options.workspaceRoot)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-fat-smoke-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad', 'pipelines', 'machine-smoke-fat-workstream');
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  const mainGraphPath = path.join(pipelineDir, 'graphs', 'main.or-graph');
  const workerGraphPath = path.join(pipelineDir, 'graphs', 'worker-stage.or-graph');
  const treePath = path.join(pipelineDir, 'trees', 'verification.or-tree');
  const targetPath = path.join(workspaceRoot, 'src', 'fat-target.md');

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, 'before from OrPAD Machine fat-smoke workspace\n', 'utf8');

  // Top-level graph: fork-join probes → barrier → queue → triage →
  // dispatcher → worker-loop → verification-tree (tree wrapper) →
  // verification-stage (sub-graph: orpad.graph) → patchReview (with
  // reject loop) → exit. The worker-loop must live in the same graph
  // as the dispatcher so `workerLoopRef` resolves; the sub-graph
  // demonstrates orpad.graph composition for the post-worker
  // verification phase.
  await writeJson(mainGraphPath, {
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'machine-smoke-fat-workstream',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Begin fat-smoke run', config: { summary: 'Fork-join + queue + sub-graph + tree exercise.' } },
        { id: 'product-probe', type: 'orpad.probe', label: 'Product Intent Probe', config: { lens: 'product-intent', queueRef: 'maintenance-queue', queueStageRoot: 'harness/generated/latest-run/queue/inbox/product-probe' } },
        { id: 'bug-risk-probe', type: 'orpad.probe', label: 'Bug Risk Probe', config: { lens: 'bug-risk', queueRef: 'maintenance-queue', queueStageRoot: 'harness/generated/latest-run/queue/inbox/bug-risk-probe' } },
        { id: 'ux-ui-probe', type: 'orpad.probe', label: 'UX/UI Probe', config: { lens: 'ux-ui', queueRef: 'maintenance-queue', queueStageRoot: 'harness/generated/latest-run/queue/inbox/ux-ui-probe' } },
        { id: 'discovery-barrier', type: 'orpad.barrier', label: 'Discovery Barrier', config: { waitFor: ['product-probe', 'bug-risk-probe', 'ux-ui-probe'], onPartialFailure: 'continue-with-warning' } },
        { id: 'maintenance-queue', type: 'orpad.workQueue', label: 'Work Queue (5 items)', config: { queueRoot: 'harness/generated/latest-run/queue', inboxRoot: 'harness/generated/latest-run/queue/inbox', schema: 'orpad.workItem.v1', states: ['candidate', 'queued', 'claimed', 'done', 'blocked', 'rejected'], singleWriter: true, ingestAfter: 'discovery-barrier', ingestFrom: ['product-probe', 'bug-risk-probe', 'ux-ui-probe'] } },
        { id: 'triage', type: 'orpad.triage', label: 'Triage', config: { queueRef: 'maintenance-queue' } },
        { id: 'dispatcher', type: 'orpad.dispatcher', label: 'Dispatcher (concurrency 1)', config: { queueRef: 'maintenance-queue', workerLoopRef: 'worker-loop', concurrency: 1, defaultAction: 'continue-claiming', stopWhenQueueEmpty: true, fileLocking: 'declared-write-set' } },
        { id: 'worker-loop', type: 'orpad.workerLoop', label: 'Worker Loop', config: { queueRef: 'maintenance-queue', outcomes: ['done', 'blocked', 'requeued'] } },
        { id: 'verification-tree', type: 'orpad.tree', label: 'Verification tree (DFS)', config: { treeRef: '../trees/verification.or-tree' } },
        { id: 'verification-stage', type: 'orpad.graph', label: 'Verification sub-graph', config: { graphRef: 'worker-stage.or-graph', executionMode: 'inline' } },
        { id: 'patch-review', type: 'orpad.patchReview', label: 'Review Patches', config: { reviewMode: 'user-selected-files' } },
        { id: 'exit', type: 'orpad.exit', label: 'Exit', config: { summary: 'Fat smoke complete.' } },
      ],
      transitions: [
        { from: 'entry', to: 'product-probe' },
        { from: 'entry', to: 'bug-risk-probe' },
        { from: 'entry', to: 'ux-ui-probe' },
        { from: 'product-probe', to: 'discovery-barrier' },
        { from: 'bug-risk-probe', to: 'discovery-barrier' },
        { from: 'ux-ui-probe', to: 'discovery-barrier' },
        { from: 'discovery-barrier', to: 'maintenance-queue' },
        { from: 'maintenance-queue', to: 'triage' },
        { from: 'triage', to: 'dispatcher' },
        { from: 'dispatcher', to: 'worker-loop' },
        { from: 'worker-loop', to: 'verification-tree' },
        { from: 'verification-tree', to: 'verification-stage' },
        { from: 'verification-stage', to: 'patch-review' },
        // Patch review fork: accept → exit, reject → loop back to
        // worker-loop. With Auto-Apply Patches mode the accepted
        // branch is taken automatically; the rejected edge stays in
        // the graph for renderer visualization of Pattern K.
        { from: 'patch-review', to: 'exit', condition: 'accepted' },
        { from: 'patch-review', to: 'worker-loop', condition: 'rejected' },
      ],
    },
  });

  // Sub-graph: post-worker verification stage holding the artifact
  // contract. The top-level graph references it via orpad.graph with
  // inline execution so the UI renders a sub-graph layer.
  await writeJson(workerGraphPath, {
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'verification-stage',
      nodes: [
        { id: 'verification-gate', type: 'orpad.gate', label: 'Verification Gate', config: { criteria: ['patch artifact present', 'write-set respected'], onFail: 'warn' } },
        { id: 'artifact-contract', type: 'orpad.artifactContract', label: 'Evidence Contract', config: { artifactRoot: 'harness/generated/latest-run/artifacts', onMissing: 'mark-partial' } },
      ],
      transitions: [
        { from: 'verification-gate', to: 'artifact-contract' },
      ],
    },
  });

  // Behavior tree referenced by orpad.tree wrapper. Executes Pre-Order
  // DFS ticks — the wrapper emits per-tick lifecycle events under
  // `main/verification-tree/<treeNodeId>`.
  await writeJson(treePath, {
    kind: 'orpad.tree',
    version: '1.0',
    root: {
      id: 'verification',
      type: 'Sequence',
      label: 'Verification sequence',
      children: [
        { id: 'patch-recorded', type: 'Context', label: 'Patch artifact recorded' },
        { id: 'writeset-clean', type: 'Gate', label: 'Files within declared write-set' },
        { id: 'acceptance-met', type: 'Gate', label: 'Acceptance criteria met' },
      ],
    },
  });

  await writeJson(pipelinePath, {
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'machine-smoke-fat-workstream',
    title: 'Fat Smoke — Fork-Join + Queue + Sub-graph + Tree + Patch Review',
    description: 'Deterministic fat-smoke pipeline for OrPAD UI verification. Exercises every workstream pattern without an LLM.',
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
        // Multi-candidate harness — drives N work items through the
        // queue. All candidates share one nodeCliPatch (same file, same
        // content); first applied patch wins, rest legitimately
        // PATCH_BASE_MISMATCH so the UI can demo conflict handling.
        candidateProposals: Array.from({ length: CANDIDATE_COUNT }, (_, index) => fatCandidateProposal(index)),
        expectedChangedFiles: ['src/fat-target.md'],
        nodeCliPatch: {
          file: 'src/fat-target.md',
          content: `${options.marker}\n`,
        },
      },
    },
    graphs: [
      { id: 'main', file: 'graphs/main.or-graph' },
      { id: 'worker-stage', file: 'graphs/worker-stage.or-graph' },
    ],
    trees: [
      { id: 'verification', file: 'trees/verification.or-tree' },
    ],
  });

  return {
    workspaceRoot,
    pipelineDir,
    pipelinePath,
    mainGraphPath,
    workerGraphPath,
    treePath,
    targetPath,
    createdWorkspace: !options.workspaceRoot,
  };
}

async function runAudit(runRoot, latestRunExportRoot) {
  const { stdout } = await execFileP(process.execPath, [
    path.join(repoRoot, 'scripts', 'audit-orpad-machine-run.mjs'),
    runRoot,
    latestRunExportRoot,
  ], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 8, windowsHide: true });
  return JSON.parse(stdout);
}

function assertSmoke(condition, message, details = {}) {
  if (condition) return;
  const err = new Error(message);
  err.details = details;
  throw err;
}

async function runFatSmoke(input = {}) {
  const options = { ...parseArgs([]), ...input };
  const workspace = await writeFatSmokeWorkspace(options);
  let cleanup = workspace.createdWorkspace && !options.keep;
  try {
    const validation = await validateRunbookFile(workspace.pipelinePath, {
      trustLevel: 'local-authored',
      checkFiles: true,
    });
    assertSmoke(validation.ok, 'Fat-smoke pipeline validation failed.', { diagnostics: validation.diagnostics });
    assertSmoke(validation.canMachineExecute === true, 'Fat-smoke pipeline is not Machine-executable.', {
      machineBlockedReasons: validation.machineBlockedReasons,
      diagnostics: validation.diagnostics,
    });

    const run = await createMachineRun({
      workspaceRoot: workspace.workspaceRoot,
      pipelinePath: workspace.pipelinePath,
    });

    // Drive the machine step-by-step until the queue drains or the
    // patchReview node halts the run. Mirrors what the desktop's
    // autonomous driver does, but without the IPC layer.
    let stepsRun = 0;
    let lastStep = null;
    while (stepsRun < MAX_DRIVER_STEPS) {
      lastStep = await executeMachineRunStep({
        workspaceRoot: workspace.workspaceRoot,
        pipelinePath: workspace.pipelinePath,
        pipelineDir: workspace.pipelineDir,
        runRoot: run.runRoot,
        runId: run.runId,
        nodeExecutable: process.execPath,
        timeoutMs: options.timeoutMs,
        exportLatestRunAfterStep: true,
      });
      stepsRun += 1;
      const lifecycle = String(lastStep.runState?.lifecycleStatus || '').toLowerCase();
      const summary = String(lastStep.runState?.summaryStatus || '').toLowerCase();
      if (['completed', 'cancelled', 'failed'].includes(lifecycle)) break;
      if (summary === 'done') break;
      // Driver stalls when there is no further progress for one full
      // step (e.g. patchReview blocking the run, evidence-incomplete).
      const eventsAdvanced = (lastStep.events || []).length > 0;
      if (!eventsAdvanced) break;
      if (lifecycle === 'waiting' && summary === 'blocked') break;
    }

    const exported = lastStep?.exported;
    const audit = exported ? await runAudit(run.runRoot, exported.targetRoot) : { ok: false, error: 'no-export' };

    const events = lastStep?.events || [];
    const eventTypeCounts = events.reduce((acc, ev) => {
      const key = ev.eventType || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    // Pattern coverage tally so the JSON output makes it obvious which
    // visualizations the seeded workspace will surface in the UI.
    const probeNodePaths = new Set(events
      .filter(ev => String(ev.eventType || '').startsWith('node.') && /\/(product|bug-risk|ux-ui)-probe$/.test(ev.nodePath || ''))
      .map(ev => ev.nodePath));
    const treeTickPaths = new Set(events
      .filter(ev => /\/verification-tree\//.test(ev.nodePath || ''))
      .map(ev => ev.nodePath));
    const subGraphNodes = new Set(events
      .filter(ev => /^main\/verification-stage(\/|$)/.test(ev.nodePath || ''))
      .map(ev => ev.nodePath));
    const workerResults = events.filter(ev => ev.eventType === 'worker.result');
    const claimLeases = events.filter(ev => String(ev.eventType || '').startsWith('claim.lease-'));
    const patchArtifacts = workerResults
      .map(ev => ev.payload?.patchArtifact)
      .filter(Boolean);

    cleanup = workspace.createdWorkspace && !options.keep;
    return {
      ok: audit.ok,
      workspaceRoot: workspace.workspaceRoot,
      pipelinePath: workspace.pipelinePath,
      runId: run.runId,
      runRoot: run.runRoot,
      latestRunExportRoot: exported?.targetRoot || '',
      stepsRun,
      lifecycle: lastStep?.runState?.lifecycleStatus || '',
      summary: lastStep?.runState?.summaryStatus || '',
      patternCoverage: {
        forkJoinProbeNodes: [...probeNodePaths].sort(),
        forkJoinProbeCount: probeNodePaths.size,
        subGraphNodeCount: subGraphNodes.size,
        treeTickPathCount: treeTickPaths.size,
        treeTickPaths: [...treeTickPaths].sort(),
        workerResultCount: workerResults.length,
        claimLeaseEventCount: claimLeases.length,
        patchArtifactCount: patchArtifacts.length,
        patchArtifacts,
      },
      eventCount: events.length,
      eventTypeCounts,
      audit,
    };
  } catch (err) {
    cleanup = false;
    err.smokeWorkspaceRoot = workspace.workspaceRoot;
    throw err;
  } finally {
    if (cleanup) await fs.rm(workspace.workspaceRoot, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }
  try {
    const result = await runFatSmoke(options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (err) {
    console.error(JSON.stringify({
      ok: false,
      error: err?.message || String(err),
      details: err?.details || {},
      smokeWorkspaceRoot: err?.smokeWorkspaceRoot || '',
    }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { runFatSmoke, writeFatSmokeWorkspace };
