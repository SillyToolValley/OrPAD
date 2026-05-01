const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { appendMachineEvent } = require('./events');
const { assertMachineStorageId } = require('./ids');
const { ensureDir, readJsonIfExists, writeJsonAtomic } = require('./metadata-store');

const fsp = fs.promises;
const DEFAULT_CLAIM_LEASE_MS = 5 * 60 * 1000;

function claimRoot(runRoot) {
  return path.join(path.resolve(runRoot), 'locks', 'claims');
}

function claimLeasePath(runRoot, claimId) {
  return path.join(claimRoot(runRoot), `${assertMachineStorageId(claimId, 'claimId')}.json`);
}

function idSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'claim';
}

function isoDate(value = new Date()) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function leaseExpiry(now, leaseMs = DEFAULT_CLAIM_LEASE_MS) {
  return new Date(new Date(now).getTime() + leaseMs).toISOString();
}

function createClaimId(itemId, options = {}) {
  if (options.claimId) return assertMachineStorageId(options.claimId, 'claimId');
  const stamp = isoDate(options.now || new Date())
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '')
    .replace('T', '_');
  const suffix = options.suffix || crypto.randomBytes(3).toString('hex');
  return assertMachineStorageId(`claim-${idSegment(itemId)}-${stamp}-${suffix}`, 'claimId');
}

function isClaimLeaseExpired(lease, now = new Date()) {
  if (!lease?.expiresAt) return true;
  return Date.parse(lease.expiresAt) <= Date.parse(isoDate(now));
}

async function readClaimLease(runRoot, claimId) {
  return readJsonIfExists(claimLeasePath(runRoot, claimId), null);
}

async function readClaimLeases(runRoot) {
  const root = claimRoot(runRoot);
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const claims = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const lease = await readJsonIfExists(path.join(root, entry.name), null);
    if (lease) claims.push(lease);
  }
  return claims;
}

async function readActiveClaimLeases(runRoot) {
  return (await readClaimLeases(runRoot)).filter(lease => lease.state === 'active');
}

async function writeClaimLease(runRoot, lease) {
  await ensureDir(claimRoot(runRoot));
  await writeJsonAtomic(claimLeasePath(runRoot, lease.claimId), lease);
  return lease;
}

async function createClaimLease(runRoot, options = {}) {
  const {
    runId,
    itemId,
    workerId = 'orpad.workerLoop',
    leaseMs = DEFAULT_CLAIM_LEASE_MS,
    writeSetLockId = '',
    writeSetPaths = [],
  } = options;
  if (!runId) throw new Error('runId is required.');
  if (!itemId) throw new Error('itemId is required.');

  const now = isoDate(options.now || new Date());
  const claimId = createClaimId(itemId, { ...options, now });
  const existing = await readClaimLease(runRoot, claimId);
  if (existing?.state === 'active') return { duplicate: true, lease: existing };

  const lease = {
    schemaVersion: 'orpad.claimLease.v1',
    claimId,
    runId,
    itemId,
    workerId,
    state: 'active',
    attempt: options.attempt || 1,
    leaseMs,
    createdAt: now,
    heartbeatAt: now,
    expiresAt: leaseExpiry(now, leaseMs),
    writeSetLockId,
    writeSetPaths,
  };
  await writeClaimLease(runRoot, lease);
  const event = await appendMachineEvent(runRoot, {
    runId,
    actor: 'machine',
    eventType: 'claim.lease-created',
    itemId,
    reason: 'dispatcher.claim-lease',
    payload: {
      claimId,
      workerId,
      leaseMs,
      expiresAt: lease.expiresAt,
      writeSetLockId,
      writeSetPaths,
    },
  });
  return { event, lease };
}

async function heartbeatClaimLease(runRoot, claimId, options = {}) {
  const lease = await readClaimLease(runRoot, claimId);
  if (!lease) throw new Error(`Claim lease not found: ${claimId}`);
  if (lease.state !== 'active') {
    const err = new Error(`Cannot heartbeat inactive claim lease: ${claimId}`);
    err.code = 'CLAIM_LEASE_INACTIVE';
    throw err;
  }

  const now = isoDate(options.now || new Date());
  const next = {
    ...lease,
    heartbeatAt: now,
    expiresAt: leaseExpiry(now, options.leaseMs || lease.leaseMs || DEFAULT_CLAIM_LEASE_MS),
    updatedAt: now,
  };
  await writeClaimLease(runRoot, next);
  const event = await appendMachineEvent(runRoot, {
    runId: lease.runId,
    actor: 'machine',
    eventType: 'claim.heartbeat',
    itemId: lease.itemId,
    reason: 'claim.heartbeat',
    payload: {
      claimId,
      expiresAt: next.expiresAt,
    },
  });
  return { event, lease: next };
}

async function markClaimLeaseReleased(runRoot, claimId, options = {}) {
  const lease = await readClaimLease(runRoot, claimId);
  if (!lease) return null;
  if (lease.state !== 'active') return { duplicate: true, lease };

  const now = isoDate(options.now || new Date());
  const state = options.state || 'released';
  const released = {
    ...lease,
    state,
    releasedAt: now,
    updatedAt: now,
    releaseReason: options.reason || `claim.${state}`,
  };
  await writeClaimLease(runRoot, released);
  const event = await appendMachineEvent(runRoot, {
    runId: lease.runId,
    actor: 'machine',
    eventType: 'claim.lease-released',
    itemId: lease.itemId,
    reason: released.releaseReason,
    payload: {
      claimId,
      state,
      writeSetLockId: lease.writeSetLockId,
    },
  });
  return { event, lease: released };
}

module.exports = {
  DEFAULT_CLAIM_LEASE_MS,
  claimLeasePath,
  claimRoot,
  createClaimId,
  createClaimLease,
  heartbeatClaimLease,
  isClaimLeaseExpired,
  markClaimLeaseReleased,
  readActiveClaimLeases,
  readClaimLease,
  readClaimLeases,
  writeClaimLease,
};
