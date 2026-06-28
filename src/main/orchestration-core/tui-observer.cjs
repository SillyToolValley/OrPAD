'use strict';
// OrPAD orchestration-core — live TUI observer.
//
// OBSERVE a real interactive Claude Code TUI that the user drives in the terminal, and render its run as the
// SAME live graph OrPAD draws for its own headless delegations. We can't sandbox/verify an interactive
// session, so this is a VISUALISATION (+ advisory) layer: we tail Claude's on-disk session log
// (~/.claude/projects/<slug>/<sessionId>.jsonl), translate each appended entry via trace.sessionEntryToTrace,
// and emit trace events on the existing 'orpad-core-trace' channel under an `observe-*` runId so the renderer
// graph "just works". Supports N concurrent observers (one per session).
//
// No electron import — `send` (an event emitter to the renderer) is injected by the IPC layer. Testable.

const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { StringDecoder } = require('node:string_decoder');
const trace = require('./trace.cjs');

function nowIso() { return new Date().toISOString(); }

// Claude derives the per-project log dir from the cwd by replacing EACH non-alphanumeric char with '-'
// (case preserved). Verified against a real path:
//   C:\Users\USER\Documents\GitHub\OrPAD Worktree\OrPad  ->  C--Users-USER-Documents-GitHub-OrPAD-Worktree-OrPad
function slugForCwd(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}
function sessionDirForCwd(cwd, home = os.homedir()) {
  return path.join(home, '.claude', 'projects', slugForCwd(cwd));
}

// The newest *.jsonl in a project dir (by mtime), or null. Used to lock onto the active session log.
async function newestJsonl(dir) {
  let names;
  try { names = await fsp.readdir(dir); } catch (_) { return null; }
  let best = null;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const p = path.join(dir, name);
    const st = await fsp.stat(p).catch(() => null);
    if (st && st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { path: p, size: st.size, mtimeMs: st.mtimeMs };
  }
  return best;
}

function projectsRoot(home = os.homedir()) { return path.join(home, '.claude', 'projects'); }

// Deterministic lookup: find <sessionId>.jsonl in ANY project dir. Used when OrPAD launched claude with a
// pinned --session-id, so we lock onto EXACTLY that session's log regardless of cwd/slug.
async function findSessionFileById(sessionId, home = os.homedir()) {
  if (!sessionId) return null;
  const root = projectsRoot(home);
  const fname = `${sessionId}.jsonl`;
  let dirs;
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch (_) { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = path.join(root, d.name, fname);
    const st = await fsp.stat(p).catch(() => null);
    if (st && st.isFile()) return { path: p, size: st.size, mtimeMs: st.mtimeMs };
  }
  return null;
}

// Fallback when the cwd-derived dir doesn't match (claude's actual cwd ≠ what OrPAD thinks): scan ALL claude
// project dirs and return the newest *.jsonl modified at/after `sinceMs` — i.e., the session the user is
// ACTIVELY driving right now, wherever it lives. Skips OrPAD's own governed-run overlay dirs (which contain a
// claude log too) so we observe the user's real session, not a nested run.
async function scanLiveJsonl(sinceMs, home = os.homedir()) {
  const root = projectsRoot(home);
  let dirs;
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch (_) { return null; }
  let best = null;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    if (d.name.includes('--orpad-core-runs-')) continue; // skip governed-run overlay sessions
    const f = await newestJsonl(path.join(root, d.name));
    if (f && f.mtimeMs >= sinceMs && (!best || f.mtimeMs > best.mtimeMs)) best = f;
  }
  return best;
}

// The newest *.jsonl in a dir BY CREATION time (birthtime), or null.
async function newestCreatedJsonl(dir) {
  let names;
  try { names = await fsp.readdir(dir); } catch (_) { return null; }
  let best = null;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const st = await fsp.stat(path.join(dir, name)).catch(() => null);
    if (!st || !st.isFile()) continue;
    const birthtimeMs = st.birthtimeMs || st.ctimeMs || st.mtimeMs;
    if (!best || birthtimeMs > best.birthtimeMs) best = { path: path.join(dir, name), size: st.size, mtimeMs: st.mtimeMs, birthtimeMs };
  }
  return best;
}

// The just-launched session = the *.jsonl whose log file was CREATED at/after `sinceMs`, across all project
// dirs (skipping OrPAD overlay dirs). This uniquely identifies the claude OrPAD just opened: its log is brand
// new, while every other session's log (incl. the agent's own) was created earlier. cwd-independent + robust.
async function scanCreatedSince(sinceMs, home = os.homedir()) {
  const root = projectsRoot(home);
  let dirs;
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch (_) { return null; }
  let best = null;
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.includes('--orpad-core-runs-')) continue;
    const f = await newestCreatedJsonl(path.join(root, d.name));
    if (f && f.birthtimeMs >= sinceMs && (!best || f.birthtimeMs > best.birthtimeMs)) best = f;
  }
  return best;
}

function sessionsDir(home = os.homedir()) { return path.join(home, '.claude', 'sessions'); }
function normCwd(p) { return String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase(); }
async function readJsonSafe(p) { try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch (_) { return null; } }

// Resolve claude's REAL (auto-generated) session id. claude registers ~/.claude/sessions/<pid>.json with
// {pid, sessionId, cwd, startedAt, kind} as soon as it launches — so we map the spawned PID → its session id
// (preferred), falling back to the newest interactive session whose cwd matches and that started around when
// we began observing (the just-launched one). This lets us drop the log-suppressing --session-id flag.
async function resolveSessionId({ pid = null, cwd = '', sinceMs = 0, home = os.homedir() } = {}) {
  const dir = sessionsDir(home);
  if (pid) {
    const j = await readJsonSafe(path.join(dir, `${pid}.json`));
    if (j && j.sessionId) return j.sessionId;
  }
  let names;
  try { names = await fsp.readdir(dir); } catch (_) { return null; }
  const want = normCwd(cwd);
  let best = null;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const j = await readJsonSafe(path.join(dir, name));
    if (!j || !j.sessionId || !j.cwd) continue;
    if (want && normCwd(j.cwd) !== want) continue;
    const started = Number(j.startedAt) || 0;
    if (started < sinceMs - 5000) continue; // only a session launched around/after we started observing
    if (!best || started > best.started) best = { sessionId: j.sessionId, started };
  }
  return best ? best.sessionId : null;
}

const observers = new Map(); // runId -> state

// Start observing. `nowMs` is injected for testability (Date.now() in prod). Returns { runId }.
function startObserve({ runId, cwd, agent = 'claude', sessionId = null, pid = null, send = () => {}, intervalMs = 600, nowMs = Date.now(), dir = null, homeDir = os.homedir() }) {
  const projectDir = dir || sessionDirForCwd(cwd); // `dir` override for tests
  send({ ev: 'run', state: 'start', continued: false, observe: true, at: nowIso() });
  send({ ev: 'notice', level: 'info', text: (sessionId || pid)
    ? `Observing the ${agent} session OrPAD just launched (read-only). Type in that claude tab to see the graph grow.`
    : `Observing ${agent} session — searching for the active session log (read-only).`, at: nowIso() });
  const state = { runId, send, sessionId, explicitSession: !!sessionId, pid, cwd, projectDir, file: null, offset: 0, partial: '', decoder: new StringDecoder('utf8'), committed: false, stopped: false, startMs: nowMs, timer: null, misses: 0, warned: false };
  observers.set(runId, state);
  const relock = (file, size) => {
    state.file = file; state.offset = size; state.partial = ''; state.decoder = new StringDecoder('utf8');
  };
  const tick = async () => {
    if (state.stopped) return;
    try {
      if (!state.committed) {
        let pick = null;
        let viaFallback = false;
        if (state.explicitSession) {
          // Caller pinned an EXACT session id → only ever lock onto that one (never a heuristic).
          const f = await findSessionFileById(state.sessionId, homeDir);
          if (f) pick = { ...f, fromStart: true };
        } else if (state.pid || state.cwd) {
          // OrPAD launched this claude (no --session-id, so it logs live). Find it WITHOUT guessing slugs:
          // its conversation log is the one CREATED at/after we started observing (every other session's log —
          // incl. the agent's own — was created earlier). This is the robust signal.
          pick = await scanCreatedSince(state.startMs - 30000, homeDir); // window: claude may create the log a few s before Apply
          if (pick) pick = { ...pick, fromStart: true };
          // Precise shortcut: if claude has registered sessions/<pid>.json, lock by its real id.
          if (!pick) {
            const resolved = await resolveSessionId({ pid: state.pid, cwd: state.cwd, sinceMs: state.startMs, home: homeDir });
            if (resolved) { const f = await findSessionFileById(resolved, homeDir); if (f) pick = { ...f, fromStart: true }; }
          }
        } else {
          // No pinned target (manual observe): prefer the cwd dir, else the globally most-recently-written session.
          pick = await newestJsonl(projectDir);
          if (!pick || pick.mtimeMs < state.startMs - 15000) {
            const live = await scanLiveJsonl(state.startMs - 10000, homeDir);
            if (live) { pick = live; viaFallback = true; }
          }
          if (pick && !viaFallback && pick.mtimeMs < state.startMs - 15000) pick = null;
        }
        if (pick) {
          if (pick.path !== state.file) {
            relock(pick.path, pick.fromStart ? 0 : pick.size);
            const where = pick.fromStart ? ` (${path.basename(pick.path)})` : (viaFallback ? ` (in ${path.basename(path.dirname(pick.path))})` : '');
            send({ ev: 'notice', level: 'info', text: `Locked onto the claude session${where} — graphing its activity now.`, at: nowIso() });
          }
        } else {
          state.misses += 1;
          if (state.misses === 8 && !state.warned) {
            state.warned = true;
            const where = state.sessionId ? `session ${state.sessionId}`
              : (state.pid ? 'the claude OrPAD launched (its log appears once you send the first message in that tab)'
              : `${projectDir} and recently-active sessions`);
            send({ ev: 'notice', level: 'warn', text: `Waiting for the claude session log — none found yet for ${where}. Send a message in the claude tab OrPAD opened.`, at: nowIso() });
          }
        }
      }
      if (state.file) {
        const st = await fsp.stat(state.file).catch(() => null);
        if (st) {
          if (st.size < state.offset) { relock(state.file, 0); state.committed = false; } // truncated / rotated
          if (st.size > state.offset) {
            const fd = await fsp.open(state.file, 'r');
            let chunk;
            try {
              const len = st.size - state.offset;
              const buf = Buffer.alloc(len);
              const { bytesRead } = await fd.read(buf, 0, len, state.offset);
              state.offset += bytesRead; // advance by ACTUAL bytes read (not assumed size)
              chunk = bytesRead === len ? buf : buf.subarray(0, bytesRead);
            } finally { await fd.close(); }
            // StringDecoder buffers any trailing partial multibyte sequence across ticks (no U+FFFD corruption).
            state.partial += state.decoder.write(chunk);
            const lines = state.partial.split(/\r?\n/);
            state.partial = lines.pop() || ''; // keep the trailing incomplete line for next tick
            for (const line of lines) {
              const t = line.trim();
              if (!t) continue;
              // Pass null so each entry's OWN recorded timestamp flows through (not the tail wall-clock).
              for (const evt of trace.sessionEntryToTrace(t, null)) send(evt);
            }
            if (lines.length) state.committed = true; // real activity on this file — stop hunting for a newer one
          }
        }
      }
    } catch (_) { /* transient fs error — retry next tick */ }
    if (!state.stopped) state.timer = setTimeout(tick, intervalMs);
  };
  state.timer = setTimeout(tick, intervalMs);
  return { runId };
}

// Stop an observer and synthesize the terminal run/done (the session log has no result entry).
function stopObserve(runId) {
  const state = observers.get(runId);
  if (!state) return false;
  state.stopped = true;
  if (state.timer) clearTimeout(state.timer);
  observers.delete(runId);
  try { state.send({ ev: 'run', state: 'done', at: nowIso() }); } catch (_) { /* best effort */ }
  return true;
}

function stopAll() { for (const id of [...observers.keys()]) stopObserve(id); }

module.exports = { slugForCwd, sessionDirForCwd, newestJsonl, scanLiveJsonl, scanCreatedSince, findSessionFileById, resolveSessionId, projectsRoot, startObserve, stopObserve, stopAll, observers };
