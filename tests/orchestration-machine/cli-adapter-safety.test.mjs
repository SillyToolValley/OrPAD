import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  applyPatchArtifact,
  applyWorkerResult,
  claimNextQueuedItem,
  cliOverlayRoot,
  codexCliInvocation,
  copyAllowedFilesToOverlay,
  createAdapterRequest,
  createCliAgentAdapter,
  createCommandGrant,
  createMachineRun,
  findQueueItem,
  ingestCandidateProposal,
  prepareCliOverlayWorkspace,
  processLooksApprovalRequired,
  redactCommandArgs,
  resultStatusForProcess,
  readMachineEvents,
  runMachineProcess,
  sanitizeEnvironment,
  sha256Text,
  transitionQueueItem,
} = require('../../src/main/orchestration-machine');

const fixedNow = new Date('2026-04-30T00:00:00.000Z');

test('Codex CLI JavaScript entrypoints use a real Node executable instead of process.execPath', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-codex-invocation-'));
  const fakeNode = path.join(tempRoot, process.platform === 'win32' ? 'node.exe' : 'node');
  const fakeCodexScript = path.join(tempRoot, 'codex.js');
  await fs.writeFile(fakeNode, '', 'utf8');
  await fs.writeFile(fakeCodexScript, '', 'utf8');

  const previousNodeExecPath = process.env.npm_node_execpath;
  const previousMachineNode = process.env.ORPAD_MACHINE_NODE_EXEC_PATH;
  try {
    delete process.env.ORPAD_MACHINE_NODE_EXEC_PATH;
    process.env.npm_node_execpath = fakeNode;
    const invocation = codexCliInvocation(fakeCodexScript);
    assert.equal(invocation.command, fakeNode);
    assert.deepEqual(invocation.prefixArgs, [fakeCodexScript]);
  } finally {
    if (previousNodeExecPath === undefined) delete process.env.npm_node_execpath;
    else process.env.npm_node_execpath = previousNodeExecPath;
    if (previousMachineNode === undefined) delete process.env.ORPAD_MACHINE_NODE_EXEC_PATH;
    else process.env.ORPAD_MACHINE_NODE_EXEC_PATH = previousMachineNode;
  }
});

async function makeRun(runId = 'run_20260430_cli_adapter') {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-cli-adapter-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/sample-machine-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'sample-machine-pipeline',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');
  return createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId,
    now: fixedNow,
  });
}

function proposal(overrides = {}) {
  return {
    schemaVersion: 'orpad.candidateProposal.v1',
    proposalId: 'proposal-cli-write-set',
    suggestedWorkItemId: 'cli-write-set-item',
    sourceNode: 'discovery/cli-probe',
    title: 'Exercise CLI adapter write-set boundaries',
    fingerprint: 'cli:write-set-item',
    evidence: [{ id: 'cli-source', file: 'src/allowed.txt' }],
    acceptanceCriteria: ['Allowed file is updated only through Machine acceptance.'],
    sourceOfTruthTargets: ['src/allowed.txt'],
    ...overrides,
  };
}

async function queueAndClaim(run, claimId = 'claim-cli-write-set') {
  await ingestCandidateProposal(run.runRoot, proposal(), {
    runId: run.runId,
    transitionId: 'ingest:cli-write-set-item',
  });
  await transitionQueueItem(run.runRoot, {
    runId: run.runId,
    itemId: 'cli-write-set-item',
    toState: 'queued',
    transitionId: 'triage:cli-write-set-item',
  });
  return claimNextQueuedItem(run.runRoot, {
    runId: run.runId,
    claimId,
    now: '2026-04-30T00:00:20.000Z',
  });
}

async function createTestSymlink(testContext, target, linkPath, type = 'file') {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch (err) {
    if (['EACCES', 'EPERM', 'ENOTSUP', 'EINVAL'].includes(err?.code)) {
      testContext.skip(`symlink creation is unavailable in this environment: ${err.code}`);
      return false;
    }
    throw err;
  }
}

test('exact command grants block unapproved or shell-like command specs', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-command-grant-'));
  const spec = {
    command: process.execPath,
    args: ['-e', 'process.stdout.write("ok")'],
    cwd,
  };
  const grant = createCommandGrant({
    ...spec,
    grantId: 'grant-node-ok',
    expiresAt: '2026-04-30T01:00:00.000Z',
  });

  assert.equal(grant.command, process.execPath);
  assert.throws(
    () => createCommandGrant({ command: '|', args: [], cwd }),
    /Shell operators are not valid commands/,
  );
  assert.throws(
    () => createCommandGrant({ command: 'cmd.exe', args: ['/c', 'echo ok'], cwd }),
    error => error?.code === 'MACHINE_COMMAND_SHELL_BLOCKED',
  );
  assert.throws(
    () => createCommandGrant({ command: 'powershell.exe', args: ['-NoProfile', '-Command', 'Write-Output ok'], cwd }),
    error => error?.code === 'MACHINE_COMMAND_SHELL_BLOCKED',
  );
  assert.throws(
    () => require('../../src/main/orchestration-machine').assertCommandGranted([grant], {
      ...spec,
      args: ['-e', 'process.stdout.write("different")'],
    }, { now: '2026-04-30T00:00:00.000Z' }),
    error => error?.code === 'MACHINE_COMMAND_NOT_GRANTED',
  );
  assert.throws(
    () => require('../../src/main/orchestration-machine').assertCommandGranted([{
      ...grant,
      grantId: 'grant-invalid-expiry',
      expiresAt: 'not-a-date',
    }], spec, { now: '2026-04-30T00:00:00.000Z' }),
    error => error?.code === 'MACHINE_COMMAND_NOT_GRANTED',
  );
});

test('process runner uses sanitized environment and captures transcript output', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-process-runner-'));
  assert.deepEqual(
    redactCommandArgs(['--api-key', 'sk-test-secret-value', '--token=ghp_testsecret', 'plain']).args,
    ['--api-key', '[redacted]', '--token=[redacted]', 'plain'],
  );
  const sanitized = sanitizeEnvironment({
    ...process.env,
    DATABASE_URL: 'postgres://secret',
    OPENAI_API_KEY: 'sk-test',
    SESSION_COOKIE: 'cookie-secret',
    SECRET_TOKEN: 'do-not-inherit',
    SAFE_VALUE: 'visible',
  });

  assert.equal(sanitized.env.DATABASE_URL, undefined);
  assert.equal(sanitized.env.OPENAI_API_KEY, undefined);
  assert.equal(sanitized.env.SESSION_COOKIE, undefined);
  assert.equal(sanitized.env.SECRET_TOKEN, undefined);
  assert.equal(sanitized.env.SAFE_VALUE, 'visible');
  assert.equal(sanitized.masked.includes('DATABASE_URL'), true);
  assert.equal(sanitized.masked.includes('OPENAI_API_KEY'), true);
  assert.equal(sanitized.masked.includes('SESSION_COOKIE'), true);
  assert.equal(sanitized.masked.includes('SECRET_TOKEN'), true);

  const result = await runMachineProcess({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(process.env.SECRET_TOKEN || "missing")'],
    cwd,
    env: {
      ...process.env,
      SECRET_TOKEN: 'do-not-inherit',
    },
    timeoutMs: 5000,
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'missing');
  assert.equal(result.maskedEnvNames.includes('SECRET_TOKEN'), true);

  const secretArgResult = await runMachineProcess({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("ok")', '--', '--api-key', 'sk-test-secret-value'],
    cwd,
    timeoutMs: 5000,
  });
  assert.equal(secretArgResult.stdout, 'ok');
  assert.deepEqual(secretArgResult.args.slice(-2), ['--api-key', '[redacted]']);
  assert.equal(secretArgResult.redactedArgCount, 1);
});

test('process runner times out long-running adapter commands', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-process-timeout-'));
  const result = await runMachineProcess({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => process.stdout.write("late"), 1000)'],
    cwd,
    timeoutMs: 100,
  });

  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test('process runner closes stdin when no adapter input is provided', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-process-stdin-'));
  const result = await runMachineProcess({
    command: process.execPath,
    args: ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("stdin-closed"));'],
    cwd,
    timeoutMs: 5000,
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'stdin-closed');
});

test('process runner forwards explicit adapter stdin', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-process-stdin-data-'));
  const result = await runMachineProcess({
    command: process.execPath,
    args: ['-e', 'let body=""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => process.stdout.write(body));'],
    cwd,
    stdin: 'adapter-input',
    timeoutMs: 5000,
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'adapter-input');
});

test('CLI overlay adapter cannot mutate canonical queue/state files directly', async () => {
  const run = await makeRun();
  await fs.mkdir(path.join(run.workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(run.workspaceRoot, 'src/allowed.txt'), 'before\n', 'utf8');
  await fs.mkdir(path.join(run.runRoot, 'queue/queued'), { recursive: true });
  const canonicalQueuePath = path.join(run.runRoot, 'queue/queued/item.json');
  await fs.writeFile(canonicalQueuePath, '{"state":"queued"}\n', 'utf8');

  const request = createAdapterRequest({
    adapter: 'cli-agent-overlay',
    runId: run.runId,
    nodePath: 'queue/worker-loop',
    taskKind: 'workerLoop',
    workspaceRoot: run.workspaceRoot,
    workspaceMode: 'read-only-plus-overlay',
    allowedFiles: ['src/allowed.txt'],
    adapterCallId: 'cli-overlay-call',
    attemptId: 'cli-overlay-attempt-1',
    idempotencyKey: 'cli-overlay-call:attempt-1',
    outputContract: 'orpad.workerResult.v1',
  });
  const overlayRoot = cliOverlayRoot(run.runRoot, request);
  const rogueQueueRel = `.orpad/pipelines/sample-machine-pipeline/runs/${run.runId}/queue/queued/item.json`;
  const script = [
    'const fs=require("fs");',
    'fs.mkdirSync("src",{recursive:true});',
    'fs.writeFileSync("src/allowed.txt","after\\n");',
    `fs.mkdirSync(${JSON.stringify(path.posix.dirname(rogueQueueRel))},{recursive:true});`,
    `fs.writeFileSync(${JSON.stringify(rogueQueueRel)},"mutated\\n");`,
  ].join('');
  const commandSpec = {
    command: process.execPath,
    args: ['-e', script],
    cwd: overlayRoot,
  };
  const adapter = createCliAgentAdapter({
    enabled: true,
    runRoot: run.runRoot,
    workspaceRoot: run.workspaceRoot,
    commandSpec,
    commandGrants: [createCommandGrant({
      ...commandSpec,
      grantId: 'grant-cli-overlay',
      expiresAt: '2026-04-30T01:00:00.000Z',
    })],
    now: '2026-04-30T00:00:30.000Z',
  });

  const result = await adapter.invoke(request);

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.changedFiles, ['src/allowed.txt']);
  assert.equal(await fs.readFile(path.join(run.workspaceRoot, 'src/allowed.txt'), 'utf8'), 'before\n');
  assert.equal(await fs.readFile(canonicalQueuePath, 'utf8'), '{"state":"queued"}\n');
  assert.equal(result.verification[0].writeSetViolationCount, 1);
  assert.equal((await readMachineEvents(run.runRoot)).some(event => event.eventType === 'artifact.registered'), true);
});

test('CLI overlay adapter refuses to run without an exact command grant', async () => {
  const run = await makeRun('run_20260430_cli_grant_block');
  await fs.mkdir(path.join(run.workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(run.workspaceRoot, 'src/allowed.txt'), 'before\n', 'utf8');
  const request = createAdapterRequest({
    adapter: 'cli-agent-overlay',
    runId: run.runId,
    nodePath: 'queue/worker-loop',
    taskKind: 'workerLoop',
    workspaceRoot: run.workspaceRoot,
    workspaceMode: 'read-only-plus-overlay',
    allowedFiles: ['src/allowed.txt'],
    adapterCallId: 'cli-no-grant-call',
    attemptId: 'cli-no-grant-attempt-1',
    idempotencyKey: 'cli-no-grant-call:attempt-1',
    outputContract: 'orpad.workerResult.v1',
  });

  await assert.rejects(
    createCliAgentAdapter({
      enabled: true,
      runRoot: run.runRoot,
      commandSpec: {
        command: process.execPath,
        args: ['-e', 'process.stdout.write("ok")'],
        cwd: cliOverlayRoot(run.runRoot, request),
      },
      commandGrants: [],
    }).invoke(request),
    error => error?.code === 'MACHINE_COMMAND_NOT_GRANTED',
  );
});

test('CLI overlay workspace rejects untrusted overlay roots before cleanup', async () => {
  const run = await makeRun('run_20260430_cli_overlay_root_guard');
  const sentinelPath = path.join(run.workspaceRoot, 'sentinel.txt');
  await fs.writeFile(sentinelPath, 'keep\n', 'utf8');
  const request = createAdapterRequest({
    adapter: 'cli-agent-overlay',
    runId: run.runId,
    nodePath: 'queue/worker-loop',
    taskKind: 'workerLoop',
    workspaceRoot: run.workspaceRoot,
    workspaceMode: 'read-only-plus-overlay',
    allowedFiles: [],
    adapterCallId: 'cli-overlay-root-guard-call',
    attemptId: 'cli-overlay-root-guard-attempt-1',
    idempotencyKey: 'cli-overlay-root-guard-call:attempt-1',
    outputContract: 'orpad.workerResult.v1',
  });
  request.overlayRoot = run.workspaceRoot;

  await assert.rejects(
    prepareCliOverlayWorkspace({
      runRoot: run.runRoot,
      request,
      workspaceRoot: run.workspaceRoot,
    }),
    error => error?.code === 'MACHINE_CLI_OVERLAY_ROOT_UNSAFE',
  );
  assert.equal(await fs.readFile(sentinelPath, 'utf8'), 'keep\n');
});

test('CLI overlay adapter blocks successful no-op when expected changed files are missing', async () => {
  const run = await makeRun('run_20260430_cli_noop_block');
  await fs.mkdir(path.join(run.workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(run.workspaceRoot, 'src/allowed.txt'), 'before\n', 'utf8');
  const request = createAdapterRequest({
    adapter: 'cli-agent-overlay',
    runId: run.runId,
    nodePath: 'queue/worker-loop',
    taskKind: 'workerLoop',
    workspaceRoot: run.workspaceRoot,
    workspaceMode: 'read-only-plus-overlay',
    allowedFiles: ['src/allowed.txt'],
    adapterCallId: 'cli-noop-call',
    attemptId: 'cli-noop-attempt-1',
    idempotencyKey: 'cli-noop-call:attempt-1',
    outputContract: 'orpad.workerResult.v1',
  });
  request.expectedChangedFiles = ['src/allowed.txt'];
  const overlayRoot = cliOverlayRoot(run.runRoot, request);
  const commandSpec = {
    command: process.execPath,
    args: ['-e', 'process.stdout.write("no-op")'],
    cwd: overlayRoot,
  };
  const result = await createCliAgentAdapter({
    enabled: true,
    runRoot: run.runRoot,
    workspaceRoot: run.workspaceRoot,
    commandSpec,
    commandGrants: [createCommandGrant({
      ...commandSpec,
      grantId: 'grant-cli-noop',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })],
  }).invoke(request);

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.changedFiles, []);
  assert.deepEqual(result.verification[0].expectedChangedFiles, ['src/allowed.txt']);
  assert.deepEqual(result.verification[0].missingExpectedChanges, ['src/allowed.txt']);
});

test('CLI overlay adapter preserves blocked stdout as blocked queue work', async () => {
  const run = await makeRun('run_20260524_cli_stdout_blocked');
  await fs.mkdir(path.join(run.workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(run.workspaceRoot, 'src/allowed.txt'), 'before\n', 'utf8');
  const claim = await queueAndClaim(run, 'claim-cli-stdout-blocked');
  const request = createAdapterRequest({
    adapter: 'cli-agent-overlay',
    runId: run.runId,
    nodePath: 'queue/worker-loop',
    taskKind: 'workerLoop',
    workspaceRoot: run.workspaceRoot,
    workspaceMode: 'read-only-plus-overlay',
    allowedFiles: claim.writeSet.paths,
    adapterCallId: 'cli-stdout-blocked-call',
    attemptId: 'cli-stdout-blocked-attempt-1',
    idempotencyKey: 'cli-stdout-blocked-call:attempt-1',
    outputContract: 'orpad.workerResult.v1',
  });
  const overlayRoot = cliOverlayRoot(run.runRoot, request);
  const stdoutResult = {
    schemaVersion: 'orpad.workerResult.v1',
    status: 'blocked',
    summary: 'Worker could not proceed because the target file was ambiguous.',
    nextAction: 'clarify-target-file-and-requeue',
    blockedReason: 'target-file-ambiguous',
    artifacts: [],
    changedFiles: [],
  };
  const commandSpec = {
    command: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(stdoutResult))})`],
    cwd: overlayRoot,
  };
  const adapter = createCliAgentAdapter({
    enabled: true,
    runRoot: run.runRoot,
    workspaceRoot: run.workspaceRoot,
    commandSpec,
    commandGrants: [createCommandGrant({
      ...commandSpec,
      grantId: 'grant-cli-stdout-blocked',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })],
  });

  const result = await adapter.invoke(request);
  assert.equal(result.status, 'blocked');
  assert.equal(result.nextAction, 'clarify-target-file-and-requeue');

  const applied = await applyWorkerResult(run.runRoot, {
    runId: run.runId,
    claimId: claim.claim.claimId,
    itemId: claim.item.id,
    request,
    result,
    now: '2026-04-30T00:00:30.000Z',
  });

  assert.equal(applied.toState, 'blocked');
  const item = await findQueueItem(run.runRoot, claim.item.id);
  assert.equal(item.state, 'blocked');
  assert.equal(item.item.workerResultStatus, 'blocked');
  assert.equal(item.item.nextAction, 'clarify-target-file-and-requeue');
  const workerEvent = (await readMachineEvents(run.runRoot)).find(event => event.eventType === 'worker.result');
  assert.equal(workerEvent.payload.status, 'blocked');
  assert.equal(workerEvent.payload.toState, 'blocked');
  assert.equal(workerEvent.payload.nextAction, 'clarify-target-file-and-requeue');
});

test('CLI overlay adapter extracts stdout evidence into canonical worker result fields', async () => {
  const run = await makeRun('run_20260524_cli_stdout_evidence');
  await fs.mkdir(path.join(run.workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(run.workspaceRoot, 'src/allowed.txt'), 'before\n', 'utf8');
  const claim = await queueAndClaim(run, 'claim-cli-stdout-evidence');
  const request = createAdapterRequest({
    adapter: 'cli-agent-overlay',
    runId: run.runId,
    nodePath: 'queue/worker-loop',
    taskKind: 'workerLoop',
    workspaceRoot: run.workspaceRoot,
    workspaceMode: 'read-only-plus-overlay',
    allowedFiles: claim.writeSet.paths,
    adapterCallId: 'cli-stdout-evidence-call',
    attemptId: 'cli-stdout-evidence-attempt-1',
    idempotencyKey: 'cli-stdout-evidence-call:attempt-1',
    outputContract: 'orpad.workerResult.v1',
  });
  request.expectedChangedFiles = ['src/allowed.txt'];
  const overlayRoot = cliOverlayRoot(run.runRoot, request);
  const stdoutResult = {
    schemaVersion: 'orpad.workerResult.v1',
    status: 'done',
    summary: 'Worker fixed the allowed target.',
    failingSymptom: 'The allowed target still contained stale text.',
    rootCause: 'The worker result parser ignored structured stdout evidence.',
    verificationCommands: ['node --test tests/orchestration-machine/cli-adapter-safety.test.mjs'],
    residualRisk: 'Only the focused adapter path is covered here.',
    artifacts: [],
  };
  const script = [
    'const fs=require("fs");',
    'fs.mkdirSync("src",{recursive:true});',
    'fs.writeFileSync("src/allowed.txt","after evidence\\n");',
    `process.stdout.write(${JSON.stringify(JSON.stringify(stdoutResult))});`,
  ].join('');
  const commandSpec = {
    command: process.execPath,
    args: ['-e', script],
    cwd: overlayRoot,
  };
  const result = await createCliAgentAdapter({
    enabled: true,
    runRoot: run.runRoot,
    workspaceRoot: run.workspaceRoot,
    commandSpec,
    commandGrants: [createCommandGrant({
      ...commandSpec,
      grantId: 'grant-cli-stdout-evidence',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })],
  }).invoke(request);

  assert.equal(result.status, 'done');
  assert.equal(result.rootCause, stdoutResult.rootCause);
  assert.deepEqual(result.filesChanged, ['src/allowed.txt']);
  assert.deepEqual(result.verificationCommands, stdoutResult.verificationCommands);

  await applyWorkerResult(run.runRoot, {
    runId: run.runId,
    claimId: claim.claim.claimId,
    itemId: claim.item.id,
    request,
    result,
    now: '2026-04-30T00:00:30.000Z',
  });
  const workerEvent = (await readMachineEvents(run.runRoot)).find(event => event.eventType === 'worker.result');
  assert.equal(workerEvent.payload.rootCause, stdoutResult.rootCause);
  assert.deepEqual(workerEvent.payload.filesChanged, ['src/allowed.txt']);
  assert.deepEqual(workerEvent.payload.verificationCommands, stdoutResult.verificationCommands);
});

test('CLI overlay adapter extracts worker result JSON nested inside provider result text', async () => {
  const run = await makeRun('run_20260524_cli_nested_stdout_evidence');
  await fs.mkdir(path.join(run.workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(run.workspaceRoot, 'src/allowed.txt'), 'before\n', 'utf8');
  const claim = await queueAndClaim(run, 'claim-cli-nested-stdout-evidence');
  const request = createAdapterRequest({
    adapter: 'cli-agent-overlay',
    runId: run.runId,
    nodePath: 'queue/worker-loop',
    taskKind: 'workerLoop',
    workspaceRoot: run.workspaceRoot,
    workspaceMode: 'read-only-plus-overlay',
    allowedFiles: claim.writeSet.paths,
    adapterCallId: 'cli-nested-stdout-evidence-call',
    attemptId: 'cli-nested-stdout-evidence-attempt-1',
    idempotencyKey: 'cli-nested-stdout-evidence-call:attempt-1',
    outputContract: 'orpad.workerResult.v1',
  });
  request.expectedChangedFiles = ['src/allowed.txt'];
  const overlayRoot = cliOverlayRoot(run.runRoot, request);
  const nestedResult = {
    schemaVersion: 'orpad.workerResult.v1',
    status: 'done',
    summary: 'Worker fixed the allowed target from a provider wrapper result.',
    failingSymptom: 'The provider wrapper hid the worker result in a result string.',
    rootCause: 'The parser did not inspect fenced JSON inside provider result text.',
    verificationCommands: ['node --test tests/orchestration-machine/cli-adapter-safety.test.mjs'],
    residualRisk: 'Only nested provider result parsing is covered here.',
    artifacts: [],
  };
  const providerEnvelope = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: [
      'Provider summary text.',
      '',
      '```json',
      JSON.stringify(nestedResult, null, 2),
      '```',
    ].join('\n'),
  };
  const script = [
    'const fs=require("fs");',
    'fs.mkdirSync("src",{recursive:true});',
    'fs.writeFileSync("src/allowed.txt","after nested evidence\\n");',
    `process.stdout.write(${JSON.stringify(JSON.stringify(providerEnvelope))});`,
  ].join('');
  const commandSpec = {
    command: process.execPath,
    args: ['-e', script],
    cwd: overlayRoot,
  };
  const result = await createCliAgentAdapter({
    enabled: true,
    runRoot: run.runRoot,
    workspaceRoot: run.workspaceRoot,
    commandSpec,
    commandGrants: [createCommandGrant({
      ...commandSpec,
      grantId: 'grant-cli-nested-stdout-evidence',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })],
  }).invoke(request);

  assert.equal(result.status, 'done');
  assert.equal(result.failingSymptom, nestedResult.failingSymptom);
  assert.equal(result.rootCause, nestedResult.rootCause);
  assert.equal(result.residualRisk, nestedResult.residualRisk);
  assert.deepEqual(result.filesChanged, ['src/allowed.txt']);
  assert.deepEqual(result.verificationCommands, nestedResult.verificationCommands);
});

test('CLI overlay adapter copies source-of-truth files as read-only context', async () => {
  const run = await makeRun('run_20260430_cli_readonly_context');
  await fs.mkdir(path.join(run.workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(run.workspaceRoot, 'src/input.md'), 'source material\n', 'utf8');
  const request = createAdapterRequest({
    adapter: 'cli-agent-overlay',
    runId: run.runId,
    nodePath: 'queue/worker-loop',
    taskKind: 'workerLoop',
    workspaceRoot: run.workspaceRoot,
    workspaceMode: 'read-only-plus-overlay',
    allowedFiles: ['dist/generated.txt'],
    readOnlyFiles: ['src/input.md'],
    adapterCallId: 'cli-readonly-context-call',
    attemptId: 'cli-readonly-context-attempt-1',
    idempotencyKey: 'cli-readonly-context-call:attempt-1',
    outputContract: 'orpad.workerResult.v1',
  });
  request.expectedChangedFiles = ['dist/generated.txt'];
  const overlayRoot = cliOverlayRoot(run.runRoot, request);
  const script = [
    'const fs=require("fs");',
    'const path=require("path");',
    'const input=fs.readFileSync("src/input.md","utf8");',
    'fs.mkdirSync("dist",{recursive:true});',
    'fs.writeFileSync("dist/generated.txt",input.toUpperCase(),"utf8");',
  ].join('');
  const commandSpec = {
    command: process.execPath,
    args: ['-e', script],
    cwd: overlayRoot,
  };

  const result = await createCliAgentAdapter({
    enabled: true,
    runRoot: run.runRoot,
    workspaceRoot: run.workspaceRoot,
    commandSpec,
    commandGrants: [createCommandGrant({
      ...commandSpec,
      grantId: 'grant-cli-readonly-context',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })],
  }).invoke(request);

  assert.equal(result.status, 'done');
  assert.deepEqual(result.changedFiles, ['dist/generated.txt']);
  assert.equal(result.verification[0].writeSetViolationCount, 0);
  assert.deepEqual(result.verification[0].missingExpectedChanges, []);
  assert.equal(await fs.readFile(path.join(run.workspaceRoot, 'src/input.md'), 'utf8'), 'source material\n');
});

test('CLI overlay patch collection and apply preserve binary files byte-for-byte', async () => {
  const run = await makeRun('run_20260430_cli_binary_patch');
  await fs.mkdir(path.join(run.workspaceRoot, 'bin'), { recursive: true });
  const before = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10, 0x80]);
  const after = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x01, 0xfe, 0x11, 0x81, 0x00]);
  await fs.writeFile(path.join(run.workspaceRoot, 'bin/out.pdf'), before);
  const request = createAdapterRequest({
    adapter: 'cli-agent-overlay',
    runId: run.runId,
    nodePath: 'queue/worker-loop',
    taskKind: 'workerLoop',
    workspaceRoot: run.workspaceRoot,
    workspaceMode: 'read-only-plus-overlay',
    allowedFiles: ['bin/out.pdf'],
    adapterCallId: 'cli-binary-patch-call',
    attemptId: 'cli-binary-patch-attempt-1',
    idempotencyKey: 'cli-binary-patch-call:attempt-1',
    outputContract: 'orpad.workerResult.v1',
  });
  request.expectedChangedFiles = ['bin/out.pdf'];
  const overlayRoot = cliOverlayRoot(run.runRoot, request);
  const script = [
    'const fs=require("fs");',
    'fs.mkdirSync("bin",{recursive:true});',
    `fs.writeFileSync("bin/out.pdf",Buffer.from(${JSON.stringify([...after])}));`,
  ].join('');
  const commandSpec = {
    command: process.execPath,
    args: ['-e', script],
    cwd: overlayRoot,
  };

  const result = await createCliAgentAdapter({
    enabled: true,
    runRoot: run.runRoot,
    workspaceRoot: run.workspaceRoot,
    commandSpec,
    commandGrants: [createCommandGrant({
      ...commandSpec,
      grantId: 'grant-cli-binary-patch',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })],
  }).invoke(request);

  assert.equal(result.status, 'done');
  const patch = JSON.parse(await fs.readFile(path.join(run.runRoot, result.patchArtifact), 'utf8'));
  assert.equal(patch.changes[0].contentEncoding, 'base64');
  assert.equal(Buffer.from(patch.changes[0].afterContentBase64, 'base64').equals(after), true);
  await applyPatchArtifact({
    workspaceRoot: run.workspaceRoot,
    patch,
    allowedFiles: patch.allowedFiles,
  });
  assert.equal((await fs.readFile(path.join(run.workspaceRoot, 'bin/out.pdf'))).equals(after), true);
});

test('CLI overlay adapter classifies provider permission prompts as approval-required', () => {
  const processResult = {
    code: 0,
    timedOut: false,
    stdout: 'Claude requested a tool, but you have not granted permission yet.',
    stderr: '',
  };
  assert.equal(processLooksApprovalRequired(processResult), true);
  assert.equal(resultStatusForProcess(processResult, { changes: [], violations: [] }, {
    expectedChangedFiles: ['src/allowed.txt'],
  }), 'approval-required');
});

test('CLI overlay adapter treats sandbox edit denials as approval-required before missing patch checks', () => {
  const processResult = {
    code: 0,
    timedOut: false,
    stdout: JSON.stringify({
      type: 'result',
      result: 'Sandbox denied write to the overlay copy; repeated Edit calls returned permission errors.',
      permission_denials: [{ tool_name: 'Edit' }],
    }),
    stderr: '',
  };
  assert.equal(processLooksApprovalRequired(processResult), true);
  assert.equal(resultStatusForProcess(processResult, { changes: [], violations: [] }, {
    expectedChangedFiles: ['src/allowed.txt'],
  }), 'approval-required');
});

test('CLI overlay adapter ignores empty provider permission-denial metadata on successful output', () => {
  const processResult = {
    code: 0,
    timedOut: false,
    stdout: JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify({
        schemaVersion: 'orpad.workerResult.v1',
        status: 'done',
        summary: 'updated overlay file',
      }),
      permission_denials: [],
      terminal_reason: 'completed',
    }),
    stderr: '',
  };
  const patch = {
    changes: [{ path: 'src/allowed.txt' }],
    violations: [],
  };
  assert.equal(processLooksApprovalRequired(processResult), false);
  assert.equal(resultStatusForProcess(processResult, patch, {
    expectedChangedFiles: ['src/allowed.txt'],
  }), 'done');
});

test('CLI overlay adapter blocks Codex dangerous sandbox bypass without explicit approval', async () => {
  const run = await makeRun('run_20260430_cli_dangerous_denied');
  await fs.mkdir(path.join(run.workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(run.workspaceRoot, 'src/allowed.txt'), 'before\n', 'utf8');
  const request = createAdapterRequest({
    adapter: 'cli-agent-overlay',
    runId: run.runId,
    nodePath: 'queue/worker-loop',
    taskKind: 'workerLoop',
    workspaceRoot: run.workspaceRoot,
    workspaceMode: 'read-only-plus-overlay',
    allowedFiles: ['src/allowed.txt'],
    adapterCallId: 'cli-dangerous-denied-call',
    attemptId: 'cli-dangerous-denied-attempt-1',
    idempotencyKey: 'cli-dangerous-denied-call:attempt-1',
    outputContract: 'orpad.workerResult.v1',
  });
  const overlayRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-dangerous-denied-'));
  const commandSpec = {
    command: process.execPath,
    args: ['-e', 'process.stdout.write("should-not-run")', '--', '--dangerously-bypass-approvals-and-sandbox'],
    cwd: overlayRoot,
  };

  await assert.rejects(
    createCliAgentAdapter({
      enabled: true,
      runRoot: run.runRoot,
      workspaceRoot: run.workspaceRoot,
      commandSpec,
      commandGrants: [createCommandGrant({
        ...commandSpec,
        grantId: 'grant-cli-dangerous-denied',
        expiresAt: '2099-01-01T00:00:00.000Z',
      })],
      overlayRoot,
      overlayRootMode: 'system-temp',
    }).invoke(request),
    error => error?.code === 'MACHINE_DANGEROUS_SANDBOX_BYPASS_NOT_APPROVED',
  );
});

test('CLI overlay adapter allows dangerous sandbox bypass only from approved system temp overlay', async () => {
  const run = await makeRun('run_20260430_cli_dangerous_approved');
  await fs.mkdir(path.join(run.workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(run.workspaceRoot, 'src/allowed.txt'), 'before\n', 'utf8');
  const request = createAdapterRequest({
    adapter: 'cli-agent-overlay',
    runId: run.runId,
    nodePath: 'queue/worker-loop',
    taskKind: 'workerLoop',
    workspaceRoot: run.workspaceRoot,
    workspaceMode: 'read-only-plus-overlay',
    allowedFiles: ['src/allowed.txt'],
    adapterCallId: 'cli-dangerous-approved-call',
    attemptId: 'cli-dangerous-approved-attempt-1',
    idempotencyKey: 'cli-dangerous-approved-call:attempt-1',
    outputContract: 'orpad.workerResult.v1',
  });
  request.expectedChangedFiles = ['src/allowed.txt'];
  request.dangerousSandboxBypassApproval = {
    approved: true,
    reason: 'unit test approved dangerous Codex bypass in a temp overlay',
  };
  const overlayRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-dangerous-approved-'));
  const script = [
    'const fs=require("fs");',
    'fs.mkdirSync("src",{recursive:true});',
    'fs.writeFileSync("src/allowed.txt","after\\n","utf8");',
  ].join('');
  const commandSpec = {
    command: process.execPath,
    args: ['-e', script, '--', '--dangerously-bypass-approvals-and-sandbox'],
    cwd: overlayRoot,
  };
  const result = await createCliAgentAdapter({
    enabled: true,
    runRoot: run.runRoot,
    workspaceRoot: run.workspaceRoot,
    commandSpec,
    commandGrants: [createCommandGrant({
      ...commandSpec,
      grantId: 'grant-cli-dangerous-approved',
      allowDangerousSandboxBypass: true,
      expiresAt: '2099-01-01T00:00:00.000Z',
    })],
    overlayRoot,
    overlayRootMode: 'system-temp',
    allowDangerousSandboxBypass: true,
  }).invoke(request);

  assert.equal(result.status, 'done');
  assert.deepEqual(result.changedFiles, ['src/allowed.txt']);
  assert.equal(result.verification[0].containment.dangerousSandboxBypass, true);
  assert.equal(result.verification[0].containment.dangerousSandboxBypassApproved, true);
  await assert.rejects(
    fs.access(overlayRoot),
    error => error?.code === 'ENOENT',
  );
});

test('CLI overlay adapter rejects commands that escape overlay cwd or reference the canonical workspace path', async () => {
  const run = await makeRun('run_20260430_cli_containment');
  await fs.mkdir(path.join(run.workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(run.workspaceRoot, 'src/allowed.txt'), 'before\n', 'utf8');
  const baseRequest = createAdapterRequest({
    adapter: 'cli-agent-overlay',
    runId: run.runId,
    nodePath: 'queue/worker-loop',
    taskKind: 'workerLoop',
    workspaceRoot: run.workspaceRoot,
    workspaceMode: 'read-only-plus-overlay',
    allowedFiles: ['src/allowed.txt'],
    adapterCallId: 'cli-containment-call',
    attemptId: 'cli-containment-attempt-1',
    idempotencyKey: 'cli-containment-call:attempt-1',
    outputContract: 'orpad.workerResult.v1',
  });
  const overlayRoot = cliOverlayRoot(run.runRoot, baseRequest);
  const outsideCwdSpec = {
    command: process.execPath,
    args: ['-e', 'process.stdout.write("outside-cwd")'],
    cwd: run.workspaceRoot,
  };
  await assert.rejects(
    createCliAgentAdapter({
      enabled: true,
      runRoot: run.runRoot,
      workspaceRoot: run.workspaceRoot,
      commandSpec: outsideCwdSpec,
      commandGrants: [createCommandGrant({
        ...outsideCwdSpec,
        grantId: 'grant-cli-outside-cwd',
        expiresAt: '2099-01-01T00:00:00.000Z',
      })],
    }).invoke(baseRequest),
    error => error?.code === 'MACHINE_PROCESS_CWD_OUTSIDE_OVERLAY',
  );

  const canonicalArgSpec = {
    command: process.execPath,
    args: ['-e', 'process.stdout.write(process.argv[1] || "")', run.workspaceRoot],
    cwd: overlayRoot,
  };
  await assert.rejects(
    createCliAgentAdapter({
      enabled: true,
      runRoot: run.runRoot,
      workspaceRoot: run.workspaceRoot,
      commandSpec: canonicalArgSpec,
      commandGrants: [createCommandGrant({
        ...canonicalArgSpec,
        grantId: 'grant-cli-canonical-arg',
        expiresAt: '2099-01-01T00:00:00.000Z',
      })],
    }).invoke(baseRequest),
    error => error?.code === 'MACHINE_PROCESS_CANONICAL_PATH_ARG',
  );
});

test('Machine-applied patch rejects out-of-write-set paths and duplicate base application', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-patch-'));
  await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'src/allowed.txt'), 'before\n', 'utf8');
  const invalidPatch = {
    schemaVersion: 'orpad.patchArtifact.v1',
    createdAt: '2026-04-30T00:00:00.000Z',
    allowedFiles: ['src/allowed.txt'],
    changes: [{
      path: 'src/outside.txt',
      beforeExists: false,
      afterExists: true,
      beforeSha256: '',
      afterSha256: sha256Text('outside\n'),
      beforeContent: '',
      afterContent: 'outside\n',
    }],
    violations: [],
  };

  await assert.rejects(
    applyPatchArtifact({ workspaceRoot, patch: invalidPatch }),
    error => error?.code === 'PATCH_WRITE_SET_VIOLATION',
  );
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'src/allowed.txt'), 'utf8'), 'before\n');

  const validPatch = {
    schemaVersion: 'orpad.patchArtifact.v1',
    createdAt: '2026-04-30T00:00:00.000Z',
    allowedFiles: ['src/allowed.txt'],
    changes: [{
      path: 'src/allowed.txt',
      beforeExists: true,
      afterExists: true,
      beforeSha256: sha256Text('before\n'),
      afterSha256: sha256Text('after\n'),
      beforeContent: 'before\n',
      afterContent: 'after\n',
    }],
    violations: [],
  };

  await applyPatchArtifact({ workspaceRoot, patch: validPatch });
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'src/allowed.txt'), 'utf8'), 'after\n');
  await assert.rejects(
    applyPatchArtifact({ workspaceRoot, patch: validPatch }),
    error => error?.code === 'PATCH_BASE_MISMATCH',
  );

  await fs.writeFile(path.join(workspaceRoot, 'src/first.txt'), 'first before\n', 'utf8');
  await fs.writeFile(path.join(workspaceRoot, 'src/second.txt'), 'second changed\n', 'utf8');
  const multiFilePatch = {
    schemaVersion: 'orpad.patchArtifact.v1',
    createdAt: '2026-04-30T00:00:00.000Z',
    allowedFiles: ['src/first.txt', 'src/second.txt'],
    changes: [
      {
        path: 'src/first.txt',
        beforeExists: true,
        afterExists: true,
        beforeSha256: sha256Text('first before\n'),
        afterSha256: sha256Text('first after\n'),
        beforeContent: 'first before\n',
        afterContent: 'first after\n',
      },
      {
        path: 'src/second.txt',
        beforeExists: true,
        afterExists: true,
        beforeSha256: sha256Text('second before\n'),
        afterSha256: sha256Text('second after\n'),
        beforeContent: 'second before\n',
        afterContent: 'second after\n',
      },
    ],
    violations: [],
  };

  await assert.rejects(
    applyPatchArtifact({ workspaceRoot, patch: multiFilePatch }),
    error => error?.code === 'PATCH_BASE_MISMATCH'
      && error.path === 'src/second.txt'
      && error.mismatches?.length === 1,
  );
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'src/first.txt'), 'utf8'), 'first before\n');
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'src/second.txt'), 'utf8'), 'second changed\n');
});

test('Machine patch helpers reject workspace symlink paths before copy or apply', async t => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-symlink-workspace-'));
  const overlayRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-symlink-overlay-'));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-symlink-outside-'));
  await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  const outsideFile = path.join(outsideRoot, 'outside.txt');
  await fs.writeFile(outsideFile, 'outside-before\n', 'utf8');
  const linkPath = path.join(workspaceRoot, 'src/link.txt');
  if (!await createTestSymlink(t, outsideFile, linkPath, 'file')) return;

  await assert.rejects(
    copyAllowedFilesToOverlay({
      workspaceRoot,
      overlayRoot,
      allowedFiles: ['src/link.txt'],
    }),
    error => error?.code === 'MACHINE_WORKSPACE_SYMLINK_UNSAFE',
  );

  const symlinkPatch = {
    schemaVersion: 'orpad.patchArtifact.v1',
    createdAt: '2026-04-30T00:00:00.000Z',
    allowedFiles: ['src/link.txt'],
    changes: [{
      path: 'src/link.txt',
      beforeExists: true,
      afterExists: true,
      beforeSha256: sha256Text('outside-before\n'),
      afterSha256: sha256Text('outside-after\n'),
      beforeContent: 'outside-before\n',
      afterContent: 'outside-after\n',
    }],
    violations: [],
  };
  await assert.rejects(
    applyPatchArtifact({ workspaceRoot, patch: symlinkPatch }),
    error => error?.code === 'MACHINE_WORKSPACE_SYMLINK_UNSAFE',
  );
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'outside-before\n');
});

test('WorkerLoop rejects accepted results that claim changes outside the active write set', async () => {
  const run = await makeRun('run_20260430_worker_write_set_violation');
  await fs.mkdir(path.join(run.workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(run.workspaceRoot, 'src/allowed.txt'), 'before\n', 'utf8');
  const claimed = await queueAndClaim(run);
  const request = createAdapterRequest({
    adapter: 'worker-fixture',
    runId: run.runId,
    nodePath: 'queue/worker-loop',
    taskKind: 'workerLoop',
    adapterCallId: 'worker-write-set-call',
    attemptId: 'worker-write-set-attempt-1',
    idempotencyKey: 'worker-write-set-call:attempt-1',
    outputContract: 'orpad.workerResult.v1',
  });

  await assert.rejects(
    applyWorkerResult(run.runRoot, {
      runId: run.runId,
      claimId: claimed.claim.claimId,
      itemId: claimed.item.id,
      request,
      result: {
        schemaVersion: 'orpad.workerResult.v1',
        adapterCallId: request.adapterCallId,
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        status: 'done',
        summary: 'Changed outside the write set.',
        artifacts: ['artifacts/work-items/cli-write-set-item/proof.md'],
        verification: [{ command: 'npm run build:renderer', status: 'passed' }],
        changedFiles: ['src/outside.txt'],
      },
      now: '2026-04-30T00:00:30.000Z',
    }),
    error => error?.code === 'WORKER_RESULT_WRITE_SET_VIOLATION',
  );

  assert.equal((await findQueueItem(run.runRoot, claimed.item.id)).state, 'claimed');
  assert.equal((await readMachineEvents(run.runRoot)).some(event => event.eventType === 'worker.result'), false);
});
