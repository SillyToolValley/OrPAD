const path = require('path');

const DANGEROUS_CODEX_BYPASS_ARG = '--dangerously-bypass-approvals-and-sandbox';

function normalizeResolved(filePath) {
  return path.resolve(String(filePath || ''));
}

function comparablePath(filePath) {
  const resolved = normalizeResolved(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameResolvedPath(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function isInsideResolvedPath(parent, child) {
  const parentPath = comparablePath(parent);
  const childPath = comparablePath(child);
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function commandUsesDangerousArg(commandSpec = {}, dangerousArgs = []) {
  const list = Array.isArray(dangerousArgs) && dangerousArgs.length
    ? dangerousArgs
    : [DANGEROUS_CODEX_BYPASS_ARG];
  return (commandSpec.args || []).some(arg => list.includes(String(arg)));
}

function commandUsesDangerousCodexBypass(commandSpec = {}) {
  return commandUsesDangerousArg(commandSpec, [DANGEROUS_CODEX_BYPASS_ARG]);
}

function hasAbsolutePathReference(value, targetRoot) {
  const text = String(value || '');
  if (!text || !targetRoot) return false;
  const normalizedText = process.platform === 'win32' ? text.toLowerCase() : text;
  const normalizedRoot = comparablePath(targetRoot);
  return normalizedText.includes(normalizedRoot);
}

function commandArgsReferenceRoot(commandSpec = {}, targetRoot = '') {
  if (!targetRoot) return false;
  return (commandSpec.args || []).some(arg => hasAbsolutePathReference(arg, targetRoot));
}

function dangerousBypassApproval(request = {}) {
  const approval = request.dangerousSandboxBypassApproval || {};
  return approval.approved === true && typeof approval.reason === 'string' && approval.reason.trim();
}

function assertCliProcessContainment(input = {}) {
  const {
    commandSpec = {},
    grant = {},
    overlayRoot = '',
    workspaceRoot = '',
    request = {},
    allowDangerousSandboxBypass = false,
    dangerousArgs,
  } = input;
  if (!overlayRoot) throw new Error('CLI process containment requires an overlay root.');
  if (!sameResolvedPath(commandSpec.cwd, overlayRoot)) {
    const err = new Error('CLI adapter command cwd must be the Machine overlay root.');
    err.code = 'MACHINE_PROCESS_CWD_OUTSIDE_OVERLAY';
    throw err;
  }
  if (workspaceRoot && commandArgsReferenceRoot(commandSpec, workspaceRoot)) {
    const err = new Error('CLI adapter command args must not reference the canonical workspace root.');
    err.code = 'MACHINE_PROCESS_CANONICAL_PATH_ARG';
    throw err;
  }

  const dangerousBypass = commandUsesDangerousArg(commandSpec, dangerousArgs);
  if (dangerousBypass) {
    if (!allowDangerousSandboxBypass || grant.allowDangerousSandboxBypass !== true || !dangerousBypassApproval(request)) {
      const err = new Error('CLI dangerous sandbox bypass requires explicit Machine approval and a matching exact command grant.');
      err.code = 'MACHINE_DANGEROUS_SANDBOX_BYPASS_NOT_APPROVED';
      throw err;
    }
    if (workspaceRoot && isInsideResolvedPath(workspaceRoot, overlayRoot)) {
      const err = new Error('CLI dangerous sandbox bypass must run from a system temp overlay outside the canonical workspace.');
      err.code = 'MACHINE_DANGEROUS_SANDBOX_BYPASS_OVERLAY_NOT_ISOLATED';
      throw err;
    }
  }

  return {
    schemaVersion: 'orpad.processContainment.v1',
    cwdKind: 'overlay',
    overlayRoot: normalizeResolved(overlayRoot),
    dangerousSandboxBypass: dangerousBypass,
    dangerousSandboxBypassApproved: dangerousBypass
      ? Boolean(allowDangerousSandboxBypass && grant.allowDangerousSandboxBypass === true && dangerousBypassApproval(request))
      : false,
    canonicalWorkspacePathArgsBlocked: Boolean(workspaceRoot),
  };
}

module.exports = {
  DANGEROUS_CODEX_BYPASS_ARG,
  assertCliProcessContainment,
  commandArgsReferenceRoot,
  commandUsesDangerousArg,
  commandUsesDangerousCodexBypass,
  sameResolvedPath,
};
