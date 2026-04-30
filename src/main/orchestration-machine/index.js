const contracts = require('./contracts');
const events = require('./events');
const metadataStore = require('./metadata-store');
const pathResolver = require('./path-resolver');
const queueStore = require('./queue-store');
const runStore = require('./run-store');
const workItemNormalizer = require('./work-item-normalizer');

module.exports = {
  ...contracts,
  ...events,
  ...metadataStore,
  ...pathResolver,
  ...queueStore,
  ...runStore,
  ...workItemNormalizer,
};
