const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('orpad', {
  platform: process.platform,
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  // File operations
  onLoadMarkdown: (cb) => ipcRenderer.on('load-markdown', (_e, d) => cb(d)),
  getSystemTheme: () => ipcRenderer.invoke('get-system-theme'),
  // Fire-and-forget: lets main create future windows with a matching backgroundColor.
  setThemeBackground: (color) => ipcRenderer.send('set-theme-background', color),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  saveFile: (filePath, content) => ipcRenderer.invoke('save-file', filePath, content),
  saveFileAs: (content) => ipcRenderer.invoke('save-file-as', content),
  dropFile: (file) => {
    let filePath = '';
    if (typeof file === 'string') {
      filePath = process.env.ORPAD_TEST_USER_DATA ? file : '';
    } else {
      try {
        filePath = webUtils.getPathForFile(file);
      } catch {
        filePath = '';
      }
    }
    if (filePath) ipcRenderer.send('drop-file', filePath);
  },
  getPathForFile: (f) => {
    if (typeof f === 'string' && process.env.ORPAD_TEST_USER_DATA) return f;
    return webUtils.getPathForFile(f);
  },
  openDefaultAppsSettings: () => ipcRenderer.invoke('open-default-apps-settings'),
  showSaveDialog: () => ipcRenderer.invoke('show-save-dialog'),
  onCheckBeforeClose: (cb) => ipcRenderer.on('check-before-close', () => cb()),
  onNewFromTemplate: (cb) => ipcRenderer.on('new-from-template', () => cb()),
  confirmClose: () => ipcRenderer.send('confirm-close'),
  getLocale: () => ipcRenderer.invoke('get-locale'),
  setLocale: (code) => ipcRenderer.send('set-locale', code),
  onLocaleChanged: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('locale-changed', listener);
    return () => ipcRenderer.removeListener('locale-changed', listener);
  },
  autoSaveRecovery: (filePath, content) => ipcRenderer.invoke('auto-save-recovery', filePath, content),
  clearRecovery: (filePath) => ipcRenderer.invoke('clear-recovery', filePath),
  saveImage: (filePath, buffer, ext) => ipcRenderer.invoke('save-image', filePath, buffer, ext),
  setTitle: (title) => ipcRenderer.send('set-title', title),
  // File tree & workspace
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  gitFs: {
    readFile: (filePath, options) => ipcRenderer.invoke('git-fs.readFile', filePath, options),
    writeFile: (filePath, data, options) => ipcRenderer.invoke('git-fs.writeFile', filePath, data, options),
    unlink: (filePath) => ipcRenderer.invoke('git-fs.unlink', filePath),
    readdir: (dirPath, options) => ipcRenderer.invoke('git-fs.readdir', dirPath, options),
    mkdir: (dirPath, options) => ipcRenderer.invoke('git-fs.mkdir', dirPath, options),
    rmdir: (dirPath) => ipcRenderer.invoke('git-fs.rmdir', dirPath),
    stat: (targetPath) => ipcRenderer.invoke('git-fs.stat', targetPath),
    lstat: (targetPath) => ipcRenderer.invoke('git-fs.lstat', targetPath),
  },
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  getApprovedWorkspace: () => ipcRenderer.invoke('get-approved-workspace'),
  readDirectory: (dirPath) => ipcRenderer.invoke('read-directory', dirPath),
  watchDirectory: (dirPath) => ipcRenderer.invoke('watch-directory', dirPath),
  unwatchDirectory: () => ipcRenderer.invoke('unwatch-directory'),
  onDirectoryChanged: (cb) => ipcRenderer.on('directory-changed', (_e, d) => cb(d)),
  createFile: (filePath) => ipcRenderer.invoke('create-file', filePath),
  createFolder: (folderPath) => ipcRenderer.invoke('create-folder', folderPath),
  renameFile: (oldPath, newPath) => ipcRenderer.invoke('rename-file', oldPath, newPath),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  // Search
  searchFiles: (dirPath, query, options) => ipcRenderer.invoke('search-files', dirPath, query, options),
  // Link index
  buildLinkIndex: (dirPath) => ipcRenderer.invoke('build-link-index', dirPath),
  resolveWikiLink: (dirPath, target) => ipcRenderer.invoke('resolve-wiki-link', dirPath, target),
  getBacklinks: (dirPath, filePath) => ipcRenderer.invoke('get-backlinks', dirPath, filePath),
  getLinkGraph: (dirPath) => ipcRenderer.invoke('get-link-graph', dirPath),
  getFileNames: (dirPath) => ipcRenderer.invoke('get-file-names', dirPath),
  runbooks: {
    validateText: (source, options) => ipcRenderer.invoke('runbook-validate-text', source, options),
    validateFile: (filePath, options) => ipcRenderer.invoke('runbook-validate-file', filePath, options),
    createRunRecord: (workspacePath, runbookPath, options) => ipcRenderer.invoke('runbook-create-run-record', workspacePath, runbookPath, options),
    scanWorkspace: (workspacePath) => ipcRenderer.invoke('runbook-scan-workspace', workspacePath),
    readWorkspaceIndex: (workspacePath) => ipcRenderer.invoke('runbook-read-workspace-index', workspacePath),
    startLocalRun: (workspacePath, runbookPath, options) => ipcRenderer.invoke('runbook-start-local-run', workspacePath, runbookPath, options),
    readRunRecord: (workspacePath, runDir) => ipcRenderer.invoke('runbook-read-run-record', workspacePath, runDir),
    auditRunEvidence: (workspacePath, runbookPath) => ipcRenderer.invoke('runbook-audit-run-evidence', workspacePath, runbookPath),
  },
  pipelines: {
    validateText: (source, options) => ipcRenderer.invoke('pipeline-validate-text', source, options),
    validateFile: (filePath, options) => ipcRenderer.invoke('pipeline-validate-file', filePath, options),
    createRunRecord: (workspacePath, pipelinePath, options) => ipcRenderer.invoke('pipeline-create-run-record', workspacePath, pipelinePath, options),
    scanWorkspace: (workspacePath) => ipcRenderer.invoke('pipeline-scan-workspace', workspacePath),
    readWorkspaceIndex: (workspacePath) => ipcRenderer.invoke('pipeline-read-workspace-index', workspacePath),
    startLocalRun: (workspacePath, pipelinePath, options) => ipcRenderer.invoke('pipeline-start-local-run', workspacePath, pipelinePath, options),
    readRunRecord: (workspacePath, runDir) => ipcRenderer.invoke('pipeline-read-run-record', workspacePath, runDir),
    auditRunEvidence: (workspacePath, pipelinePath) => ipcRenderer.invoke('pipeline-audit-run-evidence', workspacePath, pipelinePath),
  },
  orchestrationWindow: {
    open: (request = {}) => ipcRenderer.invoke('orchestration-window-open', request),
    focus: (request = {}) => ipcRenderer.invoke('orchestration-window-focus', request),
    status: (request = {}) => ipcRenderer.invoke('orchestration-window-status', request),
  },
  // Right-sized governed-delegation core (orchestration-core). Streams an
  // emergent-graph trace live on 'orpad-core-trace'; onCoreTrace returns an
  // unsubscribe function (mirrors the machine/orchestration channel pattern).
  core: {
    startRun: (request = {}) => ipcRenderer.invoke('orpad-core-run-start', request),
    continueRun: (request = {}) => ipcRenderer.invoke('orpad-core-run-continue', request),
    observeStart: (request = {}) => ipcRenderer.invoke('orpad-core-observe-start', request),
    observeStop: (runId) => ipcRenderer.invoke('orpad-core-observe-stop', { runId }),
    observeReattach: () => ipcRenderer.invoke('orpad-core-observe-reattach'),
    stopRun: (runId) => ipcRenderer.invoke('orpad-core-run-stop', { runId }),
    replayTrace: (request = {}) => ipcRenderer.invoke('orpad-core-run-replay', request),
    listRuns: () => ipcRenderer.invoke('orpad-core-list-runs'),
    onCoreTrace: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on('orpad-core-trace', listener);
      return () => ipcRenderer.removeListener('orpad-core-trace', listener);
    },
    // Seed pushed to the Run GUI window from a terminal AI-CLI launch.
    onSeed: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on('orpad-core-seed', listener);
      return () => ipcRenderer.removeListener('orpad-core-seed', listener);
    },
    // Race-proof pull: the Run GUI fetches any seed stashed for it on init (in case the push fired first).
    pullSeed: () => ipcRenderer.invoke('orpad-core-pull-seed'),
  },
  userSnippets: {
    read: () => ipcRenderer.invoke('snippets-read'),
    ensure: () => ipcRenderer.invoke('snippets-ensure'),
    watch: () => ipcRenderer.invoke('snippets-watch'),
    onChanged: (cb) => {
      const listener = () => cb();
      ipcRenderer.on('snippets-changed', listener);
      return () => ipcRenderer.removeListener('snippets-changed', listener);
    },
  },
  revealInExplorer: (targetPath) => ipcRenderer.invoke('reveal-in-explorer', targetPath),
  saveBinary: (name, buffer) => ipcRenderer.invoke('save-binary', name, buffer),
  saveText: (name, text) => ipcRenderer.invoke('save-text', name, text),
  svgToPng: (svg, width, height, bg) => ipcRenderer.invoke('svg-to-png', svg, width, height, bg),
  // Auto-update
  onShowUpdateDialog: (cb) => ipcRenderer.on('show-update-dialog', (_e, d) => cb(d)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_e, p) => cb(p)),
  onUpdateError: (cb) => ipcRenderer.on('update-error', (_e, m) => cb(m)),
  updateAction: (action) => ipcRenderer.send('update-action', action),
});

contextBridge.exposeInMainWorld('terminal', {
  history: () => ipcRenderer.invoke('terminal.history'),
  run: (request) => ipcRenderer.invoke('terminal.run', request),
  cancel: (runId) => ipcRenderer.invoke('terminal.cancel', runId),
  status: () => ipcRenderer.invoke('terminal.status'),
  onEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('terminal.event', listener);
    return () => ipcRenderer.removeListener('terminal.event', listener);
  },
});

contextBridge.exposeInMainWorld('terminalWindow', {
  open: (request) => ipcRenderer.invoke('terminal-window-open', request),
  focus: () => ipcRenderer.invoke('terminal-window-focus'),
  status: () => ipcRenderer.invoke('terminal-window-status'),
  dockToMain: () => ipcRenderer.invoke('terminal-window-dock-main'),
  context: () => ipcRenderer.invoke('terminal-window-context'),
  onDocked: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('terminal-window-docked', listener);
    return () => ipcRenderer.removeListener('terminal-window-docked', listener);
  },
});

contextBridge.exposeInMainWorld('pty', {
  status: () => ipcRenderer.invoke('terminal.pty.status'),
  shells: () => ipcRenderer.invoke('terminal.pty.shells'),
  restore: () => ipcRenderer.invoke('terminal.pty.restore'),
  spawn: (request) => ipcRenderer.invoke('terminal.pty.spawn', request),
  write: (sessionId, data) => ipcRenderer.invoke('terminal.pty.write', sessionId, data),
  resize: (sessionId, cols, rows) => ipcRenderer.invoke('terminal.pty.resize', sessionId, cols, rows),
  kill: (sessionId) => ipcRenderer.invoke('terminal.pty.kill', sessionId),
  onEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('terminal.pty.event', listener);
    return () => ipcRenderer.removeListener('terminal.pty.event', listener);
  },
});

// System clipboard bridge — the renderer is sandboxed, so navigator.clipboard is unreliable; route copy/paste
// (and a TUI's OSC 52 clipboard writes) through the Electron main-process clipboard, which always reaches the OS.
contextBridge.exposeInMainWorld('clipboard', {
  writeText: (text) => ipcRenderer.invoke('clipboard.write-text', String(text == null ? '' : text)),
  readText: () => ipcRenderer.invoke('clipboard.read-text'),
  hasImage: () => ipcRenderer.invoke('clipboard.has-image'),
});
