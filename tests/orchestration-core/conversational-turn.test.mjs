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
const ipc = require(path.join(repoRoot, 'src/main/orchestration-core/ipc.cjs'));

// The shared minimum-verification loop used by BOTH the initial run AND every conversation turn — so a
// follow-up turn is as safe as turn 1 (full smoke + critic + fix-retry), and reuses the overlay + session.
function fakeBuild(sessionId = 's1') {
  return { build: { stopped: false, patch: { changes: [{ path: 'a.js', afterExists: true }], violations: [] }, agentRun: { sessionId } }, summary: {}, brief: 'BRIEF' };
}

test('runVerifiedLoop threads seedOverlay+resumeSessionId, runs smoke+critic, retries on critic fail, surfaces notes', async () => {
  const calls = [];
  const runner = async (opts) => { calls.push({ kind: 'runner', seedOverlay: opts.seedOverlay, resumeSessionId: opts.resumeSessionId }); return fakeBuild(); };
  let criticCalls = 0;
  const coreApi = {
    buildSmokeGates: () => [],                              // no deterministic gates -> det vacuous pass
    runVerificationGates: () => ({ passed: true, results: [] }),
    runCritic: async () => { criticCalls += 1; return criticCalls < 2 ? { passed: false, findings: ['STT dead in Electron'], notes: ['n'] } : { passed: true, findings: [], notes: ['n'] }; },
    composeGoalWithGrounding: (g) => g,
    runGovernedDelegation: async (opts) => { calls.push({ kind: 'retry', seedOverlay: opts.seedOverlay, resumeSessionId: opts.resumeSessionId }); return fakeBuild(); },
    runVerifiedBuildLoop: core.runVerifiedBuildLoop,        // the REAL loop drives buildFn/verifyFn
  };
  const out = await ipc.runVerifiedLoop({
    runner, baseOpts: {}, goal: 'build it', agent: 'claude', overlayRoot: '/x',
    gates: [], autoVerify: true, maxCycles: 2, greenfield: true,
    seedOverlay: false, resumeSessionId: 'sess-1', coreApi,
  });
  // first build (the turn) reused the overlay + resumed the session
  assert.equal(calls[0].kind, 'runner');
  assert.equal(calls[0].seedOverlay, false);
  assert.equal(calls[0].resumeSessionId, 'sess-1');
  // critic failed on attempt 1 -> a retry fired, also reusing overlay + resuming session
  assert.ok(calls.some((c) => c.kind === 'retry' && c.seedOverlay === false && c.resumeSessionId === 'sess-1'),
    'critic-driven retry reuses the overlay and keeps the session');
  // deterministic gates passed throughout -> promotable; critic notes are surfaced (the advisory channel)
  assert.equal(out.gate.detPassed, true);
  assert.deepEqual(out.gate.criticNotes, ['n']);
  assert.equal(criticCalls >= 2, true);
});

test('runVerifiedLoop: a non-claude agent skips the critic (claude-only) but still smoke-verifies', async () => {
  const runner = async () => fakeBuild();
  let criticCalls = 0;
  const coreApi = {
    buildSmokeGates: () => [{ kind: 'command', id: 'g', argv: ['node', '--version'] }],
    runVerificationGates: () => ({ passed: true, results: [{ id: 'g', passed: true, detail: 'ok' }] }),
    runCritic: async () => { criticCalls += 1; return { passed: false, findings: ['should not run'] }; },
    composeGoalWithGrounding: (g) => g,
    runGovernedDelegation: async () => fakeBuild(),
    runVerifiedBuildLoop: core.runVerifiedBuildLoop,
  };
  const out = await ipc.runVerifiedLoop({
    runner, baseOpts: {}, goal: 'x', agent: 'codex', overlayRoot: '/x',
    gates: [], autoVerify: true, maxCycles: 1, greenfield: true,
    seedOverlay: false, resumeSessionId: null, coreApi,
  });
  assert.equal(criticCalls, 0, 'critic is claude-only — never invoked for codex');
  assert.equal(out.gate.detPassed, true, 'deterministic smoke still gates promotion');
});

// THE trust-boundary regression: a critic-driven retry that REGRESSES (det-fails) must NOT leave its bad bytes
// in the overlay. Best-so-far returns the earlier det-passing attempt; runVerifiedLoop must re-materialize that
// attempt's shipped bytes into the overlay so the subsequent apply ships VERIFIED bytes. Uses violations (the
// greenfield case that carries NO recorded content) to prove the disk-snapshot path, not just patch content.
test('runVerifiedLoop re-materializes the PROMOTED attempt bytes into the overlay when a retry regresses', async () => {
  const overlayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orpad-rollback-'));
  try {
    const appPath = path.join(overlayRoot, 'app.js');
    const violationBuild = () => ({ build: { stopped: false, patch: { changes: [], violations: [{ path: 'app.js', reason: 'outside-write-set' }] }, agentRun: { sessionId: 's' } }, summary: {} });
    let criticCalls = 0;
    const coreApi = {
      // gate reads the LIVE overlay: attempt-1 bytes pass, the regressed attempt-2 bytes fail.
      buildSmokeGates: () => [{ kind: 'command', id: 'content' }],
      runVerificationGates: (root) => { const c = fs.readFileSync(path.join(root, 'app.js'), 'utf8'); const passed = c === 'ATTEMPT1'; return { passed, results: [{ id: 'content', passed, detail: c }] }; },
      runCritic: async () => { criticCalls += 1; return { passed: false, findings: ['blocker'], notes: [] }; }, // forces the retry off a det-passing build
      composeGoalWithGrounding: (g) => g,
      runGovernedDelegation: async () => { fs.writeFileSync(appPath, 'ATTEMPT2', 'utf8'); return violationBuild(); }, // the regression
      runVerifiedBuildLoop: core.runVerifiedBuildLoop,
    };
    const runner = async () => { fs.writeFileSync(appPath, 'ATTEMPT1', 'utf8'); return violationBuild(); };
    const out = await ipc.runVerifiedLoop({
      runner, baseOpts: {}, goal: 'g', agent: 'claude', overlayRoot,
      gates: [], autoVerify: true, maxCycles: 1, greenfield: true,
      seedOverlay: false, resumeSessionId: null, coreApi,
    });
    assert.equal(out.cycles, 1, 'one retry happened');
    assert.equal(out.gate.detPassed, true, 'rolled back to the det-passing attempt');
    assert.equal(criticCalls, 1, 'critic ran only on the det-passing attempt-1');
    // THE assertion: the overlay holds the VERIFIED bytes, not the regression that the loop discarded.
    assert.equal(fs.readFileSync(appPath, 'utf8'), 'ATTEMPT1', 'overlay re-materialized to the promoted attempt — no unverified bytes ship');
  } finally { fs.rmSync(overlayRoot, { recursive: true, force: true }); }
});
