import { test, expect } from '@playwright/test';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchElectron } from '../helpers';

const {
  claimNextQueuedItem,
  appendMachineEvent,
  appendRunLifecycleStatus,
  appendRunSummaryStatus,
  createMachineRun,
  executeMachineRunStep,
  findQueueItem,
  ingestCandidateProposal,
  readMachineEvents,
  registerPatchArtifact,
  transitionQueueItem,
  writeQueueItem,
} = require('../../src/main/orchestration-machine');

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function writeApprovedWorkspace(userData: string, workspaceRoot: string): void {
  fs.writeFileSync(path.join(userData, 'approved-workspace.json'), JSON.stringify({
    version: 1,
    workspaceRoot,
  }));
}

function writeMachineWorkspace(): { workspace: string; pipelinePath: string; pipelineDir: string } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-machine-ui-'));
  const pipelineDir = path.join(workspace, '.orpad', 'pipelines', 'machine-workstream');
  fs.mkdirSync(path.join(pipelineDir, 'graphs'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  fs.writeFileSync(path.join(workspace, 'src', 'smoke-target.md'), 'before\n');

  fs.writeFileSync(path.join(pipelineDir, 'graphs', 'main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'machine-workstream',
      nodes: [
        { id: 'context', type: 'orpad.context', label: 'Context', config: { summary: 'Collect context.' } },
        { id: 'probe', type: 'orpad.probe', label: 'Probe', config: { lens: 'bug-risk' } },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', label: 'Triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Worker', config: { queueRef: 'queue' } },
      ],
      transitions: [
        { from: 'context', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
      ],
    },
  }, null, 2));

  fs.writeFileSync(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'machine-workstream',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    nodePacks: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3', origin: 'built-in' },
      { id: 'orpad.workstream', version: '>=0.1.0', origin: 'built-in' },
    ],
    maintenancePolicy: {
      handoff: {
        promptContract: 'path-only',
        launchPromptShape: '<pipeline.or-pipeline path> --machine-ui-test',
      },
    },
    run: {
      artifactRoot: 'harness/generated/latest-run/artifacts',
      queueRoot: 'harness/generated/latest-run/queue',
      metadataPath: 'harness/generated/latest-run/run-metadata.json',
      summaryPath: 'harness/generated/latest-run/summary.md',
      machineHarness: {
        candidateProposal: {
          schemaVersion: 'orpad.candidateProposal.v1',
          proposalId: 'proposal-machine-ui-smoke',
          suggestedWorkItemId: 'machine-ui-smoke',
          sourceNode: 'probe/machine-ui',
          title: 'Exercise Machine UI worker execution',
          fingerprint: 'machine-ui:src/smoke-target.md',
          evidence: [{ id: 'target-before', file: 'src/smoke-target.md' }],
          acceptanceCriteria: ['Patch artifact records the target file change.'],
          sourceOfTruthTargets: ['src/smoke-target.md'],
        },
        expectedChangedFiles: ['src/smoke-target.md'],
        nodeCliPatch: {
          file: 'src/smoke-target.md',
          content: 'after from Machine UI harness\n',
        },
      },
    },
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
  }, null, 2));

  return { workspace, pipelinePath, pipelineDir };
}

function addParallelProbeHarness(pipelinePath: string): void {
  const pipelineDir = path.dirname(pipelinePath);
  const graphPath = path.join(pipelineDir, 'graphs', 'main.or-graph');
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
  graph.graph.nodes.splice(2, 0, {
    id: 'probe-secondary',
    type: 'orpad.probe',
    label: 'Secondary Probe',
    config: { lens: 'test-gap' },
  });
  graph.graph.transitions.push(
    { from: 'context', to: 'probe-secondary' },
    { from: 'probe-secondary', to: 'queue' },
  );
  fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2));

  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  const primary = {
    ...pipeline.run.machineHarness.candidateProposal,
    sourceNode: 'main/probe',
  };
  const secondary = {
    ...pipeline.run.machineHarness.candidateProposal,
    proposalId: 'proposal-machine-ui-secondary',
    suggestedWorkItemId: 'machine-ui-secondary',
    sourceNode: 'main/probe-secondary',
    title: 'Exercise secondary Machine UI worker execution',
    fingerprint: 'machine-ui-secondary:src/smoke-target.md',
  };
  pipeline.run.machineHarness.candidateProposals = [primary, secondary];
  pipeline.run.machineHarness.probeNodePaths = ['main/probe', 'main/probe-secondary'];
  pipeline.run.machineHarness.parallelProbes = true;
  pipeline.run.machineHarness.probeConcurrency = 2;
  pipeline.run.machineHarness.workerConcurrency = 2;
  fs.writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2));
}

function addNestedGraphProjectionFixture(pipelinePath: string): void {
  const pipelineDir = path.dirname(pipelinePath);
  const graphPath = path.join(pipelineDir, 'graphs', 'main.or-graph');
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
  graph.graph.nodes.splice(1, 0, {
    id: 'discovery-stage',
    type: 'orpad.graph',
    label: 'Discovery stage',
    config: { graphRef: 'discovery.or-graph', executionMode: 'inline' },
  });
  graph.graph.transitions = graph.graph.transitions
    .filter((edge: { from?: string; to?: string }) => !(edge.from === 'context' && edge.to === 'probe'));
  graph.graph.transitions.push(
    { from: 'context', to: 'discovery-stage' },
    { from: 'discovery-stage', to: 'probe' },
  );
  fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2));
  fs.writeFileSync(path.join(pipelineDir, 'graphs', 'discovery.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'discovery',
      nodes: [
        { id: 'probe-a', type: 'orpad.probe', label: 'Nested probe', config: { lens: 'nested' } },
      ],
      transitions: [],
    },
  }, null, 2));

  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  pipeline.graphs.push({ id: 'discovery', file: 'graphs/discovery.or-graph' });
  fs.writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2));
}

function makeParallelProbeWorkersReviewBlocked(pipelinePath: string): void {
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  pipeline.run.machineHarness.continueAfterReviewableBlockedPatch = true;
  pipeline.run.machineHarness.expectedChangedFiles = [
    pipeline.run.machineHarness.nodeCliPatch.file,
    'src/unmodified-expected.md',
  ];
  fs.writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2));
}

function appendFailingArtifactContract(pipelineDir: string): void {
  const graphPath = path.join(pipelineDir, 'graphs', 'main.or-graph');
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
  graph.graph.nodes.push({
    id: 'artifact',
    type: 'orpad.artifactContract',
    label: 'Artifact contract',
    config: {
      required: ['missing-proof.md'],
      onMissing: 'fail-run',
    },
  });
  fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2));
}

function requireMachineApproval(pipelinePath: string): void {
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  pipeline.run.machineHarness.candidateProposal.approvalRequired = true;
  fs.writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2));
}

function removeMachineHarness(pipelinePath: string): void {
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  delete pipeline.run.machineHarness;
  fs.writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2));
}

async function seedActiveClaimRun(
  workspace: string,
  pipelinePath: string,
  options: { runId?: string; leaseMs?: number } = {},
): Promise<{ runId: string; runRoot: string; claimId: string; itemId: string }> {
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  const candidate = pipeline.run.machineHarness.candidateProposal;
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: options.runId || 'run_machine_ui_active_claim',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  const item = await ingestCandidateProposal(run.runRoot, candidate, {
    runId: run.runId,
    transitionId: 'proposal:machine-ui-active-claim',
    now: '2026-05-01T00:00:01.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: item.item.id,
    toState: 'queued',
    reason: 'machine-ui.fixture.triage.accepted',
    transitionId: 'triage:machine-ui-active-claim',
    now: '2026-05-01T00:00:02.000Z',
  });
  const claim = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-machine-ui-smoke',
    workerId: 'machine-ui-e2e-worker',
    recoverStale: false,
    leaseMs: options.leaseMs ?? 30 * 24 * 60 * 60 * 1000,
    now: '2026-05-01T00:00:03.000Z',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'node.started',
    nodePath: 'main/worker',
    payload: {
      nodeExecutionId: `${run.runId}:main/worker:attempt-1`,
      nodeType: 'orpad.workerLoop',
      status: 'started',
      attempt: 1,
      itemId: item.item.id,
      claimId: claim.claim.claimId,
    },
  });
  return {
    runId: run.runId,
    runRoot: run.runRoot,
    claimId: claim.claim.claimId,
    itemId: claim.item.id,
  };
}

async function seedStaleClaimRun(workspace: string, pipelinePath: string): Promise<{ runId: string; runRoot: string; claimId: string; itemId: string }> {
  const seeded = await seedActiveClaimRun(workspace, pipelinePath, {
    runId: 'run_machine_ui_stale_claim',
    leaseMs: 1000,
  });
  const current = await findQueueItem(seeded.runRoot, seeded.itemId, { canonicalOnly: false });
  await writeQueueItem(seeded.runRoot, {
    ...current.item,
    state: 'queued',
    updatedAt: '2026-05-01T00:00:04.000Z',
  });
  return seeded;
}

async function seedReplayProjectionRun(
  workspace: string,
  pipelinePath: string,
): Promise<{ runId: string; runRoot: string; replayPosition: number }> {
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_replay_projection',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'running',
    reason: 'machine-ui.fixture.replay-running',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/context',
    eventType: 'node.started',
    payload: {
      nodeExecutionId: `${run.runId}:main/context:attempt-1`,
      nodeType: 'orpad.context',
      status: 'started',
      attempt: 1,
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/context',
    eventType: 'node.completed',
    payload: {
      nodeExecutionId: `${run.runId}:main/context:attempt-1`,
      nodeType: 'orpad.context',
      status: 'completed',
      attempt: 1,
    },
  });
  const replayEvents = await readMachineEvents(run.runRoot);
  const replayPosition = replayEvents.findIndex((event: { eventType?: string; nodePath?: string }) =>
    event.eventType === 'node.completed' && event.nodePath === 'main/context') + 1;
  expect(replayPosition).toBeGreaterThan(0);
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/probe',
    eventType: 'node.started',
    payload: {
      nodeExecutionId: `${run.runId}:main/probe:attempt-1`,
      nodeType: 'orpad.probe',
      status: 'started',
      attempt: 1,
    },
  });
  return { runId: run.runId, runRoot: run.runRoot, replayPosition };
}

async function enableMachineUi(win: any): Promise<void> {
  await win.evaluate(() => {
    localStorage.setItem('orpad-machine-ui-enabled', '1');
  });
}

async function submitMachineCapabilityToken(win: any): Promise<void> {
  await expect(win.locator('[data-machine-token-input]')).toBeVisible();
  await win.locator('[data-machine-token-input]').fill('test-token');
  await win.getByRole('button', { name: 'Use Token' }).click();
  await expect(win.locator('#fmt-modal')).toBeHidden();
}

async function confirmRunProviderSelection(win: any): Promise<void> {
  const picker = win.locator('.orpad-adapter-picker');
  await expect(picker).toBeVisible();
  await expect(win.locator('[data-provider-id="codex-cli"]')).toBeVisible();
  await win.locator('[data-adapter-picker-confirm="true"]').click();
  await expect(win.locator('.orpad-adapter-picker-overlay')).toHaveCount(0);
}

async function skipPatchModalIfVisible(win: any): Promise<void> {
  const modal = win.locator('#fmt-modal');
  if (!(await modal.isVisible().catch(() => false))) {
    return;
  }
  await modal.getByRole('button', { name: /^(Cancel|Skip Patch)$/ }).click();
  await expect(modal).toBeHidden();
}

async function startManagedRunFromPreview(win: any): Promise<void> {
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  const defaultRun = win.locator('button[data-pipeline-run-action="default"]');
  await expect(defaultRun).toBeEnabled();
  await defaultRun.click();
}

test('Machine UI creates a durable run and executes a dispatcher worker adapter step', async () => {
  const { workspace, pipelinePath, pipelineDir } = writeMachineWorkspace();
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  const taskText = 'Improve Pipes UI smoke flow.';
  await win.locator('[data-runbook-task]').fill(taskText);
  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('Machine Workstream');
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('Flow: Main flow');
  await expect(win.locator('[data-pipeline-preview-runbar]')).not.toContainText('main.or-graph');
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('Ready to start.');
  await expect(win.locator('[data-pipeline-preview-runbar]')).not.toContainText(/Ready for .*handoff/);
  await expect(win.locator('button[data-pipeline-run-action="default"]')).toBeVisible();
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(win.locator('button[data-pipeline-run-action="local"]')).toBeDisabled();
  await expect(win.locator('button[data-pipeline-run-action="managed"]')).toContainText('Start Run');
  await expect(win.locator('button[data-pipeline-run-action="handoff"]')).toContainText('Prepare Handoff');
  await win.locator('[data-pipeline-run-menu]').click();
  await win.locator('[data-runbook-task]').focus();
  await win.keyboard.press('Control+Enter');
  await submitMachineCapabilityToken(win);
  await confirmRunProviderSelection(win);
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(win.locator('#runbooks-content')).toContainText(taskText);
  await expect(win.locator('#runbooks-content')).toContainText('Run started');
  await expect(win.locator('#runbooks-content')).not.toContainText(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  await expect(win.locator('#runbooks-content')).not.toContainText(/run_\d{8}_\d{6}/);

  const runRoot = path.join(pipelineDir, 'runs');
  await expect.poll(() => fs.existsSync(runRoot) ? fs.readdirSync(runRoot).length : 0).toBe(1);

  await expect(win.locator('#runbooks-content')).toContainText('Agent request prepared');
  await expect(win.locator('#runbooks-content')).toContainText('Work completed');
  await expect(win.locator('#runbooks-content')).toContainText('Work is ready');
  await expect(win.locator('#runbooks-content')).toContainText('Work found');
  await expect(win.locator('#runbooks-content')).toContainText('1 work item found');
  await expect(win.locator('#runbooks-content')).toContainText('Work result');
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 evidence files; 1 check; 1 changed file');
  await expect(win.locator('#fmt-modal-title')).toContainText('Review Patch');
  await expect(win.locator('#fmt-modal-body')).toContainText('Exercise Machine UI worker execution');
  await expect(win.locator('#fmt-modal-body')).toContainText('Patch artifact records the target file change.');
  await expect(win.locator('[data-machine-patch-file]')).toBeChecked();
  expect(fs.readFileSync(path.join(workspace, 'src', 'smoke-target.md'), 'utf-8')).toBe('before\n');
  await win.getByRole('button', { name: 'Approve & Apply' }).click();
  await expect(win.locator('#fmt-modal')).toBeHidden();
  await expect.poll(() => fs.readFileSync(path.join(workspace, 'src', 'smoke-target.md'), 'utf-8')).toBe('after from Machine UI harness\n');
  await expect(win.locator('#runbooks-content')).toContainText('Snapshot saved');
  await expect(win.locator('#runbooks-content')).toContainText('No permission needed');
  await expect(win.locator('#runbooks-content')).not.toContainText('No pending approvals');
  await expect(win.locator('#runbooks-content')).not.toContainText('Export Latest');
  await expect(win.locator('#runbooks-content')).not.toContainText('before auditing this run');
  await expect(win.locator('#runbooks-content')).toContainText('Recovery unavailable: completed/done is finished');
  await expect(win.locator('#runbooks-content')).not.toContainText(/\bResume\b/);
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toHaveText('Recover');
  await expect(win.locator('button[data-runbook-action="machine-export"]')).toBeEnabled();

  await win.locator('button[data-runbook-action="machine-export"]').click();
  await expect(win.locator('#runbooks-content')).toContainText('Evidence snapshot');
  await expect(win.locator('#runbooks-content')).toContainText('Snapshot saved');
  await expect(win.locator('#runbooks-content')).toContainText('Evidence check');
  await expect(win.locator('#runbooks-content')).toContainText('Evidence ready for review');
  await expect(win.locator('#runbooks-content')).not.toContainText('Export Latest before auditing this run');
  await expect.poll(() => fs.existsSync(path.join(pipelineDir, 'harness', 'generated', 'latest-run', 'run-metadata.json'))).toBe(true);
  await expect(win.locator('button[data-runbook-action="machine-view-artifacts"]')).toBeEnabled();
  await win.locator('button[data-runbook-action="machine-view-artifacts"]').click();
  await expect(win.locator('.tab-item.active')).toContainText('Run Evidence');
  await expect(win.locator('.tab-item.active')).not.toContainText(/run_\d{8}_\d{6}/);
  await expect(win.locator('.cm-content')).toContainText('Run Evidence');
  await expect(win.locator('.cm-content')).not.toContainText(/run_\d{8}_\d{6}/);
  await win.locator('#btn-preview').click();
  await expect(win.locator('#context-return-bar')).toContainText('Machine Workstream');
  await expect(win.locator('#context-return-bar')).toContainText('Run Evidence');
  await expect(win.locator('#content')).toContainText('artifacts/discovery/candidate-inventory.json');
  await expect(win.locator('#content')).toContainText('artifacts/patches');
  await expect(win.locator('#content')).toContainText('Evidence ready for review');
  await win.locator('[data-context-return-action="flow"]').click();
  await expect(win.locator('.tab-item.active')).toContainText('main.or-graph');
  await expect(win.locator('#content.view-orch-graph .orch-preview')).toBeVisible();
  await expect(win.locator('#context-return-bar')).toHaveClass(/hidden/);
  await expect(win.locator('#content.view-orch-graph .pipe-lifecycle-banner')).toBeVisible();
  await win.setViewportSize({ width: 980, height: 520 });
  const graphScroll = await win.locator('#content.view-orch-graph').evaluate((el: HTMLElement) => {
    const preview = el.querySelector('.orch-preview') as HTMLElement | null;
    const frame = el.querySelector('.orch-graph-frame') as HTMLElement | null;
    el.scrollTop = 0;
    el.scrollTop = el.scrollHeight;
    return {
      contentOverflowY: getComputedStyle(el).overflowY,
      previewOverflowY: preview ? getComputedStyle(preview).overflowY : '',
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTopAfter: el.scrollTop,
      frameBottom: frame ? frame.offsetTop + frame.offsetHeight : 0,
    };
  });
  expect(graphScroll.contentOverflowY).toBe('auto');
  expect(graphScroll.previewOverflowY).toBe('visible');
  expect(graphScroll.scrollHeight).toBeGreaterThan(graphScroll.clientHeight);
  expect(graphScroll.scrollTopAfter).toBeGreaterThan(0);
  expect(graphScroll.frameBottom).toBeLessThanOrEqual(graphScroll.scrollHeight + 2);
  await win.setViewportSize({ width: 1280, height: 720 });

  const runDirs = fs.readdirSync(runRoot);
  expect(fs.existsSync(path.join(runRoot, runDirs[0], 'run-state.json'))).toBe(true);
  expect(fs.existsSync(path.join(runRoot, runDirs[0], 'events.jsonl'))).toBe(true);
  expect(fs.readFileSync(path.join(runRoot, runDirs[0], 'events.jsonl'), 'utf-8')).toContain('run.created');
  expect(fs.readFileSync(path.join(runRoot, runDirs[0], 'events.jsonl'), 'utf-8')).toContain(taskText);
  expect(pipelinePath.endsWith('pipeline.or-pipeline')).toBe(true);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });
  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(win.locator('#runbooks-content')).toContainText(taskText);
  await expect(win.locator('#runbooks-content')).toContainText('Work completed');
  await expect(win.locator('#runbooks-content')).not.toContainText(runDirs[0]);
  await expect(win.locator('#runbooks-content')).toContainText('1 work item found');
  await expect(win.locator('#runbooks-content')).toContainText('Discovery evidence saved');
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 evidence files; 1 check; 1 changed file');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeDisabled();

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine graph executes configured probe fanout in parallel', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  addParallelProbeHarness(pipelinePath);
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_parallel_probe_fanout',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });

  const executed = await executeMachineRunStep({
    workspaceRoot: workspace,
    pipelinePath,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });

  expect(executed.selectedProbeNodes).toEqual(['main/probe', 'main/probe-secondary']);
  expect(executed.candidateInventory.candidateCount).toBe(2);
  expect(executed.workerLoop.workerCount).toBe(2);
  expect(executed.claims).toHaveLength(2);
  expect(executed.workers).toHaveLength(2);
  const probeStarts = executed.events
    .filter((event: { eventType?: string; nodePath?: string }) => (
      event.eventType === 'node.started'
      && ['main/probe', 'main/probe-secondary'].includes(event.nodePath || '')
    ));
  const probeCompletions = executed.events
    .filter((event: { eventType?: string; nodePath?: string }) => (
      event.eventType === 'node.completed'
      && ['main/probe', 'main/probe-secondary'].includes(event.nodePath || '')
    ));
  expect(probeStarts.map((event: { nodePath?: string }) => event.nodePath).sort()).toEqual(['main/probe', 'main/probe-secondary']);
  expect(probeCompletions).toHaveLength(2);
  const lastStartSequence = Math.max(...probeStarts.map((event: { sequence: number }) => event.sequence));
  const firstCompletionSequence = Math.min(...probeCompletions.map((event: { sequence: number }) => event.sequence));
  expect(lastStartSequence).toBeLessThan(firstCompletionSequence);
  const sequences = executed.events.map((event: { sequence: number }) => event.sequence);
  expect(new Set(sequences).size).toBe(sequences.length);
  const workerResults = executed.events
    .filter((event: { eventType?: string }) => event.eventType === 'worker.result');
  expect(workerResults.map((event: { itemId?: string }) => event.itemId).sort()).toEqual([
    'machine-ui-secondary',
    'machine-ui-smoke',
  ]);
  expect(executed.finalization.inventory.activeCount).toBe(0);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine graph continues queued work after reviewable blocked patch', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  addParallelProbeHarness(pipelinePath);
  makeParallelProbeWorkersReviewBlocked(pipelinePath);
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_review_blocked_continues_queue',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });

  const executed = await executeMachineRunStep({
    workspaceRoot: workspace,
    pipelinePath,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });

  expect(executed.workerLoop.workerCount).toBe(2);
  expect(executed.workerLoop.stopReason).toBe('claim-limit');
  const workerResults = executed.events
    .filter((event: { eventType?: string }) => event.eventType === 'worker.result');
  expect(workerResults).toHaveLength(2);
  expect(workerResults.every((event: { payload?: { status?: string } }) => event.payload?.status === 'blocked')).toBe(true);
  expect(executed.finalization.inventory.activeCount).toBe(0);
  expect(executed.finalization.inventory.blockedCount).toBe(2);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI shows running managed runs as busy and blocks duplicate Continue', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_running',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'running',
    reason: 'machine-ui.fixture.active-step',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/probe',
    eventType: 'node.started',
    payload: {
      nodeExecutionId: `${run.runId}:main/probe:attempt-1`,
      nodeType: 'orpad.probe',
      status: 'started',
      attempt: 1,
    },
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('Run in progress.');
  const primaryRunButton = win.locator('button.pipeline-run-primary');
  await expect(primaryRunButton).toBeEnabled();
  await expect(primaryRunButton).toHaveAttribute('data-pipeline-run-action', 'machine-cancel-run');
  await expect(primaryRunButton).toHaveAttribute('aria-label', 'Stop Run');
  await expect(primaryRunButton).toHaveClass(/danger/);
  const runningProbeNode = win.locator('.orch-graph-node[data-machine-node-path="main/probe"]');
  await expect(runningProbeNode).toContainText('Running');
  await expect(runningProbeNode).toHaveClass(/runtime-running/);
  await expect(win.locator('.orch-transition[data-machine-edge-state="active"]')).toHaveCount(1);
  await expect(win.locator('.orch-transition-flow-arrows')).toHaveCount(1);
  await expect(win.locator('button[data-orch-mode="readonly"]')).toHaveClass(/active/);
  await expect(win.locator('button[data-orch-mode="readwrite"]')).toBeDisabled();
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(win.locator('button[data-pipeline-run-action="managed"]')).toBeDisabled();
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Running$/ })).toBeVisible();
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toHaveCount(0);
  await expect(win.locator('button[data-runbook-action="machine-cancel-run"]')).toHaveCount(0);
  const recoverButton = win.locator('button[data-runbook-action="machine-resume-run"]');
  await expect(recoverButton).toBeDisabled();
  await expect(recoverButton).toHaveAttribute('title', /OrPAD is already working/);
  await expect(win.locator('#runbooks-content')).toContainText('Run started');
  await primaryRunButton.click();
  await submitMachineCapabilityToken(win);
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Cancelled$/ })).toBeVisible();
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Stopped$/ })).toBeVisible();
  await expect(win.locator('#runbooks-content')).not.toContainText('Partial proof');
  await expect(primaryRunButton).toHaveAttribute('data-pipeline-run-action', 'default');
  await expect(primaryRunButton).toHaveAttribute('aria-label', /Start Run/);
  await expect(primaryRunButton).not.toHaveClass(/danger/);
  await expect(runningProbeNode).toContainText('Cancelled');
  await expect(runningProbeNode).toHaveClass(/runtime-cancelled/);
  await expect(win.locator('.orch-transition[data-machine-edge-state="active"]')).toHaveCount(0);
  await expect(win.locator('.orch-transition-flow-arrows')).toHaveCount(0);
  await expect(win.locator('button[data-orch-mode="readwrite"]')).toBeEnabled();

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI does not animate inactive transitions after a waiting run', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_waiting_projection',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/context',
    eventType: 'node.completed',
    payload: {
      nodeExecutionId: `${run.runId}:main/context:attempt-1`,
      nodeType: 'orpad.context',
      status: 'completed',
      attempt: 1,
    },
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'waiting',
    reason: 'machine-ui.fixture.waiting',
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'partial',
    reason: 'machine-ui.fixture.partial',
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  const completedContextNode = win.locator('.orch-graph-node[data-machine-node-path="main/context"]');
  await expect(completedContextNode).toContainText('Done');
  await expect(completedContextNode).toHaveClass(/runtime-completed/);
  await expect(win.locator('.orch-transition[data-machine-edge-state="active"]')).toHaveCount(0);
  await expect(win.locator('.orch-transition-flow-arrows')).toHaveCount(0);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI replay slider drives graph projection and keeps run actions live', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const seeded = await seedReplayProjectionRun(workspace, pipelinePath);

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  const runbar = win.locator('[data-pipeline-preview-runbar]');
  const primaryRunButton = win.locator('button.pipeline-run-primary');
  const contextNode = win.locator('.orch-graph-node').filter({ hasText: 'Context' });
  const probeNode = win.locator('.orch-graph-node').filter({ hasText: 'Probe' });
  await expect(runbar).toContainText('progress 1/2');
  await expect(contextNode).toContainText('Done');
  await expect(probeNode).toContainText('Running');
  await expect(win.locator('.orch-transition[data-machine-edge-state="active"]')).toHaveCount(1);
  await expect(primaryRunButton).toHaveAttribute('data-pipeline-run-action', 'machine-cancel-run');

  for (let pass = 0; pass < 2; pass += 1) {
    await win.locator('[data-runbook-run-details]').evaluate((element: HTMLDetailsElement) => {
      element.open = true;
    });
    const slider = win.locator('[data-runbook-replay-slider]');
    await expect(slider).toBeVisible();
    await slider.evaluate((element: HTMLInputElement, value: string) => {
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, String(seeded.replayPosition));
    await expect(win.locator('#runbooks-content')).toContainText('Replaying');
    await expect(win.locator('#runbooks-content')).toContainText('Run controls use the live run');
    await expect(runbar).toContainText('progress 1/1');
    await expect(contextNode).toContainText('Done');
    await expect(probeNode).not.toContainText('Running');
    await expect(win.locator('.orch-transition[data-machine-edge-state="active"]')).toHaveCount(0);
    await expect(primaryRunButton).toHaveAttribute('data-pipeline-run-action', 'machine-cancel-run');

    await win.locator('[data-runbook-run-details]').evaluate((element: HTMLDetailsElement) => {
      element.open = true;
    });
    await win.locator('button[data-runbook-action="replay-live"]').click();
    await expect(win.locator('#runbooks-content')).not.toContainText('Replaying');
    await expect(runbar).toContainText('progress 1/2');
    await expect(probeNode).toContainText('Running');
    await expect(win.locator('.orch-transition[data-machine-edge-state="active"]')).toHaveCount(1);
  }

  expect(fs.readFileSync(path.join(seeded.runRoot, 'events.jsonl'), 'utf-8')).toContain('main/probe');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Orchestration window run refresh preserves scroll, details, and text selection', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const seeded = await seedReplayProjectionRun(workspace, pipelinePath);
  for (let i = 0; i < 60; i += 1) {
    await appendMachineEvent(seeded.runRoot, {
      runId: seeded.runId,
      actor: 'machine',
      eventType: 'scheduler.edgeEvaluation',
      nodePath: 'main/probe',
      payload: {
        firedCount: i % 2,
        droppedCount: (i + 1) % 2,
      },
    });
  }

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  const orchestrationWindowPromise = app.waitForEvent('window');
  await win.locator('#btn-orchestration').click();
  const orchestrationWin = await orchestrationWindowPromise;
  await orchestrationWin.waitForLoadState('domcontentloaded');
  await orchestrationWin.waitForSelector('body.orchestration-window');
  await orchestrationWin.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  await orchestrationWin.locator('#toolbar [data-pipeline-select-trigger]').click();
  await orchestrationWin.locator('#toolbar [data-orchestration-select-pipeline]')
    .filter({ has: orchestrationWin.locator('strong').filter({ hasText: /^Machine Workstream$/ }) })
    .click();
  await expect(orchestrationWin.locator('#runbooks-content')).toContainText('Latest Run');
  await orchestrationWin.addStyleTag({ content: '.runbook-replay-events { max-height: 36px !important; }' });

  await orchestrationWin.locator('[data-runbook-run-details] summary').click();
  const eventLog = orchestrationWin.locator('[data-runbook-run-details] [data-runbook-replay-events]');
  await expect(eventLog).toBeVisible();
  const beforeScrollTop = await eventLog.evaluate((el: HTMLElement) => new Promise<number>((resolve) => {
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.style.scrollBehavior = 'auto';
    el.scrollTop = Math.max(12, Math.floor(maxTop / 2));
    requestAnimationFrame(() => {
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      resolve(el.scrollTop);
    });
  }));
  expect(beforeScrollTop).toBeGreaterThan(0);

  await appendMachineEvent(seeded.runRoot, {
    runId: seeded.runId,
    actor: 'machine',
    eventType: 'scheduler.loopBackReset',
    nodePath: 'main/probe',
    payload: {
      targetNodePath: 'pointer-defer-probe',
    },
  });
  await orchestrationWin.locator('#content').evaluate((element: HTMLElement) => {
    const EventCtor = window.PointerEvent || window.MouseEvent;
    element.dispatchEvent(new EventCtor('pointerdown', { bubbles: true, buttons: 1 }));
  });
  await orchestrationWin.evaluate(() => window.dispatchEvent(new Event('focus')));
  await orchestrationWin.waitForTimeout(900);
  await expect(orchestrationWin.locator('#runbooks-content')).not.toContainText('Loop-back reset: pointer-defer-probe');
  await orchestrationWin.locator('#content').evaluate((element: HTMLElement) => {
    const EventCtor = window.PointerEvent || window.MouseEvent;
    element.dispatchEvent(new EventCtor('pointerup', { bubbles: true }));
  });
  await expect(orchestrationWin.locator('#runbooks-content')).toContainText('Loop-back reset: pointer-defer-probe');

  await appendMachineEvent(seeded.runRoot, {
    runId: seeded.runId,
    actor: 'machine',
    eventType: 'node.blocked',
    nodePath: 'main/probe',
    payload: {
      nodeExecutionId: `${seeded.runId}:main/probe:attempt-1`,
      nodeType: 'orpad.probe',
      attempt: 1,
      reason: 'orchestration-window-refresh-test',
    },
  });
  await orchestrationWin.locator('button[data-runbook-action="refresh"]').click();
  await expect(orchestrationWin.locator('#runbooks-content')).toContainText('Step blocked');

  const afterRefresh = await orchestrationWin.locator('[data-runbook-run-details]').evaluate((details: HTMLDetailsElement) => {
    const log = details.querySelector('[data-runbook-replay-events]') as HTMLElement | null;
    return {
      open: details.open,
      scrollTop: log?.scrollTop || 0,
    };
  });
  expect(afterRefresh.open).toBe(true);
  expect(Math.abs(afterRefresh.scrollTop - beforeScrollTop)).toBeLessThanOrEqual(8);
  await expect(orchestrationWin.locator('button[data-runbook-action="toggle-replay-stick"]')).toContainText('Manual scroll');

  const firstEvent = orchestrationWin.locator('[data-runbook-run-details] [data-runbook-replay-events] .runbook-event').first();
  const selectedText = (await firstEvent.textContent())?.trim().slice(0, 12) || 'Run started';
  await firstEvent.evaluate((el: HTMLElement) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });

  await appendMachineEvent(seeded.runRoot, {
    runId: seeded.runId,
    actor: 'machine',
    eventType: 'node.failed',
    nodePath: 'main/probe',
    payload: {
      nodeExecutionId: `${seeded.runId}:main/probe:attempt-2`,
      nodeType: 'orpad.probe',
      attempt: 2,
      reason: 'orchestration-window-refresh-test-selection',
    },
  });
  await orchestrationWin.evaluate(() => window.dispatchEvent(new Event('focus')));
  await orchestrationWin.waitForTimeout(900);
  await expect.poll(() => orchestrationWin.evaluate(() => window.getSelection()?.toString() || '')).toContain(selectedText);
  await expect(orchestrationWin.locator('#runbooks-content')).not.toContainText('Step failed');

  await orchestrationWin.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(orchestrationWin.locator('#runbooks-content')).toContainText('Step failed');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI resets transient replay and history state when switching workspaces with the same run id', async () => {
  const first = writeMachineWorkspace();
  const second = writeMachineWorkspace();
  const firstSeed = await seedReplayProjectionRun(first.workspace, first.pipelinePath);
  const secondSeed = await seedReplayProjectionRun(second.workspace, second.pipelinePath);
  expect(secondSeed.runId).toBe(firstSeed.runId);

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, first.workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  const runbar = win.locator('[data-pipeline-preview-runbar]');
  await expect(runbar).toContainText('progress 1/2');

  await win.locator('[data-runbook-run-details] summary').click();
  const slider = win.locator('[data-runbook-replay-slider]');
  await expect(slider).toBeVisible();
  await slider.evaluate((element: HTMLInputElement, value: string) => {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(firstSeed.replayPosition));
  await expect(win.locator('#runbooks-content')).toContainText('Replaying');
  await expect(runbar).toContainText('progress 1/1');

  const historySearch = win.locator('[data-runbook-history-search]');
  await expect(historySearch).toBeVisible();
  await historySearch.fill('no-such-run');
  await expect(win.locator('#runbooks-content')).toContainText('No runs match the current filter.');

  await win.locator('[data-runbook-run-details]').evaluate((element: HTMLDetailsElement) => {
    element.open = true;
  });
  const stickToggle = win.locator('button[data-runbook-action="toggle-replay-stick"]');
  await expect(stickToggle).toContainText('Auto-scroll');
  await stickToggle.click();
  await expect(stickToggle).toContainText('Manual scroll');

  const patchedDialog = await app.evaluate(({ dialog }, workspaceRoot) => {
    if (!dialog?.showOpenDialog) return false;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [workspaceRoot],
    });
    return true;
  }, second.workspace);
  expect(patchedDialog).toBe(true);

  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('file.openFolder');
  });
  const switchedRunbook = win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' });
  await expect(switchedRunbook).toBeVisible();
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');

  await expect(win.locator('#runbooks-content')).not.toContainText('Replaying');
  const switchedHistorySearch = win.locator('[data-runbook-history-search]');
  await expect.poll(async () => {
    if (await switchedHistorySearch.count() === 0) return '';
    return switchedHistorySearch.first().inputValue();
  }).toBe('');
  await expect(win.locator('#runbooks-content')).not.toContainText('No runs match the current filter.');
  if (await win.locator('[data-runbook-run-details]').count() === 0) {
    const selectedAfterSwitch = await switchedRunbook.evaluate((element: HTMLElement) => element.classList.contains('active'));
    if (selectedAfterSwitch) {
      await switchedRunbook.click();
      await expect(switchedRunbook).not.toHaveClass(/active/);
    }
    await switchedRunbook.click();
    await expect(win.locator('[data-runbook-run-details]')).toHaveCount(1);
  }
  await win.locator('[data-runbook-run-details]').evaluate((element: HTMLDetailsElement) => {
    element.open = true;
  });
  await expect(win.locator('button[data-runbook-action="toggle-replay-stick"]')).toContainText('Auto-scroll');

  await app.close();
  fs.rmSync(first.workspace, { recursive: true, force: true });
  fs.rmSync(second.workspace, { recursive: true, force: true });
});

test('Machine UI does not open a blocked decision modal for a normal waiting queue', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_waiting_active_queue',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  const baseProposal = pipeline.run.machineHarness.candidateProposal;
  const queuedItem = await ingestCandidateProposal(run.runRoot, {
    ...baseProposal,
    proposalId: 'proposal-machine-ui-queued-only',
    suggestedWorkItemId: 'machine-ui-queued-only',
    title: 'Queued work can continue without a blocker',
    fingerprint: 'machine-ui-queued-only:src/smoke-target.md',
  }, {
    runId: run.runId,
    transitionId: 'proposal:machine-ui-queued-only',
    now: '2026-05-01T00:00:01.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: queuedItem.item.id,
    toState: 'queued',
    reason: 'machine-ui.fixture.queued',
    transitionId: 'triage:machine-ui-queued-only',
    now: '2026-05-01T00:00:02.000Z',
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'waiting',
    reason: 'machine-ui.fixture.waiting',
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'partial',
    reason: 'machine-ui.fixture.partial',
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('#fmt-modal')).toBeHidden();
  await expect(win.locator('#runbooks-content')).toContainText('Work queue waiting');
  await expect(win.locator('#runbooks-content')).not.toContainText('Queue has blocked work');
  await expect(win.locator('button[data-runbook-action="machine-open-blocked-decision"]')).toHaveCount(0);
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeEnabled();

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI opens a decision modal for waiting runs with blocked queue work', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_blocked_queue_decision',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  const baseProposal = pipeline.run.machineHarness.candidateProposal;
  const blockedItem = await ingestCandidateProposal(run.runRoot, {
    ...baseProposal,
    proposalId: 'proposal-machine-ui-blocked',
    suggestedWorkItemId: 'machine-ui-blocked',
    title: 'Blocked queue item needs a decision',
    fingerprint: 'machine-ui-blocked:src/smoke-target.md',
  }, {
    runId: run.runId,
    transitionId: 'proposal:machine-ui-blocked',
    now: '2026-05-01T00:00:01.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: blockedItem.item.id,
    toState: 'blocked',
    reason: 'machine-ui.fixture.blocked',
    transitionId: 'triage:machine-ui-blocked',
    now: '2026-05-01T00:00:02.000Z',
  });
  const queuedItem = await ingestCandidateProposal(run.runRoot, {
    ...baseProposal,
    proposalId: 'proposal-machine-ui-queued',
    suggestedWorkItemId: 'machine-ui-queued',
    title: 'Queued queue item can continue',
    fingerprint: 'machine-ui-queued:src/smoke-target.md',
  }, {
    runId: run.runId,
    transitionId: 'proposal:machine-ui-queued',
    now: '2026-05-01T00:00:03.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: queuedItem.item.id,
    toState: 'queued',
    reason: 'machine-ui.fixture.queued',
    transitionId: 'triage:machine-ui-queued',
    now: '2026-05-01T00:00:04.000Z',
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'waiting',
    reason: 'machine-ui.fixture.waiting',
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'partial',
    reason: 'machine-ui.fixture.partial',
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('#fmt-modal')).toBeHidden();
  await expect(win.locator('#runbooks-content')).toContainText('Queue has blocked work');

  await win.getByRole('button', { name: 'Resolve Blocker', exact: true }).click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Run Blocked');
  await expect(win.locator('#fmt-modal-body')).toContainText('1 queued, 1 blocked');
  await expect(win.locator('#fmt-modal-body')).toContainText('machine-ui-blocked');
  await expect(win.locator('#fmt-modal-footer')).toContainText('Continue Queue');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI does not offer stop as the terminal blocked-queue follow-up', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_blocked_queue_exhausted',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  const baseProposal = pipeline.run.machineHarness.candidateProposal;
  const blockedItem = await ingestCandidateProposal(run.runRoot, {
    ...baseProposal,
    proposalId: 'proposal-machine-ui-terminal-blocked',
    suggestedWorkItemId: 'machine-ui-terminal-blocked',
    title: 'Blocked queue item remains for follow-up',
    fingerprint: 'machine-ui-terminal-blocked:src/smoke-target.md',
  }, {
    runId: run.runId,
    transitionId: 'proposal:machine-ui-terminal-blocked',
    now: '2026-05-01T00:00:01.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: blockedItem.item.id,
    toState: 'blocked',
    reason: 'machine-ui.fixture.blocked',
    transitionId: 'triage:machine-ui-terminal-blocked',
    now: '2026-05-01T00:00:02.000Z',
  });
  const doneItem = await ingestCandidateProposal(run.runRoot, {
    ...baseProposal,
    proposalId: 'proposal-machine-ui-terminal-done',
    suggestedWorkItemId: 'machine-ui-terminal-done',
    title: 'Done queue item',
    fingerprint: 'machine-ui-terminal-done:src/smoke-target.md',
  }, {
    runId: run.runId,
    transitionId: 'proposal:machine-ui-terminal-done',
    now: '2026-05-01T00:00:03.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: doneItem.item.id,
    toState: 'queued',
    reason: 'machine-ui.fixture.queued',
    transitionId: 'triage:machine-ui-terminal-done',
    now: '2026-05-01T00:00:04.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: doneItem.item.id,
    toState: 'claimed',
    reason: 'machine-ui.fixture.claimed',
    transitionId: 'claim:machine-ui-terminal-done',
    now: '2026-05-01T00:00:05.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: doneItem.item.id,
    toState: 'done',
    reason: 'machine-ui.fixture.done',
    transitionId: 'close:machine-ui-terminal-done',
    now: '2026-05-01T00:00:06.000Z',
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'waiting',
    reason: 'machine-ui.fixture.waiting',
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'partial',
    reason: 'machine-ui.fixture.partial',
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('#fmt-modal')).toBeHidden();
  await expect(win.locator('#runbooks-content')).toContainText('Queue has blocked work');
  await expect(win.locator('#runbooks-content')).toContainText('Blocked - no runnable work');
  await expect(win.locator('#runbooks-content')).toContainText('This run will not continue by itself');
  await expect(win.locator('#runbooks-content')).toContainText('Start follow-up');

  await win.getByRole('button', { name: 'Review Blocker', exact: true }).click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Run Blocked');
  await expect(win.locator('#fmt-modal-body')).toContainText('1 blocked, 1 done');
  await expect(win.locator('#fmt-modal-body')).toContainText('No runnable work');
  await expect(win.locator('#fmt-modal-body')).toContainText('No queued work remains');
  await expect(win.locator('#fmt-modal-footer')).toContainText('Start Follow-up');
  await expect(win.locator('#fmt-modal-footer')).toContainText('Review Evidence');
  await expect(win.locator('#fmt-modal-footer')).toContainText('Close');
  await expect(win.locator('#fmt-modal-footer')).not.toContainText('Stop Run');
  await expect(win.locator('#fmt-modal-footer')).not.toContainText('Cancel Remaining Work');
  await expect(win.locator('#fmt-modal-footer')).not.toContainText('Continue Queue');
  await win.locator('#fmt-modal-footer button').filter({ hasText: 'Start Follow-up' }).click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Start Follow-up');
  await expect(win.locator('#fmt-modal-body')).toContainText('Not an async wait');
  await expect(win.locator('[data-machine-follow-up-prompt]')).toHaveValue(/machine-ui-terminal-blocked/);
  await win.locator('#fmt-modal-close').click();
  await expect(win.locator('#fmt-modal')).toBeHidden();

  await win.getByRole('button', { name: 'Review Evidence', exact: true }).click();
  await expect(win.locator('.tab-item.active')).toContainText('Run Evidence');
  await expect(win.locator('.cm-content')).toContainText('Current Decision');
  await expect(win.locator('.cm-content')).toContainText('no runnable work remains');
  await expect(win.locator('.cm-content')).toContainText('Blocked Work');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI bubbles nested graph runtime state to the parent node', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  addNestedGraphProjectionFixture(pipelinePath);
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_nested_projection',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'running',
    reason: 'machine-ui.fixture.nested-active',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/context',
    eventType: 'node.completed',
    payload: {
      nodeExecutionId: `${run.runId}:main/context:attempt-1`,
      nodeType: 'orpad.context',
      status: 'completed',
      attempt: 1,
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/discovery-stage',
    eventType: 'node.completed',
    payload: {
      nodeExecutionId: `${run.runId}:main/discovery-stage:attempt-1`,
      nodeType: 'orpad.graph',
      status: 'completed',
      attempt: 1,
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'discovery/probe-a',
    eventType: 'node.started',
    payload: {
      nodeExecutionId: `${run.runId}:discovery/probe-a:attempt-1`,
      nodeType: 'orpad.probe',
      status: 'started',
      attempt: 1,
    },
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  const parentNode = win.locator('.orch-graph-node').filter({ hasText: 'Discovery stage' });
  await expect(parentNode).toContainText('Running');
  await expect(parentNode).toHaveClass(/runtime-running/);
  await expect(win.locator('.orch-transition[data-machine-edge-state="active"]')).toHaveCount(1);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI explains blocked overlay results and incomplete evidence', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_blocked_review',
    now: new Date('2026-05-01T00:00:00.000Z'),
    patchReviewMode: 'auto-apply',
  });
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  const baseProposal = pipeline.run.machineHarness.candidateProposal;
  const blockedItem = await ingestCandidateProposal(run.runRoot, {
    ...baseProposal,
    proposalId: 'proposal-machine-ui-blocked-review',
    suggestedWorkItemId: 'machine-ui-smoke',
    title: 'Exercise Machine UI worker execution',
    fingerprint: 'machine-ui-blocked-review:src/smoke-target.md',
  }, {
    runId: run.runId,
    transitionId: 'proposal:machine-ui-blocked-review',
    now: '2026-05-01T00:00:01.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: blockedItem.item.id,
    toState: 'blocked',
    reason: 'machine-ui.fixture.blocked-patch-review',
    transitionId: 'block:machine-ui-blocked-review',
    now: '2026-05-01T00:00:02.000Z',
  });
  const afterContent = 'after from blocked worker\nwith details\n';
  await registerPatchArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: 'artifacts/patches/worker.patch.json',
    producedBy: 'test.blocked-worker-review',
    patch: {
      schemaVersion: 'orpad.patchArtifact.v1',
      createdAt: '2026-05-01T00:00:05.000Z',
      allowedFiles: ['src/smoke-target.md', 'src/main/runbooks/validator.js'],
      changes: [{
        path: 'src/smoke-target.md',
        beforeExists: true,
        afterExists: true,
        beforeSha256: sha256Text('before\n'),
        afterSha256: sha256Text(afterContent),
        beforeContent: 'before\n',
        afterContent,
      }],
      violations: [],
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId: 'machine-ui-smoke',
    reason: 'worker-result.accepted',
    artifactRefs: [
      'artifacts/adapters/worker.transcript.json',
      'artifacts/patches/worker.patch.json',
    ],
    payload: {
      claimId: 'claim-machine-ui-smoke',
      adapterCallId: 'claim-machine-ui-smoke-graph-cli',
      attemptId: 'claim-machine-ui-smoke-graph-cli-attempt-1',
      idempotencyKey: 'claim-machine-ui-smoke-graph-cli:attempt-1',
      status: 'blocked',
      toState: 'blocked',
      patchArtifact: 'artifacts/patches/worker.patch.json',
      changedFiles: ['src/smoke-target.md'],
      verification: [{
        command: process.execPath,
        args: ['--version'],
        missingExpectedChanges: ['src/main/runbooks/validator.js'],
      }],
    },
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'blocked',
    reason: 'worker-result.accepted',
    payload: {
      itemId: 'machine-ui-smoke',
      workerStatus: 'blocked',
      message: 'CLI adapter result requires review before any canonical mutation.',
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'artifact-contract',
    eventType: 'node.completed',
    payload: {
      nodeExecutionId: `${run.runId}:artifact-contract:attempt-1`,
      nodeType: 'orpad.artifactContract',
      status: 'completed',
      attempt: 1,
      valid: false,
      onMissing: 'mark-partial',
      missingArtifactCount: 2,
      missingQueueCount: 1,
      inventory: { counts: { blocked: 1 } },
    },
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'waiting',
    reason: 'artifact-contract.mark-partial',
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'partial',
    reason: 'artifact-contract.mark-partial',
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('#runbooks-content')).toContainText('Waiting for decision');
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Patch ready$/ })).toHaveCount(0);
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Waiting$/ })).toHaveCount(0);
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Waiting for decision$/ })).toBeVisible();
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Review action required$/ })).toBeVisible();
  await expect(win.locator('#runbooks-content')).toContainText('1 changed file saved as blocked-work evidence; workspace files were not changed.');
  await expect(win.locator('#runbooks-content')).toContainText('Missing expected change: src/main/runbooks/validator.js.');
  await expect(win.locator('#runbooks-content')).toContainText('Evidence incomplete');
  await expect(win.locator('#runbooks-content')).toContainText('2 required evidence files missing; 1 required queue file missing');
  await expect(win.locator('#runbooks-content')).toContainText('Waiting for patch review');
  await expect(win.locator('#runbooks-content')).toContainText('No worker is running');
  await expect(win.locator('#runbooks-content')).toContainText('Review patches');
  await expect(win.locator('#fmt-modal')).toBeHidden();

  await win.locator('button[data-runbook-action="machine-open-blocked-decision"]').click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Patch Review Needed');
  await expect(win.locator('#fmt-modal-body')).toContainText('Patch review required');
  await expect(win.locator('#fmt-modal-body')).toContainText('1 changed file staged for patch review.');
  await expect(win.locator('#fmt-modal-footer')).toContainText('Review Patch');
  await expect(win.locator('#fmt-modal-footer')).toContainText('Review Evidence');
  await expect(win.locator('#fmt-modal-body')).not.toContainText('No queued work remains');
  await win.locator('#fmt-modal-footer button').filter({ hasText: 'Review Patch' }).click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Review Patch');
  await expect(win.locator('#fmt-modal-body')).toContainText('The run produced a patch');
  await expect(win.locator('#fmt-modal-body')).toContainText('Patch artifact: artifacts/patches/worker.patch.json');
  await expect(win.locator('[data-machine-patch-file][value="src/smoke-target.md"]')).toBeChecked();
  await expect(win.locator('#fmt-modal-footer')).toContainText('Continue with Prompt');
  await expect(win.locator('#fmt-modal-footer')).toContainText('Approve & Apply');
  const modalScroll = await win.locator('#fmt-modal-body').evaluate((el: HTMLElement) => ({
    overflowY: getComputedStyle(el).overflowY,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }));
  expect(modalScroll.overflowY).toBe('auto');
  expect(modalScroll.scrollHeight).toBeGreaterThan(0);
  expect(modalScroll.clientHeight).toBeGreaterThan(0);
  const patchListScroll = await win.locator('.machine-patch-change-list').evaluate((el: HTMLElement) => ({
    overflowY: getComputedStyle(el).overflowY,
  }));
  expect(patchListScroll.overflowY).toBe('auto');
  await win.locator('#fmt-modal-close').click();
  await expect(win.locator('#fmt-modal')).toBeHidden();

  await win.getByRole('button', { name: 'Review Evidence', exact: true }).click();
  await expect(win.locator('.tab-item.active')).toContainText('Run Evidence');
  await expect(win.locator('.tab-item.active')).not.toHaveClass(/modified/);
  await expect(win.locator('.cm-content')).toContainText('Patch Review');
  await expect(win.locator('.cm-content')).toContainText('Workspace changed: no, changes are staged in run evidence only');
  await expect(win.locator('.cm-content')).toContainText('Patch artifact: artifacts/patches/worker.patch.json');
  await win.locator('.cm-scroller').evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(win.locator('.cm-content')).toContainText('Patch artifact summary: 1 file change; 2 allowed files; 0 write-set violations.');
  await expect(win.locator('.cm-content')).toContainText('Review Patch opens the changed files with apply/skip controls.');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI follow-up on a stale multi-patch review advances to the next patch', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  fs.writeFileSync(path.join(workspace, 'src', 'stale-target.md'), 'current stale base\n');
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_stale_follow_up_next',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  const stalePatch = 'artifacts/patches/stale-follow-up.patch.json';
  const nextPatch = 'artifacts/patches/next-review.patch.json';
  await registerPatchArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: stalePatch,
    producedBy: 'test.stale-follow-up',
    patch: {
      schemaVersion: 'orpad.patchArtifact.v1',
      createdAt: '2026-05-01T00:00:05.000Z',
      allowedFiles: ['src/stale-target.md'],
      changes: [{
        path: 'src/stale-target.md',
        beforeExists: true,
        afterExists: true,
        beforeSha256: sha256Text('old stale base\n'),
        afterSha256: sha256Text('rebased stale result\n'),
        beforeContent: 'old stale base\n',
        afterContent: 'rebased stale result\n',
      }],
      violations: [],
    },
  });
  await registerPatchArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: nextPatch,
    producedBy: 'test.next-review',
    patch: {
      schemaVersion: 'orpad.patchArtifact.v1',
      createdAt: '2026-05-01T00:00:06.000Z',
      allowedFiles: ['src/smoke-target.md'],
      changes: [{
        path: 'src/smoke-target.md',
        beforeExists: true,
        afterExists: true,
        beforeSha256: sha256Text('before\n'),
        afterSha256: sha256Text('next review result\n'),
        beforeContent: 'before\n',
        afterContent: 'next review result\n',
      }],
      violations: [],
    },
  });
  for (const [patchArtifact, itemId, changedFile] of [
    [stalePatch, 'stale-follow-up-item', 'src/stale-target.md'],
    [nextPatch, 'next-review-item', 'src/smoke-target.md'],
  ] as const) {
    await appendMachineEvent(run.runRoot, {
      runId: run.runId,
      actor: 'machine',
      eventType: 'worker.result',
      itemId,
      reason: 'worker-result.accepted',
      artifactRefs: [patchArtifact],
      payload: {
        status: 'done',
        toState: 'done',
        patchArtifact,
        changedFiles: [changedFile],
        verification: [{ command: process.execPath, args: ['--version'] }],
      },
    });
  }
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'patch.review_required',
    reason: 'patch-review.test-fixture',
    artifactRefs: [stalePatch],
    payload: {
      patchArtifact: stalePatch,
      changedFiles: ['src/stale-target.md'],
      reason: 'stale-base-fixture',
    },
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'waiting',
    reason: 'machine-ui.fixture.waiting',
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'partial',
    reason: 'machine-ui.fixture.partial',
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('#fmt-modal')).toBeHidden();
  await win.locator('button[data-probe-action="review-patches"]').click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Rebase Required 1 of 2');
  await expect(win.locator('#fmt-modal-footer')).toContainText('Mark Follow-up & Next');
  await win.locator('#fmt-modal-footer button').filter({ hasText: 'Mark Follow-up & Next' }).click();
  await submitMachineCapabilityToken(win);
  await expect(win.locator('#fmt-modal-title')).toContainText('Review Patch 2 of 2');
  await expect(win.locator('#fmt-modal-body')).toContainText(nextPatch);
  await expect(win.locator('body')).not.toContainText('Patch contains out-of-write-set violations.');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI treats write-set violation patches as follow-up only', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_write_set_violation_follow_up',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  const unsafePatch = 'artifacts/patches/write-set-violation.patch.json';
  await registerPatchArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: unsafePatch,
    producedBy: 'test.write-set-violation',
    patch: {
      schemaVersion: 'orpad.patchArtifact.v1',
      createdAt: '2026-05-01T00:00:05.000Z',
      allowedFiles: ['src/smoke-target.md'],
      changes: [{
        path: 'src/smoke-target.md',
        beforeExists: true,
        afterExists: true,
        beforeSha256: sha256Text('before\n'),
        afterSha256: sha256Text('safe visible change\n'),
        beforeContent: 'before\n',
        afterContent: 'safe visible change\n',
      }],
      violations: [{ path: 'src/outside-write-set.md', reason: 'outside write set' }],
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId: 'unsafe-follow-up-item',
    reason: 'worker-result.accepted',
    artifactRefs: [unsafePatch],
    payload: {
      status: 'done',
      toState: 'done',
      patchArtifact: unsafePatch,
      changedFiles: ['src/smoke-target.md'],
      verification: [{ command: process.execPath, args: ['--version'] }],
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'patch.review_required',
    reason: 'patch-review.write-set-violation-fixture',
    artifactRefs: [unsafePatch],
    payload: {
      patchArtifact: unsafePatch,
      changedFiles: ['src/smoke-target.md'],
      reason: 'destructive_scope',
    },
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'waiting',
    reason: 'machine-ui.fixture.waiting',
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'partial',
    reason: 'machine-ui.fixture.partial',
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    (window as any).__orpadAlerts = [];
    window.alert = (message?: any) => {
      (window as any).__orpadAlerts.push(String(message ?? ''));
    };
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await win.locator('button[data-probe-action="review-patches"]').click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Follow-up Required');
  await expect(win.locator('#fmt-modal-body')).toContainText('write-set violation');
  await expect(win.locator('[data-machine-patch-file][value="src/smoke-target.md"]')).toBeDisabled();
  await expect(win.locator('#fmt-modal-footer')).toContainText('Start Follow-up with Prompt');
  await expect(win.locator('#fmt-modal-footer')).not.toContainText('Approve & Apply');
  await win.locator('#fmt-modal-footer button').filter({ hasText: 'Start Follow-up with Prompt' }).click();
  await submitMachineCapabilityToken(win);
  await expect(win.locator('#fmt-modal')).toBeHidden();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect.poll(async () => win.evaluate(() => (window as any).__orpadAlerts || []))
    .not.toContain('Patch contains out-of-write-set violations.');
  const events = await readMachineEvents(run.runRoot);
  const unsafePatchEvents = events.filter((event: any) => event?.payload?.patchArtifact === unsafePatch);
  expect(unsafePatchEvents.some((event: any) => event.eventType === 'patch.review_rejected')).toBe(true);
  expect(unsafePatchEvents.some((event: any) => ['patch.approved', 'patch.applied', 'patch.review_skipped'].includes(event.eventType))).toBe(false);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI play action attempts managed run and blocks non-runnable pipelines before creating runs', async () => {
  const { workspace, pipelinePath, pipelineDir } = writeMachineWorkspace();
  removeMachineHarness(pipelinePath);
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    (window as any).__orpadAlerts = [];
    window.alert = (message?: any) => {
      (window as any).__orpadAlerts.push(String(message ?? ''));
    };
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('runnable adapter');
  await expect(win.locator('button[data-pipeline-run-action="default"]')).toBeVisible();
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(win.locator('button[data-pipeline-run-action="managed"]')).toBeDisabled();
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(win.locator('button[data-pipeline-run-action="default"]')).toBeDisabled();
  await expect(win.locator('button[data-pipeline-run-action="default"]')).toHaveAttribute('title', /run\.machineHarness/);
  expect(fs.existsSync(path.join(pipelineDir, 'runs'))).toBe(false);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI implements node harness contracts for the selected pipeline', async () => {
  const { workspace, pipelinePath, pipelineDir } = writeMachineWorkspace();
  removeMachineHarness(pipelinePath);
  const staleRun = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_stale_before_harness',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  await appendMachineEvent(staleRun.runRoot, {
    runId: staleRun.runId,
    actor: 'machine',
    nodePath: 'main/probe',
    eventType: 'adapter.result',
    reason: 'proposal-only-result.failed',
    artifactRefs: ['artifacts/adapters/stale.transcript.json'],
    payload: {
      status: 'failed',
      adapter: 'codex-cli-proposal',
      adapterCallId: 'stale-harness-preflight-adapter',
      message: 'Stale run failure should not remain visible while implementing harness.',
    },
  });
  await appendRunLifecycleStatus(staleRun.runRoot, {
    runId: staleRun.runId,
    toState: 'cancelled',
    reason: 'machine-ui.fixture.stale-before-harness',
  });
  await appendRunSummaryStatus(staleRun.runRoot, {
    runId: staleRun.runId,
    summaryStatus: 'blocked',
    reason: 'machine-ui.fixture.stale-before-harness',
  });
  const labDir = path.join(workspace, 'ThreadProgramming', 'Unit3', 'Lab05_Semaphore');
  fs.mkdirSync(labDir, { recursive: true });
  fs.writeFileSync(path.join(labDir, 'Program.cs'), 'Console.WriteLine("Semaphore lab");\n');
  fs.writeFileSync(path.join(labDir, 'Lab05_Semaphore.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />\n');
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('runnable adapter');
  await expect(win.locator('#content.view-orch-graph')).toContainText('Run cancelled');
  await expect(win.locator('#content.view-orch-graph')).toContainText('Failed adapter calls (1)');
  await win.locator('[data-pipeline-run-menu]').click();
  await win.locator('button[data-pipeline-run-action="implement-harness"]').click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('Harness ready');
  await expect(win.locator('#content.view-orch-graph [data-harness-implementation-banner]')).toContainText('Harness ready');
  await expect(win.locator('#content.view-orch-graph')).not.toContainText('Run cancelled');
  await expect(win.locator('#content.view-orch-graph')).not.toContainText('Failed adapter calls');
  await expect(win.locator('#runbooks-content [data-harness-implementation-banner]')).toContainText('Harness ready');
  await expect(win.locator('#runbooks-content h3').filter({ hasText: 'Latest Run' })).toHaveCount(0);
  await expect(win.locator('#runbooks-content')).not.toContainText('Run cancelled');
  await expect(win.locator('#runbooks-content')).not.toContainText('Failed adapter calls');
  await expect(win.locator('#runbooks-content')).not.toContainText('Stale run failure should not remain visible while implementing harness.');
  const probeNode = win.locator('.orch-graph-node[data-machine-node-path="main/probe"]');
  await expect(probeNode).toContainText('Harness ready');
  await expect(probeNode).toHaveClass(/runtime-completed/);
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(win.locator('button[data-pipeline-run-action="managed"]')).toBeEnabled();

  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  expect(pipeline.run.machineAdapter.type).toBe('codex-cli');
  expect(pipeline.metadata.harnessImplementation.nodeCount).toBeGreaterThan(0);
  const statePath = path.join(pipelineDir, 'harness', 'generated', 'implementation-state.json');
  expect(fs.existsSync(statePath)).toBe(true);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  expect(state.status).toBe('succeeded');
  expect(state.nodes.every((node: any) => node.status === 'succeeded')).toBe(true);
  expect(state.projectProfile.stacks).toContain('dotnet');
  expect(state.projectProfile.requiredTools).toContain('dotnet');
  expect(state.harnessAuthoring.path).toBe('harness-authoring-spec.json');
  expect(state.harnessAuthoring.mode).toContain('deterministic');
  expect(state.provisioning.path).toBe('harness-provisioning.json');
  expect(['ready', 'degraded', 'blocked']).toContain(state.provisioning.status);
  const probeState = state.nodes.find((node: any) => node.nodePath === 'main/probe');
  expect(probeState).toBeTruthy();
  expect(fs.existsSync(path.join(pipelineDir, 'harness', 'generated', probeState.artifact))).toBe(true);
  const profilePath = path.join(pipelineDir, 'harness', 'generated', 'project-profile.json');
  const toolPlanPath = path.join(pipelineDir, 'harness', 'generated', 'tool-plan.json');
  const harnessSpecPath = path.join(pipelineDir, 'harness', 'generated', 'harness-authoring-spec.json');
  const provisioningPath = path.join(pipelineDir, 'harness', 'generated', 'harness-provisioning.json');
  const toolHealthPath = path.join(pipelineDir, 'harness', 'generated', 'tool-health.json');
  const validationPreflightPath = path.join(pipelineDir, 'harness', 'generated', 'validation-preflight.json');
  const mcpPlanPath = path.join(pipelineDir, 'harness', 'generated', 'mcp-plan.json');
  const toolPolicyPath = path.join(pipelineDir, 'harness', 'generated', 'tool-policy.json');
  const observabilityPlanPath = path.join(pipelineDir, 'harness', 'generated', 'observability-plan.json');
  const evalPlanPath = path.join(pipelineDir, 'harness', 'generated', 'eval-plan.json');
  const feedbackLoopPlanPath = path.join(pipelineDir, 'harness', 'generated', 'feedback-loop.json');
  const llmOpsPlanPath = path.join(pipelineDir, 'harness', 'generated', 'llmops-plan.json');
  const securityRiskPlanPath = path.join(pipelineDir, 'harness', 'generated', 'security-risk-plan.json');
  expect(fs.existsSync(profilePath)).toBe(true);
  expect(fs.existsSync(toolPlanPath)).toBe(true);
  expect(fs.existsSync(harnessSpecPath)).toBe(true);
  expect(fs.existsSync(provisioningPath)).toBe(true);
  expect(fs.existsSync(toolHealthPath)).toBe(true);
  expect(fs.existsSync(validationPreflightPath)).toBe(true);
  expect(fs.existsSync(mcpPlanPath)).toBe(true);
  expect(fs.existsSync(toolPolicyPath)).toBe(true);
  expect(fs.existsSync(observabilityPlanPath)).toBe(true);
  expect(fs.existsSync(evalPlanPath)).toBe(true);
  expect(fs.existsSync(feedbackLoopPlanPath)).toBe(true);
  expect(fs.existsSync(llmOpsPlanPath)).toBe(true);
  expect(fs.existsSync(securityRiskPlanPath)).toBe(true);
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
  const harnessSpec = JSON.parse(fs.readFileSync(harnessSpecPath, 'utf-8'));
  const provisioning = JSON.parse(fs.readFileSync(provisioningPath, 'utf-8'));
  const toolPolicy = JSON.parse(fs.readFileSync(toolPolicyPath, 'utf-8'));
  const evalPlan = JSON.parse(fs.readFileSync(evalPlanPath, 'utf-8'));
  expect(profile.stacks.some((stack: any) => stack.id === 'dotnet')).toBe(true);
  expect(profile.validationCommands.some((command: string) => command.includes('dotnet build'))).toBe(true);
  expect(profile.protocolContracts.some((contract: any) => contract.id === 'worker-patch')).toBe(true);
  expect(harnessSpec.schemaVersion).toBe('orpad.harnessAuthoringSpec.v1');
  expect(harnessSpec.nodeContracts.some((contract: any) => contract.nodePath === 'main/worker')).toBe(true);
  expect(provisioning.schemaVersion).toBe('orpad.harnessProvisioning.v1');
  expect(pipeline.harness.provisioning).toBe('harness/generated/harness-provisioning.json');
  expect(pipeline.harness.toolPolicy).toBe('harness/generated/tool-policy.json');
  expect(toolPolicy.schemaVersion).toBe('orpad.toolPolicy.v1');
  expect(evalPlan.schemaVersion).toBe('orpad.evalPlan.v1');
  const probeArtifact = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'harness', 'generated', probeState.artifact), 'utf-8'));
  expect(probeArtifact.environment.stacks.some((stack: any) => stack.id === 'dotnet')).toBe(true);
  expect(probeArtifact.protocols.some((contract: any) => contract.id === 'validation-evidence')).toBe(true);
  expect(probeArtifact.harnessAuthoring.nodeContract.nodePath).toBe('main/probe');
  expect(probeArtifact.provisioning.ref).toBe('harness-provisioning.json');
  expect(probeArtifact.provisioning.toolPolicyRef).toBe('tool-policy.json');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI shows harness implementation failure details on graph nodes', async () => {
  const { workspace, pipelinePath, pipelineDir } = writeMachineWorkspace();
  removeMachineHarness(pipelinePath);
  fs.mkdirSync(path.join(pipelineDir, 'harness', 'generated'), { recursive: true });
  fs.writeFileSync(path.join(pipelineDir, 'harness', 'generated', 'nodes'), 'blocks node artifact directory\n');
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  const implementHarnessButton = win.locator('button[data-pipeline-run-action="implement-harness"]').filter({ hasText: 'Implement Harness' });
  await expect.poll(async () => implementHarnessButton.evaluateAll((buttons: HTMLButtonElement[]) =>
    buttons.some(button => !button.disabled))).toBe(true);
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(implementHarnessButton).toBeVisible();
  await expect(implementHarnessButton).toBeEnabled();
  await implementHarnessButton.click();

  const failedContextNode = win.locator('.orch-graph-node[data-machine-node-path="main/context"]');
  await expect(failedContextNode).toContainText('Harness failed');
  await expect(failedContextNode).toHaveClass(/runtime-failed/);
  await failedContextNode.click({ button: 'right' });
  await expect(win.locator('.orch-context-menu')).toContainText('Failure details');
  await win.locator('button[data-orch-context-action="failure-details"]').click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Failure Details');
  await expect(win.locator('#fmt-modal-body')).toContainText('Harness implementation failed');
  await expect(win.locator('#fmt-modal-body')).toContainText('Solution choices');
  await win.getByRole('button', { name: 'Close' }).click();

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Pipes Refresh reloads selected managed run evidence from disk', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();

  await seedActiveClaimRun(workspace, pipelinePath, {
    runId: 'run_machine_ui_refresh_claim',
  });
  await win.locator('button[data-runbook-action="refresh"]').click();

  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(win.locator('#runbooks-content')).not.toContainText('run_machine_ui_refresh_claim');
  await expect(win.locator('#runbooks-content')).toContainText('1 work item in progress: machine-ui-smoke');
  await expect(win.locator('#runbooks-content')).toContainText('Ready to stop: machine-ui-smoke is in progress');
  await expect(win.locator('#runbooks-content')).toContainText('No evidence files yet');
  await expect(win.locator('#runbooks-content')).not.toContainText('No artifact manifest files yet');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI keeps gated managed run actions in the pipeline preview', async () => {
  const { workspace } = writeMachineWorkspace();
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '0',
    ORPAD_MACHINE_IPC_TOKEN: '',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await expect(win.locator('#runbooks-content')).not.toContainText('Machine Runtime');
  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('button[data-runbook-action="toggle-machine-ui"]')).toHaveCount(0);
  await expect(win.locator('button[data-runbook-action="run-machine"]')).toHaveCount(0);
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('Approve this session to start.');
  await expect(win.locator('[data-pipeline-preview-runbar]')).not.toContainText('main.or-graph');
  await win.waitForTimeout(250);
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(win.locator('button[data-pipeline-run-action="local"]')).toBeDisabled();
  const managedRun = win.locator('button[data-pipeline-run-action="managed"]');
  await expect(managedRun).toBeEnabled();
  await win.evaluate(() => {
    (window as any).__orpadAlerts = [];
    (window as any).__orpadConfirms = [];
    window.alert = (message?: any) => {
      (window as any).__orpadAlerts.push(String(message ?? ''));
    };
    window.confirm = (message?: any) => {
      (window as any).__orpadConfirms.push(String(message ?? ''));
      return true;
    };
  });
  await managedRun.click();
  await expect.poll(() => win.evaluate(() => ((window as any).__orpadConfirms || []).join('\n'))).toContain('Allow OrPAD to start runs');
  await confirmRunProviderSelection(win);
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(win.locator('#runbooks-content')).toContainText('Run started');
  await expect(win.locator('#runbooks-content')).toContainText('Work completed');
  await expect.poll(() => win.evaluate(() => ((window as any).__orpadAlerts || []).join('\n'))).toBe('');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI enabling IPC loads pending patch runs without auto-opening review modals', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_enable_pending_patch',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  const afterContent = 'after from enable pending patch\n';
  await registerPatchArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: 'artifacts/patches/enable-pending.patch.json',
    producedBy: 'test.enable-machine-pending-patch',
    patch: {
      schemaVersion: 'orpad.patchArtifact.v1',
      createdAt: '2026-05-01T00:00:05.000Z',
      allowedFiles: ['src/smoke-target.md'],
      changes: [{
        path: 'src/smoke-target.md',
        beforeExists: true,
        afterExists: true,
        beforeSha256: sha256Text('before\n'),
        afterSha256: sha256Text(afterContent),
        beforeContent: 'before\n',
        afterContent,
      }],
      violations: [],
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId: 'machine-ui-smoke',
    reason: 'worker-result.accepted',
    artifactRefs: ['artifacts/patches/enable-pending.patch.json'],
    payload: {
      status: 'blocked',
      toState: 'blocked',
      patchArtifact: 'artifacts/patches/enable-pending.patch.json',
      changedFiles: ['src/smoke-target.md'],
      verification: [{ command: process.execPath, args: ['--version'] }],
    },
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'waiting',
    reason: 'machine-ui.fixture.waiting',
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'partial',
    reason: 'machine-ui.fixture.partial',
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '0',
    ORPAD_MACHINE_IPC_TOKEN: '',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    (window as any).__orpadConfirms = [];
    window.confirm = (message?: any) => {
      (window as any).__orpadConfirms.push(String(message ?? ''));
      return true;
    };
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('button[data-runbook-action="enable-machine"]')).toBeVisible();
  await win.locator('button[data-runbook-action="enable-machine"]').click();
  await expect.poll(() => win.evaluate(() => ((window as any).__orpadConfirms || []).join('\n'))).toContain('Allow OrPAD to start runs');
  await expect(win.locator('#fmt-modal')).toBeHidden();
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(win.locator('#runbooks-content')).toContainText('Waiting for patch review');
  await expect(win.locator('#runbooks-content')).toContainText('No worker is running');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI renders pending approval state from a dispatcher pause', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  requireMachineApproval(pipelinePath);
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await enableMachineUi(win);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await win.locator('[data-pipeline-run-menu]').click();
  await win.locator('button[data-pipeline-run-action="managed-ask"]').click();
  await submitMachineCapabilityToken(win);
  await confirmRunProviderSelection(win);
  await expect(win.locator('#fmt-modal')).toBeVisible();
  await expect(win.locator('#fmt-modal-title')).toContainText('Run Approval Required');
  await win.getByRole('button', { name: 'Later' }).click();
  await expect(win.locator('#fmt-modal')).toBeHidden();

  await expect(win.locator('#runbooks-content')).toContainText('Permission requested');
  await expect(win.locator('#runbooks-content')).toContainText('Permission');
  await expect(win.locator('#runbooks-content')).toContainText('1 permission request waiting: machine-ui-smoke');
  await expect(win.locator('#runbooks-content')).toContainText('Recovery blocked: decide 1 permission request first');
  await expect(win.locator('#runbooks-content')).not.toContainText('Approval');
  await expect(win.locator('#runbooks-content')).toContainText('No work to stop');
  await expect(win.locator('#runbooks-content')).not.toContainText('No active claim to cancel');
  await expect(win.locator('#runbooks-content')).toContainText('No work result yet');
  await expect(win.locator('#runbooks-content')).not.toContainText('No artifact manifest files yet');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-export"]')).toBeEnabled();
  const approveButton = win.locator('#runbooks-content button[data-runbook-action="machine-approve-approval"]');
  const denyButton = win.locator('#runbooks-content button[data-runbook-action="machine-deny-approval"]');
  await expect(approveButton).toHaveText('Allow');
  await expect(denyButton).toHaveText('Decline');

  await approveButton.click();
  await expect(win.locator('#runbooks-content')).toContainText('Permission allowed');
  await expect(win.locator('#runbooks-content')).toContainText('1 permission decision: allowed');
  await expect(win.locator('#runbooks-content')).toContainText('Recovery ready');
  await expect(win.locator('#runbooks-content')).not.toContainText('Resume ready');
  await expect(win.locator('#runbooks-content')).not.toContainText('derived queue snapshots');
  await expect(win.locator('#runbooks-content')).not.toContainText('stale claims');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeEnabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeEnabled();

  if (await win.locator('#fmt-modal').isVisible().catch(() => false)) {
    const modalTitle = await win.locator('#fmt-modal-title').textContent();
    if (/Review Patch/.test(modalTitle || '')) {
      await skipPatchModalIfVisible(win);
    } else {
      await expect(win.locator('#fmt-modal-title')).toContainText('Run Blocked');
      await win.getByRole('button', { name: 'Continue Queue' }).click();
      await expect(win.locator('#fmt-modal')).not.toHaveClass(/busy|locked/);
      if (await win.locator('#fmt-modal').isVisible().catch(() => false)) {
        const nextTitle = await win.locator('#fmt-modal-title').textContent();
        if (/Review Patch/.test(nextTitle || '')) {
          await skipPatchModalIfVisible(win);
        } else {
          await win.locator('#fmt-modal-footer').getByRole('button', { name: /^(Decide Later|Close)$/ }).click();
          await expect(win.locator('#fmt-modal')).toBeHidden();
        }
      }
    }
  } else {
    await win.locator('#runbooks-content button[data-runbook-action="machine-execute-step"]').click();
  }
  await expect(win.locator('#runbooks-content')).toContainText('1 work item found');
  await expect(win.locator('#runbooks-content')).toContainText('Work result');
  await expect(win.locator('#runbooks-content')).toContainText('done');
  await expect(win.locator('#runbooks-content')).toContainText('Recovery unavailable: completed/done is finished');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeDisabled();

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI default run auto-drives approval gated work to patch review', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  requireMachineApproval(pipelinePath);
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await enableMachineUi(win);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await startManagedRunFromPreview(win);
  await submitMachineCapabilityToken(win);
  await confirmRunProviderSelection(win);

  await expect(win.locator('#runbooks-content')).toContainText('Permission allowed');
  await expect(win.locator('#runbooks-content')).not.toContainText('permission request waiting');
  await expect(win.locator('#runbooks-content')).toContainText('Work result');
  await expect(win.locator('#runbooks-content')).toContainText('done');
  await expect(win.locator('#fmt-modal-title')).toContainText('Review Patch');
  expect(fs.readFileSync(path.join(workspace, 'src', 'smoke-target.md'), 'utf-8')).toBe('before\n');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI switches between durable run history snapshots', async () => {
  const { workspace, pipelineDir } = writeMachineWorkspace();
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await enableMachineUi(win);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await startManagedRunFromPreview(win);
  await submitMachineCapabilityToken(win);
  await confirmRunProviderSelection(win);
  const runRoot = path.join(pipelineDir, 'runs');
  await expect.poll(() => fs.existsSync(runRoot) ? fs.readdirSync(runRoot).length : 0).toBe(1);
  const firstRunId = fs.readdirSync(runRoot)[0];

  await expect(win.locator('#runbooks-content')).toContainText('Work completed');
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 evidence files; 1 check; 1 changed file');
  await skipPatchModalIfVisible(win);

  await startManagedRunFromPreview(win);
  await confirmRunProviderSelection(win);
  await expect.poll(() => fs.existsSync(runRoot) ? fs.readdirSync(runRoot).length : 0).toBe(2);
  const runIds = fs.readdirSync(runRoot);
  const secondRunId = runIds.find(runId => runId !== firstRunId) || '';
  await expect(win.locator('#runbooks-content')).toContainText('History');
  await expect(win.locator('#runbooks-content')).toContainText('2 entries');
  await expect(win.locator('#runbooks-content')).toContainText('Work completed');
  await skipPatchModalIfVisible(win);

  const activeRunButton = win.locator('button[data-runbook-action="machine-select-run"].primary');
  await expect(activeRunButton).toBeVisible();
  const activeRunId = await activeRunButton.getAttribute('data-run-id') || secondRunId;
  const historyRunId = runIds.find(runId => runId !== activeRunId) || firstRunId;
  await win.locator(`button[data-runbook-action="machine-select-run"][data-run-id="${historyRunId}"]`).click();
  await expect(win.locator(`button[data-runbook-action="machine-select-run"][data-run-id="${historyRunId}"]`)).toHaveClass(/history-inspected/);
  await expect(win.locator('#runbooks-content')).not.toContainText(historyRunId);
  await expect(win.locator('#runbooks-content')).toContainText('Work completed');
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 evidence files; 1 check; 1 changed file');

  await win.locator(`button[data-runbook-action="machine-select-run"][data-run-id="${activeRunId}"]`).click();
  await expect(win.locator(`button[data-runbook-action="machine-select-run"][data-run-id="${activeRunId}"]`)).toHaveClass(/primary/);
  await expect(win.locator('#runbooks-content')).not.toContainText(activeRunId);
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 evidence files; 1 check; 1 changed file');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI cancels work in progress and releases visible locks', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const seeded = await seedActiveClaimRun(workspace, pipelinePath);
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await enableMachineUi(win);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('#runbooks-content')).not.toContainText(seeded.runId);
  await expect(win.locator('#runbooks-content')).toContainText('1 work item in progress: machine-ui-smoke');
  await expect(win.locator('#runbooks-content')).toContainText('1 reserved file: src/smoke-target.md');
  await expect(win.locator('#runbooks-content')).toContainText('Recovery paused: OrPAD is already working on this run');
  await expect(win.locator('#runbooks-content')).toContainText('Ready to stop: machine-ui-smoke is in progress');
  await expect(win.locator('#runbooks-content')).toContainText('Stop work');
  await expect(win.locator('#runbooks-content')).not.toContainText('Cancellation');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toHaveCount(0);
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeDisabled();
  const primaryRunButton = win.locator('[data-pipeline-preview-runbar] button.pipeline-run-primary');
  await expect(primaryRunButton).toBeEnabled();
  await expect(primaryRunButton).toHaveAttribute('data-pipeline-run-action', 'machine-cancel-run');
  await expect(primaryRunButton).toHaveAttribute('aria-label', 'Stop Run');

  await primaryRunButton.click();
  await submitMachineCapabilityToken(win);
  await expect(win.locator('#runbooks-content')).toContainText('Stopped: machine-ui-smoke; work reservation released');
  await expect(win.locator('#runbooks-content')).toContainText('No work in progress');
  await expect(win.locator('#runbooks-content')).toContainText('No reserved files');
  await expect(win.locator('#runbooks-content')).toContainText('Cancelled');
  await expect(win.locator('#runbooks-content')).toContainText('stopped');
  await expect(win.locator('button[data-runbook-action="machine-cancel-claim"]')).toHaveCount(0);
  expect(JSON.parse(fs.readFileSync(path.join(seeded.runRoot, 'queue', 'blocked', `${seeded.itemId}.json`), 'utf-8')).state).toBe('blocked');
  expect(JSON.parse(fs.readFileSync(path.join(seeded.runRoot, 'locks', 'claims', `${seeded.claimId}.json`), 'utf-8')).state).toBe('cancelled');
  expect(JSON.parse(fs.readFileSync(path.join(seeded.runRoot, 'locks', 'write-sets', `wset-${seeded.claimId}.json`), 'utf-8')).state).toBe('cancelled');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI recovers interrupted work and reports work state repair', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const seeded = await seedStaleClaimRun(workspace, pipelinePath);
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await enableMachineUi(win);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('#runbooks-content')).not.toContainText(seeded.runId);
  await expect(win.locator('#runbooks-content')).toContainText('1 work item in progress: machine-ui-smoke');
  await expect(win.locator('#runbooks-content')).toContainText('Recovery ready: 1 interrupted work item can be recovered before continuing');
  await expect(win.locator('#runbooks-content')).not.toContainText(/\bResume\b/);
  await expect(win.locator('#runbooks-content')).not.toContainText('derived queue snapshots');
  await expect(win.locator('#runbooks-content')).not.toContainText('stale claims');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeEnabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toHaveText('Recover');
  await expect(win.locator('button[data-runbook-action="machine-cancel-claim"]')).toBeEnabled();

  await win.locator('button[data-runbook-action="machine-resume-run"]').click();
  await submitMachineCapabilityToken(win);
  await expect(win.locator('#runbooks-content')).toContainText('Last recovery: 1 work state repair; 1 interrupted work item recovered; 1 queued');
  await expect(win.locator('#runbooks-content')).toContainText('No work in progress');
  await expect(win.locator('#runbooks-content')).toContainText('No reserved files');
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Waiting$/ })).toHaveCount(0);
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Queue waiting$/ })).toBeVisible();
  await expect(win.locator('#runbooks-content')).toContainText('Partial proof');
  await expect(win.locator('button[data-runbook-action="machine-cancel-claim"]')).toHaveCount(0);
  expect(JSON.parse(fs.readFileSync(path.join(seeded.runRoot, 'queue', 'queued', `${seeded.itemId}.json`), 'utf-8')).state).toBe('queued');
  expect(JSON.parse(fs.readFileSync(path.join(seeded.runRoot, 'locks', 'claims', `${seeded.claimId}.json`), 'utf-8')).state).toBe('expired');
  expect(JSON.parse(fs.readFileSync(path.join(seeded.runRoot, 'locks', 'write-sets', `wset-${seeded.claimId}.json`), 'utf-8')).state).toBe('expired');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI keeps denied approval runs terminal', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  requireMachineApproval(pipelinePath);
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await enableMachineUi(win);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await win.locator('[data-pipeline-run-menu]').click();
  await win.locator('button[data-pipeline-run-action="managed-ask"]').click();
  await submitMachineCapabilityToken(win);
  await confirmRunProviderSelection(win);
  await expect(win.locator('#fmt-modal')).toBeVisible();
  await expect(win.locator('#fmt-modal-title')).toContainText('Run Approval Required');
  await win.locator('#fmt-modal-footer').getByRole('button', { name: 'Decline' }).click();
  await expect(win.locator('#fmt-modal')).toBeHidden();

  await expect(win.locator('#runbooks-content')).toContainText('Permission declined');
  await expect(win.locator('#runbooks-content')).toContainText('1 permission decision: declined');
  await expect(win.locator('#runbooks-content')).toContainText('Cancelled');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeDisabled();

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI renders failure evidence from a failed runtime node', async () => {
  const { workspace, pipelineDir } = writeMachineWorkspace();
  appendFailingArtifactContract(pipelineDir);
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await enableMachineUi(win);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await startManagedRunFromPreview(win);
  await submitMachineCapabilityToken(win);
  await confirmRunProviderSelection(win);

  await expect(win.locator('#runbooks-content')).toContainText('MACHINE_ARTIFACT_CONTRACT_MISSING');
  await expect(win.locator('#runbooks-content')).toContainText('Required evidence missing: 1 evidence file');
  await expect(win.locator('#runbooks-content')).toContainText('main/artifact');
  await expect(win.locator('#runbooks-content')).toContainText('Step failed');
  const failedNode = win.locator('.orch-graph-node[data-machine-node-path="main/artifact"]');
  await expect(failedNode).toContainText('Failed');
  await failedNode.click({ button: 'right' });
  await expect(win.locator('.orch-context-menu')).toContainText('Failure details');
  await expect(win.locator('.orch-context-menu')).toContainText('Choose node model');
  await expect(win.locator('.orch-context-menu')).toContainText('Improve node prompt');
  await win.locator('button[data-orch-context-action="failure-details"]').click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Failure Details');
  await expect(win.locator('#fmt-modal-body')).toContainText('Failure reason');
  await expect(win.locator('#fmt-modal-body')).toContainText('Solution choices');
  await expect(win.locator('#fmt-modal-body')).toContainText('Choose a stronger or different model');
  await win.getByRole('button', { name: 'Close' }).click();

  const runRoot = path.join(pipelineDir, 'runs');
  const runDirs = fs.readdirSync(runRoot);
  expect(fs.readFileSync(path.join(runRoot, runDirs[0], 'events.jsonl'), 'utf-8')).toContain('node.failed');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});
