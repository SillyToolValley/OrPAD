'use strict';

// Complexity-tier harness for the OrPAD authoring surface.
//
// Maps the Azure "AI agent design patterns" rule — use the lowest complexity that
// reliably meets the requirement — onto OrPAD's authoring pipeline. The runtime
// machine is unchanged; this module only decides how much orchestration shape an
// LLM author has to produce and how strict the *authoring* quality audit is.
//
//   T0  single-call analysis  (Azure level 1/2): read-only probe + evidence,
//                              no work queue / worker / patch-review.
//   T1  linear sequential     (Azure Sequential): the existing workstream scaffold,
//                              but the heavy quality/contract errors are advisory.
//   T2  full graph            (Azure Concurrent/Handoff/Magentic): today's behavior,
//                              every authoring rule enforced.
//
// Default (no tier requested) is T2 so existing callers and tests are unchanged.
// Pass tier:"auto" to run the deterministic classifier.

const TIER_IDS = Object.freeze(['T0', 'T1', 'T2']);
const DEFAULT_TIER = 'T2';
const AUTO_TIER = 'auto';

// Authoring audit codes that must STAY hard errors even at T0/T1: masking these would
// either hide a real security rejection or emit a structurally invalid / un-runnable
// pipeline. Mirrors generator.js NON_RECOVERABLE_AUDIT_CODES + its safety regex.
const SAFETY_CODE_PATTERN = /UNSAFE|SYMLINK|ESCAPE|FORBIDDEN|TRAVERSAL|SECRET|CREDENTIAL/i;
// External-action / permission / isolation-boundary codes are ALSO kept hard at every
// tier. Tier downgrades relax *shape & quality*, never the least-privilege + HITL
// boundary the design treats as non-negotiable. The genuine external action in the
// authoring audit is orpad.provision (git clone + package install over the network):
// AUTHORING_PROVISION_CONFIG_INVALID is authored from the LLM spec, so the authoring gate
// is its real enforcement point and must never relax. The remaining keywords are inert
// against today's authoring codes but forward-compatible (approval / capability grant /
// sandbox / containment / network).
// Deliberately EXCLUDED: node-pack provenance/undeclared codes. Those are
// compiler-fillable declaration hygiene, are re-enforced by the runtime node-pack
// trust+capability audit, and legitimately do not apply to a minimal read-only T0 node
// set — so they MAY relax at low tiers.
const PERMISSION_BOUNDARY_PATTERN = /PROVISION|PULL_REQUEST|APPROVAL|PERMISSION|GRANT|CAPABILITY|SANDBOX|CONTAINMENT|NETWORK/i;
const NON_RECOVERABLE_AUDIT_CODES = new Set([
  'AUTHORING_GRAPH_REF_UNMATERIALIZED',
  'AUTHORING_TREE_REF_UNMATERIALIZED',
]);
const HARD_VALIDITY_CODES = new Set([
  'AUTHORING_VALIDATION_FAILED',
  'AUTHORING_VALIDATION_EXCEPTION',
  'AUTHORING_MACHINE_STEP_UNAVAILABLE',
  'AUTHORING_GRAPHSET_AUDIT_FAILED',
]);

// Intent signals (English + Korean). Conservative: ambiguity resolves upward to T2 so
// the harness never under-provisions a task that actually needs the heavy machinery.
const READONLY_INTENT_PATTERN = /\b(analy[sz]e|analysis|review|reviewing|audit|assess|evaluate|explain|describe|summar(?:y|ize|ise)|compare|investigate|research|explore|understand|document|documentation|outline|recommend|propose|diagnose|inspect|map out|walk through)\b|분석|검토|평가|설명|요약|비교|조사|이해|문서화|진단|점검|살펴/i;
// Write intent also covers mutation/action verbs that a task can phrase WITHOUT an
// obvious "edit code" word — rotate/revoke a secret, document (= author docs), provision,
// publish, etc. Without these, "audit and rotate the API keys" or "document the scheduler"
// reads as pure read-only and under-provisions to T0. Write takes precedence over
// read-only in classifyComplexityTier, so a verb appearing in both buckets resolves to T1,
// never T0. Verbs known to collide with nouns (drop-down, port, format, move, copy) are
// intentionally excluded to avoid false write matches.
const WRITE_INTENT_PATTERN = /\b(implement|fix|fixing|build|add|adding|create|creating|refactor|migrat|rename|delete|remove|removing|update|updating|change|changing|modify|write|writing|patch|integrat|wire|install|deploy|render|configure|set up|setup|replace|optimi[sz]e|generate|rotate|revoke|reset|disable|enable|grant|provision|publish|release|scaffold|document|translate|locali[sz]e|upgrade|downgrade|seed|populate|instrument|harden|revert|roll\s?back|restore|purge)\b|구현|수정|고치|추가|생성|리팩터|마이그레이션|변경|작성|배포|설치|통합|교체|최적화|삭제|제거|회수|비활성화|활성화|발행|번역|초기화|롤백|복원|갱신/i;
const MULTI_STEP_INTENT_PATTERN = /\b(parallel|concurrent|fan[-\s]?out|fork[-\s]?join|multiple (?:agents|workers|files|modules|services|tasks)|across (?:the |all |multiple )|each (?:file|module|service|component)|every (?:file|module|component)|migrat|sweep|bulk|pipeline|orchestrat|multi[-\s]?step|several (?:tasks|steps|files)|end[-\s]?to[-\s]?end|whole (?:codebase|repo))\b|병렬|동시에|여러 (?:파일|모듈|작업|에이전트)|전체|마이그레이션|일괄|파이프라인|오케스트레이션|곳곳/i;

// Node types whose presence in an authored spec means the agent explicitly designed
// the heavy multi-agent path — respect that and keep it at T2.
const HEAVY_NODE_TYPES = new Set([
  'orpad.workQueue',
  'orpad.triage',
  'orpad.dispatcher',
  'orpad.workerLoop',
  'orpad.patchReview',
  'orpad.barrier',
]);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTierId(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase() === AUTO_TIER) return AUTO_TIER;
  const upper = trimmed.toUpperCase();
  return TIER_IDS.includes(upper) ? upper : '';
}

function authoringSpecGraphNodes(authoringSpec) {
  if (!isPlainObject(authoringSpec)) return [];
  const graph = isPlainObject(authoringSpec.graph) ? authoringSpec.graph : authoringSpec;
  return Array.isArray(graph.nodes) ? graph.nodes : [];
}

function authoredSpecIsHeavy(authoringSpec) {
  const nodes = authoringSpecGraphNodes(authoringSpec);
  if (!nodes.length) return false;
  let probeCount = 0;
  for (const node of nodes) {
    const type = String(node?.type || '').trim();
    if (HEAVY_NODE_TYPES.has(type)) return true;
    if (type === 'orpad.probe') probeCount += 1;
  }
  return probeCount >= 2;
}

/**
 * Deterministically classify a task into a complexity tier.
 * @returns {{ tier: 'T0'|'T1'|'T2', reason: string, signals: object }}
 */
function classifyComplexityTier(taskText, options = {}) {
  const text = String(taskText || '');
  const authoringSpec = options.authoringSpec;
  const signals = {
    readonly: READONLY_INTENT_PATTERN.test(text),
    write: WRITE_INTENT_PATTERN.test(text),
    multiStep: MULTI_STEP_INTENT_PATTERN.test(text),
    authoredHeavy: authoredSpecIsHeavy(authoringSpec),
  };

  if (signals.authoredHeavy) {
    return { tier: 'T2', reason: 'authored-spec-uses-workstream-or-multi-probe', signals };
  }
  if (signals.multiStep) {
    return { tier: 'T2', reason: 'multi-step-or-parallel-intent', signals };
  }
  if (signals.readonly && !signals.write) {
    return { tier: 'T0', reason: 'read-only-analysis-intent', signals };
  }
  if (signals.write) {
    return { tier: 'T1', reason: 'single-bounded-write-intent', signals };
  }
  return { tier: 'T2', reason: 'ambiguous-intent-default-t2', signals };
}

/**
 * Resolve the final tier from an explicit request (option / spec metadata / CLI) or,
 * when "auto", the classifier. Unset → DEFAULT_TIER (T2) so existing behavior is kept.
 * @returns {{ tier: 'T0'|'T1'|'T2', reason: string, requested: string, signals?: object }}
 */
function resolveComplexityTier({ requestedTier, taskText, authoringSpec } = {}) {
  const requested = normalizeTierId(requestedTier);
  if (requested && requested !== AUTO_TIER) {
    return { tier: requested, reason: 'explicit-tier-request', requested };
  }
  if (requested === AUTO_TIER) {
    const classified = classifyComplexityTier(taskText, { authoringSpec });
    return { ...classified, reason: `auto:${classified.reason}`, requested: AUTO_TIER };
  }
  return { tier: DEFAULT_TIER, reason: 'default-no-tier-requested', requested: '' };
}

function tierWorkstreamEnabled(tier) {
  return normalizeTierId(tier) !== 'T0';
}

function tierAuditPolicy(tier) {
  const id = normalizeTierId(tier) || DEFAULT_TIER;
  return Object.freeze({
    tier: id === AUTO_TIER ? DEFAULT_TIER : id,
    gateNonSafetyErrors: id === 'T0' || id === 'T1',
  });
}

function auditCodeMustStayError(code) {
  const value = String(code || '').trim();
  if (!value) return true; // unknown code → keep as error (fail closed)
  if (HARD_VALIDITY_CODES.has(value)) return true;
  if (NON_RECOVERABLE_AUDIT_CODES.has(value)) return true;
  if (SAFETY_CODE_PATTERN.test(value)) return true;
  if (PERMISSION_BOUNDARY_PATTERN.test(value)) return true;
  return false;
}

/**
 * Tier-aware gating of an authoring quality audit. For T0/T1, every error diagnostic
 * that is not safety/validity-critical is downgraded to a warning (tagged so the
 * downgrade is auditable). For T2 the audit is returned untouched.
 */
function applyTierAuditGating(audit, tier) {
  if (!isPlainObject(audit)) return audit;
  const policy = tierAuditPolicy(tier);
  if (!policy.gateNonSafetyErrors) return audit;
  const diagnostics = Array.isArray(audit.diagnostics) ? audit.diagnostics : [];
  let downgraded = 0;
  const nextDiagnostics = diagnostics.map((item) => {
    if (!isPlainObject(item) || item.level !== 'error') return item;
    if (auditCodeMustStayError(item.code)) return item;
    downgraded += 1;
    return {
      ...item,
      level: 'warning',
      downgradedFromError: true,
      downgradeReason: `complexity-tier:${policy.tier}`,
    };
  });
  if (!downgraded) return audit;
  const errorCount = nextDiagnostics.filter(item => item.level === 'error').length;
  const warningCount = nextDiagnostics.filter(item => item.level === 'warning').length;
  return {
    ...audit,
    ok: errorCount === 0,
    diagnostics: nextDiagnostics,
    summary: {
      ...(isPlainObject(audit.summary) ? audit.summary : {}),
      errorCount,
      warningCount,
      tierGated: policy.tier,
      tierDowngradedErrorCount: downgraded,
    },
  };
}

function describeComplexityTier(tier) {
  const id = normalizeTierId(tier) || DEFAULT_TIER;
  if (id === 'T0') return 'T0 single-call analysis (read-only, no work queue)';
  if (id === 'T1') return 'T1 linear sequential (one bounded pass, advisory contracts)';
  return 'T2 full graph (multi-agent orchestration, all contracts)';
}

/**
 * Build the raw authoring spec (pre-normalize) for a T0 read-only analysis run:
 * entry → context → probe → artifactContract → exit. No work queue, no worker, no
 * patch-review. Fed to normalizeAuthoringSpec with { skipWorkstreamScaffold: true }.
 */
function buildTierT0AuthoringSpec(taskText, options = {}) {
  const text = String(taskText || '').trim();
  const title = (text.length > 96 ? text.slice(0, 93).trimEnd() + '...' : text)
    || 'Single-call analysis';
  const externalResearchLimitation = String(options.externalResearchLimitation || '');
  const probeConfig = {
    lens: 'analysis',
    userTask: text,
    skillRef: 'request-context',
    maxCandidates: 8,
    candidateLimitPolicy: 'collect-all-visible',
  };
  if (externalResearchLimitation) probeConfig.externalResearchLimitation = externalResearchLimitation;
  return {
    title,
    description: 'T0 single-call analysis: read-only probe and recorded evidence, no work queue.',
    graph: {
      id: 'analysis',
      label: title,
      start: 'entry',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry', config: { summary: 'Begin single-call analysis.' } },
        {
          id: 'context',
          type: 'orpad.context',
          label: 'Collect analysis context',
          config: { ruleRef: 'context', skillRef: 'request-context', summary: text || 'Collect workspace facts for the request.' },
        },
        {
          id: 'analyze',
          type: 'orpad.probe',
          label: 'Analyze and record findings',
          config: probeConfig,
        },
        {
          id: 'artifact',
          type: 'orpad.artifactContract',
          label: 'Record analysis evidence',
          config: {
            artifactRoot: 'harness/generated/latest-run/artifacts',
            queueRoot: 'harness/generated/latest-run/queue',
            required: ['discovery/candidate-inventory.json'],
            requiredQueue: [],
            onMissing: 'warn',
          },
        },
        { id: 'exit', type: 'orpad.exit', label: 'Exit', config: { summary: 'Close after recording analysis evidence.' } },
      ],
      transitions: [
        { from: 'entry', to: 'context' },
        { from: 'context', to: 'analyze' },
        { from: 'analyze', to: 'artifact' },
        { from: 'artifact', to: 'exit' },
      ],
    },
    skill: isPlainObject(options.skill) ? options.skill : {},
    rule: isPlainObject(options.rule) ? options.rule : {},
    metadata: {
      tier: 'T0',
      authoringNotes: 'T0 single-call analysis (Azure lowest-complexity): read-only probe + evidence, no work queue, worker, or patch-review.',
    },
  };
}

/**
 * Build the raw authoring spec (pre-normalize) for a T1 linear single-pass change:
 * entry → context → probe → queue → triage → dispatcher → worker → artifactContract → exit.
 * No patch-review node and no verification gate, so normalizeAuthoringSpec (with
 * { skipWorkstreamScaffold: true }) and enforceTransitionContracts add NO queue-drain loop
 * and NO gate-revise loop — the result is a genuinely linear single bounded worker pass
 * (Azure Sequential). The machine runs this shape: it is the smoke-harness worker chain
 * plus entry/exit. The worker's item-evidence contract + artifact contract provide the
 * verification that the dropped gate would have, without an iterative loop.
 */
function buildTierT1AuthoringSpec(taskText, options = {}) {
  const text = String(taskText || '').trim();
  const title = (text.length > 96 ? text.slice(0, 93).trimEnd() + '...' : text)
    || 'Single bounded change';
  const externalResearchLimitation = String(options.externalResearchLimitation || '');
  const probeConfig = {
    lens: 'request-focused',
    userTask: text,
    skillRef: 'request-context',
    maxCandidates: 5,
    candidateLimitPolicy: 'collect-all-visible',
  };
  if (externalResearchLimitation) probeConfig.externalResearchLimitation = externalResearchLimitation;
  return {
    title,
    description: 'T1 linear sequential: a single bounded implementation pass with evidence, no patch-review or queue-drain loops.',
    graph: {
      id: 'linear-change',
      label: title,
      start: 'entry',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry', config: { summary: 'Begin single bounded change.' } },
        {
          id: 'context',
          type: 'orpad.context',
          label: 'Collect change context',
          config: { ruleRef: 'context', skillRef: 'request-context', summary: text || 'Collect workspace facts for the request.' },
        },
        { id: 'probe', type: 'orpad.probe', label: 'Scope the change', config: probeConfig },
        { id: 'queue', type: 'orpad.workQueue', label: 'Queue the bounded work', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', label: 'Order the work', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', label: 'Claim one item', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', label: 'Implement the change', config: { queueRef: 'queue', targetFiles: [] } },
        {
          id: 'artifact',
          type: 'orpad.artifactContract',
          label: 'Record change evidence',
          config: { artifactRoot: 'harness/generated/latest-run/artifacts', queueRoot: 'harness/generated/latest-run/queue' },
        },
        { id: 'exit', type: 'orpad.exit', label: 'Exit', config: { summary: 'Close after recording change evidence.' } },
      ],
      transitions: [
        { from: 'entry', to: 'context' },
        { from: 'context', to: 'probe' },
        { from: 'probe', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
        { from: 'worker', to: 'artifact' },
        { from: 'artifact', to: 'exit' },
      ],
    },
    skill: isPlainObject(options.skill) ? options.skill : {},
    rule: isPlainObject(options.rule) ? options.rule : {},
    metadata: {
      tier: 'T1',
      authoringNotes: 'T1 linear sequential (Azure Sequential): one bounded worker pass with evidence, no patch-review reject loop or queue-drain loop.',
    },
  };
}

// Gate nodes only invoke an LLM when their judge policy escalates to one. A rule-only
// gate is deterministic and costs nothing at the model.
const LLM_JUDGE_POLICIES = new Set(['rule-then-llm', 'llm-required', 'llm-only']);

function gateInvokesLlm(node) {
  const policy = String(node?.config?.judgePolicy || '').trim().toLowerCase();
  return LLM_JUDGE_POLICIES.has(policy);
}

/**
 * Structural, deterministic per-tier cost observation. The cost driver of an orchestration
 * is how many LLM adapter calls it makes — that is countable from the graph without knowing
 * the model or prompt (which the live run budget meter handles for actual $/tokens). Azure's
 * guide: cost is a consequence of the pattern/tier choice. T0 is cheap (one read-only probe),
 * T2 is expensive (fan-out probes + worker loops + LLM gates).
 * @returns {{ tier, costClass, llmNodeCount, probes, workers, triage, llmGates, maxAdapterCalls, loopBackRedriveLimit, note }}
 */
function estimateTierCostProfile(tier, nodes = [], options = {}) {
  const normalized = normalizeTierId(tier);
  const id = (!normalized || normalized === AUTO_TIER) ? DEFAULT_TIER : normalized;
  const list = Array.isArray(nodes) ? nodes : [];
  let probes = 0;
  let workers = 0;
  let triage = 0;
  let llmGates = 0;
  for (const node of list) {
    const type = String(node?.type || '').trim();
    if (type === 'orpad.probe') probes += 1;
    else if (type === 'orpad.workerLoop') workers += 1;
    else if (type === 'orpad.triage') triage += 1;
    else if (type === 'orpad.gate' && gateInvokesLlm(node)) llmGates += 1;
  }
  const loopBackRedriveLimit = Math.max(0, Number(options.loopBackRedriveLimit ?? 1) || 0);
  const llmNodeCount = probes + workers + triage + llmGates;
  // Probes / triage / LLM-gates each run once; a worker can be re-driven up to
  // loopBackRedriveLimit times after its first pass, so it accounts for (1 + limit) calls.
  const maxAdapterCalls = probes + triage + llmGates + workers * (1 + loopBackRedriveLimit);
  const costClass = id === 'T0' ? 'low' : id === 'T1' ? 'medium' : 'high';
  return {
    tier: id,
    costClass,
    llmNodeCount,
    probes,
    workers,
    triage,
    llmGates,
    maxAdapterCalls,
    loopBackRedriveLimit,
    note: 'Structural estimate of LLM adapter calls (the cost driver). Actual token/$ cost is tracked live by the run budget meter.',
  };
}

module.exports = {
  TIER_IDS,
  DEFAULT_TIER,
  AUTO_TIER,
  estimateTierCostProfile,
  classifyComplexityTier,
  resolveComplexityTier,
  tierWorkstreamEnabled,
  tierAuditPolicy,
  applyTierAuditGating,
  describeComplexityTier,
  buildTierT0AuthoringSpec,
  buildTierT1AuthoringSpec,
  auditCodeMustStayError,
};
