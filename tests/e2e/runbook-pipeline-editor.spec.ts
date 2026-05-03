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

function writePipelineWorkspace(): { workspace: string; pipelinePath: string } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-pipeline-editor-'));
  const pipelineRoot = path.join(workspace, '.orpad', 'pipelines', 'editor-fixture');
  fs.mkdirSync(path.join(pipelineRoot, 'graphs'), { recursive: true });
  fs.mkdirSync(path.join(pipelineRoot, 'trees'), { recursive: true });
  fs.mkdirSync(path.join(pipelineRoot, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(pipelineRoot, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(pipelineRoot, 'graphs', 'main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'editor-fixture',
      nodes: [
        { id: 'reference-context', type: 'Context', label: 'Collect context' },
        { id: 'implementation', type: 'OrchTree', label: 'Implementation', config: { ref: '../trees/implementation.or-tree' } },
        { id: 'quality-graph', type: 'orpad.graph', label: 'Quality graph', config: { graphRef: 'quality.or-graph' } },
      ],
      transitions: [
        { from: 'reference-context', to: 'implementation' },
        { from: 'implementation', to: 'quality-graph' },
      ],
    },
  }, null, 2));
  fs.writeFileSync(path.join(pipelineRoot, 'graphs', 'quality.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'quality',
      nodes: [
        { id: 'probe', type: 'orpad.probe', label: 'Probe UI quality', config: { lens: 'ux-ui' } },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue findings', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
      ],
      transitions: [{ from: 'probe', to: 'queue' }],
    },
  }, null, 2));
  fs.writeFileSync(path.join(pipelineRoot, 'trees', 'implementation.or-tree'), JSON.stringify({
    kind: 'orpad.tree',
    version: '1.0',
    id: 'implementation',
    root: {
      id: 'root',
      type: 'Sequence',
      label: 'Implementation',
      children: [
        { id: 'implement', type: 'Skill', label: 'Implement', skillRef: 'implement' },
      ],
    },
  }, null, 2));
  fs.writeFileSync(path.join(pipelineRoot, 'skills', 'implement.md'), '# Implement\n');
  fs.writeFileSync(path.join(pipelineRoot, 'rules', 'local-safety.or-rule'), JSON.stringify({ kind: 'orpad.rule', version: '1.0', id: 'local-safety' }, null, 2));
  const pipelinePath = path.join(pipelineRoot, 'pipeline.or-pipeline');
  fs.writeFileSync(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'editor-fixture',
    title: 'Pipeline editor fixture',
    description: 'Object-map pipeline preview fixture.',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    graphs: {
      main: { file: 'graphs/main.or-graph', description: 'Main graph' },
      quality: { file: 'graphs/quality.or-graph', description: 'Quality graph' },
    },
    trees: {
      implementation: { file: 'trees/implementation.or-tree', description: 'Implementation tree' },
    },
    skills: {
      implement: { file: 'skills/implement.md', description: 'Implementation skill' },
    },
    rules: {
      safety: { file: 'rules/local-safety.or-rule', description: 'Safety policy' },
    },
    harness: { path: 'harness/generated' },
    maintenancePolicy: {
      kind: 'repeatable-maintenance-cycle',
      repeatable: true,
      cadence: { mode: 'manual' },
      cycleSemantics: {
        statusScope: 'latest-run-cycle',
        doneMeaning: 'The latest cycle is done; the pipeline remains active.',
      },
    },
    metadata: { owner: 'qa' },
    executionPolicy: {
      mode: 'continue-until-done',
      repeatable: true,
      cycleStatusScope: 'latest-run-cycle',
      promptRole: 'launch-only',
      pauseOnlyFor: ['approval-required', 'external side effect', 'credential required'],
      doneCriteria: [
        'run evidence written',
        'details reviewed',
        'graph refs validated',
        'skills updated',
        'rules checked',
        'tests passed',
        'summary updated',
      ],
    },
  }, null, 2));
  return { workspace, pipelinePath };
}

test('pipeline details preview exposes editable contract fields', async () => {
  test.setTimeout(60_000);
  const { workspace, pipelinePath } = writePipelineWorkspace();
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
  await expect(win.locator('#runbooks-content')).toContainText('Pipeline editor fixture');
  await win.locator('.runbook-item').filter({ hasText: 'Pipeline editor fixture' }).click();
  await win.locator('#btn-preview').click();
  await expect(win.locator('.orch-preview')).toContainText('Pipeline setup');
  await expect(win.locator('.orch-preview button[data-orch-mode="readonly"]')).toHaveText('View');
  await expect(win.locator('.orch-preview button[data-orch-mode="readwrite"]')).toHaveText('Edit');
  await expect(win.locator('.orch-preview')).not.toContainText(/Read-(only|write)/);
  await expect(win.locator('.pipeline-editor-tabs button.active')).toContainText('Flow');
  await expect(win.locator('#toc-source-label')).toContainText('Flow');
  await expect(win.locator('#toc-source-label')).not.toContainText('orch-graph');
  await expect(win.locator('.orch-graph-layout > .orch-inspector')).toHaveCount(0);
  await expect(win.locator('.orch-graph-main .orch-floating-inspector .orch-inspector')).toBeVisible();
  await expect(win.locator('.orch-floating-inspector .orch-inspector dl')).toContainText('Kind');
  await expect(win.locator('.orch-floating-inspector .orch-inspector dl')).not.toContainText('Type');
  await expect(win.locator('.orch-floating-inspector .orch-inspector dl')).not.toContainText('Step key');
  await expect(win.locator('.orch-floating-inspector .orch-inspector dl')).not.toContainText('reference-context');
  await win.locator('button[data-orch-mode="readwrite"]').click();
  const kindField = win.locator('.orch-floating-inspector label', { has: win.locator('select[data-orch-edit="type"]') });
  await expect(kindField).toContainText('Kind');
  await expect(kindField).not.toContainText('Type');
  const graphTypeOptions = await win.locator('.orch-floating-inspector select[data-orch-edit="type"] option').evaluateAll(options =>
    options.map(option => (option as HTMLOptionElement).value).filter(Boolean)
  );
  const graphTypeLabels = await win.locator('.orch-floating-inspector select[data-orch-edit="type"] option').evaluateAll(options =>
    options.map(option => (option.textContent || '').trim()).filter(Boolean)
  );
  expect(graphTypeOptions).toContain('orpad.context');
  expect(graphTypeOptions).toContain('orpad.graph');
  expect(graphTypeOptions).toContain('orpad.tree');
  expect(graphTypeOptions).toContain('orpad.workQueue');
  expect(graphTypeOptions).toContain('State');
  expect(graphTypeOptions).toContain('Tool');
  expect(graphTypeOptions).toContain('Human');
  expect(graphTypeOptions).toContain('Wait');
  expect(graphTypeOptions).not.toContain('Context');
  expect(graphTypeOptions).not.toContain('OrchTree');
  expect(graphTypeOptions).not.toContain('Sequence');
  expect(graphTypeLabels).toContain('Flow layer');
  expect(graphTypeLabels).toContain('Tree layer');
  expect(graphTypeLabels).toContain('Step');
  expect(graphTypeLabels).not.toContain('orpad.graph');
  expect(graphTypeLabels).not.toContain('State');
  await win.locator('button[data-orch-mode="readonly"]').click();
  const implementationNode = win.locator('.orch-graph-node.type-orchtree').filter({ hasText: 'Implementation' });
  await implementationNode.dblclick();
  await expect(win.locator('.tab-item.active')).toContainText('main.or-graph');
  await expect(win.locator('.orch-layer-bar')).toContainText('Main flow');
  await expect(win.locator('.orch-layer-bar')).toContainText('Implementation');
  await expect(win.locator('.orch-layer-up')).toBeVisible();
  await expect(win.locator('.orch-preview')).toContainText('Linked tree file');
  await expect(win.locator('.orch-graph-node')).toHaveCount(2);
  await expect(win.locator('.orch-graph-node')).toContainText(['Implementation', 'Implement']);
  const layerNodeBounds = await win.locator('.orch-graph-frame').evaluate((frame) => {
    const frameRect = frame.getBoundingClientRect();
    return [...frame.querySelectorAll('.orch-graph-node')].map((node) => {
      const rect = (node as HTMLElement).getBoundingClientRect();
      return {
        left: rect.left >= frameRect.left,
        top: rect.top >= frameRect.top,
        right: rect.right <= frameRect.right,
        bottom: rect.bottom <= frameRect.bottom,
      };
    });
  });
  expect(layerNodeBounds.every(item => item.left && item.top && item.right && item.bottom)).toBe(true);
  await win.locator('.orch-layer-up').click();
  await expect(win.locator('.orch-layer-bar')).toContainText('Main flow');
  await expect(win.locator('.orch-layer-up')).toHaveCount(0);
  await expect(win.locator('.orch-graph-node')).toHaveCount(3);
  const graphRefNode = win.locator('.orch-graph-node.type-orpad-graph').filter({ hasText: 'Quality graph' });
  await graphRefNode.dblclick();
  await expect(win.locator('.tab-item.active')).toContainText('main.or-graph');
  await expect(win.locator('.orch-layer-bar')).toContainText('Main flow');
  await expect(win.locator('.orch-layer-bar')).toContainText('Quality graph');
  await expect(win.locator('.orch-layer-up')).toBeVisible();
  await expect(win.locator('.orch-preview')).toContainText('Linked file');
  await expect(win.locator('.orch-graph-node')).toHaveCount(2);
  await expect(win.locator('.orch-graph-node')).toContainText(['Probe UI quality', 'Queue findings']);
  await win.locator('.orch-layer-up').click();
  await expect(win.locator('.orch-layer-up')).toHaveCount(0);
  await expect(win.locator('.orch-graph-node')).toHaveCount(3);
  await win.locator('.pipeline-editor-tabs button').filter({ hasText: 'Details' }).click();

  await expect(win.locator('.orch-preview')).toContainText('Pipeline setup');
  await expect(win.locator('.pipeline-editor-tabs button.active')).toContainText('Details');
  await expect(win.locator('.orch-preview')).not.toContainText(new RegExp('Mani' + 'fest'));
  await expect(win.locator('.orch-preview')).toContainText('Pipeline Details');
  await expect(win.locator('.orch-preview button[data-pipeline-mode="readonly"]')).toHaveText('View');
  await expect(win.locator('.orch-preview button[data-pipeline-mode="readwrite"]')).toHaveText('Edit');
  await expect(win.locator('.orch-preview')).toContainText('Entry Flow');
  await expect(win.locator('.orch-preview')).toContainText('Main flow');
  await expect(win.locator('.orch-preview')).not.toContainText('graphs/main.or-graph');
  await expect(win.locator('.orch-inspector')).toContainText('Pipeline key');
  await expect(win.locator('.orch-inspector')).not.toContainText(/\bID\b/);
  const manifestScroll = await win.locator('#content').evaluate((el) => {
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    return {
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    };
  });
  expect(manifestScroll.overflowY).toBe('auto');
  expect(manifestScroll.scrollHeight).toBeGreaterThan(manifestScroll.clientHeight);
  expect(manifestScroll.scrollTop).toBeGreaterThan(0);
  await expect(win.locator('.orch-preview')).toContainText('2 flows');
  await expect(win.locator('.orch-preview')).toContainText('1 trees');
  await expect(win.locator('.orch-preview')).toContainText('1 skills');
  await expect(win.locator('.orch-preview')).toContainText('1 rules');
  await expect(win.locator('.orch-preview')).toContainText('continue-until-done');
  await expect(win.locator('.orch-preview')).toContainText('repeatable maintenance');
  await expect(win.locator('.orch-preview')).toContainText('Maintenance Cycle Policy');
  await expect(win.locator('.orch-preview')).toContainText('Cycle done criteria');
  await expect(win.locator('.pipeline-ref-section').filter({ hasText: 'Skills' })).toContainText('Implementation skill');

  await win.locator('button[data-pipeline-mode="readwrite"]').click();
  await expect(win.locator('.pipeline-ref-section').filter({ hasText: 'Skills' })).toContainText('Reference key');
  await expect(win.locator('[data-pipeline-field="title"]')).toHaveValue('Pipeline editor fixture');
  await win.locator('[data-pipeline-field="title"]').evaluate((input) => {
    (input as HTMLInputElement).value = 'Edited pipeline contract';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await win.locator('[data-pipeline-ref-edit="skills"][data-ref-field="description"]').evaluate((input) => {
    (input as HTMLInputElement).value = 'Edited implementation skill';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await win.locator('[data-pipeline-policy-add="doneCriteria"]').click();
  await win.locator('[data-pipeline-harness-field="path"]').evaluate((input) => {
    (input as HTMLInputElement).value = 'harness/orpad-generated';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await win.locator('[data-pipeline-json-section="metadata"]').evaluate((input) => {
    (input as HTMLTextAreaElement).value = '{ "owner": "product", "status": "reviewed" }';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await win.locator('[data-pipeline-json-section="maintenancePolicy"]').evaluate((input) => {
    (input as HTMLTextAreaElement).value = JSON.stringify({
      kind: 'repeatable-maintenance-cycle',
      repeatable: true,
      cadence: { mode: 'manual', suggestedInterval: 'weekly' },
      cycleSemantics: {
        statusScope: 'latest-run-cycle',
        doneMeaning: 'The latest cycle is done; the pipeline remains active.',
      },
    }, null, 2);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('file.save');
  });

  await expect.poll(() => JSON.parse(fs.readFileSync(pipelinePath, 'utf-8')).title).toBe('Edited pipeline contract');
  const updated = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  expect(updated.skills.implement.description).toBe('Edited implementation skill');
  expect(updated.executionPolicy.doneCriteria).toContain('required evidence updated');
  expect(updated.harness.path).toBe('harness/orpad-generated');
  expect(updated.metadata).toEqual({ owner: 'product', status: 'reviewed' });
  expect(updated.maintenancePolicy.repeatable).toBe(true);
  expect(updated.maintenancePolicy.cadence.suggestedInterval).toBe('weekly');
  expect(updated.graphs.main.file).toBe('graphs/main.or-graph');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('pipeline check shows actionable broken entryGraph ref diagnostic', async () => {
  test.setTimeout(60_000);
  const { workspace, pipelinePath } = writePipelineWorkspace();
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
  await win.locator('.runbook-item').filter({ hasText: 'Pipeline editor fixture' }).click();
  await win.locator('#btn-preview').click();
  await expect(win.locator('.pipeline-runbar')).toBeVisible();

  const brokenPipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  brokenPipeline.entryGraph = 'graphs/missing.or-graph';
  fs.writeFileSync(pipelinePath, JSON.stringify(brokenPipeline, null, 2));

  await win.locator('[data-pipeline-run-menu]').click();
  await win.locator('button[data-pipeline-run-action="check"]').click();
  const status = win.locator('.pipeline-runbar-status.danger');
  await expect(status).toContainText('PIPELINE_ENTRY_GRAPH_NOT_FOUND');
  await expect(status).toContainText('Pipeline entryGraph file does not exist.');
  await expect(status).toContainText('ref: graphs/missing.or-graph');
  await expect(status).toContainText(/more\./);
  await expect(status).not.toHaveText('Check failed: PIPELINE_ENTRY_GRAPH_NOT_FOUND');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('maintenance pipeline opens by path and exposes nested graph layers', async () => {
  test.setTimeout(60_000);
  const workspace = path.resolve('.');
  const pipelinePath = path.join(workspace, '.orpad', 'pipelines', 'orpad-maintenance-quality-workstream-20260429', 'pipeline.or-pipeline');
  expect(fs.existsSync(pipelinePath)).toBe(true);

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

  await expect(win.locator('#runbooks-content')).toContainText('OrPAD Maintenance Quality Workstream');
  await expect(win.locator('[data-runbook-section="pipelines"]')).not.toContainText('orpad-maintenance-quality-workstream-20260429');
  await win.locator('.runbook-item').filter({ hasText: 'OrPAD Maintenance Quality Workstream' }).click();
  await win.locator('#btn-preview').click();

  await expect(win.locator('.orch-preview')).toContainText('Pipeline setup');
  await expect(win.locator('.pipeline-editor-tabs button.active')).toContainText('Flow');
  await expect(win.locator('.orch-preview')).toContainText('Main flow');
  await expect(win.locator('.orch-preview')).toContainText('Flow steps');
  await expect(win.locator('.orch-preview')).not.toContainText(new RegExp('State\\s+' + 'graph', 'i'));
  await expect(win.locator('.orch-preview')).not.toContainText('orch-graph');
  await expect(win.locator('#toc-source-label')).toContainText('Flow');
  await expect(win.locator('#toc-source-label')).not.toContainText('orch-graph');
  await win.locator('.pipeline-editor-tabs button').filter({ hasText: 'Details' }).click();
  await expect(win.locator('.orch-preview')).toContainText('Main flow');
  await expect(win.locator('.orch-preview')).not.toContainText('graphs/main.or-graph');
  await win.locator('.pipeline-editor-tabs button').filter({ hasText: 'Flow' }).click();
  await expect(win.locator('.pipeline-editor-tabs button.active')).toContainText('Flow');
  await expect(win.locator('.orch-graph-node')).toContainText([
    'Prepare workspace',
    'Run parallel discovery lenses',
    'Ingest, dedupe, and triage queue',
    'Dispatch and execute bounded work',
    'Done and proof gate',
    'Required evidence and work journal',
  ]);

  const discoveryNode = win.locator('.orch-graph-node.type-orpad-graph').filter({ hasText: 'Run parallel discovery lenses' });
  await discoveryNode.dblclick();
  await expect(win.locator('.tab-item.active')).toContainText('main.or-graph');
  await expect(win.locator('.orch-layer-bar')).toContainText('Main flow');
  await expect(win.locator('.orch-layer-bar')).toContainText('Run parallel discovery lenses');
  await expect(win.locator('.orch-layer-up')).toBeVisible();
  await expect(win.locator('.orch-preview')).toContainText('Linked file');
  await expect(win.locator('.orch-graph-node')).toContainText([
    'Current-evidence source quality',
    'Graph editor journey probe',
    'Product intent probe',
    'UX/UI probe',
    'Bug risk probe',
    'Security boundary probe',
    'Test gap probe',
    'Pipeline quality probe',
    'Merge staged probe results',
  ]);

  const layerNodeBounds = await win.locator('.orch-graph-frame').evaluate((frame) => {
    const frameRect = frame.getBoundingClientRect();
    return [...frame.querySelectorAll('.orch-graph-node')].map((node) => {
      const rect = (node as HTMLElement).getBoundingClientRect();
      return {
        left: rect.left >= frameRect.left,
        top: rect.top >= frameRect.top,
        right: rect.right <= frameRect.right,
        bottom: rect.bottom <= frameRect.bottom,
      };
    });
  });
  expect(layerNodeBounds.every(item => item.left && item.top && item.right && item.bottom)).toBe(true);

  await win.locator('.orch-layer-up').click();
  await expect(win.locator('.orch-layer-up')).toHaveCount(0);
  await expect(win.locator('.orch-graph-node').filter({ hasText: 'Run parallel discovery lenses' })).toBeVisible();

  await app.close();
});
