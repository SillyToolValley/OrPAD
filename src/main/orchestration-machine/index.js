const contracts = require('./contracts');
const events = require('./events');
const artifacts = require('./artifacts');
const latestRunExporter = require('./exporters/latest-run-exporter');
const legacyJournalExporter = require('./exporters/legacy-journal-exporter');
const metadataStore = require('./metadata-store');
const pathResolver = require('./path-resolver');
const queueStore = require('./queue-store');
const runStore = require('./run-store');
const workItemNormalizer = require('./work-item-normalizer');

module.exports = {
  ...contracts,
  ...events,
  ...artifacts,
  ...latestRunExporter,
  ...legacyJournalExporter,
  ...metadataStore,
  ...pathResolver,
  ...queueStore,
  ...runStore,
  ...workItemNormalizer,
};
