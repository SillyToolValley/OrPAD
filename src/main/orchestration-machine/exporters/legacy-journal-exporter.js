const path = require('path');

const { readMachineEvents } = require('../events');
const { atomicWriteFile, ensureDir } = require('../metadata-store');
const { legacyJournalFromEvent } = require('../queue-store');

function legacyJournalRecordsFromEvents(events) {
  return events
    .filter(event => event.eventType === 'queue.transition')
    .map(legacyJournalFromEvent);
}

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
