import { test, expect } from '@playwright/test';
import * as path from 'path';
import { launchElectron } from '../helpers';

test('JSON file displays tree view with expected keys', async () => {
  const fixturePath = path.resolve('tests/fixtures/sample.json');
  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await win.evaluate((p: string) => window.orpad.dropFile(p), fixturePath);

  // Wait for the JSON tree to render
  await expect(win.locator('.jedit-tree')).toBeVisible({ timeout: 8000 });

  // The fixture has a top-level "name" key
  const keyNames = win.locator('.jedit-key-name');
  await expect(keyNames.filter({ hasText: 'name' }).first()).toBeVisible({ timeout: 5000 });
  // Key names follow the active theme's accent token (base.css .jedit-key-name),
  // not a hardcoded palette — the old radial-gradient chrome was retired with the
  // OrPAD Hero → OrPAD Default retune.
  const treeChrome = await win.locator('.jedit-scroll').evaluate((el: Element) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent-color)';
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return {
      visible: (el as HTMLElement).offsetHeight > 0,
      accent,
      keyColor: getComputedStyle(document.querySelector('.jedit-key-name') as Element).color,
    };
  });
  expect(treeChrome.visible).toBe(true);
  expect(treeChrome.keyColor).toBe(treeChrome.accent);

  await app.close();
});
