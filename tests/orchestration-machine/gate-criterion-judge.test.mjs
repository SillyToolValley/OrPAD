import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  GATE_JUDGE_SOURCE,
  buildGateJudgeEvidence,
  buildGateJudgePrompt,
  normalizeGateJudgeEvaluations,
  judgeUnsupportedGateCriteria,
} = require('../../src/main/orchestration-machine/gate-criterion-judge.js');

const SAMPLE_EVENTS = [
  {
    eventType: 'worker.result',
    itemId: 'item-1',
    artifactRefs: ['artifacts/workers/item-1.json'],
    payload: {
      status: 'done',
      summary: 'Implemented MSW transform anchor normalization.',
      patchArtifact: 'artifacts/patches/item-1.patch',
      changedFiles: ['src/transform/anchor.ts'],
      verification: [{
        command: 'npm',
        args: ['run', 'typecheck'],
        status: 'passed',
        summary: 'Typecheck passed for the changed transform anchor.',
        exitCode: 0,
      }],
      artifacts: [{ path: 'artifacts/visual/before-after.json' }],
    },
  },
  {
    eventType: 'worker.result',
    itemId: 'item-2',
    payload: { status: 'blocked', summary: 'Blocked.', changedFiles: [], verification: [] },
  },
  { eventType: 'node.started', payload: {} },
];

test('buildGateJudgeEvidence collects only done worker results and their evidence refs', () => {
  const evidence = buildGateJudgeEvidence({
    events: SAMPLE_EVENTS,
    inventory: { activeCount: 0, doneCount: 2 },
    taskText: 'MSW editing pipeline',
  });
  assert.equal(evidence.acceptedWorkerCount, 1);
  assert.equal(evidence.workers.length, 1);
  assert.equal(evidence.workers[0].itemId, 'item-1');
  assert.equal(evidence.workers[0].verification[0].exitCode, 0);
  assert.equal(evidence.workers[0].verification[0].status, 'passed');
  assert.match(evidence.workers[0].verification[0].summary, /Typecheck passed/);
  assert.ok(evidence.workers[0].artifacts.includes('artifacts/visual/before-after.json'));
  assert.equal(evidence.activeQueueCount, 0);
  assert.ok(evidence.knownEvidenceRefs.includes('src/transform/anchor.ts'));
  assert.ok(evidence.knownEvidenceRefs.includes('artifacts/workers/item-1.json'));
  assert.ok(evidence.knownEvidenceRefs.includes('artifacts/patches/item-1.patch'));
  assert.ok(evidence.knownEvidenceRefs.includes('artifacts/visual/before-after.json'));
  assert.equal(evidence.taskText, 'MSW editing pipeline');
});

test('buildGateJudgePrompt lists every criterion and demands JSON-only output', () => {
  const evidence = buildGateJudgeEvidence({ events: [], inventory: {}, taskText: '' });
  const prompt = buildGateJudgePrompt(['typecheck passes', 'anchors match protocol'], evidence);
  assert.ok(prompt.includes('typecheck passes'));
  assert.ok(prompt.includes('anchors match protocol'));
  assert.ok(/JSON ONLY/i.test(prompt));
  assert.ok(prompt.includes('"evaluations"'));
});

test('normalizeGateJudgeEvaluations maps verdicts and fails omitted criteria', () => {
  const map = normalizeGateJudgeEvaluations(
    { evaluations: [{ criterion: 'A passes', passed: true, reason: 'ok', evidenceRefs: ['f.ts'] }] },
    ['A passes', 'B passes'],
  );
  assert.equal(map.get('A passes').passed, true);
  assert.equal(map.get('A passes').supported, true);
  assert.equal(map.get('A passes').source, GATE_JUDGE_SOURCE);
  assert.deepEqual(map.get('A passes').evidenceRefs, ['f.ts']);
  // Omitted criterion never silently passes.
  assert.equal(map.get('B passes').passed, false);
  assert.equal(map.get('B passes').supported, true);
  assert.equal(map.get('B passes').reason, 'judge-omitted-criterion');
});

test('normalizeGateJudgeEvaluations only treats strict boolean true as pass', () => {
  const map = normalizeGateJudgeEvaluations(
    { evaluations: [{ criterion: 'C', passed: 'true', reason: 'stringy' }] },
    ['C'],
  );
  assert.equal(map.get('C').passed, false);
});

test('normalizeGateJudgeEvaluations accepts a nested result.evaluations envelope', () => {
  const map = normalizeGateJudgeEvaluations(
    { result: { evaluations: [{ criterion: 'D', passed: true }] } },
    ['D'],
  );
  assert.equal(map.get('D').passed, true);
});

test('normalizeGateJudgeEvaluations returns null when no evaluation list is present', () => {
  assert.equal(normalizeGateJudgeEvaluations({ nope: 1 }, ['A']), null);
  assert.equal(normalizeGateJudgeEvaluations(null, ['A']), null);
});

test('judgeUnsupportedGateCriteria returns a verdict map from an object-returning adapter', async () => {
  const adapter = {
    async invoke() {
      return { evaluations: [{ criterion: 'X', passed: true, reason: 'evidence shows it', evidenceRefs: ['a'] }] };
    },
  };
  const map = await judgeUnsupportedGateCriteria({
    criteria: ['X'],
    events: SAMPLE_EVENTS,
    inventory: { activeCount: 0 },
    taskText: 'task',
    judgeAdapter: adapter,
  });
  assert.ok(map instanceof Map);
  assert.equal(map.get('X').passed, true);
});

test('judgeUnsupportedGateCriteria parses a JSON string adapter response', async () => {
  const adapter = {
    async invoke() {
      return JSON.stringify({ evaluations: [{ criterion: 'Y', passed: false, reason: 'missing evidence' }] });
    },
  };
  const map = await judgeUnsupportedGateCriteria({
    criteria: ['Y'],
    events: [],
    inventory: {},
    taskText: '',
    judgeAdapter: adapter,
  });
  assert.equal(map.get('Y').passed, false);
  assert.equal(map.get('Y').reason, 'missing evidence');
});

test('judgeUnsupportedGateCriteria degrades to null when the adapter throws', async () => {
  let captured = null;
  const adapter = { async invoke() { throw new Error('transport down'); } };
  const map = await judgeUnsupportedGateCriteria({
    criteria: ['Z'],
    events: [],
    inventory: {},
    judgeAdapter: adapter,
    onJudgeError: err => { captured = err; },
  });
  assert.equal(map, null);
  assert.ok(captured instanceof Error);
});

test('judgeUnsupportedGateCriteria returns null without an adapter, empty criteria, or malformed output', async () => {
  assert.equal(await judgeUnsupportedGateCriteria({ criteria: ['A'], judgeAdapter: null }), null);
  assert.equal(await judgeUnsupportedGateCriteria({ criteria: [], judgeAdapter: { invoke() {} } }), null);
  const malformed = { async invoke() { return 'not json at all'; } };
  assert.equal(await judgeUnsupportedGateCriteria({ criteria: ['A'], judgeAdapter: malformed }), null);
});
