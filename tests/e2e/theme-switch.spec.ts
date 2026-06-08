import { test, expect, type Locator, type Page } from '@playwright/test';
import { launchElectron } from '../helpers';

const HERO_VARS = {
  bgPrimary: '#050b1f',
  bgSecondary: '#0b1530',
  accentColor: '#38a3ff',
};

async function rootVars(win: Page, names: string[]) {
  return win.evaluate((varNames: string[]) => {
    const styles = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      varNames.map(name => [name, styles.getPropertyValue(name).trim()]),
    );
  }, names);
}

async function resetSavedTheme(win: Page) {
  await win.evaluate(() => localStorage.removeItem('orpad-theme'));
  await win.reload({ waitUntil: 'domcontentloaded' });
}

async function surfaceChrome(locator: Locator) {
  return locator.evaluate((el: Element) => {
    const styles = getComputedStyle(el);
    return {
      backgroundImage: styles.backgroundImage,
      backgroundColor: styles.backgroundColor,
      borderColor: styles.borderColor,
      borderStyle: styles.borderStyle,
      borderWidth: styles.borderWidth,
      boxShadow: styles.boxShadow,
      color: styles.color,
    };
  });
}

function expectCleanSoftChrome(chrome: Awaited<ReturnType<typeof surfaceChrome>>) {
  expect(chrome.backgroundImage).not.toMatch(/(?:radial|linear)-gradient/);
  expect(chrome.backgroundColor).toMatch(/rgb|color/);
  expect(chrome.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(chrome.borderColor).toMatch(/rgb|color/);
  expect(chrome.borderStyle).not.toBe('none');
  expect(parseFloat(chrome.borderWidth)).toBeGreaterThan(0);
  expect(chrome.boxShadow).not.toBe('none');
  expect(chrome.color).toMatch(/rgb|color/);
}

function expectThemeResponsiveChrome(
  before: Awaited<ReturnType<typeof surfaceChrome>>,
  after: Awaited<ReturnType<typeof surfaceChrome>>,
) {
  expect(after.backgroundImage).not.toMatch(/(?:radial|linear)-gradient/);
  expect(after.backgroundColor).toMatch(/rgb|color/);
  expect(after.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(after.backgroundColor).not.toBe(before.backgroundColor);
  expect(after.borderColor).toMatch(/rgb|color/);
  expect(after.borderColor).not.toBe(before.borderColor);
  expect(after.borderStyle).not.toBe('none');
  expect(parseFloat(after.borderWidth)).toBeGreaterThan(0);
  expect(after.color).toMatch(/rgb|color/);
  expect(after.color).not.toBe(before.color);
}

async function openCommandPalette(win: Page) {
  await win.evaluate(async () => {
    const commands = (window as any).orpadCommands;
    if (!commands?.runCommand) return;
    for (const id of ['commandPalette.open', 'commands.openPalette', 'quickOpen.open', 'file.quickOpen']) {
      try {
        await commands.runCommand(id);
        if (document.querySelector('.cmdk-shell')) return;
      } catch {
        // Some builds do not register every command alias.
      }
    }
  });

  const shell = win.locator('.cmdk-shell');
  if (await shell.isVisible().catch(() => false)) return;

  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
  try {
    await expect(shell).toBeVisible({ timeout: 1000 });
    return;
  } catch {
    // Try the quick-open shortcut before failing.
  }

  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P');
  await expect(shell).toBeVisible({ timeout: 3000 });
}

async function switchToTheme(win: Page, label: string) {
  await win.click('#btn-theme');
  await expect(win.locator('#theme-panel')).toBeVisible({ timeout: 5000 });
  const theme = win.locator('#theme-list .theme-item').filter({ hasText: label });
  await expect(theme).toBeVisible({ timeout: 3000 });
  await theme.click();
}

async function installVmHarnessFixture(win: Page) {
  await win.evaluate(() => {
    document.querySelector('[data-vm-harness-dashboard-test-fixture]')?.remove();
    const fixture = document.createElement('div');
    fixture.setAttribute('data-vm-harness-dashboard-test-fixture', '');
    fixture.style.position = 'fixed';
    fixture.style.left = '16px';
    fixture.style.top = '16px';
    fixture.style.zIndex = '2147483000';
    fixture.style.width = '560px';
    fixture.innerHTML = `
      <div class="pipe-lifecycle-banner pipe-lifecycle-banner--warn vm-harness-dashboard vm-harness-dashboard--warn" data-vm-harness-dashboard>
        <div class="vm-harness-dashboard-head">
          <div>
            <div class="pipe-lifecycle-banner-title">VM Harness</div>
            <div class="pipe-lifecycle-banner-detail">Theme fixture</div>
          </div>
          <span class="vm-harness-state-chip vm-harness-state-chip--warn">Degraded</span>
        </div>
        <ol class="vm-harness-stage-rail">
          <li class="done"><span>Profile</span></li>
          <li class="current"><span>Provision</span></li>
          <li class="wait"><span>Ready</span></li>
        </ol>
        <div class="vm-harness-metric-grid">
          <div class="vm-harness-metric vm-harness-metric--warn">
            <span>Tool health</span>
            <strong>11/15 ready</strong>
            <em>3 degraded</em>
          </div>
        </div>
        <div class="pipe-lifecycle-banner-conclusion vm-harness-next-action">Resolve provisioning warnings.</div>
        <div class="vm-harness-chip-row"><span class="vm-harness-chip vm-harness-chip--warn">MCP configured</span></div>
        <div class="pipe-lifecycle-banner-actions"><button class="pipe-lifecycle-banner-link vm-harness-dashboard-action">tool-health.json</button></div>
      </div>
    `;
    document.body.appendChild(fixture);
  });

  const dashboard = win.locator('[data-vm-harness-dashboard-test-fixture] [data-vm-harness-dashboard]');
  await expect(dashboard).toBeVisible({ timeout: 3000 });
  return dashboard;
}

async function vmHarnessChrome(dashboard: Locator) {
  return {
    dashboard: await surfaceChrome(dashboard),
    stage: await surfaceChrome(dashboard.locator('.vm-harness-stage-rail li.current')),
    metric: await surfaceChrome(dashboard.locator('.vm-harness-metric').first()),
    chip: await surfaceChrome(dashboard.locator('.vm-harness-chip').first()),
    action: await surfaceChrome(dashboard.locator('.vm-harness-dashboard-action').first()),
  };
}

async function installOrchestrationEdgeFixture(win: Page) {
  await win.evaluate(() => {
    document.querySelector('[data-orch-edge-theme-fixture]')?.remove();
    const fixture = document.createElement('div');
    fixture.setAttribute('data-orch-edge-theme-fixture', '');
    fixture.style.position = 'fixed';
    fixture.style.left = '24px';
    fixture.style.top = '24px';
    fixture.style.zIndex = '2147483000';
    fixture.style.width = '260px';
    fixture.style.height = '160px';
    fixture.innerHTML = `
      <svg class="orch-graph-edges" width="260" height="160" viewBox="0 0 260 160">
        <path data-edge-category="forward" class="orch-transition category-forward" d="M12 18 C70 18 100 18 150 18"></path>
        <path data-edge-category="branch" class="orch-transition category-branch" d="M12 42 C70 42 100 42 150 42"></path>
        <path data-edge-category="accept" class="orch-transition category-accept" d="M12 66 C70 66 100 66 150 66"></path>
        <path data-edge-category="reject" class="orch-transition category-reject" d="M12 90 C70 90 100 90 150 90"></path>
        <path data-edge-category="queue-loop" class="orch-transition category-queue-not-empty" d="M12 114 C70 114 100 114 150 114"></path>
        <path data-edge-category="loopback" class="orch-transition loop-back category-loop-back" d="M150 138 C100 154 58 154 12 138"></path>
      </svg>
    `;
    document.body.appendChild(fixture);
  });

  const fixture = win.locator('[data-orch-edge-theme-fixture]');
  await expect(fixture).toBeVisible({ timeout: 3000 });
  return fixture;
}

async function orchestrationEdgeStrokes(fixture: Locator) {
  const categories = ['forward', 'branch', 'accept', 'reject', 'queue-loop', 'loopback'];
  const entries = await Promise.all(categories.map(async category => [
    category,
    await fixture.locator(`[data-edge-category="${category}"]`).evaluate((el: Element) => getComputedStyle(el).getPropertyValue('stroke').trim()),
  ]));
  return Object.fromEntries(entries);
}

function expectVisibleEdgeStrokes(strokes: Record<string, string>) {
  for (const stroke of Object.values(strokes)) {
    expect(stroke).toMatch(/^(?:rgb|rgba|color\()/);
    expect(stroke).not.toBe('none');
    expect(stroke).not.toBe('rgba(0, 0, 0, 0)');
  }
  expect(new Set(Object.values(strokes)).size).toBeGreaterThan(3);
}

async function installTerminalChromeFixture(win: Page) {
  await win.evaluate(() => {
    document.querySelector('[data-terminal-theme-fixture]')?.remove();
    const fixture = document.createElement('div');
    fixture.setAttribute('data-terminal-theme-fixture', '');
    fixture.style.position = 'fixed';
    fixture.style.left = '18px';
    fixture.style.top = '18px';
    fixture.style.zIndex = '2147483000';
    fixture.style.width = '390px';
    fixture.innerHTML = `
      <div class="terminal-new-popover" role="menu" aria-label="Terminal picker fixture" style="position: static; width: 100%; max-height: none;">
        <div class="terminal-new-popover-head">
          <div>
            <strong>New terminal</strong>
            <span>Select a shell profile</span>
          </div>
        </div>
        <label class="terminal-new-cwd">
          <span>CWD</span>
          <input type="text" value="C:\\\\repo" spellcheck="false">
        </label>
        <div class="terminal-shell-list">
          <div class="terminal-profile-section-title">Shells</div>
          <button type="button" class="terminal-shell-card preferred" data-profile-kind="shell" data-available="true">
            <span class="terminal-shell-icon">PS</span>
            <span class="terminal-shell-copy"><strong>PowerShell</strong><small>Default shell</small></span>
            <span class="terminal-shell-badge">Default</span>
          </button>
          <button type="button" class="terminal-shell-card ai-cli" data-profile-kind="ai-cli" data-available="true">
            <span class="terminal-shell-icon">AI</span>
            <span class="terminal-shell-copy"><strong>Codex CLI</strong><small>AI coding terminal</small></span>
            <span class="terminal-shell-badge ai">AI CLI</span>
          </button>
          <button type="button" class="terminal-shell-card unavailable" data-profile-kind="shell" data-available="false" disabled>
            <span class="terminal-shell-icon">WSL</span>
            <span class="terminal-shell-copy"><strong>WSL</strong><small>Executable not found</small></span>
            <span class="terminal-shell-badge missing">Not found</span>
          </button>
          <div class="terminal-shell-loading"><span class="ai-spinner"></span><span>Detecting profiles</span></div>
          <div class="terminal-shell-empty">No additional shell profiles detected.</div>
        </div>
      </div>
      <div class="terminal-pty-stage" style="position: relative; width: 100%; height: 150px; margin-top: 12px;">
        <div class="terminal-pty-empty">
          <strong>No terminal session</strong>
          <span>Choose a shell to start.</span>
          <button type="button">Select shell</button>
        </div>
      </div>
    `;
    document.body.appendChild(fixture);
  });

  const fixture = win.locator('[data-terminal-theme-fixture]');
  await expect(fixture).toBeVisible({ timeout: 3000 });
  return fixture;
}

async function terminalFixtureChrome(fixture: Locator) {
  return {
    popover: await surfaceChrome(fixture.locator('.terminal-new-popover')),
    cwdInput: await surfaceChrome(fixture.locator('.terminal-new-cwd input')),
    preferredCard: await surfaceChrome(fixture.locator('.terminal-shell-card.preferred')),
    aiCard: await surfaceChrome(fixture.locator('.terminal-shell-card.ai-cli')),
    unavailableCard: await surfaceChrome(fixture.locator('.terminal-shell-card.unavailable')),
    defaultBadge: await surfaceChrome(fixture.locator('.terminal-shell-badge').first()),
    aiBadge: await surfaceChrome(fixture.locator('.terminal-shell-badge.ai')),
    missingBadge: await surfaceChrome(fixture.locator('.terminal-shell-badge.missing')),
    loading: await surfaceChrome(fixture.locator('.terminal-shell-loading')),
    shellEmpty: await surfaceChrome(fixture.locator('.terminal-shell-empty')),
    ptyEmpty: await surfaceChrome(fixture.locator('.terminal-pty-empty')),
    emptyButton: await surfaceChrome(fixture.locator('.terminal-pty-empty button')),
  };
}

function expectTerminalChromeClean(chrome: Awaited<ReturnType<typeof terminalFixtureChrome>>) {
  for (const surface of [
    chrome.popover,
    chrome.cwdInput,
    chrome.preferredCard,
    chrome.aiCard,
    chrome.unavailableCard,
    chrome.defaultBadge,
    chrome.aiBadge,
    chrome.missingBadge,
    chrome.loading,
    chrome.shellEmpty,
    chrome.ptyEmpty,
    chrome.emptyButton,
  ]) {
    expectCleanSoftChrome(surface);
  }
}

test('default OrPAD Hero theme is first-class and switching theme changes --bg-primary', async () => {
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await resetSavedTheme(win);

    const beforeVars = await rootVars(win, ['--bg-primary', '--bg-secondary', '--accent-color']);
    expect(beforeVars['--bg-primary']).toBe(HERO_VARS.bgPrimary);
    expect(beforeVars['--bg-secondary']).toBe(HERO_VARS.bgSecondary);
    expect(beforeVars['--accent-color']).toBe(HERO_VARS.accentColor);

    // Open the theme panel
    await win.click('#btn-theme');
    await expect(win.locator('#theme-panel')).toBeVisible({ timeout: 5000 });
    const heroTheme = win.locator('#theme-list .theme-item').filter({ hasText: 'OrPAD Hero' });
    await expect(heroTheme).toBeVisible({ timeout: 3000 });
    await expect(heroTheme).toHaveClass(/active/);

    // Click a built-in theme that is NOT the current active one.
    // "GitHub Light" has a bright background that differs from the dark default.
    const githubLight = win.locator('#theme-list .theme-item').filter({ hasText: 'GitHub Light' });
    await expect(githubLight).toBeVisible({ timeout: 3000 });
    await githubLight.click();

    const afterVars = await rootVars(win, ['--bg-primary']);
    expect(afterVars['--bg-primary']).not.toBe(beforeVars['--bg-primary']);
  } finally {
    await app.close();
  }
});

test('VM Harness dashboard chrome follows light theme tokens', async () => {
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await resetSavedTheme(win);

    const dashboard = await installVmHarnessFixture(win);
    const beforeVars = await rootVars(win, ['--bg-primary', '--bg-secondary', '--border-color', '--text-primary', '--accent-color']);
    const beforeChrome = await vmHarnessChrome(dashboard);

    await switchToTheme(win, 'GitHub Light');

    const afterVars = await rootVars(win, ['--bg-primary', '--bg-secondary', '--border-color', '--text-primary', '--accent-color']);
    expect(afterVars['--bg-primary']).not.toBe(beforeVars['--bg-primary']);
    expect(afterVars['--bg-secondary']).not.toBe(beforeVars['--bg-secondary']);
    expect(afterVars['--border-color']).not.toBe(beforeVars['--border-color']);
    expect(afterVars['--text-primary']).not.toBe(beforeVars['--text-primary']);
    expect(afterVars['--accent-color']).not.toBe(beforeVars['--accent-color']);

    const afterChrome = await vmHarnessChrome(dashboard);
    expectCleanSoftChrome(afterChrome.dashboard);
    expectThemeResponsiveChrome(beforeChrome.dashboard, afterChrome.dashboard);
    expectThemeResponsiveChrome(beforeChrome.stage, afterChrome.stage);
    expectThemeResponsiveChrome(beforeChrome.metric, afterChrome.metric);
    expectThemeResponsiveChrome(beforeChrome.chip, afterChrome.chip);
    expectThemeResponsiveChrome(beforeChrome.action, afterChrome.action);
  } finally {
    await app.close();
  }
});

test('orchestration graph edge connectors follow theme tokens', async () => {
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await resetSavedTheme(win);

    const fixture = await installOrchestrationEdgeFixture(win);
    const beforeStrokes = await orchestrationEdgeStrokes(fixture);
    expectVisibleEdgeStrokes(beforeStrokes);

    await switchToTheme(win, 'GitHub Light');

    const afterStrokes = await orchestrationEdgeStrokes(fixture);
    expectVisibleEdgeStrokes(afterStrokes);
    for (const category of Object.keys(beforeStrokes)) {
      expect(afterStrokes[category]).not.toBe(beforeStrokes[category]);
    }
  } finally {
    await app.close();
  }
});

test('terminal picker and empty state chrome follow Hero and GitHub Light tokens', async () => {
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await resetSavedTheme(win);

    const fixture = await installTerminalChromeFixture(win);
    const beforeVars = await rootVars(win, ['--bg-primary', '--bg-secondary', '--border-color', '--text-primary', '--accent-color']);
    const beforeChrome = await terminalFixtureChrome(fixture);
    expectTerminalChromeClean(beforeChrome);

    await switchToTheme(win, 'GitHub Light');

    const afterVars = await rootVars(win, ['--bg-primary', '--bg-secondary', '--border-color', '--text-primary', '--accent-color']);
    expect(afterVars['--bg-primary']).not.toBe(beforeVars['--bg-primary']);
    expect(afterVars['--bg-secondary']).not.toBe(beforeVars['--bg-secondary']);
    expect(afterVars['--border-color']).not.toBe(beforeVars['--border-color']);
    expect(afterVars['--text-primary']).not.toBe(beforeVars['--text-primary']);
    expect(afterVars['--accent-color']).not.toBe(beforeVars['--accent-color']);

    const afterChrome = await terminalFixtureChrome(fixture);
    expectTerminalChromeClean(afterChrome);
    expectThemeResponsiveChrome(beforeChrome.popover, afterChrome.popover);
    expectThemeResponsiveChrome(beforeChrome.cwdInput, afterChrome.cwdInput);
    expectThemeResponsiveChrome(beforeChrome.preferredCard, afterChrome.preferredCard);
    expectThemeResponsiveChrome(beforeChrome.aiCard, afterChrome.aiCard);
    expectThemeResponsiveChrome(beforeChrome.unavailableCard, afterChrome.unavailableCard);
    expectThemeResponsiveChrome(beforeChrome.defaultBadge, afterChrome.defaultBadge);
    expectThemeResponsiveChrome(beforeChrome.aiBadge, afterChrome.aiBadge);
    expectThemeResponsiveChrome(beforeChrome.loading, afterChrome.loading);
    expectThemeResponsiveChrome(beforeChrome.shellEmpty, afterChrome.shellEmpty);
    expectThemeResponsiveChrome(beforeChrome.ptyEmpty, afterChrome.ptyEmpty);
    expectThemeResponsiveChrome(beforeChrome.emptyButton, afterChrome.emptyButton);
  } finally {
    await app.close();
  }
});

test('OrPAD Hero paints command palette and terminal chrome', async () => {
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await resetSavedTheme(win);

    await openCommandPalette(win);
    const paletteChrome = await surfaceChrome(win.locator('.cmdk-shell'));
    expectCleanSoftChrome(paletteChrome);
    await win.keyboard.press('Escape');

    await win.locator('#btn-terminal').click();
    await expect(win.locator('.terminal-panel')).toBeVisible({ timeout: 5000 });
    const terminalChrome = await surfaceChrome(win.locator('.terminal-panel'));
    expectCleanSoftChrome(terminalChrome);
  } finally {
    await app.close();
  }
});
