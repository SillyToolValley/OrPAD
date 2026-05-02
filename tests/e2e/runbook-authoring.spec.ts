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

test('creates an OrPAD pipeline inside the current workspace', async () => {
  test.setTimeout(60_000);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-runbook-author-'));
  fs.mkdirSync(path.join(workspace, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# OrPAD Authoring Fixture\n');
  fs.writeFileSync(path.join(workspace, 'skills', 'audit.md'), '# Existing Audit\n');
  fs.writeFileSync(path.join(workspace, 'root-workflow.orch-tree.json'), JSON.stringify({
    $schema: 'https://orchpad.dev/schemas/orch-tree/v4.1.json',
    version: '4.1',
    trees: [
      {
        id: 'existing-workflow',
        label: 'Existing workflow',
        root: {
          id: 'root',
          type: 'Sequence',
          label: 'Existing OrPAD workflow',
          children: [
            { id: 'context', type: 'Context', label: 'Collect context' },
            { id: 'audit', type: 'Skill', label: 'Audit', file: 'skills/audit.md' },
          ],
        },
      },
    ],
  }, null, 2));

  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('.cm-editor');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  const toolbarButtonWidth = await win.locator('#btn-theme').evaluate(el => el.getBoundingClientRect().width);
  await win.locator('#btn-theme').click();
  await expect(win.locator('#ui-scale-control')).toBeVisible();
  await win.locator('[data-us-i]').evaluate((input) => {
    (input as HTMLInputElement).value = '115';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(win.locator('[data-us-v]')).toContainText('115%');
  await expect.poll(async () => win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim())).toBe('1.15');
  await expect.poll(async () => win.locator('#btn-theme').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(toolbarButtonWidth);
  await win.locator('[data-us-r]').click();
  await expect(win.locator('[data-us-v]')).toContainText('100%');
  await expect.poll(async () => win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim())).toBe('1');
  await expect.poll(async () => win.locator('#btn-theme').evaluate(el => el.getBoundingClientRect().width)).toBeLessThan(toolbarButtonWidth + 1);
  await win.locator('#theme-panel-close').click();

  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await expect(win.locator('#runbooks-content')).toContainText('Generate Pipeline');
  await win.locator('[data-runbook-task]').fill('Make the Pipes panel obvious: generate an OrPAD pipeline, validate it, then start a managed run.');
  await win.locator('button[data-runbook-action="starter"]').click();

  await expect(win.locator('#sidebar-runbooks')).toBeVisible();
  await expect(win.locator('.runbook-item.selected')).toHaveAttribute('aria-pressed', 'true');
  await expect(win.locator('.runbook-item.selected')).toContainText('pipeline.or-pipeline');

  const pipelinesRoot = path.join(workspace, '.orpad', 'pipelines');
  const pipelineDirs = fs.readdirSync(pipelinesRoot);
  expect(pipelineDirs.length).toBe(1);
  const runbookDir = path.join(pipelinesRoot, pipelineDirs[0]);
  const pipelineFile = 'pipeline.or-pipeline';
  const graphFile = 'main.or-graph';
  expect(fs.existsSync(path.join(runbookDir, pipelineFile))).toBe(true);
  expect(fs.existsSync(path.join(runbookDir, 'graphs', graphFile))).toBe(true);
  const skillFiles = fs.readdirSync(path.join(runbookDir, 'skills')).filter(name => name.endsWith('.md'));
  expect(skillFiles.length).toBe(1);
  const pipeline = JSON.parse(fs.readFileSync(path.join(runbookDir, pipelineFile), 'utf-8'));
  expect(pipeline.entryGraph).toBe('graphs/main.or-graph');
  expect(pipeline.nodePacks.map((entry: { id: string }) => entry.id)).toContain('orpad.workstream');
  expect(pipeline.run.machineAdapter.type).toBe('codex-cli');
  expect(pipeline.run.machineAdapter.probeNodePaths).toEqual(['main/probe']);
  const graph = JSON.parse(fs.readFileSync(path.join(runbookDir, 'graphs', graphFile), 'utf-8'));
  expect(graph.graph.nodes.map((node: { type: string }) => node.type)).toEqual([
    'orpad.context',
    'orpad.probe',
    'orpad.workQueue',
    'orpad.triage',
    'orpad.dispatcher',
    'orpad.workerLoop',
    'orpad.gate',
    'orpad.artifactContract',
  ]);
  expect(fs.readFileSync(path.join(runbookDir, 'skills', skillFiles[0]), 'utf-8')).toContain('Make the Pipes panel obvious');
  await win.locator('#btn-preview').click();
  await expect(win.locator('.orch-preview')).toContainText('Pipeline editor');
  await expect(win.locator('.pipeline-editor-tabs button.active')).toContainText('Graph');
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  await expect(win.locator('button[data-pipeline-run-action="default"]')).toBeVisible();
  await expect(win.locator('.orch-graph-node')).toHaveCount(8);
  await expect(win.locator('.orch-graph-node')).toContainText(['Load request and workspace context', 'Find evidence-backed candidate work', 'Implement claimed work in overlay']);
  await expect(win.locator('button[data-orch-tool="select"]')).toHaveClass(/active/);
  await expect(win.locator('.orch-graph-tools .ogi')).toHaveCount(8);

  await win.locator('.runbook-item').filter({ hasText: 'root-workflow.orch-tree.json' }).click();
  await expect(win.locator('.runbook-item.selected')).toContainText('root-workflow.orch-tree.json');
  await expect(win.locator('.orch-preview')).toBeVisible();
  await win.locator('#btn-preview').click();
  await expect(win.locator('.orch-preview')).toContainText('orch-tree editor');
  await expect(win.locator('.orch-graph-frame')).toBeVisible();
  await expect(win.locator('.orch-graph-node')).toHaveCount(3);
  await expect(win.locator('.orch-transition')).toHaveCount(2);
  const graphPositions = await win.locator('.orch-graph-node').evaluateAll(nodes => nodes.map(node => ({
    path: (node as HTMLElement).dataset.orchPath,
    left: parseFloat((node as HTMLElement).style.left || '0'),
    top: parseFloat((node as HTMLElement).style.top || '0'),
  })));
  const rootPosition = graphPositions.find(item => item.path === 'trees.0.root');
  const childPosition = graphPositions.find(item => item.path === 'trees.0.root.children.0');
  expect(rootPosition?.top).toBeLessThan(childPosition?.top || 0);
  await expect(win.locator('button[data-orch-tool="select"]')).toHaveClass(/active/);
  await expect(win.locator('button[data-orch-tool="hand"]')).toBeVisible();
  await expect(win.locator('button[data-orch-zoom="in"]')).toBeVisible();
  await expect(win.locator('button[data-orch-action="fit"]')).toBeVisible();
  await expect(win.locator('.orch-graph-tools .ogi')).toHaveCount(8);
  await expect(win.locator('button[data-orch-action="snap-toggle"] .ogi')).toBeVisible();
  const zoomLabel = win.locator('[data-orch-zoom-label]');
  const beforeZoom = await zoomLabel.textContent();
  await win.locator('button[data-orch-zoom="in"]').click();
  await expect.poll(async () => zoomLabel.textContent()).not.toBe(beforeZoom);
  await win.locator('button[data-orch-tool="hand"]').click();
  await expect(win.locator('button[data-orch-tool="hand"]')).toHaveClass(/active/);
  await expect(win.locator('.orch-graph-frame')).toHaveClass(/hand/);
  await win.locator('button[data-orch-action="fit"]').click();
  await win.locator('button[data-orch-tool="select"]').click();
  const beforeRightPan = await win.locator('[data-orch-viewport]').first().getAttribute('style');
  await win.locator('.orch-graph-frame').evaluate((frame) => {
    const opts = { bubbles: true, cancelable: true, button: 2, pointerId: 7, pointerType: 'mouse' };
    frame.dispatchEvent(new PointerEvent('pointerdown', { ...opts, buttons: 2, clientX: 160, clientY: 160 }));
    frame.dispatchEvent(new PointerEvent('pointermove', { ...opts, buttons: 2, clientX: 220, clientY: 190 }));
    frame.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0, clientX: 220, clientY: 190 }));
  });
  await expect(win.locator('button[data-orch-tool="select"]')).toHaveClass(/active/);
  await expect.poll(async () => win.locator('[data-orch-viewport]').first().getAttribute('style')).not.toBe(beforeRightPan);
  await expect(win.locator('.orch-context-menu')).toHaveCount(0);
  await expect(win.locator('button[data-runbook-action="open"]')).toHaveCount(0);

  await win.locator('button[data-orch-mode="readwrite"]').click();
  const treeTypeOptions = await win.locator('.orch-floating-inspector select[data-orch-edit="type"] option').evaluateAll(options =>
    options.map(option => (option as HTMLOptionElement).value).filter(Boolean)
  );
  expect(treeTypeOptions).toContain('Sequence');
  expect(treeTypeOptions).toContain('Skill');
  expect(treeTypeOptions).not.toContain('orpad.context');
  expect(treeTypeOptions).not.toContain('orpad.workQueue');
  await win.locator('button[data-orch-tool="select"]').click();
  const rootNode = win.locator('.orch-graph-node[data-orch-path="trees.0.root"]');
  const firstChildNode = win.locator('.orch-graph-node[data-orch-path="trees.0.root.children.0"]');
  const childBeforeMove = await firstChildNode.evaluate((el) => ({
    left: parseFloat((el as HTMLElement).style.left || '0'),
    top: parseFloat((el as HTMLElement).style.top || '0'),
  }));
  const rootBeforeChildMove = await rootNode.evaluate((el) => ({
    left: (el as HTMLElement).style.left,
    top: (el as HTMLElement).style.top,
  }));
  await firstChildNode.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 17, pointerType: 'mouse' };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: rect.left + 20, clientY: rect.top + 20 }));
    el.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: rect.left - 520, clientY: rect.top - 380 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: rect.left - 520, clientY: rect.top - 380 }));
  });
  await expect.poll(async () => rootNode.evaluate((el) => ({
    left: (el as HTMLElement).style.left,
    top: (el as HTMLElement).style.top,
  }))).toEqual(rootBeforeChildMove);
  await expect.poll(async () => firstChildNode.evaluate((el) => parseFloat((el as HTMLElement).style.left || '0'))).toBeLessThan(0);
  await expect.poll(async () => firstChildNode.evaluate((el) => parseFloat((el as HTMLElement).style.top || '0'))).toBeLessThan(0);
  await expect.poll(async () => win.locator('.orch-transition').evaluateAll(paths =>
    paths.every(pathEl => pathEl.previousElementSibling?.getAttribute('d') === pathEl.getAttribute('d'))
  )).toBe(true);
  await expect(win.locator('button[data-orch-history="undo"]').first()).toBeEnabled();
  await win.keyboard.press('Control+Z');
  await expect.poll(async () => firstChildNode.evaluate((el) => ({
    left: parseFloat((el as HTMLElement).style.left || '0'),
    top: parseFloat((el as HTMLElement).style.top || '0'),
  }))).toEqual(childBeforeMove);
  await expect(win.locator('button[data-orch-history="redo"]').first()).toBeEnabled();
  await win.keyboard.press('Control+Y');
  await expect.poll(async () => firstChildNode.evaluate((el) => parseFloat((el as HTMLElement).style.left || '0'))).toBeLessThan(0);
  await expect(win.locator('button[data-orch-action="snap-toggle"]').first()).not.toHaveClass(/active/);
  const nodeSnapActiveDuringDrag = await firstChildNode.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 18, pointerType: 'mouse', ctrlKey: true };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: rect.left + 18, clientY: rect.top + 18 }));
    el.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: rect.left + 113, clientY: rect.top + 77 }));
    const activeDuring = document.querySelector('button[data-orch-action="snap-toggle"]')?.classList.contains('active');
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: rect.left + 113, clientY: rect.top + 77 }));
    return activeDuring;
  });
  expect(nodeSnapActiveDuringDrag).toBe(true);
  await expect(win.locator('button[data-orch-action="snap-toggle"]').first()).not.toHaveClass(/active/);
  const ctrlSnappedChild = await firstChildNode.evaluate((el) => ({
    left: parseFloat((el as HTMLElement).style.left || '0'),
    top: parseFloat((el as HTMLElement).style.top || '0'),
  }));
  expect(Math.abs(ctrlSnappedChild.left % 28)).toBe(0);
  expect(Math.abs(ctrlSnappedChild.top % 28)).toBe(0);
  await win.locator('.orch-graph-node').filter({ hasText: 'Existing OrPAD workflow' }).click();
  const labelInput = win.locator('[data-orch-edit="label"]').first();
  await labelInput.evaluate((input, value) => {
    (input as HTMLInputElement).value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, 'Edited OrPAD workflow');
  await expect(win.locator('.orch-graph-node.selected')).toContainText('Edited OrPAD workflow');
  await rootNode.click();
  await win.keyboard.press('Control+Z');
  await expect(win.locator('.orch-graph-node.selected')).toContainText('Existing OrPAD workflow');
  await win.keyboard.press('Control+Y');
  await expect(win.locator('.orch-graph-node.selected')).toContainText('Edited OrPAD workflow');

  await win.locator('button[data-orch-action="add-child"]').click();
  await expect(win.locator('.orch-graph-node')).toHaveCount(4);
  await expect(win.locator('.orch-graph-node.selected')).toContainText('New node');
  await win.keyboard.press('Delete');
  await expect(win.locator('.orch-graph-node')).toHaveCount(3);
  await expect(win.locator('.orch-graph-node.selected')).toContainText('Edited OrPAD workflow');
  await win.locator('button[data-orch-action="add-child"]').click();
  await expect(win.locator('.orch-graph-node')).toHaveCount(4);
  await win.locator('.orch-graph-node.selected').click({ button: 'right' });
  await expect(win.locator('.orch-context-menu')).toContainText('Insert subtree');
  await win.locator('button[data-orch-context-action="insert-subtree"]').click();
  await expect(win.locator('.orch-graph-node')).toHaveCount(7);
  await win.locator('button[data-orch-action="fit"]').click();
  await win.locator('.orch-transition-hit').first().evaluate((pathEl) => {
    const rect = pathEl.getBoundingClientRect();
    pathEl.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }));
  });
  await expect(win.locator('.orch-transition.selected')).toHaveCount(1);
  await win.locator('button[data-orch-action="transition-straight"]').click();
  await expect(win.locator('.orch-transition.selected')).toHaveClass(/style-straight/);
  await expect(win.locator('.orch-transition-handle')).toBeVisible();
  const transitionSnapActiveDuringDrag = await win.locator('.orch-transition-handle').evaluate((handle) => {
    const rect = handle.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 23, pointerType: 'mouse', ctrlKey: true };
    handle.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: rect.left + 3, clientY: rect.top + 3 }));
    handle.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: rect.left + 48, clientY: rect.top - 24 }));
    const activeDuring = document.querySelector('button[data-orch-action="snap-toggle"]')?.classList.contains('active');
    handle.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: rect.left + 48, clientY: rect.top - 24 }));
    return activeDuring;
  });
  expect(transitionSnapActiveDuringDrag).toBe(true);
  await expect(win.locator('button[data-orch-action="snap-toggle"]').first()).not.toHaveClass(/active/);
  await expect.poll(async () => win.locator('.orch-transition.selected').evaluate(pathEl =>
    pathEl.previousElementSibling?.getAttribute('d') === pathEl.getAttribute('d')
  )).toBe(true);
  await expect.poll(() => fs.existsSync(path.join(workspace, 'root-workflow.orch-tree.meta.json'))).toBe(true);
  const metaPath = path.join(workspace, 'root-workflow.orch-tree.meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  expect(Object.values(meta.transitions).some((transition: any) => transition.style === 'straight')).toBe(true);
  const snappedTransition = Object.values(meta.transitions).find((transition: any) => transition.points?.length) as any;
  expect(Math.abs(snappedTransition.points[0].x % 28)).toBe(0);
  expect(Math.abs(snappedTransition.points[0].y % 28)).toBe(0);
  await win.locator('.orch-transition-hit').nth(1).evaluate((pathEl) => {
    const rect = pathEl.getBoundingClientRect();
    pathEl.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }));
  });
  await win.keyboard.press('Delete');
  await expect(win.locator('.orch-graph-node')).toHaveCount(6);

  await win.locator('button[data-orch-tool="select"]').click();
  await expect(win.locator('button[data-orch-tool="select"]')).toHaveClass(/active/);
  await win.locator('button[data-orch-action="fit"]').click();
  const frameBox = await win.locator('.orch-graph-frame').boundingBox();
  const dragLeft = (frameBox?.x || 0) + 8;
  const dragTop = (frameBox?.y || 0) + (frameBox?.height || 0) - 8;
  const dragRight = (frameBox?.x || 0) + (frameBox?.width || 0) - 8;
  const dragBottom = (frameBox?.y || 0) + 8;
  await win.locator('.orch-graph-frame').evaluate((frame, points) => {
    const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse' };
    frame.dispatchEvent(new PointerEvent('pointerdown', { ...opts, buttons: 1, clientX: points.left, clientY: points.top }));
    frame.dispatchEvent(new PointerEvent('pointermove', { ...opts, buttons: 1, clientX: points.right, clientY: points.bottom }));
    frame.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0, clientX: points.right, clientY: points.bottom }));
  }, { left: dragLeft, top: dragTop, right: dragRight, bottom: dragBottom });
  await expect.poll(async () => win.locator('.orch-graph-node.selected').count()).toBeGreaterThan(1);

  await win.locator('.orch-graph-frame').click({ button: 'right', position: { x: 40, y: 110 } });
  await expect(win.locator('.orch-context-menu')).toContainText('Add Context');

  await win.locator('.runbook-item.selected').click();
  await expect(win.locator('.runbook-item.selected')).toHaveCount(0);

  await win.locator('.runbook-item').filter({ hasText: 'root-workflow.orch-tree.json' }).click();
  await expect(win.locator('.runbook-item.selected')).toContainText('root-workflow.orch-tree.json');

  await win.locator('.runbook-item').filter({ hasText: pipelineFile }).click();
  await expect(win.locator('.runbook-item.selected')).toContainText(pipelineFile);
  await win.locator('.tab-item').filter({ hasText: graphFile }).click();
  await expect(win.locator('.tab-item.active')).toContainText(graphFile);
  await expect(win.locator('.orch-preview')).toContainText('Pipeline editor');
  await win.locator('button[data-orch-mode="readwrite"]').click();
  const graphContextNode = win.locator('.orch-graph-node[data-orch-path="graph.nodes.0"]');
  const graphApprovalNode = win.locator('.orch-graph-node[data-orch-path="graph.nodes.1"]');
  await expect(graphContextNode).toBeVisible();
  await graphContextNode.evaluate((el) => (el as HTMLElement).click());
  const graphLabelInput = win.locator('[data-orch-edit="label"]').first();
  await graphLabelInput.evaluate((input, value) => {
    (input as HTMLInputElement).value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, 'Edited graph context');
  await expect(win.locator('.orch-graph-node.selected')).toContainText('Edited graph context');
  await graphContextNode.evaluate((el) => (el as HTMLElement).click());
  await win.keyboard.press('Control+Z');
  await expect(win.locator('.orch-graph-node.selected')).toContainText('Load request and workspace context');
  await win.keyboard.press('Control+Y');
  await expect(win.locator('.orch-graph-node.selected')).toContainText('Edited graph context');
  const approvalBeforeMove = await graphApprovalNode.evaluate((el) => ({
    left: parseFloat((el as HTMLElement).style.left || '0'),
    top: parseFloat((el as HTMLElement).style.top || '0'),
  }));
  await graphApprovalNode.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 31, pointerType: 'mouse', ctrlKey: true };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: rect.left + 18, clientY: rect.top + 18 }));
    el.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: rect.left + 99, clientY: rect.top + 67 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: rect.left + 99, clientY: rect.top + 67 }));
  });
  await expect.poll(async () => graphApprovalNode.evaluate((el) => ({
    left: parseFloat((el as HTMLElement).style.left || '0'),
    top: parseFloat((el as HTMLElement).style.top || '0'),
  }))).not.toEqual(approvalBeforeMove);
  await win.keyboard.press('Control+Z');
  await expect.poll(async () => graphApprovalNode.evaluate((el) => ({
    left: parseFloat((el as HTMLElement).style.left || '0'),
    top: parseFloat((el as HTMLElement).style.top || '0'),
  }))).toEqual(approvalBeforeMove);
  await win.keyboard.press('Control+Y');
  await expect.poll(async () => graphApprovalNode.evaluate((el) => ({
    left: parseFloat((el as HTMLElement).style.left || '0'),
    top: parseFloat((el as HTMLElement).style.top || '0'),
  }))).not.toEqual(approvalBeforeMove);
  const graphMetaPath = path.join(runbookDir, 'graphs', graphFile.replace('.or-graph', '.or-graph.meta.json'));
  await expect.poll(() => fs.existsSync(graphMetaPath)).toBe(true);
  await graphContextNode.evaluate((el) => (el as HTMLElement).click());
  await win.locator('button[data-orch-action="add-child"]').click();
  await expect(win.locator('.orch-graph-node')).toHaveCount(9);
  await expect(win.locator('.orch-transition')).toHaveCount(8);
  await expect(win.locator('.orch-graph-node.selected')).toContainText('New context');
  await expect(win.locator('.orch-graph-node.selected')).toContainText('orpad.context');
  await win.keyboard.press('Delete');
  await expect(win.locator('.orch-graph-node')).toHaveCount(8);
  await expect(win.locator('.orch-transition')).toHaveCount(7);
  await graphContextNode.evaluate((el) => (el as HTMLElement).click());
  await win.locator('.orch-graph-node[data-orch-path="graph.nodes.2"]').click({ button: 'right' });
  await expect(win.locator('.orch-context-menu')).toContainText('Connect selected');
  await win.locator('button[data-orch-context-action="connect-selected"]').click();
  await expect(win.locator('.orch-transition')).toHaveCount(8);
  await win.locator('.orch-transition-hit').first().evaluate((pathEl) => {
    const rect = pathEl.getBoundingClientRect();
    pathEl.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }));
  });
  await expect(win.locator('.orch-transition.selected')).toHaveCount(1);
  await win.locator('button[data-orch-action="transition-straight"]').click();
  await expect(win.locator('.orch-transition.selected')).toHaveClass(/style-straight/);
  await expect(win.locator('.orch-transition-handle')).toBeVisible();
  await win.locator('button[data-orch-action="delete-transition"]').click();
  await expect(win.locator('.orch-graph-node')).toHaveCount(8);
  await expect(win.locator('.orch-transition')).toHaveCount(7);
  await win.keyboard.press('Control+S');
  await expect.poll(() => fs.readFileSync(path.join(runbookDir, 'graphs', graphFile), 'utf-8')).toContain('Edited graph context');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});
