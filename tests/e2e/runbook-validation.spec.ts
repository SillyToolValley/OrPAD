import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { launchElectron } from '../helpers';

function writeApprovedWorkspace(userData: string, workspaceRoot: string): void {
  fs.writeFileSync(path.join(userData, 'approved-workspace.json'), JSON.stringify({
    version: 1,
    workspaceRoot,
  }));
}

function gitOutput(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: path.resolve('.'), encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
}

function currentStatusDigest(): string {
  return createHash('sha256').update(gitOutput(['status', '--short'])).digest('hex');
}

function evidenceManifestEntry(root: string, filePath: string): { path: string; sha256: string; size: number } {
  const bytes = fs.readFileSync(filePath);
  return {
    path: path.relative(root, filePath).replace(/\\/g, '/'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

function actionableWorkItemFields(id: string): Record<string, unknown> {
  return {
    userImpact: 'A user or agent cannot rely on the queue item without a reproducible impact statement.',
    reproSteps: ['Open the fixture pipeline.', `Inspect work item ${id}.`, 'Run the OrPAD queue audit.'],
    expectedBehavior: 'The queue item is actionable and points at a source-of-truth fix target.',
    actualBehavior: 'The fixture represents the current audited queue behavior.',
    sourceOfTruthTargets: ['tests/e2e/runbook-validation.spec.ts'],
    verificationPlan: 'Run the focused queue or run audit test.',
    coverageEvidenceIds: [`coverage-${id}`],
  };
}

function validRunbook(skillRef = 'skills/audit.md', rootType = 'Sequence') {
  return {
    $schema: 'https://orchpad.dev/schemas/orch-tree/v4.1.json',
    version: '4.1',
    trees: [
      {
        id: 'release-audit',
        label: 'Release audit',
        root: {
          id: 'root',
          type: rootType,
          label: 'Audit release claims',
          children: [
            {
              id: 'collect-context',
              type: 'Context',
              label: 'Collect project context',
            },
            {
              id: 'audit-claims',
              type: 'Skill',
              label: 'Audit claims',
              file: skillRef,
              config: {
                outputs: [
                  {
                    key: 'claim-register',
                    type: 'file',
                    ref: 'outputs/claim-register.md',
                  },
                ],
              },
            },
          ],
        },
      },
    ],
  };
}

function validGraph(skillRef = 'skills/audit.md') {
  return {
    $schema: 'https://orchpad.dev/schemas/orch-graph/v1.json',
    version: '1.0',
    trustLevel: 'local-authored',
    graph: {
      id: 'release-audit-graph',
      label: 'Release audit graph',
      start: 'context',
      nodes: [
        { id: 'context', type: 'Context', label: 'Collect project context' },
        { id: 'approval', type: 'Gate', label: 'Approve run' },
        {
          id: 'implementation-tree',
          type: 'OrchTree',
          label: 'Implementation tree',
          tree: {
            id: 'implementation-tree',
            label: 'Implementation tree',
            root: {
              id: 'root',
              type: 'Sequence',
              label: 'Run implementation',
              children: [
                { id: 'audit-claims', type: 'Skill', label: 'Audit claims', file: skillRef },
              ],
            },
          },
        },
      ],
      transitions: [
        { id: 'context-to-approval', from: 'context', to: 'approval' },
        { id: 'approval-to-implementation-tree', from: 'approval', to: 'implementation-tree' },
      ],
    },
  };
}

test('runbook validator accepts local-authored MVP runbook and creates minimal run record', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-runbook-'));
  fs.mkdirSync(path.join(workspace, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'skills', 'audit.md'), '# Audit Claims\n\n## Acceptance Criteria\n\n- Produce claim register.\n');
  const runbookPath = path.join(workspace, '.orch-tree.json');
  fs.writeFileSync(runbookPath, JSON.stringify(validRunbook(), null, 2));

  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);
  await win.evaluate(async () => {
    await (window as any).orpad.getApprovedWorkspace();
  });

  const validation = await win.evaluate(async (filePath) => {
    return await (window as any).orpad.runbooks.validateFile(filePath);
  }, runbookPath);
  expect(validation.ok).toBe(true);
  expect(validation.canExecute).toBe(true);
  expect(validation.nodeCount).toBe(3);
  expect(validation.executableNodeTypes).toContain('Skill');

  const created = await win.evaluate(async ({ workspacePath, filePath }) => {
    return await (window as any).orpad.runbooks.createRunRecord(workspacePath, filePath, {
      title: 'Release audit fixture',
    });
  }, { workspacePath: workspace, filePath: runbookPath });
  expect(created.success).toBe(true);
  expect(fs.existsSync(path.join(created.runDir, 'run.json'))).toBe(true);
  expect(fs.existsSync(path.join(created.runDir, 'events.jsonl'))).toBe(true);

  const readBack = await win.evaluate(async ({ workspacePath, runDir }) => {
    return await (window as any).orpad.runbooks.readRunRecord(workspacePath, runDir);
  }, { workspacePath: workspace, runDir: created.runDir });
  expect(readBack.success).toBe(true);
  expect(readBack.run.status).toBe('created');
  expect(readBack.events.map((event: { type: string }) => event.type)).toContain('run.created');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('runbook validator accepts graph-first runbook with OrchTree subflow', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-runbook-graph-'));
  fs.mkdirSync(path.join(workspace, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'skills', 'audit.md'), '# Audit Claims\n');
  const runbookPath = path.join(workspace, 'release-audit.orch-graph.json');
  fs.writeFileSync(runbookPath, JSON.stringify(validGraph(), null, 2));

  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);
  await win.evaluate(async () => {
    await (window as any).orpad.getApprovedWorkspace();
  });

  const validation = await win.evaluate(async (filePath) => {
    return await (window as any).orpad.runbooks.validateFile(filePath);
  }, runbookPath);
  expect(validation.ok).toBe(true);
  expect(validation.canExecute).toBe(true);
  expect(validation.format).toBe('orch-graph');
  expect(validation.graphCount).toBe(1);
  expect(validation.treeCount).toBe(1);
  expect(validation.nodeTypes).toContain('OrchTree');
  expect(validation.nodeTypes).toContain('Skill');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('pipeline validator accepts manifest with external graph and tree and creates pipeline run records', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-pipeline-'));
  const pipelineRoot = path.join(workspace, '.orpad', 'pipelines', 'release-audit');
  fs.mkdirSync(path.join(pipelineRoot, 'graphs'), { recursive: true });
  fs.mkdirSync(path.join(pipelineRoot, 'trees'), { recursive: true });
  fs.mkdirSync(path.join(pipelineRoot, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(pipelineRoot, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(pipelineRoot, 'skills', 'audit.md'), '# Audit Claims\n');
  fs.writeFileSync(path.join(pipelineRoot, 'rules', 'context.or-rule'), JSON.stringify({ kind: 'orpad.rule', version: '1.0', id: 'context' }, null, 2));
  fs.writeFileSync(path.join(pipelineRoot, 'rules', 'approvals.or-rule'), JSON.stringify({ kind: 'orpad.rule', version: '1.0', id: 'approvals' }, null, 2));
  fs.writeFileSync(path.join(pipelineRoot, 'trees', 'implementation.or-tree'), JSON.stringify({
    kind: 'orpad.tree',
    version: '1.0',
    id: 'implementation',
    root: {
      id: 'root',
      type: 'Sequence',
      label: 'Run audit',
      children: [
        { id: 'audit', type: 'Skill', label: 'Audit claims', file: '../skills/audit.md' },
      ],
    },
  }, null, 2));
  fs.writeFileSync(path.join(pipelineRoot, 'graphs', 'main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'release-audit',
      label: 'Release audit',
      start: 'context',
      nodes: [
        { id: 'context', type: 'Context', label: 'Collect context' },
        { id: 'gate', type: 'Gate', label: 'Approve run' },
        { id: 'implementation', type: 'OrchTree', label: 'Implementation', config: { treeRef: '../trees/implementation.or-tree' } },
      ],
      transitions: [
        { id: 'context-to-gate', from: 'context', to: 'gate' },
        { id: 'gate-to-implementation', from: 'gate', to: 'implementation' },
      ],
    },
  }, null, 2));
  const pipelinePath = path.join(pipelineRoot, 'pipeline.or-pipeline');
  fs.writeFileSync(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'release-audit',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
    trees: [{ id: 'implementation', file: 'trees/implementation.or-tree' }],
    skills: [{ id: 'audit', file: 'skills/audit.md' }],
    rules: [
      { id: 'context', file: 'rules/context.or-rule' },
      { id: 'approvals', file: 'rules/approvals.or-rule' },
    ],
  }, null, 2));

  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);
  await win.evaluate(async () => {
    await (window as any).orpad.getApprovedWorkspace();
  });

  const validation = await win.evaluate(async (filePath) => {
    return await (window as any).orpad.pipelines.validateFile(filePath);
  }, pipelinePath);
  expect(validation.ok).toBe(true);
  expect(validation.canExecute).toBe(true);
  expect(validation.format).toBe('or-pipeline');
  expect(validation.entryGraph).toBe('graphs/main.or-graph');
  expect(validation.graphCount).toBe(1);
  expect(validation.treeCount).toBe(1);
  expect(validation.nodeTypes).toContain('OrchTree');
  expect(validation.nodeTypes).toContain('Skill');

  const created = await win.evaluate(async ({ workspacePath, filePath }) => {
    return await (window as any).orpad.pipelines.createRunRecord(workspacePath, filePath, {
      title: 'Release audit pipeline',
    });
  }, { workspacePath: workspace, filePath: pipelinePath });
  expect(created.success).toBe(true);
  expect(created.run.targetKind).toBe('pipeline');
  expect(fs.existsSync(path.join(created.runDir, 'run.or-run'))).toBe(true);
  expect(created.runDir).toContain(path.join('.orpad', 'pipelines', 'release-audit', 'runs'));

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('pipeline validator recognizes built-in OrPAD node pack graph types', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-pipeline-node-pack-'));
  const pipelineRoot = path.join(workspace, '.orpad', 'pipelines', 'node-pack-validation');
  fs.mkdirSync(path.join(pipelineRoot, 'graphs'), { recursive: true });
  fs.mkdirSync(path.join(pipelineRoot, 'trees'), { recursive: true });
  fs.mkdirSync(path.join(pipelineRoot, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(pipelineRoot, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(pipelineRoot, 'skills', 'audit.md'), '# Audit\n');
  fs.writeFileSync(path.join(pipelineRoot, 'rules', 'policy.or-rule'), JSON.stringify({ kind: 'orpad.rule', version: '1.0', id: 'policy' }, null, 2));
  fs.writeFileSync(path.join(pipelineRoot, 'trees', 'implementation.or-tree'), JSON.stringify({
    kind: 'orpad.tree',
    version: '1.0',
    id: 'implementation',
    root: {
      id: 'root',
      type: 'Sequence',
      label: 'Implementation',
      children: [
        { id: 'audit', type: 'Skill', label: 'Audit', file: '../skills/audit.md' },
      ],
    },
  }, null, 2));
  fs.writeFileSync(path.join(pipelineRoot, 'graphs', 'main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'node-pack-validation',
      label: 'Node pack validation',
      start: 'context',
      nodes: [
        { id: 'context', type: 'orpad.context', label: 'Context', config: { summary: 'Collect local workspace context.' } },
        { id: 'gate', type: 'orpad.gate', label: 'Gate', config: { criteria: ['local only'] } },
        { id: 'probe', type: 'orpad.probe', label: 'Probe', config: { lens: 'ux-ui', skillRef: 'audit', maxCandidates: 1 } },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', label: 'Triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Worker', config: { queueRef: 'queue' } },
        { id: 'skill', type: 'orpad.skill', label: 'Proof skill', config: { skillRef: 'audit' } },
        { id: 'tree', type: 'orpad.tree', label: 'Implementation tree', config: { treeRef: '../trees/implementation.or-tree' } },
        { id: 'rule', type: 'orpad.rule', label: 'Policy rule', config: { ruleRef: 'policy' } },
        { id: 'contract', type: 'orpad.artifactContract', label: 'Artifact contract', config: { required: ['summary.md'] } },
        { id: 'graph', type: 'orpad.graph', label: 'Reusable graph', config: { graphRef: 'orpad.workstream:maintenance-workstream' } },
        { id: 'barrier', type: 'orpad.barrier', label: 'Barrier', config: { waitFor: ['probe'] } },
      ],
      transitions: [
        { id: 'context-to-gate', from: 'context', to: 'gate' },
        { id: 'gate-to-probe', from: 'gate', to: 'probe' },
        { id: 'probe-to-queue', from: 'probe', to: 'queue' },
        { id: 'queue-to-triage', from: 'queue', to: 'triage' },
        { id: 'triage-to-dispatch', from: 'triage', to: 'dispatch' },
        { id: 'dispatch-to-worker', from: 'dispatch', to: 'worker' },
        { id: 'worker-to-skill', from: 'worker', to: 'skill' },
        { id: 'skill-to-tree', from: 'skill', to: 'tree' },
        { id: 'tree-to-rule', from: 'tree', to: 'rule' },
        { id: 'rule-to-contract', from: 'rule', to: 'contract' },
        { id: 'contract-to-graph', from: 'contract', to: 'graph' },
        { id: 'graph-to-barrier', from: 'graph', to: 'barrier' },
      ],
    },
  }, null, 2));
  const pipelinePath = path.join(pipelineRoot, 'pipeline.or-pipeline');
  fs.writeFileSync(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'node-pack-validation',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    nodePacks: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3', origin: 'built-in' },
      { id: 'orpad.workstream', version: '>=0.1.0', origin: 'built-in' },
    ],
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
    trees: [{ id: 'implementation', file: 'trees/implementation.or-tree' }],
    skills: [{ id: 'audit', file: 'skills/audit.md' }],
    rules: [{ id: 'policy', file: 'rules/policy.or-rule' }],
  }, null, 2));

  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);
  await win.evaluate(async () => {
    await (window as any).orpad.getApprovedWorkspace();
  });

  const validation = await win.evaluate(async (filePath) => {
    return await (window as any).orpad.pipelines.validateFile(filePath);
  }, pipelinePath);
  expect(validation.ok).toBe(true);
  expect(validation.canExecute).toBe(false);
  expect(validation.diagnostics.some((item: { code: string }) => item.code === 'GRAPH_NODE_TYPE_UNKNOWN')).toBe(false);
  expect(validation.diagnostics.some((item: { code: string }) => item.code === 'GRAPH_NODE_RENDER_VALIDATE_ONLY')).toBe(true);
  expect(validation.nodeTypes).toContain('orpad.context');
  expect(validation.nodeTypes).toContain('orpad.gate');
  expect(validation.nodeTypes).toContain('orpad.graph');
  expect(validation.nodeTypes).toContain('orpad.workQueue');
  expect(validation.nodeTypes).toContain('orpad.skill');
  expect(validation.executableNodeTypes).toContain('orpad.gate');
  expect(validation.renderOnlyNodeTypes).not.toContain('orpad.gate');
  expect(validation.renderOnlyNodeTypes).toContain('orpad.probe');
  expect(validation.diagnostics.some((item: { code: string }) => item.code === 'PIPELINE_AGENT_ORCHESTRATED')).toBe(true);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('pipeline validator follows nested graph refs and validates node contracts', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-pipeline-nested-graph-'));
  const pipelineRoot = path.join(workspace, '.orpad', 'pipelines', 'nested-graph-validation');
  fs.mkdirSync(path.join(pipelineRoot, 'graphs'), { recursive: true });
  fs.writeFileSync(path.join(pipelineRoot, 'graphs', 'child.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'child',
      nodes: [
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'queue' } },
      ],
      transitions: [],
    },
  }, null, 2));
  fs.writeFileSync(path.join(pipelineRoot, 'graphs', 'main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'main',
      nodes: [
        { id: 'child', type: 'orpad.graph', label: 'Child graph', config: { graphRef: 'child.or-graph' } },
      ],
      transitions: [],
    },
  }, null, 2));
  const pipelinePath = path.join(pipelineRoot, 'pipeline.or-pipeline');
  fs.writeFileSync(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'nested-graph-validation',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    graphs: [
      { id: 'main', file: 'graphs/main.or-graph' },
      { id: 'child', file: 'graphs/child.or-graph' },
    ],
  }, null, 2));

  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);
  await win.evaluate(async () => {
    await (window as any).orpad.getApprovedWorkspace();
  });

  const validation = await win.evaluate(async (filePath) => {
    return await (window as any).orpad.pipelines.validateFile(filePath);
  }, pipelinePath);
  expect(validation.ok).toBe(false);
  expect(validation.canExecute).toBe(false);
  expect(validation.graphCount).toBe(2);
  expect(validation.nodeTypes).toContain('orpad.graph');
  expect(validation.nodeTypes).toContain('orpad.dispatcher');
  expect(validation.diagnostics.some((item: { code: string; refPath?: string }) => (
    item.code === 'GRAPH_NODE_CONFIG_MISSING' && String(item.refPath || '').includes('child.or-graph')
  ))).toBe(true);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('pipeline validator rejects graph queue and worker refs with wrong node types', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-pipeline-ref-contract-'));
  const pipelineRoot = path.join(workspace, '.orpad', 'pipelines', 'ref-contract-validation');
  fs.mkdirSync(path.join(pipelineRoot, 'graphs'), { recursive: true });
  fs.writeFileSync(path.join(pipelineRoot, 'graphs', 'main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'main',
      nodes: [
        { id: 'gate', type: 'orpad.gate', label: 'Gate', config: { criteria: ['local only'] } },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch', config: { queueRef: 'gate', workerLoopRef: 'queue' } },
      ],
      transitions: [],
    },
  }, null, 2));
  const pipelinePath = path.join(pipelineRoot, 'pipeline.or-pipeline');
  fs.writeFileSync(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'ref-contract-validation',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
  }, null, 2));

  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);
  await win.evaluate(async () => {
    await (window as any).orpad.getApprovedWorkspace();
  });

  const validation = await win.evaluate(async (filePath) => {
    return await (window as any).orpad.pipelines.validateFile(filePath);
  }, pipelinePath);
  const diagnosticCodes = validation.diagnostics.map((item: { code: string }) => item.code);
  expect(validation.ok).toBe(false);
  expect(diagnosticCodes).toContain('GRAPH_QUEUE_REF_INVALID_TARGET');
  expect(diagnosticCodes).toContain('GRAPH_WORKER_LOOP_REF_INVALID_TARGET');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('pipeline validator rejects unsupported work item schema contracts', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-pipeline-workitem-schema-'));
  const pipelineRoot = path.join(workspace, '.orpad', 'pipelines', 'schema-contract-validation');
  fs.mkdirSync(path.join(pipelineRoot, 'graphs'), { recursive: true });
  fs.writeFileSync(path.join(pipelineRoot, 'graphs', 'main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'main',
      nodes: [
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'custom.workItem.v9' } },
      ],
      transitions: [],
    },
  }, null, 2));
  const pipelinePath = path.join(pipelineRoot, 'pipeline.or-pipeline');
  fs.writeFileSync(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'schema-contract-validation',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
    run: {
      queueProtocol: {
        schema: 'custom.workItem.v9',
        states: ['candidate', 'queued', 'claimed'],
      },
    },
  }, null, 2));

  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);
  await win.evaluate(async () => {
    await (window as any).orpad.getApprovedWorkspace();
  });

  const validation = await win.evaluate(async (filePath) => {
    return await (window as any).orpad.pipelines.validateFile(filePath);
  }, pipelinePath);
  const diagnosticCodes = validation.diagnostics.map((item: { code: string }) => item.code);
  expect(validation.ok).toBe(false);
  expect(diagnosticCodes).toContain('WORK_QUEUE_SCHEMA_UNSUPPORTED');
  expect(diagnosticCodes).toContain('PIPELINE_QUEUE_PROTOCOL_SCHEMA_UNSUPPORTED');
  expect(diagnosticCodes).toContain('PIPELINE_QUEUE_PROTOCOL_STATES_INCOMPLETE');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('work queue audit rejects malformed active queue artifacts', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-queue-audit-'));
  const pipelinePath = path.join(workspace, 'pipeline.or-pipeline');
  const queueRoot = path.join(workspace, 'queue');
  fs.mkdirSync(path.join(queueRoot, 'candidate'), { recursive: true });
  fs.mkdirSync(path.join(queueRoot, 'done'), { recursive: true });
  fs.mkdirSync(path.join(queueRoot, 'inbox', 'test', 'candidate'), { recursive: true });
  fs.writeFileSync(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'queue-audit',
    run: {
      queueRoot: 'queue',
    },
  }, null, 2));
  fs.writeFileSync(path.join(queueRoot, 'candidate', 'bad.json'), JSON.stringify({
    id: 'bad',
    schemaVersion: 'orpad.workItem.v1',
    state: 'queued',
    title: 'Malformed item',
    sourceNode: 'test',
    contentArea: 'queue',
    issueType: 'test',
    severity: 'P2',
    confidence: 0.9,
    fingerprint: 'bad',
    evidence: [],
    acceptanceCriteria: [],
    approvalRequired: false,
    createdAt: '2026-04-30T00:01:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
  }, null, 2));
  fs.writeFileSync(path.join(queueRoot, 'done', 'bad.json'), JSON.stringify({
    id: 'bad',
    schemaVersion: 'orpad.workItem.v1',
    state: 'done',
    title: 'Done item',
    sourceNode: 'test',
    contentArea: 'queue',
    issueType: 'test',
    severity: 'P2',
    confidence: 0.9,
    fingerprint: 'bad-done',
    evidence: [{ file: 'tests/e2e/runbook-validation.spec.ts' }],
    acceptanceCriteria: ['Audit fails malformed queue state.'],
    approvalRequired: false,
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
  }, null, 2));
  fs.writeFileSync(path.join(queueRoot, 'inbox', 'test', 'candidate', 'orphan.json'), JSON.stringify({
    id: 'orphan',
    schemaVersion: 'orpad.workItem.v1',
    state: 'candidate',
    title: 'Uningested staged candidate',
    sourceNode: 'test',
    contentArea: 'queue',
    issueType: 'test',
    severity: 'P2',
    confidence: 0.9,
    fingerprint: 'orphan',
    evidence: [{ file: 'tests/e2e/runbook-validation.spec.ts' }],
    acceptanceCriteria: ['Audit fails staged candidates that never reach the queue journal.'],
    ...actionableWorkItemFields('orphan'),
    approvalRequired: false,
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
  }, null, 2));
  fs.writeFileSync(path.join(queueRoot, 'journal.jsonl'), [
    '{"ok":true}',
    'not-json',
    JSON.stringify({
      actor: 'orpad.workerLoop',
      action: 'claim',
      itemId: 'ghost',
      fromState: 'queued',
      toState: 'claimed',
      timestamp: 'not-a-timestamp',
      evidence: 'tests/e2e/runbook-validation.spec.ts',
    }),
    JSON.stringify({
      actor: 'maintenance-quality-queue',
      action: 'ingest',
      itemId: 'bad',
      fromState: 'inbox',
      toState: 'done',
      timestamp: '2026-04-30T00:00:00.000Z',
      evidence: 'queue/inbox/test/candidate/bad.json',
    }),
    JSON.stringify({
      actor: 'maintenance-quality-queue',
      action: 'ingest',
      itemId: 'timewarp',
      fromState: 'inbox',
      toState: 'candidate',
      timestamp: '2026-04-30T00:02:00.000Z',
      evidence: 'queue/inbox/test/candidate/timewarp.json',
    }),
    JSON.stringify({
      actor: 'orpad.triage',
      action: 'triage',
      itemId: 'timewarp',
      fromState: 'candidate',
      toState: 'queued',
      timestamp: '2026-04-30T00:01:00.000Z',
      evidence: 'queue/queued/timewarp.json',
    }),
    '',
  ].join('\n'));

  let output = '';
  try {
    execFileSync(process.execPath, ['scripts/audit-orpad-workqueue.mjs', pipelinePath], {
      cwd: path.resolve('.'),
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (err) {
    output = String((err as { stdout?: string }).stdout || '');
  }
  const result = JSON.parse(output);
  const diagnosticCodes = result.diagnostics.map((item: { code: string }) => item.code);
  expect(result.ok).toBe(false);
  expect(diagnosticCodes).toContain('WORK_ITEM_STATE_MISMATCH');
  expect(diagnosticCodes).toContain('WORK_ITEM_EVIDENCE_INVALID');
  expect(diagnosticCodes).toContain('WORK_ITEM_ACCEPTANCE_CRITERIA_INVALID');
  expect(diagnosticCodes).toContain('WORK_ITEM_TIMESTAMP_ORDER_INVALID');
  expect(diagnosticCodes).toContain('WORK_ITEM_DUPLICATE_ACTIVE_STATE');
  expect(diagnosticCodes).toContain('WORK_QUEUE_JOURNAL_JSON_INVALID');
  expect(diagnosticCodes).toContain('WORK_QUEUE_JOURNAL_FIELD_MISSING');
  expect(diagnosticCodes).toContain('WORK_QUEUE_JOURNAL_TRANSITION_INVALID');
  expect(diagnosticCodes).toContain('WORK_QUEUE_JOURNAL_TIMESTAMP_INVALID');
  expect(diagnosticCodes).toContain('WORK_QUEUE_JOURNAL_TIMESTAMP_ORDER_INVALID');
  expect(diagnosticCodes).toContain('WORK_QUEUE_JOURNAL_REPLAY_START_INVALID');
  expect(diagnosticCodes).toContain('WORK_QUEUE_JOURNAL_REPLAY_STATE_MISMATCH');
  expect(diagnosticCodes).toContain('WORK_QUEUE_INBOX_CANDIDATE_NOT_INGESTED');
  expect(diagnosticCodes).toContain('WORK_QUEUE_INGEST_WITHOUT_STAGED_CANDIDATE');
  expect(diagnosticCodes).toContain('WORK_QUEUE_STATE_FILE_UNJOURNALED');
  expect(diagnosticCodes).toContain('WORK_QUEUE_JOURNAL_FINAL_STATE_MISSING');

  fs.rmSync(workspace, { recursive: true, force: true });
});

test('work queue audit accepts journaled active queue artifacts', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-queue-audit-valid-'));
  const pipelinePath = path.join(workspace, 'pipeline.or-pipeline');
  const queueRoot = path.join(workspace, 'queue');
  fs.mkdirSync(path.join(queueRoot, 'candidate'), { recursive: true });
  fs.mkdirSync(path.join(queueRoot, 'inbox', 'test', 'candidate'), { recursive: true });
  fs.writeFileSync(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'queue-audit-valid',
    run: {
      queueRoot: 'queue',
    },
  }, null, 2));
  fs.writeFileSync(path.join(queueRoot, 'candidate', 'good.json'), JSON.stringify({
    id: 'good',
    schemaVersion: 'orpad.workItem.v1',
    state: 'candidate',
    title: 'Valid item',
    sourceNode: 'test',
    contentArea: 'queue',
    issueType: 'test',
    severity: 'P2',
    confidence: 0.9,
    fingerprint: 'good',
    evidence: [{ file: 'tests/e2e/runbook-validation.spec.ts' }],
    acceptanceCriteria: ['Audit accepts journaled queue state.'],
    ...actionableWorkItemFields('good'),
    approvalRequired: false,
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
  }, null, 2));
  fs.copyFileSync(path.join(queueRoot, 'candidate', 'good.json'), path.join(queueRoot, 'inbox', 'test', 'candidate', 'good.json'));
  fs.writeFileSync(path.join(queueRoot, 'journal.jsonl'), `${JSON.stringify({
    actor: 'maintenance-quality-queue',
    action: 'ingest',
    itemId: 'good',
    fromState: 'inbox',
    toState: 'candidate',
    timestamp: '2026-04-30T00:00:00.000Z',
    evidence: 'queue/inbox/test/candidate/good.json',
  })}\n`);

  const output = execFileSync(process.execPath, ['scripts/audit-orpad-workqueue.mjs', pipelinePath], {
    cwd: path.resolve('.'),
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  const result = JSON.parse(output);
  expect(result.ok).toBe(true);
  expect(result.diagnostics).toEqual([]);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test('run audit requires proof artifacts for claimed work items', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-run-audit-proof-'));
  const artifactRoot = path.join(workspace, 'harness', 'generated', 'latest-run', 'artifacts');
  const queueRoot = path.join(workspace, 'harness', 'generated', 'latest-run', 'queue');
  const workItemArtifactRoot = path.join(artifactRoot, 'work-items');
  const summaryPath = path.join(workspace, 'harness', 'generated', 'latest-run', 'summary.md');
  const metadataPath = path.join(workspace, 'harness', 'generated', 'latest-run', 'run-metadata.json');
  const itemId = 'claimed-proof-contract';
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.mkdirSync(path.join(queueRoot, 'done'), { recursive: true });
  fs.mkdirSync(path.join(queueRoot, 'inbox', 'test-gap-probe', 'candidate'), { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, 'reference-context.md'), '# Reference\n');
  fs.writeFileSync(summaryPath, '# Summary\n\n## Status: done');
  const stagedItem = {
    id: itemId,
    schemaVersion: 'orpad.workItem.v1',
    state: 'candidate',
    title: 'Claimed proof contract',
    sourceNode: 'test-gap-probe',
    contentArea: 'run audit',
    issueType: 'test',
    severity: 'P2',
    confidence: 0.9,
    fingerprint: itemId,
    evidence: [{ file: 'tests/e2e/runbook-validation.spec.ts' }],
    acceptanceCriteria: ['Run audit requires proof artifacts for claimed items.'],
    ...actionableWorkItemFields(itemId),
    approvalRequired: false,
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(queueRoot, 'inbox', 'test-gap-probe', 'candidate', `${itemId}.json`), JSON.stringify(stagedItem, null, 2));
  fs.writeFileSync(path.join(queueRoot, 'done', `${itemId}.json`), JSON.stringify({
    id: itemId,
    schemaVersion: 'orpad.workItem.v1',
    state: 'done',
    title: 'Claimed proof contract',
    sourceNode: 'test-gap-probe',
    contentArea: 'run audit',
    issueType: 'test',
    severity: 'P2',
    confidence: 0.9,
    fingerprint: itemId,
    evidence: [{ file: 'tests/e2e/runbook-validation.spec.ts' }],
    acceptanceCriteria: ['Run audit requires proof artifacts for claimed items.'],
    ...actionableWorkItemFields(itemId),
    approvalRequired: false,
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:01:00.000Z',
  }, null, 2));
  fs.writeFileSync(path.join(queueRoot, 'journal.jsonl'), [
    { actor: 'maintenance-quality-queue', action: 'ingest', itemId, fromState: 'inbox', toState: 'candidate', timestamp: '2026-04-30T00:00:00.000Z', evidence: `queue/inbox/test-gap-probe/candidate/${itemId}.json` },
    { actor: 'orpad.triage', action: 'triage', itemId, fromState: 'candidate', toState: 'queued', timestamp: '2026-04-30T00:00:10.000Z', evidence: 'queued' },
    { actor: 'orpad.dispatcher', action: 'claim', itemId, fromState: 'queued', toState: 'claimed', timestamp: '2026-04-30T00:00:20.000Z', evidence: 'claimed' },
    { actor: 'orpad.workerLoop', action: 'close', itemId, fromState: 'claimed', toState: 'done', timestamp: '2026-04-30T00:01:00.000Z', evidence: 'done' },
  ].map(item => JSON.stringify(item)).join('\n') + '\n');

  const pipelinePath = path.join(workspace, 'pipeline.or-pipeline');
  fs.writeFileSync(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'run-audit-proof',
    run: {
      artifactRoot: 'harness/generated/latest-run/artifacts',
      queueRoot: 'harness/generated/latest-run/queue',
      workItemArtifactRoot: 'harness/generated/latest-run/artifacts/work-items',
      metadataPath: 'harness/generated/latest-run/run-metadata.json',
      summaryPath: 'harness/generated/latest-run/summary.md',
      requiredArtifacts: ['reference-context.md'],
      requiredQueueArtifacts: ['journal.jsonl'],
      queueProtocol: {
        schema: 'orpad.workItem.v1',
        states: ['candidate', 'queued', 'claimed', 'done', 'blocked', 'rejected'],
        singleWriter: {
          ingest: 'orpad.workQueue',
          triage: 'orpad.triage',
          claim: 'orpad.dispatcher',
          close: 'orpad.workerLoop',
        },
        ingestPolicy: { journalActor: 'maintenance-quality-queue' },
      },
    },
  }, null, 2));

  const writeMetadata = () => {
    const manifestFiles = [
      summaryPath,
      path.join(artifactRoot, 'reference-context.md'),
      path.join(queueRoot, 'journal.jsonl'),
      path.join(queueRoot, 'inbox', 'test-gap-probe', 'candidate', `${itemId}.json`),
      path.join(queueRoot, 'done', `${itemId}.json`),
    ];
    const proofPath = path.join(workItemArtifactRoot, itemId, 'proof.md');
    if (fs.existsSync(proofPath)) manifestFiles.push(proofPath);
    fs.writeFileSync(metadataPath, JSON.stringify({
      schemaVersion: 'orpad.runEvidence.v1',
      pipelineId: 'run-audit-proof',
      runId: 'latest-run',
      startedAt: '2026-04-30T00:00:00.000Z',
      endedAt: '2026-04-30T00:01:00.000Z',
      headSha: gitOutput(['rev-parse', 'HEAD']),
      workspaceStatusDigest: currentStatusDigest(),
      status: 'done',
      auditCommands: [],
      artifactManifest: {
        schemaVersion: 'orpad.artifactManifest.v1',
        files: manifestFiles.map(filePath => evidenceManifestEntry(workspace, filePath)).sort((a, b) => a.path.localeCompare(b.path)),
      },
    }, null, 2));
  };
  writeMetadata();

  let missingProofOutput = '';
  try {
    execFileSync(process.execPath, ['scripts/audit-orpad-run.mjs', pipelinePath], {
      cwd: path.resolve('.'),
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (err) {
    missingProofOutput = String((err as { stdout?: string }).stdout || '');
  }
  const missingProof = JSON.parse(missingProofOutput);
  expect(missingProof.ok).toBe(false);
  expect(missingProof.diagnostics.map((item: { code: string }) => item.code)).toContain('RUN_WORK_ITEM_PROOF_MISSING');

  fs.mkdirSync(path.join(workItemArtifactRoot, itemId), { recursive: true });
  fs.writeFileSync(path.join(workItemArtifactRoot, itemId, 'proof.md'), '# Proof\n');
  writeMetadata();

  const passedOutput = execFileSync(process.execPath, ['scripts/audit-orpad-run.mjs', pipelinePath], {
    cwd: path.resolve('.'),
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  const passed = JSON.parse(passedOutput);
  expect(passed.ok).toBe(true);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test('run audit enforces latest-run metadata and discovery coverage contracts', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-run-audit-'));
  const artifactRoot = path.join(workspace, 'harness', 'generated', 'latest-run', 'artifacts');
  const discoveryRoot = path.join(artifactRoot, 'discovery');
  const queueRoot = path.join(workspace, 'harness', 'generated', 'latest-run', 'queue');
  fs.mkdirSync(discoveryRoot, { recursive: true });
  fs.mkdirSync(path.join(queueRoot, 'inbox', 'ux-ui-probe', 'candidate'), { recursive: true });
  fs.mkdirSync(path.join(queueRoot, 'candidate'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'src', 'renderer'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'tests', 'e2e'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'renderer', 'renderer.js'), 'console.log("fixture");\n');
  fs.writeFileSync(path.join(workspace, 'tests', 'e2e', 'runbook-pipeline-editor.spec.ts'), 'export {};\n');
  fs.writeFileSync(path.join(artifactRoot, 'reference-context.md'), '# Reference\n');
  fs.writeFileSync(path.join(workspace, 'harness', 'generated', 'latest-run', 'summary.md'), '# Summary\n\n## Status: done');
  const candidateItem = {
    id: 'ux-actionability-link',
    schemaVersion: 'orpad.workItem.v1',
    state: 'candidate',
    title: 'UX actionability coverage link',
    sourceNode: 'ux-ui-probe',
    contentArea: 'pipeline editor',
    issueType: 'ux',
    severity: 'P2',
    confidence: 0.85,
    fingerprint: 'ux-actionability-link',
    evidence: [{ file: 'tests/e2e/runbook-validation.spec.ts' }],
    acceptanceCriteria: ['Run audit validates work item coverage evidence links.'],
    userImpact: 'Users need actionable UX work items that point back to observed evidence.',
    reproSteps: ['Open the fixture pipeline.', 'Inspect the UX coverage manifest.', 'Run the run audit.'],
    expectedBehavior: 'The work item links to coverage evidence captured in this run.',
    actualBehavior: 'The fixture candidate represents a valid coverage-linked work item.',
    sourceOfTruthTargets: ['tests/e2e/runbook-validation.spec.ts'],
    verificationPlan: 'Run the run audit fixture test.',
    coverageEvidenceIds: ['ux-pipeline-editor'],
    approvalRequired: false,
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(queueRoot, 'inbox', 'ux-ui-probe', 'candidate', 'ux-actionability-link.json'), JSON.stringify(candidateItem, null, 2));
  fs.writeFileSync(path.join(queueRoot, 'candidate', 'ux-actionability-link.json'), JSON.stringify(candidateItem, null, 2));
  fs.writeFileSync(path.join(queueRoot, 'journal.jsonl'), `${JSON.stringify({
    actor: 'maintenance-quality-queue',
    action: 'ingest',
    itemId: 'ux-actionability-link',
    fromState: 'inbox',
    toState: 'candidate',
    timestamp: '2026-04-30T00:00:00.000Z',
    evidence: 'queue/inbox/ux-ui-probe/candidate/ux-actionability-link.json',
  })}\n`);
  const metadataPath = path.join(workspace, 'harness', 'generated', 'latest-run', 'run-metadata.json');
  const baseMetadata = {
    schemaVersion: 'orpad.runEvidence.v1',
    pipelineId: 'run-audit',
    runId: 'latest-run',
    startedAt: '2026-04-30T00:00:00.000Z',
    endedAt: '2026-04-30T00:01:00.000Z',
    headSha: gitOutput(['rev-parse', 'HEAD']),
    workspaceStatusDigest: currentStatusDigest(),
    status: 'done',
    auditCommands: [
      {
        command: 'npm run audit:orpad-node-schemas -- pipeline.or-pipeline',
        timing: 'post-run',
        ok: true,
        summary: 'Node schema audit passed for the run fixture.',
      },
      {
        command: 'npm run audit:orpad-run -- pipeline.or-pipeline',
        timing: 'post-run',
        ok: true,
        summary: 'Run evidence audit passed for the run fixture.',
      },
    ],
  };
  fs.writeFileSync(path.join(discoveryRoot, 'coverage-manifest.json'), JSON.stringify({
    schemaVersion: 'orpad.discoveryCoverage.v1',
    lenses: {
      'ux-ui-probe': {
        evidence: [
          {
            id: 'ux-runbook-list',
            type: 'app-or-dom',
            target: 'runbook list',
            command: 'playwright inspect runbook list',
            result: 'observed',
            observedAt: '2026-04-30T00:00:10.000Z',
            observationKind: 'playwright',
            summary: 'Runbook list inspected in the current run.',
          },
          {
            id: 'ux-pipeline-editor',
            type: 'app-or-dom',
            target: 'pipeline editor',
            command: 'playwright inspect pipeline editor',
            result: 'observed',
            observedAt: '2026-04-30T00:00:20.000Z',
            observationKind: 'playwright',
            summary: 'Pipeline editor inspected in the current run.',
          },
          {
            id: 'ux-graph-editor-code',
            type: 'code-or-test',
            target: 'graph editor',
            file: 'tests/e2e/runbook-pipeline-editor.spec.ts',
            observedAt: '2026-04-30T00:00:30.000Z',
            observationKind: 'source-read',
            summary: 'Graph editor coverage inspected in test source.',
          },
          {
            id: 'ux-manifest-editor-code',
            type: 'code-or-test',
            target: 'details editor',
            file: 'src/renderer/renderer.js',
            observedAt: '2026-04-30T00:00:40.000Z',
            observationKind: 'source-read',
            summary: 'Details editor implementation inspected in source.',
          },
        ],
        scenarios: [
          { id: 'open-pipes-list', status: 'pass', evidenceIds: ['ux-runbook-list'] },
          { id: 'edit-pipeline-manifest', status: 'pass', evidenceIds: ['ux-pipeline-editor', 'ux-manifest-editor-code'] },
          { id: 'inspect-graph-editor', status: 'pass', evidenceIds: ['ux-graph-editor-code'] },
        ],
        candidatesStaged: ['ux-actionability-link'],
        emptyPassReason: 'All required UI targets had current evidence in this fixture, including runbook list, pipeline editor, graph editor, and details editor.',
      },
    },
  }, null, 2));
  const pipelinePath = path.join(workspace, 'pipeline.or-pipeline');
  fs.writeFileSync(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'run-audit',
    run: {
      artifactRoot: 'harness/generated/latest-run/artifacts',
      queueRoot: 'harness/generated/latest-run/queue',
      probeInboxRoot: 'harness/generated/latest-run/queue/inbox',
      metadataPath: 'harness/generated/latest-run/run-metadata.json',
      coverageManifestPath: 'harness/generated/latest-run/artifacts/discovery/coverage-manifest.json',
      summaryPath: 'harness/generated/latest-run/summary.md',
      requiredArtifacts: ['reference-context.md', 'discovery/coverage-manifest.json'],
      requiredQueueArtifacts: ['journal.jsonl'],
      discoveryCoveragePolicy: {
        minimumLensEvidence: {
          'ux-ui-probe': {
            minimumEvidenceItems: 4,
            requiredTargets: ['runbook list', 'pipeline editor', 'graph editor', 'details editor'],
            requiredScenarios: ['open-pipes-list', 'edit-pipeline-manifest', 'inspect-graph-editor'],
          },
        },
      },
    },
    executionPolicy: {
      verificationDefaults: [
        'npm run audit:orpad-node-schemas -- pipeline.or-pipeline',
        'npm run audit:orpad-run -- pipeline.or-pipeline',
      ],
    },
  }, null, 2));
  const writeMetadata = () => {
    const metadata = {
      ...baseMetadata,
      artifactManifest: {
        schemaVersion: 'orpad.artifactManifest.v1',
        files: [
          path.join(workspace, 'harness', 'generated', 'latest-run', 'summary.md'),
          path.join(discoveryRoot, 'coverage-manifest.json'),
          path.join(artifactRoot, 'reference-context.md'),
          path.join(queueRoot, 'journal.jsonl'),
          path.join(queueRoot, 'inbox', 'ux-ui-probe', 'candidate', 'ux-actionability-link.json'),
          path.join(queueRoot, 'candidate', 'ux-actionability-link.json'),
        ].map(filePath => evidenceManifestEntry(workspace, filePath)).sort((a, b) => a.path.localeCompare(b.path)),
      },
    };
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  };
  writeMetadata();

  const output = execFileSync(process.execPath, ['scripts/audit-orpad-run.mjs', pipelinePath], {
    cwd: path.resolve('.'),
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  const result = JSON.parse(output);
  expect(result.ok).toBe(true);
  expect(result.diagnostics).toEqual([]);

  const candidatePath = path.join(queueRoot, 'candidate', 'ux-actionability-link.json');
  const inboxCandidatePath = path.join(queueRoot, 'inbox', 'ux-ui-probe', 'candidate', 'ux-actionability-link.json');
  const candidateWithBadEvidenceLink = JSON.parse(fs.readFileSync(candidatePath, 'utf-8'));
  candidateWithBadEvidenceLink.coverageEvidenceIds = ['missing-coverage-evidence'];
  fs.writeFileSync(candidatePath, JSON.stringify(candidateWithBadEvidenceLink, null, 2));
  fs.writeFileSync(inboxCandidatePath, JSON.stringify(candidateWithBadEvidenceLink, null, 2));
  writeMetadata();
  let badCoverageLinkOutput = '';
  try {
    execFileSync(process.execPath, ['scripts/audit-orpad-run.mjs', pipelinePath], {
      cwd: path.resolve('.'),
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (err) {
    badCoverageLinkOutput = String((err as { stdout?: string }).stdout || '');
  }
  const badCoverageLink = JSON.parse(badCoverageLinkOutput);
  expect(badCoverageLink.ok).toBe(false);
  expect(badCoverageLink.diagnostics.map((item: { code: string }) => item.code)).toContain('WORK_ITEM_COVERAGE_EVIDENCE_UNKNOWN');
  fs.writeFileSync(candidatePath, JSON.stringify(candidateItem, null, 2));
  fs.writeFileSync(inboxCandidatePath, JSON.stringify(candidateItem, null, 2));
  writeMetadata();

  const coveragePath = path.join(discoveryRoot, 'coverage-manifest.json');
  const coverageMissingLiveSource = JSON.parse(fs.readFileSync(coveragePath, 'utf-8'));
  delete coverageMissingLiveSource.lenses['ux-ui-probe'].evidence[0].command;
  fs.writeFileSync(coveragePath, JSON.stringify(coverageMissingLiveSource, null, 2));
  writeMetadata();
  let missingLiveSourceOutput = '';
  try {
    execFileSync(process.execPath, ['scripts/audit-orpad-run.mjs', pipelinePath], {
      cwd: path.resolve('.'),
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (err) {
    missingLiveSourceOutput = String((err as { stdout?: string }).stdout || '');
  }
  const missingLiveSource = JSON.parse(missingLiveSourceOutput);
  expect(missingLiveSource.ok).toBe(false);
  expect(missingLiveSource.diagnostics.map((item: { code: string }) => item.code)).toContain('DISCOVERY_EVIDENCE_LIVE_SOURCE_MISSING');
  fs.writeFileSync(coveragePath, JSON.stringify({
    schemaVersion: 'orpad.discoveryCoverage.v1',
    lenses: {
      'ux-ui-probe': {
        evidence: [
          {
            id: 'ux-runbook-list',
            type: 'app-or-dom',
            target: 'runbook list',
            command: 'playwright inspect runbook list',
            result: 'observed',
            observedAt: '2026-04-30T00:00:10.000Z',
            observationKind: 'playwright',
            summary: 'Runbook list inspected in the current run.',
          },
          {
            id: 'ux-pipeline-editor',
            type: 'app-or-dom',
            target: 'pipeline editor',
            command: 'playwright inspect pipeline editor',
            result: 'observed',
            observedAt: '2026-04-30T00:00:20.000Z',
            observationKind: 'playwright',
            summary: 'Pipeline editor inspected in the current run.',
          },
          {
            id: 'ux-graph-editor-code',
            type: 'code-or-test',
            target: 'graph editor',
            file: 'tests/e2e/runbook-pipeline-editor.spec.ts',
            observedAt: '2026-04-30T00:00:30.000Z',
            observationKind: 'source-read',
            summary: 'Graph editor coverage inspected in test source.',
          },
          {
            id: 'ux-manifest-editor-code',
            type: 'code-or-test',
            target: 'details editor',
            file: 'src/renderer/renderer.js',
            observedAt: '2026-04-30T00:00:40.000Z',
            observationKind: 'source-read',
            summary: 'Details editor implementation inspected in source.',
          },
        ],
        scenarios: [
          { id: 'open-pipes-list', status: 'pass', evidenceIds: ['ux-runbook-list'] },
          { id: 'edit-pipeline-manifest', status: 'pass', evidenceIds: ['ux-pipeline-editor', 'ux-manifest-editor-code'] },
          { id: 'inspect-graph-editor', status: 'pass', evidenceIds: ['ux-graph-editor-code'] },
        ],
        candidatesStaged: ['ux-actionability-link'],
        emptyPassReason: 'All required UI targets had current evidence in this fixture, including runbook list, pipeline editor, graph editor, and details editor.',
      },
    },
  }, null, 2));
  writeMetadata();

  const summaryPath = path.join(workspace, 'harness', 'generated', 'latest-run', 'summary.md');
  fs.appendFileSync(summaryPath, '\nTampered after metadata capture.');
  let staleArtifactOutput = '';
  try {
    execFileSync(process.execPath, ['scripts/audit-orpad-run.mjs', pipelinePath], {
      cwd: path.resolve('.'),
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (err) {
    staleArtifactOutput = String((err as { stdout?: string }).stdout || '');
  }
  const staleArtifact = JSON.parse(staleArtifactOutput);
  expect(staleArtifact.ok).toBe(false);
  expect(staleArtifact.diagnostics.map((item: { code: string }) => item.code)).toContain('RUN_METADATA_ARTIFACT_MANIFEST_HASH_MISMATCH');
  fs.writeFileSync(summaryPath, '# Summary\n\n## Status: done');
  writeMetadata();

  baseMetadata.endedAt = '2026-04-29T23:59:00.000Z';
  writeMetadata();
  let badTimeOutput = '';
  try {
    execFileSync(process.execPath, ['scripts/audit-orpad-run.mjs', pipelinePath], {
      cwd: path.resolve('.'),
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (err) {
    badTimeOutput = String((err as { stdout?: string }).stdout || '');
  }
  const badTime = JSON.parse(badTimeOutput);
  expect(badTime.ok).toBe(false);
  expect(badTime.diagnostics.map((item: { code: string }) => item.code)).toContain('RUN_METADATA_TIME_ORDER_INVALID');
  baseMetadata.endedAt = '2026-04-30T00:01:00.000Z';
  writeMetadata();

  const coverageForEmptyPass = JSON.parse(fs.readFileSync(path.join(discoveryRoot, 'coverage-manifest.json'), 'utf-8'));
  coverageForEmptyPass.lenses['ux-ui-probe'].candidatesStaged = [];
  coverageForEmptyPass.lenses['ux-ui-probe'].emptyPassReason = 'No issue found';
  fs.writeFileSync(path.join(discoveryRoot, 'coverage-manifest.json'), JSON.stringify(coverageForEmptyPass, null, 2));
  writeMetadata();
  let weakEmptyPassOutput = '';
  try {
    execFileSync(process.execPath, ['scripts/audit-orpad-run.mjs', pipelinePath], {
      cwd: path.resolve('.'),
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (err) {
    weakEmptyPassOutput = String((err as { stdout?: string }).stdout || '');
  }
  const weakEmptyPass = JSON.parse(weakEmptyPassOutput);
  expect(weakEmptyPass.ok).toBe(false);
  expect(weakEmptyPass.diagnostics.map((item: { code: string }) => item.code)).toContain('DISCOVERY_LENS_EMPTY_PASS_REASON_WEAK');

  coverageForEmptyPass.lenses['ux-ui-probe'].emptyPassReason = 'All required UI targets had current evidence in this fixture, including runbook list, pipeline editor, graph editor, and details editor.';
  coverageForEmptyPass.lenses['ux-ui-probe'].candidatesStaged = ['missing-candidate'];
  fs.writeFileSync(path.join(discoveryRoot, 'coverage-manifest.json'), JSON.stringify(coverageForEmptyPass, null, 2));
  writeMetadata();
  let missingCandidateOutput = '';
  try {
    execFileSync(process.execPath, ['scripts/audit-orpad-run.mjs', pipelinePath], {
      cwd: path.resolve('.'),
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (err) {
    missingCandidateOutput = String((err as { stdout?: string }).stdout || '');
  }
  const missingCandidate = JSON.parse(missingCandidateOutput);
  expect(missingCandidate.ok).toBe(false);
  expect(missingCandidate.diagnostics.map((item: { code: string }) => item.code)).toContain('DISCOVERY_LENS_CANDIDATE_FILE_MISSING');

  coverageForEmptyPass.lenses['ux-ui-probe'].candidatesStaged = ['ux-actionability-link'];
  fs.writeFileSync(path.join(discoveryRoot, 'coverage-manifest.json'), JSON.stringify(coverageForEmptyPass, null, 2));
  writeMetadata();

  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
  metadata.auditCommands = metadata.auditCommands.filter((item: { command: string }) => !item.command.includes('audit:orpad-node-schemas'));
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

  let missingAuditOutput = '';
  try {
    execFileSync(process.execPath, ['scripts/audit-orpad-run.mjs', pipelinePath], {
      cwd: path.resolve('.'),
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (err) {
    missingAuditOutput = String((err as { stdout?: string }).stdout || '');
  }
  const missingAudit = JSON.parse(missingAuditOutput);
  expect(missingAudit.ok).toBe(false);
  expect(missingAudit.diagnostics.map((item: { code: string }) => item.code)).toContain('RUN_METADATA_AUDIT_COMMAND_MISSING');

  metadata.auditCommands.push({
    command: 'npm run audit:orpad-node-schemas -- pipeline.or-pipeline',
    timing: 'post-run',
    ok: true,
    summary: 'Node schema audit passed for the run fixture.',
  });
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

  const coverage = JSON.parse(fs.readFileSync(path.join(discoveryRoot, 'coverage-manifest.json'), 'utf-8'));
  coverage.lenses['ux-ui-probe'].evidence = coverage.lenses['ux-ui-probe'].evidence.slice(0, 1);
  fs.writeFileSync(path.join(discoveryRoot, 'coverage-manifest.json'), JSON.stringify(coverage, null, 2));

  let failedOutput = '';
  try {
    execFileSync(process.execPath, ['scripts/audit-orpad-run.mjs', pipelinePath], {
      cwd: path.resolve('.'),
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (err) {
    failedOutput = String((err as { stdout?: string }).stdout || '');
  }
  const failed = JSON.parse(failedOutput);
  expect(failed.ok).toBe(false);
  expect(failed.diagnostics.map((item: { code: string }) => item.code)).toContain('DISCOVERY_LENS_EVIDENCE_TOO_LOW');

  fs.rmSync(workspace, { recursive: true, force: true });
});

test('run audit rejects boilerplate empty-pass candidate inventory rows', async () => {
  const auditModule = await import(pathToFileURL(path.resolve('scripts/audit-orpad-run.mjs')).href) as {
    auditCandidateInventory: (
      inventory: Record<string, unknown>,
      policy: Record<string, unknown>,
      options: Record<string, unknown>
    ) => Array<{ code: string; field?: string }>;
    auditInventoryCycleStatus: (
      inventory: Record<string, unknown>,
      summaryStatus: string,
      runSelection: Record<string, unknown>,
      inventoryPath: string
    ) => Array<{ code: string }>;
  };
  const policy = {
    minimumLensEvidence: {
      'ux-ui-probe': {
        requiredScenarios: ['inspect-graph-editor'],
      },
    },
    targetMatrix: {
      'ux-ui-probe': [
        {
          id: 'ux.graph-editor',
          target: 'graph editor',
          scenarios: ['inspect-graph-editor'],
          riskChecks: [
            {
              id: 'ux.graph-editor.type-filtering',
              question: 'Does graph editing hide legacy/tree-only node types and show only valid graph node types?',
            },
          ],
        },
      ],
    },
  };
  const boilerplateInventory = {
    schemaVersion: 'orpad.candidateInventory.v1',
    items: [
      {
        id: 'ux-ui-probe:ux.graph-editor.type-filtering',
        lensId: 'ux-ui-probe',
        status: 'empty-pass',
        checkResult: 'pass',
        title: 'Risk check passed: ux.graph-editor.type-filtering',
        evidenceIds: ['graph-editor-suite'],
        targetIds: ['ux.graph-editor'],
        riskCheckIds: ['ux.graph-editor.type-filtering'],
        scenarioIds: ['inspect-graph-editor'],
        inspectedTargets: ['graph editor'],
        reason: "Current evidence directly probed ux.graph-editor.type-filtering for graph editor and did not leave a separate actionable failure after this cycle's selected fix.",
        negativeCheck: {
          method: 'Inspected graph editor with current source, focused tests, or audit command evidence for risk ux.graph-editor.type-filtering.',
          expected: 'The risk check ux.graph-editor.type-filtering should either produce a staged work item or have concrete passing evidence tied to this run.',
          observed: 'The current run evidence linked to this row showed the risk was covered without a separate actionable candidate.',
        },
      },
    ],
  };
  const options = {
    coverageEvidenceIds: new Set(['graph-editor-suite']),
    coverageEvidenceById: new Map([['graph-editor-suite', {
      file: 'tests/e2e/runbook-pipeline-editor.spec.ts',
      command: 'npm run test:electron -- --workers=1 --grep "pipeline details preview"',
    }]]),
    scenariosByLens: new Map([['ux-ui-probe', new Set(['inspect-graph-editor'])]]),
  };

  const weakDiagnostics = auditModule.auditCandidateInventory(boilerplateInventory, policy, options);
  const weakCodes = weakDiagnostics.map(item => item.code);
  expect(weakCodes).toContain('CANDIDATE_INVENTORY_EMPTY_PASS_REASON_WEAK');
  expect(weakCodes).toContain('CANDIDATE_INVENTORY_NEGATIVE_CHECK_BOILERPLATE');
  expect(weakCodes).toContain('CANDIDATE_INVENTORY_NEGATIVE_CHECK_NOT_CONCRETE');
  expect(weakCodes).toContain('CANDIDATE_INVENTORY_NEGATIVE_CHECK_EVIDENCE_UNLINKED');

  const concreteInventory = JSON.parse(JSON.stringify(boilerplateInventory));
  concreteInventory.items[0].title = 'Graph editor type filtering passed with focused DOM evidence';
  concreteInventory.items[0].reason = 'The Type select in tests/e2e/runbook-pipeline-editor.spec.ts was checked against the graph editor surface, and src/renderer/renderer.js maps graph editing to validator-supported graph node types.';
  concreteInventory.items[0].negativeCheck = {
    method: 'Ran npm run test:electron -- --workers=1 --grep "pipeline details preview" and inspected tests/e2e/runbook-pipeline-editor.spec.ts assertions for graph editor Type select options.',
    expected: 'The graph editor Type select should offer validator-supported graph node types and exclude tree-only legacy node types on the graph surface.',
    observed: 'tests/e2e/runbook-pipeline-editor.spec.ts asserted the graph editor shows State, Tool, Human, and Wait options while src/renderer/renderer.js keeps tree-only Action/Sequence choices off the graph surface.',
  };

  const concreteDiagnostics = auditModule.auditCandidateInventory(concreteInventory, policy, options);
  expect(concreteDiagnostics).toEqual([]);

  const deferredDoneDiagnostics = auditModule.auditInventoryCycleStatus({
    schemaVersion: 'orpad.candidateInventory.v1',
    items: [
      {
        id: 'ux-ui-probe:needs-live-viewport-proof',
        lensId: 'ux-ui-probe',
        status: 'deferred',
        reason: 'Live viewport evidence could not be collected in this run, so the observation still needs follow-up proof.',
      },
    ],
  }, 'done', {}, 'candidate-inventory.json');
  expect(deferredDoneDiagnostics.map(item => item.code)).toContain('RUN_INVENTORY_DEFERRED_WITH_DONE_STATUS');
  expect(auditModule.auditInventoryCycleStatus({ items: [] }, 'partial', {}, 'candidate-inventory.json')).toEqual([]);
});

test('node schema audit rejects graph config keys missing from node-pack schema', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-node-schema-audit-'));
  const nodeDir = path.join(workspace, 'nodes', 'orpad.workstream', 'nodes');
  const pipelineRoot = path.join(workspace, '.orpad', 'pipelines', 'schema-drift');
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.mkdirSync(path.join(pipelineRoot, 'graphs'), { recursive: true });
  fs.writeFileSync(path.join(nodeDir, 'probe.or-node'), JSON.stringify({
    kind: 'orpad.node',
    schemaVersion: '1.0',
    type: 'orpad.probe',
    configSchema: {
      type: 'object',
      properties: {
        lens: { type: 'string' },
        maxCandidates: { type: 'number' },
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(pipelineRoot, 'graphs', 'main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      nodes: [
        { id: 'probe', type: 'orpad.probe', config: { lens: 'ux-ui', queueRef: 'queue', maxCandidates: 'many' } },
      ],
    },
  }, null, 2));
  const pipelinePath = path.join(pipelineRoot, 'pipeline.or-pipeline');
  fs.writeFileSync(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'schema-drift',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2));

  let failedOutput = '';
  try {
    execFileSync(process.execPath, ['scripts/audit-orpad-node-schemas.mjs', pipelinePath, workspace], {
      cwd: path.resolve('.'),
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (err) {
    failedOutput = String((err as { stdout?: string }).stdout || '');
  }
  const failed = JSON.parse(failedOutput);
  expect(failed.ok).toBe(false);
  expect(failed.diagnostics.map((item: { code: string }) => item.code)).toContain('NODE_CONFIG_SCHEMA_DRIFT');
  expect(failed.diagnostics.map((item: { code: string }) => item.code)).toContain('NODE_CONFIG_SCHEMA_VIOLATION');

  const schema = JSON.parse(fs.readFileSync(path.join(nodeDir, 'probe.or-node'), 'utf-8'));
  schema.configSchema.properties.queueRef = { type: 'string' };
  fs.writeFileSync(path.join(nodeDir, 'probe.or-node'), JSON.stringify(schema, null, 2));
  const graph = JSON.parse(fs.readFileSync(path.join(pipelineRoot, 'graphs', 'main.or-graph'), 'utf-8'));
  graph.graph.nodes[0].config.maxCandidates = 2;
  fs.writeFileSync(path.join(pipelineRoot, 'graphs', 'main.or-graph'), JSON.stringify(graph, null, 2));
  const output = execFileSync(process.execPath, ['scripts/audit-orpad-node-schemas.mjs', pipelinePath, workspace], {
    cwd: path.resolve('.'),
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  const passed = JSON.parse(output);
  expect(passed.ok).toBe(true);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test('node schema audit rejects symlinked graph refs outside the pipeline root', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-node-schema-audit-boundary-'));
  const nodeDir = path.join(workspace, 'nodes', 'orpad.core', 'nodes');
  const pipelineRoot = path.join(workspace, '.orpad', 'pipelines', 'schema-boundary');
  const externalGraphRoot = path.join(workspace, 'external-graphs');
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.mkdirSync(path.join(pipelineRoot, 'graphs'), { recursive: true });
  fs.mkdirSync(externalGraphRoot, { recursive: true });
  fs.writeFileSync(path.join(nodeDir, 'context.or-node'), JSON.stringify({
    kind: 'orpad.node',
    schemaVersion: '1.0',
    type: 'orpad.context',
    configSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(externalGraphRoot, 'main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      nodes: [
        { id: 'context', type: 'orpad.context', config: { summary: 'Escaped graph.' } },
      ],
      transitions: [],
    },
  }, null, 2));

  try {
    fs.symlinkSync(externalGraphRoot, path.join(pipelineRoot, 'graphs', 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    fs.rmSync(workspace, { recursive: true, force: true });
    test.skip(true, `Filesystem could not create a graph boundary symlink: ${(err as Error).message}`);
    return;
  }

  fs.writeFileSync(path.join(pipelineRoot, 'pipeline.or-pipeline'), JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'schema-boundary',
    entryGraph: 'graphs/external/main.or-graph',
  }, null, 2));

  let output = '';
  try {
    output = execFileSync(process.execPath, ['scripts/audit-orpad-node-schemas.mjs', path.join(pipelineRoot, 'pipeline.or-pipeline'), workspace], {
      cwd: path.resolve('.'),
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  } catch (err) {
    output = String((err as { stdout?: string }).stdout || '');
  }
  const result = JSON.parse(output);
  expect(result.ok).toBe(false);
  expect(result.diagnostics.map((item: { code: string }) => item.code)).toContain('GRAPH_REF_OUTSIDE_PIPELINE');
  expect(result.diagnostics.some((item: { realPath?: string }) => String(item.realPath || '').includes('external-graphs'))).toBe(true);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test('pipeline document trust level overrides local validation options', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-pipeline-trust-'));
  const pipelineRoot = path.join(workspace, '.orpad', 'pipelines', 'imported-audit');
  fs.mkdirSync(path.join(pipelineRoot, 'graphs'), { recursive: true });
  fs.mkdirSync(path.join(pipelineRoot, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(pipelineRoot, 'skills', 'audit.md'), '# Audit\n');
  fs.writeFileSync(path.join(pipelineRoot, 'graphs', 'main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'imported-audit',
      nodes: [
        { id: 'audit', type: 'Skill', label: 'Audit', file: '../skills/audit.md' },
      ],
      transitions: [],
    },
  }, null, 2));
  const pipelinePath = path.join(pipelineRoot, 'pipeline.or-pipeline');
  fs.writeFileSync(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'imported-audit',
    trustLevel: 'imported-review',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2));

  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);
  await win.evaluate(async () => {
    await (window as any).orpad.getApprovedWorkspace();
  });

  const validation = await win.evaluate(async (filePath) => {
    return await (window as any).orpad.pipelines.validateFile(filePath, { trustLevel: 'local-authored' });
  }, pipelinePath);
  expect(validation.ok).toBe(true);
  expect(validation.trustLevel).toBe('imported-review');
  expect(validation.canExecute).toBe(false);
  expect(validation.diagnostics.some((item: { code: string }) => item.code === 'TRUST_REVIEW_REQUIRED')).toBe(true);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('pipeline validator warns when entry graph is omitted from graph manifest refs', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-pipeline-entry-'));
  const pipelineRoot = path.join(workspace, '.orpad', 'pipelines', 'entry-contract');
  fs.mkdirSync(path.join(pipelineRoot, 'graphs'), { recursive: true });
  fs.writeFileSync(path.join(pipelineRoot, 'graphs', 'main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'entry-contract',
      nodes: [
        { id: 'context', type: 'Context', label: 'Collect context' },
      ],
      transitions: [],
    },
  }, null, 2));
  fs.writeFileSync(path.join(pipelineRoot, 'graphs', 'other.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'other',
      nodes: [
        { id: 'context', type: 'Context', label: 'Other context' },
      ],
      transitions: [],
    },
  }, null, 2));
  const pipelinePath = path.join(pipelineRoot, 'pipeline.or-pipeline');
  fs.writeFileSync(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'entry-contract',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    graphs: [{ id: 'other', file: 'graphs/other.or-graph' }],
  }, null, 2));

  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);
  await win.evaluate(async () => {
    await (window as any).orpad.getApprovedWorkspace();
  });

  const validation = await win.evaluate(async (filePath) => {
    return await (window as any).orpad.pipelines.validateFile(filePath);
  }, pipelinePath);
  expect(validation.ok).toBe(true);
  expect(validation.canExecute).toBe(true);
  expect(validation.diagnostics.some((item: { code: string }) => item.code === 'PIPELINE_ENTRY_GRAPH_NOT_DECLARED')).toBe(true);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('noncanonical pipeline run records can be read back from sibling runs directory', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-pipeline-root-'));
  fs.mkdirSync(path.join(workspace, 'graphs'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'skills', 'audit.md'), '# Audit\n');
  fs.writeFileSync(path.join(workspace, 'graphs', 'main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'root-pipeline',
      nodes: [
        { id: 'audit', type: 'Skill', label: 'Audit', file: '../skills/audit.md' },
      ],
      transitions: [],
    },
  }, null, 2));
  const pipelinePath = path.join(workspace, 'pipeline.or-pipeline');
  fs.writeFileSync(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'root-pipeline',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2));

  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);
  await win.evaluate(async () => {
    await (window as any).orpad.getApprovedWorkspace();
  });

  const created = await win.evaluate(async ({ workspacePath, filePath }) => {
    return await (window as any).orpad.pipelines.createRunRecord(workspacePath, filePath, {
      title: 'Root pipeline',
    });
  }, { workspacePath: workspace, filePath: pipelinePath });
  expect(created.success).toBe(true);
  expect(created.runDir).toContain(path.join(workspace, 'runs'));

  const readBack = await win.evaluate(async ({ workspacePath, runDir }) => {
    return await (window as any).orpad.pipelines.readRunRecord(workspacePath, runDir);
  }, { workspacePath: workspace, runDir: created.runDir });
  expect(readBack.success).toBe(true);
  expect(readBack.run.pipelinePath).toBe('pipeline.or-pipeline');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('runbook validator blocks missing skill files and marks render-only nodes non-executable', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-runbook-'));
  const missingSkillPath = path.join(workspace, 'missing-skill.orch-tree.json');
  fs.writeFileSync(missingSkillPath, JSON.stringify(validRunbook('skills/missing.md'), null, 2));

  const renderOnlyPath = path.join(workspace, 'parallel.orch-tree.json');
  fs.writeFileSync(renderOnlyPath, JSON.stringify(validRunbook('skills/missing.md', 'Parallel'), null, 2));

  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);
  await win.evaluate(async () => {
    await (window as any).orpad.getApprovedWorkspace();
  });

  const missing = await win.evaluate(async (filePath) => {
    return await (window as any).orpad.runbooks.validateFile(filePath);
  }, missingSkillPath);
  expect(missing.ok).toBe(false);
  expect(missing.canExecute).toBe(false);
  expect(missing.diagnostics.some((item: { code: string }) => item.code === 'SKILL_FILE_NOT_FOUND')).toBe(true);

  fs.mkdirSync(path.join(workspace, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'skills', 'missing.md'), '# Skill\n');
  const renderOnly = await win.evaluate(async (filePath) => {
    return await (window as any).orpad.runbooks.validateFile(filePath);
  }, renderOnlyPath);
  expect(renderOnly.ok).toBe(true);
  expect(renderOnly.canExecute).toBe(false);
  expect(renderOnly.renderOnlyNodeTypes).toContain('Parallel');
  expect(renderOnly.diagnostics.some((item: { code: string }) => item.code === 'NODE_RENDER_VALIDATE_ONLY')).toBe(true);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('runbook run records cannot be created outside approved workspace', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-runbook-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-runbook-outside-'));
  fs.mkdirSync(path.join(outside, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'skills', 'audit.md'), '# Audit\n');
  const outsideRunbook = path.join(outside, '.orch-tree.json');
  fs.writeFileSync(outsideRunbook, JSON.stringify(validRunbook(), null, 2));

  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);
  await win.evaluate(async () => {
    await (window as any).orpad.getApprovedWorkspace();
  });

  const result = await win.evaluate(async ({ workspacePath, filePath }) => {
    return await (window as any).orpad.runbooks.createRunRecord(workspacePath, filePath);
  }, { workspacePath: workspace, filePath: outsideRunbook });
  expect(String(result.error || '')).toContain('outside');

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
