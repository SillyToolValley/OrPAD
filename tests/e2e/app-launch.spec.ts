import { test, expect, _electron as electron, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { attachReliableElectronClose, closeElectronApp, launchElectron } from '../helpers';

type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;

function createOrpadFileLaunchFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-file-launch-'));
  const graphPath = path.join(dir, 'entry.or-graph');
  const pipelinePath = path.join(dir, 'pipeline.or-pipeline');
  const treePath = path.join(dir, 'decision.or-tree');
  const rulePath = path.join(dir, 'guardrail.or-rule');
  const runPath = path.join(dir, 'launch.or-run');

  const graph = JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'entry',
      nodes: [
        { id: 'context', type: 'orpad.context', label: 'Review desktop graph launch' },
        { id: 'gate', type: 'orpad.gate', label: 'Confirm OrPAD association', config: { criteria: ['File launch renders'] } },
      ],
      transitions: [{ from: 'context', to: 'gate' }],
    },
  }, null, 2);

  const pipeline = JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'competitive-file-launch',
    title: 'Competitive file launch fixture',
    trustLevel: 'local-authored',
    entryGraph: 'entry.or-graph',
    graphs: [{ id: 'entry', file: 'entry.or-graph' }],
    run: {
      queueProtocol: {
        schema: 'orpad.workItem.v1',
        states: ['candidate', 'queued', 'claimed', 'done'],
      },
    },
  }, null, 2);

  const tree = JSON.stringify({
    kind: 'orpad.tree',
    version: '1.0',
    id: 'desktop-tree-launch',
    title: 'Desktop tree launch fixture',
    root: {
      id: 'root',
      label: 'Choose desktop launch branch',
      children: [
        { id: 'open-tab', label: 'Tree file launch opens a tab' },
        { id: 'read-content', label: 'Tree fixture content is visible' },
      ],
    },
  }, null, 2);

  const rule = JSON.stringify({
    kind: 'orpad.rule',
    version: '1.0',
    id: 'desktop-rule-launch',
    title: 'Desktop rule launch fixture',
    rule: {
      when: 'file association invokes OrPAD',
      then: 'show rule fixture content',
      checks: ['Rule file launch opens a tab'],
    },
  }, null, 2);

  const run = JSON.stringify({
    kind: 'orpad.run',
    version: '1.0',
    id: 'desktop-run-launch',
    title: 'Desktop run launch fixture',
    status: 'done',
    events: [
      { type: 'launch.argument.received', message: 'Run fixture content is visible' },
      { type: 'document.tab.opened', message: 'Run file launch opens a tab' },
    ],
  }, null, 2);

  fs.writeFileSync(graphPath, graph, 'utf-8');
  fs.writeFileSync(pipelinePath, pipeline, 'utf-8');
  fs.writeFileSync(treePath, tree, 'utf-8');
  fs.writeFileSync(rulePath, rule, 'utf-8');
  fs.writeFileSync(runPath, run, 'utf-8');

  return { dir, graphPath, pipelinePath, treePath, rulePath, runPath };
}

async function launchElectronWithFileArg(filePath: string) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-file-launch-user-data-'));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = attachReliableElectronClose(await electron.launch({
      args: [path.resolve('src/main/main.js'), filePath],
      env: {
        ...process.env,
        ORPAD_TEST_USER_DATA: userData,
      },
    }), userData);
    return { app, userData };
  } catch (err) {
    await closeElectronApp(app);
    if (!app) {
      fs.rmSync(userData, { recursive: true, force: true });
    }
    throw err;
  }
}

async function detachTerminalWindow(app: ElectronApp, win: Page) {
  await win.locator('#btn-terminal').click();
  await expect(win.locator('.terminal-panel')).toBeVisible();

  const headBox = await win.locator('.terminal-head').boundingBox();
  const viewport = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  expect(headBox).not.toBeNull();

  const detachedWindowPromise = app.waitForEvent('window');
  await win.mouse.move(headBox!.x + 90, headBox!.y + 12);
  await win.mouse.down();
  await win.mouse.move(viewport.width / 2, viewport.height / 2, { steps: 6 });
  await expect(win.locator('.terminal-dock-target.active')).toHaveAttribute('data-terminal-dock-target', 'floating');
  await win.mouse.up();

  const detachedTerminal = await detachedWindowPromise;
  await detachedTerminal.waitForLoadState('domcontentloaded');
  return detachedTerminal;
}

async function readDetachedTerminalChrome(page: Page) {
  return page.evaluate(() => {
    const requireElement = (selector: string) => {
      const node = document.querySelector(selector);
      if (!(node instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
      return node;
    };
    const resolveBackground = (varName: string) => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = `var(${varName})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    };
    const resolveColor = (varName: string) => {
      const probe = document.createElement('div');
      probe.style.color = `var(${varName})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };

    const rootStyle = getComputedStyle(document.documentElement);
    const shellStyle = getComputedStyle(requireElement('.terminal-window-shell'));
    const headStyle = getComputedStyle(requireElement('.terminal-window-head'));
    return {
      dataset: {
        theme: document.documentElement.dataset.theme || '',
        themeType: document.documentElement.dataset.themeType || '',
      },
      vars: {
        bgPrimary: rootStyle.getPropertyValue('--bg-primary').trim(),
        bgSecondary: rootStyle.getPropertyValue('--bg-secondary').trim(),
        textPrimary: rootStyle.getPropertyValue('--text-primary').trim(),
        textSecondary: rootStyle.getPropertyValue('--text-secondary').trim(),
      },
      tokens: {
        bgPrimary: resolveBackground('--bg-primary'),
        bgSecondary: resolveBackground('--bg-secondary'),
        textPrimary: resolveColor('--text-primary'),
        textSecondary: resolveColor('--text-secondary'),
      },
      shell: {
        backgroundColor: shellStyle.backgroundColor,
        backgroundImage: shellStyle.backgroundImage,
        color: shellStyle.color,
      },
      head: {
        backgroundColor: headStyle.backgroundColor,
        backgroundImage: headStyle.backgroundImage,
        color: headStyle.color,
      },
    };
  });
}

test('desktop app launches, window title contains OrPAD', async () => {
  const app = await launchElectron();
  try {
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await expect(win).toHaveTitle(/OrPAD/);
  await expect(win.locator('#btn-ai')).toBeVisible();
  await expect(win.locator('#btn-mcp')).toHaveCount(0);
  await expect(win.locator('#btn-git')).toHaveCount(0);

  await win.locator('#btn-ai').click();
  await expect(win.locator('.ai-sidebar')).toBeVisible();
  await expect(win.locator('.ai-context-chip')).not.toBeEmpty();
  await win.locator('#lang-select').selectOption('en');
  await expect(win.locator('.ai-context-chip')).toContainText('No active document');
  await win.locator('#lang-select').selectOption('ja');
  await expect(win.locator('.ai-context-chip')).toContainText('アクティブな文書はありません');
  await win.locator('#lang-select').selectOption('ko');
  await expect(win.locator('.ai-context-chip')).toContainText('활성 문서가 없습니다');

  await win.locator('#btn-ai').click();
  await expect(win.locator('.ai-sidebar')).toBeHidden();

  await win.locator('#btn-ai').click();
  await expect(win.locator('.ai-sidebar')).toBeVisible();
  await win.evaluate(() => (window as any).orpadCommands.runCommand('file.new'));
  await expect(win.locator('.ai-context-chip')).toContainText(/Context:|컨텍스트:/);

  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  const mcpConfigPath = path.join(userData, 'mcp-servers.json');
  fs.writeFileSync(mcpConfigPath, JSON.stringify({
    version: 1,
    servers: [{
      id: 'filesystem',
      label: 'Filesystem (workspace)',
      transport: 'stdio',
      enabled: true,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem@2026.1.14', '${workspacePath}'],
      env: {},
      description: 'Stale enabled state from a previous session.',
      readOnlyDefault: true,
    }],
  }, null, 2), 'utf-8');

  await win.locator('.ai-mode-tabs button[data-mode="mcp"]').click();
  await expect(win.locator('.ai-mcp-panel')).toBeVisible();
  const filesystemCard = win.locator('.ai-mcp-card').filter({ hasText: 'Filesystem (workspace)' });
  await expect(filesystemCard.locator('input[type="checkbox"]')).not.toBeChecked();
  await win.locator('.ai-mcp-panel > .ai-actions-head .ai-mcp-actions button').nth(0).click();
  await expect(win.locator('.ai-action-status')).toBeVisible();
  await expect.poll(() => {
    const savedMcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
    return savedMcpConfig.servers.find((server: { id?: string }) => server.id === 'filesystem')?.enabled;
  }).toBe(false);
  const mcpCardButtons = filesystemCard.locator('.ai-mcp-actions button');
  await mcpCardButtons.nth(1).click();
  await expect(win.locator('.ai-action-status')).toContainText('Filesystem (workspace)');
  await mcpCardButtons.nth(2).click();
  await expect(win.locator('.ai-action-status')).toContainText('Filesystem (workspace)');
  await expect(mcpCardButtons.nth(3)).toBeVisible();

  await win.locator('#btn-terminal').click();
  await expect(win.locator('.terminal-panel')).toBeVisible();
  await expect(win.locator('.terminal-layout-tabs')).toHaveCount(0);
  await expect(win.locator('.terminal-dock-hint')).toBeVisible();
  await win.locator('#lang-select').selectOption('en');
  await expect(win.locator('.terminal-head strong')).toHaveText('Terminal');
  await win.locator('#lang-select').selectOption('ja');
  await expect(win.locator('.terminal-head strong')).toHaveText('ターミナル');
  await win.locator('#lang-select').selectOption('ko');
  await expect(win.locator('.terminal-head strong')).toHaveText('터미널');
  const headBox = await win.locator('.terminal-head').boundingBox();
  expect(headBox).not.toBeNull();
  await win.mouse.move(headBox!.x + 90, headBox!.y + 12);
  await win.mouse.down();
  await win.mouse.move(36, Math.max(150, headBox!.y - 160), { steps: 6 });
  await expect(win.locator('.terminal-dock-overlay')).toBeVisible();
  await expect(win.locator('.terminal-dock-target.active')).toHaveAttribute('data-terminal-dock-target', 'left');
  await win.mouse.up();
  await expect(win.locator('.terminal-panel')).toHaveClass(/terminal-layout-left/);
  await expect(win.locator('body')).toHaveClass(/terminal-docked-left/);
  await expect.poll(async () => {
    const leftPanelBox = await win.locator('.terminal-panel').boundingBox();
    const pushedWorkspaceBox = await win.locator('#workspace').boundingBox();
    return Math.round((pushedWorkspaceBox?.x || 0) - (leftPanelBox?.width || 0));
  }).toBeGreaterThanOrEqual(-2);

  const leftHeadBox = await win.locator('.terminal-head').boundingBox();
  const viewport = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  expect(leftHeadBox).not.toBeNull();
  await win.mouse.move(leftHeadBox!.x + 90, leftHeadBox!.y + 12);
  await win.mouse.down();
  await win.mouse.move(viewport.width / 2, viewport.height - 28, { steps: 6 });
  await expect(win.locator('.terminal-dock-target.active')).toHaveAttribute('data-terminal-dock-target', 'bottom');
  await win.mouse.up();
  await expect(win.locator('.terminal-panel')).toHaveClass(/terminal-layout-bottom/);
  await expect(win.locator('body')).toHaveClass(/terminal-docked-bottom/);
  await expect(win.locator('.terminal-new')).toHaveCount(0);
  await expect(win.locator('.terminal-kill')).toHaveCount(0);
  await expect(win.locator('.terminal-tab-add')).toBeVisible();
  await win.locator('.terminal-tab-add').click();
  await expect(win.locator('.terminal-new-panel')).toHaveCount(0);
  await expect(win.locator('.terminal-new-popover')).toBeVisible();
  await expect(win.locator('.terminal-new-popover')).toHaveCSS('position', 'fixed');
  await expect(win.locator('.terminal-new-popover-head')).toBeVisible();
  await expect(win.locator('.terminal-profile-section-title')).toHaveCount(2);
  await expect(win.locator('.terminal-shell-card[data-profile-kind="ai-cli"]')).toHaveCount(3);
  const shellCardCount = await win.locator('.terminal-shell-card').count();
  const shellEmptyCount = await win.locator('.terminal-shell-empty').count();
  expect(shellCardCount + shellEmptyCount).toBeGreaterThan(0);
  await win.keyboard.press('Escape');

  const bottomHeadBox = await win.locator('.terminal-head').boundingBox();
  expect(bottomHeadBox).not.toBeNull();
  const detachedWindowPromise = app.waitForEvent('window');
  await win.mouse.move(bottomHeadBox!.x + 90, bottomHeadBox!.y + 12);
  await win.mouse.down();
  await win.mouse.move(viewport.width / 2, viewport.height / 2, { steps: 6 });
  await expect(win.locator('.terminal-dock-target.active')).toHaveAttribute('data-terminal-dock-target', 'floating');
  await win.mouse.up();
  const detachedTerminal = await detachedWindowPromise;
  await detachedTerminal.waitForLoadState('domcontentloaded');
  await expect(detachedTerminal).toHaveTitle(/OrPAD (Terminal|터미널)/);
  await expect(detachedTerminal.locator('.terminal-pty-root')).toBeVisible();
  await expect(detachedTerminal.locator('.terminal-new-popover')).toBeHidden();
  await expect(win.locator('.terminal-panel')).toBeHidden();
  const detachedWindowCount = app.windows().length;
  await win.locator('#btn-terminal').click();
  await expect.poll(async () => app.windows().length).toBe(detachedWindowCount);
  await expect(win.locator('.terminal-panel')).toBeHidden();
  const dockedClosePromise = detachedTerminal.waitForEvent('close');
  await detachedTerminal.locator('.terminal-window-dock').click();
  await dockedClosePromise;
  await expect(win.locator('.terminal-panel')).toBeVisible();
  await expect(win.locator('.terminal-panel')).toHaveClass(/terminal-layout-bottom/);
  await expect.poll(async () => app.windows().length).toBe(1);

  await win.evaluate(() => (window as any).orpadCommands.runCommand('git.openPanel'));
  await expect(win.locator('#fmt-modal')).toBeVisible();

  } finally {
    await closeElectronApp(app);
  }
});

test('detached terminal follows saved and live OrPAD theme tokens', async () => {
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.evaluate(() => localStorage.setItem('orpad-theme', 'github-light'));

    const detachedTerminal = await detachTerminalWindow(app, win);
    await expect(detachedTerminal.locator('.terminal-pty-root')).toBeVisible();
    await expect.poll(async () => (await readDetachedTerminalChrome(detachedTerminal)).vars.bgPrimary).toBe('#ffffff');

    const lightChrome = await readDetachedTerminalChrome(detachedTerminal);
    expect(lightChrome.vars.bgSecondary).toBe('#f6f8fa');
    expect(lightChrome.vars.textPrimary).toBe('#1f2328');
    expect(lightChrome.shell.backgroundImage).toBe('none');
    expect(lightChrome.head.backgroundImage).toBe('none');
    expect([lightChrome.tokens.bgPrimary, lightChrome.tokens.bgSecondary]).toContain(lightChrome.shell.backgroundColor);
    expect(lightChrome.shell.color).toBe(lightChrome.tokens.textPrimary);
    expect([lightChrome.tokens.bgPrimary, lightChrome.tokens.bgSecondary]).toContain(lightChrome.head.backgroundColor);
    expect([lightChrome.tokens.textPrimary, lightChrome.tokens.textSecondary]).toContain(lightChrome.head.color);

    await win.evaluate(() => localStorage.setItem('orpad-theme', 'github-dark'));
    await expect.poll(async () => (await readDetachedTerminalChrome(detachedTerminal)).vars.bgPrimary).toBe('#0d1117');

    const darkChrome = await readDetachedTerminalChrome(detachedTerminal);
    expect(darkChrome.dataset.theme).toBe('github-dark');
    expect(darkChrome.dataset.themeType).toBe('dark');
    expect([darkChrome.tokens.bgPrimary, darkChrome.tokens.bgSecondary]).toContain(darkChrome.shell.backgroundColor);
    expect(darkChrome.shell.backgroundImage).toBe('none');
    expect(darkChrome.head.backgroundImage).toBe('none');

    await win.evaluate(() => {
      localStorage.setItem('orpad-custom-themes', JSON.stringify({
        'custom-terminal-e2e': {
          name: 'Detached terminal e2e',
          type: 'light',
          colors: {
            bgPrimary: '#fdfefe',
            bgSecondary: '#eef6ff',
            borderColor: '#9db9d8',
            textPrimary: '#182230',
            textSecondary: '#536272',
            accentColor: '#0b65c2',
            editorBg: '#fdfefe',
            syntaxKeyword: '#af1d42',
            syntaxString: '#176f4d',
          },
        },
      }));
      localStorage.setItem('orpad-theme', 'custom-terminal-e2e');
    });
    await expect.poll(async () => (await readDetachedTerminalChrome(detachedTerminal)).vars.bgPrimary).toBe('#fdfefe');

    const customChrome = await readDetachedTerminalChrome(detachedTerminal);
    expect(customChrome.dataset.theme).toBe('custom-terminal-e2e');
    expect(customChrome.dataset.themeType).toBe('light');
    expect(customChrome.vars.bgSecondary).toBe('#eef6ff');
    expect(customChrome.vars.textPrimary).toBe('#182230');
    expect([customChrome.tokens.bgPrimary, customChrome.tokens.bgSecondary]).toContain(customChrome.shell.backgroundColor);
    expect(customChrome.shell.color).toBe(customChrome.tokens.textPrimary);
  } finally {
    await closeElectronApp(app);
  }
});

test('OrPAD file launch opens every registered OrPAD extension file argument', async () => {
  const fixture = createOrpadFileLaunchFixture();
  const launchCases = [
    {
      filePath: fixture.pipelinePath,
      fileName: 'pipeline.or-pipeline',
      content: ['competitive-file-launch', '"entryGraph": "entry.or-graph"'],
    },
    {
      filePath: fixture.graphPath,
      fileName: 'entry.or-graph',
      content: ['Review desktop graph launch', '"transitions"'],
    },
    {
      filePath: fixture.treePath,
      fileName: 'decision.or-tree',
      content: ['desktop-tree-launch', 'Tree fixture content is visible'],
    },
    {
      filePath: fixture.rulePath,
      fileName: 'guardrail.or-rule',
      content: ['desktop-rule-launch', 'Rule file launch opens a tab'],
    },
    {
      filePath: fixture.runPath,
      fileName: 'launch.or-run',
      content: ['desktop-run-launch', 'Run fixture content is visible'],
    },
  ];

  try {
    for (const launchCase of launchCases) {
      const { app, userData } = await launchElectronWithFileArg(launchCase.filePath);

      try {
        const win = await app.firstWindow();
        await win.waitForLoadState('domcontentloaded');

        await expect(win).toHaveTitle(new RegExp(`${launchCase.fileName.replace('.', '\\.')} - OrPAD`));
        await expect(win.locator('.tab-item')).toContainText(launchCase.fileName);
        for (const expectedContent of launchCase.content) {
          await expect(win.locator('.cm-content')).toContainText(expectedContent);
        }
        await expect.poll(async () => app.windows().length).toBe(1);
      } finally {
        await closeElectronApp(app);
        fs.rmSync(userData, { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('OrPAD file launch opens tree file from second instance argument', async () => {
  const fixture = createOrpadFileLaunchFixture();
  const app = await launchElectron();

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await app.evaluate(({ app: electronApp }, treePath) => {
      electronApp.emit('second-instance', {}, [
        process.execPath,
        process.argv[1] || 'src/main/main.js',
        treePath,
      ]);
    }, fixture.treePath);

    await expect(win).toHaveTitle(/decision\.or-tree - OrPAD/);
    await expect(win.locator('.tab-item')).toContainText('decision.or-tree');
    await expect(win.locator('.cm-content')).toContainText('desktop-tree-launch');
    await expect(win.locator('.cm-content')).toContainText('Tree file launch opens a tab');
    await expect.poll(async () => app.windows().length).toBe(1);
  } finally {
    await closeElectronApp(app);
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('closing the main window also closes detached terminal windows', async () => {
  const app = await launchElectron();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.locator('#btn-terminal').click();
    await expect(win.locator('.terminal-panel')).toBeVisible();

    const headBox = await win.locator('.terminal-head').boundingBox();
    const viewport = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(headBox).not.toBeNull();
    const detachedWindowPromise = app.waitForEvent('window');
    await win.mouse.move(headBox!.x + 90, headBox!.y + 12);
    await win.mouse.down();
    await win.mouse.move(viewport.width / 2, viewport.height / 2, { steps: 6 });
    await expect(win.locator('.terminal-dock-target.active')).toHaveAttribute('data-terminal-dock-target', 'floating');
    await win.mouse.up();

    const detachedTerminal = await detachedWindowPromise;
    await detachedTerminal.waitForLoadState('domcontentloaded');
    await expect(detachedTerminal).toHaveTitle(/OrPAD (Terminal|터미널)/);
    await expect.poll(async () => app.windows().length).toBe(2);

    const mainClosed = win.waitForEvent('close');
    const detachedClosed = detachedTerminal.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(browserWindow => !browserWindow.getTitle().includes('Terminal'));
      main?.destroy();
    });
    await Promise.all([mainClosed, detachedClosed]);
  } finally {
    await closeElectronApp(app);
  }
});
