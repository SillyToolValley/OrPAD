import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'bin', 'orpad-cli.mjs');

test('orpad generate writes an orchestration-focused pipeline package', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-authoring-cli-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, 'README.md'), '# CLI fixture\n', 'utf-8');

  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    'generate',
    '--workspace',
    workspace,
    '--prompt',
    'Search for competing products and improve this workspace.',
    '--timestamp',
    '2026-05-08T00:00:00.000Z',
    '--json',
  ], { encoding: 'utf-8' });
  const result = JSON.parse(stdout);
  assert.equal(result.success, true);
  assert.match(result.pipelinePath, /pipeline\.or-pipeline$/);
  assert.match(result.graphPath, /main\.or-graph$/);

  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  assert.equal(pipeline.metadata.orchestrationAuthoring.tool, 'orpad-cli');
  assert.equal(pipeline.metadata.orchestrationAuthoring.focus, 'orchestration-authoring');
  assert.equal(pipeline.metadata.orchestrationAuthoring.mode, 'deterministic-fallback');
  assert.equal(pipeline.metadata.orchestrationAuthoring.qualityAudit.ok, true);
  assert.equal(pipeline.metadata.orchestrationAuthoring.qualityAudit.summary.errorCount, 0);
  assert.match(pipeline.metadata.externalResearch.limitation, /external competitor claims require approved browsing/);
  assert.equal(pipeline.run.machineAdapter.type, 'codex-cli');
  assert.deepEqual(pipeline.run.machineAdapter.claimPolicy, { concurrency: 1 });
  assert.equal(pipeline.run.queueProtocol.schema, 'orpad.workItem.v1');
  assert.deepEqual(pipeline.run.queueProtocol.states, ['candidate', 'queued', 'claimed', 'done', 'blocked', 'rejected']);

  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  assert.deepEqual(graph.graph.nodes.map(node => node.type), [
    'orpad.entry',
    'orpad.context',
    'orpad.selector',
    'orpad.probe',
    'orpad.workQueue',
    'orpad.triage',
    'orpad.dispatcher',
    'orpad.workerLoop',
    'orpad.patchReview',
    'orpad.gate',
    'orpad.artifactContract',
    'orpad.exit',
  ]);
  assert.deepEqual(
    graph.graph.nodes.find(node => node.type === 'orpad.workerLoop').config.targetFiles,
    [],
  );
  const patchReviewEdges = graph.graph.transitions.filter(edge => edge.from === 'patch-review');
  assert.equal(patchReviewEdges.some(edge => edge.to === 'worker' && edge.condition === 'rejected'), true);
  assert.equal(patchReviewEdges.some(edge => edge.to === 'verification-gate' && edge.condition === 'accepted'), true);
  const verificationEdges = graph.graph.transitions.filter(edge => edge.from === 'verification-gate');
  assert.equal(verificationEdges.some(edge => edge.to === 'worker' && edge.condition === 'revise'), true);
  assert.equal(verificationEdges.some(edge => edge.to === 'triage' && edge.condition === 'queue-not-empty'), true);
  assert.equal(verificationEdges.some(edge => edge.to === 'artifact' && edge.condition === 'queue-empty'), true);

  const prompt = await fs.readFile(result.promptPath, 'utf-8');
  assert.match(prompt, /Return ONLY valid JSON/i);
  // The strengthened authoring prompt now ships an explicit Pattern Catalog,
  // a Node Catalog covering the 17 authored types, and a Self-Critique
  // checklist. Without these markers the prompt has regressed to its
  // pre-strengthening state and the model will fall back to a flat linear
  // chain on most requests.
  assert.match(prompt, /Pattern Catalog/);
  assert.match(prompt, /Self-Critique checklist/);
  assert.match(prompt, /Ralph Loop/);
  assert.match(prompt, /Fork-Join Parallelism/);
  assert.match(prompt, /Cross-Validation/);
  assert.match(prompt, /Behavior Tree Sub-graph/);
  assert.match(prompt, /Orchestration Quality Rubric/);
  assert.match(prompt, /Reference Patterns To Learn From/);
  assert.match(prompt, /LangGraph-style stateful graph/);
  assert.match(prompt, /OpenAI Agents SDK style/);
  assert.match(prompt, /Microsoft Agent Framework/);
  assert.match(prompt, /Anthropic effective-agent patterns/);
  assert.match(prompt, /Node Catalog/);
  assert.match(prompt, /targetFiles: \[\]/);
  assert.match(prompt, /services\/service-a\/auth\/middleware\.js/);

  // Generated pipelines should now carry a graphComplexity report so that
  // downstream UI can warn when a request produced a flat chain.
  assert.equal(typeof pipeline.metadata.graphComplexity, 'object');
  assert.equal(typeof pipeline.metadata.graphComplexity.nodeCount, 'number');
  assert.ok(Array.isArray(pipeline.metadata.graphComplexity.patternsDetected));
  assert.equal(pipeline.metadata.graphComplexity.isLinearChain, false);
  assert.equal(pipeline.metadata.graphComplexity.hasQueueDrainLoop, true);
  assert.ok(pipeline.metadata.graphComplexity.patternsDetected.includes('queue-drain-loop'));
  assert.ok(pipeline.metadata.graphComplexity.patternsDetected.includes('patch-review-reject-loop'));
});

test('orpad generate materializes an LLM-authored orchestration spec', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-authoring-spec-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, 'README.md'), '# CLI fixture\n', 'utf-8');
  const specPath = path.join(workspace, 'authoring-spec.json');
  await fs.writeFile(specPath, JSON.stringify({
    title: 'Lecture Clarity Pipeline',
    description: 'Task-specific graph for improving threading lecture material.',
    graph: {
      id: 'lecture-clarity',
      label: 'Lecture clarity flow',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        { id: 'map-units', type: 'orpad.context', label: 'Map lecture units', config: { summary: 'Inspect Unit slides and labs.' } },
        { id: 'find-confusion', type: 'orpad.probe', label: 'Find confusing threading explanations', config: { lens: 'lecture-comprehension', maxCandidates: 7 } },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue lecture fixes' },
        { id: 'triage', type: 'orpad.triage', label: 'Prioritize learning impact' },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch lecture fix' },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Revise lecture material' },
        { id: 'verify-learning', type: 'orpad.gate', label: 'Verify learning outcome', config: { criteria: ['slides explain thread lifecycle'], onFail: 'warn' } },
        {
          id: 'artifact',
          type: 'orpad.artifactContract',
          label: 'Record teaching evidence',
          config: {
            required: ['analysis/lecture-gap-map.md', 'verification/dotnet-log.md'],
            requiredQueue: ['journal.jsonl'],
          },
        },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [],
    },
    skill: {
      acceptanceCriteria: ['slides explain thread lifecycle'],
    },
    metadata: {
      authoringNotes: 'Lecture-specific context/probe/verification nodes.',
    },
  }, null, 2), 'utf-8');

  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    'generate',
    '--workspace',
    workspace,
    '--prompt',
    'Improve the threading lecture so students understand lifecycle and scheduling.',
    '--timestamp',
    '2026-05-08T00:00:00.000Z',
    '--authoring-spec-file',
    specPath,
    '--json',
  ], { encoding: 'utf-8' });
  const result = JSON.parse(stdout);
  assert.equal(result.success, true);
  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
  assert.equal(pipeline.title, 'Lecture Clarity Pipeline');
  assert.equal(pipeline.metadata.orchestrationAuthoring.mode, 'llm-authored-spec');
  assert.equal(pipeline.metadata.orchestrationAuthoring.qualityAudit.ok, true);
  assert.equal(result.qualityAudit.ok, true);
  assert.deepEqual(pipeline.run.machineAdapter.probeNodePaths, ['main/find-confusion']);
  assert.equal(pipeline.run.machineAdapter.workerNodePath, 'main/worker');
  assert.deepEqual(pipeline.run.machineAdapter.claimPolicy, { concurrency: 1 });
  assert.deepEqual(graph.graph.nodes.map(node => node.label).slice(1, 4), [
    'Map lecture units',
    'Find confusing threading explanations',
    'Queue lecture fixes',
  ]);
  const orderedIds = graph.graph.nodes.map(node => node.id);
  assert.ok(orderedIds.indexOf('patch-review') > orderedIds.indexOf('worker'));
  assert.ok(orderedIds.indexOf('patch-review') < orderedIds.indexOf('content-editorial-quality-gate'));
  assert.ok(orderedIds.indexOf('content-editorial-quality-gate') < orderedIds.indexOf('verify-learning'));
  assert.ok(orderedIds.indexOf('verify-learning') < orderedIds.indexOf('artifact'));
  assert.ok(orderedIds.indexOf('artifact') < orderedIds.indexOf('exit'));
  const patchReviewEdges = graph.graph.transitions.filter(edge => edge.from === 'patch-review');
  assert.equal(patchReviewEdges.some(edge => edge.to === 'worker' && edge.condition === 'rejected'), true);
  assert.equal(patchReviewEdges.some(edge => edge.to === 'content-editorial-quality-gate' && edge.condition === 'accepted'), true);
  const editorialGateEdges = graph.graph.transitions.filter(edge => edge.from === 'content-editorial-quality-gate');
  assert.equal(editorialGateEdges.some(edge => edge.to === 'verify-learning' && edge.condition === 'pass'), true);
  const gateEdges = graph.graph.transitions.filter(edge => edge.from === 'verify-learning');
  assert.equal(gateEdges.some(edge => edge.to === 'worker' && edge.condition === 'revise'), true);
  assert.equal(gateEdges.some(edge => edge.to === 'triage' && edge.condition === 'queue-not-empty'), true);
  assert.equal(gateEdges.some(edge => edge.to === 'artifact' && edge.condition === 'queue-empty'), true);
  assert.equal(graph.graph.nodes.find(node => node.id === 'find-confusion').config.maxCandidates, 7);
  assert.deepEqual(graph.graph.nodes.find(node => node.id === 'worker').config.targetFiles, []);
  const artifactNode = graph.graph.nodes.find(node => node.id === 'artifact');
  assert.deepEqual(artifactNode.config.required, ['discovery/candidate-inventory.json']);
  assert.deepEqual(artifactNode.config.requiredQueue, ['journal.jsonl']);
  assert.deepEqual(artifactNode.config.authoredEvidenceExpectations.artifacts, ['analysis/lecture-gap-map.md', 'verification/dotnet-log.md']);
  const skill = await fs.readFile(result.skillPath, 'utf-8');
  assert.match(skill, /slides explain thread lifecycle/);
});

test('orpad generate uses workspace file snapshot for node pack selection', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-cli-snapshot-pack-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const labDir = path.join(workspace, 'ThreadProgramming/Unit3/Lab05_Semaphore');
  await fs.mkdir(labDir, { recursive: true });
  await fs.writeFile(path.join(workspace, 'README.md'), '# Threading course\n', 'utf-8');
  await fs.writeFile(path.join(labDir, 'README.md'), '# Lab\n', 'utf-8');
  await fs.writeFile(path.join(labDir, 'Program.cs'), 'Console.WriteLine("lab");\n', 'utf-8');
  await fs.writeFile(path.join(labDir, 'Lab05_Semaphore.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />\n', 'utf-8');

  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    'generate',
    '--workspace',
    workspace,
    '--prompt',
    'Improve the lecture labs and repair stale learning material.',
    '--timestamp',
    '2026-05-20T01:30:00.000Z',
    '--json',
  ], { encoding: 'utf-8' });
  const result = JSON.parse(stdout);
  assert.equal(result.success, true);

  const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
  const prompt = await fs.readFile(result.promptPath, 'utf-8');
  const selected = pipeline.metadata.orchestrationAuthoring.nodePackSelection;

  assert.equal(selected[0].id, 'orpad.starter.dotnet-lab-code');
  assert.ok(selected[0].matchedSignals.some(signal => signal.startsWith('workspace:**/*.cs')));
  assert.match(prompt, /ThreadProgramming\/Unit3\/Lab05_Semaphore\/Program\.cs/);
});

test('orpad node-packs list reports built-in and user node pack pools', async (t) => {
  const userRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-cli-node-packs-'));
  t.after(() => fs.rm(userRoot, { recursive: true, force: true }));
  const packDir = path.join(userRoot, 'community.cli-pack');
  await fs.mkdir(packDir, { recursive: true });
  await fs.writeFile(path.join(packDir, 'orpad.node-pack.json'), JSON.stringify({
    kind: 'orpad.nodePack',
    schemaVersion: '1.0',
    id: 'community.cli-pack',
    name: 'CLI Community Pack',
    version: '0.1.0',
    origin: 'community',
    trustLevel: 'signed',
    compatibility: {
      orpad: '>=1.0.0-beta.3',
      packFormat: 'orpad.nodePack.v1',
    },
    capabilities: ['read.workspace'],
    nodes: [{
      type: 'community.cliNode',
      path: 'nodes/cli-node.or-node',
      runtimeHandlerKind: 'metadata-only',
      capabilities: ['read.workspace'],
    }],
    graphs: [],
    skills: [],
    rules: [],
    examples: [],
  }, null, 2), 'utf-8');

  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    'node-packs',
    'list',
    '--user-node-packs',
    userRoot,
    '--json',
  ], { encoding: 'utf-8' });
  const result = JSON.parse(stdout);
  const ids = result.nodePacks.map(pack => pack.id);

  assert.equal(result.success, true);
  assert.equal(result.ok, true);
  assert.equal(ids.includes('orpad.core'), true);
  assert.equal(ids.includes('orpad.starter.electron-maintenance'), true);
  assert.equal(ids.includes('community.cli-pack'), true);
  const communityPack = result.nodePacks.find(pack => pack.id === 'community.cli-pack');
  assert.deepEqual(communityPack.nodeTypes, ['community.cliNode']);
  assert.equal(communityPack.location.endsWith('community.cli-pack'), true);
});
