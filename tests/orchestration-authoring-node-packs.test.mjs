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
const { authoringAgentPrompt } = require(path.join(repoRoot, 'src/main/orchestration-authoring/ipc.js'));
const { selectAuthoringNodePacks } = require(path.join(repoRoot, 'src/main/orchestration-machine/node-packs.js'));

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

  assert.equal(result.qualityAudit.ok, true);
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
  assert.equal(probeNode.config.lens, 'electron-maintenance');
  assert.equal(probeNode.config.sourceNodePackGraph, 'electron-maintenance-workstream');
  assert.equal(workerNode.config.supportingNodePacks.includes('orpad.starter.security-review'), true);
  assert.equal(gateNode.config.criteria.some(item => /Electron main\/preload\/renderer/.test(item)), true);

  assert.equal(rule.include.includes('src/main/**'), true);
  assert.equal(rule.include.includes('electron-builder.yml'), true);
  assert.match(skill, /IPC and preload changes preserve least-authority boundaries/);
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
