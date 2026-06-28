'use strict';
// OrPAD — live-TUI observer via PTY-stream parsing (the primary observe path).
//
// claude under ConPTY writes NO conversation log (proven), so log-tailing (tui-observer.cjs) can't see an
// interactive session. But the TUI RENDERS every tool call to the terminal, and OrPAD owns that PTY. This
// observer taps the session's PTY output (pty-tap bus), reconstructs the rendered screen (vt-grid), and runs
// the provider-agnostic detector (tui-detect) over it on a tick — emitting the SAME trace events the run
// graph already consumes (buildEmergentGraph), under an `observe-<id>` runId.
//
// LIFETIME is bound to the PTY SESSION, not the Run GUI window. The window is just a VIEW: closing it DETACHES
// (stops sending, keeps running + buffering); reopening REATTACHES and replays the accumulated event buffer so
// the graph re-syncs exactly where it left off. The observer is only truly stopped on PTY exit, explicit Stop,
// or app quit. Keyed by sessionId (+ a runId that stays stable across detach/reattach so events keep routing to
// the same graph). N concurrent sessions via the Maps.

const ptyTap = require('../terminal/pty-tap.cjs');
const { createVtGrid } = require('./vt-grid.cjs');
const { createTuiDetector } = require('./tui-detect.cjs');

const observers = new Map();  // runId -> handle
const bySession = new Map();  // sessionId -> handle

const DEFAULT_INTERVAL_MS = 600;
const BUFFER_CAP = 20000;     // events kept for replay on reattach (far above a realistic session's node count)
const NOOP = () => {};

function startTuiDetect({ runId, sessionId, agent = 'claude', send, cols, rows, intervalMs, workspaceRoot = '', wcId = 0 } = {}) {
  if (!runId || !sessionId || typeof send !== 'function') return null;
  if (bySession.has(String(sessionId))) return bySession.get(String(sessionId)); // one observer per session
  if (observers.has(runId)) return observers.get(runId);

  const grid = createVtGrid(Number(rows) || 40, Number(cols) || 120);
  const det = createTuiDetector();
  let closed = false;
  let timer = null;
  let unsubscribe = NOOP;

  const handle = {
    runId, sessionId: String(sessionId), agent, workspaceRoot: String(workspaceRoot || ''),
    send, boundWcId: wcId, buffer: [],
    get closed() { return closed; },
    stop,
  };

  // Emit: buffer the event (for replay on reattach) AND send to the currently-bound window (if any).
  const emit = (ev) => {
    handle.buffer.push(ev);
    if (handle.buffer.length > BUFFER_CAP) handle.buffer.splice(0, handle.buffer.length - BUFFER_CAP);
    const s = handle.send;
    if (s && s !== NOOP) { try { s(ev); } catch (_) { /* window gone — stays buffered for reattach */ } }
  };

  const flush = () => {
    if (closed) return;
    let evs; try { evs = det.ingest(grid.lines()); } catch (_) { evs = []; }
    for (const ev of evs) emit({ ...ev });
  };
  function flushFinal() {
    let evs; try { evs = det.ingest(grid.lines()); } catch (_) { evs = []; }
    for (const ev of evs) emit({ ...ev });
    try { for (const ev of det.finish()) emit({ ...ev }); } catch (_) { /* ignore */ }
  }
  function stop() {
    if (closed) return false;
    closed = true;
    if (timer) clearInterval(timer);
    try { unsubscribe(); } catch (_) { /* best effort */ }
    flushFinal();
    observers.delete(runId);
    bySession.delete(handle.sessionId);
    return true;
  }

  observers.set(runId, handle);
  bySession.set(handle.sessionId, handle);

  emit({ ev: 'run', state: 'start', continued: false, observe: true, agent, goal: `Live ${agent} (TUI)` });
  emit({ ev: 'notice', text: `Observing ${agent} in the terminal (read-only) — the graph builds from the rendered screen. Governance options are advisory only; the CLI works directly in your workspace.` });

  unsubscribe = ptyTap.subscribe(handle.sessionId, {
    onData: (chunk) => { try { grid.write(chunk); } catch (_) { /* malformed chunk never breaks the tap */ } },
    onExit: () => { stop(); }, // PTY session ended → the observer's job is done
  });
  timer = setInterval(flush, Number(intervalMs) > 0 ? Number(intervalMs) : DEFAULT_INTERVAL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();

  return handle;
}

// A window bound to `runId` was closed: stop sending to it, but keep the observer ALIVE (it keeps detecting +
// buffering) so a reopened window can replay. Does NOT stop the observer.
function detachWindow(wcId) {
  for (const h of observers.values()) {
    if (h.boundWcId === wcId) { h.send = NOOP; h.boundWcId = 0; }
  }
}

function findBySession(sessionId) { return bySession.get(String(sessionId || '')) || null; }

// Re-bind a single observer to a (re)opened window and replay its buffer so the graph re-syncs.
function reattach(runId, send, wcId = 0) {
  const h = observers.get(String(runId || ''));
  if (!h || h.closed || typeof send !== 'function') return false;
  h.send = send;
  h.boundWcId = wcId;
  for (const ev of h.buffer) { try { send(ev); } catch (_) { /* ignore */ } }
  return true;
}

// On a plain Run GUI reopen (no fresh seed), re-bind EVERY live observer for this workspace to the window and
// replay their buffers. makeSend(runId) returns the per-observer send (tags events with that runId).
function reattachWorkspace(workspaceRoot, makeSend, wcId = 0) {
  const root = String(workspaceRoot || '');
  const runIds = [];
  for (const h of observers.values()) {
    if (h.closed) continue;
    if (h.boundWcId === wcId) continue; // already bound to this window — don't replay twice
    // Match same workspace; treat an UNSCOPED observer ('') as global so it still reattaches (better to show a
    // graph than to hide it on a workspace-root mismatch — the cross-project concern is rare + advisory only).
    if (root && h.workspaceRoot && h.workspaceRoot !== root) continue;
    const send = makeSend(h.runId);
    if (typeof send !== 'function') continue;
    h.send = send;
    h.boundWcId = wcId;
    for (const ev of h.buffer) { try { send(ev); } catch (_) { /* ignore */ } }
    runIds.push(h.runId);
  }
  return runIds;
}

function stopTuiDetect(runId) {
  const h = observers.get(String(runId || ''));
  return h ? h.stop() : false;
}

function stopAllTuiDetect() {
  for (const h of [...observers.values()]) { try { h.stop(); } catch (_) { /* ignore */ } }
}

module.exports = {
  startTuiDetect, stopTuiDetect, stopAllTuiDetect, observers,
  detachWindow, findBySession, reattach, reattachWorkspace,
};
