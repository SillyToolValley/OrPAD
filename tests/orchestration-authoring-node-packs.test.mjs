import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createOrchestrationPipeline } = require(path.join(repoRoot, 'src/main/orchestration-authoring/generator.js'));
const {
  authoringAgentPrompt,
  generateNodePackOptionsForRequest,
  registerOrchestrationAuthoringHandlers,
  withTrustedNodePackAuthoringOptions,
} = require(path.join(repoRoot, 'src/main/orchestration-authoring/ipc.js'));
const { selectAuthoringNodePacks } = require(path.join(repoRoot, 'src/main/orchestration-machine/node-packs.js'));

function nodePackRefs(node) {
  const config = node?.config || {};
  return [
    config.sourceNodePack,
    ...(Array.isArray(config.supportingNodePacks) ? config.supportingNodePacks : []),
  ].map(item => String(item || '').trim()).filter(Boolean);
}

function assertGraphNodePackRefsDeclared(pipeline, graph) {
  const declared = new Set(pipeline.nodePacks.map(pack => pack.id));
  const auditedTypes = new Set(['orpad.context', 'orpad.probe', 'orpad.gate', 'orpad.workerLoop', 'orpad.artifactContract']);
  for (const node of graph.graph.nodes.filter(item => auditedTypes.has(item.type))) {
    for (const ref of nodePackRefs(node)) {
      assert.equal(declared.has(ref), true, `${node.id} references undeclared node pack ${ref}`);
    }
  }
}

function assertQualityAuditKeptNodePackPool(result) {
  assert.equal(result.qualityAudit.ok, true);
  assert.equal(
    result.qualityAudit.diagnostics.some(item => item.code === 'AUTHORING_VALIDATION_FAILED'),
    false,
    'generation-time quality audit should validate against the selected node pack pool',
  );
}

async function seedElectronWorkspace(workspace) {
  await fs.mkdir(path.join(workspace, 'src/main'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'src/renderer'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'tests/e2e'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'README.md'), '# Electron pack fixture\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'SECURITY.md'), '# Security policy\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'electron-builder.yml'), 'appId: dev.orpad.fixture\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { 'build:renderer': 'node scripts/build-renderer.js' } }, null, 2), 'utf-8');
  await fs.writeFile(path.join(workspace, 'src/main/main.js'), 'module.exports = {};\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'src/main/preload.js'), 'module.exports = {};\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'src/renderer/renderer.js'), 'console.log("fixture");\n', 'utf-8');
}

function userReportNodePack(overrides = {}) {
  return {
    kind: 'orpad.nodePack',
    schemaVersion: '1.0',
    id: 'community.report-workstream',
    name: 'Community Report Workstream',
    version: '0.1.0',
    origin: 'user',
    trustLevel: 'signed',
    mutable: true,
    description: 'User-installed reusable workflow for report implementation work.',
    author: {
      name: 'Report Pack Author',
      github: 'https://github.com/example',
      repository: 'https://github.com/example/orpad-report-workstream',
    },
    license: 'MIT',
    compatibility: {
      orpad: '>=1.0.0-beta.3',
      packFormat: 'orpad.nodePack.v1',
    },
    installPolicy: {
      allowLifecycleScripts: false,
      allowExecutableHandlers: false,
    },
    capabilities: ['read.workspace'],
    nodes: [],
    graphs: [{
      id: 'report-workstream',
      path: 'graphs/report-workstream.or-graph',
      label: 'Report Workstream',
      role: 'reusable',
    }],
    skills: [{
      id: 'report-authoring',
      path: 'skills/report-authoring.md',
      description: 'Guides report workflow increments.',
    }],
    rules: [{
      id: 'report-scope',
      path: 'rules/report-scope.or-rule',
      description: 'Scopes report workflow files.',
    }],
    authoringHints: {
      situational: true,
      priority: 99,
      keywords: ['custom report', 'report workflow'],
      workspaceSignals: ['reports/'],
      selectionReason: 'The request targets the user-installed report workflow pack.',
      context: {
        id: 'map-report-workflow',
        label: 'Map report workflow',
        summary: 'Inspect report workflow files before queuing work.',
      },
      probe: {
        id: 'probe-report-workflow',
        label: 'Probe report workflow candidates',
        lens: 'report-workflow',
        maxCandidates: 5,
      },
      workerLabel: 'Implement report workflow item',
      verifyCriteria: ['report workflow behavior is covered by targeted evidence'],
      rule: {
        include: ['reports/**'],
        exclude: ['.env'],
      },
      skill: {
        acceptanceCriteria: ['report workflow work items include predictable targetFiles'],
      },
    },
    ...overrides,
  };
}

async function writeUserReportNodePackManifest(userNodePacksRoot, manifestOverrides = {}, folderName = 'report-workstream') {
  const packDir = path.join(userNodePacksRoot, folderName);
  const manifestPath = path.join(packDir, 'orpad.node-pack.json');
  await fs.mkdir(packDir, { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(userReportNodePack(manifestOverrides), null, 2), 'utf-8');
  return { packDir, manifestPath };
}

function fakeNodePackApp(userDataDir) {
  return {
    getAppPath: () => repoRoot,
    getPath: (name) => (name === 'userData' ? userDataDir : ''),
  };
}

function registerFakeAuthoringHandlers(app) {
  const handlers = new Map();
  registerOrchestrationAuthoringHandlers({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    app,
    authority: {
      async assertWorkspacePath(_sender, value) {
        return path.resolve(String(value || ''));
      },
    },
  });
  return handlers;
}

test('generated Electron security release pipeline selects and uses situation node packs', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-node-pack-generate-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await seedElectronWorkspace(workspace);

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Review Electron preload IPC security before release and verify renderer packaging risks.',
    timestamp: '2026-05-19T01:00:00.000Z',
    workspaceSnapshot: {
      files: [
        'README.md',
        'SECURITY.md',
        'electron-builder.yml',
        'package.json',
        'src/main/main.js',
        'src/main/preload.js',
        'src/renderer/renderer.js',
        'tests/e2e/app-launch.spec.ts',
      ],
    },
  });

  assertQualityAuditKeptNodePackPool(result);
  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const prompt = await fs.readFile(result.promptPath, 'utf-8');
  const skill = await fs.readFile(result.skillPath, 'utf-8');
  const rule = JSON.parse(await fs.readFile(result.contextRulePath, 'utf-8'));

  const nodePackIds = pipeline.nodePacks.map(pack => pack.id);
  for (const expected of [
    'orpad.starter.electron-maintenance',
    'orpad.starter.security-review',
    'orpad.starter.release-readiness',
  ]) {
    assert.equal(nodePackIds.includes(expected), true, `${expected} should be declared in pipeline.nodePacks`);
  }

  const selectionIds = pipeline.metadata.orchestrationAuthoring.nodePackSelection.map(pack => pack.id);
  assert.deepEqual(selectionIds.slice(0, 3), nodePackIds.filter(id => id.startsWith('orpad.starter.')));
  assert.equal(prompt.includes('Situation Node Pack Catalog'), true);
  assert.equal(prompt.includes('orpad.starter.electron-maintenance'), true);
  assert.equal(prompt.includes('security-review-workstream'), true);
  assert.equal(prompt.includes('release-readiness-workstream'), true);

  const contextNode = graph.graph.nodes.find(node => node.type === 'orpad.context');
  const probeNode = graph.graph.nodes.find(node => node.type === 'orpad.probe');
  const workerNode = graph.graph.nodes.find(node => node.type === 'orpad.workerLoop');
  const gateNode = graph.graph.nodes.find(node => node.id === 'verification-gate');
  assert.equal(contextNode.config.sourceNodePack, 'orpad.starter.electron-maintenance');
  assert.deepEqual(contextNode.config.supportingNodePacks, selectionIds);
  assert.equal(probeNode.config.lens, 'electron-maintenance');
  assert.equal(probeNode.config.sourceNodePackGraph, 'electron-maintenance-workstream');
  assert.deepEqual(probeNode.config.supportingNodePacks, selectionIds);
  assert.equal(workerNode.config.supportingNodePacks.includes('orpad.starter.security-review'), true);
  assert.equal(workerNode.config.supportingNodePacks.includes('orpad.starter.release-readiness'), true);
  assert.equal(gateNode.config.sourceNodePack, 'orpad.starter.electron-maintenance');
  assert.deepEqual(gateNode.config.supportingNodePacks, selectionIds);
  assert.equal(gateNode.config.criteria.some(item => /Electron main\/preload\/renderer/.test(item)), true);
  assertGraphNodePackRefsDeclared(pipeline, graph);

  assert.equal(rule.include.includes('src/main/**'), true);
  assert.equal(rule.include.includes('electron-builder.yml'), true);
  assert.match(skill, /IPC and preload changes preserve least-authority boundaries/);
});

test('generated authoring prompt uses the frozen selected node pack catalog', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-node-pack-frozen-prompt-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await seedElectronWorkspace(workspace);

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Review Electron preload IPC security before release and verify renderer packaging risks.',
    timestamp: '2026-05-19T01:05:00.000Z',
    maxAuthoringNodePacks: 1,
    requiredNodePackIds: ['orpad.starter.content-qa'],
    workspaceSnapshot: {
      files: [
        'README.md',
        'SECURITY.md',
        'electron-builder.yml',
        'package.json',
        'src/main/main.js',
        'src/main/preload.js',
        'src/renderer/renderer.js',
        'tests/e2e/app-launch.spec.ts',
      ],
    },
  });

  assert.equal(result.qualityAudit.ok, true);
  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  const prompt = await fs.readFile(result.promptPath, 'utf-8');

  const selectedIds = pipeline.metadata.orchestrationAuthoring.nodePackSelection.map(pack => pack.id);
  const declaredStarterIds = pipeline.nodePacks
    .map(pack => pack.id)
    .filter(id => id.startsWith('orpad.starter.'));

  assert.deepEqual(declaredStarterIds, selectedIds);
  assert.equal(selectedIds.includes('orpad.starter.content-qa'), true);
  assert.match(prompt, /Use this frozen node pack selection/);
  assert.equal(prompt.includes(`Selected pack ids: ${selectedIds.map(id => `\`${id}\``).join(', ')}`), true);
  for (const id of selectedIds) assert.equal(prompt.includes(id), true, `${id} should be present in the prompt catalog`);
  for (const id of ['orpad.starter.security-review', 'orpad.starter.release-readiness'].filter(id => !selectedIds.includes(id))) {
    assert.equal(prompt.includes(id), false, `${id} should not leak from default prompt re-selection`);
  }
});

test('generated pipeline declares a validated user-installed authoring pack from the supplied pool', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-user-node-pack-generate-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, 'reports'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'README.md'), '# Report workflow fixture\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }, null, 2), 'utf-8');
  await fs.writeFile(path.join(workspace, 'reports/monthly-report.js'), 'module.exports = {};\n', 'utf-8');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Build the custom report workflow with reusable report pack guidance.',
    timestamp: '2026-05-19T01:06:00.000Z',
    nodePackPool: [userReportNodePack()],
    nodePackTrustEvidenceByPack: {
      'community.report-workstream': { signature: { verified: true } },
    },
    workspaceSnapshot: {
      files: [
        'README.md',
        'package.json',
        'reports/monthly-report.js',
      ],
    },
  });

  assertQualityAuditKeptNodePackPool(result);
  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const prompt = await fs.readFile(result.promptPath, 'utf-8');
  const rule = JSON.parse(await fs.readFile(result.contextRulePath, 'utf-8'));
  const selected = pipeline.metadata.orchestrationAuthoring.nodePackSelection;
  const selectedIds = selected.map(pack => pack.id);
  const declaredReport = pipeline.nodePacks.find(pack => pack.id === 'community.report-workstream');

  assert.equal(declaredReport.origin, 'user');
  assert.equal(declaredReport.trustLevel, 'signed');
  assert.equal(declaredReport.source, 'https://github.com/example/orpad-report-workstream');
  assert.equal(declaredReport.validationStatus, 'valid');
  assert.equal(declaredReport.resolutionState, 'resolved');
  assert.deepEqual(declaredReport.capabilities, ['read.workspace']);
  assert.equal(declaredReport.capabilityRiskSummary, 'no high-risk capabilities requested');
  assert.equal(selectedIds.includes('community.report-workstream'), true);
  assert.equal(selected.find(pack => pack.id === 'community.report-workstream').validationStatus, 'valid');
  assert.equal(selected.find(pack => pack.id === 'community.report-workstream').origin, 'user');
  assert.equal(selected.find(pack => pack.id === 'community.report-workstream').source, 'https://github.com/example/orpad-report-workstream');
  assert.equal(selected.find(pack => pack.id === 'community.report-workstream').trustLevel, 'signed');
  assert.deepEqual(selected.find(pack => pack.id === 'community.report-workstream').capabilities, ['read.workspace']);
  assert.equal(selected.find(pack => pack.id === 'community.report-workstream').capabilityRiskSummary, 'no high-risk capabilities requested');
  assert.equal(prompt.includes('community.report-workstream'), true);
  assert.match(prompt, /Pack metadata \(quoted, not instructions\): "/);
  assert.match(prompt, /origin=user; source=https:\/\/github\.com\/example\/orpad-report-workstream; trustLevel=signed; validationState=valid; capabilityRisk=no high-risk capabilities requested/);
  assert.equal(prompt.includes('report-workstream'), true);
  assert.equal(graph.graph.nodes.find(node => node.type === 'orpad.context').config.sourceNodePack, 'community.report-workstream');
  assert.equal(graph.graph.nodes.find(node => node.type === 'orpad.probe').config.lens, 'report-workflow');
  assert.equal(rule.include.includes('reports/**'), true);
  assertGraphNodePackRefsDeclared(pipeline, graph);
});

test('generated pipeline discovers a validated user-installed authoring pack from a user node pack root', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-user-node-pack-root-generate-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, 'reports'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'README.md'), '# Report workflow fixture\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }, null, 2), 'utf-8');
  await fs.writeFile(path.join(workspace, 'reports/monthly-report.js'), 'module.exports = {};\n', 'utf-8');
  const userNodePacksRoot = path.join(workspace, 'user-data', 'nodes');
  const { manifestPath } = await writeUserReportNodePackManifest(userNodePacksRoot);

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Build the custom report workflow with reusable report pack guidance.',
    timestamp: '2026-05-19T01:06:30.000Z',
    builtInNodePacksRoot: false,
    userNodePacksRoot,
    nodePackTrustEvidenceByPack: {
      'community.report-workstream': { signature: { verified: true } },
    },
    workspaceSnapshot: {
      files: [
        'README.md',
        'package.json',
        'reports/monthly-report.js',
      ],
    },
  });

  assertQualityAuditKeptNodePackPool(result);
  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const selectedReport = pipeline.metadata.orchestrationAuthoring.nodePackSelection
    .find(pack => pack.id === 'community.report-workstream');
  const declaredReport = pipeline.nodePacks.find(pack => pack.id === 'community.report-workstream');

  assert.deepEqual(declaredReport, {
    id: 'community.report-workstream',
    version: '>=0.1.0',
    origin: 'user',
    trustLevel: 'signed',
    source: manifestPath,
    resolutionState: 'resolved',
    validationStatus: 'valid',
    capabilityRiskSummary: 'no high-risk capabilities requested',
    capabilities: ['read.workspace'],
  });
  assert.equal(selectedReport.source, manifestPath);
  assert.equal(selectedReport.validationStatus, 'valid');
  assert.equal(selectedReport.trustLevel, 'signed');
  assert.deepEqual(selectedReport.capabilities, ['read.workspace']);
  assert.equal(selectedReport.matchedSignals.includes('workspace:reports/'), true);
  assert.equal(graph.graph.nodes.find(node => node.type === 'orpad.context').config.sourceNodePack, 'community.report-workstream');
  assertGraphNodePackRefsDeclared(pipeline, graph);
});

test('authoring selection excludes unsafe duplicates and conflicted user packs with diagnostics', () => {
  const packOverrides = [
    { id: 'community.safe-report', nodes: [{ type: 'community.safeReport', path: 'nodes/safe-report.js' }] },
    { id: 'community.safe-report', name: 'Duplicate Safe Report' },
    { id: 'community.high-risk-report', capabilities: ['read.workspace', 'use.network'] },
    { id: 'community.disabled-report', enabled: false },
    { id: 'community.conflict-a', nodes: [{ type: 'community.conflictedReport', path: 'nodes/conflict-a.js' }] },
    { id: 'community.conflict-b', nodes: [{ type: 'community.conflictedReport', path: 'nodes/conflict-b.js' }] },
  ];
  const nodePackPool = packOverrides.map(overrides => userReportNodePack(overrides));
  const selectionDiagnostics = [];
  const selected = selectAuthoringNodePacks(
    'Build the custom report workflow with reusable report pack guidance.',
    { files: ['reports/monthly-report.js'] },
    {
      maxPacks: 10,
      nodePackPool,
      nodePackTrustEvidenceByPack: Object.fromEntries(
        nodePackPool.map(pack => [pack.id, { signature: { verified: true } }]),
      ),
      selectionDiagnostics,
    },
  );
  const selectedIds = selected.map(pack => pack.id);
  const diagnosticCodes = new Set(selectionDiagnostics.map(item => item.code));

  assert.equal(selectedIds.includes('community.safe-report'), true);
  for (const skippedId of [
    'community.high-risk-report',
    'community.disabled-report',
    'community.conflict-a',
    'community.conflict-b',
  ]) {
    assert.equal(selectedIds.includes(skippedId), false, `${skippedId} should not be selected`);
  }
  assert.equal(diagnosticCodes.has('NODE_PACK_AUTHORING_DUPLICATE_ID_SKIPPED'), true);
  assert.equal(diagnosticCodes.has('NODE_PACK_AUTHORING_APPROVAL_REQUIRED_SKIPPED'), true);
  assert.equal(diagnosticCodes.has('NODE_PACK_AUTHORING_VALIDATION_SKIPPED'), true);
  assert.equal(diagnosticCodes.has('NODE_PACK_AUTHORING_TYPE_CONFLICT_SKIPPED'), true);
  assert.equal(diagnosticCodes.has('NODE_PACK_AUTHORING_CONFLICT_SKIPPED'), true);
});

test('Generate blocks when an explicitly required authoring node pack is unavailable', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-required-pack-block-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, 'README.md'), '# Required pack fixture\n', 'utf-8');

  const missingPackId = 'community.missing-required-workstream';
  let thrown = null;
  try {
    await createOrchestrationPipeline({
      workspaceRoot: workspace,
      taskText: 'Build the custom report workflow with reusable report pack guidance.',
      timestamp: '2026-05-24T01:00:00.000Z',
      requiredNodePackIds: [missingPackId],
      keepFailedPipeline: true,
      workspaceSnapshot: {
        files: ['README.md'],
      },
    });
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, 'Generate should fail when a required authoring pack is unavailable');
  assert.equal(thrown.code, 'ORCHESTRATION_AUTHORING_QUALITY_FAILED');
  assert.match(thrown.message, /NODE_PACK_AUTHORING_REQUIRED_UNAVAILABLE/);
  assert.match(thrown.message, /community\.missing-required-workstream/);

  const pipeline = JSON.parse(await fs.readFile(thrown.pipelinePath, 'utf-8'));
  const selectionDiagnostic = pipeline.metadata.orchestrationAuthoring.nodePackSelectionDiagnostics
    .find(item => item.code === 'NODE_PACK_AUTHORING_REQUIRED_UNAVAILABLE');
  assert.ok(selectionDiagnostic);
  assert.equal(selectionDiagnostic.level, 'warning');
  assert.equal(selectionDiagnostic.packId, missingPackId);
  assert.equal(pipeline.metadata.orchestrationAuthoring.qualityAudit.ok, false);
  assert.equal(
    pipeline.metadata.orchestrationAuthoring.qualityAudit.diagnostics
      .some(item => item.code === 'NODE_PACK_AUTHORING_REQUIRED_UNAVAILABLE'),
    true,
  );
});

test('Generate keeps optional ineligible authoring packs non-blocking', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-optional-pack-skip-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, 'reports'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'README.md'), '# Optional pack fixture\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'reports/monthly-report.js'), 'module.exports = {};\n', 'utf-8');

  const highRiskPack = userReportNodePack({
    id: 'community.optional-high-risk-report',
    capabilities: ['read.workspace', 'use.network'],
  });
  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Build the custom report workflow with reusable report pack guidance.',
    timestamp: '2026-05-24T01:05:00.000Z',
    nodePackPool: [highRiskPack],
    nodePackTrustEvidenceByPack: {
      [highRiskPack.id]: { signature: { verified: true } },
    },
    workspaceSnapshot: {
      files: ['README.md', 'reports/monthly-report.js'],
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.qualityAudit.ok, true);
  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  const diagnosticCodes = new Set(
    pipeline.metadata.orchestrationAuthoring.nodePackSelectionDiagnostics.map(item => item.code),
  );
  assert.equal(diagnosticCodes.has('NODE_PACK_AUTHORING_VALIDATION_SKIPPED'), true);
  assert.equal(diagnosticCodes.has('NODE_PACK_AUTHORING_REQUIRED_UNAVAILABLE'), false);
  assert.equal(pipeline.nodePacks.some(pack => pack.id === highRiskPack.id), false);
});

test('Generate IPC node pack options ignore renderer-supplied pack pools trust and approvals', () => {
  const highRiskPack = userReportNodePack({
    id: 'community.renderer-report-workstream',
    capabilities: ['read.workspace', 'use.network'],
    nodes: [{
      type: 'community.rendererReportNode',
      path: 'nodes/renderer-report.or-node',
      runtimeHandlerKind: 'metadata-only',
      capabilities: ['use.network'],
    }],
  });
  const rendererRequest = {
    nodePackPool: [highRiskPack],
    grantedCapabilities: ['read.workspace', 'use.network'],
    nodePackTrustEvidenceByPack: {
      [highRiskPack.id]: { signature: { verified: true } },
    },
    nodePackCapabilityReviewByPack: {
      [highRiskPack.id]: { status: 'approved', decisionId: 'renderer-self-review' },
    },
  };
  const rendererOptions = generateNodePackOptionsForRequest({ getPath: () => '' }, rendererRequest);

  assert.equal(rendererOptions.nodePackGrantedCapabilities, undefined);
  assert.equal(rendererOptions.nodePackTrustEvidenceByPack, undefined);
  assert.equal(rendererOptions.nodePackCapabilityReviewByPack, undefined);
  assert.equal(rendererOptions.nodePackPool.nodePacks.some(pack => pack.id === highRiskPack.id), false);

  const trustedOptions = generateNodePackOptionsForRequest(
    { getPath: () => '' },
    withTrustedNodePackAuthoringOptions(rendererRequest),
  );
  assert.deepEqual(trustedOptions.nodePackPool, [highRiskPack]);
  assert.deepEqual(trustedOptions.nodePackGrantedCapabilities, ['read.workspace', 'use.network']);
  assert.deepEqual(trustedOptions.nodePackTrustEvidenceByPack, rendererRequest.nodePackTrustEvidenceByPack);
  assert.deepEqual(trustedOptions.nodePackCapabilityReviewByPack, rendererRequest.nodePackCapabilityReviewByPack);
});

test('list-node-packs ignores renderer root overrides outside approved app roots', async (t) => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-list-user-data-'));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-list-outside-packs-'));
  t.after(() => fs.rm(userDataDir, { recursive: true, force: true }));
  t.after(() => fs.rm(outsideRoot, { recursive: true, force: true }));

  const approvedRoot = path.join(userDataDir, 'nodes');
  await writeUserReportNodePackManifest(
    approvedRoot,
    { id: 'community.approved-list-pack' },
    'approved-list-pack',
  );
  await writeUserReportNodePackManifest(
    outsideRoot,
    { id: 'community.outside-list-pack' },
    'outside-list-pack',
  );

  const handlers = registerFakeAuthoringHandlers(fakeNodePackApp(userDataDir));
  const result = await handlers.get('orchestration-list-node-packs')({ sender: {} }, {
    builtInNodePacksRoot: outsideRoot,
    userNodePackRoot: outsideRoot,
  });
  const ids = result.nodePacks.map(pack => pack.id);
  const blockedDiagnostics = result.diagnostics.filter(
    item => item.code === 'NODE_PACK_DISCOVERY_ROOT_OVERRIDE_BLOCKED',
  );

  assert.equal(result.success, true);
  assert.equal(ids.includes('community.approved-list-pack'), true);
  assert.equal(ids.includes('community.outside-list-pack'), false);
  assert.equal(result.roots.some(root => path.resolve(root.root) === path.resolve(outsideRoot)), false);
  assert.equal(result.roots.some(root => root.kind === 'user' && path.resolve(root.root) === path.resolve(approvedRoot)), true);
  assert.equal(blockedDiagnostics.some(item => item.rootKind === 'built-in'), true);
  assert.equal(blockedDiagnostics.some(item => item.rootKind === 'user'), true);
});

test('Generate IPC node pack discovery blocks outside roots and accepts approved userData roots for selection', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-generate-root-workspace-'));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-generate-user-data-'));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-generate-outside-packs-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  t.after(() => fs.rm(userDataDir, { recursive: true, force: true }));
  t.after(() => fs.rm(outsideRoot, { recursive: true, force: true }));

  await fs.mkdir(path.join(workspace, 'reports'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'README.md'), '# Report workflow fixture\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'reports/monthly-report.js'), 'module.exports = {};\n', 'utf-8');

  const approvedRoot = path.join(userDataDir, 'nodes');
  const { manifestPath } = await writeUserReportNodePackManifest(
    approvedRoot,
    { id: 'community.approved-generate-pack' },
    'approved-generate-pack',
  );
  await writeUserReportNodePackManifest(
    outsideRoot,
    { id: 'community.outside-generate-pack' },
    'outside-generate-pack',
  );

  const app = fakeNodePackApp(userDataDir);
  const rendererOptions = generateNodePackOptionsForRequest(app, {
    builtInNodePacksRoot: outsideRoot,
    userNodePacksRoot: outsideRoot,
    nodePackTrustEvidenceByPack: {
      'community.approved-generate-pack': { signature: { verified: true } },
      'community.outside-generate-pack': { signature: { verified: true } },
    },
  });
  const rendererIds = rendererOptions.nodePackPool.nodePacks.map(pack => pack.id);
  const blockedDiagnostics = rendererOptions.nodePackDiagnostics.filter(
    item => item.code === 'NODE_PACK_DISCOVERY_ROOT_OVERRIDE_BLOCKED',
  );

  assert.equal(rendererIds.includes('community.approved-generate-pack'), true);
  assert.equal(rendererIds.includes('community.outside-generate-pack'), false);
  assert.equal(rendererOptions.nodePackPool.roots.some(root => path.resolve(root.root) === path.resolve(outsideRoot)), false);
  assert.equal(rendererOptions.nodePackPool.roots.some(root => root.kind === 'user' && path.resolve(root.root) === path.resolve(approvedRoot)), true);
  assert.equal(blockedDiagnostics.some(item => item.rootKind === 'built-in'), true);
  assert.equal(blockedDiagnostics.some(item => item.rootKind === 'user'), true);
  assert.equal(rendererOptions.nodePackTrustEvidenceByPack, undefined);

  const approvedRendererOptions = generateNodePackOptionsForRequest(app, {
    userNodePacksRoot: approvedRoot,
  });
  assert.equal(
    approvedRendererOptions.nodePackDiagnostics.some(
      item => item.code === 'NODE_PACK_DISCOVERY_ROOT_OVERRIDE_BLOCKED' && item.rootKind === 'user',
    ),
    false,
  );
  assert.equal(
    approvedRendererOptions.nodePackPool.nodePacks.some(pack => pack.id === 'community.approved-generate-pack'),
    true,
  );

  const trustedOptions = generateNodePackOptionsForRequest(
    app,
    withTrustedNodePackAuthoringOptions({
      builtInNodePacksRoot: false,
      userNodePacksRoot: approvedRoot,
      nodePackTrustEvidenceByPack: {
        'community.approved-generate-pack': { signature: { verified: true } },
      },
    }),
  );
  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Build the custom report workflow with reusable report pack guidance.',
    timestamp: '2026-05-24T00:30:00.000Z',
    workspaceSnapshot: {
      files: ['README.md', 'reports/monthly-report.js'],
    },
    ...trustedOptions,
  });
  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  const selectedPack = pipeline.metadata.orchestrationAuthoring.nodePackSelection
    .find(pack => pack.id === 'community.approved-generate-pack');

  assertQualityAuditKeptNodePackPool(result);
  assert.ok(selectedPack);
  assert.equal(selectedPack.source, manifestPath);
  assert.equal(selectedPack.validationStatus, 'valid');
  assert.equal(pipeline.nodePacks.some(pack => pack.id === 'community.outside-generate-pack'), false);
});

test('LLM-authored specs backfill selected node pack provenance without overwriting explicit metadata', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-node-pack-llm-backfill-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, 'README.md'), '# Pack manager fixture\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }, null, 2), 'utf-8');

  const authoringSpec = {
    title: 'Pack manager MVP',
    graph: {
      id: 'pack-manager-mvp',
      label: 'Pack manager MVP',
      start: 'entry',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        {
          id: 'map-pack-manager',
          type: 'orpad.context',
          label: 'Map pack manager surfaces',
          config: {
            summary: 'Inspect pack listing, validation status, trust level, and capability metadata.',
            sourceNodePack: 'orpad.starter.frontend-ux',
            supportingNodePacks: ['orpad.starter.frontend-ux'],
          },
        },
        { id: 'probe-pack-manager', type: 'orpad.probe', label: 'Probe pack manager candidates', config: { lens: 'pack-manager-mvp', maxCandidates: 4 } },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue pack manager increments' },
        { id: 'triage', type: 'orpad.triage', label: 'Prioritize pack manager increments' },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch pack manager increment' },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Implement pack manager increment' },
        { id: 'patch-review', type: 'orpad.patchReview', label: 'Review pack manager patch' },
        {
          id: 'verification-gate',
          type: 'orpad.gate',
          label: 'Verify pack manager evidence',
          config: {
            criteria: [
              'pack manager trust metadata is recorded for every selected node pack',
              'validation evidence links changed surfaces to queue claims',
            ],
            onFail: 'warn',
          },
        },
        { id: 'artifact', type: 'orpad.artifactContract', label: 'Record pack manager evidence' },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'map-pack-manager' },
        { from: 'map-pack-manager', to: 'probe-pack-manager' },
        { from: 'probe-pack-manager', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'patch-review' },
        { from: 'patch-review', to: 'worker', condition: 'rejected' },
        { from: 'patch-review', to: 'verification-gate', condition: 'accepted' },
        { from: 'verification-gate', to: 'worker', condition: 'revise' },
        { from: 'verification-gate', to: 'triage', condition: 'queue-not-empty' },
        { from: 'verification-gate', to: 'artifact', condition: 'queue-empty' },
        { from: 'artifact', to: 'exit' },
      ],
    },
  };

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Build a pack manager UX with community pack trust and security review metadata.',
    authoringSpec,
    timestamp: '2026-05-19T01:07:00.000Z',
    maxAuthoringNodePacks: 2,
    requiredNodePackIds: ['orpad.starter.frontend-ux', 'orpad.starter.security-review'],
    workspaceSnapshot: { files: ['README.md', 'package.json', 'src/renderer/pack-manager.js', 'SECURITY.md'] },
  });

  assert.equal(result.qualityAudit.ok, true);
  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const selectedIds = pipeline.metadata.orchestrationAuthoring.nodePackSelection.map(pack => pack.id);
  assert.equal(selectedIds.includes('orpad.starter.frontend-ux'), true);
  assert.equal(selectedIds.includes('orpad.starter.security-review'), true);

  const provenanceNodes = graph.graph.nodes.filter(node => [
    'orpad.context',
    'orpad.probe',
    'orpad.gate',
    'orpad.workerLoop',
    'orpad.artifactContract',
  ].includes(node.type));
  for (const node of provenanceNodes) {
    const refs = nodePackRefs(node);
    for (const selectedId of selectedIds) {
      assert.equal(refs.includes(selectedId), true, `${node.id} should record selected pack ${selectedId}`);
    }
  }

  const contextNode = graph.graph.nodes.find(node => node.id === 'map-pack-manager');
  assert.equal(contextNode.config.sourceNodePack, 'orpad.starter.frontend-ux');
  assert.equal(contextNode.config.supportingNodePacks.includes('orpad.starter.security-review'), true);
  assertGraphNodePackRefsDeclared(pipeline, graph);
});

test('LLM authoring agent prompt receives the matched situation pack catalog', () => {
  const prompt = authoringAgentPrompt({
    workspaceRoot: 'C:/fixture',
    appRoot: repoRoot,
    cliPath: path.join(repoRoot, 'bin/orpad-cli.mjs'),
    promptFile: 'C:/fixture/.orpad/authoring/request.txt',
    authoringSpecPath: 'C:/fixture/.orpad/authoring/spec.json',
    prompt: 'Review Electron preload IPC security before release.',
    snapshot: {
      files: [
        'src/main/preload.js',
        'src/renderer/renderer.js',
        'electron-builder.yml',
        'SECURITY.md',
      ],
    },
  });

  assert.match(prompt, /Situation Node Pack Catalog/);
  assert.match(prompt, /orpad\.starter\.electron-maintenance/);
  assert.match(prompt, /orpad\.starter\.security-review/);
  assert.match(prompt, /materialized pipeline will declare them in `nodePacks`/);
  assert.match(prompt, /Preferred probe lens: electron-maintenance/);
});

test('generated documentation pipeline selects the content QA pack', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-content-pack-generate-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, 'README.md'), '# Docs fixture\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }, null, 2), 'utf-8');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Rewrite the README documentation tutorial content for maintainer onboarding.',
    timestamp: '2026-05-19T01:10:00.000Z',
    workspaceSnapshot: { files: ['README.md', 'docs/onboarding.md', 'src/locales/en.json'] },
  });
  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));

  assert.equal(result.qualityAudit.ok, true);
  assert.equal(pipeline.nodePacks.some(pack => pack.id === 'orpad.starter.content-qa'), true);
  assert.equal(graph.graph.nodes.find(node => node.type === 'orpad.probe').config.lens, 'content-qa');
  const contentGate = graph.graph.nodes.find(node => node.id === 'content-editorial-quality-gate');
  assert.ok(contentGate, 'content/documentation pipelines should include the editorial quality gate');
  assert.equal(contentGate.type, 'orpad.gate');
  assert.equal(contentGate.config.evaluationMode, 'content-editorial-quality');
  assert.equal(contentGate.config.judgePolicy, 'rule-only');
  assert.ok(contentGate.config.expectedEvaluationArtifacts.some(item => item.includes('artifacts/evaluations/content-editorial/workers/')));
  assert.ok(contentGate.config.expectedJudgeArtifacts.some(item => item.includes('artifacts/evaluations/content-editorial/judges/')));
  assert.ok(contentGate.config.nodePackRubric.some(item => /Rule analyzer/.test(item)));
  assert.match(JSON.stringify(contentGate.config), /Voice and tone|voice-tone/);
  assert.match(JSON.stringify(contentGate.config), /density|repetition/);
  assert.match(JSON.stringify(contentGate.config), /role-separated|role separation/);
  const orderedIds = graph.graph.nodes.map(node => node.id);
  assert.ok(orderedIds.indexOf('patch-review') < orderedIds.indexOf('content-editorial-quality-gate'));
  assert.ok(orderedIds.indexOf('content-editorial-quality-gate') < orderedIds.indexOf('verification-gate'));
  assert.equal(
    graph.graph.transitions.some(edge => edge.from === 'patch-review' && edge.to === 'content-editorial-quality-gate' && edge.condition === 'accepted'),
    true,
  );
  assert.equal(
    graph.graph.transitions.some(edge => edge.from === 'content-editorial-quality-gate' && edge.to === 'verification-gate' && edge.condition === 'pass'),
    true,
  );
  assert.equal(
    pipeline.metadata.orchestrationAuthoring.nodePackSelection.some(pack => pack.id === 'orpad.starter.content-qa'),
    true,
  );
  assertGraphNodePackRefsDeclared(pipeline, graph);
});

test('generated Threading Lecture pipeline selects .NET lab code before content QA', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-dotnet-lab-pack-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, 'ThreadProgramming/Unit3/Lab05_Semaphore'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'README.md'), '# Threading Lecture\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'ThreadProgramming/Unit3/Unit3_Slides.md'), '# Unit 3\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'ThreadProgramming/Unit3/Lab05_Semaphore/README.md'), '# Semaphore lab\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'ThreadProgramming/Unit3/Lab05_Semaphore/Program.cs'), 'Console.WriteLine("lab");\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'ThreadProgramming/Unit3/Lab05_Semaphore/Lab05_Semaphore.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />\n', 'utf-8');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Repair Threading Lecture labs by aligning Program.cs behavior, README instructions, and slides with dotnet validation evidence.',
    timestamp: '2026-05-20T01:20:00.000Z',
    workspaceSnapshot: {
      files: [
        'README.md',
        'ThreadProgramming/Unit3/Unit3_Slides.md',
        'ThreadProgramming/Unit3/Lab05_Semaphore/README.md',
        'ThreadProgramming/Unit3/Lab05_Semaphore/Program.cs',
        'ThreadProgramming/Unit3/Lab05_Semaphore/Lab05_Semaphore.csproj',
      ],
    },
  });

  assert.equal(result.qualityAudit.ok, true);
  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const prompt = await fs.readFile(result.promptPath, 'utf-8');
  const skill = await fs.readFile(result.skillPath, 'utf-8');
  const rule = JSON.parse(await fs.readFile(result.contextRulePath, 'utf-8'));

  const selectedIds = pipeline.metadata.orchestrationAuthoring.nodePackSelection.map(pack => pack.id);
  assert.equal(selectedIds[0], 'orpad.starter.dotnet-lab-code');
  assert.equal(selectedIds.includes('orpad.starter.content-qa'), true);
  assert.equal(pipeline.nodePacks.some(pack => pack.id === 'orpad.starter.dotnet-lab-code'), true);
  assert.equal(graph.graph.nodes.find(node => node.type === 'orpad.probe').config.lens, 'dotnet-lab-code');
  assert.ok(graph.graph.nodes.some(node => node.id === 'content-editorial-quality-gate'));
  assert.equal(rule.include.includes('**/*.cs'), true);
  assert.match(prompt, /Candidate target policy: .*Program\.cs/);
  assert.match(prompt, /Final quality gate: Gate final editorial quality/);
  assert.match(skill, /Candidates that rely on runtime behavior include code files in targetFiles/);
  assertGraphNodePackRefsDeclared(pipeline, graph);
});

test('generated graph editor UX pipeline selects frontend UX and regression packs', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-frontend-ux-pack-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, 'src/renderer/styles'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'tests/e2e'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'playwright test' } }, null, 2), 'utf-8');
  await fs.writeFile(path.join(workspace, 'src/renderer/renderer.js'), 'console.log("graph editor");\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'src/renderer/styles/base.css'), '.graph-editor {}\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'tests/e2e/runbook-pipeline-editor.spec.ts'), 'test("graph editor", async () => {});\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'playwright.config.ts'), 'export default {};\n', 'utf-8');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Fix graph editor right-click node context menu, node inspector Bypass control, and Repeater repeat count UX with focused e2e verification.',
    timestamp: '2026-05-20T01:25:00.000Z',
    workspaceSnapshot: {
      files: [
        'package.json',
        'src/renderer/renderer.js',
        'src/renderer/styles/base.css',
        'tests/e2e/runbook-pipeline-editor.spec.ts',
        'playwright.config.ts',
      ],
    },
  });

  assert.equal(result.qualityAudit.ok, true);
  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const rule = JSON.parse(await fs.readFile(result.contextRulePath, 'utf-8'));
  const selectedIds = pipeline.metadata.orchestrationAuthoring.nodePackSelection.map(pack => pack.id);

  assert.equal(selectedIds[0], 'orpad.starter.frontend-ux');
  assert.equal(selectedIds.includes('orpad.starter.test-regression'), true);
  assert.equal(graph.graph.nodes.find(node => node.type === 'orpad.probe').config.lens, 'frontend-ux');
  assert.equal(rule.include.includes('src/renderer/**'), true);
  assert.equal(rule.include.includes('tests/e2e/**'), true);
});

test('authoring pack exploration treats C# and CSS extensions as separate signals', () => {
  const selected = selectAuthoringNodePacks('Fix graph editor CSS layout only.', {
    files: [
      'src/renderer/styles/base.css',
      'tests/e2e/runbook-pipeline-editor.spec.ts',
    ],
  }, { maxPacks: 5 });
  const ids = selected.map(pack => pack.id);

  assert.equal(ids.includes('orpad.starter.frontend-ux'), true);
  assert.equal(ids.includes('orpad.starter.dotnet-lab-code'), false);
});
