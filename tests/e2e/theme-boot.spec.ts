import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _electron as electron, ElectronApplication, Page } from 'playwright';
import { attachReliableElectronClose } from '../helpers';

// Startup theme-flash regression test: after a user saves a non-default theme, a
// relaunch must paint with that theme from the very first frame. theme-boot.js
// (a synchronous <head> script) replays the cached palette before first paint and
// sets data-orpad-theme-boot on <html> — the marker only that script sets, so it
// distinguishes the pre-paint path from the (later) bundle apply.

async function launchWithUserData(userDataDir: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = attachReliableElectronClose(await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: { ...process.env, ORPAD_TEST_USER_DATA: userDataDir },
  }));
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

test('saved theme paints pre-bundle on relaunch (no default-theme flash)', async () => {
  test.setTimeout(120000);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-themeboot-'));
  const TOKYO_BG = '#1a1b26';

  // Launch 1: pick a dark builtin theme through the real UI so applyThemeColors
  // writes the boot cache (and reports the window background to main).
  let { app, win } = await launchWithUserData(userDataDir);
  try {
    await win.waitForSelector('.cm-editor', { timeout: 10000 });
    await win.click('#btn-theme');
    await win.locator('#theme-list .theme-item').filter({ hasText: 'Tokyo Night' }).click();
    await expect.poll(() => win.evaluate(() => localStorage.getItem('orpad-theme'))).toBe('tokyo-night');
    const cacheRaw = await win.evaluate(() => localStorage.getItem('orpad-theme-boot'));
    expect(cacheRaw, 'applyThemeColors must write the boot cache').toBeTruthy();
    const cache = JSON.parse(cacheRaw as string);
    expect(cache.bg).toBe(TOKYO_BG);
    expect(cache.type).toBe('dark');
    expect(cache.vars['--bg-primary']).toBe(TOKYO_BG);
  } finally {
    await app.close();
  }

  // Launch 2: the head boot script must have applied the saved palette. The marker
  // is only ever set by theme-boot.js, which runs synchronously in <head> — its
  // presence proves the theme landed before <body> could paint.
  ({ app, win } = await launchWithUserData(userDataDir));
  try {
    const bootMarker = await win.evaluate(() => document.documentElement.dataset.orpadThemeBoot || '');
    expect(bootMarker, 'theme-boot.js must run in <head> with the cached palette').toBe(TOKYO_BG);
    const bgVar = await win.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim());
    expect(bgVar).toBe(TOKYO_BG);
    // Main-process side: the persisted window background must match the theme so
    // the pre-HTML frame doesn't flash a mismatched color.
    const persisted = JSON.parse(fs.readFileSync(path.join(userDataDir, 'window-theme.json'), 'utf-8'));
    expect(persisted.backgroundColor).toBe(TOKYO_BG);
  } finally {
    await app.close();
    // Best-effort: Windows can hold the userData lock briefly after exit.
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
});
