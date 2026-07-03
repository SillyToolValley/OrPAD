'use strict';
// OrPAD — live-TUI observer via PTY-stream parsing (the primary observe path).
//
// claude under ConPTY writes NO conversation log (proven), so log-tailing (tui-observer.cjs) can't see an
// interactive session. But the TUI RENDERS every tool call to the terminal, and OrPAD owns that PTY. This
// observer taps the session's PTY output (pty-tap bus), reconstructs the rendered screen (vt-grid), and runs
// the provider-agnostic detector (tui-detect) over it on a tick — emitting the SAME trace events the run
// graph already consumes (buildEmergentGraph), under an `observe-<id>` runId.
//
// LIFETIME is bound to the PTY SESSION, not any Run GUI window. Windows are just VIEWS — a handle keeps a
// MULTICAST map of bound consumers (wcId -> send), so several Run GUI windows can watch one session at once:
//   • closing a window DETACHES that one binding (the observer keeps running + buffering, even at zero);
//   • (re)opening a window REATTACHES it and ALWAYS replays the buffer TO THAT window — a Ctrl+R reload keeps
//     the same wcId, so "already bound" must never skip the replay. Replay idempotency lives in the renderer:
//     every replay starts with the PINNED run/start head event, which resets that run's entry.
//   • run/start (+ the initial notice) are pinned in `head`, never evicted by the buffer cap, so a very long
//     session still replays as a run that STARTS (status active), not an orphan node stream.
// PTY exit FINISHES the observer (tap + timer released, final flush once) but RETAINS the buffer so a window
// opened after the CLI exited can still replay the whole session graph (bounded: the oldest finished buffers
// per workspace are evicted beyond a small cap). Only explicit Stop / app quit truly frees a handle. Keyed by
// sessionId (+ a runId that stays stable across detach/reattach). N concurrent sessions via the Maps.

const ptyTap = require('../terminal/pty-tap.cjs');
const { createVtGrid } = require('./vt-grid.cjs');
const { createTuiDetector } = require('./tui-detect.cjs');
const { normalizeForCompare } = require('../authority.js');

const observers = new Map();  // runId -> handle (live + finished-retained)
const bySession = new Map();  // sessionId -> handle
const finishedOrder = [];     // finished handles, oldest first (drives per-workspace eviction)

const DEFAULT_INTERVAL_MS = 600;
const BUFFER_CAP = 20000;     // events kept for replay on reattach (far above a realistic session's node count)
const FINISHED_RETAIN_PER_WORKSPACE = 8; // finished-session buffers kept around per workspace

// Windows callers hand the same workspace around with differing case/separators — an exact string compare
// would silently orphan observers (reattach never matches). Normalize like the authority layer does.
function sameWorkspace(a, b) {
  return normalizeForCompare(String(a || '')) === normalizeForCompare(String(b || ''));
}

function retainFinished(handle) {
  finishedOrder.push(handle);
  const same = finishedOrder.filter((h) => sameWorkspace(h.workspaceRoot, handle.workspaceRoot));
  while (same.length > FINISHED_RETAIN_PER_WORKSPACE) {
    const oldest = same.shift();
    try { oldest.stop(); } catch (_) { /* ignore */ }
  }
}

function startTuiDetect({ runId, sessionId, agent = 'claude', send, cols, rows, intervalMs, workspaceRoot = '', wcId = 0 } = {}) {
  if (!runId || !sessionId || typeof send !== 'function') return null;
  if (bySession.has(String(sessionId))) return bySession.get(String(sessionId)); // one observer per session
  if (observers.has(runId)) return observers.get(runId);

  const grid = createVtGrid(Number(rows) || 40, Number(cols) || 120);
  const det = createTuiDetector();
  let closed = false;
  let finished = false;
  let flushedFinal = false;
  let timer = null;
  let unsubscribe = () => {};

  const handle = {
    runId, sessionId: String(sessionId), agent, workspaceRoot: String(workspaceRoot || ''),
    consumers: new Map(), // wcId -> sendFn — EVERY bound Run GUI window gets live events (multicast)
    head: [],   // pinned head events (run/start + notice): never evicted, prepended on every replay so a
                // replayed buffer always BEGINS with run/start (the renderer's reset signal)
    buffer: [], // rolling replay buffer (front-evicts beyond BUFFER_CAP; head events stay pinned above)
    get closed() { return closed; },
    get finished() { return finished; },
    stop,
    replayTo,
  };

  const fanOut = (ev) => {
    for (const s of handle.consumers.values()) { try { s(ev); } catch (_) { /* window gone — stays buffered */ } }
  };
  // Emit: buffer the event (for replay on reattach) AND send to every currently-bound window.
  const emit = (ev) => {
    handle.buffer.push(ev);
    if (handle.buffer.length > BUFFER_CAP) handle.buffer.splice(0, handle.buffer.length - BUFFER_CAP);
    fanOut(ev);
  };
  const emitHead = (ev) => { handle.head.push(ev); fanOut(ev); };

  // Replay the whole accumulated graph TO ONE consumer (head first — see the invariant above).
  function replayTo(sendFn) {
    if (typeof sendFn !== 'function') return;
    for (const ev of handle.head) { try { sendFn(ev); } catch (_) { /* ignore */ } }
    for (const ev of handle.buffer) { try { sendFn(ev); } catch (_) { /* ignore */ } }
  }

  const flush = () => {
    if (closed || finished) return;
    let evs; try { evs = det.ingest(grid.lines()); } catch (_) { evs = []; }
    for (const ev of evs) emit({ ...ev });
    // Idle-close: when the TUI sits at its input prompt (or the screen stopped changing) the last tool is
    // done — close the NODE (never the run) so it doesn't spin forever waiting for a next tool.
    let idle; try { idle = det.idleTick(grid.visibleLines()); } catch (_) { idle = []; }
    for (const ev of idle) emit({ ...ev });
  };
  function flushFinal() {
    if (flushedFinal) return; // runs ONCE (pty exit and a later explicit stop must not double-close the run)
    flushedFinal = true;
    let evs; try { evs = det.ingest(grid.lines()); } catch (_) { evs = []; }
    for (const ev of evs) emit({ ...ev });
    try { for (const ev of det.finish()) emit({ ...ev }); } catch (_) { /* ignore */ }
  }
  function release() {
    if (timer) { clearInterval(timer); timer = null; }
    try { unsubscribe(); } catch (_) { /* best effort */ }
    unsubscribe = () => {};
  }
  // PTY exit: observing is over, but RETAIN the handle + buffer so a window opened later can still replay the
  // session's graph (observe events are never written to disk — dropping the buffer would lose the whole run).
  function finish() {
    if (closed || finished) return;
    finished = true;
    release();
    flushFinal();
    retainFinished(handle);
  }
  // Explicit stop / quit / eviction: truly free everything.
  function stop() {
    if (closed) return false;
    closed = true;
    release();
    flushFinal();
    observers.delete(runId);
    bySession.delete(handle.sessionId);
    const fi = finishedOrder.indexOf(handle);
    if (fi >= 0) finishedOrder.splice(fi, 1);
    return true;
  }

  observers.set(runId, handle);
  bySession.set(handle.sessionId, handle);
  handle.consumers.set(wcId, send);

  emitHead({ ev: 'run', state: 'start', continued: false, observe: true, agent, goal: `Live ${agent} (TUI)`, at: Date.now() });
  emitHead({ ev: 'notice', text: `Observing ${agent} in the terminal (read-only) — the graph builds from the rendered screen. Governance options are advisory only; the CLI works directly in your workspace.`, at: Date.now() });

  unsubscribe = ptyTap.subscribe(handle.sessionId, {
    onData: (chunk) => { try { grid.write(chunk); } catch (_) { /* malformed chunk never breaks the tap */ } },
    // Track terminal resizes live — a stale geometry garbles every cursor-addressed repaint after the resize.
    onResize: (c, r) => { try { grid.resize(Number(c) || grid.cols, Number(r) || grid.rows); } catch (_) { /* ignore */ } },
    onExit: () => { finish(); }, // PTY session ended → finish (retain the buffer for late-opened windows)
  });
  timer = setInterval(flush, Number(intervalMs) > 0 ? Number(intervalMs) : DEFAULT_INTERVAL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();

  return handle;
}

// A window was closed: drop ITS binding from every handle. Observers keep running (and buffering) even when
// zero consumers remain — the window is just a view; only PTY exit / explicit Stop / quit ends an observer.
function detachWindow(wcId) {
  for (const h of observers.values()) h.consumers.delete(wcId);
}

function findBySession(sessionId) { return bySession.get(String(sessionId || '')) || null; }

// Bind ONE observer to a (re)opened window and ALWAYS replay its buffer to that window. Never skip on
// "already bound": a renderer reload (Ctrl+R) keeps the same wcId but lost all state — the replayed head
// run/start resets the entry renderer-side, so replaying twice is safe and replaying zero times is a blank
// graph forever.
function reattach(runId, send, wcId = 0) {
  const h = observers.get(String(runId || ''));
  if (!h || h.closed || typeof send !== 'function') return false;
  h.consumers.set(wcId, send);
  h.replayTo(send);
  return true;
}

// On a plain Run GUI (re)open (no fresh seed), bind EVERY observer for this workspace — live AND finished —
// to the window and replay each buffer to it. makeSend(runId) returns the per-observer send (tags events
// with that runId).
function reattachWorkspace(workspaceRoot, makeSend, wcId = 0) {
  const root = String(workspaceRoot || '');
  const runIds = [];
  for (const h of observers.values()) {
    if (h.closed) continue;
    // Match same workspace (case/separator-insensitively — Windows callers disagree on both); treat an
    // UNSCOPED observer ('') as global so it still reattaches (better to show a graph than to hide it on a
    // workspace-root mismatch — the cross-project concern is rare + advisory only).
    if (root && h.workspaceRoot && !sameWorkspace(h.workspaceRoot, root)) continue;
    const send = makeSend(h.runId);
    if (typeof send !== 'function') continue;
    h.consumers.set(wcId, send);
    h.replayTo(send); // ALWAYS replay — see reattach() (reload keeps the wcId)
    runIds.push(h.runId);
  }
  return runIds;
}

function stopTuiDetect(runId) {
  const h = observers.get(String(runId || ''));
  return h ? h.stop() : false;
}

// before-quit: truly free EVERYTHING, including retained finished buffers.
function stopAllTuiDetect() {
  for (const h of [...observers.values()]) { try { h.stop(); } catch (_) { /* ignore */ } }
  finishedOrder.length = 0;
}

module.exports = {
  startTuiDetect, stopTuiDetect, stopAllTuiDetect, observers,
  detachWindow, findBySession, reattach, reattachWorkspace,
};
