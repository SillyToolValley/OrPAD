const fs = require('fs/promises');
const path = require('path');
const {
  WORK_ITEM_SCHEMA_VERSION,
  WORK_ITEM_STATES,
} = require('../runbooks/work-items');
const { normalizeLockPath } = require('../orchestration-machine/file-lock-manager');
const {
  assertGeneratedPipelineQuality,
  auditGeneratedPipelineQuality,
} = require('./quality-audit');
const {
  authoringNodePackPromptLines,
  nodePackDeclarationForPipeline,
  selectAuthoringNodePacks,
} = require('../orchestration-machine/node-packs');

const EXTERNAL_RESEARCH_INTENT_PATTERN = /\b(search|competing products|competitors?|market|benchmarks?|benchmarking|web research|external research|browse|internet|online)\b/i;
const CANONICAL_QUEUE_NODE = { id: 'queue', type: 'orpad.workQueue', label: 'Own candidate queue state' };
const CANONICAL_TRIAGE_NODE = { id: 'triage', type: 'orpad.triage', label: 'Prioritize bounded work' };
const CANONICAL_DISPATCH_NODE = { id: 'dispatch', type: 'orpad.dispatcher', label: 'Claim one safe work item' };
const CANONICAL_WORKER_NODE = { id: 'worker', type: 'orpad.workerLoop', label: 'Implement claimed work in overlay', config: { targetFiles: [] } };
const CANONICAL_REVIEW_NODE = { id: 'patch-review', type: 'orpad.patchReview', label: 'Review patch results' };
const CANONICAL_ARTIFACT_NODE = { id: 'artifact', type: 'orpad.artifactContract', label: 'Record run evidence' };
const CONTENT_QA_NODE_PACK_ID = 'orpad.starter.content-qa';
const CONTENT_INTENT_PATTERN = /\b(readme|docs?|documentation|markdown|content|tutorial|lesson|lecture|course|slides?|copy|localization|locale|onboarding)\b|\uBB38\uC11C|\uAC15\uC758|\uC790\uB8CC|\uC2AC\uB77C\uC774\uB4DC|\uD559\uC2B5|\uAD50\uC721|\uC218\uC5C5|\uD29C\uD1A0\uB9AC\uC5BC|\uB9C8\uD06C\uB2E4\uC6B4|\uBC88\uC5ED|\uD604\uC9C0\uD654/i;
const EDITORIAL_GATE_PATTERN = /\b(editorial|voice|tone|style|density|readability|audience|duplicate|duplication|repetition|rewrite|polish|presentation|slide|role[-\s]?separat|human-authored|ai-sounding)\b/i;
const DEFAULT_CONTENT_EDITORIAL_GATE = Object.freeze({
  id: 'content-editorial-quality-gate',
  label: 'Gate final editorial quality',
  evaluationMode: 'content-editorial-quality',
  judgePolicy: 'rule-only',
  expectedEvaluationArtifacts: [
    'artifacts/evaluations/content-editorial/workers/<worker-id>-seq-<event-sequence>.json',
  ],
  expectedJudgeArtifacts: [
    'artifacts/evaluations/content-editorial/judges/<worker-id>-seq-<event-sequence>.json',
  ],
  nodePackRubric: [
    'Rule analyzer evaluates changed content hunks independently from worker summary claims.',
    'Optional LLM judge receives only rule output, changed hunks, a small style sample, and this rubric.',
    'Worker-specific evaluation artifacts must not be merged across workers.',
  ],
  criteria: [
    'Final content is edited down for the target audience; slides or docs avoid checklist-like over-explanation and keep one main teaching point per section or slide.',
    'Voice and tone match the existing human-authored material; remove generic model meta-language, repeated scaffolding, and AI-sounding summary phrases.',
    'README, slides, examples, and acceptance criteria are role-separated so runnable instructions do not crowd presentation material.',
    'Before/after evidence names what was removed, consolidated, or rewritten, not only what was added.',
  ],
});
const CANONICAL_REQUIRED_ARTIFACTS = Object.freeze(['discovery/candidate-inventory.json']);
const CANONICAL_REQUIRED_QUEUE = Object.freeze(['journal.jsonl']);
const AUTHORABLE_NODE_TYPES = new Set([
  'orpad.artifactContract',
  'orpad.barrier',
  'orpad.context',
  'orpad.dispatcher',
  'orpad.entry',
  'orpad.exit',
  'orpad.gate',
  'orpad.graph',
  'orpad.patchReview',
  'orpad.probe',
  'orpad.rule',
  'orpad.selector',
  'orpad.skill',
  'orpad.tree',
  'orpad.triage',
  'orpad.workQueue',
  'orpad.workerLoop',
]);

function normalizeTask(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function truncateDescription(value, maxLength = 480) {
  const text = normalizeTask(value);
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, maxLength).trim();
  const punctuationIndex = Math.max(
    slice.lastIndexOf('.'),
    slice.lastIndexOf('!'),
    slice.lastIndexOf('?'),
    slice.lastIndexOf(';'),
  );
  if (punctuationIndex >= Math.floor(maxLength * 0.55)) return slice.slice(0, punctuationIndex + 1).trim();
  const spaceIndex = slice.lastIndexOf(' ');
  const trimmed = (spaceIndex >= Math.floor(maxLength * 0.55) ? slice.slice(0, spaceIndex) : slice)
    .replace(/[,\-:;]+$/g, '')
    .trim();
  return trimmed ? `${trimmed}...` : '';
}

function slugify(value, fallback = 'orpad-pipeline') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function nodeId(value, fallback = 'node') {
  return slugify(value, fallback).replace(/^-+|-+$/g, '') || fallback;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function uniqueId(base, seen) {
  const clean = nodeId(base, 'node');
  if (!seen.has(clean)) {
    seen.add(clean);
    return clean;
  }
  let index = 2;
  while (seen.has(`${clean}-${index}`)) index += 1;
  const next = `${clean}-${index}`;
  seen.add(next);
  return next;
}

function runbookTimestamp(now = new Date()) {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function hasExternalResearchIntent(taskText) {
  return EXTERNAL_RESEARCH_INTENT_PATTERN.test(normalizeTask(taskText));
}

function externalResearchLimitationText() {
  return 'Local-only generated run: external competitor claims require approved browsing or attached research evidence. Without that evidence, the run must report a research gap and propose only local evidence-backed work.';
}

function externalResearchSkillGuard(taskText) {
  if (!hasExternalResearchIntent(taskText)) return '';
  return [
    '## External Competitor Research Guard',
    '',
    '- External competitor, market, benchmark, and web research claims require approved browsing or attached research evidence.',
    '- If approved browsing or attached evidence is unavailable, report a research gap instead of presenting competitor claims as verified.',
    '- Propose and implement only improvements backed by local workspace evidence until external research evidence is supplied.',
    '',
  ].join('\n');
}

function orchestrationQualityRubricLines() {
  return [
    '## Orchestration Quality Rubric',
    '',
    'Use the practitioner handbook bar for every generated pipeline:',
    '- Orchestration first: decide the workflow, routing, retries, approvals, and fallback before assigning autonomy to an agent.',
    '- Machine-owned state: queue, claim, approval, run status, artifact contract, and trace stay in OrPAD; the model proposes work and evidence.',
    '- Harness separation: define tools, permissions, sandbox, validation, observability, evaluation, and feedback loops as explicit nodes or metadata.',
    '- Operational controls: include state, timeout/budget, retry or loop stop conditions, idempotency assumptions, cancellation/handoff path, checkpoint/evidence, and fallback.',
    '- Evaluation: gate with task-specific criteria, preserve proof artifacts, and make failures become future eval/regression cases instead of hidden prompt tweaks.',
    '- Security: treat external or retrieved content as untrusted data, keep read/write authority separated, and require approval for destructive or externally visible execution.',
    '- UX and review: expose step-by-step progress, red flags, evidence, approval/reject/edit outcomes, and rollback or retry path.',
    '',
  ];
}

function orchestrationReferenceExampleLines() {
  return [
    '## Reference Patterns To Learn From',
    '',
    '- LangGraph-style stateful graph: durable execution, checkpoint/resume, human-in-the-loop, cycles, and deterministic replay around non-deterministic nodes.',
    '- OpenAI Agents SDK style: distinguish handoff (specialist takes over) from manager agents-as-tools (manager retains control); pass typed handoff metadata and keep guardrails around tool calls.',
    '- Microsoft Agent Framework / Semantic Kernel style: choose sequential, concurrent, handoff, group chat, or manager/Magentic patterns deliberately; group chat is for collaborative validation, not basic pipelines.',
    '- Anthropic effective-agent patterns: prompt chaining, routing, parallelization, orchestrator-workers, and evaluator-optimizer loops; prefer the simplest pattern that covers the control points.',
    '- Traditional workflow engines: borrow durable state, retry, timeout, idempotency, observability, and audit discipline from Temporal/Airflow/Dagster/Prefect-style systems.',
    '',
  ];
}

function contentEditorialContractLines() {
  return [
    '## Content / Writing / Learning-Material Contract',
    '',
    'When the request edits docs, README files, tutorials, slides, lecture material, localization copy, or other learner/user-facing prose:',
    '- The graph must include a final editorial quality gate after worker patch review and before artifact recording.',
    '- The editorial gate must use `evaluationMode: "content-editorial-quality"`, declare `judgePolicy`, and name expected OrPAD-owned worker evaluation artifact paths.',
    '- The editorial gate must check voice/tone, density, repetition, audience fit, role separation between slides/docs/examples/acceptance evidence, and before/after rewrite evidence.',
    '- Do not ask workers to self-certify editorial quality; OrPAD evaluates the diff independently, so workers must leave real patch evidence through removals, merges, or rewrites.',
    '- The worker should be allowed to remove, merge, or rewrite low-value prose; do not satisfy every content issue by adding more checklist text.',
    '- Work items should distinguish source-of-truth accuracy from presentation polish so factual repair and final voice editing are both visible.',
    '- For slides, validate presentation density: one main point per slide/section, no README-sized instruction blocks unless the source format explicitly requires them.',
    '',
  ];
}

function defaultOrchestrationSkill(taskText, authoringSpec = null, selectedNodePacks = []) {
  const guard = externalResearchSkillGuard(taskText);
  const acceptanceCriteria = Array.isArray(authoringSpec?.skill?.acceptanceCriteria)
    ? authoringSpec.skill.acceptanceCriteria.map(item => normalizeTask(item)).filter(Boolean).slice(0, 8)
    : selectedPackAcceptanceCriteria(selectedNodePacks).slice(0, 8);
  const targetPolicy = selectedPackCandidateTargetPolicy(selectedNodePacks).slice(0, 8);
  return [
    '# OrPAD Pipeline Skill',
    '',
    'Use the current workspace to implement the user request through a small, reviewable OrPAD run.',
    '',
    '## User Request',
    '',
    taskText,
    '',
    '## Include',
    '',
    '- README.md',
    '- package metadata',
    '- existing pipeline, flow, tree, and harness files',
    '- relevant source files',
    '- tests and harness summaries when relevant',
    '- Markdown notes already inside this workspace when they clarify the task',
    '',
    '## Exclude',
    '',
    '- `.env` and secret-like files',
    '- raw terminal scrollback unless explicitly attached',
    '',
    '## Acceptance Criteria',
    '',
    ...(acceptanceCriteria.length ? acceptanceCriteria.map(item => `- ${item}`) : [
      '- Generate or update the `.orpad/pipelines/<pipeline>/` package needed for the requested work.',
      '- Keep the flow definition in `.or-graph` using workstream nodes that OrPAD can run with owned work state, progress, and evidence files.',
      '- Validate the flow before running implementation work.',
      '- Run the approved managed pipeline flow and write evidence under the pipeline `runs/` folder.',
      '- Keep source edits focused on the requested OrPAD behavior.',
    ]),
    '',
    ...(targetPolicy.length ? [
      '## Candidate Target Policy',
      '',
      ...targetPolicy.map(item => `- ${item}`),
      '',
    ] : []),
    '## Operational Quality Bar',
    '',
    '- Preserve a traceable path from user request to context, candidate inventory, queue state, worker proof, review decision, verification result, and final summary.',
    '- Do not treat a model-written claim as evidence; require concrete file, test, run, screenshot, or artifact proof where the task allows it.',
    '- Stop because a declared condition is met: queue empty, approval required, verification blocked, budget/risk exceeded, or handoff required.',
    '- Escalate or mark partial when evidence is missing instead of presenting uncertain work as complete.',
    '',
    guard,
  ].filter(Boolean).join('\n');
}

function orchestrationAuthoringPrompt(taskText, contextRulePath) {
  return [
    '# OrPAD Orchestration Authoring Prompt',
    '',
    'You are defining the orchestration only. Do not implement product/source-code changes in this step.',
    '',
    '## Goal',
    '',
    taskText,
    '',
    '## Contract',
    '',
    '- Produce an OrPAD pipeline package under `.orpad/pipelines/<slug>/`.',
    '- Keep node responsibilities explicit: context, probe, queue, triage, dispatch, worker, review, verification, artifact, exit.',
    '- Make harness implementation a separate later step; the generated pipeline only defines what should be orchestrated.',
    '- Use local workspace context through the context rule.',
    `- Context rule: ${contextRulePath}`,
    '',
  ].join('\n');
}

function orchestrationAuthoringSpecPrompt(taskText, workspaceSnapshot = {}) {
  const files = Array.isArray(workspaceSnapshot.files) ? workspaceSnapshot.files.slice(0, 120) : [];
  return [
    '# OrPAD Orchestration Spec Authoring',
    '',
    'You are designing a deterministic orchestration graph that conducts non-deterministic LLM work to a verified, evidenced outcome.',
    'Return ONLY valid JSON for the spec. Do not wrap the JSON in Markdown. Do not add commentary outside metadata.authoringNotes.',
    '',
    'OrPAD principle: the LLM is non-deterministic; the pipeline is the deterministic structure that conducts it.',
    'A well-designed pipeline contains branching, loops, verification, retrieval, agents, and sub-graphs where they create leverage.',
    'A flat linear chain is almost always a sign that the design did not match the work.',
    '',
    ...orchestrationQualityRubricLines(),
    ...orchestrationReferenceExampleLines(),
    ...contentEditorialContractLines(),
    '## User Goal',
    taskText,
    '',
    '## Workspace Snapshot',
    files.length ? files.map(file => `- ${file}`).join('\n') : '- No file snapshot supplied.',
    '',
    ...authoringNodePackPromptLines(taskText, workspaceSnapshot),
    '## Node Catalog (17 authored types)',
    '',
    'Control flow:',
    '- `orpad.entry` — graph start. config: `{ summary }`.',
    '- `orpad.exit` — graph end. config: `{ summary }`.',
    '- `orpad.selector` — record a routing choice; multiple outgoing transitions keyed by `selected` value. config: `{ selector, options[], default, selectorKind? }`. Use for: mode selection (e.g. agent vs script, RAG vs no-RAG, parallel vs serial, approve vs split).',
    '- `orpad.gate` — verify criteria; control-flow loop-backs are encoded as TRANSITIONS (with `condition` strings), NOT as the gate\'s `onFail` policy. config: `{ criteria[], onFail }`. **`onFail` is a strict enum**: `"block"` (default — abort the run with MACHINE_GATE_CRITERIA_UNMET), `"warn"` (record warning, continue), `"continue"` (ignore failure), or `"continue-with-warning"`. Any other value (e.g. "revise", "loop", "loop-back-to-triage") will FAIL the run at execution time with `Unsupported Gate onFail policy`. Use for: cross-validation, re-verification loops (loop-back via transitions), acceptance checks.',
    '- `orpad.barrier` — wait for N parallel branches and merge their artifacts. config: `{ waitFor[], mergePolicy, onPartialFailure }`. Use for: fork-join, parallel agent ensembles.',
    '',
    'Context and retrieval:',
    '- `orpad.context` — collect workspace facts under a rule + skill. config: `{ ruleRef, skillRef, summary }`. Use for: scope mapping, RAG-style "retrieval" stage (config.summary describes the retrieval lens).',
    '- `orpad.probe` — generate candidate findings/work-items under a lens. config: `{ lens, userTask, skillRef, maxCandidates, candidateLimitPolicy }`. Use for: discovery, hypothesis generation, ontology surface scan.',
    '- `orpad.rule` — declare an inclusion/exclusion rule used elsewhere. config: `{ include[], exclude[] }`.',
    '- `orpad.skill` — declare a skill bundle reference. config: `{ ref, summary }`.',
    '',
    'Composition:',
    '- `orpad.graph` — invoke another `.or-graph` as a nested layer (sub-graph). config: `{ graphRef, viewMode, executionMode }`. **REQUIRED**: `graphRef` MUST be set. **PATH CONVENTION**: main.or-graph lives in `<pipeline>/graphs/`, so a sub-graph sitting next to it uses a BARE FILENAME like `"<descriptive-id>.or-graph"` (NOT `"graphs/<descriptive-id>.or-graph"` — that would resolve to `graphs/graphs/...`). **REQUIRED**: emit a matching entry in the top-level `subgraphs[]` array whose `ref` equals `graphRef` and whose `graph: { id, label, start, nodes, transitions }` defines the inner pipeline. The `orpad.graph` node WITHOUT either a `graphRef` or a corresponding `subgraphs[]` entry is decorative and not a real sub-graph — never emit one. Use for: reusable sub-pipelines (e.g. "Critique-and-Repair", "RAG-Retrieve", "Multi-Agent-Vote"), behavior-tree decomposition.',
    '- `orpad.tree` — reference an `.or-tree` procedure hierarchy (behavior-tree-style ticks). config: `{ treeRef }`. **REQUIRED**: `treeRef` MUST be set. **PATH CONVENTION**: trees live in `<pipeline>/trees/` but the ref is relative to the parent graph file (which sits in `graphs/`), so use `"../trees/<descriptive-id>.or-tree"` (NOT `"trees/<descriptive-id>.or-tree"`). **REQUIRED**: emit a matching entry in the top-level `subtrees[]` array whose `ref` equals `treeRef` and whose `tree: { id, label, root }` defines the behavior-tree primitives (Sequence / Selector / Context / Skill / Gate). The `orpad.tree` node WITHOUT either a `treeRef` or a corresponding `subtrees[]` entry is decorative and not a real tree — never emit one. Use for: hierarchical decomposition where each leaf can succeed/fail/run.',
    '',
    'Work-state machinery (use together when implementation work is queued and claimed):',
    '- `orpad.workQueue` — own the candidate→queued→claimed→done state. config: `{ queueRoot, schema }`. Always required when implementation work runs.',
    '- `orpad.triage` — prioritize work-items in the queue. config: `{ queueRef }`.',
    '- `orpad.dispatcher` — claim one safe work-item and route it to a worker loop. config: `{ queueRef, workerLoopRef }`.',
    '- `orpad.workerLoop` — Ralph-style worker that pulls from the queue, edits in an overlay, and reports back. config: `{ queueRef, targetFiles }`. Use for: agentic action, iterative refinement, ralph loop. Pair with a `gate` whose `onFail` loops back to enable retries / self-correction. **File-Lock Queue Phase 2**: when the worker writes a predictable, bounded set of files, declare them in `targetFiles: ["src/foo.js", "tests/foo.test.mjs"]`. The scheduler uses this declaration to safely parallelize disjoint workers and serialize overlapping ones — eliminating routine patchReview prompts for write conflicts. Use `targetFiles: []` when the write set is unknown; the worker then holds a GLOBAL exclusive lock = serial execution. Probes/planners that emit candidate proposals should also populate candidate `targetFiles` alongside `sourceOfTruthTargets` when they can predict the write set.',
    '- `orpad.patchReview` — review a worker patch before accepting. config: `{ reviewMode }`. Use for: cross-validation, second-pair-of-eyes.',
    '- `orpad.artifactContract` — record run evidence under a canonical artifactRoot/queueRoot. config: `{ artifactRoot, queueRoot, required[], requiredQueue[], onMissing }`. Always include before exit.',
    '',
    '## Pattern Catalog — pick and compose, do NOT default to Pattern A',
    '',
    'A. **Linear / Simple Pipeline** — entry → context → probe → queue → triage → dispatch → worker → patchReview → gate → artifact → exit. Use ONLY when the task is a single, well-defined, single-pass change with no verification ambiguity.',
    '',
    'B. **Ralph Loop (iterative refinement)** — worker → gate → (onFail) loop back to worker. Express it with `condition: "revise"` from gate back to worker and `condition: "pass"` from gate to the next verifier/artifact. Use when: the first draft is rarely correct (writing, refactors, lecture-material generation, doc revision, agent code).',
    '',
    'C. **Fork-Join Parallelism** — selector → [worker-a, worker-b, worker-c] → barrier → gate → artifact. Each parallel branch claims a different sub-scope. Use when: independent sub-scopes can be progressed in parallel (multi-module refactor, parallel research lanes, ensemble agent voting).',
    '',
    'D. **Cross-Validation / Re-verification Loop** — worker → patchReview → gate(critique) → (onFail) loop back to worker; (onPass) → second `gate` that re-runs an independent check → artifact. Use when: correctness is high-stakes (bug fixes, schema migrations, security-sensitive edits).',
    '',
    'E. **Behavior Tree Sub-graph** — a `orpad.graph` node whose graphRef is a sub-graph implementing selector/sequence/decorator semantics, OR a `orpad.tree` node referencing a `.or-tree`. Use when: the task naturally decomposes hierarchically (test suite, multi-stage migration, multi-step user journey).',
    '',
    'F. **RAG-style Retrieval Pipeline** — context (retrieval lens) → probe (semantic candidates) → selector (relevance gate) → worker (LLM with retrieved context) → gate. Use when: the task requires grounding in workspace text (doc Q&A, summarize-then-edit, "find all callers and update").',
    '',
    'G. **Ontology / Knowledge-Graph Scan** — context (schema map) → probe (lens: "ontology-surface-scan") → triage (rank by ontology importance) → workerLoop → gate. Use when: the task asks about relationships, hierarchies, or concept maps across the workspace.',
    '',
    'H. **Multi-Agent Cross-Verification** — fork two independent workerLoops on the same problem → barrier (mergePolicy: "compare") → patchReview (pick winner or merge) → gate. Use when: the task is open-ended enough that multiple plausible solutions exist and need to be reconciled.',
    '',
    'I. **Queue Drain Loop (outer Ralph loop)** — triage → dispatcher → workerLoop → patchReview → gate → loop back to dispatcher with `condition: "queue-not-empty"` until queue is drained, then `condition: "queue-empty"` → next stage. This is the canonical Ralph loop: ONE worker pull per iteration, repeat until done. Without this loop the queue is drained only once. Use whenever you have a workQueue / triage / dispatcher chain — almost always.',
    '',
    'J. **True Fork-Join (no selector)** — node `A` has MULTIPLE outgoing transitions with NO `condition` to `B`, `C`, `D`; each runs in parallel; `barrier` with `waitFor: ["B","C","D"]` joins them. Distinct from C, where a `selector` PICKS ONE branch by `condition`. If you want every branch to run, do NOT use a selector — emit multiple unconditional transitions from the same source. Use for: parallel probes/lenses, parallel sub-scope work that always all run.',
    '',
    'K. **PatchReview Reject Loop-Back** — workerLoop → patchReview → `condition: "rejected"` loop back to workerLoop (with retry hint), `condition: "accepted"` continue. Always pair patchReview with two outgoing transitions; do NOT route patchReview to a single next node unconditionally, or rejection has no effect.',
    '',
    '## Task → Pattern decision guide',
    '',
    '- Single deterministic change, easy to verify → A (Linear).',
    '- Creative/iterative output (writing, refactor, slides, agent prompts) → B (Ralph loop).',
    '- Multiple independent sub-scopes → C (Fork-Join).',
    '- High-stakes correctness, regression-prone → D (Cross-validation).',
    '- Hierarchical / multi-stage task → E (Behavior-tree sub-graph) or composed `orpad.graph` nodes.',
    '- Needs grounding in retrieved workspace text → F (RAG).',
    '- Asks about relationships / cross-module impact → G (Ontology scan).',
    '- Ambiguous problem, multiple valid solutions → H (Multi-agent cross-verification).',
    '- Real tasks usually MIX 2–3 patterns. Example: a high-stakes refactor across many modules = C (fork-join) + D (cross-validation) + E (sub-graph for the per-module change).',
    '',
    '## Required Transition Schema (audit your draft against EACH row)',
    '',
    'If your graph contains... → you MUST emit the listed transitions. If you skip a row, you MUST add a `metadata.skippedPatterns` entry that names the row and explains WHY in one sentence.',
    '',
    '1. `orpad.workQueue` + `orpad.dispatcher` present → the LAST gate before `orpad.artifactContract` MUST have:',
    '   - `{ from: <last-gate>, to: <triage-or-dispatcher>, condition: "queue-not-empty" }`',
    '   - `{ from: <last-gate>, to: <artifactContract>, condition: "queue-empty" }`',
    '   Without these two siblings, the dispatcher claims ONE item and exits.',
    '',
    '2. `orpad.patchReview` present → **HARD ENFORCEMENT** — that patchReview node MUST appear EXACTLY twice as `transition.from` in the transitions list:',
    '   - `{ from: <patchReview>, to: <workerLoop>, condition: "rejected" }`',
    '   - `{ from: <patchReview>, to: <gate-or-next>, condition: "accepted" }`',
    '   Emitting a patchReview with a single unconditional outgoing edge (no `condition` field, or only an "accepted" sibling) is a CONTRACT VIOLATION. Without the rejected loop-back the review node is decorative and cannot block a bad patch.',
    '',
    '3. `orpad.gate` whose criteria can fail in user-visible ways → at least one outgoing transition must be a loop-back. The gate\'s `config.onFail` MUST be one of `"block" | "warn" | "continue" | "continue-with-warning"`; loop-back behavior belongs in the transitions, not in `onFail`.',
    '   - `{ from: <gate>, to: <upstream-worker-or-triage>, condition: "revise" }`',
    '   - `{ from: <gate>, to: <next>, condition: "pass" }`',
    '   - `config.onFail: "warn"` (so the run continues into the loop-back branch instead of aborting)',
    '',
    '4. Two or more sub-scopes that should ALL run in parallel → emit MULTIPLE unconditional outgoing transitions from the same source node into the sub-scope entry nodes, and join them with `orpad.barrier`. Do NOT use `orpad.selector` for parallel-everything fork.',
    '',
    '5. One sub-scope picked per run from many options → use `orpad.selector` with one `condition` per outgoing transition; do NOT use multiple unconditional edges (that would run all options).',
    '',
    '6. `orpad.barrier` present → its outgoing transition MUST lead to a node (gate / patchReview / artifact) that uses the joined branches. A barrier that joins into a single workerLoop or directly to exit wastes its join work.',
    '',
    '7. `orpad.graph` (sub-graph) node present → its sub-graph scope MUST add structural value (own dispatcher, own worker, own gate, or own retrieval lens). If four sub-graph nodes all feed a single shared dispatcher, collapse them into one `selector` instead.',
    '',
    '8. Every `orpad.graph` node with `config.graphRef` MUST have a matching entry in the spec\'s top-level `subgraphs[]` array — `{ ref: "<config.graphRef>", graph: { id, label, start, nodes, transitions } }`. Likewise, every `orpad.tree` node with `config.treeRef` MUST have a matching entry in `subtrees[]` — `{ ref, tree: { id, label, root } }`. **Path convention**: refs are RELATIVE TO `<pipeline>/graphs/main.or-graph` — sub-graphs use a bare filename (`"foo.or-graph"`), sub-trees use `"../trees/foo.or-tree"`. The generator writes each entry to disk under `<pipeline>/graphs/` or `<pipeline>/trees/` respectively. A reference without a matching entry is auto-materialized as an executable scaffold and still must pass the quality audit; author the inner graph/tree when possible.',
    '',
    '## Self-Critique checklist (run mentally before emitting JSON)',
    '',
    '1. Is my graph a flat 9-node linear chain? If yes — REWRITE unless the task is truly Pattern A.',
    '2. Does the user request imply iteration or refinement? If yes — there MUST be a gate whose `onFail` transition loops back to a worker (Pattern B).',
    '3. Are there independent sub-scopes I could parallelize? If yes — decide between Pattern C (selector + barrier, picks ONE branch per run) and Pattern J (multiple unconditional outgoing transitions + barrier, runs ALL branches). If every branch must run, use J, not C.',
    '4. Does correctness matter? If yes — chain at least two distinct verifications (`gate` + `patchReview`, or two `gate` nodes with different `criteria`) (Pattern D).',
    '5. Does the task decompose hierarchically? If yes — extract sub-stages into `orpad.graph` or `orpad.tree` (Pattern E). Sub-graphs must add structural value (own dispatcher/worker/gate), not just be labelled wrappers around a shared downstream.',
    '6. Does the work need workspace grounding? If yes — make `context` and `probe` carry a specific retrieval lens, not generic "inspect-files" (Pattern F).',
    '7. Have I included at least one `orpad.gate` with concrete, task-specific `criteria` strings (not just "checks pass")?',
    '8. Have I named nodes and labels with the user\'s domain language (e.g. "Probe lecture comprehension gaps", not "Find risks")?',
    '9. Does my graph have a workQueue + dispatcher + workerLoop chain? If yes, there MUST be a Pattern I outer drain loop: gate (or workerLoop-success) → dispatcher with `condition: "queue-not-empty"`. Without it, the queue runs ONE item and then exits.',
    '10. Every `orpad.patchReview` node MUST have at least two outgoing transitions, including one with `condition: "rejected"` (or similar) that loops back to the worker. A patchReview with only one unconditional outgoing edge has no enforcement power (Pattern K).',
    '11. Record the pattern choice in `metadata.authoringNotes` as e.g. `"Pattern B+D+I: ralph loop with cross-validation and queue drain loop because the request is iterative and high-stakes."`',
    '12. For EACH row of the Required Transition Schema you skipped, add an entry to `metadata.skippedPatterns` of shape `{ row: "<number>: <title>", reason: "<one-sentence justification>" }`. An empty `skippedPatterns` is fine if you satisfied every row; missing `skippedPatterns` AND missing required transitions is a contract violation.',
    '',
    '## Concrete multi-pattern example (do NOT just copy this — adapt to the user goal)',
    '',
    'Suppose the user asks: "refactor the auth middleware across services and verify no regressions". A good graph is C+D+E:',
    JSON.stringify({
      title: 'Multi-service auth middleware refactor with cross-validation',
      description: 'Fork-join across services with per-service sub-graph and double-verification gate.',
      graph: {
        id: 'auth-refactor-cross-verify',
        label: 'Auth refactor (multi-service, cross-validated)',
        start: 'entry',
        nodes: [
          { id: 'entry', type: 'orpad.entry', label: 'Entry' },
          { id: 'scope-map', type: 'orpad.context', label: 'Map auth call-sites across services', config: { summary: 'Inventory each service\'s auth middleware usage and tests.' } },
          { id: 'probe-services', type: 'orpad.probe', label: 'Probe per-service refactor candidates', config: { lens: 'auth-middleware-refactor', maxCandidates: 8 } },
          { id: 'queue', type: 'orpad.workQueue', label: 'Own per-service refactor queue' },
          { id: 'triage', type: 'orpad.triage', label: 'Prioritize by blast-radius', config: { queueRef: 'queue' } },
          { id: 'fork-mode', type: 'orpad.selector', label: 'Parallel or serial mode', config: { selector: 'parallelism', options: ['parallel', 'serial'], default: 'parallel' } },
          { id: 'dispatch-a', type: 'orpad.dispatcher', label: 'Dispatch service-A branch', config: { queueRef: 'queue', workerLoopRef: 'worker-a' } },
          { id: 'dispatch-b', type: 'orpad.dispatcher', label: 'Dispatch service-B branch', config: { queueRef: 'queue', workerLoopRef: 'worker-b' } },
          { id: 'worker-a', type: 'orpad.workerLoop', label: 'Apply refactor in service A overlay', config: { queueRef: 'queue', targetFiles: ['services/service-a/auth/middleware.js', 'services/service-a/auth/middleware.test.js'] } },
          { id: 'worker-b', type: 'orpad.workerLoop', label: 'Apply refactor in service B overlay', config: { queueRef: 'queue', targetFiles: ['services/service-b/auth/middleware.js', 'services/service-b/auth/middleware.test.js'] } },
          { id: 'per-service-verify', type: 'orpad.graph', label: 'Per-service verification sub-graph', config: { graphRef: 'per-service-verify.or-graph', executionMode: 'inline' } },
          { id: 'join', type: 'orpad.barrier', label: 'Join parallel service branches', config: { waitFor: ['worker-a', 'worker-b'], mergePolicy: 'concat-coverage', onPartialFailure: 'continue-with-warning' } },
          { id: 'patch-review', type: 'orpad.patchReview', label: 'Review merged patch set', config: { reviewMode: 'cross-service-diff' } },
          { id: 'gate-static', type: 'orpad.gate', label: 'Static checks gate', config: { criteria: ['typecheck passes for every service', 'no new linter warnings on touched files'], onFail: 'warn' } },
          { id: 'gate-runtime', type: 'orpad.gate', label: 'Runtime regression gate', config: { criteria: ['service-A integration tests pass', 'service-B integration tests pass', 'cross-service auth happy-path passes'], onFail: 'warn' } },
          { id: 'artifact', type: 'orpad.artifactContract', label: 'Record cross-service evidence', config: { artifactRoot: 'harness/generated/latest-run/artifacts', queueRoot: 'harness/generated/latest-run/queue', required: ['discovery/candidate-inventory.json'], requiredQueue: ['journal.jsonl'], onMissing: 'mark-partial' } },
          { id: 'exit', type: 'orpad.exit', label: 'Exit' },
        ],
        transitions: [
          { from: 'entry', to: 'scope-map' },
          { from: 'scope-map', to: 'probe-services' },
          { from: 'probe-services', to: 'queue' },
          { from: 'queue', to: 'triage' },
          { from: 'triage', to: 'fork-mode' },
          { from: 'fork-mode', to: 'dispatch-a', condition: 'parallel' },
          { from: 'fork-mode', to: 'dispatch-b', condition: 'parallel' },
          { from: 'dispatch-a', to: 'worker-a' },
          { from: 'dispatch-b', to: 'worker-b' },
          { from: 'worker-a', to: 'per-service-verify' },
          { from: 'worker-b', to: 'per-service-verify' },
          { from: 'per-service-verify', to: 'join' },
          { from: 'join', to: 'patch-review' },
          // Pattern K: patchReview MUST have two outgoing transitions —
          // accepted continues, rejected loops back to a worker.
          { from: 'patch-review', to: 'worker-a', condition: 'rejected' },
          { from: 'patch-review', to: 'gate-static', condition: 'accepted' },
          // Pattern D: gate loop-back on failure to the worker that produced the issue.
          { from: 'gate-static', to: 'worker-a', condition: 'revise' },
          { from: 'gate-static', to: 'gate-runtime', condition: 'continue' },
          { from: 'gate-runtime', to: 'worker-a', condition: 'revise' },
          // Pattern I: outer queue-drain loop — after a successful slice, go
          // back to the dispatcher if the queue still has work.
          { from: 'gate-runtime', to: 'triage', condition: 'queue-not-empty' },
          { from: 'gate-runtime', to: 'artifact', condition: 'queue-empty' },
          { from: 'artifact', to: 'exit' },
        ],
      },
      skill: {
        include: ['services/**/auth/**', 'README.md', 'package.json'],
        acceptanceCriteria: ['All services compile after refactor', 'Integration tests pass across services', 'No new auth middleware regressions detected'],
      },
      rule: {
        include: ['services/**', 'README.md', '.orpad/pipelines/**'],
        exclude: ['.env', '**/*secret*', '**/*token*', '**/*.pem', '**/*.key'],
      },
      metadata: {
        authoringNotes: 'Pattern C+D+E+I+K: fork-join across services (C), double-gate cross-validation that can loop back to worker on revise (D), per-service verification as a reusable sub-graph (E), outer queue-drain loop so the dispatcher keeps claiming items until the queue is empty (I), and patchReview reject loop-back so a bad patch is revised, not silently accepted (K). Linear chain rejected because each service is an independent sub-scope, correctness is regression-prone, and a single pass would leave queued work unprocessed.',
      },
    }, null, 2),
    '',
    '## Requirements',
    '- Pick the pattern (or pattern combination) that fits the user goal. Justify in `metadata.authoringNotes`.',
    '- Reject Pattern A unless the task is truly a single deterministic edit. Most useful tasks need B, C, D, E, F, G, or H — or a combination.',
    '- Loop-back transitions are encoded as transitions whose `from` is a gate (or patchReview) and whose `to` is an earlier node, with a `condition` string. Multiple outgoing transitions from a selector/gate/patchReview use distinct `condition` values.',
    '- Runtime condition labels are canonical, not prose: gates use `pass`, `revise`, `queue-empty`, `queue-not-empty`; patchReview uses `accepted`, `rejected`; barrier uses `pass`, `partial`; non-decision nodes must not have labelled conditions.',
    '- Every `orpad.gate` MUST have at least one task-specific `criteria` string in its config. Never emit `criteria: ["task-specific checks pass"]` as a placeholder.',
    '- Use node IDs and labels in the user\'s domain language. Generic labels like "worker"/"verify" are rejected; prefer e.g. `"apply-auth-middleware-refactor"` / `"verify-no-cross-service-regression"`.',
    '- Use only OrPAD node types listed above. The 17 valid types are: orpad.entry, orpad.exit, orpad.selector, orpad.gate, orpad.barrier, orpad.context, orpad.probe, orpad.rule, orpad.skill, orpad.graph, orpad.tree, orpad.workQueue, orpad.triage, orpad.dispatcher, orpad.workerLoop, orpad.patchReview, orpad.artifactContract.',
    '- Include queue, triage, dispatcher, workerLoop, patchReview, and artifactContract whenever implementation work runs — those are how OrPAD owns the work state. They can still be combined with selectors, barriers, gates, sub-graphs, and loop-backs.',
    '- Current managed-run execution has one `machineAdapter.workerNodePath`; prefer one canonical `orpad.workerLoop` and express sub-scopes as queue items, targetFiles, sub-graphs, gates, and metadata. Do not create multiple workerLoop lane nodes unless the machine contract supports workerNodePaths.',
    '- Place `orpad.artifactContract` immediately before `orpad.exit`. Do not put task-specific files in `artifactContract.required`; put them in node summaries or `skill.acceptanceCriteria`.',
    '- Pattern I enforcement: whenever the graph contains a `orpad.workQueue` + `orpad.dispatcher` chain, the LAST gate before `orpad.artifactContract` MUST have one outgoing transition with `condition: "queue-not-empty"` (target: `orpad.triage` or `orpad.dispatcher`) and one with `condition: "queue-empty"` (target: artifactContract). Without this, the queue runs exactly one slice.',
    '- Pattern K enforcement: every `orpad.patchReview` node MUST have at least two outgoing transitions — at minimum `condition: "accepted"` (continue) and `condition: "rejected"` (loop back to its worker). A patchReview with a single unconditional outgoing edge is rejected.',
    '- Pattern J vs C: if every fork branch must run, do NOT use a `orpad.selector`. Emit multiple outgoing transitions with no `condition` field from the same source node, and join them with `orpad.barrier`. Use `orpad.selector` only when ONE branch is picked per run.',
    '- Sub-graph value: every `orpad.graph` node must add structural value (its own dispatcher / worker / gate scope), not just be a labelled wrapper around a shared downstream dispatcher. If four sub-graphs converge into a single shared dispatcher node, collapse them into a `selector` instead.',
    '- Sub-graph materialization: every `orpad.graph` node with `config.graphRef` MUST have a matching entry in the top-level `subgraphs[]` array (`{ ref, graph: { id, label, start, nodes, transitions } }`); every `orpad.tree` node with `config.treeRef` MUST have a matching entry in `subtrees[]` (`{ ref, tree: { id, label, root } }`). Refs are relative to `<pipeline>/graphs/main.or-graph`: sub-graphs use a bare filename (`per-service-verify.or-graph`), sub-trees step out of `graphs/` (`../trees/self-check.or-tree`). Missing entries are auto-materialized but still audited; hand-author them when the sub-scope carries important logic.',
    '- `metadata.authoringNotes` MUST name the pattern(s) chosen and justify why the alternatives were rejected (one sentence each).',
  ].join('\n');
}

async function writeJson(filePath, value, createdFiles) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  createdFiles.push(filePath);
}

async function writeText(filePath, value, createdFiles) {
  await fs.writeFile(filePath, value, 'utf-8');
  createdFiles.push(filePath);
}

function shouldKeepFailedPipeline(options = {}) {
  return options.keepFailedPipeline === true || process.env.ORPAD_KEEP_FAILED_GENERATE === '1';
}

async function removeFailedPipelineDirectory(pipelineDir, workspaceRoot) {
  const pipelinesRoot = path.resolve(workspaceRoot, '.orpad', 'pipelines');
  const resolvedPipelineDir = path.resolve(pipelineDir);
  const rel = path.relative(pipelinesRoot, resolvedPipelineDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  await fs.rm(resolvedPipelineDir, { recursive: true, force: true });
  return true;
}

function parseAuthoringSpecText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(candidate.slice(first, last + 1));
    throw new Error('Authoring spec must be valid JSON.');
  }
}

const GATE_ON_FAIL_VALUES = Object.freeze(['block', 'warn', 'continue', 'continue-with-warning']);

function sanitizeGateOnFail(value) {
  // The Machine runtime hard-rejects any value outside this enum with
  // MACHINE_GATE_CONFIG_INVALID. Models keep inventing semantic values like
  // "revise" / "loop-back-to-triage"; treat those as a request for "warn"
  // (continue the run so the transition-level loop-back branch can run) and
  // preserve the authored intent under config.authoredOnFail for traceability.
  if (typeof value !== 'string') return { onFail: 'warn', original: value, replaced: true };
  const trimmed = value.trim();
  if (!trimmed) return { onFail: 'warn', original: value, replaced: true };
  if (GATE_ON_FAIL_VALUES.includes(trimmed)) return { onFail: trimmed, original: trimmed, replaced: false };
  return { onFail: 'warn', original: trimmed, replaced: true };
}

// Refs inside `<pipelineDir>/graphs/main.or-graph` resolve relative to that
// file's directory. main lives in `graphs/`, so:
//   • a sub-graph that sits alongside main uses a bare filename
//     (`discovery-lenses.or-graph`), NOT `graphs/discovery-lenses.or-graph`.
//     The latter would resolve to `<pipelineDir>/graphs/graphs/...`.
//   • a sub-tree under `<pipelineDir>/trees/` needs the explicit `../`
//     step out of `graphs/` (`../trees/foo.or-tree`).
// LLMs frequently emit the pipeline-rooted form; normalize both here so
// node configs and subgraphs[]/subtrees[] entries match the on-disk
// convention regardless of which form the model produced.
function normalizeGraphRefValue(rawRef) {
  const trimmed = String(rawRef || '').trim();
  if (!trimmed) return '';
  if (/^graphs[\\/]/i.test(trimmed)) return trimmed.replace(/^graphs[\\/]/i, '');
  return trimmed;
}

function withFileSuffix(value, suffix) {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  if (!normalized) return '';
  return normalized.toLowerCase().endsWith(suffix) ? normalized : `${normalized}${suffix}`;
}

function normalizeTreeRefValue(rawRef) {
  const trimmed = String(rawRef || '').trim().replace(/\\/g, '/');
  if (!trimmed) return '';
  // Already escapes graphs/ (`../trees/...`, `../foo.or-tree`) - keep the
  // relative directory but still repair a missing .or-tree suffix.
  if (trimmed.startsWith('..')) return withFileSuffix(trimmed, '.or-tree');
  // Pipeline-rooted (`trees/...`) - promote to graph-file-relative.
  if (/^trees\//i.test(trimmed)) return `../${withFileSuffix(trimmed, '.or-tree')}`;
  // A common LLM mistake is a bare tree id (`teaching-slice-completeness`).
  // main.or-graph sits in graphs/, while tree files live in trees/, so a bare
  // ref would incorrectly resolve under graphs/. Normalize it to the runtime
  // convention instead of writing an extensionless file into graphs/.
  const bareName = trimmed.replace(/^graphs\//i, '').split('/').filter(Boolean).pop() || trimmed;
  return `../trees/${withFileSuffix(bareName, '.or-tree')}`;
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || '').trim()).filter(Boolean);
}

function selectorRouteOptions(routes) {
  if (Array.isArray(routes)) {
    return routes.map((route, index) => {
      if (typeof route === 'string') return route;
      if (isPlainObject(route)) {
        return route.condition || route.route || route.value || route.id || route.key || route.name || route.label || '';
      }
      return `route-${index + 1}`;
    }).map(item => String(item || '').trim()).filter(Boolean);
  }
  if (isPlainObject(routes)) return Object.keys(routes).map(key => String(key || '').trim()).filter(Boolean);
  return [];
}

function normalizeSkillAliasConfig(config) {
  const alias = String(config.ref || '').trim();
  if (!alias || config.skillRef || config.file) return;
  config.refOriginal = config.ref;
  if (/\.md(?:#.*)?$/i.test(alias) || alias.includes('/') || alias.includes('\\')) {
    config.file = alias;
  } else {
    config.skillRef = alias;
  }
  delete config.ref;
}

function sanitizeNode(raw, seen) {
  if (!isPlainObject(raw)) return null;
  const id = uniqueId(raw.id || raw.key || raw.label || raw.type, seen);
  const type = String(raw.type || '').trim();
  if (!AUTHORABLE_NODE_TYPES.has(type)) return null;
  const label = normalizeTask(raw.label || raw.title || id).slice(0, 120) || id;
  const config = isPlainObject(raw.config) ? { ...raw.config } : {};
  if (type === 'orpad.workQueue') {
    config.queueRoot ||= 'harness/generated/latest-run/queue';
    config.schema ||= WORK_ITEM_SCHEMA_VERSION;
  }
  if (type === 'orpad.triage') config.queueRef ||= 'queue';
  if (type === 'orpad.dispatcher') {
    config.queueRef ||= 'queue';
    config.workerLoopRef ||= 'worker';
  }
  if (type === 'orpad.skill') normalizeSkillAliasConfig(config);
  if (type === 'orpad.selector') {
    if (!Array.isArray(config.options) || !config.options.length) {
      const routeOptions = selectorRouteOptions(config.routes);
      if (routeOptions.length) config.options = [...new Set(routeOptions)];
    }
    if (!config.selector && !config.selectorKind) config.selector = 'route';
    if (!config.default && Array.isArray(config.options) && config.options.length) config.default = config.options[0];
  }
  if (type === 'orpad.barrier') {
    const waitFor = stringArray(config.waitFor);
    const aliasWaitFor = stringArray(config.joinSources)
      .concat(stringArray(config.sources))
      .concat(stringArray(config.branches))
      .concat(stringArray(config.dependsOn));
    if (waitFor.length) {
      config.waitFor = [...new Set(waitFor)];
    } else if (aliasWaitFor.length) {
      if (config.joinSources !== undefined) config.authoredJoinSources = config.joinSources;
      if (config.sources !== undefined) config.authoredSources = config.sources;
      if (config.branches !== undefined) config.authoredBranches = config.branches;
      if (config.dependsOn !== undefined) config.authoredDependsOn = config.dependsOn;
      config.waitFor = [...new Set(aliasWaitFor)];
    }
    delete config.joinSources;
    delete config.sources;
    delete config.branches;
    delete config.dependsOn;
    config.mergePolicy ||= 'all';
    config.onPartialFailure ||= 'continue-with-warning';
  }
  if (type === 'orpad.workerLoop') config.queueRef ||= 'queue';
  // File-Lock Queue Phase 1: normalize `config.targetFiles` for any
  // node that writes via the patch path (worker / skill / dispatcher
  // when it forwards work). The lock manager reads this declaration
  // before dispatching the adapter. Empty / missing => safe default
  // = global exclusive lock = serial execution. Phase 2 fills the
  // field from the probe; for Phase 1 we just sanitize whatever the
  // author supplied so the runtime sees a clean string[].
  if (['orpad.workerLoop', 'orpad.skill', 'orpad.dispatcher'].includes(type)) {
    if (Array.isArray(config.targetFiles)) {
      // Codex Phase 2 P2 #4 fix: normalize path style so 'src/a.js',
      // 'src/./a.js', 'src\\a.js' all resolve to the same lock key.
      // The runtime lock manager normalizes again as a defense in
      // depth; doing it here makes the audit trail / event payloads
      // use the canonical form.
      const normalized = config.targetFiles
        .map(item => {
          return normalizeLockPath(item);
        })
        .filter(Boolean);
      // Dedup and lock to stable order so two equivalent declarations
      // produce the same lock-acquire key sequence (matters for
      // FIFO drain ordering when multiple workers want the same set).
      const unique = [...new Set(normalized)].sort();
      if (unique.length) config.targetFiles = unique;
      else delete config.targetFiles;
    } else if (config.targetFiles !== undefined) {
      // Author wrote something non-array — preserve it under
      // `targetFilesOriginal` for audit but drop from runtime.
      config.targetFilesOriginal = config.targetFiles;
      delete config.targetFiles;
    }
  }
  // P2b follow-up 2026-05-15 (round 2): LLMs frequently emit `orpad.graph` /
  // `orpad.tree` nodes as semantic markers ("this stage decomposes
  // hierarchically") but forget to set `config.graphRef` / `config.treeRef`.
  // Auto-fill the ref from the node id so a placeholder file is always
  // written and drill-down always works. Refs follow OrPAD's path
  // convention (see normalizeGraphRefValue / normalizeTreeRefValue).
  if (type === 'orpad.graph') {
    const rawRef = String(config.graphRef || '').trim();
    if (!rawRef) {
      config.graphRef = `${id}.or-graph`;
      config.graphRefAutoFilled = true;
    } else {
      const normalized = normalizeGraphRefValue(rawRef);
      if (normalized !== rawRef) {
        config.graphRefOriginal = rawRef;
        config.graphRef = normalized;
      }
    }
    // Fork-Join Phase 1: default every authored orpad.graph wrapper to
    // inline execution so buildInlinePlan flattens the inner graph into
    // the parent's orderedNodes and the wrapper stops firing empty
    // payload events. The author may override by setting an explicit
    // value ('module' restores the old metadata-stub behavior).
    if (typeof config.executionMode !== 'string' || !config.executionMode.trim()) {
      config.executionMode = 'inline';
    }
    // onInnerFailure (Phase 3+ follow-up to Step 4): sanitize the
    // sub-graph failure policy. Default 'block' preserves the
    // pre-Phase-3 semantics (an inner failure halts the run). The
    // scheduler reads this when an inner node throws to decide
    // whether to re-throw or synthesize a recovered result.
    const authoredInnerFailure = String(config.onInnerFailure || '').trim();
    if (authoredInnerFailure && !['block', 'continue', 'partial'].includes(authoredInnerFailure)) {
      // Preserve the original under audit; default the runtime field.
      config.onInnerFailureOriginal = config.onInnerFailure;
      config.onInnerFailure = 'block';
      config.onInnerFailureNote = 'Machine runtime only accepts block|continue|partial; authored value preserved.';
    } else if (!authoredInnerFailure) {
      config.onInnerFailure = 'block';
    }
  }
  if (type === 'orpad.tree') {
    const rawRef = String(config.treeRef || '').trim();
    if (!rawRef) {
      config.treeRef = `../trees/${id}.or-tree`;
      config.treeRefAutoFilled = true;
    } else {
      const normalized = normalizeTreeRefValue(rawRef);
      if (normalized !== rawRef) {
        config.treeRefOriginal = rawRef;
        config.treeRef = normalized;
      }
    }
  }
  if (type === 'orpad.gate') {
    const sanitized = sanitizeGateOnFail(config.onFail);
    config.onFail = sanitized.onFail;
    if (sanitized.replaced) {
      config.authoredOnFail = sanitized.original;
      config.onFailNote = `Machine runtime only accepts ${GATE_ON_FAIL_VALUES.join('|')}; authored value preserved in authoredOnFail.`;
    }
    // onPass is not validated by the runtime today; strip non-string values so it
    // doesn't pollute the spec, but otherwise leave it alone.
    if (config.onPass !== undefined && typeof config.onPass !== 'string') delete config.onPass;
  }
  if (type === 'orpad.artifactContract') {
    const authoredRequired = Array.isArray(config.required)
      ? config.required.map(item => String(item || '').trim()).filter(Boolean)
      : [];
    const authoredRequiredQueue = Array.isArray(config.requiredQueue)
      ? config.requiredQueue.map(item => String(item || '').trim()).filter(Boolean)
      : [];
    config.artifactRoot ||= 'harness/generated/latest-run/artifacts';
    config.queueRoot ||= 'harness/generated/latest-run/queue';
    config.required = [...CANONICAL_REQUIRED_ARTIFACTS];
    config.requiredQueue = [...CANONICAL_REQUIRED_QUEUE];
    config.onMissing = 'mark-partial';
    const expectedArtifacts = authoredRequired.filter(item => !CANONICAL_REQUIRED_ARTIFACTS.includes(item));
    const expectedQueue = authoredRequiredQueue.filter(item => !CANONICAL_REQUIRED_QUEUE.includes(item));
    if (expectedArtifacts.length || expectedQueue.length) {
      config.authoredEvidenceExpectations = {
        artifacts: expectedArtifacts,
        queue: expectedQueue,
        enforcement: 'not-hard-required-by-artifact-contract',
      };
    }
  }
  return { id, type, label, config };
}

function transitionId(from, to, index) {
  return `${nodeId(from, 'from')}-to-${nodeId(to, 'to')}-${index + 1}`;
}

function linearTransitions(nodes) {
  return nodes.slice(0, -1).map((node, index) => ({
    id: transitionId(node.id, nodes[index + 1].id, index),
    from: node.id,
    to: nodes[index + 1].id,
  }));
}

function normalizeTransitions(rawTransitions, nodes) {
  const ids = new Set(nodes.map(node => node.id));
  const seen = new Set();
  const transitions = Array.isArray(rawTransitions)
    ? rawTransitions.map((raw, index) => {
      if (!isPlainObject(raw)) return null;
      const from = String(raw.from || raw.source || '').trim();
      const to = String(raw.to || raw.target || '').trim();
      if (!ids.has(from) || !ids.has(to)) return null;
      // Allow loop-back transitions (from === to is rejected only for true self-loops,
      // but loop-backs where to is an earlier node in the list are allowed and important
      // for Ralph-loop / Cross-Validation patterns).
      if (from === to) return null;
      const id = uniqueId(raw.id || transitionId(from, to, index), seen);
      return { id, from, to, ...(raw.condition ? { condition: String(raw.condition) } : {}) };
    }).filter(Boolean)
    : [];
  // Reachability check: ensure every non-start node is the target of some transition
  // OR the source of some loop-back (in which case it must already be reachable through
  // another transition). We accept partial LLM output if at least 80% of nodes are reachable;
  // otherwise we fall back to a linear chain to keep the pipeline runnable.
  const coveredTargets = new Set(transitions.map(transition => transition.to));
  const start = nodes[0]?.id || '';
  const reachable = nodes.filter((node, index) => index === 0 || coveredTargets.has(node.id) || node.id === start);
  const reachableRatio = nodes.length ? reachable.length / nodes.length : 1;
  if (!transitions.length || reachableRatio < 0.8) {
    return linearTransitions(nodes);
  }
  return transitions;
}

function analyzeGraphComplexity(nodes, transitions) {
  const nodeIds = nodes.map(node => node.id);
  const nodeIndex = new Map(nodeIds.map((id, i) => [id, i]));
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const typesSet = new Set(nodes.map(node => node.type));
  const outDegree = new Map();
  const outgoingByNode = new Map();
  for (const transition of transitions) {
    outDegree.set(transition.from, (outDegree.get(transition.from) || 0) + 1);
    if (!outgoingByNode.has(transition.from)) outgoingByNode.set(transition.from, []);
    outgoingByNode.get(transition.from).push(transition);
  }
  const branchNodes = [];
  for (const node of nodes) {
    if ((outDegree.get(node.id) || 0) > 1) branchNodes.push(node);
  }
  const loopBackCount = transitions.filter(transition => {
    const fromIdx = nodeIndex.get(transition.from);
    const toIdx = nodeIndex.get(transition.to);
    return typeof fromIdx === 'number' && typeof toIdx === 'number' && toIdx <= fromIdx;
  }).length;
  const subGraphCount = nodes.filter(node => node.type === 'orpad.graph' || node.type === 'orpad.tree').length;
  const barrierCount = nodes.filter(node => node.type === 'orpad.barrier').length;
  const gateCount = nodes.filter(node => node.type === 'orpad.gate').length;
  const selectorCount = nodes.filter(node => node.type === 'orpad.selector').length;
  const workerLoopCount = nodes.filter(node => node.type === 'orpad.workerLoop').length;
  const workQueueCount = nodes.filter(node => node.type === 'orpad.workQueue').length;
  const dispatcherCount = nodes.filter(node => node.type === 'orpad.dispatcher').length;
  const patchReviewNodes = nodes.filter(node => node.type === 'orpad.patchReview');
  const patchReviewCount = patchReviewNodes.length;

  // Pattern I detection: any gate (or its descendant transition) that loops back
  // to a dispatcher / triage / workQueue node is treated as an outer queue-drain
  // loop. Without it, a workQueue chain runs exactly one slice.
  const drainTargets = new Set(
    nodes.filter(node => ['orpad.dispatcher', 'orpad.triage', 'orpad.workQueue'].includes(node.type)).map(node => node.id),
  );
  const hasQueueDrainLoop = transitions.some(transition => {
    const fromNode = nodeById.get(transition.from);
    if (!fromNode || fromNode.type !== 'orpad.gate') return false;
    return drainTargets.has(transition.to);
  });

  // Pattern K detection: each patchReview node should have ≥2 outgoing transitions
  // — at minimum accepted + rejected. Single-edge patchReview has no enforcement
  // value.
  const patchReviewsWithBranching = patchReviewNodes.filter(node => (outDegree.get(node.id) || 0) >= 2);
  const patchReviewsLackingRejectLoop = patchReviewNodes.filter(node => (outDegree.get(node.id) || 0) < 2);

  // Pattern J vs C heuristic: a selector whose ≥2 outgoing transitions all
  // converge into the SAME downstream node (within a couple of hops) is a
  // selector-pretending-to-be-fork; that branch has no real divergent
  // semantics. We flag it so the model can choose between Pattern J (real
  // fork) or just collapsing it to a single edge.
  const selectorsConvergingImmediately = nodes
    .filter(node => node.type === 'orpad.selector')
    .filter(node => {
      const out = outgoingByNode.get(node.id) || [];
      if (out.length < 2) return false;
      const downstreamTargets = out.map(transition => {
        const nextOut = outgoingByNode.get(transition.to) || [];
        return nextOut.length === 1 ? nextOut[0].to : transition.to;
      });
      return new Set(downstreamTargets).size === 1;
    })
    .map(node => node.id);

  const patternsDetected = [];
  if (loopBackCount > 0) patternsDetected.push('ralph-loop');
  if (barrierCount > 0 || (selectorCount > 0 && workerLoopCount > 1)) patternsDetected.push('fork-join');
  if (gateCount >= 2 || (gateCount >= 1 && loopBackCount > 0)) patternsDetected.push('cross-validation');
  if (subGraphCount > 0) patternsDetected.push('subgraph-composition');
  if (workerLoopCount > 1) patternsDetected.push('multi-worker');
  if (hasQueueDrainLoop) patternsDetected.push('queue-drain-loop');
  if (patchReviewsWithBranching.length > 0) patternsDetected.push('patch-review-reject-loop');

  const branchPointCount = branchNodes.length;
  const isLinearChain = (
    branchPointCount === 0
    && loopBackCount === 0
    && subGraphCount === 0
    && barrierCount === 0
    && selectorCount === 0
  );

  const warnings = [];
  if (isLinearChain) {
    warnings.push('Generated graph is a flat linear chain. If the user request involves iteration, parallel sub-scopes, verification, retrieval, hierarchy, or multi-agent reasoning, the pipeline likely under-fits the task. Consider regenerating with a model prompt that asks for explicit pattern selection (Ralph loop / Fork-Join / Cross-Validation / Sub-graph / RAG / Ontology / Multi-Agent).');
  }
  if (workQueueCount > 0 && dispatcherCount > 0 && !hasQueueDrainLoop) {
    warnings.push('Pipeline has a workQueue + dispatcher chain but no outer queue-drain loop. The dispatcher will claim ONE item and then exit. Add a transition from the final gate back to triage/dispatcher with `condition: "queue-not-empty"` and a sibling transition with `condition: "queue-empty"` to artifactContract (Pattern I).');
  }
  if (patchReviewsLackingRejectLoop.length > 0) {
    warnings.push(`patchReview node(s) ${patchReviewsLackingRejectLoop.map(n => n.id).join(', ')} have <2 outgoing transitions. A patchReview with a single unconditional edge cannot enforce a reject. Add a "rejected" → workerLoop loop-back (Pattern K).`);
  }
  if (selectorsConvergingImmediately.length > 0) {
    warnings.push(`Selector node(s) ${selectorsConvergingImmediately.join(', ')} have multiple outgoing transitions that converge into the same downstream node. The selector is decorative. Either replace with Pattern J (multiple unconditional transitions + barrier) or collapse to a single edge.`);
  }

  return {
    nodeCount: nodes.length,
    uniqueNodeTypes: typesSet.size,
    branchPointCount,
    loopBackCount,
    subGraphCount,
    barrierCount,
    gateCount,
    selectorCount,
    workerLoopCount,
    workQueueCount,
    dispatcherCount,
    patchReviewCount,
    hasQueueDrainLoop,
    patternsDetected,
    isLinearChain,
    ...(warnings.length ? { warnings } : {}),
    // Backwards-compat alias so older readers still see simplicityWarning.
    ...(isLinearChain ? { simplicityWarning: warnings[0] } : {}),
  };
}

function defaultNodeConfig(node, taskText, externalResearchLimitation = '') {
  if (node.type === 'orpad.entry') return { summary: 'Begin managed run.' };
  if (node.type === 'orpad.context') return { ruleRef: 'context', skillRef: 'request-context', summary: taskText };
  if (node.type === 'orpad.probe') {
    return {
      lens: 'request-focused',
      userTask: taskText,
      skillRef: 'request-context',
      candidateLimitPolicy: 'collect-all-visible',
      ...(externalResearchLimitation ? { externalResearchLimitation } : {}),
    };
  }
  if (node.type === 'orpad.workQueue') return { queueRoot: 'harness/generated/latest-run/queue', schema: WORK_ITEM_SCHEMA_VERSION };
  if (node.type === 'orpad.triage') return { queueRef: 'queue' };
  if (node.type === 'orpad.dispatcher') return { queueRef: 'queue', workerLoopRef: 'worker' };
  if (node.type === 'orpad.workerLoop') return { queueRef: 'queue', targetFiles: [] };
  if (node.type === 'orpad.patchReview') return { reviewMode: 'user-selected-files' };
  if (node.type === 'orpad.gate') return { criteria: ['work result accepted', 'queue empty'], onFail: 'warn' };
  if (node.type === 'orpad.artifactContract') {
    return {
      artifactRoot: 'harness/generated/latest-run/artifacts',
      queueRoot: 'harness/generated/latest-run/queue',
      required: [...CANONICAL_REQUIRED_ARTIFACTS],
      requiredQueue: [...CANONICAL_REQUIRED_QUEUE],
      onMissing: 'mark-partial',
    };
  }
  if (node.type === 'orpad.exit') return { summary: 'Close after review and evidence checks.' };
  return {};
}

function nodeWithConfig(node, taskText, externalResearchLimitation = '') {
  return {
    ...node,
    config: {
      ...defaultNodeConfig(node, taskText, externalResearchLimitation),
      ...(node.config || {}),
    },
  };
}

function firstIndexMatching(nodes, predicate, fallback = nodes.length) {
  const index = nodes.findIndex(predicate);
  return index >= 0 ? index : fallback;
}

function lastIndexMatching(nodes, predicate, beforeIndex = nodes.length) {
  for (let index = Math.min(beforeIndex, nodes.length) - 1; index >= 0; index -= 1) {
    if (predicate(nodes[index], index)) return index;
  }
  return -1;
}

function moveNodeToIndex(nodes, node, targetIndex) {
  const currentIndex = nodes.indexOf(node);
  if (currentIndex < 0) return;
  nodes.splice(currentIndex, 1);
  const adjusted = currentIndex < targetIndex ? targetIndex - 1 : targetIndex;
  nodes.splice(Math.max(0, Math.min(nodes.length, adjusted)), 0, node);
}

function ensureNodeOfType(nodes, seen, type, rawNode, placementIndex) {
  const existing = nodes.find(node => node.type === type);
  if (existing) return existing;
  const node = sanitizeNode(rawNode, seen);
  if (!node) return null;
  const index = typeof placementIndex === 'function'
    ? placementIndex(nodes)
    : Number.isFinite(placementIndex)
      ? placementIndex
      : nodes.length;
  nodes.splice(Math.max(0, Math.min(nodes.length, index)), 0, node);
  return node;
}

function ensureCoreWorkstreamNodes(nodes, seen) {
  if (!nodes.some(node => node.type === 'orpad.entry')) {
    const entry = sanitizeNode({ id: 'entry', type: 'orpad.entry', label: 'Entry' }, seen);
    if (entry) nodes.unshift(entry);
  }

  const beforeWorkStateTail = () => firstIndexMatching(nodes, node => [
    'orpad.triage',
    'orpad.dispatcher',
    'orpad.workerLoop',
    'orpad.patchReview',
    'orpad.gate',
    'orpad.artifactContract',
    'orpad.exit',
  ].includes(node.type));
  const queue = ensureNodeOfType(nodes, seen, 'orpad.workQueue', CANONICAL_QUEUE_NODE, beforeWorkStateTail);

  const afterQueue = () => {
    const index = nodes.indexOf(queue);
    return index >= 0 ? index + 1 : beforeWorkStateTail();
  };
  const triage = ensureNodeOfType(nodes, seen, 'orpad.triage', CANONICAL_TRIAGE_NODE, afterQueue);

  const afterTriage = () => {
    const index = nodes.indexOf(triage);
    return index >= 0 ? index + 1 : afterQueue();
  };
  const dispatch = ensureNodeOfType(nodes, seen, 'orpad.dispatcher', CANONICAL_DISPATCH_NODE, afterTriage);

  const afterDispatch = () => {
    const index = nodes.indexOf(dispatch);
    return index >= 0 ? index + 1 : afterTriage();
  };
  const worker = ensureNodeOfType(nodes, seen, 'orpad.workerLoop', CANONICAL_WORKER_NODE, afterDispatch);

  const afterLastWorker = () => {
    const index = lastIndexMatching(nodes, node => node.type === 'orpad.workerLoop');
    return index >= 0 ? index + 1 : afterDispatch();
  };
  const patchReview = ensureNodeOfType(nodes, seen, 'orpad.patchReview', CANONICAL_REVIEW_NODE, afterLastWorker);

  const afterPatchReview = () => {
    const index = nodes.indexOf(patchReview);
    return index >= 0 ? index + 1 : afterLastWorker();
  };
  ensureNodeOfType(nodes, seen, 'orpad.gate', {
    id: 'verification-gate',
    type: 'orpad.gate',
    label: 'Verify task-specific result',
    config: { criteria: ['worker proof accepted', 'queue empty'], onFail: 'warn' },
  }, afterPatchReview);

  const beforeExit = () => firstIndexMatching(nodes, node => node.type === 'orpad.exit');
  const artifact = ensureNodeOfType(nodes, seen, 'orpad.artifactContract', CANONICAL_ARTIFACT_NODE, beforeExit);
  const exit = ensureNodeOfType(nodes, seen, 'orpad.exit', { id: 'exit', type: 'orpad.exit', label: 'Exit' }, nodes.length);

  if (exit) moveNodeToIndex(nodes, exit, nodes.length);
  if (artifact && exit) {
    const artifactIndex = nodes.indexOf(artifact);
    const exitIndex = nodes.indexOf(exit);
    if (artifactIndex > exitIndex) moveNodeToIndex(nodes, artifact, exitIndex);
  }
  return nodes;
}

const PATCH_ACCEPT_CONDITIONS = new Set(['accepted', 'accept', 'pass', 'continue']);
const PATCH_REJECT_CONDITIONS = new Set(['rejected', 'reject', 'revise']);
const GATE_PASS_CONDITIONS = new Set(['pass', 'continue', 'accept', 'accepted', 'ok', 'success']);
const GATE_REVISE_CONDITIONS = new Set(['revise', 'reject', 'rejected', 'fail', 'retry']);
const BARRIER_PASS_CONDITIONS = new Set(['pass', 'continue']);
const BARRIER_PARTIAL_CONDITIONS = new Set(['partial', 'fail']);
const DECISION_NODE_TYPES = new Set(['orpad.selector', 'orpad.gate', 'orpad.patchReview', 'orpad.barrier']);

function transitionCondition(transition) {
  return String(transition?.condition || '').trim();
}

function normalizedConditionText(condition) {
  return String(condition || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

function canonicalGateCondition(condition) {
  const c = normalizedConditionText(condition);
  if (!c) return '';
  if (c === 'queue-empty' || c.includes('queue-empty')) return 'queue-empty';
  if (
    c === 'queue-not-empty'
    || c.includes('queue-not-empty')
    || c.includes('not-empty')
    || c.includes('has-more')
    || c.includes('more-work')
    || c.includes('remaining')
  ) return 'queue-not-empty';
  if (GATE_PASS_CONDITIONS.has(c) || /\b(pass|passed|accept|accepted|approve|approved|ok|success|complete|completed|valid|verified)\b/.test(c)) {
    return 'pass';
  }
  if (GATE_REVISE_CONDITIONS.has(c) || /\b(revise|retry|reject|rejected|fail|failed|repair|fix|rework|blocked|needs)\b/.test(c)) {
    return 'revise';
  }
  return '';
}

function canonicalPatchReviewCondition(condition) {
  const c = normalizedConditionText(condition);
  if (!c) return '';
  if (PATCH_ACCEPT_CONDITIONS.has(c) || /\b(accept|accepted|approve|approved|pass|continue|ok|success|reviewed|complete|completed)\b/.test(c)) {
    return 'accepted';
  }
  if (PATCH_REJECT_CONDITIONS.has(c) || /\b(reject|rejected|revise|retry|repair|rework|fail|failed|blocked)\b/.test(c)) {
    return 'rejected';
  }
  return '';
}

function canonicalBarrierCondition(condition) {
  const c = normalizedConditionText(condition);
  if (!c) return '';
  if (BARRIER_PASS_CONDITIONS.has(c) || /\b(pass|continue|complete|completed|ready|joined|merged)\b/.test(c)) return 'pass';
  if (BARRIER_PARTIAL_CONDITIONS.has(c) || /\b(partial|fail|failed|incomplete|missing)\b/.test(c)) return 'partial';
  return '';
}

function normalizeTransitionForSource(rawTransition, sourceNode, index, seenIds) {
  const rawCondition = transitionCondition(rawTransition);
  const transition = {
    id: uniqueId(rawTransition.id || transitionId(rawTransition.from, rawTransition.to, index), seenIds),
    from: rawTransition.from,
    to: rawTransition.to,
  };
  if (!rawCondition) return transition;

  const sourceType = sourceNode?.type || '';
  let normalized = rawCondition;
  let note = '';
  if (sourceType === 'orpad.gate') {
    normalized = canonicalGateCondition(rawCondition);
    note = normalized ? 'gate-canonical-condition' : 'gate-unrecognized-condition-stripped';
  } else if (sourceType === 'orpad.patchReview') {
    normalized = canonicalPatchReviewCondition(rawCondition);
    note = normalized ? 'patch-review-canonical-condition' : 'patch-review-unrecognized-condition-stripped';
  } else if (sourceType === 'orpad.barrier') {
    normalized = canonicalBarrierCondition(rawCondition);
    note = normalized ? 'barrier-canonical-condition' : 'barrier-unrecognized-condition-stripped';
  } else if (sourceType === 'orpad.selector') {
    normalized = rawCondition;
  } else if (!DECISION_NODE_TYPES.has(sourceType)) {
    normalized = '';
    note = 'non-decision-source-condition-stripped';
  }

  if (normalized) transition.condition = normalized;
  if (normalized !== rawCondition) {
    transition.authoredCondition = rawCondition;
    if (note) transition.conditionNormalization = note;
  }
  return transition;
}

function ensureTransition(transitions, seenIds, from, to, condition = '') {
  if (!from || !to || from === to) return null;
  const normalizedCondition = String(condition || '').trim();
  const existing = transitions.find(transition => (
    transition.from === from
    && transition.to === to
    && transitionCondition(transition) === normalizedCondition
  ));
  if (existing) return existing;
  const id = uniqueId(transitionId(from, to, transitions.length), seenIds);
  const transition = {
    id,
    from,
    to,
    ...(normalizedCondition ? { condition: normalizedCondition } : {}),
  };
  transitions.push(transition);
  return transition;
}

function nodeByType(nodes, type) {
  return nodes.find(node => node.type === type) || null;
}

function previousNodeOfType(nodes, node, type) {
  const index = nodes.indexOf(node);
  if (index < 0) return nodeByType(nodes, type);
  const previousIndex = lastIndexMatching(nodes, candidate => candidate.type === type, index);
  return previousIndex >= 0 ? nodes[previousIndex] : nodeByType(nodes, type);
}

function nextNodeOfType(nodes, node, type) {
  const index = nodes.indexOf(node);
  const start = index >= 0 ? index + 1 : 0;
  return nodes.slice(start).find(candidate => candidate.type === type) || nodeByType(nodes, type);
}

function enforceTransitionContracts(rawTransitions, nodes) {
  const nodeIds = new Set(nodes.map(node => node.id));
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const seenIds = new Set();
  const transitions = [];
  for (const raw of rawTransitions || []) {
    if (!raw || !nodeIds.has(raw.from) || !nodeIds.has(raw.to) || raw.from === raw.to) continue;
    transitions.push(normalizeTransitionForSource(raw, nodesById.get(raw.from), transitions.length, seenIds));
  }

  const artifact = nodeByType(nodes, 'orpad.artifactContract');
  const exit = nodeByType(nodes, 'orpad.exit');
  const triage = nodeByType(nodes, 'orpad.triage');
  const dispatcher = nodeByType(nodes, 'orpad.dispatcher');
  const hasWorkQueueChain = !!(nodeByType(nodes, 'orpad.workQueue') && dispatcher);

  for (const review of nodes.filter(node => node.type === 'orpad.patchReview')) {
    const outgoing = transitions.filter(transition => transition.from === review.id);
    for (const transition of outgoing) {
      if (!transitionCondition(transition)) transition.condition = 'accepted';
    }
    const firstGateAfterReview = nextNodeOfType(nodes, review, 'orpad.gate');
    if (firstGateAfterReview && gateLooksEditorial(firstGateAfterReview)) {
      const firstGateIndex = nodes.indexOf(firstGateAfterReview);
      for (const transition of outgoing) {
        if (!PATCH_ACCEPT_CONDITIONS.has(transitionCondition(transition))) continue;
        const currentTargetIndex = nodes.findIndex(node => node.id === transition.to);
        if (currentTargetIndex < 0 || firstGateIndex < currentTargetIndex) {
          transition.to = firstGateAfterReview.id;
        }
      }
    }
    const refreshedOutgoing = transitions.filter(transition => transition.from === review.id);
    const worker = previousNodeOfType(nodes, review, 'orpad.workerLoop');
    const acceptedTarget = refreshedOutgoing.find(transition => PATCH_ACCEPT_CONDITIONS.has(transitionCondition(transition)))?.to
      || nextNodeOfType(nodes, review, 'orpad.gate')?.id
      || artifact?.id
      || exit?.id;
    if (worker && !transitions.some(transition => transition.to === review.id)) {
      ensureTransition(transitions, seenIds, worker.id, review.id);
    }
    if (worker && !refreshedOutgoing.some(transition => PATCH_REJECT_CONDITIONS.has(transitionCondition(transition)))) {
      ensureTransition(transitions, seenIds, review.id, worker.id, 'rejected');
    }
    if (acceptedTarget && !refreshedOutgoing.some(transition => PATCH_ACCEPT_CONDITIONS.has(transitionCondition(transition)))) {
      ensureTransition(transitions, seenIds, review.id, acceptedTarget, 'accepted');
    }
  }

  const artifactIndex = artifact ? nodes.indexOf(artifact) : nodes.length;
  const gatesBeforeArtifact = nodes.filter(node => (
    node.type === 'orpad.gate'
    && nodes.indexOf(node) >= 0
    && nodes.indexOf(node) < artifactIndex
  ));
  const lastGateBeforeArtifact = gatesBeforeArtifact[gatesBeforeArtifact.length - 1] || nodeByType(nodes, 'orpad.gate');

  for (const gate of nodes.filter(node => node.type === 'orpad.gate')) {
    const outgoing = transitions.filter(transition => transition.from === gate.id);
    const isQueueDrainGate = hasWorkQueueChain && artifact && gate === lastGateBeforeArtifact;
    for (const transition of outgoing) {
      if (transitionCondition(transition)) continue;
      transition.condition = isQueueDrainGate && transition.to === artifact.id ? 'queue-empty' : 'pass';
    }
    const refreshedOutgoing = transitions.filter(transition => transition.from === gate.id);
    const worker = previousNodeOfType(nodes, gate, 'orpad.workerLoop');
    if (worker && !refreshedOutgoing.some(transition => GATE_REVISE_CONDITIONS.has(transitionCondition(transition)))) {
      ensureTransition(transitions, seenIds, gate.id, worker.id, 'revise');
    }
    if (isQueueDrainGate) {
      ensureTransition(transitions, seenIds, gate.id, triage?.id || dispatcher.id, 'queue-not-empty');
      ensureTransition(transitions, seenIds, gate.id, artifact.id, 'queue-empty');
    } else {
      const next = nextNodeOfType(nodes, gate, 'orpad.gate')?.id || artifact?.id || exit?.id;
      if (next && !refreshedOutgoing.some(transition => GATE_PASS_CONDITIONS.has(transitionCondition(transition)))) {
        ensureTransition(transitions, seenIds, gate.id, next, 'pass');
      }
    }
  }

  if (artifact && exit) ensureTransition(transitions, seenIds, artifact.id, exit.id);
  return dedupeRawTransitions(transitions);
}

function finalizeNodeConfigsFromTransitions(nodes, transitions) {
  for (const node of nodes) {
    if (node.type === 'orpad.barrier') {
      const waitFor = stringArray(node.config?.waitFor);
      if (!waitFor.length) {
        const inferred = transitions
          .filter(transition => transition.to === node.id)
          .map(transition => transition.from)
          .filter(Boolean);
        if (inferred.length) {
          node.config.waitFor = [...new Set(inferred)];
          node.config.waitForInferred = true;
        }
      }
    }
    if (node.type === 'orpad.selector') {
      const outgoingConditions = transitions
        .filter(transition => transition.from === node.id)
        .map(transition => transitionCondition(transition))
        .filter(Boolean);
      if ((!Array.isArray(node.config.options) || !node.config.options.length) && outgoingConditions.length) {
        node.config.options = [...new Set(outgoingConditions)];
        node.config.optionsInferredFromTransitions = true;
      }
      if (!node.config.default && Array.isArray(node.config.options) && node.config.options.length) {
        node.config.default = node.config.options[0];
      }
      if (!node.config.selector && !node.config.selectorKind) node.config.selector = 'route';
    }
  }
}

function dedupeRawTransitions(transitions) {
  const seen = new Set();
  const result = [];
  for (const raw of transitions || []) {
    if (!raw || raw.from === raw.to) continue;
    const key = `${raw.from}\u0000${raw.to}\u0000${transitionCondition(raw)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(raw);
  }
  return result;
}

function collapseWorkerLoopsForMachine(nodes, rawTransitions) {
  const workerLoops = nodes.filter(node => node.type === 'orpad.workerLoop');
  if (workerLoops.length <= 1) return { nodes, transitions: rawTransitions || [] };
  const primary = workerLoops[0];
  const extraWorkerIds = new Set(workerLoops.slice(1).map(node => node.id));
  primary.config.authoredWorkerLanes = workerLoops.map(node => ({
    id: node.id,
    label: node.label,
    targetFiles: Array.isArray(node.config?.targetFiles) ? node.config.targetFiles : [],
  }));
  primary.config.workerLaneCollapseReason = 'Current managed-run adapter executes a single workerNodePath; extra authored workerLoop lanes were folded into this canonical worker and preserved as lane metadata.';

  let filteredNodes = nodes.filter(node => !extraWorkerIds.has(node.id));
  const rewriteEndpoint = id => (extraWorkerIds.has(id) ? primary.id : id);
  let transitions = (rawTransitions || []).map(raw => ({
    ...raw,
    from: rewriteEndpoint(raw.from),
    to: rewriteEndpoint(raw.to),
  })).filter(raw => raw.from && raw.to && raw.from !== raw.to);

  const collapsedSelectors = [];
  for (const selector of filteredNodes.filter(node => node.type === 'orpad.selector')) {
    const outgoing = transitions.filter(edge => edge.from === selector.id);
    if (outgoing.length < 2) continue;
    const targets = [...new Set(outgoing.map(edge => edge.to))];
    if (targets.length !== 1 || targets[0] !== primary.id) continue;
    collapsedSelectors.push({
      id: selector.id,
      label: selector.label,
      options: Array.isArray(selector.config?.options) ? selector.config.options : [],
    });
    transitions = transitions.flatMap(edge => {
      if (edge.from === selector.id) return [];
      if (edge.to !== selector.id) return [edge];
      const rewritten = { ...edge, to: primary.id };
      if (!transitionCondition(rewritten)) return [rewritten];
      return [rewritten];
    });
  }
  if (collapsedSelectors.length) {
    filteredNodes = filteredNodes.filter(node => !collapsedSelectors.some(selector => selector.id === node.id));
    primary.config.authoredWorkerSelectors = collapsedSelectors;
  }
  for (const node of filteredNodes) {
    if (node.type === 'orpad.dispatcher') node.config.workerLoopRef = primary.id;
  }
  return { nodes: filteredNodes, transitions: dedupeRawTransitions(transitions) };
}

function uniqueStrings(values, limit = 50) {
  return [...new Set((values || [])
    .map(item => String(item || '').trim())
    .filter(Boolean))]
    .slice(0, limit);
}

function selectedPackIds(selectedNodePacks = []) {
  return uniqueStrings(selectedNodePacks.map(pack => pack.id), 8);
}

function selectedPackRuleValues(selectedNodePacks = [], key) {
  return uniqueStrings(selectedNodePacks.flatMap(pack => pack.authoringHints?.rule?.[key] || []), 80);
}

function selectedPackAcceptanceCriteria(selectedNodePacks = []) {
  return uniqueStrings(selectedNodePacks.flatMap(pack => pack.authoringHints?.skill?.acceptanceCriteria || []), 12);
}

function selectedPackCandidateTargetPolicy(selectedNodePacks = []) {
  return uniqueStrings(selectedNodePacks.flatMap(pack => pack.authoringHints?.candidateTargetPolicy || []), 12);
}

function contentQaPackSelections(selectedNodePacks = []) {
  return (Array.isArray(selectedNodePacks) ? selectedNodePacks : [])
    .filter(pack => pack?.id === CONTENT_QA_NODE_PACK_ID);
}

function contentQaPromptMatched(selectedNodePacks = []) {
  return contentQaPackSelections(selectedNodePacks).some(pack => (
    (pack.matchedSignals || []).some(signal => (
      String(signal || '').startsWith('prompt:')
      || String(signal || '') === 'combined:prompt+workspace'
    ))
  ));
}

function needsContentEditorialContract(taskText, selectedNodePacks = []) {
  return CONTENT_INTENT_PATTERN.test(normalizeTask(taskText)) || contentQaPromptMatched(selectedNodePacks);
}

function selectedContentEditorialGate(selectedNodePacks = []) {
  const authored = contentQaPackSelections(selectedNodePacks)
    .map(pack => pack.authoringHints?.finalQualityGate)
    .find(item => isPlainObject(item));
  const criteria = uniqueStrings(
    authored?.criteria?.length ? authored.criteria : DEFAULT_CONTENT_EDITORIAL_GATE.criteria,
    8,
  );
  return {
    id: nodeId(authored?.id || DEFAULT_CONTENT_EDITORIAL_GATE.id, DEFAULT_CONTENT_EDITORIAL_GATE.id),
    label: normalizeTask(authored?.label || DEFAULT_CONTENT_EDITORIAL_GATE.label).slice(0, 120) || DEFAULT_CONTENT_EDITORIAL_GATE.label,
    criteria,
    evaluationMode: authored?.evaluationMode || DEFAULT_CONTENT_EDITORIAL_GATE.evaluationMode,
    judgePolicy: authored?.judgePolicy || DEFAULT_CONTENT_EDITORIAL_GATE.judgePolicy,
    expectedEvaluationArtifacts: Array.isArray(authored?.expectedEvaluationArtifacts)
      ? authored.expectedEvaluationArtifacts
      : DEFAULT_CONTENT_EDITORIAL_GATE.expectedEvaluationArtifacts,
    expectedJudgeArtifacts: Array.isArray(authored?.expectedJudgeArtifacts)
      ? authored.expectedJudgeArtifacts
      : DEFAULT_CONTENT_EDITORIAL_GATE.expectedJudgeArtifacts,
    nodePackRubric: Array.isArray(authored?.nodePackRubric)
      ? authored.nodePackRubric
      : DEFAULT_CONTENT_EDITORIAL_GATE.nodePackRubric,
  };
}

function gateLooksEditorial(node) {
  if (!node || node.type !== 'orpad.gate') return false;
  const identityText = [
    node.id,
    node.label,
    node.config?.summary,
    node.config?.evaluationMode,
    node.config?.sourceNodePack,
    ...(Array.isArray(node.config?.reviewChecklist) ? node.config.reviewChecklist : []),
    ...(Array.isArray(node.config?.qualityDimensions) ? node.config.qualityDimensions : []),
  ].map(item => String(item || '')).join('\n');
  return EDITORIAL_GATE_PATTERN.test(identityText);
}

function ensureContentEditorialGateNode(nodes, seen, taskText, selectedNodePacks = []) {
  if (!needsContentEditorialContract(taskText, selectedNodePacks)) return null;
  const existing = nodes.find(gateLooksEditorial);
  if (existing) return existing;

  const gate = selectedContentEditorialGate(selectedNodePacks);
  const patchReviewIndex = lastIndexMatching(nodes, node => node.type === 'orpad.patchReview');
  const firstGateAfterPatchReview = firstIndexMatching(nodes, node => (
    node.type === 'orpad.gate'
    && (patchReviewIndex < 0 || nodes.indexOf(node) > patchReviewIndex)
  ));
  const insertAt = firstGateAfterPatchReview >= 0
    ? firstGateAfterPatchReview
    : (patchReviewIndex >= 0 ? patchReviewIndex + 1 : firstIndexMatching(nodes, node => node.type === 'orpad.artifactContract'));
  const node = sanitizeNode({
    id: gate.id,
    type: 'orpad.gate',
    label: gate.label,
    config: {
      criteria: gate.criteria,
      onFail: 'warn',
      evaluationMode: gate.evaluationMode,
      judgePolicy: gate.judgePolicy,
      failureRouting: 'strict-revise',
      sourceNodePack: CONTENT_QA_NODE_PACK_ID,
      qualityDimensions: ['voice-tone', 'density-repetition', 'audience-fit', 'role-separation', 'before-after'],
      expectedEvaluationArtifacts: gate.expectedEvaluationArtifacts,
      expectedJudgeArtifacts: gate.expectedJudgeArtifacts,
      nodePackRubric: gate.nodePackRubric,
      summary: 'OrPAD-owned evaluator analyzes content diffs and worker-specific evaluation artifacts before the run records completion.',
    },
  }, seen);
  if (!node) return null;
  const boundedIndex = Number.isFinite(insertAt) && insertAt >= 0 ? insertAt : nodes.length;
  nodes.splice(Math.max(0, Math.min(nodes.length, boundedIndex)), 0, node);
  return node;
}

function selectedPackMetadata(selectedNodePacks = []) {
  return selectedNodePacks.map(pack => ({
    id: pack.id,
    name: pack.name,
    version: pack.version,
    origin: pack.origin,
    trustLevel: pack.trustLevel,
    score: pack.score,
    matchedSignals: pack.matchedSignals,
    reason: pack.reason,
    graphs: (pack.graphs || []).map(graph => graph.id).filter(Boolean),
    skills: (pack.skills || []).map(skill => skill.id).filter(Boolean),
    rules: (pack.rules || []).map(rule => rule.id).filter(Boolean),
  }));
}

function packSourceConfig(selectedNodePack) {
  if (!selectedNodePack) return {};
  return {
    sourceNodePack: selectedNodePack.id,
    sourceNodePackGraph: selectedNodePack.graphs?.[0]?.id || '',
    sourceNodePackSkill: selectedNodePack.skills?.[0]?.id || '',
    supportingNodePacks: selectedPackIds([selectedNodePack]),
  };
}

function deterministicAuthoringSpec(taskText, externalResearchIntent, externalResearchLimitation, selectedNodePacks = []) {
  const lower = normalizeTask(taskText).toLowerCase();
  const isLecture = /\b(lecture|course|class|slide|slides|teaching|lesson|threading|thread|concurrency)\b|강의|자료|슬라이드|수업/.test(lower);
  const isUi = /\b(ui|ux|dropdown|inspector|graph editor|z-index|sidebar|panel|screen|button)\b|드롭다운|인스펙터|그래프|사이드바/.test(lower);
  const isBug = /\b(bug|error|fail|failed|fix|regression|broken|validation|check failed)\b|버그|실패|오류|검증/.test(lower);
  const isDocs = /\b(readme|docs?|documentation|markdown|note|content)\b|문서|노트|마크다운/.test(lower);
  const primaryPack = Array.isArray(selectedNodePacks) ? selectedNodePacks[0] : null;
  const primaryHints = primaryPack?.authoringHints || {};
  const domainNodes = [];
  if (primaryHints.context && primaryHints.probe) {
    domainNodes.push(
      {
        id: primaryHints.context.id || 'map-pack-scope',
        type: 'orpad.context',
        label: primaryHints.context.label || `Map ${primaryPack.name} scope`,
        config: {
          summary: primaryHints.context.summary || primaryPack.reason,
          ...packSourceConfig(primaryPack),
        },
      },
      {
        id: primaryHints.probe.id || 'probe-pack-candidates',
        type: 'orpad.probe',
        label: primaryHints.probe.label || `Probe ${primaryPack.name} candidates`,
        config: {
          lens: primaryHints.probe.lens || nodeId(primaryPack.id, 'starter-pack'),
          maxCandidates: Number(primaryHints.probe.maxCandidates) || 5,
          candidateLimitPolicy: 'collect-all-visible',
          ...packSourceConfig(primaryPack),
        },
      },
    );
  } else if (isLecture) {
    domainNodes.push(
      { id: 'map-lecture-materials', type: 'orpad.context', label: 'Map lecture materials', config: { summary: 'Inventory units, slides, labs, examples, and unclear threading/concurrency explanations.' } },
      { id: 'find-learning-gaps', type: 'orpad.probe', label: 'Find learning gaps', config: { lens: 'lecture-comprehension', maxCandidates: 6, candidateLimitPolicy: 'collect-all-visible' } },
    );
  } else if (isUi) {
    domainNodes.push(
      { id: 'inspect-ui-state', type: 'orpad.context', label: 'Inspect UI state and layout paths', config: { summary: 'Collect renderer, CSS, and e2e coverage relevant to the requested UI behavior.' } },
      { id: 'reproduce-ui-risk', type: 'orpad.probe', label: 'Reproduce UI risk', config: { lens: 'ui-regression', maxCandidates: 5, candidateLimitPolicy: 'collect-all-visible' } },
    );
  } else if (isBug) {
    domainNodes.push(
      { id: 'reproduce-failure', type: 'orpad.context', label: 'Reproduce reported failure', config: { summary: 'Capture the exact failing check, affected files, and current behavior before editing.' } },
      { id: 'isolate-root-cause', type: 'orpad.probe', label: 'Isolate root cause candidates', config: { lens: 'bug-root-cause', maxCandidates: 5, candidateLimitPolicy: 'collect-all-visible' } },
    );
  } else if (isDocs) {
    domainNodes.push(
      { id: 'map-document-scope', type: 'orpad.context', label: 'Map document scope', config: { summary: 'Identify relevant docs, existing claims, and missing acceptance details.' } },
      { id: 'find-document-gaps', type: 'orpad.probe', label: 'Find document gaps', config: { lens: 'documentation-gap', maxCandidates: 5, candidateLimitPolicy: 'collect-all-visible' } },
    );
  } else {
    domainNodes.push(
      { id: 'inspect-solution-context', type: 'orpad.context', label: 'Inspect solution context', config: { summary: 'Collect files and project facts relevant to the requested solution.' } },
      { id: 'find-solution-work', type: 'orpad.probe', label: 'Find solution-specific work', config: { lens: 'solution-planning', maxCandidates: 5, candidateLimitPolicy: 'collect-all-visible' } },
    );
  }

  const verifyCriteria = uniqueStrings(primaryHints.verifyCriteria?.length
    ? primaryHints.verifyCriteria
    : (isLecture
      ? ['lecture flow is easier to understand', 'examples and slides align', 'generated evidence identifies changed learning outcomes']
      : isUi
        ? ['UI behavior matches request', 'layout layering is verified', 'targeted e2e or screenshot evidence exists']
        : isBug
          ? ['reported failure no longer reproduces', 'regression coverage protects the fix', 'validation passes']
          : ['requested outcome is implemented', 'evidence files explain the result', 'validation passes']), 8);
  const nodes = [
    { id: 'entry', type: 'orpad.entry', label: 'Entry' },
    domainNodes[0],
    ...(externalResearchIntent ? [{
      id: 'external-research-mode',
      type: 'orpad.selector',
      label: 'Confirm external research mode',
      config: {
        selector: 'externalResearchMode',
        options: ['local-only-research-gap', 'approved-or-attached-evidence'],
        default: 'local-only-research-gap',
        externalResearchLimitation,
        requiredEvidence: 'approved browsing or attached research evidence',
        fallback: 'report a research gap and propose only local evidence-backed work',
      },
    }] : []),
    ...domainNodes.slice(1),
    CANONICAL_QUEUE_NODE,
    CANONICAL_TRIAGE_NODE,
    CANONICAL_DISPATCH_NODE,
    {
      ...CANONICAL_WORKER_NODE,
      label: primaryHints.workerLabel || (isLecture ? 'Improve lecture materials' : isUi ? 'Implement UI correction' : isBug ? 'Patch root cause' : 'Implement solution work'),
      config: {
        ...(CANONICAL_WORKER_NODE.config || {}),
        ...(primaryPack ? {
          sourceNodePack: primaryPack.id,
          supportingNodePacks: selectedPackIds(selectedNodePacks),
        } : {}),
      },
    },
    CANONICAL_REVIEW_NODE,
    { id: 'verification-gate', type: 'orpad.gate', label: 'Verify task-specific result', config: { criteria: verifyCriteria, onFail: 'warn' } },
    CANONICAL_ARTIFACT_NODE,
    { id: 'exit', type: 'orpad.exit', label: 'Exit' },
  ].map(node => nodeWithConfig(node, taskText, externalResearchLimitation));
  const fallbackTransitions = [
    { from: 'entry', to: domainNodes[0].id },
    ...(externalResearchIntent
      ? [
        { from: domainNodes[0].id, to: 'external-research-mode' },
        { from: 'external-research-mode', to: domainNodes[1].id, condition: 'local-only-research-gap' },
        { from: 'external-research-mode', to: domainNodes[1].id, condition: 'approved-or-attached-evidence' },
      ]
      : [{ from: domainNodes[0].id, to: domainNodes[1].id }]),
    { from: domainNodes[1].id, to: 'queue' },
    { from: 'queue', to: 'triage' },
    { from: 'triage', to: 'dispatch' },
    { from: 'dispatch', to: 'worker' },
    { from: 'worker', to: 'patch-review' },
    { from: 'patch-review', to: 'worker', condition: 'rejected' },
    { from: 'patch-review', to: 'verification-gate', condition: 'accepted' },
    { from: 'verification-gate', to: 'worker', condition: 'revise' },
    { from: 'verification-gate', to: 'triage', condition: 'queue-not-empty' },
    { from: 'verification-gate', to: 'artifact', condition: 'queue-empty' },
    { from: 'artifact', to: 'exit' },
  ].map((transition, index) => ({ id: transitionId(transition.from, transition.to, index), ...transition }));
  return {
    title: taskText.slice(0, 96),
    description: externalResearchIntent
      ? `Generated from Pipes as a local-only managed workstream pipeline. ${externalResearchLimitation}`
      : 'Generated from Pipes as a managed, task-specific workstream pipeline.',
    graph: {
      id: nodeId(taskText, 'orpad-improvement'),
      label: taskText.slice(0, 96),
      start: 'entry',
      nodes,
      transitions: fallbackTransitions,
    },
    skill: {
      acceptanceCriteria: uniqueStrings([
        ...verifyCriteria,
        ...selectedPackAcceptanceCriteria(selectedNodePacks),
      ], 12),
    },
    metadata: {
      authoringMode: 'deterministic-fallback',
      authoringNotes: 'Pattern B+D+I+K: deterministic fallback uses an evaluator loop, patch-review reject loop, and queue-drain loop because a one-pass linear chain routinely leaves work unverified or only processes one queued item.',
      selectedNodePacks: selectedPackMetadata(selectedNodePacks),
    },
  };
}

// Returns a sanitized sub-graph payload `{ id, label, start, nodes, transitions }`
// suitable for writing to a `.or-graph` file under the pipeline directory.
// We reuse the main graph's sanitizeNode / normalizeTransitions helpers so a
// sub-graph follows the same node-type whitelist and transition wiring rules.
// Missing entry/exit nodes are auto-added so an LLM that only listed a probe
// or workerLoop still produces a runnable sub-graph.
function normalizeSubgraphPayload(raw, refForLabel, taskText, externalResearchLimitation) {
  const graphSpec = isPlainObject(raw?.graph) ? raw.graph : (isPlainObject(raw) ? raw : {});
  const seen = new Set();
  let nodes = Array.isArray(graphSpec.nodes)
    ? graphSpec.nodes.map(node => sanitizeNode(node, seen)).filter(Boolean)
    : [];
  if (!nodes.some(node => node.type === 'orpad.entry')) {
    nodes.unshift(sanitizeNode({ id: 'entry', type: 'orpad.entry', label: 'Entry' }, seen));
  }
  if (!nodes.some(node => node.type === 'orpad.exit')) {
    nodes.push(sanitizeNode({ id: 'exit', type: 'orpad.exit', label: 'Exit' }, seen));
  }
  nodes = nodes.map(node => nodeWithConfig(node, taskText, externalResearchLimitation));
  const transitions = enforceTransitionContracts(normalizeTransitions(graphSpec.transitions, nodes), nodes);
  finalizeNodeConfigsFromTransitions(nodes, transitions);
  // If the LLM forgot to wire entry → ... → exit, give a one-edge fallback so
  // the sub-graph is at least executable.
  if (!transitions.length && nodes.length >= 2) {
    transitions.push({ from: nodes[0].id, to: nodes[nodes.length - 1].id });
  }
  return {
    id: nodeId(graphSpec.id || raw?.id || refForLabel, 'subgraph'),
    label: normalizeTask(graphSpec.label || raw?.label || refForLabel).slice(0, 96) || refForLabel,
    start: String(graphSpec.start || nodes.find(node => node.type === 'orpad.entry')?.id || nodes[0]?.id || 'entry'),
    nodes,
    transitions,
  };
}

// Sanitize a behavior-tree root. `.or-tree` nodes use a different shape than
// graph nodes (Sequence / Selector / Context / Skill / Gate primitives with
// `children`). We do a permissive normalization: keep the user-provided
// structure but enforce id/label/type strings; if the LLM produced nothing
// usable, repair it to a small auditable gate instead of a TODO-only leaf.
const ALLOWED_TREE_NODE_TYPES = new Set(['Sequence', 'Selector', 'Context', 'Skill', 'Gate', 'Action', 'Decorator', 'Parallel']);

function sanitizeTreeNode(raw, depth = 0) {
  if (!isPlainObject(raw)) return null;
  if (depth > 6) return null; // prevent runaway nesting from a malformed spec
  const type = ALLOWED_TREE_NODE_TYPES.has(String(raw.type || '')) ? String(raw.type) : 'Sequence';
  const id = nodeId(raw.id || raw.label || type, type.toLowerCase());
  const label = normalizeTask(raw.label || raw.id || type).slice(0, 96) || type;
  const children = Array.isArray(raw.children)
    ? raw.children.map(child => sanitizeTreeNode(child, depth + 1)).filter(Boolean)
    : undefined;
  const config = isPlainObject(raw.config) ? raw.config : undefined;
  return {
    id,
    type,
    label,
    ...(config ? { config } : {}),
    ...(children && children.length ? { children } : {}),
  };
}

function normalizeSubtreePayload(raw, refForLabel) {
  const treeSpec = isPlainObject(raw?.tree) ? raw.tree : (isPlainObject(raw) ? raw : {});
  const root = sanitizeTreeNode(treeSpec.root) || {
    id: 'auto-repaired-tree-root',
    type: 'Sequence',
    label: 'Auto-repaired behavior tree root',
    children: [{
      id: 'verify-tree-scope',
      type: 'Gate',
      label: 'Verify behavior tree scope',
      config: { check: 'Generated tree root exists and must be refined with task-specific checks when the parent scope is expanded.' },
    }],
  };
  return {
    id: nodeId(treeSpec.id || raw?.id || refForLabel, 'subtree'),
    title: normalizeTask(treeSpec.title || treeSpec.label || raw?.label || refForLabel).slice(0, 96) || refForLabel,
    root,
  };
}

// Pull every authoring hint the LLM left on the parent `orpad.graph` /
// `orpad.tree` node — summary, scope, difficulty ladders, deliverables,
// leaves, criteria, etc. — and inline them into the placeholder so the
// user opening the empty layer can see "what was this stage supposed to
// do?" and either author it or replace the parent node. We avoid dumping
// raw JSON; instead we pretty-print known hint fields as readable lines.
function summarizeParentHints(parentNode) {
  if (!parentNode || !isPlainObject(parentNode.config)) return '';
  const config = parentNode.config;
  const lines = [];
  if (parentNode.label) lines.push(`Parent label: ${String(parentNode.label).trim()}`);
  if (config.summary) lines.push(`Summary: ${String(config.summary).trim()}`);
  if (config.subGraphScope) lines.push(`Scope: ${String(config.subGraphScope).trim()}`);
  if (config.unitKey) lines.push(`Unit key: ${String(config.unitKey).trim()}`);
  const arrayFields = ['difficultyPath', 'deliverables', 'leaves', 'criteria', 'checklist', 'waitFor', 'options'];
  for (const field of arrayFields) {
    if (Array.isArray(config[field]) && config[field].length) {
      lines.push(`${field}:`);
      for (const item of config[field].slice(0, 12)) {
        const s = String(item).trim();
        if (s) lines.push(`  - ${s}`);
      }
    }
  }
  return lines.join('\n');
}

function parentHintItems(parentNode, fields = ['criteria', 'checklist', 'deliverables', 'difficultyPath', 'leaves']) {
  if (!parentNode || !isPlainObject(parentNode.config)) return [];
  const items = [];
  for (const field of fields) {
    for (const item of stringArray(parentNode.config[field])) {
      items.push(item);
    }
  }
  return [...new Set(items)].slice(0, 8);
}

function hasMeaningfulSubgraphHints(parentNode) {
  if (!parentNode || !isPlainObject(parentNode.config)) return false;
  const config = parentNode.config;
  return Boolean(config.summary || config.subGraphScope || config.unitKey || parentHintItems(parentNode).length);
}

// Build a placeholder sub-graph/sub-tree when an `orpad.graph` / `orpad.tree`
// node references a ref the LLM did not author. Keeps double-click drill-down
// usable (the file exists and validates) while making the gap obvious. When
// the parent node carries authoring hints (summary, difficultyPath, leaves,
// …) we surface them inside the placeholder so the user can pick up where
// the LLM left off.
function placeholderSubgraph(ref, parentNode, taskText, externalResearchLimitation) {
  const hints = summarizeParentHints(parentNode);
  const hintItems = parentHintItems(parentNode);
  const idBase = nodeId(parentNode?.id || ref, 'subgraph');
  const criteria = hintItems.length
    ? hintItems.map(item => `Plan covers: ${item}`)
    : [`Sub-graph output reflects parent scope: ${parentNode?.label || ref}`];
  const summary = hasMeaningfulSubgraphHints(parentNode)
    ? `Auto-materialized from parent orpad.graph hints because the authoring spec omitted subgraphs[] for ${ref}.\n\n${hints}`
    : `Auto-materialized generic sub-graph because the authoring spec omitted subgraphs[] for ${ref}. Parent label: ${parentNode?.label || ref}. Refine this scaffold when the sub-scope needs custom logic.`;
  return normalizeSubgraphPayload({
    graph: {
      id: nodeId(ref, 'subgraph'),
      label: parentNode?.label
        ? `Auto-materialized sub-graph: ${parentNode.label}`
        : `Auto-materialized sub-graph (${ref})`,
      start: 'entry',
      nodes: [
        { id: 'entry', type: 'orpad.entry', label: 'Entry' },
        {
          id: 'collect-parent-scope',
          type: 'orpad.context',
          label: `Collect scope for ${idBase}`,
          config: { summary },
        },
        {
          id: 'draft-subgraph-plan',
          type: 'orpad.probe',
          label: `Draft scoped plan for ${idBase}`,
          config: {
            lens: `${idBase}-scoped-repair-plan`,
            maxCandidates: Math.max(3, Math.min(12, hintItems.length || 5)),
            candidateLimitPolicy: 'collect-all-visible',
            summary: 'Convert the parent graph hints into concrete queued repair candidates with evidence targets.',
          },
        },
        {
          id: 'verify-subgraph-plan',
          type: 'orpad.gate',
          label: `Verify scoped plan for ${idBase}`,
          config: { criteria, onFail: 'warn' },
        },
        { id: 'exit', type: 'orpad.exit', label: 'Exit' },
      ],
      transitions: [
        { from: 'entry', to: 'collect-parent-scope' },
        { from: 'collect-parent-scope', to: 'draft-subgraph-plan' },
        { from: 'draft-subgraph-plan', to: 'verify-subgraph-plan' },
        { from: 'verify-subgraph-plan', to: 'exit', condition: 'pass' },
      ],
    },
  }, ref, taskText, externalResearchLimitation);
}

// Promote any array of authoring strings the LLM left on the parent
// `orpad.tree` node (`leaves`, `criteria`, `checklist`) into actual tree
// children. A behavior-tree node whose only purpose is to verify a set
// of slice-completeness conditions is exactly a Sequence of Gate ticks —
// one Gate per condition. Producing those children directly from the
// LLM's hints turns a 1-node stub into a usable behavior tree without
// asking the LLM to author the structure twice (once as `leaves`, once
// as `subtrees[].tree.root.children`). The label is capped at 96 chars
// by sanitizeTreeNode; we stash the full condition text in config.check
// so the inspector can show the whole sentence.
function childrenFromTreeHints(parentNode) {
  if (!parentNode || !isPlainObject(parentNode.config)) return [];
  const config = parentNode.config;
  const sources = [
    { items: config.leaves, type: 'Gate', prefix: 'leaf' },
    { items: config.criteria, type: 'Gate', prefix: 'criterion' },
    { items: config.checklist, type: 'Gate', prefix: 'check' },
  ];
  const children = [];
  let index = 1;
  for (const { items, type, prefix } of sources) {
    if (!Array.isArray(items)) continue;
    for (const raw of items) {
      const text = String(raw || '').trim();
      if (!text) continue;
      children.push({
        id: `${prefix}-${index}`,
        type,
        // sanitizeTreeNode truncates the label, so we keep a short
        // ordinal label and put the actual check text in config.check
        // where the inspector renders the full sentence.
        label: `${prefix} ${index}`,
        config: { check: text },
      });
      index += 1;
    }
  }
  return children;
}

function placeholderSubtree(ref, parentNode) {
  const hints = summarizeParentHints(parentNode);
  const hintChildren = childrenFromTreeHints(parentNode);
  const hintsBlurb = hints
    ? `Auto-materialized from the parent orpad.tree node's config hints. Replace these children with hand-authored Sequence/Selector ticks when you refine the tree.\n\nOriginal parent-node authoring hints:\n${hints}`
    : `Auto-materialized generic tree because the authoring spec omitted subtrees[] for ${ref}. Refine this scaffold when the parent scope needs custom behavior-tree ticks.`;
  const title = parentNode?.label
    ? `Auto-materialized tree: ${parentNode.label}`
    : `Auto-materialized tree (${ref})`;
  // If the LLM left any leaves/criteria/checklist hints, promote them to
  // real Gate children so the tree actually has structure. Otherwise fall
  // back to a single Gate tick that can execute and be audited.
  const root = hintChildren.length
    ? {
      id: 'self-check-sequence',
      type: 'Sequence',
      label: 'Self-check sequence (auto from parent hints)',
      config: { summary: hintsBlurb },
      children: hintChildren,
    }
    : {
      id: 'auto-tree-scaffold',
      type: 'Sequence',
      label: 'Auto-materialized behavior tree scaffold',
      config: { summary: hintsBlurb },
      children: [{
        id: 'verify-tree-scope',
        type: 'Gate',
        label: 'Verify behavior tree scope',
        config: { check: hintsBlurb },
      }],
    };
  return normalizeSubtreePayload({
    tree: {
      id: nodeId(ref, 'subtree'),
      title,
      root,
    },
  }, ref);
}

// Walk the main graph's nodes and collect every (ref, parentNode) pair for
// the requested type/field combination. Returns an array of `{ ref, parentNode }`
// so the placeholder builders can attach the parent's authoring hints to a
// stub layer when the LLM forgot to author it.
function collectGraphRefs(nodes, configKey, fieldKey) {
  const refs = [];
  const seen = new Set();
  for (const node of nodes) {
    if (node?.type !== configKey) continue;
    const ref = String(node?.config?.[fieldKey] || '').trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    refs.push({ ref, parentNode: node });
  }
  return refs;
}

// Fork-Join Phase 1 (Deliverable 2): under `executionMode: 'inline'`,
// `buildInlinePlan` flattens an inner graph's nodes into the parent's
// orderedNodes using nodePaths keyed `${graphKey}/${nodeId}`. If two
// `orpad.graph` parents reference the same child .or-graph file, the
// loader collapses them to one graphKey and both parents inline the
// same inner nodePaths — so their inner lifecycle events collide.
// Sanitizer auto-fill already produces unique refs (`${parentId}.or-graph`)
// per parent; the remaining risk is explicit LLM-authored duplicate refs.
// Rewrite any collisions to the auto-fill convention so each parent gets
// a unique invocation identity. Preserve the original under
// `graphRefCollisionOriginal` so audits can see the rewrite.
function enforceUniqueWrapperRefs(nodes, configKey, fieldKey, refBuilder) {
  const seenRefs = new Map();
  for (const node of nodes) {
    if (node?.type !== configKey) continue;
    const ref = String(node?.config?.[fieldKey] || '').trim();
    if (!ref) continue;
    if (!seenRefs.has(ref)) {
      seenRefs.set(ref, node.id);
      continue;
    }
    let uniqueRef = refBuilder(node.id, 0);
    let attempt = 2;
    while (seenRefs.has(uniqueRef)) {
      uniqueRef = refBuilder(node.id, attempt);
      attempt += 1;
    }
    node.config[`${fieldKey}CollisionOriginal`] = ref;
    node.config[`${fieldKey}CollisionRewrite`] = true;
    node.config[fieldKey] = uniqueRef;
    seenRefs.set(uniqueRef, node.id);
  }
}

function normalizeSubgraphList(rawList, requiredRefs, taskText, externalResearchLimitation) {
  const byRef = new Map();
  if (Array.isArray(rawList)) {
    for (const entry of rawList) {
      if (!isPlainObject(entry)) continue;
      const rawRef = String(entry.ref || entry.graphRef || '').trim();
      if (!rawRef) continue;
      // Match the convention sanitizeNode applied to config.graphRef so
      // pipeline-rooted and graph-file-relative spec entries land on the
      // same key.
      const ref = normalizeGraphRefValue(rawRef);
      byRef.set(ref, normalizeSubgraphPayload(entry, ref, taskText, externalResearchLimitation));
    }
  }
  for (const { ref, parentNode } of requiredRefs) {
    if (!byRef.has(ref)) {
      byRef.set(ref, placeholderSubgraph(ref, parentNode, taskText, externalResearchLimitation));
    }
  }
  return [...byRef.entries()].map(([ref, graph]) => ({ ref, graph }));
}

function normalizeSubtreeList(rawList, requiredRefs) {
  const byRef = new Map();
  if (Array.isArray(rawList)) {
    for (const entry of rawList) {
      if (!isPlainObject(entry)) continue;
      const rawRef = String(entry.ref || entry.treeRef || '').trim();
      if (!rawRef) continue;
      const ref = normalizeTreeRefValue(rawRef);
      byRef.set(ref, normalizeSubtreePayload(entry, ref));
    }
  }
  for (const { ref, parentNode } of requiredRefs) {
    if (!byRef.has(ref)) {
      byRef.set(ref, placeholderSubtree(ref, parentNode));
    }
  }
  return [...byRef.entries()].map(([ref, tree]) => ({ ref, tree }));
}

function normalizeAuthoringSpec(rawSpec, taskText, externalResearchIntent, externalResearchLimitation, selectedNodePacks = []) {
  const spec = isPlainObject(rawSpec) ? rawSpec : deterministicAuthoringSpec(taskText, externalResearchIntent, externalResearchLimitation, selectedNodePacks);
  const graphSpec = isPlainObject(spec.graph) ? spec.graph : spec;
  const seen = new Set();
  let nodes = Array.isArray(graphSpec.nodes)
    ? graphSpec.nodes.map(raw => sanitizeNode(raw, seen)).filter(Boolean)
    : [];
  if (!nodes.length) {
    return normalizeAuthoringSpec(deterministicAuthoringSpec(taskText, externalResearchIntent, externalResearchLimitation, selectedNodePacks), taskText, externalResearchIntent, externalResearchLimitation, selectedNodePacks);
  }
  nodes = ensureCoreWorkstreamNodes(nodes, seen);
  ensureContentEditorialGateNode(nodes, seen, taskText, selectedNodePacks);
  nodes = nodes.filter(Boolean).map(node => nodeWithConfig(node, taskText, externalResearchLimitation));
  const firstQueue = nodes.find(node => node.type === 'orpad.workQueue')?.id || 'queue';
  const firstWorker = nodes.find(node => node.type === 'orpad.workerLoop')?.id || 'worker';
  const nodeIds = new Set(nodes.map(node => node.id));
  for (const node of nodes) {
    if (['orpad.triage', 'orpad.dispatcher', 'orpad.workerLoop'].includes(node.type)) {
      node.config.queueRef = nodeIds.has(String(node.config.queueRef || '')) ? node.config.queueRef : firstQueue;
    }
    if (node.type === 'orpad.dispatcher') {
      node.config.workerLoopRef = nodeIds.has(String(node.config.workerLoopRef || '')) ? node.config.workerLoopRef : firstWorker;
    }
  }
  const collapsedWorkers = collapseWorkerLoopsForMachine(nodes, graphSpec.transitions || spec.transitions || []);
  nodes = collapsedWorkers.nodes;
  const transitions = enforceTransitionContracts(
    normalizeTransitions(collapsedWorkers.transitions, nodes),
    nodes,
  );
  finalizeNodeConfigsFromTransitions(nodes, transitions);
  // Phase 1: ensure each orpad.graph / orpad.tree wrapper has a unique
  // ref before refs are collected for materialization. This prevents
  // reused-subgraph nodePath collisions under inline expansion.
  enforceUniqueWrapperRefs(nodes, 'orpad.graph', 'graphRef', (parentId, attempt) => (
    normalizeGraphRefValue(attempt > 0 ? `${parentId}-${attempt}.or-graph` : `${parentId}.or-graph`)
  ));
  enforceUniqueWrapperRefs(nodes, 'orpad.tree', 'treeRef', (parentId, attempt) => (
    normalizeTreeRefValue(attempt > 0 ? `../trees/${parentId}-${attempt}.or-tree` : `../trees/${parentId}.or-tree`)
  ));
  // Collect graphRefs / treeRefs the main graph declared and pair each with
  // an entry from spec.subgraphs[] / spec.subtrees[]. Missing entries get a
  // placeholder so double-click drill-down has SOMETHING to open.
  const requiredGraphRefs = collectGraphRefs(nodes, 'orpad.graph', 'graphRef');
  const requiredTreeRefs = collectGraphRefs(nodes, 'orpad.tree', 'treeRef');
  const subgraphs = normalizeSubgraphList(spec.subgraphs, requiredGraphRefs, taskText, externalResearchLimitation);
  const subtrees = normalizeSubtreeList(spec.subtrees, requiredTreeRefs);
  return {
    title: normalizeTask(spec.title || graphSpec.label || taskText).slice(0, 96),
    description: truncateDescription(spec.description || ''),
    graph: {
      id: nodeId(graphSpec.id || spec.id || taskText, 'orpad-improvement'),
      label: normalizeTask(graphSpec.label || spec.title || taskText).slice(0, 96),
      start: String(graphSpec.start || nodes.find(node => node.type === 'orpad.entry')?.id || nodes[0]?.id || 'entry'),
      nodes,
      transitions,
    },
    subgraphs,
    subtrees,
    skill: isPlainObject(spec.skill) ? spec.skill : {},
    rule: isPlainObject(spec.rule) ? spec.rule : {},
    metadata: isPlainObject(spec.metadata) ? spec.metadata : {},
  };
}

function firstNodePath(nodes, type, fallback) {
  const found = nodes.find(node => node.type === type);
  return found ? `main/${found.id}` : fallback;
}

function generatedProbeNodePaths(mainNodes, subgraphs = []) {
  const paths = [];
  for (const node of mainNodes || []) {
    if (node?.type === 'orpad.probe') paths.push(`main/${node.id}`);
  }
  for (const entry of subgraphs || []) {
    const graph = entry?.graph;
    if (!graph?.id || !Array.isArray(graph.nodes)) continue;
    for (const node of graph.nodes) {
      if (node?.type === 'orpad.probe') paths.push(`${graph.id}/${node.id}`);
    }
  }
  return [...new Set(paths)];
}

async function createOrchestrationPipeline(options = {}) {
  const workspaceInput = String(options.workspaceRoot || options.workspacePath || '').trim();
  if (!workspaceInput) throw new Error('workspaceRoot is required.');
  const workspaceRoot = path.resolve(workspaceInput);
  const taskText = normalizeTask(options.taskText || options.prompt)
    || 'Improve this OrPAD workspace from the current user request, generate evidence, and keep changes reviewable.';
  const stamp = runbookTimestamp(options.now || options.timestamp || new Date());
  const slug = `${slugify(taskText, 'orpad-improvement')}-${stamp.toLowerCase()}`;
  const externalResearchIntent = hasExternalResearchIntent(taskText);
  const externalResearchLimitation = externalResearchIntent ? externalResearchLimitationText() : '';
  const generatedProcessUntil = [
    'queue-empty',
    'approval-required-next',
    'scope-split-required',
    'verification-blocked',
    'risk-budget-exceeded',
    'handoff-required',
  ];
  const workspaceSnapshot = options.workspaceSnapshot || {};
  const selectedNodePacks = selectAuthoringNodePacks(taskText, workspaceSnapshot, {
    maxPacks: Number(options.maxAuthoringNodePacks) || 3,
    requiredPackIds: options.requiredNodePackIds || options.requiredAuthoringNodePackIds || [],
  });
  const rawAuthoringSpec = options.authoringSpec
    || (options.authoringSpecText ? parseAuthoringSpecText(options.authoringSpecText) : null);
  const hasAuthoredSpec = !!rawAuthoringSpec;
  const authoringSpec = normalizeAuthoringSpec(rawAuthoringSpec, taskText, externalResearchIntent, externalResearchLimitation, selectedNodePacks);
  const graphNodes = authoringSpec.graph.nodes;
  const graphTransitions = authoringSpec.graph.transitions;
  const probeNodes = graphNodes.filter(node => node.type === 'orpad.probe');
  const generatedCandidateLimit = Math.max(1, Math.min(20, Number(probeNodes[0]?.config?.maxCandidates || 5) || 5));

  const pipelineDir = path.join(workspaceRoot, '.orpad', 'pipelines', slug);
  const graphDir = path.join(pipelineDir, 'graphs');
  const skillDir = path.join(pipelineDir, 'skills');
  const ruleDir = path.join(pipelineDir, 'rules');
  const harnessDir = path.join(pipelineDir, 'harness');
  const generatedDir = path.join(harnessDir, 'generated');
  const instructionsDir = path.join(workspaceRoot, '.orpad', 'instructions');
  const skillName = `orpad-improvement-${stamp}.md`;
  const skillPath = `skills/${skillName}`;
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  const graphPath = path.join(graphDir, 'main.or-graph');
  const contextRulePath = path.join(ruleDir, 'context.or-rule');
  const promptPath = path.join(generatedDir, 'orchestration-authoring-prompt.md');
  const authoringSpecPath = path.join(generatedDir, 'orchestration-authoring-spec.json');
  const workspaceInstructionPath = path.join(instructionsDir, 'orchestration-authoring.md');
  const createdFiles = [];

  const graph = {
    $schema: 'https://orpad.dev/schemas/or-graph/v1.json',
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: authoringSpec.graph.id,
      label: authoringSpec.graph.label,
      start: authoringSpec.graph.start,
      nodes: graphNodes,
      transitions: graphTransitions,
    },
  };
  const complexity = analyzeGraphComplexity(graphNodes, graphTransitions);
  const metadata = {
    orchestrationAuthoring: {
      tool: 'orpad-cli',
      command: 'generate',
      focus: 'orchestration-authoring',
      mode: hasAuthoredSpec ? 'llm-authored-spec' : 'deterministic-fallback',
      promptPath: 'harness/generated/orchestration-authoring-prompt.md',
      specPath: 'harness/generated/orchestration-authoring-spec.json',
      generatedAt: new Date(options.now || options.timestamp || new Date()).toISOString(),
      authoringNotes: authoringSpec.metadata.authoringNotes || '',
      nodePackSelection: selectedPackMetadata(selectedNodePacks),
    },
    graphComplexity: complexity,
    ...(externalResearchIntent ? {
      externalResearch: {
        limitation: externalResearchLimitation,
        requiredEvidence: 'approved browsing or attached research evidence',
        fallback: 'report a research gap and propose only local evidence-backed work',
      },
    } : {}),
  };
  const pipeline = {
    $schema: 'https://orpad.dev/schemas/or-pipeline/v1.json',
    kind: 'orpad.pipeline',
    version: '1.0',
    id: slug,
    title: authoringSpec.title || taskText.slice(0, 96),
    description: authoringSpec.description || (externalResearchIntent
      ? `Generated from Pipes as a local-only managed workstream pipeline. ${externalResearchLimitation}`
      : 'Generated from Pipes as a managed, task-specific workstream pipeline.'),
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    nodePacks: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3', origin: 'built-in' },
      { id: 'orpad.workstream', version: '>=0.1.0', origin: 'built-in' },
      ...selectedNodePacks.map(nodePackDeclarationForPipeline),
    ],
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
    skills: [{ id: 'request-context', file: skillPath }],
    rules: [{ id: 'context', file: 'rules/context.or-rule' }],
    harness: {
      path: 'harness/generated',
      authoringMode: 'llm-with-deterministic-fallback',
    },
    run: {
      artifactRoot: 'harness/generated/latest-run/artifacts',
      artifactRootResolution: 'relative-to-pipeline-directory',
      queueRoot: 'harness/generated/latest-run/queue',
      queueRootResolution: 'relative-to-pipeline-directory',
      candidateInventoryPath: 'harness/generated/latest-run/artifacts/discovery/candidate-inventory.json',
      candidateInventoryPathResolution: 'relative-to-pipeline-directory',
      summaryPath: 'harness/generated/latest-run/summary.md',
      summaryPathResolution: 'relative-to-pipeline-directory',
      durableRunRoot: 'runs',
      durableRunRootResolution: 'relative-to-pipeline-directory',
      externalResearchLimitation: externalResearchIntent ? externalResearchLimitation : undefined,
      runSelection: {
        collectAllVisibleCandidates: true,
        queueAllActionableCandidates: true,
        defaultAction: 'continue-claiming',
        processUntil: generatedProcessUntil,
      },
      machineAdapter: {
        type: 'codex-cli',
        enabled: true,
        mode: 'live-mvp',
        command: 'codex',
        sandbox: 'read-only',
        proposalSandbox: 'read-only',
        workerSandbox: 'workspace-write',
        approvalPolicy: 'never',
        ephemeral: true,
        candidateLimit: generatedCandidateLimit,
        proposalTimeoutMs: 600000,
        workerTimeoutMs: 900000,
        claimLeaseMs: 1800000,
        claimPolicy: {
          concurrency: 1,
        },
        probeNodePaths: generatedProbeNodePaths(graphNodes, authoringSpec.subgraphs),
        // User report 2026-05-15: an 8-probe pipeline ran each probe back-to-
        // back (~5 min apart) because configuredProbeConcurrency() in
        // machine.js defaults to 1 when no value is set. Probes are
        // read-only analysis — running them in parallel is safe. Default
        // every generated pipeline to `'all'` so probe count == parallelism
        // (machine.js clamps to probeCount when 'all' is used). Workers
        // remain serial (claimPolicy.concurrency: 1) until the file-lock
        // queue lands — patches are not yet race-condition safe.
        probeConcurrency: 'all',
        triageNodePath: firstNodePath(graphNodes, 'orpad.triage', 'main/triage'),
        dispatcherNodePath: firstNodePath(graphNodes, 'orpad.dispatcher', 'main/dispatch'),
        workerNodePath: firstNodePath(graphNodes, 'orpad.workerLoop', 'main/worker'),
        supportNodePolicy: 'record-gate-warnings-and-mark-artifact-partial',
        description: 'Generated managed-run adapter. OrPAD owns work state, run status, and evidence files; Codex CLI submits candidate/result/proof through adapter contracts.',
      },
      queueProtocol: {
        schema: WORK_ITEM_SCHEMA_VERSION,
        states: [...WORK_ITEM_STATES],
        claimPolicy: {
          concurrency: 1,
          defaultAction: 'continue-claiming',
          processUntil: generatedProcessUntil,
          stopWhenQueueEmpty: true,
          stopOnApprovalRequired: true,
        },
      },
    },
    metadata,
  };
  const contextRule = {
    kind: 'orpad.rule',
    version: '1.0',
    id: 'context',
    include: Array.isArray(authoringSpec.rule.include) && authoringSpec.rule.include.length
      ? authoringSpec.rule.include.map(item => String(item)).filter(Boolean).slice(0, 50)
      : uniqueStrings([
        ...selectedPackRuleValues(selectedNodePacks, 'include'),
        'README.md',
        'package.json',
        '.orpad/pipelines/**',
      ], 50),
    exclude: Array.isArray(authoringSpec.rule.exclude) && authoringSpec.rule.exclude.length
      ? authoringSpec.rule.exclude.map(item => String(item)).filter(Boolean).slice(0, 50)
      : uniqueStrings([
        ...selectedPackRuleValues(selectedNodePacks, 'exclude'),
        '.env',
        '**/*secret*',
        '**/*token*',
        '**/*.pem',
        '**/*.key',
      ], 50),
  };

  // Refs inside main.or-graph resolve relative to that file's directory
  // (`<pipelineDir>/graphs/`). `safeRefPath` mirrors the validator: resolve
  // the ref under `graphs/`, then express the result as a pipeline-rooted
  // POSIX path (used for the on-disk write + pipeline.graphs manifest).
  // Anything that escapes the pipeline directory is rejected so a malicious
  // LLM-emitted `../../etc/passwd.or-graph` cannot land outside the
  // workspace. The validator's `resolveRefInsideBase` enforces the same
  // invariant at read time; we just need to match it at write time.
  const pipelineRootAbs = path.resolve(pipelineDir);
  const mainGraphDirAbs = path.resolve(path.dirname(graphPath));
  const safeRefPath = (ref) => {
    const trimmed = String(ref || '').trim();
    if (!trimmed) return null;
    if (path.isAbsolute(trimmed)) return null;
    const resolved = path.resolve(mainGraphDirAbs, trimmed);
    const rel = path.relative(pipelineRootAbs, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  };
  const subgraphWrites = [];
  for (const entry of authoringSpec.subgraphs || []) {
    const safe = safeRefPath(entry.ref);
    if (!safe) continue;
    const dest = path.join(pipelineRootAbs, safe);
    subgraphWrites.push({
      ref: safe,
      absPath: dest,
      payload: {
        $schema: 'https://orpad.dev/schemas/or-graph/v1.json',
        kind: 'orpad.graph',
        version: '1.0',
        graph: entry.graph,
      },
    });
  }
  const subtreeWrites = [];
  for (const entry of authoringSpec.subtrees || []) {
    const safe = safeRefPath(entry.ref);
    if (!safe) continue;
    const dest = path.join(pipelineRootAbs, safe);
    subtreeWrites.push({
      ref: safe,
      absPath: dest,
      payload: {
        kind: 'orpad.tree',
        schemaVersion: '1.0',
        version: '1.0',
        id: entry.tree.id,
        title: entry.tree.title,
        trustLevel: 'local-authored',
        root: entry.tree.root,
      },
    });
  }
  // Append every emitted sub-graph to pipeline.graphs so the runner can
  // resolve them. Sub-trees live under their parent `orpad.tree` node's
  // `config.treeRef` already; the pipeline manifest does not need them
  // enumerated.
  for (const sg of subgraphWrites) {
    pipeline.graphs.push({ id: sg.payload.graph.id, file: sg.ref });
  }

  await fs.mkdir(instructionsDir, { recursive: true });
  await fs.mkdir(graphDir, { recursive: true });
  await fs.mkdir(skillDir, { recursive: true });
  await fs.mkdir(ruleDir, { recursive: true });
  await fs.mkdir(generatedDir, { recursive: true });
  for (const sg of subgraphWrites) await fs.mkdir(path.dirname(sg.absPath), { recursive: true });
  for (const st of subtreeWrites) await fs.mkdir(path.dirname(st.absPath), { recursive: true });

  await writeJson(pipelinePath, pipeline, createdFiles);
  await writeJson(graphPath, graph, createdFiles);
  for (const sg of subgraphWrites) await writeJson(sg.absPath, sg.payload, createdFiles);
  for (const st of subtreeWrites) await writeJson(st.absPath, st.payload, createdFiles);
  await writeText(path.join(pipelineDir, skillPath), defaultOrchestrationSkill(taskText, authoringSpec, selectedNodePacks), createdFiles);
  await writeJson(contextRulePath, contextRule, createdFiles);
  await writeText(promptPath, orchestrationAuthoringSpecPrompt(taskText, workspaceSnapshot), createdFiles);
  await writeJson(authoringSpecPath, authoringSpec, createdFiles);
  await writeText(workspaceInstructionPath, [
    '# OrPAD Orchestration Authoring',
    '',
    'Prompt-based Generate is routed through `orpad generate` so model prompts focus on defining orchestration, not implementing work.',
    '',
  ].join('\n'), createdFiles);

  const qualityAudit = await auditGeneratedPipelineQuality(pipelinePath);
  pipeline.metadata.orchestrationAuthoring.qualityAudit = {
    ok: qualityAudit.ok,
    summary: qualityAudit.summary,
    diagnostics: qualityAudit.diagnostics.map(item => ({
      level: item.level,
      code: item.code,
      message: item.message,
    })),
  };
  await fs.writeFile(pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`, 'utf-8');
  try {
    assertGeneratedPipelineQuality(qualityAudit);
  } catch (err) {
    err.pipelinePath = pipelinePath;
    err.pipelineDir = pipelineDir;
    if (!shouldKeepFailedPipeline(options)) {
      err.failedPipelineRemoved = await removeFailedPipelineDirectory(pipelineDir, workspaceRoot);
    }
    throw err;
  }

  return {
    success: true,
    ok: true,
    command: 'generate',
    workspaceRoot,
    taskText,
    slug,
    pipelineDir,
    pipelinePath,
    graphPath,
    skillPath: path.join(pipelineDir, skillPath),
    contextRulePath,
    promptPath,
    authoringSpecPath,
    createdFiles,
    generatedBy: metadata.orchestrationAuthoring,
    graphComplexity: complexity,
    qualityAudit: pipeline.metadata.orchestrationAuthoring.qualityAudit,
  };
}

module.exports = {
  analyzeGraphComplexity,
  AUTHORABLE_NODE_TYPES,
  createOrchestrationPipeline,
  defaultOrchestrationSkill,
  externalResearchLimitationText,
  hasExternalResearchIntent,
  normalizeTask,
  orchestrationAuthoringPrompt,
  orchestrationAuthoringSpecPrompt,
  parseAuthoringSpecText,
  runbookTimestamp,
  slugify,
};
