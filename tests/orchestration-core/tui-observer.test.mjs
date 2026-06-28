import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const observer = require(path.join(repoRoot, 'src/main/orchestration-core/tui-observer.cjs'));

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('slugForCwd matches the real Claude project-dir rule (each non-alphanumeric -> "-", case preserved)', () => {
  assert.equal(
    observer.slugForCwd('C:\\Users\\USER\\Documents\\GitHub\\OrPAD Worktree\\OrPad'),
    'C--Users-USER-Documents-GitHub-OrPAD-Worktree-OrPad',
  );
  assert.equal(observer.sessionDirForCwd('/home/u/proj', '/HOME'), path.join('/HOME', '.claude', 'projects', '-home-u-proj'));
});

test('newestJsonl returns the most-recently-modified .jsonl (ignoring non-jsonl)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-obs-newest-'));
  try {
    fs.writeFileSync(path.join(dir, 'old.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
    await delay(15);
    fs.writeFileSync(path.join(dir, 'new.jsonl'), '{}\n');
    const best = await observer.newestJsonl(dir);
    assert.ok(best);
    assert.equal(path.basename(best.path), 'new.jsonl');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scanLiveJsonl finds the newest actively-written session across project dirs, skipping orpad overlay dirs', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-obs-home-'));
  const proj = path.join(home, '.claude', 'projects');
  const mk = (d, f, body = '{}\n') => { fs.mkdirSync(path.join(proj, d), { recursive: true }); fs.writeFileSync(path.join(proj, d, f), body); };
  try {
    const since = Date.now();
    mk('C--proj-A', 'a.jsonl');
    mk('C--proj-B--orpad-core-runs-core-1-overlay', 'b.jsonl'); // an OrPAD governed-run session → must be skipped
    fs.utimesSync(path.join(proj, 'C--proj-B--orpad-core-runs-core-1-overlay', 'b.jsonl'), new Date(), new Date()); // make it newest
    const live = await observer.scanLiveJsonl(since - 5000, home);
    assert.ok(live, 'found a live session');
    assert.equal(path.basename(path.dirname(live.path)), 'C--proj-A', 'picks the real session, not the orpad overlay one');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('scanCreatedSince returns the just-created session log (newest birthtime), skipping orpad overlay dirs', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-obs-created-'));
  const proj = path.join(home, '.claude', 'projects');
  const mk = (d, f) => { fs.mkdirSync(path.join(proj, d), { recursive: true }); fs.writeFileSync(path.join(proj, d, f), '{}\n'); };
  try {
    mk('C--projA', 'a.jsonl');
    mk('C--projB--orpad-core-runs-core-1-overlay', 'b.jsonl'); // overlay → must be skipped even if newest
    await delay(20);
    mk('C--projC', 'c.jsonl'); // created last → newest birthtime among non-overlay
    const hit = await observer.scanCreatedSince(0, home);
    assert.ok(hit, 'found a created-since session');
    assert.equal(path.basename(path.dirname(hit.path)), 'C--projC', 'newest-created non-overlay session');
    // a future threshold → nothing created after it
    assert.equal(await observer.scanCreatedSince(Date.now() + 100000, home), null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('resolveSessionId maps a spawned PID -> real session id (and falls back to cwd + start-time)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-obs-resolve-'));
  const sdir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(sdir, { recursive: true });
  const now = Date.now();
  // claude registers sessions/<pid>.json on launch (real shape)
  fs.writeFileSync(path.join(sdir, '4242.json'), JSON.stringify({ pid: 4242, sessionId: 'sess-real-1', cwd: 'C:\\Work\\Proj', startedAt: now, kind: 'interactive' }));
  fs.writeFileSync(path.join(sdir, '777.json'), JSON.stringify({ pid: 777, sessionId: 'sess-old', cwd: 'C:\\Work\\Proj', startedAt: now - 600000 }));
  try {
    // by PID (preferred)
    assert.equal(await observer.resolveSessionId({ pid: 4242, home }), 'sess-real-1');
    // by cwd + recency (newest started since sinceMs), case/sep-insensitive
    assert.equal(await observer.resolveSessionId({ cwd: 'c:/work/proj', sinceMs: now - 1000, home }), 'sess-real-1');
    // an old session (started long before sinceMs) is NOT picked
    assert.equal(await observer.resolveSessionId({ cwd: 'C:\\Work\\Other', sinceMs: now, home }), null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('findSessionFileById locates <uuid>.jsonl in any project dir (deterministic, cwd-independent)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-obs-byid-'));
  const proj = path.join(home, '.claude', 'projects');
  const uuid = 'abcdef12-3456-7890-abcd-ef1234567890';
  fs.mkdirSync(path.join(proj, 'C--some-other-folder'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'C--some-other-folder', `${uuid}.jsonl`), '{}\n');
  try {
    const hit = await observer.findSessionFileById(uuid, home);
    assert.ok(hit, 'found the pinned session log regardless of which folder slug it lives under');
    assert.equal(path.basename(hit.path), `${uuid}.jsonl`);
    assert.equal(await observer.findSessionFileById('00000000-0000-0000-0000-000000000000', home), null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('startObserve tails an active session log and emits run/start, nodes, then run/done on stop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-obs-tail-'));
  const sess = path.join(dir, 'abc.jsonl');
  // an active session: created "now" so the observer locks onto it
  fs.writeFileSync(sess, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } })}\n`);
  const got = [];
  const send = (ev) => got.push(ev);
  try {
    observer.startObserve({ runId: 'observe-test', dir, agent: 'claude', send, intervalMs: 25, nowMs: Date.now() });
    await delay(120);
    // the agent acts: a tool_use then its result get appended to the log
    fs.appendFileSync(sess, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'x.js' } }] } })}\n`);
    fs.appendFileSync(sess, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] } })}\n`);
    await delay(150);
    assert.equal(observer.stopObserve('observe-test'), true);

    const kinds = got.map((e) => `${e.ev}:${e.state || ''}`);
    assert.ok(kinds.includes('run:start'), 'emits run/start');
    assert.ok(kinds.includes('run:done'), 'synthesizes run/done on stop');
    const nodeActive = got.find((e) => e.ev === 'node' && e.state === 'active' && e.toolId === 't1');
    assert.ok(nodeActive, 'translated the tool_use into a node');
    assert.equal(nodeActive.file, 'x.js');
    assert.ok(got.some((e) => e.ev === 'node' && e.state === 'done' && e.toolId === 't1'), 'translated the tool_result into node done');
    assert.ok(got.some((e) => e.ev === 'notice'), 'emits the advisory vault/verify notice');
  } finally {
    observer.stopObserve('observe-test');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startObserve with a pinned sessionId NEVER locks onto a different session, and locks once its own log appears', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-obs-pin-'));
  const proj = path.join(home, '.claude', 'projects');
  const otherDir = path.join(proj, 'C--other');
  fs.mkdirSync(otherDir, { recursive: true });
  // a DIFFERENT, actively-written session that the old heuristic would have grabbed
  fs.writeFileSync(path.join(otherDir, 'aaaaaaaa-0000-0000-0000-000000000000.jsonl'), `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } })}\n`);
  const pinned = 'deadbeef-0000-0000-0000-000000000000';
  const got = [];
  try {
    observer.startObserve({ runId: 'observe-pin', sessionId: pinned, cwd: 'C:/whatever', homeDir: home, send: (e) => got.push(e), intervalMs: 25, nowMs: Date.now() });
    await delay(150);
    // so far: the pinned log doesn't exist → must NOT have locked onto the other session
    assert.ok(!got.some((e) => e.ev === 'node'), 'no nodes from the unrelated session');
    assert.ok(!got.some((e) => e.ev === 'node'), 'no nodes from any session yet');
    assert.ok(!got.some((e) => e.ev === 'notice' && /Locked onto/.test(e.text || '')), 'did not lock onto the wrong session');
    // now the pinned session writes its log (first message)
    const ownDir = path.join(proj, 'C--mine');
    fs.mkdirSync(ownDir, { recursive: true });
    fs.writeFileSync(path.join(ownDir, `${pinned}.jsonl`), `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'm1', name: 'Read', input: { file_path: 'z.js' } }] } })}\n`);
    await delay(150);
    assert.ok(got.some((e) => e.ev === 'notice' && new RegExp(`Locked onto the claude session \\(${pinned}`).test(e.text || '')), 'locked onto the pinned session once its log appeared');
    assert.ok(got.some((e) => e.ev === 'node' && e.toolId === 'm1'), 'streamed the pinned session’s nodes');
  } finally { observer.stopObserve('observe-pin'); fs.rmSync(home, { recursive: true, force: true }); }
});

test('startObserve preserves multibyte UTF-8 when a character is split across read ticks (StringDecoder)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-obs-utf8-'));
  const sess = path.join(dir, 'u.jsonl');
  fs.writeFileSync(sess, ''); // empty active log; observer locks then tails growth
  const got = [];
  try {
    observer.startObserve({ runId: 'observe-utf8', dir, agent: 'claude', send: (e) => got.push(e), intervalMs: 20, nowMs: Date.now() });
    await delay(80); // lock onto the file (offset 0, empty)
    // a tool_use entry whose file path contains CJK; append it in two writes that SPLIT a multibyte char
    const line = `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: 'C:/项目/世界.js' } }] } })}\n`;
    const full = Buffer.from(line, 'utf8');
    let i = 0; while (i < full.length && full[i] < 0x80) i += 1; // first byte of the first multibyte char
    const splitAt = i + 1; // mid-multibyte-sequence split
    fs.appendFileSync(sess, full.subarray(0, splitAt));
    await delay(60); // a tick reads the partial bytes — the decoder must BUFFER, not emit U+FFFD
    fs.appendFileSync(sess, full.subarray(splitAt));
    await delay(80);
    const node = got.find((e) => e.ev === 'node' && e.state === 'active' && e.toolId === 'u1');
    assert.ok(node, 'the tool_use node was emitted');
    assert.equal(node.file, 'C:/项目/世界.js', 'multibyte path reconstructed intact across the tick boundary');
  } finally {
    observer.stopObserve('observe-utf8');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
