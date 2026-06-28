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

// --- buildSmokeGates: deterministic, INJECTION-SAFE (argv) smoke checks from the build patch ----------
test('buildSmokeGates emits argv (shell:false) gates for available toolchains, code files only', () => {
  const has = { node: true, python: true, python3: true };
  const patch = { changes: [
    { path: 'src/a.js', afterExists: true },
    { path: 'src/b.mjs', afterExists: true },
    { path: 'tool.cjs', afterExists: true },
    { path: 'm.py', afterExists: true },
    { path: 'README.md', afterExists: true },     // not code -> no gate
    { path: 'src/gone.js', afterExists: false },  // deletion -> no gate
    { path: '../escape.js', afterExists: true },  // path traversal -> skipped
  ] };
  const gates = core.buildSmokeGates(patch, { has });
  assert.deepEqual(gates.map((g) => g.id).sort(),
    ['pysyntax:m.py', 'syntax:src/a.js', 'syntax:src/b.mjs', 'syntax:tool.cjs']);
  assert.deepEqual(gates.find((g) => g.id === 'syntax:src/a.js').argv, ['node', '--check', 'src/a.js']);
  assert.deepEqual(gates.find((g) => g.id === 'pysyntax:m.py').argv, ['python', '-m', 'py_compile', 'm.py']);
  assert.ok(gates.every((g) => g.cmd === undefined), 'argv only — never a shell string built from a path');
});

test('buildSmokeGates omits gates for a MISSING toolchain (degrade, not brick) and caps count', () => {
  const patch = { changes: [{ path: 'a.js', afterExists: true }, { path: 'b.py', afterExists: true }] };
  assert.deepEqual(core.buildSmokeGates(patch, { has: { node: false, python: false, python3: false } }), [],
    'no interpreter on PATH -> no gates (so a missing toolchain never permanently fails the build)');
  const g = core.buildSmokeGates({ changes: [{ path: 'b.py', afterExists: true }] }, { has: { node: false, python: false, python3: true } });
  assert.deepEqual(g[0].argv, ['python3', '-m', 'py_compile', 'b.py'], 'falls back to python3');
  const many = Array.from({ length: 100 }, (_, i) => ({ path: `f${i}.js`, afterExists: true }));
  assert.equal(core.buildSmokeGates({ changes: many }, { cap: 10, has: { node: true } }).length, 10);
  assert.deepEqual(core.buildSmokeGates(null, { has: { node: true } }), []);
});

test('runVerificationGates runs argv gates with shell:false and reports pass/fail (injection-safe)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-gate-'));
  try {
    fs.writeFileSync(path.join(dir, 'good.js'), 'const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'bad.js'), 'const = ;\n'); // syntax error
    const r = core.runVerificationGates(dir, [
      { kind: 'command', id: 'g', argv: ['node', '--check', 'good.js'] },
      { kind: 'command', id: 'b', argv: ['node', '--check', 'bad.js'] },
    ]);
    assert.equal(r.passed, false);
    assert.equal(r.results.find((x) => x.id === 'g').passed, true);
    assert.equal(r.results.find((x) => x.id === 'b').passed, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- parseCriticVerdict: robust LLM-verdict parsing, fails safe (non-blocking) -----------------------
test('parseCriticVerdict reads fenced json / bare object and fails SAFE', () => {
  assert.deepEqual(
    core.parseCriticVerdict('analysis…\n```json\n{"passed": false, "blockers": ["STT dead in Electron"], "notes":["x"]}\n```'),
    { passed: false, blockers: ['STT dead in Electron'], notes: ['x'] });
  assert.equal(core.parseCriticVerdict('ok {"passed": true, "blockers": []} done').passed, true);
  assert.equal(core.parseCriticVerdict('```json\n{"blockers":["x"]}\n```').passed, false, 'blockers present -> not passed');
  assert.deepEqual(core.parseCriticVerdict('no json at all'), { passed: true, blockers: [], notes: [] });
  assert.deepEqual(core.parseCriticVerdict('```json\n{bad json\n```'), { passed: true, blockers: [], notes: [] });
});

// --- runCritic: advisory; stopped/errored/thrown delegate never blocks promotion ---------------------
test('runCritic returns findings, and fails SAFE on stop/error/throw', async () => {
  const r = await core.runCritic({ overlayRoot: '/x', goal: 'g',
    delegate: async () => ({ result: '```json\n{"passed":false,"blockers":["b1","b2"]}\n```' }) });
  assert.equal(r.passed, false);
  assert.deepEqual(r.findings, ['b1', 'b2']);

  for (const bad of [
    async () => ({ stopped: true, result: '```json\n{"passed":false,"blockers":["x"]}\n```' }),
    async () => ({ isError: true, result: 'whatever' }),
    async () => { throw new Error('boom'); },
  ]) {
    assert.deepEqual(await core.runCritic({ overlayRoot: '/x', goal: 'g', delegate: bad }),
      { passed: true, findings: [] }, 'critic never hard-blocks on stop/error/throw');
  }
  // no overlay/goal -> no-op pass
  assert.deepEqual(await core.runCritic({}), { passed: true, findings: [] });
});

// --- runVerifiedBuildLoop: awaits async verifyFn and passes the latest build to it -------------------
test('runVerifiedBuildLoop awaits async verifyFn(build) and retries with feedback', async () => {
  const builds = [];
  const feedbacks = [];
  const buildFn = async (fb) => {
    feedbacks.push(fb);
    const b = { build: { stopped: false, patch: { changes: [{ path: `a${builds.length}.js`, afterExists: true }] } }, summary: {} };
    builds.push(b);
    return b;
  };
  let calls = 0;
  let sawBuild = null;
  const verifyFn = async (b) => {
    sawBuild = b; calls += 1;
    return calls >= 2 ? { passed: true, results: [] } : { passed: false, results: [{ id: 'g', passed: false, detail: 'boom' }] };
  };
  const loop = await core.runVerifiedBuildLoop({ buildFn, verifyFn, maxCycles: 3 });
  assert.ok(sawBuild && sawBuild.build, 'verifyFn received the build object');
  assert.equal(loop.met, true);
  assert.equal(loop.cycles, 1, 'failed once, then passed');
  assert.equal(builds.length, 2, 'initial build + 1 retry');
  assert.equal(feedbacks[0], null, 'first attempt gets null feedback');
  assert.match(feedbacks[1], /FAILED these verification checks/);
});

test('runVerifiedBuildLoop does NOT retry a stopped build (unwraps nested .stopped)', async () => {
  let calls = 0;
  const buildFn = async () => { calls += 1; return { build: { stopped: true }, summary: {} }; };
  const verifyFn = async () => ({ passed: false, results: [{ id: 'g', passed: false, detail: 'x' }] });
  const loop = await core.runVerifiedBuildLoop({ buildFn, verifyFn, maxCycles: 3 });
  assert.equal(calls, 1, 'stopped build not retried');
  assert.equal(loop.cycles, 0);
});

test('runVerifiedBuildLoop returns the BEST det-passing attempt when a critic-driven retry regresses', async () => {
  // attempt1: det PASSES but critic fails (passed=false -> triggers a retry). attempt2: det FAILS (regression).
  // The previously-shippable attempt1 must be returned, not the regressed attempt2.
  const verdicts = [
    { passed: false, detPassed: true, results: [{ id: 'critic:1', passed: false, detail: 'STT dead in Electron' }] },
    { passed: false, detPassed: false, results: [{ id: 'syntax:x.js', passed: false, detail: 'broke it' }] },
  ];
  const builds = [{ build: { stopped: false }, tag: 'a1' }, { build: { stopped: false }, tag: 'a2' }];
  let bi = 0; let vi = 0;
  const buildFn = async () => builds[Math.min(bi++, builds.length - 1)];
  const verifyFn = async () => verdicts[Math.min(vi++, verdicts.length - 1)];
  const loop = await core.runVerifiedBuildLoop({ buildFn, verifyFn, maxCycles: 1 });
  assert.equal(loop.build.tag, 'a1', 'best (det-passing) attempt returned, not the regressed last one');
  assert.equal(loop.gate.detPassed, true);
  assert.equal(loop.cycles, 1);
});
