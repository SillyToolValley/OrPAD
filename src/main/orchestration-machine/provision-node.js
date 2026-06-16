// orpad.provision — deterministic environment-acquisition support node.
//
// The planner can express "bring this external repo into the workspace"
// (it already authors provision-shaped work items), but regular workers
// execute inside a write-set-sliced overlay with no network and no view of
// the wider workspace, so environment acquisition can never succeed as a
// queue item. This node closes that gap: it runs BEFORE worker fan-out,
// machine-side (no LLM), directly against the canonical workspace, with a
// deliberately narrow step vocabulary instead of arbitrary commands:
//
//   { kind: 'git-clone', repo, targetDir, ref?, depth? }
//   { kind: 'install',   tool: 'npm'|'pnpm'|'yarn', dir, args? }
//
// Steps are idempotent (a satisfied step is skipped, so scheduler re-drives
// are safe) and every execution registers a provision evidence artifact.
// Failures produce a typed blocked outcome — never a silent pass.

const fs = require('fs');
const path = require('path');

const { registerJsonArtifact } = require('./adapters/cli-agent');
const { runMachineProcess } = require('./adapters/process-runner');

const fsp = fs.promises;

const PROVISION_STEP_KINDS = Object.freeze(['git-clone', 'install']);
const PROVISION_INSTALL_TOOLS = Object.freeze(['npm', 'pnpm', 'yarn']);
// Install args the planner may author. Lifecycle scripts stay quarantined
// (same posture as node-pack installs): --ignore-scripts is always enforced.
const PROVISION_INSTALL_ARG_ALLOWLIST = Object.freeze([
  'install',
  'ci',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--frozen-lockfile',
  '--prefer-offline',
]);
const PROVISION_REPO_PATTERN = /^(https:\/\/|git@|ssh:\/\/|file:\/\/)\S+$/i;
const DEFAULT_PROVISION_STEP_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PROVISION_STEP_TIMEOUT_MS = 30 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 2000;

function problemEntry(code, message, stepIndex = null) {
  return stepIndex === null ? { code, message } : { code, message, stepIndex };
}

// Structural-only check (no filesystem): relative, inside the workspace tree,
// and never under .orpad where run state lives.
function workspaceRelativeDirProblem(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'empty';
  const normalized = raw.replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) return 'absolute';
  const relative = path.relative('.', path.normalize(normalized)).replace(/\\/g, '/');
  if (!relative || relative === '.') return 'empty';
  if (relative.startsWith('..')) return 'outside-workspace';
  if (relative === '.orpad' || relative.startsWith('.orpad/')) return 'orpad-reserved';
  return '';
}

function normalizedWorkspaceRelativeDir(value) {
  return path.relative('.', path.normalize(String(value || '').trim().replace(/\\/g, '/'))).replace(/\\/g, '/');
}

function clampStepTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROVISION_STEP_TIMEOUT_MS;
  return Math.min(parsed, MAX_PROVISION_STEP_TIMEOUT_MS);
}

function normalizeProvisionConfig(config = {}) {
  const problems = [];
  const onFail = config.onFail === 'warn' ? 'warn' : 'block';
  const rawSteps = Array.isArray(config.steps) ? config.steps : [];
  if (!rawSteps.length) {
    problems.push(problemEntry('PROVISION_STEPS_REQUIRED', 'Provision node config.steps must be a non-empty array.'));
  }
  const steps = [];
  rawSteps.forEach((raw, index) => {
    const step = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const kind = String(step.kind || '').trim();
    if (!PROVISION_STEP_KINDS.includes(kind)) {
      problems.push(problemEntry(
        'PROVISION_STEP_KIND_UNSUPPORTED',
        `Provision step kind "${kind || '(missing)'}" is not supported. Supported kinds: ${PROVISION_STEP_KINDS.join(', ')}.`,
        index,
      ));
      return;
    }
    if (kind === 'git-clone') {
      const repo = String(step.repo || '').trim();
      const targetDirProblem = workspaceRelativeDirProblem(step.targetDir);
      if (!PROVISION_REPO_PATTERN.test(repo)) {
        problems.push(problemEntry(
          'PROVISION_CLONE_REPO_INVALID',
          'git-clone step requires a repo matching https://, git@, ssh://, or file://.',
          index,
        ));
      }
      if (targetDirProblem) {
        problems.push(problemEntry(
          'PROVISION_CLONE_TARGET_DIR_INVALID',
          `git-clone step targetDir is ${targetDirProblem}; it must be a relative path inside the workspace and outside .orpad.`,
          index,
        ));
      }
      if (!PROVISION_REPO_PATTERN.test(repo) || targetDirProblem) return;
      const depth = Number(step.depth);
      steps.push({
        index,
        kind,
        repo,
        targetDir: normalizedWorkspaceRelativeDir(step.targetDir),
        ref: String(step.ref || '').trim(),
        depth: Number.isInteger(depth) && depth > 0 ? depth : (step.full === true ? 0 : 1),
        timeoutMs: clampStepTimeoutMs(step.timeoutMs ?? config.timeoutMs),
      });
      return;
    }
    // kind === 'install'
    const tool = String(step.tool || '').trim();
    const dirProblem = workspaceRelativeDirProblem(step.dir);
    if (!PROVISION_INSTALL_TOOLS.includes(tool)) {
      problems.push(problemEntry(
        'PROVISION_INSTALL_TOOL_UNSUPPORTED',
        `install step tool "${tool || '(missing)'}" is not supported. Supported tools: ${PROVISION_INSTALL_TOOLS.join(', ')}.`,
        index,
      ));
    }
    if (dirProblem) {
      problems.push(problemEntry(
        'PROVISION_INSTALL_DIR_INVALID',
        `install step dir is ${dirProblem}; it must be a relative path inside the workspace and outside .orpad.`,
        index,
      ));
    }
    const rawArgs = Array.isArray(step.args) ? step.args.map(arg => String(arg)) : [];
    const rejectedArgs = rawArgs.filter(arg => !PROVISION_INSTALL_ARG_ALLOWLIST.includes(arg));
    if (rejectedArgs.length) {
      problems.push(problemEntry(
        'PROVISION_INSTALL_ARGS_UNSUPPORTED',
        `install step args outside the allowlist: ${rejectedArgs.join(', ')}.`,
        index,
      ));
    }
    if (!PROVISION_INSTALL_TOOLS.includes(tool) || dirProblem || rejectedArgs.length) return;
    const args = rawArgs.length ? [...rawArgs] : ['install'];
    if (!args.includes('--ignore-scripts')) args.push('--ignore-scripts');
    steps.push({
      index,
      kind,
      tool,
      dir: normalizedWorkspaceRelativeDir(step.dir),
      args,
      timeoutMs: clampStepTimeoutMs(step.timeoutMs ?? config.timeoutMs),
    });
  });
  return { steps, onFail, problems };
}

function pathEntries() {
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean);
}

function fileExistsSync(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function findOnPath(name) {
  for (const entry of pathEntries()) {
    const candidate = path.join(entry, name);
    if (fileExistsSync(candidate)) return candidate;
  }
  return '';
}

// npm/pnpm/yarn ship as .cmd shims on Windows; bare-name spawn only resolves
// .exe, so the shim must be resolved explicitly before falling back.
function resolveInstallToolCommand(tool) {
  if (process.platform !== 'win32') return tool;
  return findOnPath(`${tool}.cmd`) || findOnPath(`${tool}.exe`) || tool;
}

async function directoryHasEntries(dirPath) {
  try {
    const entries = await fsp.readdir(dirPath);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function directoryExists(dirPath) {
  try { return (await fsp.stat(dirPath)).isDirectory(); } catch { return false; }
}

async function fileExists(filePath) {
  try { return (await fsp.stat(filePath)).isFile(); } catch { return false; }
}

function outputTail(text) {
  return String(text || '').slice(-OUTPUT_TAIL_CHARS);
}

function stepBase(step) {
  return step.kind === 'git-clone'
    ? { index: step.index, kind: step.kind, repo: step.repo, targetDir: step.targetDir }
    : { index: step.index, kind: step.kind, tool: step.tool, dir: step.dir };
}

async function runProvisionProcess(step, spec, context) {
  let processResult;
  try {
    processResult = await runMachineProcess({
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      runId: context.runId,
      adapterCallId: `provision-${context.nodeKey}-step-${step.index}`,
      timeoutMs: step.timeoutMs,
      maxOutputBytes: 256 * 1024,
    });
  } catch (err) {
    return {
      ...stepBase(step),
      status: 'failed',
      command: spec.command,
      args: spec.args,
      spawnErrorCode: err?.code || '',
      detail: err?.message || 'provision step process failed to start',
    };
  }
  const failed = processResult.timedOut || processResult.code !== 0;
  return {
    ...stepBase(step),
    status: failed ? 'failed' : 'completed',
    command: spec.command,
    args: spec.args,
    exitCode: processResult.code,
    timedOut: Boolean(processResult.timedOut),
    spawnErrorCode: processResult.spawnError?.code || '',
    stderrTail: outputTail(processResult.stderr),
    stdoutTail: failed ? outputTail(processResult.stdout) : '',
    ...(failed ? { detail: processResult.timedOut ? 'provision step timed out' : `provision step exited with code ${processResult.code}` } : {}),
  };
}

async function executeGitCloneStep(workspaceRoot, step, context) {
  const targetAbsolute = path.resolve(workspaceRoot, step.targetDir);
  if (await directoryExists(path.join(targetAbsolute, '.git'))) {
    return { ...stepBase(step), status: 'skipped', skippedReason: 'already-cloned' };
  }
  if (await directoryHasEntries(targetAbsolute)) {
    // Never clobber user files: a non-empty, non-git target is a hard typed
    // failure rather than a forced re-clone.
    return {
      ...stepBase(step),
      status: 'failed',
      detail: `git-clone target "${step.targetDir}" exists, is not empty, and is not a git checkout.`,
      failureCode: 'PROVISION_CLONE_TARGET_OCCUPIED',
    };
  }
  const args = ['clone', '--single-branch'];
  if (step.depth > 0) args.push('--depth', String(step.depth));
  if (step.ref) args.push('--branch', step.ref);
  args.push(step.repo, step.targetDir);
  return runProvisionProcess(step, { command: 'git', args, cwd: workspaceRoot }, context);
}

async function executeInstallStep(workspaceRoot, step, context) {
  const dirAbsolute = path.resolve(workspaceRoot, step.dir);
  if (!(await directoryExists(dirAbsolute))) {
    return {
      ...stepBase(step),
      status: 'failed',
      detail: `install dir "${step.dir}" does not exist in the workspace; provision it (e.g. git-clone) first.`,
      failureCode: 'PROVISION_INSTALL_DIR_MISSING',
    };
  }
  // npm/pnpm/yarn all require a package.json. Running them in a directory
  // without one writes an empty package-lock.json side effect and resolves
  // nothing — a false green that pollutes a non-Node project (a planner that
  // authored `install: npm` for a Python repo like sprite-gen). Skip cleanly.
  if (!(await fileExists(path.join(dirAbsolute, 'package.json')))) {
    return { ...stepBase(step), status: 'skipped', skippedReason: 'no-package-json' };
  }
  if (await directoryExists(path.join(dirAbsolute, 'node_modules'))) {
    return { ...stepBase(step), status: 'skipped', skippedReason: 'dependencies-present' };
  }
  return runProvisionProcess(step, {
    command: resolveInstallToolCommand(step.tool),
    args: step.args,
    cwd: dirAbsolute,
  }, context);
}

function provisionNodeKey(nodePath) {
  return String(nodePath || 'provision').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'provision';
}

async function executeProvisionSteps(input = {}) {
  const {
    runRoot = '',
    runId = '',
    nodePath = '',
    workspaceRoot = '',
    config = {},
  } = input;
  const { steps, onFail, problems } = normalizeProvisionConfig(config);
  if (!workspaceRoot) {
    return {
      blocked: true,
      status: 'blocked',
      summaryStatus: 'partial',
      reason: 'provision.workspace-missing',
      onFail,
      problems,
      steps: [],
    };
  }
  if (problems.length) {
    // Malformed authored config is never silently repaired (no autofill):
    // block by default so the run surfaces the authoring defect.
    if (onFail === 'block') {
      return {
        blocked: true,
        status: 'blocked',
        summaryStatus: 'partial',
        reason: 'provision.config-invalid',
        onFail,
        problems,
        steps: [],
      };
    }
    return { valid: false, warned: true, onFail, problems, steps: [] };
  }

  const context = { runId, nodeKey: provisionNodeKey(nodePath) };
  const stepResults = [];
  let failedStep = null;
  for (const step of steps) {
    if (failedStep) {
      stepResults.push({ ...stepBase(step), status: 'skipped', skippedReason: 'previous-step-failed' });
      continue;
    }
    const result = step.kind === 'git-clone'
      ? await executeGitCloneStep(workspaceRoot, step, context)
      : await executeInstallStep(workspaceRoot, step, context);
    stepResults.push(result);
    if (result.status === 'failed') failedStep = result;
  }

  let evidenceArtifact = '';
  let evidenceError = '';
  try {
    const artifact = await registerJsonArtifact(runRoot, {
      runId,
      artifactPath: `artifacts/provision/${context.nodeKey}.json`,
      producedBy: 'orpad.provision',
      schemaVersion: 'orpad.provisionEvidence.v1',
      value: {
        schemaVersion: 'orpad.provisionEvidence.v1',
        nodePath,
        onFail,
        steps: stepResults,
      },
    });
    evidenceArtifact = artifact?.file?.path || '';
  } catch (err) {
    evidenceError = err?.message || 'provision evidence registration failed';
  }

  const summary = {
    valid: !failedStep,
    onFail,
    stepCount: steps.length,
    executedCount: stepResults.filter(step => step.status === 'completed').length,
    skippedCount: stepResults.filter(step => step.status === 'skipped').length,
    failedCount: stepResults.filter(step => step.status === 'failed').length,
    steps: stepResults,
    ...(evidenceArtifact ? { evidenceArtifact } : {}),
    ...(evidenceError ? { evidenceError } : {}),
  };
  if (failedStep && onFail === 'block') {
    return {
      ...summary,
      blocked: true,
      status: 'blocked',
      summaryStatus: 'partial',
      reason: 'provision.step-failed',
      failedStep: {
        index: failedStep.index,
        kind: failedStep.kind,
        detail: failedStep.detail || '',
        failureCode: failedStep.failureCode || '',
        exitCode: failedStep.exitCode,
      },
    };
  }
  if (failedStep) {
    return { ...summary, warned: true };
  }
  return summary;
}

module.exports = {
  PROVISION_INSTALL_ARG_ALLOWLIST,
  PROVISION_INSTALL_TOOLS,
  PROVISION_STEP_KINDS,
  executeProvisionSteps,
  normalizeProvisionConfig,
};
