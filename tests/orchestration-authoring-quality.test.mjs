import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { analyzeGraphComplexity, createOrchestrationPipeline } = require(path.join(repoRoot, 'src/main/orchestration-authoring/generator.js'));
const { auditGeneratedPipelineQuality } = require(path.join(repoRoot, 'src/main/orchestration-authoring/quality-audit.js'));

const PLACEHOLDER_PATTERN = /TODO\s*(?:\u2014|-)?\s*author|Placeholder created by generator|Placeholder leaf|TODO placeholder/i;
const ORPAD_HARDENING_PROMPT = [
  'Create an OrPAD orchestration pipeline to improve OrPAD product completeness and reliability through evidence-driven hardening.',
  'The pipeline must orchestrate a Ralph-style iterative improvement loop with deterministic verification before expensive work.',
  'Required orchestration shape: Use a fork-join discovery phase with independent probes for runtime, renderer UI, generation quality, web compatibility, Electron stability, and node pack trust.',
  'Merge findings into a triage node that creates a prioritized work queue.',
  'Use dispatcher + workerLoop for one bounded improvement task per iteration.',
  'Use patchReview with accepted and rejected branches; rejected patches must loop back to workerLoop.',
  'Include a queue-drain loop so dispatcher continues until the queue is empty.',
  'Include an artifact contract that requires evidence for each completed task.',
].join(' ');
const REQUIRED_ITEM_EVIDENCE_FIELDS = [
  'failingSymptom',
  'rootCause',
  'filesChanged',
  'verificationCommands',
  'residualRisk',
];
const REPLAY_RUN_COUNT = 3;
const REPLAY_TIMESTAMP = '2026-05-24T13:10:00.000Z';
const REPLAY_WORKSPACE_SNAPSHOT = {
  files: [
    'README.md',
    'package.json',
    'src/main/orchestration-machine/machine.js',
    'src/renderer/App.jsx',
    'tests/orchestration-authoring-quality.test.mjs',
  ],
};
const REPLAY_AUTHORING_SPEC = {
  title: 'Queue Drain Replay Fixture',
  description: 'Deterministic replay fixture for queue drain, patch review, and worker evidence authoring.',
  graph: {
    id: 'queue-drain-replay',
    label: 'Queue drain replay',
    start: 'entry',
    nodes: [
      { id: 'entry', type: 'orpad.entry', label: 'Entry' },
      { id: 'context', type: 'orpad.context', label: 'Map replay context', config: { summary: 'Use the fixed workspace snapshot as deterministic replay context.' } },
      { id: 'runtime-probe', type: 'orpad.probe', label: 'Probe runtime queue drain contracts', config: { lens: 'runtime-queue-drain', maxCandidates: 5 } },
      { id: 'renderer-probe', type: 'orpad.probe', label: 'Probe stale UI evidence contracts', config: { lens: 'renderer-stale-ui', maxCandidates: 5 } },
      { id: 'join-findings', type: 'orpad.barrier', label: 'Join replay probes', config: { waitFor: ['runtime-probe', 'renderer-probe'], mergePolicy: 'concat-evidence', onPartialFailure: 'continue-with-warning' } },
      { id: 'queue', type: 'orpad.workQueue', label: 'Queue replay work' },
      { id: 'triage', type: 'orpad.triage', label: 'Prioritize replay work' },
      { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch one replay item' },
      { id: 'worker', type: 'orpad.workerLoop', label: 'Repair replay item', config: { targetFiles: ['src/main/orchestration-authoring/generator.js', 'tests/orchestration-authoring-quality.test.mjs'] } },
      { id: 'patch-review', type: 'orpad.patchReview', label: 'Review replay patch' },
      { id: 'verification-gate', type: 'orpad.gate', label: 'Verify replay result', config: { criteria: ['queue drain replay proof is deterministic', 'worker evidence contract fields are present'], onFail: 'warn' } },
      { id: 'artifact', type: 'orpad.artifactContract', label: 'Record replay evidence' },
      { id: 'exit', type: 'orpad.exit', label: 'Exit' },
    ],
    transitions: [
      { from: 'entry', to: 'context' },
      { from: 'context', to: 'runtime-probe' },
      { from: 'context', to: 'renderer-probe' },
      { from: 'runtime-probe', to: 'join-findings' },
      { from: 'renderer-probe', to: 'join-findings' },
      { from: 'join-findings', to: 'queue', condition: 'pass' },
      { from: 'queue', to: 'triage' },
      { from: 'triage', to: 'dispatch' },
      { from: 'dispatch', to: 'worker' },
      { from: 'worker', to: 'patch-review' },
      { from: 'patch-review', to: 'worker', condition: 'rejected' },
      { from: 'patch-review', to: 'verification-gate', condition: 'accepted' },
      { from: 'verification-gate', to: 'worker', condition: 'revise' },
      { from: 'verification-gate', to: 'dispatch', condition: 'queue-not-empty' },
      { from: 'verification-gate', to: 'artifact', condition: 'queue-empty' },
      { from: 'artifact', to: 'exit' },
    ],
  },
  skill: {
    acceptanceCriteria: [
      'Replay emits stable queue-drain branches.',
      'Replay emits stable patch review reject-loop branches.',
      'Replay emits stable per-worker evidence contracts.',
    ],
  },
  metadata: {
    authoringNotes: 'Pattern B+D+I+J+K replay fixture for deterministic queue drain and worker evidence assertions.',
  },
};

async function writeWorkspaceSeed(workspace, title) {
  await fs.writeFile(path.join(workspace, 'README.md'), `# ${title}\n\nFixture workspace for OrPAD authoring quality tests.\n`, 'utf-8');
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }, null, 2), 'utf-8');
}

async function writeReplayWorkspaceSeed(workspace, title) {
  await writeWorkspaceSeed(workspace, title);
  await fs.mkdir(path.join(workspace, 'src/main/orchestration-machine'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'src/renderer'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'tests'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'src/main/orchestration-machine/machine.js'), 'module.exports = {};\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'src/renderer/App.jsx'), 'export default function App() { return null; }\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'tests/orchestration-authoring-quality.test.mjs'), 'import test from "node:test";\n', 'utf-8');
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf-8'));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableJsonCompare(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function normalizedTransitions(transitions) {
  return (Array.isArray(transitions) ? transitions : [])
    .map(edge => ({
      from: edge.from,
      to: edge.to,
      condition: edge.condition || '',
    }))
    .sort(stableJsonCompare);
}

function graphPayload(graphFile) {
  return graphFile?.graph || {};
}

function finalGateBeforeArtifact(graphFile) {
  const graph = graphPayload(graphFile);
  const nodes = graph.nodes || [];
  const artifactIndex = nodes.findIndex(node => node.type === 'orpad.artifactContract');
  const gates = nodes.filter((node, index) => (
    node.type === 'orpad.gate'
    && (artifactIndex < 0 || index < artifactIndex)
  ));
  return gates[gates.length - 1] || null;
}

function graphNodeById(graphFile, id) {
  return (graphPayload(graphFile).nodes || []).find(node => node.id === id) || null;
}

function normalizeReplaySnapshot({ pipeline, graphFile, authoringSpec }) {
  const graph = graphPayload(graphFile);
  const adapter = pipeline.run.machineAdapter;
  const artifact = graph.nodes.find(node => node.type === 'orpad.artifactContract');
  const worker = graph.nodes.find(node => node.type === 'orpad.workerLoop');
  const finalGate = finalGateBeforeArtifact(graphFile);
  const replayTransitions = normalizedTransitions(graph.transitions);
  return {
    authoringSpecTopology: {
      graphId: authoringSpec.graph.id,
      start: authoringSpec.graph.start,
      nodes: authoringSpec.graph.nodes.map(node => ({ id: node.id, type: node.type, label: node.label })),
      transitions: normalizedTransitions(authoringSpec.graph.transitions),
    },
    graphTopology: {
      id: graph.id,
      start: graph.start,
      nodes: graph.nodes.map(node => ({ id: node.id, type: node.type, label: node.label })),
      transitions: replayTransitions,
    },
    queueDrainEdges: replayTransitions.filter(edge => (
      edge.from === finalGate?.id
      && ['queue-empty', 'queue-not-empty'].includes(edge.condition)
    )),
    patchReviewEdges: replayTransitions.filter(edge => edge.from === 'patch-review'),
    machineAdapter: {
      claimPolicy: adapter.claimPolicy,
      probeConcurrency: adapter.probeConcurrency,
      probeNodePaths: [...adapter.probeNodePaths].sort(),
      triageNodePath: adapter.triageNodePath,
      dispatcherNodePath: adapter.dispatcherNodePath,
      workerNodePath: adapter.workerNodePath,
    },
    queueProtocol: pipeline.run.queueProtocol,
    artifactContract: {
      required: artifact.config.required,
      requiredQueue: artifact.config.requiredQueue,
      onMissing: artifact.config.onMissing,
      itemEvidenceContract: {
        schemaVersion: artifact.config.itemEvidenceContract.schemaVersion,
        workerResultSchema: artifact.config.itemEvidenceContract.workerResultSchema,
        requiredPerCompletedTask: artifact.config.itemEvidenceContract.requiredPerCompletedTask,
        optionalPerCompletedTask: artifact.config.itemEvidenceContract.optionalPerCompletedTask,
        artifactPaths: artifact.config.itemEvidenceContract.artifactPaths,
        enforcement: artifact.config.itemEvidenceContract.enforcement,
      },
    },
    workerEvidence: {
      resultSchema: worker.config.resultSchema,
      evidenceContractRef: worker.config.evidenceContractRef,
      requiredResultFields: worker.config.requiredResultFields,
      evidenceArtifacts: worker.config.evidenceArtifacts,
      targetFiles: worker.config.targetFiles,
    },
  };
}

function assertReplayContracts(snapshot, label) {
  assert.deepEqual(snapshot.queueDrainEdges, [
    { from: 'verification-gate', to: 'artifact', condition: 'queue-empty' },
    { from: 'verification-gate', to: 'dispatch', condition: 'queue-not-empty' },
  ], `${label}: queue drain branches must stay canonical and unique`);
  assert.deepEqual(snapshot.patchReviewEdges, [
    { from: 'patch-review', to: 'verification-gate', condition: 'accepted' },
    { from: 'patch-review', to: 'worker', condition: 'rejected' },
  ], `${label}: patchReview accepted/rejected routing must stay canonical`);
  assert.deepEqual(snapshot.machineAdapter.probeNodePaths, ['main/renderer-probe', 'main/runtime-probe']);
  assert.equal(snapshot.machineAdapter.triageNodePath, 'main/triage');
  assert.equal(snapshot.machineAdapter.dispatcherNodePath, 'main/dispatch');
  assert.equal(snapshot.machineAdapter.workerNodePath, 'main/worker');
  assert.deepEqual(snapshot.machineAdapter.claimPolicy, { concurrency: 1 });
  assert.equal(snapshot.machineAdapter.probeConcurrency, 'all');
  assert.equal(snapshot.queueProtocol.schema, 'orpad.workItem.v1');
  assert.deepEqual(snapshot.queueProtocol.claimPolicy, {
    concurrency: 1,
    defaultAction: 'continue-claiming',
    processUntil: [
      'queue-empty',
      'approval-required-next',
      'scope-split-required',
      'verification-blocked',
      'risk-budget-exceeded',
      'handoff-required',
    ],
    stopWhenQueueEmpty: true,
    stopOnApprovalRequired: true,
  });
  assert.deepEqual(
    new Set(snapshot.artifactContract.itemEvidenceContract.requiredPerCompletedTask),
    new Set(REQUIRED_ITEM_EVIDENCE_FIELDS),
    `${label}: artifact contract must require completed-task evidence fields`,
  );
  assert.equal(snapshot.artifactContract.itemEvidenceContract.workerResultSchema, 'orpad.workerResult.v1');
  assert.equal(snapshot.artifactContract.itemEvidenceContract.enforcement, 'hard-required-by-artifact-contract');
  assert.deepEqual(
    new Set(snapshot.workerEvidence.requiredResultFields),
    new Set(REQUIRED_ITEM_EVIDENCE_FIELDS),
    `${label}: worker result schema must require evidence fields`,
  );
  assert.equal(snapshot.workerEvidence.resultSchema, 'orpad.workerResult.v1');
  assert.equal(snapshot.workerEvidence.evidenceContractRef, 'orpad.artifactContract.itemEvidenceContract');
  assert.deepEqual(snapshot.workerEvidence.evidenceArtifacts, [
    'work-items/<work-item-id>/worker-evidence.json',
    'work-items/<work-item-id>/verification.md',
  ]);
}

function communityQualityPack(overrides = {}) {
  return {
    kind: 'orpad.nodePack',
    schemaVersion: '1.0',
    id: 'community.quality-audit-pack',
    name: 'Community Quality Audit Pack',
    version: '0.1.0',
    origin: 'user',
    trustLevel: 'signed',
    description: 'Metadata-only user-installed pack used to validate authoring quality with installed node packs.',
    author: {
      name: 'Community Pack Author',
      github: 'https://github.com/example',
      repository: 'https://github.com/example/community-quality-audit-pack',
    },
    license: 'MIT',
    compatibility: {
      orpad: '>=1.0.0',
      packFormat: 'orpad.nodePack.v1',
    },
    capabilities: ['read.workspace'],
    nodes: [],
    ...overrides,
  };
}

async function writeUserNodePack(userRoot, pack) {
  const dir = path.join(userRoot, pack.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'orpad.node-pack.json'), JSON.stringify(pack, null, 2), 'utf-8');
}

async function collectFiles(root, suffixes) {
  const out = [];
  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (suffixes.some(suffix => entry.name.endsWith(suffix))) {
        out.push(abs);
      }
    }
  }
  await walk(root);
  return out;
}

async function assertGeneratedPackageQuality(result) {
  const audit = await auditGeneratedPipelineQuality(result.pipelinePath);
  assert.equal(audit.ok, true, JSON.stringify(audit.diagnostics, null, 2));
  assert.equal(audit.summary.errorCount, 0);
  assert.equal(audit.summary.validationOk, true);
  assert.equal(audit.summary.canMachineExecuteStep, true);
  assert.ok(audit.summary.flattenedNodeCount >= 10);

  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  assert.equal(pipeline.metadata.orchestrationAuthoring.qualityAudit.ok, true);
  assert.equal(pipeline.metadata.graphComplexity.isLinearChain, false);
  assert.ok(pipeline.metadata.graphComplexity.patternsDetected.includes('queue-drain-loop'));
  assert.ok(pipeline.metadata.graphComplexity.patternsDetected.includes('patch-review-reject-loop'));
  assert.equal(pipeline.run.machineAdapter.claimPolicy.concurrency, 1);
  assert.equal(pipeline.run.queueProtocol.claimPolicy.concurrency, 1);

  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const artifact = graph.graph.nodes.find(node => node.type === 'orpad.artifactContract');
  assert.ok(artifact?.config?.itemEvidenceContract, 'artifactContract must declare itemEvidenceContract');
  assert.deepEqual(
    new Set(artifact.config.itemEvidenceContract.requiredPerCompletedTask),
    new Set(REQUIRED_ITEM_EVIDENCE_FIELDS),
  );
  assert.equal(artifact.config.itemEvidenceContract.enforcement, 'hard-required-by-artifact-contract');
  assert.equal(artifact.config.itemEvidenceContract.workerResultSchema, 'orpad.workerResult.v1');
  const worker = graph.graph.nodes.find(node => node.type === 'orpad.workerLoop');
  assert.equal(worker?.config?.resultSchema, 'orpad.workerResult.v1');
  assert.equal(worker?.config?.evidenceContractRef, 'orpad.artifactContract.itemEvidenceContract');
  for (const field of REQUIRED_ITEM_EVIDENCE_FIELDS) {
    assert.ok(worker.config.requiredResultFields.includes(field), `worker result contract must include ${field}`);
  }

  const structuralFiles = await collectFiles(result.pipelineDir, ['.or-graph', '.or-tree']);
  assert.ok(structuralFiles.length >= audit.summary.graphCount);
  for (const file of structuralFiles) {
    const text = await fs.readFile(file, 'utf-8');
    assert.equal(PLACEHOLDER_PATTERN.test(text), false, `${file} contains placeholder authoring text`);
  }
}

test('generator honors explicit fork-join independent discovery probe requests', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-fork-join-hardening-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceSeed(workspace, 'OrPAD hardening fixture');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: ORPAD_HARDENING_PROMPT,
    timestamp: '2026-05-24T09:20:00.000Z',
  });

  assert.equal(result.qualityAudit.ok, true, JSON.stringify(result.qualityAudit.diagnostics, null, 2));
  assert.ok(result.graphComplexity.patternsDetected.includes('fork-join'));
  assert.ok(result.graphComplexity.patternsDetected.includes('queue-drain-loop'));
  assert.ok(result.graphComplexity.patternsDetected.includes('patch-review-reject-loop'));
  assert.ok(result.graphComplexity.barrierCount >= 1);

  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const probes = graph.graph.nodes.filter(node => node.type === 'orpad.probe');
  const barrier = graph.graph.nodes.find(node => node.type === 'orpad.barrier');
  assert.ok(probes.length >= 6, `expected at least 6 independent discovery probes, got ${probes.length}`);
  assert.ok(barrier, 'expected a barrier to join the discovery probes');
  assert.deepEqual(
    [...barrier.config.waitFor].sort(),
    probes.map(node => node.id).sort(),
  );
  for (const probe of probes) {
    assert.ok(
      graph.graph.transitions.some(edge => edge.to === probe.id && !edge.condition),
      `expected an unconditional fork edge into ${probe.id}`,
    );
    assert.ok(
      graph.graph.transitions.some(edge => edge.from === probe.id && edge.to === barrier.id),
      `expected ${probe.id} to join through ${barrier.id}`,
    );
  }

  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  assert.equal(
    pipeline.run.machineAdapter.probeNodePaths.length,
    probes.length,
    'machineAdapter.probeNodePaths must include every generated probe',
  );
});

test('quality auditor fails explicit fork-join requests that collapse to one probe path', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-fork-join-negative-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceSeed(workspace, 'Fork join negative fixture');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: ORPAD_HARDENING_PROMPT,
    timestamp: '2026-05-24T09:21:00.000Z',
  });

  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const barrier = graph.graph.nodes.find(node => node.type === 'orpad.barrier');
  const probes = graph.graph.nodes.filter(node => node.type === 'orpad.probe');
  assert.ok(barrier);
  graph.graph.nodes = graph.graph.nodes.filter(node => node.id !== barrier.id);
  graph.graph.transitions = graph.graph.transitions
    .filter(edge => edge.from !== barrier.id && edge.to !== barrier.id)
    .concat(probes.map((probe, index) => ({
      id: `collapsed-${probe.id}-to-queue-${index}`,
      from: probe.id,
      to: 'queue',
    })));
  await fs.writeFile(result.graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

  const audit = await auditGeneratedPipelineQuality(result.pipelinePath);
  const codes = audit.diagnostics.map(item => item.code);
  assert.equal(audit.ok, false);
  assert.ok(codes.includes('AUTHORING_REQUESTED_FORK_JOIN_MISSING'));
});

test('quality auditor rejects flat linear graph topology even when metadata is absent or false', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-linear-underfit-negative-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceSeed(workspace, 'Linear underfit negative fixture');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: ORPAD_HARDENING_PROMPT,
    timestamp: '2026-05-24T13:05:00.000Z',
  });

  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const linearTypes = [
    'orpad.entry',
    'orpad.context',
    'orpad.probe',
    'orpad.workQueue',
    'orpad.triage',
    'orpad.dispatcher',
    'orpad.workerLoop',
    'orpad.patchReview',
    'orpad.gate',
    'orpad.artifactContract',
    'orpad.exit',
  ];
  const chainNodes = linearTypes.map(type => graph.graph.nodes.find(node => node.type === type));
  assert.equal(chainNodes.every(Boolean), true, 'fixture should expose the standard generated workstream node chain');
  graph.graph.start = chainNodes[0].id;
  graph.graph.nodes = chainNodes;
  graph.graph.transitions = chainNodes.slice(1).map((node, index) => ({
    from: chainNodes[index].id,
    to: node.id,
  }));
  await fs.writeFile(result.graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  pipeline.metadata.graphComplexity = {
    isLinearChain: false,
    patternsDetected: ['metadata-claims-nonlinear'],
  };
  await fs.writeFile(result.pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`, 'utf-8');

  const falseMetadataAudit = await auditGeneratedPipelineQuality(result.pipelinePath);
  const falseMetadataUnderfit = falseMetadataAudit.diagnostics
    .find(item => item.code === 'AUTHORING_GRAPH_LINEAR_UNDERFIT');
  assert.equal(falseMetadataAudit.ok, false);
  assert.equal(falseMetadataUnderfit?.graphComplexity?.isLinearChain, true);
  assert.equal(falseMetadataUnderfit?.metadataGraphComplexity?.isLinearChain, false);

  delete pipeline.metadata.graphComplexity;
  await fs.writeFile(result.pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`, 'utf-8');

  const missingMetadataAudit = await auditGeneratedPipelineQuality(result.pipelinePath);
  const missingMetadataUnderfit = missingMetadataAudit.diagnostics
    .find(item => item.code === 'AUTHORING_GRAPH_LINEAR_UNDERFIT');
  assert.equal(missingMetadataAudit.ok, false);
  assert.equal(missingMetadataUnderfit?.graphComplexity?.isLinearChain, true);
  assert.equal(missingMetadataUnderfit?.metadataGraphComplexity, null);
});

test('quality auditor fails removed or weakened per-task item evidence contracts', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-item-evidence-contract-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceSeed(workspace, 'Item evidence contract fixture');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: ORPAD_HARDENING_PROMPT,
    timestamp: '2026-05-24T12:10:00.000Z',
  });

  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const artifact = graph.graph.nodes.find(node => node.type === 'orpad.artifactContract');
  assert.ok(artifact?.config?.itemEvidenceContract, 'fixture should start with generated itemEvidenceContract');
  const originalContract = artifact.config.itemEvidenceContract;

  delete artifact.config.itemEvidenceContract;
  await fs.writeFile(result.graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');
  const missingAudit = await auditGeneratedPipelineQuality(result.pipelinePath);
  assert.equal(missingAudit.ok, false);
  assert.ok(missingAudit.diagnostics.some(item => item.code === 'AUTHORING_ITEM_EVIDENCE_CONTRACT_MISSING'));

  artifact.config.itemEvidenceContract = {
    ...originalContract,
    enforcement: 'not-hard-required-by-artifact-contract',
    requiredPerCompletedTask: originalContract.requiredPerCompletedTask
      .filter(field => field !== 'rootCause'),
  };
  await fs.writeFile(result.graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

  const weakAudit = await auditGeneratedPipelineQuality(result.pipelinePath);
  const weakCodes = weakAudit.diagnostics.map(item => item.code);
  assert.equal(weakAudit.ok, false);
  assert.ok(weakCodes.includes('AUTHORING_ITEM_EVIDENCE_CONTRACT_REQUIRED_FIELDS_MISSING'));
  assert.ok(weakCodes.includes('AUTHORING_ITEM_EVIDENCE_CONTRACT_ENFORCEMENT_WEAK'));
});

test('generator normalizes duplicate queue-drain conditions to one dispatcher branch', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-queue-drain-dedupe-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceSeed(workspace, 'Queue drain dedupe fixture');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Normalize duplicate queue-drain branches.',
    timestamp: '2026-05-24T10:40:00.000Z',
    authoringSpec: {
      title: 'Duplicate queue drain branch fixture',
      graph: {
        id: 'duplicate-queue-drain',
        label: 'Duplicate queue drain',
        start: 'entry',
        nodes: [
          { id: 'entry', type: 'orpad.entry', label: 'Entry' },
          { id: 'probe', type: 'orpad.probe', label: 'Probe work' },
          { id: 'queue', type: 'orpad.workQueue', label: 'Queue work' },
          { id: 'triage', type: 'orpad.triage', label: 'Triage work' },
          { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch work' },
          { id: 'worker', type: 'orpad.workerLoop', label: 'Do work' },
          { id: 'review', type: 'orpad.patchReview', label: 'Review work' },
          { id: 'gate', type: 'orpad.gate', label: 'Verify result', config: { criteria: ['queue drain dedupe evidence is recorded'], onFail: 'warn' } },
          { id: 'artifact', type: 'orpad.artifactContract', label: 'Record evidence' },
          { id: 'exit', type: 'orpad.exit', label: 'Exit' },
        ],
        transitions: [
          { from: 'entry', to: 'probe' },
          { from: 'probe', to: 'queue' },
          { from: 'queue', to: 'triage' },
          { from: 'triage', to: 'dispatch' },
          { from: 'dispatch', to: 'worker' },
          { from: 'worker', to: 'review' },
          { from: 'review', to: 'worker', condition: 'rejected' },
          { from: 'review', to: 'gate', condition: 'accepted' },
          { from: 'gate', to: 'triage', condition: 'queue-not-empty' },
          { from: 'gate', to: 'dispatch', condition: 'queue-not-empty' },
          { from: 'gate', to: 'artifact', condition: 'queue-empty' },
          { from: 'artifact', to: 'exit' },
        ],
      },
    },
  });

  assert.equal(result.qualityAudit.ok, true, JSON.stringify(result.qualityAudit.diagnostics, null, 2));
  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const queueNotEmpty = graph.graph.transitions
    .filter(edge => edge.from === 'gate' && edge.condition === 'queue-not-empty');
  assert.equal(queueNotEmpty.length, 1);
  assert.equal(queueNotEmpty[0].to, 'dispatch');
});

test('quality auditor fails generated queue-drain gates missing either drain branch', async (t) => {
  for (const omittedCondition of ['queue-empty', 'queue-not-empty']) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `orpad-queue-drain-missing-${omittedCondition}-`));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    await writeWorkspaceSeed(workspace, `Queue drain missing ${omittedCondition} fixture`);

    const result = await createOrchestrationPipeline({
      workspaceRoot: workspace,
      taskText: ORPAD_HARDENING_PROMPT,
      timestamp: `2026-05-24T11:${omittedCondition === 'queue-empty' ? '10' : '11'}:00.000Z`,
    });

    const graph = await readJson(result.graphPath);
    const finalGate = finalGateBeforeArtifact(graph);
    assert.ok(finalGate, 'fixture should expose a final verification gate before artifactContract');
    assert.ok(
      graph.graph.transitions.some(edge => edge.from === finalGate.id && edge.condition === omittedCondition),
      `fixture should start with a ${omittedCondition} branch`,
    );
    graph.graph.transitions = graph.graph.transitions
      .filter(edge => !(edge.from === finalGate.id && edge.condition === omittedCondition));
    await fs.writeFile(result.graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

    const audit = await auditGeneratedPipelineQuality(result.pipelinePath);
    const queueDrainDiagnostic = audit.diagnostics
      .find(item => item.code === 'AUTHORING_QUEUE_DRAIN_LOOP_MISSING');
    assert.equal(audit.ok, false);
    assert.ok(queueDrainDiagnostic, JSON.stringify(audit.diagnostics, null, 2));
    assert.equal(queueDrainDiagnostic.nodeId, finalGate.id);
  }
});

test('generator replay is deterministic for queue-drain and worker evidence contracts', async (t) => {
  const snapshots = [];

  for (let iteration = 0; iteration < REPLAY_RUN_COUNT; iteration += 1) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `orpad-authoring-replay-${iteration + 1}-`));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    await writeReplayWorkspaceSeed(workspace, `Authoring replay fixture ${iteration + 1}`);

    const result = await createOrchestrationPipeline({
      workspaceRoot: workspace,
      taskText: 'Replay queue-drain and worker evidence authoring with deterministic fixtures.',
      timestamp: REPLAY_TIMESTAMP,
      workspaceSnapshot: cloneJson(REPLAY_WORKSPACE_SNAPSHOT),
      authoringSpec: cloneJson(REPLAY_AUTHORING_SPEC),
    });

    assert.equal(result.qualityAudit.ok, true, JSON.stringify(result.qualityAudit.diagnostics, null, 2));
    const pipeline = await readJson(result.pipelinePath);
    const graphFile = await readJson(result.graphPath);
    const authoringSpec = await readJson(result.authoringSpecPath);
    const snapshot = normalizeReplaySnapshot({ pipeline, graphFile, authoringSpec });
    assertReplayContracts(snapshot, `replay ${iteration + 1}`);
    assert.equal(pipeline.metadata.graphComplexity.patternsDetected.includes('queue-drain-loop'), true);
    assert.equal(pipeline.metadata.graphComplexity.patternsDetected.includes('patch-review-reject-loop'), true);
    assert.equal(pipeline.metadata.graphComplexity.patternsDetected.includes('fork-join'), true);
    assert.equal(
      graphNodeById(graphFile, 'artifact')?.config?.itemEvidenceContract?.enforcement,
      'hard-required-by-artifact-contract',
    );
    snapshots.push(snapshot);
  }

  for (const snapshot of snapshots.slice(1)) {
    assert.deepEqual(snapshot, snapshots[0]);
  }
});

test('quality auditor fails duplicate decision conditions that target different nodes', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-decision-condition-ambiguous-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceSeed(workspace, 'Decision condition ambiguity fixture');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Fix a regression and verify the result.',
    timestamp: '2026-05-24T10:41:00.000Z',
  });

  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  graph.graph.transitions.push({
    id: 'ambiguous-queue-not-empty-to-triage',
    from: 'verification-gate',
    to: 'triage',
    condition: 'queue-not-empty',
  });
  await fs.writeFile(result.graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

  const audit = await auditGeneratedPipelineQuality(result.pipelinePath);
  const codes = audit.diagnostics.map(item => item.code);
  assert.equal(audit.ok, false);
  assert.ok(codes.includes('AUTHORING_DECISION_CONDITION_AMBIGUOUS'));
});

test('generation quality corpus covers multiple task classes without Threading Lecture overfit', async (t) => {
  const cases = [
    {
      title: 'Threading lecture clarity',
      taskText: 'Improve the threading lecture so students understand thread lifecycle, scheduling, and ThreadPool tradeoffs.',
      timestamp: '2026-05-18T10:00:00.000Z',
    },
    {
      title: 'Regression fix',
      taskText: 'Fix the login middleware regression and verify authentication tests do not break.',
      timestamp: '2026-05-18T10:01:00.000Z',
    },
    {
      title: 'Documentation rewrite',
      taskText: 'Rewrite the developer onboarding docs so a new maintainer can run and debug the project.',
      timestamp: '2026-05-18T10:02:00.000Z',
    },
    {
      title: 'External research guarded',
      taskText: 'Search for competing products and improve this workspace using only verified local or approved research evidence.',
      timestamp: '2026-05-18T10:03:00.000Z',
    },
    {
      title: 'Cross-module refactor',
      taskText: 'Refactor the import pipeline across services and preserve rollback, test evidence, and audit traces.',
      timestamp: '2026-05-18T10:04:00.000Z',
    },
  ];

  for (const item of cases) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-quality-corpus-'));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    await writeWorkspaceSeed(workspace, item.title);
    const result = await createOrchestrationPipeline({
      workspaceRoot: workspace,
      taskText: item.taskText,
      timestamp: item.timestamp,
    });
    assert.equal(result.qualityAudit.ok, true);
    await assertGeneratedPackageQuality(result);
  }
});

test('quality auditor fails mutated generated pipelines with unsafe runtime prose', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-quality-negative-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceSeed(workspace, 'Negative quality fixture');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Fix a regression and verify the result.',
    timestamp: '2026-05-18T10:10:00.000Z',
  });

  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const rejectedEdge = graph.graph.transitions.find(edge => edge.from === 'patch-review' && edge.condition === 'rejected');
  assert.ok(rejectedEdge, 'fixture should start with a canonical patchReview rejection edge');
  rejectedEdge.condition = 'reject because the patch still feels risky';
  await fs.writeFile(result.graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

  const audit = await auditGeneratedPipelineQuality(result.pipelinePath);
  const codes = audit.diagnostics.map(item => item.code);
  assert.equal(audit.ok, false);
  assert.ok(codes.includes('AUTHORING_RUNTIME_CONDITION_UNSAFE'));
  assert.ok(codes.includes('AUTHORING_PATCH_REVIEW_BRANCHING_MISSING'));
});

test('quality auditor fails patchReview rejected branches that skip worker repair', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-patch-review-reject-target-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceSeed(workspace, 'Patch review reject target fixture');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: ORPAD_HARDENING_PROMPT,
    timestamp: '2026-05-24T12:35:00.000Z',
  });

  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const rejectedEdge = graph.graph.transitions.find(edge => edge.from === 'patch-review' && edge.condition === 'rejected');
  assert.ok(rejectedEdge, 'fixture should start with a canonical patchReview rejection edge');
  rejectedEdge.to = 'artifact';
  await fs.writeFile(result.graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

  const complexity = analyzeGraphComplexity(graph.graph.nodes, graph.graph.transitions);
  assert.equal(complexity.patternsDetected.includes('patch-review-reject-loop'), false);

  const audit = await auditGeneratedPipelineQuality(result.pipelinePath);
  const codes = audit.diagnostics.map(item => item.code);
  assert.equal(audit.ok, false);
  assert.ok(codes.includes('AUTHORING_PATCH_REVIEW_REJECT_TARGET_UNSAFE'));
});

test('quality auditor fails unsupported barrier partial failure policies before runtime', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-quality-barrier-policy-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceSeed(workspace, 'Barrier policy quality fixture');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Coordinate parallel platform probes and merge their evidence.',
    timestamp: '2026-05-18T10:12:00.000Z',
  });

  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const waitFor = graph.graph.nodes[0]?.id || 'entry';
  graph.graph.nodes.push({
    id: 'bad-barrier-policy',
    type: 'orpad.barrier',
    label: 'Bad Barrier Policy',
    config: {
      waitFor: [waitFor],
      onPartialFailure: 'retry-missing-lens-until-timebox',
    },
  });
  await fs.writeFile(result.graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

  const audit = await auditGeneratedPipelineQuality(result.pipelinePath);
  const codes = audit.diagnostics.map(item => item.code);
  assert.equal(audit.ok, false);
  assert.ok(codes.includes('AUTHORING_BARRIER_ON_PARTIAL_FAILURE_UNSUPPORTED'));
});

test('quality auditor fails graph node-pack references missing from pipeline declarations', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-node-pack-reference-audit-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceSeed(workspace, 'Node pack reference audit fixture');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Fix a regression and verify the result.',
    timestamp: '2026-05-18T10:15:00.000Z',
  });

  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const probe = graph.graph.nodes.find(node => node.type === 'orpad.probe');
  probe.config = {
    ...(probe.config || {}),
    sourceNodePack: 'orpad.starter.content-qa',
  };
  await fs.writeFile(result.graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  pipeline.nodePacks = pipeline.nodePacks.filter(pack => pack.id !== 'orpad.starter.content-qa');
  await fs.writeFile(result.pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`, 'utf-8');

  const audit = await auditGeneratedPipelineQuality(result.pipelinePath);
  const codes = audit.diagnostics.map(item => item.code);
  assert.equal(audit.ok, false);
  assert.ok(codes.includes('AUTHORING_NODE_PACK_REFERENCE_UNDECLARED'));
});

test('quality auditor fails selected node packs missing generated graph provenance', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-node-pack-provenance-audit-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceSeed(workspace, 'Node pack provenance audit fixture');
  await fs.mkdir(path.join(workspace, 'src/main'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'src/renderer'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'electron-builder.yml'), 'appId: dev.orpad.fixture\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'SECURITY.md'), '# Security\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'src/main/preload.js'), 'module.exports = {};\n', 'utf-8');
  await fs.writeFile(path.join(workspace, 'src/renderer/renderer.js'), 'console.log("fixture");\n', 'utf-8');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Review Electron preload IPC security before release and verify renderer packaging risks.',
    timestamp: '2026-05-18T10:16:00.000Z',
    workspaceSnapshot: {
      files: [
        'SECURITY.md',
        'electron-builder.yml',
        'src/main/preload.js',
        'src/renderer/renderer.js',
      ],
    },
  });

  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  const selectedIds = pipeline.metadata.orchestrationAuthoring.nodePackSelection.map(pack => pack.id);
  const missingPackId = selectedIds.find(id => id !== selectedIds[0]);
  assert.ok(missingPackId, 'fixture should select at least two node packs');

  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const provenanceTypes = new Set(['orpad.context', 'orpad.probe', 'orpad.gate', 'orpad.workerLoop', 'orpad.artifactContract']);
  for (const node of graph.graph.nodes.filter(item => provenanceTypes.has(item.type))) {
    node.config.supportingNodePacks = (node.config.supportingNodePacks || [])
      .filter(id => id !== missingPackId);
  }
  await fs.writeFile(result.graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

  const audit = await auditGeneratedPipelineQuality(result.pipelinePath);
  const provenanceDiagnostics = audit.diagnostics
    .filter(item => item.code === 'AUTHORING_NODE_PACK_PROVENANCE_MISSING' && item.nodePackId === missingPackId);
  assert.equal(audit.ok, false);
  assert.deepEqual(
    new Set(provenanceDiagnostics.map(item => item.surface)),
    new Set(['context', 'probe', 'verification-gate', 'worker', 'artifact']),
  );
});

test('quality auditor validates generated pipelines that declare installed user node packs', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-quality-installed-node-pack-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceSeed(workspace, 'Installed node pack quality fixture');
  const userRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-quality-user-node-packs-'));
  t.after(() => fs.rm(userRoot, { recursive: true, force: true }));
  const userPack = communityQualityPack();
  await writeUserNodePack(userRoot, userPack);

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Fix a reporting workflow regression and verify the targeted files.',
    timestamp: '2026-05-18T10:16:30.000Z',
  });

  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  pipeline.nodePacks = [
    ...(Array.isArray(pipeline.nodePacks) ? pipeline.nodePacks : []),
    {
      id: userPack.id,
      version: '>=0.1.0',
      origin: 'user',
      trustLevel: 'signed',
      source: userPack.author.repository,
      resolutionState: 'resolved',
      validationStatus: 'valid',
      capabilityRiskSummary: 'no high-risk capabilities requested',
      capabilities: ['read.workspace'],
    },
  ];
  const authoring = pipeline.metadata?.orchestrationAuthoring || {};
  authoring.nodePackSelection = [
    ...(Array.isArray(authoring.nodePackSelection) ? authoring.nodePackSelection : []),
    {
      id: userPack.id,
      name: userPack.name,
      version: userPack.version,
      origin: 'user',
      trustLevel: 'signed',
      validationStatus: 'valid',
      matchedSignals: ['test:installed-user-pack'],
    },
  ];
  pipeline.metadata = {
    ...(pipeline.metadata || {}),
    orchestrationAuthoring: authoring,
  };
  await fs.writeFile(result.pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`, 'utf-8');

  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const provenanceTypes = new Set(['orpad.context', 'orpad.probe', 'orpad.gate', 'orpad.workerLoop', 'orpad.artifactContract']);
  for (const node of graph.graph.nodes.filter(item => provenanceTypes.has(item.type))) {
    const config = node.config || {};
    node.config = {
      ...config,
      supportingNodePacks: [...new Set([
        ...(Array.isArray(config.supportingNodePacks) ? config.supportingNodePacks : []),
        userPack.id,
      ])],
    };
  }
  await fs.writeFile(result.graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

  const audit = await auditGeneratedPipelineQuality(result.pipelinePath, {
    userNodePacksRoot: userRoot,
    trustEvidenceByPack: {
      [userPack.id]: { signature: { verified: true } },
    },
    includeValidation: true,
  });
  const codes = new Set(audit.diagnostics.map(item => item.code));

  assert.equal(audit.ok, true, JSON.stringify(audit.diagnostics, null, 2));
  const validationPack = audit.validation.nodePacks.find(pack => pack.id === userPack.id);
  assert.equal(validationPack.origin, 'user');
  assert.equal(validationPack.requestedTrustLevel, 'signed');
  assert.equal(validationPack.requestedSource, userPack.author.repository);
  assert.equal(validationPack.requestedValidationStatus, 'valid');
  assert.equal(validationPack.requestedResolutionState, 'resolved');
  assert.deepEqual(validationPack.declaredCapabilities, ['read.workspace']);
  assert.equal(codes.has('PIPELINE_NODE_PACK_UNKNOWN'), false);
  assert.equal(codes.has('AUTHORING_NODE_PACK_PROVENANCE_MISSING'), false);
});

test('quality auditor fails content pipelines missing a final editorial gate', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-content-editorial-missing-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceSeed(workspace, 'Content editorial audit fixture');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Rewrite the onboarding docs and tutorial slides for clearer maintainer learning material.',
    timestamp: '2026-05-18T10:17:00.000Z',
  });

  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  graph.graph.nodes = graph.graph.nodes.filter(node => node.id !== 'content-editorial-quality-gate');
  graph.graph.transitions = graph.graph.transitions
    .filter(edge => edge.from !== 'content-editorial-quality-gate')
    .map(edge => (
      edge.to === 'content-editorial-quality-gate'
        ? { ...edge, to: 'verification-gate' }
        : edge
    ));
  await fs.writeFile(result.graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

  const audit = await auditGeneratedPipelineQuality(result.pipelinePath);
  const codes = audit.diagnostics.map(item => item.code);
  assert.equal(audit.ok, false);
  assert.ok(codes.includes('AUTHORING_CONTENT_EDITORIAL_GATE_MISSING'));
});

test('quality auditor fails content pipelines with a weak editorial gate', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-content-editorial-weak-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceSeed(workspace, 'Weak content editorial audit fixture');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Improve documentation tutorial content and course slides for onboarding.',
    timestamp: '2026-05-18T10:18:00.000Z',
  });

  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const gate = graph.graph.nodes.find(node => node.id === 'content-editorial-quality-gate');
  assert.ok(gate, 'fixture should include the generated editorial gate');
  gate.label = 'Check content';
  gate.config = { criteria: ['Content checked'], onFail: 'warn' };
  await fs.writeFile(result.graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

  const audit = await auditGeneratedPipelineQuality(result.pipelinePath);
  const codes = audit.diagnostics.map(item => item.code);
  assert.equal(audit.ok, false);
  assert.ok(codes.includes('AUTHORING_CONTENT_EDITORIAL_GATE_WEAK'));
});

test('quality auditor fails LLM content judge policies without judge artifact configuration', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-content-editorial-judge-config-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceSeed(workspace, 'LLM content editorial judge config fixture');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Improve documentation tutorial content and course slides for onboarding.',
    timestamp: '2026-05-18T10:19:00.000Z',
  });

  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const gate = graph.graph.nodes.find(node => node.id === 'content-editorial-quality-gate');
  assert.ok(gate, 'fixture should include the generated editorial gate');
  gate.config.judgePolicy = 'llm-required';
  delete gate.config.expectedJudgeArtifacts;
  delete gate.config.judgeArtifacts;
  delete gate.config.judgeResultArtifacts;
  await fs.writeFile(result.graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

  const audit = await auditGeneratedPipelineQuality(result.pipelinePath);
  const codes = audit.diagnostics.map(item => item.code);
  assert.equal(audit.ok, false);
  assert.ok(codes.includes('AUTHORING_CONTENT_EDITORIAL_EVALUATOR_CONTRACT_WEAK'));
});

test('generator normalizes LLM-authored skill config.ref aliases before validation', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-skill-alias-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceSeed(workspace, 'Skill alias fixture');

  const authoringSpec = {
    title: 'Skill alias fixture',
    graph: {
      id: 'skill-alias',
      label: 'Skill alias',
      start: 'entry',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        { id: 'teaching-skill', type: 'orpad.skill', label: 'Use generated skill', config: { ref: 'request-context' } },
        { id: 'probe', type: 'orpad.probe', label: 'Probe work' },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue work' },
        { id: 'triage', type: 'orpad.triage', label: 'Triage work' },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch work' },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Do work' },
        { id: 'review', type: 'orpad.patchReview', label: 'Review work' },
        { id: 'gate', type: 'orpad.gate', label: 'Verify work', config: { criteria: ['skill alias fixture evidence is recorded'], onFail: 'warn' } },
        { id: 'artifact', type: 'orpad.artifactContract', label: 'Record evidence' },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'teaching-skill' },
        { from: 'teaching-skill', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'review' },
        { from: 'review', to: 'gate', condition: 'accepted' },
        { from: 'review', to: 'worker', condition: 'rejected' },
        { from: 'gate', to: 'triage', condition: 'queue-not-empty' },
        { from: 'gate', to: 'artifact', condition: 'queue-empty' },
        { from: 'artifact', to: 'exit' },
      ],
    },
  };

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Normalize skill alias',
    authoringSpec,
    timestamp: '2026-05-18T10:20:00.000Z',
  });
  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  const skill = graph.graph.nodes.find(node => node.id === 'teaching-skill');
  assert.equal(skill.config.skillRef, 'request-context');
  assert.equal(skill.config.ref, undefined);
  assert.equal(skill.config.refOriginal, 'request-context');
  await assertGeneratedPackageQuality(result);
});

test('quality auditor fails when inline sub-graph probes are omitted from machine adapter fanout', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-subgraph-probe-audit-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceSeed(workspace, 'Subgraph probe audit fixture');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Audit subgraph probe fanout',
    timestamp: '2026-05-18T10:30:00.000Z',
    authoringSpec: {
      title: 'Subgraph probe fanout',
      graph: {
        id: 'parent',
        label: 'Parent',
        start: 'entry',
        nodes: [
          { id: 'entry', type: 'orpad.entry', label: 'Entry' },
          { id: 'main-probe', type: 'orpad.probe', label: 'Main probe' },
          { id: 'inner', type: 'orpad.graph', label: 'Inner probe graph', config: { graphRef: 'inner.or-graph', executionMode: 'inline' } },
          { id: 'queue', type: 'orpad.workQueue', label: 'Queue work' },
          { id: 'triage', type: 'orpad.triage', label: 'Triage work' },
          { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch work' },
          { id: 'worker', type: 'orpad.workerLoop', label: 'Do work' },
          { id: 'review', type: 'orpad.patchReview', label: 'Review work' },
          { id: 'gate', type: 'orpad.gate', label: 'Verify work', config: { criteria: ['subgraph probe evidence is included'], onFail: 'warn' } },
          { id: 'artifact', type: 'orpad.artifactContract', label: 'Record evidence' },
          { id: 'exit', type: 'orpad.exit', label: 'Exit' },
        ],
        transitions: [
          { from: 'entry', to: 'main-probe' },
          { from: 'main-probe', to: 'inner' },
          { from: 'inner', to: 'queue' },
          { from: 'queue', to: 'triage' },
          { from: 'triage', to: 'dispatch' },
          { from: 'dispatch', to: 'worker' },
          { from: 'worker', to: 'review' },
          { from: 'review', to: 'gate', condition: 'accepted' },
          { from: 'review', to: 'worker', condition: 'rejected' },
          { from: 'gate', to: 'triage', condition: 'queue-not-empty' },
          { from: 'gate', to: 'artifact', condition: 'queue-empty' },
          { from: 'artifact', to: 'exit' },
        ],
      },
      subgraphs: [{
        ref: 'inner.or-graph',
        graph: {
          id: 'inner',
          label: 'Inner',
          start: 'inner-entry',
          nodes: [
            { id: 'inner-entry', type: 'orpad.entry', label: 'Inner entry' },
            { id: 'inner-probe', type: 'orpad.probe', label: 'Inner probe' },
            { id: 'inner-gate', type: 'orpad.gate', label: 'Inner gate', config: { criteria: ['inner probe produced evidence'], onFail: 'warn' } },
            { id: 'inner-exit', type: 'orpad.exit', label: 'Inner exit' },
          ],
          transitions: [
            { from: 'inner-entry', to: 'inner-probe' },
            { from: 'inner-probe', to: 'inner-gate' },
            { from: 'inner-gate', to: 'inner-exit', condition: 'pass' },
          ],
        },
      }],
    },
  });

  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  assert.ok(pipeline.run.machineAdapter.probeNodePaths.includes('main/main-probe'));
  assert.ok(pipeline.run.machineAdapter.probeNodePaths.includes('inner/inner-probe'));
  pipeline.run.machineAdapter.probeNodePaths = ['main/main-probe'];
  await fs.writeFile(result.pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`, 'utf-8');

  const audit = await auditGeneratedPipelineQuality(result.pipelinePath);
  assert.equal(audit.ok, false);
  assert.ok(audit.diagnostics.some(item => item.code === 'AUTHORING_ADAPTER_PROBES_INCOMPLETE'));
});

test('quality auditor fails generated live adapters with unsafe worker concurrency', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-quality-concurrency-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await writeWorkspaceSeed(workspace, 'Unsafe concurrency fixture');

  const result = await createOrchestrationPipeline({
    workspaceRoot: workspace,
    taskText: 'Improve local docs through a generated managed run.',
    timestamp: '2026-05-18T10:30:00.000Z',
  });

  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  pipeline.run.machineAdapter.claimPolicy.concurrency = 'all';
  pipeline.run.queueProtocol.claimPolicy.concurrency = 'all';
  await fs.writeFile(result.pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`, 'utf-8');

  const audit = await auditGeneratedPipelineQuality(result.pipelinePath);
  assert.equal(audit.ok, false);
  assert.ok(audit.diagnostics.some(item => item.code === 'AUTHORING_WORKER_CONCURRENCY_UNSAFE'));
  assert.ok(audit.diagnostics.some(item => item.code === 'AUTHORING_QUEUE_PROTOCOL_CONCURRENCY_UNSAFE'));
});
