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
  const treeChrome = await win.locator('.jedit-scroll').evaluate((el: Element) => {
    const styles = getComputedStyle(el);
    return {
      backgroundImage: styles.backgroundImage,
      keyColor: getComputedStyle(document.querySelector('.jedit-key-name') as Element).color,
    };
  });
  expect(treeChrome.backgroundImage).toContain('radial-gradient');
  expect(treeChrome.keyColor).toBe('rgb(56, 163, 255)');

  await app.close();
});
