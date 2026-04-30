import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchElectron } from '../helpers';

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
  await win.evaluate(() => {
    localStorage.setItem('orpad-machine-ui-enabled', '1');
    sessionStorage.setItem('orpad-machine-capability-token', 'test-token');
  });
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'machine-workstream' }).click();
  await expect(win.locator('#runbooks-content')).toContainText('Machine-compatible');
  await expect(win.locator('button[data-runbook-action="run-machine"]')).toBeEnabled();
  await expect(win.locator('button[data-runbook-action="agent-handoff"]')).toContainText('Prepare Handoff');

  await win.locator('button[data-runbook-action="run-machine"]').click();
  await expect(win.locator('#runbooks-content')).toContainText('Machine Run');
  await expect(win.locator('#runbooks-content')).toContainText('run.created');
  await expect(win.locator('#runbooks-content')).toContainText('Latest-run export');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeEnabled();

  const runRoot = path.join(pipelineDir, 'runs');
  await expect.poll(() => fs.existsSync(runRoot) ? fs.readdirSync(runRoot).length : 0).toBe(1);

  await win.locator('button[data-runbook-action="machine-execute-step"]').click();
  await expect(win.locator('#runbooks-content')).toContainText('adapter.requested');
  await expect(win.locator('#runbooks-content')).toContainText('worker.result');
  await expect(win.locator('#runbooks-content')).toContainText('queue.transition');
  await expect(win.locator('#runbooks-content')).toContainText('Candidate inventory');
  await expect(win.locator('#runbooks-content')).toContainText('1 candidate, 0 empty-pass');
  await expect(win.locator('#runbooks-content')).toContainText('Worker proof');
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 artifacts; 1 check; 1 changed file');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-export"]')).toBeEnabled();
  expect(fs.readFileSync(path.join(workspace, 'src', 'smoke-target.md'), 'utf-8')).toBe('before\n');

  await win.locator('button[data-runbook-action="machine-export"]').click();
  await expect(win.locator('#runbooks-content')).toContainText('harness');
  await expect.poll(() => fs.existsSync(path.join(pipelineDir, 'harness', 'generated', 'latest-run', 'run-metadata.json'))).toBe(true);

  const runDirs = fs.readdirSync(runRoot);
  expect(fs.existsSync(path.join(runRoot, runDirs[0], 'run-state.json'))).toBe(true);
  expect(fs.existsSync(path.join(runRoot, runDirs[0], 'events.jsonl'))).toBe(true);
  expect(fs.readFileSync(path.join(runRoot, runDirs[0], 'events.jsonl'), 'utf-8')).toContain('run.created');
  expect(pipelinePath.endsWith('pipeline.or-pipeline')).toBe(true);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(() => {
    localStorage.setItem('orpad-machine-ui-enabled', '1');
    sessionStorage.setItem('orpad-machine-capability-token', 'test-token');
  });
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });
  await win.locator('.runbook-item').filter({ hasText: 'machine-workstream' }).click();
  await expect(win.locator('#runbooks-content')).toContainText('Machine Run');
  await expect(win.locator('#runbooks-content')).toContainText('worker.result');
  await expect(win.locator('#runbooks-content')).toContainText(runDirs[0]);
  await expect(win.locator('#runbooks-content')).toContainText('1 candidate, 0 empty-pass');
  await expect(win.locator('#runbooks-content')).toContainText('artifacts/discovery/candidate-inventory.json');
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 artifacts; 1 check; 1 changed file');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();

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
  await win.evaluate(() => {
    localStorage.setItem('orpad-machine-ui-enabled', '1');
    sessionStorage.setItem('orpad-machine-capability-token', 'test-token');
  });
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'machine-workstream' }).click();
  await win.locator('button[data-runbook-action="run-machine"]').click();
  await win.locator('button[data-runbook-action="machine-execute-step"]').click();

  await expect(win.locator('#runbooks-content')).toContainText('approval.requested');
  await expect(win.locator('#runbooks-content')).toContainText('Approval');
  await expect(win.locator('#runbooks-content')).toContainText('1 pending approval: machine-ui-smoke');
  await expect(win.locator('#runbooks-content')).toContainText('No worker proof yet');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-export"]')).toBeEnabled();
  await expect(win.locator('button[data-runbook-action="machine-approve-approval"]')).toBeEnabled();
  await expect(win.locator('button[data-runbook-action="machine-deny-approval"]')).toBeEnabled();

  await win.locator('button[data-runbook-action="machine-approve-approval"]').click();
  await expect(win.locator('#runbooks-content')).toContainText('approval.decided');
  await expect(win.locator('#runbooks-content')).toContainText('1 approval decision: approved');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeEnabled();

  await win.locator('button[data-runbook-action="machine-execute-step"]').click();
  await expect(win.locator('#runbooks-content')).toContainText('Worker proof');
  await expect(win.locator('#runbooks-content')).toContainText('done');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();

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
  await win.evaluate(() => {
    localStorage.setItem('orpad-machine-ui-enabled', '1');
    sessionStorage.setItem('orpad-machine-capability-token', 'test-token');
  });
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'machine-workstream' }).click();
  await win.locator('button[data-runbook-action="run-machine"]').click();
  await win.locator('button[data-runbook-action="machine-execute-step"]').click();

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
