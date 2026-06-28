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
const vault = require('./vault.cjs');

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
    buildArgs: ({ allowedTools, streamMode, resumeSessionId }) => {
      // Session persistence is ENABLED (no --no-session-persistence) so a run can be CONTINUED
      // conversationally via --resume <sessionId> (the session_id is captured from the stream).
      const a = ['-p', '--output-format', streamMode ? 'stream-json' : 'json',
        ...(streamMode ? ['--verbose'] : []), '--permission-mode', 'default'];
      if (resumeSessionId) a.push('--resume', String(resumeSessionId));
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
function commandAvailable(command) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try { return spawnSync(probe, [command], { shell: false, windowsHide: true }).status === 0; }
  catch (_) { return false; }
}
function providerInfo(name) {
  const key = String(name || 'claude').toLowerCase();
  const provider = getProvider(key);
  return { provider: key in PROVIDERS ? key : 'claude', command: provider.command, available: commandAvailable(provider.command) };
}

// Delegate the whole goal to a capable CLI agent, running INSIDE the isolated overlay.
// Prompt goes via stdin (not argv) so multi-word goals are not mangled by the Windows shell.
// timeoutMs > 0 enables the motion stop-signal: the agent + its whole tree are killed on cap.
// Returns a Promise of the run result (stopped:true when the cap fired).
function delegateToAgent({ overlayRoot, goal, allowedTools, agent = 'claude', timeoutMs = 0, traceFile = null, onTraceEvent = null, runId = null, resumeSessionId = null }) {
  return new Promise((resolve) => {
    const provider = getProvider(agent);
    const streamMode = !!provider.stream && !!(traceFile || onTraceEvent);
    const args = provider.buildArgs({ allowedTools, streamMode, resumeSessionId });
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
    let sessionId = null; // captured from the stream so this run can be CONTINUED conversationally (--resume)
    const handleStreamLine = (line) => {
      const s = String(line).trim();
      if (!s) return;
      let obj = null;
      try { obj = JSON.parse(s); } catch (_) { obj = s; }
      if (obj && typeof obj === 'object' && obj.session_id && !sessionId) sessionId = obj.session_id;
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
        sessionId: sessionId || (parsed && parsed.session_id) || null,
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
  const agentRun = await delegateToAgent({ overlayRoot, goal: effectiveGoal, allowedTools: effectiveAllowedTools, agent, timeoutMs, traceFile, onTraceEvent, runId: opts.runId, resumeSessionId: opts.resumeSessionId });
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

// --- Vault-grounded delegation (knowledge vault: read -> research+capture -> build) ------------------
// Mirrors runGroundedDelegation but sources grounding from the durable knowledge vault and (when ground
// is on) runs a research step that ALSO writes notes back into a vault overlay. Returns the IDENTICAL
// { research, brief, build, summary } shape — plus `vault:{overlayRoot,patch}` for the caller (ipc) to
// persist through the transactional moat — so the result-unwrap downstream is unchanged. The vault read
// is a defensive no-op on a missing/empty vault: a cold start degrades to plain web grounding, never blocked.
async function runVaultGroundedDelegation(opts) {
  if (!opts || !opts.goal) throw new Error('goal is required');
  if (!opts.overlayRoot) throw new Error('overlayRoot is required');
  if (!opts.workspaceRoot) throw new Error('workspaceRoot is required');
  const onTraceEvent = opts.onTraceEvent || null;
  const emit = (ev) => { if (onTraceEvent) { try { onTraceEvent(ev); } catch (_) { /* best effort */ } } };
  const runDir = opts.runRoot || path.join(path.resolve(opts.overlayRoot), '..', 'run');

  // 1. vault_read — load durable knowledge (missing/empty/malformed -> no notes, no throw).
  emit({ ev: 'phase', kind: 'vault_read', state: 'start', at: nowIso() });
  const index = vault.loadVaultIndex(opts.workspaceRoot);
  const vaultBrief = vault.composeVaultBrief(index);
  appendObserverTrace(runDir, { event: 'vault_read', at: nowIso(), noteCount: index.notes.length, hasBrief: !!vaultBrief });
  emit({ ev: 'phase', kind: 'vault_read', state: 'done', at: nowIso() });

  // 2. gap-research that also writes notes into the vault overlay (write-set = the vault dir). Reuses the
  //    governed-delegation envelope; its collected patch IS the vault write-back the caller persists.
  let research = null;
  let researchBrief = '';
  let vaultWrite = null; // { overlayRoot, patch }
  if (opts.ground !== false && !isRunCancelled(opts.runId)) {
    emit({ ev: 'phase', kind: 'vault_writeback', state: 'start', at: nowIso() });
    const researchOverlay = opts.researchOverlayRoot || `${opts.overlayRoot}-vault`;
    const researchRun = opts.researchRunRoot || (opts.runRoot ? `${opts.runRoot}-vault` : undefined);
    research = await runGovernedDelegation({
      ...opts,
      overlayRoot: researchOverlay,
      runRoot: researchRun,
      goal: vault.composeVaultResearchGoal(opts.goal, { vaultBrief, earnedFrom: opts.earnedFrom }),
      allowedFiles: [vault.VAULT_REL],
      readOnlyFiles: opts.readOnlyFiles || [],
      allowedTools: opts.researchTools || ['Read', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'Bash', 'Grep', 'Glob'],
      timeoutMs: opts.researchTimeoutMs || opts.timeoutMs || 0,
      injectGuidance: false, // research is grounded by the vault brief, not the build's standing guidance
    });
    vaultWrite = { overlayRoot: researchOverlay, patch: research.patch };
    researchBrief = vault.readVaultNotesFromPatch(research.patch);
    emit({ ev: 'phase', kind: 'vault_writeback', state: 'done', at: nowIso() });
  }

  // cancellation between research and build (mirror runGroundedDelegation).
  if (isRunCancelled(opts.runId)) {
    return {
      research, brief: '', vault: vaultWrite,
      build: { stopped: true, stopReason: 'cancelled', patch: { changes: [], violations: [] }, summary: { stopped: true, stopReason: 'cancelled' } },
      summary: { stopped: true, stopReason: 'cancelled' },
    };
  }

  // 3. build with the vault knowledge + fresh research injected; uses the caller's real write-set.
  const combinedBrief = [vaultBrief, researchBrief].filter(s => String(s || '').trim()).join('\n\n');
  const build = await runGovernedDelegation({
    ...opts,
    goal: composeGoalWithGrounding(opts.goal, combinedBrief),
  });
  return { research, brief: combinedBrief, vault: vaultWrite, build, summary: build.summary };
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
    const id = String(g.id || g.cmd || (Array.isArray(g.argv) ? g.argv.join(' ') : '') || g.path || g.kind || 'gate');
    let passed = false;
    let detail = '';
    try {
      if (g.kind === 'command' && (g.cmd || Array.isArray(g.argv))) {
        const expect = Number.isInteger(g.expectExit) ? g.expectExit : 0;
        // argv form (shell:false) for INTERNALLY-generated gates whose tokens may include an agent-chosen
        // file path — a shell string built from that path is command injection at the trust boundary. The
        // g.cmd form (user-supplied shell command, e.g. "npm test") stays shell:true.
        const r = Array.isArray(g.argv)
          ? spawnSync(String(g.argv[0]), g.argv.slice(1).map(String), { cwd: overlayRoot, shell: false, timeout: perGateTimeoutMs, encoding: 'utf8', windowsHide: true })
          : spawnSync(String(g.cmd), { cwd: overlayRoot, shell: true, timeout: perGateTimeoutMs, encoding: 'utf8' });
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
  // A grounded/vault runner returns a wrapper { ..., build, summary } whose stop flag lives at
  // build.build.stopped; a plain governed result has it at build.stopped. Unwrap so a stopped/cancelled
  // attempt is never wrongly retried (mirrors the ipc result-unwrap at build = result.build || result).
  const isStopped = (b) => { const x = b && (b.build || b); return !!(x && x.stopped); };
  // Promotion criterion: the DETERMINISTIC verdict (detPassed) when present, else gate.passed.
  const promoted = (g) => (g && g.detPassed !== undefined) ? !!g.detPassed : !!(g && g.passed);
  let cycle = 0;
  let build = await buildFn(null);
  let gate = await verifyFn(build);
  let best = promoted(gate) ? { build, gate } : null; // best-so-far: a promotable attempt is never lost
  while (!gate.passed && cycle < maxCycles && !isStopped(build)) {
    cycle += 1;
    const failures = gate.results.filter((r) => !r.passed)
      .map((r) => `- [${r.id}] ${r.detail}`).join('\n');
    const feedback = `The previous attempt FAILED these verification checks:\n${failures}\nFix them. Do not change unrelated behavior.`;
    build = await buildFn(feedback);
    gate = await verifyFn(build);
    if (promoted(gate)) best = { build, gate };
  }
  // If the final attempt regressed below a previously-promotable one (e.g. a critic-driven retry broke a
  // deterministically-passing build), return the BEST — never discard already-shippable output.
  if (!promoted(gate) && best) { build = best.build; gate = best.gate; }
  // NB: a promotion decision should key off promoted(gate) / gate.detPassed (when present), NOT `met` —
  // with best-so-far, the returned gate can be a det-passing build whose `passed` is false (critic flagged).
  return { build, gate, met: gate.passed, cycles: cycle };
}

// --- Default verification layer: smoke gates + adversarial critic (the minimum QA orchestration) -----
// Benchmark-informed (Nous Hermes): the durable, model-advancement-proof parts are an EXTERNAL
// deterministic gate at the trust boundary + a SEPARATE critic role + bounded feedback retry. OrPAD already
// owns the gate engine (runVerificationGates) and the loop (runVerifiedBuildLoop); this adds the DEFAULT,
// auto-derived layer so a non-dev user gets verification without writing any gates.

// Cheap, dependency-free smoke gates derived from the build's changed files — language-aware STATIC checks
// (NO install/build) that catch broken output (syntax errors) without an environment. Capped to bound cost.
// These run via runVerificationGates in the overlay and are the DETERMINISTIC source of truth for promotion.
let _smokeToolCache = null;
function defaultToolAvailability() {
  if (!_smokeToolCache) {
    _smokeToolCache = { node: commandAvailable('node'), python: commandAvailable('python'), python3: commandAvailable('python3') };
  }
  return _smokeToolCache;
}
function buildSmokeGates(patch, opts = {}) {
  const cap = Number.isInteger(opts.cap) ? opts.cap : 60;
  // Only emit a gate for a toolchain that actually resolves on PATH — a MISSING interpreter must degrade to
  // "unverified for those files", never a permanent gate failure that discards correct output every retry.
  const has = opts.has || defaultToolAvailability();
  const pythonCmd = has.python ? 'python' : (has.python3 ? 'python3' : null);
  const changes = (patch && Array.isArray(patch.changes) ? patch.changes : [])
    .filter((c) => c && c.afterExists !== false && typeof c.path === 'string');
  const gates = [];
  for (const c of changes) {
    if (gates.length >= cap) break;
    const p = c.path;
    if (p.split('/').includes('..') || /^([a-zA-Z]:)?[\\/]/.test(p)) continue; // no traversal / absolute paths
    // argv form -> spawnSync shell:false, so an agent-chosen filename can never be shell-injected.
    if (/\.(c|m)?js$/i.test(p) && has.node) gates.push({ kind: 'command', id: `syntax:${p}`, argv: ['node', '--check', p] });
    else if (/\.py$/i.test(p) && pythonCmd) gates.push({ kind: 'command', id: `pysyntax:${p}`, argv: [pythonCmd, '-m', 'py_compile', p] });
  }
  return gates;
}

// Parse a critic verdict from an LLM's final text: the last ```json fenced block, else the last {...}.
// Defensive — any failure yields a non-blocking pass (the critic must never hard-block promotion).
function parseCriticVerdict(text) {
  const s = String(text || '');
  let jsonStr = null;
  const fences = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  if (fences.length) jsonStr = fences[fences.length - 1][1];
  else { const m = s.match(/\{[\s\S]*\}/); if (m) jsonStr = m[0]; }
  if (!jsonStr) return { passed: true, blockers: [], notes: [] };
  try {
    const v = JSON.parse(jsonStr);
    const blockers = Array.isArray(v.blockers) ? v.blockers.map(String).map((x) => x.trim()).filter(Boolean) : [];
    const passed = v.passed === false ? false : blockers.length === 0;
    return { passed, blockers, notes: Array.isArray(v.notes) ? v.notes.map(String) : [] };
  } catch (_) { return { passed: true, blockers: [], notes: [] }; }
}

function composeCriticGoal(buildGoal) {
  return [
    'You are an INDEPENDENT QA CRITIC. Do NOT modify, build, or run anything — review only (Read/Grep/Glob).',
    'Adversarially review the code in this directory against the TASK below. Catch things that pass a syntax',
    'check but mean the result DOES NOT ACTUALLY WORK for a real user, especially:',
    '- runtime-assumption failures: an API/library used in a target where it does not work (e.g. a browser-only',
    '  API like webkitSpeechRecognition used inside Electron; OS/platform mismatches);',
    '- features claimed (README/UI/docs) with no real implementation behind them (stubs/TODOs shipped as "done");',
    '- missing wiring between components (an event/handler/route never connected), broken entry points;',
    '- correctness or security holes that would make the stated goal fail in practice;',
    '- DELIVERABLE NOT PRODUCED: the TASK promises a built/packaged/deployable/distributable artifact (an',
    '  installer, a compiled binary, a published build) but only buildable SOURCE + instructions exist — no',
    '  actual artifact (e.g. a dist/ or release/ output) was produced. "Buildable" is not "built": check for',
    '  the real artifact with Glob/Read before accepting that the goal is met;',
    '- OVERCLAIM: the project README/docs/comments CLAIM something is done/built/working/distributable that is',
    '  NOT actually true — e.g. a README says "built as a distributable app" but no installer/release artifact',
    '  exists, or a claimed feature is only a stub. An overclaim that hides an unmet goal is a blocker.',
    'Be concrete and skeptical; name specific blockers rather than vague worry. Judge against what the TASK',
    'actually promised, not perfection.',
    '',
    'End your reply with ONLY a JSON block and no prose after it:',
    '```json',
    '{"passed": true, "blockers": ["a concrete blocker that breaks the goal"], "notes": ["minor issue"]}',
    '```',
    'Set passed=false iff there is at least one blocker that would make the goal not actually work for a user.',
    '',
    '--- TASK ---',
    buildGoal,
  ].join('\n');
}

// Adversarial critic as a SEPARATE read-only delegation over the build overlay. ADVISORY: returns
// { passed, findings[] }. The caller gates PROMOTION on the deterministic gates and uses the critic only to
// drive retry feedback + surface unresolved concerns — a model grading itself must never authorize shipping.
// Injectable `delegate` for tests. Any failure / stop yields a non-blocking pass.
async function runCritic(opts) {
  const { overlayRoot, goal, agent, timeoutMs = 0, onTraceEvent = null, runId = null, delegate = delegateToAgent } = opts || {};
  if (!overlayRoot || !goal) return { passed: true, findings: [] };
  let res;
  try {
    res = await delegate({
      overlayRoot,
      goal: composeCriticGoal(goal),
      allowedTools: ['Read', 'Grep', 'Glob'],
      agent,
      timeoutMs,
      onTraceEvent,
      runId,
    });
  } catch (_) { return { passed: true, findings: [] }; }
  if (!res || res.stopped || res.isError) return { passed: true, findings: [] };
  const v = parseCriticVerdict(res.result);
  return { passed: v.passed, findings: v.blockers, notes: v.notes };
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
  runVaultGroundedDelegation,
  // Knowledge vault (durable, workspace-contained domain knowledge; see vault.cjs + the spec).
  loadVaultIndex: vault.loadVaultIndex,
  composeVaultBrief: vault.composeVaultBrief,
  composeVaultResearchGoal: vault.composeVaultResearchGoal,
  promoteVaultPatch: vault.promoteVaultPatch,
  rebuildVaultIndex: vault.rebuildVaultIndex,
  VAULT_REL: vault.VAULT_REL,
  runVerificationGates,
  runVerifiedBuildLoop,
  buildSmokeGates,
  commandAvailable,
  runCritic,
  parseCriticVerdict,
  // The soft-node guidance catalog is no longer empty: it is grown from observed gaps and
  // promoted into guidance-catalog.json, then injected into every governed delegation.
  guidanceCatalog: loadGuidanceCatalog(),
  capabilityMapNote: 'phase1: capability map is a manual list (capability-map.json); nodes only for off-map cross-cutting concerns.',
};
