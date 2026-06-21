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

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-gates-'));
}

test('runVerificationGates: command gate passes on exit 0, fails on non-zero', () => {
  const dir = tmp();
  try {
    const g = core.runVerificationGates(dir, [
      { id: 'ok', kind: 'command', cmd: 'node -e "process.exit(0)"' },
      { id: 'bad', kind: 'command', cmd: 'node -e "process.exit(3)"' },
    ]);
    assert.equal(g.passed, false, 'one failing gate fails the set');
    const ok = g.results.find((r) => r.id === 'ok');
    const bad = g.results.find((r) => r.id === 'bad');
    assert.equal(ok.passed, true);
    assert.equal(bad.passed, false);
    assert.match(bad.detail, /exit=3/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runVerificationGates: command runs in the overlay cwd', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'marker.txt'), 'x', 'utf8');
    // exit 0 only if marker.txt is visible from cwd
    const g = core.runVerificationGates(dir, [
      { id: 'cwd', kind: 'command', cmd: 'node -e "process.exit(require(\'fs\').existsSync(\'marker.txt\')?0:1)"' },
    ]);
    assert.equal(g.passed, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runVerificationGates: file-exists / file-absent against the overlay', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>', 'utf8');
    const g = core.runVerificationGates(dir, [
      { kind: 'file-exists', path: 'index.html' },
      { kind: 'file-exists', path: 'missing.js' },
      { kind: 'file-absent', path: 'nope.tmp' },
    ]);
    assert.equal(g.results[0].passed, true, 'present file passes file-exists');
    assert.equal(g.results[1].passed, false, 'missing file fails file-exists');
    assert.equal(g.results[2].passed, true, 'absent file passes file-absent');
    assert.equal(g.passed, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runVerificationGates: empty gate set is vacuously passed; unknown kind fails', () => {
  const dir = tmp();
  try {
    assert.equal(core.runVerificationGates(dir, []).passed, true, 'no gates = vacuous pass');
    const g = core.runVerificationGates(dir, [{ kind: 'wat' }]);
    assert.equal(g.passed, false);
    assert.equal(g.results[0].detail, 'unknown-gate-kind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runVerifiedBuildLoop: passes first try -> 0 cycles, one build', async () => {
  let builds = 0;
  const r = await core.runVerifiedBuildLoop({
    buildFn: async () => { builds += 1; return {}; },
    verifyFn: () => ({ passed: true, results: [] }),
    maxCycles: 3,
  });
  assert.equal(r.met, true);
  assert.equal(r.cycles, 0);
  assert.equal(builds, 1);
});

test('runVerifiedBuildLoop: fail then pass -> 1 cycle, two builds, feedback injected', async () => {
  let builds = 0;
  let lastFeedback = 'never-called';
  let verifyN = 0;
  const r = await core.runVerifiedBuildLoop({
    buildFn: async (feedback) => { builds += 1; lastFeedback = feedback; return {}; },
    verifyFn: () => ({ passed: verifyN++ > 0, results: [{ id: 'g', passed: false, detail: 'boom' }] }),
    maxCycles: 3,
  });
  assert.equal(r.met, true);
  assert.equal(r.cycles, 1);
  assert.equal(builds, 2);
  assert.match(lastFeedback, /FAILED/);
  assert.match(lastFeedback, /boom/);
});

test('runVerifiedBuildLoop: always fails -> exhausts maxCycles, met false', async () => {
  let builds = 0;
  const r = await core.runVerifiedBuildLoop({
    buildFn: async () => { builds += 1; return {}; },
    verifyFn: () => ({ passed: false, results: [{ id: 'g', passed: false, detail: 'x' }] }),
    maxCycles: 2,
  });
  assert.equal(r.met, false);
  assert.equal(r.cycles, 2);
  assert.equal(builds, 3, 'initial + 2 retries');
});

test('runVerifiedBuildLoop: a stopped build halts the loop even while failing', async () => {
  let builds = 0;
  const r = await core.runVerifiedBuildLoop({
    buildFn: async () => { builds += 1; return { stopped: true, stopReason: 'time-cap' }; },
    verifyFn: () => ({ passed: false, results: [{ id: 'g', passed: false, detail: 'x' }] }),
    maxCycles: 3,
  });
  assert.equal(r.met, false);
  assert.equal(r.cycles, 0, 'stopped build is not retried');
  assert.equal(builds, 1);
});
