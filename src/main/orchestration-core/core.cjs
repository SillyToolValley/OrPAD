'use strict';
// OrPAD orchestration-core v0.2 — zero-node governed delegation (strangler; additive).
// Reuses the preserved isolation moat (patches.js overlay + write-set + patchArtifact).
// Philosophy: orchestrate as little as possible. No nodes: ground (recon), delegate the
// whole chunk to a capable coding agent in an isolated overlay, then enforce the write-set
// by diffing overlay->canonical (changes + out-of-set violations).
//
// v0.2 adds the MOTION/PROGRESS STOP-SIGNAL: a delegation that spins past a time cap is
// halted (whole process tree killed), partial work is still recovered (patch collected),
// and the run is marked stopped:time-cap. This is the core safety rail that prevents a
// single delegation from rabbit-holing on an intractable task (observed empirically:
// a hard deterministic-CV task spun >25min producing only debug churn, no converged output).

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const {
  copyAllowedFilesToOverlay,
  collectOverlayPatch,
} = require('../orchestration-machine/patches');

const trace = require('./trace.cjs');

function nowIso() { return new Date().toISOString(); }

// Default agent toolset for an autonomous (non-interactive `claude -p`) delegation.
// The isolation moat (write-set overlay + overlay->canonical diff) is the sandbox,
// NOT claude's interactive permission prompts — so a governed delegation must grant
// the agent a capable toolset up front, otherwise `claude -p` (which cannot prompt)
// stalls on the first tool that needs permission and the stop-signal kills it with
// no work done. Callers can still pass an explicit narrower allowedTools.
const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Bash', 'Grep', 'Glob', 'LS', 'TodoWrite',
  'WebSearch', 'WebFetch', 'Task',
];

// Recon: cheap, read-only grounding of the workspace before delegating.
function recon(workspaceRoot) {
  let entries = [];
  try {
    entries = fs.readdirSync(workspaceRoot, { withFileTypes: true })
      .map(d => d.name + (d.isDirectory() ? '/' : ''));
  } catch (_) { /* workspace may be empty */ }
  return { workspaceRoot, entries: entries.slice(0, 200), at: nowIso() };
}

// Kill the whole process tree (Windows: taskkill /T; POSIX: SIGKILL the child).
function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { shell: false });
    } else {
      child.kill('SIGKILL');
    }
  } catch (_) { /* best effort */ }
}

// --- Run cancellation registry -------------------------------------------------
// Tracks the live agent child process(es) per runId so a run can be STOPPED on
// demand (user "Stop" button) and so EVERY agent is killed when the app quits
// (otherwise a closed OrPAD leaves claude children running, holding resources).
const ACTIVE_CHILDREN = new Map(); // runId -> Set<child>
const CANCELLED_RUNS = new Set();  // runIds asked to stop

function registerChild(runId, child) {
  if (!runId) return;
  if (!ACTIVE_CHILDREN.has(runId)) ACTIVE_CHILDREN.set(runId, new Set());
  ACTIVE_CHILDREN.get(runId).add(child);
}
function unregisterChild(runId, child) {
  const set = ACTIVE_CHILDREN.get(runId);
  if (!set) return;
  set.delete(child);
  if (!set.size) ACTIVE_CHILDREN.delete(runId);
}
function isRunCancelled(runId) { return !!runId && CANCELLED_RUNS.has(runId); }
function cancelRun(runId) {
  if (!runId) return false;
  CANCELLED_RUNS.add(runId);
  const set = ACTIVE_CHILDREN.get(runId);
  if (set) for (const c of set) killTree(c);
  return !!(set && set.size);
}
function clearCancelled(runId) { if (runId) CANCELLED_RUNS.delete(runId); }
function cancelAllRuns() {
  for (const [runId, set] of ACTIVE_CHILDREN) {
    CANCELLED_RUNS.add(runId);
    for (const c of set) killTree(c);
  }
}

// AI-provider adapters. Each maps a provider key (the GUI's selection) to a CLI
// command + its non-interactive argv. The goal is ALWAYS delivered on stdin (safe for
// multi-line prompts under shell:true). Streaming providers parse their own native
// stdout into OrPAD trace events; the trace schema stays provider-neutral.
const PROVIDERS = {
  claude: {
    command: 'claude',
    stream: true,
    buildArgs: ({ allowedTools, streamMode }) => {
      const a = ['-p', '--output-format', streamMode ? 'stream-json' : 'json',
        ...(streamMode ? ['--verbose'] : []), '--no-session-persistence', '--permission-mode', 'default'];
      if (Array.isArray(allowedTools) && allowedTools.length) a.push('--allowedTools', ...allowedTools);
      return a;
    },
    parseLine: (obj, at) => trace.streamEventToTrace(obj, at),
  },
  codex: {
    command: 'codex',
    stream: true,
    buildArgs: ({ streamMode }) => [
      '--ask-for-approval', 'never',
      'exec',
      '-c', 'model_reasoning_effort=high',
      '--sandbox', 'workspace-write',
      '--skip-git-repo-check',
      '--ephemeral',
      ...(streamMode ? ['--json'] : []),
      '-',
    ],
    parseLine: (obj, at) => trace.codexEventToTrace(obj, at),
    resultFromLine: (obj, current) => trace.codexResultFromEvent(obj, current),
  },
  gemini: { command: 'gemini', stream: false, buildArgs: () => ['-y'] },
};
function getProvider(name) { return PROVIDERS[String(name || 'claude').toLowerCase()] || PROVIDERS.claude; }

// Is the provider's CLI actually installed / on PATH? (pre-flight so a missing agent
// surfaces clear guidance instead of a silent "ran but produced nothing").
function providerAvailable(command) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try { return spawnSync(probe, [command], { shell: false, windowsHide: true }).status === 0; }
  catch (_) { return false; }
}
function providerInfo(name) {
  const key = String(name || 'claude').toLowerCase();
  const provider = getProvider(key);
  return { provider: key in PROVIDERS ? key : 'claude', command: provider.command, available: providerAvailable(provider.command) };
}

// Delegate the whole goal to a capable CLI agent, running INSIDE the isolated overlay.
// Prompt goes via stdin (not argv) so multi-word goals are not mangled by the Windows shell.
// timeoutMs > 0 enables the motion stop-signal: the agent + its whole tree are killed on cap.
// Returns a Promise of the run result (stopped:true when the cap fired).
function delegateToAgent({ overlayRoot, goal, allowedTools, agent = 'claude', timeoutMs = 0, traceFile = null, onTraceEvent = null, runId = null }) {
  return new Promise((resolve) => {
    const provider = getProvider(agent);
    const streamMode = !!provider.stream && !!(traceFile || onTraceEvent);
    const args = provider.buildArgs({ allowedTools, streamMode });
    const t0 = Date.now();
    const child = spawn(provider.command, args, {
      cwd: overlayRoot,
      shell: true, // Windows: the agent CLI is often a .cmd shim
    });
    registerChild(runId, child);
    if (isRunCancelled(runId)) killTree(child); // already asked to stop before we spawned
    let out = '';
    let err = '';
    let stopped = false;
    let stopReason = null;
    // Provider JSONL: parse native stream lines into trace node events; capture
    // provider result metadata when the stream exposes it.
    let lineBuf = '';
    let resultEvent = null;
    const handleStreamLine = (line) => {
      const s = String(line).trim();
      if (!s) return;
      let obj = null;
      try { obj = JSON.parse(s); } catch (_) { obj = s; }
      if (provider.resultFromLine) resultEvent = provider.resultFromLine(obj, resultEvent) || resultEvent;
      else if (obj && obj.type === 'result') resultEvent = obj;
      try {
        const parseLine = provider.parseLine || (() => []);
        for (const ev of parseLine(obj, nowIso())) {
          if (traceFile) fs.appendFileSync(traceFile, JSON.stringify(ev) + '\n', 'utf8');
          if (onTraceEvent) { try { onTraceEvent(ev); } catch (_) { /* listener is best-effort */ } }
        }
      } catch (_) { /* trace is best-effort */ }
    };
    child.stdout.on('data', d => {
      const chunk = d.toString();
      out += chunk;
      if (streamMode) {
        lineBuf += chunk;
        let nl;
        while ((nl = lineBuf.indexOf('\n')) >= 0) {
          handleStreamLine(lineBuf.slice(0, nl));
          lineBuf = lineBuf.slice(nl + 1);
        }
      }
    });
    child.stderr.on('data', d => { err += d.toString(); });
    try { child.stdin.write(goal); child.stdin.end(); } catch (_) { /* ignore */ }

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        stopped = true;
        stopReason = 'time-cap';
        killTree(child);
      }, timeoutMs);
    }

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      unregisterChild(runId, child);
      if (isRunCancelled(runId)) { stopped = true; stopReason = stopReason || 'cancelled'; }
      if (streamMode && lineBuf.trim()) handleStreamLine(lineBuf);
      const durationMs = Date.now() - t0;
      let parsed = resultEvent;
      if (!streamMode) { try { parsed = JSON.parse(out || ''); } catch (_) { parsed = null; } }
      resolve({
        exitCode: code,
        signal,
        stopped,
        stopReason,
        durationMs,
        raw: out,
        stderr: err,
        result: parsed ? parsed.result : null,
        isError: parsed ? !!parsed.is_error : null,
        apiErrorStatus: parsed ? parsed.api_error_status : null,
        costUsd: parsed ? parsed.total_cost_usd : null,
        usage: parsed ? parsed.usage : null,
        numTurns: parsed ? parsed.num_turns : null,
        permissionDenials: parsed ? parsed.permission_denials : null,
      });
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      unregisterChild(runId, child);
      resolve({ exitCode: null, stopped, stopReason, durationMs: Date.now() - t0, raw: out, stderr: String(e), result: null, isError: true });
    });
  });
}

function appendObserverTrace(runRoot, record) {
  fs.mkdirSync(runRoot, { recursive: true });
  fs.appendFileSync(path.join(runRoot, 'observer.jsonl'), JSON.stringify(record) + '\n', 'utf8');
}

// --- Durable guidance catalog (the part of OrPAD the ralphloop grows) ----------------
// Standing, generalizable orchestration guidance PROMOTED from observed gaps
// (guidance-catalog.json). Injected as a hard-shell governance preamble into the
// soft-core goal of every governed delegation, so a lesson learned on one workload
// carries forward to all future ones. Missing/invalid catalog => no standing guidance.
const DEFAULT_GUIDANCE_CATALOG_PATH = path.join(__dirname, 'guidance-catalog.json');

function loadGuidanceCatalog(catalogPath = DEFAULT_GUIDANCE_CATALOG_PATH) {
  try {
    const doc = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const list = Array.isArray(doc) ? doc : (Array.isArray(doc.guidance) ? doc.guidance : []);
    return list
      .map(g => (typeof g === 'string' ? { id: null, guidance: g } : g))
      .filter(g => g && typeof g.guidance === 'string' && g.guidance.trim());
  } catch (_) {
    return [];
  }
}

// Prepend the standing guidance as a numbered preamble; return the goal unchanged when empty.
function composeGoalWithGuidance(goal, catalog) {
  const list = Array.isArray(catalog) ? catalog.filter(g => g && typeof g.guidance === 'string' && g.guidance.trim()) : [];
  if (!list.length) return goal;
  const lines = list.map((g, i) => `${i + 1}. ${g.guidance}`).join('\n');
  return [
    'Standing guidance (learned from prior OrPAD runs; follow unless the task below explicitly overrides):',
    lines,
    '',
    '--- Task ---',
    goal,
  ].join('\n');
}

// Zero-node governed delegation run.
// opts: { workspaceRoot, overlayRoot, runRoot?, allowedFiles, readOnlyFiles?, goal,
//         allowedTools?, agent?, timeoutMs?, injectGuidance?=true, guidanceCatalog?, guidanceCatalogPath? }
// The standing guidance catalog is injected into the goal unless injectGuidance===false.
async function runGovernedDelegation(opts) {
  const {
    workspaceRoot, overlayRoot, runRoot,
    allowedFiles = [], readOnlyFiles = [],
    goal, allowedTools, agent, timeoutMs = 0,
    injectGuidance = true, guidanceCatalog: guidanceCatalogOpt, guidanceCatalogPath,
    streamTrace = false, traceFile: traceFileOpt, onTraceEvent = null,
    seedOverlay = true,
  } = opts;
  if (!workspaceRoot) throw new Error('workspaceRoot is required');
  if (!overlayRoot) throw new Error('overlayRoot is required');
  if (!goal) throw new Error('goal is required');
  const runDir = runRoot || path.join(path.resolve(overlayRoot), '..', 'run');
  const traceFile = streamTrace ? (traceFileOpt || path.join(runDir, 'trace.jsonl')) : (traceFileOpt || null);
  if (traceFile) { fs.mkdirSync(runDir, { recursive: true }); fs.writeFileSync(traceFile, '', 'utf8'); }
  const phase = (kind, state) => {
    const ev = { ev: 'phase', kind, state, at: nowIso() };
    if (traceFile) fs.appendFileSync(traceFile, JSON.stringify(ev) + '\n', 'utf8');
    if (onTraceEvent) { try { onTraceEvent(ev); } catch (_) { /* listener is best-effort */ } }
  };

  // 1. recon (grounding)
  phase('recon', 'start');
  const reconResult = recon(workspaceRoot);
  appendObserverTrace(runDir, { event: 'recon', at: nowIso(), recon: reconResult });
  phase('recon', 'done');

  // 2. isolation moat: seed overlay with ONLY the write-set + read-only context.
  //    On a verification RETRY (seedOverlay=false) the existing overlay is REUSED
  //    so the agent fixes its own prior output instead of starting from scratch.
  phase('overlay_seeded', 'start');
  let seeded = [];
  if (seedOverlay) {
    fs.rmSync(overlayRoot, { recursive: true, force: true });
    fs.mkdirSync(overlayRoot, { recursive: true });
    seeded = await copyAllowedFilesToOverlay({ workspaceRoot, overlayRoot, allowedFiles, readOnlyFiles });
  } else {
    fs.mkdirSync(overlayRoot, { recursive: true });
  }
  appendObserverTrace(runDir, { event: 'overlay_seeded', at: nowIso(), seeded, allowedFiles, readOnlyFiles, timeoutMs, reused: !seedOverlay });
  phase('overlay_seeded', 'done');

  // 2.5 inject OrPAD's standing guidance catalog (the grown soft-core guidance) into the goal.
  phase('guidance_injected', 'start');
  const catalog = injectGuidance
    ? (Array.isArray(guidanceCatalogOpt) ? guidanceCatalogOpt : loadGuidanceCatalog(guidanceCatalogPath))
    : [];
  const effectiveGoal = composeGoalWithGuidance(goal, catalog);
  appendObserverTrace(runDir, {
    event: 'guidance_injected', at: nowIso(),
    injected: catalog.map(g => g.id || (g.guidance || '').slice(0, 40)),
  });
  phase('guidance_injected', 'done');

  // 3. delegate the whole chunk to the agent (its own inner loop), inside the overlay,
  //    under the motion stop-signal (timeoutMs cap). When streaming, the agent's tool
  //    use is classified into emergent-graph nodes written to traceFile live.
  phase('agent_run', 'start');
  const effectiveAllowedTools = (Array.isArray(allowedTools) && allowedTools.length) ? allowedTools : DEFAULT_ALLOWED_TOOLS;
  const agentRun = await delegateToAgent({ overlayRoot, goal: effectiveGoal, allowedTools: effectiveAllowedTools, agent, timeoutMs, traceFile, onTraceEvent, runId: opts.runId });
  appendObserverTrace(runDir, {
    event: 'agent_run', at: nowIso(),
    exitCode: agentRun.exitCode, durationMs: agentRun.durationMs,
    stopped: agentRun.stopped, stopReason: agentRun.stopReason,
    isError: agentRun.isError, apiErrorStatus: agentRun.apiErrorStatus,
    costUsd: agentRun.costUsd, usage: agentRun.usage, numTurns: agentRun.numTurns,
    resultPreview: (agentRun.result || '').slice(0, 200),
  });
  phase('agent_run', 'done');

  // 4. isolation enforcement moat: diff overlay->canonical => patchArtifact (changes + violations).
  //    Runs EVEN WHEN STOPPED so partial work is recovered, not lost.
  phase('patch_collected', 'start');
  const patch = await collectOverlayPatch({ workspaceRoot, overlayRoot, allowedFiles });
  appendObserverTrace(runDir, {
    event: 'patch_collected', at: nowIso(),
    stopped: agentRun.stopped,
    schemaVersion: patch.schemaVersion,
    changes: patch.changes.map(c => c.path),
    violations: patch.violations,
  });
  phase('patch_collected', 'done');

  return {
    recon: reconResult,
    seeded,
    agentRun,
    patch,
    stopped: agentRun.stopped,
    stopReason: agentRun.stopReason,
    summary: {
      durationMs: agentRun.durationMs,
      stopped: agentRun.stopped,
      stopReason: agentRun.stopReason,
      costUsd: agentRun.costUsd,
      usage: agentRun.usage,
      changeCount: patch.changes.length,
      violationCount: patch.violations.length,
      observerLog: path.join(runDir, 'observer.jsonl'),
    },
  };
}

// --- Grounding (the basic product-planning step before authoring) --------------------
// A real orchestration must not just delegate "build X"; it must FIRST ground the build:
// survey existing products/open-source/prior art, derive must-have requirements, study
// competitor limitations + how to overcome them, and prefer reuse/adaptation over
// reinventing. The base recon() only lists workspace files; this adds external prior-art
// research as a read-only delegation whose brief is injected into the build.

// Compose a READ-ONLY prior-art / requirements research goal that grounds a build.
function composeResearchGoal(buildGoal, opts = {}) {
  const groundingFile = opts.groundingFile || 'grounding.md';
  return [
    'You are doing PRODUCT-PLANNING RESEARCH ONLY. Do NOT build or modify the product or write code. Investigate, then write a grounding brief.',
    `Write your findings to ${groundingFile} (markdown), specific and concrete for the task below:`,
    '1. EXISTING SOLUTIONS / PRIOR ART: the real products, open-source tools, libraries and papers that already do this (names, links, how each works). Use web search/fetch.',
    '2. MUST-HAVE REQUIREMENTS: the capabilities any credible solution to this task MUST implement (derived from how the existing solutions work and what users expect).',
    '3. COMPETITOR LIMITATIONS + HOW TO OVERCOME: where the existing solutions fall short for THIS task, and a concrete plan to overcome those limits.',
    '4. RECOMMENDATION: reuse/adapt an existing solution (which one, why) or build new, plus the recommended approach/algorithm with rationale.',
    'Cite sources. Keep it actionable: the brief is handed to the builder as grounding.',
    '',
    '--- Task to ground ---',
    buildGoal,
  ].join('\n');
}

// Prepend a grounding brief to the build goal; return the goal unchanged when there is no brief.
function composeGoalWithGrounding(goal, briefText) {
  const brief = (typeof briefText === 'string' ? briefText : '').trim();
  if (!brief) return goal;
  return [
    'Grounding brief (prior-art survey, must-have requirements, competitor limitations + how to overcome). Build ON this; prefer reusing/adapting proven solutions over reinventing:',
    brief,
    '',
    '--- Build task ---',
    goal,
  ].join('\n');
}

// Read-only prior-art/requirements research delegation: produces a grounding brief under the moat.
// opts: runGovernedDelegation opts, plus { groundingFile?='grounding.md', researchTools? }
async function runGroundingResearch(opts) {
  if (!opts || !opts.goal) throw new Error('goal is required');
  if (!opts.overlayRoot) throw new Error('overlayRoot is required');
  const groundingFile = opts.groundingFile || 'grounding.md';
  const researchTools = opts.researchTools || ['Read', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'Bash'];
  const res = await runGovernedDelegation({
    ...opts,
    goal: composeResearchGoal(opts.goal, { groundingFile }),
    allowedFiles: [groundingFile],
    allowedTools: opts.allowedTools || researchTools,
  });
  let brief = '';
  try { brief = fs.readFileSync(path.join(opts.overlayRoot, groundingFile), 'utf8'); } catch (_) { /* none produced */ }
  return { ...res, brief, groundingFile };
}

// Default fan-out angles when parallel research is requested without explicit queries.
const DEFAULT_RESEARCH_QUERIES = [
  { label: 'Prior art', prompt: 'Survey the real products, open-source tools, libraries and papers that already do this — names, links, how each works.' },
  { label: 'Requirements', prompt: 'Derive the must-have capabilities any credible solution to this task MUST implement.' },
  { label: 'Pitfalls', prompt: 'Where existing solutions fall short for THIS task, the common failure modes, and how to overcome them.' },
];

// Parallel read-only research fan-out: run N research subagents CONCURRENTLY, each
// in its own overlay and tagged with a branch id so the live graph shows them as
// parallel branches (fork → branches → join). Read-only by design — writes are never
// parallelized (the context-merge failure mode). Returns { briefs, combinedBrief }.
// opts: { workspaceRoot, overlayRoot, runRoot, goal, agent, timeoutMs, onTraceEvent,
//         queries?, researchTools?, delegate? (injectable for tests) }
async function runParallelResearch(opts) {
  if (!opts || !opts.goal) throw new Error('goal is required');
  if (!opts.overlayRoot) throw new Error('overlayRoot is required');
  const delegate = opts.delegate || delegateToAgent;
  const queries = (Array.isArray(opts.queries) && opts.queries.length) ? opts.queries : DEFAULT_RESEARCH_QUERIES;
  const researchTools = opts.researchTools || ['Read', 'Write', 'WebSearch', 'WebFetch', 'Bash'];
  const onTraceEvent = opts.onTraceEvent || null;
  const runDir = opts.runRoot || path.join(path.resolve(opts.overlayRoot), '..', 'run');
  const branches = queries.map((q, i) => ({ id: `r${i + 1}`, label: q.label || `Research ${i + 1}` }));

  if (onTraceEvent) { try { onTraceEvent({ ev: 'fork', from: 'main', branches, at: nowIso() }); } catch (_) { /* best effort */ } }

  const runBranch = async (q, branch) => {
    const branchOverlay = `${opts.overlayRoot}-${branch.id}`;
    fs.rmSync(branchOverlay, { recursive: true, force: true });
    fs.mkdirSync(branchOverlay, { recursive: true });
    // Tag every event with this branch; swallow the subagent's run lifecycle (the
    // orchestrator owns the overall run-done, so a branch finishing must not flip it).
    const tag = onTraceEvent ? (ev) => {
      if (!ev || ev.ev === 'run') return;
      try { onTraceEvent({ ...ev, branch: ev.branch || branch.id }); } catch (_) { /* best effort */ }
    } : null;
    const groundingFile = `${branch.id}.md`;
    const res = await delegate({
      overlayRoot: branchOverlay,
      goal: composeResearchGoal(`${opts.goal}\n\nFocus this research specifically on: ${q.label}. ${q.prompt || ''}`, { groundingFile }),
      allowedTools: researchTools,
      agent: opts.agent,
      timeoutMs: opts.timeoutMs || 0,
      onTraceEvent: tag,
      runId: opts.runId,
    });
    let brief = '';
    try { brief = fs.readFileSync(path.join(branchOverlay, groundingFile), 'utf8'); } catch (_) { /* none produced */ }
    return { branch: branch.id, label: q.label, brief, stopped: !!res.stopped, costUsd: res.costUsd };
  };

  const briefs = await Promise.all(queries.map((q, i) => runBranch(q, branches[i])));

  if (onTraceEvent) { try { onTraceEvent({ ev: 'join', into: 'main', from: branches.map((b) => b.id), at: nowIso() }); } catch (_) { /* best effort */ } }

  const combinedBrief = briefs
    .filter((b) => (b.brief || '').trim())
    .map((b) => `## ${b.label}\n${b.brief.trim()}`)
    .join('\n\n');
  try {
    appendObserverTrace(runDir, {
      event: 'parallel_research', at: nowIso(),
      branches: briefs.map((b) => ({ branch: b.branch, label: b.label, hasBrief: !!(b.brief || '').trim(), stopped: b.stopped })),
    });
  } catch (_) { /* observer is best-effort */ }
  return { briefs, combinedBrief };
}

// Grounded governed delegation: research prior art FIRST, then build with the brief injected.
// opts: runGovernedDelegation opts, plus { ground?=true, groundingBrief?, researchOverlayRoot?,
//        researchRunRoot?, researchTimeoutMs?, researchTools? }
async function runGroundedDelegation(opts) {
  if (!opts || !opts.goal) throw new Error('goal is required');
  const ground = opts.ground !== false;
  let brief = (opts.groundingBrief || '').trim();
  let research = null;
  if (ground && !brief) {
    if (opts.parallelResearch) {
      // Fan-out: parallel read-only research subagents → combined brief.
      research = await runParallelResearch({
        ...opts,
        queries: opts.researchQueries,
        timeoutMs: opts.researchTimeoutMs || opts.timeoutMs || 0,
      });
      brief = (research.combinedBrief || '').trim();
    } else {
      research = await runGroundingResearch({
        ...opts,
        overlayRoot: opts.researchOverlayRoot || `${opts.overlayRoot}-research`,
        runRoot: opts.researchRunRoot || (opts.runRoot ? `${opts.runRoot}-research` : undefined),
        timeoutMs: opts.researchTimeoutMs || opts.timeoutMs || 0,
      });
      brief = (research.brief || '').trim();
    }
  }
  if (isRunCancelled(opts.runId)) {
    return { research, brief, build: { stopped: true, stopReason: 'cancelled', patch: { changes: [], violations: [] }, summary: { stopped: true, stopReason: 'cancelled' } }, summary: { stopped: true, stopReason: 'cancelled' } };
  }
  const build = await runGovernedDelegation({
    ...opts,
    goal: composeGoalWithGrounding(opts.goal, brief),
  });
  return { research, brief, build, summary: build.summary };
}

// --- Verification gates (the TRUST boundary) -----------------------------------
// Deterministic, EXTERNAL checks run against the agent's overlay output BEFORE it
// is allowed to touch the canonical workspace. External verification is the only
// signal that reliably improves agent output (a model grading itself does not);
// here it serves the stronger purpose of a TRUST gate: nothing unverified ships.
// Gate kinds:
//   { kind:'command', id?, cmd, expectExit?=0 } -> run cmd in overlay; pass iff exit===expectExit
//   { kind:'file-exists', id?, path }           -> pass iff overlay/path exists
//   { kind:'file-absent',  id?, path }          -> pass iff overlay/path missing
// Returns { passed, results:[{id,kind,passed,detail}] }. No network of its own;
// each command is bounded by perGateTimeoutMs and run with the overlay as cwd.
function runVerificationGates(overlayRoot, gates, opts = {}) {
  const perGateTimeoutMs = opts.perGateTimeoutMs || 120000;
  const results = [];
  for (const g of (Array.isArray(gates) ? gates : [])) {
    if (!g || typeof g !== 'object') continue;
    const id = String(g.id || g.cmd || g.path || g.kind || 'gate');
    let passed = false;
    let detail = '';
    try {
      if (g.kind === 'command' && g.cmd) {
        const expect = Number.isInteger(g.expectExit) ? g.expectExit : 0;
        const r = spawnSync(String(g.cmd), { cwd: overlayRoot, shell: true, timeout: perGateTimeoutMs, encoding: 'utf8' });
        const code = r.status;
        passed = code === expect && !r.error;
        const tail = String(r.stderr || r.stdout || '').trim().slice(-400);
        detail = `exit=${code === null ? 'null' : code}${r.error ? ` err=${r.error.message}` : ''}${passed ? '' : (tail ? ` :: ${tail}` : '')}`;
      } else if (g.kind === 'file-exists' && g.path) {
        passed = fs.existsSync(path.join(overlayRoot, String(g.path)));
        detail = passed ? 'present' : 'missing';
      } else if (g.kind === 'file-absent' && g.path) {
        passed = !fs.existsSync(path.join(overlayRoot, String(g.path)));
        detail = passed ? 'absent' : 'present';
      } else {
        detail = 'unknown-gate-kind';
      }
    } catch (e) {
      detail = `gate-error: ${(e && e.message) || e}`;
    }
    results.push({ id, kind: g.kind, passed, detail });
  }
  // Vacuously true for an empty gate set; callers decide whether to run gates at all.
  const passed = results.every((r) => r.passed);
  return { passed, results };
}

// build -> verify -> (retry-with-failure-feedback) loop. Pure orchestration: the
// build is `buildFn(feedback|null)` (null on the first attempt), verification is
// `verifyFn()` (returns {passed,results}). On failure with cycles remaining the
// failing gate details are handed back to buildFn so the agent fixes its own work.
// Injectable fns make this unit-testable with no live agent. Returns
// { build, gate, met, cycles }.
async function runVerifiedBuildLoop({ buildFn, verifyFn, maxCycles = 0 }) {
  if (typeof buildFn !== 'function' || typeof verifyFn !== 'function') {
    throw new Error('runVerifiedBuildLoop requires buildFn and verifyFn');
  }
  let cycle = 0;
  let build = await buildFn(null);
  let gate = verifyFn();
  while (!gate.passed && cycle < maxCycles && !(build && build.stopped)) {
    cycle += 1;
    const failures = gate.results.filter((r) => !r.passed)
      .map((r) => `- [${r.id}] ${r.detail}`).join('\n');
    const feedback = `The previous attempt FAILED these verification checks:\n${failures}\nFix them. Do not change unrelated behavior.`;
    build = await buildFn(feedback);
    gate = verifyFn();
  }
  return { build, gate, met: gate.passed, cycles: cycle };
}

module.exports = {
  recon,
  delegateToAgent,
  providerInfo,
  killTree,
  cancelRun,
  cancelAllRuns,
  clearCancelled,
  isRunCancelled,
  runGovernedDelegation,
  loadGuidanceCatalog,
  composeGoalWithGuidance,
  composeResearchGoal,
  composeGoalWithGrounding,
  runGroundingResearch,
  runParallelResearch,
  DEFAULT_RESEARCH_QUERIES,
  runGroundedDelegation,
  runVerificationGates,
  runVerifiedBuildLoop,
  // The soft-node guidance catalog is no longer empty: it is grown from observed gaps and
  // promoted into guidance-catalog.json, then injected into every governed delegation.
  guidanceCatalog: loadGuidanceCatalog(),
  capabilityMapNote: 'phase1: capability map is a manual list (capability-map.json); nodes only for off-map cross-cutting concerns.',
};
