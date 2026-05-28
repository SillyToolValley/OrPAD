import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { closeElectronApp, launchElectron } from '../helpers';

type TerminalProfile = {
  id: string;
  label?: string;
  kind?: string;
  command?: string;
  available?: boolean;
};

function createTerminalWorkspace(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-terminal-e2e-'));
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Terminal e2e\n', 'utf-8');
  return workspace;
}

async function approveWorkspace(app: any, win: Page, workspace: string): Promise<void> {
  const userData = await app.evaluate(({ app: electronApp }: any) => electronApp.getPath('userData'));
  fs.writeFileSync(path.join(userData, 'approved-workspace.json'), JSON.stringify({
    version: 1,
    workspaceRoot: workspace,
  }, null, 2), 'utf-8');

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('.cm-editor', { timeout: 10000 });
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand, null, { timeout: 10000 });
}

async function openTerminal(win: Page): Promise<void> {
  await win.locator('#btn-terminal').click();
  await expect(win.locator('.terminal-panel')).toBeVisible();
}

async function launchProfile(win: Page, profileId: string): Promise<string> {
  const before = await win.locator('.terminal-tab[data-session-id]').count();
  await win.locator('.terminal-tab-add').click();
  await expect(win.locator('.terminal-new-popover')).toBeVisible();
  const card = win.locator(`.terminal-shell-card[data-profile-id="${profileId}"]`);
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card).toBeEnabled({ timeout: 15000 });
  await card.click();
  await expect.poll(async () => win.locator('.terminal-tab[data-session-id]').count(), {
    timeout: 20000,
  }).toBe(before + 1);
  const sessionId = await win.locator('.terminal-tab.active').getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

async function closeProfile(win: Page, sessionId: string): Promise<void> {
  await win.evaluate((id) => {
    const close = document.querySelector(`[data-session-id="${id}"] .terminal-tab-close`) as HTMLElement | null;
    close?.click();
  }, sessionId);
  await expect(win.locator(`.terminal-tab[data-session-id="${sessionId}"]`)).toHaveCount(0, { timeout: 10000 });
}

async function runTerminalEcho(win: Page, sessionId: string, marker: string): Promise<void> {
  await win.evaluate(({ id, text }) => new Promise<void>((resolve, reject) => {
    let seen = '';
    let cleanup: (() => void) | null = null;
    const timeout = setTimeout(() => {
      cleanup?.();
      reject(new Error(`Timed out waiting for terminal output: ${text}`));
    }, 20000);
    cleanup = (window as any).pty.onEvent((payload: any) => {
      if (payload?.sessionId !== id || payload.type !== 'data') return;
      seen = `${seen}${payload.chunk || ''}`.slice(-8000);
      if (!seen.includes(text)) return;
      clearTimeout(timeout);
      cleanup?.();
      resolve();
    });
    (window as any).pty.write(id, `echo ${text}\r`).catch((err: Error) => {
      clearTimeout(timeout);
      cleanup?.();
      reject(err);
    });
  }), { id: sessionId, text: marker });
  await expect(win.locator('.terminal-pty-container:not(.hidden) .xterm')).toBeVisible({ timeout: 10000 });
  await win.waitForTimeout(250);
}

async function expectDragSelectionCopies(win: Page, marker: string): Promise<void> {
  await win.evaluate(() => navigator.clipboard.writeText(''));
  const box = await win.locator('.terminal-pty-container:not(.hidden) .xterm').boundingBox();
  expect(box).not.toBeNull();
  await win.mouse.move(box!.x + 6, box!.y + 8);
  await win.mouse.down();
  await win.mouse.move(
    box!.x + Math.min(box!.width - 8, 620),
    box!.y + Math.min(box!.height - 8, 180),
    { steps: 14 },
  );
  await win.mouse.up();
  await expect.poll(async () => win.evaluate(() => navigator.clipboard.readText()), {
    timeout: 5000,
  }).toContain(marker);
}

test('terminal runner executes a command in the approved workspace', async () => {
  const workspace = createTerminalWorkspace();
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    await approveWorkspace(app, win, workspace);
    await openTerminal(win);

    await win.locator('[data-terminal-mode="runner"]').click();
    await expect(win.locator('.terminal-runner-view')).toBeVisible();
    const marker = `ORPAD_RUNNER_${Date.now()}`;
    await win.locator('.terminal-input').fill(`node -e "console.log('${marker}')"`);
    await win.locator('.terminal-form button[type="submit"]').click();

    await expect(win.locator('.terminal-block').first()).toContainText(marker, { timeout: 20000 });
  } finally {
    await closeElectronApp(app);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('terminal PTY tabs launch shell profiles and copy dragged output', async () => {
  const workspace = createTerminalWorkspace();
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    await approveWorkspace(app, win, workspace);
    await openTerminal(win);

    const status = await win.evaluate(() => (window as any).pty.status());
    test.skip(!status?.available, status?.reason || 'PTY support is unavailable in this Electron build.');

    await win.locator('.terminal-tab-add').click();
    await expect(win.locator('.terminal-new-popover')).toBeVisible();
    await expect(win.locator('.terminal-shell-card[data-profile-kind="ai-cli"]')).toHaveCount(3);
    const profiles = await win.evaluate(() => (window as any).pty.shells()) as TerminalProfile[];
    await win.keyboard.press('Escape');

    const preferredIds = process.platform === 'win32'
      ? ['powershell', 'cmd', 'git-bash', 'wsl']
      : ['bash', 'zsh', 'fish'];
    const shellProfiles = preferredIds
      .map(id => profiles.find(profile => profile.id === id && profile.kind === 'shell' && profile.available !== false && profile.command))
      .filter(Boolean) as TerminalProfile[];

    test.skip(shellProfiles.length === 0, 'No executable shell profiles were detected.');

    let checkedCopy = false;
    for (const profile of shellProfiles) {
      const sessionId = await launchProfile(win, profile.id);
      await expect(win.locator(`.terminal-tab[data-session-id="${sessionId}"] span`).first()).toHaveText(profile.label || profile.id);
      const marker = `ORPAD_${profile.id.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}_${Date.now()}`;
      await runTerminalEcho(win, sessionId, marker);
      await expect(win.locator(`.terminal-tab[data-session-id="${sessionId}"] span`).first()).toHaveText(profile.label || profile.id);
      if (!checkedCopy) {
        await expectDragSelectionCopies(win, marker);
        checkedCopy = true;
      }
      await closeProfile(win, sessionId);
    }
  } finally {
    await closeElectronApp(app);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
