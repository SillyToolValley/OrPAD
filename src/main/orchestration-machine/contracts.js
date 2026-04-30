const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const SCHEMA_VERSIONS = Object.freeze({
  machineEvent: 'orpad.machineEvent.v1',
  machineRun: 'orpad.machineRun.v1',
  workItem: 'orpad.workItem.v1',
  candidateProposal: 'orpad.candidateProposal.v1',
  artifactManifest: 'orpad.artifactManifest.v1',
  adapterRequest: 'orpad.adapterRequest.v1',
  adapterResult: 'orpad.workerResult.v1',
});

const CONTRACT_SCHEMA_FILES = Object.freeze({
  machineEvent: 'machine-event.schema.json',
  machineRun: 'machine-run.schema.json',
  workItem: 'work-item.schema.json',
  candidateProposal: 'candidate-proposal.schema.json',
  artifactManifest: 'artifact-manifest.schema.json',
  adapterRequest: 'adapter-request.schema.json',
  adapterResult: 'adapter-result.schema.json',
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

module.exports = {
  CONTRACT_SCHEMA_FILES,
  CONTRACT_SCHEMA_NAMES,
  SCHEMA_VERSIONS,
  createContractValidator,
  loadAllContractSchemas,
  loadContractSchema,
};
