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

test('buildGateJudgeEvidence includes pre-worker machine evidence: provisions, probes, registered artifacts', () => {
  // Regression: SpriteGenTest gate-toolchain-mapped failed every criterion
  // because the judge package only carried worker.result evidence — at a
  // pre-worker gate that package is empty even when provision cloned the
  // checkout and probes filed candidates.
  const evidence = buildGateJudgeEvidence({
    events: [
      {
        eventType: 'node.completed',
        nodePath: 'main/provision-sprite-gen',
        payload: {
          nodeType: 'orpad.provision',
          valid: false,
          onFail: 'warn',
          stepCount: 2,
          executedCount: 1,
          skippedCount: 0,
          failedCount: 1,
          evidenceArtifact: 'artifacts/provision/main-provision-sprite-gen.json',
          steps: [
            { kind: 'git-clone', repo: 'https://github.com/example/sprite-gen', targetDir: 'vendor/sprite-gen', status: 'completed', exitCode: 0 },
            { kind: 'install', tool: 'npm', dir: 'vendor/sprite-gen', status: 'failed', exitCode: 1, stderrTail: 'npm ERR! missing package.json' },
          ],
        },
      },
      {
        eventType: 'artifact.registered',
        artifactRefs: ['artifacts/provision/main-provision-sprite-gen.json'],
        payload: { file: { path: 'artifacts/provision/main-provision-sprite-gen.json', producedBy: 'orpad.provision' } },
      },
      {
        eventType: 'adapter.result',
        nodePath: 'main/probe-runner-animation-contract',
        artifactRefs: ['artifacts/adapters/probe-call.transcript.json'],
        payload: { taskKind: 'probe', status: 'done', proposalCount: 5 },
      },
      { eventType: 'node.started', payload: {} },
    ],
    inventory: { activeCount: 5, doneCount: 0 },
    queueItems: [
      {
        itemId: 'author-runner-sprite-requests',
        state: 'candidate',
        title: 'Author runner sprite generation requests',
        summary: 'Document the exact sprite-gen CLI command: node bin/sprite-gen.mjs --ref assets/Bride.png',
        acceptanceCriteria: ['Generation command is copy-pasteable', 'Output contract recorded'],
      },
    ],
    taskText: 'Test the sprite-gen repo',
  });
  assert.equal(evidence.acceptedWorkerCount, 0);
  assert.equal(evidence.queueItems.length, 1);
  assert.equal(evidence.queueItems[0].state, 'candidate');
  assert.match(evidence.queueItems[0].summary, /sprite-gen CLI command/);
  assert.equal(evidence.queueItems[0].acceptanceCriteria.length, 2);
  assert.equal(evidence.provisions.length, 1);
  assert.equal(evidence.provisions[0].nodePath, 'main/provision-sprite-gen');
  assert.equal(evidence.provisions[0].valid, false);
  assert.equal(evidence.provisions[0].steps[0].kind, 'git-clone');
  assert.equal(evidence.provisions[0].steps[0].status, 'completed');
  assert.equal(evidence.provisions[0].steps[0].exitCode, 0);
  assert.equal(evidence.provisions[0].steps[1].status, 'failed');
  assert.match(evidence.provisions[0].steps[1].stderrTail, /missing package\.json/);
  assert.equal(evidence.probes.length, 1);
  assert.equal(evidence.probes[0].proposalCount, 5);
  assert.equal(evidence.registeredArtifacts.length, 1);
  assert.equal(evidence.registeredArtifacts[0].producedBy, 'orpad.provision');
  assert.ok(evidence.knownEvidenceRefs.includes('artifacts/provision/main-provision-sprite-gen.json'));
  assert.ok(evidence.knownEvidenceRefs.includes('artifacts/adapters/probe-call.transcript.json'));
});

test('buildGateJudgePrompt explains provision evidence as machine-executed proof', () => {
  const evidence = buildGateJudgeEvidence({ events: [], inventory: {}, taskText: '' });
  const prompt = buildGateJudgePrompt(['checkout exists'], evidence);
  assert.ok(prompt.includes('provisions'));
  assert.ok(/machine-executed/i.test(prompt));
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
