'use strict';
// OrPAD orchestration-core IPC — bridges the zero-node governed-delegation core
// to the live-trace emergent-graph GUI. Two handlers:
//   orpad-core-run-start  — run a REAL governed delegation, forwarding each
//                            emergent-graph trace event to the renderer live.
//   orpad-core-run-replay — replay a RECORDED trace.jsonl through the same
//                            channel (no paid live agent; used by dev + CI e2e).
// Both stream events on the 'orpad-core-trace' channel; the renderer accumulates
// them and (re)builds the emergent graph (see trace.cjs buildEmergentGraph).

const path = require('path');
const fsp = require('fs/promises');
const core = require('./core.cjs');

const TRACE_CHANNEL = 'orpad-core-trace';

function nowIso() { return new Date().toISOString(); }

function newRunId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Copy the agent's overlay output into the canonical workspace. Without this the
// governed delegation only COLLECTS a patch and the result stays trapped in the
// run overlay (the observed "my repo didn't change" / output-buried-in-.orpad
// problem). Each target is contained to the workspace (no path escape).
async function applyOverlayToWorkspace(workspaceRoot, overlayRoot, relPaths) {
  const root = path.resolve(workspaceRoot);
  const applied = [];
  for (const rel of relPaths) {
    const norm = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!norm || norm.split('/').includes('..')) continue;
    const dest = path.resolve(root, norm);
    const relCheck = path.relative(root, dest);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) continue;
    try {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(path.resolve(overlayRoot, norm), dest);
      applied.push(norm);
    } catch (_) { /* skip files that vanished/unreadable */ }
  }
  return applied.sort();
}

function registerCoreRunHandlers({ ipcMain, app, authority }) {
  void app; // reserved for parity with the other handler registrars

  const sender = (event, runId) => (ev) => {
    if (event.sender.isDestroyed()) return;
    event.sender.send(TRACE_CHANNEL, { runId, ...ev });
  };

  // --- Live governed-delegation run ------------------------------------------
  ipcMain.handle('orpad-core-run-start', async (event, request = {}) => {
    const workspaceRoot = authority.getWorkspaceRoot(event.sender);
    if (!workspaceRoot) return { ok: false, error: 'Open a project folder before starting a run.' };

    const goal = String(request?.goal || '').trim();
    if (!goal) return { ok: false, error: 'A goal is required.' };

    const allowedFiles = Array.isArray(request?.allowedFiles) ? request.allowedFiles.map(String) : [];
    const readOnlyFiles = Array.isArray(request?.readOnlyFiles) ? request.readOnlyFiles.map(String) : [];
    const allowedTools = Array.isArray(request?.allowedTools) ? request.allowedTools.map(String) : undefined;
    const timeoutMs = Number.isFinite(request?.timeoutMs) ? Math.max(0, request.timeoutMs) : 0;
    const agent = request?.agent ? String(request.agent) : undefined;
    const ground = request?.ground !== false;     // default ON: research prior art first
    const apply = request?.apply !== false;       // default ON: write the result into the workspace
    const parallelResearch = request?.parallelResearch === true; // fan-out: parallel research subagents
    const researchQueries = Array.isArray(request?.researchQueries) ? request.researchQueries : undefined;
    const greenfield = allowedFiles.length === 0; // no write-set -> unconstrained build, apply everything

    // Verification gates (the TRUST boundary): deterministic checks run against the
    // overlay before anything is applied. `gates` are explicit gate objects;
    // `verifyCommands` is a convenience (shell strings -> command gates).
    const rawGates = Array.isArray(request?.gates) ? request.gates : [];
    const cmdGates = Array.isArray(request?.verifyCommands)
      ? request.verifyCommands.map(String).map((s) => s.trim()).filter(Boolean).map((cmd) => ({ kind: 'command', cmd }))
      : [];
    const gates = [...rawGates.filter((g) => g && typeof g === 'object' && g.kind), ...cmdGates];
    const gated = gates.length > 0;
    const maxVerifyCycles = Number.isInteger(request?.verifyCycles) ? Math.max(0, Math.min(5, request.verifyCycles)) : 0;

    const runId = newRunId('core');
    const runBase = path.join(workspaceRoot, '.orpad', 'core-runs', runId);
    const overlayRoot = path.join(runBase, 'overlay');
    const runRoot = path.join(runBase, 'run');

    const send = sender(event, runId);
    send({ ev: 'run', state: 'start', at: nowIso() });
    try {
      const baseOpts = {
        workspaceRoot, overlayRoot, runRoot,
        allowedFiles, readOnlyFiles, goal, allowedTools, agent, timeoutMs,
        parallelResearch, researchQueries,
        streamTrace: true,
        onTraceEvent: send,
      };
      const runner = ground ? core.runGroundedDelegation : core.runGovernedDelegation;

      let result;
      let gate = { passed: true, results: [] };
      let verifyCycles = 0;
      if (gated) {
        // Trust gate: build -> verify deterministic gates against the overlay; on
        // failure, re-delegate REUSING the overlay (seedOverlay:false) with the
        // failure logs injected, up to maxVerifyCycles times.
        const tracedVerify = () => {
          send({ ev: 'phase', kind: 'verify', state: 'start', at: nowIso() });
          const g = core.runVerificationGates(overlayRoot, gates);
          send({ ev: 'phase', kind: 'verify', state: 'done', at: nowIso() });
          return g;
        };
        let firstDone = false;
        const buildFn = async (feedback) => {
          if (!firstDone) { firstDone = true; return await runner(baseOpts); }
          return await core.runGovernedDelegation({ ...baseOpts, goal: `${goal}\n\n${feedback}`, seedOverlay: false });
        };
        const loop = await core.runVerifiedBuildLoop({ buildFn, verifyFn: tracedVerify, maxCycles: maxVerifyCycles });
        result = loop.build;
        gate = loop.gate;
        verifyCycles = loop.cycles;
      } else {
        result = await runner(baseOpts);
      }

      // grounded delegation returns { research, brief, build, summary }; plain
      // delegation returns the run result directly.
      const build = result.build || result;
      const patch = build.patch || { changes: [], violations: [] };
      const summary = result.summary || build.summary || {};
      const met = gated ? gate.passed : null; // null = ungated (applied unverified)
      send({ ev: 'run', state: 'done', at: nowIso() });

      // Trust boundary: apply the agent's overlay output into the canonical
      // workspace ONLY when not blocked. Gated-and-failed (met===false) is NEVER
      // applied — the whole point is that nothing unverified reaches the repo.
      // Ungated (met===null) applies as before (unverified). Greenfield applies
      // everything the agent produced; constrained applies only in-write-set changes.
      let applied = [];
      const applyEligible = apply && !build.stopped && met !== false;
      if (applyEligible) {
        const applySet = greenfield
          ? [...patch.changes.map((c) => c.path), ...patch.violations.map((v) => v.path)]
          : patch.changes.map((c) => c.path);
        applied = await applyOverlayToWorkspace(workspaceRoot, overlayRoot, applySet);
      }

      return {
        ok: true,
        runId,
        ...summary,
        grounded: ground,
        groundingBrief: !!(result.brief && String(result.brief).trim()),
        greenfield,
        gated,
        met,
        verifyCycles,
        gates: gate.results,
        applied,
        appliedCount: applied.length,
        changes: patch.changes.map((c) => c.path),
        violations: patch.violations,
      };
    } catch (err) {
      const message = String(err?.message || err);
      send({ ev: 'run', state: 'error', error: message, at: nowIso() });
      return { ok: false, runId, error: message };
    }
  });

  // --- Replay a recorded trace.jsonl -----------------------------------------
  ipcMain.handle('orpad-core-run-replay', async (event, request = {}) => {
    const traceArg = request?.traceFile || request?.tracePath;
    if (!traceArg) return { ok: false, error: 'traceFile is required.' };

    const tracePath = path.resolve(String(traceArg));
    try {
      authority.assertWorkspacePath(event.sender, tracePath, { label: 'Trace file' });
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }

    let raw;
    try {
      raw = await fsp.readFile(tracePath, 'utf8');
    } catch (err) {
      return { ok: false, error: `Cannot read trace file: ${String(err?.message || err)}` };
    }

    const intervalMs = Number.isFinite(request?.intervalMs)
      ? Math.max(0, Math.min(1000, request.intervalMs))
      : 12;
    const runId = newRunId('replay');
    const send = sender(event, runId);
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    send({ ev: 'run', state: 'start', at: nowIso() });
    let emitted = 0;
    let sawDone = false;
    for (const line of lines) {
      let obj = null;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      if (!obj || typeof obj !== 'object' || !obj.ev) continue;
      send(obj);
      emitted += 1;
      if (obj.ev === 'run' && obj.state === 'done') sawDone = true;
      if (intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    if (!sawDone) send({ ev: 'run', state: 'done', at: nowIso() });
    return { ok: true, runId, events: emitted, done: true };
  });
}

module.exports = { registerCoreRunHandlers, TRACE_CHANNEL };
