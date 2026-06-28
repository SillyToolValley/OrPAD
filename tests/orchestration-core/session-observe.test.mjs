import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const trace = require(path.join(repoRoot, 'src/main/orchestration-core/trace.cjs'));

// sessionEntryToTrace observes a live claude TUI by translating its on-disk session-log entries (the real
// ~/.claude/projects/<slug>/<id>.jsonl schema) into the SAME trace events the graph already consumes.
const { sessionEntryToTrace, buildEmergentGraph } = trace;

test('sessionEntryToTrace: human prompt (string content) and session metadata entries produce no nodes', () => {
  // real shapes observed in a live session log
  assert.deepEqual(sessionEntryToTrace({ type: 'mode', mode: 'normal' }), []);
  assert.deepEqual(sessionEntryToTrace({ type: 'permission-mode', permissionMode: 'default' }), []);
  assert.deepEqual(sessionEntryToTrace({ type: 'file-history-snapshot', snapshot: {} }), []);
  assert.deepEqual(sessionEntryToTrace({ type: 'attachment', attachment: { type: 'x' } }), []);
  assert.deepEqual(sessionEntryToTrace({ type: 'summary', summary: 'x' }), []);
  // the human turn: content is a STRING, not blocks -> skipped (no spurious node)
  assert.deepEqual(sessionEntryToTrace({ type: 'user', message: { role: 'user', content: 'do the thing' }, timestamp: 't0' }), []);
});

test('sessionEntryToTrace: assistant tool_use -> node active (with file), user tool_result -> node done', () => {
  const toolUse = sessionEntryToTrace({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Edit', input: { file_path: 'src/app.js' } }] },
    timestamp: 't1',
  });
  assert.equal(toolUse.length, 1);
  assert.equal(toolUse[0].ev, 'node');
  assert.equal(toolUse[0].state, 'active');
  assert.equal(toolUse[0].toolId, 'tu_1');
  assert.equal(toolUse[0].type, 'edit');
  assert.equal(toolUse[0].file, 'src/app.js');
  assert.equal(toolUse[0].at, 't1'); // uses the entry's timestamp

  const toolResult = sessionEntryToTrace({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
    timestamp: 't2',
  });
  assert.equal(toolResult.length, 1);
  assert.equal(toolResult[0].ev, 'node');
  assert.equal(toolResult[0].state, 'done');
  assert.equal(toolResult[0].toolId, 'tu_1');
});

test('sessionEntryToTrace: thinking/text become transient reason/respond nodes', () => {
  const out = sessionEntryToTrace({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'done' }] },
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'reason');
  assert.equal(out[0].transient, true);
  assert.equal(out[1].type, 'reason');
  assert.equal(out[1].transient, true);
});

test('a tailed session sequence builds a coherent graph (read -> edit, both closed)', () => {
  const entries = [
    { type: 'user', message: { role: 'user', content: 'add a feature' } },                              // human prompt: skipped
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.js' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'a.js' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1' }] } },
    // NO {type:'result'} terminal entry in a session log — run-done is synthesized by the watcher
  ];
  const events = entries.flatMap((e) => sessionEntryToTrace(e));
  // synthesize the watcher's run-done (idle/exit)
  events.push({ ev: 'run', state: 'done', at: 'tN' });
  const g = buildEmergentGraph(events);
  assert.equal(g.done, true, 'run closes once run/done is synthesized + all nodes closed');
  const work = g.nodes.filter((n) => !n.phase);
  assert.equal(work.length, 2, 'one read + one write work node');
  assert.equal(work.every((n) => n.state === 'done'), true);
  const files = g.files.map((f) => f.path);
  assert.deepEqual(files, ['a.js']);
  const rec = g.files[0];
  assert.equal(rec.reads, 1);
  assert.equal(rec.writes, 1);
});
