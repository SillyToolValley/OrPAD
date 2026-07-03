import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { startStaticServer } from '../../helpers';

const docsDir = path.resolve('docs');
const sourceManifestPath = path.resolve('src/web/manifest.webmanifest');
const INTENTIONAL_FILE_HANDLER_EXCLUSIONS = new Set<string>();
const REQUIRED_DOCS_ARTIFACTS = [
  'index.html',
  'renderer.js',
  'manifest.webmanifest',
  'sw.js',
  'styles/base.css',
];
const consoleErrorsByPage = new WeakMap<Page, string[]>();

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

function expectWebBuildArtifacts(): void {
  const missing = REQUIRED_DOCS_ARTIFACTS.filter(rel => !fs.existsSync(path.join(docsDir, rel)));
  expect(
    missing,
    `Missing web release artifacts: ${missing.join(', ')}. Run npm run build:web:min before web smoke tests.`,
  ).toEqual([]);
}

function isUnexpectedConsoleError(text: string): boolean {
  return !text.toLowerCase().includes('favicon');
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
  await expect(page.locator('#btn-git')).toHaveCount(0);

  await page.evaluate(() => (window as any).orpadCommands.runCommand('file.new'));

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

  await page.evaluate(() => (window as any).orpadCommands.runCommand('git.openPanel'));
  await expect(page.locator('#fmt-modal')).toContainText('Git Status and Commands');
  await page.locator('#fmt-modal-close').click();

  // Create a new file
  await expect(page.locator('.tab-item')).toBeVisible({ timeout: 5000 });

  // No unexpected console errors (ignore favicon 404s)
  const realErrors = consoleErrors.filter(isUnexpectedConsoleError);
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
    { name: 'notes.txt', type: 'text/plain', content: 'Plain text launch', expected: 'Plain text launch' },
    { name: 'script.py', type: 'text/x-python', content: 'def launch():\n    return "web"', expected: 'def launch' },
    { name: 'notes.mkd', type: 'text/markdown', content: '# MKD\n\nmarkdown variant launch', expected: 'markdown variant launch' },
    { name: 'brief.mdx', type: 'text/markdown', content: '# MDX\n\nexport const mode = "launch";', expected: 'export const mode' },
    { name: 'diagram.mmd', type: 'text/vnd.mermaid', content: 'graph TD\n  A[Launch] --> B[Preview]', expected: 'graph TD' },
    { name: 'flow.or-pipeline', type: 'application/json', content: '{"kind":"orpad.pipeline","id":"web-launch-pipeline"}', expected: 'web-launch-pipeline' },
    { name: 'flow.or-graph', type: 'application/json', content: '{"kind":"orpad.graph","graph":{"nodes":[]}}', expected: 'orpad.graph' },
    { name: 'flow.or-tree', type: 'application/json', content: '{"kind":"orpad.tree","id":"web-launch-tree","root":{"id":"root","type":"orpad.context"}}', expected: 'web-launch-tree' },
    { name: 'flow.or-rule', type: 'application/json', content: '{"kind":"orpad.rule","id":"web-launch-rule","criteria":["launch parity"]}', expected: 'web-launch-rule' },
    { name: 'flow.or-run', type: 'application/json', content: '{"kind":"orpad.run","id":"web-launch-run","status":"queued"}', expected: 'web-launch-run' },
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
