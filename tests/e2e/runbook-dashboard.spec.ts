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
  const defaultPipelineRoot = path.join(workspace, '.orpad', 'pipelines', 'default-agent-workstream');
  fs.mkdirSync(path.join(defaultPipelineRoot, 'graphs'), { recursive: true });
  fs.writeFileSync(path.join(defaultPipelineRoot, 'graphs', 'main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'default-agent-workstream',
      nodes: [
        { id: 'context', type: 'orpad.context', label: 'Context', config: { summary: 'Collect context.' } },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Worker', config: { queueRef: 'queue' } },
      ],
      transitions: [],
    },
  }, null, 2));
  fs.writeFileSync(path.join(defaultPipelineRoot, 'pipeline.or-pipeline'), JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'default-agent-workstream',
    title: 'Default Agent Workstream',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    nodePacks: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3', origin: 'built-in' },
      { id: 'orpad.workstream', version: '>=0.1.0', origin: 'built-in' },
    ],
    maintenancePolicy: {
      handoff: {
        promptContract: 'path-only',
      },
    },
    run: {
      artifactRoot: 'harness/generated/latest-run/artifacts',
      queueRoot: 'harness/generated/latest-run/queue',
      metadataPath: 'harness/generated/latest-run/run-metadata.json',
    },
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
  }, null, 2));
  const templateRoot = path.join(workspace, 'nodes', 'orpad.workstream', 'examples');
  fs.mkdirSync(templateRoot, { recursive: true });
  fs.writeFileSync(path.join(templateRoot, 'maintenance-workstream.or-pipeline'), JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'maintenance-workstream-example',
    title: 'Maintenance Workstream Example',
    description: 'Example pipeline that should not appear as a runnable workspace pipeline.',
    template: true,
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    executionPolicy: {
      mode: 'template-only',
      copyBeforeRun: true,
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
  const templatesSection = win.locator('[data-runbook-section="templates"]');
  const legacySection = win.locator('[data-runbook-section="legacy"]');
  await expect(pipelinesSection.locator('.runbook-item[data-runbook-format="or-pipeline"]')
    .filter({ has: win.locator('strong').filter({ hasText: /^Agent Workstream$/ }) })).toBeVisible();
  await expect(pipelinesSection).not.toContainText('.orpad/pipelines');
  await expect(pipelinesSection).not.toContainText('pipeline.or-pipeline');
  await expect(pipelinesSection).not.toContainText('Maintenance Workstream Example');
  await expect(pipelinesSection).toContainText('2 pipelines');
  await expect(templatesSection).toContainText('Templates');
  await expect(templatesSection).toContainText('Maintenance Workstream Example');
  await expect(templatesSection).toContainText('1 template');
  await expect(templatesSection).not.toContainText('nodes/orpad.workstream');
  await expect(templatesSection).not.toContainText('maintenance-workstream.or-pipeline');
  await expect(pipelinesSection).not.toContainText('.orch-tree.json');
  await expect(legacySection).toContainText('Legacy Workflows');
  await expect(legacySection).toContainText('.orch-tree.json');
  await expect(legacySection).toContainText('1 legacy flow');
  const workspaceMeta = win.locator('[data-runbook-workspace-meta]');
  await expect(workspaceMeta).toContainText(path.basename(workspace));
  await expect(workspaceMeta).toContainText('2 pipelines');
  await expect(workspaceMeta).toContainText('1 legacy flow');
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
  expect(cachedIndex.pipelines.map((item: { path: string }) => item.path)).toContain('.orpad/pipelines/default-agent-workstream/pipeline.or-pipeline');
  expect(cachedIndex.pipelines.map((item: { path: string }) => item.path)).not.toContain('nodes/orpad.workstream/examples/maintenance-workstream.or-pipeline');
  expect(cachedIndex.templatePipelines.map((item: { path: string }) => item.path)).toContain('nodes/orpad.workstream/examples/maintenance-workstream.or-pipeline');
  expect(cachedIndex.legacyRunbooks.map((item: { path: string }) => item.path)).toContain('.orch-tree.json');
  expect(cachedIndex.redaction.contentIncluded).toBe(false);
  expect(cachedIndex.redaction.candidates.map((item: { path: string }) => item.path)).toContain('.env');

  await win.locator('.runbook-item').filter({ hasText: '.orch-tree.json' }).click();
  await expect(win.locator('.runbook-item.selected')).toContainText('.orch-tree.json');

  await win.locator('.runbook-item[data-runbook-format="or-pipeline"]')
    .filter({ has: win.locator('strong').filter({ hasText: /^Agent Workstream$/ }) })
    .click();
  await expect(win.locator('.runbook-item.selected')).toContainText('Agent Workstream');
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  const templatesAfterLatestRun = await win.evaluate(() => {
    const templates = document.querySelector('#runbooks-content [data-runbook-section="templates"]');
    const latestRun = [...document.querySelectorAll('#runbooks-content .runbook-panel-section h3')]
      .find(node => node.textContent?.trim() === 'Latest Run')
      ?.closest('.runbook-panel-section');
    return !!latestRun && !!templates && !!(latestRun.compareDocumentPosition(templates) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(templatesAfterLatestRun).toBe(true);
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  await expect(win.locator('[data-pipeline-preview-runbar] strong')).toContainText('Agent Workstream');
  await expect(win.locator('[data-pipeline-preview-runbar]')).not.toContainText('.orpad/pipelines');
  await expect(win.locator('[data-pipeline-preview-runbar]')).not.toContainText('pipeline.or-pipeline');
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
  await expect(win.locator('#fmt-modal-body')).toContainText('Evidence check becomes meaningful after the first cycle creates required evidence files');
  await expect(win.locator('#fmt-modal-body')).not.toContainText('RUN_REQUIRED_ARTIFACT_MISSING');
  await expect(win.locator('#fmt-modal-body')).not.toContainText('RUN_ARTIFACT_ROOT_MISSING');
  await expect(win.locator('#fmt-modal-body')).not.toContainText('dynamic import callback');
  await expect(win.locator('#fmt-modal-body')).not.toContainText('RUN_AUDIT_FAILED');
  await expect(win.locator('#fmt-modal-body')).toContainText('Required Checks');
  await expect(win.locator('#fmt-modal-body')).toContainText('audit:orpad-node-schemas');
  await expect(win.locator('#fmt-modal-body')).toContainText('audit:orpad-run');
  await expect(win.locator('#fmt-modal-body')).toContainText('agent-only steps');
  await expect(win.locator('#fmt-modal-body')).toContainText('Work queue');
  await expect(win.locator('#fmt-modal-body')).not.toContainText('orpad.context');
  await expect(win.locator('#fmt-modal-body')).not.toContainText('orpad.workQueue');
  await expect(win.locator('#fmt-modal-body')).not.toContainText('node-pack semantics');
  await expect(win.locator('#fmt-modal-body')).toContainText('agent-workstream/pipeline.or-pipeline');
  await expect(win.locator('#fmt-modal-body')).toContainText('custom-evidence/latest-summary.md');
  await expect(win.locator('#fmt-modal-body')).not.toContainText('harness/generated/latest-run/summary.md');
  await expect(win.locator('#fmt-modal-footer button').filter({ hasText: 'Copy Prompt' })).toBeVisible();
  await expect(win.locator('#fmt-modal-footer button').filter({ hasText: 'Copy Audits' })).toBeVisible();
  await expect(win.locator('#fmt-modal-footer button').filter({ hasText: 'Open Summary' })).toBeDisabled();
  await win.locator('#fmt-modal-close').click();
  await expect(win.locator('#fmt-modal')).toBeHidden();

  await win.locator('.runbook-item[data-runbook-format="or-pipeline"]')
    .filter({ has: win.locator('strong').filter({ hasText: /^Default Agent Workstream$/ }) })
    .click();
  await expect(win.locator('.runbook-item.selected')).toContainText('Default Agent Workstream');
  const defaultPipelinePath = path.join(workspace, '.orpad', 'pipelines', 'default-agent-workstream', 'pipeline.or-pipeline').replace(/\\/g, '/');
  const defaultRunbar = win.locator('[data-pipeline-preview-runbar]')
    .filter({ has: win.locator('strong').filter({ hasText: /^Default Agent Workstream$/ }) });
  await expect(defaultRunbar.locator('strong')).toContainText('Default Agent Workstream');
  await expect(defaultRunbar).toHaveAttribute('data-pipeline-path', defaultPipelinePath);
  await expect(defaultRunbar.locator('button[data-pipeline-run-action="handoff"]')).toHaveAttribute('data-path', defaultPipelinePath);
  await defaultRunbar.locator('[data-pipeline-run-menu]').click();
  await expect(defaultRunbar.locator('button[data-pipeline-run-action="handoff"]')).toBeEnabled();
  await defaultRunbar.locator('button[data-pipeline-run-action="handoff"]').click();
  await expect(win.locator('#fmt-modal')).toBeVisible();
  await expect(win.locator('#fmt-modal-title')).toContainText('Prepare Agent Handoff');
  const defaultPrompt = await win.locator('[data-agent-handoff-prompt]').inputValue();
  expect(defaultPrompt).toBe(`Run this OrPAD pipeline: ${defaultPipelinePath}`);
  expect(defaultPrompt).toContain(defaultPipelinePath);
  expect(defaultPrompt).toMatch(/^[\x00-\x7F]+$/);
  expect(defaultPrompt).not.toContain('undefined');
  expect(defaultPrompt).not.toContain('\\');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('toolbar opens Orchestration in a dedicated workspace window', async () => {
  const workspace = writeFixtureWorkspace();
  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('.cm-editor');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  await expect(win.locator('#btn-orchestration')).toBeVisible();
  await expect(win.locator('.sidebar-tab[data-panel="runbooks"]')).toBeHidden();

  const orchestrationWindowPromise = app.waitForEvent('window');
  await win.locator('#btn-orchestration').click();
  const orchestrationWin = await orchestrationWindowPromise;
  await orchestrationWin.waitForLoadState('domcontentloaded');
  await orchestrationWin.waitForSelector('body.orchestration-window');
  await orchestrationWin.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  await expect(orchestrationWin.locator('#btn-orchestration')).toHaveClass(/active/);
  await expect(orchestrationWin.locator('#sidebar-header')).toBeHidden();
  await expect(orchestrationWin.locator('#editor-pane')).toBeHidden();
  await expect(orchestrationWin.locator('#preview-pane')).toBeVisible();
  await expect(orchestrationWin.locator('#runbooks-content')).toContainText('Describe the work');
  await expect(orchestrationWin.locator('#runbooks-content')).toContainText('Generate Pipeline');
  await expect(orchestrationWin.locator('#runbooks-content [data-runbook-section="pipelines"]')).toHaveCount(0);
  await expect(orchestrationWin.locator('#toolbar #orchestration-runbar-slot [data-orchestration-runbar-placeholder]')).toBeVisible();
  await expect(orchestrationWin.locator('#toolbar #orchestration-runbar-slot')).toContainText('Select Pipeline');
  await orchestrationWin.locator('#toolbar [data-pipeline-select-trigger]').click();
  const pipelineOption = orchestrationWin.locator('#toolbar [data-orchestration-select-pipeline]')
    .filter({ has: orchestrationWin.locator('strong').filter({ hasText: /^Agent Workstream$/ }) });
  await expect(pipelineOption).toBeVisible();
  const pipelineOptionBox = await pipelineOption.boundingBox();
  expect(pipelineOptionBox?.width || 0).toBeGreaterThan(220);
  await pipelineOption.click();
  const toolbarRunbar = orchestrationWin.locator('#toolbar #orchestration-runbar-slot [data-pipeline-preview-runbar]');
  await expect(toolbarRunbar).toBeVisible();
  await expect(toolbarRunbar.locator('[data-pipeline-select-trigger] span')).toContainText('Agent Workstream');
  await expect(toolbarRunbar.locator('.pipeline-runbar-status').first()).toBeHidden();
  await expect(toolbarRunbar.locator('.pipeline-run-menu')).toBeHidden();
  await expect(toolbarRunbar.locator('.pipeline-select-menu')).toBeHidden();
  await toolbarRunbar.locator('[data-pipeline-run-menu]').click();
  const runMenuOption = toolbarRunbar.locator('.pipeline-run-menu button').filter({ hasText: 'Start Run' }).first();
  await expect(runMenuOption).toBeVisible();
  const runMenuOptionBox = await runMenuOption.boundingBox();
  expect(runMenuOptionBox?.width || 0).toBeGreaterThan(220);
  const toolbarZ = await orchestrationWin.locator('#toolbar').evaluate((el) => Number(getComputedStyle(el).zIndex) || 0);
  const graphToolbarZ = await orchestrationWin.locator('.orch-toolbar').first().evaluate((el) => Number(getComputedStyle(el).zIndex) || 0);
  expect(toolbarZ).toBeGreaterThan(graphToolbarZ);
  await toolbarRunbar.locator('.pipeline-run-menu-wrap').evaluate((el: HTMLElement) => el.removeAttribute('open'));
  await toolbarRunbar.locator('[data-pipeline-select-trigger]').click();
  const selectedPipelineOption = orchestrationWin.locator('#toolbar [data-orchestration-select-pipeline].selected');
  await expect(selectedPipelineOption).toBeVisible();
  const selectedPipelineOptionBox = await selectedPipelineOption.boundingBox();
  expect(selectedPipelineOptionBox?.width || 0).toBeGreaterThan(220);
  await toolbarRunbar.locator('[data-pipeline-run-menu]').click();
  await expect(selectedPipelineOption).toBeHidden();
  await expect(toolbarRunbar.locator('.pipeline-run-menu button').filter({ hasText: 'Start Run' }).first()).toBeVisible();
  await toolbarRunbar.locator('[data-pipeline-select-trigger]').click();
  await expect(toolbarRunbar.locator('.pipeline-run-menu button').filter({ hasText: 'Start Run' }).first()).toBeHidden();
  await expect(selectedPipelineOption).toBeVisible();
  await toolbarRunbar.locator('[data-pipeline-select]').evaluate((el: HTMLElement) => el.removeAttribute('open'));
  await expect(orchestrationWin.locator('#content [data-pipeline-preview-runbar]')).toHaveCount(0);
  await expect(orchestrationWin.locator('.orch-graph-node')).toHaveCount(6);
  const graphFrame = orchestrationWin.locator('[data-orch-frame]').first();
  await expect(graphFrame).toBeVisible();
  await graphFrame.locator('[data-orch-zoom="in"]').click();
  const viewport = graphFrame.locator('[data-orch-viewport]');
  const zoomedTransform = await viewport.evaluate((el: HTMLElement) => el.style.transform);
  const graphBoxBeforeClick = await graphFrame.boundingBox();
  expect(graphBoxBeforeClick).toBeTruthy();
  await orchestrationWin.mouse.click(
    (graphBoxBeforeClick?.x || 0) + (graphBoxBeforeClick?.width || 0) - 80,
    (graphBoxBeforeClick?.y || 0) + (graphBoxBeforeClick?.height || 0) - 80,
  );
  await orchestrationWin.waitForTimeout(120);
  await expect.poll(async () => await viewport.evaluate((el: HTMLElement) => el.style.transform)).toBe(zoomedTransform);
  await orchestrationWin.setViewportSize({ width: 1120, height: 620 });
  const compactGraphBox = await graphFrame.boundingBox();
  await orchestrationWin.setViewportSize({ width: 1120, height: 840 });
  await expect.poll(async () => (await graphFrame.boundingBox())?.height || 0).toBeGreaterThan((compactGraphBox?.height || 0) + 90);
  const runbarBox = await toolbarRunbar.boundingBox();
  const viewportWidth = await orchestrationWin.evaluate(() => window.innerWidth);
  expect(runbarBox?.y ?? 999).toBeLessThan(40);
  expect(Math.abs(((runbarBox?.x || 0) + (runbarBox?.width || 0) / 2) - (viewportWidth / 2))).toBeLessThan(36);

  await orchestrationWin.locator('#btn-orchestration').click();
  await expect(orchestrationWin.locator('body')).toHaveClass(/orchestration-rail-collapsed/);
  await expect(orchestrationWin.locator('#runbooks-content')).toBeHidden();
  await expect(orchestrationWin.locator('.orch-graph-node')).toHaveCount(6);

  await orchestrationWin.locator('#btn-orchestration').click();
  await expect(orchestrationWin.locator('body')).not.toHaveClass(/orchestration-rail-collapsed/);
  await expect(orchestrationWin.locator('#runbooks-content')).toBeVisible();

  const status = await win.evaluate(async () => {
    return await (window as any).orpad.orchestrationWindow.status();
  });
  expect(status.open).toBe(true);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Orchestration button asks for a project folder before opening', async () => {
  const workspace = writeFixtureWorkspace();
  const app = await launchElectron();
  const win = await app.firstWindow();

  const patchedDialog = await app.evaluate(({ dialog }, nextWorkspace) => {
    if (!dialog?.showOpenDialog) return false;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [nextWorkspace],
    });
    return true;
  }, workspace);
  expect(patchedDialog).toBe(true);

  const orchestrationWindowPromise = app.waitForEvent('window');
  await win.locator('#btn-orchestration').click();
  const orchestrationWin = await orchestrationWindowPromise;
  await orchestrationWin.waitForLoadState('domcontentloaded');
  await orchestrationWin.waitForSelector('body.orchestration-window');
  await orchestrationWin.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  await expect(orchestrationWin.locator('#runbooks-content')).toContainText(path.basename(workspace));
  await expect(orchestrationWin.locator('#runbooks-content [data-runbook-section="pipelines"]')).toHaveCount(0);
  await orchestrationWin.locator('#toolbar [data-pipeline-select-trigger]').click();
  await expect(orchestrationWin.locator('#toolbar [data-orchestration-select-pipeline]')
    .filter({ has: orchestrationWin.locator('strong').filter({ hasText: /^Agent Workstream$/ }) })).toBeVisible();

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('workspace switch clears stale selected pipeline and graph preview', async () => {
  const firstWorkspace = writeFixtureWorkspace();
  const emptyWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-runbook-empty-'));
  fs.writeFileSync(path.join(emptyWorkspace, 'README.md'), '# Empty pipeline workspace\n');
  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, firstWorkspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('.cm-editor');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });
  await win.locator('.runbook-item[data-runbook-format="or-pipeline"]')
    .filter({ has: win.locator('strong').filter({ hasText: /^Agent Workstream$/ }) })
    .click();
  await expect(win.locator('.runbook-item.selected')).toContainText('Agent Workstream');
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  await expect(win.locator('.orch-graph-node')).toHaveCount(6);

  const patchedDialog = await app.evaluate(({ dialog }, nextWorkspace) => {
    if (!dialog?.showOpenDialog) return false;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [nextWorkspace],
    });
    return true;
  }, emptyWorkspace);
  expect(patchedDialog).toBe(true);

  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('file.openFolder');
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await expect(win.locator('[data-runbook-workspace-meta] strong')).toContainText(path.basename(emptyWorkspace));
  await expect(win.locator('[data-runbook-section="pipelines"]')).toContainText('No OrPAD pipelines found yet');
  await expect(win.locator('.runbook-item.selected')).toHaveCount(0);
  await expect(win.locator('[data-pipeline-preview-runbar]')).toHaveCount(0);
  await expect(win.locator('.orch-graph-node')).toHaveCount(0);

  await app.close();
  fs.rmSync(firstWorkspace, { recursive: true, force: true });
  fs.rmSync(emptyWorkspace, { recursive: true, force: true });
});
