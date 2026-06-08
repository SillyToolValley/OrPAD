import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const appAsar = path.join(repoRoot, 'release', 'win-unpacked', 'resources', 'app.asar');
const appExe = path.join(repoRoot, 'release', 'win-unpacked', process.platform === 'win32' ? 'OrPAD.exe' : 'OrPAD');
const tempRoots = [];

const requiredAsarPaths = [
  'package.json',
  'assets/icon.ico',
  'dist/renderer.js',
  'dist/terminal-window.js',
  'scripts/audit-orpad-run.mjs',
  'scripts/audit-orpad-node-schemas.mjs',
  'src/locales/en.json',
  'src/locales/ko.json',
  'src/main/main.js',
  'src/main/preload.js',
  'src/main/orchestration-authoring/ipc.js',
  'src/main/orchestration-machine/ipc.js',
  'src/main/orchestration-machine/machine.js',
  'src/main/orchestration-machine/node-pack-installer.js',
  'src/main/orchestration-machine/node-pack-registry.js',
  'src/main/orchestration-machine/node-packs.js',
  'src/main/orchestration-machine/non-runnable-work.js',
  'src/main/orchestration-machine/providers/plugins/claude-code.js',
  'src/main/runbooks/ipc.js',
  'src/renderer/index.html',
  'src/renderer/terminal-window.html',
  'src/renderer/orpad-mark.png',
  'src/renderer/renderer.js',
  'src/renderer/styles/base.css',
  'src/renderer/styles/katex.min.css',
  'src/renderer/ui-scale.js',
  'src/shared/ai/provider-catalog.js',
  'src/shared/orchestration/failure-summary.js',
  'registry/node-packs.json',
  'registry/packages.json',
  'nodes/orpad.core/orpad.node-pack.json',
  'nodes/orpad.workstream/orpad.node-pack.json',
];

function fail(message, detail = '') {
  console.error(`FAIL ${message}${detail ? `\n${detail}` : ''}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function normalizeAsarPath(value) {
  return String(value || '').replace(/^[/\\]+/, '').replace(/[\\/]+/g, '\\');
}

function loadAsarPackageReader() {
  try {
    return require('@electron/asar');
  } catch (err) {
    if (err?.code !== 'MODULE_NOT_FOUND') throw err;
    return null;
  }
}

function readPickleString(buffer) {
  if (buffer.length < 8) throw new Error('ASAR header pickle is too small');
  const stringLength = buffer.readUInt32LE(4);
  const stringStart = 8;
  const stringEnd = stringStart + stringLength;
  if (stringEnd > buffer.length) {
    throw new Error(`ASAR header string exceeds header size (${stringLength} bytes)`);
  }
  return buffer.subarray(stringStart, stringEnd).toString('utf8').replace(/\0+$/, '');
}

function readAsarHeaderWithoutDependency(archivePath) {
  const fd = fs.openSync(archivePath, 'r');
  try {
    const sizePickle = Buffer.alloc(8);
    fs.readSync(fd, sizePickle, 0, sizePickle.length, 0);
    const headerPickleSize = sizePickle.readUInt32LE(4);
    if (!headerPickleSize || headerPickleSize > 128 * 1024 * 1024) {
      throw new Error(`Unexpected ASAR header size: ${headerPickleSize}`);
    }
    const headerPickle = Buffer.alloc(headerPickleSize);
    fs.readSync(fd, headerPickle, 0, headerPickle.length, sizePickle.length);
    return JSON.parse(readPickleString(headerPickle));
  } finally {
    fs.closeSync(fd);
  }
}

function listAsarPackageWithoutDependency(archivePath) {
  const header = readAsarHeaderWithoutDependency(archivePath);
  const entries = [];
  function visit(prefix, node) {
    for (const [name, child] of Object.entries(node?.files || {})) {
      const itemPath = prefix ? `${prefix}/${name}` : name;
      entries.push(itemPath);
      if (child?.files) visit(itemPath, child);
    }
  }
  visit('', header);
  return entries;
}

function assertBuiltPackageExists() {
  if (!fs.existsSync(appAsar)) {
    fail('packaged app.asar is missing', appAsar);
    return false;
  }
  if (!fs.existsSync(appExe)) {
    fail('packaged app executable is missing', appExe);
    return false;
  }
  pass('packaged app exists');
  return true;
}

function assertAsarContents() {
  let listedPaths;
  const asar = loadAsarPackageReader();
  try {
    listedPaths = asar ? asar.listPackage(appAsar) : listAsarPackageWithoutDependency(appAsar);
  } catch (err) {
    fail('app.asar contents could not be listed', err?.stack || err?.message || String(err));
    return;
  }
  const files = new Set(listedPaths.map(normalizeAsarPath));
  const missing = requiredAsarPaths.filter(item => !files.has(normalizeAsarPath(item)));
  if (missing.length) {
    fail('app.asar is missing runtime files', missing.map(item => `- ${item}`).join('\n'));
    return;
  }
  pass('app.asar contains required runtime files');
}

function runPackagedNode(source) {
  const result = spawnSync(appExe, ['-e', source], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      `exit ${result.status}`,
      result.stdout ? `stdout:\n${result.stdout}` : '',
      result.stderr ? `stderr:\n${result.stderr}` : '',
    ].filter(Boolean).join('\n'));
  }
  return result.stdout.trim();
}

function assertPackagedNodeCheck(name, source) {
  try {
    const stdout = runPackagedNode(source);
    pass(`${name}${stdout ? `: ${stdout}` : ''}`);
  } catch (err) {
    fail(name, err?.stack || err?.message || String(err));
  }
}

function assertPackagedRuntime() {
  const appAsarForNode = appAsar.replace(/\\/g, '/');
  const smokeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-packaged-smoke-'));
  tempRoots.push(smokeUserData);
  assertPackagedNodeCheck('packaged modules load', `
    const base = ${JSON.stringify(appAsarForNode)};
    const authoring = require(base + '/src/main/orchestration-authoring/ipc.js');
    const machine = require(base + '/src/main/orchestration-machine');
    const nodePackInstaller = require(base + '/src/main/orchestration-machine/node-pack-installer.js');
    const nodePackRegistry = require(base + '/src/main/orchestration-machine/node-pack-registry.js');
    const nodePacks = require(base + '/src/main/orchestration-machine/node-packs.js');
    const runbooks = require(base + '/src/main/runbooks/ipc.js');
    const terminalPty = require(base + '/src/main/terminal/pty.js');
    const result = {
      authoring: typeof authoring.registerOrchestrationAuthoringHandlers,
      machineStatus: typeof machine.registerMachineHandlers,
      machineJournalProjection: typeof machine.writeLegacyJournalProjection,
      nodePackInstaller: typeof nodePackInstaller,
      nodePackRegistry: typeof nodePackRegistry,
      nodePacks: typeof nodePacks,
      runbooks: typeof runbooks.registerRunbookHandlers,
      terminalPty: typeof terminalPty,
    };
    if (Object.values(result).some(value => !value || value === 'undefined')) {
      throw new Error(JSON.stringify(result));
    }
    console.log(JSON.stringify(result));
  `);

  assertPackagedNodeCheck('packaged audit script imports', `
    const path = require('path');
    const { pathToFileURL } = require('url');
    const p = pathToFileURL(path.resolve('release/win-unpacked/resources/app.asar/scripts/audit-orpad-run.mjs')).href;
    import(p).then(mod => {
      if (typeof mod.auditRun !== 'function') throw new Error('auditRun export missing');
      console.log('auditRun=function');
    }).catch(err => {
      console.error(err.stack || err.message);
      process.exit(1);
    });
  `);

  assertPackagedNodeCheck('packaged Node resolution avoids OrPAD.exe', `
    const machine = require(${JSON.stringify(appAsarForNode + '/src/main/orchestration-machine')});
    delete process.env.ORPAD_MACHINE_NODE_EXEC_PATH;
    delete process.env.npm_node_execpath;
    delete process.env.NODE;
    const harnessNode = machine.nodeExecutableForHarness();
    const cliNode = machine.nodeExecutableForCli();
    const claudeNode = machine.nodeExecutableForClaudeCode();
    const result = { execPath: process.execPath, harnessNode, cliNode, claudeNode };
    if (!harnessNode || harnessNode === process.execPath) throw new Error(JSON.stringify(result));
    if (!cliNode || cliNode === process.execPath) throw new Error(JSON.stringify(result));
    if (!claudeNode || claudeNode === process.execPath) throw new Error(JSON.stringify(result));
    console.log(JSON.stringify(result));
  `);

  assertPackagedNodeCheck('packaged Machine session can enable mutating runs', `
    const { registerMachineHandlers, MACHINE_IPC_CHANNELS } = require(${JSON.stringify(appAsarForNode + '/src/main/orchestration-machine/ipc.js')});
    const handlers = new Map();
    const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
    const event = { sender: { id: 1 }, senderFrame: { url: 'file:///C:/orpad/index.html' } };
    const authority = { assertWorkspacePath() {}, isGrantedFile() { return false; } };
    registerMachineHandlers({
      ipcMain,
      authority,
      featureGate: { enabled: false, mutatingCapabilityToken: '' },
      allowSessionEnable: true,
    });
    (async () => {
      const before = await handlers.get(MACHINE_IPC_CHANNELS.status)(event);
      const enabled = await handlers.get(MACHINE_IPC_CHANNELS.enableSession)(event);
      const after = await handlers.get(MACHINE_IPC_CHANNELS.status)(event);
      if (!before.sessionEnableAvailable || !enabled.success || !after.enabled || !after.mutatingCapabilityConfigured) {
        throw new Error(JSON.stringify({ before, enabled, after }));
      }
      console.log(JSON.stringify({ before: before.enabled, after: after.enabled, token: /^orpad-session-/.test(enabled.capabilityToken || '') }));
    })().catch(err => {
      console.error(err.stack || err.message);
      process.exit(1);
    });
  `);

  assertPackagedNodeCheck('packaged Generate prompt never asks for app.asar CLI execution', `
    const { authoringAgentPrompt } = require(${JSON.stringify(appAsarForNode + '/src/main/orchestration-authoring/ipc.js')});
    const prompt = authoringAgentPrompt({
      workspaceRoot: 'C:/workspace',
      appRoot: ${JSON.stringify(appAsarForNode)},
      cliPath: ${JSON.stringify(appAsarForNode + '/bin/orpad-cli.mjs')},
      cliRunnable: false,
      promptFile: 'C:/workspace/.orpad/authoring/request.txt',
      authoringSpecPath: 'C:/workspace/.orpad/authoring/spec.json',
      prompt: 'Detect rendering issues in the TUI tab.',
      snapshot: { files: ['README.md'] },
    });
    if (!prompt.includes('PACKAGED APP ACTION')) throw new Error('missing packaged instruction');
    if (prompt.includes('node "<orpadCliPath>"') || prompt.includes('CLI INVOCATION')) {
      throw new Error('packaged prompt still asks for CLI execution');
    }
    console.log('packaged-prompt-ok');
  `);

  assertPackagedNodeCheck('packaged harness provisioning treats native placeholders as candidates', `
    const { buildHarnessProvisioningReport, preflightValidationCommand } = require(${JSON.stringify(appAsarForNode + '/src/main/orchestration-authoring/ipc.js')});
    (async () => {
      const workspaceRoot = process.cwd();
      const preflight = await preflightValidationCommand('cmake --build <build-dir>', workspaceRoot);
      const report = await buildHarnessProvisioningReport({
        workspaceRoot,
        app: { getPath: () => ${JSON.stringify(smokeUserData.replace(/\\/g, '/'))} },
        projectProfile: {
          requiredTools: ['candidate: msbuild or make when applicable'],
          validationCommands: ['cmake --build <build-dir>'],
          stacks: [{ id: 'cpp', cliTools: ['msbuild or make when applicable'] }],
        },
        toolPlan: {},
        harnessSpec: { schemaVersion: 'orpad.harnessAuthoringSpec.v1' },
      });
      if (preflight.status !== 'candidate' || report.enforcement.runBlockers.length) {
        throw new Error(JSON.stringify({ preflight, blockers: report.enforcement.runBlockers }));
      }
      console.log(JSON.stringify({ preflight: preflight.status, blockers: report.enforcement.runBlockers.length }));
    })().catch(err => {
      console.error(err.stack || err.message);
      process.exit(1);
    });
  `);

  assertPackagedNodeCheck('packaged Machine rejects non-runnable Unity meta work and ignores result templates', `
    const fs = require('fs/promises');
    const os = require('os');
    const path = require('path');
    const machine = require(${JSON.stringify(appAsarForNode + '/src/main/orchestration-machine')});
    (async () => {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-packaged-content-smoke-'));
      const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/content-smoke');
      await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
      const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
      await fs.writeFile(pipelinePath, JSON.stringify({ kind: 'orpad.pipeline', version: '1.0', id: 'content-smoke', entryGraph: 'graphs/main.or-graph' }), 'utf8');
      const run = await machine.createMachineRun({ workspaceRoot, pipelinePath, runId: 'run_packaged_content_smoke' });
      const patchArtifact = (await machine.registerPatchArtifact(run.runRoot, {
        runId: run.runId,
        producedBy: 'packaged-smoke',
        artifactPath: 'artifacts/patches/content-smoke.patch.json',
        patch: {
          schemaVersion: 'orpad.patchArtifact.v1',
          createdAt: '2026-05-27T00:00:00.000Z',
          allowedFiles: ['docs/tui-plan.md'],
          changes: [{
            path: 'docs/tui-plan.md',
            beforeExists: true,
            afterExists: true,
            beforeContent: '# TUI Plan\\n\\nOld summary.\\n',
            afterContent: [
              '# TUI Plan',
              '',
              'The diagnostics result table records one status per rendering risk.',
              'section 2.1 ConPTY diff drift : PASS | FAIL | BLOCKED - notes:',
              'section 2.2 Sync-output suppression : PASS | FAIL | BLOCKED - notes:',
              'section 2.3 Alt-buffer residue : PASS | FAIL | BLOCKED - notes:',
              'The final note explains what changed without expanding the checklist.',
            ].join('\\n'),
          }],
          violations: [],
        },
      })).file.path;
      const worker = await machine.appendMachineEvent(run.runRoot, {
        runId: run.runId,
        actor: 'machine',
        eventType: 'worker.result',
        itemId: 'packaged-content-smoke',
        payload: {
          status: 'done',
          itemId: 'packaged-content-smoke',
          patchArtifact,
          changedFiles: ['docs/tui-plan.md'],
          verification: [{ command: 'packaged smoke', status: 'passed', summary: 'ok' }],
        },
        artifactRefs: [patchArtifact],
      });
      const evaluation = await machine.createWorkerEvaluationArtifact({
        runRoot: run.runRoot,
        runId: run.runId,
        config: { evaluationMode: 'content-editorial-quality', judgePolicy: 'rule-only' },
        events: [worker],
      }, worker);
      const artifact = JSON.parse(await fs.readFile(path.join(run.runRoot, ...evaluation.artifactPath.split('/')), 'utf8'));
      const rejected = machine.isNonRunnableExternalGenerationWork({
        title: 'Make Unity package tests importable',
        acceptanceCriteria: [
          'Unity has imported Packages/com.example/Tests so .meta files exist.',
          'No .meta files are hand-authored; they are generated by Unity import.',
        ],
      });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      if (artifact.evaluator.version !== '3' || !artifact.overall.passed || !rejected) {
        throw new Error(JSON.stringify({ version: artifact.evaluator.version, passed: artifact.overall.passed, rejected }));
      }
      console.log(JSON.stringify({ version: artifact.evaluator.version, passed: artifact.overall.passed, rejected }));
    })().catch(err => {
      console.error(err.stack || err.message);
      process.exit(1);
    });
  `);
}

if (assertBuiltPackageExists()) {
  assertAsarContents();
  assertPackagedRuntime();
}

for (const root of tempRoots) {
  fs.rmSync(root, { recursive: true, force: true });
}

if (process.exitCode) process.exit(process.exitCode);
