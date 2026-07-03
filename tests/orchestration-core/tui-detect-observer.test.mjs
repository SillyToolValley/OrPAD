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

  const actives = events.filter((e) => e.ev === 'node' && e.state === 'active' && !e.transient);
  assert.deepEqual(actives.map((a) => a.type), ['inspect', 'exec', 'edit'], 'read → bash → write, summary/prose skipped');
  assert.equal(actives[0].file, 'note.txt');
  assert.match(actives[1].label, /echo LIVE_OK/);
  assert.equal(actives[2].file, 'out.txt');
  // every observed event carries a timestamp
  assert.ok(events.filter((e) => e.ev === 'node').every((e) => typeof e.at === 'number' && e.at > 0), 'node events are timestamped');

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

test('a session exit (pty onExit → bus) closes the observed run but RETAINS it for later replay', async () => {
  const events = [];
  const runId = 'observe-test-B';
  const sessionId = 'sess-B';
  startTuiDetect({ runId, sessionId, agent: 'claude', send: (e) => events.push(e), intervalMs: 15 });
  ptyTap.publishData(sessionId, '● Bash(npm test)\r\n');
  await delay(40);
  assert.equal(events.some((e) => e.ev === 'node' && e.type === 'exec'), true);

  ptyTap.publishExit(sessionId); // terminal closed
  assert.equal(events.filter((e) => e.ev === 'run' && e.state === 'done').length, 1);
  // FINISHED, not deleted: observe events are never written to disk, so the buffer is retained — a window
  // opened AFTER the CLI exited can still replay the whole session graph.
  assert.equal(observers.has(runId), true, 'finished handle retained for replay');
  const h = findBySession(sessionId);
  assert.ok(h && h.finished === true, 'handle is in the finished state');

  // A late-opened window replays the finished run — run/start FIRST (the renderer reset), run/done last.
  const late = [];
  assert.equal(reattach(runId, (e) => late.push(e), 505), true);
  assert.equal(late[0].ev, 'run');
  assert.equal(late[0].state, 'start');
  assert.equal(late.some((e) => e.ev === 'node' && e.type === 'exec'), true, 'the session graph replays after exit');
  assert.equal(late[late.length - 1].ev, 'run');
  assert.equal(late[late.length - 1].state, 'done');

  // Explicit stop truly frees the retained handle (and its buffer).
  assert.equal(stopTuiDetect(runId), true);
  assert.equal(observers.has(runId), false);
  assert.equal(findBySession(sessionId), null);
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

test('multicast: a second window binds WITHOUT stealing the first; detach removes only its own binding', async () => {
  const a = [];
  const b = [];
  const runId = 'observe-multi';
  const sessionId = 'sess-MULTI';
  startTuiDetect({ runId, sessionId, agent: 'claude', send: (e) => a.push(e), intervalMs: 15, wcId: 1, workspaceRoot: '/ws-m' });
  ptyTap.publishData(sessionId, '● Read(first.txt)\r\n');
  await delay(45);
  assert.ok(a.some((e) => e.ev === 'node' && e.file === 'first.txt'));

  // Window 2 attaches: IT gets the buffer replay; window 1's live link is untouched (no steal, no re-replay).
  const aLen = a.length;
  assert.equal(reattach(runId, (e) => b.push(e), 2), true);
  assert.equal(a.length, aLen, 'the replay went ONLY to the newly-bound consumer');
  assert.ok(b.some((e) => e.ev === 'run' && e.state === 'start'));
  assert.ok(b.some((e) => e.ev === 'node' && e.file === 'first.txt'));

  // Live events now fan out to BOTH windows.
  ptyTap.publishData(sessionId, '● Write(second.txt)\r\n');
  await delay(45);
  assert.ok(a.some((e) => e.ev === 'node' && e.file === 'second.txt'), 'window 1 still live after window 2 bound');
  assert.ok(b.some((e) => e.ev === 'node' && e.file === 'second.txt'), 'window 2 live too');

  // Closing window 2 detaches only ITS binding; window 1 keeps streaming.
  detachWindow(2);
  const bLen = b.length;
  ptyTap.publishData(sessionId, '● Bash(npm run build)\r\n');
  await delay(45);
  assert.equal(b.length, bLen, 'the detached window receives nothing');
  assert.ok(a.some((e) => e.ev === 'node' && e.label && /npm run build/.test(e.label)), 'the other window still does');
  stopTuiDetect(runId);
});

test('a renderer reload (SAME wcId) still replays on reattach — never skipped as already-bound', async () => {
  const first = [];
  const runId = 'observe-reload';
  const sessionId = 'sess-RELOAD';
  startTuiDetect({ runId, sessionId, agent: 'claude', send: (e) => first.push(e), intervalMs: 15, wcId: 77, workspaceRoot: '/ws-r' });
  ptyTap.publishData(sessionId, '● Write(pre-reload.txt)\r\n');
  await delay(45);
  assert.ok(first.some((e) => e.ev === 'node' && e.file === 'pre-reload.txt'));

  // Ctrl+R: the webContents id survives but ALL renderer state is gone — the replay must happen anyway,
  // and it must BEGIN with run/start (the renderer's reset mechanism, which makes the replay idempotent).
  const reloaded = [];
  assert.equal(reattach(runId, (e) => reloaded.push(e), 77), true);
  assert.equal(reloaded[0].ev, 'run');
  assert.equal(reloaded[0].state, 'start', 'replay begins with run/start');
  assert.ok(reloaded.some((e) => e.ev === 'node' && e.file === 'pre-reload.txt'), 'the graph is rebuilt after reload');
  stopTuiDetect(runId);
});

test('reattachWorkspace: normalized workspace compare + always-replay (reload-safe), other workspaces excluded', () => {
  // Trailing slash on purpose: an exact-string compare would orphan this observer (Windows callers also
  // differ on case + separators; normalizeForCompare handles those there).
  startTuiDetect({ runId: 'obs-ws-A', sessionId: 'ws-A', send: () => {}, intervalMs: 15, wcId: 0, workspaceRoot: '/projA/' });
  startTuiDetect({ runId: 'obs-ws-B', sessionId: 'ws-B', send: () => {}, intervalMs: 15, wcId: 0, workspaceRoot: '/projB' });
  startTuiDetect({ runId: 'obs-ws-none', sessionId: 'ws-none', send: () => {}, intervalMs: 15, wcId: 0, workspaceRoot: '' });
  // /projA window gets its own observer + the unscoped one (treated as global), but NOT the /projB observer.
  const got = new Map();
  const mk = (rid) => { const arr = []; got.set(rid, arr); return (e) => arr.push(e); };
  const ids = reattachWorkspace('/projA', mk, 303).sort();
  assert.deepEqual(ids, ['obs-ws-A', 'obs-ws-none']);
  assert.equal(got.get('obs-ws-A')[0].ev, 'run');
  assert.equal(got.get('obs-ws-A')[0].state, 'start', 'the buffer replayed, run/start first');
  // A second reattach for the same window replays AGAIN — a reload keeps the wcId, and the replayed
  // run/start reset makes the repeat harmless. (The old skip-already-bound behavior froze reloads blank.)
  const ids2 = reattachWorkspace('/projA', () => () => {}, 303).sort();
  assert.deepEqual(ids2, ['obs-ws-A', 'obs-ws-none'], 'always-replay: never skipped as already-bound');
  stopTuiDetect('obs-ws-A');
  stopTuiDetect('obs-ws-B');
  stopTuiDetect('obs-ws-none');
});

test('run/start is PINNED outside the evictable buffer — replay still starts a run after total eviction', () => {
  const runId = 'observe-headpin';
  const sessionId = 'sess-HEAD';
  const h = startTuiDetect({ runId, sessionId, send: () => {}, intervalMs: 60000, wcId: 0 });
  // Simulate the 20000-cap's front-eviction at its worst: every buffered event evicted. The head events
  // (run/start + notice) live OUTSIDE the buffer, so the replayed run still starts (status active), instead
  // of reconstructing an orphan node stream with status 'inactive'.
  h.buffer.splice(0, h.buffer.length);
  const sink = [];
  assert.equal(reattach(runId, (e) => sink.push(e), 606), true);
  assert.equal(sink[0].ev, 'run');
  assert.equal(sink[0].state, 'start', 'pinned run/start prepended on replay');
  assert.equal(sink[1].ev, 'notice', 'pinned notice follows');
  stopTuiDetect(runId);
});

test('a live terminal resize reaches the observer grid — post-resize tool lines reconstruct at the new width', async () => {
  const events = [];
  const runId = 'observe-resize';
  const sessionId = 'sess-RESIZE';
  startTuiDetect({ runId, sessionId, send: (e) => events.push(e), cols: 30, rows: 8, intervalMs: 15 });
  // The terminal grows; pty.js publishes the resize on the tap bus; the grid must follow, or every
  // cursor-addressed repaint after this lands on wrong cells (garbled/truncated tool lines).
  ptyTap.publishResize(sessionId, 120, 10);
  ptyTap.publishData(sessionId, '● Write(a-really-long-file-name-that-needs-the-new-width.txt)\r\n');
  await delay(45);
  assert.ok(
    events.some((e) => e.ev === 'node' && e.file === 'a-really-long-file-name-that-needs-the-new-width.txt'),
    'the full-width tool line is intact after the live resize',
  );
  stopTuiDetect(runId);
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
