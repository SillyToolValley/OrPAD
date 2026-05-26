const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const SCHEMA_VERSIONS = Object.freeze({
  machineEvent: 'orpad.machineEvent.v1',
  machineRun: 'orpad.machineRun.v1',
  workItem: 'orpad.workItem.v1',
  candidateProposal: 'orpad.candidateProposal.v1',
  candidateInventory: 'orpad.machineCandidateInventory.v1',
  artifactManifest: 'orpad.artifactManifest.v1',
  adapterRequest: 'orpad.adapterRequest.v1',
  adapterResult: 'orpad.workerResult.v1',
  machineAdapter: 'orpad.machineAdapter.v2',
  contentEditorialEvaluation: 'orpad.contentEditorialEvaluation.v1',
  nodePackRegistry: 'orpad.nodePackRegistry.v1',
});

const CONTRACT_SCHEMA_FILES = Object.freeze({
  machineEvent: 'machine-event.schema.json',
  machineRun: 'machine-run.schema.json',
  workItem: 'work-item.schema.json',
  candidateProposal: 'candidate-proposal.schema.json',
  candidateInventory: 'candidate-inventory.schema.json',
  artifactManifest: 'artifact-manifest.schema.json',
  adapterRequest: 'adapter-request.schema.json',
  adapterResult: 'adapter-result.schema.json',
  machineAdapter: 'machine-adapter.schema.json',
  contentEditorialEvaluation: 'content-editorial-evaluation.schema.json',
  nodePackRegistry: 'node-pack-registry.schema.json',
});

const CONTRACT_SCHEMA_NAMES = Object.freeze(Object.keys(CONTRACT_SCHEMA_FILES));
const CONTRACTS_DIR = path.join(__dirname, 'contracts');

function loadContractSchema(name) {
  const fileName = CONTRACT_SCHEMA_FILES[name];
  if (!fileName) throw new Error(`Unknown Orchestration Machine contract schema: ${name}`);
  return JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, fileName), 'utf8'));
}

function loadAllContractSchemas() {
  return Object.fromEntries(CONTRACT_SCHEMA_NAMES.map(name => [name, loadContractSchema(name)]));
}

function createContractValidator() {
  const schemas = loadAllContractSchemas();
  const ajv = new Ajv({ allErrors: true, jsonPointers: true });
  for (const [name, schema] of Object.entries(schemas)) {
    ajv.addSchema(schema, name);
  }

  function validate(name, value) {
    const validator = ajv.getSchema(name);
    if (!validator) throw new Error(`Unknown Orchestration Machine contract schema: ${name}`);
    const ok = validator(value);
    return {
      ok,
      errors: ok ? [] : (validator.errors || []),
    };
  }

  function assertValid(name, value) {
    const result = validate(name, value);
    if (!result.ok) {
      const err = new Error(`Invalid Orchestration Machine ${name} contract.`);
      err.errors = result.errors;
      throw err;
    }
    return value;
  }

  return {
    ajv,
    schemas,
    validate,
    assertValid,
  };
}

const MACHINE_ADAPTER_V2_RESERVED_KEYS = new Set([
  'schemaVersion',
  'enabled',
  'default',
  'fallback',
  'budget',
  'cache',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function liftMachineAdapterV1ToV2(adapter) {
  if (!isPlainObject(adapter)) return adapter;
  if (adapter.schemaVersion === SCHEMA_VERSIONS.machineAdapter) return adapter;

  const type = typeof adapter.type === 'string' ? adapter.type.trim() : '';
  const isCodexCli = type === 'codex-cli';
  const family = isPlainObject(adapter.default) && adapter.default.family
    ? adapter.default.family
    : (isCodexCli ? 'cli' : (adapter.family || 'cli'));
  const providerId = adapter.providerId || (type || 'codex-cli');
  const model = adapter.model || (isCodexCli ? 'codex' : 'default');
  const sandbox = (adapter.workerSandbox || adapter.sandbox || null);
  const approvalPolicy = adapter.approvalPolicy || 'never';
  const timeoutMs = Number.isFinite(adapter.workerTimeoutMs)
    ? adapter.workerTimeoutMs
    : (Number.isFinite(adapter.proposalTimeoutMs) ? adapter.proposalTimeoutMs : 600000);
  const ephemeral = adapter.ephemeral !== false;

  const legacy = {};
  for (const [key, value] of Object.entries(adapter)) {
    if (!MACHINE_ADAPTER_V2_RESERVED_KEYS.has(key)) legacy[key] = value;
  }

  return {
    schemaVersion: SCHEMA_VERSIONS.machineAdapter,
    enabled: adapter.enabled !== false,
    default: {
      family,
      providerId,
      model,
      qualityTier: 'standard',
      sessionStrategy: 'none',
      toolPolicy: 'none',
      sandbox,
      approvalPolicy,
      timeoutMs,
      ephemeral,
      legacy,
    },
  };
}

module.exports = {
  CONTRACT_SCHEMA_FILES,
  CONTRACT_SCHEMA_NAMES,
  SCHEMA_VERSIONS,
  createContractValidator,
  liftMachineAdapterV1ToV2,
  loadAllContractSchemas,
  loadContractSchema,
};
