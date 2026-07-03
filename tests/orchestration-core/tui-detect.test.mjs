import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { createTuiDetector, matchToolLine, verbToType } = require(path.join(repoRoot, 'src/main/orchestration-core/tui-detect.cjs'));

// Exact lines captured from a real claude TUI (default fullscreen) doing read → bash → write, after
// reconstructing the rendered screen. The detector turns these into the ontology's node events.
const CAPTURED = [
  '⏵⏵ bypass permissions on (shift+tab to cycle)',
  "● I'll do the three steps in order.",
  '● Reading 1 file…',
  '⎿ note.txt',
  '● Reading 1 file, running 1 shell command…',
  '⎿ $ echo HELLO_42',
  '● Write(out.txt)',
  '⎿ Wrote 1 lines to out.txt',
  '● All three steps done:',
  '1. Read note.txt — contents: SECRET_VALUE_777',
];

test('matchToolLine maps the real claude tool markers to the ontology (and skips prose/summary bullets)', () => {
  const read = matchToolLine('⎿ note.txt');
  assert.deepEqual([read.type, read.name, read.file], ['inspect', 'Read', 'note.txt']);
  const bash = matchToolLine('⎿ $ echo HELLO_42');
  assert.equal(bash.type, 'exec'); assert.match(bash.label, /echo HELLO_42/);
  const write = matchToolLine('● Write(out.txt)');
  assert.deepEqual([write.type, write.name, write.file], ['edit', 'Write', 'out.txt']);
  // targets that themselves contain parens (Windows paths, quoted shell) must NOT truncate at the first ')'
  const winpath = matchToolLine('● Write(C:\\Program Files (x86)\\out.txt)');
  assert.equal(winpath.file, 'C:\\Program Files (x86)\\out.txt');
  const quoted = matchToolLine("● Bash(echo '(hi)')");
  assert.match(quoted.label, /echo '\(hi\)'/);
  // the SUMMARY bullet (batches tools) and prose bullets must NOT become nodes
  assert.equal(matchToolLine('● Reading 1 file, running 1 shell command…'), null);
  assert.equal(matchToolLine("● I'll do the three steps in order."), null);
  assert.equal(matchToolLine('● All three steps done:'), null);
});

test('createTuiDetector turns a captured screen into 3 distinct tool nodes (read, bash, write), deduped', () => {
  const det = createTuiDetector();
  const events = det.ingest(CAPTURED);
  const actives = events.filter((e) => e.ev === 'node' && e.state === 'active' && !e.transient);
  assert.equal(actives.length, 3, 'exactly the 3 real tools (no summary noise)');
  assert.deepEqual(actives.map((a) => a.type), ['inspect', 'exec', 'edit']);
  assert.equal(actives[0].file, 'note.txt');
  assert.match(actives[1].label, /echo HELLO_42/);
  assert.equal(actives[2].file, 'out.txt');
  // prose bullets ("● I'll do…", "● All three steps done:") become TRANSIENT Responds, never tool nodes
  const prose = events.filter((e) => e.ev === 'node' && e.state === 'active' && e.transient);
  assert.equal(prose.length, 2, 'the two prose bullets are transient Responds');
  assert.ok(prose.every((p) => p.type === 'reason' && p.label === 'Respond' && p.toolId === null));
  // each new tool closes the previous (active -> done chain) so the graph links in execution order
  // (2 tool-chain closes + the final prose bullet closing the Write)
  assert.equal(events.filter((e) => e.ev === 'node' && e.state === 'done').length, 3);
  // every event carries a timestamp
  assert.ok(events.every((e) => typeof e.at === 'number' && e.at > 0), 'events are timestamped');

  // INCREMENTAL: re-ingesting the same screen (TUI repaint) yields NO new events (dedup by signature)
  assert.equal(det.ingest(CAPTURED).length, 0, 'repaints do not duplicate nodes');

  // a later screen with a NEW tool appends just that one
  const more = det.ingest([...CAPTURED, '● Bash(npm test)']);
  const newActives = more.filter((e) => e.ev === 'node' && e.state === 'active');
  assert.equal(newActives.length, 1);
  assert.equal(newActives[0].type, 'exec');
});

// Exact lines captured from a real Codex CLI TUI doing read(via shell) → bash → write. Codex uses "•" bullets
// with verbs (Ran/Running/Added), reads files via the shell, and writes show as "Added <file> (+N -M)".
const CODEX = [
  "• I'll do these in the requested order: read data.txt, run the echo command, then write out.txt.",
  '• Starting MCP servers (8/9): unity-ai-4f5b8991161d (39s • esc to interrupt)',
  '• Ran Get-Content -LiteralPath .\\data.txt',
  '└ CODEX_SECRET_42',
  '• Running echo CODEX_OK',
  '• Ran echo CODEX_OK',
  '└ CODEX_OK',
  '• Added out.txt (+1 -0)',
  '• Done. data.txt contained CODEX_SECRET_42, echo CODEX_OK returned CODEX_OK, and out.txt now contains FIN.',
];

test('matchToolLine maps the Codex TUI markers (and skips its prose/spinner bullets)', () => {
  const read = matchToolLine('• Ran Get-Content -LiteralPath .\\data.txt');
  assert.equal(read.type, 'inspect'); assert.match(read.label, /Get-Content/); // codex reads via the shell
  const bash = matchToolLine('• Ran echo CODEX_OK');
  assert.equal(bash.type, 'exec'); assert.match(bash.label, /echo CODEX_OK/);
  const write = matchToolLine('• Added out.txt (+1 -0)');
  assert.deepEqual([write.type, write.file], ['edit', 'out.txt']);
  // prose / spinner / progress bullets must NOT become nodes
  assert.equal(matchToolLine("• I'll do these in the requested order: read data.txt, …"), null);
  assert.equal(matchToolLine('• Done. data.txt contained CODEX_SECRET_42 …'), null);
  assert.equal(matchToolLine('• Working (14s • esc to interrupt)'), null);
  assert.equal(matchToolLine('• Starting MCP servers (8/9): unity-ai (39s • esc to interrupt)'), null);
});

test('codex rule 6: prose that starts with a write-verb is NOT a write; space-containing paths survive', () => {
  // "Added <prose>" used to create a phantom Write node labeled "error" — must fall through as prose now.
  assert.equal(matchToolLine('• Added error handling to the parser'), null);
  assert.equal(matchToolLine('• Updated the tests to cover the new case'), null);
  // Prose that merely MENTIONS a path is still prose: the remainder has spaces and is NOT filesystem-anchored,
  // so it must NOT become a Write node with a sentence-long "file" value.
  assert.equal(matchToolLine('• Added error handling to src/parser.js'), null);
  assert.equal(matchToolLine('• Updated Plan'), null);
  // A FILESYSTEM-ANCHORED path with SPACES must not truncate at the first space (and the trailing diffstat is
  // stripped). Drive-anchored ("C:\…") …
  const spacey = matchToolLine('• Added C:\\My Project\\file.ts (+3 -1)');
  assert.deepEqual([spacey.type, spacey.name, spacey.file], ['edit', 'Write', 'C:\\My Project\\file.ts']);
  // … and relative-prefix-anchored ("./…") both survive with their spaces intact.
  const rel = matchToolLine('• Edited ./src/app with spaces/main file.js');
  assert.equal(rel.file, './src/app with spaces/main file.js');
});

test('createTuiDetector turns a Codex screen into 3 deduped nodes (read → bash → write)', () => {
  const det = createTuiDetector();
  const actives = det.ingest(CODEX).filter((e) => e.ev === 'node' && e.state === 'active');
  assert.deepEqual(actives.map((a) => a.type), ['inspect', 'exec', 'edit'], 'Running+Ran for one cmd dedupe to one node');
  assert.equal(actives[2].file, 'out.txt');
});

test('verbToType matches the OrPAD ontology (provider-agnostic)', () => {
  assert.equal(verbToType('Reading'), 'inspect');
  assert.equal(verbToType('Write'), 'edit');
  assert.equal(verbToType('Bash'), 'exec');
  assert.equal(verbToType('WebSearch'), 'research');
  assert.equal(verbToType('Task'), 'subagent');
});

test('dedup allows a GENUINE re-run to re-emit after ≥3 other detections; repaints stay rock solid', () => {
  const det = createTuiDetector();
  const base = ['⎿ $ npm test'];
  let evs = det.ingest(base);
  assert.equal(evs.filter((e) => e.ev === 'node' && e.state === 'active').length, 1);
  // repaint: the SAME rendered line re-presented every tick → never re-emits
  assert.equal(det.ingest(base).length, 0);
  assert.equal(det.ingest(base).length, 0);
  // three other tools happen; the old line is still on screen (scrollback) → still deduped
  const grown = [...base, '● Read(a.txt)', '● Write(b.txt)', '● Bash(lint)'];
  evs = det.ingest(grown);
  assert.equal(evs.filter((e) => e.ev === 'node' && e.state === 'active').length, 3);
  assert.equal(det.ingest(grown).length, 0, 'still a repaint — no re-emission without a NEW occurrence');
  // the command RE-RUNS (a new line appears below the old one) → re-emits exactly once
  const rerun = [...grown, '⎿ $ npm test'];
  evs = det.ingest(rerun);
  const actives = evs.filter((e) => e.ev === 'node' && e.state === 'active');
  assert.equal(actives.length, 1, 'the genuine repeat counts again');
  assert.match(actives[0].label, /npm test/);
  // …and the re-emitted line's repaints are deduped again
  assert.equal(det.ingest(rerun).length, 0);
});

test('dedup absorbs a too-fast repeat (adjacent Running/Ran pairs and archive echoes never double-count)', () => {
  const det = createTuiDetector();
  det.ingest(['⎿ $ npm test']);
  // The same signature reappears with only ONE other detection since — absorbed, not re-emitted.
  const evs = det.ingest(['⎿ $ npm test', '● Read(a.txt)', '⎿ $ npm test']);
  const actives = evs.filter((e) => e.ev === 'node' && e.state === 'active');
  assert.equal(actives.length, 1, 'only the Read is new');
  assert.equal(actives[0].type, 'inspect');
});

test('dedup absorbs a full-transcript repaint STORM (many sigs grow at once); a lone genuine re-run still re-emits', () => {
  const det = createTuiDetector();
  // Emit 4 distinct tools (advancing the recency clock to 4).
  const base = ['● Read(a.txt)', '● Write(b.txt)', '● Bash(one)', '● Bash(two)'];
  let evs = det.ingest(base);
  assert.equal(evs.filter((e) => e.ev === 'node' && e.state === 'active').length, 4);
  // A transcript redraw (clear + repaint) re-presents EVERY line, so many already-seen sigs grow their
  // occurrence count in ONE tick. A genuine re-run grows exactly one — several growing together is a repaint,
  // so ALL growth that tick is absorbed (counts recorded, nothing re-emitted).
  const doubled = [...base, ...base];
  assert.equal(det.ingest(doubled).length, 0, 'repaint storm: zero re-emissions even though 4 sigs grew');
  // The absorbed counts were recorded, so a plain repaint of the doubled screen stays silent too.
  assert.equal(det.ingest(doubled).length, 0);
  // Now only ONE sig grows — a real re-run of the first tool (Read a.txt), whose last emission is ≥3 detections
  // back — so it is NOT a storm and re-emits exactly once.
  evs = det.ingest([...doubled, '● Read(a.txt)']);
  const actives = evs.filter((e) => e.ev === 'node' && e.state === 'active');
  assert.equal(actives.length, 1, 'a lone growth after the storm is a genuine re-run → exactly one re-emission');
  assert.equal(actives[0].type, 'inspect');
  assert.match(actives[0].label, /a\.txt/);
});

test('idleTick closes the open node at an idle prompt / static screen — never mid-tool, never the run', () => {
  const det = createTuiDetector();
  det.ingest(['⎿ $ npm test']);
  // a spinner / "esc to interrupt" on the visible screen = still working → never close
  assert.deepEqual(det.idleTick(['⎿ $ npm test', '✳ Running… (3s · esc to interrupt)']), []);
  assert.deepEqual(det.idleTick(['⎿ $ npm test', '⠙ thinking']), []);
  // the idle input prompt is back (and no spinner) → close the NODE (the run stays open)
  const evs = det.idleTick(['⎿ $ npm test', '❯', '⏵⏵ bypass permissions on (shift+tab to cycle)']);
  assert.equal(evs.length, 1);
  assert.deepEqual([evs[0].ev, evs[0].state], ['node', 'done']);
  assert.ok(evs.every((e) => e.ev !== 'run'), 'idle close never ends the run');
  // idle again with nothing open → no-op
  assert.deepEqual(det.idleTick(['❯']), []);
  // a subsequent detection opens the next node normally (no stray done first)
  const next = det.ingest(['⎿ $ npm test', '● Write(x.txt)']);
  assert.equal(next.filter((e) => e.state === 'done').length, 0);
  assert.equal(next.filter((e) => e.state === 'active').length, 1);

  // static-screen fallback (codex has no trusted idle marker): unchanged for 3 ticks + no spinner → close
  const det2 = createTuiDetector();
  det2.ingest(['⎿ $ sleep 100']);
  const vis = ['⎿ $ sleep 100', 'some output'];
  assert.deepEqual(det2.idleTick(vis), []); // records the signature
  assert.deepEqual(det2.idleTick(vis), []); // unchanged ×1
  assert.deepEqual(det2.idleTick(vis), []); // unchanged ×2
  const closed = det2.idleTick(vis);        // unchanged ×3 → close
  assert.equal(closed.length, 1);
  assert.equal(closed[0].state, 'done');
  // …but a static screen WITH a busy marker never closes (long quiet builds keep spinning)
  const det3 = createTuiDetector();
  det3.ingest(['⎿ $ npm run build']);
  const busy = ['⎿ $ npm run build', '✳ Building… (94s · esc to interrupt)'];
  for (let i = 0; i < 6; i += 1) assert.deepEqual(det3.idleTick(busy), []);
});

test('idleTick: a permission dialog stays BUSY (never closes); the ⏵⏵ footer is NOT an idle prompt', () => {
  // A permission/trust dialog awaiting the user is BUSY, not idle — the screen sits static with no spinner, and
  // the numbered "❯ 1. Yes" selection caret is a busy marker. The in-flight node must NEVER close while the
  // dialog is up, even after many unchanged ticks (else the static-screen fallback would close it mid-approval).
  const det = createTuiDetector();
  det.ingest(['● Edit(app.js)']);
  const dialog = ['● Edit(app.js)', 'Do you want to make this edit to app.js?', '│ ❯ 1. Yes', '│   2. No'];
  for (let i = 0; i < 6; i += 1) assert.deepEqual(det.idleTick(dialog), []);

  // The "⏵⏵ bypass permissions" footer renders persistently (even mid-tool) so it is NOT an idle prompt: were it
  // one, the FIRST tick would close immediately. Here it takes the full IDLE_TICKS of an UNCHANGED screen (the
  // static-screen fallback, no busy marker) before the node closes — proving the footer alone did nothing.
  const det2 = createTuiDetector();
  det2.ingest(['⎿ $ echo hi']);
  const footer = ['⎿ $ echo hi', 'hi', '⏵⏵ bypass permissions on (shift+tab to cycle)'];
  assert.deepEqual(det2.idleTick(footer), []); // records the signature (footer is not an idle marker)
  assert.deepEqual(det2.idleTick(footer), []); // unchanged ×1
  assert.deepEqual(det2.idleTick(footer), []); // unchanged ×2
  const closed = det2.idleTick(footer);        // unchanged ×3 → static-screen fallback closes (not the footer)
  assert.equal(closed.length, 1);
  assert.equal(closed[0].state, 'done');
});

test('user prompt echo + assistant prose become transcript / transient Respond (never tool nodes)', () => {
  const det = createTuiDetector();
  const screen = [
    '❯ add a save button',
    "● I'll add the button now.",
    '● Write(save.js)',
  ];
  const evs = det.ingest(screen);
  const echo = evs.find((e) => e.ev === 'transcript');
  assert.ok(echo, 'the submitted prompt is captured');
  assert.equal(echo.role, 'user');
  assert.equal(echo.text, 'add a save button');
  const respond = evs.filter((e) => e.ev === 'node' && e.transient);
  assert.equal(respond.length, 1);
  assert.deepEqual([respond[0].type, respond[0].label], ['reason', 'Respond']);
  const tools = evs.filter((e) => e.ev === 'node' && e.state === 'active' && !e.transient);
  assert.equal(tools.length, 1, 'the Write is the only tool node');
  assert.equal(tools[0].type, 'edit');
  // repaint: nothing re-emits (transcript + prose dedup like tools)
  assert.equal(det.ingest(screen).length, 0);

  // the LIVE input box (chrome below, not claude output) must NOT emit typing prefixes
  const det2 = createTuiDetector();
  assert.equal(det2.ingest(['❯ add a sa', '⏵⏵ bypass permissions on (shift+tab to cycle)']).length, 0);
  // the EMPTY idle prompt is not a transcript entry either
  assert.equal(det2.ingest(['❯', '● ok, done.']).filter((e) => e.ev === 'transcript').length, 0);
});
