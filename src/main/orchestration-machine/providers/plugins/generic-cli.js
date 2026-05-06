// Generic CLI provider plugin factory.
//
// PR M8: lets users register a custom CLI executable as a Machine provider
// without writing a brand-new plugin module. Registration is parameterized
// and *required* — a generic plugin without a commandAllowlist or
// outputContractParser is rejected so the Machine never spawns an unbounded
// command. The plugin still goes through the same M1 process-containment
// gate (overlay cwd, exact command grant, dangerousArgs metadata).

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertGenericCliConfig(config) {
  if (!isPlainObject(config)) {
    const err = new Error('Generic CLI plugin requires a configuration object.');
    err.code = 'GENERIC_CLI_CONFIG_REQUIRED';
    throw err;
  }
  if (typeof config.id !== 'string' || !config.id.trim()) {
    const err = new Error('Generic CLI plugin config.id must be a non-empty string.');
    err.code = 'GENERIC_CLI_CONFIG_INVALID_ID';
    throw err;
  }
  if (!Array.isArray(config.commandAllowlist) || config.commandAllowlist.length === 0) {
    const err = new Error('Generic CLI plugin config.commandAllowlist must be a non-empty array.');
    err.code = 'GENERIC_CLI_CONFIG_ALLOWLIST_REQUIRED';
    throw err;
  }
  for (const entry of config.commandAllowlist) {
    if (!isPlainObject(entry) || typeof entry.command !== 'string' || !entry.command.trim()) {
      const err = new Error('Generic CLI plugin commandAllowlist entries must include a non-empty `command` string.');
      err.code = 'GENERIC_CLI_CONFIG_ALLOWLIST_ENTRY_INVALID';
      throw err;
    }
  }
  if (typeof config.outputContractParser !== 'function') {
    const err = new Error('Generic CLI plugin config.outputContractParser must be a function.');
    err.code = 'GENERIC_CLI_CONFIG_PARSER_REQUIRED';
    throw err;
  }
}

function findAllowlistEntry(allowlist, command) {
  return allowlist.find(entry => entry.command === command) || null;
}

function commandAllowed(allowlist, commandSpec) {
  const command = String(commandSpec?.command || '');
  const entry = findAllowlistEntry(allowlist, command);
  if (!entry) return { ok: false, reason: 'command-not-allowlisted', command };
  // Optional argument prefix check
  if (Array.isArray(entry.argsPrefix) && entry.argsPrefix.length) {
    const args = Array.isArray(commandSpec?.args) ? commandSpec.args : [];
    for (let i = 0; i < entry.argsPrefix.length; i += 1) {
      if (args[i] !== entry.argsPrefix[i]) {
        return { ok: false, reason: 'args-prefix-mismatch', expected: entry.argsPrefix, observed: args.slice(0, entry.argsPrefix.length) };
      }
    }
  }
  return { ok: true, entry };
}

function createGenericCliPlugin(config) {
  assertGenericCliConfig(config);
  const id = String(config.id).trim();
  const displayName = config.displayName || id;
  const dangerousArgs = Array.isArray(config.dangerousArgs)
    ? Object.freeze(config.dangerousArgs.map(arg => String(arg)))
    : Object.freeze([]);
  const commandAllowlist = Object.freeze(config.commandAllowlist.map(entry => Object.freeze({ ...entry })));
  const outputContractParser = config.outputContractParser;
  const needsKey = Boolean(config.needsKey);
  const family = 'cli';
  const buildPrompt = typeof config.buildPrompt === 'function' ? config.buildPrompt : (input => String(input.prompt || ''));

  return {
    id,
    displayName,
    family,
    needsKey,
    capabilities: Object.freeze({
      sessionStrategies: ['none'],
      toolPolicies: ['none'],
      streaming: false,
      structuredOutput: 'free-text',
      sandbox: 'workspace-write',
    }),
    models: Array.isArray(config.models) ? Object.freeze([...config.models]) : Object.freeze([]),
    defaultModel: config.defaultModel || id,
    dangerousArgs,
    commandAllowlist,
    outputContractParser,
    assertCommandAllowed(commandSpec) {
      const decision = commandAllowed(commandAllowlist, commandSpec);
      if (!decision.ok) {
        const err = new Error(`Generic CLI plugin "${id}" rejected command: ${decision.reason}`);
        err.code = 'GENERIC_CLI_COMMAND_NOT_ALLOWED';
        err.classification = 'FATAL';
        err.details = decision;
        throw err;
      }
      return decision.entry;
    },
    buildWorkerCommandSpec(input = {}) {
      const adapter = input.adapter || {};
      const requested = adapter.commandSpec || input.commandSpec;
      if (!isPlainObject(requested)) {
        const err = new Error(`Generic CLI plugin "${id}" requires adapter.commandSpec to choose an allowlisted command.`);
        err.code = 'GENERIC_CLI_COMMAND_SPEC_REQUIRED';
        err.classification = 'FATAL';
        throw err;
      }
      this.assertCommandAllowed(requested);
      const prompt = buildPrompt(input);
      const argsBase = Array.isArray(requested.args) ? requested.args.slice() : [];
      const args = prompt ? [...argsBase, prompt] : argsBase;
      return {
        command: requested.command,
        args,
        cwd: input.overlayRoot || requested.cwd || '',
      };
    },
    parseOutputContract(rawOutput, context) {
      return outputContractParser(rawOutput, context);
    },
  };
}

module.exports = {
  assertGenericCliConfig,
  commandAllowed,
  createGenericCliPlugin,
  findAllowlistEntry,
};
