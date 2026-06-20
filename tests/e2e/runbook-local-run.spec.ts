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

function writeFixtureWorkspace(options: { canonicalNodeTypes?: boolean; trustLevel?: string } = {}): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-local-run-'));
  const contextNodeType = options.canonicalNodeTypes ? 'orpad.context' : 'Context';
  const gateNodeType = options.canonicalNodeTypes ? 'orpad.gate' : 'Gate';
  const treeNodeType = options.canonicalNodeTypes ? 'orpad.tree' : 'OrchTree';
  const skillNodeType = options.canonicalNodeTypes ? 'orpad.skill' : 'Skill';
  const treeConfig = options.canonicalNodeTypes
    ? { treeRef: '../trees/implementation.or-tree' }
    : { ref: '../trees/implementation.or-tree' };
  const skillNode = options.canonicalNodeTypes
    ? { id: 'audit', type: skillNodeType, label: 'Audit', config: { skillRef: 'release-claim-audit' } }
    : { id: 'audit', type: skillNodeType, label: 'Audit', skillRef: 'release-claim-audit' };
  const pipelineRoot = path.join(workspace, '.orpad', 'pipelines', 'release-audit');
  fs.mkdirSync(path.join(pipelineRoot, 'graphs'), { recursive: true });
  fs.mkdirSync(path.join(pipelineRoot, 'trees'), { recursive: true });
  fs.mkdirSync(path.join(pipelineRoot, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(pipelineRoot, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(pipelineRoot, 'harness', 'generated'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Fixture\n\nCurrent release: 1.0.0\n');
  fs.writeFileSync(path.join(workspace, 'CHANGELOG.md'), '## 1.0.1\n\n- Fixed release notes.\n');
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ version: '1.0.1' }, null, 2));
  fs.writeFileSync(path.join(workspace, '.env'), 'SECRET_TOKEN=redacted\n');
  fs.writeFileSync(path.join(pipelineRoot, 'skills', 'release-claim-audit.md'), '# Release Claim Audit\n\n## Acceptance Criteria\n\n- Produce a claim register.\n');
  fs.writeFileSync(path.join(pipelineRoot, 'pipeline.or-pipeline'), JSON.stringify({
    $schema: 'https://orpad.dev/schemas/or-pipeline/v1.json',
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'release-audit',
    title: 'Release audit',
    trustLevel: options.trustLevel || 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    graphs: { main: { file: 'graphs/main.or-graph' } },
    trees: [{ id: 'implementation', file: 'trees/implementation.or-tree' }],
    skills: { 'release-claim-audit': { file: 'skills/release-claim-audit.md' } },
    rules: {
      context: { file: 'rules/context.or-rule' },
      approvals: { file: 'rules/approvals.or-rule' },
    },
    harness: { path: 'harness/generated' },
  }, null, 2));
  fs.writeFileSync(path.join(pipelineRoot, 'graphs', 'main.or-graph'), JSON.stringify({
    $schema: 'https://orpad.dev/schemas/or-graph/v1.json',
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'release-audit-graph',
      label: 'Release audit graph',
      start: 'context',
      nodes: [
        { id: 'context', type: contextNodeType, label: 'Collect release context', config: { ruleRef: 'context' } },
        { id: 'gate', type: gateNodeType, label: 'Approve release audit', config: { ruleRef: 'approvals' } },
        { id: 'implementation', type: treeNodeType, label: 'Run release audit tree', config: treeConfig },
      ],
      transitions: [
        { id: 'context-to-gate', from: 'context', to: 'gate' },
        { id: 'gate-to-implementation', from: 'gate', to: 'implementation' },
      ],
    },
  }, null, 2));
  fs.writeFileSync(path.join(pipelineRoot, 'trees', 'implementation.or-tree'), JSON.stringify({
    $schema: 'https://orpad.dev/schemas/or-tree/v1.json',
    kind: 'orpad.tree',
    version: '1.0',
    id: 'release-audit-tree',
    label: 'Release audit tree',
    root: {
      id: 'root',
      type: 'Sequence',
      label: 'Audit release claims',
      children: [
        skillNode,
      ],
    },
  }, null, 2));
  fs.writeFileSync(path.join(pipelineRoot, 'rules', 'context.or-rule'), JSON.stringify({
    kind: 'orpad.rule',
    version: '1.0',
    id: 'context',
    include: ['README.md', 'CHANGELOG.md', 'package.json'],
    exclude: ['.env'],
  }, null, 2));
  fs.writeFileSync(path.join(pipelineRoot, 'rules', 'approvals.or-rule'), JSON.stringify({
    kind: 'orpad.rule',
    version: '1.0',
    id: 'approvals',
    approvals: [{ action: 'provider-send', scope: 'run', mode: 'approve-once' }],
  }, null, 2));
  return workspace;
}


test('pipeline local MVP run follows canonical orpad tree and skill nodes', async () => {
  const workspace = writeFixtureWorkspace({ canonicalNodeTypes: true });
  const pipelinePath = path.join(workspace, '.orpad', 'pipelines', 'release-audit', 'pipeline.or-pipeline');
  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpad?.pipelines?.startLocalRun);

  const validation = await win.evaluate(async (filePath) => {
    return await (window as any).orpad.pipelines.validateFile(filePath);
  }, pipelinePath);
  expect(validation.ok).toBe(true);
  expect(validation.canExecute).toBe(true);
  expect(validation.nodeTypes).toContain('orpad.tree');
  expect(validation.nodeTypes).toContain('orpad.skill');

  const result = await win.evaluate(async ({ workspacePath, filePath }) => {
    return await (window as any).orpad.pipelines.startLocalRun(workspacePath, filePath, {
      approval: { allowed: true, action: 'provider-send', scope: 'run', target: 'local MVP dry run' },
      title: 'Canonical node run',
    });
  }, { workspacePath: workspace, filePath: pipelinePath });
  expect(result.success).toBe(true);
  expect(result.contextManifest.activeNode.type).toBe('orpad.skill');
  expect(result.contextManifest.activeNode.id).toBe('audit');
  expect(result.contextManifest.included.some((item: { role: string; path: string }) => item.role === 'tree' && item.path.endsWith('trees/implementation.or-tree'))).toBe(true);
  expect(result.contextManifest.included.some((item: { role: string; path: string }) => item.role === 'skill' && item.path.endsWith('skills/release-claim-audit.md'))).toBe(true);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

// NOTE: the pipeline-preview-runbar UI flow tests ('records context, approval,
// replay, and claim artifact' + 'denying local run approval...') were removed
// in the G2 stage-2.4 static-graph editor amputation: .or-pipeline opens as a
// read-only JSON view, so there is no in-preview run bar. Local-run BACKEND
// coverage stays via the canonical-tree run + API-denial + imported-review tests.

test('pipeline local MVP run API denial does not create run evidence', async () => {
  const workspace = writeFixtureWorkspace();
  const pipelinePath = path.join(workspace, '.orpad', 'pipelines', 'release-audit', 'pipeline.or-pipeline');
  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpad?.pipelines?.startLocalRun);

  const result = await win.evaluate(async ({ workspacePath, filePath }) => {
    return await (window as any).orpad.pipelines.startLocalRun(workspacePath, filePath, {
      approval: {
        allowed: false,
        action: 'provider-send',
        scope: 'run',
        target: 'local MVP dry run',
        reason: 'Automated denial.',
      },
      title: 'Denied run',
    });
  }, { workspacePath: workspace, filePath: pipelinePath });

  expect(result.success).toBe(true);
  expect(result.blocked).toBe(true);
  expect(result.runDir).toBe('');
  expect(result.contextManifest).toBeNull();
  expect(result.artifactManifest).toBeNull();

  const runRoot = path.join(workspace, '.orpad', 'pipelines', 'release-audit', 'runs');
  expect(fs.existsSync(runRoot) ? fs.readdirSync(runRoot).length : 0).toBe(0);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('imported-review pipeline cannot start a local run even with approval', async () => {
  const workspace = writeFixtureWorkspace({ canonicalNodeTypes: true, trustLevel: 'imported-review' });
  const pipelinePath = path.join(workspace, '.orpad', 'pipelines', 'release-audit', 'pipeline.or-pipeline');
  const app = await launchElectron();
  const win = await app.firstWindow();
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeApprovedWorkspace(userData, workspace);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!(window as any).orpad?.pipelines?.startLocalRun);

  const result = await win.evaluate(async ({ workspacePath, filePath }) => {
    return await (window as any).orpad.pipelines.startLocalRun(workspacePath, filePath, {
      approval: { allowed: true, action: 'provider-send', scope: 'run', target: 'local MVP dry run' },
      title: 'Imported trust run',
    });
  }, { workspacePath: workspace, filePath: pipelinePath });

  expect(result.success).toBeFalsy();
  expect(result.error).toBe('Pipeline is not executable in the local MVP.');
  expect(result.validation.trustLevel).toBe('imported-review');
  expect(result.validation.canExecute).toBe(false);
  expect(result.validation.diagnostics.some((item: { code: string }) => item.code === 'TRUST_REVIEW_REQUIRED')).toBe(true);

  const runRoot = path.join(workspace, '.orpad', 'pipelines', 'release-audit', 'runs');
  expect(fs.existsSync(runRoot) ? fs.readdirSync(runRoot).length : 0).toBe(0);

  await app.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});
