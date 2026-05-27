const path = require('path');

const { readMachineEvents } = require('../events');
const { atomicWriteFile, ensureDir } = require('../metadata-store');
const { legacyJournalRecordsFromEvents } = require('../queue-store');

async function exportLegacyJournal(runRoot, targetQueueRoot) {
  const events = await readMachineEvents(runRoot);
  const records = legacyJournalRecordsFromEvents(events);
  await ensureDir(targetQueueRoot);
  await atomicWriteFile(
    path.join(targetQueueRoot, 'journal.jsonl'),
    records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''),
  );
  return records;
}

module.exports = {
  exportLegacyJournal,
  legacyJournalRecordsFromEvents,
};
