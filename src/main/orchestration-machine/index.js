const contracts = require('./contracts');
const apiAgentAdapter = require('./adapters/api-agent');
const approvals = require('./approvals');
const cliAgentAdapter = require('./adapters/cli-agent');
const commandGrants = require('./command-grants');
const proposalAdapter = require('./adapters/proposal-adapter');
const claims = require('./claims');
const dispatcher = require('./dispatcher');
const events = require('./events');
const artifacts = require('./artifacts');
const latestRunExporter = require('./exporters/latest-run-exporter');
const legacyJournalExporter = require('./exporters/legacy-journal-exporter');
const graphLoader = require('./graph-loader');
const ipc = require('./ipc');
const lifecycle = require('./lifecycle');
const metadataStore = require('./metadata-store');
const nodeLifecycle = require('./node-lifecycle');
const nodePacks = require('./node-packs');
const patches = require('./patches');
const pathResolver = require('./path-resolver');
const processRunner = require('./adapters/process-runner');
const probeRunner = require('./probe-runner');
const providerPolicy = require('./providers/policy');
const queueStore = require('./queue-store');
const runStore = require('./run-store');
const triageRunner = require('./triage-runner');
const traversal = require('./traversal');
const workerLoop = require('./worker-loop');
const workItemNormalizer = require('./work-item-normalizer');
const writeSets = require('./write-sets');

module.exports = {
  ...contracts,
  ...apiAgentAdapter,
  ...approvals,
  ...cliAgentAdapter,
  ...commandGrants,
  ...proposalAdapter,
  ...claims,
  ...dispatcher,
  ...events,
  ...artifacts,
  ...latestRunExporter,
  ...legacyJournalExporter,
  ...graphLoader,
  ...ipc,
  ...lifecycle,
  ...metadataStore,
  ...nodeLifecycle,
  ...nodePacks,
  ...patches,
  ...pathResolver,
  ...processRunner,
  ...probeRunner,
  ...providerPolicy,
  ...queueStore,
  ...runStore,
  ...triageRunner,
  ...traversal,
  ...workerLoop,
  ...workItemNormalizer,
  ...writeSets,
};
