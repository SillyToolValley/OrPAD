try { require("v8-compile-cache"); } catch {}
const { app, BrowserWindow, ipcMain, nativeTheme, dialog, shell, session, safeStorage, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const crypto = require('crypto');
const { registerRunbookHandlers } = require('./runbooks/ipc');
const { registerCoreRunHandlers } = require('./orchestration-core/ipc.cjs');
const { registerTerminalHandlers } = require('./terminal/ipc');
const { createAuthorityManager, isInsidePath, normalizeForCompare } = require('./authority');

const windows = new Set();
const terminalWindows = new Set();
const orchestrationWindows = new Set();
const terminalWindowContexts = new Map();
const orchestrationWindowContexts = new Map();
const pendingOrchestrationSeeds = new Map(); // webContentsId -> seed, awaiting the Run GUI renderer's pull
const watchers = new Map();
const snippetWatchers = new Map();
const authority = createAuthorityManager();

if (!app.isPackaged && process.env.ORPAD_TEST_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.ORPAD_TEST_USER_DATA));
}

// --- Sentry (main process) ---
// TODO: wire DEFAULT_SENTRY_DSN in the build config once the project's Sentry org is set up.
if (process.env.SENTRY_DSN) {
  const Sentry = require('@sentry/electron/main');
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: `orpad@${require('../../package.json').version}`,
    environment: app.isPackaged ? 'production' : 'development',
    tracesSampleRate: 0.1,
    beforeSend(event) {
      if (event.breadcrumbs?.values) {
        for (const bc of event.breadcrumbs.values) {
          if (typeof bc.message === 'string') {
            bc.message = bc.message.replace(/[^/\\]+\.(?:env|key|pem)\b/gi, '<redacted>');
          }
        }
      }
      delete event.user;
      return event;
    },
  });
} else {
  console.info('[OrPAD] SENTRY_DSN not set — crash reporting disabled');
}

// --- Locale ---
const localeData = {
  en: require('../locales/en.json'),
  ko: require('../locales/ko.json'),
  zh: require('../locales/zh.json'),
  'zh-TW': require('../locales/zh-TW.json'),
  ja: require('../locales/ja.json'),
  es: require('../locales/es.json'),
  fr: require('../locales/fr.json'),
  de: require('../locales/de.json'),
  pt: require('../locales/pt.json'),
  ru: require('../locales/ru.json'),
  ar: require('../locales/ar.json'),
  hi: require('../locales/hi.json'),
  it: require('../locales/it.json'),
  nl: require('../locales/nl.json'),
  pl: require('../locales/pl.json'),
  tr: require('../locales/tr.json'),
  vi: require('../locales/vi.json'),
  th: require('../locales/th.json'),
  sv: require('../locales/sv.json'),
  da: require('../locales/da.json'),
  fi: require('../locales/fi.json'),
  nb: require('../locales/nb.json'),
  cs: require('../locales/cs.json'),
  el: require('../locales/el.json'),
  hu: require('../locales/hu.json'),
  ro: require('../locales/ro.json'),
  uk: require('../locales/uk.json'),
  id: require('../locales/id.json'),
  ms: require('../locales/ms.json'),
  he: require('../locales/he.json'),
};
let appLocale = 'en';
let appStrings = localeData.en;

const LCID_MAP = {
  1033:'en',1042:'ko',2052:'zh',1028:'zh-TW',1041:'ja',1034:'es',1036:'fr',
  1031:'de',1046:'pt',1049:'ru',1025:'ar',1081:'hi',1040:'it',1043:'nl',
  1045:'pl',1055:'tr',1066:'vi',1054:'th',1053:'sv',1030:'da',1035:'fi',
  1044:'nb',1029:'cs',1032:'el',1038:'hu',1048:'ro',1058:'uk',1057:'id',
  1086:'ms',1037:'he',
};

function resolveLocale(raw) {
  if (!raw) return null;
  if (localeData[raw]) return raw;
  const lcid = parseInt(raw);
  if (!isNaN(lcid) && LCID_MAP[lcid] && localeData[LCID_MAP[lcid]]) return LCID_MAP[lcid];
  return null;
}

function initLocale() {
  const log = [];
  const tryPaths = [
    path.join(path.dirname(app.getPath('exe')), 'resources', 'locale'),
    path.join(process.resourcesPath, 'locale'),
  ];
  let found = false;
  for (const p of tryPaths) {
    try {
      const raw = fs.readFileSync(p, 'utf-8').trim();
      const code = resolveLocale(raw);
      log.push(`file: ${p} | raw="${raw}" | resolved=${code}`);
      if (code) { appLocale = code; appStrings = localeData[code]; found = true; log.push(`SET: ${code}`); break; }
    } catch (e) { log.push(`file: ${p} | error: ${e.message}`); }
  }
  if (!found) {
    try {
      const { execSync } = require('child_process');
      const out = execSync('reg query "HKLM\\Software\\OrPAD" /v Locale 2>nul', { encoding: 'utf-8' });
      const m = out.match(/Locale\s+REG_SZ\s+(\S+)/);
      if (m) {
        const code = resolveLocale(m[1]);
        log.push(`reg: raw="${m[1]}" | resolved=${code}`);
        if (code) { appLocale = code; appStrings = localeData[code]; found = true; log.push(`SET: ${code}`); }
      }
    } catch (e) { log.push(`reg error: ${e.message}`); }
  }
  if (!found) {
    const sysLocale = app.getLocale();
    const sysCode = sysLocale.split('-')[0];
    log.push(`system: ${sysLocale} → ${sysCode}`);
    if (localeData[sysCode]) { appLocale = sysCode; appStrings = localeData[sysCode]; log.push(`SET: ${sysCode}`); }
  }
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'locale-debug.txt'), log.join('\n'), 'utf-8'); } catch {}
}

function t(key) { return appStrings[key] || localeData.en[key] || key; }

function broadcastLocaleChanged() {
  const payload = { code: appLocale };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('locale-changed', payload);
  }
}

// --- Single instance lock ---
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) app.quit();

app.on('second-instance', (_event, argv) => {
  const filePath = getFilePathFromArgs(argv);
  if (windows.size > 0) {
    const win = windows.values().next().value;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (filePath) loadMarkdownFile(win, filePath);
  } else if (filePath) {
    createWindow(filePath);
  } else {
    createWindow(null);
  }
});

// --- Supported file formats ---
// SUPPORTED_EXTS is the allow-list shown in open/save dialog filters (UX hint).
// isSupportedFile uses a binary block-list so that unknown text files still open.
const SUPPORTED_EXTS = [
  'md', 'markdown', 'mkd', 'mdx', 'mmd',
  'json', 'jsonl', 'ndjson', 'yaml', 'yml',
  'html', 'htm', 'xml', 'csv', 'tsv', 'toml', 'ini', 'conf', 'properties', 'env', 'log', 'txt',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx',
  'css', 'scss', 'sass', 'less',
  'py', 'pyw', 'java', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'cs', 'go', 'rs',
  'php', 'phtml', 'rb', 'swift', 'kt', 'kts', 'dart', 'sh', 'bash', 'zsh', 'ps1', 'psm1',
  'sql', 'lua', 'r', 'pl', 'pm', 'vue', 'svelte', 'proto', 'diff', 'patch', 'svg',
  'or-pipeline', 'or-graph', 'or-tree', 'or-rule', 'or-run',
];
const BINARY_EXTS = new Set([
  'exe','dll','so','dylib','bin','msi','app','class','jar',
  'zip','rar','7z','tar','gz','bz2','xz',
  'png','jpg','jpeg','gif','bmp','ico','webp','tiff',
  'mp4','avi','mov','wmv','mkv','webm','mp3','wav','ogg','flac','m4a',
  'pdf','doc','docx','xls','xlsx','ppt','pptx',
  'db','sqlite',
]);
function isSupportedFile(filePath) {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  return !BINARY_EXTS.has(ext);
}

// --- Arg parsing ---
function isLaunchEntrypointArg(arg) {
  const resolved = path.resolve(String(arg || ''));
  const appRoot = path.resolve(__dirname, '../..');
  const mainEntry = path.resolve(__dirname, 'main.js');
  return resolved === appRoot || resolved === mainEntry;
}

function getFilePathFromArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(1) : [];
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.startsWith('-')) continue;
    const resolved = path.resolve(arg);
    if (isLaunchEntrypointArg(resolved)) continue;
    if (!isSupportedFile(resolved)) continue;
    try {
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {}
  }
  return null;
}

// --- Window ---
function createWindow(filePath) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    icon: path.join(__dirname, '../../assets/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep timers/rAF running at full rate when the window is blurred/occluded. Without this Electron throttles
      // background rendering, so a live terminal (or the observe graph) stops updating while unfocused and then
      // floods through a huge backlog on refocus — the cause of the "lag when not focused" stutter.
      backgroundThrottling: false,
    },
    show: false,
    backgroundColor: windowBackgroundColor(),
    title: 'OrPAD',
  });
  const windowId = win.id;
  const webContentsId = win.webContents.id;
  const webContents = win.webContents;

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Disable Electron's built-in Ctrl+Wheel zoom (handled in renderer)
  webContents.setVisualZoomLevelLimits(1, 1);

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.show();
  });

  webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    if (filePath) loadMarkdownFile(win, filePath);
  });

  win.on('closed', () => {
    windows.delete(win);
    authority.forget({ id: webContentsId });
    const entry = watchers.get(windowId);
    if (entry) {
      entry.watcher.close();
      if (entry.flushTimer) clearTimeout(entry.flushTimer);
      watchers.delete(windowId);
    }
    if (windows.size === 0) closeTerminalWindows();
  });

  webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Unsaved changes protection
  win.on('close', (e) => {
    if (win._forceClose) return;
    if (webContents.isDestroyed()) return;
    e.preventDefault();
    webContents.send('check-before-close');
  });

  webContents.on('render-process-gone', () => {
    win._forceClose = true;
  });

  windows.add(win);
  return win;
}

function clampNumber(value, min, max, fallback) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}

function terminalWindowBounds(requested = {}, openerWindow = null) {
  const width = clampNumber(requested.width, 560, 1800, 920);
  const height = clampNumber(requested.height, 360, 1200, 620);
  const openerBounds = openerWindow?.getBounds?.() || null;
  const fallbackPoint = openerBounds
    ? { x: openerBounds.x + Math.round(openerBounds.width / 2), y: openerBounds.y + Math.round(openerBounds.height / 2) }
    : screen.getCursorScreenPoint();
  const rawX = Number(requested.x);
  const rawY = Number(requested.y);
  const point = {
    x: Number.isFinite(rawX) ? rawX : fallbackPoint.x - Math.round(width / 2),
    y: Number.isFinite(rawY) ? rawY : fallbackPoint.y - Math.round(height / 2),
  };
  const display = screen.getDisplayNearestPoint({
    x: point.x + Math.round(width / 2),
    y: point.y + Math.round(height / 2),
  });
  const area = display.workArea;
  return {
    width,
    height,
    x: Math.round(clampNumber(point.x, area.x, area.x + area.width - width, area.x)),
    y: Math.round(clampNumber(point.y, area.y, area.y + area.height - height, area.y)),
  };
}

function activeTerminalWindow() {
  for (const win of terminalWindows) {
    if (win && !win.isDestroyed()) return win;
  }
  return null;
}

function focusTerminalWindow(win = activeTerminalWindow()) {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}

function closeTerminalWindows() {
  for (const win of Array.from(terminalWindows)) {
    if (!win || win.isDestroyed()) continue;
    win.close();
  }
}

function orchestrationWindowContextMatches(context = {}, target = {}) {
  const targetWorkspace = target.workspaceRoot ? normalizeForCompare(target.workspaceRoot) : '';
  const contextWorkspace = context.workspaceRoot ? normalizeForCompare(context.workspaceRoot) : '';
  const targetOpener = Number(target.openerWebContentsId || 0);
  const contextOpener = Number(context.openerWebContentsId || 0);
  if (targetOpener && contextOpener && targetOpener !== contextOpener) return false;
  if (targetWorkspace && contextWorkspace && targetWorkspace !== contextWorkspace) return false;
  if (targetWorkspace && !contextWorkspace) return false;
  if (targetOpener && !contextOpener) return false;
  return true;
}

function activeOrchestrationWindow(target = {}) {
  for (const win of orchestrationWindows) {
    if (!win || win.isDestroyed()) continue;
    const hasTarget = !!(target.openerWebContentsId || target.workspaceRoot);
    if (!hasTarget) return win;
    const context = orchestrationWindowContexts.get(win.webContents.id) || {};
    if (orchestrationWindowContextMatches(context, target)) return win;
  }
  return null;
}

function focusOrchestrationWindow(win = activeOrchestrationWindow()) {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}

function mainWindowForTerminalContext(context = {}) {
  const openerId = Number(context.openerWebContentsId || 0);
  for (const win of windows) {
    if (!win.isDestroyed() && win.webContents.id === openerId) return win;
  }
  for (const win of windows) {
    if (!win.isDestroyed()) return win;
  }
  return null;
}

async function orchestrationWorkspaceForRequest(event, request = {}) {
  const grantedWorkspace = await existingWorkspaceRoot(authority.getWorkspaceRoot(event.sender));
  if (grantedWorkspace) return path.resolve(String(grantedWorkspace));
  const approvedWorkspace = await readApprovedWorkspace();
  if (approvedWorkspace) return path.resolve(String(approvedWorkspace));
  return '';
}

async function orchestrationWindowTargetForRequest(event, request = {}) {
  return {
    openerWebContentsId: event.sender?.id || 0,
    workspaceRoot: await orchestrationWorkspaceForRequest(event, request),
  };
}

function createTerminalWindow({ openerWebContents, workspaceRoot = '', cwd = '', bounds = null } = {}) {
  const openerWindow = openerWebContents ? BrowserWindow.fromWebContents(openerWebContents) : null;
  const safeBounds = terminalWindowBounds(bounds || {}, openerWindow);
  const win = new BrowserWindow({
    ...safeBounds,
    minWidth: 560,
    minHeight: 360,
    icon: path.join(__dirname, '../../assets/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep timers/rAF running at full rate when the window is blurred/occluded. Without this Electron throttles
      // background rendering, so a live terminal (or the observe graph) stops updating while unfocused and then
      // floods through a huge backlog on refocus — the cause of the "lag when not focused" stutter.
      backgroundThrottling: false,
    },
    show: false,
    backgroundColor: windowBackgroundColor(),
    title: 'OrPAD Terminal',
  });
  const webContentsId = win.webContents.id;
  const context = {
    openerWebContentsId: openerWebContents?.id || 0,
    workspaceRoot: workspaceRoot ? path.resolve(String(workspaceRoot)) : '',
    cwd: cwd ? path.resolve(String(cwd)) : '',
  };

  win.setMenuBarVisibility(false);
  if (context.workspaceRoot) authority.grantWorkspace(win.webContents, context.workspaceRoot);
  terminalWindowContexts.set(webContentsId, context);
  terminalWindows.add(win);
  win.loadFile(path.join(__dirname, '../renderer/terminal-window.html'));
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on('closed', () => {
    terminalWindows.delete(win);
    terminalWindowContexts.delete(webContentsId);
    authority.forget({ id: webContentsId });
  });
  return win;
}

function createOrchestrationWindow({ openerWebContents, workspaceRoot = '' } = {}) {
  const openerWindow = openerWebContents ? BrowserWindow.fromWebContents(openerWebContents) : null;
  const openerBounds = openerWindow?.getBounds?.() || null;
  const display = screen.getDisplayNearestPoint(openerBounds
    ? { x: openerBounds.x + Math.round(openerBounds.width / 2), y: openerBounds.y + Math.round(openerBounds.height / 2) }
    : screen.getCursorScreenPoint());
  const area = display.workArea;
  const width = Math.min(1180, area.width);
  const height = Math.min(850, area.height);
  const win = new BrowserWindow({
    width,
    height,
    minWidth: 840,
    minHeight: 620,
    x: area.x + Math.max(0, Math.round((area.width - width) / 2)),
    y: area.y + Math.max(0, Math.round((area.height - height) / 2)),
    icon: path.join(__dirname, '../../assets/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep timers/rAF running at full rate when the window is blurred/occluded. Without this Electron throttles
      // background rendering, so a live terminal (or the observe graph) stops updating while unfocused and then
      // floods through a huge backlog on refocus — the cause of the "lag when not focused" stutter.
      backgroundThrottling: false,
    },
    show: false,
    backgroundColor: windowBackgroundColor(),
    // Make the project this Run GUI is scoped to explicit — the window is bound to ONE workspace (its run list
    // and live observers are filtered to it), so name it in the title.
    title: workspaceRoot ? `OrPAD Run GUI — ${path.basename(String(workspaceRoot))}` : 'OrPAD Run GUI',
  });

  win.setMenuBarVisibility(false);
  const webContentsId = win.webContents.id;
  const context = {
    openerWebContentsId: openerWebContents?.id || 0,
    workspaceRoot: workspaceRoot ? path.resolve(String(workspaceRoot)) : '',
  };
  if (context.workspaceRoot) authority.grantWorkspace(win.webContents, context.workspaceRoot);
  orchestrationWindowContexts.set(webContentsId, context);
  orchestrationWindows.add(win);
  win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { mode: 'orchestration' } });
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on('closed', () => {
    orchestrationWindows.delete(win);
    orchestrationWindowContexts.delete(webContentsId);
    pendingOrchestrationSeeds.delete(webContentsId);
    authority.forget({ id: webContentsId });
  });
  return win;
}

function installApplicationMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New from Template...',
          accelerator: 'Ctrl+Alt+N',
          click: (_item, focusedWindow) => {
            const win = focusedWindow || BrowserWindow.getFocusedWindow();
            win?.webContents.send('new-from-template');
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- File loading ---
async function loadMarkdownFile(win, filePath) {
  try {
    const resolvedPath = path.resolve(String(filePath));
    const content = await fsp.readFile(resolvedPath, 'utf-8');
    if (win.isDestroyed()) return;
    authority.grantFile(win.webContents, resolvedPath);
    const fileName = path.basename(resolvedPath);
    win.setTitle(fileName + ' - OrPAD');
    win.webContents.send('load-markdown', {
      content,
      filePath: resolvedPath,
      fileName,
      dirPath: path.dirname(resolvedPath),
    });
  } catch (err) {
    dialog.showErrorBox('Error', 'Failed to read file:\n' + filePath + '\n\n' + err.message);
  }
}

function allowedPath(event, filePath, options = {}) {
  return authority.assertWorkspacePath(event.sender, filePath, options);
}

function allowedWorkspacePath(event, targetPath, label = 'Path') {
  return allowedPath(event, targetPath, { label });
}

function allowedFilePath(event, targetPath, label = 'File') {
  return allowedPath(event, targetPath, { label, allowFileCapability: true });
}

async function nearestExistingRealPath(targetPath) {
  let current = path.resolve(String(targetPath || ''));
  while (current && current !== path.dirname(current)) {
    try {
      return await fsp.realpath(current);
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
      current = path.dirname(current);
    }
  }
  return '';
}

async function allowedReadPath(event, targetPath, label = 'Path', options = {}) {
  const target = allowedPath(event, targetPath, { ...options, label });
  if (options.allowFileCapability && authority.isGrantedFile(event.sender, target)) return target;
  const realTarget = await fsp.realpath(target);
  authority.assertWorkspacePath(event.sender, realTarget, { label });
  return target;
}

async function allowedWritePath(event, targetPath, label = 'Path', options = {}) {
  const target = allowedPath(event, targetPath, { ...options, label });
  if (options.allowFileCapability && authority.isGrantedFile(event.sender, target)) return target;
  const realTargetOrAncestor = await nearestExistingRealPath(target);
  if (realTargetOrAncestor) {
    authority.assertWorkspacePath(event.sender, realTargetOrAncestor, { label });
  }
  return target;
}

// --- IPC: system / locale / title ---
ipcMain.handle('get-app-info', () => ({
  isPackaged: app.isPackaged,
  version: app.getVersion(),
}));

registerRunbookHandlers({ ipcMain, app, authority });
registerCoreRunHandlers({ ipcMain, app, authority });
registerTerminalHandlers({ ipcMain, app, authority });

ipcMain.handle('terminal-window-open', async (event, request = {}) => {
  const existing = activeTerminalWindow();
  if (existing) {
    focusTerminalWindow(existing);
    return { id: existing.id, success: true, reused: true };
  }
  const openerWorkspace = authority.getWorkspaceRoot(event.sender) || await readApprovedWorkspace();
  const workspaceRoot = openerWorkspace ? path.resolve(String(openerWorkspace)) : '';
  let cwd = '';
  if (request?.cwd) {
    const candidate = path.resolve(String(request.cwd));
    if (!workspaceRoot || isInsidePath(candidate, workspaceRoot)) {
      cwd = candidate;
    }
  }
  const win = createTerminalWindow({
    openerWebContents: event.sender,
    workspaceRoot,
    cwd: cwd || workspaceRoot,
    bounds: request?.bounds || null,
  });
  return { id: win.id, success: true };
});

ipcMain.handle('terminal-window-status', async () => {
  const win = activeTerminalWindow();
  return win ? { open: true, id: win.id } : { open: false };
});

ipcMain.handle('terminal-window-focus', async () => {
  return focusTerminalWindow();
});

ipcMain.handle('orchestration-window-open', async (event, request = {}) => {
  const target = await orchestrationWindowTargetForRequest(event, request);
  if (!target.workspaceRoot) return { success: false, error: 'Open a project folder before opening the Run GUI.' };
  // Optional seed from a terminal AI-CLI launch ("Apply orchestration"). Delivered TWO ways for reliability:
  // (1) STORE it keyed by the target window so the renderer can PULL it on init (race-proof), and
  // (2) PUSH it via 'orpad-core-seed' for an already-loaded window.
  const seed = request && request.seed && typeof request.seed === 'object' ? request.seed : null;
  const stash = (id) => { if (seed) pendingOrchestrationSeeds.set(id, seed); };
  const existing = activeOrchestrationWindow(target);
  if (existing) {
    focusOrchestrationWindow(existing);
    if (seed && !existing.isDestroyed()) {
      stash(existing.webContents.id);
      if (!existing.webContents.isLoadingMainFrame()) existing.webContents.send('orpad-core-seed', seed);
    }
    return { id: existing.id, success: true, reused: true, workspaceRoot: target.workspaceRoot };
  }
  const win = createOrchestrationWindow({
    openerWebContents: event.sender,
    workspaceRoot: target.workspaceRoot,
  });
  if (seed) {
    stash(win.webContents.id);
    win.webContents.once('did-finish-load', () => { if (!win.isDestroyed()) win.webContents.send('orpad-core-seed', seed); });
  }
  return { id: win.id, success: true, workspaceRoot: target.workspaceRoot };
});

// Race-proof seed delivery: the Run GUI renderer pulls any seed stashed for its window on init.
ipcMain.handle('orpad-core-pull-seed', (event) => {
  const id = event.sender.id;
  const seed = pendingOrchestrationSeeds.get(id) || null;
  pendingOrchestrationSeeds.delete(id);
  return seed;
});

ipcMain.handle('orchestration-window-status', async (event, request = {}) => {
  const target = await orchestrationWindowTargetForRequest(event, request);
  const win = activeOrchestrationWindow(target);
  return win ? { open: true, id: win.id, workspaceRoot: target.workspaceRoot } : { open: false, workspaceRoot: target.workspaceRoot };
});

ipcMain.handle('orchestration-window-focus', async (event, request = {}) => {
  const target = await orchestrationWindowTargetForRequest(event, request);
  return focusOrchestrationWindow(activeOrchestrationWindow(target));
});

ipcMain.handle('terminal-window-dock-main', async (event) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  const context = terminalWindowContexts.get(event.sender.id) || {};
  const targetWindow = mainWindowForTerminalContext(context);
  if (targetWindow && !targetWindow.isDestroyed()) {
    if (targetWindow.isMinimized()) targetWindow.restore();
    targetWindow.show();
    targetWindow.focus();
    targetWindow.webContents.send('terminal-window-docked', { layout: 'bottom' });
  }
  if (sourceWindow && !sourceWindow.isDestroyed()) sourceWindow.close();
  return { success: true };
});

ipcMain.handle('terminal-window-context', async (event) => {
  return terminalWindowContexts.get(event.sender.id) || { workspaceRoot: '', cwd: '' };
});

ipcMain.handle('get-system-theme', () => {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
});

// New BrowserWindows are created with the last applied theme's background so the
// pre-HTML frame matches the theme instead of flashing a mismatched color. The
// renderer reports it (themes.js cacheBootTheme) on every theme apply; persisted
// so the very first window of the next launch already matches.
function windowThemePath() {
  return path.join(app.getPath('userData'), 'window-theme.json');
}

let cachedWindowBackgroundColor = '';
function windowBackgroundColor() {
  if (!cachedWindowBackgroundColor) {
    // Fallback = orpad-hero bgPrimary, matching the base.css :root defaults that
    // paint when no saved theme cache exists yet.
    cachedWindowBackgroundColor = '#f6f8fd';
    try {
      const parsed = JSON.parse(fs.readFileSync(windowThemePath(), 'utf-8'));
      if (typeof parsed?.backgroundColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(parsed.backgroundColor)) {
        cachedWindowBackgroundColor = parsed.backgroundColor;
      }
    } catch { /* missing/corrupt file → default */ }
  }
  return cachedWindowBackgroundColor;
}

ipcMain.on('set-theme-background', (_event, color) => {
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return;
  if (color === windowBackgroundColor()) return;
  cachedWindowBackgroundColor = color;
  fsp.mkdir(path.dirname(windowThemePath()), { recursive: true })
    .then(() => fsp.writeFile(windowThemePath(), JSON.stringify({ version: 1, backgroundColor: color }), 'utf-8'))
    .catch(() => {});
});

ipcMain.handle('get-locale', async () => {
  let mtime = 0;
  try {
    const p = path.join(path.dirname(app.getPath('exe')), 'resources', 'locale');
    mtime = (await fsp.stat(p)).mtimeMs;
  } catch {}
  return { code: appLocale, mtime };
});

ipcMain.on('set-locale', (_event, code) => {
  if (localeData[code]) {
    appLocale = code;
    appStrings = localeData[code];
    broadcastLocaleChanged();
  }
});

ipcMain.on('set-title', (event, title) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.setTitle(title);
});

// --- IPC: Markdown file ops ---
ipcMain.handle('open-file-dialog', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    filters: [
      { name: 'Supported', extensions: SUPPORTED_EXTS },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections'],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    for (const fp of result.filePaths) {
      const resolved = authority.grantFile(win.webContents, fp);
      loadMarkdownFile(win, resolved);
    }
    return true;
  }
  return false;
});

ipcMain.handle('save-file', async (event, filePath, content) => {
  try {
    const target = await allowedWritePath(event, filePath, 'Save target', { allowFileCapability: true });
    await fsp.writeFile(target, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('save-file-as', async (event, content) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showSaveDialog(win, {
    filters: [
      { name: 'Supported', extensions: SUPPORTED_EXTS },
      { name: 'All Files', extensions: ['*'] },
    ],
    defaultPath: 'untitled.md',
  });
  if (!result.canceled && result.filePath) {
    try {
      const target = authority.grantFile(event.sender, result.filePath);
      await fsp.writeFile(target, content, 'utf-8');
      const fileName = path.basename(target);
      win.setTitle(fileName + ' - OrPAD');
      return target;
    } catch {
      return null;
    }
  }
  return null;
});

ipcMain.handle('open-default-apps-settings', async () => {
  try {
    await shell.openExternal('ms-settings:defaultapps?registeredAppMachine=OrPAD');
  } catch {
    await shell.openExternal('ms-settings:defaultapps');
  }
});

ipcMain.handle('show-save-dialog', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return 'cancel';
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: [t('dialog.save'), t('dialog.dontSave'), t('dialog.cancel')],
    defaultId: 0,
    cancelId: 2,
    message: t('dialog.unsavedMsg'),
    detail: t('dialog.unsavedDetail'),
  });
  return ['save', 'discard', 'cancel'][response];
});

ipcMain.on('confirm-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win._forceClose = true;
    win.destroy();
  }
});

ipcMain.on('drop-file', (event, filePath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && filePath && fs.existsSync(filePath)) {
    const resolved = authority.grantFile(event.sender, filePath);
    loadMarkdownFile(win, resolved);
  }
});

// --- Read file (for file tree) ---
ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const target = await allowedReadPath(event, filePath, 'Read target', { allowFileCapability: true });
    const content = await fsp.readFile(target, 'utf-8');
    return { content, filePath: target, fileName: path.basename(target), dirPath: path.dirname(target) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('get-approved-workspace', async (event) => {
  const grantedWorkspace = await existingWorkspaceRoot(authority.getWorkspaceRoot(event.sender));
  if (grantedWorkspace) return grantedWorkspace;
  const workspaceRoot = await readApprovedWorkspace();
  return workspaceRoot ? authority.grantWorkspace(event.sender, workspaceRoot) : null;
});

const DEFAULT_SNIPPETS_JSON = '{\n  "markdown": [\n    { "name": "note", "description": "Callout note", "body": "> **Note** ${0}" }\n  ]\n}\n';

function userSnippetsPath() {
  return path.join(app.getPath('userData'), 'snippets.json');
}

function approvedWorkspacePath() {
  return path.join(app.getPath('userData'), 'approved-workspace.json');
}

async function rememberApprovedWorkspace(dirPath) {
  const workspaceRoot = await fsp.realpath(path.resolve(String(dirPath || ''))).catch(() => path.resolve(String(dirPath || '')));
  await fsp.mkdir(path.dirname(approvedWorkspacePath()), { recursive: true });
  await fsp.writeFile(approvedWorkspacePath(), JSON.stringify({
    version: 1,
    workspaceRoot,
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');
  return workspaceRoot;
}

async function existingWorkspaceRoot(dirPath) {
  const workspaceRoot = dirPath ? path.resolve(String(dirPath)) : '';
  if (!workspaceRoot) return '';
  const realRoot = await fsp.realpath(workspaceRoot).catch(() => workspaceRoot);
  const stat = await fsp.stat(realRoot).catch(() => null);
  return stat?.isDirectory() ? realRoot : '';
}

async function readApprovedWorkspace() {
  try {
    const raw = await fsp.readFile(approvedWorkspacePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return await existingWorkspaceRoot(parsed?.workspaceRoot);
  } catch {
    return '';
  }
}

async function ensureUserSnippetsFile() {
  const filePath = userSnippetsPath();
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const exists = await fsp.access(filePath).then(() => true).catch(() => false);
  if (!exists) await fsp.writeFile(filePath, DEFAULT_SNIPPETS_JSON, 'utf-8');
  const content = await fsp.readFile(filePath, 'utf-8');
  return { filePath, dirPath: path.dirname(filePath), content };
}

ipcMain.handle('snippets-read', async () => {
  try {
    return await ensureUserSnippetsFile();
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('snippets-ensure', async () => {
  try {
    return await ensureUserSnippetsFile();
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('snippets-watch', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  const id = win.id;
  const existing = snippetWatchers.get(id);
  if (existing) existing.close();
  try {
    await ensureUserSnippetsFile();
    const watcher = fs.watch(userSnippetsPath(), () => {
      if (!win.isDestroyed()) win.webContents.send('snippets-changed');
    });
    watcher.on('error', () => {});
    snippetWatchers.set(id, watcher);
    return true;
  } catch {
    return false;
  }
});

function statPayload(stat) {
  return {
    type: stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'symlink' : 'file',
    size: stat.size,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function dataPayload(data, options) {
  if (typeof data === 'string') return data;
  if (data?.type === 'Buffer' && Array.isArray(data.data)) return Buffer.from(data.data);
  if (Array.isArray(data)) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return Buffer.from(String(data ?? ''), encoding || 'utf8');
}

function gitFsError(err) {
  return { error: err?.code || err?.message || String(err) };
}

ipcMain.handle('git-fs.readFile', async (event, filePath, options) => {
  try {
    const target = await allowedReadPath(event, filePath, 'Git read target');
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const data = await fsp.readFile(target);
    return encoding ? data.toString(encoding) : data;
  } catch (err) {
    return gitFsError(err);
  }
});

ipcMain.handle('git-fs.writeFile', async (event, filePath, data, options) => {
  try {
    const target = await allowedWritePath(event, filePath, 'Git write target', { checkParent: true });
    const encoding = typeof options === 'string' ? options : options?.encoding;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, dataPayload(data, options), encoding ? { encoding } : undefined);
    return { success: true };
  } catch (err) {
    return gitFsError(err);
  }
});

ipcMain.handle('git-fs.unlink', async (event, filePath) => {
  try {
    const target = await allowedWritePath(event, filePath, 'Git unlink target');
    await fsp.unlink(target);
    return { success: true };
  } catch (err) {
    return gitFsError(err);
  }
});

ipcMain.handle('git-fs.readdir', async (event, dirPath, options) => {
  try {
    const target = await allowedReadPath(event, dirPath, 'Git directory');
    const entries = await fsp.readdir(target, { withFileTypes: !!options?.withFileTypes });
    if (!options?.withFileTypes) return entries;
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'symlink' : 'file',
    }));
  } catch (err) {
    return gitFsError(err);
  }
});

ipcMain.handle('git-fs.mkdir', async (event, dirPath, options) => {
  try {
    const target = await allowedWritePath(event, dirPath, 'Git mkdir target', { checkParent: true });
    await fsp.mkdir(target, { recursive: !!options?.recursive });
    return { success: true };
  } catch (err) {
    return err?.code === 'EEXIST' ? { success: true } : gitFsError(err);
  }
});

ipcMain.handle('git-fs.rmdir', async (event, dirPath) => {
  try {
    const target = await allowedWritePath(event, dirPath, 'Git rmdir target');
    await fsp.rmdir(target);
    return { success: true };
  } catch (err) {
    return gitFsError(err);
  }
});

ipcMain.handle('git-fs.stat', async (event, targetPath) => {
  try {
    const target = await allowedReadPath(event, targetPath, 'Git stat target');
    return statPayload(await fsp.stat(target));
  } catch (err) {
    return gitFsError(err);
  }
});

ipcMain.handle('git-fs.lstat', async (event, targetPath) => {
  try {
    const target = await allowedReadPath(event, targetPath, 'Git lstat target');
    return statPayload(await fsp.lstat(target));
  } catch (err) {
    return gitFsError(err);
  }
});

// --- Image paste ---
ipcMain.handle('save-image', async (_event, filePath, buffer, ext) => {
  try {
    const source = filePath ? await allowedReadPath(_event, filePath, 'Image source file', { allowFileCapability: true }) : '';
    const dir = source ? path.dirname(source) : app.getPath('pictures');
    const assetsDir = path.join(dir, 'assets');
    await fsp.mkdir(assetsDir, { recursive: true });
    const name = 'image-' + Date.now() + '.' + ext;
    const dest = path.join(assetsDir, name);
    await fsp.writeFile(dest, Buffer.from(buffer));
    return './assets/' + name;
  } catch { return null; }
});

// --- Auto-save recovery ---
async function getRecoveryDir() {
  const dir = path.join(app.getPath('userData'), 'recovery');
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function recoveryId(filePath) {
  if (!filePath) return 'untitled';
  return crypto.createHash('sha256').update(filePath).digest('hex').substring(0, 16);
}

ipcMain.handle('auto-save-recovery', async (event, filePath, content) => {
  try {
    const target = filePath ? await allowedWritePath(event, filePath, 'Recovery file', { allowFileCapability: true }) : '';
    const id = recoveryId(target);
    const dir = await getRecoveryDir();
    await fsp.writeFile(path.join(dir, id + '.json'), JSON.stringify({
      filePath: target || null, content, timestamp: Date.now(),
    }), 'utf-8');
  } catch {}
});

ipcMain.handle('clear-recovery', async (event, filePath) => {
  try {
    const target = filePath ? await allowedWritePath(event, filePath, 'Recovery file', { allowFileCapability: true }) : '';
    const dir = await getRecoveryDir();
    const p = path.join(dir, recoveryId(target) + '.json');
    await fsp.unlink(p).catch(() => {});
  } catch {}
});

async function checkRecovery(win) {
  if (win.isDestroyed()) return;
  try {
    const dir = path.join(app.getPath('userData'), 'recovery');
    const allFiles = await fsp.readdir(dir).catch(() => null);
    if (!allFiles) return;
    const files = allFiles.filter(f => f.endsWith('.json'));
    for (const file of files) {
      const fullPath = path.join(dir, file);
      try {
        const raw = await fsp.readFile(fullPath, 'utf-8');
        const data = JSON.parse(raw);
        if (Date.now() - data.timestamp > 7 * 24 * 60 * 60 * 1000) {
          await fsp.unlink(fullPath).catch(() => {}); continue;
        }
        const name = data.filePath ? path.basename(data.filePath) : t('untitled');
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          title: t('recovery.title'),
          message: t('recovery.message').replace('{0}', name),
          detail: t('recovery.detail').replace('{0}', new Date(data.timestamp).toLocaleString()),
          buttons: [t('recovery.recover'), t('recovery.discard')],
          defaultId: 0, cancelId: 1,
        });
        if (response === 0) {
          let savedContent = '';
          if (data.filePath) {
            const recoveredPath = authority.grantFile(win.webContents, data.filePath);
            savedContent = await fsp.readFile(recoveredPath, 'utf-8').catch(() => '');
            data.filePath = recoveredPath;
          }
          win.webContents.send('load-markdown', {
            content: data.content, filePath: data.filePath,
            fileName: name, dirPath: data.filePath ? path.dirname(data.filePath) : null,
            savedContent,
          });
          if (data.filePath) win.setTitle(name + ' - OrPAD');
        }
        await fsp.unlink(fullPath).catch(() => {});
        if (response === 0) break;
      } catch { await fsp.unlink(fullPath).catch(() => {}); }
    }
  } catch {}
}

// --- Workspace: File tree & directory operations ---
const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', 'dist', 'build', '.next', '.cache', '.idea', '.vscode']);

async function readDirectoryTree(dirPath, depth) {
  if (depth > 8) return [];
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const items = [];
    const dirs = entries.filter(e => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter(e => e.isFile() && !e.isSymbolicLink() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));

    // Fan out subdirectory reads in parallel — same event loop tick benefits a tree
    // with many siblings at each level.
    const dirItems = await Promise.all(dirs.map(async (dir) => {
      if (IGNORED_DIRS.has(dir.name)) return null;
      const sub = path.join(dirPath, dir.name);
      return {
        name: dir.name,
        path: sub,
        isDirectory: true,
        children: await readDirectoryTree(sub, depth + 1),
      };
    }));
    for (const di of dirItems) if (di) items.push(di);

    for (const file of files) {
      items.push({
        name: file.name,
        path: path.join(dirPath, file.name),
        isDirectory: false,
      });
    }
    return items;
  } catch {
    return [];
  }
}

ipcMain.handle('open-folder-dialog', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    const workspaceRoot = await rememberApprovedWorkspace(result.filePaths[0]);
    return authority.grantWorkspace(event.sender, workspaceRoot);
  }
  return null;
});

ipcMain.handle('read-directory', async (event, dirPath) => {
  try {
    const target = await allowedReadPath(event, dirPath, 'Directory');
    return await readDirectoryTree(target, 0);
  } catch {
    return [];
  }
});

ipcMain.handle('watch-directory', async (event, dirPath) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  const id = win.id;
  const existing = watchers.get(id);
  if (existing) {
    existing.watcher.close();
    if (existing.flushTimer) clearTimeout(existing.flushTimer);
    watchers.delete(id);
  }
  try {
    const target = await allowedReadPath(event, dirPath, 'Watched directory');
    // Coalesce rapid-fire events from bulk operations (save-many, git checkout, etc.).
    // Dedupe same filename within a 120ms window, flush as a batch to the renderer.
    const pending = new Map(); // filename -> last eventType
    let flushTimer = null;
    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const entry = watchers.get(id);
        if (entry) entry.flushTimer = null;
        if (win.isDestroyed()) return;
        const batch = [];
        for (const [filename, eventType] of pending) batch.push({ eventType, filename });
        pending.clear();
        if (batch.length === 0) return;
        // Keep backward-compatible single-event shape by dispatching individually,
        // but the dedupe + 120ms delay collapses storms.
        for (const ev of batch) win.webContents.send('directory-changed', ev);
      }, 120);
    };
    const watcher = fs.watch(target, { recursive: true }, (eventType, filename) => {
      if (win.isDestroyed()) return;
      pending.set(filename || '', eventType);
      scheduleFlush();
      const entry = watchers.get(id);
      if (entry) entry.flushTimer = flushTimer;
    });
    watcher.on('error', () => {});
    watchers.set(id, { watcher, flushTimer: null });
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('unwatch-directory', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const id = win.id;
  const entry = watchers.get(id);
  if (entry) {
    entry.watcher.close();
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    watchers.delete(id);
  }
});

ipcMain.handle('create-file', async (event, filePath) => {
  try {
    const target = await allowedWritePath(event, filePath, 'Create file target', { checkParent: true });
    const exists = await fsp.access(target).then(() => true).catch(() => false);
    if (exists) return { error: 'File already exists' };
    const dir = path.dirname(target);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(target, '', 'utf-8');
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('create-folder', async (event, folderPath) => {
  try {
    const target = await allowedWritePath(event, folderPath, 'Create folder target', { checkParent: true });
    const exists = await fsp.access(target).then(() => true).catch(() => false);
    if (exists) return { error: 'Folder already exists' };
    await fsp.mkdir(target, { recursive: true });
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('rename-file', async (event, oldPath, newPath) => {
  try {
    const oldTarget = await allowedWritePath(event, oldPath, 'Rename source');
    const newTarget = await allowedWritePath(event, newPath, 'Rename target', { checkParent: true });
    await fsp.rename(oldTarget, newTarget);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    const target = await allowedWritePath(event, filePath, 'Delete target');
    await shell.trashItem(target);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- Workspace: Cross-file search ---
ipcMain.handle('search-files', async (event, dirPath, query, options) => {
  if (!query || !dirPath) return [];
  let root;
  try {
    root = await allowedReadPath(event, dirPath, 'Search directory');
  } catch {
    return [];
  }
  const { regex = false, caseSensitive = false, extensions = null } = options || {};
  let pattern;
  if (regex) {
    try { pattern = new RegExp(query, caseSensitive ? 'g' : 'gi'); }
    catch { return []; }
  }
  // null/empty → all text files (= !isBinary). Otherwise exact-match the lowercase ext.
  const extSet = (Array.isArray(extensions) && extensions.length > 0)
    ? new Set(extensions.map(e => String(e).toLowerCase().replace(/^\*?\./, '')).filter(Boolean))
    : null;

  const results = [];
  const needle = caseSensitive ? query : query.toLowerCase();

  async function processFile(fullPath, fileName) {
    try {
      const content = await fsp.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');
      const matches = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let found = false;
        if (pattern) {
          pattern.lastIndex = 0;
          found = pattern.test(line);
        } else {
          found = caseSensitive ? line.includes(query) : line.toLowerCase().includes(needle);
        }
        if (found) {
          matches.push({ lineNumber: i + 1, lineText: line.substring(0, 200) });
          if (matches.length >= 50) break;
        }
      }
      if (matches.length > 0) {
        results.push({
          filePath: fullPath,
          fileName,
          relativePath: path.relative(root, fullPath),
          matches,
        });
      }
    } catch {}
  }

  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    const subWalks = [];
    const fileTasks = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) subWalks.push(walk(fullPath));
      } else if (entry.isFile() && isSupportedFile(fullPath)) {
        if (extSet) {
          const ext = path.extname(entry.name).toLowerCase().slice(1);
          if (!extSet.has(ext)) continue;
        }
        fileTasks.push(processFile(fullPath, entry.name));
      }
    }
    await Promise.all(fileTasks);
    await Promise.all(subWalks);
  }

  await walk(root);
  return results;
});

// --- Link Index (wiki-links, backlinks, graph) ---
const linkIndex = {
  forward: new Map(),
  back: new Map(),
  fileNames: new Map(),
  workspacePath: null,
};

function clearBacklinksFor(filePath) {
  const oldLinks = linkIndex.forward.get(filePath) || [];
  for (const link of oldLinks) {
    const backList = linkIndex.back.get(link.resolvedTarget);
    if (backList) {
      linkIndex.back.set(link.resolvedTarget, backList.filter(b => b.source !== filePath));
    }
  }
}

function indexFile(filePath, content) {
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext).toLowerCase();
  linkIndex.fileNames.set(baseName, filePath);

  clearBacklinksFor(filePath);

  const links = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]/g)) {
      links.push({ raw: m[1].trim(), line: i + 1, context: line.substring(0, 200) });
    }
    for (const m of line.matchAll(/\[([^\]]*)\]\(([^)]+\.(?:md|markdown|mkd|mdx))\)/gi)) {
      links.push({ raw: m[2], line: i + 1, context: line.substring(0, 200) });
    }
  }

  const dir = path.dirname(filePath);
  const resolved = links.map(l => {
    const resolvedTarget = resolveLinkTarget(dir, l.raw);
    return { ...l, resolvedTarget };
  });

  linkIndex.forward.set(filePath, resolved);

  for (const link of resolved) {
    if (!link.resolvedTarget) continue;
    if (!linkIndex.back.has(link.resolvedTarget)) linkIndex.back.set(link.resolvedTarget, []);
    linkIndex.back.get(link.resolvedTarget).push({ source: filePath, line: link.line, context: link.context });
  }
}

function resolveLinkTarget(fromDir, target) {
  if (target.includes('/') || target.includes('\\') || /\.(md|markdown|mkd|mdx)$/i.test(target)) {
    const abs = path.resolve(fromDir, target);
    try { if (fs.existsSync(abs)) return abs; } catch {}
  }
  const normalized = target.toLowerCase().replace(/\.(md|markdown|mkd|mdx)$/i, '');
  const found = linkIndex.fileNames.get(normalized);
  if (found) return found;
  for (const [name, fpath] of linkIndex.fileNames) {
    if (name === normalized) return fpath;
  }
  return null;
}

async function buildFullIndex(dirPath) {
  linkIndex.forward.clear();
  linkIndex.back.clear();
  linkIndex.fileNames.clear();
  linkIndex.workspacePath = dirPath;

  // First pass: register all file names so wiki-link resolution has complete scope.
  async function registerNames(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    const subs = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) subs.push(registerNames(fullPath));
      } else if (entry.isFile() && /\.(md|markdown|mkd|mdx)$/i.test(entry.name)) {
        const ext = path.extname(entry.name);
        linkIndex.fileNames.set(path.basename(entry.name, ext).toLowerCase(), fullPath);
      }
    }
    await Promise.all(subs);
  }

  // Second pass: index each file's outgoing links.
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    const fileTasks = [];
    const subWalks = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) subWalks.push(walk(fullPath));
      } else if (entry.isFile() && /\.(md|markdown|mkd|mdx)$/i.test(entry.name)) {
        fileTasks.push(
          fsp.readFile(fullPath, 'utf-8')
             .then(content => indexFile(fullPath, content))
             .catch(() => {})
        );
      }
    }
    await Promise.all(fileTasks);
    await Promise.all(subWalks);
  }

  await registerNames(dirPath);
  await walk(dirPath);
}

ipcMain.handle('build-link-index', async (event, dirPath) => {
  const root = await allowedReadPath(event, dirPath, 'Link index workspace');
  await buildFullIndex(root);
  return { fileCount: linkIndex.fileNames.size };
});

ipcMain.handle('resolve-wiki-link', async (event, dirPath, targetName) => {
  const root = await allowedReadPath(event, dirPath, 'Wiki-link workspace');
  if (linkIndex.workspacePath !== root) await buildFullIndex(root);
  const resolved = resolveLinkTarget(root, targetName);
  return resolved && authority.isInWorkspace(event.sender, resolved) ? resolved : null;
});

ipcMain.handle('get-backlinks', async (event, dirPath, filePath) => {
  const root = await allowedReadPath(event, dirPath, 'Backlinks workspace');
  const target = await allowedReadPath(event, filePath, 'Backlinks file');
  if (linkIndex.workspacePath !== root) await buildFullIndex(root);

  const linked = (linkIndex.back.get(target) || []).map(b => ({
    sourcePath: b.source,
    sourceTitle: path.basename(b.source, path.extname(b.source)),
    line: b.line,
    context: b.context,
  }));

  const unlinked = [];
  if (linkIndex.fileNames.size <= 1000) {
    const baseName = path.basename(target, path.extname(target));
    const searchTerm = baseName.toLowerCase();
    const linkedSources = new Set(linked.map(l => l.sourcePath));

    // Scan candidate files in parallel — up to 1000 files, previously serialized.
    const tasks = [];
    for (const [, fpath] of linkIndex.fileNames) {
      if (fpath === target || linkedSources.has(fpath)) continue;
      tasks.push(fsp.readFile(fpath, 'utf-8').then((content) => {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(searchTerm)) {
            unlinked.push({
              sourcePath: fpath,
              sourceTitle: path.basename(fpath, path.extname(fpath)),
              line: i + 1,
              context: lines[i].substring(0, 200),
            });
            return;
          }
        }
      }).catch(() => {}));
    }
    await Promise.all(tasks);
  }

  return { linked, unlinked };
});

ipcMain.handle('get-file-names', async (event, dirPath) => {
  const root = await allowedReadPath(event, dirPath, 'File names workspace');
  if (linkIndex.workspacePath !== root) await buildFullIndex(root);
  const names = [];
  for (const [, filePath] of linkIndex.fileNames) {
    names.push({ baseName: path.basename(filePath, path.extname(filePath)), filePath });
  }
  return names;
});

// Full workspace link graph (Obsidian-style): every markdown note as a node, each
// resolved wiki/markdown link as a file→file edge. Read-only; reuses the link index.
// Resolves the workspace from the authority when no dirPath is given (orchestration window).
ipcMain.handle('get-link-graph', async (event, dirPath) => {
  let root;
  try {
    root = dirPath
      ? await allowedReadPath(event, dirPath, 'Link graph workspace')
      : (authority.getWorkspaceRoot(event.sender) || await readApprovedWorkspace());
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  if (!root) return { ok: false, error: 'Open a project folder first.' };
  if (linkIndex.workspacePath !== root) await buildFullIndex(root);

  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  const nodes = new Map(); // abs -> { path, name, out, in }
  const ensure = (abs) => {
    let n = nodes.get(abs);
    if (!n) { n = { path: rel(abs), name: path.basename(abs, path.extname(abs)), out: 0, in: 0 }; nodes.set(abs, n); }
    return n;
  };
  for (const [, abs] of linkIndex.fileNames) ensure(abs);
  const edges = [];
  for (const [src, links] of linkIndex.forward) {
    const s = ensure(src);
    for (const l of links) {
      if (!l.resolvedTarget) continue;
      const t = ensure(l.resolvedTarget);
      edges.push({ from: s.path, to: t.path });
      s.out += 1; t.in += 1;
    }
  }
  return { ok: true, root: rel(root) || '.', nodes: [...nodes.values()], edges };
});

// --- Save arbitrary binary / text payload from renderer via save dialog ---
ipcMain.handle('save-binary', async (event, defaultName, buffer) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const ext = path.extname(defaultName).slice(1) || 'bin';
  const result = await dialog.showSaveDialog(win, {
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return false;
  try { await fsp.writeFile(result.filePath, Buffer.from(buffer)); return result.filePath; }
  catch (err) { dialog.showErrorBox('Save failed', err.message); return false; }
});

ipcMain.handle('svg-to-png', async (event, svgString, width, height, backgroundColor) => {
  const w = Math.min(Math.max(parseInt(width, 10) || 1200, 100), 8192);
  const h = Math.min(Math.max(parseInt(height, 10) || 800, 100), 8192);
  const bg = (typeof backgroundColor === 'string' && backgroundColor.trim()) || '#ffffff';
  let off = null;
  try {
    off = new BrowserWindow({
      width: w,
      height: h,
      show: false,
      webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
    });
    const html = `<!DOCTYPE html><html><head><style>html,body{margin:0;padding:0;background:${bg};width:100%;height:100%;}body{display:flex;align-items:center;justify-content:center;}svg{display:block;width:100%;height:100%;max-width:100%;max-height:100%;}</style></head><body>${svgString}</body></html>`;
    await off.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 150));
    const image = await off.webContents.capturePage();
    off.destroy();
    off = null;
    const pngBuf = image.toPNG();
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win, {
      defaultPath: 'diagram.png',
      filters: [{ name: 'PNG', extensions: ['png'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return false;
    await fsp.writeFile(result.filePath, pngBuf);
    return result.filePath;
  } catch (err) {
    if (off) try { off.destroy(); } catch {}
    dialog.showErrorBox('PNG export failed', err.message);
    return false;
  }
});

ipcMain.handle('save-text', async (event, defaultName, text) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const ext = path.extname(defaultName).slice(1) || 'txt';
  const result = await dialog.showSaveDialog(win, {
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return false;
  try { await fsp.writeFile(result.filePath, text, 'utf-8'); return result.filePath; }
  catch (err) { dialog.showErrorBox('Save failed', err.message); return false; }
});

// --- Reveal a file or directory in the OS file manager ---
ipcMain.handle('reveal-in-explorer', async (event, targetPath) => {
  try {
    const target = await allowedReadPath(event, targetPath, 'Reveal target', { allowFileCapability: true });
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) {
      await shell.openPath(target);
    } else {
      shell.showItemInFolder(target);
    }
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Renderer CSP — must match the <meta> tag in index.html.
const RENDERER_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*; " +
  "worker-src 'self' blob:; frame-src 'none'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none';";

// --- Navigation + new-window hardening ---
app.on('web-contents-created', (_event, contents) => {
  // Block all navigation; only file-drop (file:/// → supported file) is allowed.
  contents.on('will-navigate', (navEvent, url) => {
    navEvent.preventDefault();
    if (url.startsWith('file:///')) {
      const filePath = decodeURIComponent(url.replace('file:///', '').replace(/\//g, '\\'));
      if (isSupportedFile(filePath)) {
        const win = BrowserWindow.fromWebContents(contents);
        if (win) loadMarkdownFile(win, filePath);
      }
    }
  });

  // Block new windows that try to navigate outside the app; open http/https externally.
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
});

// --- App lifecycle ---
app.whenReady().then(async () => {
  initLocale();
  installApplicationMenu();

  // Belt-and-suspenders CSP: set via response header in addition to the <meta> tag.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [RENDERER_CSP],
      },
    });
  });

  // If an installer is currently mid-install, bail out before showing any UI.
  try {
    const { checkUpdateInProgress } = require('./updater');
    if (checkUpdateInProgress()) {
      await dialog.showMessageBox({
        type: 'info',
        title: t('update.inProgressTitle'),
        message: t('update.inProgressMessage'),
        buttons: ['OK'],
      });
      app.quit();
      return;
    }
  } catch {}

  const filePath = getFilePathFromArgs(process.argv);
  const win = createWindow(filePath);
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => { if (!win.isDestroyed()) checkRecovery(win); }, 2000);
    setTimeout(() => {
      if (!win.isDestroyed()) {
        try {
          const { checkForUpdates } = require('./updater');
          checkForUpdates(win, t);
        } catch {}
      }
    }, 4000);
  });
});

ipcMain.on('update-action', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  try {
    const { handleUpdateAction } = require('./updater');
    handleUpdateAction(win, action);
  } catch {}
});

app.on('window-all-closed', () => app.quit());

// Closing OrPAD must STOP any in-flight orchestration run — kill the agent child
// process tree so it stops occupying resources (it does not survive the app).
app.on('before-quit', () => {
  try { require('./orchestration-core/core.cjs').cancelAllRuns(); } catch (_) { /* best effort */ }
  try { require('./orchestration-core/tui-observer.cjs').stopAll(); } catch (_) { /* best effort */ }
  try { require('./orchestration-core/tui-detect-observer.cjs').stopAllTuiDetect(); } catch (_) { /* best effort */ }
});
app.on('activate', () => {
  if (windows.size === 0) createWindow(null);
});
