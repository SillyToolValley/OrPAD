import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchElectron } from '../helpers';

const {
  claimNextQueuedItem,
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
  await win.locator('.runbook-item').filter({ hasText: 'machine-workstream' }).click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('machine-workstream');
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('Ready for managed run or supervised handoff.');
  await expect(win.locator('button[data-pipeline-run-action="default"]')).toBeVisible();
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(win.locator('button[data-pipeline-run-action="local"]')).toBeDisabled();
  await expect(win.locator('button[data-pipeline-run-action="managed"]')).toContainText('Start Managed Run');
  await expect(win.locator('button[data-pipeline-run-action="handoff"]')).toContainText('Prepare Handoff');
  await win.locator('[data-pipeline-run-menu]').click();
  await win.locator('[data-runbook-task]').focus();
  await win.keyboard.press('Control+Enter');
  await submitMachineCapabilityToken(win);
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(win.locator('#runbooks-content')).toContainText(taskText);
  await expect(win.locator('#runbooks-content')).toContainText('run.created');

  const runRoot = path.join(pipelineDir, 'runs');
  await expect.poll(() => fs.existsSync(runRoot) ? fs.readdirSync(runRoot).length : 0).toBe(1);

  await expect(win.locator('#runbooks-content')).toContainText('adapter.requested');
  await expect(win.locator('#runbooks-content')).toContainText('worker.result');
  await expect(win.locator('#runbooks-content')).toContainText('queue.transition');
  await expect(win.locator('#runbooks-content')).toContainText('Candidate inventory');
  await expect(win.locator('#runbooks-content')).toContainText('1 candidate, 0 empty-pass');
  await expect(win.locator('#runbooks-content')).toContainText('Worker proof');
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 artifacts; 1 check; 1 changed file');
  await expect(win.locator('#runbooks-content')).toContainText('Resume unavailable: terminal completed/done');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-export"]')).toBeEnabled();
  expect(fs.readFileSync(path.join(workspace, 'src', 'smoke-target.md'), 'utf-8')).toBe('before\n');

  await win.locator('button[data-runbook-action="machine-export"]').click();
  await expect(win.locator('#runbooks-content')).toContainText('harness');
  await expect(win.locator('#runbooks-content')).toContainText('audit:orpad-machine-run');
  await expect.poll(() => fs.existsSync(path.join(pipelineDir, 'harness', 'generated', 'latest-run', 'run-metadata.json'))).toBe(true);
  await expect(win.locator('button[data-runbook-action="machine-view-artifacts"]')).toBeEnabled();
  await win.locator('button[data-runbook-action="machine-view-artifacts"]').click();
  await expect(win.locator('.tab-item.active')).toContainText('Run Artifacts');
  await expect(win.locator('.cm-content')).toContainText('Run Artifact Manifest');
  await win.locator('#btn-preview').click();
  await expect(win.locator('#content')).toContainText('artifacts/discovery/candidate-inventory.json');
  await expect(win.locator('#content')).toContainText('artifacts/patches');
  await expect(win.locator('#content')).toContainText('audit:orpad-machine-run');

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
  await win.locator('.runbook-item').filter({ hasText: 'machine-workstream' }).click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(win.locator('#runbooks-content')).toContainText(taskText);
  await expect(win.locator('#runbooks-content')).toContainText('worker.result');
  await expect(win.locator('#runbooks-content')).toContainText(runDirs[0]);
  await expect(win.locator('#runbooks-content')).toContainText('1 candidate, 0 empty-pass');
  await expect(win.locator('#runbooks-content')).toContainText('artifacts/discovery/candidate-inventory.json');
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 artifacts; 1 check; 1 changed file');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeDisabled();

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

  await win.locator('.runbook-item').filter({ hasText: 'machine-workstream' }).click();
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

  await win.locator('.runbook-item').filter({ hasText: 'machine-workstream' }).click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();

  await seedActiveClaimRun(workspace, pipelinePath, {
    runId: 'run_machine_ui_refresh_claim',
  });
  await win.locator('button[data-runbook-action="refresh"]').click();

  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(win.locator('#runbooks-content')).toContainText('run_machine_ui_refresh_claim');
  await expect(win.locator('#runbooks-content')).toContainText('1 active claim: machine-ui-smoke');
  await expect(win.locator('#runbooks-content')).toContainText('Cancel ready: claim claim-machine-ui-smoke owns machine-ui-smoke');

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
  await win.locator('.runbook-item').filter({ hasText: 'machine-workstream' }).click();
  await expect(win.locator('button[data-runbook-action="toggle-machine-ui"]')).toHaveCount(0);
  await expect(win.locator('button[data-runbook-action="run-machine"]')).toHaveCount(0);
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('approve this session');
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
  await expect.poll(() => win.evaluate(() => ((window as any).__orpadConfirms || []).join('\n'))).toContain('Enable managed runs');
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(win.locator('#runbooks-content')).toContainText('run.created');
  await expect(win.locator('#runbooks-content')).toContainText('worker.result');
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

  await win.locator('.runbook-item').filter({ hasText: 'machine-workstream' }).click();
  await startManagedRunFromPreview(win);
  await submitMachineCapabilityToken(win);

  await expect(win.locator('#runbooks-content')).toContainText('approval.requested');
  await expect(win.locator('#runbooks-content')).toContainText('Approval');
  await expect(win.locator('#runbooks-content')).toContainText('1 pending approval: machine-ui-smoke');
  await expect(win.locator('#runbooks-content')).toContainText('Resume blocked: 1 pending approval must be decided first');
  await expect(win.locator('#runbooks-content')).toContainText('No active claim to cancel');
  await expect(win.locator('#runbooks-content')).toContainText('No worker proof yet');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-export"]')).toBeEnabled();
  await expect(win.locator('button[data-runbook-action="machine-approve-approval"]')).toBeEnabled();
  await expect(win.locator('button[data-runbook-action="machine-deny-approval"]')).toBeEnabled();

  await win.locator('button[data-runbook-action="machine-approve-approval"]').click();
  await expect(win.locator('#runbooks-content')).toContainText('approval.decided');
  await expect(win.locator('#runbooks-content')).toContainText('1 approval decision: approved');
  await expect(win.locator('#runbooks-content')).toContainText('Resume ready');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeEnabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeEnabled();

  await win.locator('button[data-runbook-action="machine-execute-step"]').click();
  await expect(win.locator('#runbooks-content')).toContainText('1 candidate');
  await expect(win.locator('#runbooks-content')).toContainText('Worker proof');
  await expect(win.locator('#runbooks-content')).toContainText('done');
  await expect(win.locator('#runbooks-content')).toContainText('Resume unavailable: terminal completed/done');
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

  await win.locator('.runbook-item').filter({ hasText: 'machine-workstream' }).click();
  await startManagedRunFromPreview(win);
  await submitMachineCapabilityToken(win);
  const runRoot = path.join(pipelineDir, 'runs');
  await expect.poll(() => fs.existsSync(runRoot) ? fs.readdirSync(runRoot).length : 0).toBe(1);
  const firstRunId = fs.readdirSync(runRoot)[0];

  await expect(win.locator('#runbooks-content')).toContainText('worker.result');
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 artifacts; 1 check; 1 changed file');

  await startManagedRunFromPreview(win);
  await expect.poll(() => fs.existsSync(runRoot) ? fs.readdirSync(runRoot).length : 0).toBe(2);
  const runIds = fs.readdirSync(runRoot);
  const secondRunId = runIds.find(runId => runId !== firstRunId) || '';
  await expect(win.locator('#runbooks-content')).toContainText('Recent Runs');
  await expect(win.locator('#runbooks-content')).toContainText('2 recent runs');
  await expect(win.locator('#runbooks-content')).toContainText('worker.result');

  await win.locator(`button[data-runbook-action="machine-select-run"][data-run-id="${firstRunId}"]`).click();
  await expect(win.locator('#runbooks-content')).toContainText(firstRunId);
  await expect(win.locator('#runbooks-content')).toContainText('worker.result');
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 artifacts; 1 check; 1 changed file');

  await win.locator(`button[data-runbook-action="machine-select-run"][data-run-id="${secondRunId}"]`).click();
  await expect(win.locator('#runbooks-content')).toContainText(secondRunId);
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 artifacts; 1 check; 1 changed file');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI cancels an active claim and releases visible locks', async () => {
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

  await win.locator('.runbook-item').filter({ hasText: 'machine-workstream' }).click();
  await expect(win.locator('#runbooks-content')).toContainText(seeded.runId);
  await expect(win.locator('#runbooks-content')).toContainText('1 active claim: machine-ui-smoke');
  await expect(win.locator('#runbooks-content')).toContainText('1 active write-set lock: src/smoke-target.md');
  await expect(win.locator('#runbooks-content')).toContainText('Resume guarded: 1 active claim still owns work');
  await expect(win.locator('#runbooks-content')).toContainText('Cancel ready: claim claim-machine-ui-smoke owns machine-ui-smoke');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-cancel-claim"]')).toBeEnabled();

  await win.locator('button[data-runbook-action="machine-cancel-claim"]').click();
  await submitMachineCapabilityToken(win);
  await expect(win.locator('#runbooks-content')).toContainText('Last cancellation: machine-ui-smoke moved to blocked; claim claim-machine-ui-smoke released');
  await expect(win.locator('#runbooks-content')).toContainText('No active claims');
  await expect(win.locator('#runbooks-content')).toContainText('No active write-set locks');
  await expect(win.locator('#runbooks-content')).toContainText('cancelled');
  await expect(win.locator('#runbooks-content')).toContainText('blocked');
  await expect(win.locator('button[data-runbook-action="machine-cancel-claim"]')).toHaveCount(0);
  expect(JSON.parse(fs.readFileSync(path.join(seeded.runRoot, 'queue', 'blocked', `${seeded.itemId}.json`), 'utf-8')).state).toBe('blocked');
  expect(JSON.parse(fs.readFileSync(path.join(seeded.runRoot, 'locks', 'claims', `${seeded.claimId}.json`), 'utf-8')).state).toBe('cancelled');
  expect(JSON.parse(fs.readFileSync(path.join(seeded.runRoot, 'locks', 'write-sets', `wset-${seeded.claimId}.json`), 'utf-8')).state).toBe('cancelled');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI resumes stale claims and reports queue repair', async () => {
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

  await win.locator('.runbook-item').filter({ hasText: 'machine-workstream' }).click();
  await expect(win.locator('#runbooks-content')).toContainText(seeded.runId);
  await expect(win.locator('#runbooks-content')).toContainText('1 active claim: machine-ui-smoke');
  await expect(win.locator('#runbooks-content')).toContainText('Resume ready: 1 stale claim can be recovered before continuing');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeEnabled();
  await expect(win.locator('button[data-runbook-action="machine-cancel-claim"]')).toBeEnabled();

  await win.locator('button[data-runbook-action="machine-resume-run"]').click();
  await submitMachineCapabilityToken(win);
  await expect(win.locator('#runbooks-content')).toContainText('Last resume: 1 queue repair; 1 stale claim recovered; 1 queued');
  await expect(win.locator('#runbooks-content')).toContainText('No active claims');
  await expect(win.locator('#runbooks-content')).toContainText('No active write-set locks');
  await expect(win.locator('#runbooks-content')).toContainText('waiting');
  await expect(win.locator('#runbooks-content')).toContainText('partial');
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

  await win.locator('.runbook-item').filter({ hasText: 'machine-workstream' }).click();
  await startManagedRunFromPreview(win);
  await submitMachineCapabilityToken(win);
  await win.locator('button[data-runbook-action="machine-deny-approval"]').click();

  await expect(win.locator('#runbooks-content')).toContainText('approval.decided');
  await expect(win.locator('#runbooks-content')).toContainText('1 approval decision: denied');
  await expect(win.locator('#runbooks-content')).toContainText('cancelled');
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

  await win.locator('.runbook-item').filter({ hasText: 'machine-workstream' }).click();
  await startManagedRunFromPreview(win);
  await submitMachineCapabilityToken(win);

  await expect(win.locator('#runbooks-content')).toContainText('MACHINE_ARTIFACT_CONTRACT_MISSING');
  await expect(win.locator('#runbooks-content')).toContainText('Artifact contract missing: 1 artifacts');
  await expect(win.locator('#runbooks-content')).toContainText('main/artifact');
  await expect(win.locator('#runbooks-content')).toContainText('node.failed');

  const runRoot = path.join(pipelineDir, 'runs');
  const runDirs = fs.readdirSync(runRoot);
  expect(fs.readFileSync(path.join(runRoot, runDirs[0], 'events.jsonl'), 'utf-8')).toContain('node.failed');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});
