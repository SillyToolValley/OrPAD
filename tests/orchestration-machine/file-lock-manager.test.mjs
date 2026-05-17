import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const { createFileLockManager } = require(path.join(repoRoot, 'src/main/orchestration-machine'));

// File-Lock Queue Phase 1: pure in-memory lock manager. Worker
// tasks declare `targetFiles` (a conservative upper bound on writes)
// and the manager grants them exclusive write access for the
// duration of the dispatch. Empty targetFiles => global exclusive.
// Two tasks whose declared sets are disjoint can run concurrently;
// overlapping sets queue deterministically. ALL-OR-NOTHING acquire
// + FIFO drain on release avoids the hold-and-wait deadlock cycle.

test('acquire with disjoint files grants both tasks concurrently', async () => {
  const manager = createFileLockManager();
  const t1 = await manager.acquire('task-1', ['A', 'B']);
  const t2 = await manager.acquire('task-2', ['C', 'D']);
  assert.equal(t1.waited, false);
  assert.equal(t2.waited, false);
  assert.deepEqual(t1.granted.sort(), ['A', 'B']);
  assert.deepEqual(t2.granted.sort(), ['C', 'D']);
  const state = manager.snapshot();
  assert.equal(state.heldByFile.get('A'), 'task-1');
  assert.equal(state.heldByFile.get('C'), 'task-2');
  assert.equal(state.waitersCount, 0);
});

test('acquire with overlapping files queues the second task until the first releases', async () => {
  const manager = createFileLockManager();
  await manager.acquire('task-1', ['shared', 'task-1-only']);
  // task-2 wants `shared` (held) plus `task-2-only` (free).
  // ALL-OR-NOTHING: it waits even though task-2-only is free.
  let task2Resolved = false;
  const task2Promise = manager.acquire('task-2', ['shared', 'task-2-only']).then(result => {
    task2Resolved = true;
    return result;
  });
  // Yield once so task2's then handler can run if it were going to
  // resolve immediately (it shouldn't).
  await Promise.resolve();
  assert.equal(task2Resolved, false, 'task-2 must NOT be granted while task-1 holds shared');
  assert.equal(manager.snapshot().waitersCount, 1);
  manager.release('task-1');
  const result2 = await task2Promise;
  assert.equal(result2.waited, true);
  assert.deepEqual(result2.granted.sort(), ['shared', 'task-2-only']);
  assert.equal(manager.snapshot().waitersCount, 0);
});

test('design doc worked example: T1(A,B) / T2(B,C) / T3(A,C) serialize deterministically', async () => {
  // The design's worked example timeline (rephrased under the
  // all-or-nothing + FIFO-drain model the manager implements):
  //   t0: T1 grants (A,B). T2 and T3 wait (B and A held).
  //   t1: T1 releases. FIFO drain: T2's (B,C) — both free now — grants.
  //                    T3's (A,C): A free, but C held by T2 → still waits.
  //   t2: T2 releases. FIFO drain: T3's (A,C) — both free — grants.
  const manager = createFileLockManager();
  const t1 = await manager.acquire('T1', ['A', 'B']);
  assert.equal(t1.waited, false);

  let t2Resolved = false;
  let t3Resolved = false;
  const t2Promise = manager.acquire('T2', ['B', 'C']).then(r => { t2Resolved = true; return r; });
  const t3Promise = manager.acquire('T3', ['A', 'C']).then(r => { t3Resolved = true; return r; });
  await Promise.resolve();
  assert.equal(t2Resolved, false);
  assert.equal(t3Resolved, false);

  manager.release('T1');
  const t2 = await t2Promise;
  assert.equal(t2.waited, true);
  assert.deepEqual(t2.granted.sort(), ['B', 'C']);
  // T3 is still waiting — C is now held by T2.
  await Promise.resolve();
  assert.equal(t3Resolved, false, 'T3 must still wait on C');

  manager.release('T2');
  const t3 = await t3Promise;
  assert.equal(t3.waited, true);
  assert.deepEqual(t3.granted.sort(), ['A', 'C']);

  manager.release('T3');
  const finalState = manager.snapshot();
  assert.equal(finalState.heldByFile.size, 0);
  assert.equal(finalState.waitersCount, 0);
});

test('empty targetFiles acquires the global exclusive lock', async () => {
  const manager = createFileLockManager();
  const t1 = await manager.acquire('global-1', []);
  assert.equal(t1.waited, false);
  // Once a task holds the global lock, NO other task can acquire
  // anything — file-specific OR another global request.
  let t2Resolved = false;
  let t3Resolved = false;
  const t2Promise = manager.acquire('t2', ['A']).then(r => { t2Resolved = true; return r; });
  const t3Promise = manager.acquire('t3', []).then(r => { t3Resolved = true; return r; });
  await Promise.resolve();
  assert.equal(t2Resolved, false);
  assert.equal(t3Resolved, false);
  assert.equal(manager.snapshot().globalLockHolder, 'global-1');
  manager.release('global-1');
  const t2 = await t2Promise;
  assert.equal(t2.waited, true);
  // t3 still waiting because t2 holds A.
  await Promise.resolve();
  assert.equal(t3Resolved, false, 't3 (global) must wait while t2 holds A');
  manager.release('t2');
  const t3 = await t3Promise;
  assert.equal(t3.waited, true);
  assert.equal(manager.snapshot().globalLockHolder, 't3');
});

test('held files block a global-lock request even when the requesting task arrives first in the queue', async () => {
  const manager = createFileLockManager();
  await manager.acquire('holder', ['busy.md']);
  let globalGranted = false;
  let secondaryGranted = false;
  const globalPromise = manager.acquire('global', []).then(r => { globalGranted = true; return r; });
  const secondaryPromise = manager.acquire('secondary', ['other.md']).then(r => { secondaryGranted = true; return r; });
  await Promise.resolve();
  // global can't run because busy.md is held; secondary CAN run
  // because other.md is free and no global lock is yet active.
  assert.equal(globalGranted, false);
  // But: secondary's acquire happens AFTER global's queued entry.
  // The drain on release scans waiters in FIFO order, and global
  // (at the head) blocks until ALL files are released. secondary
  // (behind global) would be considered AFTER global, so it stays
  // queued — head-of-line blocking is the all-or-nothing trade-off.
  //
  // CORRECTION: at acquire-time we check isGrantable for secondary
  // BEFORE checking the queue. secondary's targetFiles=['other.md']
  // is grantable (other.md free, no global holder yet). So
  // secondary gets granted immediately on its own acquire call.
  // global stays waiting.
  assert.equal(secondaryGranted, true, 'secondary on a free disjoint file grants without queuing');
  manager.release('holder');
  await Promise.resolve();
  // After holder releases, busy.md is free but secondary still holds
  // other.md — global still waits.
  assert.equal(globalGranted, false);
  manager.release('secondary');
  await globalPromise;
  assert.equal(globalGranted, true);
});

test('release is idempotent and tolerant of unknown taskId', () => {
  const manager = createFileLockManager();
  // Release with no prior acquire is a no-op.
  assert.deepEqual(manager.release('unknown'), { released: [] });
  assert.equal(manager.snapshot().heldByFile.size, 0);
});

test('release while no acquire was made does not crash', () => {
  const manager = createFileLockManager();
  manager.acquire('task-1', ['A']);
  manager.release('task-1');
  // Second release should silently no-op.
  const result = manager.release('task-1');
  assert.deepEqual(result.released, []);
});

test('release scans waiters in FIFO order and grants every eligible waiter in one pass', async () => {
  const manager = createFileLockManager();
  await manager.acquire('blocker', ['x', 'y']);
  let wantsXGranted = false;
  let wantsYGranted = false;
  const wantsX = manager.acquire('wants-x', ['x']).then(r => { wantsXGranted = true; return r; });
  const wantsY = manager.acquire('wants-y', ['y']).then(r => { wantsYGranted = true; return r; });
  await Promise.resolve();
  assert.equal(wantsXGranted, false);
  assert.equal(wantsYGranted, false);
  manager.release('blocker');
  // After blocker releases x and y, BOTH waiters become eligible in
  // the same drain pass. The manager must grant both before
  // returning from release.
  await Promise.all([wantsX, wantsY]);
  assert.equal(wantsXGranted, true);
  assert.equal(wantsYGranted, true);
});

test('re-entrant acquire from the same task is a no-op (same task can request locks it already holds)', async () => {
  const manager = createFileLockManager();
  await manager.acquire('task-1', ['A']);
  // Same task re-acquires A — should NOT block, returns immediately.
  const second = await manager.acquire('task-1', ['A']);
  assert.equal(second.waited, false);
  assert.equal(manager.snapshot().heldByFile.get('A'), 'task-1');
});

// Codex Fix1 (2026-05-16): global re-entrant acquire used to
// self-deadlock — a task that already held files OR the global lock
// could not upgrade to global because canGrant required no holdings.
test('Codex Fix1: same task can upgrade from file-holdings to global lock without deadlocking', async () => {
  const manager = createFileLockManager();
  await manager.acquire('task-1', ['A', 'B']);
  // Same task now requests the global lock. Pre-fix this queued
  // forever because heldByFile.size !== 0. With Fix1, the manager
  // recognizes the holdings as self-owned and grants the upgrade.
  const upgrade = await manager.acquire('task-1', []);
  assert.equal(upgrade.waited, false);
  assert.equal(manager.snapshot().globalLockHolder, 'task-1');
});

test('Codex Fix1: same task re-acquires global lock without deadlocking', async () => {
  const manager = createFileLockManager();
  await manager.acquire('task-1', []);
  // Same task re-acquires global — should NOT block.
  const second = await manager.acquire('task-1', []);
  assert.equal(second.waited, false);
  assert.equal(manager.snapshot().globalLockHolder, 'task-1');
});

// Codex Phase 2 P2 #4 fix (2026-05-16): incoming paths are
// normalized so equivalent declarations across authors / probes /
// canonicalizers all resolve to the same lock key. Without
// normalization, two workers declaring 'src/a.js' vs 'src/./a.js'
// vs 'src\\a.js' would lock different keys and could race the
// same file.
test('Codex P2 #4: lock paths normalize style — src/a.js, src/./a.js, src\\\\a.js all lock the same key', async () => {
  const manager = createFileLockManager();
  await manager.acquire('task-1', ['src/a.js']);
  // Other tasks declaring equivalent paths must wait.
  let dotSlashGranted = false;
  let backslashGranted = false;
  let trailingSlashGranted = false;
  const dotSlash = manager.acquire('task-dot-slash', ['src/./a.js']).then(r => { dotSlashGranted = true; return r; });
  const backslash = manager.acquire('task-backslash', ['src\\a.js']).then(r => { backslashGranted = true; return r; });
  const trailing = manager.acquire('task-trailing', ['src/a.js/']).then(r => { trailingSlashGranted = true; return r; });
  await Promise.resolve();
  assert.equal(dotSlashGranted, false, "'src/./a.js' must normalize to 'src/a.js' and wait");
  assert.equal(backslashGranted, false, "'src\\\\a.js' must normalize to 'src/a.js' and wait");
  assert.equal(trailingSlashGranted, false, "'src/a.js/' must normalize to 'src/a.js' and wait");
  manager.release('task-1');
  // After release, exactly one of the waiters grants (whichever is
  // first in FIFO order); the others continue to wait on that
  // holder.
  await Promise.resolve();
  const grantedCount = [dotSlashGranted, backslashGranted, trailingSlashGranted].filter(Boolean).length;
  assert.equal(grantedCount, 1, 'after release exactly one normalized-equivalent waiter grants');
});

test('Codex P2 #4: leading ./ is stripped before locking', async () => {
  const manager = createFileLockManager();
  await manager.acquire('task-1', ['./src/foo.js']);
  let task2Granted = false;
  const task2 = manager.acquire('task-2', ['src/foo.js']).then(r => { task2Granted = true; return r; });
  await Promise.resolve();
  assert.equal(task2Granted, false, "'./src/foo.js' normalizes to 'src/foo.js' — task-2 must wait");
  manager.release('task-1');
  await task2;
  assert.equal(task2Granted, true);
});

test('Codex P2 #4: dot-dot path segments collapse before locking', async () => {
  const manager = createFileLockManager();
  await manager.acquire('task-1', ['src/foo/../bar.js']);
  let task2Granted = false;
  const task2 = manager.acquire('task-2', ['src/bar.js']).then(r => { task2Granted = true; return r; });
  await Promise.resolve();
  assert.equal(task2Granted, false, "'src/foo/../bar.js' normalizes to 'src/bar.js' and must serialize");
  manager.release('task-1');
  await task2;
  assert.equal(task2Granted, true);
});

test('file locks use prefix-overlap semantics for directories and child paths', async () => {
  const manager = createFileLockManager();
  await manager.acquire('task-dir', ['src']);
  let childGranted = false;
  const child = manager.acquire('task-child', ['src/a.js']).then(r => { childGranted = true; return r; });
  await Promise.resolve();
  assert.equal(childGranted, false, "'src' lock must block child file locks");
  manager.release('task-dir');
  await child;
  assert.equal(childGranted, true);
  manager.release('task-child');

  await manager.acquire('task-child-2', ['src/b.js']);
  let parentGranted = false;
  const parent = manager.acquire('task-parent', ['src']).then(r => { parentGranted = true; return r; });
  await Promise.resolve();
  assert.equal(parentGranted, false, "child file lock must block a parent directory lock");
  manager.release('task-child-2');
  await parent;
  assert.equal(parentGranted, true);
});

test('Codex Fix1: different tasks must NOT upgrade past a self-holder; another task waiting on the same file still queues', async () => {
  const manager = createFileLockManager();
  await manager.acquire('task-1', ['A']);
  let task2Granted = false;
  const task2Promise = manager.acquire('task-2', ['A']).then(r => { task2Granted = true; return r; });
  await Promise.resolve();
  assert.equal(task2Granted, false, 'task-2 must still wait on task-1');
  // Self-upgrade for task-1 should still work even with another
  // task waiting on its files.
  const upgrade = await manager.acquire('task-1', []);
  assert.equal(upgrade.waited, false);
  // task-2 still queued — task-1 holds global now.
  await Promise.resolve();
  assert.equal(task2Granted, false);
  manager.release('task-1');
  await task2Promise;
  assert.equal(task2Granted, true);
});
