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

function writeNodeSchema(workspace: string, fileName: string, type: string, properties: Record<string, unknown>): void {
  const nodeRoot = path.join(workspace, 'nodes', 'orpad.test', 'nodes');
  fs.mkdirSync(nodeRoot, { recursive: true });
  fs.writeFileSync(path.join(nodeRoot, fileName), JSON.stringify({
    kind: 'orpad.node',
    schemaVersion: '1.0',
    type,
    label: type,
    configSchema: {
      type: 'object',
      properties,
    },
  }, null, 2));
}

function writeFixtureWorkspace(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-runbook-ui-'));
  fs.mkdirSync(path.join(workspace, 'skills'), { recursive: true });
  writeNodeSchema(workspace, 'context.or-node', 'orpad.context', { summary: { type: 'string' } });
  writeNodeSchema(workspace, 'probe.or-node', 'orpad.probe', { lens: { type: 'string' }, maxCandidates: { type: 'number' } });
  writeNodeSchema(workspace, 'work-queue.or-node', 'orpad.workQueue', { queueRoot: { type: 'string' }, schema: { type: 'string' } });
  writeNodeSchema(workspace, 'triage.or-node', 'orpad.triage', { queueRef: { type: 'string' } });
  writeNodeSchema(workspace, 'dispatcher.or-node', 'orpad.dispatcher', { queueRef: { type: 'string' }, workerLoopRef: { type: 'string' } });
  writeNodeSchema(workspace, 'worker-loop.or-node', 'orpad.workerLoop', { queueRef: { type: 'string' } });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Fixture\n\nVersion claim: 1.0.0\n');
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ version: '1.0.1' }, null, 2));
  fs.writeFileSync(path.join(workspace, '.env'), 'SECRET_TOKEN=redacted\n');
  fs.writeFileSync(path.join(workspace, 'skills', 'audit.md'), '# Audit Claims\n\n## Acceptance Criteria\n\n- Produce a claim register.\n');
  const generatedEvidenceRoot = path.join(workspace, '.orpad', 'pipelines', 'stale-run', 'harness', 'generated', 'latest-run');
  fs.mkdirSync(path.join(generatedEvidenceRoot, 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(generatedEvidenceRoot, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(generatedEvidenceRoot, 'artifacts', 'summary.md'), '# Stale generated evidence\n');
  fs.writeFileSync(path.join(generatedEvidenceRoot, 'queue', 'journal.jsonl'), '{"stale":true}\n');
  const pipelineRoot = path.join(workspace, '.orpad', 'pipelines', 'agent-workstream');
  fs.mkdirSync(path.join(pipelineRoot, 'graphs'), { recursive: true });
  fs.writeFileSync(path.join(pipelineRoot, 'graphs', 'main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'agent-workstream',
      nodes: [
        { id: 'context', type: 'orpad.context', label: 'Context', config: { summary: 'Collect context.' } },
        { id: 'probe', type: 'orpad.probe', label: 'Probe', config: { lens: 'bug-risk', maxCandidates: 1 } },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', label: 'Triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Worker', config: { queueRef: 'queue' } },
      ],
      transitions: [],
    },
  }, null, 2));
  fs.writeFileSync(path.join(pipelineRoot, 'pipeline.or-pipeline'), JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'agent-workstream',
    title: 'Agent Workstream',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    nodePacks: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3', origin: 'built-in' },
      { id: 'orpad.workstream', version: '>=0.1.0', origin: 'built-in' },
    ],
    maintenancePolicy: {
      handoff: {
        promptContract: 'path-only',
        launchPromptShape: '<pipeline.or-pipeline path> --custom-handoff',
      },
    },
    run: {
      artifactRoot: 'harness/generated/latest-run/artifacts',
      queueRoot: 'harness/generated/latest-run/queue',
      metadataPath: 'harness/generated/latest-run/run-metadata.json',
      summaryPath: 'custom-evidence/latest-summary.md',
    },
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
    executionPolicy: {
      verificationDefaults: [
        'npm run audit:orpad-node-schemas -- .orpad/pipelines/agent-workstream/pipeline.or-pipeline',
        'npm run audit:orpad-run -- .orpad/pipelines/agent-workstream/pipeline.or-pipeline',
      ],
    },
  }, null, 2));
  fs.writeFileSync(path.join(workspace, '.orch-tree.json'), JSON.stringify({
    $schema: 'https://orchpad.dev/schemas/orch-tree/v4.1.json',
    version: '4.1',
    trees: [
      {
        id: 'release-audit',
        label: 'Release audit',
        root: {
          id: 'root',
          type: 'Sequence',
          label: 'Audit release claims',
          children: [
            { id: 'context', type: 'Context', label: 'Collect context' },
            { id: 'audit', type: 'Skill', label: 'Audit', file: 'skills/audit.md' },
          ],
        },
      },
    ],
  }, null, 2));
  return workspace;
}

test('pipelines sidebar keeps the local flow simple and validates selected entries', async () => {
  const workspace = writeFixtureWorkspace();
  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('.cm-editor');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await expect(win.locator('#sidebar-runbooks')).toBeVisible();
  await expect(win.locator('#runbooks-content')).toContainText('Describe the work');
  await expect(win.locator('#runbooks-content')).toContainText('Generate Pipeline');
  await expect(win.locator('#runbooks-content')).toContainText('Pipelines');
  await expect(win.locator('#runbooks-content')).toContainText('.orch-tree.json');
  const pipelinesSection = win.locator('[data-runbook-section="pipelines"]');
  const legacySection = win.locator('[data-runbook-section="legacy"]');
  await expect(pipelinesSection.locator('.runbook-item[data-runbook-format="or-pipeline"] strong')).toContainText('Agent Workstream');
  await expect(pipelinesSection).toContainText('agent-workstream');
  await expect(pipelinesSection).toContainText('1 pipeline');
  await expect(pipelinesSection).not.toContainText('.orch-tree.json');
  await expect(legacySection).toContainText('Legacy Workflows');
  await expect(legacySection).toContainText('.orch-tree.json');
  await expect(legacySection).toContainText('1 legacy graph');
  const workspaceMeta = win.locator('[data-runbook-workspace-meta]');
  await expect(workspaceMeta).toContainText(path.basename(workspace));
  await expect(workspaceMeta).toContainText('1 pipeline');
  await expect(workspaceMeta).toContainText('1 legacy graph');
  await expect(workspaceMeta).not.toContainText(workspace);
  await expect(workspaceMeta).toHaveAttribute('title', workspace.replace(/\\/g, '/'));
  const cacheDir = path.join(userData, 'workspace-index');
  expect(fs.existsSync(cacheDir)).toBe(true);
  const cacheFiles = fs.readdirSync(cacheDir).filter(name => name.endsWith('.json'));
  expect(cacheFiles.length).toBeGreaterThan(0);
  const cachedIndex = JSON.parse(fs.readFileSync(path.join(cacheDir, cacheFiles[0]), 'utf-8'));
  expect(cachedIndex.workspace.fileCount).toBeGreaterThanOrEqual(13);
  expect(Array.isArray(cachedIndex.pipelines)).toBe(true);
  expect(cachedIndex.pipelines.map((item: { path: string }) => item.path)).toContain('.orpad/pipelines/agent-workstream/pipeline.or-pipeline');
  expect(cachedIndex.legacyRunbooks.map((item: { path: string }) => item.path)).toContain('.orch-tree.json');
  expect(cachedIndex.redaction.contentIncluded).toBe(false);
  expect(cachedIndex.redaction.candidates.map((item: { path: string }) => item.path)).toContain('.env');

  await win.locator('.runbook-item').filter({ hasText: '.orch-tree.json' }).click();
  await expect(win.locator('.runbook-item.selected')).toContainText('.orch-tree.json');

  await win.locator('.runbook-item').filter({ hasText: 'Agent Workstream' }).click();
  await expect(win.locator('.runbook-item.selected')).toContainText('Agent Workstream');
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(win.locator('button[data-pipeline-run-action="handoff"]')).toContainText('Prepare Handoff');
  await expect(win.locator('button[data-pipeline-run-action="handoff"]')).toBeEnabled();
  await expect(win.locator('button[data-runbook-action="latest-summary"]')).toHaveCount(0);
  await win.locator('button[data-pipeline-run-action="handoff"]').click();
  await expect(win.locator('#fmt-modal')).toBeVisible();
  await expect(win.locator('#fmt-modal-title')).toContainText('Prepare Agent Handoff');
  const expectedPrompt = `${path.join(workspace, '.orpad', 'pipelines', 'agent-workstream', 'pipeline.or-pipeline').replace(/\\/g, '/')} --custom-handoff`;
  await expect(win.locator('[data-agent-handoff-prompt]')).toHaveValue(expectedPrompt);
  await expect(win.locator('#fmt-modal-body')).toContainText('Latest Run / Cycle Evidence');
  await expect(win.locator('#fmt-modal-body')).toContainText('ready for first cycle');
  await expect(win.locator('#fmt-modal-body')).toContainText('No latest cycle evidence exists yet');
  await expect(win.locator('#fmt-modal-body')).toContainText('Run evidence audit becomes meaningful after the first cycle creates required artifacts');
  await expect(win.locator('#fmt-modal-body')).not.toContainText('RUN_REQUIRED_ARTIFACT_MISSING');
  await expect(win.locator('#fmt-modal-body')).not.toContainText('RUN_ARTIFACT_ROOT_MISSING');
  await expect(win.locator('#fmt-modal-body')).not.toContainText('dynamic import callback');
  await expect(win.locator('#fmt-modal-body')).not.toContainText('RUN_AUDIT_FAILED');
  await expect(win.locator('#fmt-modal-body')).toContainText('Required Audits');
  await expect(win.locator('#fmt-modal-body')).toContainText('audit:orpad-node-schemas');
  await expect(win.locator('#fmt-modal-body')).toContainText('audit:orpad-run');
  await expect(win.locator('#fmt-modal-body')).toContainText('agent-workstream/pipeline.or-pipeline');
  await expect(win.locator('#fmt-modal-body')).toContainText('custom-evidence/latest-summary.md');
  await expect(win.locator('#fmt-modal-body')).not.toContainText('harness/generated/latest-run/summary.md');
  await expect(win.locator('#fmt-modal-footer button').filter({ hasText: 'Copy Prompt' })).toBeVisible();
  await expect(win.locator('#fmt-modal-footer button').filter({ hasText: 'Copy Audits' })).toBeVisible();
  await expect(win.locator('#fmt-modal-footer button').filter({ hasText: 'Open Summary' })).toBeDisabled();

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});
