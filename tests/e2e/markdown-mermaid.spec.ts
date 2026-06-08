import { test, expect, type Page } from '@playwright/test';
import * as path from 'path';
import { launchElectron } from '../helpers';

async function chooseTheme(win: Page, themeName: string) {
  const panel = win.locator('#theme-panel');
  const isHidden = await panel.evaluate((el) => el.classList.contains('hidden'));
  if (isHidden) await win.locator('#btn-theme').click();
  const themeItem = win.locator('#theme-list .theme-item', { hasText: themeName }).first();
  await expect(themeItem).toBeVisible();
  await themeItem.click();
}

async function mermaidThemeSnapshot(win: Page) {
  return win.locator('#content .mermaid-block svg').first().evaluate((svg) => {
    const doc = svg.ownerDocument;
    const normalizeColor = (value: string) => {
      const raw = String(value || '').trim();
      if (!raw || raw === 'none' || raw === 'transparent' || raw.startsWith('url(')) return '';
      const probe = doc.createElement('span');
      probe.style.color = raw;
      doc.body.appendChild(probe);
      const normalized = getComputedStyle(probe).color;
      probe.remove();
      return normalized === 'rgba(0, 0, 0, 0)' ? '' : normalized;
    };
    const tokenNames = [
      '--bg-primary',
      '--bg-secondary',
      '--bg-tertiary',
      '--text-primary',
      '--text-secondary',
      '--border-color',
      '--accent-color',
      '--syntax-keyword',
      '--syntax-string',
    ];
    const rootStyles = getComputedStyle(doc.documentElement);
    const tokenColors = tokenNames
      .map((name) => normalizeColor(rootStyles.getPropertyValue(name)))
      .filter(Boolean);
    const palette = new Set<string>();
    const selectors = [
      'rect',
      'circle',
      'ellipse',
      'polygon',
      'path',
      'line',
      'text',
      '.nodeLabel',
      '.edgeLabel',
      '.label',
    ];
    svg.querySelectorAll(selectors.join(',')).forEach((el) => {
      const styles = getComputedStyle(el);
      ['fill', 'stroke', 'color', 'background-color'].forEach((prop) => {
        const color = normalizeColor(styles.getPropertyValue(prop));
        if (color) palette.add(color);
      });
    });
    const rect = svg.getBoundingClientRect();
    const colors = Array.from(palette).sort();
    return {
      colors,
      hasThemeTokenColor: colors.some((color) => tokenColors.includes(color)),
      paletteKey: colors.join('|'),
      tokenKey: Array.from(new Set(tokenColors)).sort().join('|'),
      width: rect.width,
      height: rect.height,
    };
  });
}

test('mermaid fenced block follows OrPAD theme tokens in preview', async () => {
  const fixturePath = path.resolve('tests/fixtures/sample-mermaid.md');
  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await chooseTheme(win, 'Hero');
  await win.evaluate((p: string) => window.orpad.dropFile(p), fixturePath);

  // Wait past the 400ms per-block debounce before polling for the SVG.
  await win.waitForTimeout(600);

  // renderMermaidBlocks() renders SVG into .mermaid-block inside #content.
  // Use the class selector so we only match the actual mermaid output.
  await expect(win.locator('#content .mermaid-block svg').first()).toBeVisible({ timeout: 15000 });
  const hero = await mermaidThemeSnapshot(win);
  expect(hero.width).toBeGreaterThan(0);
  expect(hero.height).toBeGreaterThan(0);
  expect(hero.hasThemeTokenColor).toBe(true);

  await chooseTheme(win, 'GitHub Light');
  await expect
    .poll(async () => (await mermaidThemeSnapshot(win)).paletteKey, { timeout: 15000 })
    .not.toBe(hero.paletteKey);
  const githubLight = await mermaidThemeSnapshot(win);
  expect(githubLight.hasThemeTokenColor).toBe(true);
  expect(githubLight.tokenKey).not.toBe(hero.tokenKey);

  await app.close();
});
