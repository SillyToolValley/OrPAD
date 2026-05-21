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
const { auditGeneratedPipelineQuality } = require(path.join(repoRoot, 'src/main/orchestration-authoring/quality-audit.js'));

const PLACEHOLDER_PATTERN = /TODO\s*(?:\u2014|-)?\s*author|Placeholder created by generator|Placeholder leaf|TODO placeholder/i;

async function writeWorkspaceSeed(workspace, title) {
  await fs.writeFile(path.join(workspace, 'README.md'), `# ${title}\n\nFixture workspace for OrPAD authoring quality tests.\n`, 'utf-8');
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }, null, 2), 'utf-8');
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

  const structuralFiles = await collectFiles(result.pipelineDir, ['.or-graph', '.or-tree']);
  assert.ok(structuralFiles.length >= audit.summary.graphCount);
  for (const file of structuralFiles) {
    const text = await fs.readFile(file, 'utf-8');
    assert.equal(PLACEHOLDER_PATTERN.test(text), false, `${file} contains placeholder authoring text`);
  }
}

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
