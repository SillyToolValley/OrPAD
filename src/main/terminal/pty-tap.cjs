'use strict';
// OrPAD — PTY data-tap bus (decoupled seam between the terminal and the orchestration observer).
//
// The terminal owns the PTY (terminal/pty.js); the live-TUI observer (orchestration-core) needs to READ a
// session's output stream to reconstruct the rendered screen and detect tool calls — WITHOUT disturbing the
// terminal (no extra reads of the pty, no ownership change). This tiny singleton bus is the seam: pty.js
// PUBLISHES each chunk (and the exit) for a session id; the observer SUBSCRIBES by session id. Publishing is
// a no-op when nobody is listening (one Map lookup per chunk), so it costs nothing on un-observed sessions.

const taps = new Map(); // sessionId -> Set<{ onData?, onExit?, onResize? }>

// Liveness registry: lets the observer side ask whether a pty session still exists
// without owning a reference to the pty manager (observing an already-exited session
// would otherwise create a run that never emits and never finishes).
const alive = new Set(); // sessionId
function markAlive(sessionId) { const id = String(sessionId || ''); if (id) alive.add(id); }
function isAlive(sessionId) { return alive.has(String(sessionId || '')); }

function subscribe(sessionId, handlers) {
  const id = String(sessionId || '');
  if (!id || !handlers) return () => {};
  let set = taps.get(id);
  if (!set) { set = new Set(); taps.set(id, set); }
  set.add(handlers);
  return () => {
    const s = taps.get(id);
    if (!s) return;
    s.delete(handlers);
    if (!s.size) taps.delete(id);
  };
}

function publishData(sessionId, chunk) {
  const set = taps.get(String(sessionId || ''));
  if (!set) return;
  for (const h of set) { try { h.onData && h.onData(chunk); } catch (_) { /* a bad subscriber never breaks the pty */ } }
}

function publishExit(sessionId) {
  alive.delete(String(sessionId || ''));
  const set = taps.get(String(sessionId || ''));
  if (!set) return;
  for (const h of [...set]) { try { h.onExit && h.onExit(); } catch (_) { /* best effort */ } }
}

// The observer reconstructs the rendered screen on a fixed-size grid; without this signal a
// terminal resize after observe-start leaves the grid at the stale geometry and the TUI's
// cursor-addressed repaints land on wrong cells (garbled/missed tool lines).
function publishResize(sessionId, cols, rows) {
  const set = taps.get(String(sessionId || ''));
  if (!set) return;
  for (const h of set) { try { h.onResize && h.onResize(cols, rows); } catch (_) { /* best effort */ } }
}

function hasSubscribers(sessionId) { return taps.has(String(sessionId || '')); }

module.exports = { subscribe, publishData, publishExit, publishResize, hasSubscribers, markAlive, isAlive };
