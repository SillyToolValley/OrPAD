// orpad.pullRequest — opt-in PR / CI / review-loop support node.
//
// After the patch-review node applies worker changes to the canonical
// workspace, regular OrPAD has no path to a real pull request — patchReview /
// artifactContract are pipeline-internal review only. This node closes that gap,
// machine-side (no LLM), with a deliberately narrow verb vocabulary instead of
// arbitrary commands:
//
//   1. verify the workspace is a git repo with uncommitted changes
//   2. create/switch to the PR branch, stage + commit the changes
//   3. push the branch, open a PR via `gh pr create`
//   4. (optional) poll `gh pr checks` and gate the run on CI status
//
// It is opt-in (the node only exists if authored) and requires an
// authenticated gh CLI. Every failure is a typed blocked outcome with a
// pull-request evidence artifact — never a silent pass. All external commands
// run through an injectable `runProcess` (default: the Machine process runner)
// so the success path is deterministically testable without a live gh.

const { registerJsonArtifact } = require('./adapters/cli-agent');
const { runMachineProcess } = require('./adapters/process-runner');

const DEFAULT_STEP_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_STEP_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_CHECKS_POLL_INTERVAL_MS = 15 * 1000;
const DEFAULT_CHECKS_MAX_WAIT_MS = 10 * 60 * 1000;
const MAX_CHECKS_POLL_ATTEMPTS = 240;
const OUTPUT_TAIL_CHARS = 2000;

// gh pr checks exits 0 = all passed, 8 = some pending, anything else = failure.
const GH_CHECKS_PASS = 0;
const GH_CHECKS_PENDING = 8;

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const REMOTE_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

function problemEntry(code, message) {
  return { code, message };
}

function clampStepTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STEP_TIMEOUT_MS;
  return Math.min(parsed, MAX_STEP_TIMEOUT_MS);
}

function clampPositive(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function outputTail(text) {
  return String(text || '').slice(-OUTPUT_TAIL_CHARS);
}

function nodeKey(nodePath) {
  return String(nodePath || 'pull-request').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'pull-request';
}

function normalizePullRequestConfig(config = {}) {
  const problems = [];
  const onFail = config.onFail === 'warn' ? 'warn' : 'block';
  const branch = String(config.branch || '').trim();
  if (branch && !BRANCH_PATTERN.test(branch)) {
    problems.push(problemEntry('PULL_REQUEST_BRANCH_INVALID', `pullRequest branch "${branch}" must match [A-Za-z0-9._/-] (<=200 chars).`));
  }
  const remote = String(config.remote || 'origin').trim();
  if (!REMOTE_PATTERN.test(remote)) {
    problems.push(problemEntry('PULL_REQUEST_REMOTE_INVALID', `pullRequest remote "${remote}" must match [A-Za-z0-9._-].`));
  }
  const title = String(config.title || '').trim();
  if (!title) {
    problems.push(problemEntry('PULL_REQUEST_TITLE_REQUIRED', 'pullRequest node config.title is required.'));
  }
  const base = String(config.base || '').trim();
  if (base && !BRANCH_PATTERN.test(base)) {
    problems.push(problemEntry('PULL_REQUEST_BASE_INVALID', `pullRequest base "${base}" must match [A-Za-z0-9._/-].`));
  }
  const commitPaths = Array.isArray(config.commitPaths)
    ? config.commitPaths.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  return {
    branch,
    remote,
    title,
    base,
    body: String(config.body || '').slice(0, 4000),
    draft: config.draft === true,
    push: config.push !== false,
    commitMessage: String(config.commitMessage || title || 'OrPAD automated change').slice(0, 500),
    commitPaths,
    requireChecks: config.requireChecks === true || config.requireChecks === 'true',
    pollIntervalMs: clampPositive(config.pollIntervalMs, DEFAULT_CHECKS_POLL_INTERVAL_MS, DEFAULT_CHECKS_MAX_WAIT_MS),
    checksMaxWaitMs: clampPositive(config.checksMaxWaitMs, DEFAULT_CHECKS_MAX_WAIT_MS, MAX_STEP_TIMEOUT_MS),
    timeoutMs: clampStepTimeoutMs(config.timeoutMs),
    onFail,
    problems,
  };
}

function defaultRunProcess(spec) {
  return runMachineProcess(spec);
}

async function realSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runStep(context, args, command = 'git') {
  let result;
  try {
    result = await context.runProcess({
      command,
      args,
      cwd: context.workspaceRoot,
      runId: context.runId,
      adapterCallId: `pull-request-${context.nodeKey}`,
      timeoutMs: context.timeoutMs,
      maxOutputBytes: 256 * 1024,
    });
  } catch (err) {
    return { ok: false, code: null, timedOut: false, stdout: '', stderr: err?.message || '', spawnErrorCode: err?.code || 'EUNKNOWN' };
  }
  return {
    ok: result.code === 0 && !result.timedOut,
    code: typeof result.code === 'number' ? result.code : null,
    timedOut: Boolean(result.timedOut),
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    spawnErrorCode: result.spawnError?.code || '',
  };
}

function stepRecord(name, command, args, result, extra = {}) {
  return {
    name,
    command,
    args,
    status: result.ok ? 'completed' : 'failed',
    exitCode: result.code,
    timedOut: result.timedOut,
    ...(result.spawnErrorCode ? { spawnErrorCode: result.spawnErrorCode } : {}),
    ...(result.ok ? {} : { stderrTail: outputTail(result.stderr) }),
    ...extra,
  };
}

function firstUrlIn(text) {
  const match = String(text || '').match(/https?:\/\/\S+/);
  return match ? match[0] : '';
}

async function registerEvidence(runRoot, runId, nodePath, key, value) {
  try {
    const artifact = await registerJsonArtifact(runRoot, {
      runId,
      artifactPath: `artifacts/pull-request/${key}.json`,
      producedBy: 'orpad.pullRequest',
      schemaVersion: 'orpad.pullRequestEvidence.v1',
      value: { schemaVersion: 'orpad.pullRequestEvidence.v1', nodePath, ...value },
    });
    return artifact?.file?.path || '';
  } catch {
    return '';
  }
}

async function pollChecks(context, cfg, branch) {
  const started = context.now ? context.now() : 0;
  let elapsed = 0;
  for (let attempt = 0; attempt < MAX_CHECKS_POLL_ATTEMPTS; attempt += 1) {
    const result = await runStep(context, ['pr', 'checks', branch], 'gh');
    if (result.spawnErrorCode) {
      return { status: 'unavailable', reason: 'gh-unavailable', attempts: attempt + 1, lastExitCode: result.code };
    }
    if (result.code === GH_CHECKS_PASS) {
      return { status: 'passed', attempts: attempt + 1, lastExitCode: result.code };
    }
    if (result.code !== GH_CHECKS_PENDING) {
      return { status: 'failed', attempts: attempt + 1, lastExitCode: result.code, stderrTail: outputTail(result.stderr) };
    }
    elapsed += cfg.pollIntervalMs;
    if (elapsed >= cfg.checksMaxWaitMs) {
      return { status: 'timeout', attempts: attempt + 1, lastExitCode: result.code, waitedMs: elapsed };
    }
    await context.sleep(cfg.pollIntervalMs);
  }
  return { status: 'timeout', attempts: MAX_CHECKS_POLL_ATTEMPTS, waitedMs: elapsed };
}

async function executePullRequestSteps(input = {}) {
  const {
    runRoot = '',
    runId = '',
    nodePath = '',
    workspaceRoot = '',
    config = {},
    runProcess = defaultRunProcess,
    sleep = realSleep,
  } = input;
  const cfg = normalizePullRequestConfig(config);
  const key = nodeKey(nodePath);

  if (!workspaceRoot) {
    return { blocked: true, status: 'blocked', summaryStatus: 'partial', reason: 'pull-request.workspace-missing', onFail: cfg.onFail, problems: cfg.problems, steps: [] };
  }
  if (cfg.problems.length) {
    if (cfg.onFail === 'block') {
      return { blocked: true, status: 'blocked', summaryStatus: 'partial', reason: 'pull-request.config-invalid', onFail: cfg.onFail, problems: cfg.problems, steps: [] };
    }
    return { valid: false, warned: true, onFail: cfg.onFail, problems: cfg.problems, steps: [] };
  }

  const context = { runId, nodeKey: key, workspaceRoot, runProcess, sleep, timeoutMs: cfg.timeoutMs };
  const steps = [];
  const branch = cfg.branch || `orpad/pr-${key}`;

  const finalizeBlocked = async (reason, detail, extra = {}) => {
    const evidence = await registerEvidence(runRoot, runId, nodePath, key, { branch, onFail: cfg.onFail, reason, detail, steps, ...extra });
    if (cfg.onFail === 'warn') {
      return { valid: false, warned: true, onFail: cfg.onFail, reason, detail, branch, steps, ...(evidence ? { evidenceArtifact: evidence } : {}), ...extra };
    }
    return { blocked: true, status: 'blocked', summaryStatus: 'partial', onFail: cfg.onFail, reason, detail, branch, steps, ...(evidence ? { evidenceArtifact: evidence } : {}), ...extra };
  };

  const repoCheck = await runStep(context, ['rev-parse', '--is-inside-work-tree']);
  steps.push(stepRecord('git-repo-check', 'git', ['rev-parse', '--is-inside-work-tree'], repoCheck));
  if (!(repoCheck.ok && repoCheck.stdout.trim() === 'true')) {
    return finalizeBlocked('pull-request.not-a-git-repo', 'workspace is not a git repository');
  }

  const status = await runStep(context, ['status', '--porcelain']);
  steps.push(stepRecord('git-status', 'git', ['status', '--porcelain'], status));
  if (!status.ok) {
    return finalizeBlocked('pull-request.git-status-failed', 'git status failed');
  }
  if (!status.stdout.trim()) {
    return finalizeBlocked('pull-request.no-changes', 'no uncommitted changes to open a pull request for');
  }

  const branchStep = await runStep(context, ['checkout', '-B', branch]);
  steps.push(stepRecord('git-branch', 'git', ['checkout', '-B', branch], branchStep));
  if (!branchStep.ok) {
    return finalizeBlocked('pull-request.branch-failed', `could not create branch ${branch}`);
  }

  const addArgs = cfg.commitPaths.length ? ['add', '--', ...cfg.commitPaths] : ['add', '-A'];
  const addStep = await runStep(context, addArgs);
  steps.push(stepRecord('git-add', 'git', addArgs, addStep));
  if (!addStep.ok) {
    return finalizeBlocked('pull-request.add-failed', 'git add failed');
  }

  const commitStep = await runStep(context, ['commit', '-m', cfg.commitMessage]);
  steps.push(stepRecord('git-commit', 'git', ['commit', '-m', cfg.commitMessage], commitStep));
  if (!commitStep.ok) {
    return finalizeBlocked('pull-request.commit-failed', 'git commit failed (check git identity / staged changes)');
  }

  if (cfg.push) {
    const pushStep = await runStep(context, ['push', '-u', cfg.remote, branch]);
    steps.push(stepRecord('git-push', 'git', ['push', '-u', cfg.remote, branch], pushStep));
    if (!pushStep.ok) {
      return finalizeBlocked('pull-request.push-failed', `git push to ${cfg.remote} failed`);
    }
  }

  const prArgs = ['pr', 'create', '--title', cfg.title, '--body', cfg.body, '--head', branch];
  if (cfg.base) prArgs.push('--base', cfg.base);
  if (cfg.draft) prArgs.push('--draft');
  const prStep = await runStep(context, prArgs, 'gh');
  steps.push(stepRecord('gh-pr-create', 'gh', ['pr', 'create', '--head', branch], prStep));
  if (!prStep.ok) {
    const reason = prStep.spawnErrorCode ? 'pull-request.gh-unavailable' : 'pull-request.pr-create-failed';
    return finalizeBlocked(reason, prStep.spawnErrorCode ? 'gh CLI is unavailable' : 'gh pr create failed');
  }
  const prUrl = firstUrlIn(prStep.stdout);

  let checks = null;
  if (cfg.requireChecks) {
    checks = await pollChecks(context, cfg, branch);
    steps.push({ name: 'gh-pr-checks', command: 'gh', args: ['pr', 'checks', branch], status: checks.status, ...checks });
    if (checks.status !== 'passed') {
      return finalizeBlocked(`pull-request.checks-${checks.status}`, `CI checks ${checks.status}`, { prUrl, checks });
    }
  }

  const summary = {
    valid: true,
    onFail: cfg.onFail,
    branch,
    prUrl,
    pushed: cfg.push,
    requireChecks: cfg.requireChecks,
    ...(checks ? { checks } : {}),
    steps,
  };
  const evidence = await registerEvidence(runRoot, runId, nodePath, key, summary);
  if (evidence) summary.evidenceArtifact = evidence;
  return summary;
}

module.exports = {
  executePullRequestSteps,
  normalizePullRequestConfig,
};
