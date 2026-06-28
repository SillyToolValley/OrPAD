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
  const actives = events.filter((e) => e.ev === 'node' && e.state === 'active');
  assert.equal(actives.length, 3, 'exactly the 3 real tools (no prose/summary noise)');
  assert.deepEqual(actives.map((a) => a.type), ['inspect', 'exec', 'edit']);
  assert.equal(actives[0].file, 'note.txt');
  assert.match(actives[1].label, /echo HELLO_42/);
  assert.equal(actives[2].file, 'out.txt');
  // each new tool closes the previous (active -> done chain) so the graph links in execution order
  assert.equal(events.filter((e) => e.ev === 'node' && e.state === 'done').length, 2);

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
