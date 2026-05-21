import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  buildDeterministicHarnessAuthoringSpec,
  buildHarnessProvisioningReport,
  harnessAuthoringPrompt,
  normalizeHarnessAuthoringSpec,
  preflightValidationCommand,
  registerOrchestrationAuthoringHandlers,
} = require(path.join(repoRoot, 'src/main/orchestration-authoring/ipc.js'));

const input = {
  pipelineDoc: {
    id: 'dotnet-lab-pipeline',
    nodePacks: [{ id: 'orpad.starter.dotnet-lab-code' }],
    run: { machineAdapter: { type: 'codex-cli', command: 'codex' } },
  },
  graphDoc: {
    graph: {
      id: 'main',
      nodes: [
        { id: 'probe', type: 'orpad.probe', label: 'Probe labs' },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Repair lab' },
        { id: 'gate', type: 'orpad.gate', label: 'Verify lab' },
      ],
    },
  },
  projectProfile: {
    requiredTools: ['dotnet', 'git'],
    mcpRecommendations: ['filesystem workspace access', 'terminal command runner'],
    validationCommands: ['dotnet build Lab.csproj --no-restore'],
    protocolContracts: [{ id: 'worker-patch', schemaVersion: 'orpad.workerResult.v1' }],
  },
  toolPlan: {
    requiredTools: ['workspace read/write filesystem', 'dotnet'],
    validationCommands: ['dotnet build Lab.csproj --no-restore'],
  },
  generatedAt: '2026-05-20T02:00:00.000Z',
};

test('deterministic harness authoring spec maps stack tools to node contracts', () => {
  const spec = buildDeterministicHarnessAuthoringSpec(input);

  assert.equal(spec.schemaVersion, 'orpad.harnessAuthoringSpec.v1');
  assert.equal(spec.authoringMode, 'deterministic-fallback');
  assert.equal(spec.requiredTools.includes('dotnet'), true);
  const worker = spec.nodeContracts.find(contract => contract.nodePath === 'main/worker');
  assert.ok(worker);
  assert.equal(worker.requestedCapabilities.includes('workspace-write'), true);
  assert.equal(worker.validationCommands.includes('dotnet build Lab.csproj --no-restore'), true);
  const probe = spec.nodeContracts.find(contract => contract.nodePath === 'main/probe');
  assert.equal(probe.requestedCapabilities.includes('candidate-proposal-write'), true);
});

test('harness authoring prompt gives LLM the profile and schema contract', () => {
  const prompt = harnessAuthoringPrompt(input);

  assert.match(prompt, /orpad\.harnessAuthoringSpec\.v1/);
  assert.match(prompt, /dotnet build Lab\.csproj/);
  assert.match(prompt, /<harness-authoring-input>/);
});

test('normalizer preserves canonical node contracts and disables harness-time command execution', () => {
  const spec = normalizeHarnessAuthoringSpec({
    schemaVersion: 'orpad.harnessAuthoringSpec.v1',
    summary: 'LLM spec',
    commandPolicy: { runDuringHarnessImplementation: true },
    nodeContracts: [{
      nodePath: 'main/worker',
      requestedCapabilities: ['workspace-write', 'custom'],
      validationCommands: ['dotnet test'],
      adapterGuidance: 'Use test evidence.',
    }],
  }, input, 'llm-authored-spec');

  assert.equal(spec.authoringMode, 'llm-authored-spec');
  assert.equal(spec.commandPolicy.runDuringHarnessImplementation, false);
  assert.equal(spec.nodeContracts.length, 3);
  const worker = spec.nodeContracts.find(contract => contract.nodePath === 'main/worker');
  assert.deepEqual(worker.validationCommands, ['dotnet test']);
  const gate = spec.nodeContracts.find(contract => contract.nodePath === 'main/gate');
  assert.equal(gate.requestedCapabilities.includes('validation-evidence-read'), true);
});

async function writeHarnessAuthoringWorkspace() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-harness-authoring-ipc-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/harness-authoring');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), `${JSON.stringify(input.graphDoc, null, 2)}\n`, 'utf8');
  await fs.writeFile(pipelinePath, `${JSON.stringify({
    ...input.pipelineDoc,
    entryGraph: 'graphs/main.or-graph',
    harness: { path: 'harness/generated' },
  }, null, 2)}\n`, 'utf8');
  return { workspaceRoot, pipelinePath };
}

async function writeFakeHarnessAuthoringCodex(resultObject) {
  const fakeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-fake-harness-codex-'));
  const scriptPath = path.join(fakeRoot, 'fake-codex.js');
  await fs.writeFile(scriptPath, [
    'const fs = require("fs");',
    'const path = require("path");',
    'const args = process.argv.slice(2);',
    'const outputIndex = args.indexOf("--output-last-message");',
    'const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : "";',
    `const result = ${JSON.stringify(resultObject, null, 2)};`,
    'if (outputPath) {',
    '  fs.mkdirSync(path.dirname(outputPath), { recursive: true });',
    '  fs.writeFileSync(outputPath, JSON.stringify(result), "utf8");',
    '} else {',
    '  process.stdout.write(JSON.stringify(result));',
    '}',
  ].join('\n'), 'utf8');
  return scriptPath;
}

function registerHarnessAuthoringTestHandler() {
  const handlers = new Map();
  registerOrchestrationAuthoringHandlers({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    app: {
      getAppPath: () => repoRoot,
      getPath: () => repoRoot,
    },
    authority: {
      async assertWorkspacePath(sender, targetPath) {
        return path.resolve(targetPath);
      },
    },
  });
  return handlers.get('orchestration-author-harness');
}

function registerHarnessProvisioningTestHandler() {
  const handlers = new Map();
  registerOrchestrationAuthoringHandlers({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    app: {
      getAppPath: () => repoRoot,
      getPath: (name) => name === 'userData' ? path.join(os.tmpdir(), 'orpad-harness-provisioning-user-data') : repoRoot,
    },
    authority: {
      async assertWorkspacePath(sender, targetPath) {
        return path.resolve(targetPath);
      },
    },
  });
  return handlers.get('orchestration-provision-harness');
}

test('harness authoring IPC accepts a real LLM-authored spec from the CLI path', async () => {
  const { workspaceRoot, pipelinePath } = await writeHarnessAuthoringWorkspace();
  const fakeCodex = await writeFakeHarnessAuthoringCodex({
    schemaVersion: 'orpad.harnessAuthoringSpec.v1',
    summary: 'LLM-authored harness spec.',
    nodeContracts: [{
      nodePath: 'main/worker',
      requestedCapabilities: ['workspace-write', 'validation-command-runner'],
      validationCommands: ['dotnet test ThreadProgramming.sln --no-build'],
      adapterGuidance: 'Run targeted .NET validation before returning done.',
    }],
    commandPolicy: { runDuringHarnessImplementation: true },
  });
  const handler = registerHarnessAuthoringTestHandler();
  const response = await handler({ sender: {} }, {
    workspacePath: workspaceRoot,
    pipelinePath,
    projectProfile: input.projectProfile,
    toolPlan: input.toolPlan,
    useLlm: true,
    fallbackToDeterministic: true,
    authoringCommand: process.execPath,
    authoringCommandPrefixArgs: [fakeCodex],
    authoringTimeoutMs: 30_000,
  });

  assert.equal(response.success, true);
  assert.equal(response.authoringMode, 'llm-authored-spec');
  const worker = response.spec.nodeContracts.find(contract => contract.nodePath === 'main/worker');
  assert.deepEqual(worker.validationCommands, ['dotnet test ThreadProgramming.sln --no-build']);
  assert.equal(response.spec.commandPolicy.runDuringHarnessImplementation, false);
  assert.equal((await fs.stat(response.specPath)).isFile(), true);
});

test('harness authoring IPC falls back when CLI JSON is not a harness spec', async () => {
  const { workspaceRoot, pipelinePath } = await writeHarnessAuthoringWorkspace();
  const fakeCodex = await writeFakeHarnessAuthoringCodex({
    schemaVersion: 'orpad.workerResult.v1',
    status: 'done',
    summary: 'This is a worker result, not a harness spec.',
  });
  const handler = registerHarnessAuthoringTestHandler();
  const response = await handler({ sender: {} }, {
    workspacePath: workspaceRoot,
    pipelinePath,
    projectProfile: input.projectProfile,
    toolPlan: input.toolPlan,
    useLlm: true,
    fallbackToDeterministic: true,
    authoringCommand: process.execPath,
    authoringCommandPrefixArgs: [fakeCodex],
    authoringTimeoutMs: 30_000,
  });

  assert.equal(response.success, true);
  assert.equal(response.authoringMode, 'deterministic-fallback');
  assert.match(response.authoringError, /not a harness authoring spec/);
  assert.equal(response.spec.schemaVersion, 'orpad.harnessAuthoringSpec.v1');
  assert.ok(response.spec.residualRisks.some(risk => risk.includes('fell back to deterministic mode')));
});

test('harness provisioning checks CLI health, MCP config, and validation readiness', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-harness-provisioning-'));
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-harness-provisioning-user-data-'));
  await fs.writeFile(path.join(workspaceRoot, 'fixture.js'), 'console.log("fixture");\n', 'utf8');
  const app = {
    getPath(name) {
      if (name === 'userData') return userData;
      if (name === 'documents') return workspaceRoot;
      return repoRoot;
    },
  };

  const ready = await preflightValidationCommand(`"${process.execPath}" --version`, workspaceRoot);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.dryRun.mode, 'readiness-check-no-build');

  const report = await buildHarnessProvisioningReport({
    app,
    workspaceRoot,
    projectProfile: {
      requiredTools: ['node', 'terminal command runner'],
      stacks: [{ id: 'node', cliTools: ['node'], validationCommands: [`"${process.execPath}" --version`] }],
      mcpRecommendations: ['filesystem workspace access', 'terminal command runner'],
      validationCommands: [`"${process.execPath}" --version`, 'definitely-missing-orpad-tool --version'],
    },
    toolPlan: {
      requiredTools: ['node'],
      validationCommands: [`"${process.execPath}" --version`],
    },
    harnessSpec: {
      schemaVersion: 'orpad.harnessAuthoringSpec.v1',
      nodeContracts: [{
        nodePath: 'main/worker',
        requiredTools: ['node'],
        validationCommands: [`"${process.execPath}" --version`],
        mcpRecommendations: ['filesystem workspace access'],
      }],
    },
    generatedAt: '2026-05-20T03:00:00.000Z',
  });

  assert.equal(report.schemaVersion, 'orpad.harnessProvisioning.v1');
  assert.equal(report.toolHealth.tools.some(tool => tool.input === 'node' && tool.status === 'ready'), true);
  assert.equal(report.validationPreflight.commands.some(command => command.command.includes('--version') && command.status === 'ready'), true);
  assert.equal(report.validationPreflight.commands.some(command => command.command.includes('definitely-missing-orpad-tool') && command.status === 'blocked'), true);
  assert.equal(report.mcpPlan.recommendedServers.some(server => server.id === 'filesystem' && server.configured), true);
  assert.equal(report.mcpPlan.orpadCapabilities.some(capability => capability.id === 'terminal'), true);
  assert.ok(report.enforcement.runBlockers.some(blocker => blocker.includes('definitely-missing-orpad-tool')));
  assert.equal(report.agentReadiness.schemaVersion, 'orpad.agentReadiness.v1');
  assert.equal(report.toolPolicy.schemaVersion, 'orpad.toolPolicy.v1');
  assert.equal(report.observabilityPlan.schemaVersion, 'orpad.observabilityPlan.v1');
  assert.equal(report.evalPlan.schemaVersion, 'orpad.evalPlan.v1');
  assert.equal(report.feedbackLoopPlan.schemaVersion, 'orpad.feedbackLoopPlan.v1');
  assert.equal(report.llmOpsPlan.schemaVersion, 'orpad.llmOpsPlan.v1');
  assert.equal(report.securityRiskPlan.schemaVersion, 'orpad.securityRiskPlan.v1');
  assert.ok(report.toolPolicy.approvalRequiredFor.includes('external network or egress'));
  assert.ok(report.evalPlan.failureTaxonomy.includes('tool call argument error'));
});

test('harness provisioning treats LLM candidate commands and file readers as non-blocking harness context', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-harness-candidate-command-'));
  const candidate = await preflightValidationCommand('candidate: missing-orpad-validator --project <changed-lab-csproj>', workspaceRoot);
  assert.equal(candidate.status, 'candidate');
  assert.deepEqual(candidate.parsed.tokens.slice(0, 2), ['missing-orpad-validator', '--project']);
  assert.equal(candidate.dryRun.status, 'not-run');

  const report = await buildHarnessProvisioningReport({
    app: { getPath: () => workspaceRoot },
    workspaceRoot,
    projectProfile: {},
    toolPlan: {},
    harnessSpec: {
      schemaVersion: 'orpad.harnessAuthoringSpec.v1',
      requiredTools: ['Markdown/code file reader'],
      validationCommands: ['candidate: missing-orpad-validator --project <changed-lab-csproj>'],
    },
    generatedAt: '2026-05-20T03:00:00.000Z',
  });

  assert.equal(report.status, 'ready');
  assert.equal(report.toolHealth.tools.find(tool => tool.input === 'Markdown/code file reader')?.status, 'ready');
  assert.equal(report.validationPreflight.commands.find(command => command.command.startsWith('candidate:'))?.status, 'candidate');
  assert.equal(report.enforcement.runBlockers.length, 0);
});

test('harness provisioning checks Windows Codex npm shims through the provider invocation', { skip: process.platform !== 'win32' }, async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-harness-codex-health-'));
  const shimRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-fake-codex-shim-'));
  const codexBin = path.join(shimRoot, 'node_modules', '@openai', 'codex', 'bin');
  await fs.mkdir(codexBin, { recursive: true });
  await fs.writeFile(path.join(shimRoot, 'codex'), 'npm shim placeholder\n', 'utf8');
  await fs.writeFile(path.join(codexBin, 'codex.js'), 'process.stdout.write("codex-cli fake-health\\n");\n', 'utf8');

  const previousPath = process.env.PATH;
  const previousNode = process.env.ORPAD_MACHINE_NODE_EXEC_PATH;
  process.env.PATH = `${shimRoot}${path.delimiter}${previousPath || ''}`;
  process.env.ORPAD_MACHINE_NODE_EXEC_PATH = process.execPath;
  try {
    const report = await buildHarnessProvisioningReport({
      app: { getPath: () => workspaceRoot },
      workspaceRoot,
      projectProfile: { requiredTools: ['adapter CLI: codex'] },
      toolPlan: {},
      harnessSpec: {},
      generatedAt: '2026-05-20T03:00:00.000Z',
    });

    const codex = report.toolHealth.tools.find(tool => tool.input === 'adapter CLI: codex');
    assert.equal(codex?.status, 'ready');
    assert.equal(codex?.selectedCommand, 'codex');
    assert.match(codex?.versionCheck?.executedCommand || '', /node(\.exe)?$/i);
    assert.equal(codex?.versionCheck?.output, 'codex-cli fake-health\n');
  } finally {
    process.env.PATH = previousPath;
    if (previousNode == null) delete process.env.ORPAD_MACHINE_NODE_EXEC_PATH;
    else process.env.ORPAD_MACHINE_NODE_EXEC_PATH = previousNode;
  }
});

test('harness provisioning IPC writes report artifacts beside the harness spec', async () => {
  const { workspaceRoot, pipelinePath } = await writeHarnessAuthoringWorkspace();
  const handler = registerHarnessProvisioningTestHandler();
  const response = await handler({ sender: {} }, {
    workspacePath: workspaceRoot,
    pipelinePath,
    projectProfile: {
      requiredTools: ['node'],
      stacks: [{ id: 'node', cliTools: ['node'], validationCommands: [`"${process.execPath}" --version`] }],
      mcpRecommendations: ['filesystem workspace access'],
      validationCommands: [`"${process.execPath}" --version`],
    },
    toolPlan: {
      requiredTools: ['node'],
      validationCommands: [`"${process.execPath}" --version`],
    },
    harnessSpec: {
      schemaVersion: 'orpad.harnessAuthoringSpec.v1',
      nodeContracts: [{ nodePath: 'main/worker', requiredTools: ['node'], validationCommands: [`"${process.execPath}" --version`] }],
    },
  });

  assert.equal(response.success, true);
  assert.equal((await fs.stat(response.provisioningPath)).isFile(), true);
  assert.equal((await fs.stat(response.toolHealthPath)).isFile(), true);
  assert.equal((await fs.stat(response.validationPreflightPath)).isFile(), true);
  assert.equal((await fs.stat(response.mcpPlanPath)).isFile(), true);
  assert.equal((await fs.stat(response.agentReadinessPath)).isFile(), true);
  assert.equal((await fs.stat(response.toolPolicyPath)).isFile(), true);
  assert.equal((await fs.stat(response.observabilityPlanPath)).isFile(), true);
  assert.equal((await fs.stat(response.evalPlanPath)).isFile(), true);
  assert.equal((await fs.stat(response.feedbackLoopPlanPath)).isFile(), true);
  assert.equal((await fs.stat(response.llmOpsPlanPath)).isFile(), true);
  assert.equal((await fs.stat(response.securityRiskPlanPath)).isFile(), true);
  const provisioning = JSON.parse(await fs.readFile(response.provisioningPath, 'utf8'));
  assert.equal(provisioning.schemaVersion, 'orpad.harnessProvisioning.v1');
  assert.equal(provisioning.toolPolicyPath, 'tool-policy.json');
  const toolPolicy = JSON.parse(await fs.readFile(response.toolPolicyPath, 'utf8'));
  assert.equal(toolPolicy.schemaVersion, 'orpad.toolPolicy.v1');
});
