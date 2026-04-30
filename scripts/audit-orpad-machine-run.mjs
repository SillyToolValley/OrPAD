import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  artifactManifestPath,
  fileDigest,
  legacyJournalRecordsFromEvents,
  projectQueueStateFromEvents,
  projectRunStateFromEvents,
  readMachineEvents,
  readQueueItems,
  readRunState,
} = require('../src/main/orchestration-machine');

function usage() {
  return 'Usage: node scripts/audit-orpad-machine-run.mjs <runRoot> [latestRunExportRoot]';
}

function diagnostic(code, message, details = {}) {
  return { code, message, ...details };
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function readJsonlIfExists(filePath) {
  try {
    const source = await fs.readFile(filePath, 'utf8');
    return source.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

function auditEventSequence(events) {
  const diagnostics = [];
  if (!events.length) {
    diagnostics.push(diagnostic('MACHINE_EVENTS_MISSING', 'Machine run must include events.jsonl with at least run.created.'));
    return diagnostics;
  }
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].sequence !== index) {
      diagnostics.push(diagnostic('MACHINE_EVENT_SEQUENCE_GAP', 'Machine event sequence must be contiguous and zero-based.', {
        index,
        actual: events[index].sequence,
      }));
    }
  }
  if (events[0]?.eventType !== 'run.created') {
    diagnostics.push(diagnostic('MACHINE_RUN_CREATED_EVENT_MISSING', 'First Machine event must be run.created.', {
      firstEventType: events[0]?.eventType,
    }));
  }
  return diagnostics;
}

function auditRunState(runState, projectedRunState) {
  const diagnostics = [];
  if (!runState) {
    diagnostics.push(diagnostic('MACHINE_RUN_STATE_MISSING', 'run-state.json is missing.'));
    return diagnostics;
  }
  for (const field of ['runId', 'lifecycleStatus', 'summaryStatus', 'eventSequence']) {
    if (runState[field] !== projectedRunState?.[field]) {
      diagnostics.push(diagnostic('MACHINE_RUN_STATE_PROJECTION_MISMATCH', 'run-state.json must match event replay projection.', {
        field,
        expected: projectedRunState?.[field],
        actual: runState[field],
      }));
    }
  }
  return diagnostics;
}

async function auditArtifactManifest(runRoot) {
  const diagnostics = [];
  const manifestPath = artifactManifestPath(runRoot);
  const manifest = await readJsonIfExists(manifestPath, null);
  if (!manifest) return { manifest: null, diagnostics };

  for (const file of manifest.files || []) {
    const filePath = path.join(runRoot, ...String(file.path || '').replace(/\\/g, '/').split('/'));
    try {
      const digest = await fileDigest(filePath);
      if (digest.sha256 !== file.sha256) {
        diagnostics.push(diagnostic('MACHINE_ARTIFACT_HASH_MISMATCH', 'Artifact manifest sha256 must match current file.', {
          path: file.path,
          expected: file.sha256,
          actual: digest.sha256,
        }));
      }
      if (digest.size !== file.size) {
        diagnostics.push(diagnostic('MACHINE_ARTIFACT_SIZE_MISMATCH', 'Artifact manifest size must match current file.', {
          path: file.path,
          expected: file.size,
          actual: digest.size,
        }));
      }
    } catch (err) {
      diagnostics.push(diagnostic('MACHINE_ARTIFACT_FILE_MISSING', 'Artifact manifest file is missing or unreadable.', {
        path: file.path,
        error: err.message,
      }));
    }
    if (!file.producedBy || !file.registeredBy) {
      diagnostics.push(diagnostic('MACHINE_ARTIFACT_PROVENANCE_MISSING', 'Artifact manifest files must include producedBy and registeredBy.', {
        path: file.path,
      }));
    }
  }
  return { manifest, diagnostics };
}

async function auditQueueProjection(runRoot, events) {
  const diagnostics = [];
  const projected = projectQueueStateFromEvents(events);
  const queueItems = await readQueueItems(runRoot);
  const itemsById = new Map(queueItems.map(entry => [entry.item.id, entry]));
  for (const [itemId, state] of projected.entries()) {
    const entry = itemsById.get(itemId);
    if (!entry) {
      diagnostics.push(diagnostic('MACHINE_QUEUE_PROJECTED_ITEM_MISSING', 'Projected queue item must have a derived state file.', {
        itemId,
        state,
      }));
    } else if (entry.state !== state || entry.item.state !== state) {
      diagnostics.push(diagnostic('MACHINE_QUEUE_STATE_MISMATCH', 'Derived queue state must match Machine event projection.', {
        itemId,
        expected: state,
        actualDirectoryState: entry.state,
        actualItemState: entry.item.state,
      }));
    }
  }
  return { projectedCount: projected.size, diagnostics };
}

async function auditLegacyJournal(runRoot, events) {
  const diagnostics = [];
  const expected = legacyJournalRecordsFromEvents(events);
  if (!expected.length) return { journalCount: 0, diagnostics };
  const journalPath = path.join(runRoot, 'queue', 'journal.jsonl');
  const actual = await readJsonlIfExists(journalPath);
  if (actual.length !== expected.length) {
    diagnostics.push(diagnostic('MACHINE_LEGACY_JOURNAL_COUNT_MISMATCH', 'Legacy journal projection must match queue.transition event count.', {
      expected: expected.length,
      actual: actual.length,
      path: journalPath,
    }));
  }
  for (let index = 0; index < Math.min(actual.length, expected.length); index += 1) {
    for (const field of ['action', 'itemId', 'fromState', 'toState']) {
      if (actual[index][field] !== expected[index][field]) {
        diagnostics.push(diagnostic('MACHINE_LEGACY_JOURNAL_EVENT_MISMATCH', 'Legacy journal record must match Machine event projection.', {
          index,
          field,
          expected: expected[index][field],
          actual: actual[index][field],
        }));
      }
    }
  }
  return { journalCount: actual.length, diagnostics };
}

async function auditLatestRunExport(runRoot, latestRunExportRoot, events) {
  const diagnostics = [];
  if (!latestRunExportRoot) return { exportMetadata: null, diagnostics };
  const metadataPath = path.join(latestRunExportRoot, 'run-metadata.json');
  const metadata = await readJsonIfExists(metadataPath, null);
  if (!metadata) {
    diagnostics.push(diagnostic('MACHINE_LATEST_RUN_EXPORT_METADATA_MISSING', 'Latest-run export metadata is missing.', {
      path: metadataPath,
    }));
    return { exportMetadata: null, diagnostics };
  }
  const expectedSequence = events.length ? events[events.length - 1].sequence : 0;
  if (path.resolve(metadata.sourceRunRoot || '') !== path.resolve(runRoot)) {
    diagnostics.push(diagnostic('MACHINE_LATEST_RUN_EXPORT_SOURCE_MISMATCH', 'Latest-run export sourceRunRoot must point to the audited durable run.', {
      expected: path.resolve(runRoot),
      actual: metadata.sourceRunRoot,
    }));
  }
  if (metadata.sourceEventSequence !== expectedSequence) {
    diagnostics.push(diagnostic('MACHINE_LATEST_RUN_EXPORT_SEQUENCE_STALE', 'Latest-run export sourceEventSequence must match durable run events.', {
      expected: expectedSequence,
      actual: metadata.sourceEventSequence,
    }));
  }
  if (metadata.status !== 'exported') {
    diagnostics.push(diagnostic('MACHINE_LATEST_RUN_EXPORT_STATUS_INVALID', 'Latest-run export metadata status must be exported.', {
      actual: metadata.status,
    }));
  }
  return { exportMetadata: metadata, diagnostics };
}

async function auditMachineRun(runRoot, latestRunExportRoot = '') {
  const resolvedRunRoot = path.resolve(runRoot);
  const diagnostics = [];
  const events = await readMachineEvents(resolvedRunRoot);
  diagnostics.push(...auditEventSequence(events));
  const projectedRunState = projectRunStateFromEvents(events);
  const runState = await readRunState(resolvedRunRoot);
  diagnostics.push(...auditRunState(runState, projectedRunState));

  const artifactAudit = await auditArtifactManifest(resolvedRunRoot);
  diagnostics.push(...artifactAudit.diagnostics);
  const queueAudit = await auditQueueProjection(resolvedRunRoot, events);
  diagnostics.push(...queueAudit.diagnostics);
  const journalAudit = await auditLegacyJournal(resolvedRunRoot, events);
  diagnostics.push(...journalAudit.diagnostics);
  const exportAudit = await auditLatestRunExport(resolvedRunRoot, latestRunExportRoot, events);
  diagnostics.push(...exportAudit.diagnostics);

  return {
    ok: diagnostics.length === 0,
    runRoot: resolvedRunRoot,
    latestRunExportRoot: latestRunExportRoot ? path.resolve(latestRunExportRoot) : '',
    eventCount: events.length,
    artifactCount: artifactAudit.manifest?.files?.length || 0,
    projectedQueueItemCount: queueAudit.projectedCount,
    legacyJournalCount: journalAudit.journalCount,
    diagnostics,
  };
}

const [, , runRootArg, latestRunExportRootArg = ''] = process.argv;
if (!runRootArg) {
  console.error(usage());
  process.exit(2);
}

try {
  const result = await auditMachineRun(runRootArg, latestRunExportRootArg);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  console.error(err?.message || String(err));
  process.exit(2);
}
