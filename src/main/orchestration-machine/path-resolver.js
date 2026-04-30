const path = require('path');

const LEGACY_LATEST_RUN_PREFIX = 'harness/generated/latest-run';

function toPortablePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/');
}

function trimLeadingSlash(value) {
  return String(value || '').replace(/^\/+/, '');
}

function isLegacyLatestRunRef(ref) {
  const normalized = trimLeadingSlash(toPortablePath(ref));
  return normalized === LEGACY_LATEST_RUN_PREFIX || normalized.startsWith(`${LEGACY_LATEST_RUN_PREFIX}/`);
}

function legacyLatestRunSuffix(ref) {
  if (!isLegacyLatestRunRef(ref)) return '';
  const normalized = trimLeadingSlash(toPortablePath(ref));
  return trimLeadingSlash(normalized.slice(LEGACY_LATEST_RUN_PREFIX.length));
}

function durableRunRoot(pipelineDir, runId) {
  if (!pipelineDir) throw new Error('pipelineDir is required.');
  if (!runId) throw new Error('runId is required.');
  return path.join(path.resolve(pipelineDir), 'runs', String(runId));
}

function latestRunExportRoot(pipelineDir) {
  if (!pipelineDir) throw new Error('pipelineDir is required.');
  return path.join(path.resolve(pipelineDir), 'harness', 'generated', 'latest-run');
}

function resolveRunRef({ pipelineDir, runRoot, ref }) {
  if (!pipelineDir) throw new Error('pipelineDir is required.');
  if (!runRoot) throw new Error('runRoot is required.');
  if (!ref) throw new Error('ref is required.');

  const rawRef = String(ref);
  if (path.isAbsolute(rawRef)) {
    return {
      inputRef: rawRef,
      kind: 'absolute',
      resolvedPath: path.resolve(rawRef),
      runRelativePath: '',
    };
  }

  if (isLegacyLatestRunRef(rawRef)) {
    const suffix = legacyLatestRunSuffix(rawRef);
    return {
      inputRef: rawRef,
      kind: 'legacy-latest-run-alias',
      resolvedPath: suffix ? path.join(path.resolve(runRoot), ...suffix.split('/')) : path.resolve(runRoot),
      runRelativePath: suffix,
    };
  }

  return {
    inputRef: rawRef,
    kind: 'pipeline-relative',
    resolvedPath: path.resolve(pipelineDir, rawRef),
    runRelativePath: '',
  };
}

function resolvePipelineContext({ workspaceRoot, pipelinePath }) {
  if (!workspaceRoot) throw new Error('workspaceRoot is required.');
  if (!pipelinePath) throw new Error('pipelinePath is required.');
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedPipelinePath = path.resolve(resolvedWorkspaceRoot, pipelinePath);
  return {
    workspaceRoot: resolvedWorkspaceRoot,
    pipelinePath: resolvedPipelinePath,
    pipelineDir: path.dirname(resolvedPipelinePath),
  };
}

module.exports = {
  LEGACY_LATEST_RUN_PREFIX,
  durableRunRoot,
  isLegacyLatestRunRef,
  latestRunExportRoot,
  legacyLatestRunSuffix,
  resolvePipelineContext,
  resolveRunRef,
  toPortablePath,
};
