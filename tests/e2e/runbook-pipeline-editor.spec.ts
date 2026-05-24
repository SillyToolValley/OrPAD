import { test, expect, type Locator, type Page } from '@playwright/test';
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

async function expectFittedGraphNodesClearOfFloatingInspector(win: Page, label: string): Promise<void> {
  await win.locator('.orch-graph-frame [data-orch-action="fit"]').first().click();
  await win.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));

  const clearance = await win.locator('.orch-graph-frame').first().evaluate((frame) => {
    const frameRect = frame.getBoundingClientRect();
    const inspector = frame.closest('.orch-graph-main')?.querySelector('.orch-floating-inspector');
    const inspectorRect = inspector?.getBoundingClientRect();
    const inspectorStyle = inspector ? getComputedStyle(inspector) : null;
    const inspectorVisible = !!inspectorRect
      && inspectorStyle?.display !== 'none'
      && inspectorStyle?.visibility !== 'hidden'
      && inspectorRect.width > 0
      && inspectorRect.height > 0;
    const tolerance = 1;
    const nodes = [...frame.querySelectorAll<HTMLElement>('.orch-graph-node')].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        label: node.textContent?.trim().replace(/\s+/g, ' ') || node.dataset.orchPath || 'node',
        inFrame: rect.left >= frameRect.left - tolerance
          && rect.top >= frameRect.top - tolerance
          && rect.right <= frameRect.right + tolerance
          && rect.bottom <= frameRect.bottom + tolerance,
        overlapsInspector: inspectorVisible
          && rect.left < inspectorRect!.right - tolerance
          && rect.right > inspectorRect!.left + tolerance
          && rect.top < inspectorRect!.bottom - tolerance
          && rect.bottom > inspectorRect!.top + tolerance,
      };
    });
    return { inspectorVisible, nodes };
  });

  expect(clearance.inspectorVisible, `${label}: floating inspector should be visible`).toBe(true);
  expect(clearance.nodes.length, `${label}: graph should render nodes`).toBeGreaterThan(0);
  expect(
    clearance.nodes.filter(item => !item.inFrame || item.overlapsInspector),
    `${label}: fitted nodes should stay inside the frame and outside the floating inspector`,
  ).toEqual([]);
}

async function readInlineDiagnosticColorTreatment(field: Locator): Promise<{
  className: string;
  color: string;
  borderLeftColor: string;
  backgroundColor: string;
  warningColor: string;
  warningBackgroundColor: string;
  dangerColor: string;
  dangerBackgroundColor: string;
}> {
  return field.locator('.pipeline-inline-diagnostic').evaluate((element) => {
    const style = getComputedStyle(element);
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement('span');
    document.body.appendChild(probe);
    const resolveColor = (value: string): string => {
      probe.style.color = '';
      probe.style.color = value.trim();
      return getComputedStyle(probe).color;
    };
    const resolveBackground = (value: string): string => {
      probe.style.background = '';
      probe.style.background = value.trim();
      return getComputedStyle(probe).backgroundColor;
    };
    const warningToken = root.getPropertyValue('--syntax-meta').trim() || '#e0af68';
    const dangerToken = root.getPropertyValue('--danger-color').trim() || '#ff7676';
    const treatment = {
      className: element.className,
      color: style.color,
      borderLeftColor: style.borderLeftColor,
      backgroundColor: style.backgroundColor,
      warningColor: resolveColor(warningToken),
      warningBackgroundColor: resolveBackground(`color-mix(in srgb, ${warningToken} 10%, transparent)`),
      dangerColor: resolveColor(dangerToken),
      dangerBackgroundColor: resolveBackground(`color-mix(in srgb, ${dangerToken} 10%, transparent)`),
    };
    probe.remove();
    return treatment;
  });
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

async function setNodePackManagerMock(
  win: Page,
  response: unknown,
  delayMs = 0,
  markTestOverride = true,
  bypassCatalogCache = true,
): Promise<void> {
  await win.evaluate(({
    response: mockResponse,
    delayMs: mockDelayMs,
    markTestOverride: shouldMarkTestOverride,
    bypassCatalogCache: shouldBypassCatalogCache,
  }) => {
    const mockListNodePacks = async () => {
      if (mockDelayMs) await new Promise(resolve => setTimeout(resolve, mockDelayMs));
      return mockResponse;
    };
    if (shouldMarkTestOverride) {
      (mockListNodePacks as any).orpadTestOverride = true;
      if (!shouldBypassCatalogCache) (mockListNodePacks as any).orpadBypassCatalogCache = false;
    }
    (window as any).__orpadNodePackManagerListPacks = mockListNodePacks;
    (window as any).__orpadNodePackListPacks = mockListNodePacks;
  }, { response, delayMs, markTestOverride, bypassCatalogCache });
}

async function setNodePackManagerThrowingMock(win: Page, message: string): Promise<void> {
  await win.evaluate((mockErrorMessage) => {
    const mockListNodePacks = async () => {
      throw new Error(mockErrorMessage);
    };
    (mockListNodePacks as any).orpadTestOverride = true;
    (window as any).__orpadNodePackManagerListPacks = mockListNodePacks;
    (window as any).__orpadNodePackListPacks = mockListNodePacks;
  }, message);
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
  const metadataField = win.locator('[data-pipeline-json-section="metadata"]');
  await metadataField.focus();
  await expect(metadataField).toBeFocused();
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
  await expect(metadataField).toBeFocused();

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

test('pipeline details surfaces missing node pack diagnostics inline', async () => {
  test.setTimeout(60_000);
  const { workspace, pipelinePath } = writePipelineWorkspace();
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  pipeline.nodePacks = [
    { id: 'community.missing-pack', version: '>=9.9.0', origin: 'user-installed' },
  ];
  fs.writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2));

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
  await win.locator('.pipeline-editor-tabs button').filter({ hasText: 'Details' }).click();

  const nodePacksSection = win.locator('.pipeline-node-packs-section');
  await expect(nodePacksSection).toContainText('Node Packs');
  await expect(nodePacksSection).toContainText('community.missing-pack');
  await expect(nodePacksSection).toContainText('>=9.9.0');
  await expect(nodePacksSection).toContainText('user-installed');
  await expect(nodePacksSection).toContainText('PIPELINE_NODE_PACK_UNKNOWN');
  await expect(nodePacksSection.locator('.pipeline-inline-diagnostic')).toContainText('community.missing-pack');
  await expect(nodePacksSection.locator('[data-node-pack-manager-open]').first()).toContainText('Resolve in Pack Manager');

  await win.locator('button[data-pipeline-mode="readwrite"]').click();
  await expect(win.locator('[data-pipeline-json-section="nodePacks"]')).toHaveValue(/community\.missing-pack/);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('node pack manager lists metadata and safe pack prose states', async () => {
  test.setTimeout(60_000);
  const { workspace } = writePipelineWorkspace();
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
  await expect(win.locator('[data-node-pack-manager-open]')).toBeVisible();

  await setNodePackManagerMock(win, {
    success: true,
    ok: true,
    nodePacks: [
      {
        id: 'orpad.core',
        name: 'OrPAD Core Nodes',
        version: '1.0.0',
        origin: 'built-in',
        trustLevel: 'official',
        resolutionState: 'resolved',
        capabilities: ['read.workspace'],
        discovery: {
          rootKind: 'built-in',
          packDir: '/app/nodes/core',
          manifestPath: '/app/nodes/core/orpad.node-pack.json',
        },
        nodes: [
          { type: 'orpad.gate', label: 'Gate' },
        ],
      },
      {
        id: 'community.safe-pack',
        name: 'Community Safe Pack',
        version: '0.2.0',
        origin: 'user-installed',
        trustLevel: 'community',
        description: '<button data-unsafe-pack-prose>Do not click</button> Pack prose.',
        capabilities: ['read.workspace', 'run.localVerification'],
        discovery: {
          rootKind: 'user',
          packDir: '/packs/community.safe-pack',
          manifestPath: '/packs/community.safe-pack/orpad.nodepack.json',
        },
        nodes: [
          { type: 'community.probe', label: 'Community Probe', capabilities: ['call.aiProvider'] },
        ],
      },
      {
        id: 'community.review-required',
        name: 'Review Required Pack',
        version: '0.4.0',
        origin: 'user-installed',
        trustLevel: 'signed-community',
        resolutionState: 'approval-required',
        validationStatus: 'approval-required',
        capabilities: ['read.workspace', 'use.credentials'],
        highRiskCapabilities: ['use.credentials'],
        diagnostics: [
          {
            level: 'warning',
            code: 'NODE_PACK_HIGH_RISK_CAPABILITY_REVIEW_REQUIRED',
            message: 'Community node pack requests high-risk authority without approved review.',
            packId: 'community.review-required',
            capability: 'use.credentials',
            scope: 'pack',
          },
        ],
        discovery: {
          rootKind: 'user',
          packDir: '/packs/community.review-required',
          manifestPath: '/packs/community.review-required/orpad.node-pack.json',
        },
        nodes: [
          { type: 'community.secretProbe', label: 'Secret Probe', capabilities: ['use.credentials'] },
        ],
      },
    ],
    diagnostics: [],
    conflicts: [],
  }, 100);

  await win.locator('[data-node-pack-manager-open]').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'loading');
  await expect(win.locator('.node-pack-manager-status')).toContainText('Loading installed node packs');
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'success');
  const corePack = win.locator('.node-pack-manager-pack').filter({ hasText: 'OrPAD Core Nodes' });
  await expect(corePack).toContainText('orpad.core');
  await expect(corePack).toContainText('built-in');
  await expect(corePack).toContainText('official');
  await expect(corePack).toContainText('0 diagnostics');
  const safePack = win.locator('.node-pack-manager-pack').filter({ hasText: 'Community Safe Pack' });
  await expect(safePack).toContainText('community.safe-pack');
  await expect(safePack).toContainText('0.2.0');
  await expect(safePack).toContainText('user-installed');
  await expect(safePack).toContainText('community');
  await expect(safePack).toContainText('valid');
  await expect(safePack).toContainText('0 diagnostics');
  await expect(safePack).toContainText('read.workspace');
  await expect(safePack).toContainText('/packs/community.safe-pack/orpad.nodepack.json');
  const reviewPack = win.locator('.node-pack-manager-pack').filter({ hasText: 'Review Required Pack' });
  await expect(reviewPack).toHaveAttribute('data-node-pack-validation', 'approval-required');
  await expect(reviewPack).toContainText('signed-community');
  await expect(reviewPack).toContainText('approval-required');
  await expect(reviewPack).toContainText('1 high-risk');
  await expect(reviewPack).toContainText('high-risk: use.credentials');
  await safePack.click();
  await expect(win.locator('.node-pack-manager-detail')).toContainText('Trusted Discovery Metadata');
  await expect(win.locator('.node-pack-manager-detail')).toContainText('Diagnostic count');
  await expect(win.locator('.node-pack-manager-detail')).toContainText('0 diagnostics');
  await expect(win.locator('.node-pack-manager-detail')).toContainText('Capabilities');
  await expect(win.locator('.node-pack-manager-detail')).toContainText('call.aiProvider');
  await expect(win.locator('.node-pack-manager-detail')).toContainText('Pack-Provided Prose (Untrusted)');
  await expect(win.locator('[data-unsafe-pack-prose]')).toHaveCount(0);
  await expect(win.locator('.node-pack-manager-untrusted')).toContainText('<button data-unsafe-pack-prose>Do not click</button> Pack prose.');
  await reviewPack.click();
  await expect(win.locator('.node-pack-manager-detail')).toContainText('High-risk capabilities');
  await expect(win.locator('.node-pack-manager-detail')).toContainText('use.credentials');
  await expect(win.locator('.node-pack-manager-detail')).toContainText('NODE_PACK_HIGH_RISK_CAPABILITY_REVIEW_REQUIRED');

  const layout = await win.locator('.node-pack-manager').evaluate((manager) => ({
    widthFits: manager.scrollWidth <= manager.clientWidth + 1,
    packCount: manager.querySelectorAll('.node-pack-manager-pack').length,
  }));
  expect(layout.widthFits).toBe(true);
  expect(layout.packCount).toBe(3);

  await win.locator('#fmt-modal-close').click();
  await setNodePackManagerMock(win, { success: true, ok: true, nodePacks: [], diagnostics: [], conflicts: [] });
  await win.locator('[data-node-pack-manager-open]').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'empty');
  await expect(win.locator('.node-pack-manager')).toContainText('No node packs are installed.');

  await win.locator('#fmt-modal-close').click();
  await setNodePackManagerMock(win, { success: false, ok: false, error: 'fixture discovery failure' });
  await win.locator('[data-node-pack-manager-open]').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'error');
  await expect(win.locator('.node-pack-manager-error')).toContainText('fixture discovery failure');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('node pack manager surfaces discovery diagnostics and conflicts', async () => {
  test.setTimeout(60_000);
  const { workspace } = writePipelineWorkspace();
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
  await expect(win.locator('[data-node-pack-manager-open]')).toBeVisible();

  await setNodePackManagerMock(win, {
    success: true,
    ok: true,
    roots: [
      { kind: 'built-in', root: '/app/nodes' },
      { kind: 'user', root: '/bad/nodes' },
    ],
    nodePacks: [
      {
        id: 'community.alpha',
        name: 'Community Alpha Pack',
        version: '0.1.0',
        origin: 'user-installed',
        trustLevel: 'community',
        capabilities: ['read.workspace'],
        discovery: {
          rootKind: 'user',
          packDir: '/packs/community.alpha',
          manifestPath: '/packs/community.alpha/orpad.node-pack.json',
        },
        nodes: [{ type: 'community.shared', label: 'Shared Node' }],
      },
      {
        id: 'community.beta',
        name: 'Community Beta Pack',
        version: '0.3.0',
        origin: 'user-installed',
        trustLevel: 'community',
        capabilities: ['write.runArtifacts'],
        discovery: {
          rootKind: 'user',
          packDir: '/packs/community.beta',
          manifestPath: '/packs/community.beta/orpad.node-pack.json',
        },
        nodes: [{ type: 'community.shared', label: 'Shared Node Variant' }],
      },
      {
        id: 'community.broken',
        name: 'Community Broken Pack',
        version: '',
        origin: 'user-installed',
        trustLevel: 'community',
        resolutionState: 'incompatible',
        validationStatus: 'validation-error',
        diagnostics: [
          {
            level: 'error',
            code: 'NODE_PACK_VERSION_MISSING',
            message: 'Node pack version is required.',
            packId: 'community.broken',
          },
        ],
        discovery: {
          rootKind: 'user',
          packDir: '/packs/community.broken',
          manifestPath: '/packs/community.broken/orpad.node-pack.json',
        },
        nodes: [{ type: 'community.brokenProbe', label: 'Broken Probe' }],
      },
    ],
    diagnostics: [
      {
        level: 'warning',
        code: 'NODE_PACK_DISCOVERY_ROOT_UNREADABLE',
        message: 'Node pack root could not be read.',
        rootKind: 'user',
        root: '/bad/nodes',
        error: 'EACCES: permission denied',
      },
      {
        level: 'warning',
        code: 'NODE_PACK_DISCOVERY_MANIFEST_INVALID',
        message: 'Node pack manifest could not be parsed.',
        rootKind: 'user',
        manifestPath: '/packs/broken/orpad.node-pack.json',
        error: 'Unexpected token } in JSON',
      },
      {
        level: 'warning',
        code: 'NODE_PACK_DISCOVERY_VALIDATION_FAILED',
        message: 'Discovered node pack is not launch-compatible.',
        packId: 'community.alpha',
        manifestPath: '/packs/community.alpha/orpad.node-pack.json',
        packDiagnostics: [
          {
            level: 'error',
            code: 'NODE_PACK_VERSION_MISSING',
            message: 'Node pack version is required.',
            packId: 'community.alpha',
          },
        ],
      },
      {
        level: 'warning',
        code: 'NODE_PACK_DISCOVERY_DUPLICATE_ID',
        message: 'Duplicate node pack id discovered; deterministic load keeps the first pack and skips later duplicates.',
        packId: 'community.alpha',
        keptManifestPath: '/packs/community.alpha/orpad.node-pack.json',
        skippedManifestPath: '/packs/community.alpha-copy/orpad.node-pack.json',
      },
      {
        level: 'warning',
        code: 'NODE_PACK_TYPE_CONFLICT',
        message: 'Multiple node packs declare the same node type; user selection is required before activation.',
        nodeType: 'community.shared',
        firstPackId: 'community.alpha',
        firstManifestPath: '/packs/community.alpha/orpad.node-pack.json',
        secondPackId: 'community.beta',
        secondManifestPath: '/packs/community.beta/orpad.node-pack.json',
      },
    ],
    conflicts: [
      {
        nodeType: 'community.shared',
        firstPackId: 'community.alpha',
        firstManifestPath: '/packs/community.alpha/orpad.node-pack.json',
        secondPackId: 'community.beta',
        secondManifestPath: '/packs/community.beta/orpad.node-pack.json',
      },
    ],
  });

  await win.locator('[data-node-pack-manager-open]').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'success');
  await expect(win.locator('.node-pack-manager-status')).toContainText('1 conflict');
  const diagnostics = win.locator('.node-pack-manager-diagnostics');
  await expect(diagnostics).toContainText('Discovery roots');
  await expect(diagnostics).toContainText('NODE_PACK_DISCOVERY_ROOT_UNREADABLE');
  await expect(diagnostics).toContainText('Root path');
  await expect(diagnostics).toContainText('/bad/nodes');
  await expect(diagnostics).toContainText('NODE_PACK_DISCOVERY_MANIFEST_INVALID');
  await expect(diagnostics).toContainText('/packs/broken/orpad.node-pack.json');
  await expect(diagnostics).toContainText('NODE_PACK_DISCOVERY_VALIDATION_FAILED');
  await expect(diagnostics).toContainText('NODE_PACK_VERSION_MISSING');
  await expect(diagnostics).toContainText('NODE_PACK_DISCOVERY_DUPLICATE_ID');
  await expect(diagnostics).toContainText('/packs/community.alpha-copy/orpad.node-pack.json');
  await expect(diagnostics).toContainText('NODE_PACK_TYPE_CONFLICT');
  await expect(diagnostics).toContainText('community.shared');

  await expect(win.locator('.node-pack-manager-pack.has-conflict')).toHaveCount(2);
  const alphaPack = win.locator('.node-pack-manager-pack.has-conflict').filter({ hasText: 'Community Alpha Pack' });
  await expect(alphaPack).toContainText('conflict');
  await expect(alphaPack).toHaveAttribute('data-node-pack-validation', 'conflict');
  const detail = win.locator('.node-pack-manager-detail');
  await expect(detail.locator('.node-pack-manager-detail-header.has-conflict')).toBeVisible();
  await expect(detail).toContainText('Conflict state');
  await expect(detail).toContainText('NODE_PACK_DISCOVERY_VALIDATION_FAILED');
  await expect(detail).toContainText('NODE_PACK_DISCOVERY_DUPLICATE_ID');
  await expect(detail).toContainText('NODE_PACK_TYPE_CONFLICT');

  await win.locator('.node-pack-manager-pack.has-conflict').filter({ hasText: 'Community Beta Pack' }).click();
  await expect(detail.locator('.node-pack-manager-detail-header.has-conflict')).toBeVisible();
  await expect(detail).toContainText('NODE_PACK_TYPE_CONFLICT');
  await expect(detail).toContainText('community.beta');
  await expect(detail).toContainText('community.shared');

  const brokenPack = win.locator('.node-pack-manager-pack').filter({ hasText: 'Community Broken Pack' });
  await expect(brokenPack).toHaveAttribute('data-node-pack-validation', 'validation-error');
  await expect(brokenPack).toContainText('validation-error');
  await brokenPack.click();
  await expect(detail.locator('.node-pack-manager-detail-header.has-conflict')).toHaveCount(0);
  await expect(detail).toContainText('Validation status');
  await expect(detail).toContainText('validation-error');
  await expect(detail).toContainText('/packs/community.broken/orpad.node-pack.json');
  await expect(detail).toContainText('NODE_PACK_VERSION_MISSING');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('add node browser blocks unresolved and conflicting node pack choices', async () => {
  test.setTimeout(60_000);
  const { workspace } = writePipelineWorkspace();
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
  await win.locator('button[data-orch-mode="readwrite"]').click();

  await setNodePackManagerMock(win, {
    success: true,
    ok: true,
    nodePacks: [
      {
        id: 'orpad.workstream',
        name: 'OrPAD Workstream Nodes',
        version: '1.0.0',
        origin: 'built-in',
        trustLevel: 'official',
        resolutionState: 'resolved',
        nodes: [{ type: 'orpad.workerLoop', label: 'Worker Loop' }],
      },
      {
        id: 'community.review-required',
        name: 'Review Required Pack',
        version: '0.1.0',
        origin: 'user-installed',
        trustLevel: 'community',
        resolutionState: 'approval-required',
        nodes: [{ type: 'orpad.probe', label: 'Unsafe Probe' }],
      },
      {
        id: 'community.alpha',
        name: 'Community Alpha Pack',
        version: '0.2.0',
        origin: 'user-installed',
        trustLevel: 'community',
        nodes: [{ type: 'orpad.gate', label: 'Shared Gate' }],
      },
      {
        id: 'community.beta',
        name: 'Community Beta Pack',
        version: '0.2.0',
        origin: 'user-installed',
        trustLevel: 'community',
        nodes: [{ type: 'orpad.gate', label: 'Shared Gate Variant' }],
      },
    ],
    diagnostics: [
      {
        level: 'warning',
        code: 'NODE_PACK_TYPE_CONFLICT',
        message: 'Multiple node packs declare the same node type; user selection is required before activation.',
        nodeType: 'orpad.gate',
        firstPackId: 'community.alpha',
        secondPackId: 'community.beta',
      },
    ],
    conflicts: [
      {
        nodeType: 'orpad.gate',
        firstPackId: 'community.alpha',
        secondPackId: 'community.beta',
      },
    ],
  });

  await win.locator('.orch-graph-node').filter({ hasText: 'Collect context' }).click({ button: 'right' });
  await win.locator('.orch-context-menu button[data-orch-context-action="add-node-browser"]').click();
  await expect(win.locator('.orch-node-browser')).toBeVisible();

  const officialTab = win.locator('.orch-node-browser-tab').filter({ hasText: 'OrPAD Workstream Nodes' });
  await expect(officialTab).toHaveAttribute('data-orch-node-pack-status', 'valid');
  await expect(officialTab).toContainText('official');
  await expect(win.locator('.orch-node-browser-item').filter({ hasText: 'Worker Loop' })).toBeEnabled();

  const reviewTab = win.locator('.orch-node-browser-tab').filter({ hasText: 'Review Required Pack' });
  await expect(reviewTab).toHaveAttribute('data-orch-node-pack-status', 'approval-required');
  await expect(reviewTab).toContainText('community');
  await reviewTab.click();
  const unsafeProbe = win.locator('.orch-node-browser-item').filter({ hasText: 'Unsafe Probe' });
  await expect(unsafeProbe).toBeDisabled();
  await expect(unsafeProbe).toContainText('approval-required');
  await expect(unsafeProbe).toContainText('Pack resolution is approval-required');

  const conflictTab = win.locator('.orch-node-browser-tab').filter({ hasText: 'Community Alpha Pack' });
  await expect(conflictTab).toHaveAttribute('data-orch-node-pack-status', 'conflict');
  await conflictTab.click();
  const sharedGate = win.locator('.orch-node-browser-item').filter({ hasText: 'Shared Gate' });
  await expect(sharedGate).toBeDisabled();
  await expect(sharedGate).toContainText('conflict');
  await expect(sharedGate).toContainText('Node type orpad.gate is declared by community.alpha and community.beta');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('add node browser surfaces node pack discovery failure fallback state', async () => {
  test.setTimeout(60_000);
  const { workspace } = writePipelineWorkspace();
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
  await win.locator('button[data-orch-mode="readwrite"]').click();

  await setNodePackManagerThrowingMock(win, 'fixture discovery failure');

  await win.locator('.orch-graph-node').filter({ hasText: 'Collect context' }).click({ button: 'right' });
  await win.locator('.orch-context-menu button[data-orch-context-action="add-node-browser"]').click();
  await expect(win.locator('.orch-node-browser')).toBeVisible();

  const alert = win.locator('.orch-node-browser-alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Degraded node pack catalog');
  await expect(alert).toContainText('built-in fallback packs only');
  await expect(alert).toContainText('User-installed packs may be missing');
  await expect(alert).toContainText('fixture discovery failure');
  await expect(alert.locator('[data-orch-node-browser-retry]')).toContainText('Retry discovery');
  await expect(alert.locator('[data-node-pack-manager-open]')).toContainText('Open Pack Manager');

  await expect(win.locator('.orch-node-browser-tab[data-orch-node-pack-status="valid"]')).toHaveCount(0);
  const fallbackTab = win.locator('.orch-node-browser-tab').filter({ hasText: 'OrPAD Workstream Nodes' });
  await expect(fallbackTab).toHaveAttribute('data-orch-node-pack-status', 'fallback');
  await expect(fallbackTab).toContainText('fallback');
  await fallbackTab.click();
  await expect(win.locator('.orch-node-browser-item').filter({ hasText: 'Worker Loop' })).toContainText('fallback');

  await setNodePackManagerMock(win, {
    success: true,
    ok: true,
    nodePacks: [
      {
        id: 'community.recovered',
        name: 'Recovered Community Pack',
        version: '1.2.3',
        origin: 'user-installed',
        trustLevel: 'community',
        resolutionState: 'resolved',
        nodes: [{ type: 'orpad.workerLoop', label: 'Recovered Worker' }],
      },
    ],
    diagnostics: [],
    conflicts: [],
  });
  await alert.locator('[data-orch-node-browser-retry]').click();
  await expect(alert).toBeHidden();
  const recoveredTab = win.locator('.orch-node-browser-tab').filter({ hasText: 'Recovered Community Pack' });
  await expect(recoveredTab).toHaveAttribute('data-orch-node-pack-status', 'valid');
  await recoveredTab.click();
  await expect(win.locator('.orch-node-browser-item').filter({ hasText: 'Recovered Worker' })).toBeEnabled();
  await expect(win.locator('.orch-node-browser-tab').filter({ hasText: 'OrPAD Workstream Nodes' })).toHaveCount(0);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('node pack manager refresh updates add node browser catalog in the same session', async () => {
  test.setTimeout(60_000);
  const { workspace } = writePipelineWorkspace();
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
  await win.locator('button[data-orch-mode="readwrite"]').click();

  await setNodePackManagerMock(win, {
    success: true,
    ok: true,
    nodePacks: [
      {
        id: 'community.legacy',
        name: 'Legacy Community Pack',
        version: '0.1.0',
        origin: 'user-installed',
        trustLevel: 'community',
        resolutionState: 'resolved',
        nodes: [{ type: 'orpad.workerLoop', label: 'Legacy Worker' }],
      },
    ],
    diagnostics: [],
    conflicts: [],
  }, 0, true, false);

  await win.locator('.orch-graph-node').filter({ hasText: 'Collect context' }).click({ button: 'right' });
  await win.locator('.orch-context-menu button[data-orch-context-action="add-node-browser"]').click();
  await expect(win.locator('.orch-node-browser')).toBeVisible();
  await expect(win.locator('.orch-node-browser-tab').filter({ hasText: 'Legacy Community Pack' })).toBeVisible();
  await expect(win.locator('.orch-node-browser-item').filter({ hasText: 'Legacy Worker' })).toBeEnabled();
  await win.locator('#fmt-modal-close').click();

  await win.locator('[data-node-pack-manager-open]').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'success');
  await expect(win.locator('.node-pack-manager')).toContainText('Legacy Community Pack');

  await setNodePackManagerMock(win, {
    success: true,
    ok: true,
    nodePacks: [
      {
        id: 'community.fresh',
        name: 'Fresh Community Pack',
        version: '0.2.0',
        origin: 'user-installed',
        trustLevel: 'community',
        resolutionState: 'resolved',
        nodes: [{ type: 'orpad.workerLoop', label: 'Fresh Worker' }],
      },
      {
        id: 'community.review-refresh',
        name: 'Refresh Review Pack',
        version: '0.3.0',
        origin: 'user-installed',
        trustLevel: 'community',
        resolutionState: 'approval-required',
        nodes: [{ type: 'orpad.probe', label: 'Refresh Unsafe Probe' }],
      },
      {
        id: 'community.conflict-alpha',
        name: 'Refresh Conflict Alpha',
        version: '0.4.0',
        origin: 'user-installed',
        trustLevel: 'community',
        nodes: [{ type: 'orpad.gate', label: 'Refresh Shared Gate' }],
      },
      {
        id: 'community.conflict-beta',
        name: 'Refresh Conflict Beta',
        version: '0.4.0',
        origin: 'user-installed',
        trustLevel: 'community',
        nodes: [{ type: 'orpad.gate', label: 'Refresh Shared Gate Variant' }],
      },
    ],
    diagnostics: [
      {
        level: 'warning',
        code: 'NODE_PACK_TYPE_CONFLICT',
        message: 'Multiple node packs declare the same node type; user selection is required before activation.',
        nodeType: 'orpad.gate',
        firstPackId: 'community.conflict-alpha',
        secondPackId: 'community.conflict-beta',
      },
    ],
    conflicts: [
      {
        nodeType: 'orpad.gate',
        firstPackId: 'community.conflict-alpha',
        secondPackId: 'community.conflict-beta',
      },
    ],
  }, 0, true, false);

  await win.locator('#fmt-modal-footer button').filter({ hasText: 'Refresh' }).click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'success');
  await expect(win.locator('.node-pack-manager')).toContainText('Fresh Community Pack');
  await expect(win.locator('.node-pack-manager')).not.toContainText('Legacy Community Pack');
  await win.locator('#fmt-modal-close').click();

  await win.locator('.orch-graph-node').filter({ hasText: 'Collect context' }).click({ button: 'right' });
  await win.locator('.orch-context-menu button[data-orch-context-action="add-node-browser"]').click();
  await expect(win.locator('.orch-node-browser')).toBeVisible();
  await expect(win.locator('.orch-node-browser-tab').filter({ hasText: 'Legacy Community Pack' })).toHaveCount(0);
  await expect(win.locator('.orch-node-browser-item').filter({ hasText: 'Legacy Worker' })).toHaveCount(0);

  const freshTab = win.locator('.orch-node-browser-tab').filter({ hasText: 'Fresh Community Pack' });
  await expect(freshTab).toHaveAttribute('data-orch-node-pack-status', 'valid');
  await freshTab.click();
  await expect(win.locator('.orch-node-browser-item').filter({ hasText: 'Fresh Worker' })).toBeEnabled();

  const reviewTab = win.locator('.orch-node-browser-tab').filter({ hasText: 'Refresh Review Pack' });
  await expect(reviewTab).toHaveAttribute('data-orch-node-pack-status', 'approval-required');
  await reviewTab.click();
  const unsafeProbe = win.locator('.orch-node-browser-item').filter({ hasText: 'Refresh Unsafe Probe' });
  await expect(unsafeProbe).toBeDisabled();
  await expect(unsafeProbe).toContainText('approval-required');

  const conflictTab = win.locator('.orch-node-browser-tab').filter({ hasText: 'Refresh Conflict Alpha' });
  await expect(conflictTab).toHaveAttribute('data-orch-node-pack-status', 'conflict');
  await conflictTab.click();
  const sharedGate = win.locator('.orch-node-browser-item').filter({ hasText: 'Refresh Shared Gate' });
  await expect(sharedGate).toBeDisabled();
  await expect(sharedGate).toContainText('conflict');

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

  await win.locator('.pipeline-editor-tabs button').filter({ hasText: 'Details' }).click();
  await expect(win.locator('.pipeline-editor-tabs button.active')).toContainText('Details');
  const entryInlineDiagnostic = win.locator('.pipeline-field.has-inline-diagnostic').filter({ hasText: 'Entry' });
  await expect(entryInlineDiagnostic).toContainText('PIPELINE_ENTRY_GRAPH_NOT_FOUND');
  await expect(entryInlineDiagnostic).toContainText('Pipeline entryGraph file does not exist.');
  await expect(entryInlineDiagnostic).toContainText('ref: graphs/missing.or-graph');
  const entryErrorTreatment = await readInlineDiagnosticColorTreatment(entryInlineDiagnostic);
  expect(entryErrorTreatment.className).toContain('error');
  expect(entryErrorTreatment.className).not.toContain('warning');
  expect(entryErrorTreatment.color).toBe(entryErrorTreatment.dangerColor);
  expect(entryErrorTreatment.borderLeftColor).toBe(entryErrorTreatment.dangerColor);
  expect(entryErrorTreatment.backgroundColor).toBe(entryErrorTreatment.dangerBackgroundColor);

  await app.close();

  const restoredPipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  restoredPipeline.entryGraph = 'graphs/main.or-graph';
  fs.writeFileSync(pipelinePath, JSON.stringify(restoredPipeline, null, 2));
  const mainGraphPath = path.join(path.dirname(pipelinePath), 'graphs', 'main.or-graph');
  const brokenGraph = JSON.parse(fs.readFileSync(mainGraphPath, 'utf-8'));
  const qualityNode = brokenGraph.graph.nodes.find((node: any) => node.id === 'quality-graph');
  qualityNode.config.graphRef = 'missing-quality.or-graph';
  fs.writeFileSync(mainGraphPath, JSON.stringify(brokenGraph, null, 2));

  const graphApp = await launchElectron();
  const graphWin = await graphApp.firstWindow();
  const graphUserData = await graphApp.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(graphUserData, workspace);

  await graphWin.reload();
  await graphWin.waitForLoadState('domcontentloaded');
  await graphWin.waitForSelector('.cm-editor');
  await graphWin.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  await graphWin.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });
  await graphWin.locator('.runbook-item').filter({ hasText: 'Pipeline editor fixture' }).click();
  await graphWin.locator('#btn-preview').click();
  await expect(graphWin.locator('.pipeline-runbar')).toBeVisible();

  await graphWin.locator('[data-pipeline-run-menu]').click();
  await graphWin.locator('button[data-pipeline-run-action="check"]').click();
  const graphStatus = graphWin.locator('.pipeline-runbar-status.danger');
  await expect(graphStatus).toContainText('ORPAD_GRAPH_NOT_FOUND');
  await expect(graphStatus).toContainText('Referenced graph file does not exist.');
  await expect(graphStatus).toContainText('ref: missing-quality.or-graph');

  await graphWin.locator('.pipeline-editor-tabs button').filter({ hasText: 'Flow' }).click();
  await expect(graphWin.locator('.orch-graph-node.type-orpad-graph').filter({ hasText: 'Quality graph' })).toBeVisible();
  await graphWin.locator('button[data-orch-mode="readwrite"]').click();
  await graphWin.locator('.orch-graph-node.type-orpad-graph').filter({ hasText: 'Quality graph' }).click();
  const flowInlineDiagnostic = graphWin.locator('.orch-floating-inspector label.has-inline-diagnostic', {
    has: graphWin.locator('input[data-orch-edit="config.graphRef"]'),
  });
  await expect(flowInlineDiagnostic).toContainText('ORPAD_GRAPH_NOT_FOUND');
  await expect(flowInlineDiagnostic).toContainText('Referenced graph file does not exist.');
  await expect(flowInlineDiagnostic).toContainText('ref: missing-quality.or-graph');

  await graphApp.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('pipeline check surfaces warning when entry graph is omitted from graph declarations', async () => {
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

  const entryGraphPath = path.join(path.dirname(pipelinePath), 'graphs', 'main.or-graph');
  const entryGraph = JSON.parse(fs.readFileSync(entryGraphPath, 'utf-8'));
  entryGraph.graph.nodes = entryGraph.graph.nodes.filter((node: { id?: string }) => node.id !== 'quality-graph');
  entryGraph.graph.transitions = entryGraph.graph.transitions.filter((edge: { from?: string; to?: string }) => (
    edge.from !== 'quality-graph' && edge.to !== 'quality-graph'
  ));
  fs.writeFileSync(entryGraphPath, JSON.stringify(entryGraph, null, 2));

  const warningPipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  warningPipeline.graphs = {
    quality: { file: 'graphs/quality.or-graph', description: 'Quality graph' },
  };
  fs.writeFileSync(pipelinePath, JSON.stringify(warningPipeline, null, 2));

  await win.locator('[data-pipeline-run-menu]').click();
  await win.locator('button[data-pipeline-run-action="check"]').click();
  const status = win.locator('.pipeline-runbar-status.warn');
  await expect(status).toContainText('Ready with warning');
  await expect(status).toContainText('PIPELINE_ENTRY_GRAPH_NOT_DECLARED');
  await expect(status).toContainText('Pipeline entryGraph should also be listed in graphs for clearer replay and editing.');
  await expect(status).toContainText('ref: graphs/main.or-graph');
  await expect(win.locator('button[data-pipeline-run-action="local"]')).toBeEnabled();

  await win.locator('.pipeline-editor-tabs button').filter({ hasText: 'Details' }).click();
  await expect(win.locator('.pipeline-editor-tabs button.active')).toContainText('Details');
  const entryInlineDiagnostic = win.locator('.pipeline-field.has-inline-diagnostic.has-inline-warning').filter({ hasText: 'Entry' });
  await expect(entryInlineDiagnostic).toContainText('PIPELINE_ENTRY_GRAPH_NOT_DECLARED');
  await expect(entryInlineDiagnostic).toContainText('Pipeline entryGraph should also be listed in graphs for clearer replay and editing.');
  await expect(entryInlineDiagnostic).toContainText('ref: graphs/main.or-graph');
  const entryWarningTreatment = await readInlineDiagnosticColorTreatment(entryInlineDiagnostic);
  expect(entryWarningTreatment.className).toContain('warning');
  expect(entryWarningTreatment.className).not.toContain('error');
  expect(entryWarningTreatment.color).toBe(entryWarningTreatment.warningColor);
  expect(entryWarningTreatment.borderLeftColor).toBe(entryWarningTreatment.warningColor);
  expect(entryWarningTreatment.backgroundColor).toBe(entryWarningTreatment.warningBackgroundColor);
  expect(entryWarningTreatment.backgroundColor).not.toBe(entryWarningTreatment.dangerBackgroundColor);
  await win.locator('button[data-pipeline-mode="readwrite"]').click();
  await expect(win.locator('[data-pipeline-field="entryGraph"]')).not.toHaveAttribute('aria-invalid', 'true');

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
    'External research mode selector',
    'Run parallel discovery lenses',
    'Ingest, dedupe, and triage queue',
    'Dispatch and execute bounded work',
    'Done and proof gate',
    'Required evidence and work journal',
  ]);
  await expectFittedGraphNodesClearOfFloatingInspector(win, 'main flow fit');

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
  await expectFittedGraphNodesClearOfFloatingInspector(win, 'nested discovery layer fit');

  await win.locator('.orch-layer-up').click();
  await expect(win.locator('.orch-layer-up')).toHaveCount(0);
  await expect(win.locator('.orch-graph-node').filter({ hasText: 'Run parallel discovery lenses' })).toBeVisible();
  await expectFittedGraphNodesClearOfFloatingInspector(win, 'returned main flow fit');

  await app.close();
});
