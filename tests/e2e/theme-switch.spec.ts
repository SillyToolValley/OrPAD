import { test, expect, type Locator, type Page } from '@playwright/test';
import { launchElectron } from '../helpers';

const HERO_VARS = {
  bgPrimary: '#050b1f',
  bgSecondary: '#0b1530',
  accentColor: '#38a3ff',
  successColor: '#73e6c2',
  warningColor: '#b8d8ff',
  dangerColor: '#ff8ba7',
  breakpointColor: '#ff8ba7',
};

const RUNTIME_STEP_STATES = ['completed', 'failed', 'blocked'] as const;
const RUNTIME_STEP_TOKEN_BY_STATE = {
  completed: '--syntax-string',
  failed: '--syntax-deleted',
  blocked: '--syntax-meta',
} as const;
const CSS_COLOR_VALUE_PATTERN = /^(?:rgb|rgba|color\(|oklab\(|oklch\()/;

async function rootVars(win: Page, names: string[]) {
  return win.evaluate((varNames: string[]) => {
    const styles = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      varNames.map(name => [name, styles.getPropertyValue(name).trim()]),
    );
  }, names);
}

async function resolvedRootColors(win: Page, names: string[]) {
  return win.evaluate((varNames: string[]) => {
    const styles = getComputedStyle(document.documentElement);
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);
    const entries = varNames.map(name => {
      probe.style.color = '';
      probe.style.color = styles.getPropertyValue(name).trim();
      return [name, getComputedStyle(probe).color];
    });
    probe.remove();
    return Object.fromEntries(entries);
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

async function installEditorSearchFixture(win: Page) {
  await win.evaluate(() => {
    document.querySelector('[data-editor-search-theme-fixture]')?.remove();
    const fixture = document.createElement('div');
    fixture.setAttribute('data-editor-search-theme-fixture', '');
    fixture.style.position = 'fixed';
    fixture.style.left = '24px';
    fixture.style.top = '24px';
    fixture.style.zIndex = '2147483000';
    fixture.style.width = '420px';
    fixture.style.height = '112px';
    fixture.innerHTML = `
      <div class="cm-editor">
        <div class="cm-scroller">
          <div class="cm-content">
            <div class="cm-line">
              <span class="cm-searchMatch" data-editor-search-match>pipeline</span>
              <span class="cm-searchMatch cm-searchMatch-selected" data-editor-search-selected>builder</span>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(fixture);
  });

  const fixture = win.locator('[data-editor-search-theme-fixture]');
  await expect(fixture).toBeVisible({ timeout: 3000 });
  return fixture;
}

async function editorSearchHighlightChrome(fixture: Locator) {
  return fixture.evaluate((root: Element) => {
    const readChrome = (selector: string) => {
      const el = root.querySelector(selector);
      if (!el) throw new Error(`Missing editor search fixture selector: ${selector}`);
      const styles = getComputedStyle(el);
      return {
        backgroundColor: styles.backgroundColor,
        backgroundImage: styles.backgroundImage,
        color: styles.color,
        outlineColor: styles.outlineColor,
        outlineStyle: styles.outlineStyle,
        outlineWidth: styles.outlineWidth,
      };
    };

    return {
      editor: readChrome('.cm-editor'),
      match: readChrome('[data-editor-search-match]'),
      selected: readChrome('[data-editor-search-selected]'),
    };
  });
}

function expectEditorSearchHighlightChrome(chrome: Awaited<ReturnType<typeof editorSearchHighlightChrome>>) {
  for (const highlight of [chrome.match, chrome.selected]) {
    expect(highlight.backgroundImage).not.toMatch(/(?:radial|linear)-gradient/);
    expect(highlight.backgroundColor).toMatch(CSS_COLOR_VALUE_PATTERN);
    expect(highlight.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(highlight.backgroundColor).not.toBe(chrome.editor.backgroundColor);
    expect(highlight.backgroundColor).not.toMatch(/255,\s*213,\s*0/);
    expect(highlight.color).toMatch(CSS_COLOR_VALUE_PATTERN);
    expect(highlight.color).not.toBe(highlight.backgroundColor);
    expect(highlight.outlineColor).toMatch(CSS_COLOR_VALUE_PATTERN);
    expect(highlight.outlineStyle).not.toBe('none');
    expect(parseFloat(highlight.outlineWidth)).toBeGreaterThan(0);
  }
  expect(chrome.selected.backgroundColor).not.toBe(chrome.match.backgroundColor);
  expect(chrome.selected.outlineColor).not.toBe(chrome.match.outlineColor);
}

function expectCleanSoftChrome(chrome: Awaited<ReturnType<typeof surfaceChrome>>) {
  expect(chrome.backgroundImage).not.toMatch(/(?:radial|linear)-gradient/);
  expect(chrome.backgroundColor).toMatch(CSS_COLOR_VALUE_PATTERN);
  expect(chrome.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(chrome.borderColor).toMatch(CSS_COLOR_VALUE_PATTERN);
  expect(chrome.borderStyle).not.toBe('none');
  expect(parseFloat(chrome.borderWidth)).toBeGreaterThan(0);
  expect(chrome.boxShadow).not.toBe('none');
  expect(chrome.color).toMatch(CSS_COLOR_VALUE_PATTERN);
}

function expectThemeResponsiveChrome(
  before: Awaited<ReturnType<typeof surfaceChrome>>,
  after: Awaited<ReturnType<typeof surfaceChrome>>,
) {
  expect(after.backgroundImage).not.toMatch(/(?:radial|linear)-gradient/);
  expect(after.backgroundColor).toMatch(CSS_COLOR_VALUE_PATTERN);
  expect(after.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(after.backgroundColor).not.toBe(before.backgroundColor);
  expect(after.borderColor).toMatch(CSS_COLOR_VALUE_PATTERN);
  expect(after.borderColor).not.toBe(before.borderColor);
  expect(after.borderStyle).not.toBe('none');
  expect(parseFloat(after.borderWidth)).toBeGreaterThan(0);
  expect(after.color).toMatch(CSS_COLOR_VALUE_PATTERN);
  expect(after.color).not.toBe(before.color);
}

async function openCommandPalette(win: Page) {
  await win.evaluate(async () => {
    const commands = (window as any).orpadCommands;
    if (!commands?.runCommand) return;
    for (const id of ['commandPalette.open', 'commands.openPalette', 'quickOpen.open', 'file.quickOpen']) {
      try {
        await commands.runCommand(id);
        if (document.querySelector('.cmdk-shell:not(.quick-open)')) return;
      } catch {
        // Some builds do not register every command alias.
      }
    }
  });

  const shell = win.locator('.cmdk-shell:not(.quick-open)').first();
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
    expect(stroke).toMatch(CSS_COLOR_VALUE_PATTERN);
    expect(stroke).not.toBe('none');
    expect(stroke).not.toBe('rgba(0, 0, 0, 0)');
  }
  expect(new Set(Object.values(strokes)).size).toBeGreaterThan(3);
}

async function installRuntimeStepFixture(win: Page) {
  await win.evaluate(() => {
    document.querySelector('[data-runtime-step-theme-fixture]')?.remove();
    const fixture = document.createElement('div');
    fixture.setAttribute('data-runtime-step-theme-fixture', '');
    fixture.style.position = 'fixed';
    fixture.style.left = '24px';
    fixture.style.top = '24px';
    fixture.style.zIndex = '2147483000';
    fixture.innerHTML = `
      <div class="orch-inspector-runtime-steps">
        <span class="orch-inspector-runtime-step state-completed" data-runtime-step-state="completed">completed</span>
        <span class="orch-inspector-runtime-step state-failed" data-runtime-step-state="failed">failed</span>
        <span class="orch-inspector-runtime-step state-blocked" data-runtime-step-state="blocked">blocked</span>
      </div>
    `;
    document.body.appendChild(fixture);
  });

  const fixture = win.locator('[data-runtime-step-theme-fixture]');
  await expect(fixture).toBeVisible({ timeout: 3000 });
  return fixture;
}

async function runtimeStepChrome(fixture: Locator) {
  const entries = await Promise.all(RUNTIME_STEP_STATES.map(async state => [
    state,
    await fixture.locator(`[data-runtime-step-state="${state}"]`).evaluate((el: Element) => {
      const styles = getComputedStyle(el);
      return {
        backgroundColor: styles.backgroundColor,
        color: styles.color,
      };
    }),
  ]));
  return Object.fromEntries(entries) as Record<typeof RUNTIME_STEP_STATES[number], { backgroundColor: string; color: string }>;
}

function expectRuntimeStepChrome(
  chrome: Awaited<ReturnType<typeof runtimeStepChrome>>,
  tokens: Record<string, string>,
) {
  for (const state of RUNTIME_STEP_STATES) {
    expect(chrome[state].backgroundColor).toMatch(CSS_COLOR_VALUE_PATTERN);
    expect(chrome[state].backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(chrome[state].color).toBe(tokens[RUNTIME_STEP_TOKEN_BY_STATE[state]]);
  }
  expect(new Set(RUNTIME_STEP_STATES.map(state => chrome[state].color)).size).toBe(RUNTIME_STEP_STATES.length);
  expect(new Set(RUNTIME_STEP_STATES.map(state => chrome[state].backgroundColor)).size).toBe(RUNTIME_STEP_STATES.length);
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
          <button type="button" class="terminal-shell-card ai-cli" data-terminal-long-profile data-profile-kind="ai-cli" data-available="true">
            <span class="terminal-shell-icon">AI</span>
            <span class="terminal-shell-copy"><strong>Codex CLI Enterprise Workspace Orchestration Profile With Extended Context</strong><small>Runs LongNestedWorkspaceProfileForTerminalPickerReadabilityValidation sessions</small></span>
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
    aiCard: await surfaceChrome(fixture.locator('.terminal-shell-card.ai-cli').first()),
    unavailableCard: await surfaceChrome(fixture.locator('.terminal-shell-card.unavailable')),
    defaultBadge: await surfaceChrome(fixture.locator('.terminal-shell-badge').first()),
    aiBadge: await surfaceChrome(fixture.locator('.terminal-shell-badge.ai').first()),
    missingBadge: await surfaceChrome(fixture.locator('.terminal-shell-badge.missing')),
    loading: await surfaceChrome(fixture.locator('.terminal-shell-loading')),
    shellEmpty: await surfaceChrome(fixture.locator('.terminal-shell-empty')),
    ptyEmpty: await surfaceChrome(fixture.locator('.terminal-pty-empty')),
    emptyButton: await surfaceChrome(fixture.locator('.terminal-pty-empty button')),
  };
}

async function terminalLongProfileLayout(fixture: Locator) {
  return fixture.locator('[data-terminal-long-profile]').evaluate((card: Element) => {
    const strong = card.querySelector('.terminal-shell-copy strong') as HTMLElement;
    const small = card.querySelector('.terminal-shell-copy small') as HTMLElement;
    const icon = card.querySelector('.terminal-shell-icon') as HTMLElement;
    const badge = card.querySelector('.terminal-shell-badge') as HTMLElement;
    const cardRect = card.getBoundingClientRect();
    const strongRect = strong.getBoundingClientRect();
    const smallRect = small.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    const badgeRect = badge.getBoundingClientRect();
    const strongStyles = getComputedStyle(strong);
    const smallStyles = getComputedStyle(small);
    const iconStyles = getComputedStyle(icon);
    const badgeStyles = getComputedStyle(badge);
    const lineHeight = (el: HTMLElement, styles: CSSStyleDeclaration) => {
      const parsed = parseFloat(styles.lineHeight);
      return Number.isFinite(parsed) ? parsed : parseFloat(styles.fontSize);
    };
    const insideCard = (rect: DOMRect) => (
      rect.left >= cardRect.left - 0.5
      && rect.right <= cardRect.right + 0.5
      && rect.top >= cardRect.top - 0.5
      && rect.bottom <= cardRect.bottom + 0.5
    );

    return {
      strongInsideCard: insideCard(strongRect),
      smallInsideCard: insideCard(smallRect),
      strongDoesNotRunUnderBadge: strongRect.right <= badgeRect.left - 4,
      smallDoesNotRunUnderBadge: smallRect.right <= badgeRect.left - 4,
      strongWhiteSpace: strongStyles.whiteSpace,
      smallWhiteSpace: smallStyles.whiteSpace,
      strongLineClamp: strongStyles.getPropertyValue('-webkit-line-clamp'),
      smallLineClamp: smallStyles.getPropertyValue('-webkit-line-clamp'),
      strongLineCount: strongRect.height / lineHeight(strong, strongStyles),
      smallLineCount: smallRect.height / lineHeight(small, smallStyles),
      iconWidth: iconRect.width,
      iconHeight: iconRect.height,
      iconCssWidth: parseFloat(iconStyles.width),
      iconCssHeight: parseFloat(iconStyles.height),
      badgeWhiteSpace: badgeStyles.whiteSpace,
      badgeWidth: badgeRect.width,
      badgeHeight: badgeRect.height,
      badgeMaxWidth: parseFloat(badgeStyles.maxWidth),
    };
  });
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

function expectTerminalLongProfileLayout(layout: Awaited<ReturnType<typeof terminalLongProfileLayout>>) {
  expect(layout.strongInsideCard).toBe(true);
  expect(layout.smallInsideCard).toBe(true);
  expect(layout.strongDoesNotRunUnderBadge).toBe(true);
  expect(layout.smallDoesNotRunUnderBadge).toBe(true);
  expect(layout.strongWhiteSpace).not.toBe('nowrap');
  expect(layout.smallWhiteSpace).not.toBe('nowrap');
  expect(layout.strongLineClamp).toBe('2');
  expect(layout.smallLineClamp).toBe('2');
  expect(layout.strongLineCount).toBeGreaterThan(1.5);
  expect(layout.strongLineCount).toBeLessThanOrEqual(2.2);
  expect(layout.smallLineCount).toBeGreaterThan(1.5);
  expect(layout.smallLineCount).toBeLessThanOrEqual(2.2);
  expect(layout.iconWidth).toBeCloseTo(layout.iconCssWidth, 1);
  expect(layout.iconHeight).toBeCloseTo(layout.iconCssHeight, 1);
  expect(layout.badgeWhiteSpace).toBe('nowrap');
  expect(layout.badgeWidth).toBeLessThanOrEqual(layout.badgeMaxWidth + 1);
  expect(layout.badgeHeight).toBeLessThanOrEqual(layout.iconHeight);
}

async function installPackageManagerThemeFixture(win: Page) {
  await win.evaluate(() => {
    document.querySelector('[data-package-manager-theme-fixture]')?.remove();
    const fixture = document.createElement('div');
    fixture.setAttribute('data-package-manager-theme-fixture', '');
    fixture.style.position = 'fixed';
    fixture.style.left = '18px';
    fixture.style.top = '18px';
    fixture.style.zIndex = '2147483000';
    fixture.style.width = '760px';
    fixture.innerHTML = `
      <div class="node-pack-manager-list" style="max-height: none; overflow: visible;">
        <div class="node-pack-manager-pack node-pack-manager-package-row" data-package-row-state="normal">
          <div class="node-pack-manager-package-row-main">
            <div class="node-pack-manager-pack-title"><strong>Built-in worker pack</strong></div>
            <span class="node-pack-manager-package-maker">orpad.core</span>
          </div>
          <div class="node-pack-manager-package-row-trust">
            <span class="node-pack-manager-trust-chip good">Built-in</span>
          </div>
          <div class="node-pack-manager-package-row-actions"><button type="button">Details</button></div>
        </div>
        <div class="node-pack-manager-pack active node-pack-manager-package-row" data-package-row-state="active">
          <div class="node-pack-manager-package-row-main">
            <div class="node-pack-manager-pack-title"><strong>Selected pack</strong></div>
            <span class="node-pack-manager-package-maker">orpad.selected</span>
          </div>
          <div class="node-pack-manager-package-row-trust">
            <span class="node-pack-manager-trust-chip info">Active</span>
          </div>
          <div class="node-pack-manager-package-row-actions"><button type="button">Open</button></div>
        </div>
        <div class="node-pack-manager-pack node-pack-manager-pack-warn node-pack-manager-package-row" data-package-row-state="warn">
          <div class="node-pack-manager-package-row-main">
            <div class="node-pack-manager-pack-title"><strong>Needs review</strong></div>
            <span class="node-pack-manager-package-maker">community.warning</span>
          </div>
          <div class="node-pack-manager-package-row-trust">
            <span class="node-pack-manager-trust-chip warn">Warning</span>
          </div>
          <div class="node-pack-manager-package-row-actions"><button type="button">Review</button></div>
        </div>
        <div class="node-pack-manager-pack node-pack-manager-pack-danger node-pack-manager-package-row" data-package-row-state="danger">
          <div class="node-pack-manager-package-row-main">
            <div class="node-pack-manager-pack-title"><strong>Blocked risk pack</strong></div>
            <span class="node-pack-manager-package-maker">community.danger</span>
          </div>
          <div class="node-pack-manager-package-row-trust">
            <span class="node-pack-manager-trust-chip danger">Danger</span>
          </div>
          <div class="node-pack-manager-package-row-actions"><button type="button">Inspect</button></div>
        </div>
        <div class="node-pack-manager-pack has-conflict node-pack-manager-package-row" data-package-row-state="conflict">
          <div class="node-pack-manager-package-row-main">
            <div class="node-pack-manager-pack-title"><strong>Conflicting pack</strong></div>
            <span class="node-pack-manager-package-maker">workspace.conflict</span>
          </div>
          <div class="node-pack-manager-package-row-trust">
            <span class="node-pack-manager-trust-chip danger">Conflict</span>
          </div>
          <div class="node-pack-manager-package-row-actions"><button type="button">Resolve</button></div>
        </div>
      </div>
    `;
    document.body.appendChild(fixture);
  });

  const fixture = win.locator('[data-package-manager-theme-fixture]');
  await expect(fixture).toBeVisible({ timeout: 3000 });
  return fixture;
}

async function packageManagerFixtureChrome(fixture: Locator) {
  return fixture.evaluate((root: Element) => {
    const rows = Array.from(root.querySelectorAll('[data-package-row-state]'));
    return Object.fromEntries(rows.map(row => {
      const styles = getComputedStyle(row);
      const rail = getComputedStyle(row, '::before');
      return [
        row.getAttribute('data-package-row-state') || '',
        {
          backgroundImage: styles.backgroundImage,
          backgroundColor: styles.backgroundColor,
          borderColor: styles.borderColor,
          borderStyle: styles.borderStyle,
          borderWidth: styles.borderWidth,
          boxShadow: styles.boxShadow,
          color: styles.color,
          railColor: rail.backgroundColor,
          railWidth: rail.width,
          clientWidth: row.clientWidth,
          scrollWidth: row.scrollWidth,
        },
      ];
    }));
  });
}

function expectPackageManagerRowsClean(chrome: Awaited<ReturnType<typeof packageManagerFixtureChrome>>) {
  for (const state of ['normal', 'active', 'warn', 'danger', 'conflict']) {
    const row = chrome[state];
    expect(row.backgroundImage).not.toMatch(/(?:radial|linear)-gradient/);
    expect(row.backgroundColor).toMatch(CSS_COLOR_VALUE_PATTERN);
    expect(row.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(row.borderColor).toMatch(CSS_COLOR_VALUE_PATTERN);
    expect(row.borderStyle).not.toBe('none');
    expect(parseFloat(row.borderWidth)).toBeGreaterThan(0);
    expect(row.boxShadow).toBe('none');
    expect(row.color).toMatch(CSS_COLOR_VALUE_PATTERN);
    expect(row.railColor).toMatch(CSS_COLOR_VALUE_PATTERN);
    expect(row.railColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(parseFloat(row.railWidth)).toBeGreaterThan(0);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  }
}

async function installDangerThemeFixture(win: Page) {
  await win.evaluate(() => {
    document.querySelector('[data-danger-theme-fixture]')?.remove();
    const fixture = document.createElement('div');
    fixture.setAttribute('data-danger-theme-fixture', '');
    fixture.style.position = 'fixed';
    fixture.style.left = '20px';
    fixture.style.bottom = '20px';
    fixture.style.zIndex = '2147483000';
    fixture.style.width = '280px';
    fixture.style.pointerEvents = 'none';
    fixture.innerHTML = `
      <div class="pipeline-inline-diagnostic" role="status">
        Danger token fixture
      </div>
    `;
    document.body.appendChild(fixture);
  });

  const diagnostic = win.locator('[data-danger-theme-fixture] .pipeline-inline-diagnostic');
  await expect(diagnostic).toBeVisible({ timeout: 3000 });
  return diagnostic;
}

async function installWarningStatusFixture(win: Page) {
  await win.evaluate(() => {
    document.querySelector('[data-warning-theme-fixture]')?.remove();
    const fixture = document.createElement('div');
    fixture.setAttribute('data-warning-theme-fixture', '');
    fixture.style.position = 'fixed';
    fixture.style.left = '20px';
    fixture.style.bottom = '76px';
    fixture.style.zIndex = '2147483000';
    fixture.style.pointerEvents = 'none';
    fixture.innerHTML = `
      <button class="template-status-chip warning" type="button">
        Warning token fixture
      </button>
    `;
    document.body.appendChild(fixture);
  });

  const chip = win.locator('[data-warning-theme-fixture] .template-status-chip.warning');
  await expect(chip).toBeVisible({ timeout: 3000 });
  return chip;
}

async function installBreakpointThemeFixture(win: Page) {
  await win.evaluate(() => {
    document.querySelector('[data-breakpoint-theme-fixture]')?.remove();
    const fixture = document.createElement('div');
    fixture.setAttribute('data-breakpoint-theme-fixture', '');
    fixture.style.position = 'fixed';
    fixture.style.left = '20px';
    fixture.style.bottom = '132px';
    fixture.style.zIndex = '2147483000';
    fixture.style.pointerEvents = 'none';
    fixture.innerHTML = `
      <div class="orch-graph-node has-breakpoint" style="position: relative; width: 96px; height: 56px;">
        <span class="orch-graph-node-breakpoint">!</span>
      </div>
      <button class="pipe-breakpoint-active" type="button">Breakpoint</button>
    `;
    document.body.appendChild(fixture);
  });

  const fixture = win.locator('[data-breakpoint-theme-fixture]');
  await expect(fixture).toBeVisible({ timeout: 3000 });
  return fixture;
}

async function warningChipChrome(locator: Locator) {
  return locator.evaluate((el: Element) => {
    const styles = getComputedStyle(el);
    return {
      backgroundColor: styles.backgroundColor,
      borderColor: styles.borderColor,
      borderStyle: styles.borderStyle,
      borderWidth: styles.borderWidth,
      color: styles.color,
    };
  });
}

function expectWarningChipChrome(chrome: Awaited<ReturnType<typeof warningChipChrome>>) {
  expect(chrome.backgroundColor).toMatch(CSS_COLOR_VALUE_PATTERN);
  expect(chrome.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(chrome.borderColor).toMatch(CSS_COLOR_VALUE_PATTERN);
  expect(chrome.borderStyle).not.toBe('none');
  expect(parseFloat(chrome.borderWidth)).toBeGreaterThan(0);
  expect(chrome.color).toMatch(CSS_COLOR_VALUE_PATTERN);
}

async function breakpointChrome(fixture: Locator) {
  return fixture.evaluate((root: Element) => {
    const marker = root.querySelector('.orch-graph-node-breakpoint');
    const node = root.querySelector('.orch-graph-node.has-breakpoint');
    const active = root.querySelector('.pipe-breakpoint-active');
    if (!marker || !node || !active) throw new Error('Missing breakpoint theme fixture element');
    const markerStyles = getComputedStyle(marker);
    const nodeStyles = getComputedStyle(node);
    const activeStyles = getComputedStyle(active);
    return {
      markerBackgroundColor: markerStyles.backgroundColor,
      markerColor: markerStyles.color,
      nodeOutlineColor: nodeStyles.outlineColor,
      activeBackgroundColor: activeStyles.backgroundColor,
      activeBorderColor: activeStyles.borderColor,
      activeColor: activeStyles.color,
    };
  });
}

function expectBreakpointChrome(
  chrome: Awaited<ReturnType<typeof breakpointChrome>>,
  breakpointColor: string,
  foregroundColor: string,
) {
  expect(chrome.markerBackgroundColor).toBe(breakpointColor);
  expect(chrome.markerColor).toBe(foregroundColor);
  expect(chrome.nodeOutlineColor).toMatch(CSS_COLOR_VALUE_PATTERN);
  expect(chrome.nodeOutlineColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(chrome.activeBackgroundColor).toMatch(CSS_COLOR_VALUE_PATTERN);
  expect(chrome.activeBackgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(chrome.activeBorderColor).toMatch(CSS_COLOR_VALUE_PATTERN);
  expect(chrome.activeColor).toBe(breakpointColor);
}

async function dangerChrome(locator: Locator) {
  return locator.evaluate((el: Element) => {
    const styles = getComputedStyle(el);
    return {
      backgroundColor: styles.backgroundColor,
      borderLeftColor: styles.borderLeftColor,
      borderLeftWidth: styles.borderLeftWidth,
      color: styles.color,
    };
  });
}

function expectDangerChrome(chrome: Awaited<ReturnType<typeof dangerChrome>>) {
  expect(chrome.backgroundColor).toMatch(CSS_COLOR_VALUE_PATTERN);
  expect(chrome.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(chrome.borderLeftColor).toBe(chrome.color);
  expect(parseFloat(chrome.borderLeftWidth)).toBeGreaterThan(0);
  expect(chrome.color).toMatch(CSS_COLOR_VALUE_PATTERN);
}

async function installRunbookSuccessFixture(win: Page) {
  await win.evaluate(() => {
    document.querySelector('[data-runbook-success-theme-fixture]')?.remove();
    const fixture = document.createElement('div');
    fixture.setAttribute('data-runbook-success-theme-fixture', '');
    fixture.style.position = 'fixed';
    fixture.style.left = '20px';
    fixture.style.top = '20px';
    fixture.style.zIndex = '2147483000';
    fixture.style.width = '460px';
    fixture.innerHTML = `
      <div class="runbook-action-row">
        <button class="cta-ready" type="button">Continue</button>
        <button type="button">Neutral</button>
      </div>
      <div class="pipe-failed-probe-actions">
        <button class="pipe-failed-probe-retry" type="button">Retry probe</button>
        <button class="pipe-failed-probe-skip" type="button">Skip probe</button>
      </div>
      <div class="runbook-replay-events-bar">
        <button class="runbook-replay-stick-toggle active" type="button">Live tail</button>
        <button class="runbook-replay-timeline-live" type="button">Live</button>
      </div>
      <div class="runbook-chip good">Ready</div>
      <div class="runbook-generate-status good">generated</div>
      <div class="runbook-latest-run-summary good">latest run ready</div>
      <div class="runbook-guide good">good guide</div>
      <div class="runbook-replay-events">
        <div class="runbook-event runbook-event-fresh">fresh event</div>
        <div class="runbook-event">neutral event</div>
      </div>
      <div class="runbook-diagnostics">
        <div class="runbook-diagnostic good">good diagnostic</div>
        <div class="runbook-diagnostic warning">warning diagnostic</div>
      </div>
    `;
    document.body.appendChild(fixture);
  });

  const fixture = win.locator('[data-runbook-success-theme-fixture]');
  await expect(fixture).toBeVisible({ timeout: 3000 });
  return fixture;
}

async function runbookSuccessChrome(fixture: Locator) {
  return fixture.evaluate((root: Element) => {
    const sample = (selector: string, pseudo?: string) => {
      const el = root.querySelector(selector);
      if (!el) throw new Error(`Missing runbook fixture selector: ${selector}`);
      const styles = getComputedStyle(el, pseudo);
      return {
        backgroundColor: styles.backgroundColor,
        borderColor: styles.borderColor,
        borderLeftColor: styles.borderLeftColor,
        borderStyle: styles.borderStyle,
        borderWidth: styles.borderWidth,
        color: styles.color,
      };
    };

    return {
      readyAction: sample('.runbook-action-row .cta-ready'),
      neutralAction: sample('.runbook-action-row button:not(.cta-ready)'),
      retryProbe: sample('.pipe-failed-probe-retry'),
      skipProbe: sample('.pipe-failed-probe-skip'),
      stickToggle: sample('.runbook-replay-stick-toggle.active'),
      stickToggleMarker: sample('.runbook-replay-stick-toggle.active', '::before'),
      timelineLive: sample('.runbook-replay-timeline-live'),
      goodChip: sample('.runbook-chip.good'),
      generateStatus: sample('.runbook-generate-status.good'),
      latestSummary: sample('.runbook-latest-run-summary.good'),
      guide: sample('.runbook-guide.good'),
      freshEvent: sample('.runbook-event-fresh'),
      neutralEvent: sample('.runbook-event:not(.runbook-event-fresh)'),
      goodDiagnostic: sample('.runbook-diagnostic.good'),
      warningDiagnostic: sample('.runbook-diagnostic.warning'),
    };
  });
}

function expectRunbookSuccessChrome(
  chrome: Awaited<ReturnType<typeof runbookSuccessChrome>>,
  successColor: string,
) {
  expect(chrome.readyAction.color).toBe(successColor);
  expect(chrome.retryProbe.color).toBe(successColor);
  expect(chrome.stickToggle.color).toBe(successColor);
  expect(chrome.stickToggleMarker.color).toBe(successColor);
  expect(chrome.timelineLive.color).toBe(successColor);
  expect(chrome.goodChip.color).toBe(successColor);
  expect(chrome.generateStatus.borderLeftColor).toBe(successColor);
  expect(chrome.latestSummary.borderLeftColor).toBe(successColor);
  expect(chrome.guide.borderLeftColor).toBe(successColor);
  expect(chrome.goodDiagnostic.borderLeftColor).toBe(successColor);

  expect(chrome.readyAction.color).not.toBe(chrome.neutralAction.color);
  expect(chrome.retryProbe.color).not.toBe(chrome.skipProbe.color);
  expect(chrome.stickToggle.color).not.toBe(chrome.neutralAction.color);
  expect(chrome.timelineLive.color).not.toBe(chrome.neutralAction.color);
  expect(chrome.goodDiagnostic.borderLeftColor).not.toBe(chrome.warningDiagnostic.borderLeftColor);
  expect(chrome.freshEvent.borderLeftColor).not.toBe(chrome.neutralEvent.borderLeftColor);
  expect(chrome.freshEvent.backgroundColor).toMatch(CSS_COLOR_VALUE_PATTERN);
  expect(chrome.readyAction.borderStyle).not.toBe('none');
  expect(parseFloat(chrome.readyAction.borderWidth)).toBeGreaterThan(0);
  expect(chrome.retryProbe.borderStyle).not.toBe('none');
  expect(parseFloat(chrome.retryProbe.borderWidth)).toBeGreaterThan(0);
}

async function installManagedRunActionFixture(win: Page) {
  await win.evaluate(() => {
    document.querySelector('[data-managed-run-action-theme-fixture]')?.remove();
    const fixture = document.createElement('div');
    fixture.setAttribute('data-managed-run-action-theme-fixture', '');
    fixture.style.position = 'fixed';
    fixture.style.left = '20px';
    fixture.style.top = '20px';
    fixture.style.zIndex = '2147483000';
    fixture.style.width = '460px';
    fixture.innerHTML = `
      <div class="pipe-failed-probe-actions">
        <button class="pipe-failed-probe-link" type="button">events.jsonl</button>
      </div>
      <div class="pipe-lifecycle-banner">
        <div class="pipe-lifecycle-banner-title">Run blocked</div>
        <div class="pipe-lifecycle-banner-actions">
          <button class="pipe-lifecycle-banner-link" type="button">Review patches</button>
        </div>
      </div>
      <div class="pipe-patch-outcome">
        <div class="pipe-patch-outcome-counts"><span>2 approved</span><span>1 rejected</span></div>
        <div class="pipe-patch-outcome-row"><span>Accepted</span><div class="pipe-patch-outcome-files"><code>base.css</code></div></div>
      </div>
    `;
    document.body.appendChild(fixture);
  });

  const fixture = win.locator('[data-managed-run-action-theme-fixture]');
  await expect(fixture).toBeVisible({ timeout: 3000 });
  return fixture;
}

async function managedRunActionChrome(fixture: Locator) {
  return {
    failedProbeLink: await surfaceChrome(fixture.locator('.pipe-failed-probe-link').first()),
    lifecycleLink: await surfaceChrome(fixture.locator('.pipe-lifecycle-banner-link').first()),
    patchOutcome: await surfaceChrome(fixture.locator('.pipe-patch-outcome').first()),
  };
}

function expectManagedRunActionChromeClean(chrome: Awaited<ReturnType<typeof managedRunActionChrome>>) {
  for (const surface of [chrome.failedProbeLink, chrome.lifecycleLink, chrome.patchOutcome]) {
    expect(surface.backgroundImage).not.toMatch(/(?:radial|linear)-gradient/);
    expect(surface.backgroundColor).toMatch(CSS_COLOR_VALUE_PATTERN);
    expect(surface.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(surface.borderColor).toMatch(CSS_COLOR_VALUE_PATTERN);
    expect(surface.borderStyle).not.toBe('none');
    expect(parseFloat(surface.borderWidth)).toBeGreaterThan(0);
    expect(surface.color).toMatch(CSS_COLOR_VALUE_PATTERN);
  }
}

test('default OrPAD Hero theme is first-class and switching theme changes --bg-primary', async () => {
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await resetSavedTheme(win);

    const beforeVars = await rootVars(win, [
      '--bg-primary',
      '--bg-secondary',
      '--accent-color',
      '--success-color',
      '--warning-color',
      '--danger-color',
      '--breakpoint-color',
    ]);
    expect(beforeVars['--bg-primary']).toBe(HERO_VARS.bgPrimary);
    expect(beforeVars['--bg-secondary']).toBe(HERO_VARS.bgSecondary);
    expect(beforeVars['--accent-color']).toBe(HERO_VARS.accentColor);
    expect(beforeVars['--success-color']).toBe(HERO_VARS.successColor);
    expect(beforeVars['--warning-color']).toBe(HERO_VARS.warningColor);
    expect(beforeVars['--danger-color']).toBe(HERO_VARS.dangerColor);
    expect(beforeVars['--breakpoint-color']).toBe(HERO_VARS.breakpointColor);

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

test('editor search highlights follow theme tokens', async () => {
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await resetSavedTheme(win);

    const fixture = await installEditorSearchFixture(win);
    const beforeVars = await rootVars(win, ['--editor-bg', '--accent-color', '--text-primary']);
    const beforeChrome = await editorSearchHighlightChrome(fixture);
    expectEditorSearchHighlightChrome(beforeChrome);

    await switchToTheme(win, 'GitHub Light');

    const afterVars = await rootVars(win, ['--editor-bg', '--accent-color', '--text-primary']);
    expect(afterVars['--editor-bg']).not.toBe(beforeVars['--editor-bg']);
    expect(afterVars['--accent-color']).not.toBe(beforeVars['--accent-color']);
    expect(afterVars['--text-primary']).not.toBe(beforeVars['--text-primary']);

    const afterChrome = await editorSearchHighlightChrome(fixture);
    expectEditorSearchHighlightChrome(afterChrome);
    expect(afterChrome.match.backgroundColor).not.toBe(beforeChrome.match.backgroundColor);
    expect(afterChrome.match.outlineColor).not.toBe(beforeChrome.match.outlineColor);
    expect(afterChrome.selected.backgroundColor).not.toBe(beforeChrome.selected.backgroundColor);
    expect(afterChrome.selected.outlineColor).not.toBe(beforeChrome.selected.outlineColor);
    expect(afterChrome.match.color).not.toBe(beforeChrome.match.color);
    expect(afterChrome.selected.color).not.toBe(beforeChrome.selected.color);
  } finally {
    await app.close();
  }
});

test('managed-run action chrome follows theme switches', async () => {
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await resetSavedTheme(win);

    const fixture = await installManagedRunActionFixture(win);
    const beforeVars = await rootVars(win, ['--bg-primary', '--border-color', '--text-primary']);
    const beforeChrome = await managedRunActionChrome(fixture);
    expectManagedRunActionChromeClean(beforeChrome);

    await switchToTheme(win, 'GitHub Light');

    const afterVars = await rootVars(win, ['--bg-primary', '--border-color', '--text-primary']);
    expect(afterVars['--bg-primary']).not.toBe(beforeVars['--bg-primary']);
    expect(afterVars['--border-color']).not.toBe(beforeVars['--border-color']);
    expect(afterVars['--text-primary']).not.toBe(beforeVars['--text-primary']);

    const afterChrome = await managedRunActionChrome(fixture);
    expectManagedRunActionChromeClean(afterChrome);
    for (const surface of ['failedProbeLink', 'lifecycleLink', 'patchOutcome'] as const) {
      expect(afterChrome[surface].backgroundColor).not.toBe(beforeChrome[surface].backgroundColor);
      expect(afterChrome[surface].borderColor).not.toBe(beforeChrome[surface].borderColor);
      expect(afterChrome[surface].color).not.toBe(beforeChrome[surface].color);
    }
  } finally {
    await app.close();
  }
});

test('semantic status tokens and warning/danger/breakpoint chrome follow theme switches', async () => {
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await resetSavedTheme(win);

    const warningChip = await installWarningStatusFixture(win);
    const diagnostic = await installDangerThemeFixture(win);
    const breakpointFixture = await installBreakpointThemeFixture(win);
    const beforeVars = await rootVars(win, [
      '--success-color',
      '--syntax-added',
      '--warning-color',
      '--syntax-meta',
      '--danger-color',
      '--syntax-deleted',
      '--breakpoint-color',
    ]);
    expect(beforeVars['--success-color']).toBe(beforeVars['--syntax-added']);
    expect(beforeVars['--success-color']).toBe(HERO_VARS.successColor);
    expect(beforeVars['--warning-color']).toBe(beforeVars['--syntax-meta']);
    expect(beforeVars['--warning-color']).toBe(HERO_VARS.warningColor);
    expect(beforeVars['--danger-color']).toBe(beforeVars['--syntax-deleted']);
    expect(beforeVars['--danger-color']).toBe(HERO_VARS.dangerColor);
    expect(beforeVars['--breakpoint-color']).toBe(beforeVars['--danger-color']);
    expect(beforeVars['--breakpoint-color']).toBe(HERO_VARS.breakpointColor);

    const beforeWarningChrome = await warningChipChrome(warningChip);
    expectWarningChipChrome(beforeWarningChrome);
    const beforeChrome = await dangerChrome(diagnostic);
    expectDangerChrome(beforeChrome);
    const beforeResolved = await resolvedRootColors(win, ['--breakpoint-color', '--bg-primary']);
    const beforeBreakpointChrome = await breakpointChrome(breakpointFixture);
    expectBreakpointChrome(
      beforeBreakpointChrome,
      beforeResolved['--breakpoint-color'],
      beforeResolved['--bg-primary'],
    );

    await switchToTheme(win, 'GitHub Light');

    const afterVars = await rootVars(win, [
      '--success-color',
      '--syntax-added',
      '--warning-color',
      '--syntax-meta',
      '--danger-color',
      '--syntax-deleted',
      '--breakpoint-color',
    ]);
    expect(afterVars['--success-color']).toBe(afterVars['--syntax-added']);
    expect(afterVars['--success-color']).toBe('#22863a');
    expect(afterVars['--success-color']).not.toBe(beforeVars['--success-color']);
    expect(afterVars['--warning-color']).toBe(afterVars['--syntax-meta']);
    expect(afterVars['--warning-color']).toBe('#735c0f');
    expect(afterVars['--warning-color']).not.toBe(beforeVars['--warning-color']);
    expect(afterVars['--danger-color']).toBe(afterVars['--syntax-deleted']);
    expect(afterVars['--danger-color']).toBe('#b31d28');
    expect(afterVars['--danger-color']).not.toBe(beforeVars['--danger-color']);
    expect(afterVars['--breakpoint-color']).toBe(afterVars['--danger-color']);
    expect(afterVars['--breakpoint-color']).not.toBe(beforeVars['--breakpoint-color']);

    const afterWarningChrome = await warningChipChrome(warningChip);
    expectWarningChipChrome(afterWarningChrome);
    expect(afterWarningChrome.borderColor).not.toBe(beforeWarningChrome.borderColor);
    expect(afterWarningChrome.color).not.toBe(beforeWarningChrome.color);

    const afterChrome = await dangerChrome(diagnostic);
    expectDangerChrome(afterChrome);
    expect(afterChrome.backgroundColor).not.toBe(beforeChrome.backgroundColor);
    expect(afterChrome.borderLeftColor).not.toBe(beforeChrome.borderLeftColor);
    expect(afterChrome.color).not.toBe(beforeChrome.color);

    const afterResolved = await resolvedRootColors(win, ['--breakpoint-color', '--bg-primary']);
    const afterBreakpointChrome = await breakpointChrome(breakpointFixture);
    expectBreakpointChrome(
      afterBreakpointChrome,
      afterResolved['--breakpoint-color'],
      afterResolved['--bg-primary'],
    );
    expect(afterBreakpointChrome.markerBackgroundColor).not.toBe(beforeBreakpointChrome.markerBackgroundColor);
    expect(afterBreakpointChrome.markerColor).not.toBe(beforeBreakpointChrome.markerColor);
    expect(afterBreakpointChrome.activeColor).not.toBe(beforeBreakpointChrome.activeColor);
  } finally {
    await app.close();
  }
});

test('runbook ready and live success accents follow theme switches', async () => {
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await resetSavedTheme(win);

    const fixture = await installRunbookSuccessFixture(win);
    const beforeTokens = await resolvedRootColors(win, ['--run-monitor-success-color', '--success-color', '--syntax-added', '--warning-color']);
    expect(beforeTokens['--run-monitor-success-color']).toBe(beforeTokens['--success-color']);
    expect(beforeTokens['--success-color']).toBe(beforeTokens['--syntax-added']);
    expect(beforeTokens['--run-monitor-success-color']).not.toBe(beforeTokens['--warning-color']);

    const beforeChrome = await runbookSuccessChrome(fixture);
    expectRunbookSuccessChrome(beforeChrome, beforeTokens['--run-monitor-success-color']);

    await switchToTheme(win, 'GitHub Light');

    const afterTokens = await resolvedRootColors(win, ['--run-monitor-success-color', '--success-color', '--syntax-added', '--warning-color']);
    expect(afterTokens['--run-monitor-success-color']).toBe(afterTokens['--success-color']);
    expect(afterTokens['--success-color']).toBe(afterTokens['--syntax-added']);
    expect(afterTokens['--run-monitor-success-color']).not.toBe(beforeTokens['--run-monitor-success-color']);
    expect(afterTokens['--run-monitor-success-color']).not.toBe(afterTokens['--warning-color']);

    const afterChrome = await runbookSuccessChrome(fixture);
    expectRunbookSuccessChrome(afterChrome, afterTokens['--run-monitor-success-color']);
    expect(afterChrome.readyAction.color).not.toBe(beforeChrome.readyAction.color);
    expect(afterChrome.retryProbe.color).not.toBe(beforeChrome.retryProbe.color);
    expect(afterChrome.stickToggle.color).not.toBe(beforeChrome.stickToggle.color);
    expect(afterChrome.timelineLive.color).not.toBe(beforeChrome.timelineLive.color);
    expect(afterChrome.goodChip.color).not.toBe(beforeChrome.goodChip.color);
    expect(afterChrome.generateStatus.borderLeftColor).not.toBe(beforeChrome.generateStatus.borderLeftColor);
    expect(afterChrome.latestSummary.borderLeftColor).not.toBe(beforeChrome.latestSummary.borderLeftColor);
    expect(afterChrome.guide.borderLeftColor).not.toBe(beforeChrome.guide.borderLeftColor);
    expect(afterChrome.freshEvent.borderLeftColor).not.toBe(beforeChrome.freshEvent.borderLeftColor);
    expect(afterChrome.goodDiagnostic.borderLeftColor).not.toBe(beforeChrome.goodDiagnostic.borderLeftColor);
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

test('orchestration inspector runtime state chips follow theme tokens', async () => {
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await resetSavedTheme(win);

    const fixture = await installRuntimeStepFixture(win);
    const tokenNames = Object.values(RUNTIME_STEP_TOKEN_BY_STATE);
    const beforeTokens = await resolvedRootColors(win, tokenNames);
    const beforeChrome = await runtimeStepChrome(fixture);
    expectRuntimeStepChrome(beforeChrome, beforeTokens);

    await switchToTheme(win, 'GitHub Light');

    const afterTokens = await resolvedRootColors(win, tokenNames);
    const afterChrome = await runtimeStepChrome(fixture);
    expectRuntimeStepChrome(afterChrome, afterTokens);
    for (const state of RUNTIME_STEP_STATES) {
      expect(afterChrome[state].backgroundColor).not.toBe(beforeChrome[state].backgroundColor);
      expect(afterChrome[state].color).not.toBe(beforeChrome[state].color);
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
    expectTerminalLongProfileLayout(await terminalLongProfileLayout(fixture));

    await switchToTheme(win, 'GitHub Light');

    const afterVars = await rootVars(win, ['--bg-primary', '--bg-secondary', '--border-color', '--text-primary', '--accent-color']);
    expect(afterVars['--bg-primary']).not.toBe(beforeVars['--bg-primary']);
    expect(afterVars['--bg-secondary']).not.toBe(beforeVars['--bg-secondary']);
    expect(afterVars['--border-color']).not.toBe(beforeVars['--border-color']);
    expect(afterVars['--text-primary']).not.toBe(beforeVars['--text-primary']);
    expect(afterVars['--accent-color']).not.toBe(beforeVars['--accent-color']);

    const afterChrome = await terminalFixtureChrome(fixture);
    expectTerminalChromeClean(afterChrome);
    expectTerminalLongProfileLayout(await terminalLongProfileLayout(fixture));
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

test('Package Manager row chrome follows Hero and GitHub Light tokens', async () => {
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await resetSavedTheme(win);

    const fixture = await installPackageManagerThemeFixture(win);
    const beforeChrome = await packageManagerFixtureChrome(fixture);
    expectPackageManagerRowsClean(beforeChrome);

    await fixture.evaluate((el: Element) => el.remove());
    await switchToTheme(win, 'GitHub Light');

    const afterFixture = await installPackageManagerThemeFixture(win);
    const afterChrome = await packageManagerFixtureChrome(afterFixture);
    expectPackageManagerRowsClean(afterChrome);
    for (const state of ['normal', 'active', 'warn', 'danger', 'conflict']) {
      expect(afterChrome[state].backgroundColor).not.toBe(beforeChrome[state].backgroundColor);
      expect(afterChrome[state].borderColor).not.toBe(beforeChrome[state].borderColor);
      expect(afterChrome[state].color).not.toBe(beforeChrome[state].color);
      expect(afterChrome[state].railColor).not.toBe(beforeChrome[state].railColor);
    }
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
    const paletteChrome = await surfaceChrome(win.locator('.cmdk-shell:not(.quick-open)').first());
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
