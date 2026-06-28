'use strict';
// OrPAD — PTY data-tap bus (decoupled seam between the terminal and the orchestration observer).
//
// The terminal owns the PTY (terminal/pty.js); the live-TUI observer (orchestration-core) needs to READ a
// session's output stream to reconstruct the rendered screen and detect tool calls — WITHOUT disturbing the
// terminal (no extra reads of the pty, no ownership change). This tiny singleton bus is the seam: pty.js
// PUBLISHES each chunk (and the exit) for a session id; the observer SUBSCRIBES by session id. Publishing is
// a no-op when nobody is listening (one Map lookup per chunk), so it costs nothing on un-observed sessions.

const taps = new Map(); // sessionId -> Set<{ onData?, onExit? }>

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
  const set = taps.get(String(sessionId || ''));
  if (!set) return;
  for (const h of [...set]) { try { h.onExit && h.onExit(); } catch (_) { /* best effort */ } }
}

function hasSubscribers(sessionId) { return taps.has(String(sessionId || '')); }

module.exports = { subscribe, publishData, publishExit, hasSubscribers };
