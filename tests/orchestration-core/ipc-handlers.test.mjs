import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ipc = require(path.join(repoRoot, 'src/main/orchestration-core/ipc.cjs'));
const ptyTap = require(path.join(repoRoot, 'src/main/terminal/pty-tap.cjs'));

// Register the core IPC handlers against a FAKE ipcMain/authority so we can invoke them directly — exercises
// the renderer-facing contract (path containment, outcome persistence, continue guards) without electron or
// spawning a real agent (every assertion here hits a path that returns BEFORE delegation).
function harness(workspaceRoot) {
  const handlers = {};
  const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
  const authority = { getWorkspaceRoot: () => workspaceRoot, assertWorkspacePath: () => {} };
  ipc.registerCoreRunHandlers({ ipcMain, app: {}, authority });
  const ev = { sender: {} };
  return { call: (name, req) => handlers[name](ev, req), handlers };
}
function mkRun(workspaceRoot, runId, meta) {
  const base = path.join(workspaceRoot, '.orpad', 'core-runs', runId);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'meta.json'), JSON.stringify(meta || {}), 'utf8');
  return base;
}

test('run-continue: guards (message required, runId containment, overlay existence) before any delegation', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-cont-'));
  try {
    const { call } = harness(ws);
    mkRun(ws, 'core-1700000000000-bbb', { goal: 'g', agent: 'claude', sessionId: 's1' });

    // empty message -> refused
    assert.equal((await call('orpad-core-run-continue', { runId: 'core-1700000000000-bbb', message: '   ' })).ok, false);
    // traversal runId -> refused with the containment error
    const trav = await call('orpad-core-run-continue', { runId: '..\\..\\..\\evil', message: 'do it' });
    assert.equal(trav.ok, false);
    assert.equal(trav.error, 'Invalid runId.');
    // valid runId but no overlay dir -> refused (nothing to continue), still no agent spawned
    const noOverlay = await call('orpad-core-run-continue', { runId: 'core-1700000000000-bbb', message: 'do it' });
    assert.equal(noOverlay.ok, false);
    assert.match(noOverlay.error, /overlay no longer exists/);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// A Run-GUI-shaped harness: a REAL-enough webContents fake (id / isDestroyed / send / once) so the
// observe-start contract — including what streams back on the trace channel — can be asserted end to end.
function guiHarness(workspaceRoot, wcId = 42) {
  const handlers = {};
  const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
  const authority = { getWorkspaceRoot: () => workspaceRoot, assertWorkspacePath: () => {} };
  ipc.registerCoreRunHandlers({ ipcMain, app: {}, authority });
  const sent = [];
  const ev = { sender: { id: wcId, isDestroyed: () => false, send: (_ch, payload) => sent.push(payload), once: () => {} } };
  return { call: (name, req) => handlers[name](ev, req), sent };
}

test('observe-start: an already-exited session is REJECTED (structured error + an error row in the Run GUI)', async () => {
  const { call, sent } = guiHarness('C:/ws-obs-dead');
  const res = await call('orpad-core-observe-start', { sessionId: 'ipc-dead-1', agent: 'claude' });
  assert.equal(res.ok, false);
  assert.equal(res.deadSession, true, 'structured: the caller can tell WHY');
  assert.match(res.error, /already exited/);
  const err = sent.find((e) => e.ev === 'run' && e.state === 'error');
  assert.ok(err, 'the Run GUI is told why nothing appeared (no silent zombie run)');
  assert.equal(sent.some((e) => e.ev === 'run' && e.state === 'start'), false, 'no observer was started');
});

test('observe-start: stable runId + ALWAYS-replay on repeat calls (reload-safe), finished sessions still replay', async () => {
  const { call, sent } = guiHarness('C:/ws-obs-live');
  const sessionId = 'ipc-live-1';
  ptyTap.markAlive(sessionId);
  let runId = null;
  try {
    const a = await call('orpad-core-observe-start', { sessionId, agent: 'claude' });
    assert.equal(a.ok, true);
    runId = a.runId;
    assert.match(runId, /^observe-/);
    assert.equal(sent.filter((e) => e.ev === 'run' && e.state === 'start').length, 1);

    // The same window asks again (a Ctrl+R reload keeps the wcId): SAME runId, and the buffer replays —
    // the old "already bound → skip replay" behavior left reloaded windows permanently blank.
    const b = await call('orpad-core-observe-start', { sessionId, agent: 'claude' });
    assert.equal(b.ok, true);
    assert.equal(b.runId, runId, 'runId stays stable for a known session');
    assert.equal(sent.filter((e) => e.ev === 'run' && e.state === 'start').length, 2, 'the repeat call replayed');

    // The session exits: the run closes but stays replayable (retained finished handle).
    ptyTap.publishExit(sessionId);
    assert.equal(sent.filter((e) => e.ev === 'run' && e.state === 'done').length, 1);
    const c = await call('orpad-core-observe-start', { sessionId, agent: 'claude' });
    assert.equal(c.ok, true);
    assert.equal(c.runId, runId);
    assert.equal(sent.filter((e) => e.ev === 'run' && e.state === 'start').length, 3, 'a finished session still replays (not a dead-session error)');
  } finally {
    if (runId) await call('orpad-core-observe-stop', { runId });
  }
});

test('list-runs: labels each run by goal/agent/vault and only lists runs with a non-empty trace', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-list-'));
  try {
    const { call } = harness(ws);
    const base = mkRun(ws, 'core-1700000000001-ccc', { goal: 'build a thing', agent: 'claude', vault: true });
    // a run with no trace must NOT be listed
    mkRun(ws, 'core-1700000000002-ddd', { goal: 'no trace', agent: 'claude' });
    // list-runs only reports a run that has a non-empty trace.jsonl
    const runDir = path.join(base, 'run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'trace.jsonl'), '{"ev":"run","state":"done"}\n', 'utf8');

    const res = await call('orpad-core-list-runs', {});
    assert.equal(res.ok, true);
    const row = res.runs.find((r) => r.runId === 'core-1700000000001-ccc');
    assert.ok(row, 'the run with a trace is listed');
    assert.equal(row.goal, 'build a thing');
    assert.equal(row.agent, 'claude');
    assert.equal(row.vault, true);
    assert.equal(res.runs.find((r) => r.runId === 'core-1700000000002-ddd'), undefined, 'a traceless run is not listed');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});
