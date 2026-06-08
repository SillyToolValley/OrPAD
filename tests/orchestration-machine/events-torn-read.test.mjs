import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { readMachineEvents, eventsPath } = require('../../src/main/orchestration-machine');

async function makeRunRoot() {
  // A basename NOT starting with 'run_' so event runId checks are not required here.
  return fs.mkdtemp(path.join(os.tmpdir(), 'orpad-events-torn-'));
}

function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

test('readMachineEvents tolerates a torn (partial) trailing line from a concurrent append', async () => {
  const runRoot = await makeRunRoot();
  const filePath = eventsPath(runRoot);
  // Two complete records, then a half-written final record (no newline, invalid JSON) —
  // exactly the shape a reader can observe mid-append (appends are serialized and only
  // ever add a complete "<json>\n" at EOF, so only the LAST line can be torn).
  await fs.writeFile(
    filePath,
    line({ sequence: 0, eventType: 'run.created', runId: 'r' })
      + line({ sequence: 1, eventType: 'run.status', runId: 'r' })
      + '{"sequence":2,"eventType":"node.st',
    'utf8',
  );
  const events = await readMachineEvents(runRoot);
  assert.equal(events.length, 2, 'the partial trailing line is skipped, complete records are returned');
  assert.deepEqual(events.map(e => e.sequence), [0, 1]);
});

test('readMachineEvents surfaces (throws on) corruption of an INTERIOR line', async () => {
  const runRoot = await makeRunRoot();
  const filePath = eventsPath(runRoot);
  // A corrupt line that is NOT the last line cannot be a torn read (appends only
  // touch EOF) — it is genuine corruption and must not be silently dropped.
  await fs.writeFile(
    filePath,
    line({ sequence: 0, eventType: 'run.created', runId: 'r' })
      + '{"sequence":1,"eventType":CORRUPT}\n'
      + line({ sequence: 2, eventType: 'run.status', runId: 'r' }),
    'utf8',
  );
  await assert.rejects(() => readMachineEvents(runRoot), /JSON|Unexpected|token/i,
    'interior corruption is surfaced, not masked');
});

test('readMachineEvents returns all records for a well-formed log and [] for a missing one', async () => {
  const runRoot = await makeRunRoot();
  assert.deepEqual(await readMachineEvents(runRoot), [], 'missing log reads as empty');
  const filePath = eventsPath(runRoot);
  await fs.writeFile(
    filePath,
    line({ sequence: 0, eventType: 'run.created', runId: 'r' })
      + line({ sequence: 1, eventType: 'run.status', runId: 'r' })
      + line({ sequence: 2, eventType: 'run.summary', runId: 'r' }),
    'utf8',
  );
  const events = await readMachineEvents(runRoot);
  assert.deepEqual(events.map(e => e.sequence), [0, 1, 2], 'a complete log round-trips fully');
});
