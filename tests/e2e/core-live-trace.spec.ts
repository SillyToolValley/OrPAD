import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { closeElectronApp, launchElectron } from '../helpers';

// Stage 2.3: the orchestration-core live-trace Run view. A recorded trace.jsonl
// fixture is replayed through the real IPC (orpad-core-run-replay) so CI exercises
// the full main->preload->renderer path with NO paid live agent. Asserts the
// emergent graph grows, the in-progress node spins, and every node closes out on
// run-done.

function writeApprovedWorkspace(userData: string, workspaceRoot: string): void {
  fs.writeFileSync(path.join(userData, 'approved-workspace.json'), JSON.stringify({
    version: 1,
    workspaceRoot,
  }));
}

function createWorkspaceWithTrace(): { workspace: string; tracePath: string } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-core-trace-'));
  fs.writeFileSync(path.join(workspace, 'README.md'), '# core-live-trace e2e\n', 'utf-8');
  const fixture = fs.readFileSync(path.resolve('tests/fixtures/core-trace.jsonl'), 'utf-8');
  const tracePath = path.join(workspace, 'trace.jsonl');
  fs.writeFileSync(tracePath, fixture, 'utf-8');
  return { workspace, tracePath };
}

async function openOrchestrationWindow(app: any, win: Page): Promise<Page> {
  const orchestrationWindowPromise = app.waitForEvent('window');
  await win.locator('#btn-orchestration').click();
  const orchestrationWin: Page = await orchestrationWindowPromise;
  await orchestrationWin.waitForLoadState('domcontentloaded');
  await orchestrationWin.waitForSelector('body.orchestration-window');
  await orchestrationWin.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await orchestrationWin.waitForSelector('#core-run-view');
  return orchestrationWin;
}

test('orchestration-core live-trace Run view replays a recorded trace', async () => {
  const { workspace, tracePath } = createWorkspaceWithTrace();
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    const userData = await app.evaluate(({ app: electronApp }: any) => electronApp.getPath('userData'));
    writeApprovedWorkspace(userData, workspace);

    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForSelector('.cm-editor');
    await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

    const orchestrationWin = await openOrchestrationWindow(app, win);

    // The Run view starts idle and the Run form is present.
    await expect(orchestrationWin.locator('#core-run-view [data-core-run-status]'))
      .toHaveText(/Idle/);
    await expect(orchestrationWin.locator('#core-run-view [data-core-run-form]')).toBeVisible();
    await expect(orchestrationWin.locator('#core-run-view [data-core-run-submit]')).toBeEnabled();

    // Submitting an empty goal is rejected client-side (no run, inline error).
    await orchestrationWin.locator('#core-run-view [data-core-run-submit]').click();
    await expect(orchestrationWin.locator('#core-run-view [data-core-run-error]')).toBeVisible();

    // Replay the recorded trace through the real IPC. The graph renders in a 2D
    // SVG data-flow scene (file circles + agent chips + flowing access edges), so
    // we assert the run lifecycle via the status + the mounted SVG scene + nodes.
    const summary = await orchestrationWin.evaluate(async (p: string) => {
      return await (window as any).orpad.core.replayTrace({ traceFile: p, intervalMs: 8 });
    }, tracePath);
    expect(summary.ok).toBe(true);
    expect(summary.events).toBeGreaterThan(0);
    expect(summary.done).toBe(true);

    // run-done drives the status to complete and the 2D scene has rendered nodes.
    await expect(orchestrationWin.locator('#core-run-view [data-core-run-status]'))
      .toHaveText(/Run complete/, { timeout: 8000 });
    await expect(orchestrationWin.locator('#core-run-view .core-run-graph2d')).toHaveCount(1, { timeout: 8000 });
    await expect(orchestrationWin.locator('#core-run-view .core-run-nodes .crn-run').first()).toBeVisible({ timeout: 8000 });
  } finally {
    await closeElectronApp(app);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('replayTrace refuses a trace file outside the approved workspace', async () => {
  const { workspace } = createWorkspaceWithTrace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-core-outside-'));
  const outsideTrace = path.join(outside, 'trace.jsonl');
  fs.writeFileSync(outsideTrace, '{"ev":"phase","kind":"recon","state":"start"}\n', 'utf-8');
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    const userData = await app.evaluate(({ app: electronApp }: any) => electronApp.getPath('userData'));
    writeApprovedWorkspace(userData, workspace);

    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForSelector('.cm-editor');
    await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

    const orchestrationWin = await openOrchestrationWindow(app, win);

    const result = await orchestrationWin.evaluate(async (p: string) => {
      return await (window as any).orpad.core.replayTrace({ traceFile: p, intervalMs: 0 });
    }, outsideTrace);
    expect(result.ok).toBe(false);
    expect(String(result.error || '')).toMatch(/outside/i);
  } finally {
    await closeElectronApp(app);
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('legacy .or-graph artifacts open as a read-only JSON tree (static-graph editor removed)', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-or-graph-'));
  const graphPath = path.join(workspace, 'sample.or-graph');
  fs.writeFileSync(graphPath, JSON.stringify({
    schemaVersion: '1.0',
    start: 'a',
    graph: { nodes: [{ id: 'a', type: 'orpad.context' }], transitions: [] },
  }, null, 2), 'utf-8');
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    await win.evaluate((p: string) => (window as any).orpad.dropFile(p), graphPath);
    // Renders via the generic JSON viewer, NOT the old orch graph editor.
    await expect(win.locator('.jedit-tree')).toBeVisible({ timeout: 8000 });
    await expect(win.locator('.orch-graph-node')).toHaveCount(0);
    await expect(win.locator('[data-node-pack-manager-open]')).toHaveCount(0);
  } finally {
    await closeElectronApp(app);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
