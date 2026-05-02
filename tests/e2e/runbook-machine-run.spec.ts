import { test, expect } from '@playwright/test';
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
  findQueueItem,
  ingestCandidateProposal,
  transitionQueueItem,
  writeQueueItem,
} = require('../../src/main/orchestration-machine');

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
      transitions: [],
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
    leaseMs: options.leaseMs ?? 7 * 24 * 60 * 60 * 1000,
    now: '2026-05-01T00:00:03.000Z',
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

async function enableMachineUi(win: any): Promise<void> {
  await win.evaluate(() => {
    localStorage.setItem('orpad-machine-ui-enabled', '1');
  });
}

async function submitMachineCapabilityToken(win: any): Promise<void> {
  await expect(win.locator('[data-machine-token-input]')).toBeVisible();
  await win.locator('[data-machine-token-input]').fill('test-token');
  await win.getByRole('button', { name: 'Use Token' }).click();
}

async function startManagedRunFromPreview(win: any): Promise<void> {
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  await win.locator('[data-pipeline-run-menu]').click();
  const managedRun = win.locator('button[data-pipeline-run-action="managed"]');
  await expect(managedRun).toBeEnabled();
  await managedRun.click();
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

  const taskText = 'Find competitor gaps and improve Pipes.';
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
  expect(fs.readFileSync(path.join(workspace, 'src', 'smoke-target.md'), 'utf-8')).toBe('before\n');

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
  await expect(win.locator('#content')).toContainText('artifacts/discovery/candidate-inventory.json');
  await expect(win.locator('#content')).toContainText('artifacts/patches');
  await expect(win.locator('#content')).toContainText('Evidence ready for review');

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
    nodePath: 'probe',
    eventType: 'node.started',
    payload: {
      nodeExecutionId: `${run.runId}:probe:attempt-1`,
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
  await expect(win.locator('button[data-pipeline-run-action="default"]')).toBeDisabled();
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(win.locator('button[data-pipeline-run-action="managed"]')).toBeDisabled();
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Running$/ })).toBeVisible();
  const continueButton = win.locator('button[data-runbook-action="machine-execute-step"]');
  await expect(continueButton).toBeDisabled();
  await expect(continueButton).toHaveAttribute('title', /OrPAD is already working/);
  const recoverButton = win.locator('button[data-runbook-action="machine-resume-run"]');
  await expect(recoverButton).toBeDisabled();
  await expect(recoverButton).toHaveAttribute('title', /OrPAD is already working/);
  await expect(win.locator('#runbooks-content')).toContainText('Run started');

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
  });
  const patchDir = path.join(run.runRoot, 'artifacts', 'patches');
  fs.mkdirSync(patchDir, { recursive: true });
  fs.writeFileSync(path.join(patchDir, 'worker.patch.json'), JSON.stringify({
    schemaVersion: 'orpad.patchArtifact.v1',
    createdAt: '2026-05-01T00:00:05.000Z',
    allowedFiles: ['src/smoke-target.md', 'src/main/runbooks/validator.js'],
    changes: [{
      path: 'src/smoke-target.md',
      beforeExists: true,
      afterExists: true,
      beforeSha256: '1111111111111111111111111111111111111111111111111111111111111111',
      afterSha256: '2222222222222222222222222222222222222222222222222222222222222222',
      beforeContent: 'before\n',
      afterContent: 'after from blocked worker\nwith details\n',
    }],
    violations: [],
  }, null, 2));
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
  await expect(win.locator('#runbooks-content')).toContainText('Review required');
  await expect(win.locator('#runbooks-content')).toContainText('1 changed file staged in run evidence; workspace files were not changed.');
  await expect(win.locator('#runbooks-content')).toContainText('Missing expected change: src/main/runbooks/validator.js.');
  await expect(win.locator('#runbooks-content')).toContainText('Evidence incomplete');
  await expect(win.locator('#runbooks-content')).toContainText('2 required evidence files missing; 1 required queue file missing');
  await expect(win.locator('#runbooks-content')).toContainText('Work needs review');
  await expect(win.locator('#runbooks-content')).toContainText('review needed; 2 evidence files; 1 check; 1 changed file');
  await win.locator('button[data-runbook-action="machine-view-artifacts"]').click();
  await expect(win.locator('.tab-item.active')).toContainText('Run Evidence');
  await expect(win.locator('.cm-content')).toContainText('Patch Review');
  await expect(win.locator('.cm-content')).toContainText('Workspace changed: no, changes are staged in run evidence only');
  await expect(win.locator('.cm-content')).toContainText('Patch artifact: artifacts/patches/worker.patch.json');
  await expect(win.locator('.cm-content')).toContainText('Patch artifact summary: 1 file change; 2 allowed files; 0 write-set violations.');
  await expect(win.locator('.cm-content')).toContainText('Continue runs the next machine step; it does not apply this patch to the workspace.');
  await expect(win.locator('.cm-content')).toContainText('`src/smoke-target.md`: Modified; 1 -> 2 lines (+1); SHA 111111111111 -> 222222222222');
  await expect(win.locator('.cm-content')).toContainText('Changed files staged in evidence: src/smoke-target.md');
  await expect(win.locator('.cm-content')).toContainText('Missing expected changes: src/main/runbooks/validator.js');

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
  await win.locator('button[data-pipeline-run-action="default"]').click();

  await expect.poll(() => win.evaluate(() => ((window as any).__orpadAlerts || []).join('\n'))).toContain('run.machineHarness');
  expect(fs.existsSync(path.join(pipelineDir, 'runs'))).toBe(false);

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
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(win.locator('#runbooks-content')).toContainText('Run started');
  await expect(win.locator('#runbooks-content')).toContainText('Work completed');
  await expect.poll(() => win.evaluate(() => ((window as any).__orpadAlerts || []).join('\n'))).toBe('');

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
  await startManagedRunFromPreview(win);
  await submitMachineCapabilityToken(win);

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
  await expect(win.locator('button[data-runbook-action="machine-approve-approval"]')).toHaveText('Allow');
  await expect(win.locator('button[data-runbook-action="machine-deny-approval"]')).toHaveText('Decline');

  await win.locator('button[data-runbook-action="machine-approve-approval"]').click();
  await expect(win.locator('#runbooks-content')).toContainText('Permission allowed');
  await expect(win.locator('#runbooks-content')).toContainText('1 permission decision: allowed');
  await expect(win.locator('#runbooks-content')).toContainText('Recovery ready');
  await expect(win.locator('#runbooks-content')).not.toContainText('Resume ready');
  await expect(win.locator('#runbooks-content')).not.toContainText('derived queue snapshots');
  await expect(win.locator('#runbooks-content')).not.toContainText('stale claims');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeEnabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeEnabled();

  await win.locator('button[data-runbook-action="machine-execute-step"]').click();
  await expect(win.locator('#runbooks-content')).toContainText('1 work item found');
  await expect(win.locator('#runbooks-content')).toContainText('Work result');
  await expect(win.locator('#runbooks-content')).toContainText('done');
  await expect(win.locator('#runbooks-content')).toContainText('Recovery unavailable: completed/done is finished');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeDisabled();

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
  const runRoot = path.join(pipelineDir, 'runs');
  await expect.poll(() => fs.existsSync(runRoot) ? fs.readdirSync(runRoot).length : 0).toBe(1);
  const firstRunId = fs.readdirSync(runRoot)[0];

  await expect(win.locator('#runbooks-content')).toContainText('Work completed');
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 evidence files; 1 check; 1 changed file');

  await startManagedRunFromPreview(win);
  await expect.poll(() => fs.existsSync(runRoot) ? fs.readdirSync(runRoot).length : 0).toBe(2);
  const runIds = fs.readdirSync(runRoot);
  const secondRunId = runIds.find(runId => runId !== firstRunId) || '';
  await expect(win.locator('#runbooks-content')).toContainText('History');
  await expect(win.locator('#runbooks-content')).toContainText('2 entries');
  await expect(win.locator('#runbooks-content')).toContainText('Work completed');

  await win.locator(`button[data-runbook-action="machine-select-run"][data-run-id="${firstRunId}"]`).click();
  await expect(win.locator(`button[data-runbook-action="machine-select-run"][data-run-id="${firstRunId}"]`)).toHaveClass(/primary/);
  await expect(win.locator('#runbooks-content')).not.toContainText(firstRunId);
  await expect(win.locator('#runbooks-content')).toContainText('Work completed');
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 evidence files; 1 check; 1 changed file');

  await win.locator(`button[data-runbook-action="machine-select-run"][data-run-id="${secondRunId}"]`).click();
  await expect(win.locator(`button[data-runbook-action="machine-select-run"][data-run-id="${secondRunId}"]`)).toHaveClass(/primary/);
  await expect(win.locator('#runbooks-content')).not.toContainText(secondRunId);
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
  await expect(win.locator('#runbooks-content')).toContainText('Recovery paused: 1 work item in progress');
  await expect(win.locator('#runbooks-content')).toContainText('Ready to stop: machine-ui-smoke is in progress');
  await expect(win.locator('#runbooks-content')).toContainText('Stop work');
  await expect(win.locator('#runbooks-content')).not.toContainText('Cancellation');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-cancel-claim"]')).toBeEnabled();
  await expect(win.locator('button[data-runbook-action="machine-cancel-claim"]')).toHaveText('Stop Work');

  await win.locator('button[data-runbook-action="machine-cancel-claim"]').click();
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
  await expect(win.locator('#runbooks-content')).toContainText('Last recovery: 1 work state repair; 1 interrupted work item recovered; 1 ready');
  await expect(win.locator('#runbooks-content')).toContainText('No work in progress');
  await expect(win.locator('#runbooks-content')).toContainText('No reserved files');
  await expect(win.locator('#runbooks-content')).toContainText('Waiting');
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
  await startManagedRunFromPreview(win);
  await submitMachineCapabilityToken(win);
  await win.locator('button[data-runbook-action="machine-deny-approval"]').click();

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

  await expect(win.locator('#runbooks-content')).toContainText('MACHINE_ARTIFACT_CONTRACT_MISSING');
  await expect(win.locator('#runbooks-content')).toContainText('Required evidence missing: 1 evidence file');
  await expect(win.locator('#runbooks-content')).toContainText('main/artifact');
  await expect(win.locator('#runbooks-content')).toContainText('Step failed');

  const runRoot = path.join(pipelineDir, 'runs');
  const runDirs = fs.readdirSync(runRoot);
  expect(fs.readFileSync(path.join(runRoot, runDirs[0], 'events.jsonl'), 'utf-8')).toContain('node.failed');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});
