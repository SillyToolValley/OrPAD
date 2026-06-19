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

function nowIso() { return new Date().toISOString(); }

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

// Delegate the whole goal to a capable CLI agent, running INSIDE the isolated overlay.
// Prompt goes via stdin (not argv) so multi-word goals are not mangled by the Windows shell.
// timeoutMs > 0 enables the motion stop-signal: the agent + its whole tree are killed on cap.
// Returns a Promise of the run result (stopped:true when the cap fired).
function delegateToAgent({ overlayRoot, goal, allowedTools, agent = 'claude', timeoutMs = 0 }) {
  return new Promise((resolve) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--no-session-persistence',
      '--permission-mode', 'default',
    ];
    if (Array.isArray(allowedTools) && allowedTools.length) {
      args.push('--allowedTools', ...allowedTools);
    }
    const t0 = Date.now();
    const child = spawn(agent, args, {
      cwd: overlayRoot,
      shell: true, // Windows: claude is a .cmd shim
    });
    let out = '';
    let err = '';
    let stopped = false;
    let stopReason = null;
    child.stdout.on('data', d => { out += d.toString(); });
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
      const durationMs = Date.now() - t0;
      let parsed = null;
      try { parsed = JSON.parse(out || ''); } catch (_) { /* partial/non-json on stop */ }
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
  } = opts;
  if (!workspaceRoot) throw new Error('workspaceRoot is required');
  if (!overlayRoot) throw new Error('overlayRoot is required');
  if (!goal) throw new Error('goal is required');
  const runDir = runRoot || path.join(path.resolve(overlayRoot), '..', 'run');

  // 1. recon (grounding)
  const reconResult = recon(workspaceRoot);
  appendObserverTrace(runDir, { event: 'recon', at: nowIso(), recon: reconResult });

  // 2. isolation moat: seed overlay with ONLY the write-set + read-only context
  fs.rmSync(overlayRoot, { recursive: true, force: true });
  fs.mkdirSync(overlayRoot, { recursive: true });
  const seeded = await copyAllowedFilesToOverlay({ workspaceRoot, overlayRoot, allowedFiles, readOnlyFiles });
  appendObserverTrace(runDir, { event: 'overlay_seeded', at: nowIso(), seeded, allowedFiles, readOnlyFiles, timeoutMs });

  // 2.5 inject OrPAD's standing guidance catalog (the grown soft-core guidance) into the goal.
  const catalog = injectGuidance
    ? (Array.isArray(guidanceCatalogOpt) ? guidanceCatalogOpt : loadGuidanceCatalog(guidanceCatalogPath))
    : [];
  const effectiveGoal = composeGoalWithGuidance(goal, catalog);
  appendObserverTrace(runDir, {
    event: 'guidance_injected', at: nowIso(),
    injected: catalog.map(g => g.id || (g.guidance || '').slice(0, 40)),
  });

  // 3. delegate the whole chunk to the agent (its own inner loop), inside the overlay,
  //    under the motion stop-signal (timeoutMs cap).
  const agentRun = await delegateToAgent({ overlayRoot, goal: effectiveGoal, allowedTools, agent, timeoutMs });
  appendObserverTrace(runDir, {
    event: 'agent_run', at: nowIso(),
    exitCode: agentRun.exitCode, durationMs: agentRun.durationMs,
    stopped: agentRun.stopped, stopReason: agentRun.stopReason,
    isError: agentRun.isError, apiErrorStatus: agentRun.apiErrorStatus,
    costUsd: agentRun.costUsd, usage: agentRun.usage, numTurns: agentRun.numTurns,
    resultPreview: (agentRun.result || '').slice(0, 200),
  });

  // 4. isolation enforcement moat: diff overlay->canonical => patchArtifact (changes + violations).
  //    Runs EVEN WHEN STOPPED so partial work is recovered, not lost.
  const patch = await collectOverlayPatch({ workspaceRoot, overlayRoot, allowedFiles });
  appendObserverTrace(runDir, {
    event: 'patch_collected', at: nowIso(),
    stopped: agentRun.stopped,
    schemaVersion: patch.schemaVersion,
    changes: patch.changes.map(c => c.path),
    violations: patch.violations,
  });

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

module.exports = {
  recon,
  delegateToAgent,
  killTree,
  runGovernedDelegation,
  loadGuidanceCatalog,
  composeGoalWithGuidance,
  // The soft-node guidance catalog is no longer empty: it is grown from observed gaps and
  // promoted into guidance-catalog.json, then injected into every governed delegation.
  guidanceCatalog: loadGuidanceCatalog(),
  capabilityMapNote: 'phase1: capability map is a manual list (capability-map.json); nodes only for off-map cross-cutting concerns.',
};
