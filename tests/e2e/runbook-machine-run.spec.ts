import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchElectron } from '../helpers';

const {
  claimNextQueuedItem,
  appendMachineEvent,
  appendRunLifecycleStatus,
  appendRunSummaryStatus,
  createMachineRun,
  executeMachineRunStep,
  findQueueItem,
  ingestCandidateProposal,
  readMachineEvents,
  registerPatchArtifact,
  transitionQueueItem,
  writeQueueItem,
} = require('../../src/main/orchestration-machine');

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function writeApprovedWorkspace(userData: string, workspaceRoot: string): void {
  fs.writeFileSync(path.join(userData, 'approved-workspace.json'), JSON.stringify({
    version: 1,
    workspaceRoot,
  }));
}

async function expectToolbarRunbarTelemetryVisible(page: Page): Promise<void> {
  const runbar = page.locator('#toolbar [data-pipeline-preview-runbar]');
  await expect(runbar).toBeVisible();
  await expect(runbar.locator('.pipeline-runbar-status[role="status"]')).toBeVisible();
  const telemetry = runbar.locator([
    '.pipeline-runbar-status:not([role="status"])',
    '.pipeline-runbar-current',
    '.pipeline-runbar-progress',
    '.pipeline-runbar-elapsed',
    '.pipe-budget-chip',
  ].join(', '));
  const telemetryCount = await telemetry.count();
  expect(telemetryCount, 'Toolbar runbar should expose at least one secondary telemetry chip.').toBeGreaterThan(0);
  for (let index = 0; index < telemetryCount; index += 1) {
    await expect(telemetry.nth(index), `Toolbar runbar telemetry chip ${index + 1} should remain visible.`).toBeVisible();
  }
}

async function expectToolbarRunbarActionsClear(page: Page): Promise<void> {
  const runbar = page.locator('#toolbar [data-pipeline-preview-runbar]');
  const meta = runbar.locator('.pipeline-runbar-meta');
  const actions = runbar.locator('.pipeline-runbar-actions');
  const primaryRun = runbar.locator('.pipeline-run-primary');
  const runMenu = runbar.locator('[data-pipeline-run-menu]');
  await expect(meta).toBeVisible();
  await expect(actions).toBeVisible();
  await expect(primaryRun).toBeVisible();
  await expect(runMenu).toBeVisible();

  const [metaBox, actionsBox] = await Promise.all([
    meta.boundingBox(),
    actions.boundingBox(),
  ]);
  if (!metaBox || !actionsBox) {
    throw new Error('Toolbar runbar telemetry or action bounds were unavailable.');
  }
  expect(metaBox.x + metaBox.width).toBeLessThanOrEqual(actionsBox.x + 1);

  const layout = await runbar.evaluate((root) => {
    const rectOf = (element: Element | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const overlaps = (a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>, tolerance = 1) => !!a && !!b
      && a.left < b.right - tolerance
      && a.right > b.left + tolerance
      && a.top < b.bottom - tolerance
      && a.bottom > b.top + tolerance;
    const actionRect = rectOf(root.querySelector('.pipeline-runbar-actions'));
    const runbarRect = rectOf(root);
    const metaElement = root.querySelector('.pipeline-runbar-meta');
    const chipSelectors = [
      ['primary status', '.pipeline-runbar-status[role="status"]'],
      ['current node', '.pipeline-runbar-current'],
      ['progress', '.pipeline-runbar-progress'],
    ];
    const criticalTelemetry = chipSelectors.flatMap(([label, selector]) =>
      [...root.querySelectorAll(selector)].map((element) => {
        const rect = rectOf(element);
        return {
          label,
          width: rect?.width || 0,
          height: rect?.height || 0,
          overlapsActions: overlaps(rect, actionRect),
          clippedByRunbar: !!rect && !!runbarRect && (
            rect.left < runbarRect.left - 1
            || rect.right > runbarRect.right + 1
            || rect.top < runbarRect.top - 1
            || rect.bottom > runbarRect.bottom + 1
          ),
        };
      }));
    const actionTargets = [...root.querySelectorAll('.pipeline-run-primary, .pipeline-run-control, [data-pipeline-run-menu]')]
      .map((element) => {
        const rect = rectOf(element);
        return {
          label: element.getAttribute('aria-label') || element.getAttribute('title') || element.className || element.tagName,
          width: rect?.width || 0,
          height: rect?.height || 0,
        };
      });
    const metaStyle = metaElement ? getComputedStyle(metaElement) : null;
    return {
      metaFlexWrap: metaStyle?.flexWrap || '',
      metaOverflow: metaStyle?.overflow || '',
      criticalTelemetry,
      actionTargets,
    };
  });
  expect(layout.metaFlexWrap, 'Toolbar runbar telemetry rail should wrap instead of squeezing every chip into one row.').toBe('wrap');
  expect(layout.metaOverflow, 'Toolbar runbar telemetry should not be clipped by its own rail.').not.toBe('hidden');
  expect(layout.criticalTelemetry.length, 'Toolbar runbar should expose primary status and any live progress/current-node chips.').toBeGreaterThan(0);
  for (const chip of layout.criticalTelemetry) {
    expect(chip.width, `${chip.label} chip should keep a readable width.`).toBeGreaterThanOrEqual(20);
    expect(chip.height, `${chip.label} chip should keep a readable height.`).toBeGreaterThanOrEqual(16);
    expect(chip.overlapsActions, `${chip.label} chip should not overlap run actions.`).toBe(false);
    expect(chip.clippedByRunbar, `${chip.label} chip should stay inside the runbar surface.`).toBe(false);
  }
  expect(layout.actionTargets.length, 'Toolbar runbar should expose fixed-size run action targets.').toBeGreaterThanOrEqual(2);
  for (const target of layout.actionTargets) {
    expect(target.width, `${target.label} should preserve its tap target width.`).toBeGreaterThanOrEqual(23);
    expect(target.height, `${target.label} should preserve its tap target height.`).toBeGreaterThanOrEqual(23);
  }
}

async function expectToolbarRunbarTelemetryAtWidth(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 720 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  await expectToolbarRunbarTelemetryVisible(page);
  await expectToolbarRunbarActionsClear(page);
}

async function expectRuntimeHeroGraphChrome(page: Page, label: string): Promise<void> {
  const audit = await page.locator('.orch-graph-frame').first().evaluate((frame) => {
    const rectOf = (element: Element | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    };
    const overlaps = (a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>, tolerance = 1) => !!a && !!b
      && a.left < b.right - tolerance
      && a.right > b.left + tolerance
      && a.top < b.bottom - tolerance
      && a.bottom > b.top + tolerance;
    const frameStyle = getComputedStyle(frame);
    const runningNode = frame.querySelector<HTMLElement>('.orch-graph-node.runtime-running');
    const activeEdge = frame.querySelector<SVGPathElement>('.orch-transition[data-machine-edge-state="active"]');
    const runControls = frame.querySelector<HTMLElement>('.orch-graph-run-controls');
    const runningStyle = runningNode ? getComputedStyle(runningNode) : null;
    const activeEdgeStyle = activeEdge ? getComputedStyle(activeEdge) : null;
    const nodeRects = [...frame.querySelectorAll<HTMLElement>('.orch-graph-node')].map(rectOf);
    const runControlRect = rectOf(runControls);
    return {
      frameBackgroundImage: frameStyle.backgroundImage,
      frameBackgroundColor: frameStyle.backgroundColor,
      frameBoxShadow: frameStyle.boxShadow,
      runControlsVisible: !!runControlRect,
      runControlsOverlapNodeCount: nodeRects.filter(node => overlaps(node, runControlRect)).length,
      runningNodeBackgroundImage: runningStyle?.backgroundImage || '',
      runningNodeBackgroundColor: runningStyle?.backgroundColor || '',
      runningNodeBoxShadow: runningStyle?.boxShadow || '',
      runningNodeAnimationName: runningStyle?.animationName || '',
      activeEdgeStrokeWidth: Number.parseFloat(activeEdgeStyle?.strokeWidth || '0'),
      activeEdgeStrokeDasharray: activeEdgeStyle?.strokeDasharray || '',
      activeEdgeFilter: activeEdgeStyle?.filter || '',
    };
  });

  const transparentColor = 'rgba(0, 0, 0, 0)';
  expect(audit.frameBackgroundImage, `${label}: live graph frame should use a solid soft dashboard surface`).toBe('none');
  expect(audit.frameBackgroundColor, `${label}: live graph frame should retain a visible surface color`).not.toBe(transparentColor);
  expect(audit.frameBoxShadow, `${label}: live graph frame should have depth`).not.toBe('none');
  expect(audit.runControlsVisible, `${label}: run controls should remain visible on the graph`).toBe(true);
  expect(audit.runControlsOverlapNodeCount, `${label}: run controls should not cover active nodes`).toBe(0);
  expect(audit.runningNodeBackgroundImage, `${label}: running node should avoid decorative gradients`).toBe('none');
  expect(audit.runningNodeBackgroundColor, `${label}: running node should keep a visible state surface`).not.toBe(transparentColor);
  expect(audit.runningNodeBoxShadow, `${label}: running node should have a glow/depth treatment`).not.toBe('none');
  expect(audit.runningNodeAnimationName, `${label}: running node should pulse when motion is allowed`).toContain('orch-runtime-pulse');
  expect(audit.activeEdgeStrokeWidth, `${label}: active path should scan by weight, not color alone`).toBeGreaterThanOrEqual(5);
  expect(audit.activeEdgeStrokeDasharray, `${label}: active path should scan by dash pattern, not color alone`).not.toBe('none');
  expect(audit.activeEdgeFilter, `${label}: active path should have a static glow fallback`).not.toBe('none');
}

async function expectReducedMotionHeroGraphFallback(page: Page, label: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  const audit = await page.locator('.orch-graph-frame').first().evaluate((frame) => {
    const activeEdge = frame.querySelector<SVGPathElement>('.orch-transition[data-machine-edge-state="active"]');
    const flowArrow = frame.querySelector<SVGTextElement>('.orch-transition-flow-arrows');
    const runningNode = frame.querySelector<HTMLElement>('.orch-graph-node.runtime-running');
    const activeStyle = activeEdge ? getComputedStyle(activeEdge) : null;
    const arrowStyle = flowArrow ? getComputedStyle(flowArrow) : null;
    const nodeStyle = runningNode ? getComputedStyle(runningNode) : null;
    return {
      activeEdgeAnimationName: activeStyle?.animationName || '',
      activeEdgeFilter: activeStyle?.filter || '',
      flowArrowDisplay: arrowStyle?.display || '',
      runningNodeAnimationName: nodeStyle?.animationName || '',
    };
  });
  expect(audit.flowArrowDisplay, `${label}: reduced motion should hide moving edge glyphs`).toBe('none');
  expect(audit.activeEdgeAnimationName, `${label}: reduced motion should stop active edge dash animation`).toBe('none');
  expect(audit.activeEdgeFilter, `${label}: reduced motion should keep a static path glow`).not.toBe('none');
  expect(audit.runningNodeAnimationName, `${label}: reduced motion should stop running node pulse`).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}

function writeMachineWorkspace(): { workspace: string; pipelinePath: string; pipelineDir: string } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-machine-ui-'));
  const pipelineDir = path.join(workspace, '.orpad', 'pipelines', 'machine-workstream');
  fs.mkdirSync(path.join(pipelineDir, 'graphs'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  fs.writeFileSync(path.join(workspace, 'src', 'smoke-target.md'), 'before\n');

  fs.writeFileSync(path.join(pipelineDir, 'graphs', 'main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'machine-workstream',
      nodes: [
        { id: 'context', type: 'orpad.context', label: 'Context', config: { summary: 'Collect context.' } },
        { id: 'probe', type: 'orpad.probe', label: 'Probe', config: { lens: 'bug-risk' } },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', label: 'Triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Worker', config: { queueRef: 'queue' } },
      ],
      transitions: [
        { from: 'context', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
      ],
    },
  }, null, 2));

  fs.writeFileSync(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'machine-workstream',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    nodePacks: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3', origin: 'built-in' },
      { id: 'orpad.workstream', version: '>=0.1.0', origin: 'built-in' },
    ],
    maintenancePolicy: {
      handoff: {
        promptContract: 'path-only',
        launchPromptShape: '<pipeline.or-pipeline path> --machine-ui-test',
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
          proposalId: 'proposal-machine-ui-smoke',
          suggestedWorkItemId: 'machine-ui-smoke',
          sourceNode: 'probe/machine-ui',
          title: 'Exercise Machine UI worker execution',
          fingerprint: 'machine-ui:src/smoke-target.md',
          evidence: [{ id: 'target-before', file: 'src/smoke-target.md' }],
          acceptanceCriteria: ['Patch artifact records the target file change.'],
          sourceOfTruthTargets: ['src/smoke-target.md'],
        },
        expectedChangedFiles: ['src/smoke-target.md'],
        nodeCliPatch: {
          file: 'src/smoke-target.md',
          content: 'after from Machine UI harness\n',
        },
      },
    },
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
  }, null, 2));

  return { workspace, pipelinePath, pipelineDir };
}

function addParallelProbeHarness(pipelinePath: string): void {
  const pipelineDir = path.dirname(pipelinePath);
  const graphPath = path.join(pipelineDir, 'graphs', 'main.or-graph');
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
  graph.graph.nodes.splice(2, 0, {
    id: 'probe-secondary',
    type: 'orpad.probe',
    label: 'Secondary Probe',
    config: { lens: 'test-gap' },
  });
  graph.graph.transitions.push(
    { from: 'context', to: 'probe-secondary' },
    { from: 'probe-secondary', to: 'queue' },
  );
  fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2));

  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  const primary = {
    ...pipeline.run.machineHarness.candidateProposal,
    sourceNode: 'main/probe',
  };
  const secondary = {
    ...pipeline.run.machineHarness.candidateProposal,
    proposalId: 'proposal-machine-ui-secondary',
    suggestedWorkItemId: 'machine-ui-secondary',
    sourceNode: 'main/probe-secondary',
    title: 'Exercise secondary Machine UI worker execution',
    fingerprint: 'machine-ui-secondary:src/smoke-target.md',
  };
  pipeline.run.machineHarness.candidateProposals = [primary, secondary];
  pipeline.run.machineHarness.probeNodePaths = ['main/probe', 'main/probe-secondary'];
  pipeline.run.machineHarness.parallelProbes = true;
  pipeline.run.machineHarness.probeConcurrency = 2;
  pipeline.run.machineHarness.workerConcurrency = 2;
  fs.writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2));
}

function addNestedGraphProjectionFixture(pipelinePath: string): void {
  const pipelineDir = path.dirname(pipelinePath);
  const graphPath = path.join(pipelineDir, 'graphs', 'main.or-graph');
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
  graph.graph.nodes.splice(1, 0, {
    id: 'discovery-stage',
    type: 'orpad.graph',
    label: 'Discovery stage',
    config: { graphRef: 'discovery.or-graph', executionMode: 'inline' },
  });
  graph.graph.transitions = graph.graph.transitions
    .filter((edge: { from?: string; to?: string }) => !(edge.from === 'context' && edge.to === 'probe'));
  graph.graph.transitions.push(
    { from: 'context', to: 'discovery-stage' },
    { from: 'discovery-stage', to: 'probe' },
  );
  fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2));
  fs.writeFileSync(path.join(pipelineDir, 'graphs', 'discovery.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'discovery',
      nodes: [
        { id: 'probe-a', type: 'orpad.probe', label: 'Nested probe', config: { lens: 'nested' } },
      ],
      transitions: [],
    },
  }, null, 2));

  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  pipeline.graphs.push({ id: 'discovery', file: 'graphs/discovery.or-graph' });
  fs.writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2));
}

function makeParallelProbeWorkersReviewBlocked(pipelinePath: string): void {
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  pipeline.run.machineHarness.continueAfterReviewableBlockedPatch = true;
  pipeline.run.machineHarness.expectedChangedFiles = [
    pipeline.run.machineHarness.nodeCliPatch.file,
    'src/unmodified-expected.md',
  ];
  fs.writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2));
}

function appendFailingArtifactContract(pipelineDir: string): void {
  const graphPath = path.join(pipelineDir, 'graphs', 'main.or-graph');
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
  graph.graph.nodes.push({
    id: 'artifact',
    type: 'orpad.artifactContract',
    label: 'Artifact contract',
    config: {
      required: ['missing-proof.md'],
      onMissing: 'fail-run',
    },
  });
  fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2));
}

function requireMachineApproval(pipelinePath: string): void {
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  pipeline.run.machineHarness.candidateProposal.approvalRequired = true;
  fs.writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2));
}

function removeMachineHarness(pipelinePath: string): void {
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  delete pipeline.run.machineHarness;
  fs.writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2));
}

function writeHarnessReadinessArtifacts(generatedDir: string, options: {
  status?: string;
  blockers?: string[];
  warnings?: string[];
} = {}): void {
  const status = options.status || 'ready';
  const blockers = options.blockers || [];
  const warnings = options.warnings || [];
  const degradedTools = status === 'blocked' || status === 'degraded' ? 1 : 0;
  const missingTools = status === 'blocked' ? 1 : 0;
  fs.writeFileSync(path.join(generatedDir, 'project-profile.json'), JSON.stringify({
    schemaVersion: 'orpad.projectProfile.v1',
    projectStacks: [{ id: 'node-frontend', confidence: 'high' }],
    requiredTools: ['node', 'npm', 'playwright'],
    validationCommands: ['npm run build:renderer', 'npx playwright test --project=electron tests/e2e/runbook-machine-run.spec.ts'],
  }, null, 2));
  fs.writeFileSync(path.join(generatedDir, 'tool-health.json'), JSON.stringify({
    schemaVersion: 'orpad.harnessToolHealth.v1',
    summary: { total: 5, ready: 5 - degradedTools - missingTools, degraded: degradedTools, missing: missingTools, unknown: 0 },
  }, null, 2));
  fs.writeFileSync(path.join(generatedDir, 'validation-preflight.json'), JSON.stringify({
    schemaVersion: 'orpad.harnessValidationPreflight.v1',
    summary: { total: 3, ready: status === 'blocked' ? 1 : 2, blocked: status === 'blocked' ? 1 : 0, unknown: status === 'blocked' ? 1 : 0 },
  }, null, 2));
  fs.writeFileSync(path.join(generatedDir, 'mcp-plan.json'), JSON.stringify({
    schemaVersion: 'orpad.harnessMcpPlan.v1',
    recommendedServers: [
      { id: 'filesystem', status: status === 'blocked' ? 'configured-not-running' : 'ready' },
      { id: 'git', status: 'ready' },
    ],
    orpadCapabilities: [
      { id: 'terminal', status: 'available' },
      { id: 'browser', status: 'available' },
    ],
  }, null, 2));
  fs.writeFileSync(path.join(generatedDir, 'harness-provisioning.json'), JSON.stringify({
    schemaVersion: 'orpad.harnessProvisioning.v1',
    status,
    enforcement: { runBlockers: blockers, warnings },
  }, null, 2));
  fs.writeFileSync(path.join(generatedDir, 'README.md'), [
    '# Harness Implementation',
    '',
    `Provisioning: ${status}`,
  ].join('\n'));
}

function attachHarnessArtifactRefs(pipeline: any, implementedAt = ''): void {
  pipeline.harness = {
    ...(pipeline.harness || {}),
    path: 'harness/generated',
    implementationState: 'harness/generated/implementation-state.json',
    projectProfile: 'harness/generated/project-profile.json',
    provisioning: 'harness/generated/harness-provisioning.json',
    toolHealth: 'harness/generated/tool-health.json',
    validationPreflight: 'harness/generated/validation-preflight.json',
    mcpPlan: 'harness/generated/mcp-plan.json',
    ...(implementedAt ? { implementedAt } : {}),
  };
}

function seededHarnessProvisioning(status: string, blockers: string[] = [], warnings: string[] = []) {
  const degradedTools = status === 'blocked' || status === 'degraded' ? 1 : 0;
  const missingTools = status === 'blocked' ? 1 : 0;
  return {
    path: 'harness-provisioning.json',
    toolHealthPath: 'tool-health.json',
    validationPreflightPath: 'validation-preflight.json',
    mcpPlanPath: 'mcp-plan.json',
    agentReadinessPath: 'agent-readiness.json',
    status,
    blockers,
    warnings,
    toolHealthSummary: { total: 5, ready: 5 - degradedTools - missingTools, degraded: degradedTools, missing: missingTools, unknown: 0 },
    validationPreflightSummary: { total: 3, ready: status === 'blocked' ? 1 : 2, blocked: status === 'blocked' ? 1 : 0, unknown: status === 'blocked' ? 1 : 0 },
    mcpRecommendedServers: [
      { id: 'filesystem', status: status === 'blocked' ? 'configured-not-running' : 'ready' },
      { id: 'git', status: 'ready' },
    ],
    orpadCapabilities: [
      { id: 'terminal', status: 'available' },
      { id: 'browser', status: 'available' },
    ],
  };
}

function seedSucceededHarnessImplementation(pipelinePath: string): void {
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
  const state = {
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
    provisioning: seededHarnessProvisioning('ready', [], ['MCP git server is optional for this fixture.']),
    nodes,
  };
  fs.writeFileSync(path.join(generatedDir, 'implementation-state.json'), JSON.stringify(state, null, 2));
  writeHarnessReadinessArtifacts(generatedDir, { status: 'ready', warnings: ['MCP git server is optional for this fixture.'] });

  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  attachHarnessArtifactRefs(pipeline, implementedAt);
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

function seedRunningHarnessImplementation(pipelinePath: string): void {
  const pipelineDir = path.dirname(pipelinePath);
  const generatedDir = path.join(pipelineDir, 'harness', 'generated');
  fs.mkdirSync(path.join(generatedDir, 'nodes'), { recursive: true });
  const state = {
    schemaVersion: 'orpad.harnessImplementation.v1',
    status: 'running',
    stage: 'node-contracts',
    stageLabel: 'Node contracts',
    startedAt: '2026-05-01T00:09:00.000Z',
    updatedAt: '2026-05-01T00:10:00.000Z',
    message: 'Writing harness contracts and operational artifacts.',
    nodeCount: 3,
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
    provisioning: seededHarnessProvisioning('degraded', [], ['Playwright browser cache was not verified.']),
    nodes: [
      {
        nodePath: 'main/context',
        status: 'succeeded',
        artifact: 'nodes/main-context.json',
        completedAt: '2026-05-01T00:09:30.000Z',
      },
      {
        nodePath: 'main/probe',
        status: 'running',
        startedAt: '2026-05-01T00:09:40.000Z',
      },
      {
        nodePath: 'main/queue',
        status: 'pending',
      },
    ],
  };
  fs.writeFileSync(path.join(generatedDir, 'implementation-state.json'), JSON.stringify(state, null, 2));
  writeHarnessReadinessArtifacts(generatedDir, { status: 'degraded', warnings: ['Playwright browser cache was not verified.'] });

  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  attachHarnessArtifactRefs(pipeline);
  pipeline.metadata = {
    ...(pipeline.metadata || {}),
    harnessImplementation: {
      ...(pipeline.metadata?.harnessImplementation || {}),
      status: 'running',
      statePath: 'harness/generated/implementation-state.json',
      nodeCount: state.nodes.length,
    },
  };
  fs.writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2));
}

function seedBlockedHarnessImplementation(pipelinePath: string): void {
  const pipelineDir = path.dirname(pipelinePath);
  const generatedDir = path.join(pipelineDir, 'harness', 'generated');
  fs.mkdirSync(path.join(generatedDir, 'nodes'), { recursive: true });
  const blockers = ['Node executable missing from PATH'];
  const warnings = ['MCP filesystem server configured but not running'];
  const state = {
    schemaVersion: 'orpad.harnessImplementation.v1',
    status: 'blocked',
    stage: 'blocked',
    stageLabel: 'Provisioning blocked',
    startedAt: '2026-05-01T00:09:00.000Z',
    updatedAt: '2026-05-01T00:10:00.000Z',
    message: 'Harness provisioning blocked: Node executable missing from PATH',
    nodeCount: 3,
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
    provisioning: seededHarnessProvisioning('blocked', blockers, warnings),
    nodes: [
      { nodePath: 'main/context', status: 'pending', artifact: 'nodes/main-context.json' },
      { nodePath: 'main/probe', status: 'pending', artifact: 'nodes/main-probe.json' },
      { nodePath: 'main/queue', status: 'pending', artifact: 'nodes/main-queue.json' },
    ],
  };
  fs.writeFileSync(path.join(generatedDir, 'implementation-state.json'), JSON.stringify(state, null, 2));
  writeHarnessReadinessArtifacts(generatedDir, { status: 'blocked', blockers, warnings });

  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  attachHarnessArtifactRefs(pipeline);
  pipeline.metadata = {
    ...(pipeline.metadata || {}),
    harnessImplementation: {
      ...(pipeline.metadata?.harnessImplementation || {}),
      status: 'blocked',
      statePath: 'harness/generated/implementation-state.json',
      projectProfilePath: 'harness/generated/project-profile.json',
      provisioningPath: 'harness/generated/harness-provisioning.json',
      nodeCount: state.nodes.length,
    },
  };
  fs.writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2));
}

async function seedActiveClaimRun(
  workspace: string,
  pipelinePath: string,
  options: { runId?: string; leaseMs?: number } = {},
): Promise<{ runId: string; runRoot: string; claimId: string; itemId: string }> {
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  const candidate = pipeline.run.machineHarness.candidateProposal;
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: options.runId || 'run_machine_ui_active_claim',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  const item = await ingestCandidateProposal(run.runRoot, candidate, {
    runId: run.runId,
    transitionId: 'proposal:machine-ui-active-claim',
    now: '2026-05-01T00:00:01.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: item.item.id,
    toState: 'queued',
    reason: 'machine-ui.fixture.triage.accepted',
    transitionId: 'triage:machine-ui-active-claim',
    now: '2026-05-01T00:00:02.000Z',
  });
  const claim = await claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId: 'claim-machine-ui-smoke',
    workerId: 'machine-ui-e2e-worker',
    recoverStale: false,
    // The renderer's staleness check (machineStaleActiveClaims) compares the
    // claim's expiresAt against the REAL wall clock (Date.now()), but this
    // fixture pins the claim to 2026-05-01. A finite lease anchored to a fixed
    // past date silently expires N ms after that date — the previous 30-day
    // lease made every "active claim in progress" assertion go red exactly on
    // 2026-05-31. A century-long lease keeps the fixture deterministically fresh
    // whenever the suite runs. seedStaleClaimRun passes an explicit short lease
    // when it wants the opposite.
    leaseMs: options.leaseMs ?? 100 * 365 * 24 * 60 * 60 * 1000,
    now: '2026-05-01T00:00:03.000Z',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'node.started',
    nodePath: 'main/worker',
    payload: {
      nodeExecutionId: `${run.runId}:main/worker:attempt-1`,
      nodeType: 'orpad.workerLoop',
      status: 'started',
      attempt: 1,
      itemId: item.item.id,
      claimId: claim.claim.claimId,
    },
  });
  return {
    runId: run.runId,
    runRoot: run.runRoot,
    claimId: claim.claim.claimId,
    itemId: claim.item.id,
  };
}

async function seedStaleClaimRun(workspace: string, pipelinePath: string): Promise<{ runId: string; runRoot: string; claimId: string; itemId: string }> {
  const seeded = await seedActiveClaimRun(workspace, pipelinePath, {
    runId: 'run_machine_ui_stale_claim',
    leaseMs: 1000,
  });
  const current = await findQueueItem(seeded.runRoot, seeded.itemId, { canonicalOnly: false });
  await writeQueueItem(seeded.runRoot, {
    ...current.item,
    state: 'queued',
    updatedAt: '2026-05-01T00:00:04.000Z',
  });
  return seeded;
}

async function seedReplayProjectionRun(
  workspace: string,
  pipelinePath: string,
): Promise<{ runId: string; runRoot: string; replayPosition: number }> {
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_replay_projection',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'running',
    reason: 'machine-ui.fixture.replay-running',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/context',
    eventType: 'node.started',
    payload: {
      nodeExecutionId: `${run.runId}:main/context:attempt-1`,
      nodeType: 'orpad.context',
      status: 'started',
      attempt: 1,
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/context',
    eventType: 'node.completed',
    payload: {
      nodeExecutionId: `${run.runId}:main/context:attempt-1`,
      nodeType: 'orpad.context',
      status: 'completed',
      attempt: 1,
    },
  });
  const replayEvents = await readMachineEvents(run.runRoot);
  const replayPosition = replayEvents.findIndex((event: { eventType?: string; nodePath?: string }) =>
    event.eventType === 'node.completed' && event.nodePath === 'main/context') + 1;
  expect(replayPosition).toBeGreaterThan(0);
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/probe',
    eventType: 'node.started',
    payload: {
      nodeExecutionId: `${run.runId}:main/probe:attempt-1`,
      nodeType: 'orpad.probe',
      status: 'started',
      attempt: 1,
    },
  });
  return { runId: run.runId, runRoot: run.runRoot, replayPosition };
}

async function enableMachineUi(win: any): Promise<void> {
  await win.evaluate(() => {
    localStorage.setItem('orpad-machine-ui-enabled', '1');
  });
}

async function submitMachineCapabilityToken(win: any): Promise<void> {
  await expect(win.locator('[data-machine-token-input]')).toBeVisible();
  await win.locator('[data-machine-token-input]').fill('test-token');
  await win.getByRole('button', { name: 'Use Token' }).click();
  await expect(win.locator('#fmt-modal')).toBeHidden();
}

async function confirmRunProviderSelection(win: any): Promise<void> {
  const picker = win.locator('.orpad-adapter-picker');
  await expect(picker).toBeVisible();
  await expect(picker).not.toContainText(/[\u3131-\uD79D]/);
  await expect(win.locator('[data-provider-id="codex-cli"]')).toBeVisible();
  await win.locator('[data-adapter-picker-confirm="true"]').click();
  await expect(win.locator('.orpad-adapter-picker-overlay')).toHaveCount(0);
}

async function skipPatchModalIfVisible(win: any): Promise<void> {
  const modal = win.locator('#fmt-modal');
  if (!(await modal.isVisible().catch(() => false))) {
    return;
  }
  await modal.getByRole('button', { name: /^(Cancel|Skip Patch)$/ }).click();
  await expect(modal).toBeHidden();
}

async function startManagedRunFromPreview(win: any): Promise<void> {
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  const defaultRun = win.locator('button[data-pipeline-run-action="default"]');
  await expect(defaultRun).toBeEnabled();
  await defaultRun.click();
}

test('Machine UI creates a durable run and executes a dispatcher worker adapter step', async () => {
  const { workspace, pipelinePath, pipelineDir } = writeMachineWorkspace();
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  const taskText = 'Improve Pipes UI smoke flow.';
  await win.locator('[data-runbook-task]').fill(taskText);
  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('Machine Workstream');
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('Flow: Main flow');
  await expect(win.locator('[data-pipeline-preview-runbar]')).not.toContainText('main.or-graph');
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('Ready to start.');
  await expect(win.locator('[data-pipeline-preview-runbar]')).not.toContainText(/Ready for .*handoff/);
  await expect(win.locator('button[data-pipeline-run-action="default"]')).toBeVisible();
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(win.locator('button[data-pipeline-run-action="local"]')).toBeDisabled();
  await expect(win.locator('button[data-pipeline-run-action="managed"]')).toContainText('Start Run');
  await expect(win.locator('button[data-pipeline-run-action="handoff"]')).toContainText('Prepare Handoff');
  await win.locator('[data-pipeline-run-menu]').click();
  await win.locator('[data-runbook-task]').focus();
  await win.keyboard.press('Control+Enter');
  await submitMachineCapabilityToken(win);
  await confirmRunProviderSelection(win);
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(win.locator('#runbooks-content')).toContainText(taskText);
  await expect(win.locator('#runbooks-content')).toContainText('Run started');
  await expect(win.locator('#runbooks-content')).not.toContainText(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  await expect(win.locator('#runbooks-content')).not.toContainText(/run_\d{8}_\d{6}/);

  const runRoot = path.join(pipelineDir, 'runs');
  await expect.poll(() => fs.existsSync(runRoot) ? fs.readdirSync(runRoot).length : 0).toBe(1);

  await expect(win.locator('#runbooks-content')).toContainText('Agent request prepared');
  await expect(win.locator('#runbooks-content')).toContainText('Work completed');
  await expect(win.locator('#runbooks-content')).toContainText('Work is ready');
  await expect(win.locator('#runbooks-content')).toContainText('Work found');
  await expect(win.locator('#runbooks-content')).toContainText('1 work item found');
  await expect(win.locator('#runbooks-content')).toContainText('Work result');
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 evidence files; 1 check; 1 changed file');
  await expect(win.locator('#fmt-modal-title')).toContainText('Review Patch');
  await expect(win.locator('#fmt-modal-body')).toContainText('Exercise Machine UI worker execution');
  await expect(win.locator('#fmt-modal-body')).toContainText('Patch artifact records the target file change.');
  await expect(win.locator('[data-machine-patch-file]')).toBeChecked();
  expect(fs.readFileSync(path.join(workspace, 'src', 'smoke-target.md'), 'utf-8')).toBe('before\n');
  await win.getByRole('button', { name: 'Approve & Apply' }).click();
  await expect(win.locator('#fmt-modal')).toBeHidden();
  await expect.poll(() => fs.readFileSync(path.join(workspace, 'src', 'smoke-target.md'), 'utf-8')).toBe('after from Machine UI harness\n');
  await expect(win.locator('#runbooks-content')).toContainText('Snapshot saved');
  await expect(win.locator('#runbooks-content')).toContainText('No permission needed');
  await expect(win.locator('#runbooks-content')).not.toContainText('No pending approvals');
  await expect(win.locator('#runbooks-content')).not.toContainText('Export Latest');
  await expect(win.locator('#runbooks-content')).not.toContainText('before auditing this run');
  await expect(win.locator('#runbooks-content')).toContainText('Recovery unavailable: completed/done is finished');
  await expect(win.locator('#runbooks-content')).not.toContainText(/\bResume\b/);
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toHaveText('Recover');
  await expect(win.locator('button[data-runbook-action="machine-export"]')).toBeEnabled();

  await win.locator('button[data-runbook-action="machine-export"]').click();
  await expect(win.locator('#runbooks-content')).toContainText('Evidence snapshot');
  await expect(win.locator('#runbooks-content')).toContainText('Snapshot saved');
  await expect(win.locator('#runbooks-content')).toContainText('Evidence check');
  await expect(win.locator('#runbooks-content')).toContainText('Evidence ready for review');
  await expect(win.locator('#runbooks-content')).not.toContainText('Export Latest before auditing this run');
  await expect.poll(() => fs.existsSync(path.join(pipelineDir, 'harness', 'generated', 'latest-run', 'run-metadata.json'))).toBe(true);
  await expect(win.locator('button[data-runbook-action="machine-view-artifacts"]')).toBeEnabled();
  await win.locator('button[data-runbook-action="machine-view-artifacts"]').click();
  await expect(win.locator('.tab-item.active')).toContainText('Run Evidence');
  await expect(win.locator('.tab-item.active')).not.toContainText(/run_\d{8}_\d{6}/);
  await expect(win.locator('.cm-content')).toContainText('Run Evidence');
  await expect(win.locator('.cm-content')).not.toContainText(/run_\d{8}_\d{6}/);
  await win.locator('#btn-preview').click();
  await expect(win.locator('#context-return-bar')).toContainText('Machine Workstream');
  await expect(win.locator('#context-return-bar')).toContainText('Run Evidence');
  await expect(win.locator('#content')).toContainText('artifacts/discovery/candidate-inventory.json');
  await expect(win.locator('#content')).toContainText('artifacts/patches');
  await expect(win.locator('#content')).toContainText('Evidence ready for review');
  await win.locator('[data-context-return-action="flow"]').click();
  await expect(win.locator('.tab-item.active')).toContainText('main.or-graph');
  await expect(win.locator('#content.view-orch-graph .orch-preview')).toBeVisible();
  await expect(win.locator('#context-return-bar')).toHaveClass(/hidden/);
  await expect(win.locator('#content.view-orch-graph .pipe-lifecycle-banner')).toBeVisible();
  await win.setViewportSize({ width: 980, height: 520 });
  const graphScroll = await win.locator('#content.view-orch-graph').evaluate((el: HTMLElement) => {
    const preview = el.querySelector('.orch-preview') as HTMLElement | null;
    const frame = el.querySelector('.orch-graph-frame') as HTMLElement | null;
    el.scrollTop = 0;
    el.scrollTop = el.scrollHeight;
    return {
      contentOverflowY: getComputedStyle(el).overflowY,
      previewOverflowY: preview ? getComputedStyle(preview).overflowY : '',
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTopAfter: el.scrollTop,
      frameBottom: frame ? frame.offsetTop + frame.offsetHeight : 0,
    };
  });
  expect(graphScroll.contentOverflowY).toBe('auto');
  expect(graphScroll.previewOverflowY).toBe('visible');
  expect(graphScroll.scrollHeight).toBeGreaterThan(graphScroll.clientHeight);
  expect(graphScroll.scrollTopAfter).toBeGreaterThan(0);
  expect(graphScroll.frameBottom).toBeLessThanOrEqual(graphScroll.scrollHeight + 2);
  await win.setViewportSize({ width: 1280, height: 720 });

  const runDirs = fs.readdirSync(runRoot);
  expect(fs.existsSync(path.join(runRoot, runDirs[0], 'run-state.json'))).toBe(true);
  expect(fs.existsSync(path.join(runRoot, runDirs[0], 'events.jsonl'))).toBe(true);
  expect(fs.readFileSync(path.join(runRoot, runDirs[0], 'events.jsonl'), 'utf-8')).toContain('run.created');
  expect(fs.readFileSync(path.join(runRoot, runDirs[0], 'events.jsonl'), 'utf-8')).toContain(taskText);
  expect(pipelinePath.endsWith('pipeline.or-pipeline')).toBe(true);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });
  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(win.locator('#runbooks-content')).toContainText(taskText);
  await expect(win.locator('#runbooks-content')).toContainText('Work completed');
  await expect(win.locator('#runbooks-content')).not.toContainText(runDirs[0]);
  await expect(win.locator('#runbooks-content')).toContainText('1 work item found');
  await expect(win.locator('#runbooks-content')).toContainText('Discovery evidence saved');
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 evidence files; 1 check; 1 changed file');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeDisabled();

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI uses selected pipeline objective instead of stale draft task', async () => {
  const { workspace, pipelinePath, pipelineDir } = writeMachineWorkspace();
  const pipelineObjective = 'Fix UI pipeline pagination cleanup and simulation resource release.';
  const staleDraftTask = 'Build Package RAG for installed OrPAD packages.';
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  pipeline.metadata = {
    ...(pipeline.metadata || {}),
    orchestrationAuthoring: {
      ...(pipeline.metadata?.orchestrationAuthoring || {}),
      taskText: pipelineObjective,
    },
  };
  fs.writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2));

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);
  await win.evaluate((value) => localStorage.setItem('orpad-runbook-task', value), staleDraftTask);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await expect(win.locator('[data-runbook-task]')).toHaveValue(staleDraftTask);
  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await win.locator('[data-runbook-task]').focus();
  await win.keyboard.press('Control+Enter');
  await submitMachineCapabilityToken(win);
  await confirmRunProviderSelection(win);

  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  const objectiveLine = win.locator('#runbooks-content p.runbook-muted').filter({ hasText: 'Objective' }).first();
  await expect(objectiveLine).toContainText(pipelineObjective);
  await expect(objectiveLine).not.toContainText(staleDraftTask);

  const runRoot = path.join(pipelineDir, 'runs');
  await expect.poll(() => fs.existsSync(runRoot) ? fs.readdirSync(runRoot).length : 0).toBe(1);
  const runDirs = fs.readdirSync(runRoot);
  const events = fs.readFileSync(path.join(runRoot, runDirs[0], 'events.jsonl'), 'utf-8');
  expect(events).toContain(pipelineObjective);
  expect(events).not.toContain(staleDraftTask);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine graph executes configured probe fanout in parallel', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  addParallelProbeHarness(pipelinePath);
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_parallel_probe_fanout',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });

  const executed = await executeMachineRunStep({
    workspaceRoot: workspace,
    pipelinePath,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });

  expect(executed.selectedProbeNodes).toEqual(['main/probe', 'main/probe-secondary']);
  expect(executed.candidateInventory.candidateCount).toBe(2);
  expect(executed.workerLoop.workerCount).toBe(2);
  expect(executed.claims).toHaveLength(2);
  expect(executed.workers).toHaveLength(2);
  const probeStarts = executed.events
    .filter((event: { eventType?: string; nodePath?: string }) => (
      event.eventType === 'node.started'
      && ['main/probe', 'main/probe-secondary'].includes(event.nodePath || '')
    ));
  const probeCompletions = executed.events
    .filter((event: { eventType?: string; nodePath?: string }) => (
      event.eventType === 'node.completed'
      && ['main/probe', 'main/probe-secondary'].includes(event.nodePath || '')
    ));
  expect(probeStarts.map((event: { nodePath?: string }) => event.nodePath).sort()).toEqual(['main/probe', 'main/probe-secondary']);
  expect(probeCompletions).toHaveLength(2);
  const lastStartSequence = Math.max(...probeStarts.map((event: { sequence: number }) => event.sequence));
  const firstCompletionSequence = Math.min(...probeCompletions.map((event: { sequence: number }) => event.sequence));
  expect(lastStartSequence).toBeLessThan(firstCompletionSequence);
  const sequences = executed.events.map((event: { sequence: number }) => event.sequence);
  expect(new Set(sequences).size).toBe(sequences.length);
  const workerResults = executed.events
    .filter((event: { eventType?: string }) => event.eventType === 'worker.result');
  expect(workerResults.map((event: { itemId?: string }) => event.itemId).sort()).toEqual([
    'machine-ui-secondary',
    'machine-ui-smoke',
  ]);
  expect(executed.finalization.inventory.activeCount).toBe(0);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine graph continues queued work after reviewable blocked patch', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  addParallelProbeHarness(pipelinePath);
  makeParallelProbeWorkersReviewBlocked(pipelinePath);
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_review_blocked_continues_queue',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });

  const executed = await executeMachineRunStep({
    workspaceRoot: workspace,
    pipelinePath,
    runRoot: run.runRoot,
    runId: run.runId,
    exportLatestRunAfterStep: false,
    nodeExecutable: process.execPath,
  });

  expect(executed.workerLoop.workerCount).toBe(2);
  expect(executed.workerLoop.stopReason).toBe('claim-limit');
  const workerResults = executed.events
    .filter((event: { eventType?: string }) => event.eventType === 'worker.result');
  expect(workerResults).toHaveLength(2);
  expect(workerResults.every((event: { payload?: { status?: string } }) => event.payload?.status === 'blocked')).toBe(true);
  expect(executed.finalization.inventory.activeCount).toBe(0);
  expect(executed.finalization.inventory.blockedCount).toBe(2);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI shows running managed runs as busy and blocks duplicate Continue', async (_fixtures, testInfo) => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_running',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'running',
    reason: 'machine-ui.fixture.active-step',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/probe',
    eventType: 'node.started',
    payload: {
      nodeExecutionId: `${run.runId}:main/probe:attempt-1`,
      nodeType: 'orpad.probe',
      status: 'started',
      attempt: 1,
    },
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('Run in progress.');
  const primaryRunButton = win.locator('button.pipeline-run-primary');
  await expect(primaryRunButton).toBeEnabled();
  await expect(primaryRunButton).toHaveAttribute('data-pipeline-run-action', 'machine-cancel-run');
  await expect(primaryRunButton).toHaveAttribute('aria-label', 'Stop Run');
  await expect(primaryRunButton).toHaveClass(/danger/);
  const runningProbeNode = win.locator('.orch-graph-node[data-machine-node-path="main/probe"]');
  await expect(runningProbeNode).toContainText('Running');
  await expect(runningProbeNode).toHaveClass(/runtime-running/);
  await expect(win.locator('.orch-transition[data-machine-edge-state="active"]')).toHaveCount(1);
  await expect(win.locator('.orch-transition-flow-arrows')).toHaveCount(1);
  await expectRuntimeHeroGraphChrome(win, 'machine run active graph');
  const activeGraphScreenshot = testInfo.outputPath('machine-run-active-graph.png');
  await win.locator('.orch-graph-frame').first().screenshot({
    path: activeGraphScreenshot,
    animations: 'disabled',
  });
  await testInfo.attach('machine-run-active-graph', {
    path: activeGraphScreenshot,
    contentType: 'image/png',
  });
  await expectReducedMotionHeroGraphFallback(win, 'machine run active graph');
  await expect(win.locator('button[data-orch-mode="readonly"]')).toHaveClass(/active/);
  await expect(win.locator('button[data-orch-mode="readwrite"]')).toBeDisabled();
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(win.locator('button[data-pipeline-run-action="managed"]')).toBeDisabled();
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Running$/ })).toBeVisible();
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toHaveCount(0);
  await expect(win.locator('button[data-runbook-action="machine-cancel-run"]')).toHaveCount(0);
  const recoverButton = win.locator('button[data-runbook-action="machine-resume-run"]');
  await expect(recoverButton).toBeDisabled();
  await expect(recoverButton).toHaveAttribute('title', /OrPAD is already working/);
  await expect(win.locator('#runbooks-content')).toContainText('Run started');
  // Stopping an in-flight run now requires confirming the destructive action.
  win.once('dialog', (dialog: any) => dialog.accept());
  await primaryRunButton.click();
  await submitMachineCapabilityToken(win);
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Cancelled$/ })).toBeVisible();
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Stopped$/ })).toBeVisible();
  await expect(win.locator('#runbooks-content')).not.toContainText('Partial proof');
  await expect(primaryRunButton).toHaveAttribute('data-pipeline-run-action', 'default');
  await expect(primaryRunButton).toHaveAttribute('aria-label', /Start Run/);
  await expect(primaryRunButton).not.toHaveClass(/danger/);
  await expect(runningProbeNode).toContainText('Cancelled');
  await expect(runningProbeNode).toHaveClass(/runtime-cancelled/);
  await expect(win.locator('.orch-transition[data-machine-edge-state="active"]')).toHaveCount(0);
  await expect(win.locator('.orch-transition-flow-arrows')).toHaveCount(0);
  await expect(win.locator('button[data-orch-mode="readwrite"]')).toBeEnabled();

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI does not animate inactive transitions after a waiting run', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_waiting_projection',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/context',
    eventType: 'node.completed',
    payload: {
      nodeExecutionId: `${run.runId}:main/context:attempt-1`,
      nodeType: 'orpad.context',
      status: 'completed',
      attempt: 1,
    },
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'waiting',
    reason: 'machine-ui.fixture.waiting',
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'partial',
    reason: 'machine-ui.fixture.partial',
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  const completedContextNode = win.locator('.orch-graph-node[data-machine-node-path="main/context"]');
  await expect(completedContextNode).toContainText('Done');
  await expect(completedContextNode).toHaveClass(/runtime-completed/);
  await expect(win.locator('.orch-transition[data-machine-edge-state="active"]')).toHaveCount(0);
  await expect(win.locator('.orch-transition-flow-arrows')).toHaveCount(0);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI replay slider drives graph projection and keeps run actions live', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const seeded = await seedReplayProjectionRun(workspace, pipelinePath);

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  const runbar = win.locator('[data-pipeline-preview-runbar]');
  const primaryRunButton = win.locator('button.pipeline-run-primary');
  const contextNode = win.locator('.orch-graph-node').filter({ hasText: 'Context' });
  const probeNode = win.locator('.orch-graph-node').filter({ hasText: 'Probe' });
  await expect(runbar).toContainText('progress 1/2');
  await expect(contextNode).toContainText('Done');
  await expect(probeNode).toContainText('Running');
  await expect(win.locator('.orch-transition[data-machine-edge-state="active"]')).toHaveCount(1);
  await expect(primaryRunButton).toHaveAttribute('data-pipeline-run-action', 'machine-cancel-run');

  for (let pass = 0; pass < 2; pass += 1) {
    await win.locator('[data-runbook-run-details]').evaluate((element: HTMLDetailsElement) => {
      element.open = true;
    });
    const slider = win.locator('[data-runbook-replay-slider]');
    await expect(slider).toBeVisible();
    await slider.evaluate((element: HTMLInputElement, value: string) => {
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, String(seeded.replayPosition));
    await expect(win.locator('#runbooks-content')).toContainText('Replaying');
    await expect(win.locator('#runbooks-content')).toContainText('Run controls use the live run');
    await expect(runbar).toContainText('progress 1/1');
    await expect(contextNode).toContainText('Done');
    await expect(probeNode).not.toContainText('Running');
    await expect(win.locator('.orch-transition[data-machine-edge-state="active"]')).toHaveCount(0);
    await expect(primaryRunButton).toHaveAttribute('data-pipeline-run-action', 'machine-cancel-run');

    await win.locator('[data-runbook-run-details]').evaluate((element: HTMLDetailsElement) => {
      element.open = true;
    });
    await win.locator('button[data-runbook-action="replay-live"]').click();
    await expect(win.locator('#runbooks-content')).not.toContainText('Replaying');
    await expect(runbar).toContainText('progress 1/2');
    await expect(probeNode).toContainText('Running');
    await expect(win.locator('.orch-transition[data-machine-edge-state="active"]')).toHaveCount(1);
  }

  expect(fs.readFileSync(path.join(seeded.runRoot, 'events.jsonl'), 'utf-8')).toContain('main/probe');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Orchestration window run refresh preserves scroll, details, and text selection', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const seeded = await seedReplayProjectionRun(workspace, pipelinePath);
  for (let i = 0; i < 60; i += 1) {
    await appendMachineEvent(seeded.runRoot, {
      runId: seeded.runId,
      actor: 'machine',
      eventType: 'scheduler.edgeEvaluation',
      nodePath: 'main/probe',
      payload: {
        firedCount: i % 2,
        droppedCount: (i + 1) % 2,
      },
    });
  }

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  const orchestrationWindowPromise = app.waitForEvent('window');
  await win.locator('#btn-orchestration').click();
  const orchestrationWin = await orchestrationWindowPromise;
  await orchestrationWin.waitForLoadState('domcontentloaded');
  await orchestrationWin.waitForSelector('body.orchestration-window');
  await orchestrationWin.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  await expect(orchestrationWin.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(orchestrationWin.locator('#toolbar [data-pipeline-select-trigger] span')).toContainText('Machine Workstream');

  await orchestrationWin.locator('#toolbar [data-pipeline-select-trigger]').click();
  await orchestrationWin.locator('#toolbar [data-orchestration-select-pipeline]')
    .filter({ has: orchestrationWin.locator('strong').filter({ hasText: /^Machine Workstream/ }) })
    .click();
  await expect(orchestrationWin.locator('#runbooks-content')).toContainText('Latest Run');
  await expectToolbarRunbarTelemetryAtWidth(orchestrationWin, 900);
  await orchestrationWin.addStyleTag({ content: '.runbook-replay-events { max-height: 36px !important; }' });

  await orchestrationWin.locator('[data-runbook-run-details] summary').click();
  const eventLog = orchestrationWin.locator('[data-runbook-run-details] [data-runbook-replay-events]');
  await expect(eventLog).toBeVisible();
  const beforeScrollTop = await eventLog.evaluate((el: HTMLElement) => new Promise<number>((resolve) => {
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.style.scrollBehavior = 'auto';
    el.scrollTop = Math.max(12, Math.floor(maxTop / 2));
    requestAnimationFrame(() => {
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      resolve(el.scrollTop);
    });
  }));
  expect(beforeScrollTop).toBeGreaterThan(0);

  await appendMachineEvent(seeded.runRoot, {
    runId: seeded.runId,
    actor: 'machine',
    eventType: 'scheduler.loopBackReset',
    nodePath: 'main/probe',
    payload: {
      targetNodePath: 'pointer-defer-probe',
    },
  });
  await orchestrationWin.locator('#content').evaluate((element: HTMLElement) => {
    const EventCtor = window.PointerEvent || window.MouseEvent;
    element.dispatchEvent(new EventCtor('pointerdown', { bubbles: true, buttons: 1 }));
  });
  await orchestrationWin.evaluate(() => window.dispatchEvent(new Event('focus')));
  await orchestrationWin.waitForTimeout(900);
  await expect(orchestrationWin.locator('#runbooks-content')).not.toContainText('Loop-back reset: pointer-defer-probe');
  await orchestrationWin.locator('#content').evaluate((element: HTMLElement) => {
    const EventCtor = window.PointerEvent || window.MouseEvent;
    element.dispatchEvent(new EventCtor('pointerup', { bubbles: true }));
  });
  await expect(orchestrationWin.locator('#runbooks-content')).toContainText('Loop-back reset: pointer-defer-probe');

  await appendMachineEvent(seeded.runRoot, {
    runId: seeded.runId,
    actor: 'machine',
    eventType: 'node.blocked',
    nodePath: 'main/probe',
    payload: {
      nodeExecutionId: `${seeded.runId}:main/probe:attempt-1`,
      nodeType: 'orpad.probe',
      attempt: 1,
      reason: 'orchestration-window-refresh-test',
    },
  });
  await orchestrationWin.locator('button[data-runbook-action="refresh"]').click();
  await expect(orchestrationWin.locator('#runbooks-content')).toContainText('Step blocked');

  const afterRefresh = await orchestrationWin.locator('[data-runbook-run-details]').evaluate((details: HTMLDetailsElement) => {
    const log = details.querySelector('[data-runbook-replay-events]') as HTMLElement | null;
    return {
      open: details.open,
      scrollTop: log?.scrollTop || 0,
    };
  });
  expect(afterRefresh.open).toBe(true);
  expect(Math.abs(afterRefresh.scrollTop - beforeScrollTop)).toBeLessThanOrEqual(8);
  await expect(orchestrationWin.locator('button[data-runbook-action="toggle-replay-stick"]')).toContainText('Manual scroll');

  const firstEvent = orchestrationWin.locator('[data-runbook-run-details] [data-runbook-replay-events] .runbook-event').first();
  const selectedText = (await firstEvent.textContent())?.trim().slice(0, 12) || 'Run started';
  await firstEvent.evaluate((el: HTMLElement) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });

  await appendMachineEvent(seeded.runRoot, {
    runId: seeded.runId,
    actor: 'machine',
    eventType: 'node.failed',
    nodePath: 'main/probe',
    payload: {
      nodeExecutionId: `${seeded.runId}:main/probe:attempt-2`,
      nodeType: 'orpad.probe',
      attempt: 2,
      reason: 'orchestration-window-refresh-test-selection',
    },
  });
  await orchestrationWin.evaluate(() => window.dispatchEvent(new Event('focus')));
  await orchestrationWin.waitForTimeout(900);
  await expect.poll(() => orchestrationWin.evaluate(() => window.getSelection()?.toString() || '')).toContain(selectedText);
  await expect(orchestrationWin.locator('#runbooks-content')).not.toContainText('Step failed');

  await orchestrationWin.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(orchestrationWin.locator('#runbooks-content')).toContainText('Step failed');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI resets transient replay and history state when switching workspaces with the same run id', async () => {
  const first = writeMachineWorkspace();
  const second = writeMachineWorkspace();
  const firstSeed = await seedReplayProjectionRun(first.workspace, first.pipelinePath);
  const secondSeed = await seedReplayProjectionRun(second.workspace, second.pipelinePath);
  expect(secondSeed.runId).toBe(firstSeed.runId);

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, first.workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  const runbar = win.locator('[data-pipeline-preview-runbar]');
  await expect(runbar).toContainText('progress 1/2');

  await win.locator('[data-runbook-run-details] summary').click();
  const slider = win.locator('[data-runbook-replay-slider]');
  await expect(slider).toBeVisible();
  await slider.evaluate((element: HTMLInputElement, value: string) => {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(firstSeed.replayPosition));
  await expect(win.locator('#runbooks-content')).toContainText('Replaying');
  await expect(runbar).toContainText('progress 1/1');

  const historySearch = win.locator('[data-runbook-history-search]');
  await expect(historySearch).toBeVisible();
  await historySearch.fill('no-such-run');
  await expect(win.locator('#runbooks-content')).toContainText('No runs match the current filter.');

  await win.locator('[data-runbook-run-details]').evaluate((element: HTMLDetailsElement) => {
    element.open = true;
  });
  const stickToggle = win.locator('button[data-runbook-action="toggle-replay-stick"]');
  await expect(stickToggle).toContainText('Auto-scroll');
  await stickToggle.click();
  await expect(stickToggle).toContainText('Manual scroll');

  const patchedDialog = await app.evaluate(({ dialog }, workspaceRoot) => {
    if (!dialog?.showOpenDialog) return false;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [workspaceRoot],
    });
    return true;
  }, second.workspace);
  expect(patchedDialog).toBe(true);

  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('file.openFolder');
  });
  const switchedRunbook = win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' });
  await expect(switchedRunbook).toBeVisible();
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');

  await expect(win.locator('#runbooks-content')).not.toContainText('Replaying');
  const switchedHistorySearch = win.locator('[data-runbook-history-search]');
  await expect.poll(async () => {
    if (await switchedHistorySearch.count() === 0) return '';
    return switchedHistorySearch.first().inputValue();
  }).toBe('');
  await expect(win.locator('#runbooks-content')).not.toContainText('No runs match the current filter.');
  if (await win.locator('[data-runbook-run-details]').count() === 0) {
    const selectedAfterSwitch = await switchedRunbook.evaluate((element: HTMLElement) => element.classList.contains('active'));
    if (selectedAfterSwitch) {
      await switchedRunbook.click();
      await expect(switchedRunbook).not.toHaveClass(/active/);
    }
    await switchedRunbook.click();
    await expect(win.locator('[data-runbook-run-details]')).toHaveCount(1);
  }
  await win.locator('[data-runbook-run-details]').evaluate((element: HTMLDetailsElement) => {
    element.open = true;
  });
  await expect(win.locator('button[data-runbook-action="toggle-replay-stick"]')).toContainText('Auto-scroll');

  await app.close();
  fs.rmSync(first.workspace, { recursive: true, force: true });
  fs.rmSync(second.workspace, { recursive: true, force: true });
});

test('Machine UI prunes per-run replay transient state without resetting active auto-scroll', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  const result = await win.evaluate(({ workspaceRoot, runbookPath }) => {
    (window as any).__orpadReplayPruneArgs = { workspaceRoot, runbookPath };
    return (window as any).eval(`(() => {
      const { workspaceRoot, runbookPath } = window.__orpadReplayPruneArgs;
      workspacePath = workspaceRoot;
      selectedRunbookPath = runbookPath;
      const activeRunId = 'run_machine_ui_replay_prune_active';
      const staleRunId = 'run_machine_ui_replay_prune_stale';
      const inspectedRunId = 'run_machine_ui_replay_prune_inspected';
      const seedTransient = (runId, lastSeq = 4) => {
        setReplayPosition(runbookPath, runId, 1);
        setReplayStickEnabled(runbookPath, runId, false);
        lastReplayRenderedSequence.set(machineRunTransientScopeKey(runbookPath, runId), lastSeq);
      };
      const snapshot = (runId) => {
        const key = machineRunTransientScopeKey(runbookPath, runId);
        return {
          position: machineRunReplayPosition.has(key),
          stickOff: machineRunReplayStickRunIds.has('off:' + key),
          lastSeq: lastReplayRenderedSequence.get(key) || 0,
        };
      };

      lastMachineRunRecord = {
        runId: activeRunId,
        runState: { runId: activeRunId, lifecycleStatus: 'running', summaryStatus: 'pending' },
        events: [{ sequence: 1 }, { sequence: 2 }],
      };
      setRunbookCache(machineRunRecordCache, runbookPath, lastMachineRunRecord);
      seedTransient(activeRunId);
      seedTransient(staleRunId);
      setRunbookCache(machineRunListCache, runbookPath, {
        runs: [{ runId: activeRunId, lifecycleStatus: 'running', summaryStatus: 'pending' }],
        loadedAt: new Date().toISOString(),
      });
      pruneMachineRunReplayTransientStateForCachedRunList(runbookPath);
      const afterListPrune = {
        active: snapshot(activeRunId),
        stale: snapshot(staleRunId),
      };

      seedTransient(inspectedRunId, 9);
      setHistoryInspectionRecord(runbookPath, {
        runId: inspectedRunId,
        runState: { runId: inspectedRunId, lifecycleStatus: 'completed', summaryStatus: 'done' },
      });
      clearHistoryInspection(runbookPath);
      const afterHistoryClose = snapshot(inspectedRunId);

      clearReplayPosition(runbookPath, activeRunId);
      clearMachineRunReplayTransientStateIfUnreferenced(runbookPath, activeRunId);
      const afterLive = snapshot(activeRunId);

      setReplayPosition(runbookPath, activeRunId, 2);
      const liveRecord = applyReplaySnapshot({
        runId: activeRunId,
        runState: { runId: activeRunId, lifecycleStatus: 'running', summaryStatus: 'pending' },
        events: [{ sequence: 1 }, { sequence: 2 }],
      }, runbookPath);
      const afterMaxReplay = {
        active: snapshot(activeRunId),
        returnedLive: !liveRecord.__replay,
      };

      return { afterListPrune, afterHistoryClose, afterLive, afterMaxReplay };
    })()`);
  }, { workspaceRoot: workspace, runbookPath: pipelinePath });

  expect(result).toEqual({
    afterListPrune: {
      active: { position: true, stickOff: true, lastSeq: 4 },
      stale: { position: false, stickOff: false, lastSeq: 0 },
    },
    afterHistoryClose: { position: false, stickOff: false, lastSeq: 0 },
    afterLive: { position: false, stickOff: true, lastSeq: 4 },
    afterMaxReplay: {
      active: { position: false, stickOff: true, lastSeq: 4 },
      returnedLive: true,
    },
  });

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI does not open a blocked decision modal for a normal waiting queue', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_waiting_active_queue',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  const baseProposal = pipeline.run.machineHarness.candidateProposal;
  const queuedItem = await ingestCandidateProposal(run.runRoot, {
    ...baseProposal,
    proposalId: 'proposal-machine-ui-queued-only',
    suggestedWorkItemId: 'machine-ui-queued-only',
    title: 'Queued work can continue without a blocker',
    fingerprint: 'machine-ui-queued-only:src/smoke-target.md',
  }, {
    runId: run.runId,
    transitionId: 'proposal:machine-ui-queued-only',
    now: '2026-05-01T00:00:01.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: queuedItem.item.id,
    toState: 'queued',
    reason: 'machine-ui.fixture.queued',
    transitionId: 'triage:machine-ui-queued-only',
    now: '2026-05-01T00:00:02.000Z',
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'waiting',
    reason: 'machine-ui.fixture.waiting',
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'partial',
    reason: 'machine-ui.fixture.partial',
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('#fmt-modal')).toBeHidden();
  await expect(win.locator('#runbooks-content')).toContainText('Work queue waiting');
  await expect(win.locator('#runbooks-content')).not.toContainText('Queue has blocked work');
  await expect(win.locator('button[data-runbook-action="machine-open-blocked-decision"]')).toHaveCount(0);
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeEnabled();

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI opens a decision modal for waiting runs with blocked queue work', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_blocked_queue_decision',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  const baseProposal = pipeline.run.machineHarness.candidateProposal;
  const blockedItem = await ingestCandidateProposal(run.runRoot, {
    ...baseProposal,
    proposalId: 'proposal-machine-ui-blocked',
    suggestedWorkItemId: 'machine-ui-blocked',
    title: 'Blocked queue item needs a decision',
    fingerprint: 'machine-ui-blocked:src/smoke-target.md',
  }, {
    runId: run.runId,
    transitionId: 'proposal:machine-ui-blocked',
    now: '2026-05-01T00:00:01.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: blockedItem.item.id,
    toState: 'blocked',
    reason: 'machine-ui.fixture.blocked',
    transitionId: 'triage:machine-ui-blocked',
    now: '2026-05-01T00:00:02.000Z',
  });
  const queuedItem = await ingestCandidateProposal(run.runRoot, {
    ...baseProposal,
    proposalId: 'proposal-machine-ui-queued',
    suggestedWorkItemId: 'machine-ui-queued',
    title: 'Queued queue item can continue',
    fingerprint: 'machine-ui-queued:src/smoke-target.md',
  }, {
    runId: run.runId,
    transitionId: 'proposal:machine-ui-queued',
    now: '2026-05-01T00:00:03.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: queuedItem.item.id,
    toState: 'queued',
    reason: 'machine-ui.fixture.queued',
    transitionId: 'triage:machine-ui-queued',
    now: '2026-05-01T00:00:04.000Z',
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'waiting',
    reason: 'machine-ui.fixture.waiting',
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'partial',
    reason: 'machine-ui.fixture.partial',
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('#fmt-modal')).toBeHidden();
  await expect(win.locator('#runbooks-content')).toContainText('Queue has blocked work');

  await win.getByRole('button', { name: 'Resolve Blocker', exact: true }).click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Run Blocked');
  await expect(win.locator('#fmt-modal-body')).toContainText('1 queued, 1 blocked');
  await expect(win.locator('#fmt-modal-body')).toContainText('machine-ui-blocked');
  await expect(win.locator('#fmt-modal-footer')).toContainText('Continue Queue');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI does not offer stop as the terminal blocked-queue follow-up', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_blocked_queue_exhausted',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  const baseProposal = pipeline.run.machineHarness.candidateProposal;
  const blockedItem = await ingestCandidateProposal(run.runRoot, {
    ...baseProposal,
    proposalId: 'proposal-machine-ui-terminal-blocked',
    suggestedWorkItemId: 'machine-ui-terminal-blocked',
    title: 'Blocked queue item remains for follow-up',
    fingerprint: 'machine-ui-terminal-blocked:src/smoke-target.md',
  }, {
    runId: run.runId,
    transitionId: 'proposal:machine-ui-terminal-blocked',
    now: '2026-05-01T00:00:01.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: blockedItem.item.id,
    toState: 'blocked',
    reason: 'machine-ui.fixture.blocked',
    transitionId: 'triage:machine-ui-terminal-blocked',
    now: '2026-05-01T00:00:02.000Z',
  });
  const doneItem = await ingestCandidateProposal(run.runRoot, {
    ...baseProposal,
    proposalId: 'proposal-machine-ui-terminal-done',
    suggestedWorkItemId: 'machine-ui-terminal-done',
    title: 'Done queue item',
    fingerprint: 'machine-ui-terminal-done:src/smoke-target.md',
  }, {
    runId: run.runId,
    transitionId: 'proposal:machine-ui-terminal-done',
    now: '2026-05-01T00:00:03.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: doneItem.item.id,
    toState: 'queued',
    reason: 'machine-ui.fixture.queued',
    transitionId: 'triage:machine-ui-terminal-done',
    now: '2026-05-01T00:00:04.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: doneItem.item.id,
    toState: 'claimed',
    reason: 'machine-ui.fixture.claimed',
    transitionId: 'claim:machine-ui-terminal-done',
    now: '2026-05-01T00:00:05.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: doneItem.item.id,
    toState: 'done',
    reason: 'machine-ui.fixture.done',
    transitionId: 'close:machine-ui-terminal-done',
    now: '2026-05-01T00:00:06.000Z',
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'waiting',
    reason: 'machine-ui.fixture.waiting',
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'partial',
    reason: 'machine-ui.fixture.partial',
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('#fmt-modal')).toBeHidden();
  await expect(win.locator('#runbooks-content')).toContainText('Queue has blocked work');
  await expect(win.locator('#runbooks-content')).toContainText('Blocked - no runnable work');
  await expect(win.locator('#runbooks-content')).toContainText('This run will not continue by itself');
  await expect(win.locator('#runbooks-content')).toContainText('Start follow-up');

  await win.getByRole('button', { name: 'Review Blocker', exact: true }).click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Run Blocked');
  await expect(win.locator('#fmt-modal-body')).toContainText('1 blocked, 1 done');
  await expect(win.locator('#fmt-modal-body')).toContainText('No runnable work');
  await expect(win.locator('#fmt-modal-body')).toContainText('No queued work remains');
  await expect(win.locator('#fmt-modal-footer')).toContainText('Start Follow-up');
  await expect(win.locator('#fmt-modal-footer')).toContainText('Review Evidence');
  await expect(win.locator('#fmt-modal-footer')).toContainText('Close');
  await expect(win.locator('#fmt-modal-footer')).not.toContainText('Stop Run');
  await expect(win.locator('#fmt-modal-footer')).not.toContainText('Cancel Remaining Work');
  await expect(win.locator('#fmt-modal-footer')).not.toContainText('Continue Queue');
  await win.locator('#fmt-modal-footer button').filter({ hasText: 'Start Follow-up' }).click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Start Follow-up');
  await expect(win.locator('#fmt-modal-body')).toContainText('Not an async wait');
  await expect(win.locator('[data-machine-follow-up-prompt]')).toHaveValue(/machine-ui-terminal-blocked/);
  await win.locator('#fmt-modal-close').click();
  await expect(win.locator('#fmt-modal')).toBeHidden();

  await win.getByRole('button', { name: 'Review Evidence', exact: true }).click();
  await expect(win.locator('.tab-item.active')).toContainText('Run Evidence');
  await expect(win.locator('.cm-content')).toContainText('Current Decision');
  await expect(win.locator('.cm-content')).toContainText('no runnable work remains');
  await expect(win.locator('.cm-content')).toContainText('Blocked Work');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine blocked modal prioritizes evidence-incomplete gate reason', async () => {
  const { workspace, pipelinePath, pipelineDir } = writeMachineWorkspace();
  const graphPath = path.join(pipelineDir, 'graphs', 'main.or-graph');
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
  graph.graph.nodes.push({
    id: 'exit',
    type: 'orpad.exit',
    label: 'Exit',
    config: { requireEvidence: true },
  });
  graph.graph.transitions.push({ from: 'worker', to: 'exit' });
  fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2));

  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_evidence_incomplete_gate',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  const blockedItem = await ingestCandidateProposal(run.runRoot, {
    ...pipeline.run.machineHarness.candidateProposal,
    proposalId: 'proposal-machine-ui-evidence-incomplete',
    suggestedWorkItemId: 'machine-ui-evidence-incomplete',
    title: 'Blocked work item behind evidence-incomplete exit',
    fingerprint: 'machine-ui-evidence-incomplete:src/smoke-target.md',
  }, {
    runId: run.runId,
    transitionId: 'proposal:machine-ui-evidence-incomplete',
    now: '2026-05-01T00:00:01.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: blockedItem.item.id,
    toState: 'blocked',
    reason: 'machine-ui.fixture.blocked',
    transitionId: 'block:machine-ui-evidence-incomplete',
    now: '2026-05-01T00:00:02.000Z',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'node.blocked',
    nodePath: 'main/exit',
    reason: 'exit.evidence-incomplete',
    payload: {
      nodeExecutionId: `${run.runId}:main/exit:attempt-1`,
      nodeType: 'orpad.exit',
      status: 'blocked',
      attempt: 1,
      reason: 'exit.evidence-incomplete',
      artifactContracts: [{
        nodePath: 'main/exit',
        missingArtifacts: [],
        missingQueue: [],
        missingItemEvidence: [{
          itemId: 'machine-ui-evidence-incomplete',
          missingFields: ['failingSymptom', 'rootCause', 'residualRisk'],
          evidenceSources: ['worker.result:12'],
        }],
      }],
    },
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'waiting',
    reason: 'exit.evidence-incomplete',
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'partial',
    reason: 'exit.evidence-incomplete',
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('#runbooks-content')).toContainText('Evidence incomplete');
  await expect(win.locator('#runbooks-content')).toContainText('Queue has blocked work');

  const modal = win.locator('#fmt-modal');
  if (!(await modal.isVisible().catch(() => false))) {
    await win.getByRole('button', { name: 'Review Blocker', exact: true }).click();
  }
  await expect(modal).toBeVisible();
  await expect(win.locator('#fmt-modal-title')).toContainText('Run Blocked');
  const primarySection = win.locator('#fmt-modal-body .runbook-modal-section');
  await expect(primarySection.locator('h4')).toContainText('Evidence incomplete');
  await expect(primarySection.locator('p')).toContainText('1 completed work item is missing required evidence fields');
  await expect(primarySection).not.toContainText('Blocked work recorded');
  await expect(win.locator('#fmt-modal-body')).toContainText('Blocked gate');
  await expect(win.locator('#fmt-modal-body')).toContainText('main/exit (exit.evidence-incomplete)');
  await expect(win.locator('#fmt-modal-body')).toContainText('Missing item evidence: machine-ui-evidence-incomplete: failingSymptom, rootCause, residualRisk.');
  await expect(win.locator('#fmt-modal-body')).toContainText('No runnable work');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI bubbles nested graph runtime state to the parent node', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  addNestedGraphProjectionFixture(pipelinePath);
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_nested_projection',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'running',
    reason: 'machine-ui.fixture.nested-active',
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/context',
    eventType: 'node.completed',
    payload: {
      nodeExecutionId: `${run.runId}:main/context:attempt-1`,
      nodeType: 'orpad.context',
      status: 'completed',
      attempt: 1,
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'main/discovery-stage',
    eventType: 'node.completed',
    payload: {
      nodeExecutionId: `${run.runId}:main/discovery-stage:attempt-1`,
      nodeType: 'orpad.graph',
      status: 'completed',
      attempt: 1,
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'discovery/probe-a',
    eventType: 'node.started',
    payload: {
      nodeExecutionId: `${run.runId}:discovery/probe-a:attempt-1`,
      nodeType: 'orpad.probe',
      status: 'started',
      attempt: 1,
    },
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  const parentNode = win.locator('.orch-graph-node').filter({ hasText: 'Discovery stage' });
  await expect(parentNode).toContainText('Running');
  await expect(parentNode).toHaveClass(/runtime-running/);
  await expect(win.locator('.orch-transition[data-machine-edge-state="active"]')).toHaveCount(1);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI explains blocked overlay results and incomplete evidence', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_blocked_review',
    now: new Date('2026-05-01T00:00:00.000Z'),
    patchReviewMode: 'auto-apply',
  });
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  const baseProposal = pipeline.run.machineHarness.candidateProposal;
  const blockedItem = await ingestCandidateProposal(run.runRoot, {
    ...baseProposal,
    proposalId: 'proposal-machine-ui-blocked-review',
    suggestedWorkItemId: 'machine-ui-smoke',
    title: 'Exercise Machine UI worker execution',
    fingerprint: 'machine-ui-blocked-review:src/smoke-target.md',
  }, {
    runId: run.runId,
    transitionId: 'proposal:machine-ui-blocked-review',
    now: '2026-05-01T00:00:01.000Z',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: blockedItem.item.id,
    toState: 'blocked',
    reason: 'machine-ui.fixture.blocked-patch-review',
    transitionId: 'block:machine-ui-blocked-review',
    now: '2026-05-01T00:00:02.000Z',
  });
  const afterContent = 'after from blocked worker\nwith details\n';
  await registerPatchArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: 'artifacts/patches/worker.patch.json',
    producedBy: 'test.blocked-worker-review',
    patch: {
      schemaVersion: 'orpad.patchArtifact.v1',
      createdAt: '2026-05-01T00:00:05.000Z',
      allowedFiles: ['src/smoke-target.md', 'src/main/runbooks/validator.js'],
      changes: [{
        path: 'src/smoke-target.md',
        beforeExists: true,
        afterExists: true,
        beforeSha256: sha256Text('before\n'),
        afterSha256: sha256Text(afterContent),
        beforeContent: 'before\n',
        afterContent,
      }],
      violations: [],
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId: 'machine-ui-smoke',
    reason: 'worker-result.accepted',
    artifactRefs: [
      'artifacts/adapters/worker.transcript.json',
      'artifacts/patches/worker.patch.json',
    ],
    payload: {
      claimId: 'claim-machine-ui-smoke',
      adapterCallId: 'claim-machine-ui-smoke-graph-cli',
      attemptId: 'claim-machine-ui-smoke-graph-cli-attempt-1',
      idempotencyKey: 'claim-machine-ui-smoke-graph-cli:attempt-1',
      status: 'blocked',
      toState: 'blocked',
      patchArtifact: 'artifacts/patches/worker.patch.json',
      changedFiles: ['src/smoke-target.md'],
      verification: [{
        command: process.execPath,
        args: ['--version'],
        missingExpectedChanges: ['src/main/runbooks/validator.js'],
      }],
    },
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'blocked',
    reason: 'worker-result.accepted',
    payload: {
      itemId: 'machine-ui-smoke',
      workerStatus: 'blocked',
      message: 'CLI adapter result requires review before any canonical mutation.',
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    nodePath: 'artifact-contract',
    eventType: 'node.completed',
    payload: {
      nodeExecutionId: `${run.runId}:artifact-contract:attempt-1`,
      nodeType: 'orpad.artifactContract',
      status: 'completed',
      attempt: 1,
      valid: false,
      onMissing: 'mark-partial',
      missingArtifactCount: 2,
      missingQueueCount: 1,
      inventory: { counts: { blocked: 1 } },
    },
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'waiting',
    reason: 'artifact-contract.mark-partial',
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'partial',
    reason: 'artifact-contract.mark-partial',
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('#runbooks-content')).toContainText('Waiting for decision');
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Patch ready$/ })).toHaveCount(0);
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Waiting$/ })).toHaveCount(0);
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Waiting for decision$/ })).toBeVisible();
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Review action required$/ })).toBeVisible();
  await expect(win.locator('#runbooks-content')).toContainText('1 changed file saved as blocked-work evidence; workspace files were not changed.');
  await expect(win.locator('#runbooks-content')).toContainText('Missing expected change: src/main/runbooks/validator.js.');
  await expect(win.locator('#runbooks-content')).toContainText('Evidence incomplete');
  await expect(win.locator('#runbooks-content')).toContainText('2 required evidence files missing; 1 required queue file missing');
  await expect(win.locator('#runbooks-content')).toContainText('Waiting for patch review');
  await expect(win.locator('#runbooks-content')).toContainText('No worker is running');
  await expect(win.locator('#runbooks-content')).toContainText('Review patches');
  await expect(win.locator('#fmt-modal')).toBeHidden();

  await win.locator('button[data-runbook-action="machine-open-blocked-decision"]').click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Patch Review Needed');
  await expect(win.locator('#fmt-modal-body')).toContainText('Patch review required');
  await expect(win.locator('#fmt-modal-body')).toContainText('1 changed file staged for patch review.');
  await expect(win.locator('#fmt-modal-footer')).toContainText('Review Patch');
  await expect(win.locator('#fmt-modal-footer')).toContainText('Review Evidence');
  await expect(win.locator('#fmt-modal-body')).not.toContainText('No queued work remains');
  await win.locator('#fmt-modal-footer button').filter({ hasText: 'Review Patch' }).click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Review Patch');
  await expect(win.locator('#fmt-modal-body')).toContainText('The run produced a patch');
  await expect(win.locator('#fmt-modal-body')).toContainText('Patch artifact: artifacts/patches/worker.patch.json');
  await expect(win.locator('[data-machine-patch-file][value="src/smoke-target.md"]')).toBeChecked();
  await expect(win.locator('#fmt-modal-footer')).toContainText('Continue with Prompt');
  await expect(win.locator('#fmt-modal-footer')).toContainText('Approve & Apply');
  const modalScroll = await win.locator('#fmt-modal-body').evaluate((el: HTMLElement) => ({
    overflowY: getComputedStyle(el).overflowY,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }));
  expect(modalScroll.overflowY).toBe('auto');
  expect(modalScroll.scrollHeight).toBeGreaterThan(0);
  expect(modalScroll.clientHeight).toBeGreaterThan(0);
  const patchListScroll = await win.locator('.machine-patch-change-list').evaluate((el: HTMLElement) => ({
    overflowY: getComputedStyle(el).overflowY,
  }));
  expect(patchListScroll.overflowY).toBe('auto');
  await win.locator('#fmt-modal-close').click();
  await expect(win.locator('#fmt-modal')).toBeHidden();

  await win.getByRole('button', { name: 'Review Evidence', exact: true }).click();
  await expect(win.locator('.tab-item.active')).toContainText('Run Evidence');
  await expect(win.locator('.tab-item.active')).not.toHaveClass(/modified/);
  await expect(win.locator('.cm-content')).toContainText('Patch Review');
  await expect(win.locator('.cm-content')).toContainText('Workspace changed: no, changes are staged in run evidence only');
  await expect(win.locator('.cm-content')).toContainText('Patch artifact: artifacts/patches/worker.patch.json');
  await win.locator('.cm-scroller').evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(win.locator('.cm-content')).toContainText('Patch artifact summary: 1 file change; 2 allowed files; 0 write-set violations.');
  await expect(win.locator('.cm-content')).toContainText('Review Patch opens the changed files with apply/skip controls.');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI follow-up on a stale multi-patch review advances to the next patch', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  fs.writeFileSync(path.join(workspace, 'src', 'stale-target.md'), 'current stale base\n');
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_stale_follow_up_next',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  const stalePatch = 'artifacts/patches/stale-follow-up.patch.json';
  const nextPatch = 'artifacts/patches/next-review.patch.json';
  await registerPatchArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: stalePatch,
    producedBy: 'test.stale-follow-up',
    patch: {
      schemaVersion: 'orpad.patchArtifact.v1',
      createdAt: '2026-05-01T00:00:05.000Z',
      allowedFiles: ['src/stale-target.md'],
      changes: [{
        path: 'src/stale-target.md',
        beforeExists: true,
        afterExists: true,
        beforeSha256: sha256Text('old stale base\n'),
        afterSha256: sha256Text('rebased stale result\n'),
        beforeContent: 'old stale base\n',
        afterContent: 'rebased stale result\n',
      }],
      violations: [],
    },
  });
  await registerPatchArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: nextPatch,
    producedBy: 'test.next-review',
    patch: {
      schemaVersion: 'orpad.patchArtifact.v1',
      createdAt: '2026-05-01T00:00:06.000Z',
      allowedFiles: ['src/smoke-target.md'],
      changes: [{
        path: 'src/smoke-target.md',
        beforeExists: true,
        afterExists: true,
        beforeSha256: sha256Text('before\n'),
        afterSha256: sha256Text('next review result\n'),
        beforeContent: 'before\n',
        afterContent: 'next review result\n',
      }],
      violations: [],
    },
  });
  for (const [patchArtifact, itemId, changedFile] of [
    [stalePatch, 'stale-follow-up-item', 'src/stale-target.md'],
    [nextPatch, 'next-review-item', 'src/smoke-target.md'],
  ] as const) {
    await appendMachineEvent(run.runRoot, {
      runId: run.runId,
      actor: 'machine',
      eventType: 'worker.result',
      itemId,
      reason: 'worker-result.accepted',
      artifactRefs: [patchArtifact],
      payload: {
        status: 'done',
        toState: 'done',
        patchArtifact,
        changedFiles: [changedFile],
        verification: [{ command: process.execPath, args: ['--version'] }],
      },
    });
  }
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'patch.review_required',
    reason: 'patch-review.test-fixture',
    artifactRefs: [stalePatch],
    payload: {
      patchArtifact: stalePatch,
      changedFiles: ['src/stale-target.md'],
      reason: 'stale-base-fixture',
    },
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'waiting',
    reason: 'machine-ui.fixture.waiting',
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'partial',
    reason: 'machine-ui.fixture.partial',
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('#fmt-modal')).toBeHidden();
  await win.locator('button[data-probe-action="review-patches"]').click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Rebase Required 1 of 2');
  await expect(win.locator('#fmt-modal-footer')).toContainText('Mark Follow-up & Next');
  await win.locator('#fmt-modal-footer button').filter({ hasText: 'Mark Follow-up & Next' }).click();
  await submitMachineCapabilityToken(win);
  await expect(win.locator('#fmt-modal-title')).toContainText('Review Patch 2 of 2');
  await expect(win.locator('#fmt-modal-body')).toContainText(nextPatch);
  await expect(win.locator('body')).not.toContainText('Patch contains out-of-write-set violations.');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI treats write-set violation patches as follow-up only', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_write_set_violation_follow_up',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  const unsafePatch = 'artifacts/patches/write-set-violation.patch.json';
  await registerPatchArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: unsafePatch,
    producedBy: 'test.write-set-violation',
    patch: {
      schemaVersion: 'orpad.patchArtifact.v1',
      createdAt: '2026-05-01T00:00:05.000Z',
      allowedFiles: ['src/smoke-target.md'],
      changes: [{
        path: 'src/smoke-target.md',
        beforeExists: true,
        afterExists: true,
        beforeSha256: sha256Text('before\n'),
        afterSha256: sha256Text('safe visible change\n'),
        beforeContent: 'before\n',
        afterContent: 'safe visible change\n',
      }],
      violations: [{ path: 'src/outside-write-set.md', reason: 'outside write set' }],
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId: 'unsafe-follow-up-item',
    reason: 'worker-result.accepted',
    artifactRefs: [unsafePatch],
    payload: {
      status: 'done',
      toState: 'done',
      patchArtifact: unsafePatch,
      changedFiles: ['src/smoke-target.md'],
      verification: [{ command: process.execPath, args: ['--version'] }],
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'patch.review_required',
    reason: 'patch-review.write-set-violation-fixture',
    artifactRefs: [unsafePatch],
    payload: {
      patchArtifact: unsafePatch,
      changedFiles: ['src/smoke-target.md'],
      reason: 'destructive_scope',
    },
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'waiting',
    reason: 'machine-ui.fixture.waiting',
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'partial',
    reason: 'machine-ui.fixture.partial',
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    (window as any).__orpadAlerts = [];
    window.alert = (message?: any) => {
      (window as any).__orpadAlerts.push(String(message ?? ''));
    };
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await win.locator('button[data-probe-action="review-patches"]').click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Follow-up Required');
  await expect(win.locator('#fmt-modal-body')).toContainText('write-set violation');
  await expect(win.locator('[data-machine-patch-file][value="src/smoke-target.md"]')).toBeDisabled();
  await expect(win.locator('#fmt-modal-footer')).toContainText('Start Follow-up with Prompt');
  await expect(win.locator('#fmt-modal-footer')).not.toContainText('Approve & Apply');
  await win.locator('#fmt-modal-footer button').filter({ hasText: 'Start Follow-up with Prompt' }).click();
  await submitMachineCapabilityToken(win);
  await expect(win.locator('#fmt-modal')).toBeHidden();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect.poll(async () => win.evaluate(() => (window as any).__orpadAlerts || []))
    .not.toContain('Patch contains out-of-write-set violations.');
  const events = await readMachineEvents(run.runRoot);
  const unsafePatchEvents = events.filter((event: any) => event?.payload?.patchArtifact === unsafePatch);
  expect(unsafePatchEvents.some((event: any) => event.eventType === 'patch.review_rejected')).toBe(true);
  expect(unsafePatchEvents.some((event: any) => ['patch.approved', 'patch.applied', 'patch.review_skipped'].includes(event.eventType))).toBe(false);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI play action attempts managed run and blocks non-runnable pipelines before creating runs', async () => {
  const { workspace, pipelinePath, pipelineDir } = writeMachineWorkspace();
  removeMachineHarness(pipelinePath);
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    (window as any).__orpadAlerts = [];
    window.alert = (message?: any) => {
      (window as any).__orpadAlerts.push(String(message ?? ''));
    };
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('runnable adapter');
  await expect(win.locator('button[data-pipeline-run-action="default"]')).toBeVisible();
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(win.locator('button[data-pipeline-run-action="managed"]')).toBeDisabled();
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(win.locator('button[data-pipeline-run-action="default"]')).toBeDisabled();
  await expect(win.locator('button[data-pipeline-run-action="default"]')).toHaveAttribute('title', /run\.machineHarness/);
  expect(fs.existsSync(path.join(pipelineDir, 'runs'))).toBe(false);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI implements node harness contracts for the selected pipeline', async () => {
  const { workspace, pipelinePath, pipelineDir } = writeMachineWorkspace();
  removeMachineHarness(pipelinePath);
  const staleRun = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_stale_before_harness',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  await appendMachineEvent(staleRun.runRoot, {
    runId: staleRun.runId,
    actor: 'machine',
    nodePath: 'main/probe',
    eventType: 'adapter.result',
    reason: 'proposal-only-result.failed',
    artifactRefs: ['artifacts/adapters/stale.transcript.json'],
    payload: {
      status: 'failed',
      adapter: 'codex-cli-proposal',
      adapterCallId: 'stale-harness-preflight-adapter',
      message: 'Stale run failure should not remain visible while implementing harness.',
    },
  });
  await appendRunLifecycleStatus(staleRun.runRoot, {
    runId: staleRun.runId,
    toState: 'cancelled',
    reason: 'machine-ui.fixture.stale-before-harness',
  });
  await appendRunSummaryStatus(staleRun.runRoot, {
    runId: staleRun.runId,
    summaryStatus: 'blocked',
    reason: 'machine-ui.fixture.stale-before-harness',
  });
  const labDir = path.join(workspace, 'ThreadProgramming', 'Unit3', 'Lab05_Semaphore');
  fs.mkdirSync(labDir, { recursive: true });
  fs.writeFileSync(path.join(labDir, 'Program.cs'), 'Console.WriteLine("Semaphore lab");\n');
  fs.writeFileSync(path.join(labDir, 'Lab05_Semaphore.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />\n');
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('runnable adapter');
  await expect(win.locator('#content.view-orch-graph')).toContainText('Run cancelled');
  await expect(win.locator('#content.view-orch-graph')).toContainText('Failed adapter calls (1)');
  await win.locator('[data-pipeline-run-menu]').click();
  await win.locator('button[data-pipeline-run-action="implement-harness"]').click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('Harness ready');
  await expect(win.locator('#content.view-orch-graph [data-vm-harness-dashboard]')).toContainText('VM Harness ready');
  await expect(win.locator('#content.view-orch-graph')).not.toContainText('Run cancelled');
  await expect(win.locator('#content.view-orch-graph')).not.toContainText('Failed adapter calls');
  await expect(win.locator('#runbooks-content [data-vm-harness-dashboard]')).toContainText('VM Harness ready');
  await expect(win.locator('#runbooks-content h3').filter({ hasText: 'Latest Run' })).toHaveCount(1);
  await expect(win.locator('#runbooks-content')).toContainText('Cancelled');
  const probeNode = win.locator('.orch-graph-node[data-machine-node-path="main/probe"]');
  await expect(probeNode).toContainText('Harness ready');
  await expect(probeNode).toHaveClass(/runtime-completed/);
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(win.locator('button[data-pipeline-run-action="managed"]')).toBeEnabled();

  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  expect(pipeline.run.machineAdapter.type).toBe('codex-cli');
  expect(pipeline.metadata.harnessImplementation.nodeCount).toBeGreaterThan(0);
  const statePath = path.join(pipelineDir, 'harness', 'generated', 'implementation-state.json');
  expect(fs.existsSync(statePath)).toBe(true);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  expect(state.status).toBe('succeeded');
  expect(state.nodes.every((node: any) => node.status === 'succeeded')).toBe(true);
  expect(state.projectProfile.stacks).toContain('dotnet');
  expect(state.projectProfile.requiredTools).toContain('dotnet');
  expect(state.harnessAuthoring.path).toBe('harness-authoring-spec.json');
  expect(state.harnessAuthoring.mode).toContain('deterministic');
  expect(state.provisioning.path).toBe('harness-provisioning.json');
  expect(['ready', 'degraded', 'blocked']).toContain(state.provisioning.status);
  const probeState = state.nodes.find((node: any) => node.nodePath === 'main/probe');
  expect(probeState).toBeTruthy();
  expect(fs.existsSync(path.join(pipelineDir, 'harness', 'generated', probeState.artifact))).toBe(true);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });
  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('Harness ready');
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(win.locator('button[data-pipeline-run-action="implement-harness"]')).toContainText('Refresh Harness');
  await expect(win.locator('button[data-pipeline-run-action="managed"]')).toBeEnabled();

  const profilePath = path.join(pipelineDir, 'harness', 'generated', 'project-profile.json');
  const toolPlanPath = path.join(pipelineDir, 'harness', 'generated', 'tool-plan.json');
  const harnessSpecPath = path.join(pipelineDir, 'harness', 'generated', 'harness-authoring-spec.json');
  const provisioningPath = path.join(pipelineDir, 'harness', 'generated', 'harness-provisioning.json');
  const toolHealthPath = path.join(pipelineDir, 'harness', 'generated', 'tool-health.json');
  const validationPreflightPath = path.join(pipelineDir, 'harness', 'generated', 'validation-preflight.json');
  const mcpPlanPath = path.join(pipelineDir, 'harness', 'generated', 'mcp-plan.json');
  const toolPolicyPath = path.join(pipelineDir, 'harness', 'generated', 'tool-policy.json');
  const observabilityPlanPath = path.join(pipelineDir, 'harness', 'generated', 'observability-plan.json');
  const evalPlanPath = path.join(pipelineDir, 'harness', 'generated', 'eval-plan.json');
  const feedbackLoopPlanPath = path.join(pipelineDir, 'harness', 'generated', 'feedback-loop.json');
  const llmOpsPlanPath = path.join(pipelineDir, 'harness', 'generated', 'llmops-plan.json');
  const securityRiskPlanPath = path.join(pipelineDir, 'harness', 'generated', 'security-risk-plan.json');
  expect(fs.existsSync(profilePath)).toBe(true);
  expect(fs.existsSync(toolPlanPath)).toBe(true);
  expect(fs.existsSync(harnessSpecPath)).toBe(true);
  expect(fs.existsSync(provisioningPath)).toBe(true);
  expect(fs.existsSync(toolHealthPath)).toBe(true);
  expect(fs.existsSync(validationPreflightPath)).toBe(true);
  expect(fs.existsSync(mcpPlanPath)).toBe(true);
  expect(fs.existsSync(toolPolicyPath)).toBe(true);
  expect(fs.existsSync(observabilityPlanPath)).toBe(true);
  expect(fs.existsSync(evalPlanPath)).toBe(true);
  expect(fs.existsSync(feedbackLoopPlanPath)).toBe(true);
  expect(fs.existsSync(llmOpsPlanPath)).toBe(true);
  expect(fs.existsSync(securityRiskPlanPath)).toBe(true);
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
  const harnessSpec = JSON.parse(fs.readFileSync(harnessSpecPath, 'utf-8'));
  const provisioning = JSON.parse(fs.readFileSync(provisioningPath, 'utf-8'));
  const toolPolicy = JSON.parse(fs.readFileSync(toolPolicyPath, 'utf-8'));
  const evalPlan = JSON.parse(fs.readFileSync(evalPlanPath, 'utf-8'));
  expect(profile.stacks.some((stack: any) => stack.id === 'dotnet')).toBe(true);
  expect(profile.validationCommands.some((command: string) => command.includes('dotnet build'))).toBe(true);
  expect(profile.protocolContracts.some((contract: any) => contract.id === 'worker-patch')).toBe(true);
  expect(harnessSpec.schemaVersion).toBe('orpad.harnessAuthoringSpec.v1');
  expect(harnessSpec.nodeContracts.some((contract: any) => contract.nodePath === 'main/worker')).toBe(true);
  expect(provisioning.schemaVersion).toBe('orpad.harnessProvisioning.v1');
  expect(pipeline.harness.provisioning).toBe('harness/generated/harness-provisioning.json');
  expect(pipeline.harness.toolPolicy).toBe('harness/generated/tool-policy.json');
  expect(toolPolicy.schemaVersion).toBe('orpad.toolPolicy.v1');
  expect(evalPlan.schemaVersion).toBe('orpad.evalPlan.v1');
  const probeArtifact = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'harness', 'generated', probeState.artifact), 'utf-8'));
  expect(probeArtifact.environment.stacks.some((stack: any) => stack.id === 'dotnet')).toBe(true);
  expect(probeArtifact.protocols.some((contract: any) => contract.id === 'validation-evidence')).toBe(true);
  expect(probeArtifact.harnessAuthoring.nodeContract.nodePath).toBe('main/probe');
  expect(probeArtifact.provisioning.ref).toBe('harness-provisioning.json');
  expect(probeArtifact.provisioning.toolPolicyRef).toBe('tool-policy.json');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI shows harness implementation failure details on graph nodes', async () => {
  const { workspace, pipelinePath, pipelineDir } = writeMachineWorkspace();
  removeMachineHarness(pipelinePath);
  fs.mkdirSync(path.join(pipelineDir, 'harness', 'generated'), { recursive: true });
  fs.writeFileSync(path.join(pipelineDir, 'harness', 'generated', 'nodes'), 'blocks node artifact directory\n');
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  const implementHarnessButton = win.locator('button[data-pipeline-run-action="implement-harness"]').filter({ hasText: 'Implement Harness' });
  await expect.poll(async () => implementHarnessButton.evaluateAll((buttons: HTMLButtonElement[]) =>
    buttons.some(button => !button.disabled))).toBe(true);
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(implementHarnessButton).toBeVisible();
  await expect(implementHarnessButton).toBeEnabled();
  await implementHarnessButton.click();

  const failedContextNode = win.locator('.orch-graph-node[data-machine-node-path="main/context"]');
  await expect(failedContextNode).toContainText('Harness failed');
  await expect(failedContextNode).toHaveClass(/runtime-failed/);
  await failedContextNode.click({ button: 'right' });
  await expect(win.locator('.orch-context-menu')).toContainText('Failure details');
  await win.locator('button[data-orch-context-action="failure-details"]').click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Failure Details');
  await expect(win.locator('#fmt-modal-body')).toContainText('Harness implementation failed');
  await expect(win.locator('#fmt-modal-body')).toContainText('Solution choices');
  await win.getByRole('button', { name: 'Close' }).click();

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Pipes Refresh reloads selected managed run evidence from disk', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();

  await seedActiveClaimRun(workspace, pipelinePath, {
    runId: 'run_machine_ui_refresh_claim',
  });
  await win.locator('button[data-runbook-action="refresh"]').click();

  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(win.locator('#runbooks-content')).not.toContainText('run_machine_ui_refresh_claim');
  await expect(win.locator('#runbooks-content')).toContainText('1 work item in progress: machine-ui-smoke');
  await expect(win.locator('#runbooks-content')).toContainText('Ready to stop: machine-ui-smoke is in progress');
  await expect(win.locator('#runbooks-content')).toContainText('No evidence files yet');
  await expect(win.locator('#runbooks-content')).not.toContainText('No artifact manifest files yet');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI caches Latest Run event projections by run event sequence', async () => {
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => (window as any).eval('typeof machineLatestRunEventProjection') === 'function');

  const result = await win.evaluate(() => (window as any).eval(`(() => {
    const runId = 'run_machine_ui_projection_cache';
    const events = [];
    let sequence = 1;
    const push = (event) => {
      events.push({ timestamp: '2026-06-04T00:00:00.000Z', sequence: sequence++, ...event });
    };
    push({ eventType: 'run.created' });
    push({ eventType: 'queue.transition', itemId: 'item-a', toState: 'queued' });
    push({ eventType: 'queue.transition', itemId: 'item-a', toState: 'done' });
    push({ eventType: 'queue.transition', itemId: 'item-b', toState: 'queued' });
    push({ eventType: 'queue.transition', itemId: 'item-c', toState: 'candidate' });
    push({ eventType: 'queue.transition', itemId: 'item-d', toState: 'blocked' });
    push({
      eventType: 'worker.result',
      itemId: 'item-a',
      artifactRefs: ['work-items/item-a/worker-evidence.json'],
      payload: { status: 'done', verification: [{ command: 'one' }], changedFiles: ['src/a.js'] },
    });
    push({
      eventType: 'worker.result',
      itemId: 'item-b',
      artifactRefs: ['work-items/item-b/worker-evidence.json', 'work-items/item-b/verification.md'],
      payload: { status: 'blocked', verification: [{ command: 'two' }, { command: 'three' }], changedFiles: ['src/b.js', 'src/c.js'] },
    });
    for (let index = 0; index < 150; index += 1) {
      push({ eventType: 'node.completed', nodePath: 'main/node-' + index, payload: { nodeType: 'orpad.probe' } });
      push({ eventType: 'scheduler.edgeEvaluation', payload: { firedCount: 1, droppedCount: 0 } });
    }

    const record = {
      runId,
      runRoot: '/tmp/run-machine-ui-projection-cache',
      runState: { runId, lifecycleStatus: 'waiting', summaryStatus: 'pending' },
      events,
    };
    const first = machineLatestRunEventProjection(record);
    const sameSequence = machineLatestRunEventProjection({ ...record, events: events.slice() });
    const replayAtPrevious = machineLatestRunEventProjection({
      ...record,
      events: events.slice(0, events.length - 1),
      __replay: { position: events.length - 1, total: events.length },
    });
    const replayAtEarlier = machineLatestRunEventProjection({
      ...record,
      events: events.slice(0, events.length - 2),
      __replay: { position: events.length - 2, total: events.length },
    });

    return {
      sameEventSequenceCached: first === sameSequence,
      replayPositionInvalidates: replayAtPrevious !== replayAtEarlier,
      queueCounts: first.queueInventory.counts,
      rejectableCount: first.rejectableItems.length,
      workerProofDetails: first.workerProofDetails,
      nodeCompletionDetails: first.nodeCompletionDetails,
      recentEventCount: first.recentEvents.length,
    };
  })()`));

  expect(result).toEqual({
    sameEventSequenceCached: true,
    replayPositionInvalidates: true,
    queueCounts: {
      candidate: 1,
      queued: 1,
      claimed: 0,
      done: 1,
      blocked: 1,
      rejected: 0,
    },
    rejectableCount: 3,
    workerProofDetails: '2 work results; 3 evidence files; 3 checks; 3 changed files',
    nodeCompletionDetails: '150 steps completed',
    recentEventCount: 100,
  });

  await app.close();
});

test('Machine UI disposes throttled progress refresh state when polling stops', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  const stopped = await win.evaluate(async ({ runbookPath }) => {
    (window as any).__orpadProgressTeardownRunbookPath = runbookPath;
    return (window as any).eval(`(async () => {
      const runbookPath = window.__orpadProgressTeardownRunbookPath;
      const runId = 'run_machine_ui_progress_stop_teardown';
      const key = machineRunActionKey(runbookPath, runId);
      let fired = false;
      selectedRunbookPath = runbookPath;
      lastMachineRunRecord = {
        runId,
        runState: { runId, lifecycleStatus: 'running', summaryStatus: 'pending' },
      };
      machineRunProgressTimers.set(key, setInterval(() => { fired = true; }, 1000));
      machineRunProgressRefreshState.set(key, {
        last: Date.now(),
        timer: setTimeout(() => { fired = true; }, 25),
      });
      stopMachineRunProgressPollingByKey(key);
      await new Promise(resolve => setTimeout(resolve, 60));
      return {
        fired,
        hasPollingTimer: machineRunProgressTimers.has(key),
        hasRefreshState: machineRunProgressRefreshState.has(key),
      };
    })()`);
  }, { runbookPath: pipelinePath });

  expect(stopped).toEqual({
    fired: false,
    hasPollingTimer: false,
    hasRefreshState: false,
  });

  const unselected = await win.evaluate(async ({ runbookPath }) => {
    (window as any).__orpadProgressTeardownRunbookPath = runbookPath;
    return (window as any).eval(`(async () => {
      const runbookPath = window.__orpadProgressTeardownRunbookPath;
      const runId = 'run_machine_ui_progress_unselected_teardown';
      const key = machineRunActionKey(runbookPath, runId);
      let fired = false;
      selectedRunbookPath = runbookPath + '.other';
      lastMachineRunRecord = {
        runId,
        runState: { runId, lifecycleStatus: 'running', summaryStatus: 'pending' },
      };
      machineRunProgressTimers.set(key, setInterval(() => { fired = true; }, 1000));
      machineRunProgressRefreshState.set(key, {
        last: Date.now(),
        timer: setTimeout(() => { fired = true; }, 25),
      });
      stopMachineRunProgressPollingForUnselectedRunbooks(selectedRunbookPath);
      await new Promise(resolve => setTimeout(resolve, 60));
      return {
        fired,
        hasPollingTimer: machineRunProgressTimers.has(key),
        hasRefreshState: machineRunProgressRefreshState.has(key),
      };
    })()`);
  }, { runbookPath: pipelinePath });

  expect(unselected).toEqual({
    fired: false,
    hasPollingTimer: false,
    hasRefreshState: false,
  });

  const terminal = await win.evaluate(async ({ runbookPath }) => {
    (window as any).__orpadProgressTeardownRunbookPath = runbookPath;
    return (window as any).eval(`(async () => {
      const runbookPath = window.__orpadProgressTeardownRunbookPath;
      const runId = 'run_machine_ui_progress_terminal_teardown';
      const key = machineRunActionKey(runbookPath, runId);
      let fired = false;
      selectedRunbookPath = runbookPath;
      lastMachineRunRecord = {
        runId,
        runState: { runId, lifecycleStatus: 'running', summaryStatus: 'pending' },
      };
      machineRunProgressTimers.set(key, setInterval(() => { fired = true; }, 1000));
      machineRunProgressRefreshState.set(key, {
        last: Date.now(),
        timer: setTimeout(() => { fired = true; }, 25),
      });
      machineUpdateRunRecord(runbookPath, {
        runId,
        runState: { runId, lifecycleStatus: 'completed', summaryStatus: 'done' },
      });
      await new Promise(resolve => setTimeout(resolve, 60));
      return {
        fired,
        hasPollingTimer: machineRunProgressTimers.has(key),
        hasRefreshState: machineRunProgressRefreshState.has(key),
      };
    })()`);
  }, { runbookPath: pipelinePath });

  expect(terminal).toEqual({
    fired: false,
    hasPollingTimer: false,
    hasRefreshState: false,
  });

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Orchestration window keeps Latest Run visible when selected pipeline has ready harness', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
  pipeline.title = 'Machine Workstream With A Deliberately Long Cockpit Telemetry Name For Responsive Runbar';
  pipeline.run.machineAdapter = {
    ...(pipeline.run.machineAdapter || {}),
    command: 'codex',
    budget: { perRunUsd: 1.25, perCallUsd: 0.10, hardStop: true },
  };
  pipeline.metadata = {
    ...(pipeline.metadata || {}),
    externalResearch: {
      limitation: 'Local-only generated run: external competitor claims require approved evidence.',
    },
  };
  fs.writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2));
  seedSucceededHarnessImplementation(pipelinePath);

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  const orchestrationWindowPromise = app.waitForEvent('window');
  await win.locator('#btn-orchestration').click();
  const orchestrationWin = await orchestrationWindowPromise;
  await orchestrationWin.waitForLoadState('domcontentloaded');
  await orchestrationWin.waitForSelector('body.orchestration-window');
  await orchestrationWin.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  await expect(orchestrationWin.locator('#toolbar [data-pipeline-select-trigger] span')).toContainText('Machine Workstream');
  await orchestrationWin.locator('#toolbar [data-pipeline-run-menu]').click();
  await orchestrationWin.locator('#toolbar button[data-pipeline-run-action="check"]').click();
  await expect(orchestrationWin.locator('[data-pipeline-preview-runbar]')).toContainText('Harness ready');
  await expect(orchestrationWin.locator('#toolbar .pipeline-runbar-status[role="status"]')).toContainText('Harness ready');
  await expect(orchestrationWin.locator('#toolbar .pipeline-runbar-status.done').filter({ hasText: 'Harness ready' })).toBeVisible();
  await expect(orchestrationWin.locator('#toolbar .pipeline-runbar-status.warn').filter({ hasText: 'External research needs approval' })).toBeVisible();
  await expect(orchestrationWin.locator('#toolbar .pipe-budget-chip')).toContainText('Budget');
  await expectToolbarRunbarTelemetryAtWidth(orchestrationWin, 900);
  await expectToolbarRunbarTelemetryAtWidth(orchestrationWin, 1200);
  await expectToolbarRunbarTelemetryAtWidth(orchestrationWin, 1440);
  await expect(orchestrationWin.locator('#runbooks-content h3').filter({ hasText: 'Latest Run' })).toHaveCount(1);
  await expect(orchestrationWin.locator('#runbooks-content h3').filter({ hasText: 'VM Harness' })).toHaveCount(1);
  const sidebarHarness = orchestrationWin.locator('#runbooks-content [data-vm-harness-dashboard]');
  await expect(sidebarHarness).toContainText('VM Harness ready');
  await expect(sidebarHarness).toContainText('Tool health');
  await expect(sidebarHarness).toContainText('Validation');
  await expect(sidebarHarness).toContainText('MCP capability');
  await expect(sidebarHarness.locator('.vm-harness-stage-rail li')).toHaveCount(5);
  await expect(sidebarHarness.locator('.vm-harness-metric')).toHaveCount(5);
  await expect(sidebarHarness.locator('button[data-probe-action="open-artifact"]')).toHaveCount(6);
  const latestRunSection = orchestrationWin.locator('#runbooks-content .runbook-panel-section', {
    has: orchestrationWin.locator('h3').filter({ hasText: /^Latest Run$/ }),
  });
  await expect(latestRunSection).not.toContainText('Harness ready');
  const graphHarness = orchestrationWin.locator('#content.view-orch-graph [data-vm-harness-dashboard]');
  await expect(graphHarness).toContainText('VM Harness ready');
  await expect(graphHarness).toContainText('5 ready / 5 total');
  await expect(graphHarness.locator('button').filter({ hasText: 'project-profile.json' })).toHaveAttribute('data-artifact-path', /project-profile\.json$/);

  await orchestrationWin.locator('#toolbar [data-pipeline-select-trigger]').click();
  await orchestrationWin.locator('#toolbar [data-orchestration-select-pipeline]')
    .filter({ has: orchestrationWin.locator('strong').filter({ hasText: /^Machine Workstream/ }) })
    .click();
  await expect(orchestrationWin.locator('#runbooks-content h3').filter({ hasText: 'Latest Run' })).toHaveCount(1);
  await expect(orchestrationWin.locator('#runbooks-content [data-vm-harness-dashboard]')).toContainText('VM Harness ready');
  await expect(latestRunSection).not.toContainText('Harness ready');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Orchestration window keeps Latest Run above active harness status', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  seedRunningHarnessImplementation(pipelinePath);

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  const orchestrationWindowPromise = app.waitForEvent('window');
  await win.locator('#btn-orchestration').click();
  const orchestrationWin = await orchestrationWindowPromise;
  await orchestrationWin.waitForLoadState('domcontentloaded');
  await orchestrationWin.waitForSelector('body.orchestration-window');
  await orchestrationWin.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  await orchestrationWin.locator('#toolbar [data-pipeline-run-menu]').click();
  await orchestrationWin.locator('#toolbar button[data-pipeline-run-action="check"]').click();
  await expect(orchestrationWin.locator('[data-pipeline-preview-runbar]')).toContainText('Implementing harness');
  const toolbarRunbar = orchestrationWin.locator('#toolbar [data-pipeline-preview-runbar]');
  await expect(toolbarRunbar.locator('.pipeline-runbar-status[role="status"]')).toContainText('Implementing harness');
  await expect(toolbarRunbar.locator('.pipeline-runbar-status.warn:not([role="status"])').filter({ hasText: 'Implementing harness' })).toBeVisible();
  await expectToolbarRunbarTelemetryAtWidth(orchestrationWin, 1200);
  await expect(orchestrationWin.locator('#runbooks-content h3').filter({ hasText: 'Latest Run' })).toHaveCount(1);
  await expect(orchestrationWin.locator('#runbooks-content h3').filter({ hasText: 'VM Harness' })).toHaveCount(1);
  const latestRunSection = orchestrationWin.locator('#runbooks-content .runbook-panel-section', {
    has: orchestrationWin.locator('h3').filter({ hasText: /^Latest Run$/ }),
  });
  await expect(latestRunSection).not.toContainText('Implementing harness');
  await expect(latestRunSection).not.toContainText('Harness ready');
  const sidebarHarness = orchestrationWin.locator('#runbooks-content [data-vm-harness-dashboard]');
  await expect(sidebarHarness).toContainText('Node contracts');
  await expect(sidebarHarness).toContainText('1/3 ready');
  await expect(sidebarHarness).toContainText('Degraded');
  await expect(sidebarHarness).toContainText('Playwright browser cache was not verified');
  await expect(sidebarHarness.locator('.vm-harness-stage-rail li.current')).toContainText('Contracts');
  await expect(orchestrationWin.locator('#content.view-orch-graph [data-vm-harness-dashboard]')).toContainText('Validation');

  const sectionOrder = await orchestrationWin.locator('#runbooks-content h3').evaluateAll((headers) =>
    headers.map((header) => header.textContent?.trim() || ''),
  );
  expect(sectionOrder.indexOf('Latest Run')).toBeGreaterThanOrEqual(0);
  expect(sectionOrder.indexOf('VM Harness')).toBeGreaterThanOrEqual(0);
  expect(sectionOrder.indexOf('Latest Run')).toBeLessThan(sectionOrder.indexOf('VM Harness'));

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Orchestration window renders blocked VM Harness readiness with artifact links', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  seedBlockedHarnessImplementation(pipelinePath);

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  const orchestrationWindowPromise = app.waitForEvent('window');
  await win.locator('#btn-orchestration').click();
  const orchestrationWin = await orchestrationWindowPromise;
  await orchestrationWin.waitForLoadState('domcontentloaded');
  await orchestrationWin.waitForSelector('body.orchestration-window');
  await orchestrationWin.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  await orchestrationWin.locator('#toolbar [data-pipeline-run-menu]').click();
  await orchestrationWin.locator('#toolbar button[data-pipeline-run-action="check"]').click();
  await expect(orchestrationWin.locator('[data-pipeline-preview-runbar]')).toContainText('Harness blocked');
  await expect(orchestrationWin.locator('#runbooks-content h3').filter({ hasText: 'Latest Run' })).toHaveCount(1);
  const sidebarHarness = orchestrationWin.locator('#runbooks-content [data-vm-harness-dashboard]');
  await expect(sidebarHarness).toContainText('VM Harness blocked');
  await expect(sidebarHarness).toContainText('Node executable missing from PATH');
  await expect(sidebarHarness).toContainText('Tool health');
  await expect(sidebarHarness).toContainText('Validation');
  await expect(sidebarHarness).toContainText('1 blocked');
  await expect(sidebarHarness.locator('.vm-harness-state-chip--danger')).toContainText('Blocked');
  await expect(sidebarHarness.locator('.vm-harness-stage-rail li.danger')).toContainText('Provision');

  const graphHarness = orchestrationWin.locator('#content.view-orch-graph [data-vm-harness-dashboard]');
  await expect(graphHarness).toContainText('Resolve: Node executable missing from PATH');
  for (const artifactName of [
    'implementation-state.json',
    'project-profile.json',
    'tool-health.json',
    'validation-preflight.json',
    'mcp-plan.json',
    'README.md',
  ]) {
    await expect(graphHarness.locator('button[data-probe-action="open-artifact"]').filter({ hasText: artifactName }))
      .toHaveAttribute('data-artifact-path', new RegExp(artifactName.replace('.', '\\.') + '$'));
  }

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI keeps gated managed run actions in the pipeline preview', async () => {
  const { workspace } = writeMachineWorkspace();
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '0',
    ORPAD_MACHINE_IPC_TOKEN: '',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await expect(win.locator('#runbooks-content')).not.toContainText('Machine Runtime');
  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('button[data-runbook-action="toggle-machine-ui"]')).toHaveCount(0);
  await expect(win.locator('button[data-runbook-action="run-machine"]')).toHaveCount(0);
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('Approve this session to start.');
  await expect(win.locator('[data-pipeline-preview-runbar]')).not.toContainText('main.or-graph');
  await win.waitForTimeout(250);
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(win.locator('button[data-pipeline-run-action="local"]')).toBeDisabled();
  const managedRun = win.locator('button[data-pipeline-run-action="managed"]');
  await expect(managedRun).toBeEnabled();
  await win.evaluate(() => {
    (window as any).__orpadAlerts = [];
    (window as any).__orpadConfirms = [];
    window.alert = (message?: any) => {
      (window as any).__orpadAlerts.push(String(message ?? ''));
    };
    window.confirm = (message?: any) => {
      (window as any).__orpadConfirms.push(String(message ?? ''));
      return true;
    };
  });
  await managedRun.click();
  await expect.poll(() => win.evaluate(() => ((window as any).__orpadConfirms || []).join('\n'))).toContain('Allow OrPAD to start runs');
  await confirmRunProviderSelection(win);
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(win.locator('#runbooks-content')).toContainText('Run started');
  await expect(win.locator('#runbooks-content')).toContainText('Work completed');
  await expect.poll(() => win.evaluate(() => ((window as any).__orpadAlerts || []).join('\n'))).toBe('');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI enabling IPC loads pending patch runs without auto-opening review modals', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const run = await createMachineRun({
    workspaceRoot: workspace,
    pipelinePath,
    runId: 'run_machine_ui_enable_pending_patch',
    now: new Date('2026-05-01T00:00:00.000Z'),
  });
  const afterContent = 'after from enable pending patch\n';
  await registerPatchArtifact(run.runRoot, {
    runId: run.runId,
    artifactPath: 'artifacts/patches/enable-pending.patch.json',
    producedBy: 'test.enable-machine-pending-patch',
    patch: {
      schemaVersion: 'orpad.patchArtifact.v1',
      createdAt: '2026-05-01T00:00:05.000Z',
      allowedFiles: ['src/smoke-target.md'],
      changes: [{
        path: 'src/smoke-target.md',
        beforeExists: true,
        afterExists: true,
        beforeSha256: sha256Text('before\n'),
        afterSha256: sha256Text(afterContent),
        beforeContent: 'before\n',
        afterContent,
      }],
      violations: [],
    },
  });
  await appendMachineEvent(run.runRoot, {
    runId: run.runId,
    actor: 'machine',
    eventType: 'worker.result',
    itemId: 'machine-ui-smoke',
    reason: 'worker-result.accepted',
    artifactRefs: ['artifacts/patches/enable-pending.patch.json'],
    payload: {
      status: 'blocked',
      toState: 'blocked',
      patchArtifact: 'artifacts/patches/enable-pending.patch.json',
      changedFiles: ['src/smoke-target.md'],
      verification: [{ command: process.execPath, args: ['--version'] }],
    },
  });
  await appendRunLifecycleStatus(run.runRoot, {
    runId: run.runId,
    toState: 'waiting',
    reason: 'machine-ui.fixture.waiting',
  });
  await appendRunSummaryStatus(run.runRoot, {
    runId: run.runId,
    summaryStatus: 'partial',
    reason: 'machine-ui.fixture.partial',
  });

  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '0',
    ORPAD_MACHINE_IPC_TOKEN: '',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    (window as any).__orpadConfirms = [];
    window.confirm = (message?: any) => {
      (window as any).__orpadConfirms.push(String(message ?? ''));
      return true;
    };
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('button[data-runbook-action="enable-machine"]')).toBeVisible();
  await win.locator('button[data-runbook-action="enable-machine"]').click();
  await expect.poll(() => win.evaluate(() => ((window as any).__orpadConfirms || []).join('\n'))).toContain('Allow OrPAD to start runs');
  await expect(win.locator('#fmt-modal')).toBeHidden();
  await expect(win.locator('#runbooks-content')).toContainText('Latest Run');
  await expect(win.locator('#runbooks-content')).toContainText('Waiting for patch review');
  await expect(win.locator('#runbooks-content')).toContainText('No worker is running');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI renders pending approval state from a dispatcher pause', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  requireMachineApproval(pipelinePath);
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await enableMachineUi(win);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await win.locator('[data-pipeline-run-menu]').click();
  await win.locator('button[data-pipeline-run-action="managed-ask"]').click();
  await submitMachineCapabilityToken(win);
  await confirmRunProviderSelection(win);
  await expect(win.locator('#fmt-modal')).toBeVisible();
  await expect(win.locator('#fmt-modal-title')).toContainText('Run Approval Required');
  await win.getByRole('button', { name: 'Later' }).click();
  await expect(win.locator('#fmt-modal')).toBeHidden();

  await expect(win.locator('#runbooks-content')).toContainText('Permission requested');
  await expect(win.locator('#runbooks-content')).toContainText('Permission');
  await expect(win.locator('#runbooks-content')).toContainText('1 permission request waiting: machine-ui-smoke');
  await expect(win.locator('#runbooks-content')).toContainText('Recovery blocked: decide 1 permission request first');
  await expect(win.locator('#runbooks-content')).not.toContainText('Approval');
  await expect(win.locator('#runbooks-content')).toContainText('No work to stop');
  await expect(win.locator('#runbooks-content')).not.toContainText('No active claim to cancel');
  await expect(win.locator('#runbooks-content')).toContainText('No work result yet');
  await expect(win.locator('#runbooks-content')).not.toContainText('No artifact manifest files yet');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-export"]')).toBeEnabled();
  const approveButton = win.locator('#runbooks-content button[data-runbook-action="machine-approve-approval"]');
  const denyButton = win.locator('#runbooks-content button[data-runbook-action="machine-deny-approval"]');
  await expect(approveButton).toHaveText('Allow');
  await expect(denyButton).toHaveText('Decline');

  await approveButton.click();
  await expect(win.locator('#runbooks-content')).toContainText('Permission allowed');
  await expect(win.locator('#runbooks-content')).toContainText('1 permission decision: allowed');
  await expect(win.locator('#runbooks-content')).toContainText('Recovery ready');
  await expect(win.locator('#runbooks-content')).not.toContainText('Resume ready');
  await expect(win.locator('#runbooks-content')).not.toContainText('derived queue snapshots');
  await expect(win.locator('#runbooks-content')).not.toContainText('stale claims');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeEnabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeEnabled();

  if (await win.locator('#fmt-modal').isVisible().catch(() => false)) {
    const modalTitle = await win.locator('#fmt-modal-title').textContent();
    if (/Review Patch/.test(modalTitle || '')) {
      await skipPatchModalIfVisible(win);
    } else {
      await expect(win.locator('#fmt-modal-title')).toContainText('Run Blocked');
      await win.getByRole('button', { name: 'Continue Queue' }).click();
      await expect(win.locator('#fmt-modal')).not.toHaveClass(/busy|locked/);
      if (await win.locator('#fmt-modal').isVisible().catch(() => false)) {
        const nextTitle = await win.locator('#fmt-modal-title').textContent();
        if (/Review Patch/.test(nextTitle || '')) {
          await skipPatchModalIfVisible(win);
        } else {
          await win.locator('#fmt-modal-footer').getByRole('button', { name: /^(Decide Later|Close)$/ }).click();
          await expect(win.locator('#fmt-modal')).toBeHidden();
        }
      }
    }
  } else {
    await win.locator('#runbooks-content button[data-runbook-action="machine-execute-step"]').click();
  }
  await expect(win.locator('#runbooks-content')).toContainText('1 work item found');
  await expect(win.locator('#runbooks-content')).toContainText('Work result');
  await expect(win.locator('#runbooks-content')).toContainText('done');
  await expect(win.locator('#runbooks-content')).toContainText('Recovery unavailable: completed/done is finished');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeDisabled();

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI default run auto-drives approval gated work to patch review', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  requireMachineApproval(pipelinePath);
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await enableMachineUi(win);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await startManagedRunFromPreview(win);
  await submitMachineCapabilityToken(win);
  await confirmRunProviderSelection(win);

  await expect(win.locator('#runbooks-content')).toContainText('Permission allowed');
  await expect(win.locator('#runbooks-content')).not.toContainText('permission request waiting');
  await expect(win.locator('#runbooks-content')).toContainText('Work result');
  await expect(win.locator('#runbooks-content')).toContainText('done');
  await expect(win.locator('#fmt-modal-title')).toContainText('Review Patch');
  expect(fs.readFileSync(path.join(workspace, 'src', 'smoke-target.md'), 'utf-8')).toBe('before\n');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI switches between durable run history snapshots', async () => {
  const { workspace, pipelineDir } = writeMachineWorkspace();
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await enableMachineUi(win);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await startManagedRunFromPreview(win);
  await submitMachineCapabilityToken(win);
  await confirmRunProviderSelection(win);
  const runRoot = path.join(pipelineDir, 'runs');
  await expect.poll(() => fs.existsSync(runRoot) ? fs.readdirSync(runRoot).length : 0).toBe(1);
  const firstRunId = fs.readdirSync(runRoot)[0];

  await expect(win.locator('#runbooks-content')).toContainText('Work completed');
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 evidence files; 1 check; 1 changed file');
  await skipPatchModalIfVisible(win);

  await startManagedRunFromPreview(win);
  await confirmRunProviderSelection(win);
  await expect.poll(() => fs.existsSync(runRoot) ? fs.readdirSync(runRoot).length : 0).toBe(2);
  const runIds = fs.readdirSync(runRoot);
  const secondRunId = runIds.find(runId => runId !== firstRunId) || '';
  await expect(win.locator('#runbooks-content')).toContainText('History');
  await expect(win.locator('#runbooks-content')).toContainText('2 entries');
  await expect(win.locator('#runbooks-content')).toContainText('Work completed');
  await skipPatchModalIfVisible(win);

  const activeRunButton = win.locator('button[data-runbook-action="machine-select-run"].primary');
  await expect(activeRunButton).toBeVisible();
  const activeRunId = await activeRunButton.getAttribute('data-run-id') || secondRunId;
  const historyRunId = runIds.find(runId => runId !== activeRunId) || firstRunId;
  await win.locator(`button[data-runbook-action="machine-select-run"][data-run-id="${historyRunId}"]`).click();
  await expect(win.locator(`button[data-runbook-action="machine-select-run"][data-run-id="${historyRunId}"]`)).toHaveClass(/history-inspected/);
  await expect(win.locator('#runbooks-content')).not.toContainText(historyRunId);
  await expect(win.locator('#runbooks-content')).toContainText('Work completed');
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 evidence files; 1 check; 1 changed file');

  await win.locator(`button[data-runbook-action="machine-select-run"][data-run-id="${activeRunId}"]`).click();
  await expect(win.locator(`button[data-runbook-action="machine-select-run"][data-run-id="${activeRunId}"]`)).toHaveClass(/primary/);
  await expect(win.locator('#runbooks-content')).not.toContainText(activeRunId);
  await expect(win.locator('#runbooks-content')).toContainText('done; 2 evidence files; 1 check; 1 changed file');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI cancels work in progress and releases visible locks', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const seeded = await seedActiveClaimRun(workspace, pipelinePath);
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await enableMachineUi(win);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('#runbooks-content')).not.toContainText(seeded.runId);
  await expect(win.locator('#runbooks-content')).toContainText('1 work item in progress: machine-ui-smoke');
  await expect(win.locator('#runbooks-content')).toContainText('1 reserved file: src/smoke-target.md');
  await expect(win.locator('#runbooks-content')).toContainText('Recovery paused: OrPAD is already working on this run');
  await expect(win.locator('#runbooks-content')).toContainText('Ready to stop: machine-ui-smoke is in progress');
  await expect(win.locator('#runbooks-content')).toContainText('Stop work');
  await expect(win.locator('#runbooks-content')).not.toContainText('Cancellation');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toHaveCount(0);
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeDisabled();
  const primaryRunButton = win.locator('[data-pipeline-preview-runbar] button.pipeline-run-primary');
  await expect(primaryRunButton).toBeEnabled();
  await expect(primaryRunButton).toHaveAttribute('data-pipeline-run-action', 'machine-cancel-run');
  await expect(primaryRunButton).toHaveAttribute('aria-label', 'Stop Run');

  // Stopping an in-flight run now requires confirming the destructive action.
  win.once('dialog', (dialog: any) => dialog.accept());
  await primaryRunButton.click();
  await submitMachineCapabilityToken(win);
  await expect(win.locator('#runbooks-content')).toContainText('Stopped: machine-ui-smoke; work reservation released');
  await expect(win.locator('#runbooks-content')).toContainText('No work in progress');
  await expect(win.locator('#runbooks-content')).toContainText('No reserved files');
  await expect(win.locator('#runbooks-content')).toContainText('Cancelled');
  await expect(win.locator('#runbooks-content')).toContainText('stopped');
  await expect(win.locator('button[data-runbook-action="machine-cancel-claim"]')).toHaveCount(0);
  expect(JSON.parse(fs.readFileSync(path.join(seeded.runRoot, 'queue', 'blocked', `${seeded.itemId}.json`), 'utf-8')).state).toBe('blocked');
  expect(JSON.parse(fs.readFileSync(path.join(seeded.runRoot, 'locks', 'claims', `${seeded.claimId}.json`), 'utf-8')).state).toBe('cancelled');
  expect(JSON.parse(fs.readFileSync(path.join(seeded.runRoot, 'locks', 'write-sets', `wset-${seeded.claimId}.json`), 'utf-8')).state).toBe('cancelled');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI recovers interrupted work and reports work state repair', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  const seeded = await seedStaleClaimRun(workspace, pipelinePath);
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await enableMachineUi(win);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await expect(win.locator('#runbooks-content')).not.toContainText(seeded.runId);
  await expect(win.locator('#runbooks-content')).toContainText('1 work item in progress: machine-ui-smoke');
  await expect(win.locator('#runbooks-content')).toContainText('Recovery ready: 1 interrupted work item can be recovered before continuing');
  await expect(win.locator('#runbooks-content')).not.toContainText(/\bResume\b/);
  await expect(win.locator('#runbooks-content')).not.toContainText('derived queue snapshots');
  await expect(win.locator('#runbooks-content')).not.toContainText('stale claims');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeEnabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toHaveText('Recover');
  await expect(win.locator('button[data-runbook-action="machine-cancel-claim"]')).toBeEnabled();

  await win.locator('button[data-runbook-action="machine-resume-run"]').click();
  await submitMachineCapabilityToken(win);
  await expect(win.locator('#runbooks-content')).toContainText('Last recovery: 1 work state repair; 1 interrupted work item recovered; 1 queued');
  await expect(win.locator('#runbooks-content')).toContainText('No work in progress');
  await expect(win.locator('#runbooks-content')).toContainText('No reserved files');
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Waiting$/ })).toHaveCount(0);
  await expect(win.locator('.runbook-chip').filter({ hasText: /^Queue waiting$/ })).toBeVisible();
  await expect(win.locator('#runbooks-content')).toContainText('Partial proof');
  await expect(win.locator('button[data-runbook-action="machine-cancel-claim"]')).toHaveCount(0);
  expect(JSON.parse(fs.readFileSync(path.join(seeded.runRoot, 'queue', 'queued', `${seeded.itemId}.json`), 'utf-8')).state).toBe('queued');
  expect(JSON.parse(fs.readFileSync(path.join(seeded.runRoot, 'locks', 'claims', `${seeded.claimId}.json`), 'utf-8')).state).toBe('expired');
  expect(JSON.parse(fs.readFileSync(path.join(seeded.runRoot, 'locks', 'write-sets', `wset-${seeded.claimId}.json`), 'utf-8')).state).toBe('expired');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI keeps denied approval runs terminal', async () => {
  const { workspace, pipelinePath } = writeMachineWorkspace();
  requireMachineApproval(pipelinePath);
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await enableMachineUi(win);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await win.locator('[data-pipeline-run-menu]').click();
  await win.locator('button[data-pipeline-run-action="managed-ask"]').click();
  await submitMachineCapabilityToken(win);
  await confirmRunProviderSelection(win);
  await expect(win.locator('#fmt-modal')).toBeVisible();
  await expect(win.locator('#fmt-modal-title')).toContainText('Run Approval Required');
  await win.locator('#fmt-modal-footer').getByRole('button', { name: 'Decline' }).click();
  await expect(win.locator('#fmt-modal')).toBeHidden();

  await expect(win.locator('#runbooks-content')).toContainText('Permission declined');
  await expect(win.locator('#runbooks-content')).toContainText('1 permission decision: declined');
  await expect(win.locator('#runbooks-content')).toContainText('Cancelled');
  await expect(win.locator('button[data-runbook-action="machine-execute-step"]')).toBeDisabled();
  await expect(win.locator('button[data-runbook-action="machine-resume-run"]')).toBeDisabled();

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('Machine UI renders failure evidence from a failed runtime node', async () => {
  const { workspace, pipelineDir } = writeMachineWorkspace();
  appendFailingArtifactContract(pipelineDir);
  const app = await launchElectron([], {
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'test-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await enableMachineUi(win);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'Machine Workstream' }).click();
  await startManagedRunFromPreview(win);
  await submitMachineCapabilityToken(win);
  await confirmRunProviderSelection(win);

  await expect(win.locator('#runbooks-content')).toContainText('MACHINE_ARTIFACT_CONTRACT_MISSING');
  await expect(win.locator('#runbooks-content')).toContainText('Required evidence missing: 1 evidence file');
  await expect(win.locator('#runbooks-content')).toContainText('main/artifact');
  await expect(win.locator('#runbooks-content')).toContainText('Step failed');
  const failedNode = win.locator('.orch-graph-node[data-machine-node-path="main/artifact"]');
  await expect(failedNode).toContainText('Failed');
  await failedNode.click({ button: 'right' });
  await expect(win.locator('.orch-context-menu')).toContainText('Failure details');
  await expect(win.locator('.orch-context-menu')).toContainText('Choose node model');
  await expect(win.locator('.orch-context-menu')).toContainText('Improve node prompt');
  await win.locator('button[data-orch-context-action="failure-details"]').click();
  await expect(win.locator('#fmt-modal-title')).toContainText('Failure Details');
  await expect(win.locator('#fmt-modal-body')).toContainText('Failure reason');
  await expect(win.locator('#fmt-modal-body')).toContainText('Solution choices');
  await expect(win.locator('#fmt-modal-body')).toContainText('Choose a stronger or different model');
  await win.getByRole('button', { name: 'Close' }).click();

  const runRoot = path.join(pipelineDir, 'runs');
  const runDirs = fs.readdirSync(runRoot);
  expect(fs.readFileSync(path.join(runRoot, runDirs[0], 'events.jsonl'), 'utf-8')).toContain('node.failed');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});
