import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { startStaticServer } from '../../helpers';

const docsDir = path.resolve('docs');
const sourceManifestPath = path.resolve('src/web/manifest.webmanifest');
const INTENTIONAL_FILE_HANDLER_EXCLUSIONS = new Set<string>();

function extractSupportedExts(sourcePath: string): string[] {
  const source = fs.readFileSync(sourcePath, 'utf-8');
  const match = source.match(/const SUPPORTED_EXTS = \[([\s\S]*?)\];/);
  if (!match) throw new Error(`Missing SUPPORTED_EXTS in ${sourcePath}`);
  return Array.from(match[1].matchAll(/'([^']+)'/g), item => item[1]);
}

function extractDesktopAssociationExts(sourcePath: string): string[] {
  const source = fs.readFileSync(sourcePath, 'utf-8');
  const section = source.match(/^fileAssociations:\r?\n([\s\S]*)$/m)?.[1];
  if (!section) throw new Error(`Missing fileAssociations in ${sourcePath}`);
  return Array.from(section.matchAll(/^\s*-\s+ext:\s+([^\s]+)/gm), item => item[1]);
}

function extractManifestFileHandlerExts(sourcePath: string): string[] {
  const manifest = JSON.parse(fs.readFileSync(sourcePath, 'utf-8'));
  const handlers = manifest.file_handlers || [];
  const exts: string[] = [];
  for (const handler of handlers as Array<{ accept?: Record<string, string[]> }>) {
    for (const accepted of Object.values(handler.accept || {})) {
      for (const ext of accepted) exts.push(ext.replace(/^\./, ''));
    }
  }
  return exts;
}

function expectSameExtSet(actual: string[], expected: string[]): void {
  expect([...new Set(actual)].sort()).toEqual([...new Set(expected)].sort());
}

async function installHangingAiMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('orpad-ai-provider', 'openai-compatible');
    localStorage.setItem('orpad-ai-endpoint-openai-compatible', 'https://orpad.test');

    const originalFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith('https://orpad.test/chat/completions')) {
        return originalFetch(input, init);
      }

      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    };
  });
}

async function installDelayedAiMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('orpad-ai-provider', 'openai-compatible');
    localStorage.setItem('orpad-ai-endpoint-openai-compatible', 'https://orpad.test');

    const originalFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith('https://orpad.test/chat/completions')) {
        return originalFetch(input, init);
      }

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const timer = window.setTimeout(() => {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Explained."}}]}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          }, 1000);
          init?.signal?.addEventListener('abort', () => {
            window.clearTimeout(timer);
            controller.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    };
  });
}

async function installMcpMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const server = {
      id: 'mock',
      label: 'Mock MCP',
      enabled: true,
      command: 'mock',
      args: [],
      env: {},
      description: 'Mock MCP server for UI tests.',
      readOnlyDefault: true,
    };
    const tool = {
      name: 'read_file',
      description: 'Read a workspace file.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          limit: { type: 'integer', description: 'Maximum bytes to read.' },
          includeHidden: { type: 'boolean', description: 'Include hidden files.' },
        },
      },
    };
    (window as any).mcp = {
      listServers: async () => ({
        servers: [server],
        statuses: { mock: { state: 'running', toolCount: 1, resourceCount: 0 } },
      }),
      setEnabled: async () => ({
        server,
        statuses: { mock: { state: 'running', toolCount: 1, resourceCount: 0 } },
      }),
      listTools: async () => [tool],
      listResources: async () => [],
      readResource: async () => ({ contents: [] }),
      prepareToolCall: async () => ({ readOnly: true, canPersistGlobal: true }),
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      upsertServer: async () => server,
      removeServer: async () => [server],
      refreshServer: async () => ({ state: 'running', toolCount: 1, resourceCount: 0 }),
      revokeGlobalPermission: async () => true,
      exportConfig: async () => ({ version: 1, servers: [server] }),
      importConfig: async () => [server],
    };
  });
}

async function installStoppedMcpMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const server = {
      id: 'stale',
      label: 'Stale MCP',
      enabled: true,
      command: 'mock',
      args: [],
      env: {},
      description: 'Stopped server with stale enabled config.',
      readOnlyDefault: true,
    };
    (window as any).mcp = {
      listServers: async () => ({
        servers: [server],
        statuses: { stale: { state: 'stopped', toolCount: 0, resourceCount: 0 } },
      }),
      setEnabled: async (_id: string, enabled: boolean) => {
        server.enabled = enabled;
        return {
          server,
          statuses: { stale: { state: enabled ? 'running' : 'stopped', toolCount: 0, resourceCount: 0 } },
        };
      },
      listTools: async () => [],
      listResources: async () => [],
      readResource: async () => ({ contents: [] }),
      prepareToolCall: async () => ({ readOnly: true, canPersistGlobal: true }),
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      upsertServer: async () => server,
      removeServer: async () => [server],
      refreshServer: async () => ({ state: 'stopped', toolCount: 0, resourceCount: 0 }),
      revokeGlobalPermission: async () => true,
      exportConfig: async () => ({ version: 1, servers: [server] }),
      importConfig: async () => [server],
    };
  });
}

async function installWorkspacePickerMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    function fileHandle(name: string, content = 'fixture') {
      return {
        kind: 'file',
        name,
        async getFile() {
          return new File([content], name, { type: 'text/plain' });
        },
      };
    }

    function dirHandle(name: string, entries: Record<string, any>) {
      return {
        kind: 'directory',
        name,
        async *entries() {
          for (const [entryName, entry] of Object.entries(entries)) {
            yield [entryName, entry];
          }
        },
      };
    }

    const generated = dirHandle('generated', {
      'latest-run': dirHandle('latest-run', {
        artifacts: dirHandle('artifacts', {
          'summary.md': fileHandle('summary.md'),
        }),
        queue: dirHandle('queue', {
          'journal.jsonl': fileHandle('journal.jsonl'),
        }),
      }),
    });

    const pipeline = JSON.stringify({
      kind: 'orpad.pipeline',
      version: '1.0',
      id: 'fixture-quality-workstream-20260502',
      title: 'Fixture Quality Workstream',
      description: 'A web scanner fixture pipeline.',
      trustLevel: 'local-authored',
      entryGraph: 'graphs/main.or-graph',
    });

    const workspace = dirHandle('workspace', {
      'README.md': fileHandle('README.md'),
      '.orpad': dirHandle('.orpad', {
        pipelines: dirHandle('pipelines', {
          fixture: dirHandle('fixture', {
            'pipeline.or-pipeline': fileHandle('pipeline.or-pipeline', pipeline),
            harness: dirHandle('harness', { generated }),
          }),
        }),
      }),
    });

    (window as any).showDirectoryPicker = async () => workspace;
  });
}

async function installPipelineValidationWorkspaceMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    function fileHandle(name: string, content: string) {
      return {
        kind: 'file',
        name,
        async getFile() {
          return new File([content], name, { type: 'application/json' });
        },
      };
    }

    function dirHandle(name: string, entries: Record<string, any>) {
      return {
        kind: 'directory',
        name,
        async *entries() {
          for (const [entryName, entry] of Object.entries(entries)) {
            yield [entryName, entry];
          }
        },
      };
    }

    const childGraph = JSON.stringify({
      kind: 'orpad.graph',
      version: '1.0',
      graph: {
        id: 'child',
        nodes: [
          { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue' } },
        ],
        transitions: [],
      },
    });

    const mainGraph = JSON.stringify({
      kind: 'orpad.graph',
      version: '1.0',
      graph: {
        id: 'main',
        nodes: [
          { id: 'gate', type: 'orpad.gate', label: 'Gate', config: { criteria: ['local only'] } },
          { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'custom.workItem.v9' } },
          { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'gate', workerLoopRef: 'queue' } },
          { id: 'child', type: 'orpad.graph', label: 'Child graph', config: { graphRef: 'child.or-graph' } },
          { id: 'unknown', type: 'orpad.notARealNode', label: 'Unknown node' },
        ],
        transitions: [
          { from: 'gate', to: 'missing-node' },
        ],
      },
    });

    const pipeline = JSON.stringify({
      kind: 'orpad.pipeline',
      version: '1.0',
      id: 'web-ref-contract-validation',
      trustLevel: 'local-authored',
      entryGraph: 'graphs/main.or-graph',
      graphs: [
        { id: 'main', file: 'graphs/main.or-graph' },
        { id: 'child', file: 'graphs/child.or-graph' },
      ],
      run: {
        queueProtocol: {
          schema: 'custom.workItem.v9',
          states: ['candidate', 'queued', 'claimed'],
        },
      },
    });

    const workspace = dirHandle('workspace', {
      '.orpad': dirHandle('.orpad', {
        pipelines: dirHandle('pipelines', {
          fixture: dirHandle('fixture', {
            'pipeline.or-pipeline': fileHandle('pipeline.or-pipeline', pipeline),
            graphs: dirHandle('graphs', {
              'main.or-graph': fileHandle('main.or-graph', mainGraph),
              'child.or-graph': fileHandle('child.or-graph', childGraph),
            }),
          }),
        }),
      }),
    });

    (window as any).showDirectoryPicker = async () => workspace;
  });
}

async function installPipelineSkillTreeValidationWorkspaceMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    function fileHandle(name: string, content: string) {
      return {
        kind: 'file',
        name,
        async getFile() {
          return new File([content], name, { type: 'application/json' });
        },
      };
    }

    function dirHandle(name: string, entries: Record<string, any>) {
      return {
        kind: 'directory',
        name,
        async *entries() {
          for (const [entryName, entry] of Object.entries(entries)) {
            yield [entryName, entry];
          }
        },
      };
    }

    const mainGraph = JSON.stringify({
      kind: 'orpad.graph',
      version: '1.0',
      graph: {
        id: 'skill-tree-parity',
        nodes: [
          { id: 'missing-skill-id', type: 'orpad.skill', label: 'Missing skill id', config: { skillRef: 'not-declared' } },
          { id: 'missing-skill-file', type: 'orpad.skill', label: 'Missing skill file', config: { file: '../skills/missing.md' } },
          { id: 'missing-tree', type: 'orpad.tree', label: 'Missing tree', config: { treeRef: '../trees/missing.or-tree' } },
          { id: 'cyclic-tree', type: 'orpad.tree', label: 'Cyclic tree', config: { treeRef: '../trees/cycle.or-tree' } },
        ],
        transitions: [],
      },
    });

    const cycleTree = JSON.stringify({
      kind: 'orpad.tree',
      version: '1.0',
      id: 'cycle',
      root: {
        id: 'cycle-root',
        type: 'orpad.tree',
        label: 'Loop back to this tree',
        config: { treeRef: 'cycle.or-tree' },
      },
    });

    const pipeline = JSON.stringify({
      kind: 'orpad.pipeline',
      version: '1.0',
      id: 'web-skill-tree-validation',
      trustLevel: 'local-authored',
      entryGraph: 'graphs/main.or-graph',
      graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
    });

    const workspace = dirHandle('workspace', {
      '.orpad': dirHandle('.orpad', {
        pipelines: dirHandle('pipelines', {
          fixture: dirHandle('fixture', {
            'pipeline.or-pipeline': fileHandle('pipeline.or-pipeline', pipeline),
            graphs: dirHandle('graphs', {
              'main.or-graph': fileHandle('main.or-graph', mainGraph),
            }),
            skills: dirHandle('skills', {}),
            trees: dirHandle('trees', {
              'cycle.or-tree': fileHandle('cycle.or-tree', cycleTree),
            }),
          }),
        }),
      }),
    });

    (window as any).showDirectoryPicker = async () => workspace;
  });
}

test('web build loads, new-file works, no console errors', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built — run npm run build:web:min first');
    return;
  }

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const { url, close } = await startStaticServer(docsDir);

  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');

  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /width=device-width/);

  // Toolbar must be present
  await expect(page.locator('#toolbar')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#btn-ai')).toBeVisible();
  await expect(page.locator('#btn-mcp')).toHaveCount(0);
  await expect(page.locator('#btn-git')).toHaveCount(0);

  await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-sidebar')).toBeVisible();
  await expect(page.locator('.ai-context-chip')).toContainText('No active document');

  await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-sidebar')).toBeHidden();

  await page.locator('#btn-ai').click();
  await expect(page.locator('.ai-sidebar')).toBeVisible();
  await page.evaluate(() => (window as any).orpadCommands.runCommand('file.new'));
  await expect(page.locator('.ai-context-chip')).toContainText('Context: Untitled');

  const treeValidation = await page.evaluate(async () => {
    return await (window as any).orpad.pipelines.validateText(JSON.stringify({
      kind: 'orpad.tree',
      version: '1.0',
      root: {
        id: 'root',
        type: 'Sequence',
        children: [
          { id: 'context', type: 'Context' },
        ],
      },
    }));
  });
  expect(treeValidation.ok).toBe(true);
  expect(treeValidation.treeCount).toBe(1);

  await page.locator('.ai-mode-tabs button[data-mode="mcp"]').click();
  await expect(page.locator('.ai-mcp-panel')).toBeVisible();
  await expect(page.locator('.ai-mcp-panel')).toContainText('MCP is desktop-only');

  await page.evaluate(() => (window as any).orpadCommands.runCommand('git.openPanel'));
  await expect(page.locator('#fmt-modal')).toContainText('Git Status and Commands');
  await page.locator('#fmt-modal-close').click();

  // Create a new file
  await expect(page.locator('.tab-item')).toBeVisible({ timeout: 5000 });

  // No unexpected console errors (ignore favicon 404s)
  const realErrors = consoleErrors.filter(
    (e) => !e.toLowerCase().includes('favicon'),
  );
  expect(realErrors).toHaveLength(0);

  await close();
});

test('web pipeline scanner excludes generated harness evidence', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);
  await installWorkspacePickerMock(page);

  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(async () => {
    await (window as any).orpad.openFolderDialog();
  });
  const scan = await page.evaluate(async () => {
    return await (window as any).orpad.pipelines.scanWorkspace();
  });

  expect(scan.success).toBe(true);
  expect(scan.fileCount).toBe(2);
  expect(scan.markdownCount).toBe(1);
  expect(scan.dataCount).toBe(0);
  expect(scan.pipelines.map((item: { path: string }) => item.path)).toContain('/.orpad/pipelines/fixture/pipeline.or-pipeline');
  expect(scan.pipelines.map((item: { displayName: string }) => item.displayName)).toContain('Fixture Quality Workstream');
  expect(scan.pipelines.map((item: { displayName: string }) => item.displayName)).not.toContain('fixture-quality-workstream-20260502');

  await close();
});

test('web pipeline validator follows nested graph refs and queue contracts', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);
  await installPipelineValidationWorkspaceMock(page);

  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(async () => {
    await (window as any).orpad.openFolderDialog();
  });
  const validation = await page.evaluate(async () => {
    return await (window as any).orpad.pipelines.validateFile('/.orpad/pipelines/fixture/pipeline.or-pipeline');
  });
  const diagnosticCodes = validation.diagnostics.map((item: { code: string }) => item.code);

  expect(validation.ok).toBe(false);
  expect(validation.graphCount).toBe(2);
  expect(validation.nodeTypes).toContain('orpad.graph');
  expect(validation.nodeTypes).toContain('orpad.dispatcher');
  expect(diagnosticCodes).toContain('GRAPH_NODE_CONFIG_MISSING');
  expect(diagnosticCodes).toContain('GRAPH_QUEUE_REF_INVALID_TARGET');
  expect(diagnosticCodes).toContain('GRAPH_WORKER_LOOP_REF_INVALID_TARGET');
  expect(diagnosticCodes).toContain('GRAPH_TRANSITION_TO_UNKNOWN');
  expect(diagnosticCodes).toContain('GRAPH_NODE_TYPE_UNKNOWN');
  expect(diagnosticCodes).toContain('WORK_QUEUE_SCHEMA_UNSUPPORTED');
  expect(diagnosticCodes).toContain('PIPELINE_QUEUE_PROTOCOL_SCHEMA_UNSUPPORTED');
  expect(diagnosticCodes).toContain('PIPELINE_QUEUE_PROTOCOL_STATES_INCOMPLETE');

  await close();
});

test('web pipeline validator accepts built-in OrPAD managed-run graph nodes', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);

  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');
  const validation = await page.evaluate(async () => {
    return await (window as any).orpad.pipelines.validateText(JSON.stringify({
      kind: 'orpad.graph',
      version: '1.0',
      graph: {
        id: 'managed-run-node-parity',
        nodes: [
          { id: 'entry', type: 'orpad.entry', label: 'Entry', config: { summary: 'Begin managed run.' } },
          { id: 'selector', type: 'orpad.selector', label: 'Select work', config: { mode: 'claimed-work-item' } },
          { id: 'patch-review', type: 'orpad.patchReview', label: 'Review patch results', config: { reviewMode: 'user-selected-files' } },
          { id: 'exit', type: 'orpad.exit', label: 'Exit', config: { summary: 'Close after review and evidence checks.' } },
        ],
        transitions: [
          { from: 'entry', to: 'selector' },
          { from: 'selector', to: 'patch-review' },
          { from: 'patch-review', to: 'exit' },
        ],
      },
    }));
  });
  const diagnosticCodes = validation.diagnostics.map((item: { code: string }) => item.code);

  expect(validation.ok).toBe(true);
  expect(validation.nodeTypes).toEqual(expect.arrayContaining([
    'orpad.entry',
    'orpad.exit',
    'orpad.patchReview',
    'orpad.selector',
  ]));
  expect(diagnosticCodes).not.toContain('GRAPH_NODE_TYPE_UNKNOWN');

  await close();
});

test('web pipeline validator checks OrPAD skill and tree graph refs', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);
  await installPipelineSkillTreeValidationWorkspaceMock(page);

  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(async () => {
    await (window as any).orpad.openFolderDialog();
  });
  const validation = await page.evaluate(async () => {
    return await (window as any).orpad.pipelines.validateFile('/.orpad/pipelines/fixture/pipeline.or-pipeline');
  });
  const diagnostics = validation.diagnostics as Array<{ code: string; nodeId?: string }>;

  expect(validation.ok).toBe(false);
  expect(validation.nodeTypes).toContain('orpad.skill');
  expect(validation.nodeTypes).toContain('orpad.tree');
  expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'SKILL_FILE_MISSING', nodeId: 'missing-skill-id' }));
  expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'SKILL_FILE_NOT_FOUND', nodeId: 'missing-skill-file' }));
  expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'ORCH_TREE_NOT_FOUND', nodeId: 'missing-tree' }));
  expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'ORCH_TREE_REF_CYCLE', nodeId: 'cycle-root' }));

  await close();
});

test('web opens OrPAD graph files with visual graph preview', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');

    const opened = await page.evaluate(async () => {
      const graph = JSON.stringify({
        kind: 'orpad.graph',
        version: '1.0',
        graph: {
          id: 'web-preview',
          nodes: [
            { id: 'context', type: 'orpad.context', label: 'Collect web facts' },
            { id: 'gate', type: 'orpad.gate', label: 'Review web graph', config: { criteria: ['Preview renders'] } },
          ],
          transitions: [{ from: 'context', to: 'gate' }],
        },
      }, null, 2);
      return await (window as any).orpad.openFileHandles([{
        kind: 'file',
        name: 'web-preview.or-graph',
        getFile: async () => new File([graph], 'web-preview.or-graph', { type: 'application/json' }),
      }]);
    });

    expect(opened).toBe(true);
    await expect(page.locator('.tab-item')).toContainText('web-preview.or-graph');
    await page.locator('#btn-preview').click();
    await expect(page.locator('.orch-preview')).toContainText('Flow setup');
    await expect(page.locator('.orch-graph-node')).toHaveCount(2);
    await expect(page.locator('.orch-graph-node')).toContainText(['Collect web facts', 'Review web graph']);
    await expect(page.locator('.orch-transition')).toHaveCount(1);
  } finally {
    await close();
  }
});

test('MCP tool lists are collapsible and explain argument schemas', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);
  await installMcpMock(page);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.locator('#btn-ai').click();
    await page.locator('.ai-mode-tabs button[data-mode="mcp"]').click();

    const card = page.locator('.ai-mcp-card').filter({ hasText: 'Mock MCP' });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Tools' }).click();
    const hideTools = card.getByRole('button', { name: 'Hide tools' });
    await expect(hideTools).toBeVisible();
    await expect(hideTools).toHaveAttribute('aria-pressed', 'true');
    await expect(hideTools).toHaveAttribute('aria-expanded', 'true');
    await expect(hideTools).toHaveClass(/active/);
    await expect(card.getByRole('button', { name: /read_file/ })).toContainText('required path');

    await card.getByRole('button', { name: 'Hide tools' }).click();
    await expect(card.getByRole('button', { name: /read_file/ })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Tools' })).toHaveAttribute('aria-pressed', 'false');

    await card.getByRole('button', { name: 'Resources' }).click();
    const hideResources = card.getByRole('button', { name: 'Hide resources' });
    await expect(hideResources).toHaveAttribute('aria-pressed', 'true');
    await expect(hideResources).toHaveAttribute('aria-expanded', 'true');
    await expect(hideResources).toHaveClass(/active/);
    await expect(card.locator('.ai-mcp-empty')).toContainText('No resources reported');
    await hideResources.click();

    await card.getByRole('button', { name: 'Tools' }).click();
    await card.getByRole('button', { name: /read_file/ }).click();
    await expect(page.locator('#fmt-modal')).toContainText('Required: path');
    await expect(page.locator('#fmt-modal')).toContainText('Workspace-relative file path.');
    await expect(page.locator('#fmt-modal')).toContainText('Input schema');
    await expect(page.locator('#fmt-modal textarea')).toHaveValue(/"path": "<path>"/);
  } finally {
    await close();
  }
});

test('MCP stopped servers do not appear enabled from stale config', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);
  await installStoppedMcpMock(page);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.locator('#btn-ai').click();
    await page.locator('.ai-mode-tabs button[data-mode="mcp"]').click();

    const card = page.locator('.ai-mcp-card').filter({ hasText: 'Stale MCP' });
    await expect(card).toBeVisible();
    await expect(card.getByRole('checkbox', { name: 'Enable Stale MCP' })).not.toBeChecked();
    await expect(card).toContainText(/stopped/i);
    await card.getByRole('button', { name: 'Tools' }).click();
    await expect(page.locator('.ai-action-status')).toContainText(/Enable Stale MCP before using MCP Tools/i);
  } finally {
    await close();
  }
});

test('AI edit diff modal close button cancels the running action', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async () => {
      await (window as any).orpad.dropFile(new File(['# Plan\n\n## Scope\n\nShip beta.'], 'plan.md', { type: 'text/markdown' }));
    });

    await page.locator('#btn-ai').click();
    await page.locator('.ai-mode-tabs button[data-mode="actions"]').click();
    await page.getByRole('button', { name: /Generate \/ refresh TOC/ }).click();
    await expect(page.locator('#fmt-modal')).toContainText('Generate / refresh Markdown TOC');
    await expect(page.locator('.ai-action-running')).toContainText('Generate / refresh TOC');

    await page.locator('#fmt-modal-close').click();
    await expect(page.locator('.ai-action-running')).toHaveCount(0);
    await expect(page.locator('.ai-action-status')).toContainText('canceled');
    await expect(page.locator('#fmt-modal')).toBeHidden();
  } finally {
    await close();
  }
});

test('Assist tools distinguish local actions from AI-powered actions', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async () => {
      await (window as any).orpad.dropFile(new File(['{"name":"OrPAD","beta":2}'], 'sample.json', { type: 'application/json' }));
    });

    await page.locator('#btn-ai').click();
    await expect(page.locator('.ai-mode-tabs button[data-mode="actions"]')).toHaveText('Assist');
    await page.locator('.ai-mode-tabs button[data-mode="actions"]').click();
    await expect(page.locator('.ai-actions-panel')).toContainText('AI-powered edits');
    await expect(page.locator('.ai-actions-panel')).toContainText('Local format tools');

    const localAction = page.getByRole('button', { name: /Generate JSON Schema/ });
    await expect(localAction).toContainText('Runs locally');
    await expect(localAction).not.toBeDisabled();

    const aiAction = page.getByRole('button', { name: /Validate \+ explain/ });
    await expect(aiAction).toContainText('Uses AI provider');
    await expect(aiAction).toContainText('Requires provider key');
    await expect(aiAction).toBeDisabled();
  } finally {
    await close();
  }
});

test('JSON sample generation cancel does not create an output tab', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async () => {
      await (window as any).orpad.dropFile(new File(['{"type":"object","properties":{"name":{"type":"string"}}}'], 'schema.json', { type: 'application/json' }));
    });

    await page.locator('#btn-ai').click();
    await page.locator('.ai-mode-tabs button[data-mode="actions"]').click();
    await page.getByRole('button', { name: /Generate samples from schema/ }).click();
    await expect(page.locator('#fmt-modal')).toContainText('Generate samples');
    await page.locator('#fmt-modal-footer button', { hasText: 'Cancel' }).click();

    await expect(page.locator('.ai-action-running')).toHaveCount(0);
    await expect(page.locator('.ai-action-status')).toContainText('Canceled');
    await expect(page.locator('.tab-item')).not.toContainText('sample-data.json');
  } finally {
    await close();
  }
});

test('JSON sample generation refuses non-schema documents', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async () => {
      await (window as any).orpad.dropFile(new File(['{"name":"OrPAD","beta":2}'], 'sample.json', { type: 'application/json' }));
    });

    await page.locator('#btn-ai').click();
    await page.locator('.ai-mode-tabs button[data-mode="actions"]').click();
    await page.getByRole('button', { name: /Generate samples from schema/ }).click();
    await page.locator('#fmt-modal-footer button.primary').click();

    await expect(page.locator('.ai-action-running')).toHaveCount(0);
    await expect(page.locator('.ai-action-status')).toContainText('Open a JSON Schema first');
    await expect(page.locator('.tab-item')).not.toContainText('sample-data.json');
  } finally {
    await close();
  }
});

test('AI edit apply returns to the source tab after tab switching', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);
  await installDelayedAiMock(page);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async () => {
      await (window as any).orpad.dropFile(new File(['{"name":"OrPAD",}'], 'broken.json', { type: 'application/json' }));
      await (window as any).orpad.dropFile(new File(['{"other":true}'], 'other.json', { type: 'application/json' }));
    });

    await page.locator('.tab-item').filter({ hasText: 'broken.json' }).click();
    await page.locator('#btn-ai').click();
    await page.locator('.ai-mode-tabs button[data-mode="actions"]').click();
    await page.getByRole('button', { name: /Repair \+ explain/ }).click();
    await expect(page.locator('.ai-action-running')).toContainText('Repair + explain');

    await page.locator('.tab-item').filter({ hasText: 'other.json' }).click();
    await expect(page.locator('.tab-item.active')).toContainText('other.json');
    await expect(page.locator('#fmt-modal')).toContainText('Repair JSON');
    await expect(page.locator('.tab-item.active')).toContainText('broken.json');

    await page.locator('#fmt-modal-footer button.primary').click();
    await page.locator('.tab-item').filter({ hasText: 'broken.json' }).click();
    await expect(page.locator('.cm-content')).toContainText('"name":"OrPAD"');

    await page.locator('.tab-item').filter({ hasText: 'other.json' }).click();
    await expect(page.locator('.cm-content')).toContainText('"other":true');
  } finally {
    await close();
  }
});

test('file handler extension registrations match runtime-supported extensions', async () => {
  const desktopRuntime = extractSupportedExts(path.resolve('src/main/main.js'));
  const webRuntime = extractSupportedExts(path.resolve('src/web/platform-adapter.js'));
  const desktopAssociations = extractDesktopAssociationExts(path.resolve('electron-builder.yml'));
  const webManifestHandlers = extractManifestFileHandlerExts(sourceManifestPath);
  const manifestExpected = webRuntime.filter(ext => !INTENTIONAL_FILE_HANDLER_EXCLUSIONS.has(ext));

  expectSameExtSet(webRuntime, desktopRuntime);
  expectSameExtSet(desktopAssociations, desktopRuntime);
  expectSameExtSet(webManifestHandlers, manifestExpected);
  expect([...INTENTIONAL_FILE_HANDLER_EXCLUSIONS]).toEqual([]);
});

test('web PWA assets are self-contained for offline install', async () => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(docsDir, 'manifest.webmanifest'), 'utf-8'));
  expect(manifest.start_url).toBe('./');
  expect(manifest.scope).toBe('./');
  expect(manifest.file_handlers?.[0]?.action).toBe('./');
  expect(manifest.file_handlers?.[0]?.accept?.['text/markdown']).toEqual(expect.arrayContaining([
    '.md',
    '.markdown',
    '.mkd',
    '.mdx',
  ]));
  expect(manifest.file_handlers?.[0]?.accept?.['application/json']).toEqual(expect.arrayContaining([
    '.or-pipeline',
    '.or-graph',
    '.or-tree',
    '.or-rule',
    '.or-run',
  ]));

  const sw = fs.readFileSync(path.join(docsDir, 'sw.js'), 'utf-8');
  expect(sw).not.toContain('storage.googleapis.com');
  expect(sw).toContain('styles/fonts/KaTeX_Main-Regular.woff2');
  expect(fs.existsSync(path.join(docsDir, 'styles', 'fonts', 'KaTeX_Main-Regular.woff2'))).toBe(true);
});

test('web file launch consumer and non-FSA save fallback work', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);
  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');

  const launchFiles = [
    { name: 'launch.md', type: 'text/markdown', content: '# Launched\n\nfrom file handler', expected: 'from file handler' },
    { name: 'notes.mkd', type: 'text/markdown', content: '# MKD\n\nmarkdown variant launch', expected: 'markdown variant launch' },
    { name: 'brief.mdx', type: 'text/markdown', content: '# MDX\n\nexport const mode = "launch";', expected: 'export const mode' },
    { name: 'diagram.mmd', type: 'text/vnd.mermaid', content: 'graph TD\n  A[Launch] --> B[Preview]', expected: 'graph TD' },
    { name: 'flow.or-pipeline', type: 'application/json', content: '{"kind":"orpad.pipeline","id":"web-launch-pipeline"}', expected: 'web-launch-pipeline' },
    { name: 'flow.or-graph', type: 'application/json', content: '{"kind":"orpad.graph","graph":{"nodes":[]}}', expected: 'orpad.graph' },
  ];
  const opened = await page.evaluate(async (files) => {
    return await (window as any).orpad.openFileHandles(files.map(file => ({
      kind: 'file',
      name: file.name,
      getFile: async () => new File([file.content], file.name, { type: file.type }),
    })));
  }, launchFiles);
  expect(opened).toBe(true);
  await expect(page.locator('.tab-item')).toContainText(launchFiles.map(file => file.name));
  for (const file of launchFiles) {
    await page.locator('.tab-item').filter({ hasText: file.name }).click();
    await expect(page.locator('.cm-content')).toContainText(file.expected);
  }

  const downloadPromise = page.waitForEvent('download');
  const saved = await page.evaluate(async () => {
    return await (window as any).orpad.saveFile('web:nohandle/fallback.md', '# Download fallback');
  });
  expect(saved).toBe(true);
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('fallback.md');

  await close();
});

test('AI edit action cancel stops a hanging provider response', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);
  await installHangingAiMock(page);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async () => {
      await (window as any).orpad.dropFile(new File(['{"name":"OrPAD"}'], 'sample.json', { type: 'application/json' }));
    });

    await page.locator('#btn-ai').click();
    await page.locator('.ai-mode-tabs button[data-mode="actions"]').click();
    await page.getByRole('button', { name: /Validate \+ explain/ }).click();
    await expect(page.locator('#fmt-modal')).toContainText('Validate current JSON');
    await expect(page.locator('#fmt-modal')).toContainText('Schema for current file: sample.json');
    await expect(page.locator('#fmt-modal')).toContainText('OrPAD validates the currently open JSON document against this schema.');
    await page.locator('#fmt-modal-footer button.primary').click();

    await expect(page.locator('.ai-action-running')).toContainText('Validate + explain');
    await page.locator('.ai-action-running button').click();
    await expect(page.locator('.ai-action-running')).toHaveCount(0);
    await expect(page.locator('.ai-action-status')).toContainText('canceled');
  } finally {
    await close();
  }
});

test('AI chat can run without an active document and can be canceled', async ({ page }) => {
  if (!fs.existsSync(path.join(docsDir, 'index.html'))) {
    test.skip(true, 'docs/ not built - run npm run build:web:min first');
    return;
  }

  const { url, close } = await startStaticServer(docsDir);
  await installHangingAiMock(page);

  try {
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    await page.locator('#btn-ai').click();
    await page.locator('.ai-composer').fill('Can you answer without a document?');
    await page.locator('.ai-send').click();
    await expect(page.locator('.ai-send')).toHaveText('Stop');
    await expect(page.locator('.ai-message.assistant .ai-loading-line')).toContainText('Waiting for AI response');
    await page.locator('.ai-send').click();
    await expect(page.locator('.ai-send')).toHaveText('Send');
    await expect(page.locator('.ai-log')).toContainText('Canceled.');
    await expect(page.locator('.ai-message.user').first()).toHaveCSS('justify-content', 'flex-end');
    await expect(page.locator('.ai-message.assistant').first()).toHaveCSS('justify-content', 'flex-start');
    const messageGaps = await page.evaluate(() => {
      const log = document.querySelector('.ai-log')?.getBoundingClientRect();
      const user = document.querySelector('.ai-message.user .ai-message-bubble')?.getBoundingClientRect();
      const assistant = document.querySelector('.ai-message.assistant .ai-message-bubble')?.getBoundingClientRect();
      return {
        userLeft: user && log ? user.left - log.left : 0,
        userRight: user && log ? log.right - user.right : 0,
        assistantLeft: assistant && log ? assistant.left - log.left : 0,
        assistantRight: assistant && log ? log.right - assistant.right : 0,
      };
    });
    expect(messageGaps.userLeft).toBeGreaterThan(30);
    expect(messageGaps.userRight).toBeLessThan(24);
    expect(messageGaps.assistantLeft).toBeLessThan(24);
    expect(messageGaps.assistantRight).toBeGreaterThan(30);
    const historyItem = page.locator('.ai-history-item').first();
    await expect(historyItem).toContainText('Can you answer without a document?');
    await historyItem.hover();
    await expect(historyItem.locator('.ai-history-delete')).toHaveCSS('opacity', '1');
    page.once('dialog', dialog => dialog.accept());
    await historyItem.locator('.ai-history-delete').click();
    await expect(page.locator('.ai-history-item')).toHaveCount(0);
    await expect(page.locator('.ai-chat-panel .ai-empty')).toContainText('AI sidebar is ready');
  } finally {
    await close();
  }
});
