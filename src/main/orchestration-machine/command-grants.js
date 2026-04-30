const path = require('path');

const SHELL_TOKENS = new Set(['&&', '||', ';', '|', '>', '>>', '<', '&']);

function normalizeArgs(args = []) {
  if (!Array.isArray(args)) throw new Error('Command args must be an array.');
  return args.map(arg => String(arg));
}

function normalizeCommandSpec(input = {}) {
  const command = String(input.command || '').trim();
  if (!command) throw new Error('Command is required.');
  if (SHELL_TOKENS.has(command)) {
    throw new Error('Shell operators are not valid commands. Use an exact command plus args array.');
  }
  const args = normalizeArgs(input.args || []);
  const operator = args.find(arg => SHELL_TOKENS.has(arg));
  if (operator) {
    throw new Error(`Shell operator "${operator}" is not allowed in Machine command args.`);
  }
  return {
    command,
    args,
    cwd: input.cwd ? path.resolve(String(input.cwd)) : '',
  };
}

function commandSpecsEqual(left, right) {
  const a = normalizeCommandSpec(left);
  const b = normalizeCommandSpec(right);
  return a.command === b.command
    && a.cwd === b.cwd
    && a.args.length === b.args.length
    && a.args.every((arg, index) => arg === b.args[index]);
}

function createCommandGrant(input = {}) {
  const spec = normalizeCommandSpec(input);
  return {
    schemaVersion: 'orpad.commandGrant.v1',
    grantId: input.grantId || `grant:${spec.command}:${spec.args.join(' ')}`,
    scope: input.scope || 'verification',
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    approvalId: input.approvalId || '',
    allowDangerousSandboxBypass: input.allowDangerousSandboxBypass === true,
    createdAt: input.createdAt || new Date().toISOString(),
    expiresAt: input.expiresAt || '',
    reason: input.reason || 'explicit-command-grant',
  };
}

function isGrantExpired(grant, now = new Date()) {
  if (!grant?.expiresAt) return false;
  return Date.parse(grant.expiresAt) <= Date.parse(now instanceof Date ? now.toISOString() : String(now));
}

function findMatchingCommandGrant(grants = [], commandSpec = {}, options = {}) {
  const now = options.now || new Date();
  return (grants || []).find(grant => {
    if (!grant || isGrantExpired(grant, now)) return false;
    return commandSpecsEqual(grant, commandSpec);
  }) || null;
}

function assertCommandGranted(grants = [], commandSpec = {}, options = {}) {
  const grant = findMatchingCommandGrant(grants, commandSpec, options);
  if (grant) return grant;
  const err = new Error('Machine command is not covered by an exact command grant.');
  err.code = 'MACHINE_COMMAND_NOT_GRANTED';
  throw err;
}

module.exports = {
  assertCommandGranted,
  commandSpecsEqual,
  createCommandGrant,
  findMatchingCommandGrant,
  isGrantExpired,
  normalizeArgs,
  normalizeCommandSpec,
};
