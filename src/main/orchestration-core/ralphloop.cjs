'use strict';
// OrPAD ralphloop — fully-automated, metric-gated maintenance loop on top of the core.
// observe -> metric-gate -> codify -> rerun, growing a versioned guidance catalog.
//
// Safety rails (from the spec): every codified guidance addition is KEPT only if the next
// run improves progress (or lowers motion); otherwise it is AUTO-DISCARDED (anti over-
// orchestration). The catalog is versioned/reversible, a per-cycle ledger is written, and
// the loop stops at convergence for a HUMAN checkpoint. The core's stop-signal bounds each
// delegation so a single cycle cannot rabbit-hole.
//
// The "codify" step is a fully-automated meta-agent (a small claude meta-call) that proposes
// ONE next minimal guidance line from the observed gap, or replies CONVERGED. A deterministic
// metaAgent can be injected for tests.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const core = require('./core.cjs');

function nowIso() { return new Date().toISOString(); }

// Default meta-agent: a small claude call that reads the task + current output/score gap
// and returns ONE next minimal guidance line, or "CONVERGED".
function claudeMetaAgent({ baseGoal, catalog, lastScore, maxScore, observation }) {
  const prompt = [
    'You are the ralphloop META-AGENT. You do NOT do the task. You propose ONE next minimal',
    'GUIDANCE line to help a coding agent improve on the task, OR reply exactly "CONVERGED".',
    'Keep guidance concrete and small (one sentence). Reply with ONLY the guidance line or CONVERGED.',
    '',
    'TASK: ' + baseGoal,
    'GUIDANCE SO FAR: ' + (catalog.length ? catalog.map((g, i) => `${i + 1}. ${g}`).join(' | ') : '(none)'),
    `LAST PROGRESS SCORE: ${lastScore} / ${maxScore}`,
    'OBSERVATION (gaps / test output): ' + observation,
  ].join('\n');
  const res = spawnSync('claude', ['-p', '--output-format', 'json', '--no-session-persistence'], {
    input: prompt, encoding: 'utf8', shell: true, maxBuffer: 16 * 1024 * 1024,
    timeout: 120000,
  });
  let txt = '';
  try { txt = (JSON.parse(res.stdout || '').result || '').trim(); } catch (_) { txt = (res.stdout || '').trim(); }
  return txt;
}

// opts: {
//   runId, baseGoal, workspaceRoot, scratchRoot, allowedFiles, readOnlyFiles?,
//   allowedTools?, progressFn (async (overlayRoot)=>{score,max,observation}),
//   maxCycles=4, timeoutMs, noImproveStop=2, metaAgent=claudeMetaAgent
// }
async function ralphloop(opts) {
  const {
    runId = 'ralph-' + Date.now(),
    baseGoal, workspaceRoot, scratchRoot,
    allowedFiles = [], readOnlyFiles = [], allowedTools,
    progressFn,
    maxCycles = 4, timeoutMs = 300000, noImproveStop = 2,
    metaAgent = claudeMetaAgent,
    runFn = core.runGovernedDelegation, // DI seam for deterministic tests
  } = opts;
  if (!baseGoal || !workspaceRoot || !scratchRoot || typeof progressFn !== 'function') {
    throw new Error('ralphloop requires baseGoal, workspaceRoot, scratchRoot, progressFn');
  }
  const loopDir = path.join(scratchRoot, runId);
  fs.mkdirSync(loopDir, { recursive: true });
  const ledgerPath = path.join(loopDir, 'ralphloop-ledger.jsonl');
  const appendLedger = (r) => fs.appendFileSync(ledgerPath, JSON.stringify(r) + '\n', 'utf8');

  let catalog = [];                 // accepted guidance (versioned below)
  let bestScore = -Infinity;
  let noImprove = 0;
  let converged = false;
  let convergeReason = null;
  const history = [];
  let pendingGuidance = null;       // guidance added this cycle, on trial

  function saveCatalog(cycle) {
    fs.writeFileSync(path.join(loopDir, `catalog-v${cycle}.json`), JSON.stringify({ cycle, catalog }, null, 2));
  }

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    const overlay = path.join(loopDir, `overlay-c${cycle}`);
    const runRoot = path.join(loopDir, `run-c${cycle}`);
    const composedGoal = baseGoal + (catalog.length
      ? '\n\nApply this accumulated GUIDANCE:\n' + catalog.map((g, i) => `- ${g}`).join('\n')
      : '');

    const run = await runFn({
      workspaceRoot, overlayRoot: overlay, runRoot,
      allowedFiles, readOnlyFiles, allowedTools, goal: composedGoal, timeoutMs,
    });
    const prog = await progressFn(overlay);              // {score, max, observation}
    const motion = run.summary.durationMs;
    const improved = prog.score > bestScore;

    // METRIC-GATE: keep the pendingGuidance (added at end of previous cycle) only if it improved.
    let gate = 'n/a';
    if (pendingGuidance !== null) {
      if (improved) { gate = 'accepted'; }
      else { gate = 'discarded'; catalog.pop(); } // auto-discard non-earning guidance
    }
    if (improved) { bestScore = prog.score; noImprove = 0; }
    else { noImprove += 1; }

    const rec = {
      cycle, at: nowIso(),
      score: prog.score, max: prog.max, bestScore,
      stopped: run.stopped, stopReason: run.stopReason,
      durationMs: motion, costUsd: run.summary.costUsd,
      changes: run.patch.changes.map(c => c.path), violations: run.patch.violations.length,
      pendingGuidance, gate, catalogSize: catalog.length,
      observation: (prog.observation || '').slice(0, 300),
    };
    appendLedger(rec); history.push(rec);
    saveCatalog(cycle);

    // Convergence checks
    if (prog.score >= prog.max) { converged = true; convergeReason = 'max-progress'; break; }
    if (noImprove >= noImproveStop) { converged = true; convergeReason = `no-improvement x${noImprove}`; break; }
    if (cycle === maxCycles) { convergeReason = 'max-cycles'; break; }

    // CODIFY next guidance (fully automated meta-agent)
    const proposal = metaAgent({ baseGoal, catalog, lastScore: prog.score, maxScore: prog.max, observation: prog.observation || '' });
    if (/^converged$/i.test((proposal || '').trim())) { converged = true; convergeReason = 'meta-agent-converged'; break; }
    pendingGuidance = (proposal || '').trim().slice(0, 400);
    catalog.push(pendingGuidance);                       // on trial; gated next cycle
  }

  const summary = {
    runId, cycles: history.length, bestScore, converged, convergeReason,
    finalCatalog: catalog, ledger: ledgerPath, loopDir,
    humanCheckpoint: 'review finalCatalog + ledger; accept catalog into the core or adjust',
  };
  fs.writeFileSync(path.join(loopDir, 'ralphloop-summary.json'), JSON.stringify(summary, null, 2));
  return { summary, history };
}

module.exports = { ralphloop, claudeMetaAgent };
