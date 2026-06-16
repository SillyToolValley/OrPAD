import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  PROVISION_INSTALL_ARG_ALLOWLIST,
  createMachineRun,
  executeProvisionSteps,
  normalizeProvisionConfig,
} = require('../../src/main/orchestration-machine');

const fixedNow = new Date('2026-06-11T00:00:00.000Z');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

async function fileExists(filePath) {
  try { return (await fs.stat(filePath)).isFile(); } catch { return false; }
}

async function makeFixtureRepo(root) {
  const repoDir = path.join(root, 'fixture-repo');
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(path.join(repoDir, 'README.md'), '# fixture\n', 'utf8');
  git(repoDir, 'init', '--initial-branch=main');
  git(repoDir, '-c', 'user.name=orpad-test', '-c', 'user.email=test@orpad.local', 'add', '.');
  git(repoDir, '-c', 'user.name=orpad-test', '-c', 'user.email=test@orpad.local', 'commit', '-m', 'fixture');
  return repoDir;
}

async function withTempRoot(fn) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-provision-'));
  try {
    const workspaceRoot = path.join(tempRoot, 'workspace');
    const pipelineDir = path.join(workspaceRoot, '.orpad', 'pipelines', 'provision-pipeline');
    await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
    const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
    await fs.writeFile(pipelinePath, JSON.stringify({
      kind: 'orpad.pipeline',
      version: '1.0',
      id: 'provision-pipeline',
      entryGraph: 'graphs/main.or-graph',
    }, null, 2), 'utf8');
    const run = await createMachineRun({
      workspaceRoot,
      pipelinePath,
      runId: `run_20260611_provision_${path.basename(tempRoot).slice(-6)}`,
      now: fixedNow,
    });
    return await fn({ tempRoot, workspaceRoot, runRoot: run.runRoot, runId: run.runId });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test('normalizeProvisionConfig requires a non-empty steps array', () => {
  const empty = normalizeProvisionConfig({});
  assert.equal(empty.problems.some(problem => problem.code === 'PROVISION_STEPS_REQUIRED'), true);
  assert.equal(empty.onFail, 'block');
});

test('normalizeProvisionConfig rejects unsupported kinds, repos, and escaping dirs', () => {
  const { problems } = normalizeProvisionConfig({
    steps: [
      { kind: 'shell', command: 'rm -rf /' },
      { kind: 'git-clone', repo: 'not-a-url', targetDir: 'ok' },
      { kind: 'git-clone', repo: 'https://github.com/example/repo', targetDir: '../outside' },
      { kind: 'git-clone', repo: 'https://github.com/example/repo', targetDir: '.orpad/inner' },
      { kind: 'git-clone', repo: 'https://github.com/example/repo', targetDir: 'C:/abs' },
      { kind: 'install', tool: 'cargo', dir: 'repo' },
      { kind: 'install', tool: 'npm', dir: 'repo', args: ['install', '--unsafe-perm'] },
    ],
  });
  const codes = problems.map(problem => problem.code);
  assert.equal(codes.includes('PROVISION_STEP_KIND_UNSUPPORTED'), true);
  assert.equal(codes.includes('PROVISION_CLONE_REPO_INVALID'), true);
  assert.equal(codes.filter(code => code === 'PROVISION_CLONE_TARGET_DIR_INVALID').length, 3);
  assert.equal(codes.includes('PROVISION_INSTALL_TOOL_UNSUPPORTED'), true);
  assert.equal(codes.includes('PROVISION_INSTALL_ARGS_UNSUPPORTED'), true);
});

test('normalizeProvisionConfig normalizes valid steps and quarantines lifecycle scripts', () => {
  const { steps, problems } = normalizeProvisionConfig({
    steps: [
      { kind: 'git-clone', repo: 'https://github.com/example/repo', targetDir: 'vendor\\repo', ref: 'main' },
      { kind: 'install', tool: 'npm', dir: 'vendor/repo' },
    ],
  });
  assert.deepEqual(problems, []);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].targetDir, 'vendor/repo');
  assert.equal(steps[0].depth, 1);
  assert.equal(steps[1].args.includes('--ignore-scripts'), true);
  assert.equal(PROVISION_INSTALL_ARG_ALLOWLIST.includes('--ignore-scripts'), true);
});

test('executeProvisionSteps blocks without a workspace root', async () => {
  const result = await executeProvisionSteps({
    runRoot: '',
    runId: 'run_20260611_no_workspace',
    config: { steps: [{ kind: 'git-clone', repo: 'https://github.com/example/repo', targetDir: 'repo' }] },
  });
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'provision.workspace-missing');
});

test('executeProvisionSteps blocks on invalid config and warns when onFail is warn', async () => {
  await withTempRoot(async ({ workspaceRoot, runRoot, runId }) => {
    const blocked = await executeProvisionSteps({
      runRoot,
      runId,
      nodePath: 'main/provision',
      workspaceRoot,
      config: { steps: [] },
    });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.reason, 'provision.config-invalid');

    const warned = await executeProvisionSteps({
      runRoot,
      runId,
      nodePath: 'main/provision',
      workspaceRoot,
      config: { steps: [], onFail: 'warn' },
    });
    assert.equal(warned.blocked, undefined);
    assert.equal(warned.valid, false);
    assert.equal(warned.warned, true);
  });
});

test('executeProvisionSteps clones a repo, registers evidence, and is idempotent on re-drive', async () => {
  await withTempRoot(async ({ tempRoot, workspaceRoot, runRoot, runId }) => {
    const fixtureRepo = await makeFixtureRepo(tempRoot);
    const config = {
      steps: [{ kind: 'git-clone', repo: pathToFileURL(fixtureRepo).href, targetDir: 'sprite-gen' }],
    };
    const first = await executeProvisionSteps({
      runRoot,
      runId,
      nodePath: 'main/provision',
      workspaceRoot,
      config,
    });
    assert.equal(first.valid, true, JSON.stringify(first.steps));
    assert.equal(first.steps[0].status, 'completed');
    assert.equal(first.executedCount, 1);
    const readme = await fs.readFile(path.join(workspaceRoot, 'sprite-gen', 'README.md'), 'utf8');
    assert.equal(readme.includes('fixture'), true);
    assert.equal(typeof first.evidenceArtifact, 'string');
    assert.equal(first.evidenceArtifact.length > 0, true, first.evidenceError || 'evidence artifact missing');
    const evidence = JSON.parse(await fs.readFile(path.join(runRoot, first.evidenceArtifact), 'utf8'));
    assert.equal(evidence.schemaVersion, 'orpad.provisionEvidence.v1');
    assert.equal(evidence.steps[0].kind, 'git-clone');

    const second = await executeProvisionSteps({
      runRoot,
      runId,
      nodePath: 'main/provision',
      workspaceRoot,
      config,
    });
    assert.equal(second.valid, true);
    assert.equal(second.steps[0].status, 'skipped');
    assert.equal(second.steps[0].skippedReason, 'already-cloned');
  });
});

test('executeProvisionSteps refuses to clone over a non-git occupied directory', async () => {
  await withTempRoot(async ({ workspaceRoot, runRoot, runId }) => {
    await fs.mkdir(path.join(workspaceRoot, 'sprite-gen'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'sprite-gen', 'user-file.txt'), 'precious', 'utf8');
    const result = await executeProvisionSteps({
      runRoot,
      runId,
      nodePath: 'main/provision',
      workspaceRoot,
      config: {
        steps: [{ kind: 'git-clone', repo: 'https://github.com/example/repo', targetDir: 'sprite-gen' }],
      },
    });
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'provision.step-failed');
    assert.equal(result.failedStep.failureCode, 'PROVISION_CLONE_TARGET_OCCUPIED');
    const preserved = await fs.readFile(path.join(workspaceRoot, 'sprite-gen', 'user-file.txt'), 'utf8');
    assert.equal(preserved, 'precious');
  });
});

test('executeProvisionSteps surfaces clone failures as typed blocked outcomes and skips later steps', async () => {
  await withTempRoot(async ({ tempRoot, workspaceRoot, runRoot, runId }) => {
    const missingRepo = pathToFileURL(path.join(tempRoot, 'does-not-exist')).href;
    const result = await executeProvisionSteps({
      runRoot,
      runId,
      nodePath: 'main/provision',
      workspaceRoot,
      config: {
        steps: [
          { kind: 'git-clone', repo: missingRepo, targetDir: 'sprite-gen' },
          { kind: 'install', tool: 'npm', dir: 'sprite-gen' },
        ],
      },
    });
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'provision.step-failed');
    assert.equal(result.failedStep.kind, 'git-clone');
    assert.equal(result.steps[1].status, 'skipped');
    assert.equal(result.steps[1].skippedReason, 'previous-step-failed');

    const warned = await executeProvisionSteps({
      runRoot,
      runId,
      nodePath: 'main/provision',
      workspaceRoot,
      config: {
        onFail: 'warn',
        steps: [{ kind: 'git-clone', repo: missingRepo, targetDir: 'sprite-gen' }],
      },
    });
    assert.equal(warned.blocked, undefined);
    assert.equal(warned.valid, false);
    assert.equal(warned.warned, true);
  });
});

test('executeProvisionSteps install step fails typed on missing dir and skips when satisfied', async () => {
  await withTempRoot(async ({ workspaceRoot, runRoot, runId }) => {
    const missing = await executeProvisionSteps({
      runRoot,
      runId,
      nodePath: 'main/provision',
      workspaceRoot,
      config: { steps: [{ kind: 'install', tool: 'npm', dir: 'sprite-gen' }] },
    });
    assert.equal(missing.blocked, true);
    assert.equal(missing.failedStep.failureCode, 'PROVISION_INSTALL_DIR_MISSING');

    await fs.mkdir(path.join(workspaceRoot, 'sprite-gen'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'sprite-gen', 'package.json'), '{"name":"x"}\n', 'utf8');
    await fs.mkdir(path.join(workspaceRoot, 'sprite-gen', 'node_modules'), { recursive: true });
    const satisfied = await executeProvisionSteps({
      runRoot,
      runId,
      nodePath: 'main/provision',
      workspaceRoot,
      config: { steps: [{ kind: 'install', tool: 'npm', dir: 'sprite-gen' }] },
    });
    assert.equal(satisfied.valid, true);
    assert.equal(satisfied.steps[0].status, 'skipped');
    assert.equal(satisfied.steps[0].skippedReason, 'dependencies-present');
  });
});

test('executeProvisionSteps install step skips a non-Node directory instead of polluting it', async () => {
  // Regression: SpriteGenTest cloned a Python repo (pyproject.toml, no
  // package.json); the npm install step wrote an empty package-lock.json and
  // reported a false green. A directory with no package.json must skip cleanly.
  await withTempRoot(async ({ workspaceRoot, runRoot, runId }) => {
    const pyDir = path.join(workspaceRoot, 'sprite-gen');
    await fs.mkdir(pyDir, { recursive: true });
    await fs.writeFile(path.join(pyDir, 'pyproject.toml'), '[project]\nname = "sprite-gen"\n', 'utf8');
    const result = await executeProvisionSteps({
      runRoot,
      runId,
      nodePath: 'main/provision',
      workspaceRoot,
      config: { steps: [{ kind: 'install', tool: 'npm', dir: 'sprite-gen' }] },
    });
    assert.equal(result.valid, true);
    assert.equal(result.steps[0].status, 'skipped');
    assert.equal(result.steps[0].skippedReason, 'no-package-json');
    assert.equal(await fileExists(path.join(pyDir, 'package-lock.json')), false);
  });
});
