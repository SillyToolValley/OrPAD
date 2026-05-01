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
  copyAllowedFilesToOverlay,
  createAdapterRequest,
  createCliAgentAdapter,
  createCommandGrant,
  createMachineRun,
  findQueueItem,
  ingestCandidateProposal,
  prepareCliOverlayWorkspace,
  redactCommandArgs,
  readMachineEvents,
  runMachineProcess,
  sanitizeEnvironment,
  sha256Text,
  transitionQueueItem,
} = require('../../src/main/orchestration-machine');

const fixedNow = new Date('2026-04-30T00:00:00.000Z');

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
