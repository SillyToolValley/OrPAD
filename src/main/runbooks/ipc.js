const path = require('path');
const fsp = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { isInsidePath } = require('../authority');
const { validateRunbookFile, validateRunbookSource } = require('./validator');
const { createRunRecord, readRunRecord, runRoot } = require('./storage');
const { startLocalRun } = require('./executor');
const { readWorkspaceIndexCache, writeWorkspaceIndexCache } = require('../workspace-index/cache');

const RUNBOOK_SCAN_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '__pycache__',
  'dist',
  'build',
  'out',
  '.next',
  '.cache',
  'coverage',
  'test-results',
  'playwright-report',
]);
const RUNBOOK_SCAN_MAX_DEPTH = 8;
const RUNBOOK_SCAN_MAX_ENTRIES = 5000;
const execFileAsync = promisify(execFile);

function normalizeTrustLevel(options = {}) {
  return options?.trustLevel || 'local-authored';
}

async function workspaceRootForRun(event, authority, workspacePath) {
  const requested = workspacePath || authority.getWorkspaceRoot(event.sender);
  return authority.assertWorkspacePath(event.sender, requested, { label: 'Run workspace' });
}

function runbookExt(name) {
  const lower = String(name || '').toLowerCase();
  if (lower === '.env' || lower.endsWith('.env')) return 'env';
  if (lower.endsWith('.or-pipeline')) return 'orpad';
  if (lower.endsWith('.or-graph')) return 'orpad';
  if (lower.endsWith('.or-tree')) return 'orpad';
  if (lower.endsWith('.or-rule')) return 'orpad';
  if (lower.endsWith('.or-run')) return 'orpad';
  if (lower.endsWith('.orch-graph.json')) return 'orch';
  if (lower.endsWith('.orch-tree.json')) return 'orch';
  const match = lower.match(/\.([a-z0-9]+)$/);
  return match ? match[1] : 'text';
}

function isPipelineFile(name) {
  return String(name || '').toLowerCase().endsWith('.or-pipeline');
}

function isLegacyRunbookFile(name) {
  const lower = String(name || '').toLowerCase();
  return lower.endsWith('.orch-graph.json') || lower.endsWith('.orch-tree.json') || lower.endsWith('.orch');
}

function isRunbookFile(name) {
  return isPipelineFile(name) || isLegacyRunbookFile(name);
}

async function readPipelineManifestSummary(filePath) {
  const fallback = path.basename(path.dirname(filePath));
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, 'utf-8'));
    return {
      displayName: parsed.title || parsed.name || parsed.id || fallback,
      pipelineId: parsed.id || fallback,
      description: parsed.description || '',
    };
  } catch {
    return {
      displayName: fallback,
      pipelineId: fallback,
      description: '',
    };
  }
}

function isRiskyWorkspaceFile(name) {
  const lower = String(name || '').toLowerCase();
  return lower === '.env'
    || lower.startsWith('.env.')
    || lower.includes('secret')
    || lower.includes('token')
    || lower.includes('password')
    || lower.endsWith('.pem')
    || lower.endsWith('.key')
    || lower.endsWith('.p12')
    || lower.endsWith('.pfx');
}

function isPipelineGeneratedHarnessDir(workspaceRoot, dirPath) {
  const relativeParts = path.relative(workspaceRoot, dirPath)
    .split(/[\\/]+/)
    .filter(Boolean);

  for (let index = 0; index <= relativeParts.length - 5; index += 1) {
    if (
      relativeParts[index] === '.orpad'
      && relativeParts[index + 1] === 'pipelines'
      && relativeParts[index + 3] === 'harness'
      && relativeParts[index + 4] === 'generated'
    ) {
      return true;
    }
  }

  return false;
}

async function scanRunbookWorkspace(workspaceRoot) {
  const extCounts = new Map();
  const runbooks = [];
  const pipelines = [];
  const legacyRunbooks = [];
  const risky = [];
  let fileCount = 0;
  let dirCount = 0;
  let markdownCount = 0;
  let dataCount = 0;
  let diagramCount = 0;
  let logCount = 0;
  let hasObsidian = false;
  let hasRuns = false;
  let scannedEntries = 0;
  let truncated = false;

  async function walk(dirPath, depth) {
    if (depth > RUNBOOK_SCAN_MAX_DEPTH || scannedEntries >= RUNBOOK_SCAN_MAX_ENTRIES) {
      truncated = true;
      return;
    }

    let entries = [];
    try {
      entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (scannedEntries >= RUNBOOK_SCAN_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;

      scannedEntries += 1;
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        dirCount += 1;
        if (entry.name === '.obsidian') {
          hasObsidian = true;
          continue;
        }
        if (entry.name === '.orch-runs') {
          hasRuns = true;
          continue;
        }
        if (entry.name === 'runs' && entryPath.includes(`${path.sep}.orpad${path.sep}pipelines${path.sep}`)) {
          hasRuns = true;
          continue;
        }
        if (isPipelineGeneratedHarnessDir(workspaceRoot, entryPath)) continue;
        if (RUNBOOK_SCAN_IGNORED_DIRS.has(entry.name)) continue;
        await walk(entryPath, depth + 1);
      } else if (entry.isFile()) {
        fileCount += 1;
        const ext = runbookExt(entry.name);
        const item = { name: entry.name, path: entryPath, kind: 'file' };
        extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
        if (isPipelineFile(entry.name)) {
          const manifestSummary = await readPipelineManifestSummary(entryPath);
          item.format = 'or-pipeline';
          item.displayName = manifestSummary.displayName;
          item.pipelineId = manifestSummary.pipelineId;
          item.description = manifestSummary.description;
          pipelines.push(item);
          runbooks.push(item);
        } else if (isLegacyRunbookFile(entry.name)) {
          item.format = entry.name.toLowerCase().endsWith('.orch-graph.json') ? 'orch-graph' : 'orch-tree';
          legacyRunbooks.push(item);
          runbooks.push(item);
        }
        if (isRiskyWorkspaceFile(entry.name)) risky.push(item);
        if (['md', 'markdown', 'mkd', 'mdx'].includes(ext)) markdownCount += 1;
        if (['json', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'xml', 'ini', 'conf', 'properties', 'env'].includes(ext)) dataCount += 1;
        if (['mmd', 'mermaid'].includes(ext)) diagramCount += 1;
        if (ext === 'log') logCount += 1;
      }
    }
  }

  await walk(workspaceRoot, 0);

  let workspaceType = 'Project workspace';
  if (hasObsidian && pipelines.length) workspaceType = 'Obsidian + OrPAD Pipeline workspace';
  else if (hasObsidian && runbooks.length) workspaceType = 'Obsidian + Legacy Runbook workspace';
  else if (hasObsidian) workspaceType = 'Obsidian vault';
  else if (pipelines.length) workspaceType = 'OrPAD Pipeline workspace';
  else if (runbooks.length) workspaceType = 'Legacy Runbook workspace';

  return {
    source: 'scanner',
    workspaceType,
    files: [],
    dirs: [],
    fileCount,
    dirCount,
    runbooks,
    pipelines,
    legacyRunbooks,
    risky,
    hasObsidian,
    hasRuns,
    markdownCount,
    dataCount,
    diagramCount,
    logCount,
    truncated,
    topExts: [...extCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
}

async function scanAndCacheRunbookWorkspace(app, workspaceRoot) {
  const summary = await scanRunbookWorkspace(workspaceRoot);
  if (app) {
    try {
      summary.cache = await writeWorkspaceIndexCache(app, workspaceRoot, summary);
    } catch (err) {
      summary.cache = { error: err.message };
    }
  }
  return summary;
}

async function isRecordedPipelineRunDir(workspaceRoot, targetRunDir) {
  try {
    const run = JSON.parse(await fsp.readFile(path.join(targetRunDir, 'run.or-run'), 'utf-8'));
    const pipelineRel = run.pipelinePath || (run.targetKind === 'pipeline' ? run.targetPath : '');
    if (!pipelineRel) return false;
    const pipelinePath = path.resolve(workspaceRoot, pipelineRel);
    if (!/\.or-pipeline$/i.test(pipelinePath) || !isInsidePath(pipelinePath, workspaceRoot)) return false;
    return isInsidePath(targetRunDir, runRoot(workspaceRoot, pipelinePath));
  } catch {
    return false;
  }
}

async function auditPipelineRunEvidence(pipelinePath) {
  const appRoot = path.join(__dirname, '..', '..', '..');
  const scriptPath = path.join(appRoot, 'scripts', 'audit-orpad-run.mjs');
  const execBaseName = path.basename(process.execPath || '').toLowerCase();
  const useElectronAsNode = execBaseName.includes('electron');
  const nodeBinary = process.execPath || process.env.npm_node_execpath || process.env.NODE || 'node';
  let stdout = '';
  try {
    const result = await execFileAsync(nodeBinary, [scriptPath, pipelinePath], {
      cwd: appRoot,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      env: useElectronAsNode ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
      windowsHide: true,
    });
    stdout = result.stdout || '';
  } catch (err) {
    stdout = err?.stdout || '';
    if (!stdout.trim()) throw err;
  }
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Run evidence audit returned invalid JSON: ${err.message}`);
  }
}

function registerRunbookHandlers({ ipcMain, app, authority }) {
  const validateTextHandler = async (_event, source, options = {}) => {
    return validateRunbookSource(source, {
      trustLevel: normalizeTrustLevel(options),
      checkFiles: false,
    });
  };

  const validateFileHandler = async (event, filePath, options = {}) => {
    try {
      const target = await authority.assertWorkspacePath(event.sender, filePath, {
        label: 'Pipeline file',
        allowFileCapability: true,
      });
      return await validateRunbookFile(target, {
        trustLevel: normalizeTrustLevel(options),
        checkFiles: options.checkFiles !== false,
      });
    } catch (err) {
      return {
        ok: false,
        canExecute: false,
        trustLevel: normalizeTrustLevel(options),
        schemaVersion: '',
        treeCount: 0,
        nodeCount: 0,
        nodeTypes: [],
        executableNodeTypes: [],
        renderOnlyNodeTypes: [],
        diagnostics: [
          {
            level: 'error',
            code: 'RUNBOOK_VALIDATE_FAILED',
            message: err.message,
          },
        ],
      };
    }
  };

  const createRunRecordHandler = async (event, workspacePath, runbookPath, options = {}) => {
    try {
      const workspaceRoot = await workspaceRootForRun(event, authority, workspacePath);
      const targetRunbook = await authority.assertWorkspacePath(event.sender, runbookPath, {
        label: 'Pipeline file',
      });
      const validation = await validateRunbookFile(targetRunbook, {
        trustLevel: normalizeTrustLevel(options),
        checkFiles: options.checkFiles !== false,
      });
      if (!validation.ok) {
        return { error: 'Pipeline validation failed.', validation };
      }
      const result = await createRunRecord({
        workspaceRoot,
        runbookPath: targetRunbook,
        validation,
        createdBy: 'orpad-local',
        title: options.title || path.basename(targetRunbook),
      });
      return { success: true, ...result, validation };
    } catch (err) {
      return { error: err.message };
    }
  };

  const scanWorkspaceHandler = async (event, workspacePath) => {
    try {
      const workspaceRoot = await workspaceRootForRun(event, authority, workspacePath);
      return { success: true, ...(await scanAndCacheRunbookWorkspace(app, workspaceRoot)) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  };

  const readWorkspaceIndexHandler = async (event, workspacePath) => {
    try {
      const workspaceRoot = await workspaceRootForRun(event, authority, workspacePath);
      return { success: true, index: await readWorkspaceIndexCache(app, workspaceRoot) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  };

  const startLocalRunHandler = async (event, workspacePath, runbookPath, options = {}) => {
    try {
      const workspaceRoot = await workspaceRootForRun(event, authority, workspacePath);
      const targetRunbook = await authority.assertWorkspacePath(event.sender, runbookPath, {
        label: 'Pipeline file',
      });
      const validation = await validateRunbookFile(targetRunbook, {
        trustLevel: normalizeTrustLevel(options),
        checkFiles: options.checkFiles !== false,
      });
      if (!validation.ok || !validation.canExecute) {
        return { error: 'Pipeline is not executable in the local MVP.', validation };
      }
      const workspaceSummary = await scanAndCacheRunbookWorkspace(app, workspaceRoot);
      const result = await startLocalRun({
        workspaceRoot,
        runbookPath: targetRunbook,
        validation,
        workspaceSummary,
        approval: options.approval,
        title: options.title || path.basename(targetRunbook),
      });
      return { success: true, ...result, validation };
    } catch (err) {
      return { error: err.message };
    }
  };

  const readRunRecordHandler = async (event, workspacePath, runDir) => {
    try {
      const workspaceRoot = await workspaceRootForRun(event, authority, workspacePath);
      const targetRunDir = authority.assertWorkspacePath(event.sender, runDir, {
        label: 'Run directory',
      });
      const inLegacyRuns = isInsidePath(targetRunDir, path.join(workspaceRoot, '.orch-runs'));
      const inPipelineRuns = isInsidePath(targetRunDir, path.join(workspaceRoot, '.orpad', 'pipelines'))
        && targetRunDir.split(/[\\/]/).includes('runs');
      const inRecordedPipelineRuns = await isRecordedPipelineRunDir(workspaceRoot, targetRunDir);
      if (!inLegacyRuns && !inPipelineRuns && !inRecordedPipelineRuns) {
        throw new Error('Run directory must be inside .orch-runs, .orpad/pipelines/*/runs, or the recorded runs directory for a workspace .or-pipeline.');
      }
      return { success: true, ...(await readRunRecord(targetRunDir)) };
    } catch (err) {
      return { error: err.message };
    }
  };

  const auditRunEvidenceHandler = async (event, workspacePath, pipelinePath) => {
    try {
      await workspaceRootForRun(event, authority, workspacePath);
      const targetPipeline = await authority.assertWorkspacePath(event.sender, pipelinePath, {
        label: 'Pipeline file',
      });
      if (!/\.or-pipeline$/i.test(targetPipeline)) {
        throw new Error('Run evidence audit requires an .or-pipeline file.');
      }
      return { success: true, ...(await auditPipelineRunEvidence(targetPipeline)) };
    } catch (err) {
      return { success: false, ok: false, error: err.message, diagnostics: [{ level: 'error', code: 'RUN_AUDIT_FAILED', message: err.message }] };
    }
  };

  ipcMain.handle('runbook-validate-text', validateTextHandler);
  ipcMain.handle('runbook-validate-file', validateFileHandler);
  ipcMain.handle('runbook-create-run-record', createRunRecordHandler);
  ipcMain.handle('runbook-scan-workspace', scanWorkspaceHandler);
  ipcMain.handle('runbook-read-workspace-index', readWorkspaceIndexHandler);
  ipcMain.handle('runbook-start-local-run', startLocalRunHandler);
  ipcMain.handle('runbook-read-run-record', readRunRecordHandler);
  ipcMain.handle('runbook-audit-run-evidence', auditRunEvidenceHandler);

  ipcMain.handle('pipeline-validate-text', validateTextHandler);
  ipcMain.handle('pipeline-validate-file', validateFileHandler);
  ipcMain.handle('pipeline-create-run-record', createRunRecordHandler);
  ipcMain.handle('pipeline-scan-workspace', scanWorkspaceHandler);
  ipcMain.handle('pipeline-read-workspace-index', readWorkspaceIndexHandler);
  ipcMain.handle('pipeline-start-local-run', startLocalRunHandler);
  ipcMain.handle('pipeline-read-run-record', readRunRecordHandler);
  ipcMain.handle('pipeline-audit-run-evidence', auditRunEvidenceHandler);
}

module.exports = {
  registerRunbookHandlers,
  scanAndCacheRunbookWorkspace,
  scanRunbookWorkspace,
};
