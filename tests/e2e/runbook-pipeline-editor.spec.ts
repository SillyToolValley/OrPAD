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

async function expectHeroGraphChromeAtViewport(win: Page, label: string, viewport: { width: number; height: number }): Promise<void> {
  await win.setViewportSize(viewport);
  await win.locator('.orch-graph-frame [data-orch-action="fit"]').first().click();
  await win.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const audit = await win.locator('.orch-graph-frame').first().evaluate((frame) => {
    const rectOf = (element: Element | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      if (!rect.width && !rect.height) return null;
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const overlaps = (a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>, tolerance = 1) => !!a && !!b
      && a.left < b.right - tolerance
      && a.right > b.left + tolerance
      && a.top < b.bottom - tolerance
      && a.bottom > b.top + tolerance;
    const frameRect = rectOf(frame)!;
    const frameStyle = getComputedStyle(frame);
    const frameBeforeStyle = getComputedStyle(frame, '::before');
    const frameAfterStyle = getComputedStyle(frame, '::after');
    const graphTools = frame.querySelector<HTMLElement>('.orch-graph-tools');
    const toolsRect = rectOf(graphTools);
    const legendRect = rectOf(frame.querySelector('.orch-graph-legend'));
    const sampleChrome = (element: HTMLElement) => {
      const rect = rectOf(element);
      const style = getComputedStyle(element);
      return {
        backgroundImage: style.backgroundImage,
        backgroundColor: style.backgroundColor,
        boxShadow: style.boxShadow,
        visible: !!rect && style.display !== 'none' && style.visibility !== 'hidden',
        disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
      };
    };
    const toolButtons = [...frame.querySelectorAll<HTMLElement>('.orch-graph-tools .orch-tool-btn')];
    const toolButtonSamples = toolButtons.slice(0, 3).map(sampleChrome);
    const activeToolButtonSample = (() => {
      const button = toolButtons[0];
      if (!button) return null;
      const wasActive = button.classList.contains('active');
      button.classList.add('active');
      const sample = sampleChrome(button);
      if (!wasActive) button.classList.remove('active');
      return sample;
    })();
    const nodeRects = [...frame.querySelectorAll<HTMLElement>('.orch-graph-node')].map((node) => {
      const rect = rectOf(node)!;
      const style = getComputedStyle(node);
      const title = node.querySelector<HTMLElement>('.orch-graph-node-top strong');
      return {
        ...rect,
        className: node.className,
        backgroundImage: style.backgroundImage,
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
        labelFits: title ? title.scrollWidth <= title.clientWidth + 1 : false,
      };
    });
    const nodeBadgeSamples = [...frame.querySelectorAll<HTMLElement>('.orch-graph-node-top span')]
      .slice(0, 2)
      .map(sampleChrome);
    const runningNodeSample = (() => {
      const node = frame.querySelector<HTMLElement>('.orch-graph-node');
      if (!node) return null;
      const previousClassName = node.className;
      node.classList.add('runtime-running');
      const style = getComputedStyle(node);
      const sample = {
        backgroundImage: style.backgroundImage,
        backgroundColor: style.backgroundColor,
        boxShadow: style.boxShadow,
      };
      node.className = previousClassName;
      return sample;
    })();
    const edgeRects = [...frame.querySelectorAll<SVGPathElement>('.orch-transition')].map((edge) => {
      const rect = rectOf(edge);
      if (!rect) return null;
      const style = getComputedStyle(edge);
      return {
        ...rect,
        markerEnd: edge.getAttribute('marker-end') || style.markerEnd,
        strokeWidth: Number.parseFloat(style.strokeWidth || '0'),
      };
    }).filter(Boolean) as Array<{
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
      height: number;
      markerEnd: string;
      strokeWidth: number;
    }>;
    const labelRects = [...frame.querySelectorAll<SVGGraphicsElement>('.orch-transition-label-bg')].map(rectOf).filter(Boolean);
    const nodeOverlaps = nodeRects.flatMap((node, index) =>
      nodeRects.slice(index + 1).filter(other => overlaps(node, other)).map(other => [node.className, other.className])
    );
    const nodeToolOverlaps = nodeRects.filter(node => overlaps(node, toolsRect));
    const nodeLegendOverlaps = nodeRects.filter(node => overlaps(node, legendRect));
    const labelNodeOverlaps = labelRects.filter(labelRect => nodeRects.some(node => overlaps(labelRect, node)));
    const edgeToolOverlaps = edgeRects.filter(edge => overlaps(edge, toolsRect, 0));
    const edgeLegendOverlaps = edgeRects.filter(edge => overlaps(edge, legendRect, 0));
    const nodesInFrame = nodeRects.every(node =>
      node.left >= frameRect.left - 1
      && node.top >= frameRect.top - 1
      && node.right <= frameRect.right + 1
      && node.bottom <= frameRect.bottom + 1
    );

    return {
      frame: {
        backgroundImage: frameStyle.backgroundImage,
        backgroundColor: frameStyle.backgroundColor,
        beforeBackgroundImage: frameBeforeStyle.backgroundImage,
        afterBackgroundImage: frameAfterStyle.backgroundImage,
        borderRadius: frameStyle.borderRadius,
        boxShadow: frameStyle.boxShadow,
      },
      tools: graphTools ? sampleChrome(graphTools) : null,
      toolButtonCount: toolButtons.length,
      enabledToolButtonCount: toolButtons.filter(button => !button.matches(':disabled') && button.getAttribute('aria-disabled') !== 'true').length,
      toolButtonSamples,
      activeToolButtonSample,
      edgeCount: edgeRects.length,
      minEdgeStrokeWidth: edgeRects.reduce((min, edge) => Math.min(min, edge.strokeWidth), Number.POSITIVE_INFINITY),
      allEdgesHaveMarkers: edgeRects.every(edge => edge.markerEnd && edge.markerEnd !== 'none'),
      nodeCount: nodeRects.length,
      nodeSamples: nodeRects.slice(0, 2),
      nodeBadgeSamples,
      runningNodeSample,
      nodesInFrame,
      nodeOverlaps,
      nodeToolOverlapCount: nodeToolOverlaps.length,
      nodeLegendOverlapCount: nodeLegendOverlaps.length,
      labelNodeOverlapCount: labelNodeOverlaps.length,
      edgeToolOverlapCount: edgeToolOverlaps.length,
      edgeLegendOverlapCount: edgeLegendOverlaps.length,
    };
  });

  const transparentColor = 'rgba(0, 0, 0, 0)';
  const graphToolButton = win.locator('.orch-graph-tools .orch-tool-btn:not(:disabled):not([aria-disabled="true"])').first();
  await expect(win.locator('.orch-graph-tools'), `${label}: graph tools should stay visible`).toBeVisible();
  await expect(graphToolButton, `${label}: graph tool button should stay visible`).toBeVisible();
  await expect(graphToolButton, `${label}: graph tool button should stay usable`).toBeEnabled();
  await graphToolButton.hover();
  const hoveredToolButton = await graphToolButton.evaluate((button) => {
    const style = getComputedStyle(button as HTMLElement);
    return {
      backgroundImage: style.backgroundImage,
      backgroundColor: style.backgroundColor,
    };
  });
  expect(audit.frame.backgroundImage, `${label}: frame should use a solid soft dashboard surface`).toBe('none');
  expect(audit.frame.beforeBackgroundImage, `${label}: frame chrome should avoid decorative pseudo-element gradients`).toBe('none');
  expect(audit.frame.afterBackgroundImage, `${label}: frame depth overlay should avoid decorative gradients`).toBe('none');
  expect(audit.frame.backgroundColor, `${label}: frame should retain a visible surface color`).not.toBe(transparentColor);
  expect(audit.frame.boxShadow, `${label}: frame should have neumorphic depth`).not.toBe('none');
  expect(audit.tools?.backgroundImage, `${label}: graph tools should use solid toolbar chrome`).toBe('none');
  expect(audit.tools?.backgroundColor, `${label}: graph tools should retain a visible surface color`).not.toBe(transparentColor);
  expect(audit.tools?.boxShadow, `${label}: graph tools should retain soft depth`).not.toBe('none');
  expect(audit.toolButtonCount, `${label}: graph tool buttons should render`).toBeGreaterThan(0);
  expect(audit.enabledToolButtonCount, `${label}: graph tools should keep at least one usable control`).toBeGreaterThan(0);
  expect(audit.toolButtonSamples.every(button => button.visible), `${label}: sampled graph tool buttons should stay visible`).toBe(true);
  expect(audit.toolButtonSamples.every(button => button.backgroundImage === 'none'), `${label}: graph tool buttons should avoid decorative gradients`).toBe(true);
  expect(audit.toolButtonSamples.every(button => button.backgroundColor !== transparentColor), `${label}: graph tool buttons should retain visible surfaces`).toBe(true);
  expect(audit.toolButtonSamples.every(button => button.boxShadow !== 'none'), `${label}: graph tool buttons should retain soft depth`).toBe(true);
  expect(audit.activeToolButtonSample?.backgroundImage, `${label}: active graph tool button should avoid decorative gradients`).toBe('none');
  expect(audit.activeToolButtonSample?.backgroundColor, `${label}: active graph tool button should retain a visible state surface`).not.toBe(transparentColor);
  expect(hoveredToolButton.backgroundImage, `${label}: hovered graph tool button should avoid decorative gradients`).toBe('none');
  expect(hoveredToolButton.backgroundColor, `${label}: hovered graph tool button should retain a visible state surface`).not.toBe(transparentColor);
  expect(audit.nodeCount, `${label}: graph nodes should render`).toBeGreaterThan(0);
  expect(audit.nodeSamples.every(node => node.backgroundImage === 'none'), `${label}: nodes should use solid operational surfaces`).toBe(true);
  expect(audit.nodeSamples.every(node => node.backgroundColor !== transparentColor), `${label}: node surfaces should remain visible`).toBe(true);
  expect(audit.nodeSamples.every(node => node.boxShadow !== 'none'), `${label}: nodes should have depth`).toBe(true);
  expect(audit.nodeBadgeSamples.length, `${label}: node type badges should render`).toBeGreaterThan(0);
  expect(audit.nodeBadgeSamples.every(badge => badge.backgroundImage === 'none'), `${label}: node type badges should avoid decorative gradients`).toBe(true);
  expect(audit.nodeBadgeSamples.every(badge => badge.backgroundColor !== transparentColor), `${label}: node type badges should keep visible surfaces`).toBe(true);
  expect(audit.runningNodeSample?.backgroundImage, `${label}: running node should avoid decorative gradients`).toBe('none');
  expect(audit.runningNodeSample?.backgroundColor, `${label}: running node should keep a visible state surface`).not.toBe(transparentColor);
  expect(audit.runningNodeSample?.boxShadow, `${label}: running node should keep state depth`).not.toBe('none');
  expect(audit.nodeSamples.every(node => node.labelFits), `${label}: node labels should fit their cards`).toBe(true);
  expect(audit.edgeCount, `${label}: graph edges should render`).toBeGreaterThan(0);
  expect(audit.minEdgeStrokeWidth, `${label}: edges should be substantial glowing conduits`).toBeGreaterThanOrEqual(3);
  expect(audit.allEdgesHaveMarkers, `${label}: edges should keep direction markers`).toBe(true);
  expect(audit.nodesInFrame, `${label}: fitted nodes should stay inside the frame`).toBe(true);
  expect(audit.nodeOverlaps, `${label}: graph node cards should not overlap`).toEqual([]);
  expect(audit.nodeToolOverlapCount, `${label}: graph tools should not cover nodes`).toBe(0);
  expect(audit.nodeLegendOverlapCount, `${label}: legend should not cover nodes`).toBe(0);
  expect(audit.labelNodeOverlapCount, `${label}: edge labels should not cover nodes`).toBe(0);
  expect(audit.edgeToolOverlapCount, `${label}: tools should not cover visible conduits`).toBe(0);
  expect(audit.edgeLegendOverlapCount, `${label}: legend should not cover visible conduits`).toBe(0);
}

function nodePackManagerRow(win: Page, label: string): Locator {
  return win.locator('.node-pack-manager-pack').filter({ hasText: label });
}

async function openNodePackManagerRowDetail(win: Page, row: Locator): Promise<Locator> {
  const button = row.locator('[data-node-pack-manager-detail-open]');
  await row.evaluate((element) => {
    const list = element.closest<HTMLElement>('.node-pack-manager-list');
    if (!list) {
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      return;
    }
    const rowRect = element.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    list.scrollTop += rowRect.top - listRect.top - ((list.clientHeight - rowRect.height) / 2);
  });
  await win.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  await button.click();
  const modal = win.locator('.node-pack-manager-detail-modal');
  await expect(modal).toBeVisible();
  return modal;
}

async function closeNodePackManagerRowDetail(win: Page): Promise<void> {
  await win.locator('[data-node-pack-manager-detail-close]').click();
  await expect(win.locator('.node-pack-manager-detail-modal')).toHaveCount(0);
}

async function expectNodePackManagerInspectorUsable(win: Page, label: string, expectedPackCount?: number): Promise<void> {
  await win.locator('.node-pack-manager-list').evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  await win.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));

  const layout = await win.locator('.node-pack-manager').evaluate((manager) => {
    const modalBody = document.querySelector('#fmt-modal-body');
    const shell = manager.querySelector<HTMLElement>('.node-pack-manager-shell');
    const list = manager.querySelector<HTMLElement>('.node-pack-manager-list');
    const rows = [...manager.querySelectorAll<HTMLElement>('.node-pack-manager-pack')];
    const managerRect = manager.getBoundingClientRect();
    const bodyRect = modalBody?.getBoundingClientRect();
    const shellRect = shell?.getBoundingClientRect();
    const listRect = list?.getBoundingClientRect();
    const rowRects = rows.map(row => row.getBoundingClientRect());
    const rowActionCounts = rows.map(row => row.querySelectorAll('.node-pack-manager-package-row-actions button').length);
    const tolerance = 1;
    return {
      widthFits: manager.scrollWidth <= manager.clientWidth + tolerance,
      packCount: rows.length,
      managerFitsModalBody: !!bodyRect && managerRect.bottom <= bodyRect.bottom + tolerance,
      managerFitsModalBodyHorizontally: !!bodyRect
        && managerRect.left >= bodyRect.left - tolerance
        && managerRect.right <= bodyRect.right + tolerance,
      shellFitsManager: !!shellRect && shellRect.bottom <= managerRect.bottom + tolerance,
      shellFitsManagerHorizontally: !!shellRect
        && shellRect.left >= managerRect.left - tolerance
        && shellRect.right <= managerRect.right + tolerance,
      panesFitShell: !!shellRect && !!listRect
        && listRect.bottom <= shellRect.bottom + tolerance,
      panesFitShellHorizontally: !!shellRect && !!listRect
        && listRect.left >= shellRect.left - tolerance
        && listRect.right <= shellRect.right + tolerance,
      listHasViewport: !!list && list.clientHeight > 0,
      listWidthFits: !!list && list.scrollWidth <= list.clientWidth + tolerance,
      rowsStayInList: !!listRect && rowRects.every(rect => rect.left >= listRect.left - tolerance && rect.right <= listRect.right + tolerance),
      rowsHaveExpectedActions: rowActionCounts.every(count => count === 2),
      debug: {
        listScrollTop: list?.scrollTop ?? null,
        listScrollHeight: list?.scrollHeight ?? null,
        listClientHeight: list?.clientHeight ?? null,
        rowActionCounts,
      },
    };
  });

  expect(layout.widthFits, `${label}: manager should not overflow horizontally`).toBe(true);
  expect(layout.managerFitsModalBody, `${label}: manager should fit inside the modal body`).toBe(true);
  expect(layout.managerFitsModalBodyHorizontally, `${label}: manager should not be clipped by the modal body ${JSON.stringify(layout)}`).toBe(true);
  expect(layout.shellFitsManager, `${label}: inspector shell should fit inside the manager`).toBe(true);
  expect(layout.shellFitsManagerHorizontally, `${label}: inspector shell should not be clipped horizontally ${JSON.stringify(layout)}`).toBe(true);
  expect(layout.panesFitShell, `${label}: list and inspector panes should fit inside the shell ${JSON.stringify(layout)}`).toBe(true);
  expect(layout.panesFitShellHorizontally, `${label}: list and inspector panes should not overflow the shell ${JSON.stringify(layout)}`).toBe(true);
  expect(layout.listHasViewport, `${label}: package list should have visible height`).toBe(true);
  expect(layout.listWidthFits, `${label}: package list should not require horizontal scroll ${JSON.stringify(layout)}`).toBe(true);
  expect(layout.rowsStayInList, `${label}: package rows should stay inside the list ${JSON.stringify(layout)}`).toBe(true);
  expect(layout.rowsHaveExpectedActions, `${label}: package rows should expose Detail and Import actions ${JSON.stringify(layout)}`).toBe(true);
  if (typeof expectedPackCount === 'number') {
    expect(layout.packCount, `${label}: pack count`).toBe(expectedPackCount);
  }
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

async function setNodePackRegistryInstallMock(win: Page): Promise<void> {
  await win.evaluate(() => {
    let installed = false;
    const registryEntry = {
      id: 'community.registry-pack',
      name: 'Registry Community Pack',
      description: '<strong>Registry prose stays text.</strong>',
      latestVersion: '0.1.0',
      versionCount: 1,
      sourceRepository: 'https://github.com/example/registry-pack',
      sourceRef: 'v0.1.0',
      manifestPath: 'orpad.node-pack.json',
      trustLevel: 'community',
      capabilities: ['read.workspace'],
      keywords: ['registry'],
      categories: ['Testing'],
      author: { name: 'Fixture Author', repository: 'https://github.com/example/registry-pack' },
      license: 'MIT',
      installable: true,
    };
    const installedResponse = () => ({
      success: true,
      ok: true,
      nodePacks: installed ? [{
        id: registryEntry.id,
        name: registryEntry.name,
        version: registryEntry.latestVersion,
        origin: 'user-installed',
        trustLevel: 'community',
        resolutionState: 'untrusted',
        capabilities: ['read.workspace'],
        description: registryEntry.description,
        discovery: {
          rootKind: 'user',
          packDir: '/packs/community.registry-pack',
          manifestPath: '/packs/community.registry-pack/orpad.node-pack.json',
        },
        nodes: [],
      }] : [],
      diagnostics: [],
      conflicts: [],
    });
    const mockListNodePacks = async () => installedResponse();
    (mockListNodePacks as any).orpadTestOverride = true;
    (window as any).__orpadNodePackManagerListPacks = mockListNodePacks;
    (window as any).__orpadNodePackListPacks = mockListNodePacks;
    (window as any).__orpadNodePackRegistrySource = 'https://registry.example/orpad-node-packs.json';
    (window as any).__orpadNodePackRegistryList = async () => ({
      success: true,
      ok: true,
      registry: {
        registryId: 'orpad.test',
        name: 'Fixture Registry',
      },
      source: 'https://registry.example/orpad-node-packs.json',
      entries: [registryEntry],
      diagnostics: [],
    });
    (window as any).__orpadNodePackRegistrySearch = async () => ({
      success: true,
      ok: true,
      registry: {
        registryId: 'orpad.test',
        name: 'Fixture Registry',
      },
      source: 'https://registry.example/orpad-node-packs.json',
      entries: [registryEntry],
      diagnostics: [],
      query: 'registry',
    });
    (window as any).__orpadNodePackInstall = async ({ packId }: { packId: string }) => {
      if (packId !== registryEntry.id) {
        return { success: false, ok: false, error: 'unexpected pack id' };
      }
      installed = true;
      return { success: true, ok: true, action: 'install', nodePack: installedResponse().nodePacks[0], diagnostics: [] };
    };
  });
}

async function setNodePackMissingResolutionRegistryMock(win: Page): Promise<void> {
  await win.evaluate(() => {
    let installed = false;
    const registryEntry = {
      id: 'community.missing-pack',
      name: 'Missing Pack Candidate',
      description: 'Candidate pack that resolves a shared pipeline dependency.',
      latestVersion: '9.9.1',
      versionCount: 1,
      sourceRepository: 'https://github.com/example/missing-pack',
      sourceRef: 'v9.9.1',
      manifestPath: 'orpad.node-pack.json',
      trustLevel: 'community',
      capabilities: ['read.workspace'],
      nodeTypes: ['community.sharedNode'],
      keywords: ['missing', 'shared'],
      categories: ['Testing'],
      author: { name: 'Fixture Author', repository: 'https://github.com/example/missing-pack' },
      license: 'MIT',
      installable: true,
    };
    const installedResponse = () => ({
      success: true,
      ok: true,
      nodePacks: installed ? [{
        id: registryEntry.id,
        name: registryEntry.name,
        version: registryEntry.latestVersion,
        origin: 'user-installed',
        trustLevel: 'community',
        resolutionState: 'resolved',
        validationStatus: 'valid',
        capabilities: ['read.workspace'],
        description: registryEntry.description,
        discovery: {
          rootKind: 'user',
          packDir: '/packs/community.missing-pack',
          manifestPath: '/packs/community.missing-pack/orpad.node-pack.json',
        },
        nodes: [{
          type: 'community.sharedNode',
          path: 'nodes/shared.or-node',
          runtimeHandlerKind: 'metadata-only',
          capabilities: ['read.workspace'],
        }],
      }] : [],
      diagnostics: [],
      conflicts: [],
    });
    const mockListNodePacks = async () => installedResponse();
    (mockListNodePacks as any).orpadTestOverride = true;
    (window as any).__orpadNodePackManagerListPacks = mockListNodePacks;
    (window as any).__orpadNodePackListPacks = mockListNodePacks;
    (window as any).__orpadNodePackRegistrySource = 'https://registry.example/orpad-node-packs.json';
    const registryResponse = (query = '') => ({
      success: true,
      ok: true,
      registry: {
        registryId: 'orpad.test',
        name: 'Fixture Registry',
      },
      source: 'https://registry.example/orpad-node-packs.json',
      entries: [registryEntry],
      diagnostics: [],
      query,
    });
    (window as any).__orpadNodePackRegistryList = async () => registryResponse('');
    (window as any).__orpadNodePackRegistrySearch = async ({ query }: { query?: string }) => registryResponse(query || '');
    (window as any).__orpadNodePackInstall = async ({ packId }: { packId: string }) => {
      if (packId !== registryEntry.id) {
        return { success: false, ok: false, error: 'unexpected pack id' };
      }
      installed = true;
      return { success: true, ok: true, action: 'install', nodePack: installedResponse().nodePacks[0], diagnostics: [] };
    };
  });
}

async function setNodePackRegistryUpdateMock(win: Page): Promise<void> {
  await win.evaluate(() => {
    let installedVersion = '0.1.0';
    const registryEntry = {
      id: 'community.update-pack',
      name: 'Registry Update Pack',
      description: 'Update candidate prose.',
      latestVersion: '0.2.0',
      versionCount: 2,
      sourceRepository: 'https://github.com/example/update-pack',
      sourceRef: 'v0.2.0',
      manifestPath: 'orpad.node-pack.json',
      trustLevel: 'community',
      signatureStatus: 'declared',
      checksumStatus: 'manifest-and-files-declared',
      reviewStatus: 'approved',
      capabilities: ['read.workspace'],
      keywords: ['update'],
      categories: ['Testing'],
      author: { name: 'Fixture Author', repository: 'https://github.com/example/update-pack' },
      license: 'MIT',
      installable: true,
    };
    const installedPack = () => ({
      id: registryEntry.id,
      name: registryEntry.name,
      version: installedVersion,
      origin: 'user-installed',
      trustLevel: 'community',
      resolutionState: 'resolved',
      validationStatus: 'valid',
      capabilities: ['read.workspace'],
      description: registryEntry.description,
      discovery: {
        rootKind: 'user',
        packDir: '/packs/community.update-pack',
        manifestPath: '/packs/community.update-pack/orpad.node-pack.json',
      },
      nodes: [],
    });
    const installedResponse = () => ({
      success: true,
      ok: true,
      nodePacks: [installedPack()],
      diagnostics: [],
      conflicts: [],
    });
    const mockListNodePacks = async () => installedResponse();
    (mockListNodePacks as any).orpadTestOverride = true;
    (window as any).__orpadNodePackManagerListPacks = mockListNodePacks;
    (window as any).__orpadNodePackListPacks = mockListNodePacks;
    (window as any).__orpadNodePackRegistrySource = 'https://registry.example/orpad-node-packs.json';
    (window as any).__orpadNodePackRegistryList = async () => ({
      success: true,
      ok: true,
      registry: {
        registryId: 'orpad.test',
        name: 'Fixture Registry',
      },
      source: 'https://registry.example/orpad-node-packs.json',
      entries: [registryEntry],
      diagnostics: [],
    });
    (window as any).__orpadNodePackUpdate = async ({ packId }: { packId: string }) => {
      if (packId !== registryEntry.id) {
        return { success: false, ok: false, error: 'unexpected pack id' };
      }
      installedVersion = registryEntry.latestVersion;
      return {
        success: true,
        ok: true,
        action: 'update',
        results: [{ success: true, ok: true, action: 'install', nodePack: installedPack(), diagnostics: [] }],
        nodePack: installedPack(),
        diagnostics: [],
      };
    };
  });
}

async function setNodePackWorkspaceLockMock(win: Page): Promise<void> {
  await win.evaluate(() => {
    const workspaceRegistrySource = 'https://registry.example/workspace-lock.json';
    const defaultRegistrySource = 'https://registry.example/default.json';
    let installedVersion = '0.1.0';
    let missingInstalled = false;
    const registryCalls: string[] = [];
    const workspaceLockUpserts: any[] = [];
    const installRequests: any[] = [];
    const lockedEntry = {
      id: 'community.locked-pack',
      name: 'Workspace Locked Pack',
      description: 'Workspace lock drift fixture package.',
      latestVersion: '0.2.0',
      versionCount: 2,
      sourceRepository: 'https://github.com/example/workspace-locked-pack',
      sourceRef: 'v0.2.0',
      manifestPath: 'orpad.node-pack.json',
      trustLevel: 'community',
      signatureStatus: 'declared',
      checksumStatus: 'manifest-and-files-declared',
      reviewStatus: 'approved',
      capabilities: ['read.workspace'],
      nodeTypes: ['community.lockedNode'],
      categories: ['Testing'],
      installable: true,
    };
    const missingEntry = {
      id: 'community.missing-pack',
      name: 'Workspace Lock Missing Candidate',
      description: 'Candidate selected from workspace lock metadata.',
      latestVersion: '9.9.1',
      versionCount: 1,
      sourceRepository: 'https://github.com/example/workspace-missing-pack',
      sourceRef: 'v9.9.1',
      manifestPath: 'orpad.node-pack.json',
      trustLevel: 'community',
      signatureStatus: 'declared',
      checksumStatus: 'manifest-and-files-declared',
      reviewStatus: 'approved',
      capabilities: ['read.workspace'],
      nodeTypes: ['community.sharedNode'],
      categories: ['Testing'],
      installable: true,
    };
    const unsafeEntry = {
      id: 'community.locked-unsafe',
      name: 'Workspace Lock Unsafe Pack',
      description: 'Unsafe package remains blocked even when lock metadata exists.',
      latestVersion: '0.9.0',
      versionCount: 1,
      sourceRepository: 'https://github.com/example/workspace-unsafe-pack',
      sourceRef: 'v0.9.0',
      manifestPath: 'orpad.node-pack.json',
      trustLevel: 'community',
      signatureStatus: 'declared',
      checksumStatus: 'mismatch',
      reviewStatus: 'approved',
      capabilities: ['read.workspace', 'use.credentials'],
      highRiskCapabilities: ['use.credentials'],
      nodeTypes: ['community.unsafeNode'],
      categories: ['Testing'],
      installable: true,
    };
    let workspaceLock = {
      kind: 'orpad.workspaceNodePackLock',
      schemaVersion: '1.0',
      updatedAt: '2026-05-26T00:00:00.000Z',
      packs: [{
        id: lockedEntry.id,
        version: '0.2.0',
        registrySource: workspaceRegistrySource,
        source: 'registry',
        sourceRepository: lockedEntry.sourceRepository,
        sourceRef: lockedEntry.sourceRef,
        manifestPath: lockedEntry.manifestPath,
        signatureStatus: lockedEntry.signatureStatus,
        checksumStatus: lockedEntry.checksumStatus,
        reviewStatus: lockedEntry.reviewStatus,
        trustLevel: lockedEntry.trustLevel,
        capabilities: lockedEntry.capabilities,
        resolvedNodeTypes: lockedEntry.nodeTypes,
        metadataTrust: 'registry-discovery-only',
        diagnostics: [],
      }, {
        id: missingEntry.id,
        version: missingEntry.latestVersion,
        registrySource: workspaceRegistrySource,
        source: 'registry',
        sourceRepository: missingEntry.sourceRepository,
        sourceRef: missingEntry.sourceRef,
        manifestPath: missingEntry.manifestPath,
        signatureStatus: missingEntry.signatureStatus,
        checksumStatus: missingEntry.checksumStatus,
        reviewStatus: missingEntry.reviewStatus,
        trustLevel: missingEntry.trustLevel,
        capabilities: missingEntry.capabilities,
        resolvedNodeTypes: missingEntry.nodeTypes,
        metadataTrust: 'registry-discovery-only',
        diagnostics: [],
      }, {
        id: unsafeEntry.id,
        version: unsafeEntry.latestVersion,
        registrySource: workspaceRegistrySource,
        source: 'registry',
        checksumStatus: unsafeEntry.checksumStatus,
        reviewStatus: unsafeEntry.reviewStatus,
        highRiskCapabilities: unsafeEntry.highRiskCapabilities,
        resolvedNodeTypes: unsafeEntry.nodeTypes,
        metadataTrust: 'registry-discovery-only',
        diagnostics: [],
      }],
    };
    const installedPack = () => ({
      id: lockedEntry.id,
      name: lockedEntry.name,
      version: installedVersion,
      origin: 'user-installed',
      trustLevel: 'community',
      resolutionState: 'resolved',
      validationStatus: 'valid',
      capabilities: ['read.workspace'],
      description: lockedEntry.description,
      discovery: {
        rootKind: 'user',
        packDir: '/packs/community.locked-pack',
        manifestPath: '/packs/community.locked-pack/orpad.node-pack.json',
      },
      nodes: [{
        type: 'community.lockedNode',
        path: 'nodes/locked.or-node',
        runtimeHandlerKind: 'metadata-only',
        capabilities: ['read.workspace'],
      }],
    });
    const missingInstalledPack = () => ({
      id: missingEntry.id,
      name: missingEntry.name,
      version: missingEntry.latestVersion,
      origin: 'user-installed',
      trustLevel: 'community',
      resolutionState: 'resolved',
      validationStatus: 'valid',
      capabilities: ['read.workspace'],
      description: missingEntry.description,
      discovery: {
        rootKind: 'user',
        packDir: '/packs/community.missing-pack',
        manifestPath: '/packs/community.missing-pack/orpad.node-pack.json',
      },
      nodes: [{
        type: 'community.sharedNode',
        path: 'nodes/shared.or-node',
        runtimeHandlerKind: 'metadata-only',
        capabilities: ['read.workspace'],
      }],
    });
    const installedResponse = () => ({
      success: true,
      ok: true,
      nodePacks: [
        installedPack(),
        ...(missingInstalled ? [missingInstalledPack()] : []),
      ],
      diagnostics: [],
      conflicts: [],
    });
    const lockResponse = () => ({
      success: true,
      ok: true,
      path: '/workspace/.orpad/orpad-node-packs.lock.json',
      lockPath: '/workspace/.orpad/orpad-node-packs.lock.json',
      lock: workspaceLock,
      packs: workspaceLock.packs,
      diagnostics: [],
    });
    const mockListNodePacks = async () => installedResponse();
    (mockListNodePacks as any).orpadTestOverride = true;
    (window as any).__orpadNodePackManagerListPacks = mockListNodePacks;
    (window as any).__orpadNodePackListPacks = mockListNodePacks;
    (window as any).__orpadDefaultNodePackRegistrySource = defaultRegistrySource;
    (window as any).__orpadNodePackRegistrySource = defaultRegistrySource;
    (window as any).__orpadNodePackWorkspaceLockRead = async () => lockResponse();
    (window as any).__orpadNodePackWorkspaceLockWrite = async ({ lock }: { lock: any }) => {
      workspaceLock = { ...workspaceLock, ...(lock || {}), packs: Array.isArray(lock?.packs) ? lock.packs : workspaceLock.packs };
      return lockResponse();
    };
    (window as any).__orpadNodePackWorkspaceLockUpsert = async ({ entry }: { entry: any }) => {
      workspaceLockUpserts.push(entry);
      workspaceLock = {
        ...workspaceLock,
        updatedAt: '2026-05-26T01:00:00.000Z',
        packs: [
          ...workspaceLock.packs.filter(item => item.id !== entry.id),
          { ...entry, metadataTrust: 'registry-discovery-only' },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      };
      return lockResponse();
    };
    (window as any).__orpadNodePackWorkspaceLockUpserts = workspaceLockUpserts;
    (window as any).__orpadNodePackRegistryCalls = registryCalls;
    const registryResponse = ({ registry, query = '' }: { registry?: string; query?: string } = {}) => {
      const source = registry || defaultRegistrySource;
      registryCalls.push(source);
      return {
        success: true,
        ok: true,
        registry: {
          registryId: source === workspaceRegistrySource ? 'orpad.workspace-lock-fixture' : 'orpad.default-fixture',
          name: source === workspaceRegistrySource ? 'Workspace Lock Fixture Registry' : 'Default Fixture Registry',
        },
        source,
        sourceKind: 'url',
        entries: [lockedEntry, missingEntry, unsafeEntry],
        diagnostics: [],
        query,
      };
    };
    (window as any).__orpadNodePackRegistryList = async (request: { registry?: string } = {}) => registryResponse(request);
    (window as any).__orpadNodePackRegistrySearch = async (request: { registry?: string; query?: string } = {}) => registryResponse(request);
    (window as any).__orpadNodePackInstallRequests = installRequests;
    (window as any).__orpadNodePackInstall = async (request: { packId: string; version?: string; registry?: string }) => {
      installRequests.push({ ...request });
      if (request.packId === lockedEntry.id) {
        installedVersion = request.version || lockedEntry.latestVersion;
        return { success: true, ok: true, action: 'install', nodePack: installedPack(), diagnostics: [] };
      }
      if (request.packId === missingEntry.id) {
        missingInstalled = true;
        return { success: true, ok: true, action: 'install', nodePack: missingInstalledPack(), diagnostics: [] };
      }
      return { success: false, ok: false, action: 'install', error: 'unsafe or unexpected package should have been blocked before IPC', diagnostics: [] };
    };
    (window as any).__orpadNodePackUpdate = async ({ packId }: { packId: string }) => {
      if (packId !== lockedEntry.id) {
        return { success: false, ok: false, action: 'update', error: 'unexpected pack id', diagnostics: [] };
      }
      installedVersion = lockedEntry.latestVersion;
      return {
        success: true,
        ok: true,
        action: 'update',
        results: [{ success: true, ok: true, action: 'install', nodePack: installedPack(), diagnostics: [] }],
        nodePack: installedPack(),
        diagnostics: [],
      };
    };
  });
}

async function setNodePackInstalledLifecycleMock(win: Page): Promise<void> {
  await win.evaluate(() => {
    let installed = true;
    let installedVersion = '0.2.0';
    let previousInstall = {
      backupPath: '/backups/community.lifecycle-pack-0.1.0',
      replacedAt: '2026-05-25T01:00:00.000Z',
      previousEntry: {
        id: 'community.lifecycle-pack',
        version: '0.1.0',
        source: 'registry:orpad.test',
      },
    };
    const installedPack = () => ({
      id: 'community.lifecycle-pack',
      name: 'Lifecycle Package',
      version: installedVersion,
      origin: 'user-installed',
      trustLevel: 'community',
      resolutionState: 'resolved',
      validationStatus: 'valid',
      capabilities: ['read.workspace'],
      description: 'Lifecycle package prose.',
      discovery: {
        rootKind: 'user',
        packDir: '/packs/community.lifecycle-pack',
        manifestPath: '/packs/community.lifecycle-pack/orpad.node-pack.json',
      },
      nodes: [],
    });
    const lockEntry = () => ({
      id: 'community.lifecycle-pack',
      version: installedVersion,
      enabled: true,
      source: 'registry:orpad.test',
      installedAt: '2026-05-25T02:00:00.000Z',
      installedBy: 'node-pack-manager',
      previousInstall,
      capabilities: ['read.workspace'],
      diagnostics: [],
    });
    const installedResponse = () => ({
      success: true,
      ok: true,
      nodePacks: installed ? [installedPack()] : [],
      diagnostics: [],
      conflicts: [],
    });
    const exportResponse = () => ({
      success: true,
      ok: true,
      action: 'export-list',
      lockPath: '/userData/nodes/orpad-node-packs.lock.json',
      packs: installed ? [lockEntry()] : [],
      discovery: {
        ok: true,
        diagnostics: [],
        conflicts: [],
        nodePackIds: installed ? ['community.lifecycle-pack'] : [],
      },
      diagnostics: [],
    });
    const mockListNodePacks = async () => installedResponse();
    (mockListNodePacks as any).orpadTestOverride = true;
    (window as any).__orpadNodePackManagerListPacks = mockListNodePacks;
    (window as any).__orpadNodePackListPacks = mockListNodePacks;
    (window as any).__orpadNodePackExportList = async () => exportResponse();
    (window as any).__orpadNodePackRollback = async ({ packId }: { packId: string }) => {
      if (packId !== 'community.lifecycle-pack') {
        return { success: false, ok: false, action: 'rollback', error: 'unexpected pack id', diagnostics: [] };
      }
      installedVersion = '0.1.0';
      previousInstall = {
        backupPath: '/backups/community.lifecycle-pack-0.2.0',
        replacedAt: '2026-05-25T03:00:00.000Z',
        previousEntry: {
          id: 'community.lifecycle-pack',
          version: '0.2.0',
          source: 'registry:orpad.test',
        },
      };
      return {
        success: true,
        ok: true,
        action: 'rollback',
        nodePack: installedPack(),
        backupPath: previousInstall.backupPath,
        diagnostics: [{
          level: 'warning',
          code: 'NODE_PACK_ROLLBACK_RESTORED_BACKUP',
          message: 'Installed package was restored from rollback backup.',
          packId,
        }],
      };
    };
    (window as any).__orpadNodePackRemove = async ({ packId }: { packId: string }) => {
      if (packId !== 'community.lifecycle-pack') {
        return { success: false, ok: false, action: 'remove', error: 'unexpected pack id', diagnostics: [] };
      }
      installed = false;
      return {
        success: true,
        ok: true,
        action: 'remove',
        backupPath: '/backups/community.lifecycle-pack-removed',
        diagnostics: [{
          level: 'warning',
          code: 'NODE_PACK_INSTALL_REMOVED_TO_BACKUP',
          message: 'Installed package was moved to a backup directory instead of being deleted.',
          packId,
        }],
      };
    };
  });
}

async function setNodePackRegistryUpdateFailureMock(win: Page): Promise<void> {
  await win.evaluate(() => {
    const registryEntry = {
      id: 'community.update-failure',
      name: 'Registry Update Failure Pack',
      description: 'Update failure candidate prose.',
      latestVersion: '0.2.0',
      versionCount: 2,
      sourceRepository: 'https://github.com/example/update-failure-pack',
      sourceRef: 'v0.2.0',
      manifestPath: 'orpad.node-pack.json',
      trustLevel: 'community',
      signatureStatus: 'declared',
      checksumStatus: 'manifest-and-files-declared',
      reviewStatus: 'approved',
      capabilities: ['read.workspace'],
      keywords: ['update'],
      categories: ['Testing'],
      author: { name: 'Fixture Author', repository: 'https://github.com/example/update-failure-pack' },
      license: 'MIT',
      installable: true,
    };
    const installedPack = () => ({
      id: registryEntry.id,
      name: registryEntry.name,
      version: '0.1.0',
      origin: 'user-installed',
      trustLevel: 'community',
      resolutionState: 'resolved',
      validationStatus: 'valid',
      capabilities: ['read.workspace'],
      description: registryEntry.description,
      discovery: {
        rootKind: 'user',
        packDir: '/packs/community.update-failure',
        manifestPath: '/packs/community.update-failure/orpad.node-pack.json',
      },
      nodes: [],
    });
    const installedResponse = () => ({
      success: true,
      ok: true,
      nodePacks: [installedPack()],
      diagnostics: [],
      conflicts: [],
    });
    const mockListNodePacks = async () => installedResponse();
    (mockListNodePacks as any).orpadTestOverride = true;
    (window as any).__orpadNodePackManagerListPacks = mockListNodePacks;
    (window as any).__orpadNodePackListPacks = mockListNodePacks;
    (window as any).__orpadNodePackRegistrySource = 'https://registry.example/orpad-node-packs.json';
    (window as any).__orpadNodePackRegistryList = async () => ({
      success: true,
      ok: true,
      registry: {
        registryId: 'orpad.test',
        name: 'Fixture Registry',
      },
      source: 'https://registry.example/orpad-node-packs.json',
      entries: [registryEntry],
      diagnostics: [],
    });
    (window as any).__orpadNodePackExportList = async () => ({
      success: true,
      ok: true,
      action: 'export-list',
      lockPath: '/userData/nodes/orpad-node-packs.lock.json',
      packs: [{
        id: registryEntry.id,
        version: '0.1.0',
        enabled: true,
        source: 'registry:orpad.test',
        installedAt: '2026-05-25T02:00:00.000Z',
        capabilities: ['read.workspace'],
        diagnostics: [],
      }],
      discovery: {
        ok: true,
        diagnostics: [],
        conflicts: [],
        nodePackIds: [registryEntry.id],
      },
      diagnostics: [],
    });
    (window as any).__orpadNodePackUpdate = async ({ packId }: { packId: string }) => {
      if (packId !== registryEntry.id) {
        return { success: false, ok: false, error: 'unexpected pack id' };
      }
      return {
        success: false,
        ok: false,
        action: 'update',
        error: 'checksum mismatch',
        diagnostics: [{
          level: 'error',
          code: 'NODE_PACK_INSTALL_DECLARED_FILE_CHECKSUM_MISMATCH',
          message: 'Declared package file checksum did not match registry metadata.',
          packId,
        }],
      };
    };
  });
}

async function setNodePackRegistrySourceManagementMock(win: Page): Promise<void> {
  await win.evaluate(() => {
    const defaultSource = 'https://registry.example/default.json';
    const customSource = 'https://registry.example/custom.json';
    localStorage.removeItem('orpad.nodePackRegistrySource');
    localStorage.removeItem('orpad.nodePackRegistryRecentSources');
    const registryCalls: string[] = [];
    const officialGovernance = {
      registryTrust: 'official',
      reviewModel: 'orpad-pr-reviewed',
      submissions: { type: 'pull-request', url: 'https://github.com/orpad/registry/pulls' },
      reviewPolicyUrl: 'https://orpad.dev/docs/package-registry-review',
      maintainer: 'OrPAD maintainers',
      notes: 'Fixture official registry metadata is admitted by maintainer-reviewed PRs.',
    };
    const customGovernance = {
      registryTrust: 'official',
      reviewModel: 'orpad-pr-reviewed',
      submissions: { type: 'pull-request', url: 'https://registry.example/custom/pulls' },
      reviewPolicyUrl: 'https://registry.example/custom/review-policy',
      maintainer: 'Custom registry maintainers',
      notes: 'Fixture custom registry metadata claims official review but remains discovery-only in OrPAD.',
    };
    const registryEntry = {
      id: 'community.source-pack',
      name: 'Registry Source Pack',
      description: 'Registry source management fixture package.',
      latestVersion: '0.2.0',
      versionCount: 2,
      sourceRepository: 'https://github.com/example/source-pack',
      sourceRef: 'v0.2.0',
      manifestPath: 'orpad.node-pack.json',
      trustLevel: 'community',
      signatureStatus: 'missing',
      checksumStatus: 'missing',
      reviewStatus: 'unreviewed',
      capabilities: ['read.workspace'],
      keywords: ['registry', 'source'],
      categories: ['Testing'],
      author: { name: 'Fixture Author', repository: 'https://github.com/example/source-pack' },
      license: 'MIT',
      installable: true,
    };
    const installedPack = () => ({
      id: registryEntry.id,
      name: registryEntry.name,
      version: '0.1.0',
      origin: 'user-installed',
      trustLevel: 'community',
      resolutionState: 'resolved',
      validationStatus: 'valid',
      capabilities: ['read.workspace'],
      description: registryEntry.description,
      discovery: {
        rootKind: 'user',
        packDir: '/packs/community.source-pack',
        manifestPath: '/packs/community.source-pack/orpad.node-pack.json',
      },
      nodes: [],
    });
    const mockListNodePacks = async () => ({
      success: true,
      ok: true,
      nodePacks: [installedPack()],
      diagnostics: [],
      conflicts: [],
    });
    (mockListNodePacks as any).orpadTestOverride = true;
    (window as any).__orpadNodePackManagerListPacks = mockListNodePacks;
    (window as any).__orpadNodePackListPacks = mockListNodePacks;
    (window as any).__orpadDefaultNodePackRegistrySource = defaultSource;
    (window as any).__orpadNodePackRegistrySource = '';
    (window as any).__orpadNodePackRegistryCalls = registryCalls;
    const registryResponse = ({ registry, query = '' }: { registry?: string; query?: string } = {}) => {
      const source = registry || defaultSource;
      registryCalls.push(source);
      if (source === customSource) {
        return {
          success: true,
          ok: true,
          registry: {
            registryId: 'orpad.cached-custom',
            name: 'Cached Custom Fixture Registry',
            governance: customGovernance,
            metadataTrust: 'orpad-official-registry-reviewed',
          },
          source,
          sourceKind: 'url',
          fromCache: true,
          entries: [registryEntry],
          diagnostics: [{
            level: 'warning',
            code: 'NODE_PACK_REGISTRY_SOURCE_FAILED_CACHE_USED',
            message: 'Package registry source failed; using last valid cache.',
            source,
          }],
          query,
        };
      }
      return {
        success: true,
        ok: true,
        registry: {
          registryId: 'orpad.default-fixture',
          name: 'Default Fixture Registry',
          governance: officialGovernance,
          metadataTrust: 'orpad-official-registry-reviewed',
          signature: {
            scheme: 'ed25519',
            keyId: 'orpad-registry-test-key',
            verified: true,
            verificationAttempted: true,
            fingerprint: 'SHA256:default-registry-fixture',
          },
        },
        source,
        sourceKind: 'url',
        entries: [registryEntry],
        diagnostics: [],
        query,
      };
    };
    (window as any).__orpadNodePackRegistryList = async (request: { registry?: string } = {}) => registryResponse(request);
    (window as any).__orpadNodePackRegistrySearch = async (request: { registry?: string; query?: string } = {}) => registryResponse(request);
  });
}

async function setNodePackRegistryTrustReviewMock(win: Page): Promise<void> {
  await win.evaluate(() => {
    const registrySource = 'https://registry.example/trust-review.json';
    localStorage.removeItem('orpad.nodePackRegistrySource');
    localStorage.removeItem('orpad.nodePackRegistryRecentSources');
    let warningPackInstalled = false;
    const installCalls: string[] = [];
    const updateCalls: string[] = [];
    const warningEntry = {
      id: 'community.warning-pack',
      name: 'Registry Warning Pack',
      description: 'Unsigned registry entry that still requires explicit confirmation.',
      latestVersion: '0.1.0',
      versionCount: 1,
      sourceRepository: 'https://github.com/example/warning-pack',
      sourceRef: 'v0.1.0',
      manifestPath: 'orpad.node-pack.json',
      trustLevel: 'community',
      signatureStatus: 'missing',
      checksumStatus: 'missing',
      reviewStatus: 'unreviewed',
      capabilities: ['read.workspace'],
      installable: true,
    };
    const blockedEntry = {
      id: 'community.unsafe-pack',
      name: 'Registry Unsafe Pack',
      description: 'Unsafe registry entry should never look installable.',
      latestVersion: '0.3.0',
      versionCount: 2,
      sourceRepository: 'https://github.com/example/unsafe-pack',
      sourceRef: 'v0.3.0',
      manifestPath: 'orpad.node-pack.json',
      trustLevel: 'community',
      signatureStatus: 'missing',
      checksumStatus: 'mismatch',
      reviewStatus: 'unreviewed',
      capabilities: ['read.workspace', 'use.credentials'],
      highRiskCapabilities: ['use.credentials'],
      installable: true,
    };
    const reviewedHighRiskEntry = {
      id: 'community.reviewed-high-risk',
      name: 'Registry Reviewed High Risk Pack',
      description: 'Reviewed package that still carries high-risk capability warnings.',
      latestVersion: '0.5.0',
      versionCount: 1,
      sourceRepository: 'https://github.com/example/reviewed-high-risk',
      sourceRef: 'v0.5.0',
      manifestPath: 'orpad.node-pack.json',
      trustLevel: 'community',
      signatureStatus: 'declared',
      checksumStatus: 'manifest-and-files-declared',
      reviewStatus: 'approved',
      reviewedAt: '2026-05-25T00:00:00.000Z',
      reviewId: 'third-party-review-7',
      reviewedBy: 'fixture-registry-reviewers',
      approvedCapabilities: ['read.workspace', 'use.network'],
      metadataTrust: 'third-party-registry-reviewed',
      capabilities: ['read.workspace', 'use.network'],
      highRiskCapabilities: ['use.network'],
      installable: true,
    };
    const updateEntry = {
      id: 'community.unsafe-update',
      name: 'Registry Unsafe Update Pack',
      description: 'Unsafe update candidate should be visible but blocked.',
      latestVersion: '0.2.0',
      versionCount: 2,
      sourceRepository: 'https://github.com/example/unsafe-update',
      sourceRef: 'v0.2.0',
      manifestPath: 'orpad.node-pack.json',
      trustLevel: 'community',
      signatureStatus: 'declared',
      checksumStatus: 'mismatch',
      reviewStatus: 'approved',
      metadataTrust: 'third-party-registry-reviewed',
      capabilities: ['read.workspace'],
      installable: true,
    };
    const warningPack = () => ({
      id: warningEntry.id,
      name: warningEntry.name,
      version: warningEntry.latestVersion,
      origin: 'user-installed',
      trustLevel: 'community',
      resolutionState: 'resolved',
      validationStatus: 'valid',
      capabilities: ['read.workspace'],
      discovery: {
        rootKind: 'user',
        packDir: '/packs/community.warning-pack',
        manifestPath: '/packs/community.warning-pack/orpad.node-pack.json',
      },
      nodes: [],
    });
    const installedResponse = () => ({
      success: true,
      ok: true,
      nodePacks: [
        {
          id: updateEntry.id,
          name: updateEntry.name,
          version: '0.1.0',
          origin: 'user-installed',
          trustLevel: 'community',
          resolutionState: 'resolved',
          validationStatus: 'valid',
          capabilities: ['read.workspace'],
          discovery: {
            rootKind: 'user',
            packDir: '/packs/community.unsafe-update',
            manifestPath: '/packs/community.unsafe-update/orpad.node-pack.json',
          },
          nodes: [],
        },
        ...(warningPackInstalled ? [warningPack()] : []),
      ],
      diagnostics: [],
      conflicts: [],
    });
    const mockListNodePacks = async () => installedResponse();
    (mockListNodePacks as any).orpadTestOverride = true;
    (window as any).__orpadNodePackManagerListPacks = mockListNodePacks;
    (window as any).__orpadNodePackListPacks = mockListNodePacks;
    (window as any).__orpadNodePackRegistrySource = registrySource;
    (window as any).__orpadNodePackTrustReviewInstallCalls = installCalls;
    (window as any).__orpadNodePackTrustReviewUpdateCalls = updateCalls;
    const registryResponse = () => ({
      success: true,
      ok: true,
      registry: {
        registryId: 'orpad.trust-review',
        name: 'Trust Review Fixture Registry',
        governance: {
          registryTrust: 'community',
          reviewModel: 'third-party-reviewed',
          submissions: { type: 'pull-request', url: 'https://registry.example/trust-review/pulls' },
          reviewPolicyUrl: 'https://registry.example/trust-review/policy',
          maintainer: 'Fixture registry maintainers',
        },
        metadataTrust: 'registry-discovery-only',
      },
      source: registrySource,
      sourceKind: 'url',
      entries: [warningEntry, reviewedHighRiskEntry, blockedEntry, updateEntry],
      diagnostics: [],
    });
    (window as any).__orpadNodePackRegistryList = async () => registryResponse();
    (window as any).__orpadNodePackRegistrySearch = async () => registryResponse();
    (window as any).__orpadNodePackInstall = async ({ packId }: { packId: string }) => {
      installCalls.push(packId);
      if (packId !== warningEntry.id) {
        return { success: false, ok: false, action: 'install', error: 'unexpected install pack id', diagnostics: [] };
      }
      warningPackInstalled = true;
      return { success: true, ok: true, action: 'install', nodePack: warningPack(), diagnostics: [] };
    };
    (window as any).__orpadNodePackUpdate = async ({ packId }: { packId: string }) => {
      updateCalls.push(packId);
      return { success: false, ok: false, action: 'update', error: 'unsafe update should have been blocked before IPC', diagnostics: [] };
    };
  });
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
  await expectHeroGraphChromeAtViewport(win, 'pipeline fixture graph desktop', { width: 1280, height: 760 });
  await expectHeroGraphChromeAtViewport(win, 'pipeline fixture graph narrow', { width: 900, height: 760 });
  await win.setViewportSize({ width: 1280, height: 760 });
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

test('pipeline details surfaces missing Package diagnostics inline', async () => {
  test.setTimeout(60_000);
  const { workspace, pipelinePath } = writePipelineWorkspace();
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  pipeline.nodePacks = [
    {
      id: 'community.missing-pack',
      version: '>=9.9.0',
      origin: 'user-installed',
      trustLevel: 'community',
      capabilityRiskSummary: 'Workspace read and shell execution requested',
      highRiskCapabilities: ['read.workspace', 'run.process'],
    },
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
  await expect(nodePacksSection).toContainText('Packages');
  await expect(nodePacksSection).toContainText('community.missing-pack');
  await expect(nodePacksSection).toContainText('>=9.9.0');
  await expect(nodePacksSection).toContainText('user-installed');
  const nodePackRisk = nodePacksSection.locator('.pipeline-node-pack-risk');
  await expect(nodePackRisk).toContainText('Trust');
  await expect(nodePackRisk).toContainText('community');
  await expect(nodePackRisk).toContainText('Workspace read and shell execution requested');
  await expect(nodePackRisk).toContainText('2 high-risk capabilities');
  await expect(nodePacksSection).toContainText('PIPELINE_NODE_PACK_UNKNOWN');
  await expect(nodePacksSection.locator('.pipeline-inline-diagnostic')).toContainText('community.missing-pack');
  await expect(nodePacksSection.locator('[data-node-pack-manager-open]').first()).toContainText('Resolve in Package Manager');

  await win.locator('button[data-pipeline-mode="readwrite"]').click();
  await expect(nodePacksSection).toContainText('Packages JSON (nodePacks)');
  await expect(win.locator('[data-pipeline-json-section="nodePacks"]')).toHaveValue(/community\.missing-pack/);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Package manager opens registry candidates for a missing pipeline pack', async () => {
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
  await setNodePackMissingResolutionRegistryMock(win);

  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });
  await win.locator('.runbook-item').filter({ hasText: 'Pipeline editor fixture' }).click();
  await win.locator('#btn-preview').click();
  await win.locator('.pipeline-editor-tabs button').filter({ hasText: 'Details' }).click();

  await win.locator('.pipeline-node-packs-section [data-node-pack-manager-open]').first().click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-tab', 'browse');
  await expect(win.locator('.node-pack-manager-status')).toContainText('resolution candidate');
  const missingPack = nodePackManagerRow(win, 'Missing Pack Candidate');
  await expect(missingPack).toContainText('Fixture Author');
  const missingPackDetail = await openNodePackManagerRowDetail(win, missingPack);
  await expect(missingPackDetail).toContainText('community.missing-pack');
  await closeNodePackManagerRowDetail(win);

  const missingInstallDialog = win.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.message()).toContain('Package id: community.missing-pack');
    expect(dialog.message()).toContain('Registry source: https://registry.example/orpad-node-packs.json');
    await dialog.accept();
  });
  await missingPack.locator('[data-node-pack-manager-registry-install="community.missing-pack"]').click();
  await missingInstallDialog;
  await expect(win.locator('.node-pack-manager-status')).toContainText('Installed community.missing-pack');
  await expect(missingPack.locator('[data-node-pack-manager-registry-install="community.missing-pack"]')).toHaveText('Imported');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Package manager lists metadata and safe pack prose states', async () => {
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
  await win.setViewportSize({ width: 1200, height: 620 });
  const toolbarPlacement = await win.locator('#toolbar').evaluate((toolbar) => {
    const packageButton = toolbar.querySelector<HTMLElement>('#btn-package-manager');
    const themeButton = toolbar.querySelector<HTMLElement>('#btn-theme');
    const packageRect = packageButton?.getBoundingClientRect();
    const themeRect = themeButton?.getBoundingClientRect();
    return {
      packageVisible: !!packageRect && packageRect.width > 0 && packageRect.height > 0,
      themeVisible: !!themeRect && themeRect.width > 0 && themeRect.height > 0,
      packageLeftOfTheme: !!packageRect && !!themeRect && packageRect.right <= themeRect.left + 1,
      packageThemeGap: packageRect && themeRect ? themeRect.left - packageRect.right : null,
    };
  });
  expect(toolbarPlacement.packageVisible, 'Package Manager toolbar button should be visible').toBe(true);
  expect(toolbarPlacement.themeVisible, 'Theme toolbar button should be visible').toBe(true);
  expect(toolbarPlacement.packageLeftOfTheme, `Package Manager should sit left of Theme ${JSON.stringify(toolbarPlacement)}`).toBe(true);
  expect(toolbarPlacement.packageThemeGap, `Package Manager should stay adjacent to Theme ${JSON.stringify(toolbarPlacement)}`).not.toBeNull();
  expect(toolbarPlacement.packageThemeGap!, `Package Manager should stay adjacent to Theme ${JSON.stringify(toolbarPlacement)}`).toBeLessThanOrEqual(8);

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
        id: 'orpad.starter.frontend-ux',
        name: 'Frontend UX Starter Package',
        version: '0.1.0',
        origin: 'built-in',
        trustLevel: 'official',
        description: 'Reusable orchestration hints for renderer UI and e2e verification.',
        capabilities: ['read.workspace', 'write.runArtifacts'],
        discovery: {
          rootKind: 'built-in',
          packDir: '/app/nodes/orpad.starter.frontend-ux',
          manifestPath: '/app/nodes/orpad.starter.frontend-ux/orpad.node-pack.json',
        },
        nodes: [],
        graphs: [
          {
            id: 'frontend-ux-workstream',
            path: 'graphs/frontend-ux-workstream.or-graph',
            role: 'reusable',
            description: 'Discovery and verification lens for UI workflows.',
          },
        ],
        skills: [
          {
            id: 'frontend-ux-audit',
            path: 'skills/frontend-ux-audit.md',
            description: 'Guides UI state, layout, interaction, accessibility, screenshot, and e2e evidence.',
          },
        ],
        rules: [
          {
            id: 'frontend-ux-scope',
            path: 'rules/frontend-ux-scope.or-rule',
            description: 'Includes renderer UI, styles, Playwright/e2e tests, and browser-facing assets.',
          },
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
            message: 'Community Package requests high-risk authority without approved review.',
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

  await win.locator('#btn-package-manager').click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Package Manager');
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'loading');
  await expect(win.locator('.node-pack-manager-status')).toContainText('Loading installed packages');
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'success');
  const corePack = nodePackManagerRow(win, 'OrPAD Core Nodes');
  await expect(corePack).toContainText('built-in');
  await expect(corePack.locator('[data-node-pack-manager-detail-open]')).toHaveText('Detail');
  await expect(corePack.locator('[data-node-pack-manager-pack-import="orpad.core"]')).toHaveText('Import');
  const corePackTrust = corePack.locator('[data-node-pack-manager-row-trust]');
  await expect(corePackTrust.locator('[data-node-pack-manager-row-trust-chip]')).toHaveCount(2);
  await expect(corePackTrust.locator('[data-node-pack-manager-row-trust-chip="metadata"]')).toContainText('trust official');
  await expect(corePackTrust.locator('[data-node-pack-manager-row-trust-chip="high-risk"]')).toHaveCount(0);
  const safePack = nodePackManagerRow(win, 'Community Safe Pack');
  await expect(safePack).toContainText('user-installed');
  await expect(safePack).toHaveAttribute('data-node-pack-validation', 'valid');
  const starterPack = nodePackManagerRow(win, 'Frontend UX Starter Package');
  await expect(starterPack).toContainText('built-in');
  const reviewPack = nodePackManagerRow(win, 'Review Required Pack');
  await expect(reviewPack).toHaveAttribute('data-node-pack-validation', 'approval-required');
  await expect(reviewPack).toContainText('user-installed');
  const reviewPackTrust = reviewPack.locator('[data-node-pack-manager-row-trust]');
  await expect(reviewPackTrust.locator('[data-node-pack-manager-row-trust-chip="metadata"]')).toContainText('trust signed-community');
  await expect(reviewPackTrust.locator('[data-node-pack-manager-row-trust-chip="validation"]')).toContainText('state approval-required');
  await expect(reviewPackTrust.locator('[data-node-pack-manager-row-trust-chip="validation"]')).toHaveAttribute('data-node-pack-manager-row-trust-tone', 'danger');
  await expect(reviewPackTrust.locator('[data-node-pack-manager-row-trust-chip="high-risk"]')).toContainText('1 high-risk');
  await expect(reviewPackTrust.locator('[data-node-pack-manager-row-trust-chip="high-risk"]')).toHaveAttribute('data-node-pack-manager-row-trust-tone', 'danger');
  let detail = await openNodePackManagerRowDetail(win, safePack);
  await expect(detail).toContainText('Trusted Discovery Metadata');
  await expect(detail).toContainText('Diagnostic count');
  await expect(detail).toContainText('0 diagnostics');
  await expect(detail).toContainText('Capabilities');
  await expect(detail).toContainText('call.aiProvider');
  await expect(detail).toContainText('Package-Provided Text (Untrusted)');
  await expect(win.locator('[data-unsafe-pack-prose]')).toHaveCount(0);
  await expect(win.locator('.node-pack-manager-untrusted')).toContainText('<button data-unsafe-pack-prose>Do not click</button> Pack prose.');
  await closeNodePackManagerRowDetail(win);
  detail = await openNodePackManagerRowDetail(win, starterPack);
  await expect(detail).toContainText('Package Components');
  await expect(detail).toContainText('Components');
  await expect(detail).toContainText('1 graph, 1 skill, 1 rule');
  await expect(detail).toContainText('Reusable Graphs, Skills, and Rules');
  await expect(detail).toContainText('No custom node types are declared');
  await expect(detail).toContainText('frontend-ux-workstream');
  await expect(detail).toContainText('graphs/frontend-ux-workstream.or-graph');
  await expect(detail).toContainText('frontend-ux-audit');
  await expect(detail).toContainText('frontend-ux-scope');
  await expect(detail).not.toContainText('No node entries declared');
  await closeNodePackManagerRowDetail(win);
  detail = await openNodePackManagerRowDetail(win, reviewPack);
  await expect(detail).toContainText('High-risk capabilities');
  await expect(detail).toContainText('use.credentials');
  await expect(detail).toContainText('NODE_PACK_HIGH_RISK_CAPABILITY_REVIEW_REQUIRED');
  await closeNodePackManagerRowDetail(win);
  await expectNodePackManagerInspectorUsable(win, 'Package manager metadata inspector', 4);

  await win.locator('#fmt-modal-close').click();
  await setNodePackManagerMock(win, { success: true, ok: true, nodePacks: [], diagnostics: [], conflicts: [] });
  await win.locator('#btn-package-manager').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'empty');
  await expect(win.locator('.node-pack-manager')).toContainText('No packages are installed.');

  await win.locator('#fmt-modal-close').click();
  await setNodePackManagerMock(win, { success: false, ok: false, error: 'fixture discovery failure' });
  await win.locator('#btn-package-manager').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'error');
  await expect(win.locator('.node-pack-manager-error')).toContainText('fixture discovery failure');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Package manager browses registry entries and installs through the manager action', async () => {
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
  await setNodePackRegistryInstallMock(win);

  await win.locator('[data-node-pack-manager-open]').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'empty');
  await win.locator('[data-node-pack-manager-tab="browse"]').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-tab', 'browse');
  await win.locator('[data-node-pack-manager-registry-load]').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'success');
  await expect(win.locator('.node-pack-manager')).toContainText('Fixture Registry');
  const registryPack = nodePackManagerRow(win, 'Registry Community Pack');
  await expect(registryPack).toContainText('Fixture Author');
  await expect(registryPack).toHaveAttribute('data-node-pack-validation', 'available');
  const registryDetail = await openNodePackManagerRowDetail(win, registryPack);
  await expect(registryDetail).toContainText('Registry Metadata');
  await expect(registryDetail).toContainText('Registry metadata is discovery input, not trust evidence.');
  await expect(registryDetail).toContainText('<strong>Registry prose stays text.</strong>');
  await expect(registryDetail.locator('strong')).toHaveCount(0);
  await closeNodePackManagerRowDetail(win);

  const registryInstallDialog = win.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.message()).toContain('Package id: community.registry-pack');
    expect(dialog.message()).toContain('Version: 0.1.0');
    expect(dialog.message()).toContain('Registry source: https://registry.example/orpad-node-packs.json');
    await dialog.accept();
  });
  await registryPack.locator('[data-node-pack-manager-registry-install="community.registry-pack"]').click();
  await registryInstallDialog;
  await expect(win.locator('.node-pack-manager-status')).toContainText('Installed community.registry-pack');
  await expect(registryPack.locator('[data-node-pack-manager-registry-install="community.registry-pack"]')).toHaveText('Imported');
  await win.locator('[data-node-pack-manager-tab="installed"]').click();
  await expect(win.locator('.node-pack-manager')).toContainText('Registry Community Pack');
  await expect(nodePackManagerRow(win, 'Registry Community Pack')).toContainText('user-installed');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Package manager manages registry source defaults recents and offline cache state', async () => {
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
  await setNodePackRegistrySourceManagementMock(win);

  await win.locator('[data-node-pack-manager-open]').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'success');
  await win.locator('[data-node-pack-manager-tab="browse"]').click();
  await expect(win.locator('[data-node-pack-manager-registry-source-select]')).toContainText('Default OrPAD Registry');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('Default OrPAD Registry');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('https://registry.example/default.json');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('Registry metadata is discovery input, not trust evidence.');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('Registry signature');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('missing / not attempted');

  await win.locator('[data-node-pack-manager-registry-load]').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'success');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('Default Fixture Registry');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('loaded');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('official PR-reviewed');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('OrPAD official review');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('signature verified');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('orpad-registry-test-key');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('SHA256:default-registry-fixture');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('https://github.com/orpad/registry/pulls');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('https://orpad.dev/docs/package-registry-review');

  await win.locator('[data-node-pack-manager-registry-source]').fill('https://registry.example/custom.json');
  await win.locator('[data-node-pack-manager-registry-load]').click();
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('Cached Custom Fixture Registry');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('custom registry');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('Discovery metadata only');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('https://registry.example/custom/pulls');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('https://registry.example/custom/review-policy');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('Recent Registry source');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('offline cache');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('fromCache');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('missing / not attempted');
  await expect(win.locator('.node-pack-manager-diagnostics')).toContainText('NODE_PACK_REGISTRY_SOURCE_FAILED_CACHE_USED');
  await expect(win.locator('[data-node-pack-manager-registry-source-select]')).toContainText('Recent Registry source');
  await expect(win.locator('[data-node-pack-manager-registry-source-select]')).toContainText('https://registry.example/custom.json');

  await win.locator('[data-node-pack-manager-tab="updates"]').click();
  await expect(win.locator('.node-pack-manager-status')).toContainText('1 update candidate');
  await expect(win.locator('.node-pack-manager-status')).toContainText('Against Recent Registry source.');
  await expect(win.locator('.node-pack-manager-status')).toContainText('https://registry.example/custom.json');
  await expect(win.locator('.node-pack-manager-status')).toContainText('offline cache');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Package manager blocks non-HTTPS registry source before browsing', async () => {
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
  await setNodePackRegistrySourceManagementMock(win);

  await win.locator('[data-node-pack-manager-open]').click();
  await win.locator('[data-node-pack-manager-tab="browse"]').click();
  await win.locator('[data-node-pack-manager-registry-source]').fill('http://registry.example/insecure.json');
  await win.locator('[data-node-pack-manager-registry-load]').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'error');
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('blocked source');
  await expect(win.locator('.node-pack-manager-error')).toContainText('Registry source must use HTTPS.');
  await expect(win.locator('.node-pack-manager-diagnostics')).toContainText('NODE_PACK_REGISTRY_SOURCE_BLOCKED');
  const registryCallCount = await win.evaluate(() => ((window as any).__orpadNodePackRegistryCalls || []).length);
  expect(registryCallCount).toBe(0);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Package manager shows registry trust review warnings and blocks unsafe package actions', async () => {
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
  await setNodePackRegistryTrustReviewMock(win);

  await win.locator('[data-node-pack-manager-open]').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'success');
  await win.locator('[data-node-pack-manager-tab="browse"]').click();
  await win.locator('[data-node-pack-manager-registry-load]').click();
  await expect(win.locator('.node-pack-manager')).toContainText('Trust Review Fixture Registry');

  const warningPack = nodePackManagerRow(win, 'Registry Warning Pack');
  await expect(warningPack.locator('[data-node-pack-manager-registry-install="community.warning-pack"]')).toBeEnabled();
  const warningPackTrust = warningPack.locator('[data-node-pack-manager-row-trust]');
  await expect(warningPackTrust.locator('[data-node-pack-manager-row-trust-chip="signature"]')).toContainText('sig missing');
  await expect(warningPackTrust.locator('[data-node-pack-manager-row-trust-chip="checksum"]')).toContainText('hash missing');
  await expect(warningPackTrust.locator('[data-node-pack-manager-row-trust-chip="review"]')).toContainText('review unreviewed');
  await expect(warningPackTrust.locator('[data-node-pack-manager-row-trust-chip="metadata"]')).toHaveAttribute('data-node-pack-manager-row-trust-tone', 'warn');
  let detail = await openNodePackManagerRowDetail(win, warningPack);
  await expect(detail).toContainText('Package Risk Review');
  await expect(detail).toContainText('NODE_PACK_REGISTRY_SIGNATURE_MISSING');
  await expect(detail).toContainText('NODE_PACK_REGISTRY_CHECKSUM_MISSING');
  await expect(detail).toContainText('NODE_PACK_REGISTRY_REVIEW_MISSING');
  await closeNodePackManagerRowDetail(win);

  const reviewedHighRiskPack = nodePackManagerRow(win, 'Registry Reviewed High Risk Pack');
  await expect(reviewedHighRiskPack.locator('[data-node-pack-manager-registry-install="community.reviewed-high-risk"]')).toBeEnabled();
  const reviewedHighRiskTrust = reviewedHighRiskPack.locator('[data-node-pack-manager-row-trust]');
  await expect(reviewedHighRiskTrust.locator('[data-node-pack-manager-row-trust-chip="metadata"]')).toContainText('trust third-party');
  await expect(reviewedHighRiskTrust.locator('[data-node-pack-manager-row-trust-chip="high-risk"]')).toContainText('1 high-risk');
  await expect(reviewedHighRiskTrust.locator('[data-node-pack-manager-row-trust-chip="high-risk"]')).toHaveAttribute('data-node-pack-manager-row-trust-tone', 'warn');
  detail = await openNodePackManagerRowDetail(win, reviewedHighRiskPack);
  await expect(detail).toContainText('Third-party review');
  await expect(detail).toContainText('third-party-review-7');
  await expect(detail).toContainText('NODE_PACK_REGISTRY_THIRD_PARTY_REVIEW');
  await expect(detail).toContainText('NODE_PACK_REGISTRY_HIGH_RISK_CAPABILITY_DECLARED');
  await expect(detail).toContainText('use.network');
  await closeNodePackManagerRowDetail(win);

  const unsafePack = nodePackManagerRow(win, 'Registry Unsafe Pack');
  await expect(unsafePack).toHaveAttribute('data-node-pack-validation', 'blocked');
  const unsafePackTrust = unsafePack.locator('[data-node-pack-manager-row-trust]');
  await expect(unsafePackTrust.locator('[data-node-pack-manager-row-trust-chip="checksum"]')).toContainText('hash mismatch');
  await expect(unsafePackTrust.locator('[data-node-pack-manager-row-trust-chip="checksum"]')).toHaveAttribute('data-node-pack-manager-row-trust-tone', 'danger');
  await expect(unsafePackTrust.locator('[data-node-pack-manager-row-trust-chip="high-risk"]')).toContainText('1 high-risk');
  await expect(unsafePackTrust.locator('[data-node-pack-manager-row-trust-chip="high-risk"]')).toHaveAttribute('data-node-pack-manager-row-trust-tone', 'danger');
  detail = await openNodePackManagerRowDetail(win, unsafePack);
  await expect(detail).toContainText('NODE_PACK_REGISTRY_CHECKSUM_UNSAFE');
  await expect(detail).toContainText('NODE_PACK_REGISTRY_HIGH_RISK_REVIEW_REQUIRED');
  await closeNodePackManagerRowDetail(win);
  const unsafeImport = unsafePack.locator('[data-node-pack-manager-registry-install="community.unsafe-pack"]');
  await expect(unsafeImport).toBeDisabled();
  await expect(unsafeImport).toHaveText('Import blocked');
  await expect(unsafeImport).toHaveAttribute('title', /checksum status blocks/);

  await win.locator('[data-node-pack-manager-tab="updates"]').click();
  const unsafeUpdate = nodePackManagerRow(win, 'Registry Unsafe Update Pack');
  await expect(unsafeUpdate).toHaveAttribute('data-node-pack-validation', 'update-blocked');
  const unsafeUpdateTrust = unsafeUpdate.locator('[data-node-pack-manager-row-trust]');
  await expect(unsafeUpdateTrust.locator('[data-node-pack-manager-row-trust-chip="checksum"]')).toContainText('hash mismatch');
  await expect(unsafeUpdateTrust.locator('[data-node-pack-manager-row-trust-chip="metadata"]')).toContainText('trust third-party');
  detail = await openNodePackManagerRowDetail(win, unsafeUpdate);
  await expect(detail).toContainText('Package Risk Review');
  await expect(detail).toContainText('NODE_PACK_REGISTRY_CHECKSUM_UNSAFE');
  await closeNodePackManagerRowDetail(win);
  await expect(unsafeUpdate.locator('[data-node-pack-manager-registry-update="community.unsafe-update"]')).toBeDisabled();
  await expect(unsafeUpdate.locator('[data-node-pack-manager-registry-update="community.unsafe-update"]')).toHaveText('Update blocked');
  await win.locator('[data-node-pack-manager-tab="browse"]').click();
  const warningInstallDialog = win.waitForEvent('dialog').then(async (dialog) => {
    const message = dialog.message();
    expect(message).toContain('Package id: community.warning-pack');
    expect(message).toContain('Version: 0.1.0');
    expect(message).toContain('Registry source: https://registry.example/trust-review.json');
    expect(message).toContain('NODE_PACK_REGISTRY_SIGNATURE_MISSING');
    expect(message).toContain('Registry metadata is discovery input, not trust evidence.');
    await dialog.accept();
  });
  await warningPack.locator('[data-node-pack-manager-registry-install="community.warning-pack"]').click();
  await warningInstallDialog;
  await expect(win.locator('.node-pack-manager-status')).toContainText('Installed community.warning-pack');
  const callCounts = await win.evaluate(() => ({
    installs: ((window as any).__orpadNodePackTrustReviewInstallCalls || []).slice(),
    updates: ((window as any).__orpadNodePackTrustReviewUpdateCalls || []).slice(),
  }));
  expect(callCounts.installs).toEqual(['community.warning-pack']);
  expect(callCounts.updates).toEqual([]);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Package manager applies an available registry update from the updates tab', async () => {
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
  await setNodePackRegistryUpdateMock(win);

  await win.locator('[data-node-pack-manager-open]').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'success');
  await win.locator('[data-node-pack-manager-tab="browse"]').click();
  await win.locator('[data-node-pack-manager-registry-load]').click();
  await expect(win.locator('.node-pack-manager')).toContainText('Registry Update Pack');
  await win.locator('[data-node-pack-manager-tab="updates"]').click();
  await expect(win.locator('.node-pack-manager-status')).toContainText('1 update candidate');
  const updatePack = nodePackManagerRow(win, 'Registry Update Pack');
  const updateDetail = await openNodePackManagerRowDetail(win, updatePack);
  await expect(updateDetail).toContainText('Installed version');
  await expect(updateDetail).toContainText('0.1.0');
  await expect(updateDetail).toContainText('0.2.0');
  await closeNodePackManagerRowDetail(win);
  const registryUpdateDialog = win.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.message()).toContain('Package id: community.update-pack');
    expect(dialog.message()).toContain('Version: 0.2.0');
    expect(dialog.message()).toContain('Registry source: https://registry.example/orpad-node-packs.json');
    await dialog.accept();
  });
  await expect(updatePack.locator('[data-node-pack-manager-registry-update="community.update-pack"]')).toHaveText('Update');
  await updatePack.locator('[data-node-pack-manager-registry-update="community.update-pack"]').click();
  await registryUpdateDialog;
  await win.locator('[data-node-pack-manager-tab="installed"]').click();
  const installedUpdateDetail = await openNodePackManagerRowDetail(win, nodePackManagerRow(win, 'Registry Update Pack'));
  await expect(installedUpdateDetail).toContainText('0.2.0');
  await closeNodePackManagerRowDetail(win);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Package manager shows workspace lock drift and syncs registry update metadata', async () => {
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
  await setNodePackWorkspaceLockMock(win);

  await win.locator('[data-node-pack-manager-open]').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'success');
  await expect(win.locator('[data-node-pack-manager-workspace-lock-panel]')).toContainText('/workspace/.orpad/orpad-node-packs.lock.json');
  await expect(win.locator('[data-node-pack-manager-workspace-lock-panel]')).toContainText('It is not trust evidence.');
  const lockedPack = nodePackManagerRow(win, 'Workspace Locked Pack');
  await expect(win.locator('.node-pack-manager-status')).toContainText('workspace drift');
  let detail = await openNodePackManagerRowDetail(win, lockedPack);
  await expect(detail).toContainText('Workspace Lock');
  await expect(detail).toContainText('Workspace lock expects 0.2.0; installed package is 0.1.0.');
  await closeNodePackManagerRowDetail(win);

  await win.locator('[data-node-pack-manager-tab="browse"]').click();
  await win.locator('[data-node-pack-manager-registry-source]').fill('https://registry.example/workspace-lock.json');
  await win.locator('[data-node-pack-manager-registry-load]').click();
  await expect(win.locator('[data-node-pack-manager-registry-source-panel]')).toContainText('Workspace Lock Fixture Registry');
  const unsafePack = nodePackManagerRow(win, 'Workspace Lock Unsafe Pack');
  await expect(unsafePack).toHaveAttribute('data-node-pack-validation', 'blocked');
  await expect(unsafePack.locator('[data-node-pack-manager-registry-install="community.locked-unsafe"]')).toBeDisabled();
  detail = await openNodePackManagerRowDetail(win, unsafePack);
  await expect(detail).toContainText('A workspace lock match only records reproducible metadata');
  await closeNodePackManagerRowDetail(win);

  await win.locator('[data-node-pack-manager-tab="updates"]').click();
  await expect(win.locator('.node-pack-manager-status')).toContainText('1 update candidate');
  const updateDialog = win.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.message()).toContain('Package id: community.locked-pack');
    expect(dialog.message()).toContain('Registry source: https://registry.example/workspace-lock.json');
    await dialog.accept();
  });
  await nodePackManagerRow(win, 'Workspace Locked Pack').locator('[data-node-pack-manager-registry-update="community.locked-pack"]').click();
  await updateDialog;
  await win.locator('[data-node-pack-manager-tab="installed"]').click();
  const syncedLockedPack = nodePackManagerRow(win, 'Workspace Locked Pack');
  detail = await openNodePackManagerRowDetail(win, syncedLockedPack);
  await expect(detail).toContainText('Workspace lock version 0.2.0.');
  await closeNodePackManagerRowDetail(win);

  await win.locator('[data-node-pack-manager-export-workspace-lock]').click();
  const exportModal = win.locator('.node-pack-manager-detail-modal');
  await expect(exportModal).toContainText('Exported Workspace Lock Summary');
  await expect(exportModal).toContainText('community.locked-pack');
  await expect(exportModal).toContainText('https://registry.example/workspace-lock.json');
  await expect(exportModal).toContainText('registry-discovery-only');
  const upserts = await win.evaluate(() => ((window as any).__orpadNodePackWorkspaceLockUpserts || []).map((entry: any) => ({
    id: entry.id,
    version: entry.version,
    registrySource: entry.registrySource,
    metadataTrust: entry.metadataTrust,
  })));
  expect(upserts).toContainEqual({
    id: 'community.locked-pack',
    version: '0.2.0',
    registrySource: 'https://registry.example/workspace-lock.json',
    metadataTrust: 'registry-discovery-only',
  });

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Package manager dry-runs workspace lock apply before package install', async () => {
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
  await setNodePackWorkspaceLockMock(win);

  await win.locator('[data-node-pack-manager-open]').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'success');
  await win.locator('[data-node-pack-manager-tab="workspace"]').click();
  await expect(win.locator('.node-pack-manager-status')).toContainText('dry-run required');
  await win.locator('[data-node-pack-manager-workspace-dry-run]').click();
  await expect(win.locator('.node-pack-manager-status')).toContainText('ready');
  await expect(win.locator('.node-pack-manager-status')).toContainText('2 missing');
  await expect(win.locator('.node-pack-manager-status')).toContainText('1 drift');
  await expect(win.locator('.node-pack-manager-status')).toContainText('1 blocked');

  const driftLocked = nodePackManagerRow(win, 'Workspace Locked Pack');
  await expect(driftLocked).toHaveAttribute('data-node-pack-validation', 'ready to update');
  await expect(driftLocked.locator('[data-node-pack-manager-workspace-apply]')).toHaveText('Update');
  const updateDialog = win.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.message()).toContain('Package id: community.locked-pack');
    expect(dialog.message()).toContain('Version: 0.2.0');
    expect(dialog.message()).toContain('Registry source: https://registry.example/workspace-lock.json');
    await dialog.accept();
  });
  await driftLocked.locator('[data-node-pack-manager-workspace-apply]').click();
  await updateDialog;
  await expect(win.locator('.node-pack-manager-action-notice')).toContainText('Updated Package');
  const syncedLockedPack = nodePackManagerRow(win, 'community.locked-pack');
  await expect(syncedLockedPack).toHaveAttribute('data-node-pack-validation', 'synced');
  await expect(syncedLockedPack.locator('[data-node-pack-manager-workspace-apply]')).toBeDisabled();
  await expect(syncedLockedPack.locator('[data-node-pack-manager-workspace-apply]')).toHaveText('Imported');

  const unsafeLocked = nodePackManagerRow(win, 'Workspace Lock Unsafe Pack');
  await expect(unsafeLocked).toHaveAttribute('data-node-pack-validation', 'blocked');
  const unsafeDetail = await openNodePackManagerRowDetail(win, unsafeLocked);
  await expect(unsafeDetail).toContainText('Package checksum status blocks install and update.');
  await closeNodePackManagerRowDetail(win);
  await expect(unsafeLocked.locator('[data-node-pack-manager-workspace-apply]')).toBeDisabled();
  await expect(unsafeLocked.locator('[data-node-pack-manager-workspace-apply]')).toHaveText('Install blocked');

  const missingLocked = nodePackManagerRow(win, 'Workspace Lock Missing Candidate');
  await expect(missingLocked).toHaveAttribute('data-node-pack-validation', 'ready to install');
  const missingDetail = await openNodePackManagerRowDetail(win, missingLocked);
  await expect(missingDetail).toContainText('Dry-Run Registry Match');
  await expect(missingDetail).toContainText('Registry metadata is discovery input, not trust evidence.');
  await closeNodePackManagerRowDetail(win);
  await expect(missingLocked.locator('[data-node-pack-manager-workspace-apply]')).toHaveText('Install');

  const applyDialog = win.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.message()).toContain('Package id: community.missing-pack');
    expect(dialog.message()).toContain('Version: 9.9.1');
    expect(dialog.message()).toContain('Registry source: https://registry.example/workspace-lock.json');
    expect(dialog.message()).toContain('Registry metadata is discovery input, not trust evidence.');
    await dialog.accept();
  });
  await missingLocked.locator('[data-node-pack-manager-workspace-apply]').click();
  await applyDialog;
  await expect(win.locator('.node-pack-manager-action-notice')).toContainText('Installed Package');
  await expect(nodePackManagerRow(win, 'community.missing-pack')).toHaveAttribute('data-node-pack-validation', 'synced');

  const installRequests = await win.evaluate(() => ((window as any).__orpadNodePackInstallRequests || []).map((request: any) => ({
    packId: request.packId,
    version: request.version,
    registry: request.registry,
  })));
  expect(installRequests).toContainEqual({
    packId: 'community.locked-pack',
    version: '0.2.0',
    registry: 'https://registry.example/workspace-lock.json',
  });
  expect(installRequests).toContainEqual({
    packId: 'community.missing-pack',
    version: '9.9.1',
    registry: 'https://registry.example/workspace-lock.json',
  });
  const workspaceLockUpserts = await win.evaluate(() => ((window as any).__orpadNodePackWorkspaceLockUpserts || []).slice());
  expect(workspaceLockUpserts).toEqual([]);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Package manager prefers workspace lock registry source for missing package resolution', async () => {
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
  await setNodePackWorkspaceLockMock(win);

  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });
  await win.locator('.runbook-item').filter({ hasText: 'Pipeline editor fixture' }).click();
  await win.locator('#btn-preview').click();
  await win.locator('.pipeline-editor-tabs button').filter({ hasText: 'Details' }).click();

  await win.locator('.pipeline-node-packs-section [data-node-pack-manager-open]').first().click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-tab', 'browse');
  await expect(win.locator('.node-pack-manager-status')).toContainText('workspace lock source');
  await expect(win.locator('[data-node-pack-manager-workspace-lock-panel]')).toContainText('community.missing-pack -> https://registry.example/workspace-lock.json');
  const missingCandidate = nodePackManagerRow(win, 'Workspace Lock Missing Candidate');
  await expect(missingCandidate).toContainText('https://github.com/example/workspace-missing-pack');
  const missingCandidateDetail = await openNodePackManagerRowDetail(win, missingCandidate);
  await expect(missingCandidateDetail).toContainText('community.missing-pack');
  await closeNodePackManagerRowDetail(win);
  const registryCalls = await win.evaluate(() => ((window as any).__orpadNodePackRegistryCalls || []).slice());
  expect(registryCalls[0]).toBe('https://registry.example/workspace-lock.json');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Package manager exposes installed lifecycle export rollback and remove actions', async () => {
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
  await setNodePackInstalledLifecycleMock(win);

  await win.locator('[data-node-pack-manager-open]').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'success');
  const lifecyclePack = nodePackManagerRow(win, 'Lifecycle Package');
  await expect(lifecyclePack).toContainText('user-installed');
  let lifecycleDetail = await openNodePackManagerRowDetail(win, lifecyclePack);
  await expect(lifecycleDetail).toContainText('Installed Lifecycle');
  await expect(lifecycleDetail).toContainText('Rollback');
  await expect(lifecycleDetail).toContainText('Available to 0.1.0');
  await expect(lifecycleDetail.locator('[data-node-pack-manager-action="rollback"]')).toBeEnabled();
  await closeNodePackManagerRowDetail(win);

  await win.locator('[data-node-pack-manager-export-list]').click();
  const exportModal = win.locator('.node-pack-manager-detail-modal');
  await expect(exportModal).toContainText('Exported Installed List');
  await expect(exportModal).toContainText('community.lifecycle-pack');
  await expect(exportModal).toContainText('/userData/nodes/orpad-node-packs.lock.json');
  await closeNodePackManagerRowDetail(win);
  await expectNodePackManagerInspectorUsable(win, 'Package manager installed lifecycle inspector', 1);

  lifecycleDetail = await openNodePackManagerRowDetail(win, lifecyclePack);
  const rollbackDialog = win.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.message()).toContain('Rollback package "Lifecycle Package"?');
    await dialog.accept();
  });
  await lifecycleDetail.locator('[data-node-pack-manager-action="rollback"]').click();
  await rollbackDialog;
  await expect(win.locator('.node-pack-manager-action-notice')).toContainText('Rolled Back Package');
  await expect(win.locator('.node-pack-manager-action-notice')).toContainText('NODE_PACK_ROLLBACK_RESTORED_BACKUP');
  lifecycleDetail = await openNodePackManagerRowDetail(win, lifecyclePack);
  await expect(lifecycleDetail).toContainText('Available to 0.2.0');

  const removeDialog = win.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.message()).toContain('Remove package "Lifecycle Package"?');
    await dialog.accept();
  });
  await lifecycleDetail.locator('[data-node-pack-manager-action="remove"]').click();
  await removeDialog;
  await expect(win.locator('.node-pack-manager-action-notice')).toContainText('Removed Package');
  await expect(win.locator('.node-pack-manager-action-notice')).toContainText('moved to backup');
  await expect(win.locator('.node-pack-manager')).toContainText('No packages are installed.');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Package manager keeps update candidates visible when a registry update fails', async () => {
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
  await setNodePackRegistryUpdateFailureMock(win);

  await win.locator('[data-node-pack-manager-open]').click();
  await win.locator('[data-node-pack-manager-tab="browse"]').click();
  await win.locator('[data-node-pack-manager-registry-load]').click();
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'success');
  await win.locator('[data-node-pack-manager-tab="updates"]').click();
  await expect(win.locator('.node-pack-manager-status')).toContainText('1 update candidate');
  const updateFailurePack = nodePackManagerRow(win, 'Registry Update Failure Pack');
  const registryUpdateFailureDialog = win.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.message()).toContain('Package id: community.update-failure');
    expect(dialog.message()).toContain('Version: 0.2.0');
    expect(dialog.message()).toContain('Registry source: https://registry.example/orpad-node-packs.json');
    await dialog.accept();
  });
  await updateFailurePack.locator('[data-node-pack-manager-registry-update="community.update-failure"]').click();
  await registryUpdateFailureDialog;
  await expect(win.locator('.node-pack-manager-action-notice')).toContainText('Update Failed');
  await expect(win.locator('.node-pack-manager-action-notice')).toContainText('active package');
  await expect(win.locator('.node-pack-manager-action-notice')).toContainText('NODE_PACK_INSTALL_DECLARED_FILE_CHECKSUM_MISMATCH');
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-tab', 'updates');
  await expect(win.locator('.node-pack-manager')).toHaveAttribute('data-node-pack-manager-state', 'success');
  const updateFailureDetail = await openNodePackManagerRowDetail(win, updateFailurePack);
  await expect(updateFailureDetail).toContainText('0.1.0');
  await expect(updateFailureDetail).toContainText('0.2.0');
  await closeNodePackManagerRowDetail(win);
  await win.locator('[data-node-pack-manager-tab="installed"]').click();
  const installedFailureDetail = await openNodePackManagerRowDetail(win, nodePackManagerRow(win, 'Registry Update Failure Pack'));
  await expect(installedFailureDetail).toContainText('0.1.0');
  await closeNodePackManagerRowDetail(win);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Package manager surfaces discovery diagnostics and conflicts', async () => {
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
  await win.setViewportSize({ width: 820, height: 620 });

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
            message: 'Package version is required.',
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
        message: 'Package root could not be read.',
        rootKind: 'user',
        root: '/bad/nodes',
        error: 'EACCES: permission denied',
      },
      {
        level: 'warning',
        code: 'NODE_PACK_DISCOVERY_MANIFEST_INVALID',
        message: 'Package manifest could not be parsed.',
        rootKind: 'user',
        manifestPath: '/packs/broken/orpad.node-pack.json',
        error: 'Unexpected token } in JSON',
      },
      {
        level: 'warning',
        code: 'NODE_PACK_DISCOVERY_VALIDATION_FAILED',
        message: 'Discovered Package is not launch-compatible.',
        packId: 'community.alpha',
        manifestPath: '/packs/community.alpha/orpad.node-pack.json',
        packDiagnostics: [
          {
            level: 'error',
            code: 'NODE_PACK_VERSION_MISSING',
            message: 'Package version is required.',
            packId: 'community.alpha',
          },
        ],
      },
      {
        level: 'warning',
        code: 'NODE_PACK_DISCOVERY_DUPLICATE_ID',
        message: 'Duplicate Package id discovered; deterministic load keeps the first pack and skips later duplicates.',
        packId: 'community.alpha',
        keptManifestPath: '/packs/community.alpha/orpad.node-pack.json',
        skippedManifestPath: '/packs/community.alpha-copy/orpad.node-pack.json',
      },
      {
        level: 'warning',
        code: 'NODE_PACK_TYPE_CONFLICT',
        message: 'Multiple packages declare the same node type; user selection is required before activation.',
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
  const rootSummary = win.locator('.node-pack-manager-root-summary');
  await expect(rootSummary).toContainText('Discovery roots');
  await expect(rootSummary).toContainText('built-in');
  await expect(rootSummary).toContainText('/app/nodes');
  await expect(rootSummary).toContainText('user');
  await expect(rootSummary).toContainText('/bad/nodes');
  await expect(win.locator('.node-pack-manager-diagnostics .node-pack-manager-roots')).toHaveCount(0);
  await expect(diagnostics).not.toContainText('Discovery roots');
  const rootSummaryLayout = await win.locator('.node-pack-manager').evaluate((manager) => {
    const tabs = [...manager.querySelectorAll<HTMLElement>('[data-node-pack-manager-tab]')];
    const lastTab = tabs[tabs.length - 1] || null;
    const summary = manager.querySelector<HTMLElement>('.node-pack-manager-root-summary');
    const label = manager.querySelector<HTMLElement>('.node-pack-manager-root-summary-label');
    const chips = [...manager.querySelectorAll<HTMLElement>('.node-pack-manager-root-chip')];
    const managerRect = manager.getBoundingClientRect();
    const lastTabRect = lastTab?.getBoundingClientRect();
    const summaryRect = summary?.getBoundingClientRect();
    const labelRect = label?.getBoundingClientRect();
    const chipRects = chips.map(chip => chip.getBoundingClientRect());
    const chipWidths = chips.map(chip => chip.getBoundingClientRect().width);
    const tolerance = 2;
    return {
      anchoredAfterLastTab: !!lastTabRect && !!summaryRect && summaryRect.left <= lastTabRect.right + 12,
      stretchesToManagerRight: !!summaryRect && summaryRect.right >= managerRect.right - tolerance,
      labelSharesFirstRootLine: !!labelRect && chipRects.length > 0
        && chipRects[0].top <= labelRect.bottom + tolerance
        && chipRects[0].bottom >= labelRect.top - tolerance,
      rootChipsStacked: chipRects.length > 1
        ? chipRects.slice(1).every((rect, index) => rect.top >= chipRects[index].bottom - tolerance)
        : true,
      minChipWidth: chipWidths.length ? Math.min(...chipWidths) : 0,
    };
  });
  expect(rootSummaryLayout.anchoredAfterLastTab, `Discovery roots should start next to the final Package Manager tab ${JSON.stringify(rootSummaryLayout)}`).toBe(true);
  expect(rootSummaryLayout.stretchesToManagerRight, `Discovery roots should fill the row to the right edge ${JSON.stringify(rootSummaryLayout)}`).toBe(true);
  expect(rootSummaryLayout.labelSharesFirstRootLine, `Discovery roots label should stay on the first root line ${JSON.stringify(rootSummaryLayout)}`).toBe(true);
  expect(rootSummaryLayout.rootChipsStacked, `Discovery root paths should render on separate lines ${JSON.stringify(rootSummaryLayout)}`).toBe(true);
  expect(rootSummaryLayout.minChipWidth, `Discovery root chips should have room for path text ${JSON.stringify(rootSummaryLayout)}`).toBeGreaterThanOrEqual(140);
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
  await expect(alphaPack).toHaveAttribute('data-node-pack-validation', 'conflict');
  let detail = await openNodePackManagerRowDetail(win, alphaPack);
  await expect(detail.locator('.node-pack-manager-detail-header.has-conflict')).toBeVisible();
  await expect(detail).toContainText('Conflict state');
  await expect(detail).toContainText('NODE_PACK_DISCOVERY_VALIDATION_FAILED');
  await expect(detail).toContainText('NODE_PACK_DISCOVERY_DUPLICATE_ID');
  await expect(detail).toContainText('NODE_PACK_TYPE_CONFLICT');
  await closeNodePackManagerRowDetail(win);

  detail = await openNodePackManagerRowDetail(win, win.locator('.node-pack-manager-pack.has-conflict').filter({ hasText: 'Community Beta Pack' }));
  await expect(detail.locator('.node-pack-manager-detail-header.has-conflict')).toBeVisible();
  await expect(detail).toContainText('NODE_PACK_TYPE_CONFLICT');
  await expect(detail).toContainText('community.beta');
  await expect(detail).toContainText('community.shared');
  await closeNodePackManagerRowDetail(win);

  const brokenPack = nodePackManagerRow(win, 'Community Broken Pack');
  await expect(brokenPack).toHaveAttribute('data-node-pack-validation', 'validation-error');
  detail = await openNodePackManagerRowDetail(win, brokenPack);
  await expect(detail.locator('.node-pack-manager-detail-header.has-conflict')).toHaveCount(0);
  await expect(detail).toContainText('Validation status');
  await expect(detail).toContainText('validation-error');
  await expect(detail).toContainText('/packs/community.broken/orpad.node-pack.json');
  await expect(detail).toContainText('NODE_PACK_VERSION_MISSING');
  await closeNodePackManagerRowDetail(win);
  await expectNodePackManagerInspectorUsable(win, 'Package manager diagnostics inspector', 3);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('add node browser blocks unresolved and conflicting Package choices', async () => {
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
        message: 'Multiple packages declare the same node type; user selection is required before activation.',
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
  await expect(unsafeProbe).toContainText('Package resolution is approval-required');

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

test('add node browser surfaces Package discovery failure fallback state', async () => {
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
  await expect(alert).toContainText('Degraded package catalog');
  await expect(alert).toContainText('built-in fallback packs only');
  await expect(alert).toContainText('User-installed packs may be missing');
  await expect(alert).toContainText('fixture discovery failure');
  await expect(alert.locator('[data-orch-node-browser-retry]')).toContainText('Retry discovery');
  await expect(alert.locator('[data-node-pack-manager-open]')).toContainText('Open Package Manager');

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

test('Package manager refresh updates add node browser catalog in the same session', async () => {
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
        message: 'Multiple packages declare the same node type; user selection is required before activation.',
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
