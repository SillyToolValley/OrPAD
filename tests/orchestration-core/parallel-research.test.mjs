import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = require(path.join(repoRoot, 'src/main/orchestration-core/core.cjs'));

test('runParallelResearch fans out: fork/join emitted, branch-tagged, briefs combined', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-par-'));
  try {
    const events = [];
    // Injected delegate: writes the branch's grounding file + emits a node event and
    // a (to-be-swallowed) run-done, simulating a real research subagent.
    const fakeDelegate = async ({ overlayRoot, onTraceEvent }) => {
      const m = overlayRoot.match(/-(r\d+)$/);
      const bid = m ? m[1] : 'r?';
      if (onTraceEvent) {
        onTraceEvent({ ev: 'node', state: 'active', toolId: `${bid}-t`, type: 'research', label: `search ${bid}` });
        onTraceEvent({ ev: 'run', state: 'done' });
      }
      fs.writeFileSync(path.join(overlayRoot, `${bid}.md`), `brief for ${bid}`, 'utf8');
      return { stopped: false, costUsd: 0.1 };
    };
    const res = await core.runParallelResearch({
      overlayRoot: path.join(dir, 'overlay'),
      runRoot: path.join(dir, 'run'),
      goal: 'build X',
      queries: [{ label: 'Prior art' }, { label: 'Pitfalls' }],
      onTraceEvent: (e) => events.push(e),
      delegate: fakeDelegate,
    });

    const fork = events.find((e) => e.ev === 'fork');
    const join = events.find((e) => e.ev === 'join');
    assert.ok(fork, 'fork emitted');
    assert.equal(fork.branches.length, 2);
    assert.equal(fork.branches[0].label, 'Prior art');
    assert.ok(join, 'join emitted');
    assert.deepEqual(join.from, ['r1', 'r2']);

    const nodeEvents = events.filter((e) => e.ev === 'node');
    assert.equal(nodeEvents.length, 2, 'one node per branch');
    assert.deepEqual(nodeEvents.map((e) => e.branch).sort(), ['r1', 'r2'], 'nodes tagged with their branch');
    assert.equal(events.filter((e) => e.ev === 'run').length, 0, 'subagent run-done is swallowed (orchestrator owns it)');

    assert.match(res.combinedBrief, /## Prior art/);
    assert.match(res.combinedBrief, /## Pitfalls/);
    assert.match(res.combinedBrief, /brief for r1/);
    assert.match(res.combinedBrief, /brief for r2/);
    assert.equal(res.briefs.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DEFAULT_RESEARCH_QUERIES covers prior-art / requirements / pitfalls', () => {
  const labels = core.DEFAULT_RESEARCH_QUERIES.map((q) => q.label);
  assert.ok(labels.includes('Prior art'));
  assert.ok(labels.includes('Requirements'));
  assert.ok(labels.includes('Pitfalls'));
});
