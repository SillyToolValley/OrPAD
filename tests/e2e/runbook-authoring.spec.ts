import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchElectron } from '../helpers';

function writeApprovedWorkspace(userData: string, workspaceRoot: string): void {
  fs.writeFileSync(path.join(userData, 'approved-workspace.json'), JSON.stringify({
    version: 1,
    workspaceRoot,
  }));
}

function writeFakeCodexAuthoringCli(workspace: string): string {
  const scriptPath = path.join(workspace, 'fake-codex-authoring.js');
  fs.writeFileSync(scriptPath, `
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error('missing --output-last-message');
const outputPath = args[outputIndex + 1];
const prompt = args[args.length - 1] === '-' ? fs.readFileSync(0, 'utf8') : (args[args.length - 1] || '');
const match = prompt.match(/<orpad-authoring-input>\\s*([\\s\\S]*?)\\s*<\\/orpad-authoring-input>/);
if (!match) throw new Error('missing authoring input');
const input = JSON.parse(match[1]);
fs.mkdirSync(path.dirname(input.authoringSpecPath), { recursive: true });
const spec = {
  title: 'Competitive Improvement Pipeline',
  description: 'LLM-authored graph for competitive product improvement work.',
  graph: {
    id: 'competitive-improvement',
    label: 'Competitive improvement flow',
    start: 'entry',
    nodes: [
      { id: 'entry', type: 'orpad.entry', label: 'Entry' },
      { id: 'map-product-surface', type: 'orpad.context', label: 'Map product surface', config: { summary: 'Inspect workspace features, UI paths, and existing OrPAD pipeline behavior.' } },
      { id: 'external-research-mode', type: 'orpad.selector', label: 'Confirm competitive research mode', config: { selector: 'externalResearchMode', options: ['local-only-research-gap', 'approved-or-attached-evidence'], default: 'local-only-research-gap' } },
      { id: 'find-competitive-gaps', type: 'orpad.probe', label: 'Find competitive improvement gaps', config: { lens: 'competitive-product-gap', maxCandidates: 5, candidateLimitPolicy: 'collect-all-visible' } },
      { id: 'queue-competitive-work', type: 'orpad.workQueue', label: 'Queue competitive work' },
      { id: 'triage-competitive-work', type: 'orpad.triage', label: 'Prioritize competitive impact' },
      { id: 'dispatch-competitive-work', type: 'orpad.dispatcher', label: 'Dispatch competitive work' },
      { id: 'worker', type: 'orpad.workerLoop', label: 'Implement competitive improvement' },
      { id: 'patch-review', type: 'orpad.patchReview', label: 'Review competitive patch' },
      { id: 'competitive-verification', type: 'orpad.gate', label: 'Verify competitive improvement', config: { criteria: ['local evidence backs competitive claims', 'implementation improves target workflow'], onFail: 'warn' } },
      { id: 'artifact', type: 'orpad.artifactContract', label: 'Record competitive evidence' },
      { id: 'exit', type: 'orpad.exit', label: 'Exit' }
    ],
    transitions: [
      { from: 'entry', to: 'map-product-surface' },
      { from: 'map-product-surface', to: 'external-research-mode' },
      { from: 'external-research-mode', to: 'find-competitive-gaps' },
      { from: 'find-competitive-gaps', to: 'queue-competitive-work' },
      { from: 'queue-competitive-work', to: 'triage-competitive-work' },
      { from: 'triage-competitive-work', to: 'dispatch-competitive-work' },
      { from: 'dispatch-competitive-work', to: 'worker' },
      { from: 'worker', to: 'patch-review' },
      { from: 'patch-review', to: 'competitive-verification' },
      { from: 'competitive-verification', to: 'artifact' },
      { from: 'artifact', to: 'exit' }
    ]
  },
  skill: {
    acceptanceCriteria: ['local evidence backs competitive claims', 'implementation improves target workflow']
  },
  metadata: {
    authoringNotes: 'Fake Codex authoring agent wrote this spec, then invoked OrPAD CLI.'
  }
};
fs.writeFileSync(input.authoringSpecPath, JSON.stringify(spec, null, 2));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 650);
const stdout = childProcess.execFileSync(process.execPath, [
  input.orpadCliPath,
  'generate',
  '--workspace',
  input.workspaceRoot,
  '--prompt-file',
  input.promptFile,
  '--authoring-spec-file',
  input.authoringSpecPath,
  '--json'
], { encoding: 'utf-8' });
fs.writeFileSync(outputPath, stdout);
process.stdout.write(stdout);
`, 'utf-8');
  return scriptPath;
}

function writeFakeCodexLifecycleCli(fakeRoot: string): string {
  fs.mkdirSync(fakeRoot, { recursive: true });
  const scriptPath = path.join(fakeRoot, 'fake-codex-lifecycle.js');
  fs.writeFileSync(scriptPath, `
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

function writeJson(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-last-message');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : '';
const prompt = args[args.length - 1] === '-' ? fs.readFileSync(0, 'utf8') : (args[args.length - 1] || '');
const authoringMatch = prompt.match(/<orpad-authoring-input>\\s*([\\s\\S]*?)\\s*<\\/orpad-authoring-input>/);

if (authoringMatch) {
  const input = JSON.parse(authoringMatch[1]);
  fs.mkdirSync(path.dirname(input.authoringSpecPath), { recursive: true });
  const spec = {
    title: 'README Lifecycle Pipeline',
    description: 'LLM-authored graph for a generated UI lifecycle smoke.',
    graph: {
      id: 'readme-lifecycle',
      label: 'README lifecycle flow',
      start: 'entry',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        { id: 'context', type: 'orpad.context', label: 'Map README', config: { summary: 'Inspect README.md.' } },
        { id: 'probe-readme', type: 'orpad.probe', label: 'Find README improvement', config: { lens: 'readme-lifecycle', maxCandidates: 1 } },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue README work' },
        { id: 'triage', type: 'orpad.triage', label: 'Prioritize README work' },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch README work' },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Edit README', config: { targetFiles: ['README.md'] } },
        { id: 'patch-review', type: 'orpad.patchReview', label: 'Review README patch' },
        { id: 'verify', type: 'orpad.gate', label: 'Verify README work', config: { criteria: ['worker proof accepted', 'queue empty'], onFail: 'warn' } },
        { id: 'artifact', type: 'orpad.artifactContract', label: 'Record evidence' },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' }
      ],
      transitions: [
        { from: 'entry', to: 'context' },
        { from: 'context', to: 'probe-readme' },
        { from: 'probe-readme', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'patch-review' },
        { from: 'patch-review', to: 'verify', condition: 'accepted' },
        { from: 'patch-review', to: 'worker', condition: 'rejected' },
        { from: 'verify', to: 'triage', condition: 'queue-not-empty' },
        { from: 'verify', to: 'artifact', condition: 'queue-empty' },
        { from: 'artifact', to: 'exit' }
      ]
    },
    skill: {
      acceptanceCriteria: ['README receives a lifecycle proof line.']
    },
    metadata: {
      authoringNotes: 'Fake lifecycle Codex generated this spec, then invoked OrPAD CLI.'
    }
  };
  fs.writeFileSync(input.authoringSpecPath, JSON.stringify(spec, null, 2));
  const stdout = childProcess.execFileSync(process.execPath, [
    input.orpadCliPath,
    'generate',
    '--workspace',
    input.workspaceRoot,
    '--prompt-file',
    input.promptFile,
    '--authoring-spec-file',
    input.authoringSpecPath,
    '--json'
  ], { encoding: 'utf-8' });
  fs.writeFileSync(outputPath, stdout);
  process.stdout.write(stdout);
  process.exit(0);
}

if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const result = {
    schemaVersion: 'orpad.workerResult.v1',
    status: 'done',
    summary: 'Fake lifecycle proposal.',
    artifacts: [],
    candidateProposals: [{
      schemaVersion: 'orpad.candidateProposal.v1',
      proposalId: 'proposal-readme-lifecycle',
      suggestedWorkItemId: 'readme-lifecycle',
      sourceNode: 'main/probe-readme',
      title: 'Add README lifecycle proof',
      fingerprint: 'README.md:lifecycle-proof',
      evidence: [{ id: 'readme-before', file: 'README.md', summary: 'README exists.' }],
      acceptanceCriteria: ['README receives a lifecycle proof line.'],
      sourceOfTruthTargets: ['README.md'],
      targetFiles: ['README.md'],
      verificationPlan: 'Inspect README.md for the proof line.',
      approvalRequired: false
    }]
  };
  fs.writeFileSync(outputPath, JSON.stringify(result));
  writeJson(result);
  process.exit(0);
}

const allowedMatch = prompt.match(/allowedFiles:\\s*(\\[[^\\n]+\\])/);
const allowedFiles = allowedMatch ? JSON.parse(allowedMatch[1]) : ['README.md'];
const target = allowedFiles[0] || 'README.md';
fs.appendFileSync(path.join(process.cwd(), target), '\\nOrPAD UI lifecycle proof.\\n');
writeJson({
  schemaVersion: 'orpad.workerResult.v1',
  status: 'done',
  summary: 'Fake lifecycle worker changed ' + target,
  artifacts: []
});
`, 'utf-8');
  return scriptPath;
}

test('graph editor supports node bypass and repeater decorator controls', async () => {
  test.setTimeout(60_000);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-graph-node-actions-'));
  const treePath = path.join(workspace, 'tree.orch-tree.json');
  const graphPath = path.join(workspace, 'flow.orch-graph.json');
  fs.writeFileSync(treePath, JSON.stringify({
    $schema: 'https://orchpad.dev/schemas/orch-tree/v4.1.json',
    version: '4.1',
    trees: [{
      id: 'node-actions-tree',
      label: 'Node actions tree',
      root: {
        id: 'root',
        type: 'Sequence',
        label: 'Root',
        children: [
          { id: 'work', type: 'Context', label: 'Work item' },
        ],
      },
    }],
  }, null, 2));
  fs.writeFileSync(graphPath, JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'node-actions-flow',
      start: 'start',
      nodes: [
        { id: 'start', type: 'orpad.context', label: 'Start' },
        { id: 'done', type: 'orpad.exit', label: 'Done' },
      ],
      transitions: [{ from: 'start', to: 'done' }],
    },
  }, null, 2));

  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('.cm-editor');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);
  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await win.locator('.runbook-item').filter({ hasText: 'tree.orch-tree.json' }).click();
  await win.locator('#btn-preview').click();
  await win.locator('button[data-orch-mode="readwrite"]').click();
  const treeNode = win.locator('.orch-graph-node[data-orch-path="trees.0.root.children.0"]');
  await treeNode.click();
  await win.locator('.orch-floating-inspector select[data-orch-edit="type"]').selectOption('Decorator');
  const decoratorField = win.locator('.orch-floating-inspector input[data-orch-edit="config.decorator"]');
  await expect(decoratorField).toHaveValue('Repeater');
  const repeatField = win.locator('.orch-floating-inspector textarea[data-orch-edit="config.repeatCount"]');
  await expect(repeatField).toBeVisible();
  await decoratorField.evaluate((input) => {
    (input as HTMLInputElement).value = 'Limiter';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(repeatField).toHaveCount(0);
  await treeNode.click({ button: 'right' });
  await expect(win.locator('.orch-context-menu')).toContainText('Set as Repeater');
  await win.locator('button[data-orch-context-action="edit-repeat-count"]').click();
  await expect(decoratorField).toHaveValue('Repeater');
  await expect(repeatField).toBeVisible();
  await expect(repeatField).toBeFocused();
  await repeatField.evaluate((textarea) => {
    (textarea as HTMLTextAreaElement).value = '5';
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await treeNode.click({ button: 'right' });
  await expect(win.locator('.orch-context-menu')).toContainText('Edit repeat count');
  await win.locator('button[data-orch-context-action="edit-repeat-count"]').click();
  await expect(repeatField).toBeFocused();
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
  await expect.poll(() => {
    const saved = JSON.parse(fs.readFileSync(treePath, 'utf-8'));
    return saved.trees[0].root.children[0].config.repeatCount;
  }).toBe(5);

  await win.locator('.runbook-item').filter({ hasText: 'flow.orch-graph.json' }).click();
  await expect(win.locator('.tab-item.active')).toContainText('flow.orch-graph.json');
  await win.locator('#btn-preview').click();
  await expect(win.locator('.orch-preview')).toContainText('Flow setup');
  await win.locator('button[data-orch-mode="readonly"]').click();
  await expect(win.locator('button[data-orch-mode="readonly"]')).toHaveClass(/active/);
  const graphNodeSelector = '.orch-graph-node[data-orch-path="graph.nodes.0"]';
  const graphNode = win.locator(graphNodeSelector);
  await expect(graphNode).toBeVisible();
  await expect.poll(async () => win.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    (el as HTMLElement).click();
    return true;
  }, graphNodeSelector)).toBe(true);
  await win.locator('.orch-graph-frame').evaluate((frame) => {
    const rect = frame.getBoundingClientRect();
    frame.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + 8,
      clientY: rect.top + 8,
    }));
  });
  await expect(win.locator('.orch-context-menu')).not.toContainText('Enable Bypass');
  await expect(win.locator('.orch-context-menu')).toContainText('Add Node...');
  await expect(win.locator('.orch-context-menu')).toContainText('Auto layout');
  await expect.poll(async () => win.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + 18,
      clientY: rect.top + 18,
    }));
    return true;
  }, graphNodeSelector)).toBe(true);
  await expect(win.locator('.orch-context-menu')).toContainText('Enable Bypass');
  await win.locator('button[data-orch-context-action="toggle-bypass"]').click();
  await expect(win.locator('button[data-orch-mode="readwrite"]')).toHaveClass(/active/);
  await expect(graphNode).toHaveClass(/bypassed/);
  await expect(win.locator('.orch-floating-inspector input[data-orch-edit="bypass"]')).toBeChecked();
  await expect.poll(async () => win.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + 18,
      clientY: rect.top + 18,
    }));
    return true;
  }, graphNodeSelector)).toBe(true);
  await expect(win.locator('.orch-context-menu')).toContainText('Disable Bypass');
  await win.locator('.orch-graph-frame').evaluate((frame) => {
    const rect = frame.getBoundingClientRect();
    frame.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + 180,
      clientY: rect.top + 120,
    }));
  });
  await expect(win.locator('.orch-context-menu')).toContainText('Add Node...');
  await win.locator('button[data-orch-context-action="add-node-browser"]').click();
  await expect(win.locator('#fmt-modal')).not.toHaveClass(/hidden/);
  await expect(win.locator('button[data-orch-node-pack-tab="orpad.core"]')).toContainText('OrPAD Core');
  await expect(win.locator('button[data-orch-node-pack-tab="orpad.workstream"]')).toContainText('OrPAD Workstream');
  await win.locator('button[data-orch-node-pack-tab="orpad.workstream"]').click();
  await win.locator('input[data-orch-node-search]').fill('work queue');
  await expect(win.locator('button[data-orch-node-template*="orpad.workQueue"]')).toContainText('Work queue');
  await win.locator('button[data-orch-node-template*="orpad.workQueue"]').click();
  await expect(win.locator('#fmt-modal')).toHaveClass(/hidden/);
  await expect(win.locator('.orch-graph-node')).toHaveCount(3);
  await expect(win.locator('.orch-graph-node.selected')).toContainText('New work queue');
  await win.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
  await expect.poll(() => {
    try {
      const saved = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
      return {
        bypass: saved.graph.nodes[0].bypass,
        workQueue: saved.graph.nodes.some((node: any) => node.type === 'orpad.workQueue'),
      };
    } catch {
      return null;
    }
  }).toEqual({ bypass: true, workQueue: true });

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('creates an OrPAD pipeline inside the current workspace', async () => {
  test.setTimeout(60_000);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-runbook-author-'));
  const fakeCodexPath = writeFakeCodexAuthoringCli(workspace);
  fs.mkdirSync(path.join(workspace, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# OrPAD Authoring Fixture\n');
  fs.writeFileSync(path.join(workspace, 'skills', 'audit.md'), '# Existing Audit\n');
  fs.writeFileSync(path.join(workspace, 'root-workflow.orch-tree.json'), JSON.stringify({
    $schema: 'https://orchpad.dev/schemas/orch-tree/v4.1.json',
    version: '4.1',
    trees: [
      {
        id: 'existing-workflow',
        label: 'Existing workflow',
        root: {
          id: 'root',
          type: 'Sequence',
          label: 'Existing OrPAD workflow',
          children: [
            { id: 'context', type: 'Context', label: 'Collect context' },
            { id: 'audit', type: 'Skill', label: 'Audit', file: 'skills/audit.md' },
          ],
        },
      },
    ],
  }, null, 2));

  const app = await launchElectron([], { ORPAD_CODEX_CLI_PATH: fakeCodexPath });
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('.cm-editor');
  await win.waitForFunction(() => !!(window as any).orpadCommands?.runCommand);

  const toolbarButtonWidth = await win.locator('#btn-theme').evaluate(el => el.getBoundingClientRect().width);
  await win.locator('#btn-theme').click();
  await expect(win.locator('#ui-scale-control')).toBeVisible();
  await win.locator('[data-us-i]').evaluate((input) => {
    (input as HTMLInputElement).value = '115';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(win.locator('[data-us-v]')).toContainText('115%');
  await expect.poll(async () => win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim())).toBe('1.15');
  await expect.poll(async () => win.locator('#btn-theme').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(toolbarButtonWidth);
  await win.locator('[data-us-r]').click();
  await expect(win.locator('[data-us-v]')).toContainText('100%');
  await expect.poll(async () => win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim())).toBe('1');
  await expect.poll(async () => win.locator('#btn-theme').evaluate(el => el.getBoundingClientRect().width)).toBeLessThan(toolbarButtonWidth + 1);
  await win.locator('#theme-panel-close').click();

  await win.evaluate(async () => {
    await (window as any).orpadCommands.runCommand('view.runbooks');
  });

  await expect(win.locator('#runbooks-content')).toContainText('Generate Pipeline');
  await win.locator('[data-runbook-task]').fill('Search for competing products, find improvements, implement them, and verify whether they are more competitive.');
  await expect(win.locator('[data-runbook-external-research-warning]')).toBeVisible();
  await expect(win.locator('[data-runbook-external-research-warning]')).toContainText('external competitor claims require approved browsing or attached research evidence');
  await win.locator('button[data-runbook-action="starter"]').click();
  // Generate now opens an AI tool picker modal before authoring starts.
  // Confirm with the default provider (codex-cli, exercised by the fake CLI shim).
  const generatePicker = win.locator('.orpad-generate-picker-overlay');
  await expect(generatePicker).toBeVisible();
  await generatePicker.locator('button', { hasText: 'Generate with this tool' }).click();
  await expect(generatePicker).toHaveCount(0);
  await expect(win.locator('button[data-runbook-action="starter"]')).toBeDisabled();
  await expect(win.locator('[data-runbook-generate-status]')).toBeVisible();
  await expect(win.locator('[data-runbook-generate-status]')).toContainText(/Collecting context|Starting LLM agent|LLM authoring graph|Preparing request/);
  await expect(win.locator('[data-runbook-generate-status]')).toContainText('Search for competing products');

  await expect(win.locator('#sidebar-runbooks')).toBeVisible();
  await expect(win.locator('.runbook-item.selected')).toHaveAttribute('aria-pressed', 'true');
  await expect(win.locator('.runbook-item.selected')).toHaveAttribute('data-runbook-path', /[\\\/]\.orpad[\\\/]pipelines[\\\/].+[\\\/]pipeline\.or-pipeline/);
  await expect(win.locator('.runbook-item.selected')).not.toContainText('pipeline.or-pipeline');
  await expect(win.locator('[data-runbook-generate-status]')).toContainText('Pipeline generated');
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(win.locator('button[data-pipeline-run-action="implement-harness"]')).toBeEnabled();
  await expect(win.locator('button[data-pipeline-run-action="managed"]')).toBeEnabled();
  await expect(win.locator('button[data-pipeline-run-action="managed"]')).toHaveAttribute('title', /implement the Machine harness first/);
  await win.locator('[data-pipeline-run-menu]').click();

  const pipelinesRoot = path.join(workspace, '.orpad', 'pipelines');
  const pipelineDirs = fs.readdirSync(pipelinesRoot);
  expect(pipelineDirs.length).toBe(1);
  const runbookDir = path.join(pipelinesRoot, pipelineDirs[0]);
  const pipelineFile = 'pipeline.or-pipeline';
  const graphFile = 'main.or-graph';
  expect(fs.existsSync(path.join(runbookDir, pipelineFile))).toBe(true);
  expect(fs.existsSync(path.join(runbookDir, 'graphs', graphFile))).toBe(true);
  const skillFiles = fs.readdirSync(path.join(runbookDir, 'skills')).filter(name => name.endsWith('.md'));
  expect(skillFiles.length).toBe(1);
  const pipeline = JSON.parse(fs.readFileSync(path.join(runbookDir, pipelineFile), 'utf-8'));
  expect(pipeline.entryGraph).toBe('graphs/main.or-graph');
  expect(pipeline.title).toBe('Competitive Improvement Pipeline');
  expect(pipeline.description).toContain('LLM-authored graph');
  expect(pipeline.metadata.orchestrationAuthoring.tool).toBe('orpad-cli');
  expect(pipeline.metadata.orchestrationAuthoring.focus).toBe('orchestration-authoring');
  expect(pipeline.metadata.orchestrationAuthoring.mode).toBe('llm-authored-spec');
  expect(pipeline.metadata.externalResearch.limitation).toContain('external competitor claims require approved browsing or attached research evidence');
  expect(pipeline.run.externalResearchLimitation).toContain('report a research gap');
  expect(pipeline.nodePacks.map((entry: { id: string }) => entry.id)).toContain('orpad.workstream');
  expect(pipeline.run.machineAdapter.type).toBe('codex-cli');
  expect(pipeline.run.machineAdapter.candidateLimit).toBe(5);
  expect(pipeline.run.machineAdapter.claimPolicy.concurrency).toBe(1);
  expect(pipeline.run.runSelection.collectAllVisibleCandidates).toBe(true);
  expect(pipeline.run.runSelection.queueAllActionableCandidates).toBe(true);
  expect(pipeline.run.queueProtocol.schema).toBe('orpad.workItem.v1');
  expect(pipeline.run.queueProtocol.states).toEqual(['candidate', 'queued', 'claimed', 'done', 'blocked', 'rejected']);
  expect(pipeline.run.queueProtocol.claimPolicy.concurrency).toBe(1);
  expect(pipeline.run.machineAdapter.probeNodePaths).toEqual(['main/find-competitive-gaps']);
  const graph = JSON.parse(fs.readFileSync(path.join(runbookDir, 'graphs', graphFile), 'utf-8'));
  const probeNode = graph.graph.nodes.find((node: { id: string }) => node.id === 'find-competitive-gaps') as { config?: { candidateLimitPolicy?: string } } | undefined;
  expect(probeNode?.config?.candidateLimitPolicy).toBe('collect-all-visible');
  expect(graph.graph.nodes.map((node: { type: string }) => node.type)).toEqual([
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
  const generatedSkill = fs.readFileSync(path.join(runbookDir, 'skills', skillFiles[0]), 'utf-8');
  expect(generatedSkill).toContain('Search for competing products');
  expect(generatedSkill).toContain('implementation improves target workflow');
  expect(generatedSkill).toContain('External Competitor Research Guard');
  expect(generatedSkill).toContain('approved browsing or attached research evidence');
  expect(generatedSkill).toContain('report a research gap');
  const authoringDirs = fs.readdirSync(path.join(workspace, '.orpad', 'authoring')).filter(name => name.startsWith('generate-'));
  expect(authoringDirs.length).toBeGreaterThan(0);
  const authoringDir = path.join(workspace, '.orpad', 'authoring', authoringDirs[0]);
  expect(fs.existsSync(path.join(authoringDir, 'authoring-spec.json'))).toBe(true);
  expect(fs.existsSync(path.join(authoringDir, 'authoring-agent-result.json'))).toBe(true);
  await win.locator('#btn-preview').click();
  await expect(win.locator('.orch-preview')).toContainText('Pipeline setup');
  await expect(win.locator('.pipeline-editor-tabs button.active')).toContainText('Flow');
  await expect(win.locator('[data-pipeline-preview-runbar]')).toBeVisible();
  await expect(win.locator('button[data-pipeline-run-action="default"]')).toBeVisible();
  await expect(win.locator('.orch-inspector')).not.toContainText('Step key');
  await expect(win.locator('.orch-inspector')).not.toContainText(/\bID\b/);
  await win.locator('[data-pipeline-run-menu]').click();
  const runMenuStacking = await win.evaluate(() => {
    const runbar = document.querySelector('.pipeline-runbar');
    const menu = document.querySelector('.pipeline-run-menu');
    const inspector = document.querySelector('.orch-floating-inspector');
    return {
      runbar: Number(getComputedStyle(runbar as Element).zIndex),
      menu: Number(getComputedStyle(menu as Element).zIndex),
      inspector: Number(getComputedStyle(inspector as Element).zIndex),
    };
  });
  expect(runMenuStacking.runbar).toBeGreaterThan(runMenuStacking.inspector);
  expect(runMenuStacking.menu).toBeGreaterThan(runMenuStacking.inspector);
  await win.locator('[data-pipeline-run-menu]').click();
  await expect(win.locator('.orch-graph-node')).toHaveCount(12);
  await expect(win.locator('.orch-graph-node')).toContainText(['Map product surface', 'Confirm competitive research mode', 'Find competitive improvement gaps', 'Implement competitive improvement']);
  await expect(win.locator('button[data-orch-tool="select"]')).toHaveClass(/active/);
  await expect(win.locator('.orch-graph-tools .ogi')).toHaveCount(8);
  await win.locator('.pipeline-editor-tabs button').filter({ hasText: 'Details' }).click();
  await expect(win.locator('.orch-preview')).toContainText('external competitor claims require approved browsing or attached research evidence');
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('External research needs approval');
  await win.locator('.pipeline-editor-tabs button').filter({ hasText: 'Flow' }).click();

  await win.locator('.runbook-item').filter({ hasText: 'root-workflow.orch-tree.json' }).click();
  await expect(win.locator('.runbook-item.selected')).toContainText('root-workflow.orch-tree.json');
  await expect(win.locator('.orch-preview')).toBeVisible();
  await win.locator('#btn-preview').click();
  await expect(win.locator('.orch-preview')).toContainText('Tree setup');
  await expect(win.locator('.orch-graph-frame')).toBeVisible();
  await expect(win.locator('.orch-graph-node')).toHaveCount(3);
  await expect(win.locator('.orch-transition')).toHaveCount(2);
  const graphPositions = await win.locator('.orch-graph-node').evaluateAll(nodes => nodes.map(node => ({
    path: (node as HTMLElement).dataset.orchPath,
    left: parseFloat((node as HTMLElement).style.left || '0'),
    top: parseFloat((node as HTMLElement).style.top || '0'),
  })));
  const rootPosition = graphPositions.find(item => item.path === 'trees.0.root');
  const childPosition = graphPositions.find(item => item.path === 'trees.0.root.children.0');
  expect(rootPosition?.top).toBeLessThan(childPosition?.top || 0);
  await expect(win.locator('button[data-orch-tool="select"]')).toHaveClass(/active/);
  await expect(win.locator('button[data-orch-tool="hand"]')).toBeVisible();
  await expect(win.locator('button[data-orch-zoom="in"]')).toBeVisible();
  await expect(win.locator('button[data-orch-action="fit"]')).toBeVisible();
  await expect(win.locator('.orch-graph-tools .ogi')).toHaveCount(8);
  await expect(win.locator('button[data-orch-action="snap-toggle"] .ogi')).toBeVisible();
  const zoomLabel = win.locator('[data-orch-zoom-label]');
  await expect(zoomLabel).toHaveText('');
  const beforeZoom = await zoomLabel.getAttribute('data-zoom-value');
  await win.locator('button[data-orch-zoom="in"]').click();
  await expect.poll(async () => zoomLabel.getAttribute('data-zoom-value')).not.toBe(beforeZoom);
  await win.locator('button[data-orch-tool="hand"]').click();
  await expect(win.locator('button[data-orch-tool="hand"]')).toHaveClass(/active/);
  await expect(win.locator('.orch-graph-frame')).toHaveClass(/hand/);
  await win.locator('button[data-orch-action="fit"]').click();
  await win.locator('button[data-orch-tool="select"]').click();
  const beforeRightPan = await win.locator('[data-orch-viewport]').first().getAttribute('style');
  await win.locator('.orch-graph-frame').evaluate((frame) => {
    const opts = { bubbles: true, cancelable: true, button: 2, pointerId: 7, pointerType: 'mouse' };
    frame.dispatchEvent(new PointerEvent('pointerdown', { ...opts, buttons: 2, clientX: 160, clientY: 160 }));
    frame.dispatchEvent(new PointerEvent('pointermove', { ...opts, buttons: 2, clientX: 220, clientY: 190 }));
    frame.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0, clientX: 220, clientY: 190 }));
  });
  await expect(win.locator('button[data-orch-tool="select"]')).toHaveClass(/active/);
  await expect.poll(async () => win.locator('[data-orch-viewport]').first().getAttribute('style')).not.toBe(beforeRightPan);
  await expect(win.locator('.orch-context-menu')).toHaveCount(0);
  await expect(win.locator('button[data-runbook-action="open"]')).toHaveCount(0);

  await win.locator('button[data-orch-mode="readwrite"]').click();
  const treeTypeOptions = await win.locator('.orch-floating-inspector select[data-orch-edit="type"] option').evaluateAll(options =>
    options.map(option => (option as HTMLOptionElement).value).filter(Boolean)
  );
  expect(treeTypeOptions).toContain('Sequence');
  expect(treeTypeOptions).toContain('Skill');
  expect(treeTypeOptions).not.toContain('orpad.context');
  expect(treeTypeOptions).not.toContain('orpad.workQueue');
  await win.locator('button[data-orch-tool="select"]').click();
  const rootNode = win.locator('.orch-graph-node[data-orch-path="trees.0.root"]');
  const firstChildNode = win.locator('.orch-graph-node[data-orch-path="trees.0.root.children.0"]');
  const childBeforeMove = await firstChildNode.evaluate((el) => ({
    left: parseFloat((el as HTMLElement).style.left || '0'),
    top: parseFloat((el as HTMLElement).style.top || '0'),
  }));
  const rootBeforeChildMove = await rootNode.evaluate((el) => ({
    left: (el as HTMLElement).style.left,
    top: (el as HTMLElement).style.top,
  }));
  await firstChildNode.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 17, pointerType: 'mouse' };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: rect.left + 20, clientY: rect.top + 20 }));
    el.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: rect.left - 520, clientY: rect.top - 380 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: rect.left - 520, clientY: rect.top - 380 }));
  });
  await expect.poll(async () => rootNode.evaluate((el) => ({
    left: (el as HTMLElement).style.left,
    top: (el as HTMLElement).style.top,
  }))).toEqual(rootBeforeChildMove);
  await expect.poll(async () => firstChildNode.evaluate((el) => parseFloat((el as HTMLElement).style.left || '0'))).toBeLessThan(0);
  await expect.poll(async () => firstChildNode.evaluate((el) => parseFloat((el as HTMLElement).style.top || '0'))).toBeLessThan(0);
  await expect.poll(async () => win.locator('.orch-transition').evaluateAll(paths =>
    paths.every(pathEl => pathEl.previousElementSibling?.getAttribute('d') === pathEl.getAttribute('d'))
  )).toBe(true);
  await expect(win.locator('button[data-orch-history="undo"]').first()).toBeEnabled();
  await win.keyboard.press('Control+Z');
  await expect.poll(async () => firstChildNode.evaluate((el) => ({
    left: parseFloat((el as HTMLElement).style.left || '0'),
    top: parseFloat((el as HTMLElement).style.top || '0'),
  }))).toEqual(childBeforeMove);
  await expect(win.locator('button[data-orch-history="redo"]').first()).toBeEnabled();
  await win.keyboard.press('Control+Y');
  await expect.poll(async () => firstChildNode.evaluate((el) => parseFloat((el as HTMLElement).style.left || '0'))).toBeLessThan(0);
  await expect(win.locator('button[data-orch-action="snap-toggle"]').first()).not.toHaveClass(/active/);
  const nodeSnapActiveDuringDrag = await firstChildNode.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 18, pointerType: 'mouse', ctrlKey: true };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: rect.left + 18, clientY: rect.top + 18 }));
    el.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: rect.left + 113, clientY: rect.top + 77 }));
    const activeDuring = document.querySelector('button[data-orch-action="snap-toggle"]')?.classList.contains('active');
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: rect.left + 113, clientY: rect.top + 77 }));
    return activeDuring;
  });
  expect(nodeSnapActiveDuringDrag).toBe(true);
  await expect(win.locator('button[data-orch-action="snap-toggle"]').first()).not.toHaveClass(/active/);
  const ctrlSnappedChild = await firstChildNode.evaluate((el) => ({
    left: parseFloat((el as HTMLElement).style.left || '0'),
    top: parseFloat((el as HTMLElement).style.top || '0'),
  }));
  expect(Math.abs(ctrlSnappedChild.left % 28)).toBe(0);
  expect(Math.abs(ctrlSnappedChild.top % 28)).toBe(0);
  await win.locator('.orch-graph-node').filter({ hasText: 'Existing OrPAD workflow' }).click();
  const labelInput = win.locator('[data-orch-edit="label"]').first();
  await labelInput.evaluate((input, value) => {
    (input as HTMLInputElement).value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, 'Edited OrPAD workflow');
  await expect(win.locator('.orch-graph-node.selected')).toContainText('Edited OrPAD workflow');
  await rootNode.click();
  await win.keyboard.press('Control+Z');
  await expect(win.locator('.orch-graph-node.selected')).toContainText('Existing OrPAD workflow');
  await win.keyboard.press('Control+Y');
  await expect(win.locator('.orch-graph-node.selected')).toContainText('Edited OrPAD workflow');

  await win.locator('button[data-orch-action="add-child"]').click();
  await expect(win.locator('.orch-graph-node')).toHaveCount(4);
  await expect(win.locator('.orch-graph-node.selected')).toContainText('New node');
  await win.keyboard.press('Delete');
  await expect(win.locator('.orch-graph-node')).toHaveCount(3);
  await expect(win.locator('.orch-graph-node.selected')).toContainText('Edited OrPAD workflow');
  await win.locator('button[data-orch-action="add-child"]').click();
  await expect(win.locator('.orch-graph-node')).toHaveCount(4);
  await win.locator('.orch-graph-node.selected').click({ button: 'right' });
  await expect(win.locator('.orch-context-menu')).toContainText('Insert subtree');
  await win.locator('button[data-orch-context-action="insert-subtree"]').click();
  await expect(win.locator('.orch-graph-node')).toHaveCount(7);
  await win.locator('button[data-orch-action="fit"]').click();
  await win.locator('.orch-transition-hit').first().evaluate((pathEl) => {
    const rect = pathEl.getBoundingClientRect();
    pathEl.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }));
  });
  await expect(win.locator('.orch-transition.selected')).toHaveCount(1);
  await win.locator('button[data-orch-action="transition-straight"]').click();
  await expect(win.locator('.orch-transition.selected')).toHaveClass(/style-straight/);
  await expect(win.locator('.orch-transition-handle')).toBeVisible();
  const transitionSnapActiveDuringDrag = await win.locator('.orch-transition-handle').evaluate((handle) => {
    const rect = handle.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 23, pointerType: 'mouse', ctrlKey: true };
    handle.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: rect.left + 3, clientY: rect.top + 3 }));
    handle.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: rect.left + 48, clientY: rect.top - 24 }));
    const activeDuring = document.querySelector('button[data-orch-action="snap-toggle"]')?.classList.contains('active');
    handle.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: rect.left + 48, clientY: rect.top - 24 }));
    return activeDuring;
  });
  expect(transitionSnapActiveDuringDrag).toBe(true);
  await expect(win.locator('button[data-orch-action="snap-toggle"]').first()).not.toHaveClass(/active/);
  await expect.poll(async () => win.locator('.orch-transition.selected').evaluate(pathEl =>
    pathEl.previousElementSibling?.getAttribute('d') === pathEl.getAttribute('d')
  )).toBe(true);
  await expect.poll(() => fs.existsSync(path.join(workspace, 'root-workflow.orch-tree.meta.json'))).toBe(true);
  const metaPath = path.join(workspace, 'root-workflow.orch-tree.meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  expect(Object.values(meta.transitions).some((transition: any) => transition.style === 'straight')).toBe(true);
  const snappedTransition = Object.values(meta.transitions).find((transition: any) => transition.points?.length) as any;
  expect(Math.abs(snappedTransition.points[0].x % 28)).toBe(0);
  expect(Math.abs(snappedTransition.points[0].y % 28)).toBe(0);
  await win.locator('.orch-transition-hit').nth(1).evaluate((pathEl) => {
    const rect = pathEl.getBoundingClientRect();
    pathEl.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }));
  });
  await win.keyboard.press('Delete');
  await expect(win.locator('.orch-graph-node')).toHaveCount(6);

  await win.locator('button[data-orch-tool="select"]').click();
  await expect(win.locator('button[data-orch-tool="select"]')).toHaveClass(/active/);
  await win.locator('button[data-orch-action="fit"]').click();
  const frameBox = await win.locator('.orch-graph-frame').boundingBox();
  const dragLeft = (frameBox?.x || 0) + 8;
  const dragTop = (frameBox?.y || 0) + (frameBox?.height || 0) - 8;
  const dragRight = (frameBox?.x || 0) + (frameBox?.width || 0) - 8;
  const dragBottom = (frameBox?.y || 0) + 8;
  await win.locator('.orch-graph-frame').evaluate((frame, points) => {
    const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse' };
    frame.dispatchEvent(new PointerEvent('pointerdown', { ...opts, buttons: 1, clientX: points.left, clientY: points.top }));
    frame.dispatchEvent(new PointerEvent('pointermove', { ...opts, buttons: 1, clientX: points.right, clientY: points.bottom }));
    frame.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0, clientX: points.right, clientY: points.bottom }));
  }, { left: dragLeft, top: dragTop, right: dragRight, bottom: dragBottom });
  await expect.poll(async () => win.locator('.orch-graph-node.selected').count()).toBeGreaterThan(1);

  await win.locator('.orch-graph-frame').click({ button: 'right', position: { x: 40, y: 110 } });
  await expect(win.locator('.orch-context-menu')).toContainText('Add Context');

  await win.locator('.runbook-item.selected').click();
  await expect(win.locator('.runbook-item.selected')).toHaveCount(0);

  await win.locator('.runbook-item').filter({ hasText: 'root-workflow.orch-tree.json' }).click();
  await expect(win.locator('.runbook-item.selected')).toContainText('root-workflow.orch-tree.json');

  await win.locator('.runbook-item[data-runbook-format="or-pipeline"]').click();
  await expect(win.locator('.runbook-item.selected')).toHaveAttribute('data-runbook-path', /[\\\/]\.orpad[\\\/]pipelines[\\\/].+[\\\/]pipeline\.or-pipeline/);
  await win.locator('.tab-item').filter({ hasText: graphFile }).click();
  await expect(win.locator('.tab-item.active')).toContainText(graphFile);
  await expect(win.locator('.orch-preview')).toContainText('Pipeline setup');
  await win.locator('button[data-orch-mode="readwrite"]').click();
  const graphContextNode = win.locator('.orch-graph-node[data-orch-path="graph.nodes.1"]');
  const graphApprovalNode = win.locator('.orch-graph-node[data-orch-path="graph.nodes.2"]');
  await expect(graphContextNode).toBeVisible();
  await graphContextNode.evaluate((el) => (el as HTMLElement).click());
  await expect(win.locator('.orch-inspector')).toContainText('Step key');
  await expect(win.locator('.orch-inspector')).not.toContainText(/\bID\b/);
  const graphLabelInput = win.locator('[data-orch-edit="label"]').first();
  await graphLabelInput.evaluate((input, value) => {
    (input as HTMLInputElement).value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, 'Edited graph context');
  await expect(win.locator('.orch-graph-node.selected')).toContainText('Edited graph context');
  await graphContextNode.evaluate((el) => (el as HTMLElement).click());
  await win.keyboard.press('Control+Z');
  await expect(win.locator('.orch-graph-node.selected')).toContainText('Map product surface');
  await win.keyboard.press('Control+Y');
  await expect(win.locator('.orch-graph-node.selected')).toContainText('Edited graph context');
  const approvalBeforeMove = await graphApprovalNode.evaluate((el) => ({
    left: parseFloat((el as HTMLElement).style.left || '0'),
    top: parseFloat((el as HTMLElement).style.top || '0'),
  }));
  await graphApprovalNode.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 31, pointerType: 'mouse', ctrlKey: true };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: rect.left + 18, clientY: rect.top + 18 }));
    el.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: rect.left + 99, clientY: rect.top + 67 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: rect.left + 99, clientY: rect.top + 67 }));
  });
  await expect.poll(async () => graphApprovalNode.evaluate((el) => ({
    left: parseFloat((el as HTMLElement).style.left || '0'),
    top: parseFloat((el as HTMLElement).style.top || '0'),
  }))).not.toEqual(approvalBeforeMove);
  await win.keyboard.press('Control+Z');
  await expect.poll(async () => graphApprovalNode.evaluate((el) => ({
    left: parseFloat((el as HTMLElement).style.left || '0'),
    top: parseFloat((el as HTMLElement).style.top || '0'),
  }))).toEqual(approvalBeforeMove);
  await win.keyboard.press('Control+Y');
  await expect.poll(async () => graphApprovalNode.evaluate((el) => ({
    left: parseFloat((el as HTMLElement).style.left || '0'),
    top: parseFloat((el as HTMLElement).style.top || '0'),
  }))).not.toEqual(approvalBeforeMove);
  const graphMetaPath = path.join(runbookDir, 'graphs', graphFile.replace('.or-graph', '.or-graph.meta.json'));
  await expect.poll(() => fs.existsSync(graphMetaPath)).toBe(true);
  await graphContextNode.evaluate((el) => (el as HTMLElement).click());
  const graphTransitionCountBeforeAdd = await win.locator('.orch-transition').count();
  await win.locator('button[data-orch-action="add-child"]').click();
  await expect(win.locator('.orch-graph-node')).toHaveCount(13);
  await expect(win.locator('.orch-transition')).toHaveCount(graphTransitionCountBeforeAdd + 1);
  await expect(win.locator('.orch-graph-node.selected')).toContainText('New context');
  await expect(win.locator('.orch-graph-node.selected')).toContainText('Context');
  await win.keyboard.press('Delete');
  await expect(win.locator('.orch-graph-node')).toHaveCount(12);
  await expect(win.locator('.orch-transition')).toHaveCount(graphTransitionCountBeforeAdd);
  await graphContextNode.evaluate((el) => (el as HTMLElement).click());
  await win.locator('.orch-graph-node[data-orch-path="graph.nodes.3"]').evaluate((el) => {
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + 18,
      clientY: rect.top + 18,
    }));
  });
  await expect(win.locator('.orch-context-menu')).toContainText('Connect selected');
  await win.locator('button[data-orch-context-action="connect-selected"]').click();
  await expect(win.locator('.orch-transition')).toHaveCount(graphTransitionCountBeforeAdd + 1);
  await win.locator('.orch-transition-hit').first().evaluate((pathEl) => {
    const rect = pathEl.getBoundingClientRect();
    pathEl.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }));
  });
  await expect(win.locator('.orch-transition.selected')).toHaveCount(1);
  await win.locator('button[data-orch-action="transition-straight"]').click();
  await expect(win.locator('.orch-transition.selected')).toHaveClass(/style-straight/);
  await expect(win.locator('.orch-transition-handle')).toBeVisible();
  await win.locator('button[data-orch-action="delete-transition"]').click();
  await expect(win.locator('.orch-graph-node')).toHaveCount(12);
  await expect(win.locator('.orch-transition')).toHaveCount(graphTransitionCountBeforeAdd);
  await win.keyboard.press('Control+S');
  await expect.poll(() => fs.readFileSync(path.join(runbookDir, 'graphs', graphFile), 'utf-8')).toContain('Edited graph context');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('generated pipeline can implement harness and run from the UI', async () => {
  test.setTimeout(120_000);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-ui-lifecycle-'));
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-fake-ui-lifecycle-'));
  const fakeCodexPath = writeFakeCodexLifecycleCli(fakeRoot);
  fs.writeFileSync(path.join(workspace, 'README.md'), '# UI Lifecycle Fixture\n');

  const app = await launchElectron([], {
    ORPAD_CODEX_CLI_PATH: fakeCodexPath,
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

  await win.locator('[data-runbook-task]').fill('Improve README using local evidence and run it through OrPAD.');
  await win.locator('button[data-runbook-action="starter"]').click();
  const generatePicker = win.locator('.orpad-generate-picker-overlay');
  await expect(generatePicker).toBeVisible();
  await generatePicker.locator('button', { hasText: 'Generate with this tool' }).click();
  await expect(win.locator('[data-runbook-generate-status]')).toContainText('Pipeline generated', { timeout: 30_000 });

  const pipelinePath = await win.locator('.runbook-item.selected').getAttribute('data-runbook-path');
  expect(pipelinePath).toBeTruthy();
  const pipeline = JSON.parse(fs.readFileSync(pipelinePath as string, 'utf-8'));
  expect(pipeline.run.machineAdapter.command).toBe('codex');
  expect(pipeline.run.machineAdapter.claimPolicy.concurrency).toBe(1);

  await win.locator('[data-pipeline-run-menu]').click();
  await win.locator('button[data-pipeline-run-action="implement-harness"]').click();
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('Harness ready', { timeout: 30_000 });
  await expect(win.locator('[data-pipeline-preview-runbar]')).toContainText('Fallback harness', { timeout: 30_000 });
  const harnessSpecPath = path.join(path.dirname(pipelinePath as string), 'harness', 'generated', 'harness-authoring-spec.json');
  const provisioningPath = path.join(path.dirname(pipelinePath as string), 'harness', 'generated', 'harness-provisioning.json');
  const evalPlanPath = path.join(path.dirname(pipelinePath as string), 'harness', 'generated', 'eval-plan.json');
  const securityRiskPlanPath = path.join(path.dirname(pipelinePath as string), 'harness', 'generated', 'security-risk-plan.json');
  await expect.poll(() => fs.existsSync(harnessSpecPath), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => fs.existsSync(provisioningPath), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => fs.existsSync(evalPlanPath), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => fs.existsSync(securityRiskPlanPath), { timeout: 10_000 }).toBe(true);
  const harnessSpec = JSON.parse(fs.readFileSync(harnessSpecPath, 'utf-8'));
  const provisioning = JSON.parse(fs.readFileSync(provisioningPath, 'utf-8'));
  const evalPlan = JSON.parse(fs.readFileSync(evalPlanPath, 'utf-8'));
  const implementedPipeline = JSON.parse(fs.readFileSync(pipelinePath as string, 'utf-8'));
  expect(harnessSpec.schemaVersion).toBe('orpad.harnessAuthoringSpec.v1');
  expect(implementedPipeline.harness.actualAuthoringMode).toBe('deterministic-fallback');
  expect(implementedPipeline.metadata.harnessImplementation.harnessAuthoringMode).toBe('deterministic-fallback');
  expect(provisioning.schemaVersion).toBe('orpad.harnessProvisioning.v1');
  expect(evalPlan.schemaVersion).toBe('orpad.evalPlan.v1');
  expect(harnessSpec.nodeContracts.some((contract: any) => contract.nodePath === 'main/worker')).toBe(true);

  await win.locator('[data-pipeline-run-menu]').click();
  await win.locator('button[data-pipeline-run-action="managed-auto-apply"]').click();
  await expect(win.locator('[data-machine-token-input]')).toBeVisible();
  await win.locator('[data-machine-token-input]').fill('test-token');
  await win.getByRole('button', { name: 'Use Token' }).click();
  await expect(win.locator('.orpad-adapter-picker')).toBeVisible();
  await win.locator('[data-adapter-picker-confirm="true"]').click();
  await expect(win.locator('.orpad-adapter-picker-overlay')).toHaveCount(0);

  await expect.poll(() => fs.readFileSync(path.join(workspace, 'README.md'), 'utf-8'), {
    timeout: 45_000,
  }).toContain('OrPAD UI lifecycle proof.');
  await expect(win.locator('#runbooks-content')).toContainText('Work result', { timeout: 30_000 });
  await expect(win.locator('#runbooks-content')).not.toContainText('MACHINE_COMMAND_NOT_GRANTED');
  await expect(win.locator('#fmt-modal')).toBeHidden();
  const runDirs = fs.readdirSync(path.join(path.dirname(pipelinePath as string), 'runs'));
  expect(runDirs.length).toBe(1);
  const runState = JSON.parse(fs.readFileSync(path.join(path.dirname(pipelinePath as string), 'runs', runDirs[0], 'run-state.json'), 'utf-8'));
  expect(runState.metadata.patchReviewMode).toBe('auto-apply');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(fakeRoot, { recursive: true, force: true });
});
