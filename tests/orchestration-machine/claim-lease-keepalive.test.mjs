import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

// RC-4: claim-lease keepalive across a pause. A long pause must not let an active
// claim's lease expire into stale-claim recovery (which would re-queue the item
// and discard the held work). On resume-from-pause, requestRunResume heartbeats
// every active lease so the paused duration does not count toward expiry — a
// resume-time renewal, no background keepalive ticker.

const require = createRequire(import.meta.url);
const {
  appendRunLifecycleStatus,
  createClaimLease,
  createMachineRun,
  isClaimLeaseExpired,
  readClaimLease,
  readMachineEvents,
} = require('../../src/main/orchestration-machine');
const runControl = require('../../src/main/orchestration-machine/run-control');

async function makeRun(runId) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-rc4-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/rc4');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline', version: '1.0', id: 'rc4', entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId,
    now: new Date('2026-05-16T00:00:00.000Z'),
  });
  return { workspaceRoot, run };
}

test('RC-4: resuming a paused run renews active claim leases so the paused duration does not expire them', async () => {
  const { workspaceRoot, run } = await makeRun('rc4-keepalive');
  const runId = run.runId;
  try {
    // An active claim with a SHORT (1s) lease, created at T0.
    const created = await createClaimLease(run.runRoot, {
      runId,
      itemId: 'rc4-item',
      leaseMs: 1000,
      now: '2026-05-16T00:00:00.000Z',
    });
    const claimId = created.lease.claimId;
    assert.equal(created.lease.expiresAt, '2026-05-16T00:00:01.000Z');

    // Pause the run.
    await appendRunLifecycleStatus(run.runRoot, { runId, toState: 'paused', reason: 'test.pause' });

    // Resume an HOUR later — long past the original 1s lease expiry. Without the
    // keepalive the lease would be stale; RC-4 must renew it.
    const resumeNow = '2026-05-16T01:00:00.000Z';
    const resumed = await runControl.requestRunResume(run.runRoot, { runId, now: resumeNow });
    assert.equal(resumed.renewedLeaseCount, 1, 'one active lease was renewed on resume');
    assert.equal(resumed.transition?.duplicate === true, false, 'paused -> waiting transition happened');

    const lease = await readClaimLease(run.runRoot, claimId);
    assert.equal(lease.state, 'active', 'lease is still active after resume');
    assert.equal(
      isClaimLeaseExpired(lease, new Date(resumeNow)),
      false,
      'the renewed lease is NOT expired at resume time (the paused hour did not age it)',
    );
    assert.equal(lease.expiresAt, '2026-05-16T01:00:01.000Z', 'expiresAt was pushed to resume time + leaseMs');

    const events = await readMachineEvents(run.runRoot);
    assert.equal(events.some(e => e.eventType === 'claim.heartbeat'), true, 'a durable claim.heartbeat keepalive was recorded');
  } finally {
    runControl.clearRunControlToken(runId);
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('RC-4: a non-paused resume (crash recovery) does not renew leases', async () => {
  const { workspaceRoot, run } = await makeRun('rc4-noresume-renew');
  const runId = run.runId;
  try {
    await createClaimLease(run.runRoot, {
      runId,
      itemId: 'rc4-item-2',
      leaseMs: 1000,
      now: '2026-05-16T00:00:00.000Z',
    });
    // Run is left in its created/waiting state (NOT paused). requestRunResume on a
    // non-paused run must not heartbeat leases (genuine stale-claim recovery still
    // applies on a crash-recovery path).
    const resumed = await runControl.requestRunResume(run.runRoot, { runId, now: '2026-05-16T01:00:00.000Z' });
    assert.equal(resumed.renewedLeaseCount, 0, 'no leases renewed when the run was not paused');
    const events = await readMachineEvents(run.runRoot);
    assert.equal(events.some(e => e.eventType === 'claim.heartbeat'), false, 'no keepalive recorded for a non-paused resume');
  } finally {
    runControl.clearRunControlToken(runId);
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
