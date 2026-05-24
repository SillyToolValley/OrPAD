import { test, expect } from '@playwright/test';
import { withElectronApp } from '../helpers';

test('Ctrl+N creates a new untitled tab', async () => {
  await withElectronApp(async app => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const before = await win.locator('.tab-item').count();

    await win.keyboard.press('Control+n');

    await expect(win.locator('.tab-item')).toHaveCount(before + 1, { timeout: 5000 });
  });
});
