import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const trace = require(path.join(repoRoot, 'src/main/orchestration-core/trace.cjs'));

test('classifyTool maps native agent tools to work-node types', () => {
  assert.equal(trace.classifyTool('Read'), 'inspect');
  assert.equal(trace.classifyTool('Grep'), 'inspect');
  assert.equal(trace.classifyTool('Write'), 'edit');
  assert.equal(trace.classifyTool('Edit'), 'edit');
  assert.equal(trace.classifyTool('Bash'), 'exec');
  assert.equal(trace.classifyTool('WebSearch'), 'research');
  assert.equal(trace.classifyTool('Task'), 'subagent');
  assert.equal(trace.classifyTool('TodoWrite'), 'plan');
  assert.equal(trace.classifyTool('mcp__fs__write_file'), 'tool');
  assert.equal(trace.classifyTool('SomethingNew'), 'tool');
});

test('streamEventToTrace turns claude stream-json into node trace events', () => {
  const toolUse = trace.streamEventToTrace({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/main/x.js' } }] },
  });
  assert.equal(toolUse.length, 1);
  assert.equal(toolUse[0].ev, 'node');
  assert.equal(toolUse[0].state, 'active');
  assert.equal(toolUse[0].type, 'edit');
  assert.equal(toolUse[0].toolId, 't1');
  assert.match(toolUse[0].label, /x\.js/);

  const result = trace.streamEventToTrace({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } });
  assert.equal(result.length, 1);
  assert.equal(result[0].ev, 'node');
  assert.equal(result[0].state, 'done');
  assert.equal(result[0].toolId, 't1');

  const fin = trace.streamEventToTrace({ type: 'result', total_cost_usd: 0.5, num_turns: 9 });
  assert.equal(fin[0].ev, 'run');
  assert.equal(fin[0].state, 'done');
  assert.equal(fin[0].costUsd, 0.5);
});

test('buildEmergentGraph grows nodes in execution order and links them', () => {
  const events = [
    { ev: 'phase', kind: 'recon', state: 'start' },
    { ev: 'phase', kind: 'recon', state: 'done' },
    { ev: 'node', state: 'active', toolId: 'a', type: 'inspect', label: 'Read a.js' },
    { ev: 'node', state: 'done', toolId: 'a' },
    { ev: 'node', state: 'active', toolId: 'b', type: 'edit', label: 'Edit a.js' },
    { ev: 'node', state: 'done', toolId: 'b' },
  ];
  const g = trace.buildEmergentGraph(events);
  assert.equal(g.nodes.length, 3, 'recon + inspect + edit');
  assert.deepEqual(g.nodes.map(n => n.type), ['recon', 'inspect', 'edit']);
  assert.equal(g.edges.length, 2, 'sequential edges between the three nodes');
  assert.deepEqual(g.edges, [{ from: 'n0', to: 'n1' }, { from: 'n1', to: 'n2' }]);
  assert.equal(g.nodes.every(n => n.state === 'done'), true);
});

test('the node fed by the still-filling buffer is in-progress (spinner)', () => {
  // a tool_use with no matching tool_result yet => that node stays active.
  const events = [
    { ev: 'node', state: 'active', toolId: 'a', type: 'inspect', label: 'Read' },
    { ev: 'node', state: 'done', toolId: 'a' },
    { ev: 'node', state: 'active', toolId: 'b', type: 'exec', label: 'Bash: build' },
    // no done for b yet -> b is in progress
  ];
  const g = trace.buildEmergentGraph(events);
  assert.equal(g.activeId, 'n1', 'the exec node is the in-progress one');
  const exec = g.nodes.find(n => n.id === 'n1');
  assert.equal(exec.state, 'active');
  assert.equal(trace.isInProgress(exec), true, 'spinner shows on the filling node');
  assert.equal(g.done, false);
});

test('run-done closes any still-open nodes', () => {
  const events = [
    { ev: 'node', state: 'active', toolId: 'a', type: 'exec', label: 'Bash' },
    { ev: 'run', state: 'done', costUsd: 1.2 },
  ];
  const g = trace.buildEmergentGraph(events);
  assert.equal(g.done, true);
  assert.equal(g.activeId, null);
  assert.equal(g.nodes[0].state, 'done');
});

test('end-to-end: a raw stream replays into an emergent graph', () => {
  const stream = [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'thinking' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'pixelart.py' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'python pixelart.py' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1' }] } },
    { type: 'result', total_cost_usd: 0.3, num_turns: 4 },
  ];
  const traceEvents = stream.flatMap(o => trace.streamEventToTrace(o));
  const g = trace.buildEmergentGraph(traceEvents);
  assert.deepEqual(g.nodes.map(n => n.type), ['reason', 'inspect', 'exec']);
  assert.equal(g.done, true);
  assert.equal(g.nodes.every(n => n.state === 'done'), true);
});

test('a grounded dual-agent stream stays running until the build closes', () => {
  // A grounded run delegates TWICE (research, then build). Each agent's CLI
  // result emits an intermediate run-done; the build's nodes open AFTER it. The
  // graph must not read "complete" until the build itself closes, and a phase
  // node must not keep spinning above its already-finished child work nodes.
  const upToBuildInFlight = [
    // research agent
    { ev: 'phase', kind: 'agent_run', state: 'start' }, // "Delegate to agent"
    { ev: 'node', state: 'active', toolId: 'r1', type: 'inspect', label: 'Read' },
    { ev: 'node', state: 'done', toolId: 'r1' },
    { ev: 'run', state: 'done' },                        // research result -> intermediate run-done
    { ev: 'phase', kind: 'agent_run', state: 'done' },
    // build agent begins AFTER the intermediate run-done
    { ev: 'phase', kind: 'agent_run', state: 'start' },  // second "Delegate to agent"
    { ev: 'node', state: 'active', toolId: 'w1', type: 'edit', label: 'Write index.html' },
    { ev: 'node', state: 'done', toolId: 'w1' },
    { ev: 'node', state: 'active', toolId: 'b1', type: 'exec', label: 'Bash: test' }, // still running
  ];
  const g = trace.buildEmergentGraph(upToBuildInFlight);
  assert.equal(g.done, false, 'an intermediate agent run-done must not complete the graph');
  const delegates = g.nodes.filter(n => n.phase && n.type === 'delegate');
  assert.equal(delegates.length, 2, 'one delegate phase node per agent');
  assert.equal(delegates.every(n => n.state === 'done'), true, 'phase nodes do not spin over finished children');
  const exec = g.nodes.find(n => n.label === 'Bash: test');
  assert.equal(exec.state, 'active');
  assert.equal(g.activeId, exec.id, 'the spinner is the work frontier, not the delegate phase');

  // build agent finishes -> only now is the whole run complete.
  const g2 = trace.buildEmergentGraph([
    ...upToBuildInFlight,
    { ev: 'node', state: 'done', toolId: 'b1' },
    { ev: 'phase', kind: 'agent_run', state: 'done' },
    { ev: 'run', state: 'done' },
  ]);
  assert.equal(g2.done, true);
  assert.equal(g2.activeId, null);
  assert.equal(g2.nodes.every(n => n.state === 'done'), true);
});

test('streamEventToTrace captures the touched file from tool input (data layer)', () => {
  const evs = trace.streamEventToTrace({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'w', name: 'Write', input: { file_path: 'src/x.js' } },
    { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_use', id: 'g', name: 'Grep', input: { pattern: 'foo' } },
  ] } });
  assert.equal(evs.find((e) => e.toolId === 'w').file, 'src/x.js', 'Write target is captured');
  assert.equal(evs.find((e) => e.toolId === 'b').file, null, 'Bash command is not a file');
  assert.equal(evs.find((e) => e.toolId === 'g').file, null, 'Grep pattern is not a file');
});

test('buildEmergentGraph builds a file-access layer (reads/writes per file)', () => {
  const events = [
    { ev: 'node', state: 'active', toolId: 'r1', type: 'inspect', label: 'Read a', file: 'src/a.js' },
    { ev: 'node', state: 'done', toolId: 'r1' },
    { ev: 'node', state: 'active', toolId: 'w1', type: 'edit', label: 'Write a', file: 'src/a.js' },
    { ev: 'node', state: 'done', toolId: 'w1' },
    { ev: 'node', state: 'active', toolId: 'w2', type: 'edit', label: 'Write b', file: 'src/b.js' },
    { ev: 'node', state: 'done', toolId: 'w2' },
    { ev: 'node', state: 'active', toolId: 'x1', type: 'exec', label: 'Bash' },
    { ev: 'run', state: 'done' },
  ];
  const g = trace.buildEmergentGraph(events);
  const byFile = Object.fromEntries(g.files.map((f) => [f.path, f]));
  assert.equal(g.files.length, 2, 'two distinct files touched');
  assert.equal(byFile['src/a.js'].reads, 1, 'a.js read once');
  assert.equal(byFile['src/a.js'].writes, 1, 'a.js written once');
  assert.equal(byFile['src/a.js'].nodes.length, 2, 'a.js touched by two nodes (a star, not a line)');
  assert.equal(byFile['src/b.js'].writes, 1);
  // nodes carry their file + access; non-file tools (exec) carry neither.
  assert.equal(g.nodes.find((n) => n.label === 'Write a').access, 'write');
  assert.equal(g.nodes.find((n) => n.label === 'Read a').access, 'read');
  assert.equal(g.nodes.find((n) => n.type === 'exec').file, undefined);
});
