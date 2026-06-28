import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ptyTap = require(path.join(repoRoot, 'src/main/terminal/pty-tap.cjs'));
const { startTuiDetect, stopTuiDetect, observers, detachWindow, reattach, reattachWorkspace, findBySession } = require(path.join(repoRoot, 'src/main/orchestration-core/tui-detect-observer.cjs'));

// Drive the WHOLE main-process observe chain: pty-tap bus -> vt-grid (screen) -> tui-detect (ontology) -> send.
// Feeds raw-PTY-style chunks (with cursor noise + SGR colour, exactly like a real TUI stream) and asserts the
// run graph events come out — proving the integration, not just the detector in isolation.

test('observer turns a live PTY stream into run/start + ontology node events + run/done', async () => {
  const events = [];
  const send = (e) => events.push(e);
  const runId = 'observe-test-A';
  const sessionId = 'sess-A';

  const handle = startTuiDetect({ runId, sessionId, agent: 'claude', send, cols: 80, rows: 24, intervalMs: 15 });
  assert.ok(handle, 'observer started');

  // run/start + a human-facing notice are emitted synchronously so the sidebar row appears immediately.
  assert.equal(events.filter((e) => e.ev === 'run' && e.state === 'start').length, 1);
  assert.equal(events.filter((e) => e.ev === 'run' && e.state === 'start')[0].observe, true);
  assert.equal(events.some((e) => e.ev === 'notice'), true);

  // The terminal renders tool activity — with cursor moves + colour interleaved, as a real TUI stream does.
  ptyTap.publishData(sessionId, '\x1b[2J\x1b[H');
  ptyTap.publishData(sessionId, '\x1b[31m● \x1b[0mReading 1 file…\r\n');
  ptyTap.publishData(sessionId, '⎿ note.txt\r\n');
  ptyTap.publishData(sessionId, '● Reading 1 file, running 1 shell command…\r\n'); // SUMMARY bullet → ignored
  ptyTap.publishData(sessionId, '⎿ $ echo LIVE_OK\r\n');
  ptyTap.publishData(sessionId, '● Write(out.txt)\r\n');
  ptyTap.publishData(sessionId, '⎿ Wrote 1 lines to out.txt\r\n');

  await delay(60); // let the detector tick at least once

  const actives = events.filter((e) => e.ev === 'node' && e.state === 'active');
  assert.deepEqual(actives.map((a) => a.type), ['inspect', 'exec', 'edit'], 'read → bash → write, summary/prose skipped');
  assert.equal(actives[0].file, 'note.txt');
  assert.match(actives[1].label, /echo LIVE_OK/);
  assert.equal(actives[2].file, 'out.txt');

  // Stopping synthesizes run/done and detaches from the bus.
  assert.equal(stopTuiDetect(runId), true);
  assert.equal(events.filter((e) => e.ev === 'run' && e.state === 'done').length, 1);
  assert.equal(observers.has(runId), false, 'observer removed from the registry');

  // After stop, further PTY output is ignored (no leaked tap, no new events).
  const countAfter = events.length;
  ptyTap.publishData(sessionId, '● Bash(should-be-ignored)\r\n');
  await delay(40);
  assert.equal(events.length, countAfter, 'no events after stop (unsubscribed)');
});

test('a session exit (pty onExit → bus) closes the observed run automatically', async () => {
  const events = [];
  const runId = 'observe-test-B';
  const sessionId = 'sess-B';
  startTuiDetect({ runId, sessionId, agent: 'claude', send: (e) => events.push(e), intervalMs: 15 });
  ptyTap.publishData(sessionId, '● Bash(npm test)\r\n');
  await delay(40);
  assert.equal(events.some((e) => e.ev === 'node' && e.type === 'exec'), true);

  ptyTap.publishExit(sessionId); // terminal closed
  assert.equal(events.filter((e) => e.ev === 'run' && e.state === 'done').length, 1);
  assert.equal(observers.has(runId), false);
});

test('observer survives window close (detach) and replays its accumulated graph on reattach', async () => {
  const win1 = [];
  const runId = 'observe-reattach';
  const sessionId = 'sess-RA';
  startTuiDetect({ runId, sessionId, agent: 'claude', send: (e) => win1.push(e), intervalMs: 15, wcId: 101, workspaceRoot: '/ws' });
  ptyTap.publishData(sessionId, '● Read(a.txt)\r\n');
  await delay(45);
  assert.ok(win1.some((e) => e.ev === 'node' && e.file === 'a.txt'), 'window 1 saw the first node');

  // The Run GUI window closes -> DETACH: the observer must keep running (PTY session is still alive).
  detachWindow(101);
  const before = win1.length;
  ptyTap.publishData(sessionId, '● Write(b.txt)\r\n');
  await delay(45);
  assert.equal(win1.length, before, 'a detached (closed) window receives no further events');
  assert.equal(observers.has(runId), true, 'the observer is STILL ALIVE after the window closed');
  assert.ok(findBySession(sessionId), 'still findable by sessionId');

  // Reopen -> reattach a fresh window: it must replay the WHOLE buffer, including the node detected while detached.
  const win2 = [];
  assert.equal(reattach(runId, (e) => win2.push(e), 202), true);
  assert.ok(win2.some((e) => e.ev === 'run' && e.state === 'start'), 'run/start replayed');
  assert.ok(win2.some((e) => e.ev === 'node' && e.file === 'a.txt'), 'pre-close node replayed');
  assert.ok(win2.some((e) => e.ev === 'node' && e.file === 'b.txt'), 'node detected WHILE detached is replayed (no gap)');

  // Live events continue to the reattached window.
  const win2Before = win2.length;
  ptyTap.publishData(sessionId, '● Bash(npm test)\r\n');
  await delay(45);
  assert.ok(win2.length > win2Before, 'live events flow to the reattached window');

  stopTuiDetect(runId);
  assert.equal(observers.has(runId), false, 'explicit stop truly ends it');
});

test('reattachWorkspace matches same-workspace + unscoped (global) observers, excludes other workspaces, skips already-bound', () => {
  startTuiDetect({ runId: 'obs-ws-A', sessionId: 'ws-A', send: () => {}, intervalMs: 15, wcId: 0, workspaceRoot: '/projA' });
  startTuiDetect({ runId: 'obs-ws-B', sessionId: 'ws-B', send: () => {}, intervalMs: 15, wcId: 0, workspaceRoot: '/projB' });
  startTuiDetect({ runId: 'obs-ws-none', sessionId: 'ws-none', send: () => {}, intervalMs: 15, wcId: 0, workspaceRoot: '' });
  // /projA window gets its own observer + the unscoped one (treated as global), but NOT the /projB observer.
  const ids = reattachWorkspace('/projA', () => () => {}, 303).sort();
  assert.deepEqual(ids, ['obs-ws-A', 'obs-ws-none']);
  const ids2 = reattachWorkspace('/projA', () => () => {}, 303);
  assert.deepEqual(ids2, [], 'a window already bound is not replayed again');
  stopTuiDetect('obs-ws-A');
  stopTuiDetect('obs-ws-B');
  stopTuiDetect('obs-ws-none');
});

test('observers are isolated by sessionId (no cross-talk on the shared bus)', async () => {
  const a = [];
  const b = [];
  startTuiDetect({ runId: 'observe-iso-A', sessionId: 'iso-A', send: (e) => a.push(e), intervalMs: 15 });
  startTuiDetect({ runId: 'observe-iso-B', sessionId: 'iso-B', send: (e) => b.push(e), intervalMs: 15 });
  ptyTap.publishData('iso-A', '● Write(only-a.txt)\r\n');
  await delay(40);
  assert.equal(a.some((e) => e.ev === 'node' && e.file === 'only-a.txt'), true);
  assert.equal(b.some((e) => e.ev === 'node' && e.file === 'only-a.txt'), false, 'session B never sees session A output');
  stopTuiDetect('observe-iso-A');
  stopTuiDetect('observe-iso-B');
});
