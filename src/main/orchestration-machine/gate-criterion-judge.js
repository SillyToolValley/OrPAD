// Generic gate-criterion LLM judge.
//
// OrPAD's deterministic gate evaluator (evaluateGateCriterion in machine.js)
// only recognizes two hardcoded criterion phrases ("worker proof accepted" /
// "work result accepted" and "queue empty" / "active queue empty"). Every
// other criterion — including the free-form, task-specific criteria authored by
// the pipeline-generation agent ("typecheck passes for every service",
// "transform anchors match the MSW protocol", ...) — falls through to
// `unsupported-criterion` and, under onFail:block, fails the run permanently.
//
// This module is the missing evaluation tier: when a live judge adapter is
// available, the *unsupported* criteria of a gate are evaluated together in a
// single LLM call, grounded strictly in the run's own worker evidence (worker
// result summaries, changed files, verification commands/exit codes, registered
// artifacts). The judge returns a per-criterion {passed, reason} verdict.
//
// Safety / graceful degradation is the contract: this is only ever reached when
// the machine threads an explicit `gateJudgeAdapter` into validateGateNode (live
// runs only). With no adapter — every existing test, every harness/fixture run —
// the criteria stay `unsupported` and the machine keeps exactly its prior
// behavior. Any judge failure (no adapter, transport error, malformed JSON)
// returns null so the caller falls back to the original `unsupported` evals.
// A judge verdict never silently passes a criterion the evidence does not
// support: the prompt requires the verdict be grounded in supplied evidence,
// and an omitted criterion is treated as failed, not passed.

const { normalizeLockPath } = require('./file-lock-manager');

const GATE_JUDGE_SCHEMA_VERSION = 'orpad.gateCriterionEvaluation.v1';
const GATE_JUDGE_SOURCE = 'llm-judge';
const MAX_WORKERS_IN_EVIDENCE = 24;
const MAX_VERIFICATION_PER_WORKER = 12;
const MAX_CHANGED_FILES_PER_WORKER = 40;
const MAX_SUMMARY_CHARS = 600;
const MAX_PROVISIONS_IN_EVIDENCE = 8;
const MAX_STEPS_PER_PROVISION = 8;
const MAX_PROBES_IN_EVIDENCE = 12;
const MAX_REGISTERED_ARTIFACTS_IN_EVIDENCE = 48;
const MAX_QUEUE_ITEMS_IN_EVIDENCE = 24;
const MAX_ACCEPTANCE_CRITERIA_PER_ITEM = 6;

function normalizeCriterion(value) {
  return String(value || '').trim().toLowerCase();
}

function clampText(value, max) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function normalizeVerificationEntry(entry = {}) {
  const command = clampText(entry.command || '', 200);
  const args = Array.isArray(entry.args) ? entry.args.map(arg => clampText(arg, 80)).slice(0, 12) : [];
  const out = { command };
  if (entry.status) out.status = clampText(entry.status, 40);
  if (entry.summary) out.summary = clampText(entry.summary, 400);
  if (args.length) out.args = args;
  if (Number.isFinite(Number(entry.exitCode))) out.exitCode = Number(entry.exitCode);
  if (entry.timedOut === true) out.timedOut = true;
  if (entry.cwdKind) out.cwdKind = clampText(entry.cwdKind, 60);
  return out;
}

function normalizeProvisionStepEntry(step = {}) {
  const out = { kind: clampText(step.kind || '', 40), status: clampText(step.status || '', 40) };
  if (step.repo) out.repo = clampText(step.repo, 200);
  if (step.targetDir) out.targetDir = clampText(step.targetDir, 200);
  if (step.tool) out.tool = clampText(step.tool, 40);
  if (step.dir) out.dir = clampText(step.dir, 200);
  if (step.skippedReason) out.skippedReason = clampText(step.skippedReason, 80);
  if (Number.isFinite(Number(step.exitCode))) out.exitCode = Number(step.exitCode);
  if (step.detail) out.detail = clampText(step.detail, 300);
  if (step.stderrTail) out.stderrTail = clampText(step.stderrTail, 300);
  return out;
}

// Collect the run's machine-owned evidence into a compact, judge-readable
// structure. The judge can only evaluate against what actually happened, so
// this is the sole source of truth handed to the model — there is no
// workspace read here. Workers are NOT the only evidence source: provision
// steps, discovery probe results, and registered artifacts all exist before
// the first worker runs, and pre-worker gates judged against an empty
// package fail unconditionally (SpriteGenTest gate-toolchain-mapped trace).
function buildGateJudgeEvidence(input = {}) {
  const events = Array.isArray(input.events) ? input.events : [];
  const inventory = input.inventory || {};
  const knownRefs = new Set();
  const workers = [];
  const provisions = [];
  const probes = [];
  const registeredArtifacts = [];
  for (const event of events) {
    if (event?.eventType === 'node.completed' && event.payload?.nodeType === 'orpad.provision') {
      const payload = event.payload || {};
      provisions.push({
        nodePath: clampText(event.nodePath || '', 160),
        valid: payload.valid === true,
        onFail: clampText(payload.onFail || '', 20),
        stepCount: Number.isFinite(Number(payload.stepCount)) ? Number(payload.stepCount) : null,
        executedCount: Number.isFinite(Number(payload.executedCount)) ? Number(payload.executedCount) : null,
        skippedCount: Number.isFinite(Number(payload.skippedCount)) ? Number(payload.skippedCount) : null,
        failedCount: Number.isFinite(Number(payload.failedCount)) ? Number(payload.failedCount) : null,
        steps: (Array.isArray(payload.steps) ? payload.steps : [])
          .slice(0, MAX_STEPS_PER_PROVISION)
          .map(normalizeProvisionStepEntry),
      });
      if (payload.evidenceArtifact) knownRefs.add(normalizeLockPath(payload.evidenceArtifact));
      continue;
    }
    if (event?.eventType === 'adapter.result') {
      const payload = event.payload || {};
      const artifactRefs = (Array.isArray(event.artifactRefs) ? event.artifactRefs : [])
        .map(normalizeLockPath)
        .filter(Boolean);
      artifactRefs.forEach(ref => knownRefs.add(ref));
      probes.push({
        nodePath: clampText(event.nodePath || '', 160),
        taskKind: clampText(payload.taskKind || '', 40),
        status: clampText(payload.status || '', 40),
        ...(payload.summary ? { summary: clampText(payload.summary, MAX_SUMMARY_CHARS) } : {}),
        ...(Number.isFinite(Number(payload.proposalCount)) ? { proposalCount: Number(payload.proposalCount) } : {}),
        artifactRefs,
      });
      continue;
    }
    if (event?.eventType === 'artifact.registered') {
      const file = event.payload?.file || {};
      const refPath = normalizeLockPath(file.path || (Array.isArray(event.artifactRefs) ? event.artifactRefs[0] : ''));
      if (refPath) {
        knownRefs.add(refPath);
        registeredArtifacts.push({
          path: refPath,
          ...(file.producedBy ? { producedBy: clampText(file.producedBy, 80) } : {}),
        });
      }
      continue;
    }
    if (event?.eventType !== 'worker.result') continue;
    const payload = event.payload || {};
    if (payload.status !== 'done') continue;
    const changedFiles = (Array.isArray(payload.changedFiles) ? payload.changedFiles : [])
      .map(normalizeLockPath)
      .filter(Boolean);
    const artifactRefs = (Array.isArray(event.artifactRefs) ? event.artifactRefs : [])
      .map(normalizeLockPath)
      .filter(Boolean);
    const declaredArtifacts = (Array.isArray(payload.artifacts) ? payload.artifacts : [])
      .map(item => (typeof item === 'string' ? item : (item?.path || item?.file || item?.ref || '')))
      .map(normalizeLockPath)
      .filter(Boolean);
    const verification = (Array.isArray(payload.verification) ? payload.verification : [])
      .slice(0, MAX_VERIFICATION_PER_WORKER)
      .map(normalizeVerificationEntry);
    changedFiles.forEach(file => knownRefs.add(file));
    artifactRefs.forEach(ref => knownRefs.add(ref));
    declaredArtifacts.forEach(ref => knownRefs.add(ref));
    if (payload.patchArtifact) knownRefs.add(normalizeLockPath(payload.patchArtifact));
    workers.push({
      itemId: clampText(event.itemId || payload.itemId || '', 120),
      summary: clampText(payload.summary || '', MAX_SUMMARY_CHARS),
      changedFiles: changedFiles.slice(0, MAX_CHANGED_FILES_PER_WORKER),
      patchArtifact: payload.patchArtifact ? normalizeLockPath(payload.patchArtifact) : '',
      artifactRefs,
      artifacts: declaredArtifacts,
      verification,
    });
  }
  const trimmedWorkers = workers.slice(-MAX_WORKERS_IN_EVIDENCE);
  const queueItems = (Array.isArray(input.queueItems) ? input.queueItems : [])
    .filter(entry => entry && (entry.itemId || entry.title))
    .slice(0, MAX_QUEUE_ITEMS_IN_EVIDENCE)
    .map(entry => ({
      itemId: clampText(entry.itemId || '', 120),
      state: clampText(entry.state || '', 40),
      title: clampText(entry.title || '', 200),
      ...(entry.summary ? { summary: clampText(entry.summary, MAX_SUMMARY_CHARS) } : {}),
      ...(Array.isArray(entry.acceptanceCriteria) && entry.acceptanceCriteria.length
        ? { acceptanceCriteria: entry.acceptanceCriteria.slice(0, MAX_ACCEPTANCE_CRITERIA_PER_ITEM).map(item => clampText(item, 300)) }
        : {}),
    }));
  return {
    schemaVersion: GATE_JUDGE_SCHEMA_VERSION,
    taskText: clampText(input.taskText || '', 1600),
    activeQueueCount: Number.isFinite(Number(inventory.activeCount)) ? Number(inventory.activeCount) : null,
    completedQueueCount: Number.isFinite(Number(inventory.doneCount)) ? Number(inventory.doneCount) : null,
    acceptedWorkerCount: workers.length,
    workers: trimmedWorkers,
    provisions: provisions.slice(-MAX_PROVISIONS_IN_EVIDENCE),
    probes: probes.slice(-MAX_PROBES_IN_EVIDENCE),
    registeredArtifacts: registeredArtifacts.slice(-MAX_REGISTERED_ARTIFACTS_IN_EVIDENCE),
    queueItems,
    knownEvidenceRefs: [...knownRefs],
  };
}

function buildGateJudgePrompt(criteria, evidence) {
  const criteriaList = criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n');
  return [
    'You are OrPAD\'s gate-criterion judge. A pipeline run has produced machine-owned evidence and reached a quality gate.',
    'Decide, for EACH listed criterion, whether the run evidence demonstrably satisfies it.',
    '',
    'Hard rules:',
    '- Judge ONLY against the evidence provided below. Do not assume work happened that the evidence does not show.',
    '- A criterion passes ONLY if the evidence clearly demonstrates it (e.g. a relevant changed file plus a passing verification command, an explicit worker summary backed by an artifact, or a machine-executed provision step that completed with exit code 0).',
    '- `provisions` entries are machine-executed environment steps (git clone, dependency install) with exit codes — a completed clone step IS proof the checkout exists; a failed or skipped step is proof of its own status.',
    '- `probes` are discovery results and `registeredArtifacts` lists artifacts the machine recorded; they prove that discovery ran and what it filed, but artifact CONTENTS are not shown — do not invent contents.',
    '- `queueItems` are work items discovery filed. Their titles/summaries/acceptance criteria ARE evidence of what discovery documented or planned, but a candidate/queued item is NOT proof its work was performed — only done items backed by worker evidence prove completed work.',
    '- If the evidence is missing, ambiguous, or insufficient to confirm a criterion, mark it passed=false and say what evidence is missing.',
    '- Cite the concrete evidence you relied on in evidenceRefs (file paths, artifact refs, or verification commands copied from the evidence).',
    '- Copy each criterion verbatim into the "criterion" field.',
    '',
    'Criteria to evaluate:',
    criteriaList,
    '',
    'Run evidence (JSON):',
    JSON.stringify(evidence, null, 2),
    '',
    'Respond with JSON ONLY, no prose, exactly this shape:',
    '{"evaluations":[{"criterion":"<verbatim criterion>","passed":true,"reason":"<grounded justification>","evidenceRefs":["<ref>"]}]}',
  ].join('\n');
}

function coerceEvaluationList(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (Array.isArray(raw.evaluations)) return raw.evaluations;
  if (Array.isArray(raw.result?.evaluations)) return raw.result.evaluations;
  if (Array.isArray(raw)) return raw;
  return null;
}

// Map the judge's verdicts back onto the requested criteria. A criterion the
// judge confirmed becomes a supported pass; a criterion it rejected or omitted
// becomes a supported failure (never a silent pass).
function normalizeGateJudgeEvaluations(rawResult, criteria) {
  const list = coerceEvaluationList(rawResult);
  if (!list) return null;
  const byCriterion = new Map();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const key = normalizeCriterion(entry.criterion);
    if (!key || byCriterion.has(key)) continue;
    const evidenceRefs = Array.isArray(entry.evidenceRefs)
      ? entry.evidenceRefs.map(ref => String(ref || '').trim()).filter(Boolean).slice(0, 12)
      : [];
    byCriterion.set(key, {
      passed: entry.passed === true,
      reason: clampText(entry.reason || (entry.passed === true ? 'judge-accepted' : 'judge-rejected'), 400),
      evidenceRefs,
    });
  }
  const result = new Map();
  for (const criterion of criteria) {
    const key = normalizeCriterion(criterion);
    const verdict = byCriterion.get(key);
    if (verdict) {
      result.set(criterion, {
        criterion,
        supported: true,
        passed: verdict.passed,
        reason: verdict.reason,
        source: GATE_JUDGE_SOURCE,
        evidenceRefs: verdict.evidenceRefs,
      });
    } else {
      result.set(criterion, {
        criterion,
        supported: true,
        passed: false,
        reason: 'judge-omitted-criterion',
        source: GATE_JUDGE_SOURCE,
        evidenceRefs: [],
      });
    }
  }
  return result;
}

// Evaluate the unsupported criteria of a gate with the supplied judge adapter.
// Returns a Map<criterion, evaluation> on success, or null to signal the caller
// to keep the original unsupported evaluations (graceful degradation).
async function judgeUnsupportedGateCriteria(input = {}) {
  const criteria = Array.isArray(input.criteria) ? input.criteria.filter(Boolean) : [];
  const judgeAdapter = input.judgeAdapter;
  if (!criteria.length || !judgeAdapter || typeof judgeAdapter.invoke !== 'function') {
    return null;
  }
  const evidence = buildGateJudgeEvidence({
    events: input.events,
    inventory: input.inventory,
    queueItems: input.queueItems,
    taskText: input.taskText,
  });
  const prompt = buildGateJudgePrompt(criteria, evidence);
  let rawResult;
  try {
    rawResult = await judgeAdapter.invoke({
      prompt,
      input: { schemaVersion: GATE_JUDGE_SCHEMA_VERSION, criteria, evidence },
      responseFormat: 'json-only',
    });
  } catch (err) {
    if (typeof input.onJudgeError === 'function') {
      try { input.onJudgeError(err); } catch {}
    }
    return null;
  }
  let parsed = rawResult;
  if (typeof rawResult === 'string') {
    try {
      parsed = JSON.parse(rawResult);
    } catch {
      return null;
    }
  }
  const normalized = normalizeGateJudgeEvaluations(parsed, criteria);
  return normalized || null;
}

module.exports = {
  GATE_JUDGE_SCHEMA_VERSION,
  GATE_JUDGE_SOURCE,
  buildGateJudgeEvidence,
  buildGateJudgePrompt,
  normalizeGateJudgeEvaluations,
  judgeUnsupportedGateCriteria,
};
