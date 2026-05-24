import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withElectronApp } from '../helpers';

test('edit + Ctrl+S saves content to disk', async () => {
  const tmpFile = path.join(os.tmpdir(), `orpad-test-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, '# Original Content\n');

  try {
    await withElectronApp(async app => {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');

      // Wait for the file tab to appear
      await expect(win.locator('.tab-item')).toBeVisible({ timeout: 8000 });

      // Click into the editor and append text
      await win.locator('.cm-content').click();
      await win.keyboard.press('Control+End');
      await win.keyboard.type('\n\n## Added by test');

      // Save
      await win.keyboard.press('Control+s');

      // Allow the async IPC write to complete
      await win.waitForTimeout(400);

      const saved = fs.readFileSync(tmpFile, 'utf-8');
      expect(saved).toContain('## Added by test');
    }, [tmpFile]);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});
