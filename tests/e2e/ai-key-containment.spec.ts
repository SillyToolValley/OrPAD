import { test, expect } from '@playwright/test';
import { withElectronApp } from '../helpers';

test('desktop AI key bridge does not expose decrypted saved keys', async () => {
  await withElectronApp(async app => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const bridge = await win.evaluate(() => {
      const aiKeys = (window as any).orpad.aiKeys || {};
      return {
        hasStatus: typeof aiKeys.status === 'function',
        hasSet: typeof aiKeys.set === 'function',
        hasRemove: typeof aiKeys.remove === 'function',
        hasGetDecrypted: typeof aiKeys.getDecrypted === 'function',
        hasAiChat: typeof (window as any).orpad.aiChat?.start === 'function',
      };
    });

    expect(bridge).toEqual({
      hasStatus: true,
      hasSet: true,
      hasRemove: true,
      hasGetDecrypted: false,
      hasAiChat: true,
    });
  });
});
