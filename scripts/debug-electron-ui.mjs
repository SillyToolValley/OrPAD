#!/usr/bin/env node

import { _electron as electron } from 'playwright';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const shotOnly = args.has('--shot-only');
const skipBuild = args.has('--no-build');
const keepWorkspace = Boolean(process.env.ORPAD_DEBUG_WORKSPACE);
const workspaceRoot = process.env.ORPAD_DEBUG_WORKSPACE
  ? path.resolve(process.env.ORPAD_DEBUG_WORKSPACE)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-debug-workspace-'));
const testUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-debug-user-'));

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function ensureDebugPipeline(root) {
  const pipelineDir = path.join(root, '.orpad', 'pipelines', 'debug-orchestration-workstream');
  const graphDir = path.join(pipelineDir, 'graphs');
  fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# OrPAD UI Debug Workspace\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'debug-target.md'), 'before\n', 'utf8');
  writeJson(path.join(graphDir, 'main.or-graph'), {
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'debug-orchestration',
      label: 'Debug orchestration',
      start: 'entry',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry', config: { summary: 'Begin debug run.' } },
        { id: 'context', type: 'orpad.context', label: 'Prepare project context', config: { summary: 'Inspect the selected project.' } },
        { id: 'probe', type: 'orpad.probe', label: 'Generate orchestration candidates', config: { lens: 'ux-ui', candidateLimitPolicy: 'collect-all-visible' } },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue candidate work', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', label: 'Prioritize work', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Dispatch harness work', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Implement harness', config: { queueRef: 'queue' } },
        { id: 'exit', type: 'orpad.exit', label: 'Exit', config: { summary: 'Finish debug run.' } },
      ],
      transitions: [
        { id: 'entry-context', from: 'entry', to: 'context' },
        { id: 'context-probe', from: 'context', to: 'probe' },
        { id: 'probe-queue', from: 'probe', to: 'queue' },
        { id: 'queue-triage', from: 'queue', to: 'triage' },
        { id: 'triage-dispatch', from: 'triage', to: 'dispatch' },
        { id: 'dispatch-worker', from: 'dispatch', to: 'worker' },
        { id: 'worker-exit', from: 'worker', to: 'exit' },
      ],
    },
  });
  writeJson(path.join(pipelineDir, 'pipeline.or-pipeline'), {
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'debug-orchestration-workstream',
    title: 'Debug orchestration workstream',
    description: 'Local Electron UI debug pipeline with Machine run controls.',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    nodePacks: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3', origin: 'built-in' },
      { id: 'orpad.workstream', version: '>=0.1.0', origin: 'built-in' },
    ],
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
    harness: { path: 'harness/generated' },
    run: {
      artifactRoot: 'harness/generated/latest-run/artifacts',
      queueRoot: 'harness/generated/latest-run/queue',
      summaryPath: 'harness/generated/latest-run/summary.md',
      durableRunRoot: 'runs',
      machineAdapter: {
        type: 'codex-cli',
        enabled: true,
        mode: 'live-mvp',
        command: 'codex',
        sandbox: 'read-only',
        proposalSandbox: 'read-only',
        workerSandbox: 'workspace-write',
        approvalPolicy: 'never',
        ephemeral: true,
        candidateLimit: 3,
        proposalTimeoutMs: 600000,
        workerTimeoutMs: 900000,
        probeNodePaths: ['main/probe'],
        triageNodePath: 'main/triage',
        dispatcherNodePath: 'main/dispatch',
        workerNodePath: 'main/worker',
      },
    },
  });
}

function cleanup() {
  if (!keepWorkspace) fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(testUserData, { recursive: true, force: true });
}

if (!skipBuild) {
  const build = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'build-renderer.js')], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (build.status !== 0) process.exit(build.status || 1);
}

ensureDebugPipeline(workspaceRoot);

const app = await electron.launch({
  args: ['.'],
  cwd: projectRoot,
  env: {
    ...process.env,
    ORPAD_TEST_USER_DATA: testUserData,
    ORPAD_MACHINE_IPC: '1',
    ORPAD_MACHINE_IPC_TOKEN: 'debug-token',
    ORPAD_MACHINE_NODE_EXEC_PATH: process.execPath,
  },
});

try {
  const win = await app.firstWindow();
  const electronUserData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  writeJson(path.join(electronUserData, 'approved-workspace.json'), {
    version: 1,
    workspaceRoot,
  });

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => Boolean(window.orpadCommands?.runCommand));
  await win.evaluate(async () => {
    await window.orpadCommands.runCommand('view.runbooks');
  });
  await win.locator('.runbook-item').filter({ hasText: 'Debug orchestration workstream' }).click();
  await win.waitForSelector('[data-pipeline-preview-runbar]');

  const screenshotsDir = path.join(projectRoot, '~screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const shotPath = path.join(screenshotsDir, `electron-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  await win.screenshot({ path: shotPath, fullPage: true });
  console.log(`Electron UI debug workspace: ${workspaceRoot}`);
  console.log(`Machine capability token: debug-token`);
  console.log(`Screenshot: ${shotPath}`);

  if (!shotOnly) {
    console.log('Electron is open. Press Enter here to close it.');
    await new Promise(resolve => process.stdin.once('data', resolve));
  }
} finally {
  await app.close().catch(() => {});
  cleanup();
}
