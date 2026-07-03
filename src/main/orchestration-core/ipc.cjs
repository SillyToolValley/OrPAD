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
const fs = require('fs');
const fsp = require('fs/promises');
const core = require('./core.cjs');
const observer = require('./tui-observer.cjs');
const tuiDetect = require('./tui-detect-observer.cjs');
const ptyTap = require('../terminal/pty-tap.cjs');
const { assertNoSymlinkInWorkspacePath } = require('../orchestration-machine/patches');

const TRACE_CHANNEL = 'orpad-core-trace';

function nowIso() { return new Date().toISOString(); }

function newRunId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Copy the agent's overlay output into the canonical workspace. Without this the
// governed delegation only COLLECTS a patch and the result stays trapped in the
// run overlay (the observed "my repo didn't change" / output-buried-in-.orpad
// problem). Each target is contained to the workspace (no path escape).
// Copy overlay files into an arbitrary destination root, contained to it (no '..'/absolute escape).
// Each target is resolved under destRoot and rejected if it escapes. Returns the copied rel paths.
async function copyOverlayPathsToDir(overlayRoot, destRoot, relPaths) {
  const root = path.resolve(destRoot);
  const copied = [];
  for (const rel of relPaths) {
    // `norm` is forced relative + '..'-free below, so it stays contained under BOTH overlayRoot (the
    // source read) and destRoot (the write). Only the dest side is symlink-asserted, so keep this invariant.
    const norm = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!norm || norm.split('/').includes('..')) continue;
    const dest = path.resolve(root, norm);
    const relCheck = path.relative(root, dest);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) continue;
    try {
      // Refuse to write THROUGH a symlink at the destination: a pre-existing dir-symlink on the path
      // (e.g. <root>/dist -> outside) would let copyFile escape the contained root. Per-segment lstat
      // guard, so containment is a property of THIS helper (matching the vault delivery's guarantee),
      // not an accident of when collectOverlayPatch happens to read the workspace baseline.
      await assertNoSymlinkInWorkspacePath(root, norm);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(path.resolve(overlayRoot, norm), dest);
      copied.push(norm);
    } catch (_) { /* skip files that vanished/unreadable OR that cross a symlink */ }
  }
  return copied.sort();
}

// Apply overlay output into the canonical workspace (contained to it — no path escape).
async function applyOverlayToWorkspace(workspaceRoot, overlayRoot, relPaths) {
  return copyOverlayPathsToDir(overlayRoot, workspaceRoot, relPaths);
}

// Shared minimum-verification loop used by BOTH the initial run AND every conversation turn: build ->
// deterministic smoke gates (+ user gates) [+ adversarial critic] -> on failure re-delegate REUSING the
// overlay with the failures injected, up to maxCycles. PROMOTION is gated on the DETERMINISTIC gates; the
// critic is ADVISORY (it drives retries + is surfaced, never authorizes shipping). This is what makes a
// follow-up turn as safe as turn 1. Returns { result, gate, cycles } (gate carries detPassed/criticFindings/
// criticNotes). `runner({...baseOpts, seedOverlay, resumeSessionId})` runs the first build; retries reuse the
// overlay via runGovernedDelegation. Injectable `coreApi` for tests.
async function runVerifiedLoop(ctx) {
  const {
    runner, baseOpts = {}, goal, agent, timeoutMs = 0, runId = null, overlayRoot,
    gates = [], autoVerify = true, maxCycles = 0, greenfield = false,
    seedOverlay = true, resumeSessionId = null, send = () => {}, coreApi = core,
  } = ctx;
  const criticCapable = String(agent || 'claude').toLowerCase() === 'claude';
  // Trust-boundary safety for best-so-far: retries reuse the SAME overlay IN PLACE (seedOverlay:false), so if
  // a later attempt regresses and the loop rolls back to an earlier det-passing one, the overlay on disk still
  // holds the LATER (gate-failed) bytes. We snapshot the promoted attempt's shipped bytes here and (only if a
  // retry actually happened) re-materialize them into the overlay before apply — so applyOverlayToWorkspace,
  // which copies live overlay bytes, can NEVER ship the regressed/unverified attempt. (changes carry recorded
  // content in the patch, but violations/greenfield output do not — so we snapshot from disk, uniformly.)
  let bestSnapshot = null; // Map<relPath, Buffer|null> of the last det-passing attempt's shipped files
  const snapshotOverlay = async (relPaths) => {
    const m = new Map();
    for (const rel of relPaths) {
      const norm = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!norm || norm.split('/').includes('..')) continue;
      try { m.set(norm, await fsp.readFile(path.resolve(overlayRoot, norm))); }
      catch (_) { m.set(norm, null); } // absent/unreadable -> record as "should not exist"
    }
    return m;
  };
  const verifyFn = async (b) => {
    const built = b && (b.build || b);
    const patch = (built && built.patch) || { changes: [], violations: [] };
    const shipped = greenfield
      ? [...patch.changes, ...patch.violations.map((v) => ({ path: v.path, afterExists: true }))]
      : patch.changes;
    send({ ev: 'phase', kind: 'verify', state: 'start', at: nowIso() });
    const smoke = autoVerify ? coreApi.buildSmokeGates({ changes: shipped }) : [];
    const detGates = [...gates, ...smoke];
    const det = detGates.length ? coreApi.runVerificationGates(overlayRoot, detGates) : { passed: true, results: [] };
    // Snapshot the shipped bytes of every det-passing attempt (only meaningful when retries can mutate the
    // overlay). The critic runs READ-ONLY after this, so the overlay isn't touched between det and snapshot.
    if (maxCycles > 0 && det.passed && shipped.length) {
      try { bestSnapshot = await snapshotOverlay(shipped.map((c) => c.path)); } catch (_) { /* best effort */ }
    }
    let critic = { passed: true, findings: [], notes: [] };
    if (autoVerify && criticCapable && det.passed && !(built && built.stopped) && shipped.length) {
      try { critic = await coreApi.runCritic({ overlayRoot, goal, agent, timeoutMs, onTraceEvent: send, runId }); }
      catch (_) { critic = { passed: true, findings: [], notes: [] }; }
    }
    send({ ev: 'phase', kind: 'verify', state: 'done', at: nowIso() });
    const criticResults = (critic.findings || []).map((f, i) => ({ id: `critic:${i + 1}`, kind: 'critic', passed: false, detail: f }));
    return {
      passed: det.passed && critic.passed,        // loop continuation (retry on either)
      detPassed: det.passed,                       // PROMOTION gate (deterministic source of truth)
      criticPassed: critic.passed,
      results: [...det.results, ...criticResults], // feedback to the next attempt (det + critic)
      detResults: det.results,                     // UI "X/Y checks" display
      criticFindings: critic.findings || [],
      criticNotes: critic.notes || [],             // advisory "shipped anyway, consider X" channel
    };
  };
  let firstDone = false;
  let firstWrap = null;
  const withInfraRetry = async (fn) => {
    let r;
    for (let i = 0; i < 3; i += 1) {
      r = await fn();
      const built = r && (r.build || r);
      const ar = built && built.agentRun;
      const transient = ar && ar.isError && [429, 500, 502, 503, 504].includes(Number(ar.apiErrorStatus));
      if (transient && !built.stopped && i < 2) { send({ ev: 'phase', kind: 'verify', state: 'infra-retry', at: nowIso() }); continue; }
      break;
    }
    return r;
  };
  const buildFn = async (feedback) => {
    if (!firstDone) { firstDone = true; const r = await withInfraRetry(() => runner({ ...baseOpts, seedOverlay, resumeSessionId })); firstWrap = r; return r; }
    // Retry: reuse the overlay (seedOverlay:false), keep the session (resume), re-inject the first attempt's
    // grounding/vault brief so the fix pass keeps the same standing context.
    const grounded = firstWrap && firstWrap.brief ? coreApi.composeGoalWithGrounding(goal, firstWrap.brief) : goal;
    // Resume the FIRST attempt's agent session so the fix pass keeps attempt-1's reasoning (not just the files
    // on disk + the feedback). On an INITIAL run ctx.resumeSessionId is null, so fall back to the session the
    // first attempt created (captured on firstWrap); the conversation-continue path already passes a real one.
    const firstBuilt = firstWrap && (firstWrap.build || firstWrap);
    const retryResumeId = resumeSessionId || (firstBuilt && firstBuilt.agentRun && firstBuilt.agentRun.sessionId) || null;
    return await withInfraRetry(() => coreApi.runGovernedDelegation({ ...baseOpts, goal: `${grounded}\n\n${feedback}`, seedOverlay: false, resumeSessionId: retryResumeId }));
  };
  const loop = await coreApi.runVerifiedBuildLoop({ buildFn, verifyFn, maxCycles });
  let result = loop.build;
  const gate = loop.gate;
  // If a retry happened and the loop returned a det-passing build, re-materialize that promoted attempt's
  // shipped bytes into the overlay — undoing any in-place mutation by a later regressed attempt — so the apply
  // ships exactly what was verified. No-op (idempotent) when the final attempt WAS the best.
  if (bestSnapshot && loop.cycles > 0 && gate && gate.detPassed) {
    for (const [rel, buf] of bestSnapshot) {
      const dest = path.resolve(overlayRoot, rel);
      try {
        await assertNoSymlinkInWorkspacePath(overlayRoot, rel); // contained like copyOverlayPathsToDir: never write THROUGH a planted symlink
        if (buf === null) await fsp.rm(dest, { force: true });
        else { await fsp.mkdir(path.dirname(dest), { recursive: true }); await fsp.writeFile(dest, buf); }
      } catch (_) { /* best effort — apply still reads whatever is on disk (and re-asserts containment) */ }
    }
  }
  // Carry the first (grounded/vault) attempt's wrapper fields forward — a retry returns a plain governed
  // result with no .vault/.brief/.research that would otherwise be dropped.
  if (firstWrap && result && result !== firstWrap) {
    if (!result.vault) result.vault = firstWrap.vault;
    if (result.brief == null) result.brief = firstWrap.brief;
    if (!result.research) result.research = firstWrap.research;
  }
  return { result, gate, cycles: loop.cycles, firstWrap };
}

// Resolve a run's base dir from a renderer-supplied runId, kept STRICTLY under core-runs (no '..'/escape).
// Returns the absolute runBase, or null if the runId would escape the runs directory.
function resolveRunBase(workspaceRoot, runId) {
  const runsDir = path.join(workspaceRoot, '.orpad', 'core-runs');
  const runBase = path.join(runsDir, String(runId || ''));
  const rel = path.relative(runsDir, runBase);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return null;
  return runBase;
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

    // Pre-flight: if the selected provider CLI isn't installed / on PATH, fail fast with
    // guidance (a `providerMissing` payload the GUI turns into a help modal) instead of
    // spawning a doomed child that "runs" but produces nothing.
    const providerStatus = core.providerInfo(agent);
    if (!providerStatus.available) {
      return { ok: false, providerMissing: providerStatus, error: `The "${providerStatus.provider}" provider CLI ("${providerStatus.command}") was not found on your PATH.` };
    }

    const ground = request?.ground !== false;     // default ON: research prior art first
    const apply = request?.apply !== false;       // default ON: write the result into the workspace
    const parallelResearch = request?.parallelResearch === true; // fan-out: parallel research subagents
    const researchQueries = Array.isArray(request?.researchQueries) ? request.researchQueries : undefined;
    const greenfield = allowedFiles.length === 0; // no write-set -> unconstrained build, apply everything
    const useVault = request?.vault === true; // opt-in: ground in + capture to the durable knowledge vault
    // Where compiled build artifacts (dist/build/release/...) land. OrPAD does NOT build — the agent does;
    // this only routes the OUTPUT. 'auto' follows the apply verdict; 'workspace'/'run-dir' are explicit.
    const buildOutputTo = ['workspace', 'run-dir'].includes(request?.buildOutputTo) ? request.buildOutputTo : 'auto';

    // Verification gates (the TRUST boundary): deterministic checks run against the
    // overlay before anything is applied. `gates` are explicit gate objects;
    // `verifyCommands` is a convenience (shell strings -> command gates).
    const rawGates = Array.isArray(request?.gates) ? request.gates : [];
    const cmdGates = Array.isArray(request?.verifyCommands)
      ? request.verifyCommands.map(String).map((s) => s.trim()).filter(Boolean).map((cmd) => ({ kind: 'command', cmd }))
      : [];
    const gates = [...rawGates.filter((g) => g && typeof g === 'object' && g.kind), ...cmdGates];
    // Default-ON minimum verification (benchmark-informed): even with NO user gates, auto-derive deterministic
    // smoke gates from the build + run an adversarial critic, with bounded feedback retries. Disable via verify:false.
    const autoVerify = request?.verify !== false;
    const userMaxCycles = Number.isInteger(request?.verifyCycles) ? Math.max(0, Math.min(5, request.verifyCycles)) : null;
    const maxVerifyCycles = userMaxCycles != null ? userMaxCycles : (autoVerify ? 3 : 0);
    const doVerify = autoVerify || gates.length > 0;

    const runId = newRunId('core');
    const runBase = path.join(workspaceRoot, '.orpad', 'core-runs', runId);
    const overlayRoot = path.join(runBase, 'overlay');
    const runRoot = path.join(runBase, 'run');

    // Persist EVERY streamed event to the replayable trace (research fan-out branches
    // AND the build), so a later replay reconstructs the fork/join flowers. This TEE
    // is the single source of truth — the core no longer writes its own trace file
    // (streamTrace:false), which previously truncated it and dropped the research
    // branches that only ever reached the live IPC stream.
    const traceFilePath = path.join(runRoot, 'trace.jsonl');
    try { fs.mkdirSync(runRoot, { recursive: true }); fs.writeFileSync(traceFilePath, '', 'utf8'); } catch (_) { /* best effort */ }
    // Persist a human-readable label for the run-history picker (the cryptic runId dir
    // is kept as-is so paths don't break; the goal is shown as the title instead).
    try {
      fs.writeFileSync(path.join(runBase, 'meta.json'), JSON.stringify({
        goal, agent: providerStatus.provider, parallelResearch, ground, apply, vault: useVault, startedAt: nowIso(),
      }), 'utf8');
    } catch (_) { /* label is best-effort */ }
    const rawSend = sender(event, runId);
    const send = (ev) => {
      try { fs.appendFileSync(traceFilePath, JSON.stringify(ev) + '\n', 'utf8'); } catch (_) { /* trace persist best-effort */ }
      rawSend(ev);
    };
    send({ ev: 'run', state: 'start', at: nowIso() });
    try {
      const baseOpts = {
        workspaceRoot, overlayRoot, runRoot, runId,
        allowedFiles, readOnlyFiles, goal, allowedTools, agent, timeoutMs,
        ground, parallelResearch, researchQueries,
        earnedFrom: `${runId} — goal: ${goal.slice(0, 120)}`,
        streamTrace: false, // the IPC tee above owns trace persistence now
        onTraceEvent: send,
      };
      const runner = useVault
        ? core.runVaultGroundedDelegation
        : ground ? core.runGroundedDelegation : core.runGovernedDelegation;

      let result;
      let gate = { passed: true, results: [], detResults: [], detPassed: true, criticPassed: true, criticFindings: [] };
      let verifyCycles = 0;
      if (doVerify) {
        // The minimum-verification loop, shared with conversation turns (run-continue).
        const out = await runVerifiedLoop({
          runner, baseOpts, goal, agent, timeoutMs, runId, overlayRoot,
          gates, autoVerify, maxCycles: maxVerifyCycles, greenfield,
          seedOverlay: true, resumeSessionId: null, send,
        });
        result = out.result;
        gate = out.gate;
        verifyCycles = out.cycles;
      } else {
        result = await runner(baseOpts);
      }

      // grounded delegation returns { research, brief, build, summary }; plain
      // delegation returns the run result directly.
      const build = result.build || result;
      const patch = build.patch || { changes: [], violations: [] };
      const summary = result.summary || build.summary || {};
      const sessionId = (build.agentRun && build.agentRun.sessionId) || null; // for conversational continue (--resume)
      const met = doVerify ? !!gate.detPassed : null; // promotion gated on DETERMINISTIC checks; null = unverified
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

      // Knowledge-vault write-back: persist the notes the run produced into the durable vault, through
      // the transactional moat (collectOverlayPatch -> applyPatchArtifact in core.promoteVaultPatch), NOT
      // applyOverlayToWorkspace. Gated on vaultEligible (not stopped, not gate-FAILED) — deliberately
      // INDEPENDENT of `apply`: turning OFF code-apply (to inspect the build before it touches the repo)
      // must NOT also discard the researched knowledge. NOTE the notes are advisory grounding from the
      // research overlay and are NOT themselves gate-verified (gates inspect the build overlay, not
      // `${overlayRoot}-vault`); ungated runs (met===null) still seed the vault. Best-effort: a vault
      // failure surfaces as vaultSkipped and never crashes the run.
      const vaultEligible = useVault && !build.stopped && met !== false;
      let vaultResult = null;
      if (vaultEligible && result.vault && result.vault.patch) {
        try {
          vaultResult = await core.promoteVaultPatch({ workspaceRoot, patch: result.vault.patch, runId });
        } catch (e) {
          vaultResult = { written: [], skipped: [{ path: core.VAULT_REL, reason: String(e?.message || e) }], indexed: false };
        }
      }

      // Build outputs (dist/build/release/out/.next/...) are normally filtered as generated artifacts and
      // dropped. Deliver them so a "build me an app" goal yields a retrievable result: apply ON -> into the
      // workspace (alongside source); otherwise -> a clean `build/` folder under the run dir (findable, not
      // buried in overlay/). Only the build-output category is delivered — tool caches (__pycache__/
      // .pytest_cache) and validation artifacts (coverage/test-results) stay filtered.
      const buildOutputPaths = (patch.ignoredGeneratedFiles || [])
        .filter((f) => f && f.reason === 'overlay-generated-build-output')
        .map((f) => f.path);
      let buildOutputs = [];
      let buildOutputDest = null;
      if (buildOutputPaths.length) {
        // Explicit choice wins; 'auto' follows the apply verdict (workspace when eligible, else run dir).
        const toWorkspace = buildOutputTo === 'workspace' || (buildOutputTo === 'auto' && applyEligible);
        if (toWorkspace) {
          buildOutputs = await applyOverlayToWorkspace(workspaceRoot, overlayRoot, buildOutputPaths);
          buildOutputDest = 'workspace';
        } else {
          const buildDir = path.join(runBase, 'build');
          buildOutputs = await copyOverlayPathsToDir(overlayRoot, buildDir, buildOutputPaths);
          buildOutputDest = buildDir;
        }
      }

      // Persist the captured session id so this run can be CONTINUED conversationally (--resume).
      if (sessionId) {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(runBase, 'meta.json'), 'utf8'));
          m.sessionId = sessionId;
          fs.writeFileSync(path.join(runBase, 'meta.json'), JSON.stringify(m), 'utf8');
        } catch (_) { /* best effort */ }
      }

      return {
        ok: true,
        runId,
        sessionId,
        agentText: (build.agentRun && build.agentRun.result) ? String(build.agentRun.result).slice(0, 4000) : '',
        ...summary,
        grounded: ground,
        groundingBrief: !!(result.brief && String(result.brief).trim()),
        greenfield,
        gated: doVerify,
        verified: doVerify,
        met,
        verifyCycles,
        gates: gate.detResults || gate.results,
        criticPassed: doVerify ? !!gate.criticPassed : null,
        criticConcerns: gate.criticFindings || [],
        criticNotes: gate.criticNotes || [],
        applied,
        appliedCount: applied.length,
        changes: patch.changes.map((c) => c.path),
        violations: patch.violations,
        overlayPath: overlayRoot,           // where the built result lives (esp. when not applied)
        builtCount: patch.changes.length + patch.violations.length,
        vault: useVault,
        vaultWritten: vaultResult ? vaultResult.written : [],
        vaultIndexed: vaultResult ? vaultResult.indexed : false,
        vaultSkipped: vaultResult ? vaultResult.skipped : [],
        ignoredGeneratedFiles: (patch.ignoredGeneratedFiles || []).length,
        buildOutputs,
        buildOutputCount: buildOutputs.length,
        buildOutputDest,
      };
    } catch (err) {
      const message = String(err?.message || err);
      send({ ev: 'run', state: 'error', error: message, at: nowIso() });
      return { ok: false, runId, error: message };
    } finally {
      core.clearCancelled(runId);
    }
  });

  // --- Stop a running governed delegation ------------------------------------
  // Kills the agent child process tree for the run so it stops occupying
  // resources. The in-flight run-start resolves as stopped:cancelled.
  ipcMain.handle('orpad-core-run-stop', async (event, request = {}) => {
    const runId = request && request.runId ? String(request.runId) : null;
    if (!runId) return { ok: false, error: 'runId is required.' };
    // An observed TUI run isn't a child process — stop its detector/tailer; otherwise cancel the delegation.
    if (runId.startsWith('observe-')) return { ok: true, cancelled: tuiDetect.stopTuiDetect(runId) || observer.stopObserve(runId) };
    const cancelled = core.cancelRun(runId);
    return { ok: true, cancelled };
  });

  // One detach hook per webContents: observe-start/reattach are called repeatedly (per Apply, per reload),
  // and stacking a fresh once('destroyed') each time accumulates listeners on long-lived windows.
  const hookedDetachSenders = new Set();
  function hookDetachOnDestroy(event) {
    const wcId = event.sender.id;
    if (hookedDetachSenders.has(wcId)) return;
    hookedDetachSenders.add(wcId);
    try {
      event.sender.once('destroyed', () => {
        hookedDetachSenders.delete(wcId);
        tuiDetect.detachWindow(wcId);
      });
    } catch (_) { hookedDetachSenders.delete(wcId); /* best effort */ }
  }

  // --- Observe a live interactive TUI (claude) → live graph ---------------------------------------------
  // Called BY the Run GUI window (so trace streams back to it). Visualises a session the user drives in the
  // terminal — no sandbox/verify (advisory only). Cleans up when the window is destroyed.
  //
  // PRIMARY path = PTY-stream parsing: claude under ConPTY writes no conversation log, but OrPAD owns the PTY,
  // so we tap the session's output, reconstruct the rendered screen, and detect tool calls from it (works for
  // any provider tui-detect knows, no session-log dependency). Requires the pty `sessionId`. Without one we
  // fall back to log-tailing (legacy; only sees claudes that DO write a live log).
  ipcMain.handle('orpad-core-observe-start', async (event, request = {}) => {
    const workspaceRoot = authority.getWorkspaceRoot(event.sender);
    const cwd = request && request.cwd ? String(request.cwd) : workspaceRoot;
    const agent = request && request.agent ? String(request.agent).toLowerCase() : 'claude';
    const sessionId = request && request.sessionId ? String(request.sessionId) : null;
    const runId = newRunId('observe');
    const send = sender(event, runId);

    if (sessionId) {
      const wcId = event.sender.id;
      // The observer's lifetime follows the PTY SESSION, not this window. If one already exists for this
      // session — live, or finished-but-retained after PTY exit — REATTACH: bind this webContents as a
      // consumer and ALWAYS replay the buffer to it. A Ctrl+R reload keeps the same wcId, so "already bound"
      // must never skip the replay (the replayed head run/start resets the renderer entry — idempotent).
      const existing = tuiDetect.findBySession(sessionId);
      if (existing && !existing.closed) {
        tuiDetect.reattach(existing.runId, sender(event, existing.runId), wcId);
        hookDetachOnDestroy(event);
        return { ok: true, runId: existing.runId };
      }
      // Observing an already-exited session would create an immortal 'active' zombie run. Reject it — and
      // surface WHY in the Run GUI (an Apply seed can still arrive after the CLI exited), as an error row
      // rather than a silently missing graph.
      if (!ptyTap.isAlive(sessionId)) {
        const msg = 'This terminal session has already exited — nothing to observe.';
        send({ ev: 'run', state: 'error', error: msg, at: nowIso() });
        return { ok: false, deadSession: true, error: msg };
      }
      const cols = Number(request.cols) || undefined;
      const rows = Number(request.rows) || undefined;
      // If this session is somehow already observed, startTuiDetect returns the EXISTING handle; report its
      // (stable) runId, never the fresh one, so the renderer routes to the live channel.
      const h = tuiDetect.startTuiDetect({ runId, sessionId, agent, send: sender(event, runId), cols, rows, workspaceRoot, wcId });
      hookDetachOnDestroy(event);
      return { ok: true, runId: (h && h.runId) || runId };
    }

    // Fallback: tail the on-disk session log (legacy path).
    if (!cwd) return { ok: false, error: 'A working directory is required to locate the session log.' };
    if (agent !== 'claude') return { ok: false, error: 'Live observation currently supports claude only.' };
    const pid = request && request.pid ? Number(request.pid) : null;
    observer.startObserve({ runId, cwd, agent, pid, send });
    // Tie the observer's lifetime to the window that asked for it — no leaked tailers.
    try { event.sender.once('destroyed', () => observer.stopObserve(runId)); } catch (_) { /* best effort */ }
    return { ok: true, runId };
  });

  // Reattach a (re)opened Run GUI window to every observer for its workspace — live ones (their PTY sessions
  // kept running) AND finished-retained ones (their session exited while no window was open) — and replay
  // their buffers, so closing/reopening the window re-syncs the graphs without a fresh Apply.
  ipcMain.handle('orpad-core-observe-reattach', async (event) => {
    const workspaceRoot = authority.getWorkspaceRoot(event.sender);
    const wcId = event.sender.id;
    const runIds = tuiDetect.reattachWorkspace(workspaceRoot, (runId) => sender(event, runId), wcId);
    hookDetachOnDestroy(event);
    return { ok: true, runIds };
  });

  ipcMain.handle('orpad-core-observe-stop', async (event, request = {}) => {
    const runId = request && request.runId ? String(request.runId) : null;
    if (!runId) return { ok: false, error: 'runId is required.' };
    return { ok: tuiDetect.stopTuiDetect(runId) || observer.stopObserve(runId) };
  });

  // --- Continue a run as a CONVERSATION turn ---------------------------------
  // The conceptual shift: a run is a SESSION, not a one-shot. A turn = a governed delegation that REUSES the
  // run's overlay (seedOverlay:false) and RESUMES the agent session (--resume, so it keeps full context),
  // streamed into the SAME graph (same runId channel) so it accumulates. Everything is preserved — the moat,
  // vault grounding, and a deterministic smoke verify before apply all run per turn (full critic/retry loop
  // per turn is a later phase).
  ipcMain.handle('orpad-core-run-continue', async (event, request = {}) => {
    const workspaceRoot = authority.getWorkspaceRoot(event.sender);
    if (!workspaceRoot) return { ok: false, error: 'Open a project folder before continuing a run.' };
    const runId = request?.runId ? String(request.runId) : null;
    const message = String(request?.message || '').trim();
    if (!runId) return { ok: false, error: 'runId is required.' };
    if (!message) return { ok: false, error: 'A message is required.' };

    // Containment: runId comes from the renderer — keep runBase strictly under core-runs (no '..'/escape),
    // matching the path-safety posture of the replay/apply paths.
    const runBase = resolveRunBase(workspaceRoot, runId);
    if (!runBase) return { ok: false, error: 'Invalid runId.' };
    const overlayRoot = path.join(runBase, 'overlay');
    const runRoot = path.join(runBase, 'run');
    if (!fs.existsSync(overlayRoot)) return { ok: false, error: "This run's overlay no longer exists — start a new run." };

    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(runBase, 'meta.json'), 'utf8')); } catch (_) { /* no meta */ }
    const agent = meta.agent ? String(meta.agent) : 'claude';
    const resumeSessionId = meta.sessionId || null;
    const useVault = meta.vault === true;
    const apply = meta.apply !== false;

    const providerStatus = core.providerInfo(agent);
    if (!providerStatus.available) {
      return { ok: false, providerMissing: providerStatus, error: `The "${providerStatus.provider}" provider CLI ("${providerStatus.command}") was not found on your PATH.` };
    }

    const traceFilePath = path.join(runRoot, 'trace.jsonl');
    const rawSend = sender(event, runId);
    const send = (ev) => {
      try { fs.appendFileSync(traceFilePath, JSON.stringify(ev) + '\n', 'utf8'); } catch (_) { /* best effort */ }
      rawSend(ev);
    };
    // Degrade LOUDLY (not silently): flag a pre-conversational run, missing session memory, or a non-claude
    // provider (no adversarial critic) so the UI can warn rather than mislead.
    const criticCapable = String(agent || 'claude').toLowerCase() === 'claude';
    const degraded = [];
    if (!meta.agent) degraded.push('this run predates conversational continue — starting a fresh run is recommended');
    if (!resumeSessionId) degraded.push('no session memory for this turn — the agent will not recall earlier turns');
    if (!criticCapable) degraded.push(`adversarial critic is claude-only — this ${agent} turn ships with smoke checks only`);
    for (const d of degraded) send({ ev: 'notice', level: 'warn', text: d, at: nowIso() });

    send({ ev: 'turn', state: 'start', message: message.slice(0, 200), at: nowIso() });
    send({ ev: 'run', state: 'start', continued: true, at: nowIso() }); // continued=true: graph accumulates, no reset
    try {
      const runner = useVault ? core.runVaultGroundedDelegation : core.runGovernedDelegation;
      // FULL minimum-verification (smoke + adversarial critic + fix-retry) — the SAME loop as the initial run,
      // so a follow-up turn is as safe as turn 1. Reuse the overlay (seedOverlay:false) and resume the session.
      const out = await runVerifiedLoop({
        runner,
        // ground: useVault — a plain turn skips the (expensive) prior-art research, but a VAULT turn must keep
        // it ON, because runVaultGroundedDelegation gates its gap-research + knowledge write-back on ground;
        // forcing it off would let the vault READ each turn but never CAPTURE, so it stops compounding.
        baseOpts: { workspaceRoot, overlayRoot, runRoot, runId, allowedFiles: [], readOnlyFiles: [], goal: message, agent, ground: useVault, streamTrace: false, onTraceEvent: send, earnedFrom: `${runId} (turn)` },
        goal: message, agent, timeoutMs: 0, runId, overlayRoot,
        gates: [], autoVerify: true, maxCycles: 3, greenfield: true,
        seedOverlay: false, resumeSessionId, send,
      });
      const result = out.result;
      const gate = out.gate;
      const build = result.build || result;
      const patch = build.patch || { changes: [], violations: [] };
      const newSessionId = (build.agentRun && build.agentRun.sessionId) || resumeSessionId || null;
      const met = !!gate.detPassed;

      send({ ev: 'run', state: 'done', at: nowIso() });
      send({ ev: 'turn', state: 'done', at: nowIso() });

      let applied = [];
      const applyEligible = apply && !build.stopped && met !== false;
      if (applyEligible) {
        const applySet = [...patch.changes.map((c) => c.path), ...patch.violations.map((v) => v.path)];
        applied = await applyOverlayToWorkspace(workspaceRoot, overlayRoot, applySet);
      }
      // Vault write-back on the turn (when the vault runner produced notes and the turn is promotable).
      let vaultResult = null;
      if (useVault && applyEligible && result.vault && result.vault.patch) {
        try { vaultResult = await core.promoteVaultPatch({ workspaceRoot, patch: result.vault.patch, runId }); }
        catch (e) { vaultResult = { written: [], skipped: [{ path: core.VAULT_REL, reason: String(e?.message || e) }], indexed: false }; }
      }
      if (newSessionId && newSessionId !== resumeSessionId) {
        // Re-read fresh and merge only sessionId: the turn held its meta snapshot across a minutes-long
        // delegation, during which another writer may have updated meta.json. Writing the stale snapshot back
        // would clobber those edits — so merge sessionId into the latest on disk.
        try {
          const m = JSON.parse(fs.readFileSync(path.join(runBase, 'meta.json'), 'utf8'));
          m.sessionId = newSessionId;
          fs.writeFileSync(path.join(runBase, 'meta.json'), JSON.stringify(m), 'utf8');
        } catch (_) { /* best effort */ }
      }

      return {
        ok: true, runId, turn: true, sessionId: newSessionId, degraded,
        agentText: (build.agentRun && build.agentRun.result) ? String(build.agentRun.result).slice(0, 4000) : '',
        ...(result.summary || build.summary || {}),
        gated: true, verified: true, met, verifyCycles: out.cycles,
        gates: gate.detResults || gate.results,
        criticPassed: !!gate.criticPassed, criticConcerns: gate.criticFindings || [], criticNotes: gate.criticNotes || [],
        applied, appliedCount: applied.length,
        vault: useVault, vaultWritten: vaultResult ? vaultResult.written : [],
        changes: patch.changes.map((c) => c.path),
        violations: patch.violations,
        overlayPath: overlayRoot,
        stopped: build.stopped, stopReason: build.stopReason,
      };
    } catch (err) {
      const errMsg = String(err?.message || err);
      send({ ev: 'run', state: 'error', error: errMsg, at: nowIso() });
      return { ok: false, runId, error: errMsg };
    } finally {
      core.clearCancelled(runId);
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

  // --- List recorded runs (for the run-history picker) -----------------------
  // Enumerate <workspace>/.orpad/core-runs/* and report the replayable trace of
  // each (newest first), so the GUI can re-visualise a past run without re-running.
  ipcMain.handle('orpad-core-list-runs', async (event) => {
    const workspaceRoot = authority.getWorkspaceRoot(event.sender);
    if (!workspaceRoot) return { ok: false, error: 'Open a project folder first.' };
    const runsDir = path.join(workspaceRoot, '.orpad', 'core-runs');
    let entries;
    try {
      entries = await fsp.readdir(runsDir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: true, runs: [] };
      return { ok: false, error: String(err?.message || err) };
    }
    const runs = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const runId = e.name;
      const mainTrace = path.join(runsDir, runId, 'run', 'trace.jsonl');
      const researchTrace = path.join(runsDir, runId, 'run-research', 'trace.jsonl');
      let traceFile = null;
      let stat = null;
      for (const c of [mainTrace, researchTrace]) {
        try { const s = await fsp.stat(c); if (s.isFile() && s.size > 0) { traceFile = c; stat = s; break; } } catch (_) { /* missing */ }
      }
      if (!traceFile) continue;
      const hasResearch = await fsp.stat(researchTrace).then((s) => s.isFile()).catch(() => false);
      const m = /-(\d{10,16})-/.exec(runId); // core-<startedMs>-<rand>
      const startedMs = m ? Number(m[1]) : stat.mtimeMs;
      // Human-readable label from the run's meta.json (older runs have none → null).
      let goal = null; let agent = null; let vault = false;
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(runsDir, runId, 'meta.json'), 'utf8'));
        if (meta && typeof meta.goal === 'string') goal = meta.goal;
        if (meta && meta.agent) agent = String(meta.agent);
        if (meta && meta.vault) vault = true;
      } catch (_) { /* no meta */ }
      runs.push({ runId, traceFile, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, startedMs, hasResearch, goal, agent, vault });
    }
    runs.sort((a, b) => (b.startedMs || b.mtimeMs) - (a.startedMs || a.mtimeMs));
    return { ok: true, runs };
  });
}

module.exports = { registerCoreRunHandlers, TRACE_CHANNEL, applyOverlayToWorkspace, copyOverlayPathsToDir, runVerifiedLoop };
