import { test, expect, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { startStaticServer } from '../../helpers';

const docsDir = path.resolve('docs');
const REQUIRED_DOCS_ARTIFACTS = [
  'index.html',
  'renderer.js',
  'styles/base.css',
];
const HERO_VARS = {
  bgPrimary: '#050b1f',
  bgSecondary: '#0b1530',
  accentColor: '#38a3ff',
  editorBg: '#071228',
};
const GITHUB_LIGHT_VARS = {
  bgPrimary: '#ffffff',
  bgSecondary: '#f6f8fa',
  editorBg: '#ffffff',
};
const consoleErrorsByPage = new WeakMap<Page, string[]>();

function expectWebBuildArtifacts(): void {
  const missing = REQUIRED_DOCS_ARTIFACTS.filter(rel => !fs.existsSync(path.join(docsDir, rel)));
  expect(
    missing,
    `Missing web release artifacts: ${missing.join(', ')}. Run npm run build:web:min before web theme smoke tests.`,
  ).toEqual([]);
}

function isUnexpectedConsoleError(text: string): boolean {
  return !text.toLowerCase().includes('favicon');
}

async function rootVars(page: Page, names: string[]) {
  return page.evaluate((varNames: string[]) => {
    const styles = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      varNames.map(name => [name, styles.getPropertyValue(name).trim()]),
    );
  }, names);
}

async function surfaceChrome(locator: Locator) {
  return locator.evaluate((el: Element) => {
    const styles = getComputedStyle(el);
    return {
      backgroundColor: styles.backgroundColor,
      borderColor: styles.borderColor,
      boxShadow: styles.boxShadow,
      color: styles.color,
    };
  });
}

async function resetSavedTheme(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.removeItem('orpad-theme'));
}

test.beforeAll(() => {
  expectWebBuildArtifacts();
});

test.beforeEach(async ({ page }) => {
  const consoleErrors: string[] = [];
  consoleErrorsByPage.set(page, consoleErrors);
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
});

test.afterEach(async ({ page }) => {
  const realErrors = (consoleErrorsByPage.get(page) || []).filter(isUnexpectedConsoleError);
  expect(realErrors).toEqual([]);
});

test('web default OrPAD Hero theme switches to GitHub Light across visible chrome', async ({ page }) => {
  await resetSavedTheme(page);
  const { url, close } = await startStaticServer(docsDir);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('#toolbar')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#editor-pane')).toBeVisible();
    await expect(page.locator('.cm-editor')).toBeVisible();

    const beforeVars = await rootVars(page, ['--bg-primary', '--bg-secondary', '--accent-color', '--editor-bg']);
    expect(beforeVars['--bg-primary']).toBe(HERO_VARS.bgPrimary);
    expect(beforeVars['--bg-secondary']).toBe(HERO_VARS.bgSecondary);
    expect(beforeVars['--accent-color']).toBe(HERO_VARS.accentColor);
    expect(beforeVars['--editor-bg']).toBe(HERO_VARS.editorBg);

    const beforeToolbarChrome = await surfaceChrome(page.locator('#toolbar'));
    const beforeEditorChrome = await surfaceChrome(page.locator('#editor-pane'));

    await page.locator('#btn-theme').click();
    await expect(page.locator('#theme-panel')).toBeVisible({ timeout: 5000 });
    const heroTheme = page.locator('#theme-list .theme-item').filter({ hasText: 'OrPAD Hero' });
    await expect(heroTheme).toBeVisible({ timeout: 3000 });
    await expect(heroTheme).toHaveClass(/active/);

    const githubLight = page.locator('#theme-list .theme-item').filter({ hasText: 'GitHub Light' });
    await expect(githubLight).toBeVisible({ timeout: 3000 });
    await githubLight.click();

    await expect.poll(
      async () => (await rootVars(page, ['--bg-primary']))['--bg-primary'],
      { message: 'GitHub Light should update root --bg-primary' },
    ).toBe(GITHUB_LIGHT_VARS.bgPrimary);

    const afterVars = await rootVars(page, ['--bg-primary', '--bg-secondary', '--editor-bg']);
    expect(afterVars['--bg-secondary']).toBe(GITHUB_LIGHT_VARS.bgSecondary);
    expect(afterVars['--editor-bg']).toBe(GITHUB_LIGHT_VARS.editorBg);

    const afterToolbarChrome = await surfaceChrome(page.locator('#toolbar'));
    const afterEditorChrome = await surfaceChrome(page.locator('#editor-pane'));
    expect(afterToolbarChrome.backgroundColor).not.toBe(beforeToolbarChrome.backgroundColor);
    expect(afterToolbarChrome.borderColor).not.toBe(beforeToolbarChrome.borderColor);
    expect(afterToolbarChrome.color).not.toBe(beforeToolbarChrome.color);
    expect(afterEditorChrome.backgroundColor).not.toBe(beforeEditorChrome.backgroundColor);
    expect(afterEditorChrome.color).not.toBe(beforeEditorChrome.color);
    expect(afterToolbarChrome.boxShadow).not.toBe('none');
    expect(afterEditorChrome.boxShadow).not.toBe('none');
  } finally {
    await close();
  }
});
