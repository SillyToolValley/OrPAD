const contracts = require('./contracts');
const cliAgentAdapter = require('./adapters/cli-agent');
const proposalAdapter = require('./adapters/proposal-adapter');
const claims = require('./claims');
const dispatcher = require('./dispatcher');
const events = require('./events');
const artifacts = require('./artifacts');
const latestRunExporter = require('./exporters/latest-run-exporter');
const legacyJournalExporter = require('./exporters/legacy-journal-exporter');
const graphLoader = require('./graph-loader');
const ipc = require('./ipc');
const metadataStore = require('./metadata-store');
const nodeLifecycle = require('./node-lifecycle');
const pathResolver = require('./path-resolver');
const probeRunner = require('./probe-runner');
const queueStore = require('./queue-store');
const runStore = require('./run-store');
const triageRunner = require('./triage-runner');
const traversal = require('./traversal');
const workerLoop = require('./worker-loop');
const workItemNormalizer = require('./work-item-normalizer');
const writeSets = require('./write-sets');

module.exports = {
  ...contracts,
  ...cliAgentAdapter,
  ...proposalAdapter,
  ...claims,
  ...dispatcher,
  ...events,
  ...artifacts,
  ...latestRunExporter,
  ...legacyJournalExporter,
  ...graphLoader,
  ...ipc,
  ...metadataStore,
  ...nodeLifecycle,
  ...pathResolver,
  ...probeRunner,
  ...queueStore,
  ...runStore,
  ...triageRunner,
  ...traversal,
  ...workerLoop,
  ...workItemNormalizer,
  ...writeSets,
};
