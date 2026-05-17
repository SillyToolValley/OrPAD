import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const {
  createMachineRun,
  evaluateOutgoingEdges,
  readMachineEvents,
  summarizeEdgeEvaluation,
  __test_emitEdgeEvaluationDiagnostic: emitEdgeEvaluationDiagnostic,
} = require(path.join(repoRoot, 'src/main/orchestration-machine'));

// Fork-Join Phase 2: evaluateOutgoingEdges is a pure function that
// decides which outgoing edges of a source node WOULD fire given the
// source's last completed result. Phase 2 wires this as a non-mutating
// dry-run diagnostic. Phase 3 uses the same decisions to gate dispatch.
//
// These tests pin the Phase 2 contract: every supported source type
// (selector / gate / patchReview / barrier) has documented edge
// semantics; unconditional edges (Pattern J fan-out) always fire;
// unrecognized conditions default-fire so we don't accidentally
// suppress today-working pipelines during rollout.

test('unconditional edge (no condition) fires regardless of source type', () => {
  const node = { nodeType: 'orpad.gate' };
  const edges = [
    { from: 'gate', to: 'next', condition: '' },
    { from: 'gate', to: 'other' },
  ];
  const result = summarizeEdgeEvaluation(evaluateOutgoingEdges(node, edges, { valid: false }));
  assert.equal(result[0].fired, true);
  assert.equal(result[0].reason, 'unconditional');
  assert.equal(result[1].fired, true);
  assert.equal(result[1].reason, 'unconditional');
});

test('selector edges fire only when condition matches selected route', () => {
  const node = { nodeType: 'orpad.selector' };
  const edges = [
    { from: 'select', to: 'fast', condition: 'fast' },
    { from: 'select', to: 'thorough', condition: 'thorough' },
  ];
  const fast = summarizeEdgeEvaluation(evaluateOutgoingEdges(node, edges, { selected: 'fast' }));
  assert.equal(fast[0].fired, true);
  assert.equal(fast[0].reason, 'selector-match');
  assert.equal(fast[1].fired, false);
  assert.equal(fast[1].reason, 'selector-mismatch');

  // selectedRoute is the renderer-facing field; the evaluator accepts
  // either selected or selectedRoute so callers don't have to
  // normalize before calling.
  const thorough = summarizeEdgeEvaluation(evaluateOutgoingEdges(node, edges, { selectedRoute: 'thorough' }));
  assert.equal(thorough[0].fired, false);
  assert.equal(thorough[1].fired, true);

  // When selector has no selection at all, no edges fire.
  const none = summarizeEdgeEvaluation(evaluateOutgoingEdges(node, edges, {}));
  assert.equal(none[0].fired, false);
  assert.equal(none[0].reason, 'selector-no-selection');
});

test('gate pass family fires only when valid=true; revise family fires only when valid=false', () => {
  const node = { nodeType: 'orpad.gate' };
  const edges = [
    { from: 'gate', to: 'next', condition: 'pass' },
    { from: 'gate', to: 'worker', condition: 'revise' },
    // 'continue' is part of the pass family (renderer + generator
    // both produce it as the gate-passes outgoing label).
    { from: 'gate', to: 'final', condition: 'continue' },
  ];
  const passed = summarizeEdgeEvaluation(evaluateOutgoingEdges(node, edges, { valid: true, onFail: 'block' }));
  assert.equal(passed.find(e => e.condition === 'pass').fired, true);
  assert.equal(passed.find(e => e.condition === 'revise').fired, false);
  assert.equal(passed.find(e => e.condition === 'continue').fired, true);

  const failed = summarizeEdgeEvaluation(evaluateOutgoingEdges(node, edges, { valid: false, onFail: 'warn' }));
  assert.equal(failed.find(e => e.condition === 'pass').fired, false);
  assert.equal(failed.find(e => e.condition === 'revise').fired, true);
  assert.equal(failed.find(e => e.condition === 'continue').fired, false);
});

test('gate queue-state conditions (Pattern I) consult the real summarizeQueueInventory shape', () => {
  // Codex cross-review 2026-05-16 caught that the original test used a
  // flat `{ candidate, queued, claimed }` shape that does NOT match the
  // real shape that `validateGateNode` produces. `summarizeQueueInventory`
  // returns `{ counts: { candidate, queued, claimed, ... }, activeCount,
  // ... }`. The evaluator now reads `activeCount` first; this test
  // exercises that path with the realistic shape, plus the counts and
  // legacy-flat fallbacks so future changes can't regress.
  const node = { nodeType: 'orpad.gate' };
  const edges = [
    { from: 'drain-gate', to: 'dispatcher', condition: 'queue-not-empty' },
    { from: 'drain-gate', to: 'exit', condition: 'queue-empty' },
  ];

  // Real shape (what gates produce today).
  const stillWorkActiveCount = summarizeEdgeEvaluation(evaluateOutgoingEdges(node, edges, {
    valid: true,
    inventory: { counts: { candidate: 0, queued: 2, claimed: 0 }, activeCount: 2 },
  }));
  assert.equal(stillWorkActiveCount.find(e => e.condition === 'queue-not-empty').fired, true);
  assert.equal(stillWorkActiveCount.find(e => e.condition === 'queue-empty').fired, false);

  const drainedActiveCount = summarizeEdgeEvaluation(evaluateOutgoingEdges(node, edges, {
    valid: true,
    inventory: { counts: { candidate: 0, queued: 0, claimed: 0 }, activeCount: 0 },
  }));
  assert.equal(drainedActiveCount.find(e => e.condition === 'queue-not-empty').fired, false);
  assert.equal(drainedActiveCount.find(e => e.condition === 'queue-empty').fired, true);

  // Counts-only fallback (no activeCount field).
  const stillWorkCounts = summarizeEdgeEvaluation(evaluateOutgoingEdges(node, edges, {
    valid: true,
    inventory: { counts: { candidate: 0, queued: 2, claimed: 0 } },
  }));
  assert.equal(stillWorkCounts.find(e => e.condition === 'queue-not-empty').fired, true);

  // Legacy flat fallback (very old callers).
  const stillWorkFlat = summarizeEdgeEvaluation(evaluateOutgoingEdges(node, edges, {
    valid: true,
    inventory: { candidate: 0, queued: 2, claimed: 0 },
  }));
  assert.equal(stillWorkFlat.find(e => e.condition === 'queue-not-empty').fired, true);
});

test('patchReview accepted/rejected edges read the executePatchReviewNode result status', () => {
  const node = { nodeType: 'orpad.patchReview' };
  const edges = [
    { from: 'review', to: 'gate', condition: 'accepted' },
    { from: 'review', to: 'worker', condition: 'rejected' },
  ];
  // status: 'reviewed' (patches applied) -> accepted branch fires.
  const accepted = summarizeEdgeEvaluation(evaluateOutgoingEdges(node, edges, { status: 'reviewed' }));
  assert.equal(accepted.find(e => e.condition === 'accepted').fired, true);
  // rejected edge today does NOT fire — executePatchReviewNode does
  // not emit a 'rejected' resolution. Phase 3 adds that semantics;
  // Phase 2's job is to surface the gap as a diagnostic.
  const rejectedDecision = accepted.find(e => e.condition === 'rejected');
  assert.equal(rejectedDecision.fired, false);
  assert.equal(rejectedDecision.reason, 'patch-review-rejected-not-yet-emitted');

  // status: 'not-required' (no patches authored) -> still accepted.
  const noPatches = summarizeEdgeEvaluation(evaluateOutgoingEdges(node, edges, { status: 'not-required' }));
  assert.equal(noPatches.find(e => e.condition === 'accepted').fired, true);

  // status: 'blocked' -> neither edge fires (the for-loop would have
  // stopped before evaluating outgoing edges anyway, but the
  // evaluator must not lie about it).
  const blocked = summarizeEdgeEvaluation(evaluateOutgoingEdges(node, edges, { status: 'blocked' }));
  assert.equal(blocked.find(e => e.condition === 'accepted').fired, false);
});

test('barrier pass/partial edges reflect validateBarrierNode valid bit', () => {
  const node = { nodeType: 'orpad.barrier' };
  const edges = [
    { from: 'join', to: 'next', condition: 'pass' },
    { from: 'join', to: 'recover', condition: 'partial' },
  ];
  const valid = summarizeEdgeEvaluation(evaluateOutgoingEdges(node, edges, { valid: true }));
  assert.equal(valid.find(e => e.condition === 'pass').fired, true);
  assert.equal(valid.find(e => e.condition === 'partial').fired, false);

  // continue-with-warning produces `valid: false` and the node still
  // completes (no throw), so the 'partial' edge fires.
  const partial = summarizeEdgeEvaluation(evaluateOutgoingEdges(node, edges, { valid: false, mergePolicy: 'concat-coverage' }));
  assert.equal(partial.find(e => e.condition === 'pass').fired, false);
  assert.equal(partial.find(e => e.condition === 'partial').fired, true);
});

test('unrecognized conditions on decision-emitting sources default-fire and surface the gap', () => {
  // Phase 2's rollout strategy: don't accidentally suppress today-
  // working pipelines that author conditions the evaluator doesn't
  // recognize. Default-fire and tag with a reason so the diagnostic
  // event lets the user see the unrecognized vocabulary. Phase 3 may
  // tighten this when the recognized set is stable.
  const node = { nodeType: 'orpad.gate' };
  const edges = [
    { from: 'gate', to: 'sideline', condition: 'maybe-someday' },
  ];
  const result = summarizeEdgeEvaluation(evaluateOutgoingEdges(node, edges, { valid: true }));
  assert.equal(result[0].fired, true);
  assert.equal(result[0].reason, 'gate-condition-unrecognized-default-fire');
});

test('non-decision-emitting source with labelled edge default-fires with audit tag', () => {
  // A context node has no decision semantics, but the LLM could
  // still author a labelled outgoing edge. Phase 2 default-fires so
  // no surprise regressions, and tags the reason so the diagnostic
  // event makes the situation visible.
  const node = { nodeType: 'orpad.context' };
  const edges = [{ from: 'ctx', to: 'next', condition: 'whatever' }];
  const result = summarizeEdgeEvaluation(evaluateOutgoingEdges(node, edges, {}));
  assert.equal(result[0].fired, true);
  assert.equal(result[0].reason, 'source-not-decision-emitting');
});

test('evaluateOutgoingEdges tolerates missing edges array', () => {
  const node = { nodeType: 'orpad.gate' };
  assert.deepEqual(evaluateOutgoingEdges(node, undefined, { valid: true }), []);
  assert.deepEqual(evaluateOutgoingEdges(node, null, { valid: true }), []);
  assert.deepEqual(evaluateOutgoingEdges(node, [], { valid: true }), []);
});

// Direct unit test for the scheduler's diagnostic emission wrapper.
// The tutorial replay test (tutorial-templates.test.mjs) only proves
// the SKIP path (blocked sources don't emit); this proves the EMIT
// path actually appends a scheduler.edgeEvaluation event with the
// expected payload shape. Codex cross-review 2026-05-16 noted the
// tutorial coverage wasn't enough since the tutorial has no labelled
// edges and only patchReview as a decision-emitting source.
async function setupMinimalRun(t) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-edge-eval-emit-'));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/edge-eval-emit');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'edge-eval-emit',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');
  const run = await createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId: 'run_edge_eval_emit',
    now: new Date('2026-05-16T00:00:00.000Z'),
  });
  return { run };
}

test('emitEdgeEvaluationDiagnostic appends a scheduler.edgeEvaluation event with per-edge decisions', async (t) => {
  const { run } = await setupMinimalRun(t);
  await emitEdgeEvaluationDiagnostic({
    runRoot: run.runRoot,
    runId: run.runId,
    sourceNode: { nodePath: 'main/route-selector', nodeType: 'orpad.selector' },
    sourceResult: { selected: 'fast' },
    transitions: [
      { from: 'main/route-selector', to: 'main/fast-branch', condition: 'fast' },
      { from: 'main/route-selector', to: 'main/thorough-branch', condition: 'thorough' },
    ],
  });
  const events = await readMachineEvents(run.runRoot);
  const edgeEval = events.find(event => event.eventType === 'scheduler.edgeEvaluation');
  assert.ok(edgeEval, 'should append a scheduler.edgeEvaluation event');
  assert.equal(edgeEval.nodePath, 'main/route-selector');
  assert.equal(edgeEval.payload.sourceNodeType, 'orpad.selector');
  assert.equal(edgeEval.payload.phase, 'phase-2-dry-run');
  assert.equal(edgeEval.payload.firedCount, 1);
  assert.equal(edgeEval.payload.droppedCount, 1);
  assert.equal(edgeEval.payload.decisions.length, 2);
  const fast = edgeEval.payload.decisions.find(d => d.condition === 'fast');
  const thorough = edgeEval.payload.decisions.find(d => d.condition === 'thorough');
  assert.equal(fast.fired, true);
  assert.equal(fast.reason, 'selector-match');
  assert.equal(thorough.fired, false);
  assert.equal(thorough.reason, 'selector-mismatch');
});

test('emitEdgeEvaluationDiagnostic skips blocked sources (codex cross-review fix)', async (t) => {
  const { run } = await setupMinimalRun(t);
  await emitEdgeEvaluationDiagnostic({
    runRoot: run.runRoot,
    runId: run.runId,
    sourceNode: { nodePath: 'main/patch-review', nodeType: 'orpad.patchReview' },
    sourceResult: { blocked: true, reason: 'patch-review.required' },
    transitions: [
      { from: 'main/patch-review', to: 'main/exit' },
    ],
  });
  const events = await readMachineEvents(run.runRoot);
  const edgeEval = events.find(event => event.eventType === 'scheduler.edgeEvaluation');
  assert.equal(edgeEval, undefined, 'blocked source must NOT produce a diagnostic event');
});

test('emitEdgeEvaluationDiagnostic skips non-decision sources without labelled edges', async (t) => {
  const { run } = await setupMinimalRun(t);
  await emitEdgeEvaluationDiagnostic({
    runRoot: run.runRoot,
    runId: run.runId,
    sourceNode: { nodePath: 'main/context', nodeType: 'orpad.context' },
    sourceResult: { summary: 'ok' },
    transitions: [
      { from: 'main/context', to: 'main/next' }, // no condition
    ],
  });
  const events = await readMachineEvents(run.runRoot);
  const edgeEval = events.find(event => event.eventType === 'scheduler.edgeEvaluation');
  assert.equal(edgeEval, undefined, 'non-decision source with no labelled edges is not interesting enough to diagnose');
});
