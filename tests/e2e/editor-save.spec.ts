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

const textFormatCases = [
  {
    label: 'plain txt',
    ext: 'txt',
    content: 'Plain text notes\n',
    expected: 'Plain text notes',
    marker: 'Saved from text fallback',
    expectSyntax: false,
  },
  {
    label: 'python source',
    ext: 'py',
    content: 'def greet():\n    return "hello"\n',
    expected: 'def greet',
    marker: '# Saved from source editor',
    expectSyntax: true,
  },
  {
    label: 'typescript source',
    ext: 'ts',
    content: 'export function greet(): string {\n  return "hello";\n}\n',
    expected: 'export function greet',
    marker: '// Saved from source editor',
    expectSyntax: true,
  },
  {
    label: 'unknown text extension',
    ext: 'orpadtext',
    content: 'Unknown text format\n',
    expected: 'Unknown text format',
    marker: 'Saved from unknown fallback',
    expectSyntax: false,
  },
];

for (const fixture of textFormatCases) {
  test(`opens and saves ${fixture.label} files as editable text`, async () => {
    const tmpFile = path.join(os.tmpdir(), `orpad-${fixture.ext}-${Date.now()}.${fixture.ext}`);
    fs.writeFileSync(tmpFile, fixture.content);

    try {
      await withElectronApp(async app => {
        const win = await app.firstWindow();
        await win.waitForLoadState('domcontentloaded');

        await expect(win.locator('.tab-item')).toContainText(path.basename(tmpFile), { timeout: 8000 });
        await expect(win.locator('.cm-content')).toContainText(fixture.expected);
        if (fixture.expectSyntax) {
          await expect(win.locator('.cm-content .tok-keyword').first()).toBeVisible({ timeout: 8000 });
        }

        await win.locator('.cm-content').click();
        await win.keyboard.press('Control+End');
        await win.keyboard.type(`\n${fixture.marker}`);
        await win.keyboard.press('Control+s');
        await win.waitForTimeout(400);

        const saved = fs.readFileSync(tmpFile, 'utf-8');
        expect(saved).toContain(fixture.marker);
      }, [tmpFile]);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });
}

test('programming source editor colors keywords, names, and strings distinctly', async () => {
  const tmpFile = path.join(os.tmpdir(), `orpad-syntax-${Date.now()}.py`);
  fs.writeFileSync(tmpFile, 'def greet(name):\n    value = "hello"\n    return value\n');

  try {
    await withElectronApp(async app => {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');

      await expect(win.locator('.tab-item')).toContainText(path.basename(tmpFile), { timeout: 8000 });

      const keyword = win.locator('.cm-content .tok-keyword').filter({ hasText: 'def' }).first();
      const name = win.locator('.cm-content .tok-definition').filter({ hasText: 'greet' }).first();
      const stringLiteral = win.locator('.cm-content .tok-string').filter({ hasText: '"hello"' }).first();

      await expect(keyword).toBeVisible({ timeout: 8000 });
      await expect(name).toBeVisible({ timeout: 8000 });
      await expect(stringLiteral).toBeVisible({ timeout: 8000 });

      const colors = await Promise.all([
        keyword.evaluate(el => getComputedStyle(el).color),
        name.evaluate(el => getComputedStyle(el).color),
        stringLiteral.evaluate(el => getComputedStyle(el).color),
      ]);

      expect(new Set(colors).size).toBe(3);
    }, [tmpFile]);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});
