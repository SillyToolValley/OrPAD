import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tier = require(path.join(repoRoot, 'src/main/orchestration-authoring/complexity-tier.js'));
const { createOrchestrationPipeline } = require(path.join(repoRoot, 'src/main/orchestration-authoring/generator.js'));

const WORKSPACE_SNAPSHOT = {
  files: ['README.md', 'package.json', 'src/main/orchestration-machine/machine.js', 'src/renderer/App.jsx'],
};
const TIMESTAMP = '2026-06-15T12:00:00.000Z';

async function withTempWorkspace(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-tier-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function graphNodeTypes(graph) {
  return new Set((graph.graph?.nodes || []).map(node => node.type));
}

// ---------------------------------------------------------------------------
// Pure classifier
// ---------------------------------------------------------------------------

test('classifyComplexityTier: read-only analysis intent → T0', () => {
  const result = tier.classifyComplexityTier('Analyze the orchestration machine and explain how the scheduler works');
  assert.equal(result.tier, 'T0');
  assert.equal(result.signals.readonly, true);
  assert.equal(result.signals.write, false);
});

test('classifyComplexityTier: single bounded write intent → T1', () => {
  const result = tier.classifyComplexityTier('Fix the bug in the dispatcher node');
  assert.equal(result.tier, 'T1');
});

test('classifyComplexityTier: mutation verbs phrased without "edit code" stay out of T0', () => {
  // Previously these read as pure read-only and under-provisioned to T0.
  assert.equal(tier.classifyComplexityTier('Audit and rotate the API keys').tier, 'T1');
  assert.equal(tier.classifyComplexityTier('Document the scheduler module').tier, 'T1');
  assert.equal(tier.classifyComplexityTier('Review and revoke unused tokens').tier, 'T1');
  assert.equal(tier.classifyComplexityTier('API 키를 점검하고 회수해줘').tier, 'T1');
  // Pure analysis still classifies as T0.
  assert.equal(tier.classifyComplexityTier('Analyze the architecture').tier, 'T0');
  assert.equal(tier.classifyComplexityTier('Explain how the scheduler works').tier, 'T0');
  // Nouns that collide with mutation verbs must NOT trigger a false write match.
  assert.equal(tier.classifyComplexityTier('Explain the drop-down menu behavior').tier, 'T0');
});

test('classifyComplexityTier: multi-step / parallel intent → T2', () => {
  const result = tier.classifyComplexityTier('Migrate every module across the whole codebase in parallel');
  assert.equal(result.tier, 'T2');
  assert.equal(result.signals.multiStep, true);
});

test('classifyComplexityTier: ambiguous intent defaults to T2 (never under-provision)', () => {
  assert.equal(tier.classifyComplexityTier('the orchestration machine internals').tier, 'T2');
});

test('classifyComplexityTier: authored heavy spec forces T2 even on read-only text', () => {
  const authoringSpec = {
    graph: { nodes: [{ type: 'orpad.entry' }, { type: 'orpad.workerLoop' }, { type: 'orpad.exit' }] },
  };
  const result = tier.classifyComplexityTier('Review the code', { authoringSpec });
  assert.equal(result.tier, 'T2');
  assert.equal(result.signals.authoredHeavy, true);
});

// ---------------------------------------------------------------------------
// resolveComplexityTier (explicit vs auto vs default)
// ---------------------------------------------------------------------------

test('resolveComplexityTier: unset → T2 default (preserves existing behavior)', () => {
  const result = tier.resolveComplexityTier({ taskText: 'Analyze the code' });
  assert.equal(result.tier, 'T2');
  assert.equal(result.reason, 'default-no-tier-requested');
});

test('resolveComplexityTier: explicit tier wins, case-insensitive', () => {
  assert.equal(tier.resolveComplexityTier({ requestedTier: 't0' }).tier, 'T0');
  assert.equal(tier.resolveComplexityTier({ requestedTier: 'T2' }).tier, 'T2');
});

test('resolveComplexityTier: auto runs the classifier', () => {
  const result = tier.resolveComplexityTier({ requestedTier: 'auto', taskText: 'Summarize the architecture' });
  assert.equal(result.tier, 'T0');
  assert.match(result.reason, /^auto:/);
});

test('resolveComplexityTier: invalid tier string → default T2', () => {
  assert.equal(tier.resolveComplexityTier({ requestedTier: 'banana', taskText: 'anything' }).tier, 'T2');
});

test('tierWorkstreamEnabled: only T0 disables the workstream scaffold', () => {
  assert.equal(tier.tierWorkstreamEnabled('T0'), false);
  assert.equal(tier.tierWorkstreamEnabled('T1'), true);
  assert.equal(tier.tierWorkstreamEnabled('T2'), true);
});

// ---------------------------------------------------------------------------
// Audit gating
// ---------------------------------------------------------------------------

function fakeAudit(diagnostics) {
  const errorCount = diagnostics.filter(d => d.level === 'error').length;
  return {
    ok: errorCount === 0,
    diagnostics,
    summary: { errorCount, warningCount: diagnostics.filter(d => d.level === 'warning').length },
  };
}

test('applyTierAuditGating: T2 returns the audit untouched', () => {
  const audit = fakeAudit([{ level: 'error', code: 'AUTHORING_GATE_CRITERIA_WEAK' }]);
  assert.equal(tier.applyTierAuditGating(audit, 'T2'), audit);
});

test('applyTierAuditGating: T0/T1 downgrade non-safety errors but keep safety + validity', () => {
  const audit = fakeAudit([
    { level: 'error', code: 'AUTHORING_GATE_CRITERIA_WEAK' },
    { level: 'error', code: 'AUTHORING_CONTENT_EDITORIAL_GATE_MISSING' },
    { level: 'error', code: 'AUTHORING_VALIDATION_FAILED' },
    { level: 'error', code: 'AUTHORING_TREE_REF_ESCAPES_PIPELINE' },
    { level: 'warning', code: 'AUTHORING_GATE_CRITERIA_AUTOFILLED' },
  ]);
  const gated = tier.applyTierAuditGating(audit, 'T0');
  const byCode = Object.fromEntries(gated.diagnostics.map(d => [d.code, d.level]));
  assert.equal(byCode.AUTHORING_GATE_CRITERIA_WEAK, 'warning');
  assert.equal(byCode.AUTHORING_CONTENT_EDITORIAL_GATE_MISSING, 'warning');
  assert.equal(byCode.AUTHORING_VALIDATION_FAILED, 'error', 'hard validity stays an error');
  assert.equal(byCode.AUTHORING_TREE_REF_ESCAPES_PIPELINE, 'error', 'safety stays an error');
  assert.equal(gated.summary.tierDowngradedErrorCount, 2);
  assert.equal(gated.ok, false, 'still blocked by remaining safety/validity errors');
});

test('applyTierAuditGating: a fully-downgradable audit becomes ok at T1', () => {
  const audit = fakeAudit([
    { level: 'error', code: 'AUTHORING_GRAPH_LINEAR_UNDERFIT' },
    { level: 'error', code: 'AUTHORING_QUEUE_DRAIN_GATE_MISSING' },
  ]);
  const gated = tier.applyTierAuditGating(audit, 'T1');
  assert.equal(gated.ok, true);
  assert.equal(gated.diagnostics.filter(d => d.level === 'error').length, 0);
});

test('auditCodeMustStayError: unknown codes fail closed', () => {
  assert.equal(tier.auditCodeMustStayError(''), true);
  assert.equal(tier.auditCodeMustStayError('AUTHORING_GATE_CRITERIA_WEAK'), false);
  assert.equal(tier.auditCodeMustStayError('SOMETHING_UNSAFE_HERE'), true);
});

test('applyTierAuditGating: external-action / permission boundary codes stay hard at T0/T1', () => {
  // orpad.provision is a git clone + package install (network + arbitrary execution) and
  // is authored from the LLM spec, so the authoring gate is the real enforcement point —
  // it must not relax with the tier. Permission/capability/approval keywords are kept too.
  assert.equal(tier.auditCodeMustStayError('AUTHORING_PROVISION_CONFIG_INVALID'), true);
  assert.equal(tier.auditCodeMustStayError('NODE_PACK_HIGH_RISK_CAPABILITY_REQUIRES_APPROVAL'), true);
  // Node-pack provenance/undeclared is compiler-fillable declaration hygiene re-enforced
  // by the runtime trust audit, so it MAY relax at low tiers — it legitimately does not
  // apply to a minimal read-only T0 node set.
  assert.equal(tier.auditCodeMustStayError('AUTHORING_NODE_PACK_PROVENANCE_MISSING'), false);
  assert.equal(tier.auditCodeMustStayError('AUTHORING_NODE_PACK_REFERENCE_UNDECLARED'), false);

  const audit = fakeAudit([
    { level: 'error', code: 'AUTHORING_PROVISION_CONFIG_INVALID' },
    { level: 'error', code: 'AUTHORING_GATE_CRITERIA_WEAK' },
  ]);
  const gated = tier.applyTierAuditGating(audit, 'T1');
  const byCode = Object.fromEntries(gated.diagnostics.map(d => [d.code, d.level]));
  assert.equal(byCode.AUTHORING_PROVISION_CONFIG_INVALID, 'error', 'provision config stays blocking');
  assert.equal(byCode.AUTHORING_GATE_CRITERIA_WEAK, 'warning', 'quality nitpick still relaxes');
  assert.equal(gated.ok, false);
});

// ---------------------------------------------------------------------------
// Per-tier cost observation (B4)
// ---------------------------------------------------------------------------

test('estimateTierCostProfile: counts LLM adapter calls and classes by tier', () => {
  const t0 = tier.estimateTierCostProfile('T0', [{ type: 'orpad.probe' }]);
  assert.equal(t0.costClass, 'low');
  assert.equal(t0.maxAdapterCalls, 1); // one read-only probe

  const t1 = tier.estimateTierCostProfile(
    'T1',
    [{ type: 'orpad.probe' }, { type: 'orpad.triage' }, { type: 'orpad.workerLoop' }, { type: 'orpad.dispatcher' }],
    { loopBackRedriveLimit: 1 },
  );
  assert.equal(t1.costClass, 'medium');
  // probe(1) + triage(1) + worker(1 + loopBack 1 = 2) = 4; dispatcher is deterministic (0).
  assert.equal(t1.maxAdapterCalls, 4);
  assert.equal(t1.workers, 1);

  const t2 = tier.estimateTierCostProfile(
    'T2',
    [{ type: 'orpad.probe' }, { type: 'orpad.probe' }, { type: 'orpad.triage' }, { type: 'orpad.workerLoop' }, { type: 'orpad.gate', config: { judgePolicy: 'llm-required' } }],
    { loopBackRedriveLimit: 1 },
  );
  assert.equal(t2.costClass, 'high');
  // probes(2) + triage(1) + llm-gate(1) + worker(2) = 6
  assert.equal(t2.maxAdapterCalls, 6);
  assert.equal(t2.llmGates, 1);
});

test('estimateTierCostProfile: deterministic (rule-only / plain) gates are not LLM calls', () => {
  const p = tier.estimateTierCostProfile('T2', [
    { type: 'orpad.gate', config: { judgePolicy: 'rule-only' } },
    { type: 'orpad.gate' },
    { type: 'orpad.dispatcher' },
    { type: 'orpad.artifactContract' },
  ]);
  assert.equal(p.llmGates, 0);
  assert.equal(p.maxAdapterCalls, 0);
});

// ---------------------------------------------------------------------------
// T0 spec builder
// ---------------------------------------------------------------------------

test('buildTierT0AuthoringSpec: read-only shape, no workstream node types', () => {
  const spec = tier.buildTierT0AuthoringSpec('Explain the scheduler');
  const types = spec.graph.nodes.map(n => n.type);
  assert.ok(types.includes('orpad.probe'));
  assert.ok(types.includes('orpad.artifactContract'));
  for (const heavy of ['orpad.workQueue', 'orpad.triage', 'orpad.dispatcher', 'orpad.workerLoop', 'orpad.patchReview']) {
    assert.ok(!types.includes(heavy), `T0 spec must not contain ${heavy}`);
  }
  assert.equal(spec.metadata.tier, 'T0');
});

// ---------------------------------------------------------------------------
// Integration: createOrchestrationPipeline honors the tier
// ---------------------------------------------------------------------------

test('generate: explicit T0 produces a runnable read-only pipeline with no worker/queue', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const result = await createOrchestrationPipeline({
      workspaceRoot,
      prompt: 'Analyze how the orchestration scheduler picks the next ready node',
      tier: 'T0',
      timestamp: TIMESTAMP,
      workspaceSnapshot: WORKSPACE_SNAPSHOT,
    });
    assert.equal(result.success, true);
    assert.equal(result.complexityTier, 'T0');

    const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
    const types = graphNodeTypes(graph);
    assert.ok(types.has('orpad.probe'));
    assert.ok(types.has('orpad.artifactContract'));
    assert.ok(!types.has('orpad.workerLoop'), 'T0 must not inject a worker loop');
    assert.ok(!types.has('orpad.workQueue'), 'T0 must not inject a work queue');
    assert.ok(!types.has('orpad.dispatcher'), 'T0 must not inject a dispatcher');

    const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
    assert.equal(pipeline.run.queueProtocol, undefined, 'T0 omits queueProtocol');
    assert.equal(pipeline.run.machineAdapter.workerNodePath, undefined, 'T0 omits worker adapter path');
    assert.equal(pipeline.metadata.orchestrationAuthoring.complexityTier, 'T0');
  });
});

test('generate: no tier → unchanged T2 behavior (full workstream scaffold)', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const result = await createOrchestrationPipeline({
      workspaceRoot,
      prompt: 'Analyze how the orchestration scheduler picks the next ready node',
      timestamp: TIMESTAMP,
      workspaceSnapshot: WORKSPACE_SNAPSHOT,
    });
    assert.equal(result.success, true);
    assert.equal(result.complexityTier, 'T2');

    const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
    const types = graphNodeTypes(graph);
    assert.ok(types.has('orpad.workerLoop'), 'default (T2) still injects the worker loop');
    assert.ok(types.has('orpad.workQueue'), 'default (T2) still injects the work queue');

    const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
    assert.ok(pipeline.run.queueProtocol, 'T2 keeps queueProtocol');
    assert.ok(pipeline.run.machineAdapter.workerNodePath, 'T2 keeps worker adapter path');
  });
});

test('generate: T1 (no authored spec) produces a lean linear pipeline — worker, no patch-review, no loops', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const result = await createOrchestrationPipeline({
      workspaceRoot,
      prompt: 'Fix the off-by-one bug in the dispatcher claim counter',
      tier: 'T1',
      timestamp: TIMESTAMP,
      workspaceSnapshot: WORKSPACE_SNAPSHOT,
    });
    assert.equal(result.success, true);
    assert.equal(result.complexityTier, 'T1');

    const graph = JSON.parse(await fs.readFile(result.graphPath, 'utf-8'));
    const nodes = graph.graph.nodes;
    const types = new Set(nodes.map(n => n.type));
    assert.ok(types.has('orpad.workerLoop'), 'T1 keeps a worker — it implements the change');
    assert.ok(types.has('orpad.workQueue'));
    assert.ok(!types.has('orpad.patchReview'), 'lean T1 drops the patch-review reject loop');
    assert.ok(!types.has('orpad.gate'), 'lean T1 drops the verification gate (no gate-revise loop)');

    // Truly linear: no loop-back edge (no transition whose target is at or before its source).
    const indexById = new Map(nodes.map((n, i) => [n.id, i]));
    const loopBacks = graph.graph.transitions.filter(t => indexById.get(t.to) <= indexById.get(t.from));
    assert.equal(loopBacks.length, 0, `lean T1 must be linear; found loop-backs: ${JSON.stringify(loopBacks)}`);

    const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
    assert.equal(pipeline.metadata.orchestrationAuthoring.mode, 'tier-t1-linear');
    assert.ok(pipeline.run.machineAdapter.workerNodePath, 'T1 keeps the worker adapter path');
  });
});

test('generate: T1 WITH an authored spec keeps the authored path (audit relaxed, not the lean builder)', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const authoringSpec = {
      title: 'Authored T1',
      graph: {
        id: 'authored', label: 'Authored', start: 'entry',
        nodes: [
          { id: 'entry', type: 'orpad.entry', label: 'Entry' },
          { id: 'ctx', type: 'orpad.context', label: 'Context', config: { summary: 'Authored context.' } },
          { id: 'exit', type: 'orpad.exit', label: 'Exit' },
        ],
        transitions: [{ from: 'entry', to: 'ctx' }, { from: 'ctx', to: 'exit' }],
      },
    };
    const result = await createOrchestrationPipeline({
      workspaceRoot,
      prompt: 'implement the authored change',
      tier: 'T1',
      authoringSpec,
      timestamp: TIMESTAMP,
      workspaceSnapshot: WORKSPACE_SNAPSHOT,
    });
    assert.equal(result.success, true);
    assert.equal(result.complexityTier, 'T1');
    const pipeline = JSON.parse(await fs.readFile(result.pipelinePath, 'utf-8'));
    assert.equal(pipeline.metadata.orchestrationAuthoring.mode, 'llm-authored-spec');
  });
});

test('generate: records a per-tier cost profile; T0 makes fewer LLM calls than lean-T1', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const t0 = await createOrchestrationPipeline({
      workspaceRoot,
      prompt: 'Analyze how the scheduler picks the next ready node',
      tier: 'T0',
      timestamp: TIMESTAMP,
      workspaceSnapshot: WORKSPACE_SNAPSHOT,
    });
    const t1 = await createOrchestrationPipeline({
      workspaceRoot,
      prompt: 'Fix the off-by-one bug in the dispatcher claim counter',
      tier: 'T1',
      timestamp: TIMESTAMP,
      workspaceSnapshot: WORKSPACE_SNAPSHOT,
    });

    assert.equal(t0.complexityTierCost.costClass, 'low');
    assert.equal(t1.complexityTierCost.costClass, 'medium');
    assert.equal(t0.complexityTierCost.workers, 0, 'T0 is read-only — no worker calls');
    assert.ok(
      t1.complexityTierCost.maxAdapterCalls > t0.complexityTierCost.maxAdapterCalls,
      `lean-T1 (${t1.complexityTierCost.maxAdapterCalls}) should cost more LLM calls than T0 (${t0.complexityTierCost.maxAdapterCalls})`,
    );

    const pipeline = JSON.parse(await fs.readFile(t0.pipelinePath, 'utf-8'));
    assert.equal(pipeline.metadata.orchestrationAuthoring.complexityTierCost.tier, 'T0');
    assert.equal(pipeline.metadata.orchestrationAuthoring.complexityTierCost.costClass, 'low');
  });
});

test('generate: tier "auto" classifies a read-only prompt as T0', async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const result = await createOrchestrationPipeline({
      workspaceRoot,
      prompt: 'Review and summarize the renderer architecture and explain the data flow',
      tier: 'auto',
      timestamp: TIMESTAMP,
      workspaceSnapshot: WORKSPACE_SNAPSHOT,
    });
    assert.equal(result.success, true);
    assert.equal(result.complexityTier, 'T0');
    assert.match(result.complexityTierReason, /^auto:/);
  });
});
