#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  emitNodeCancelledForInflight,
  recoverStaleClaims,
  readMachineEvents,
  readRunState,
  repairRunStateFromEvents,
  resumeMachineRun,
} = require('../src/main/orchestration-machine');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRootDefault = path.resolve(repoRoot, '..');
const transientAuditCodes = new Set([
  'MACHINE_RUN_STATE_PROJECTION_MISMATCH',
  'MACHINE_BYPASS_RUN_STATE_STALE',
  'MACHINE_QUEUE_PROJECTED_ITEM_MISSING',
  'MACHINE_LEGACY_JOURNAL_COUNT_MISMATCH',
]);

function parseArgs(argv) {
  const options = {
    workspaceRoot: workspaceRootDefault,
    runRoot: '',
    staleMinutes: 5,
    failOnProblem: false,
    noRepair: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace-root') options.workspaceRoot = path.resolve(argv[index += 1] || '');
    else if (arg === '--run-root') options.runRoot = path.resolve(argv[index += 1] || '');
    else if (arg === '--stale-minutes') options.staleMinutes = Math.max(1, Number(argv[index += 1] || 60));
    else if (arg === '--fail-on-problem') options.failOnProblem = true;
    else if (arg === '--no-repair') options.noRepair = true;
  }
  return options;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function listDirectories(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).map(entry => path.join(dirPath, entry.name));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

async function findLatestRun(workspaceRoot) {
  const pipelinesRoot = path.join(workspaceRoot, '.orpad', 'pipelines');
  const candidates = [];
  for (const pipelineDir of await listDirectories(pipelinesRoot)) {
    const runsRoot = path.join(pipelineDir, 'runs');
    for (const runDir of await listDirectories(runsRoot)) {
      const statePath = path.join(runDir, 'run-state.json');
      const eventsPath = path.join(runDir, 'events.jsonl');
      if (!await exists(eventsPath)) continue;
      const stats = await fs.stat(runDir);
      const stateStats = await fs.stat(statePath).catch(() => null);
      const eventsStats = await fs.stat(eventsPath).catch(() => null);
      candidates.push({
        runRoot: runDir,
        mtimeMs: Math.max(stats.mtimeMs, stateStats?.mtimeMs || 0, eventsStats?.mtimeMs || 0),
      });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.runRoot || '';
}

function runAudit(runRoot) {
  const result = spawnSync(process.execPath, ['scripts/audit-orpad-machine-run.mjs', runRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120000,
  });
  let json = null;
  try {
    json = result.stdout ? JSON.parse(result.stdout) : null;
  } catch (err) {
    json = {
      ok: false,
      diagnostics: [{
        code: 'ORPAD_MONITOR_AUDIT_OUTPUT_INVALID',
        message: err.message,
      }],
    };
  }
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json,
  };
}

function diagnosticCodes(audit) {
  return (audit?.json?.diagnostics || []).map(item => item.code).filter(Boolean);
}

function onlyTransientDiagnostics(audit) {
  const codes = diagnosticCodes(audit);
  return codes.length > 0 && codes.every(code => transientAuditCodes.has(code));
}

async function activeRunProcesses(runId) {
  if (process.platform !== 'win32' || !runId) return [];
  const escaped = runId.replace(/'/g, "''");
  const command = [
    `$pattern = [regex]::Escape('${escaped}')`,
    '$own = $PID',
    "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $own -and $_.CommandLine -match $pattern -and $_.Name -match '^(node|codex|npm)(\\.exe)?$' } | Select-Object ProcessId,Name,CreationDate,CommandLine | ConvertTo-Json -Compress",
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (!result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function writeMonitorLog(workspaceRoot, record) {
  const logRoot = path.join(workspaceRoot, '.orpad', 'monitor');
  await fs.mkdir(logRoot, { recursive: true });
  const logPath = path.join(logRoot, 'hourly-run-audit.jsonl');
  const latestPath = path.join(logRoot, 'latest-run-audit.json');
  await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');
  await fs.writeFile(latestPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { logPath, latestPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const checkedAt = new Date();
  const runRoot = options.runRoot || await findLatestRun(options.workspaceRoot);
  if (!runRoot) {
    const record = {
      checkedAt: checkedAt.toISOString(),
      workspaceRoot: options.workspaceRoot,
      status: 'no-run',
      diagnostics: [{ code: 'ORPAD_MONITOR_NO_RUN', message: 'No OrPAD Machine run was found.' }],
    };
    const log = await writeMonitorLog(options.workspaceRoot, record);
    console.log(JSON.stringify({ ...record, log }, null, 2));
    return;
  }

  let runState = await readRunState(runRoot);
  let events = await readMachineEvents(runRoot);
  let audit = runAudit(runRoot);
  const beforeCodes = diagnosticCodes(audit);
  let repaired = false;

  if (!options.noRepair && onlyTransientDiagnostics(audit)) {
    await repairRunStateFromEvents(runRoot);
    repaired = true;
    await new Promise(resolve => setTimeout(resolve, 2000));
    audit = runAudit(runRoot);
  }

  if (!options.noRepair && onlyTransientDiagnostics(audit)) {
    await repairRunStateFromEvents(runRoot);
    repaired = true;
    audit = runAudit(runRoot);
  }

  runState = await readRunState(runRoot);
  events = await readMachineEvents(runRoot);
  let lastEvent = events.at(-1) || null;
  let lastEventAt = lastEvent?.timestamp ? new Date(lastEvent.timestamp) : null;
  let lastEventAgeMs = lastEventAt ? checkedAt.getTime() - lastEventAt.getTime() : null;
  let activeProcesses = await activeRunProcesses(runState?.runId || path.basename(runRoot));
  let afterCodes = diagnosticCodes(audit);
  let autoRecovery = null;
  const monitorDiagnostics = [];
  let lifecycleStatus = runState?.lifecycleStatus || '';
  let terminal = ['completed', 'failed', 'cancelled'].includes(lifecycleStatus);

  const stalledNoActiveAdapter = lifecycleStatus === 'running'
    && lastEventAgeMs != null
    && lastEventAgeMs >= options.staleMinutes * 60 * 1000
    && activeProcesses.length === 0;
  if (
    !options.noRepair
    && stalledNoActiveAdapter
    && afterCodes.includes('MACHINE_BYPASS_UNRESOLVED_ADAPTER_REQUEST')
  ) {
    try {
      const resumed = await resumeMachineRun(runRoot, {
        runId: runState?.runId || path.basename(runRoot),
        now: checkedAt.toISOString(),
        recoverStaleClaims,
        emitNodeCancelledForInflight,
        orphanedAdapterGraceMs: 0,
      });
      const orphanedAdapterRecoveryCount = resumed.staleClaims
        .filter(item => item?.orphanedAdapter)
        .length;
      autoRecovery = {
        ok: true,
        reason: 'orphaned-adapter-request',
        staleClaimCount: resumed.staleClaims.length,
        orphanedAdapterRecoveryCount,
        cancelledNodeCount: resumed.cancelledNodes.length,
        lifecycleStatus: resumed.runState?.lifecycleStatus || '',
        summaryStatus: resumed.runState?.summaryStatus || '',
      };
      audit = runAudit(runRoot);
      runState = await readRunState(runRoot);
      events = await readMachineEvents(runRoot);
      lastEvent = events.at(-1) || null;
      lastEventAt = lastEvent?.timestamp ? new Date(lastEvent.timestamp) : null;
      lastEventAgeMs = lastEventAt ? checkedAt.getTime() - lastEventAt.getTime() : null;
      activeProcesses = await activeRunProcesses(runState?.runId || path.basename(runRoot));
      afterCodes = diagnosticCodes(audit);
      lifecycleStatus = runState?.lifecycleStatus || '';
      terminal = ['completed', 'failed', 'cancelled'].includes(lifecycleStatus);
    } catch (err) {
      autoRecovery = {
        ok: false,
        reason: 'orphaned-adapter-request',
        code: err?.code || '',
        message: err?.message || String(err),
      };
    }
  }

  if (afterCodes.length) {
    monitorDiagnostics.push(...(audit.json?.diagnostics || []));
  }
  if (
    lifecycleStatus === 'running'
    && lastEventAgeMs != null
    && lastEventAgeMs >= options.staleMinutes * 60 * 1000
    && activeProcesses.length === 0
  ) {
    monitorDiagnostics.push({
      code: 'ORPAD_MONITOR_RUNNING_STALLED_NO_ACTIVE_ADAPTER',
      message: 'Run is still running but no event or active adapter process was observed within the stale threshold.',
      staleMinutes: options.staleMinutes,
      lastEventSequence: lastEvent?.sequence ?? null,
      lastEventAt: lastEvent?.timestamp || '',
    });
  }
  if (
    lifecycleStatus === 'running'
    && lastEventAgeMs != null
    && lastEventAgeMs >= options.staleMinutes * 60 * 1000
    && activeProcesses.length > 0
  ) {
    monitorDiagnostics.push({
      code: 'ORPAD_MONITOR_RUNNING_LONG_WITH_ACTIVE_ADAPTER',
      message: 'Run has not emitted events within the stale threshold, but adapter processes are still active.',
      staleMinutes: options.staleMinutes,
      activeProcessCount: activeProcesses.length,
      lastEventSequence: lastEvent?.sequence ?? null,
      lastEventAt: lastEvent?.timestamp || '',
    });
  }

  const status = monitorDiagnostics.length
    ? (terminal ? 'terminal-with-problems' : 'problem')
    : (terminal ? 'terminal-ok' : 'ok');
  const record = {
    checkedAt: checkedAt.toISOString(),
    workspaceRoot: options.workspaceRoot,
    runRoot,
    runId: runState?.runId || path.basename(runRoot),
    lifecycleStatus,
    summaryStatus: runState?.summaryStatus || '',
    eventSequence: runState?.eventSequence ?? null,
    lastEventSequence: lastEvent?.sequence ?? null,
    lastEventType: lastEvent?.eventType || '',
    lastEventAt: lastEvent?.timestamp || '',
    lastEventAgeSeconds: lastEventAgeMs == null ? null : Math.max(0, Math.round(lastEventAgeMs / 1000)),
    activeAdapterProcessCount: activeProcesses.length,
    repairedTransientProjection: repaired,
    autoRecovery,
    auditExitCode: audit.exitCode,
    auditCodesBeforeRepair: beforeCodes,
    auditCodesAfterRepair: afterCodes,
    status,
    diagnostics: monitorDiagnostics,
  };
  const log = await writeMonitorLog(options.workspaceRoot, record);
  console.log(JSON.stringify({ ...record, log }, null, 2));
  if (options.failOnProblem && monitorDiagnostics.length) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
