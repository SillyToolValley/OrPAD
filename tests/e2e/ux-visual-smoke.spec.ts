import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { closeElectronApp, launchElectron } from '../helpers';

type ViewportCase = {
  name: string;
  width: number;
  height: number;
};

type PngStats = {
  width: number;
  height: number;
  sampledPixels: number;
  opaquePixels: number;
  uniqueColors: number;
  luminanceRange: number;
};

type ContrastStats = {
  sampledTextElements: number;
  minContrastRatio: number;
  maxContrastRatio: number;
  averageContrastRatio: number;
};

type ThemeVarSnapshot = {
  bgPrimary: string;
  bgSecondary: string;
  accentColor: string;
};

const VISUAL_VIEWPORTS: ViewportCase[] = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'constrained', width: 980, height: 620 },
];

const HERO_VARS = {
  bgPrimary: '#050b1f',
  bgSecondary: '#0b1530',
  accentColor: '#38a3ff',
};

const GITHUB_LIGHT_VARS = {
  bgPrimary: '#ffffff',
  bgSecondary: '#f6f8fa',
  accentColor: '#0969da',
};

const LONG_RUNBAR_CURRENT_NODE_LABEL = 'main/orpad-ux-worker-loop/claim-wi-frontend-ux-runbar-current-node-readability/adapters/managed-run/current-node-with-readable-label';

function writeApprovedWorkspace(userData: string, workspaceRoot: string): void {
  fs.writeFileSync(path.join(userData, 'approved-workspace.json'), JSON.stringify({
    version: 1,
    workspaceRoot,
  }, null, 2));
}

function writeVisualSmokeHarnessReadinessArtifacts(generatedDir: string): void {
  fs.writeFileSync(path.join(generatedDir, 'project-profile.json'), JSON.stringify({
    schemaVersion: 'orpad.projectProfile.v1',
    projectStacks: [{ id: 'node-frontend', confidence: 'high' }],
    requiredTools: ['node', 'npm', 'playwright'],
    validationCommands: [
      'npm run build:renderer',
      'npx playwright test --project=electron-visual-smoke tests/e2e/ux-visual-smoke.spec.ts --grep "visual smoke"',
    ],
  }, null, 2));
  fs.writeFileSync(path.join(generatedDir, 'tool-health.json'), JSON.stringify({
    schemaVersion: 'orpad.harnessToolHealth.v1',
    summary: { total: 5, ready: 5, degraded: 0, missing: 0, unknown: 0 },
  }, null, 2));
  fs.writeFileSync(path.join(generatedDir, 'validation-preflight.json'), JSON.stringify({
    schemaVersion: 'orpad.harnessValidationPreflight.v1',
    summary: { total: 3, ready: 3, blocked: 0, unknown: 0 },
  }, null, 2));
  fs.writeFileSync(path.join(generatedDir, 'mcp-plan.json'), JSON.stringify({
    schemaVersion: 'orpad.harnessMcpPlan.v1',
    recommendedServers: [
      { id: 'filesystem', status: 'ready' },
      { id: 'git', status: 'ready' },
    ],
    orpadCapabilities: [
      { id: 'terminal', status: 'available' },
      { id: 'browser', status: 'available' },
    ],
  }, null, 2));
  fs.writeFileSync(path.join(generatedDir, 'harness-provisioning.json'), JSON.stringify({
    schemaVersion: 'orpad.harnessProvisioning.v1',
    status: 'ready',
    enforcement: {
      runBlockers: [],
      warnings: ['Visual smoke fixture seeds VM Harness readiness for screenshot coverage.'],
    },
  }, null, 2));
  fs.writeFileSync(path.join(generatedDir, 'README.md'), [
    '# Harness Implementation',
    '',
    'Provisioning: ready',
  ].join('\n'));
}

function seedVisualSmokeHarnessImplementation(pipelinePath: string): void {
  const pipelineDir = path.dirname(pipelinePath);
  const generatedDir = path.join(pipelineDir, 'harness', 'generated');
  fs.mkdirSync(path.join(generatedDir, 'nodes'), { recursive: true });
  const implementedAt = '2026-05-01T00:10:00.000Z';
  const nodes = ['main/context', 'main/probe', 'main/queue', 'main/triage', 'main/dispatch', 'main/worker']
    .map((nodePath) => ({
      nodePath,
      status: 'succeeded',
      artifact: `nodes/${nodePath.replace(/[^\w.-]+/g, '-')}.json`,
      completedAt: implementedAt,
    }));

  fs.writeFileSync(path.join(generatedDir, 'implementation-state.json'), JSON.stringify({
    schemaVersion: 'orpad.harnessImplementation.v1',
    status: 'succeeded',
    startedAt: '2026-05-01T00:09:00.000Z',
    updatedAt: implementedAt,
    implementedAt,
    message: 'Harness implementation completed.',
    nodeCount: nodes.length,
    projectProfile: {
      path: 'project-profile.json',
      stacks: ['node-frontend'],
      requiredTools: ['node', 'npm', 'playwright'],
      validationCommandCount: 2,
    },
    toolPlan: {
      path: 'tool-plan.json',
      mcpRecommendations: ['filesystem', 'git'],
    },
    provisioning: {
      path: 'harness-provisioning.json',
      toolHealthPath: 'tool-health.json',
      validationPreflightPath: 'validation-preflight.json',
      mcpPlanPath: 'mcp-plan.json',
      status: 'ready',
      blockers: [],
      warnings: ['Visual smoke fixture seeds VM Harness readiness for screenshot coverage.'],
      toolHealthSummary: { total: 5, ready: 5, degraded: 0, missing: 0, unknown: 0 },
      validationPreflightSummary: { total: 3, ready: 3, blocked: 0, unknown: 0 },
      mcpRecommendedServers: [
        { id: 'filesystem', status: 'ready' },
        { id: 'git', status: 'ready' },
      ],
      orpadCapabilities: [
        { id: 'terminal', status: 'available' },
        { id: 'browser', status: 'available' },
      ],
    },
    nodes,
  }, null, 2));
  writeVisualSmokeHarnessReadinessArtifacts(generatedDir);

  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  pipeline.harness = {
    ...(pipeline.harness || {}),
    path: 'harness/generated',
    implementationState: 'harness/generated/implementation-state.json',
    projectProfile: 'harness/generated/project-profile.json',
    provisioning: 'harness/generated/harness-provisioning.json',
    toolHealth: 'harness/generated/tool-health.json',
    validationPreflight: 'harness/generated/validation-preflight.json',
    mcpPlan: 'harness/generated/mcp-plan.json',
    implementedAt,
  };
  pipeline.metadata = {
    ...(pipeline.metadata || {}),
    harnessImplementation: {
      ...(pipeline.metadata?.harnessImplementation || {}),
      status: 'succeeded',
      implementedAt,
      statePath: 'harness/generated/implementation-state.json',
      projectProfilePath: 'harness/generated/project-profile.json',
      nodeCount: nodes.length,
    },
  };
  fs.writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2));
}

function writeVisualSmokeWorkspace(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-ux-visual-smoke-'));
  const pipelineDir = path.join(workspace, '.orpad', 'pipelines', 'visual-smoke-workstream');
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  fs.mkdirSync(path.join(pipelineDir, 'graphs'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'visual-smoke-target.md'), 'before visual smoke\n', 'utf-8');

  fs.writeFileSync(path.join(pipelineDir, 'graphs', 'main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'visual-smoke-workstream',
      nodes: [
        { id: 'context', type: 'orpad.context', label: 'Collect redesign context', config: { summary: 'Capture OrPAD UX overhaul context.' } },
        { id: 'probe', type: 'orpad.probe', label: 'Probe visual gap', config: { lens: 'ux-visual-smoke' } },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue visual work', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', label: 'Triage layout risk', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch bounded patch', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Worker evidence loop', config: { queueRef: 'queue' } },
      ],
      transitions: [
        { from: 'context', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
      ],
    },
  }, null, 2), 'utf-8');

  fs.writeFileSync(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'visual-smoke-workstream',
    title: 'Visual Smoke Workstream',
    description: 'Focused fixture for OrPAD UX visual smoke review.',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    nodePacks: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3', origin: 'built-in' },
      { id: 'orpad.workstream', version: '>=0.1.0', origin: 'built-in' },
      { id: 'community.review-required', version: '0.4.0', origin: 'user-installed' },
    ],
    maintenancePolicy: {
      handoff: {
        promptContract: 'path-only',
        launchPromptShape: '<pipeline.or-pipeline path> --visual-smoke',
      },
    },
    run: {
      artifactRoot: 'harness/generated/latest-run/artifacts',
      queueRoot: 'harness/generated/latest-run/queue',
      metadataPath: 'harness/generated/latest-run/run-metadata.json',
      summaryPath: 'harness/generated/latest-run/summary.md',
      machineHarness: {
        candidateProposal: {
          schemaVersion: 'orpad.candidateProposal.v1',
          proposalId: 'proposal-visual-smoke',
          suggestedWorkItemId: 'visual-smoke',
          sourceNode: 'main/probe',
          title: 'Capture UX visual smoke evidence',
          fingerprint: 'visual-smoke:src/visual-smoke-target.md',
          evidence: [{ id: 'target-before', file: 'src/visual-smoke-target.md' }],
          acceptanceCriteria: ['Screenshots show the redesigned OrPAD surfaces.'],
          sourceOfTruthTargets: ['src/visual-smoke-target.md'],
        },
        expectedChangedFiles: ['src/visual-smoke-target.md'],
        nodeCliPatch: {
          file: 'src/visual-smoke-target.md',
          content: 'after visual smoke\n',
        },
      },
    },
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
  }, null, 2), 'utf-8');

  seedVisualSmokeHarnessImplementation(pipelinePath);

  return workspace;
}

function paethPredictor(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function pngStats(png: Buffer): PngStats {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(png.subarray(0, 8).equals(signature), 'surface screenshot should be a PNG').toBe(true);

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Buffer[] = [];
  let offset = 8;

  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    expect(dataEnd + 4, `PNG chunk ${type} should fit in the screenshot`).toBeLessThanOrEqual(png.length);
    const data = png.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  const channelsByColorType: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelsByColorType[colorType];
  expect(width, 'PNG width should be present').toBeGreaterThan(0);
  expect(height, 'PNG height should be present').toBeGreaterThan(0);
  expect(bitDepth, 'visual smoke PNG parser expects 8-bit screenshots').toBe(8);
  expect(interlace, 'visual smoke PNG parser expects non-interlaced screenshots').toBe(0);
  expect(Boolean(channels), `visual smoke PNG parser supports color type ${colorType}`).toBe(true);
  expect(idatChunks.length, 'PNG should include image data').toBeGreaterThan(0);
  if (!channels) {
    throw new Error(`Unsupported PNG color type ${colorType}`);
  }

  const rowBytes = width * channels;
  const bytesPerPixel = channels;
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const pixels = Buffer.alloc(rowBytes * height);
  let rawOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    const rowStart = y * rowBytes;
    const previousRowStart = rowStart - rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const value = raw[rawOffset];
      rawOffset += 1;
      const left = x >= bytesPerPixel ? pixels[rowStart + x - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[previousRowStart + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? pixels[previousRowStart + x - bytesPerPixel] : 0;
      let reconstructed = value;
      if (filter === 1) reconstructed = value + left;
      if (filter === 2) reconstructed = value + up;
      if (filter === 3) reconstructed = value + Math.floor((left + up) / 2);
      if (filter === 4) reconstructed = value + paethPredictor(left, up, upLeft);
      pixels[rowStart + x] = reconstructed & 0xff;
    }
  }

  const totalPixels = width * height;
  const sampleEvery = Math.max(1, Math.floor(totalPixels / 5000));
  const colors = new Set<string>();
  let sampledPixels = 0;
  let opaquePixels = 0;
  let minLuminance = 255;
  let maxLuminance = 0;

  for (let pixel = 0; pixel < totalPixels; pixel += sampleEvery) {
    const index = pixel * channels;
    let red = pixels[index];
    let green = pixels[index];
    let blue = pixels[index];
    let alpha = 255;
    if (colorType === 2 || colorType === 6) {
      red = pixels[index];
      green = pixels[index + 1];
      blue = pixels[index + 2];
      alpha = colorType === 6 ? pixels[index + 3] : 255;
    } else if (colorType === 4) {
      alpha = pixels[index + 1];
    }
    sampledPixels += 1;
    if (alpha <= 8) continue;
    opaquePixels += 1;
    colors.add(`${red >> 4}:${green >> 4}:${blue >> 4}`);
    const luminance = (red * 299 + green * 587 + blue * 114) / 1000;
    minLuminance = Math.min(minLuminance, luminance);
    maxLuminance = Math.max(maxLuminance, luminance);
  }

  return {
    width,
    height,
    sampledPixels,
    opaquePixels,
    uniqueColors: colors.size,
    luminanceRange: maxLuminance - minLuminance,
  };
}

async function captureSurfaceEvidence(
  testInfo: TestInfo,
  locator: Locator,
  name: string,
  options: {
    minWidth: number;
    minHeight: number;
    expectChrome?: boolean;
    minUniqueColors?: number;
    minLuminanceRange?: number;
    minTextContrast?: number;
    minAverageTextContrast?: number;
  },
): Promise<void> {
  await expect(locator, `${name}: surface should be visible`).toBeVisible({ timeout: 15000 });
  const box = await locator.boundingBox();
  expect(box, `${name}: surface should have a layout box`).not.toBeNull();
  expect(box!.width, `${name}: surface width should not collapse`).toBeGreaterThanOrEqual(options.minWidth);
  expect(box!.height, `${name}: surface height should not collapse`).toBeGreaterThanOrEqual(options.minHeight);

  const domShape = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const visibleChildren = [...element.querySelectorAll<HTMLElement>('*')].filter((child) => {
      const childRect = child.getBoundingClientRect();
      const childStyle = getComputedStyle(child);
      return childRect.width > 0
        && childRect.height > 0
        && childStyle.display !== 'none'
        && childStyle.visibility !== 'hidden';
    }).length;
    return {
      width: rect.width,
      height: rect.height,
      textLength: (element.textContent || '').replace(/\s+/g, ' ').trim().length,
      visibleChildren,
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      boxShadow: style.boxShadow,
      borderColor: style.borderColor,
    };
  });
  expect(domShape.textLength + domShape.visibleChildren, `${name}: surface should not be blank`).toBeGreaterThan(4);

  const contrastStats = await locator.evaluate((element): ContrastStats => {
    type Rgba = { r: number; g: number; b: number; a: number };

    const parseRgb = (color: string): Rgba | null => {
      const match = color.match(/rgba?\(([^)]+)\)/i);
      if (!match) return null;
      const parts = match[1].split(/[\s,/]+/).filter(Boolean);
      const [r, g, b] = parts.slice(0, 3).map((part) => Number.parseFloat(part));
      const a = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]);
      if (![r, g, b, a].every(Number.isFinite)) return null;
      return { r, g, b, a };
    };

    const channelLuminance = (channel: number) => {
      const normalized = Math.max(0, Math.min(255, channel)) / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    };

    const luminance = (color: Rgba) => (
      0.2126 * channelLuminance(color.r)
      + 0.7152 * channelLuminance(color.g)
      + 0.0722 * channelLuminance(color.b)
    );

    const contrastRatio = (foreground: Rgba, background: Rgba) => {
      const light = Math.max(luminance(foreground), luminance(background));
      const dark = Math.min(luminance(foreground), luminance(background));
      return (light + 0.05) / (dark + 0.05);
    };

    const resolvedBackground = (node: Element): Rgba => {
      let current: Element | null = node;
      while (current) {
        const background = parseRgb(getComputedStyle(current).backgroundColor);
        if (background && background.a > 0.2) return background;
        current = current.parentElement;
      }
      return parseRgb(getComputedStyle(document.body).backgroundColor)
        || parseRgb(getComputedStyle(document.documentElement).backgroundColor)
        || { r: 5, g: 11, b: 31, a: 1 };
    };

    const candidates = [element as HTMLElement, ...element.querySelectorAll<HTMLElement>('*')]
      .filter((child) => {
        const ownText = [...child.childNodes].some((node) => (
          node.nodeType === Node.TEXT_NODE
          && (node.textContent || '').replace(/\s+/g, '').length > 0
        ));
        if (!ownText) return false;
        const rect = child.getBoundingClientRect();
        const style = getComputedStyle(child);
        return rect.width > 4
          && rect.height > 4
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number.parseFloat(style.fontSize || '0') >= 8;
      })
      .slice(0, 96);

    let sampledTextElements = 0;
    let minContrastRatio = Number.POSITIVE_INFINITY;
    let maxContrastRatio = 0;
    let contrastTotal = 0;

    for (const candidate of candidates) {
      const foreground = parseRgb(getComputedStyle(candidate).color);
      if (!foreground || foreground.a <= 0.2) continue;
      const ratio = contrastRatio(foreground, resolvedBackground(candidate));
      sampledTextElements += 1;
      minContrastRatio = Math.min(minContrastRatio, ratio);
      maxContrastRatio = Math.max(maxContrastRatio, ratio);
      contrastTotal += ratio;
    }

    return {
      sampledTextElements,
      minContrastRatio: sampledTextElements ? minContrastRatio : 0,
      maxContrastRatio,
      averageContrastRatio: sampledTextElements ? contrastTotal / sampledTextElements : 0,
    };
  });
  expect(contrastStats.sampledTextElements, `${name}: text contrast sampler should find visible labels`).toBeGreaterThan(0);
  expect(contrastStats.maxContrastRatio, `${name}: surface should include readable text contrast`).toBeGreaterThanOrEqual(options.minTextContrast ?? 3);
  expect(contrastStats.averageContrastRatio, `${name}: surface text should not wash into its background`).toBeGreaterThanOrEqual(options.minAverageTextContrast ?? 2.2);

  if (options.expectChrome) {
    const chrome = `${domShape.backgroundImage} ${domShape.boxShadow} ${domShape.borderColor}`;
    expect(chrome, `${name}: surface should carry styled chrome`).toMatch(/gradient|rgba|rgb|color/i);
  }

  const screenshot = await locator.screenshot({ animations: 'disabled' });
  await testInfo.attach(`${name}.png`, { body: screenshot, contentType: 'image/png' });
  const stats = pngStats(screenshot);
  expect(stats.width, `${name}: screenshot width should not collapse`).toBeGreaterThanOrEqual(Math.floor(options.minWidth));
  expect(stats.height, `${name}: screenshot height should not collapse`).toBeGreaterThanOrEqual(Math.floor(options.minHeight));
  expect(stats.opaquePixels, `${name}: screenshot should have visible pixels`).toBeGreaterThan(50);
  expect(stats.uniqueColors, `${name}: screenshot should not be a flat blank panel`).toBeGreaterThanOrEqual(options.minUniqueColors ?? 5);
  expect(stats.luminanceRange, `${name}: screenshot should include visible content contrast`).toBeGreaterThanOrEqual(options.minLuminanceRange ?? 8);
}

async function expectThemeTokens(win: Page, expected: ThemeVarSnapshot): Promise<void> {
  const vars = await win.evaluate(() => {
    const styles = getComputedStyle(document.documentElement);
    return {
      bgPrimary: styles.getPropertyValue('--bg-primary').trim().toLowerCase(),
      bgSecondary: styles.getPropertyValue('--bg-secondary').trim().toLowerCase(),
      accentColor: styles.getPropertyValue('--accent-color').trim().toLowerCase(),
    };
  });
  expect(vars.bgPrimary).toBe(expected.bgPrimary);
  expect(vars.bgSecondary).toBe(expected.bgSecondary);
  expect(vars.accentColor).toBe(expected.accentColor);
}

async function expectHeroThemeTokens(win: Page): Promise<void> {
  await expectThemeTokens(win, HERO_VARS);
}

async function expectGithubLightThemeTokens(win: Page): Promise<void> {
  await expectThemeTokens(win, GITHUB_LIGHT_VARS);
}

async function setNodePackManagerVisualMock(win: Page): Promise<void> {
  await win.evaluate(() => {
    const nodePacks = [
      {
        id: 'orpad.core',
        name: 'OrPAD Core Nodes',
        version: '1.0.0',
        origin: 'built-in',
        trustLevel: 'official',
        resolutionState: 'resolved',
        validationStatus: 'valid',
        capabilities: ['read.workspace'],
        discovery: {
          rootKind: 'built-in',
          packDir: '/app/nodes/core',
          manifestPath: '/app/nodes/core/orpad.node-pack.json',
        },
        nodes: [{ type: 'orpad.gate', label: 'Gate' }],
      },
      {
        id: 'orpad.starter.frontend-ux',
        name: 'Frontend UX Starter Package',
        version: '0.1.0',
        origin: 'built-in',
        trustLevel: 'official',
        resolutionState: 'resolved',
        validationStatus: 'valid',
        capabilities: ['read.workspace', 'write.runArtifacts'],
        description: 'Reusable orchestration hints for renderer UI and e2e verification.',
        discovery: {
          rootKind: 'built-in',
          packDir: '/app/nodes/orpad.starter.frontend-ux',
          manifestPath: '/app/nodes/orpad.starter.frontend-ux/orpad.node-pack.json',
        },
        nodes: [],
        graphs: [{
          id: 'frontend-ux-workstream',
          path: 'graphs/frontend-ux-workstream.or-graph',
          role: 'reusable',
          description: 'Discovery and verification lens for UI workflows.',
        }],
        skills: [{
          id: 'frontend-ux-audit',
          path: 'skills/frontend-ux-audit.md',
          description: 'Guides UI state, layout, interaction, accessibility, screenshot, and e2e evidence.',
        }],
        rules: [{
          id: 'frontend-ux-scope',
          path: 'rules/frontend-ux-scope.or-rule',
          description: 'Includes renderer UI, styles, Playwright/e2e tests, and browser-facing assets.',
        }],
      },
      {
        id: 'community.review-required',
        name: 'Review Required Package',
        version: '0.4.0',
        origin: 'user-installed',
        trustLevel: 'signed-community',
        resolutionState: 'approval-required',
        validationStatus: 'approval-required',
        capabilities: ['read.workspace', 'use.credentials'],
        capabilityRiskSummary: 'high-risk capabilities: use.credentials; quarantined install behaviors: handler.executable; validation state: approval-required',
        highRiskCapabilities: ['use.credentials'],
        highRiskInstallBehaviors: ['handler.executable'],
        diagnostics: [{
          level: 'warning',
          code: 'NODE_PACK_HIGH_RISK_CAPABILITY_REVIEW_REQUIRED',
          message: 'Community Package requests high-risk authority without approved review.',
          packId: 'community.review-required',
          capability: 'use.credentials',
          scope: 'pack',
        }],
        discovery: {
          rootKind: 'user',
          packDir: '/packs/community.review-required',
          manifestPath: '/packs/community.review-required/orpad.node-pack.json',
        },
        nodes: [{ type: 'community.secretProbe', label: 'Secret Probe', capabilities: ['use.credentials'] }],
      },
    ];
    const mockListNodePacks = async () => ({
      success: true,
      ok: true,
      nodePacks,
      diagnostics: [],
      conflicts: [],
    });
    (mockListNodePacks as any).orpadTestOverride = true;
    (window as any).__orpadNodePackManagerListPacks = mockListNodePacks;
    (window as any).__orpadNodePackListPacks = mockListNodePacks;
  });
}

async function openVisualSmokePipeline(win: Page, options: { resetTheme?: boolean } = {}): Promise<void> {
  const { resetTheme = true } = options;
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('.cm-editor', { state: 'attached', timeout: 15000 });
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand, null, { timeout: 15000 });
  await win.evaluate(async (shouldResetTheme) => {
    if (shouldResetTheme) {
      localStorage.removeItem('orpad-theme');
    }
    await (window as any).orpadCommands.runCommand('view.runbooks');
  }, resetTheme);

  await expect(win.locator('#sidebar-runbooks')).toBeVisible();
  await expect(win.locator('#runbooks-content')).toContainText('Visual Smoke Workstream');
  await win.locator('.runbook-item').filter({ hasText: 'Visual Smoke Workstream' }).click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible({ timeout: 15000 });
  await win.locator('#btn-split').click();
  await expect(win.locator('.cm-content')).toContainText('visual-smoke-workstream');
}

async function fitGraphIfAvailable(win: Page): Promise<void> {
  const fit = win.locator('.orch-graph-frame [data-orch-action="fit"]').first();
  if (await fit.isVisible().catch(() => false)) {
    await fit.click();
    await win.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  }
}

async function expectRunbarCurrentNodeBreathes(runbar: Locator, viewport: ViewportCase): Promise<void> {
  await runbar.evaluate((element, label) => {
    const meta = element.querySelector('.pipeline-runbar-meta');
    if (!meta) throw new Error('Runbar metadata container is missing');
    let current = meta.querySelector<HTMLElement>('.pipeline-runbar-current');
    if (!current) {
      current = document.createElement('span');
      current.className = 'pipeline-runbar-current';
      meta.append(current);
    }
    current.textContent = label;
    current.title = `Currently running: ${label}`;
  }, LONG_RUNBAR_CURRENT_NODE_LABEL);

  const currentChip = runbar.locator('.pipeline-runbar-current').first();
  await expect(currentChip, `${viewport.name}: runbar should expose the long current node`).toHaveText(LONG_RUNBAR_CURRENT_NODE_LABEL);
  await expect(currentChip, `${viewport.name}: long current node should keep its full title`).toHaveAttribute(
    'title',
    `Currently running: ${LONG_RUNBAR_CURRENT_NODE_LABEL}`,
  );

  const metrics = await runbar.evaluate((element) => {
    const current = element.querySelector<HTMLElement>('.pipeline-runbar-current');
    const status = element.querySelector<HTMLElement>('.pipeline-runbar-status[role="status"]');
    const actions = element.querySelector<HTMLElement>('.pipeline-runbar-actions');
    if (!current || !actions) throw new Error('Runbar current node or actions are missing');

    const runbarRect = element.getBoundingClientRect();
    const currentRect = current.getBoundingClientRect();
    const statusRect = status?.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const style = getComputedStyle(current);
    const fullLabelProbe = current.cloneNode(true) as HTMLElement;
    fullLabelProbe.style.position = 'fixed';
    fullLabelProbe.style.visibility = 'hidden';
    fullLabelProbe.style.pointerEvents = 'none';
    fullLabelProbe.style.width = 'max-content';
    fullLabelProbe.style.maxWidth = 'none';
    fullLabelProbe.style.overflow = 'visible';
    document.body.append(fullLabelProbe);
    const fullLabelWidth = fullLabelProbe.getBoundingClientRect().width;
    fullLabelProbe.remove();
    return {
      actionsRight: actionsRect.right,
      actionsWidth: actionsRect.width,
      currentClientWidth: current.clientWidth,
      currentWidth: currentRect.width,
      flexBasis: style.flexBasis,
      flexGrow: style.flexGrow,
      fullLabelWidth,
      maxWidth: style.maxWidth,
      overflowX: style.overflowX,
      runbarClientWidth: element.clientWidth,
      runbarRight: runbarRect.right,
      runbarScrollWidth: element.scrollWidth,
      statusWidth: statusRect?.width || 0,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
    };
  });

  expect(metrics.textOverflow, `${viewport.name}: long current node should ellipsize`).toBe('ellipsis');
  expect(metrics.whiteSpace, `${viewport.name}: long current node should stay on one line`).toBe('nowrap');
  expect(metrics.overflowX, `${viewport.name}: long current node should clip safely`).toBe('hidden');
  expect(metrics.fullLabelWidth, `${viewport.name}: long current node fixture should be wider than the chip`).toBeGreaterThan(metrics.currentClientWidth + 8);
  expect(metrics.runbarScrollWidth, `${viewport.name}: runbar should not create horizontal overflow`).toBeLessThanOrEqual(metrics.runbarClientWidth + 1);
  expect(metrics.actionsWidth, `${viewport.name}: runbar actions should remain measurable`).toBeGreaterThan(0);
  expect(metrics.actionsRight, `${viewport.name}: runbar actions should remain inside the runbar`).toBeLessThanOrEqual(metrics.runbarRight + 1);
  expect(Number.parseFloat(metrics.flexGrow), `${viewport.name}: current node should flex beyond fixed metadata chips`).toBeGreaterThan(1);
  expect(metrics.flexBasis, `${viewport.name}: current node should have a readable flex basis`).not.toBe('auto');
  expect(metrics.maxWidth, `${viewport.name}: current node should keep a bounded max width`).not.toBe('none');
  if (viewport.name === 'desktop') {
    expect(metrics.currentWidth, `${viewport.name}: current node should be wider than secondary status chips`)
      .toBeGreaterThan(Math.max(metrics.statusWidth + 24, 156));
  } else {
    expect(metrics.currentWidth, `${viewport.name}: current node should stay readable in constrained smoke viewport`)
      .toBeGreaterThan(100);
  }
}

async function expectRunbarSolidThemeChrome(runbar: Locator, name: string): Promise<void> {
  await expect(runbar, `${name}: runbar should be visible for chrome inspection`).toBeVisible({ timeout: 15000 });

  const chrome = await runbar.evaluate((element) => {
    const parseColor = (value: string): { r: number; g: number; b: number; alpha: number } | null => {
      const rgb = value.match(/rgba?\(([^)]+)\)/i);
      if (rgb) {
        const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
        const [r, g, b] = parts.slice(0, 3).map((part) => Number.parseFloat(part));
        const alpha = parts[3] === undefined
          ? 1
          : Number.parseFloat(parts[3]) / (parts[3].endsWith('%') ? 100 : 1);
        return [r, g, b, alpha].every(Number.isFinite) ? { r, g, b, alpha } : null;
      }
      const srgb = value.match(/color\(\s*srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+%?))?/i);
      if (srgb) {
        const [r, g, b] = srgb.slice(1, 4).map((part) => Number.parseFloat(part));
        const alpha = srgb[4] === undefined
          ? 1
          : Number.parseFloat(srgb[4]) / (srgb[4].endsWith('%') ? 100 : 1);
        if (![r, g, b, alpha].every(Number.isFinite)) return null;
        return {
          r: r <= 1 ? r * 255 : r,
          g: g <= 1 ? g * 255 : g,
          b: b <= 1 ? b * 255 : b,
          alpha,
        };
      }
      return null;
    };

    const backgroundAlpha = (style: CSSStyleDeclaration): number => {
      const value = String(style.backgroundColor || '').trim();
      if (!value || /\btransparent\b/i.test(value)) return 0;
      return parseColor(value)?.alpha ?? 1;
    };

    const readBackdrop = (style: CSSStyleDeclaration): string => (
      style.getPropertyValue('backdrop-filter')
      || style.getPropertyValue('-webkit-backdrop-filter')
      || 'none'
    ).trim();

    const readChip = (chip: HTMLElement) => {
      const style = getComputedStyle(chip);
      const before = getComputedStyle(chip, '::before');
      const rect = chip.getBoundingClientRect();
      return {
        className: chip.className,
        text: (chip.textContent || '').replace(/\s+/g, ' ').trim(),
        width: rect.width,
        height: rect.height,
        backgroundColor: style.backgroundColor,
        backgroundAlpha: backgroundAlpha(style),
        backgroundImage: style.backgroundImage,
        backdropFilter: readBackdrop(style),
        boxShadow: style.boxShadow,
        beforeBoxShadow: before.boxShadow,
      };
    };

    const style = getComputedStyle(element);
    const chips = [...element.querySelectorAll<HTMLElement>([
      '.pipeline-runbar-path',
      '.pipeline-runbar-status',
      '.pipeline-runbar-current',
      '.pipeline-runbar-progress',
      '.pipeline-runbar-elapsed',
      '.pipe-budget-chip',
    ].join(','))]
      .filter((chip) => {
        const chipStyle = getComputedStyle(chip);
        const rect = chip.getBoundingClientRect();
        return rect.width > 0
          && rect.height > 0
          && chipStyle.display !== 'none'
          && chipStyle.visibility !== 'hidden';
      })
      .map(readChip);

    return {
      runbar: {
        backgroundColor: style.backgroundColor,
        backgroundAlpha: backgroundAlpha(style),
        backgroundImage: style.backgroundImage,
        backdropFilter: readBackdrop(style),
        boxShadow: style.boxShadow,
      },
      chips,
    };
  });

  expect(chrome.runbar.backgroundImage, `${name}: runbar should not use gradients or image backgrounds`).toBe('none');
  expect(chrome.runbar.backdropFilter, `${name}: runbar should not use blur or backdrop filters`).toBe('none');
  expect(chrome.runbar.backgroundAlpha, `${name}: runbar should use an opaque theme-token surface`).toBeGreaterThan(0.98);
  expect(chrome.runbar.boxShadow, `${name}: runbar should use solid chrome without raised/glow shadow`).toBe('none');
  expect(chrome.chips.length, `${name}: runbar should expose compact status chips`).toBeGreaterThan(0);

  for (const chip of chrome.chips) {
    const label = chip.text || chip.className;
    expect(chip.backgroundImage, `${name}: ${label} chip should not use gradients or image backgrounds`).toBe('none');
    expect(chip.backdropFilter, `${name}: ${label} chip should not use blur or backdrop filters`).toBe('none');
    expect(chip.backgroundAlpha, `${name}: ${label} chip should use an opaque theme-token surface`).toBeGreaterThan(0.98);
    expect(chip.boxShadow, `${name}: ${label} chip should not use glow shadows`).toBe('none');
    expect(chip.beforeBoxShadow, `${name}: ${label} chip marker should not use glow shadows`).toBe('none');
  }
}

async function expectGraphToolbarSolidControls(win: Page, name: string): Promise<void> {
  const toolbar = win.locator('.orch-graph-frame .orch-graph-tools').first();
  await expect(toolbar, `${name}: graph toolbar should be visible`).toBeVisible({ timeout: 15000 });

  const button = toolbar.locator('.orch-tool-btn').first();
  await expect(button, `${name}: graph toolbar should expose tool buttons`).toBeVisible();

  const normal = await button.evaluate((element) => {
    const wasActive = element.classList.contains('active');
    if (wasActive) {
      element.classList.remove('active');
    }
    const toolbarElement = element.closest('.orch-graph-tools');
    const toolbarStyle = toolbarElement ? getComputedStyle(toolbarElement) : null;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const result = {
      toolbarBackgroundImage: toolbarStyle?.backgroundImage || '',
      toolbarBackgroundColor: toolbarStyle?.backgroundColor || '',
      toolbarBorderColor: toolbarStyle?.borderColor || '',
      buttonBackgroundImage: style.backgroundImage,
      buttonBackgroundColor: style.backgroundColor,
      buttonBorderColor: style.borderColor,
      buttonColor: style.color,
      width: rect.width,
      height: rect.height,
    };
    if (wasActive) {
      element.classList.add('active');
    }
    return result;
  });

  expect(normal.toolbarBackgroundImage, `${name}: graph toolbar container should not use image or gradient chrome`).toBe('none');
  expect(normal.buttonBackgroundImage, `${name}: graph tool button should not use image or gradient chrome`).toBe('none');
  expect(normal.toolbarBackgroundColor, `${name}: graph toolbar should keep a theme surface background`).toMatch(/rgb|color/i);
  expect(normal.toolbarBorderColor, `${name}: graph toolbar should keep a themed border`).toMatch(/rgb|color/i);
  expect(normal.width, `${name}: graph tool button width should remain stable`).toBeGreaterThan(0);
  expect(normal.height, `${name}: graph tool button height should remain stable`).toBeGreaterThan(0);

  await button.hover();
  const hover = await button.evaluate((element) => {
    const wasActive = element.classList.contains('active');
    if (wasActive) {
      element.classList.remove('active');
    }
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const result = {
      backgroundImage: style.backgroundImage,
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      color: style.color,
      width: rect.width,
      height: rect.height,
    };
    if (wasActive) {
      element.classList.add('active');
    }
    return result;
  });
  expect(hover.backgroundImage, `${name}: graph tool hover state should stay solid`).toBe('none');
  expect(hover.backgroundColor, `${name}: graph tool hover should change background through theme tokens`).not.toBe(normal.buttonBackgroundColor);
  expect(hover.borderColor, `${name}: graph tool hover should change border through theme tokens`).not.toBe(normal.buttonBorderColor);
  expect(hover.color, `${name}: graph tool hover should change text/icon color through theme tokens`).not.toBe(normal.buttonColor);
  expect(Math.abs(hover.width - normal.width), `${name}: graph tool hover should not change width`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(hover.height - normal.height), `${name}: graph tool hover should not change height`).toBeLessThanOrEqual(0.5);

  const active = await button.evaluate((element) => {
    const wasActive = element.classList.contains('active');
    element.classList.add('active');
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const result = {
      backgroundImage: style.backgroundImage,
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      color: style.color,
      width: rect.width,
      height: rect.height,
    };
    if (!wasActive) {
      element.classList.remove('active');
    }
    return result;
  });
  expect(active.backgroundImage, `${name}: active graph tool button should stay solid`).toBe('none');
  expect(active.backgroundColor, `${name}: active graph tool should change background through theme tokens`).not.toBe(normal.buttonBackgroundColor);
  expect(active.borderColor, `${name}: active graph tool should change border through theme tokens`).not.toBe(normal.buttonBorderColor);
  expect(active.color, `${name}: active graph tool should change text/icon color through theme tokens`).not.toBe(normal.buttonColor);
  expect(Math.abs(active.width - normal.width), `${name}: active graph tool should not change width`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(active.height - normal.height), `${name}: active graph tool should not change height`).toBeLessThanOrEqual(0.5);
}

async function expectGraphOverlayControlsSolidChrome(win: Page, name: string): Promise<void> {
  const frame = win.locator('.orch-graph-frame').first();
  await expect(frame, `${name}: graph frame should be visible for overlay chrome inspection`).toBeVisible({ timeout: 15000 });

  const probeId = `graph-overlay-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  await win.evaluate((id) => {
    document.querySelector(`[data-graph-overlay-probe="${id}"]`)?.remove();
    const graphFrame = document.querySelector<HTMLElement>('.orch-graph-frame');
    if (!graphFrame) throw new Error('Missing .orch-graph-frame for overlay chrome probe');

    const probe = document.createElement('div');
    probe.dataset.graphOverlayProbe = id;
    probe.setAttribute('aria-hidden', 'true');
    probe.style.position = 'absolute';
    probe.style.inset = '0';
    probe.style.zIndex = '30';

    const legend = document.createElement('div');
    legend.className = 'orch-graph-legend';
    legend.dataset.probeOverlay = 'legend';
    const legendTitle = document.createElement('div');
    legendTitle.className = 'orch-graph-legend-title';
    legendTitle.textContent = 'Legend';
    const legendList = document.createElement('ul');
    legendList.className = 'orch-graph-legend-list';
    const legendItem = document.createElement('li');
    legendItem.className = 'orch-graph-legend-item';
    legendItem.textContent = 'Forward';
    legendList.append(legendItem);
    legend.append(legendTitle, legendList);

    const controls = document.createElement('div');
    controls.className = 'orch-graph-run-controls';
    controls.dataset.probeOverlay = 'run-controls';
    controls.style.top = '44px';

    const makeButton = (className: string, label: string, role: string) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.dataset.probeRunBtn = role;
      button.textContent = label;
      return button;
    };

    controls.append(
      makeButton('orch-graph-run-btn', 'P', 'pause'),
      makeButton('orch-graph-run-btn resume', 'R', 'resume'),
      makeButton('orch-graph-run-btn cancel', 'C', 'cancel'),
    );

    probe.append(legend, controls);
    graphFrame.append(probe);
  }, probeId);

  const probe = win.locator(`[data-graph-overlay-probe="${probeId}"]`);
  const readChrome = (element: HTMLElement) => {
    const parseAlpha = (value: string): number => {
      const normalized = value.trim();
      if (!normalized || /\btransparent\b/i.test(normalized)) return 0;
      const rgb = normalized.match(/rgba?\(([^)]+)\)/i);
      if (rgb) {
        const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
        const alpha = parts[3] === undefined
          ? 1
          : Number.parseFloat(parts[3]) / (parts[3].endsWith('%') ? 100 : 1);
        return Number.isFinite(alpha) ? alpha : 1;
      }
      const srgb = normalized.match(/color\(\s*srgb\s+[0-9.]+\s+[0-9.]+\s+[0-9.]+(?:\s*\/\s*([0-9.]+%?))?/i);
      if (srgb) {
        const alpha = srgb[1] === undefined
          ? 1
          : Number.parseFloat(srgb[1]) / (srgb[1].endsWith('%') ? 100 : 1);
        return Number.isFinite(alpha) ? alpha : 1;
      }
      return 1;
    };

    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      backgroundAlpha: parseAlpha(style.backgroundColor),
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      backdropFilter: (
        style.getPropertyValue('backdrop-filter')
        || style.getPropertyValue('-webkit-backdrop-filter')
        || 'none'
      ).trim(),
      borderColor: style.borderColor,
      color: style.color,
      height: rect.height,
      width: rect.width,
    };
  };

  try {
    const overlayTargets = [
      { label: 'legend', selector: '[data-probe-overlay="legend"]' },
      { label: 'run controls', selector: '[data-probe-overlay="run-controls"]' },
      { label: 'pause button', selector: '[data-probe-run-btn="pause"]' },
      { label: 'resume button', selector: '[data-probe-run-btn="resume"]' },
      { label: 'cancel button', selector: '[data-probe-run-btn="cancel"]' },
    ];

    for (const target of overlayTargets) {
      const chrome = await probe.locator(target.selector).evaluate(readChrome);
      expect(chrome.backgroundImage, `${name}: ${target.label} should not use gradient or image chrome`).toBe('none');
      expect(chrome.backdropFilter, `${name}: ${target.label} should not use blurred glass chrome`).toBe('none');
      expect(chrome.backgroundColor, `${name}: ${target.label} should keep a theme surface background`).toMatch(/rgb|color/i);
      expect(chrome.backgroundAlpha, `${name}: ${target.label} should use an opaque theme-token surface`).toBeGreaterThan(0.98);
      expect(chrome.borderColor, `${name}: ${target.label} should keep a themed border`).toMatch(/rgb|color/i);
      expect(chrome.width, `${name}: ${target.label} should keep stable width`).toBeGreaterThan(0);
      expect(chrome.height, `${name}: ${target.label} should keep stable height`).toBeGreaterThan(0);
    }

    const pauseButton = probe.locator('[data-probe-run-btn="pause"]');
    const pauseNormal = await pauseButton.evaluate(readChrome);
    await pauseButton.hover();
    const pauseHover = await pauseButton.evaluate(readChrome);
    expect(pauseHover.backgroundImage, `${name}: pause hover should stay solid`).toBe('none');
    expect(pauseHover.backdropFilter, `${name}: pause hover should avoid backdrop filters`).toBe('none');
    expect(pauseHover.backgroundColor, `${name}: pause hover should change background`).not.toBe(pauseNormal.backgroundColor);
    expect(pauseHover.borderColor, `${name}: pause hover should change border`).not.toBe(pauseNormal.borderColor);
    expect(pauseHover.color, `${name}: pause hover should change icon color`).not.toBe(pauseNormal.color);
    expect(Math.abs(pauseHover.width - pauseNormal.width), `${name}: pause hover should not resize`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(pauseHover.height - pauseNormal.height), `${name}: pause hover should not resize`).toBeLessThanOrEqual(0.5);

    const resumeChrome = await probe.locator('[data-probe-run-btn="resume"]').evaluate(readChrome);
    expect(resumeChrome.backgroundColor, `${name}: resume state should differ from pause`).not.toBe(pauseNormal.backgroundColor);
    expect(resumeChrome.borderColor, `${name}: resume state should differ from pause border`).not.toBe(pauseNormal.borderColor);
    expect(resumeChrome.color, `${name}: resume state should differ from pause color`).not.toBe(pauseNormal.color);
    const resumeButton = probe.locator('[data-probe-run-btn="resume"]');
    await resumeButton.hover();
    const resumeHover = await resumeButton.evaluate(readChrome);
    expect(resumeHover.backgroundImage, `${name}: resume hover should stay solid`).toBe('none');
    expect(resumeHover.backgroundColor, `${name}: resume hover should change background`).not.toBe(resumeChrome.backgroundColor);
    expect(resumeHover.borderColor, `${name}: resume hover should change border`).not.toBe(resumeChrome.borderColor);
    expect(resumeHover.color, `${name}: resume hover should change icon color`).not.toBe(resumeChrome.color);

    const cancelButton = probe.locator('[data-probe-run-btn="cancel"]');
    const cancelChrome = await cancelButton.evaluate(readChrome);
    expect(cancelChrome.backgroundColor, `${name}: cancel state should differ from pause`).not.toBe(pauseNormal.backgroundColor);
    expect(cancelChrome.borderColor, `${name}: cancel state should differ from pause border`).not.toBe(pauseNormal.borderColor);
    expect(cancelChrome.color, `${name}: cancel state should differ from pause color`).not.toBe(pauseNormal.color);
    expect(cancelChrome.backgroundColor, `${name}: cancel state should differ from resume`).not.toBe(resumeChrome.backgroundColor);
    expect(cancelChrome.borderColor, `${name}: cancel state should differ from resume border`).not.toBe(resumeChrome.borderColor);
    await cancelButton.hover();
    const cancelHover = await cancelButton.evaluate(readChrome);
    expect(cancelHover.backgroundImage, `${name}: cancel hover should stay solid`).toBe('none');
    expect(cancelHover.backgroundColor, `${name}: cancel hover should change background`).not.toBe(cancelChrome.backgroundColor);
    expect(cancelHover.borderColor, `${name}: cancel hover should change border`).not.toBe(cancelChrome.borderColor);
    expect(cancelHover.color, `${name}: cancel hover should change icon color`).not.toBe(cancelChrome.color);
  } finally {
    await win.evaluate((id) => {
      document.querySelector(`[data-graph-overlay-probe="${id}"]`)?.remove();
    }, probeId).catch(() => undefined);
  }
}

function nodePackManagerRow(win: Page, label: string): Locator {
  return win.locator('.node-pack-manager-pack').filter({ hasText: label });
}

async function expectNodePackManagerSoftCardRows(manager: Locator, name: string): Promise<void> {
  const chrome = await manager.evaluate((element) => {
    const parseColor = (value: string): { alpha: number } | null => {
      const rgb = value.match(/rgba?\(([^)]+)\)/i);
      if (rgb) {
        const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
        const alpha = parts[3] === undefined
          ? 1
          : Number.parseFloat(parts[3]) / (parts[3].endsWith('%') ? 100 : 1);
        return Number.isFinite(alpha) ? { alpha } : null;
      }
      const srgb = value.match(/color\(\s*srgb\s+[0-9.]+\s+[0-9.]+\s+[0-9.]+(?:\s*\/\s*([0-9.]+%?))?/i);
      if (srgb) {
        const alpha = srgb[1] === undefined
          ? 1
          : Number.parseFloat(srgb[1]) / (srgb[1].endsWith('%') ? 100 : 1);
        return Number.isFinite(alpha) ? { alpha } : null;
      }
      return null;
    };

    const splitCssList = (value: string): string[] => {
      if (!value || value === 'none') return [];
      const items: string[] = [];
      let depth = 0;
      let start = 0;
      for (let i = 0; i < value.length; i += 1) {
        const char = value[i];
        if (char === '(') depth += 1;
        else if (char === ')') depth = Math.max(0, depth - 1);
        else if (char === ',' && depth === 0) {
          items.push(value.slice(start, i).trim());
          start = i + 1;
        }
      }
      items.push(value.slice(start).trim());
      return items.filter(Boolean);
    };

    const rows = [...element.querySelectorAll<HTMLElement>('.node-pack-manager-pack')].map((row) => {
      const style = getComputedStyle(row);
      const shadowLayers = splitCssList(style.boxShadow);
      const trustChips = [...row.querySelectorAll<HTMLElement>('.node-pack-manager-trust-chip')]
        .map((chip) => {
          const chipStyle = getComputedStyle(chip);
          return {
            text: chip.textContent?.trim() || '',
            kind: chip.getAttribute('data-node-pack-manager-row-trust-chip') || '',
            color: chipStyle.color,
            textOverflow: chipStyle.textOverflow,
            whiteSpace: chipStyle.whiteSpace,
            clientWidth: chip.clientWidth,
            scrollWidth: chip.scrollWidth,
            clientHeight: chip.clientHeight,
            scrollHeight: chip.scrollHeight,
          };
        });
      return {
        label: row.querySelector('strong')?.textContent?.trim() || '',
        validation: row.getAttribute('data-node-pack-validation') || '',
        className: row.className,
        backgroundAlpha: parseColor(style.backgroundColor)?.alpha ?? 0,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
        shadowLayerCount: shadowLayers.length,
        hasRaisedShadow: shadowLayers.some(layer => !/\binset\b/i.test(layer)),
        trustChips,
        trustChipColors: trustChips.map(chip => chip.color),
      };
    });

    return {
      rowCount: rows.length,
      labels: rows.map(row => row.label),
      rows,
      trustChipTexts: rows.flatMap(row => row.trustChips.map(chip => chip.text)),
      trustChipColors: [...new Set(rows.flatMap(row => row.trustChipColors).filter(Boolean))],
    };
  });

  expect(chrome.rowCount, `${name}: Package Manager should render package rows`).toBeGreaterThanOrEqual(3);
  expect(chrome.labels, `${name}: Package Manager rows should keep known packages visible`)
    .toEqual(expect.arrayContaining([
      'OrPAD Core Nodes',
      'Frontend UX Starter Package',
      'Review Required Package',
    ]));

  for (const row of chrome.rows) {
    expect(row.backgroundImage, `${name}: ${row.label} row should not use gradient or image backgrounds`).toBe('none');
    expect(row.backgroundAlpha, `${name}: ${row.label} row should use an opaque theme-token surface`).toBeGreaterThan(0.98);
    expect(row.boxShadow, `${name}: ${row.label} row should have raised soft-card shadow`).not.toBe('none');
    expect(row.hasRaisedShadow, `${name}: ${row.label} row should include an outer raised shadow, not only inset status strips`).toBe(true);
    expect(row.shadowLayerCount, `${name}: ${row.label} row should layer surface highlight and raised shadow`).toBeGreaterThanOrEqual(2);
  }

  const normalRow = chrome.rows.find(row => row.label === 'OrPAD Core Nodes');
  const reviewRow = chrome.rows.find(row => row.label === 'Review Required Package');
  expect(reviewRow?.className || '', `${name}: review-required package should keep danger row state`)
    .toContain('node-pack-manager-pack-danger');
  expect(reviewRow?.borderColor, `${name}: danger row border should remain visually distinct`)
    .not.toBe(normalRow?.borderColor);
  expect(chrome.trustChipColors.length, `${name}: trust chips should keep distinct themed state colors`).toBeGreaterThanOrEqual(2);
  expect(chrome.trustChipTexts, `${name}: trust chips should show full short trust and risk labels`)
    .toEqual(expect.arrayContaining([
      'trust official',
      'state valid',
      'trust signed-community',
      'state approval-required',
      '1 high-risk',
    ]));

  const trustChipReadabilityFailures = chrome.rows.flatMap(row => row.trustChips
    .filter(chip => (
      chip.textOverflow === 'ellipsis'
      || chip.whiteSpace === 'nowrap'
      || chip.text.includes('...')
      || chip.text.includes('\u2026')
      || chip.scrollWidth - chip.clientWidth > 1
      || chip.scrollHeight - chip.clientHeight > 1
    ))
    .map(chip => `${row.label}: ${chip.text} (${chip.clientWidth}x${chip.clientHeight}/${chip.scrollWidth}x${chip.scrollHeight}, ${chip.whiteSpace}, ${chip.textOverflow})`));
  expect(trustChipReadabilityFailures, `${name}: trust chips should fit their visible boxes without ellipsis`).toEqual([]);
}

async function closeModalIfVisible(win: Page): Promise<void> {
  const modal = win.locator('#fmt-modal');
  if (await modal.isVisible().catch(() => false)) {
    await win.locator('#fmt-modal-close').click();
    await expect(modal).toBeHidden({ timeout: 5000 });
  }
}

async function expectVmHarnessDashboardReady(vmHarness: Locator): Promise<void> {
  await expect(vmHarness).toBeVisible({ timeout: 15000 });
  await expect(vmHarness).toContainText('VM Harness ready');
  await expect(vmHarness).toContainText('Tool health');
  await expect(vmHarness).toContainText('Validation');
  await expect(vmHarness).toContainText('MCP capability');
  await expect(vmHarness.locator('.vm-harness-stage-rail li')).toHaveCount(5);
  await expect(vmHarness.locator('.vm-harness-metric')).toHaveCount(5);
  const artifactButtons = vmHarness.locator('button[data-probe-action="open-artifact"]');
  await expect(artifactButtons).toHaveCount(6);
  await expect(artifactButtons.filter({ hasText: 'project-profile.json' }))
    .toHaveAttribute('data-artifact-path', /project-profile\.json$/);
}

async function expectVmHarnessThemeChrome(
  vmHarness: Locator,
  name: string,
  options: { expectLightSurface?: boolean } = {},
): Promise<void> {
  const chrome = await vmHarness.evaluate((element) => {
    const readStyle = (target: Element) => {
      const style = getComputedStyle(target);
      return {
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        borderColor: style.borderColor,
        color: style.color,
      };
    };

    const parseColor = (value: string): { r: number; g: number; b: number; alpha: number } | null => {
      const rgb = value.match(/rgba?\(([^)]+)\)/i);
      if (rgb) {
        const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
        const [r, g, b] = parts.slice(0, 3).map((part) => Number.parseFloat(part));
        const alpha = parts[3] === undefined
          ? 1
          : Number.parseFloat(parts[3]) / (parts[3].endsWith('%') ? 100 : 1);
        return [r, g, b, alpha].every(Number.isFinite) ? { r, g, b, alpha } : null;
      }
      const srgb = value.match(/color\(\s*srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+%?))?/i);
      if (srgb) {
        const [r, g, b] = srgb.slice(1, 4).map((part) => Number.parseFloat(part));
        const alpha = srgb[4] === undefined
          ? 1
          : Number.parseFloat(srgb[4]) / (srgb[4].endsWith('%') ? 100 : 1);
        if (![r, g, b, alpha].every(Number.isFinite)) return null;
        return {
          r: r <= 1 ? r * 255 : r,
          g: g <= 1 ? g * 255 : g,
          b: b <= 1 ? b * 255 : b,
          alpha,
        };
      }
      return null;
    };

    const luminance = (color: { r: number; g: number; b: number; alpha: number } | null): number => (
      color ? (color.r * 299 + color.g * 587 + color.b * 114) / 1000 : 0
    );
    const backgroundAlpha = (style: { backgroundColor: string; color: string }): number => {
      const parsed = parseColor(style.backgroundColor);
      if (parsed) return parsed.alpha;
      const value = String(style.backgroundColor || '').trim();
      if (!value || /\btransparent\b/i.test(value)) return 0;
      return 1;
    };

    const vmStyle = getComputedStyle(element);
    const metricStyles = [...element.querySelectorAll('.vm-harness-metric')].map(readStyle);
    const stageStyles = [...element.querySelectorAll('.vm-harness-stage-rail li')].map(readStyle);
    const chipStyles = [...element.querySelectorAll('.vm-harness-state-chip, .vm-harness-chip')].map(readStyle);
    const actionStyles = [...element.querySelectorAll('.vm-harness-dashboard-action')].map(readStyle);
    const dashboardStyle = readStyle(element);
    const allChromeStyles = [dashboardStyle, ...metricStyles, ...stageStyles, ...chipStyles, ...actionStyles];
    const backgroundDebug = allChromeStyles.map((style, index) => ({
      index,
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      color: style.color,
      alpha: backgroundAlpha(style),
    }));

    return {
      dashboardStyle,
      dashboardLuminance: luminance(parseColor(dashboardStyle.backgroundColor)),
      minBackgroundAlpha: Math.min(...allChromeStyles.map(backgroundAlpha)),
      transparentBackgrounds: backgroundDebug.filter(entry => entry.alpha <= 0.98),
      metricCount: metricStyles.length,
      stageCount: stageStyles.length,
      chipCount: chipStyles.length,
      actionCount: actionStyles.length,
      backgroundImages: [
        dashboardStyle.backgroundImage,
        ...metricStyles.map((style) => style.backgroundImage),
        ...stageStyles.map((style) => style.backgroundImage),
        ...chipStyles.map((style) => style.backgroundImage),
        ...actionStyles.map((style) => style.backgroundImage),
      ],
      vmSurfaceVar: vmStyle.getPropertyValue('--vm-harness-surface').trim(),
      vmRaisedVar: vmStyle.getPropertyValue('--vm-harness-surface-raised').trim(),
      vmAccentVar: vmStyle.getPropertyValue('--vm-harness-accent').trim(),
      vmGoodVar: vmStyle.getPropertyValue('--vm-harness-good').trim(),
      vmDangerVar: vmStyle.getPropertyValue('--vm-harness-danger').trim(),
    };
  });

  expect(chrome.metricCount, `${name}: VM Harness should keep five metrics`).toBe(5);
  expect(chrome.stageCount, `${name}: VM Harness should keep five stages`).toBe(5);
  expect(chrome.chipCount, `${name}: VM Harness should expose themed chips`).toBeGreaterThan(0);
  expect(chrome.actionCount, `${name}: VM Harness should expose themed artifact actions`).toBeGreaterThan(0);
  expect(chrome.backgroundImages.join(' '), `${name}: VM Harness chrome should not use gradients`).not.toMatch(/gradient/i);
  expect(chrome.backgroundImages.every((image) => image === 'none'), `${name}: VM Harness chrome should stay solid`).toBe(true);
  expect(
    chrome.minBackgroundAlpha,
    `${name}: VM Harness chrome backgrounds should be opaque theme-token surfaces ${JSON.stringify(chrome.transparentBackgrounds)}`,
  ).toBeGreaterThan(0.98);
  if (chrome.vmSurfaceVar.includes('var(')) {
    expect(chrome.vmSurfaceVar, `${name}: dashboard surface should reference theme background tokens`).toContain('var(--bg-secondary)');
  }
  if (chrome.vmRaisedVar.includes('var(')) {
    expect(chrome.vmRaisedVar, `${name}: raised surface should reference theme background tokens`).toContain('var(--bg-secondary)');
  }
  if (chrome.vmAccentVar.includes('var(')) {
    expect(chrome.vmAccentVar, `${name}: dashboard accent should remain theme-driven`)
      .toMatch(/var\(--(?:accent-color|vm-harness-good|vm-harness-danger)/);
  }
  if (chrome.vmGoodVar.includes('var(')) {
    expect(chrome.vmGoodVar, `${name}: success state should remain syntax/theme-driven`).toContain('var(--syntax-string');
  }
  if (chrome.vmDangerVar.includes('var(')) {
    expect(chrome.vmDangerVar, `${name}: danger state should remain theme-driven`).toContain('var(--danger-color');
  }
  if (options.expectLightSurface) {
    expect(chrome.dashboardLuminance, `${name}: light theme should produce a light VM Harness surface`).toBeGreaterThan(180);
  }
}

test('visual smoke captures redesigned orchestration VM Harness editor terminal and package manager surfaces', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const workspace = writeVisualSmokeWorkspace();
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    writeApprovedWorkspace(userData, workspace);

    for (const viewport of VISUAL_VIEWPORTS) {
      await win.setViewportSize({ width: viewport.width, height: viewport.height });
      await win.evaluate(() => localStorage.removeItem('orpad-theme'));
      await win.reload({ waitUntil: 'domcontentloaded' });
      await openVisualSmokePipeline(win);
      await expectHeroThemeTokens(win);

      await captureSurfaceEvidence(
        testInfo,
        win.locator('#runbooks-content'),
        `visual-smoke-${viewport.name}-dashboard`,
        {
          minWidth: 240,
          minHeight: viewport.name === 'desktop' ? 520 : 360,
          expectChrome: true,
        },
      );

      await captureSurfaceEvidence(
        testInfo,
        win.locator('#editor-pane .cm-editor').first(),
        `visual-smoke-${viewport.name}-editor`,
        {
          minWidth: viewport.name === 'desktop' ? 420 : 280,
          minHeight: 220,
          minUniqueColors: 4,
        },
      );

      await win.locator('#btn-preview').click();
      await expect(win.locator('.orch-preview')).toContainText('Pipeline setup');
      await expect(win.locator('.orch-graph-node')).toHaveCount(6);
      await fitGraphIfAvailable(win);
      await expectGraphToolbarSolidControls(win, `visual-smoke-${viewport.name}-orchestration`);
      await expectGraphOverlayControlsSolidChrome(win, `visual-smoke-${viewport.name}-orchestration`);

      const runbar = win.locator('[data-pipeline-preview-runbar]').first();
      await expect(runbar).toContainText('Visual Smoke Workstream');
      await expect(runbar.locator('button[data-pipeline-run-action="default"]')).toBeVisible();
      await runbar.locator('[data-pipeline-run-menu]').click();
      const checkHarnessAction = win.locator('button[data-pipeline-run-action="check"]').first();
      if (await checkHarnessAction.isVisible().catch(() => false)) {
        await checkHarnessAction.click();
        await expect(runbar).toContainText('Harness ready');
      } else {
        await runbar.locator('[data-pipeline-run-menu]').click();
      }
      const managedRunAction = win.locator('button[data-pipeline-run-action="managed"]').first();
      if (!await managedRunAction.isVisible().catch(() => false)) {
        await runbar.locator('[data-pipeline-run-menu]').click();
      }
      await expect(managedRunAction).toContainText('Start Run');
      await expect(win.locator('button[data-pipeline-run-action="handoff"]')).toContainText('Prepare Handoff');
      if (await managedRunAction.isVisible().catch(() => false)) {
        await runbar.locator('[data-pipeline-run-menu]').click();
      }
      await expectRunbarCurrentNodeBreathes(runbar, viewport);
      await expectRunbarSolidThemeChrome(runbar, `visual-smoke-${viewport.name}-runbar`);

      await captureSurfaceEvidence(
        testInfo,
        runbar,
        `visual-smoke-${viewport.name}-runbar`,
        {
          minWidth: viewport.name === 'desktop' ? 420 : 300,
          minHeight: 44,
          expectChrome: true,
          minUniqueColors: 4,
          minLuminanceRange: 6,
        },
      );

      const vmHarness = win.locator('#content.view-orch-graph [data-vm-harness-dashboard]').first();
      await expectVmHarnessDashboardReady(vmHarness);
      await expectVmHarnessThemeChrome(vmHarness, `visual-smoke-${viewport.name}-vm-harness-hero`);
      await captureSurfaceEvidence(
        testInfo,
        vmHarness,
        `visual-smoke-${viewport.name}-vm-harness`,
        {
          minWidth: viewport.name === 'desktop' ? 360 : 300,
          minHeight: viewport.name === 'desktop' ? 240 : 200,
          expectChrome: true,
          minUniqueColors: 4,
          minLuminanceRange: 6,
        },
      );

      await captureSurfaceEvidence(
        testInfo,
        win.locator('.orch-preview').first(),
        `visual-smoke-${viewport.name}-orchestration`,
        {
          minWidth: viewport.name === 'desktop' ? 700 : 430,
          minHeight: viewport.name === 'desktop' ? 420 : 300,
          expectChrome: true,
        },
      );

      await win.locator('#btn-terminal').click();
      await expect(win.locator('.terminal-panel')).toBeVisible({ timeout: 10000 });
      await expect(win.locator('.terminal-tab-add')).toBeVisible();
      await captureSurfaceEvidence(
        testInfo,
        win.locator('.terminal-panel'),
        `visual-smoke-${viewport.name}-terminal`,
        {
          minWidth: viewport.name === 'desktop' ? 520 : 360,
          minHeight: 180,
          expectChrome: true,
        },
      );

      await setNodePackManagerVisualMock(win);
      await win.locator('#btn-package-manager').click();
      await expect(win.locator('#fmt-modal-title')).toContainText('Package Manager');
      const manager = win.locator('.node-pack-manager');
      await expect(manager).toHaveAttribute('data-node-pack-manager-state', 'success', { timeout: 15000 });
      await manager.locator('[data-node-pack-manager-tab="installed"]').click();
      await expect(manager).toHaveAttribute('data-node-pack-manager-tab', 'installed');
      await expect(manager).toHaveAttribute('data-node-pack-manager-state', 'success', { timeout: 15000 });
      await expect(manager).toContainText('OrPAD Core Nodes');
      await expect(manager).toContainText('Frontend UX Starter Package');
      await expect(manager).toContainText('Review Required Package');
      await captureSurfaceEvidence(
        testInfo,
        manager,
        `visual-smoke-${viewport.name}-package-manager`,
        {
          minWidth: viewport.name === 'desktop' ? 760 : 600,
          minHeight: viewport.name === 'desktop' ? 420 : 320,
          expectChrome: true,
        },
      );
      await expectNodePackManagerSoftCardRows(manager, `visual-smoke-${viewport.name}-package-manager`);

      const reviewPack = nodePackManagerRow(win, 'Review Required Package');
      await expect(reviewPack).toHaveAttribute('data-node-pack-validation', 'approval-required');
      await reviewPack.locator('[data-node-pack-manager-detail-open]').click();
      const detail = win.locator('.node-pack-manager-detail-modal');
      await expect(detail).toContainText('High-risk capabilities');
      await expect(detail).toContainText('Capability risk');
      await expect(detail).toContainText('high-risk capabilities: use.credentials; quarantined install behaviors: handler.executable; validation state: approval-required');
      await expect(detail).toContainText('use.credentials');
      await expect(detail).toContainText('High-risk install behaviors');
      await expect(detail).toContainText('handler.executable');
      await expect(detail).toContainText('NODE_PACK_HIGH_RISK_CAPABILITY_REVIEW_REQUIRED');
      await captureSurfaceEvidence(
        testInfo,
        detail,
        `visual-smoke-${viewport.name}-package-authority-detail`,
        {
          minWidth: viewport.name === 'desktop' ? 620 : 500,
          minHeight: 260,
          expectChrome: true,
        },
      );
      await win.locator('[data-node-pack-manager-detail-close]').click();
      await expect(detail).toHaveCount(0);
      await closeModalIfVisible(win);

      if (viewport.name === 'desktop') {
        await win.evaluate(() => localStorage.setItem('orpad-theme', 'github-light'));
        await win.reload({ waitUntil: 'domcontentloaded' });
        await openVisualSmokePipeline(win, { resetTheme: false });
        await expectGithubLightThemeTokens(win);
        await win.locator('#btn-preview').click();
        await expect(win.locator('.orch-preview')).toContainText('Pipeline setup');
        await expect(win.locator('.orch-graph-node')).toHaveCount(6);
        await fitGraphIfAvailable(win);
        await expectGraphToolbarSolidControls(win, 'visual-smoke-desktop-orchestration-github-light');
        await expectGraphOverlayControlsSolidChrome(win, 'visual-smoke-desktop-orchestration-github-light');
        const themedVmHarness = win.locator('#content.view-orch-graph [data-vm-harness-dashboard]').first();
        await expectVmHarnessDashboardReady(themedVmHarness);
        await expectVmHarnessThemeChrome(themedVmHarness, 'visual-smoke-desktop-vm-harness-github-light', {
          expectLightSurface: true,
        });
        await captureSurfaceEvidence(
          testInfo,
          themedVmHarness,
          'visual-smoke-desktop-vm-harness-github-light',
          {
            minWidth: 360,
            minHeight: 240,
            expectChrome: true,
            minUniqueColors: 4,
            minLuminanceRange: 6,
          },
        );

        await setNodePackManagerVisualMock(win);
        await win.locator('#btn-package-manager').click();
        await expect(win.locator('#fmt-modal-title')).toContainText('Package Manager');
        const themedManager = win.locator('.node-pack-manager');
        await expect(themedManager).toHaveAttribute('data-node-pack-manager-state', 'success', { timeout: 15000 });
        await themedManager.locator('[data-node-pack-manager-tab="installed"]').click();
        await expect(themedManager).toHaveAttribute('data-node-pack-manager-tab', 'installed');
        await expect(themedManager).toHaveAttribute('data-node-pack-manager-state', 'success', { timeout: 15000 });
        await captureSurfaceEvidence(
          testInfo,
          themedManager,
          'visual-smoke-desktop-package-manager-github-light',
          {
            minWidth: 760,
            minHeight: 420,
            expectChrome: true,
          },
        );
        await expectNodePackManagerSoftCardRows(themedManager, 'visual-smoke-desktop-package-manager-github-light');
        await closeModalIfVisible(win);
      }
    }
  } finally {
    await closeElectronApp(app);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
