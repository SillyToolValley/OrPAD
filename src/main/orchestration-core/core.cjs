'use strict';
// OrPAD orchestration-core v0 — zero-node governed delegation (strangler; additive).
// Reuses the preserved isolation moat (patches.js overlay + write-set + patchArtifact).
// Philosophy: orchestrate as little as possible. v0 has NO nodes: it grounds (recon),
// delegates the whole chunk to a capable coding agent in an isolated overlay, then
// enforces the write-set by diffing overlay->canonical (changes + out-of-set violations).
// The guidance/soft-node catalog starts EMPTY and is grown later by the ralphloop.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
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

// Delegate the whole goal to a capable CLI agent, running INSIDE the isolated overlay.
// Default agent = Claude Code (`claude -p ... --output-format json`). The agent runs its
// own inner loop; we do not micro-manage it (soft core). Returns stdout + parsed usage/cost.
function delegateToAgent({ overlayRoot, goal, allowedTools, agent = 'claude' }) {
  // Prompt is passed via stdin (not argv) so multi-word goals are not mangled by the
  // Windows shell (shell:true concatenates argv). `claude -p` reads the prompt from stdin.
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
  const res = spawnSync(agent, args, {
    cwd: overlayRoot,
    input: goal,
    encoding: 'utf8',
    shell: true, // Windows: claude is a .cmd shim
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - t0;
  let parsed = null;
  try { parsed = JSON.parse(res.stdout || ''); } catch (_) { /* non-json */ }
  return {
    exitCode: res.status,
    durationMs,
    raw: res.stdout,
    stderr: res.stderr,
    result: parsed ? parsed.result : null,
    isError: parsed ? !!parsed.is_error : null,
    apiErrorStatus: parsed ? parsed.api_error_status : null,
    costUsd: parsed ? parsed.total_cost_usd : null,
    usage: parsed ? parsed.usage : null,
    numTurns: parsed ? parsed.num_turns : null,
    permissionDenials: parsed ? parsed.permission_denials : null,
  };
}

function appendObserverTrace(runRoot, record) {
  fs.mkdirSync(runRoot, { recursive: true });
  fs.appendFileSync(path.join(runRoot, 'observer.jsonl'), JSON.stringify(record) + '\n', 'utf8');
}

// Zero-node governed delegation run.
// opts: { workspaceRoot, overlayRoot, runRoot?, allowedFiles, readOnlyFiles?, goal, allowedTools?, agent? }
async function runGovernedDelegation(opts) {
  const {
    workspaceRoot, overlayRoot, runRoot,
    allowedFiles = [], readOnlyFiles = [],
    goal, allowedTools, agent,
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
  appendObserverTrace(runDir, { event: 'overlay_seeded', at: nowIso(), seeded, allowedFiles, readOnlyFiles });

  // 3. delegate the whole chunk to the agent (its own inner loop), inside the overlay
  const agentRun = delegateToAgent({ overlayRoot, goal, allowedTools, agent });
  appendObserverTrace(runDir, {
    event: 'agent_run', at: nowIso(),
    exitCode: agentRun.exitCode, durationMs: agentRun.durationMs,
    isError: agentRun.isError, apiErrorStatus: agentRun.apiErrorStatus,
    costUsd: agentRun.costUsd, usage: agentRun.usage, numTurns: agentRun.numTurns,
    resultPreview: (agentRun.result || '').slice(0, 200),
  });

  // 4. isolation enforcement moat: diff overlay->canonical => patchArtifact (changes + violations)
  const patch = await collectOverlayPatch({ workspaceRoot, overlayRoot, allowedFiles });
  appendObserverTrace(runDir, {
    event: 'patch_collected', at: nowIso(),
    schemaVersion: patch.schemaVersion,
    changes: patch.changes.map(c => c.path),
    violations: patch.violations,
  });

  return {
    recon: reconResult,
    seeded,
    agentRun,
    patch,
    summary: {
      durationMs: agentRun.durationMs,
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
  runGovernedDelegation,
  // v0: guidance/soft-node catalog is intentionally EMPTY; grown by the ralphloop.
  guidanceCatalog: [],
  capabilityMapNote: 'phase1: capability map is a manual list (capability-map.json); nodes only for off-map cross-cutting concerns.',
};
