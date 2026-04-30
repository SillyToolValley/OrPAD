const contracts = require('./contracts');
const events = require('./events');
const artifacts = require('./artifacts');
const latestRunExporter = require('./exporters/latest-run-exporter');
const legacyJournalExporter = require('./exporters/legacy-journal-exporter');
const graphLoader = require('./graph-loader');
const metadataStore = require('./metadata-store');
const nodeLifecycle = require('./node-lifecycle');
const pathResolver = require('./path-resolver');
const queueStore = require('./queue-store');
const runStore = require('./run-store');
const traversal = require('./traversal');
const workItemNormalizer = require('./work-item-normalizer');

module.exports = {
  ...contracts,
  ...events,
  ...artifacts,
  ...latestRunExporter,
  ...legacyJournalExporter,
  ...graphLoader,
  ...metadataStore,
  ...nodeLifecycle,
  ...pathResolver,
  ...queueStore,
  ...runStore,
  ...traversal,
  ...workItemNormalizer,
};
