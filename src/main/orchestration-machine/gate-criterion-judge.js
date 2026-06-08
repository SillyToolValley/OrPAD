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

// Collect the run's worker evidence into a compact, judge-readable structure.
// The judge can only evaluate against what actually happened, so this is the
// sole source of truth handed to the model — there is no workspace read here.
function buildGateJudgeEvidence(input = {}) {
  const events = Array.isArray(input.events) ? input.events : [];
  const inventory = input.inventory || {};
  const knownRefs = new Set();
  const workers = [];
  for (const event of events) {
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
  return {
    schemaVersion: GATE_JUDGE_SCHEMA_VERSION,
    taskText: clampText(input.taskText || '', 1600),
    activeQueueCount: Number.isFinite(Number(inventory.activeCount)) ? Number(inventory.activeCount) : null,
    completedQueueCount: Number.isFinite(Number(inventory.doneCount)) ? Number(inventory.doneCount) : null,
    acceptedWorkerCount: workers.length,
    workers: trimmedWorkers,
    knownEvidenceRefs: [...knownRefs],
  };
}

function buildGateJudgePrompt(criteria, evidence) {
  const criteriaList = criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n');
  return [
    'You are OrPAD\'s gate-criterion judge. A pipeline run has produced worker evidence and reached a quality gate.',
    'Decide, for EACH listed criterion, whether the run evidence demonstrably satisfies it.',
    '',
    'Hard rules:',
    '- Judge ONLY against the evidence provided below. Do not assume work happened that the evidence does not show.',
    '- A criterion passes ONLY if the evidence clearly demonstrates it (e.g. a relevant changed file plus a passing verification command, or an explicit worker summary backed by an artifact).',
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
