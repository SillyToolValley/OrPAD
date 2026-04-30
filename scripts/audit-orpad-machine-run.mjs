import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  SCHEMA_VERSIONS,
  artifactManifestPath,
  createContractValidator,
  fileDigest,
  legacyJournalRecordsFromEvents,
  projectQueueStateFromEvents,
  projectRunStateFromEvents,
  readMachineEvents,
  readQueueItems,
  readRunState,
} = require('../src/main/orchestration-machine');

const contractValidator = createContractValidator();

function usage() {
  return 'Usage: node scripts/audit-orpad-machine-run.mjs <runRoot> [latestRunExportRoot]';
}

function diagnostic(code, message, details = {}) {
  return { code, message, ...details };
}

function runRelativePath(runRoot, relativePath) {
  return path.join(path.resolve(runRoot), ...String(relativePath || '').replace(/\\/g, '/').split('/'));
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

function nodeLifecycleKey(event) {
  return event.payload?.nodeExecutionId
    || `${event.nodePath || ''}:attempt-${event.payload?.attempt || 1}`;
}

function auditNodeLifecycle(events) {
  const diagnostics = [];
  const byExecutionId = new Map();
  for (const event of events) {
    if (!String(event.eventType || '').startsWith('node.')) continue;
    const key = nodeLifecycleKey(event);
    if (!key) continue;
    if (!byExecutionId.has(key)) byExecutionId.set(key, []);
    byExecutionId.get(key).push(event);
  }

  for (const [nodeExecutionId, lifecycleEvents] of byExecutionId.entries()) {
    const byType = new Map(lifecycleEvents.map(event => [event.eventType, event]));
    const terminalEvents = lifecycleEvents.filter(event => ['node.completed', 'node.failed', 'node.blocked', 'node.skipped'].includes(event.eventType));
    const started = byType.get('node.started');
    const scheduled = byType.get('node.scheduled');

    if (started && !scheduled) {
      diagnostics.push(diagnostic('MACHINE_NODE_STARTED_WITHOUT_SCHEDULED', 'Node lifecycle must schedule before start.', {
        nodeExecutionId,
        nodePath: started.nodePath,
        startedSequence: started.sequence,
      }));
    }
    for (const terminal of terminalEvents) {
      if (!started) {
        diagnostics.push(diagnostic('MACHINE_NODE_TERMINAL_WITHOUT_STARTED', 'Node lifecycle terminal events require a prior started event.', {
          nodeExecutionId,
          nodePath: terminal.nodePath,
          eventType: terminal.eventType,
          terminalSequence: terminal.sequence,
        }));
      } else if (started.sequence >= terminal.sequence) {
        diagnostics.push(diagnostic('MACHINE_NODE_TERMINAL_BEFORE_STARTED', 'Node lifecycle terminal event must occur after started.', {
          nodeExecutionId,
          nodePath: terminal.nodePath,
          eventType: terminal.eventType,
          startedSequence: started.sequence,
          terminalSequence: terminal.sequence,
        }));
      }
      if (scheduled && scheduled.sequence >= terminal.sequence) {
        diagnostics.push(diagnostic('MACHINE_NODE_TERMINAL_BEFORE_SCHEDULED', 'Node lifecycle terminal event must occur after scheduled.', {
          nodeExecutionId,
          nodePath: terminal.nodePath,
          eventType: terminal.eventType,
          scheduledSequence: scheduled.sequence,
          terminalSequence: terminal.sequence,
        }));
      }
    }
    if (terminalEvents.length > 1) {
      diagnostics.push(diagnostic('MACHINE_NODE_MULTIPLE_TERMINAL_EVENTS', 'Node lifecycle must not record multiple terminal events for one execution id.', {
        nodeExecutionId,
        nodePath: terminalEvents[0].nodePath,
        terminalEventTypes: terminalEvents.map(event => event.eventType),
        terminalSequences: terminalEvents.map(event => event.sequence),
      }));
    }
  }
  return diagnostics;
}

function adapterIdentity(event) {
  const payload = event.payload || {};
  return {
    adapterCallId: payload.adapterCallId || '',
    attemptId: payload.attemptId || '',
    idempotencyKey: payload.idempotencyKey || '',
  };
}

function auditAdapterIdentity(events) {
  const diagnostics = [];
  const requestsByIdempotencyKey = new Map();
  const resultCounts = new Map();

  for (const event of events) {
    if (event.eventType !== 'adapter.requested') continue;
    const identity = adapterIdentity(event);
    if (!identity.idempotencyKey) {
      diagnostics.push(diagnostic('MACHINE_ADAPTER_REQUEST_IDENTITY_MISSING', 'Adapter requests must record idempotency identity fields.', {
        sequence: event.sequence,
        nodePath: event.nodePath,
      }));
      continue;
    }
    if (requestsByIdempotencyKey.has(identity.idempotencyKey)) {
      diagnostics.push(diagnostic('MACHINE_ADAPTER_REQUEST_DUPLICATE_IDEMPOTENCY', 'Adapter requests must not reuse an idempotency key within one run.', {
        idempotencyKey: identity.idempotencyKey,
        firstSequence: requestsByIdempotencyKey.get(identity.idempotencyKey).sequence,
        duplicateSequence: event.sequence,
      }));
      continue;
    }
    requestsByIdempotencyKey.set(identity.idempotencyKey, event);
  }

  for (const event of events) {
    if (!['adapter.result', 'worker.result'].includes(event.eventType)) continue;
    const identity = adapterIdentity(event);
    const count = (resultCounts.get(identity.idempotencyKey) || 0) + 1;
    resultCounts.set(identity.idempotencyKey, count);
    if (!identity.adapterCallId || !identity.attemptId || !identity.idempotencyKey) {
      diagnostics.push(diagnostic('MACHINE_ADAPTER_RESULT_IDENTITY_MISSING', 'Adapter results must record adapterCallId, attemptId, and idempotencyKey.', {
        sequence: event.sequence,
        eventType: event.eventType,
        nodePath: event.nodePath,
      }));
      continue;
    }
    const request = requestsByIdempotencyKey.get(identity.idempotencyKey);
    if (!request) {
      diagnostics.push(diagnostic('MACHINE_ADAPTER_RESULT_WITHOUT_REQUEST', 'Adapter result events must match a prior adapter.requested event.', {
        sequence: event.sequence,
        eventType: event.eventType,
        idempotencyKey: identity.idempotencyKey,
      }));
      continue;
    }
    const requestIdentity = adapterIdentity(request);
    for (const field of ['adapterCallId', 'attemptId']) {
      if (identity[field] !== requestIdentity[field]) {
        diagnostics.push(diagnostic('MACHINE_ADAPTER_RESULT_IDENTITY_MISMATCH', 'Adapter result identity must match the request identity.', {
          sequence: event.sequence,
          eventType: event.eventType,
          field,
          expected: requestIdentity[field],
          actual: identity[field],
          requestSequence: request.sequence,
        }));
      }
    }
    if (request.sequence >= event.sequence) {
      diagnostics.push(diagnostic('MACHINE_ADAPTER_RESULT_BEFORE_REQUEST', 'Adapter result event must occur after its request event.', {
        requestSequence: request.sequence,
        resultSequence: event.sequence,
        idempotencyKey: identity.idempotencyKey,
      }));
    }
  }

  for (const [idempotencyKey, count] of resultCounts.entries()) {
    if (count > 1) {
      diagnostics.push(diagnostic('MACHINE_ADAPTER_RESULT_DUPLICATE_IDEMPOTENCY', 'Adapter results must not reuse an idempotency key within one run.', {
        idempotencyKey,
        count,
      }));
    }
  }

  return diagnostics;
}

function auditWorkerResultProof(events) {
  const diagnostics = [];
  for (const event of events) {
    if (event.eventType !== 'worker.result') continue;
    if (event.payload?.status !== 'done') continue;
    const hasArtifact = (event.artifactRefs || []).length > 0 || Boolean(event.payload?.patchArtifact);
    const hasVerification = (event.payload?.verification || []).length > 0;
    if (!hasArtifact || !hasVerification) {
      diagnostics.push(diagnostic('MACHINE_WORKER_DONE_PROOF_MISSING', 'Done worker results must include artifact evidence and verification proof.', {
        sequence: event.sequence,
        itemId: event.itemId,
        adapterCallId: event.payload?.adapterCallId || '',
        hasArtifact,
        hasVerification,
      }));
    }
  }
  return diagnostics;
}

function workerResultArtifactRefs(event) {
  return Array.from(new Set([
    ...(event.artifactRefs || []),
    event.payload?.patchArtifact || '',
  ].filter(Boolean).map(ref => String(ref).replace(/\\/g, '/'))));
}

function findPriorEvent(events, sequence, predicate) {
  return events.find(event => event.sequence < sequence && predicate(event)) || null;
}

function findLaterEvent(events, sequence, predicate) {
  return events.find(event => event.sequence > sequence && predicate(event)) || null;
}

function auditQueueTransitionCausality(events) {
  const diagnostics = [];
  for (const event of events) {
    if (event.eventType !== 'queue.transition') continue;

    if (event.toState === 'claimed') {
      const claimId = event.payload?.claimId || '';
      const lease = findPriorEvent(events, event.sequence, candidate => (
        candidate.eventType === 'claim.lease-created'
        && candidate.itemId === event.itemId
        && candidate.payload?.claimId === claimId
      ));
      if (!claimId || !lease) {
        diagnostics.push(diagnostic('MACHINE_QUEUE_CLAIM_WITHOUT_LEASE', 'Queue claim transitions require a prior Machine-owned claim lease event.', {
          sequence: event.sequence,
          itemId: event.itemId,
          claimId,
          transitionId: event.payload?.transitionId || '',
        }));
      }
      const leaseWriteSetLockId = lease?.payload?.writeSetLockId || '';
      const transitionWriteSetLockId = event.payload?.writeSetLockId || '';
      if (leaseWriteSetLockId && transitionWriteSetLockId !== leaseWriteSetLockId) {
        diagnostics.push(diagnostic('MACHINE_QUEUE_CLAIM_WRITE_SET_MISMATCH', 'Queue claim transition writeSetLockId must match the claim lease.', {
          sequence: event.sequence,
          itemId: event.itemId,
          claimId,
          expected: leaseWriteSetLockId,
          actual: transitionWriteSetLockId,
          leaseSequence: lease.sequence,
        }));
      }
    }

    if (event.fromState === 'claimed' && event.toState === 'done') {
      const claimId = event.payload?.claimId || '';
      const workerResult = findPriorEvent(events, event.sequence, candidate => (
        candidate.eventType === 'worker.result'
        && candidate.itemId === event.itemId
        && candidate.payload?.status === 'done'
        && candidate.payload?.toState === 'done'
      ));
      if (!workerResult) {
        diagnostics.push(diagnostic('MACHINE_QUEUE_DONE_WITHOUT_WORKER_RESULT', 'Queue done transitions require a prior accepted done worker result.', {
          sequence: event.sequence,
          itemId: event.itemId,
          claimId,
          transitionId: event.payload?.transitionId || '',
        }));
      } else if (claimId && workerResult.payload?.claimId !== claimId) {
        diagnostics.push(diagnostic('MACHINE_QUEUE_DONE_WORKER_CLAIM_MISMATCH', 'Queue done transition claimId must match the accepted worker result claimId.', {
          sequence: event.sequence,
          itemId: event.itemId,
          expected: workerResult.payload?.claimId || '',
          actual: claimId,
          workerResultSequence: workerResult.sequence,
        }));
      }
    }
  }
  return diagnostics;
}

function auditLockCausality(events) {
  const diagnostics = [];
  for (const event of events) {
    if (event.eventType === 'claim.lease-created') {
      const writeSetLockId = event.payload?.writeSetLockId || '';
      if (!writeSetLockId) continue;
      const writeSet = findPriorEvent(events, event.sequence, candidate => (
        candidate.eventType === 'write-set.acquired'
        && candidate.itemId === event.itemId
        && candidate.payload?.lockId === writeSetLockId
        && candidate.payload?.claimId === event.payload?.claimId
      ));
      if (!writeSet) {
        diagnostics.push(diagnostic('MACHINE_CLAIM_LEASE_WITHOUT_WRITE_SET', 'Claim leases with a write-set lock require a prior Machine-owned write-set acquisition event.', {
          sequence: event.sequence,
          itemId: event.itemId,
          claimId: event.payload?.claimId || '',
          writeSetLockId,
        }));
      }
    }

    if (event.eventType === 'queue.transition' && event.fromState === 'claimed') {
      const claimId = event.payload?.claimId || '';
      if (!claimId) continue;
      const release = findLaterEvent(events, event.sequence, candidate => (
        candidate.eventType === 'claim.lease-released'
        && candidate.itemId === event.itemId
        && candidate.payload?.claimId === claimId
      ));
      if (!release) {
        diagnostics.push(diagnostic('MACHINE_QUEUE_CLOSE_WITHOUT_CLAIM_RELEASE', 'Closed queue claims must release the Machine-owned claim lease.', {
          sequence: event.sequence,
          itemId: event.itemId,
          claimId,
          toState: event.toState,
          transitionId: event.payload?.transitionId || '',
        }));
      }

      const lease = findPriorEvent(events, event.sequence, candidate => (
        candidate.eventType === 'claim.lease-created'
        && candidate.itemId === event.itemId
        && candidate.payload?.claimId === claimId
      ));
      const writeSetLockId = lease?.payload?.writeSetLockId || event.payload?.writeSetLockId || '';
      if (!writeSetLockId) continue;
      const writeSetRelease = findLaterEvent(events, event.sequence, candidate => (
        candidate.eventType === 'write-set.released'
        && candidate.itemId === event.itemId
        && candidate.payload?.lockId === writeSetLockId
        && candidate.payload?.claimId === claimId
      ));
      if (!writeSetRelease) {
        diagnostics.push(diagnostic('MACHINE_QUEUE_CLOSE_WITHOUT_WRITE_SET_RELEASE', 'Closed queue claims must release their Machine-owned write-set lock.', {
          sequence: event.sequence,
          itemId: event.itemId,
          claimId,
          writeSetLockId,
          toState: event.toState,
          transitionId: event.payload?.transitionId || '',
        }));
      }
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
    const filePath = runRelativePath(runRoot, file.path);
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

function auditWorkerResultArtifacts(events, manifest) {
  const diagnostics = [];
  const manifestPaths = new Set((manifest?.files || []).map(file => file.path));
  for (const event of events) {
    if (event.eventType !== 'worker.result') continue;
    if (event.payload?.status !== 'done') continue;
    const refs = workerResultArtifactRefs(event);
    if (!refs.length) continue;
    if (!manifest) {
      diagnostics.push(diagnostic('MACHINE_WORKER_RESULT_ARTIFACT_MANIFEST_MISSING', 'Worker result artifact proof requires a Machine artifact manifest.', {
        sequence: event.sequence,
        itemId: event.itemId,
        refs,
      }));
      continue;
    }
    for (const ref of refs) {
      if (manifestPaths.has(ref)) continue;
      diagnostics.push(diagnostic('MACHINE_WORKER_RESULT_ARTIFACT_UNREGISTERED', 'Worker result artifact proof must reference a registered Machine artifact.', {
        sequence: event.sequence,
        itemId: event.itemId,
        ref,
      }));
    }
  }
  return diagnostics;
}

function candidateInventoryFiles(manifest) {
  return (manifest?.files || []).filter(file => (
    file.schemaVersion === SCHEMA_VERSIONS.candidateInventory
    || file.producedBy === 'orpad.machine.candidate-inventory'
    || file.path === 'artifacts/discovery/candidate-inventory.json'
  ));
}

function completedProbeNodePaths(events, maxSequence) {
  return new Set(events
    .filter(event => (
      event.eventType === 'node.completed'
      && event.nodePath
      && event.sequence <= maxSequence
      && event.payload?.nodeType === 'orpad.probe'
    ))
    .map(event => event.nodePath));
}

async function auditCandidateInventory(runRoot, manifest, events) {
  const diagnostics = [];
  const files = candidateInventoryFiles(manifest);
  if (!files.length) return { inventoryCount: 0, itemCount: 0, diagnostics };

  let itemCount = 0;
  for (const file of files) {
    const filePath = runRelativePath(runRoot, file.path);
    let inventory = null;
    try {
      inventory = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (err) {
      diagnostics.push(diagnostic('MACHINE_CANDIDATE_INVENTORY_UNREADABLE', 'Candidate inventory artifact must be readable JSON.', {
        path: file.path,
        error: err.message,
      }));
      continue;
    }

    const validation = contractValidator.validate('candidateInventory', inventory);
    if (!validation.ok) {
      diagnostics.push(diagnostic('MACHINE_CANDIDATE_INVENTORY_SCHEMA_INVALID', 'Candidate inventory artifact must match the Machine contract schema.', {
        path: file.path,
        errors: validation.errors,
      }));
      continue;
    }

    itemCount += inventory.items.length;
    const candidateCount = inventory.items.filter(item => item.status === 'candidate').length;
    const emptyPassCount = inventory.items.filter(item => item.status === 'empty-pass').length;
    if (inventory.candidateCount !== candidateCount) {
      diagnostics.push(diagnostic('MACHINE_CANDIDATE_INVENTORY_COUNT_MISMATCH', 'Candidate inventory candidateCount must match candidate rows.', {
        path: file.path,
        field: 'candidateCount',
        expected: candidateCount,
        actual: inventory.candidateCount,
      }));
    }
    if (inventory.emptyPassCount !== emptyPassCount) {
      diagnostics.push(diagnostic('MACHINE_CANDIDATE_INVENTORY_COUNT_MISMATCH', 'Candidate inventory emptyPassCount must match empty-pass rows.', {
        path: file.path,
        field: 'emptyPassCount',
        expected: emptyPassCount,
        actual: inventory.emptyPassCount,
      }));
    }

    const selectedProbeNodes = new Set(inventory.selectedProbeNodes);
    for (const item of inventory.items) {
      if (!selectedProbeNodes.has(item.nodePath)) {
        diagnostics.push(diagnostic('MACHINE_CANDIDATE_INVENTORY_NODE_UNSELECTED', 'Candidate inventory item nodePath must be listed in selectedProbeNodes.', {
          path: file.path,
          itemId: item.id,
          nodePath: item.nodePath,
        }));
      }
      if (item.status === 'candidate' && !item.proposalId && !item.suggestedWorkItemId) {
        diagnostics.push(diagnostic('MACHINE_CANDIDATE_INVENTORY_CANDIDATE_ID_MISSING', 'Candidate inventory candidate rows must carry a proposalId or suggestedWorkItemId.', {
          path: file.path,
          itemId: item.id,
          nodePath: item.nodePath,
        }));
      }
      if (item.status === 'empty-pass' && !item.reason) {
        diagnostics.push(diagnostic('MACHINE_CANDIDATE_INVENTORY_EMPTY_PASS_REASON_MISSING', 'Candidate inventory empty-pass rows must explain why no candidate was submitted.', {
          path: file.path,
          itemId: item.id,
          nodePath: item.nodePath,
        }));
      }
    }

    const registrationEvent = events.find(event => (
      event.eventType === 'artifact.registered'
      && event.payload?.file?.path === file.path
    ));
    if (!registrationEvent) {
      diagnostics.push(diagnostic('MACHINE_CANDIDATE_INVENTORY_REGISTRATION_MISSING', 'Candidate inventory artifact must have an artifact.registered event.', {
        path: file.path,
      }));
    } else if (inventory.sourceEventSequence >= registrationEvent.sequence) {
      diagnostics.push(diagnostic('MACHINE_CANDIDATE_INVENTORY_SOURCE_SEQUENCE_INVALID', 'Candidate inventory sourceEventSequence must point to events before artifact registration.', {
        path: file.path,
        sourceEventSequence: inventory.sourceEventSequence,
        registrationSequence: registrationEvent.sequence,
      }));
    }

    const completedProbeNodes = completedProbeNodePaths(events, inventory.sourceEventSequence);
    for (const nodePath of inventory.selectedProbeNodes) {
      if (!completedProbeNodes.has(nodePath)) {
        diagnostics.push(diagnostic('MACHINE_CANDIDATE_INVENTORY_PROBE_NOT_COMPLETED', 'Candidate inventory selectedProbeNodes must be completed probe nodes at the source event sequence.', {
          path: file.path,
          nodePath,
          sourceEventSequence: inventory.sourceEventSequence,
        }));
      }
    }
  }

  return { inventoryCount: files.length, itemCount, diagnostics };
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

function auditRunTerminalSemantics(projectedRunState, projectedQueue) {
  const diagnostics = [];
  const active = [];
  const blocked = [];
  for (const [itemId, state] of projectedQueue.entries()) {
    if (['candidate', 'queued', 'claimed'].includes(state)) active.push({ itemId, state });
    if (state === 'blocked') blocked.push({ itemId, state });
  }

  if (projectedRunState?.summaryStatus === 'done' && active.length) {
    diagnostics.push(diagnostic('MACHINE_RUN_DONE_ACTIVE_QUEUE', 'Run summary cannot be done while active queue items remain.', {
      activeCount: active.length,
      active,
    }));
  }
  if (projectedRunState?.summaryStatus === 'done' && blocked.length) {
    diagnostics.push(diagnostic('MACHINE_RUN_DONE_BLOCKED_QUEUE', 'Run summary cannot be done while blocked queue items remain.', {
      blockedCount: blocked.length,
      blocked,
    }));
  }
  if (projectedRunState?.lifecycleStatus === 'completed' && projectedRunState?.summaryStatus !== 'done') {
    diagnostics.push(diagnostic('MACHINE_RUN_COMPLETED_WITHOUT_DONE_SUMMARY', 'Completed lifecycle status requires a done run summary.', {
      lifecycleStatus: projectedRunState.lifecycleStatus,
      summaryStatus: projectedRunState.summaryStatus,
    }));
  }
  if (projectedRunState?.lifecycleStatus === 'completed' && active.length) {
    diagnostics.push(diagnostic('MACHINE_RUN_COMPLETED_ACTIVE_QUEUE', 'Completed lifecycle status requires no active queue items.', {
      activeCount: active.length,
      active,
    }));
  }
  return diagnostics;
}

function queueInventoryFromEvents(events, maxSequence) {
  const projected = new Map();
  for (const event of events) {
    if (event.sequence > maxSequence) continue;
    if (event.eventType !== 'queue.transition') continue;
    projected.set(event.itemId, event.toState);
  }
  const counts = {};
  for (const state of projected.values()) counts[state] = (counts[state] || 0) + 1;
  const activeCount = ['candidate', 'queued', 'claimed'].reduce((sum, state) => sum + (counts[state] || 0), 0);
  const terminalCount = ['done', 'blocked', 'rejected'].reduce((sum, state) => sum + (counts[state] || 0), 0);
  return {
    counts,
    activeCount,
    terminalCount,
    blockedCount: counts.blocked || 0,
    doneCount: counts.done || 0,
  };
}

function auditRunInventorySnapshots(events) {
  const diagnostics = [];
  for (const event of events) {
    if (!['run.summary', 'run.status'].includes(event.eventType)) continue;
    const actual = event.payload?.inventory;
    if (!actual || typeof actual !== 'object') continue;
    const expected = queueInventoryFromEvents(events, event.sequence);
    for (const field of ['activeCount', 'terminalCount', 'blockedCount', 'doneCount']) {
      if (actual[field] === expected[field]) continue;
      diagnostics.push(diagnostic('MACHINE_RUN_INVENTORY_SNAPSHOT_MISMATCH', 'Run inventory snapshots must match queue replay at the event sequence.', {
        sequence: event.sequence,
        eventType: event.eventType,
        field,
        expected: expected[field],
        actual: actual[field],
      }));
    }
    const states = new Set([
      ...Object.keys(actual.counts || {}),
      ...Object.keys(expected.counts || {}),
    ]);
    for (const state of states) {
      const expectedCount = expected.counts[state] || 0;
      const actualCount = actual.counts?.[state] || 0;
      if (actualCount === expectedCount) continue;
      diagnostics.push(diagnostic('MACHINE_RUN_INVENTORY_SNAPSHOT_MISMATCH', 'Run inventory count snapshots must match queue replay at the event sequence.', {
        sequence: event.sequence,
        eventType: event.eventType,
        field: `counts.${state}`,
        expected: expectedCount,
        actual: actualCount,
      }));
    }
  }
  return diagnostics;
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
  diagnostics.push(...auditNodeLifecycle(events));
  diagnostics.push(...auditAdapterIdentity(events));
  diagnostics.push(...auditWorkerResultProof(events));
  diagnostics.push(...auditQueueTransitionCausality(events));
  diagnostics.push(...auditLockCausality(events));

  const artifactAudit = await auditArtifactManifest(resolvedRunRoot);
  diagnostics.push(...artifactAudit.diagnostics);
  diagnostics.push(...auditWorkerResultArtifacts(events, artifactAudit.manifest));
  const candidateInventoryAudit = await auditCandidateInventory(resolvedRunRoot, artifactAudit.manifest, events);
  diagnostics.push(...candidateInventoryAudit.diagnostics);
  const queueAudit = await auditQueueProjection(resolvedRunRoot, events);
  diagnostics.push(...queueAudit.diagnostics);
  diagnostics.push(...auditRunTerminalSemantics(projectedRunState, projectQueueStateFromEvents(events)));
  diagnostics.push(...auditRunInventorySnapshots(events));
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
    candidateInventoryCount: candidateInventoryAudit.inventoryCount,
    candidateInventoryItemCount: candidateInventoryAudit.itemCount,
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
