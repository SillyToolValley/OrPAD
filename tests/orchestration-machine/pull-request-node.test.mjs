import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
  executePullRequestSteps,
  normalizePullRequestConfig,
} = require(path.join(repoRoot, 'src/main/orchestration-machine/pull-request-node'));

// Fake git/gh process runner. Resolves like runMachineProcess ({code,stdout,
// stderr,timedOut}) and throws (rejects) to simulate a spawn failure.
function makeRunner(overrides = {}) {
  return async ({ command, args }) => {
    if (command === 'git' && args[0] === 'rev-parse') {
      return { code: overrides.notGit ? 1 : 0, stdout: overrides.notGit ? 'false' : 'true', stderr: '' };
    }
    if (command === 'git' && args[0] === 'status') {
      return { code: 0, stdout: overrides.noChanges ? '' : ' M src/a.js\n', stderr: '' };
    }
    if (command === 'git' && ['checkout', 'add', 'commit', 'push'].includes(args[0])) {
      if (overrides.failCommand === args[0]) return { code: 1, stdout: '', stderr: `${args[0]} failed` };
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
      if (overrides.ghUnavailable) {
        const err = new Error('spawn gh ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      if (overrides.prCreateFail) return { code: 1, stdout: '', stderr: 'pr create failed' };
      return { code: 0, stdout: 'Created PR\nhttps://github.com/o/r/pull/7\n', stderr: '' };
    }
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'checks') {
      return { code: overrides.checksCode ?? 0, stdout: '', stderr: overrides.checksCode ? 'failing' : '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

const noopSleep = async () => {};
const base = { workspaceRoot: '/tmp/orpad-pr-x', runRoot: '', sleep: noopSleep };

test('normalizePullRequestConfig requires a title and validates branch/remote/base', () => {
  assert.ok(normalizePullRequestConfig({}).problems.some(p => p.code === 'PULL_REQUEST_TITLE_REQUIRED'));
  assert.equal(normalizePullRequestConfig({ title: 'T' }).problems.length, 0);
  assert.ok(normalizePullRequestConfig({ title: 'T', branch: 'bad branch!' }).problems.some(p => p.code === 'PULL_REQUEST_BRANCH_INVALID'));
  assert.ok(normalizePullRequestConfig({ title: 'T', remote: 'bad/remote' }).problems.some(p => p.code === 'PULL_REQUEST_REMOTE_INVALID'));
  assert.equal(normalizePullRequestConfig({ title: 'T' }).onFail, 'block');
});

test('pullRequest opens a PR on the happy path and captures the PR url', async () => {
  const res = await executePullRequestSteps({ ...base, config: { title: 'T' }, runProcess: makeRunner() });
  assert.equal(res.blocked, undefined, 'not blocked');
  assert.equal(res.valid, true);
  assert.equal(res.prUrl, 'https://github.com/o/r/pull/7');
  assert.ok(res.steps.some(s => s.name === 'gh-pr-create' && s.status === 'completed'));
});

test('pullRequest with requireChecks gates on CI: passes when checks pass, blocks when they fail', async () => {
  const pass = await executePullRequestSteps({ ...base, config: { title: 'T', requireChecks: true }, runProcess: makeRunner({ checksCode: 0 }) });
  assert.equal(pass.valid, true);
  assert.equal(pass.checks.status, 'passed');

  const fail = await executePullRequestSteps({ ...base, config: { title: 'T', requireChecks: true }, runProcess: makeRunner({ checksCode: 1 }) });
  assert.equal(fail.blocked, true);
  assert.equal(fail.reason, 'pull-request.checks-failed');
  assert.equal(fail.prUrl, 'https://github.com/o/r/pull/7', 'the PR url is still reported');
});

test('pullRequest blocks with a typed reason when gh is unavailable', async () => {
  const res = await executePullRequestSteps({ ...base, config: { title: 'T' }, runProcess: makeRunner({ ghUnavailable: true }) });
  assert.equal(res.blocked, true);
  assert.equal(res.reason, 'pull-request.gh-unavailable');
});

test('pullRequest blocks on a non-git workspace and on an empty working tree', async () => {
  const notGit = await executePullRequestSteps({ ...base, config: { title: 'T' }, runProcess: makeRunner({ notGit: true }) });
  assert.equal(notGit.blocked, true);
  assert.equal(notGit.reason, 'pull-request.not-a-git-repo');

  const noChanges = await executePullRequestSteps({ ...base, config: { title: 'T' }, runProcess: makeRunner({ noChanges: true }) });
  assert.equal(noChanges.blocked, true);
  assert.equal(noChanges.reason, 'pull-request.no-changes');
});

test('pullRequest blocks on invalid config (missing title)', async () => {
  const res = await executePullRequestSteps({ ...base, config: {}, runProcess: makeRunner() });
  assert.equal(res.blocked, true);
  assert.equal(res.reason, 'pull-request.config-invalid');
});

test('pullRequest honors onFail:warn (degrades to a warning instead of blocking)', async () => {
  const res = await executePullRequestSteps({ ...base, config: { title: 'T', onFail: 'warn' }, runProcess: makeRunner({ ghUnavailable: true }) });
  assert.equal(res.blocked, undefined);
  assert.equal(res.warned, true);
  assert.equal(res.reason, 'pull-request.gh-unavailable');
});
