import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The renderer ships a browser ESM port of the pure trace model. It MUST stay in
// lockstep with the main-process CommonJS source of truth (trace.cjs); this test
// fails loudly if the two diverge so the live-trace GUI never builds a graph that
// disagrees with what the core records.
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const trace = require(path.join(repoRoot, 'src/main/orchestration-core/trace.cjs'));
const browser = await import(
  'file://' + path.join(repoRoot, 'src/renderer/orchestration/emergent-trace.js').replace(/\\/g, '/')
);

const SAMPLE_EVENTS = [
  { ev: 'phase', kind: 'recon', state: 'start' },
  { ev: 'phase', kind: 'recon', state: 'done' },
  { ev: 'phase', kind: 'overlay_seeded', state: 'start' },
  { ev: 'phase', kind: 'overlay_seeded', state: 'done' },
  { ev: 'phase', kind: 'guidance_injected', state: 'start' },
  { ev: 'phase', kind: 'guidance_injected', state: 'done' },
  { ev: 'phase', kind: 'agent_run', state: 'start' },
  { ev: 'node', state: 'active', toolId: null, type: 'reason', transient: true, label: 'Reason' },
  { ev: 'node', state: 'active', toolId: 't1', type: 'edit', label: 'Write: out.txt' },
  { ev: 'node', state: 'done', toolId: 't1' },
  { ev: 'node', state: 'active', toolId: 't2', type: 'inspect', label: 'Read: out.txt' },
  { ev: 'node', state: 'done', toolId: 't2' },
  { ev: 'node', state: 'active', toolId: 't3', type: 'exec', label: 'Bash: node out.txt' },
  { ev: 'node', state: 'done', toolId: 't3' },
  { ev: 'run', state: 'done', costUsd: 0.14, numTurns: 4 },
  { ev: 'phase', kind: 'agent_run', state: 'done' },
  { ev: 'phase', kind: 'patch_collected', state: 'start' },
  { ev: 'phase', kind: 'patch_collected', state: 'done' },
];

test('PHASE_NODE taxonomy matches between trace.cjs and the browser port', () => {
  assert.deepEqual(browser.PHASE_NODE, trace.PHASE_NODE);
});

test('classifyTool matches between trace.cjs and the browser port', () => {
  for (const name of ['Read', 'Write', 'Edit', 'Bash', 'WebSearch', 'Task', 'TodoWrite', 'mcp__fs__write', 'Whatever']) {
    assert.equal(browser.classifyTool(name), trace.classifyTool(name), name);
  }
});

test('buildEmergentGraph is identical between trace.cjs and the browser port', () => {
  const a = trace.buildEmergentGraph(SAMPLE_EVENTS);
  const b = browser.buildEmergentGraph(SAMPLE_EVENTS);
  assert.deepEqual(b, a);
});

test('parity holds on partial (still-running) prefixes', () => {
  for (let i = 1; i <= SAMPLE_EVENTS.length; i += 1) {
    const slice = SAMPLE_EVENTS.slice(0, i);
    assert.deepEqual(browser.buildEmergentGraph(slice), trace.buildEmergentGraph(slice), `prefix length ${i}`);
  }
});
