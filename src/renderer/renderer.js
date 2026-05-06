import { initAnalytics, track, sizeBucket, stackSig } from './analytics.js';
import { createAdapterPicker } from './orchestration/adapter-picker.js';
import { createBudgetMeter } from './orchestration/budget-meter.js';
import {
  failedAdapterCallsFromRecord as sharedFailedAdapterCalls,
  runArtifactAbsPath as sharedRunArtifactAbsPath,
  lifecycleSuppressesFallback as sharedLifecycleSuppressesFallback,
} from '../shared/orchestration/failure-summary.js';
import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorSelection, EditorState, Prec, Transaction } from '@codemirror/state';
import { keymap, ViewPlugin } from '@codemirror/view';
import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  copyLineUp,
  moveLineDown,
  moveLineUp,
  redo as cmRedo,
  toggleBlockComment,
  toggleComment,
  undo as cmUndo,
} from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { foldCode, foldedRanges, foldEffect, syntaxHighlighting, unfoldCode } from '@codemirror/language';
import { openSearchPanel, selectMatches, selectNextOccurrence } from '@codemirror/search';
import { languages } from '@codemirror/language-data';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { xml } from '@codemirror/lang-xml';
import { html as htmlLang } from '@codemirror/lang-html';
import yamljs from 'js-yaml';
import Papa from 'papaparse';
import { parse as tomlParse } from 'smol-toml';
import DOMPurify from 'dompurify';
import svgPanZoom from 'svg-pan-zoom';
import { SpreadsheetGrid } from './spreadsheet-grid.js';
import { JSONEditor } from './json-editor.js';
import ini from 'ini';
import { jsonrepair } from 'jsonrepair';
import { JSONPath } from 'jsonpath-plus';
import Ajv from 'ajv';
import TurndownService from 'turndown';
import { classHighlighter } from '@lezer/highlight';
import { acceptCompletion, autocompletion, completionStatus } from '@codemirror/autocomplete';
import { vim } from '@replit/codemirror-vim';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import { gfmHeadingId } from 'marked-gfm-heading-id';
import hljs from 'highlight.js/lib/core';
import hljsBash from 'highlight.js/lib/languages/bash';
import hljsCpp from 'highlight.js/lib/languages/cpp';
import hljsCsharp from 'highlight.js/lib/languages/csharp';
import hljsCss from 'highlight.js/lib/languages/css';
import hljsDiff from 'highlight.js/lib/languages/diff';
import hljsGo from 'highlight.js/lib/languages/go';
import hljsJava from 'highlight.js/lib/languages/java';
import hljsJavascript from 'highlight.js/lib/languages/javascript';
import hljsJson from 'highlight.js/lib/languages/json';
import hljsMarkdown from 'highlight.js/lib/languages/markdown';
import hljsPowershell from 'highlight.js/lib/languages/powershell';
import hljsPython from 'highlight.js/lib/languages/python';
import hljsRust from 'highlight.js/lib/languages/rust';
import hljsSql from 'highlight.js/lib/languages/sql';
import hljsTypescript from 'highlight.js/lib/languages/typescript';
import hljsXml from 'highlight.js/lib/languages/xml';
import hljsYaml from 'highlight.js/lib/languages/yaml';
import katex from 'katex';
import { t, setLocale, getLocaleCode, LANGUAGES } from './i18n.js';
import { initAISidebar } from './ai/index.js';
import { createTerminalPanel } from './terminal/panel.js';
import { openTemplatePicker } from './ui/template-picker.js';
import { getCommands, registerCommand, registerCommands, runCommand } from './commands/registry.js';
import { createCommandPalette } from './command-palette/palette.js';
import { createQuickOpen } from './command-palette/quick-open.js';
import { gitHunkGutter, updateGitHunkGutter } from './git/hunk-gutter.js';
import {
  aheadBehind as gitAheadBehind,
  currentBranch as gitCurrentBranch,
  diffAgainstHead as gitDiffAgainstHead,
  listBranches as gitListBranches,
  checkoutBranch as gitCheckoutBranch,
  relativePath as gitRelativePath,
  revertFile as gitRevertFile,
  status as gitStatus,
} from './git/git.js';
import { analyzeTemplate, findSectionRange, replaceSectionContent, updateChecklistProgressFrontmatter } from './templates/tracker.js';
import { buildFragmentShareUrl, sharedByteLength, SHARE_GIST_BYTES, SHARE_WARN_BYTES } from '../web/url-sharing.js';
import {
  DEFAULT_USER_SNIPPETS,
  createSnippetCompletionSource,
  expandSnippetShortcut,
  getAllSnippetFormats,
  getSnippetsForFormat,
  insertSnippet,
  parseUserSnippets,
  setUserSnippets,
} from './snippets/registry.js';
import {
  builtinThemes, applyThemeColors,
  getSavedThemeId, saveThemeId,
  getCustomThemes, addCustomTheme, updateCustomThemeColors,
  updateCustomThemeName, deleteCustomTheme,
  CUSTOMIZE_GROUPS, deriveFullColors,
} from './themes.js';

[
  ['bash', hljsBash],
  ['cpp', hljsCpp],
  ['csharp', hljsCsharp],
  ['css', hljsCss],
  ['diff', hljsDiff],
  ['go', hljsGo],
  ['java', hljsJava],
  ['javascript', hljsJavascript],
  ['json', hljsJson],
  ['markdown', hljsMarkdown],
  ['powershell', hljsPowershell],
  ['python', hljsPython],
  ['rust', hljsRust],
  ['sql', hljsSql],
  ['typescript', hljsTypescript],
  ['xml', hljsXml],
  ['yaml', hljsYaml],
].forEach(([name, language]) => hljs.registerLanguage(name, language));

// ==================== KaTeX extension for marked ====================
const katexBlock = {
  name: 'katexBlock',
  level: 'block',
  start(src) { return src.indexOf('$$'); },
  tokenizer(src) {
    const match = src.match(/^\$\$\s*\n([\s\S]*?)\n\s*\$\$/);
    if (match) return { type: 'katexBlock', raw: match[0], text: match[1].trim() };
  },
  renderer(token) {
    try { return '<div class="katex-block">' + katex.renderToString(token.text, { displayMode: true, throwOnError: false }) + '</div>'; }
    catch { return '<div class="katex-block katex-error">' + token.text + '</div>'; }
  },
};
const katexInline = {
  name: 'katexInline',
  level: 'inline',
  start(src) { return src.indexOf('$'); },
  tokenizer(src) {
    const match = src.match(/^\$([^\$\n]+?)\$/);
    if (match) return { type: 'katexInline', raw: match[0], text: match[1] };
  },
  renderer(token) {
    try { return katex.renderToString(token.text, { displayMode: false, throwOnError: false }); }
    catch { return '<code class="katex-error">' + token.text + '</code>'; }
  },
};

// ==================== Highlight extension for marked ====================
const highlightInline = {
  name: 'highlight',
  level: 'inline',
  start(src) { return src.indexOf('=='); },
  tokenizer(src) {
    const match = src.match(/^==((?!=).+?)==/);
    if (match) return { type: 'highlight', raw: match[0], text: match[1] };
  },
  renderer(token) {
    return '<mark>' + token.text + '</mark>';
  },
};

// ==================== Wiki Link extension for marked ====================
const wikiLink = {
  name: 'wikiLink',
  level: 'inline',
  start(src) { return src.indexOf('[['); },
  tokenizer(src) {
    const match = src.match(/^\[\[([^\]\|]+?)(?:\|([^\]]+?))?\]\]/);
    if (match) return { type: 'wikiLink', raw: match[0], target: match[1].trim(), display: (match[2] || match[1]).trim() };
  },
  renderer(token) {
    const escaped = token.target.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const display = token.display.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<a class="wiki-link" data-wiki-target="' + escaped + '">' + display + '</a>';
  },
};

// ==================== FNV-1a 32-bit hash + LRU cache ====================
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  return (h >>> 0).toString(36);
}

class LRU {
  constructor(cap) { this.cap = cap; this.m = new Map(); }
  get(k) {
    if (!this.m.has(k)) return undefined;
    const v = this.m.get(k); this.m.delete(k); this.m.set(k, v); return v;
  }
  set(k, v) {
    if (this.m.has(k)) this.m.delete(k);
    else if (this.m.size >= this.cap) this.m.delete(this.m.keys().next().value);
    this.m.set(k, v);
  }
}

// ==================== Mermaid code block renderer ====================
let mermaidReady = false;
let mermaidModule = null;
const mermaidRenderer = {
  code(tokenOrText, maybeLang) {
    const text = String(typeof tokenOrText === 'object' ? tokenOrText.text || '' : tokenOrText || '');
    const lang = typeof tokenOrText === 'object' ? tokenOrText.lang : maybeLang;
    if (lang === 'mermaid') {
      const h = hash32(text);
      return '<div class="mermaid-block" data-mermaid="' + escapeHtml(text) + '" data-mermaid-hash="' + h + '">' + escapeHtml(text) + '</div>';
    }
    return false;
  },
};

// ==================== Markdown Parser ====================
const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      if (lang === 'mermaid') return code;
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
      return hljs.highlightAuto(code).value;
    },
  }),
  gfmHeadingId(),
  { gfm: true, breaks: false, extensions: [katexBlock, katexInline, highlightInline, wikiLink], renderer: mermaidRenderer }
);

// ==================== DOM ====================
const contentEl = document.getElementById('content');
const welcomeEl = document.getElementById('welcome');
const fileInfoEl = document.getElementById('file-info');
const templateStatusHost = document.createElement('span');
templateStatusHost.id = 'template-status-host';
fileInfoEl?.insertAdjacentElement('afterend', templateStatusHost);
const workspaceEl = document.getElementById('workspace');
const editorPaneEl = document.getElementById('editor-pane');
const previewPaneEl = document.getElementById('preview-pane');
const dividerEl = document.getElementById('divider');
const statusCursorEl = document.getElementById('status-cursor');
const statusVimEl = document.createElement('span');
statusVimEl.id = 'status-vim-mode';
statusVimEl.className = 'status-chip hidden';
statusCursorEl?.insertAdjacentElement('afterend', statusVimEl);
const statusSelectionEl = document.getElementById('status-selection');
const statusWordsEl = document.getElementById('status-words');
const statusReadTimeEl = document.getElementById('status-readtime');
const statusZoomEl = document.getElementById('status-zoom');
const statusGitEl = document.createElement('button');
statusGitEl.id = 'status-git';
statusGitEl.className = 'status-git hidden';
statusGitEl.type = 'button';
statusZoomEl?.insertAdjacentElement('beforebegin', statusGitEl);
const btnAiEl = document.getElementById('btn-ai');
const tabListEl = document.getElementById('tab-list');
const sidebarEl = document.getElementById('sidebar');
const fileTreeEl = document.getElementById('file-tree');
const searchInputEl = document.getElementById('search-input');
const searchResultsEl = document.getElementById('search-results');
const searchStatusEl = document.getElementById('search-status');
const tocNav = document.getElementById('toc');
const backlinksContentEl = document.getElementById('backlinks-content');
const runbooksContentEl = document.getElementById('runbooks-content');

// ==================== Platform gating ====================
// Detect the browser build so workspace features can fall back gracefully.
// The File System Access API supplies folder picking and handle-based I/O on
// Chromium; Firefox / Safari have no equivalent yet and the adapter surfaces
// a clear error when Open Folder is clicked there. Only UI whose backing
// behavior cannot exist on the web at all (OS default-app registration,
// reveal-in-explorer, auto-updater) is hidden here.
const IS_WEB = window.orpad?.platform === 'web';
const BUILD_TARGET_WEB = process.env.ORPAD_WEB === 'true';
if (IS_WEB) {
  const hideIds = ['btn-set-default', 'ctx-reveal', 'tctx-reveal'];
  hideIds.forEach((id) => { const el = document.getElementById(id); if (el) el.hidden = true; });
}

// ==================== Sentry (renderer) ====================
// Opt-out check: if localStorage["sentry-opt-out"] is truthy, skip init.
// TODO: expose "Send crash reports" toggle in the Settings UI once one exists.
if (!BUILD_TARGET_WEB && !IS_WEB && !localStorage.getItem('sentry-opt-out')) {
  try {
    require('@sentry/electron/renderer').init({
      tracesSampleRate: 0.1,
      beforeSend(event) {
        delete event.user;
        if (event.breadcrumbs?.values) {
          for (const bc of event.breadcrumbs.values) {
            if (typeof bc.message === 'string') {
              bc.message = bc.message.replace(/[^/\\]+\.(?:env|key|pem)\b/gi, '<redacted>');
            }
          }
        }
        return event;
      },
    });
  } catch {}
}

// ==================== State ====================
let tocScrolling = false;
let tocScrollHandler = null;
let autoSaveTimer = null;
let debounceTimer = null;
let editorMouseDown = false;
let terminalController = null;
let aiController = null;
let commandPalette = null;
let quickOpen = null;
let vimEnabled = localStorage.getItem('editor.vim') === 'true';
let minimapEnabled = localStorage.getItem('editor.minimap') === 'true';
let zenChordArmed = false;
let zenChordTimer = null;
let aiContextRefreshTimer = null;

function syncAiToolbarButton(visible = aiController?.isVisible?.() === true) {
  if (!btnAiEl) return;
  btnAiEl.classList.toggle('active', !!visible);
  btnAiEl.setAttribute('aria-pressed', String(!!visible));
  btnAiEl.title = visible ? t('ai.toolbar.hide') : t('ai.toolbar.show');
}

function scheduleAIContextRefresh(delay = 0) {
  if (aiContextRefreshTimer) clearTimeout(aiContextRefreshTimer);
  aiContextRefreshTimer = setTimeout(() => {
    aiContextRefreshTimer = null;
    aiController?.refreshActiveContext?.();
  }, delay);
}

// Tab state
const tabs = [];
let activeTabId = null;
let tabIdCounter = 0;
const closedEditorSessionState = new Map();
let switchingTabs = false;
let tabCountTimer = null;
function trackTabCountThrottled() {
  if (tabCountTimer) return;
  tabCountTimer = setTimeout(() => {
    track('tab_count', { count: String(tabs.length) });
    tabCountTimer = null;
  }, 5000);
}

// Web beforeunload guard - the adapter installs the listener, we supply the predicate.
if (IS_WEB && typeof window.orpad.__setDirtyProbe === 'function') {
  window.orpad.__setDirtyProbe(() => tabs.some((tb) => tb.isModified));
}

function getRecoveryKey(tab) {
  return tab.filePath || ('untitled-' + tab.id);
}

// CodeMirror stores the doc with LF only (CRLF/CR are normalized on input),
// so editor.state.doc.toString() always returns LF-joined text. Keep the
// "last saved" reference in the same form - otherwise a freshly-opened
// Windows file looks dirty the moment we re-compare on tab switch.
function normalizeLineEndings(s) {
  return s == null ? '' : String(s).replace(/\r\n?/g, '\n');
}

function normalizeComparablePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isPathInsideWorkspace(filePath) {
  if (!workspacePath || !filePath) return false;
  const root = normalizeComparablePath(workspacePath);
  const full = normalizeComparablePath(filePath);
  return full === root || full.startsWith(root + '/');
}

// Sidebar state
let sidebarVisible = true;
let sidebarActivePanel = 'files';

// Workspace/file tree state
let workspacePath = localStorage.getItem('orpad-workspace-path') || null;
const expandedPaths = new Set();
let fileTreeCache = [];
let workspaceRunbookSummary = null;
let selectedRunbookPath = null;
let selectedRunbookValidation = null;
let lastRunRecord = null;
let runbookScanRequestId = 0;
const RUNBOOK_TASK_STORAGE_KEY = 'orpad-runbook-task';
let runbookDraftTask = localStorage.getItem(RUNBOOK_TASK_STORAGE_KEY) || '';
const EXTERNAL_RESEARCH_INTENT_PATTERN = /\b(search|competing products|competitors?|market|benchmarks?|benchmarking|web research|external research|browse|internet|online)\b/i;
const runbookValidationCache = new Map();
const runbookRecordCache = new Map();
const machineRunRecordCache = new Map();
const machineRunListCache = new Map();
const machineRunStartPendingPaths = new Set();
const machineRunPendingActions = new Map();
const machineRunProgressTimers = new Map();
const machineRunExternalResearchDecisions = new Map();
const machinePatchReviewShown = new Set();
let lastMachineRunRecord = null;
let machineCapabilityToken = '';
let machineRuntimeStatus = null;
let machineRuntimeStatusLoading = false;
let gitRepoState = { isRepo: false, statuses: new Map(), branch: null, ahead: null, behind: null, slow: false };
let gitStatusTimer = null;
let gitRefreshToken = 0;
let gitHunkTimer = null;
let snippetsRefreshTimer = null;
let userSnippetsPath = null;
let userSnippetsSource = 'none';

// Search state
let searchRegex = false;
let searchCaseSensitive = false;
let searchDebounceTimer = null;

// Context menu state
let contextMenuTarget = null;
let contextMenuIsDir = false;

// ==================== Zoom ====================
const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;
const ZOOM_DEFAULT = 100;
let zoomLevel = parseInt(localStorage.getItem('orpad-zoom'), 10) || ZOOM_DEFAULT;

function applyZoom(level) {
  zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
  const scale = zoomLevel / 100;
  const scroller = document.querySelector('.cm-scroller');
  if (scroller) scroller.style.fontSize = (14 * scale) + 'px';
  contentEl.style.fontSize = (16 * scale) + 'px';
  // CSS `zoom` is non-standard and breaks intrinsic width measurement of children,
  // which made wide markdown content (long pre/inline-code paragraphs) refuse to
  // wrap. Stick to font-size scaling only - images/SVGs don't grow with zoom now,
  // but text reflows correctly at every zoom level.
  contentEl.style.zoom = '';
  localStorage.setItem('orpad-zoom', zoomLevel);
  statusZoomEl.textContent = zoomLevel + '%';
}

// Global Ctrl+Z/Y override for structured viewers (grid, JSON editor).
// Their inline inputs would otherwise swallow the shortcut and keep CodeMirror's
// undo stack unreachable. After undo/redo we re-run renderPreview to rebuild the
// structured view from the new document text.
// Exception: diff panel textareas manage their own undo - left side syncs to
// CodeMirror via the 'input' event (which fires on native undo), right side
// has an independent history that must not be hijacked.
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  const tab = getActiveTab();
  if (!tab) return;
  const key = e.key.toLowerCase();
  const isUndo = key === 'z' && !e.shiftKey;
  const isRedo = key === 'y' || (key === 'z' && e.shiftKey);
  if (!isUndo && !isRedo) return;
  const active = document.activeElement;
  if (active && active.closest && active.closest('.diff-text')) return; // native textarea undo/redo
  if (isOrchViewType(tab.viewType) && contentEl.querySelector('.orch-preview')) {
    if (active && active.closest && active.closest('input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault();
    e.stopPropagation();
    if (!runOrchHistoryCommand(isUndo ? 'undo' : 'redo')) runCodeMirrorHistoryCommand(isUndo ? 'undo' : 'redo', true);
    return;
  }
  const structuredViews = new Set(['csv', 'tsv', 'json', 'jsonl', 'yaml', 'toml', 'ini']);
  if (!structuredViews.has(tab.viewType)) return;
  e.preventDefault();
  e.stopPropagation();
  if (active instanceof HTMLElement) active.blur();
  if (isUndo) cmUndo(editor);
  else cmRedo(editor);
}, true);

// Use capture phase on document to intercept before CodeMirror handles it
document.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  if (!workspaceEl.contains(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
  applyZoom(zoomLevel + delta);
}, { passive: false, capture: true });

statusZoomEl.addEventListener('click', () => applyZoom(ZOOM_DEFAULT));

// ==================== Theme ====================
let currentThemeId = getSavedThemeId() || (window.orpad?.getSystemTheme ? null : 'tokyo-night');
let editingCustomId = null;

function getThemeById(id) {
  if (builtinThemes[id]) return builtinThemes[id];
  const customs = getCustomThemes();
  if (customs[id]) return customs[id];
  return builtinThemes['github-light'];
}

async function initTheme() {
  if (!currentThemeId) {
    const sys = await window.orpad.getSystemTheme();
    currentThemeId = 'tokyo-night';
  }
  const theme = getThemeById(currentThemeId);
  applyThemeColors(theme.colors);
  saveThemeId(currentThemeId);
}

function switchTheme(id) {
  currentThemeId = id;
  saveThemeId(id);
  editingCustomId = null;
  const theme = getThemeById(id);
  applyThemeColors(theme.colors);
  renderThemePanel();
}

// ==================== Theme Panel ====================
const themePanel = document.getElementById('theme-panel');
const themeListEl = document.getElementById('theme-list');
const customizeFieldsEl = document.getElementById('customize-fields');

// Keep the fixed-position theme panel aligned with the bottom of the top-bar
// stack. The stack height varies (format-bar hides when no tab is open, and
// tab-bar collapses to its 1px border when tabs.length === 0), so a hardcoded
// top leaves a visible gap. Publish the live bottom via a CSS variable that
// #theme-panel reads. ResizeObserver catches tab-bar row wrap + format-bar
// show/hide; the window listener covers viewport resize.
function updateTopBarsBottom() {
  const tabBar = document.getElementById('tab-bar');
  if (!tabBar) return;
  const bottom = tabBar.getBoundingClientRect().bottom;
  document.documentElement.style.setProperty('--top-bars-bottom', bottom + 'px');
}
{
  const ro = new ResizeObserver(updateTopBarsBottom);
  ro.observe(document.getElementById('toolbar'));
  ro.observe(document.getElementById('format-bar'));
  ro.observe(document.getElementById('tab-bar'));
  window.addEventListener('resize', updateTopBarsBottom);
  // Initial measurement - wait one frame so the layout has settled.
  requestAnimationFrame(updateTopBarsBottom);
}

document.getElementById('btn-theme').addEventListener('click', () => {
  themePanel.classList.toggle('hidden');
  if (!themePanel.classList.contains('hidden')) {
    updateTopBarsBottom();
    renderThemePanel();
  }
});
document.getElementById('theme-panel-close').addEventListener('click', () => themePanel.classList.add('hidden'));
document.addEventListener('mousedown', (e) => {
  if (!themePanel.classList.contains('hidden') && !themePanel.contains(e.target) && !e.target.closest('#btn-theme')) {
    themePanel.classList.add('hidden');
  }
});

document.getElementById('btn-add-theme').addEventListener('click', () => {
  const newId = addCustomTheme('My Theme', currentThemeId);
  switchTheme(newId);
  editingCustomId = newId;
  renderThemePanel();
});

function renderThemePanel() {
  renderThemeList();
  renderCustomizeFields();
}

function renderThemeList() {
  themeListEl.innerHTML = '';
  const builtinLabel = document.createElement('div');
  builtinLabel.className = 'theme-section-label';
  builtinLabel.textContent = t('builtIn');
  themeListEl.appendChild(builtinLabel);
  for (const [id, theme] of Object.entries(builtinThemes)) {
    themeListEl.appendChild(createThemeItem(id, theme, false));
  }
  const customs = getCustomThemes();
  if (Object.keys(customs).length > 0) {
    const customLabel = document.createElement('div');
    customLabel.className = 'theme-section-label';
    customLabel.textContent = t('myThemes');
    themeListEl.appendChild(customLabel);
    for (const [id, theme] of Object.entries(customs)) {
      themeListEl.appendChild(createThemeItem(id, theme, true));
    }
  }
}

function createThemeItem(id, theme, isCustom) {
  const item = document.createElement('div');
  item.className = 'theme-item' + (id === currentThemeId ? ' active' : '');
  const c = theme.colors;
  const swatch = document.createElement('div');
  swatch.className = 'theme-swatch';
  swatch.innerHTML = `
    <div class="theme-swatch-quarter" style="background:${c.bgPrimary}"></div>
    <div class="theme-swatch-quarter" style="background:${c.accentColor}"></div>
    <div class="theme-swatch-quarter" style="background:${c.syntaxKeyword}"></div>
    <div class="theme-swatch-quarter" style="background:${c.syntaxString}"></div>`;
  const name = document.createElement('span');
  name.className = 'theme-item-name';
  name.textContent = theme.name;
  item.appendChild(swatch);
  item.appendChild(name);
  if (isCustom) {
    const actions = document.createElement('div');
    actions.className = 'theme-item-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'theme-action-btn';
    editBtn.title = t('tooltip.editTheme');
    editBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/></svg>';
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); switchTheme(id); editingCustomId = id; renderThemePanel(); });
    const delBtn = document.createElement('button');
    delBtn.className = 'theme-action-btn';
    delBtn.title = t('tooltip.deleteTheme');
    delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/></svg>';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteCustomTheme(id); if (currentThemeId === id) switchTheme('github-light'); editingCustomId = null; renderThemePanel(); });
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    item.appendChild(actions);
  }
  item.addEventListener('click', () => { switchTheme(id); if (isCustom) { editingCustomId = id; renderThemePanel(); } });
  return item;
}

function renderCustomizeFields() {
  customizeFieldsEl.innerHTML = '';
  if (!editingCustomId) { customizeFieldsEl.classList.add('hidden'); return; }
  customizeFieldsEl.classList.remove('hidden');
  const customs = getCustomThemes();
  const theme = customs[editingCustomId];
  if (!theme) return;
  const nameRow = document.createElement('div');
  nameRow.className = 'customize-name-row';
  nameRow.innerHTML = `<label>${t('themeName')}</label>`;
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'customize-name-input';
  nameInput.value = theme.name;
  nameInput.addEventListener('change', () => { updateCustomThemeName(editingCustomId, nameInput.value); renderThemeList(); });
  nameRow.appendChild(nameInput);
  customizeFieldsEl.appendChild(nameRow);
  for (const group of CUSTOMIZE_GROUPS) {
    const div = document.createElement('div');
    div.className = 'customize-group';
    div.innerHTML = `<div class="customize-group-label">${t(group.i18n)}</div>`;
    for (const field of group.fields) {
      let val = theme.colors[field.key] || '#888888';
      if (val.startsWith('rgba') || val.startsWith('rgb')) val = '#888888';
      const row = document.createElement('div');
      row.className = 'customize-row';
      row.innerHTML = `<label>${t(field.i18n)}</label><input type="color" value="${val}" data-key="${field.key}">`;
      row.querySelector('input').addEventListener('input', (e) => { onCustomColorChange(field.key, e.target.value); });
      div.appendChild(row);
    }
    customizeFieldsEl.appendChild(div);
  }
}

function onCustomColorChange(key, value) {
  if (!editingCustomId) return;
  const customs = getCustomThemes();
  const theme = customs[editingCustomId];
  if (!theme) return;
  const updated = { ...theme.colors, [key]: value };
  const isDark = theme.type === 'dark';
  const full = deriveFullColors(updated, isDark);
  updateCustomThemeColors(editingCustomId, full);
  applyThemeColors(full);
}

// ==================== Wiki-link autocomplete ====================
let cachedFileNames = [];

async function refreshFileNameCache() {
  if (!workspacePath) { cachedFileNames = []; return; }
  try {
    const names = await window.orpad.getFileNames(workspacePath);
    cachedFileNames = names.map(n => n.baseName);
  } catch { cachedFileNames = []; }
}

function wikiLinkCompletions(context) {
  // Match [[ followed by any non-] characters
  const before = context.matchBefore(/\[\[[^\]]*$/);
  if (!before) return null;

  const prefix = before.text.slice(2); // text after [[
  const filtered = cachedFileNames
    .filter(name => name.toLowerCase().includes(prefix.toLowerCase()))
    .sort((a, b) => {
      // Exact start match first
      const aStarts = a.toLowerCase().startsWith(prefix.toLowerCase());
      const bStarts = b.toLowerCase().startsWith(prefix.toLowerCase());
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return a.localeCompare(b);
    })
    .slice(0, 20)
    .map(name => ({
      label: name,
      apply: name + ']]',
      type: 'file',
    }));

  return {
    from: before.from + 2,
    options: filtered,
    filter: false,
  };
}

// ==================== Snippets ====================
const snippetCompletionSource = createSnippetCompletionSource(() => getActiveTab()?.viewType || 'markdown');

function workspaceSnippetPaths() {
  if (!workspacePath) return null;
  const sep = workspacePath.includes('\\') ? '\\' : '/';
  const root = workspacePath.replace(/[\\/]+$/, '');
  const folder = root + sep + '.orpad';
  return { folder, file: folder + sep + 'snippets.json' };
}

function isUserSnippetPath(filePath) {
  if (!filePath || !userSnippetsPath) return false;
  return String(filePath).replace(/\\/g, '/').toLowerCase() === String(userSnippetsPath).replace(/\\/g, '/').toLowerCase();
}

async function readWorkspaceSnippets() {
  const paths = workspaceSnippetPaths();
  if (!paths) return null;
  const result = await window.orpad.readFile(paths.file);
  if (result?.error) return null;
  return { ...result, source: 'workspace' };
}

async function readFallbackSnippets() {
  if (window.orpad.userSnippets?.read) {
    const result = await window.orpad.userSnippets.read();
    if (!result?.error) return { ...result, source: 'userData' };
  }
  const raw = localStorage.getItem('orpad-user-snippets');
  return {
    filePath: 'localStorage:orpad-user-snippets',
    dirPath: null,
    content: raw || '{}',
    source: 'localStorage',
  };
}

async function refreshUserSnippets() {
  try {
    const result = await readWorkspaceSnippets() || await readFallbackSnippets();
    userSnippetsPath = result?.filePath || null;
    userSnippetsSource = result?.source || 'none';
    const parsed = parseUserSnippets(result?.content || '{}');
    setUserSnippets(parsed);
  } catch (err) {
    console.warn('[snippets] failed to load user snippets', err);
    setUserSnippets({});
  }
}

function scheduleSnippetRefresh(delay = 250) {
  if (snippetsRefreshTimer) clearTimeout(snippetsRefreshTimer);
  snippetsRefreshTimer = setTimeout(refreshUserSnippets, delay);
}

async function ensureWorkspaceSnippetFile() {
  const paths = workspaceSnippetPaths();
  if (!paths) return null;
  await window.orpad.createFolder(paths.folder).catch(() => {});
  let result = await window.orpad.readFile(paths.file);
  if (result?.error) {
    await window.orpad.createFile(paths.file).catch(() => {});
    await window.orpad.saveFile(paths.file, DEFAULT_USER_SNIPPETS).catch(() => {});
    result = await window.orpad.readFile(paths.file);
  }
  return {
    filePath: paths.file,
    dirPath: paths.folder,
    content: result?.content || DEFAULT_USER_SNIPPETS,
    savedContent: result?.content || DEFAULT_USER_SNIPPETS,
  };
}

async function editUserSnippets() {
  let target = null;
  if (workspacePath) {
    target = await ensureWorkspaceSnippetFile();
  } else if (window.orpad.userSnippets?.ensure) {
    const result = await window.orpad.userSnippets.ensure();
    if (!result?.error) target = { ...result, savedContent: result.content };
  } else {
    const content = localStorage.getItem('orpad-user-snippets') || DEFAULT_USER_SNIPPETS;
    target = { filePath: 'localStorage:orpad-user-snippets', dirPath: null, content, savedContent: content, title: 'snippets.json' };
  }
  if (!target) return;
  userSnippetsPath = target.filePath || userSnippetsPath;
  const tab = createTab(target.filePath, target.dirPath, target.content, target.savedContent, {
    title: target.title || null,
    viewType: 'json',
  });
  switchToTab(tab.id);
}

function openSnippetPicker() {
  const format = getActiveTab()?.viewType || 'markdown';
  const applicable = getSnippetsForFormat(format);
  const all = applicable.length ? applicable : getAllSnippetFormats().flatMap(getSnippetsForFormat);
  const body = document.createElement('div');
  body.className = 'snippet-picker';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Filter snippets...';
  const list = document.createElement('div');
  list.className = 'snippet-picker-list';
  body.appendChild(input);
  body.appendChild(list);

  let selected = 0;
  let filtered = [];
  const render = () => {
    const query = input.value.trim().toLowerCase();
    filtered = all
      .filter(item => !query || `${item.name} ${item.description} ${item.format}`.toLowerCase().includes(query))
      .slice(0, 60);
    selected = Math.max(0, Math.min(selected, filtered.length - 1));
    list.innerHTML = '';
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'snippet-picker-empty';
      empty.textContent = 'No snippets found.';
      list.appendChild(empty);
      return;
    }
    filtered.forEach((item, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'snippet-picker-item' + (index === selected ? ' selected' : '');
      btn.innerHTML = `<strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.description || item.format)}</span><kbd>${escapeHtml(item.source)}</kbd>`;
      btn.addEventListener('mousemove', () => { selected = index; render(); });
      btn.addEventListener('click', () => accept(index));
      list.appendChild(btn);
    });
  };
  const accept = (index = selected) => {
    const item = filtered[index];
    if (!item) return;
    closeFmtModal();
    insertSnippet(editor, item);
  };
  input.addEventListener('input', () => { selected = 0; render(); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); selected = filtered.length ? (selected + 1) % filtered.length : 0; render(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); selected = filtered.length ? (selected - 1 + filtered.length) % filtered.length : 0; render(); }
    else if (event.key === 'Enter') { event.preventDefault(); accept(); }
  });
  render();
  openFmtModal({
    title: 'Insert Snippet...',
    body,
    footer: [
      { label: 'Edit User Snippets', onClick: () => { closeFmtModal(); editUserSnippets(); } },
      { label: 'Close', onClick: closeFmtModal },
      { label: 'Insert', primary: true, onClick: () => accept() },
    ],
  });
  setTimeout(() => input.focus(), 0);
}

// ==================== Format routing ====================
function getViewType(filePath) {
  const name = (filePath || '').toLowerCase();
  if (/\.(md|markdown|mkd|mdx)$/.test(name)) return 'markdown';
  if (/\.mmd$/.test(name)) return 'mermaid';
  if (/\.(jsonl|ndjson)$/.test(name)) return 'jsonl';
  if (/\.or-pipeline$/.test(name)) return 'orch-pipeline';
  if (/\.or-graph$/.test(name)) return 'orch-graph';
  if (/\.or-tree$/.test(name)) return 'orch-tree';
  if (/\.(or-rule|or-run)$/.test(name)) return 'json';
  if (/\.orch-graph\.json$/.test(name)) return 'orch-graph';
  if (/\.orch-tree\.json$/.test(name)) return 'orch-tree';
  if (/\.orch$/.test(name)) return 'orch-tree';
  if (/\.json$/.test(name)) return 'json';
  if (/\.ya?ml$/.test(name)) return 'yaml';
  if (/\.(html?|htm)$/.test(name)) return 'html';
  if (/\.xml$/.test(name)) return 'xml';
  if (/\.csv$/.test(name)) return 'csv';
  if (/\.tsv$/.test(name)) return 'tsv';
  if (/\.toml$/.test(name)) return 'toml';
  if (/\.(ini|conf)$/.test(name)) return 'ini';
  if (/\.properties$/.test(name)) return 'properties';
  if (/(^|[\\/])\.env$/.test(name) || /\.env$/.test(name)) return 'env';
  return 'plain';
}

function getLangExtension(viewType) {
  switch (viewType) {
    case 'markdown':
    case 'mermaid':
      return markdown({ base: markdownLanguage, codeLanguages: languages });
    case 'orch-pipeline':
    case 'orch-graph':
    case 'orch-tree':
    case 'json': return json();
    case 'yaml': return yaml();
    case 'xml':  return xml();
    case 'html': return htmlLang();
    default: return null;
  }
}

function viewTypeDisplayLabel(viewType) {
  const labels = {
    'orch-pipeline': 'Pipeline',
    'orch-graph': 'Flow',
    'orch-tree': 'Tree',
    jsonl: 'JSONL',
    yaml: 'YAML',
    toml: 'TOML',
    csv: 'CSV',
    tsv: 'TSV',
    html: 'HTML',
    xml: 'XML',
    env: 'Env',
  };
  const raw = String(viewType || '').trim();
  return labels[raw] || (raw ? raw.toUpperCase() : '');
}

const BINARY_EXTS = new Set([
  'exe','dll','so','dylib','bin','msi','app','class','jar',
  'zip','rar','7z','tar','gz','bz2','xz',
  'png','jpg','jpeg','gif','bmp','ico','webp','tiff',
  'mp4','avi','mov','wmv','mkv','webm','mp3','wav','ogg','flac','m4a',
  'pdf','doc','docx','xls','xlsx','ppt','pptx',
  'db','sqlite',
]);

function isSupportedFormat(filename) {
  const name = (filename || '').toLowerCase();
  const m = name.match(/\.([^./\\]+)$/);
  const ext = m ? m[1] : '';
  if (!ext) return true; // no extension - Dockerfile, Makefile, dotfiles, etc.
  return !BINARY_EXTS.has(ext);
}

// ==================== CodeMirror Editor ====================
const vimCompartment = new Compartment();
const minimapCompartment = new Compartment();

const editorUxKeymap = [
  {
    key: 'Tab',
    run: (view) => {
      if (expandSnippetShortcut(view, getActiveTab()?.viewType || 'markdown')) return true;
      if (completionStatus(view.state) === 'active') return acceptCompletion(view);
      return false;
    },
  },
  { key: 'Mod-Alt-ArrowUp', run: addCursorAbove },
  { key: 'Mod-Alt-ArrowDown', run: addCursorBelow },
  { key: 'Mod-d', run: selectNextOccurrence },
  { key: 'Mod-Shift-l', run: selectMatches },
  { key: 'Alt-ArrowUp', run: moveLineUp },
  { key: 'Alt-ArrowDown', run: moveLineDown },
  { key: 'Shift-Alt-ArrowUp', run: copyLineUp },
  { key: 'Shift-Alt-ArrowDown', run: copyLineDown },
  { key: 'Mod-/', run: toggleComment },
  { key: 'Mod-Shift-/', run: toggleBlockComment },
  { key: 'Mod-?', run: toggleBlockComment },
  { key: 'Mod-Shift-[', run: foldCode },
  { key: 'Mod-Shift-]', run: unfoldCode },
  { key: 'Mod-{', run: foldCode },
  { key: 'Mod-}', run: unfoldCode },
];

const vimStatusExtension = EditorView.domEventHandlers({
  keydown() { requestAnimationFrame(updateVimStatusBar); return false; },
  keyup() { requestAnimationFrame(updateVimStatusBar); return false; },
  focus() { requestAnimationFrame(updateVimStatusBar); return false; },
});

function getVimExtensions() {
  return vimEnabled ? [vim({ status: false }), vimStatusExtension] : [];
}

const minimapExtension = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.raf = 0;
    this.dom = document.createElement('div');
    this.dom.className = 'orpad-minimap';
    this.dom.title = 'Click to jump in the document';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'orpad-minimap-canvas';
    this.dom.appendChild(this.canvas);
    this.onPointerDown = (event) => this.jump(event);
    this.dom.addEventListener('pointerdown', this.onPointerDown);
    this.view.dom.classList.add('orpad-minimap-enabled');
    this.view.dom.appendChild(this.dom);
    this.scheduleRender();
  }

  update(update) {
    if (update.docChanged || update.viewportChanged || update.selectionSet || update.geometryChanged) {
      this.scheduleRender();
    }
  }

  scheduleRender() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  render() {
    const doc = this.view.state.doc;
    const width = this.dom.clientWidth || 72;
    const height = this.view.scrollDOM.clientHeight || this.view.dom.clientHeight || 1;
    const dpr = window.devicePixelRatio || 1;
    const canvasWidth = Math.max(1, Math.floor(width * dpr));
    const canvasHeight = Math.max(1, Math.floor(height * dpr));
    if (this.canvas.width !== canvasWidth || this.canvas.height !== canvasHeight) {
      this.canvas.width = canvasWidth;
      this.canvas.height = canvasHeight;
      this.canvas.style.width = width + 'px';
      this.canvas.style.height = height + 'px';
    }

    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const styles = getComputedStyle(this.view.dom);
    const textColor = styles.getPropertyValue('--text-secondary').trim() || 'rgba(160, 166, 190, 0.7)';
    const accentColor = styles.getPropertyValue('--accent-color').trim() || '#7aa2f7';
    const gutterColor = styles.getPropertyValue('--border-color').trim() || 'rgba(120, 124, 153, 0.35)';
    const step = Math.max(1, Math.ceil(doc.lines / Math.max(1, height)));
    const lineHeight = Math.max(1, height / Math.max(1, doc.lines));

    ctx.fillStyle = gutterColor;
    ctx.fillRect(0, 0, 1, height);
    for (let lineNo = 1; lineNo <= doc.lines; lineNo += step) {
      const line = doc.line(lineNo);
      const y = Math.floor(((lineNo - 1) / Math.max(1, doc.lines)) * height);
      const trimmed = line.text.trimStart();
      ctx.fillStyle = trimmed.startsWith('#') || /^[\]}),;]+$/.test(trimmed) ? accentColor : textColor;
      ctx.globalAlpha = trimmed ? 0.64 : 0.18;
      const barWidth = Math.max(3, Math.min(width - 8, (trimmed.length / 120) * (width - 8)));
      ctx.fillRect(4, y, barWidth, Math.max(1, lineHeight));
    }
    ctx.globalAlpha = 1;

    const viewportStart = doc.lineAt(this.view.viewport.from).number;
    const viewportEnd = doc.lineAt(this.view.viewport.to).number;
    const top = ((viewportStart - 1) / Math.max(1, doc.lines)) * height;
    const bottom = (viewportEnd / Math.max(1, doc.lines)) * height;
    ctx.fillStyle = accentColor;
    ctx.globalAlpha = 0.18;
    ctx.fillRect(0, top, width, Math.max(6, bottom - top));
    ctx.globalAlpha = 0.62;
    ctx.strokeStyle = accentColor;
    ctx.strokeRect(0.5, top + 0.5, width - 1, Math.max(6, bottom - top) - 1);
    ctx.globalAlpha = 1;
  }

  jump(event) {
    event.preventDefault();
    const rect = this.dom.getBoundingClientRect();
    const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
    const lineNo = Math.max(1, Math.min(this.view.state.doc.lines, Math.round(ratio * this.view.state.doc.lines)));
    const line = this.view.state.doc.line(lineNo);
    this.view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    this.view.focus();
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.remove();
    this.view.dom.classList.remove('orpad-minimap-enabled');
  }
});

function getMinimapExtensions() {
  return minimapEnabled ? [minimapExtension] : [];
}

function getSessionStateKey(filePath) {
  return filePath ? filePath.replace(/\\/g, '/').toLowerCase() : null;
}

function cacheClosedEditorSessionState(tab) {
  const key = getSessionStateKey(tab?.filePath);
  if (!key) return;
  const state = tab.id === activeTabId ? editor.state : tab.editorState;
  const scroller = tab.id === activeTabId ? document.querySelector('.cm-scroller') : null;
  const folds = [];
  try {
    foldedRanges(state).between(0, state.doc.length, (from, to) => folds.push({ from, to }));
  } catch {}
  closedEditorSessionState.set(key, {
    selection: state.selection.toJSON(),
    folds,
    scrollTop: {
      editor: scroller ? scroller.scrollTop : tab.scrollTop?.editor || 0,
      preview: tab.id === activeTabId ? contentEl.scrollTop : tab.scrollTop?.preview || 0,
    },
  });
  while (closedEditorSessionState.size > 50) {
    closedEditorSessionState.delete(closedEditorSessionState.keys().next().value);
  }
}

function restoreEditorSessionState(state, filePath) {
  const cached = closedEditorSessionState.get(getSessionStateKey(filePath));
  if (!cached) return state;
  const spec = {};
  try { spec.selection = EditorSelection.fromJSON(cached.selection); } catch {}
  const folds = (cached.folds || [])
    .filter(({ from, to }) => Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to <= state.doc.length && from < to)
    .map((range) => foldEffect.of(range));
  if (folds.length) spec.effects = folds;
  return Object.keys(spec).length ? state.update(spec).state : state;
}

function getRestoredScrollTop(filePath) {
  return closedEditorSessionState.get(getSessionStateKey(filePath))?.scrollTop || { editor: 0, preview: 0 };
}

function createEditorState(content, viewType = 'markdown') {
  const langExt = getLangExtension(viewType);
  return EditorState.create({
    doc: content,
    extensions: [
      basicSetup,
      syntaxHighlighting(classHighlighter),
      ...(langExt ? [langExt] : []),
      autocompletion({ override: [wikiLinkCompletions, snippetCompletionSource], activateOnTyping: true }),
      EditorView.lineWrapping,
      gitHunkGutter,
      EditorView.domEventHandlers({
        drop(e) {
          const linkName = e.dataTransfer.getData('application/x-orpad-link');
          if (!linkName) return false;
          e.preventDefault();
          const pos = editor.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos !== null) {
            const insert = '[[' + linkName + ']]';
            editor.dispatch({ changes: { from: pos, insert } });
            editor.focus();
          }
          return true;
        },
        dragover(e) {
          if (e.dataTransfer.types.includes('application/x-orpad-link')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            return true;
          }
          return false;
        },
      }),
      EditorView.updateListener.of((update) => {
        if (switchingTabs) return;
        if (update.docChanged) onEditorChange();
        if (update.selectionSet && !editorMouseDown) {
          syncPreviewToEditor();
        }
        if (update.selectionSet && !editorMouseDown) updateStatusBar();
        if (update.docChanged || update.selectionSet) updateVimStatusBar();
        if (update.docChanged || update.selectionSet) scheduleAIContextRefresh(80);
      }),
      Prec.highest(keymap.of(editorUxKeymap)),
      keymap.of([
        { key: 'Mod-s', run: () => { saveFile(); return true; } },
        { key: 'Mod-Shift-s', run: () => { saveFileAs(); return true; } },
      ]),
      vimCompartment.of(getVimExtensions()),
      minimapCompartment.of(getMinimapExtensions()),
    ],
  });
}

const editor = new EditorView({
  state: createEditorState(''),
  parent: document.getElementById('editor'),
});
document.getElementById('editor').addEventListener('contextmenu', () => {
  if (getActiveTab()?.viewType === 'markdown') {
    window.dispatchEvent(new CustomEvent('orpad-ai-open-actions', { detail: { format: 'markdown', scope: getEditorSelectionText() ? 'selection' : 'document' } }));
  }
});

function applyEditorUxCompartments() {
  if (!editor?.state) return;
  editor.dispatch({
    effects: [
      vimCompartment.reconfigure(getVimExtensions()),
      minimapCompartment.reconfigure(getMinimapExtensions()),
    ],
  });
  updateVimStatusBar();
}

function setVimEnabled(enabled) {
  vimEnabled = !!enabled;
  localStorage.setItem('editor.vim', vimEnabled ? 'true' : 'false');
  applyEditorUxCompartments();
  editor.focus();
}

function setMinimapEnabled(enabled) {
  minimapEnabled = !!enabled;
  localStorage.setItem('editor.minimap', minimapEnabled ? 'true' : 'false');
  applyEditorUxCompartments();
}

function updateVimStatusBar() {
  if (!statusVimEl) return;
  statusVimEl.classList.toggle('hidden', !vimEnabled);
  if (!vimEnabled) {
    statusVimEl.textContent = '';
    return;
  }
  const vimState = editor?.cm?.state?.vim;
  let mode = vimState?.mode || (vimState?.visualMode ? 'visual' : vimState?.insertMode ? 'insert' : 'normal');
  if (vimState?.visualBlock) mode = 'visual block';
  else if (vimState?.visualLine) mode = 'visual line';
  const label = String(mode || 'normal').replace(/\s+.*/, '').toUpperCase();
  statusVimEl.textContent = label;
  statusVimEl.title = 'Vim mode is on. Use the command palette to toggle Vim mode if normal-mode keys are capturing input.';
}

function updateZenLayoutClass() {
  const tab = getActiveTab();
  const proseTypes = new Set(['markdown', 'txt', 'text', 'log']);
  document.body.classList.toggle('zen-prose', document.body.classList.contains('zen-mode') && proseTypes.has(tab?.viewType || 'markdown'));
}

function setZenMode(enabled) {
  document.body.classList.toggle('zen-mode', !!enabled);
  updateZenLayoutClass();
  if (enabled) editor.focus();
}

function toggleZenMode() {
  setZenMode(!document.body.classList.contains('zen-mode'));
}

function runEditorCommand(command) {
  editor.focus();
  const handled = command(editor);
  updateStatusBar();
  return handled;
}

// Bidirectional scroll sync uses a pair of one-shot blocks so whichever
// direction is actively driving briefly silences the other.
// - P2E (preview - or) is held until the preview's smooth scroll actually
//   ends, detected via the `scrollend` event on previewPaneEl. A fixed
//   timer is unreliable here: smooth scrollIntoView's duration scales with
//   distance and can exceed 600ms, which used to let the capture-phase
//   scroll handler teleport the editor mid-animation and produce a visible
//   "overshoot + return" flicker after a long TOC jump.
// - E2P (editor - iew) is short: EditorView.scrollIntoView is instant,
//   so 150ms covers the single resulting scroll event and keeps the
//   forward path responsive to cursor moves that follow a preview scroll.
const BLOCK_E2P_MS = 150;
const BLOCK_P2E_SAFETY_MS = 1500;
let blockEditorToPreview = false;  // set by preview - or sync
let blockPreviewToEditor = false;  // set by editor - iew sync
let blockE2PTimer = null;
let blockP2ESafetyTimer = null;
let blockP2EScrollEndHandler = null;

function blockEditorToPreviewBriefly(ms = BLOCK_E2P_MS) {
  blockEditorToPreview = true;
  if (blockE2PTimer) clearTimeout(blockE2PTimer);
  blockE2PTimer = setTimeout(() => { blockEditorToPreview = false; blockE2PTimer = null; }, ms);
}

function blockPreviewToEditorUntilScrollEnd() {
  blockPreviewToEditor = true;
  if (blockP2ESafetyTimer) { clearTimeout(blockP2ESafetyTimer); blockP2ESafetyTimer = null; }
  if (blockP2EScrollEndHandler) {
    previewPaneEl.removeEventListener('scrollend', blockP2EScrollEndHandler);
    blockP2EScrollEndHandler = null;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    blockPreviewToEditor = false;
    if (blockP2ESafetyTimer) { clearTimeout(blockP2ESafetyTimer); blockP2ESafetyTimer = null; }
    if (blockP2EScrollEndHandler) {
      previewPaneEl.removeEventListener('scrollend', blockP2EScrollEndHandler);
      blockP2EScrollEndHandler = null;
    }
  };
  // scrollend can precede a last trailing scroll frame in some engines;
  // defer one frame so that final event is still filtered.
  blockP2EScrollEndHandler = () => requestAnimationFrame(release);
  previewPaneEl.addEventListener('scrollend', blockP2EScrollEndHandler);
  // Safety: if no scroll actually fires (target already in view, element
  // not scrollable, page hidden during animation) scrollend never arrives.
  blockP2ESafetyTimer = setTimeout(release, BLOCK_P2E_SAFETY_MS);
}

// Sync preview highlight + status bar (called outside of drag)
function syncPreviewToEditor() {
  if (blockEditorToPreview) { updateStatusBar(); return; }
  const pos = editor.state.selection.main.head;
  const line = editor.state.doc.lineAt(pos).number - 1;
  const tab = getActiveTab();
  const viewType = tab?.viewType;
  if (!viewType) { updateStatusBar(); return; }
  blockPreviewToEditorUntilScrollEnd();
  if (viewType === 'markdown') {
    highlightPreviewLine(line);
  } else {
    syncPreviewStructured(viewType, line);
  }
  updateStatusBar();
}

// Reverse direction: preview scroll - editor scroll. Triggered by a capture-
// phase listener on previewPaneEl (scroll doesn't bubble, but does fire in
// capture). Maps the preview's top-most visible "line" back to a document
// line and parks the editor's viewport there.
function syncEditorToPreview() {
  if (blockPreviewToEditor) return;
  if (tocScrolling) return; // TOC jump drives the editor directly; suppress intermediate teleport frames during its smooth preview scroll.
  if (switchingTabs) return;
  const tab = getActiveTab();
  if (!tab) return;
  const viewType = tab.viewType;
  if (!viewType) return;
  const targetLine = computePreviewTopLine(viewType);
  if (targetLine == null) return;
  blockEditorToPreviewBriefly();
  try {
    const docLines = editor.state.doc.lines;
    const lineNo = Math.max(1, Math.min(docLines, targetLine + 1));
    const line = editor.state.doc.line(lineNo);
    editor.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 0 }) });
  } catch {}
}

// Inverse of syncPreviewStructured/highlightPreviewLine. Returns a 0-based
// editor line, or null if we can't derive one for this viewer.
function computePreviewTopLine(viewType) {
  if (viewType === 'markdown') {
    const paneTop = previewPaneEl.getBoundingClientRect().top;
    const elems = contentEl.querySelectorAll('[data-source-line]');
    for (const el of elems) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom >= paneTop) {
        const n = parseInt(el.getAttribute('data-source-line'), 10);
        return Number.isNaN(n) ? 0 : n;
      }
    }
    return 0;
  }
  if ((viewType === 'csv' || viewType === 'tsv') && currentGrid?.scrollEl && currentGrid.theadEl) {
    const rowH = currentGrid.measuredRowHeight || 24;
    const topRow = Math.floor(currentGrid.scrollEl.scrollTop / rowH);
    return Math.max(0, topRow + 1); // +1 for header line in source
  }
  if (viewType === 'jsonl' && currentGrid?.scrollEl && currentGrid.theadEl) {
    const rowH = currentGrid.measuredRowHeight || 24;
    const topRow = Math.floor(currentGrid.scrollEl.scrollTop / rowH);
    return Math.max(0, topRow); // JSONL source has no header row
  }
  const jeditScroll = contentEl.querySelector('.jedit-scroll');
  let container;
  if (jeditScroll) container = jeditScroll;
  else if (contentEl.scrollHeight > contentEl.clientHeight) container = contentEl;
  else container = previewPaneEl;
  const max = container.scrollHeight - container.clientHeight;
  if (max <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, container.scrollTop / max));
  return Math.round(ratio * Math.max(0, editor.state.doc.lines - 1));
}

// Scroll doesn't bubble, but capture-phase listeners catch every descendant
// (contentEl, .jedit-scroll, .sgrid-scroll). One handler covers all viewers.
previewPaneEl.addEventListener('scroll', syncEditorToPreview, { capture: true, passive: true });

// Non-markdown formats don't have per-element line mapping. Use row-based
// sync for grid viewers (CSV/TSV/JSONL) and proportional scroll everywhere
// else - good enough to put "roughly the same place" in view without
// building a full line - nt map for every format.
function syncPreviewStructured(viewType, editorLine) {
  const totalLines = editor.state.doc.lines;
  if (totalLines <= 0) return;

  // CSV/TSV: line 0 is the header row, line N+1 is data row N.
  if ((viewType === 'csv' || viewType === 'tsv') && currentGrid) {
    scrollGridToRow(currentGrid, Math.max(0, editorLine - 1));
    return;
  }
  // JSONL: each editor line is one data record (no header in source).
  if (viewType === 'jsonl' && currentGrid) {
    scrollGridToRow(currentGrid, Math.max(0, editorLine));
    return;
  }

  const ratio = totalLines > 1 ? editorLine / (totalLines - 1) : 0;
  const clamped = Math.max(0, Math.min(1, ratio));

  // Tree viewers (JSON editable / YAML / TOML / INI read-only) keep their
  // scroll inside .jedit-scroll, not on contentEl itself.
  const jeditScroll = contentEl.querySelector('.jedit-scroll');
  if (jeditScroll) {
    const max = jeditScroll.scrollHeight - jeditScroll.clientHeight;
    if (max > 0) jeditScroll.scrollTop = max * clamped;
    return;
  }

  // XML / HTML / plain / etc. - scroll whichever ancestor actually owns the
  // overflow. contentEl is usually the scroller, but preview-pane wraps it
  // when the viewer renders non-scrolling content (e.g. mermaid SVG).
  const target = contentEl.scrollHeight > contentEl.clientHeight ? contentEl : previewPaneEl;
  const max = target.scrollHeight - target.clientHeight;
  if (max > 0) target.scrollTop = max * clamped;
}

function scrollGridToRow(grid, rowIdx) {
  if (!grid || !grid.scrollEl || !grid.theadEl) return;
  const rows = grid.data || [];
  if (rows.length === 0) return;
  const clamped = Math.max(0, Math.min(rows.length - 1, rowIdx));
  const rowH = grid.measuredRowHeight || 24;
  const headerH = grid.theadEl.getBoundingClientRect().height;
  const viewportH = grid.scrollEl.clientHeight;
  const targetTop = clamped * rowH;
  const curTop = grid.scrollEl.scrollTop;
  if (targetTop < curTop) {
    grid.scrollEl.scrollTop = Math.max(0, targetTop - headerH - 2);
  } else if (targetTop + rowH > curTop + viewportH - headerH) {
    grid.scrollEl.scrollTop = targetTop - (viewportH - rowH) + headerH + 2;
  }
  if (grid.virtEnabled && typeof grid.renderVirtWindow === 'function') {
    grid.renderVirtWindow();
  }
}

// Track mouse state on editor - block all updateListener side effects during drag
document.getElementById('editor').addEventListener('mousedown', () => { editorMouseDown = true; });
document.addEventListener('mouseup', () => {
  if (editorMouseDown) {
    editorMouseDown = false;
    syncPreviewToEditor();
  }
});

// ==================== Tab Management ====================
function getActiveTab() {
  return tabs.find(tb => tb.id === activeTabId) || null;
}

function findTabByPath(filePath) {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return tabs.find(tb => tb.filePath && tb.filePath.replace(/\\/g, '/').toLowerCase() === normalized) || null;
}

function getTabDisplayName(tab) {
  return tab?.filePath ? tab.filePath.split(/[/\\]/).pop() : (tab?.title || t('untitled'));
}

function createTab(filePath, dirPath, content, savedContent, options = {}) {
  const existing = filePath ? findTabByPath(filePath) : null;
  if (existing) {
    switchToTab(existing.id);
    return existing;
  }
  const tabName = options.title || filePath;
  const viewType = options.viewType || getViewType(tabName);
  const normContent = normalizeLineEndings(content);
  const normSaved = savedContent !== undefined ? normalizeLineEndings(savedContent) : normContent;
  const editorState = restoreEditorSessionState(createEditorState(normContent, viewType), filePath);
  const scrollTop = getRestoredScrollTop(filePath);
  const tab = {
    id: 'tab-' + (++tabIdCounter),
    filePath: filePath || null,
    dirPath: dirPath || null,
    title: options.title || null,
    source: options.source || null,
    sourceUrl: options.sourceUrl || null,
    viewType,
    pinned: false,
    lastSavedContent: normSaved,
    isModified: options.forceUnsaved === true || normContent !== normSaved,
    editorState,
    scrollTop,
    lastAutoSavedContent: null,
    openedAt: Date.now(),
    mdCache: new LRU(8),
  };
  tabs.push(tab);
  switchToTab(tab.id);
  if (filePath) {
    track('file_open', {
      format: viewType,
      size_bucket: sizeBucket(normContent.length),
      source: IS_WEB ? 'web' : 'local',
    });
    trackTabCountThrottled();
  }
  return tab;
}

function switchToTab(tabId) {
  const currentTab = getActiveTab();
  if (currentTab && currentTab.id !== tabId) {
    currentTab.editorState = editor.state;
    currentTab.isModified = editor.state.doc.toString() !== currentTab.lastSavedContent;
    const scroller = document.querySelector('.cm-scroller');
    currentTab.scrollTop.editor = scroller ? scroller.scrollTop : 0;
    currentTab.scrollTop.preview = contentEl.scrollTop;
  }

  activeTabId = tabId;
  const newTab = getActiveTab();
  if (!newTab) return;

  switchingTabs = true;
  editor.setState(newTab.editorState);
  switchingTabs = false;
  applyEditorUxCompartments();
  newTab.editorState = editor.state;

  // The rAF scroll restore below will fire a preview scroll event. Without
  // this block the capture-phase listener would treat it as user intent and
  // drag the editor to line 0.
  blockPreviewToEditorUntilScrollEnd();

  requestAnimationFrame(() => {
    const scroller = document.querySelector('.cm-scroller');
    if (scroller) scroller.scrollTop = newTab.scrollTop.editor;
    contentEl.scrollTop = newTab.scrollTop.preview;
  });

  renderPreview(editor.state.doc.toString());
  updateFormatBar(newTab.viewType);
  applyDiffWorkspaceMode();
  renderTabBar();
  updateTitle();
  updateStatusBar();
  updateZenLayoutClass();
  refreshGitHunks();
  welcomeEl.classList.add('hidden');
  // Sidebar follows the active tab regardless of viewType - renderPreview only
  // refreshes the outline for markdown, so structured-view tabs would otherwise
  // keep the previous markdown's TOC/backlinks pinned.
  buildTOC();
  if (sidebarActivePanel === 'backlinks') refreshBacklinks();
  if (sidebarActivePanel === 'runbooks') {
    renderRunbooksPanel();
  }
  aiController?.refreshActiveContext?.({ force: true });

  // RB-1: opening one file grants that file only. Workspace authority comes
  // from the main process after Open Folder or trusted restore.
}

async function closeTab(tabId) {
  const tab = tabs.find(tb => tb.id === tabId);
  if (!tab) return;

  if (tab.isModified) {
    if (activeTabId !== tabId) switchToTab(tabId);
    const result = await window.orpad.showSaveDialog();
    if (result === 'save') {
      await saveFile();
      if (getActiveTab()?.isModified) return;
    } else if (result === 'cancel') {
      return;
    } else {
      window.orpad.clearRecovery(getRecoveryKey(tab));
    }
  } else {
    window.orpad.clearRecovery(getRecoveryKey(tab));
  }

  const durationSec = (Date.now() - (tab.openedAt || Date.now())) / 1000;
  if (tab.filePath && durationSec < 3) {
    track('file_quick_close', { format: tab.viewType, duration_sec: String(Math.round(durationSec)) });
  }

  cacheClosedEditorSessionState(tab);
  const idx = tabs.indexOf(tab);
  tabs.splice(idx, 1);
  trackTabCountThrottled();

  if (tabs.length === 0) {
    activeTabId = null;
    switchingTabs = true;
    editor.setState(createEditorState(''));
    switchingTabs = false;
    updateVimStatusBar();
    updateZenLayoutClass();
    updateGitHunkGutter(editor, []);
    contentEl.innerHTML = '';
    if (tocScrollHandler) { contentEl.removeEventListener('scroll', tocScrollHandler); tocScrollHandler = null; }
    tocNav.innerHTML = '';
    welcomeEl.classList.remove('hidden');
    updateFormatBar(null);
    document.body.classList.remove('json-diff-mode');
    updateTitle();
    renderTabBar();
    aiController?.refreshActiveContext?.({ force: true });
    return;
  }

  if (activeTabId === tabId) {
    const newIdx = Math.min(idx, tabs.length - 1);
    switchToTab(tabs[newIdx].id);
  } else {
    renderTabBar();
  }
}

const ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" aria-hidden="true"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.5-4.5a2 2 0 0 1-.1-.6V5a2 2 0 0 0-2-2H8.6a2 2 0 0 0-2 2v6.9a2 2 0 0 1-.1.6L5 17z"/></svg>';

function renderTabBar() {
  tabListEl.innerHTML = '';
  // Keep pinned tabs at the front of the row, preserving their relative order.
  const ordered = [...tabs].sort((a, b) => (b.pinned === true) - (a.pinned === true));
  for (const tab of ordered) {
    const el = document.createElement('div');
    el.className = 'tab-item'
      + (tab.id === activeTabId ? ' active' : '')
      + (tab.isModified ? ' modified' : '')
      + (tab.pinned ? ' pinned' : '')
      + (tab.source ? ' source-' + tab.source : '');
    el.draggable = !tab.pinned;
    el.dataset.tabId = tab.id;

    if (tab.isModified) {
      const dot = document.createElement('span');
      dot.className = 'tab-modified-dot';
      el.appendChild(dot);
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tab-name';
    const name = getTabDisplayName(tab);
    nameSpan.textContent = name;
    nameSpan.title = tab.sourceUrl
      ? `${name}\nUnsaved (from URL)\n${tab.sourceUrl}`
      : (tab.filePath || t('untitled'));

    const pinBtn = document.createElement('button');
    pinBtn.className = 'tab-pin-btn';
    pinBtn.innerHTML = ICON_PIN;
    pinBtn.title = tab.pinned ? t('context.unpin') : t('context.pin');
    pinBtn.addEventListener('click', (e) => { e.stopPropagation(); tab.pinned = !tab.pinned; renderTabBar(); });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = t('tooltip.closeTab');
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id); });

    el.appendChild(nameSpan);
    el.appendChild(pinBtn);
    el.appendChild(closeBtn);

    el.addEventListener('click', () => switchToTab(tab.id));
    el.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); showTabContextMenu(e.clientX, e.clientY, tab.id); });

    // Drag reorder
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', tab.id); el.classList.add('dragging'); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over-tab'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over-tab'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over-tab');
      const draggedId = e.dataTransfer.getData('text/plain');
      const draggedIdx = tabs.findIndex(tb => tb.id === draggedId);
      const targetIdx = tabs.findIndex(tb => tb.id === tab.id);
      if (draggedIdx !== -1 && targetIdx !== -1 && draggedIdx !== targetIdx) {
        const [moved] = tabs.splice(draggedIdx, 1);
        tabs.splice(targetIdx, 0, moved);
        renderTabBar();
      }
    });

    tabListEl.appendChild(el);
  }
  requestAnimationFrame(assignTabRows);
}

function assignTabRows() { /* no-op: simple VSCode-style flat multi-row tabs */ }

// ==================== Tab context menu ====================
let tabContextTargetId = null;

function showTabContextMenu(x, y, tabId) {
  const menu = document.getElementById('tab-context-menu');
  const tab = tabs.find(tb => tb.id === tabId);
  if (!tab) return;
  tabContextTargetId = tabId;
  document.getElementById('tctx-pin').textContent = tab.pinned ? t('context.unpin') : t('context.pin');
  document.getElementById('tctx-reveal').style.display = tab.filePath ? '' : 'none';
  const others = tabs.filter(tb => tb.id !== tabId && !tb.pinned).length;
  document.getElementById('tctx-close-others').style.display = others > 0 ? '' : 'none';
  menu.classList.remove('hidden');
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - mw - 4) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - mh - 4) + 'px';
}

document.addEventListener('click', () => document.getElementById('tab-context-menu').classList.add('hidden'));

document.getElementById('tctx-close').addEventListener('click', () => {
  if (tabContextTargetId) closeTab(tabContextTargetId);
});
document.getElementById('tctx-close-others').addEventListener('click', () => {
  if (!tabContextTargetId) return;
  const targets = tabs.filter(tb => tb.id !== tabContextTargetId && !tb.pinned).map(tb => tb.id);
  (async () => { for (const id of targets) await closeTab(id); })();
});
document.getElementById('tctx-close-all').addEventListener('click', () => {
  const targets = tabs.filter(tb => !tb.pinned).map(tb => tb.id);
  (async () => { for (const id of targets) await closeTab(id); })();
});
document.getElementById('tctx-pin').addEventListener('click', () => {
  const tab = tabs.find(tb => tb.id === tabContextTargetId);
  if (!tab) return;
  tab.pinned = !tab.pinned;
  renderTabBar();
});
document.getElementById('tctx-reveal').addEventListener('click', () => {
  const tab = tabs.find(tb => tb.id === tabContextTargetId);
  if (tab?.filePath) window.orpad.revealInExplorer(tab.filePath);
});

// ==================== Editor change handling ====================
function onEditorChange() {
  if (switchingTabs) return;
  const tab = getActiveTab();
  if (!tab) return;
  const content = editor.state.doc.toString();
  const wasModified = tab.isModified;
  tab.isModified = content !== tab.lastSavedContent;
  tab.editorState = editor.state;
  renderTemplateStatusChip();
  if (wasModified !== tab.isModified) {
    updateTitle();
    renderTabBar();
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => renderPreview(content), 200);
  scheduleGitHunkRefresh();
}

function updateTitle() {
  const tab = getActiveTab();
  const shareBtn = document.getElementById('btn-share');
  if (shareBtn) {
    shareBtn.hidden = !IS_WEB;
    shareBtn.disabled = !tab;
  }
  if (!tab) {
    fileInfoEl.textContent = '';
    fileInfoEl.title = '';
    renderTemplateStatusChip();
    window.orpad.setTitle('OrPAD');
    return;
  }
  const name = getTabDisplayName(tab);
  const sourceLabel = tab.source ? ' - Unsaved (from URL)' : '';
  fileInfoEl.textContent = (tab.isModified ? '* ' : '') + name + sourceLabel;
  fileInfoEl.title = tab.sourceUrl || tab.filePath || '';
  renderTemplateStatusChip();
  window.orpad.setTitle((tab.isModified ? '* ' : '') + name + ' - OrPAD');
}

function showSaveFlash() {
  fileInfoEl.classList.add('saved-flash');
  setTimeout(() => fileInfoEl.classList.remove('saved-flash'), 1500);
}

function activeTemplateAnalysis() {
  const tab = getActiveTab();
  if (!tab || tab.viewType !== 'markdown') return null;
  const content = tab.id === activeTabId ? editor.state.doc.toString() : tab.editorState?.doc?.toString?.() || '';
  return analyzeTemplate(content);
}

function openTemplateStatusPopover(analysis) {
  if (!analysis) return;
  const body = document.createElement('div');
  body.className = 'template-status-popover';
  const title = document.createElement('h3');
  title.textContent = analysis.label;
  const summary = document.createElement('p');
  summary.textContent = `${analysis.completedCount}/${analysis.totalCount} required sections complete. ${analysis.uncheckedCount} unchecked tasks.`;
  body.append(title, summary);

  const list = document.createElement('div');
  list.className = 'template-section-list';
  for (const section of analysis.requiredSections) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'template-section-row';
    const missing = analysis.missingSections.includes(section);
    row.innerHTML = `<span>${missing ? '!' : 'OK'}</span><strong>${section}</strong><small>${missing ? 'Needs content' : 'Looks filled'}</small>`;
    row.addEventListener('click', () => {
      closeFmtModal();
      window.dispatchEvent(new CustomEvent('orpad-ai-fill-template-section', { detail: { section } }));
    });
    list.appendChild(row);
  }
  body.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'template-popover-actions';
  if (analysis.templateId === 'task-list') {
    for (const label of ['Import from GitHub Issues', 'Import from Linear', 'Import from Task Master']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.addEventListener('click', () => notifyFormatError('Templates', new Error('Enable the matching MCP server in AI > MCP. Phase 1 exposes the hook; full import mapping is Phase 2.')));
      actions.appendChild(btn);
    }
  }
  if (analysis.templateId === 'handover') {
    const handover = document.createElement('button');
    handover.type = 'button';
    handover.textContent = 'Load into next AI chat';
    handover.addEventListener('click', () => {
      closeFmtModal();
      window.dispatchEvent(new CustomEvent('orpad-ai-load-handover', {
        detail: { content: editor.state.doc.toString() },
      }));
    });
    actions.appendChild(handover);
  }
  if (actions.childElementCount) body.appendChild(actions);

  openFmtModal({
    title: 'Template status',
    body,
    footer: [
      {
        label: 'Complete remaining sections',
        primary: true,
        onClick: () => {
          closeFmtModal();
          window.dispatchEvent(new CustomEvent('orpad-ai-complete-template', {
            detail: { sections: analysis.missingSections },
          }));
        },
      },
      { label: 'Close', onClick: closeFmtModal },
    ],
  });
}

function renderTemplateStatusChip() {
  if (!templateStatusHost) return;
  templateStatusHost.innerHTML = '';
  const analysis = activeTemplateAnalysis();
  if (!analysis) return;
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'template-status-chip' + (analysis.missingSections.length ? ' warning' : '');
  chip.textContent = `${analysis.missingSections.length ? '! ' : ''}${analysis.template.label} ${analysis.completedCount}/${analysis.totalCount} sections - ${analysis.uncheckedCount} unchecked`;
  chip.title = 'Template status';
  chip.addEventListener('click', () => openTemplateStatusPopover(analysis));
  templateStatusHost.appendChild(chip);
}

function prepareTemplateContentForSave(content) {
  const analysis = analyzeTemplate(content);
  if (!analysis) return content;
  return updateChecklistProgressFrontmatter(content, analysis.checklistProgress);
}

function createTabFromTemplate(file) {
  const tab = createTab(null, null, file.content || '', '', { forceUnsaved: true });
  tab.title = file.filename || 'template.md';
  tab.viewType = file.format || 'markdown';
  tab.editorState = createEditorState(file.content || '', tab.viewType);
  tab.isModified = true;
  editor.setState(tab.editorState);
  renderPreview(file.content || '');
  updateFormatBar(tab.viewType);
  updateTitle();
  renderTabBar();
  editor.focus();
  track('template_create', { template: file.template?.id || 'unknown' });
  return tab;
}

function openNewFromTemplate() {
  openTemplatePicker({
    openModal: openFmtModal,
    closeModal: closeFmtModal,
    notify: notifyFormatError,
    onCreate: createTabFromTemplate,
  });
}

// ==================== Preview ====================
let skipNextRenderPreview = false;
let currentGrid = null;
let currentJsonEditor = null;
// Last rendered (tabId, viewType, content) - lets renderPreview skip redundant re-renders
// when CodeMirror's debounced updateListener fires with the same content (common after
// undo/redo races or focus changes).
let lastRendered = { tabId: null, viewType: null, content: null };

function invalidateRenderCache() { lastRendered = { tabId: null, viewType: null, content: null }; }

function disposeStructuredViewers() {
  if (currentGrid) {
    try { currentGrid.destroy(); } catch {}
    currentGrid = null;
  }
  if (currentJsonEditor) {
    try { currentJsonEditor.destroy(); } catch {}
    currentJsonEditor = null;
  }
  currentDiffPanel = null;
  // Don't invalidate render cache here - disposeStructuredViewers runs inside
  // renderPreview itself, and wiping would cancel the cache we're about to populate.
  // Callers that genuinely change state (mode toggles, theme swaps) invalidate directly.
}

const FORMAT_BAR_VIEWS = new Set(['markdown', 'csv', 'tsv', 'json', 'jsonl', 'orch-pipeline', 'orch-graph', 'orch-tree', 'yaml', 'toml', 'ini', 'html', 'xml', 'mermaid', 'env']);
let jsonViewMode = 'tree'; // 'tree' | 'diff'
let orchTreeGraphMode = 'readonly'; // 'readonly' | 'readwrite'
let selectedOrchNodePath = '';
let selectedOrchNodePaths = new Set();
let selectedOrchEdgeId = '';
let orchGraphTool = 'select'; // 'select' | 'hand'
let orchGraphTemporaryTool = '';
let orchGraphViewport = { x: 0, y: 0, scale: 1 };
let orchGraphFitAfterRender = true;
let orchGridSnapEnabled = false;
let orchTempSnap = false;
let orchHistoryBatchDepth = 0;
let orchNodeClickTimer = 0;
let suppressOrchContextMenuUntil = 0;
let suppressOrchContextMenuPoint = null;
const orchGraphMetaCache = new Map();
let currentDiffPanel = null; // { el, recompute } - valid while diff panel is mounted
// Set when the left diff textarea echoes into CodeMirror - the debounced renderPreview
// would otherwise trigger a second recompute for the same keystroke.
let suppressNextDiffRecompute = false;
let mmdTheme = localStorage.getItem('orpad-mmd-theme') || 'dark';

function updateFormatBar(viewType) {
  const bar = document.getElementById('format-bar');
  if (!bar) return;
  // Hide bar only when no tab is active. Otherwise show bar (possibly empty).
  bar.hidden = !viewType;
  for (const group of bar.querySelectorAll('.fmt-group')) {
    const views = (group.dataset.view || '').split(',').map(s => s.trim());
    group.hidden = !views.includes(viewType);
  }
  if (viewType === 'json') {
    const diffBtn = document.getElementById('fmt-json-diff');
    if (diffBtn) diffBtn.classList.toggle('fmt-active', jsonViewMode === 'diff');
  }
}

function renderPreview(content) {
  if (skipNextRenderPreview) { skipNextRenderPreview = false; return; }
  const tab = getActiveTab();
  const viewType = tab?.viewType || 'markdown';
  // Diff panel keeps its own text input state - skip full re-render, just recompute diff.
  if (viewType === 'json' && jsonViewMode === 'diff' && currentDiffPanel && contentEl.contains(currentDiffPanel.el)) {
    if (suppressNextDiffRecompute) { suppressNextDiffRecompute = false; return; }
    currentDiffPanel.recompute();
    return;
  }
  // Skip redundant renders when debounced update fires with identical state.
  // We deliberately skip for formats with side effects (html iframe, mermaid render)
  // that own their refresh lifecycle.
  const tabId = tab?.id ?? null;
  if (
    lastRendered.tabId === tabId &&
    lastRendered.viewType === viewType &&
    lastRendered.content === content
  ) {
    return;
  }
  lastRendered = { tabId, viewType, content };
  disposeStructuredViewers();
  // Markdown typography lives under .markdown-body in base.css; keep that class for
  // the markdown view and drop it for structured views (JSON tree, CSV grid, etc.)
  // where those rules would interfere.
  contentEl.className = 'view-' + viewType + (viewType === 'markdown' ? ' markdown-body' : '');

  if (viewType === 'html')    { renderHTMLPreview(content); return; }
  if (viewType === 'mermaid') { renderMermaidPreview(content); return; }
  if (viewType === 'git-diff') { renderGitDiffPreview(); return; }
  if (viewType === 'orch-pipeline') { renderOrchPipelinePreview(content); return; }
  if (viewType === 'orch-graph') { renderOrchGraphPreview(content); return; }
  if (viewType === 'orch-tree') { renderOrchTreePreview(content); return; }
  if (viewType === 'json')    { renderJSONPreview(content); return; }
  if (viewType === 'jsonl')   { renderJSONLPreview(content); return; }
  if (viewType === 'yaml')    { renderYAMLPreview(content); return; }
  if (viewType === 'csv')     { renderDelimitedPreview(content, ',', 'CSV'); return; }
  if (viewType === 'tsv')     { renderDelimitedPreview(content, '\t', 'TSV'); return; }
  if (viewType === 'toml')    { renderTOMLPreview(content); return; }
  if (viewType === 'ini')     { renderINIPreview(content); return; }
  if (viewType === 'properties') { renderPropertiesPreview(content); return; }
  if (viewType === 'xml')     { renderXMLPreview(content); return; }
  if (viewType === 'env')     { renderEnvPreview(content); return; }
  if (viewType !== 'markdown') {
    contentEl.innerHTML = '<div class="preview-placeholder">No structured preview for this format.</div>';
    return;
  }

  let parsedHtml;
  {
    const mdKey = hash32(content);
    const mdHit = tab?.mdCache?.get(mdKey);
    if (mdHit !== undefined) {
      parsedHtml = mdHit;
    } else {
      parsedHtml = marked.parse(content);
      tab?.mdCache?.set(mdKey, parsedHtml);
    }
  }
  contentEl.innerHTML = parsedHtml;

  const templateAnalysis = activeTemplateAnalysis();
  if (templateAnalysis) {
    contentEl.querySelectorAll('h2, h3, h4, h5, h6').forEach((heading) => {
      const text = heading.textContent?.replace(/\s+#$/, '').trim();
      if (!text || !templateAnalysis.requiredSections.includes(text)) return;
      heading.classList.add('template-heading');
      heading.title = 'Right-click to ask AI to fill this section';
      heading.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('orpad-ai-fill-template-section', {
          detail: { section: text },
        }));
      });
    });
  }

  contentEl.querySelectorAll('a[href]').forEach((link) => {
    const href = link.getAttribute('href');
    if (href.startsWith('http')) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    } else if (/\.(md|markdown|mkd|mdx)$/i.test(href)) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        if (tab?.dirPath) {
          const fullPath = tab.dirPath.replace(/\\/g, '/') + '/' + decodeURIComponent(href);
          openFileInTab(fullPath);
        }
      });
    }
  });

  contentEl.querySelectorAll('a.wiki-link').forEach((link) => {
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      const target = link.dataset.wikiTarget;
      if (!workspacePath) return;
      const resolved = await window.orpad.resolveWikiLink(workspacePath, target);
      if (resolved) {
        openFileInTab(resolved);
      }
    });
  });

  contentEl.querySelectorAll('pre').forEach((pre) => {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = t('copy');
    copyBtn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      if (code) {
        navigator.clipboard.writeText(code.textContent).then(() => {
          copyBtn.textContent = t('copied');
          setTimeout(() => { copyBtn.textContent = t('copy'); }, 2000);
        });
      }
    });
    pre.appendChild(copyBtn);
  });

  // Resolve relative image paths
  const dirPath = tab?.dirPath;
  if (dirPath) {
    contentEl.querySelectorAll('img[src]').forEach((img) => {
      const src = img.getAttribute('src');
      if (src && !src.startsWith('http') && !src.startsWith('data:') && !src.startsWith('file:') && !src.startsWith('/')) {
        img.src = 'file:///' + dirPath.replace(/\\/g, '/') + '/' + src;
      }
    });
  }

  // Wrap every markdown <table> in a scroll container. Without this wrapper
  // Chromium's table sizing (display:block + width:max-content) propagates the
  // table's intrinsic width up through flex ancestors, preventing the preview
  // pane from shrinking when the window is narrowed.
  contentEl.querySelectorAll('table').forEach((tbl) => {
    if (tbl.parentElement?.classList.contains('md-table-scroll')) return;
    const wrap = document.createElement('div');
    wrap.className = 'md-table-scroll';
    tbl.parentNode.insertBefore(wrap, tbl);
    wrap.appendChild(tbl);
  });

  renderMermaidBlocks();
  buildPreviewLineMap(content);

  const pos = editor.state.selection.main.head;
  const curLine = editor.state.doc.lineAt(pos).number - 1;
  highlightPreviewLine(curLine);

  buildTOC();
  if (sidebarActivePanel === 'backlinks') refreshBacklinks();
}

function renderHTMLPreview(content) {
  // Style attributes are permitted: the HTML viewer renders user-authored HTML
  // where CSS styling is expected. All script/frame/form vectors are blocked below.
  // on* event attrs are stripped by DOMPurify by default (no need to enumerate).
  const clean = DOMPurify.sanitize(content, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'meta', 'link', 'base'],
    FORBID_ATTR: ['formaction'],
    ADD_ATTR: ['target'],
    ADD_URI_SAFE_ATTR: [],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel|data:image\/(?:png|jpeg|gif|webp|svg\+xml))/,
  });
  const csp = "default-src 'none'; img-src data: https: http: file:; style-src 'unsafe-inline'; font-src data:;";
  const wrapped = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + csp + '"><style>body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;padding:16px;margin:0;color:#222;}</style></head><body>' + clean + '</body></html>';
  contentEl.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'width:100%;height:100%;border:none;background:white;';
  iframe.sandbox = '';
  iframe.srcdoc = wrapped;
  contentEl.appendChild(iframe);
}

function renderMermaidPreview(content) {
  const esc = content.replace(/"/g, '&quot;');
  contentEl.innerHTML =
    '<div class="mermaid-toolbar">' +
      '<button class="mermaid-action" data-action="reset" title="Reset view">Reset</button>' +
      '<button class="mermaid-action" data-action="svg" title="Save SVG">SVG</button>' +
      '<button class="mermaid-action" data-action="png" title="Save PNG">PNG</button>' +
    '</div>' +
    '<div class="mermaid-block" data-mermaid="' + esc + '">' + escapeHtml(content) + '</div>';
  renderMermaidBlocks().then(() => {
    const block = contentEl.querySelector('.mermaid-block');
    block?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('orpad-ai-open-actions', { detail: { format: 'mermaid', scope: 'node' } }));
    });
    const svg = block?.querySelector('svg');
    if (!svg) return;
    // Snapshot original SVG string before svgPanZoom wraps it in a group.
    const originalSvgText = block.innerHTML;
    let svgSize = { w: 1200, h: 800 };
    try { const bbox = svg.getBBox(); svgSize = { w: Math.ceil(Math.max(400, bbox.width)) * 2, h: Math.ceil(Math.max(300, bbox.height)) * 2 }; } catch {}
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    let panZoom = null;
    try {
      panZoom = svgPanZoom(svg, { zoomEnabled: true, controlIconsEnabled: false, fit: true, center: true, minZoom: 0.3, maxZoom: 10 });
    } catch { /* keep static */ }
    contentEl.querySelectorAll('.mermaid-action').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'reset' && panZoom) { panZoom.resetZoom(); panZoom.resetPan(); panZoom.fit(); panZoom.center(); }
        else if (action === 'svg') { saveSVG(originalSvgText); }
        else if (action === 'png') { exportSVGToPNG(originalSvgText, svgSize); }
      });
    });
  });
}

async function saveSVG(svgString) {
  try { await window.orpad.saveText('diagram.svg', svgString); } catch {}
}

async function exportSVGToPNG(svgString, size) {
  const w = size?.w || 1200;
  const h = size?.h || 800;
  let text = svgString;
  if (!/xmlns=/.test(text)) text = text.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  text = text.replace(/<svg\b([^>]*)>/i, (m, attrs) => {
    let a = attrs;
    if (!/\swidth=/i.test(a)) a += ' width="' + w + '"';
    if (!/\sheight=/i.test(a)) a += ' height="' + h + '"';
    return '<svg' + a + '>';
  });
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim() || '#ffffff';
  try { await window.orpad.svgToPng(text, w, h, bg); }
  catch (err) { console.error('svgToPng failed', err); }
}

// ==================== JSON / YAML / TOML / INI tree view ====================
function mountJSONEditor(content, parseFn, label, { readOnly = false, toggleable = false } = {}) {
  contentEl.innerHTML = '';
  try {
    currentJsonEditor = new JSONEditor(contentEl, {
      content,
      readOnly,
      toggleable,
      parse: parseFn,
      onChange: (serialized) => {
        skipNextRenderPreview = true;
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: serialized } });
      },
    });
  } catch (err) {
    contentEl.innerHTML = '<div class="preview-error">Invalid ' + label + ': ' + escapeHtml(err.message) + '</div>';
  }
}

function renderJSONPreview(content) {
  if (jsonViewMode === 'diff')  { renderJSONDiffPreview(content); return; }
  mountJSONEditor(content, JSON.parse, 'JSON', { readOnly: false, toggleable: true });
}

const ORCH_TREE_NODE_TYPES = [
  'Sequence', 'Selector', 'Parallel', 'Discuss', 'Loop', 'Gate', 'Context',
  'Timeout', 'Retry', 'Catch', 'CrossCheck', 'Skill', 'Planner', 'OrchTree',
];
const ORCH_GRAPH_NODE_TYPES = [
  'orpad.entry', 'orpad.context', 'orpad.gate', 'orpad.selector', 'orpad.skill', 'orpad.tree', 'orpad.graph',
  'orpad.rule', 'orpad.artifactContract', 'orpad.patchReview', 'orpad.exit', 'orpad.probe', 'orpad.workQueue',
  'orpad.triage', 'orpad.dispatcher', 'orpad.workerLoop', 'orpad.barrier',
  'State', 'Tool', 'Human', 'Wait',
];
const ORCH_NODE_TYPE_LABELS = {
  'orpad.entry': 'Entry',
  'orpad.context': 'Context',
  'orpad.gate': 'Gate',
  'orpad.selector': 'Selector',
  'orpad.skill': 'Skill',
  'orpad.tree': 'Tree layer',
  'orpad.graph': 'Flow layer',
  'orpad.rule': 'Rule',
  'orpad.artifactContract': 'Evidence contract',
  'orpad.patchReview': 'Patch review',
  'orpad.exit': 'Exit',
  'orpad.probe': 'Probe',
  'orpad.workQueue': 'Work queue',
  'orpad.triage': 'Triage',
  'orpad.dispatcher': 'Dispatcher',
  'orpad.workerLoop': 'Worker loop',
  'orpad.barrier': 'Barrier',
  State: 'Step',
  Tool: 'Tool',
  Human: 'Human',
  Wait: 'Wait',
};
const ORCH_NODE_WIDTH = 236;
const ORCH_NODE_HEIGHT = 88;
const ORCH_X_GAP = 72;
const ORCH_Y_GAP = 110;
const ORCH_GRAPH_MARGIN = 80;
const ORCH_ZOOM_MIN = 0.35;
const ORCH_FIT_ZOOM_MIN = 0.18;
const ORCH_ZOOM_MAX = 2.2;
const ORCH_GRID_SIZE = 28;
const ORCH_HISTORY_LIMIT = 80;

function isOrchViewType(viewType) {
  return viewType === 'orch-tree' || viewType === 'orch-graph';
}

function isOrchGraphNodeTypeTarget(path) {
  return getActiveTab()?.viewType === 'orch-graph' && !activeOrchGraphLayerPath() && isGraphNodePath(path);
}

function orchNodeTypesForPath(path) {
  return isOrchGraphNodeTypeTarget(path) ? ORCH_GRAPH_NODE_TYPES : ORCH_TREE_NODE_TYPES;
}

function orchNodeTypeLabel(type) {
  const raw = String(type || '').trim();
  if (!raw) return '';
  return ORCH_NODE_TYPE_LABELS[raw] || raw;
}

function orchNodeTypeListLabels(types) {
  return [...new Set((types || [])
    .map(type => orchNodeTypeLabel(type))
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function isOrchSkillType(type) {
  return type === 'Skill' || type === 'orpad.skill';
}

function isOrchTreeRefType(type) {
  return type === 'OrchTree' || type === 'orpad.tree';
}

function isOrchGraphRefType(type) {
  return type === 'orpad.graph';
}

function orchToolIcon(path) {
  return `<svg class="ogi" viewBox="0 0 16 16"><path d="${path}"/></svg>`;
}

const ORCH_TOOL_ICON_SELECT = orchToolIcon('M3 3h10v10H3z');
const ORCH_TOOL_ICON_HAND = orchToolIcon('M8 3v10M3 8h10M5 5l3-3 3 3M5 11l3 3 3-3');
const ORCH_TOOL_ICON_SNAP = orchToolIcon('M4 4h8v8H4zM8 4v8M4 8h8');
const ORCH_TOOL_ICON_ZOOM_OUT = orchToolIcon('M4 8h8');
const ORCH_TOOL_ICON_ZOOM_IN = orchToolIcon('M4 8h8M8 4v8');
const ORCH_TOOL_ICON_FIT = orchToolIcon('M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3');
const ORCH_TOOL_ICON_UNDO = orchToolIcon('M6 4H3v3M3 4c2-2 6-2 8 .5 1.8 2.2.7 5.5-2.5 6.2');
const ORCH_TOOL_ICON_REDO = orchToolIcon('M10 4h3v3M13 4c-2-2-6-2-8 .5-1.8 2.2-.7 5.5 2.5 6.2');

function orchPathToParts(path) {
  if (Array.isArray(path)) return path;
  return String(path || '').split('.').filter(Boolean).map(part => (/^\d+$/.test(part) ? Number(part) : part));
}

function orchValueAtPath(root, path) {
  return orchPathToParts(path).reduce((value, key) => (value == null ? null : value[key]), root);
}

function setOrchSelection(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  selectedOrchNodePaths = new Set(list);
  selectedOrchNodePath = list[0] || '';
  selectedOrchEdgeId = '';
}

function toggleOrchSelection(path) {
  if (!path) return;
  if (selectedOrchNodePaths.has(path)) {
    selectedOrchNodePaths.delete(path);
  } else {
    selectedOrchNodePaths.add(path);
  }
  selectedOrchNodePath = selectedOrchNodePaths.values().next().value || '';
}

function isOrchNodeSelected(path) {
  return selectedOrchNodePath === path || selectedOrchNodePaths.has(path);
}

function isOnlyOrchNodeSelected(path) {
  return !selectedOrchEdgeId && selectedOrchNodePath === path && selectedOrchNodePaths.size === 1 && selectedOrchNodePaths.has(path);
}

function setOrchEdgeSelection(edgeId) {
  selectedOrchEdgeId = edgeId || '';
  selectedOrchNodePath = '';
  selectedOrchNodePaths = new Set();
}

function currentOrchGraphLayerStack() {
  const tab = getActiveTab();
  if (!tab) return [];
  if (!Array.isArray(tab.orchGraphLayerStack)) tab.orchGraphLayerStack = [];
  return tab.orchGraphLayerStack;
}

function activeOrchGraphLayerPath() {
  const stack = currentOrchGraphLayerStack();
  return stack[stack.length - 1]?.path || '';
}

function activeOrchGraphLayerEntry() {
  const stack = currentOrchGraphLayerStack();
  return stack[stack.length - 1] || null;
}

function canOpenOrchSubtree(path, doc = null) {
  if (getActiveTab()?.viewType !== 'orch-graph' || !path) return false;
  let root = doc;
  if (!root) {
    try {
      root = JSON.parse(editor.state.doc.toString());
    } catch {
      return false;
    }
  }
  const node = orchValueAtPath(root, path);
  if (isOrchTreeRefType(node?.type)) return !!node.tree?.root || !!externalOrchTreeLayerTarget(path, root);
  if (isOrchGraphRefType(node?.type)) return !!externalOrchGraphLayerTarget(path, root);
  return false;
}

function splitOrchFileRef(ref) {
  const raw = String(ref || '').trim();
  const hashIndex = raw.indexOf('#');
  return {
    file: hashIndex === -1 ? raw : raw.slice(0, hashIndex),
    anchor: hashIndex === -1 ? '' : raw.slice(hashIndex + 1),
  };
}

function isRemoteOrchRef(ref) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(ref || ''));
}

function runbookDirPath(filePath = getActiveTab()?.filePath) {
  const normalized = runbookNormalizePath(filePath);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

function normalizeRunbookFilePath(value) {
  const raw = runbookNormalizePath(value);
  const drive = raw.match(/^([A-Za-z]:\/)/)?.[1] || '';
  const root = drive || (raw.startsWith('/') ? '/' : '');
  const rest = root ? raw.slice(root.length) : raw;
  const parts = [];
  rest.split('/').forEach((part) => {
    if (!part || part === '.') return;
    if (part === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else if (!root) parts.push(part);
      return;
    }
    parts.push(part);
  });
  return root + parts.join('/');
}

function resolveRunbookFileRef(ref, baseFilePath = getActiveTab()?.filePath) {
  const { file, anchor } = splitOrchFileRef(ref);
  if (!file || isRemoteOrchRef(file)) return null;
  const normalized = runbookNormalizePath(file);
  const isAbsolute = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/');
  const base = runbookDirPath(baseFilePath) || runbookNormalizePath(getActiveTab()?.dirPath || workspacePath || '');
  return {
    filePath: normalizeRunbookFilePath(isAbsolute ? normalized : `${base}/${normalized}`),
    anchor,
  };
}

function firstFileRefFromList(list) {
  return (Array.isArray(list) ? list : []).find(item => item?.type === 'file' && item?.ref)?.ref || '';
}

function orchNodeFileRef(node) {
  if (!node || typeof node !== 'object') return '';
  return node.file
    || node.config?.file
    || node.treeRef
    || node.config?.treeRef
    || node.graphRef
    || node.config?.graphRef
    || node.ref
    || node.config?.ref
    || firstFileRefFromList(node.config?.outputs)
    || firstFileRefFromList(node.outputs)
    || firstFileRefFromList(node.config?.inputs)
    || firstFileRefFromList(node.inputs)
    || '';
}

function orchNodeFileTarget(path, doc = null, baseFilePath = getActiveTab()?.filePath) {
  let root = doc;
  if (!root) {
    try {
      root = JSON.parse(editor.state.doc.toString());
    } catch {
      return null;
    }
  }
  const node = orchValueAtPath(root, path);
  const ref = orchNodeFileRef(node);
  return ref ? resolveRunbookFileRef(ref, baseFilePath) : null;
}

function externalOrchTreeLayerTarget(path, doc = null, baseFilePath = getActiveTab()?.filePath) {
  if (getActiveTab()?.viewType !== 'orch-graph' || !path) return null;
  let root = doc;
  if (!root) {
    try {
      root = JSON.parse(editor.state.doc.toString());
    } catch {
      return null;
    }
  }
  const node = orchValueAtPath(root, path);
  if (!isOrchTreeRefType(node?.type) || node.tree?.root) return null;
  const target = orchNodeFileTarget(path, root, baseFilePath);
  if (!target?.filePath || !(/\.or-tree$/i.test(target.filePath) || /\.orch-tree\.json$/i.test(target.filePath))) return null;
  return target;
}

function externalOrchGraphLayerTarget(path, doc = null, baseFilePath = getActiveTab()?.filePath) {
  if (getActiveTab()?.viewType !== 'orch-graph' || !path) return null;
  let root = doc;
  if (!root) {
    try {
      root = JSON.parse(editor.state.doc.toString());
    } catch {
      return null;
    }
  }
  const node = orchValueAtPath(root, path);
  if (!isOrchGraphRefType(node?.type)) return null;
  const target = orchNodeFileTarget(path, root, baseFilePath);
  if (!target?.filePath || !(/\.or-graph$/i.test(target.filePath) || /\.orch-graph\.json$/i.test(target.filePath))) return null;
  return target;
}

function externalOrchLinkedLayerTarget(path, doc = null, baseFilePath = getActiveTab()?.filePath) {
  return externalOrchTreeLayerTarget(path, doc, baseFilePath)
    || externalOrchGraphLayerTarget(path, doc, baseFilePath);
}

function hasOrchNodeOpenTarget(path, doc = null, baseFilePath = getActiveTab()?.filePath) {
  return canOpenOrchSubtree(path, doc) || !!orchNodeFileTarget(path, doc, baseFilePath);
}

async function openOrchNodeFile(path, doc = null, baseFilePath = getActiveTab()?.filePath) {
  const target = orchNodeFileTarget(path, doc, baseFilePath);
  if (!target?.filePath) return false;
  await openFileFromQuickOpen(target.filePath, { symbol: target.anchor });
  return true;
}

function openOrchNodeTarget(path, doc = null, baseFilePath = getActiveTab()?.filePath) {
  if (canOpenOrchSubtree(path, doc)) return openOrchGraphLayer(path);
  openOrchNodeFile(path, doc, baseFilePath).catch(err => notifyFormatError('Pipeline node file', err));
  return !!orchNodeFileTarget(path, doc, baseFilePath);
}

function pipelineContextForPath(filePath = getActiveTab()?.filePath) {
  const normalized = runbookNormalizePath(filePath);
  const marker = '/.orpad/pipelines/';
  const markerIndex = normalized.toLowerCase().indexOf(marker);
  if (markerIndex === -1) return null;
  const afterMarker = normalized.slice(markerIndex + marker.length);
  const parts = afterMarker.split('/').filter(Boolean);
  const pipelineName = parts[0] || '';
  if (!pipelineName) return null;
  const pipelineDir = normalizeRunbookFilePath(`${normalized.slice(0, markerIndex)}${marker}${pipelineName}`);
  const pipelinePath = normalizeRunbookFilePath(`${pipelineDir}/pipeline.or-pipeline`);
  return {
    pipelineName,
    pipelineDir,
    pipelinePath,
    activePath: normalized,
    activeRelativePath: normalized.toLowerCase().startsWith((pipelineDir + '/').toLowerCase())
      ? normalized.slice(pipelineDir.length + 1)
      : '',
    isManifest: normalized.toLowerCase() === pipelinePath.toLowerCase(),
    isGraph: normalized.toLowerCase().startsWith((pipelineDir + '/graphs/').toLowerCase()) && /\.or-graph$/i.test(normalized),
  };
}

function pipelineEditorGraphPathFromDoc(doc, context = pipelineContextForPath()) {
  const graphRefs = pipelineRefEntries(doc || {}, 'graphs').entries;
  const entryGraph = doc?.entryGraph || doc?.entry?.graph || doc?.graph?.file || graphRefs[0]?.file || '';
  if (!entryGraph || !context?.pipelineDir) return '';
  return normalizeRunbookFilePath(`${context.pipelineDir}/${entryGraph}`);
}

function pipelineEditorCurrentGraphPath(context = pipelineContextForPath()) {
  if (!context) return '';
  if (context.isGraph) return context.activePath;
  return '';
}

function renderPipelineEditorTabs(context, active, graphPath = '') {
  if (!context) return '';
  const manifestPath = context.pipelinePath;
  const resolvedGraphPath = graphPath || pipelineEditorCurrentGraphPath(context);
  return `
    <div class="pipeline-editor-tabs" aria-label="Pipeline setup tabs">
      <button class="${active === 'graph' ? 'active' : ''}" data-pipeline-editor-target="${escapeHtml(resolvedGraphPath)}" ${resolvedGraphPath ? '' : 'disabled'}>Flow</button>
      <button class="${active === 'manifest' ? 'active' : ''}" data-pipeline-editor-target="${escapeHtml(manifestPath)}">Details</button>
    </div>
  `;
}

function selectedPipelineValidation(runbookPath) {
  if (!runbookPath) return null;
  const selectedKey = runbookNormalizePath(selectedRunbookPath).toLowerCase();
  const targetKey = runbookNormalizePath(runbookPath).toLowerCase();
  if (selectedKey && selectedKey === targetKey && selectedRunbookValidation) return selectedRunbookValidation;
  return getRunbookCache(runbookValidationCache, runbookPath);
}

function pipelineDiagnosticDetailText(issue) {
  if (!issue || typeof issue !== 'object') return '';
  const detailLabels = {
    ref: 'ref',
    path: 'path',
    refPath: 'ref path',
    nodeId: 'node',
    id: 'id',
    skillRef: 'skill',
    schema: 'schema',
  };
  return Object.entries(detailLabels)
    .map(([key, label]) => {
      const value = issue[key];
      if (value === undefined || value === null || value === '') return '';
      if (Array.isArray(value)) {
        const list = value.map(item => String(item || '').trim()).filter(Boolean);
        return list.length ? `${label}: ${list.join(', ')}` : '';
      }
      if (typeof value === 'object') return '';
      return `${label}: ${String(value)}`;
    })
    .filter(Boolean)
    .join(', ');
}

function pipelineDiagnosticStatusText(validation) {
  const diagnostics = Array.isArray(validation?.diagnostics) ? validation.diagnostics : [];
  const issue = diagnostics.find(isDiagnosticError) || diagnostics[0];
  if (!issue) return 'Check failed.';
  const parts = [issue.code ? `Check failed: ${issue.code}` : 'Check failed.'];
  if (issue.message) parts.push(String(issue.message));
  const detailText = pipelineDiagnosticDetailText(issue);
  let text = parts.join(' - ');
  if (detailText) text += ` (${detailText})`;
  const remaining = diagnostics.length - 1;
  if (remaining > 0) text += ` + ${remaining} more.`;
  return text;
}

function pipelineValidationDiagnostics(validation) {
  return (Array.isArray(validation?.diagnostics) ? validation.diagnostics : [])
    .filter(issue => isDiagnosticError(issue) || isEntryGraphDeclarationWarning(issue));
}

function pipelineInlineDiagnosticText(issue) {
  if (!issue || typeof issue !== 'object') return '';
  const parts = [issue.code, issue.message].filter(Boolean).map(String);
  const details = pipelineDiagnosticDetailText(issue);
  if (details) parts.push(details);
  return parts.join(' - ');
}

function isEntryGraphDeclarationWarning(issue) {
  return issue?.code === 'PIPELINE_ENTRY_GRAPH_NOT_DECLARED';
}

function renderPipelineInlineDiagnostic(issue) {
  const text = pipelineInlineDiagnosticText(issue);
  if (!text) return '';
  const warning = isEntryGraphDeclarationWarning(issue);
  return `<div class="pipeline-inline-diagnostic ${warning ? 'warning' : 'error'}" role="${warning ? 'status' : 'alert'}">${escapeHtml(text)}</div>`;
}

function normalizeDiagnosticRef(value) {
  return runbookNormalizePath(value).replace(/^\.\/+/, '').toLowerCase();
}

function pipelineEntryDiagnostic(diagnostics) {
  const codes = new Set([
    'PIPELINE_ENTRY_GRAPH_MISSING',
    'PIPELINE_ENTRY_GRAPH_NOT_DECLARED',
    'PIPELINE_ENTRY_GRAPH_NOT_FOUND',
    'PIPELINE_ENTRY_GRAPH_OUTSIDE_PIPELINE',
    'PIPELINE_ENTRY_GRAPH_PARSE_FAILED',
  ]);
  const entryIssues = diagnostics.filter(issue => codes.has(issue.code));
  return entryIssues.find(isDiagnosticError) || entryIssues[0];
}

function pipelineRefDiagnostic(diagnostics, kind, entry) {
  const codes = new Set([
    `${kind.toUpperCase()}_REF_NOT_FOUND`,
    `${kind.toUpperCase()}_REF_OUTSIDE_PIPELINE`,
  ]);
  const entryId = normalizeDiagnosticRef(entry?.id || '');
  const entryFile = normalizeDiagnosticRef(entry?.file || '');
  return diagnostics.find((issue) => {
    if (!codes.has(issue.code)) return false;
    const issueId = normalizeDiagnosticRef(issue.id || '');
    const issueRef = normalizeDiagnosticRef(issue.ref || '');
    return (entryId && issueId === entryId) || (entryFile && issueRef === entryFile);
  });
}

function graphDiagnosticSourcePath(issue) {
  const value = String(issue?.path || issue?.refPath || '');
  const graphPathIndex = value.search(/:(graph|trees)\./);
  if (graphPathIndex === -1) return '';
  return runbookNormalizePath(value.slice(0, graphPathIndex));
}

function normalizeGraphDiagnosticPath(value) {
  const text = String(value || '');
  const graphPathIndex = text.search(/:(graph|trees)\./);
  const local = graphPathIndex === -1 ? text : text.slice(graphPathIndex + 1);
  return local.replace(/\[(\d+)\]/g, '.$1');
}

function graphNodePathFromDiagnostic(issue) {
  const normalized = normalizeGraphDiagnosticPath(issue?.path || '');
  const match = normalized.match(/(?:^|\.)graph\.nodes\.(\d+)(?:\.|$)/);
  return match ? `graph.nodes.${match[1]}` : '';
}

function graphRelativePathForFile(filePath, context = pipelineContextForPath(filePath)) {
  const normalized = runbookNormalizePath(filePath);
  const pipelineDir = runbookNormalizePath(context?.pipelineDir || '').replace(/\/+$/, '');
  if (!normalized || !pipelineDir) return '';
  if (normalized.toLowerCase().startsWith((pipelineDir + '/').toLowerCase())) {
    return normalized.slice(pipelineDir.length + 1);
  }
  return '';
}

function diagnosticMatchesGraphFile(issue, baseFilePath, context = pipelineContextForPath(baseFilePath)) {
  const source = graphDiagnosticSourcePath(issue);
  if (!source) return true;
  const relative = graphRelativePathForFile(baseFilePath, context);
  return !!relative && normalizeDiagnosticRef(source) === normalizeDiagnosticRef(relative);
}

function graphDiagnosticField(issue, node) {
  const path = normalizeGraphDiagnosticPath(issue?.path || '');
  if (issue?.configKey) return `config.${issue.configKey}`;
  if (/\.config\.queueRef$/.test(path) || String(issue?.code || '').startsWith('GRAPH_QUEUE_REF_')) return 'config.queueRef';
  if (/\.config\.workerLoopRef$/.test(path) || String(issue?.code || '').startsWith('GRAPH_WORKER_LOOP_REF_')) return 'config.workerLoopRef';
  if (String(issue?.code || '').startsWith('SKILL_')) return node?.type === 'Skill' ? 'file' : 'config.skillRef';
  if (String(issue?.code || '').startsWith('ORCH_TREE_')) return 'config.treeRef';
  if (String(issue?.code || '').startsWith('ORPAD_GRAPH_')) return 'config.graphRef';
  return '';
}

function graphNodeDiagnostics(doc, nodePath, baseFilePath = getActiveTab()?.filePath) {
  const context = pipelineContextForPath(baseFilePath);
  const runbookPath = context?.pipelinePath || baseFilePath;
  const diagnostics = pipelineValidationDiagnostics(selectedPipelineValidation(runbookPath));
  const node = orchValueAtPath(doc, nodePath);
  return diagnostics.filter((issue) => {
    if (!diagnosticMatchesGraphFile(issue, baseFilePath, context)) return false;
    const diagnosticNodePath = graphNodePathFromDiagnostic(issue);
    if (diagnosticNodePath && diagnosticNodePath === nodePath) return true;
    return !!issue.nodeId && String(issue.nodeId) === String(node?.id || '');
  });
}

function graphNodeFieldDiagnostic(diagnostics, field, node) {
  return diagnostics.find(issue => graphDiagnosticField(issue, node) === field);
}

function renderOrchInspectorField(label, field, path, value, issue = null) {
  const hasIssue = !!issue;
  return `
    <label class="${hasIssue ? 'has-inline-diagnostic' : ''}">
      <span>${escapeHtml(label)}</span>
      <input data-orch-edit="${escapeHtml(field)}" data-orch-path="${escapeHtml(path)}" value="${escapeHtml(value || '')}" ${hasIssue ? 'aria-invalid="true"' : ''}>
      ${renderPipelineInlineDiagnostic(issue)}
    </label>
  `;
}

function pipelinePreviewRunStatus(validation, runtimeBlockReason, runInProgress = false) {
  if (runInProgress) return { state: 'warn', text: 'Run in progress.' };
  if (!validation) return { state: '', text: 'Not checked yet.' };
  if (!validation.ok) {
    return { state: 'danger', text: pipelineDiagnosticStatusText(validation) };
  }
  const entryGraphWarning = (validation.diagnostics || []).find(isEntryGraphDeclarationWarning);
  if (entryGraphWarning) {
    return { state: 'warn', text: `Ready with warning: ${pipelineInlineDiagnosticText(entryGraphWarning)}` };
  }
  if (isAgentOrchestratedPipeline(validation)) {
    if (runtimeBlockReason) {
      if (canEnableManagedRunsForSession()) {
        return { state: 'warn', text: 'Approve this session to start.' };
      }
      return { state: 'warn', text: 'Run support is unavailable in this session.' };
    }
    if (isMachineCompatiblePipeline(validation) && !isMachineStartablePipeline(validation)) {
      return { state: 'warn', text: 'This pipeline needs a runnable adapter before it can start.' };
    }
    return { state: 'good', text: 'Ready to start.' };
  }
  if (validation.canExecute) {
    return { state: 'good', text: 'Ready for local run.' };
  }
  return { state: 'warn', text: 'Checked, but no executable run mode is available yet.' };
}

function pipelinePreviewTitle(context, pipelineDoc = null) {
  const manifestTitle = pipelineDoc?.title || pipelineDoc?.name || pipelineDoc?.id || '';
  if (manifestTitle) return manifestTitle;
  const summaryItem = context?.pipelinePath ? runbookSummaryItemForPath(context.pipelinePath) : null;
  return (summaryItem ? runbookListItemTitle(summaryItem) : '') || context?.pipelineName || 'Pipeline';
}

function pipelinePreviewLocationLabel(context) {
  if (!context) return '';
  if (context.isManifest) return 'Details';
  if (context.isGraph) return `Flow: ${pipelineDisplayTitle(context.activePath, 'Flow')}`;
  if (context.activeRelativePath) return context.activeRelativePath;
  return 'Pipeline package';
}

// Failure detection / artifact path helpers live in
// src/shared/orchestration/failure-summary.js so node tests can verify the
// same logic that renders here. Local thin wrappers stay for diff stability.
function machineFailedAdapterCalls(record) {
  return sharedFailedAdapterCalls(record);
}
function machineRunArtifactAbsPath(record, ref) {
  return sharedRunArtifactAbsPath(record, ref);
}

function renderMachineFailedAdaptersHtml(record) {
  const failures = machineFailedAdapterCalls(record);
  const runRoot = record?.runRoot || record?.runState?.runRoot || '';
  const lifecycleStatus = String(record?.runState?.lifecycleStatus || '').toLowerCase();
  const summaryStatus = String(record?.runState?.summaryStatus || '').toLowerCase();
  // Cancelled / created / running 상태에서는 사용자 의도된 상태이므로 fallback
  // 표시 안 함. 실제 실패한 adapter 카드(failures.length>0)는 그대로 표시.
  const lifecycleHidesFallback = sharedLifecycleSuppressesFallback(lifecycleStatus);
  const runIsFailing = !lifecycleHidesFallback
    && (lifecycleStatus === 'failed' || summaryStatus === 'blocked');
  if (!failures.length && !runIsFailing) return '';

  const fallbackBlock = (!failures.length && runIsFailing && runRoot)
    ? `<div class="pipe-failed-probe">
        <div class="pipe-failed-probe-meta">
          <span class="pipe-failed-probe-node">Run state is ${escapeHtml(lifecycleStatus || summaryStatus)}, but no adapter.result/worker.result event with a failure status was found in the polled record.</span>
        </div>
        <div class="pipe-failed-probe-reason">Open the run root in OrPAD to inspect events.jsonl and adapter transcripts manually.</div>
        <div class="pipe-failed-probe-actions">
          <button class="pipe-failed-probe-link" data-probe-action="open-artifact" data-artifact-path="${escapeHtml(`${runRoot.replace(/[\\/]+$/, '')}/events.jsonl`)}" title="${escapeHtml(`${runRoot}/events.jsonl`)}">events.jsonl</button>
        </div>
      </div>`
    : '';

  const items = failures.map(f => {
    const transcriptAbs = machineRunArtifactAbsPath(record, f.transcriptRef);
    const lastMessageAbs = machineRunArtifactAbsPath(record, f.lastMessageRef);
    const patchAbs = machineRunArtifactAbsPath(record, f.patchRef);
    const eventsAbs = runRoot ? `${runRoot.replace(/[\\/]+$/, '')}/events.jsonl` : '';
    const links = [];
    if (transcriptAbs) {
      links.push(`<button class="pipe-failed-probe-link" data-probe-action="open-artifact" data-artifact-path="${escapeHtml(transcriptAbs)}" title="${escapeHtml(transcriptAbs)}">View transcript</button>`);
    }
    if (lastMessageAbs) {
      links.push(`<button class="pipe-failed-probe-link" data-probe-action="open-artifact" data-artifact-path="${escapeHtml(lastMessageAbs)}" title="${escapeHtml(lastMessageAbs)}">Last message</button>`);
    }
    if (patchAbs) {
      links.push(`<button class="pipe-failed-probe-link" data-probe-action="open-artifact" data-artifact-path="${escapeHtml(patchAbs)}" title="${escapeHtml(patchAbs)}">Patch</button>`);
    }
    if (eventsAbs) {
      links.push(`<button class="pipe-failed-probe-link" data-probe-action="open-artifact" data-artifact-path="${escapeHtml(eventsAbs)}" title="${escapeHtml(eventsAbs)}">events.jsonl</button>`);
    }
    return `
      <div class="pipe-failed-probe">
        <div class="pipe-failed-probe-meta">
          <span class="pipe-failed-probe-node">${escapeHtml(f.nodePath || '(no node path)')}</span>
          <span class="pipe-failed-probe-status status-${escapeHtml(f.status)}">${escapeHtml(f.status)}</span>
          ${f.adapter ? `<span class="pipe-failed-probe-adapter">${escapeHtml(f.adapter)}</span>` : ''}
        </div>
        ${f.reason ? `<div class="pipe-failed-probe-reason">${escapeHtml(f.reason)}</div>` : ''}
        ${links.length ? `<div class="pipe-failed-probe-actions">${links.join('')}</div>` : `<div class="pipe-failed-probe-reason">No transcript artifact attached. Open events.jsonl from the run root.</div>`}
      </div>
    `;
  }).join('');

  return `
    <div class="pipe-failed-probes">
      <div class="pipe-failed-probes-title">${failures.length ? `Failed adapter calls (${failures.length})` : 'Run is in a failed/blocked state'} — click to inspect</div>
      ${items || fallbackBlock}
    </div>
  `;
}

function renderPipelinePreviewRunBar(context = pipelineContextForPath(), pipelineDoc = null) {
  if (!context?.pipelinePath) return '';
  const runbookPath = context.pipelinePath;
  const runbookKey = runbookNormalizePath(runbookPath).toLowerCase();
  const validation = selectedPipelineValidation(runbookPath);
  const checked = !!validation;
  const agentReady = isAgentOrchestratedPipeline(validation);
  const localDisabled = checked && validation?.canExecute !== true;
  const handoffDisabled = checked && !agentReady;
  const selectedRunbookMatchesPreview = runbookNormalizePath(selectedRunbookPath).toLowerCase() === runbookKey;
  const previewRunRecord = getRunbookCache(machineRunRecordCache, runbookPath) || (selectedRunbookMatchesPreview ? lastMachineRunRecord : null);
  const previewRunInProgress = isMachineRunInProgress(previewRunRecord, runbookPath);
  const previewRunId = previewRunRecord?.runState?.runId || previewRunRecord?.runId || '';
  const startPending = machineRunStartPendingPaths.has(runbookKey);
  const runtimeBlockReason = machineRuntimeBlockReason();
  const machineReason = runtimeBlockReason || (checked
    ? machineStartBlockReason(validation) || 'Start and track work state, progress, and evidence files.'
    : 'Check this pipeline, then start and track its work state, progress, and evidence files.');
  const machineStartable = isMachineStartablePipeline(validation);
  const machineCompatible = isMachineCompatiblePipeline(validation);
  const machineDisabled = startPending || previewRunInProgress || (checked && !machineStartable);
  const defaultAction = machineCompatible && previewRunInProgress ? 'machine-cancel-run' : 'default';
  const defaultTitle = machineCompatible
    ? (previewRunInProgress ? 'Stop Run' : (startPending ? 'Starting run...' : (machineStartable ? 'Start Run' : (machineReason || 'Start Run'))))
    : (agentReady ? 'Prepare Handoff' : 'Run this pipeline');
  const defaultDisabled = machineCompatible
    ? (startPending || (!previewRunInProgress && checked && !machineStartable) || (previewRunInProgress && !window.orpad?.machine?.cancelRun))
    : false;
  const defaultDangerClass = machineCompatible && previewRunInProgress ? ' danger' : '';
  const defaultIcon = machineCompatible && previewRunInProgress
    ? orchToolIcon('M5 5h8v8H5z')
    : orchToolIcon('M5 3l7 5-7 5V3z');
  const runStatus = pipelinePreviewRunStatus(validation, runtimeBlockReason, previewRunInProgress);
  const displayTitle = pipelinePreviewTitle(context, pipelineDoc);
  const activeLabel = pipelinePreviewLocationLabel(context);
  const activePathTitle = runbookRelativePath(context.activePath || runbookPath);
  const externalResearchLimitation = pipelineDoc?.metadata?.externalResearch?.limitation || pipelineDoc?.run?.externalResearchLimitation || '';
  if (isMachineApiAvailable() && !machineRuntimeStatus && !machineRuntimeStatusLoading) {
    void refreshMachineRuntimeStatus();
  }
  return `
    <div class="pipeline-runbar" data-pipeline-preview-runbar data-pipeline-path="${escapeHtml(runbookPath)}">
      <div class="pipeline-runbar-meta">
        <strong>${escapeHtml(displayTitle)}</strong>
        <span class="pipeline-runbar-path" title="${escapeHtml(activePathTitle)}">${escapeHtml(activeLabel)}</span>
        <span class="pipeline-runbar-status ${escapeHtml(runStatus.state)}">${escapeHtml(runStatus.text)}</span>
        ${externalResearchLimitation ? `<span class="pipeline-runbar-status warn" title="${escapeHtml(externalResearchLimitation)}">External research needs approval</span>` : ''}
      </div>
      <div class="pipeline-runbar-actions">
        <button class="pipeline-run-primary${defaultDangerClass}" data-pipeline-run-action="${escapeHtml(defaultAction)}" data-path="${escapeHtml(runbookPath)}" data-run-id="${escapeHtml(previewRunId)}" ${defaultDisabled ? 'disabled' : ''} title="${escapeHtml(defaultTitle)}" aria-label="${escapeHtml(defaultTitle)}">
          ${defaultIcon}
        </button>
        <details class="pipeline-run-menu-wrap">
          <summary class="pipeline-run-menu-trigger" data-pipeline-run-menu title="Run options" aria-label="Run options">
            ${orchToolIcon('M4 6l4 4 4-4')}
          </summary>
          <div class="pipeline-run-menu" role="menu">
            <button data-pipeline-run-action="local" data-path="${escapeHtml(runbookPath)}" ${localDisabled ? 'disabled' : ''} title="${escapeHtml(localDisabled ? 'This pipeline cannot use the local runner.' : 'Run with the local runner.')}">Run locally</button>
            <button data-pipeline-run-action="managed" data-path="${escapeHtml(runbookPath)}" ${machineDisabled ? 'disabled' : ''} title="${escapeHtml(previewRunInProgress ? 'Run already in progress.' : (machineReason || 'Start and track work state, progress, and evidence files.'))}">Start Run</button>
            <button data-pipeline-run-action="handoff" data-path="${escapeHtml(runbookPath)}" ${handoffDisabled ? 'disabled' : ''} title="${escapeHtml(handoffDisabled ? 'No handoff is required for this pipeline.' : 'Prepare instructions for running this pipeline with an external agent.')}">Prepare Handoff</button>
            <button data-pipeline-run-action="choose-adapter" data-path="${escapeHtml(runbookPath)}" title="Choose AI provider and model for this pipeline.">Choose AI Provider…</button>
            <button data-pipeline-run-action="check" data-path="${escapeHtml(runbookPath)}">Check</button>
          </div>
        </details>
      </div>
    </div>
    ${renderMachineFailedAdaptersHtml(previewRunRecord)}
  `;
}

function bindPipelineEditorTabs() {
  contentEl.querySelectorAll('[data-pipeline-editor-target]').forEach(button => {
    button.addEventListener('click', async () => {
      const target = button.dataset.pipelineEditorTarget || '';
      if (!target) return;
      await openFileFromQuickOpen(target);
    });
  });
}

const ORCH_PIPELINE_TRUST_LEVELS = ['local-authored', 'signed-template', 'imported-review', 'generated-draft', 'unknown'];
const ORCH_PIPELINE_REF_SECTIONS = [
  { key: 'graphs', label: 'Flows', singular: 'flow', defaultId: 'main', defaultFile: 'graphs/main.or-graph' },
  { key: 'trees', label: 'Trees', singular: 'tree', defaultId: 'implementation', defaultFile: 'trees/implementation.or-tree' },
  { key: 'skills', label: 'Skills', singular: 'skill', defaultId: 'implement', defaultFile: 'skills/implement.md' },
  { key: 'rules', label: 'Rules', singular: 'rule', defaultId: 'context', defaultFile: 'rules/context.or-rule' },
];
const ORCH_PIPELINE_KNOWN_KEYS = new Set([
  '$schema',
  'kind',
  'version',
  'id',
  'title',
  'description',
  'trustLevel',
  'entryGraph',
  'graphs',
  'trees',
  'skills',
  'rules',
  'nodePacks',
  'run',
  'maintenancePolicy',
  'harness',
  'executionPolicy',
  'metadata',
]);

function pipelineSlug(value, fallback = 'item') {
  const slug = String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function pipelineValueText(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function pipelineDisplayTitle(value, fallback = 'Item') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const stem = raw
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.(or-graph|or-tree|or-rule|md|markdown|json)$/i, '')
    .replace(/[-_]+(?:19|20)\d{6}$/i, '');
  if (!stem) return fallback;
  if (stem.toLowerCase() === 'main') return 'Main flow';
  const acronyms = new Map([
    ['api', 'API'],
    ['cli', 'CLI'],
    ['ipc', 'IPC'],
    ['json', 'JSON'],
    ['llm', 'LLM'],
    ['mcp', 'MCP'],
    ['mvp', 'MVP'],
    ['orpad', 'OrPAD'],
    ['ui', 'UI'],
    ['ux', 'UX'],
  ]);
  return stem
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => acronyms.get(part.toLowerCase()) || `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ') || fallback;
}

function pipelineRefDisplayTitle(entry, section) {
  const title = pipelineDisplayTitle(entry?.id || entry?.file, section?.singular || 'Item');
  if (section?.key === 'graphs' && title.toLowerCase() === 'main') return 'Main flow';
  return title;
}

function pipelineRefEntries(doc, key) {
  const value = doc?.[key];
  const shape = Array.isArray(value) ? 'array' : 'object';
  if (Array.isArray(value)) {
    return {
      shape,
      entries: value.map((item, index) => pipelineNormalizeRefEntry(item, `item-${index + 1}`)).filter(Boolean),
    };
  }
  if (value && typeof value === 'object') {
    return {
      shape,
      entries: Object.entries(value)
        .map(([id, item]) => pipelineNormalizeRefEntry(item, id))
        .filter(Boolean),
    };
  }
  return { shape, entries: [] };
}

function pipelineNormalizeRefEntry(item, fallbackId = '') {
  if (typeof item === 'string') {
    return {
      id: fallbackId || pipelineSlug(item),
      file: item,
      description: '',
    };
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const file = item.file || item.path || item.ref || '';
  const id = item.id || item.name || fallbackId || pipelineSlug(file);
  return {
    ...item,
    id: pipelineValueText(id),
    file: pipelineValueText(file),
    description: pipelineValueText(item.description),
  };
}

function pipelineSerializeRefEntry(entry, index) {
  const clean = { ...(entry || {}) };
  clean.id = pipelineSlug(clean.id || clean.file, `item-${index + 1}`);
  clean.file = pipelineValueText(clean.file);
  if (!clean.description) delete clean.description;
  delete clean.path;
  delete clean.ref;
  delete clean.name;
  return clean;
}

function setPipelineRefEntries(doc, key, entries, shape) {
  const normalized = (entries || [])
    .map((entry, index) => pipelineSerializeRefEntry(entry, index))
    .filter(entry => entry.id || entry.file);
  if (shape === 'array') {
    doc[key] = normalized;
    return;
  }
  const objectValue = {};
  normalized.forEach((entry, index) => {
    const id = pipelineSlug(entry.id || entry.file, `item-${index + 1}`);
    const value = { ...entry };
    delete value.id;
    objectValue[id] = value;
  });
  doc[key] = objectValue;
}

function applyOrchPipelineMutation(mutator) {
  let doc;
  try {
    doc = JSON.parse(editor.state.doc.toString());
  } catch (err) {
    notifyFormatError('Pipeline details', err);
    return;
  }
  mutator(doc);
  const serialized = JSON.stringify(doc, null, 2);
  skipNextRenderPreview = true;
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: serialized } });
  invalidateRenderCache();
  renderOrchPipelinePreview(serialized);
}

function setPipelineOptionalString(doc, key, value) {
  const text = pipelineValueText(value);
  if (text) doc[key] = text;
  else if (key !== 'kind' && key !== 'version' && key !== 'trustLevel') delete doc[key];
  else doc[key] = text;
}

function ensurePipelineHarness(doc) {
  if (!doc.harness || typeof doc.harness !== 'object' || Array.isArray(doc.harness)) doc.harness = {};
  return doc.harness;
}

function ensurePipelineExecutionPolicy(doc) {
  if (!doc.executionPolicy || typeof doc.executionPolicy !== 'object' || Array.isArray(doc.executionPolicy)) doc.executionPolicy = {};
  return doc.executionPolicy;
}

function pipelinePolicyList(policy, key) {
  const value = policy?.[key];
  if (Array.isArray(value)) return value.map(item => pipelineValueText(item));
  if (value) return [pipelineValueText(value)];
  return [];
}

function renderPipelineField({ key, label, type = 'text', multiline = false, options = [] }, value, readwrite) {
  const text = pipelineValueText(value);
  if (!readwrite) {
    return `
      <div class="pipeline-field readonly">
        <span>${escapeHtml(label)}</span>
        <code>${escapeHtml(text || 'not set')}</code>
      </div>
    `;
  }
  if (options.length) {
    return `
      <label class="pipeline-field">
        <span>${escapeHtml(label)}</span>
        <select data-pipeline-field="${escapeHtml(key)}">
          ${options.map(option => `<option value="${escapeHtml(option)}" ${text === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
        </select>
      </label>
    `;
  }
  if (multiline) {
    return `
      <label class="pipeline-field span-2">
        <span>${escapeHtml(label)}</span>
        <textarea data-pipeline-field="${escapeHtml(key)}" rows="3">${escapeHtml(text)}</textarea>
      </label>
    `;
  }
  return `
    <label class="pipeline-field">
      <span>${escapeHtml(label)}</span>
      <input data-pipeline-field="${escapeHtml(key)}" type="${escapeHtml(type)}" value="${escapeHtml(text)}">
    </label>
  `;
}

function renderPipelineEntryField(entryGraph, readwrite, diagnostics = []) {
  const issue = pipelineEntryDiagnostic(diagnostics);
  const isWarning = isEntryGraphDeclarationWarning(issue);
  const diagnostic = renderPipelineInlineDiagnostic(issue);
  if (!readwrite) {
    return `
      <div class="pipeline-field readonly ${issue ? `has-inline-diagnostic ${isWarning ? 'has-inline-warning' : 'has-inline-error'}` : ''}">
        <span>Entry Flow</span>
        <code>${escapeHtml(entryGraph ? pipelineDisplayTitle(entryGraph, 'Entry flow') : 'not set')}</code>
        ${diagnostic}
      </div>
    `;
  }
  return renderPipelineField({ key: 'entryGraph', label: 'Entry file' }, entryGraph, readwrite)
    .replace('<label class="pipeline-field"', `<label class="pipeline-field ${issue ? `has-inline-diagnostic ${isWarning ? 'has-inline-warning' : 'has-inline-error'}` : ''}"`)
    .replace('</label>', `${diagnostic}</label>`)
    .replace('<input data-pipeline-field="entryGraph"', `<input data-pipeline-field="entryGraph" ${issue && !isWarning ? 'aria-invalid="true"' : ''}`);
}

function renderPipelineRefSection(doc, section, readwrite, diagnostics = []) {
  const { shape, entries } = pipelineRefEntries(doc, section.key);
  const empty = !entries.length;
  return `
    <section class="runbook-panel-section pipeline-ref-section" data-pipeline-ref-section="${escapeHtml(section.key)}">
      <header class="pipeline-section-header">
        <div>
          <h3>${escapeHtml(section.label)}</h3>
          <p>${escapeHtml(shape === 'array' ? 'array form' : 'object map form')}</p>
        </div>
        <span class="runbook-chip">${escapeHtml(machineCountLabel(entries.length, section.singular))}</span>
      </header>
      <div class="pipeline-ref-list">
        ${empty ? `<div class="runbook-empty">No ${escapeHtml(section.key)} declared.</div>` : entries.map((entry, index) => {
          const issue = pipelineRefDiagnostic(diagnostics, section.singular, entry);
          return `
          <div class="pipeline-ref-row ${issue ? 'has-inline-diagnostic' : ''}" data-pipeline-ref-index="${index}">
            ${readwrite ? `
              <label><span>Reference key</span><input data-pipeline-ref-edit="${escapeHtml(section.key)}" data-ref-index="${index}" data-ref-field="id" value="${escapeHtml(entry.id || '')}"></label>
              <label class="${issue ? 'has-inline-diagnostic' : ''}"><span>File</span><input data-pipeline-ref-edit="${escapeHtml(section.key)}" data-ref-index="${index}" data-ref-field="file" value="${escapeHtml(entry.file || '')}" ${issue ? 'aria-invalid="true"' : ''}>${renderPipelineInlineDiagnostic(issue)}</label>
              <label><span>Description</span><input data-pipeline-ref-edit="${escapeHtml(section.key)}" data-ref-index="${index}" data-ref-field="description" value="${escapeHtml(entry.description || '')}"></label>
            ` : `
              <div><strong>${escapeHtml(pipelineRefDisplayTitle(entry, section))}</strong>${entry.description ? `<small>${escapeHtml(entry.description)}</small>` : ''}${renderPipelineInlineDiagnostic(issue)}</div>
            `}
            <div class="pipeline-ref-actions">
              ${entry.file ? `<button data-pipeline-open-ref="${escapeHtml(entry.file)}">Open</button>` : ''}
              ${readwrite ? `<button data-pipeline-ref-remove="${escapeHtml(section.key)}" data-ref-index="${index}">Remove</button>` : ''}
            </div>
          </div>
        `; }).join('')}
      </div>
      ${readwrite ? `<button class="pipeline-add-btn" data-pipeline-ref-add="${escapeHtml(section.key)}">Add ${escapeHtml(section.singular)}</button>` : ''}
    </section>
  `;
}

function renderPipelinePolicyList(policy, key, label, readwrite) {
  const values = pipelinePolicyList(policy, key);
  return `
    <div class="pipeline-policy-list">
      <header>
        <strong>${escapeHtml(label)}</strong>
        <span>${values.length}</span>
      </header>
      ${values.length ? values.map((value, index) => readwrite ? `
        <div class="pipeline-list-row">
          <input data-pipeline-policy-list="${escapeHtml(key)}" data-policy-index="${index}" value="${escapeHtml(value)}">
          <button data-pipeline-policy-remove="${escapeHtml(key)}" data-policy-index="${index}">Remove</button>
        </div>
      ` : `<code>${escapeHtml(value)}</code>`).join('') : '<div class="runbook-empty">No entries.</div>'}
      ${readwrite ? `<button class="pipeline-add-btn" data-pipeline-policy-add="${escapeHtml(key)}">Add</button>` : ''}
    </div>
  `;
}

function renderPipelineExecutionPolicy(doc, readwrite) {
  const policy = doc.executionPolicy && typeof doc.executionPolicy === 'object' && !Array.isArray(doc.executionPolicy)
    ? doc.executionPolicy
    : {};
  const repeatable = !!doc.maintenancePolicy?.repeatable || !!policy.repeatable;
  return `
    <section class="runbook-panel-section">
      <header class="pipeline-section-header">
        <div>
          <h3>Execution Policy</h3>
          <p>Autonomy, launch semantics, pause gates, and run/cycle completion criteria.</p>
        </div>
        <span class="runbook-chip">${policy.mode || 'not set'}</span>
        ${repeatable ? '<span class="runbook-chip good">repeatable cycle</span>' : ''}
      </header>
      <div class="pipeline-field-grid">
        ${renderPipelineField({ key: 'mode', label: 'Mode' }, policy.mode || '', readwrite).replaceAll('data-pipeline-field=', 'data-pipeline-policy-field=')}
        ${renderPipelineField({ key: 'promptRole', label: 'Prompt role' }, policy.promptRole || '', readwrite).replaceAll('data-pipeline-field=', 'data-pipeline-policy-field=')}
      </div>
      <div class="pipeline-policy-grid">
        ${renderPipelinePolicyList(policy, 'pauseOnlyFor', 'Pause only for', readwrite)}
        ${renderPipelinePolicyList(policy, 'doneCriteria', 'Cycle done criteria', readwrite)}
      </div>
    </section>
  `;
}

function renderPipelineJsonSection(doc, key, label, description, readwrite) {
  const value = doc?.[key];
  const hasValue = value !== undefined;
  const json = hasValue ? JSON.stringify(value, null, 2) : '';
  return `
    <section class="runbook-panel-section">
      <header class="pipeline-section-header">
        <div>
          <h3>${escapeHtml(label)}</h3>
          <p>${escapeHtml(description)}</p>
        </div>
        <span class="runbook-chip">${hasValue ? (Array.isArray(value) ? `${value.length} entries` : typeof value) : 'not set'}</span>
      </header>
      ${readwrite ? `
        <label class="pipeline-field span-2">
          <span>${escapeHtml(label)} JSON</span>
          <textarea data-pipeline-json-section="${escapeHtml(key)}" rows="10">${escapeHtml(json)}</textarea>
        </label>
      ` : hasValue ? `
        <pre class="runbook-context-preview">${escapeHtml(json)}</pre>
      ` : '<div class="runbook-empty">No value declared.</div>'}
    </section>
  `;
}

function pipelineAdditionalKeys(doc) {
  return Object.keys(doc || {}).filter(key => !ORCH_PIPELINE_KNOWN_KEYS.has(key));
}

function renderPipelineAdditionalProperties(doc, readwrite) {
  const keys = pipelineAdditionalKeys(doc);
  if (!keys.length && !readwrite) return '<div class="runbook-empty">No additional top-level properties.</div>';
  return `
    ${keys.length ? keys.map((key, index) => `
      <div class="pipeline-extra-row">
        ${readwrite ? `
          <label><span>Key</span><input data-pipeline-extra-key="${index}" value="${escapeHtml(key)}"></label>
          <label><span>JSON value</span><textarea data-pipeline-extra-value="${index}" rows="4">${escapeHtml(JSON.stringify(doc[key], null, 2))}</textarea></label>
          <button data-pipeline-extra-remove="${index}">Remove</button>
        ` : `
          <strong>${escapeHtml(key)}</strong>
          <code>${escapeHtml(JSON.stringify(doc[key]))}</code>
        `}
      </div>
    `).join('') : '<div class="runbook-empty">No additional top-level properties.</div>'}
    ${readwrite ? '<button class="pipeline-add-btn" data-pipeline-extra-add="true">Add property</button>' : ''}
  `;
}

function parsePipelineExtraValue(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    notifyFormatError('Pipeline property JSON', err);
    return { ok: false, value: null };
  }
}

function uniquePipelineExtraKey(doc) {
  let index = 1;
  while (Object.prototype.hasOwnProperty.call(doc, `metadata${index === 1 ? '' : index}`)) index += 1;
  return `metadata${index === 1 ? '' : index}`;
}

function normalizeOrchGraphLayerStack(doc) {
  const stack = currentOrchGraphLayerStack();
  let changed = false;
  while (stack.length && !canOpenOrchSubtree(stack[stack.length - 1].path, doc)) {
    stack.pop();
    changed = true;
  }
  return changed;
}

function firstOrchTreeEntryFromDoc(doc) {
  return orchTreeEntriesFromDoc(doc)[0] || null;
}

function renderOrchGraphLayerAgainIfActive(entry) {
  if (activeOrchGraphLayerEntry() !== entry) return;
  orchGraphFitAfterRender = true;
  invalidateRenderCache();
  rerenderOrchPreview();
}

async function loadExternalOrchGraphLayer(entry, target) {
  if (!entry || !target?.filePath || entry.loaded || entry.loading) return;
  entry.loading = true;
  entry.error = '';
  try {
    const result = await readFileForQuickOpen(target.filePath);
    if (result?.error) throw new Error(result.error);
    const parsed = JSON.parse(result?.content || '{}');
    const isGraphLayer = /\.or-graph$/i.test(target.filePath) || /\.orch-graph\.json$/i.test(target.filePath);
    const treeEntry = isGraphLayer ? null : firstOrchTreeEntryFromDoc(parsed);
    if (isGraphLayer && (!parsed?.graph || !Array.isArray(parsed.graph.nodes))) {
      throw new Error('Linked OrPAD flow file does not include graph.nodes.');
    }
    if (!isGraphLayer && !treeEntry?.tree?.root) throw new Error('Linked OrPAD tree file does not include a root node.');
    entry.doc = parsed;
    entry.layerKind = isGraphLayer ? 'graph' : 'tree';
    entry.treeEntry = treeEntry || null;
    entry.filePath = target.filePath;
    entry.anchor = target.anchor || '';
    entry.loaded = true;
  } catch (err) {
    entry.error = err?.message || String(err);
    entry.loaded = true;
  } finally {
    entry.loading = false;
    renderOrchGraphLayerAgainIfActive(entry);
  }
}

function ensureExternalOrchGraphLayerLoaded(entry, path, doc) {
  if (!entry || entry.loaded || entry.loading) return;
  const target = entry.filePath
    ? { filePath: entry.filePath, anchor: entry.anchor || '' }
    : externalOrchLinkedLayerTarget(path, doc);
  if (!target?.filePath) {
    entry.loaded = true;
    entry.error = 'Linked OrPAD layer file could not be resolved.';
    return;
  }
  entry.filePath = target.filePath;
  entry.anchor = target.anchor || '';
  loadExternalOrchGraphLayer(entry, target);
}

function openOrchGraphLayer(path) {
  let doc;
  try {
    doc = JSON.parse(editor.state.doc.toString());
  } catch {
    return false;
  }
  if (!canOpenOrchSubtree(path, doc)) return false;
  const node = orchValueAtPath(doc, path);
  const target = node?.tree?.root ? null : externalOrchLinkedLayerTarget(path, doc);
  const stack = currentOrchGraphLayerStack();
  const existingIndex = stack.findIndex(entry => entry.path === path);
  let entry;
  if (existingIndex !== -1) {
    stack.splice(existingIndex + 1);
    entry = stack[existingIndex];
  } else {
    entry = { path };
    if (target?.filePath) {
      entry.filePath = target.filePath;
      entry.anchor = target.anchor || '';
    }
    stack.push(entry);
  }
  selectedOrchEdgeId = '';
  setOrchSelection(node?.tree?.root ? `${path}.tree.root` : '');
  if (target?.filePath) ensureExternalOrchGraphLayerLoaded(entry, path, doc);
  orchGraphFitAfterRender = true;
  invalidateRenderCache();
  rerenderOrchPreview();
  return true;
}

function navigateOrchGraphLayer(index) {
  const stack = currentOrchGraphLayerStack();
  if (index < 0) stack.length = 0;
  else stack.splice(index + 1);
  selectedOrchEdgeId = '';
  const path = activeOrchGraphLayerPath();
  let doc = null;
  try {
    doc = JSON.parse(editor.state.doc.toString());
  } catch {}
  const node = path && doc ? orchValueAtPath(doc, path) : null;
  setOrchSelection(node?.tree?.root ? `${path}.tree.root` : '');
  orchGraphFitAfterRender = true;
  invalidateRenderCache();
  rerenderOrchPreview();
}

function isOrchGraphStateLayer() {
  return getActiveTab()?.viewType === 'orch-graph' && !activeOrchGraphLayerPath();
}

function normalizeOrchSelection(doc, fallbackPath = '') {
  const validPaths = [...selectedOrchNodePaths].filter(path => !!orchValueAtPath(doc, path));
  if (selectedOrchNodePath && !validPaths.includes(selectedOrchNodePath) && orchValueAtPath(doc, selectedOrchNodePath)) {
    validPaths.unshift(selectedOrchNodePath);
  }
  if (!validPaths.length && fallbackPath) validPaths.push(fallbackPath);
  setOrchSelection(validPaths);
}

function parentArrayPathForOrchNode(path) {
  const parts = orchPathToParts(path);
  if (!parts.length) return null;
  const index = parts.pop();
  if (typeof index !== 'number') return null;
  return { arrayPath: parts.join('.'), index };
}

function uniqueOrchChildId(children, base = 'node') {
  const used = new Set((children || []).map(child => child?.id).filter(Boolean));
  let candidate = String(base || 'node').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'node';
  if (!used.has(candidate)) return candidate;
  let index = 2;
  while (used.has(`${candidate}-${index}`)) index += 1;
  return `${candidate}-${index}`;
}

function orchNodeTypeStem(type) {
  return String(type || 'node')
    .replace(/^orpad\./, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'node';
}

function orchNodeDefaultLabel(type) {
  const labels = {
    Sequence: 'New sequence',
    Skill: 'New skill',
    OrchTree: 'New tree subflow',
    'orpad.entry': 'Entry',
    'orpad.context': 'New context',
    'orpad.gate': 'New gate',
    'orpad.selector': 'New selector',
    'orpad.skill': 'New skill',
    'orpad.tree': 'New tree reference',
    'orpad.graph': 'New flow reference',
    'orpad.rule': 'New rule',
    'orpad.artifactContract': 'New evidence contract',
    'orpad.patchReview': 'Review patch results',
    'orpad.exit': 'Exit',
    'orpad.probe': 'New probe',
    'orpad.workQueue': 'New work queue',
    'orpad.triage': 'New triage',
    'orpad.dispatcher': 'New dispatcher',
    'orpad.workerLoop': 'New worker loop',
    'orpad.barrier': 'New barrier',
  };
  return labels[type] || 'New node';
}

function createOrchNode(type = 'Context', children = [], siblings = []) {
  const id = uniqueOrchChildId(siblings, `${orchNodeTypeStem(type)}-${(siblings || []).length + 1}`);
  const node = {
    id,
    type,
    label: orchNodeDefaultLabel(type),
  };
  if (type === 'Skill') node.file = '';
  if (type === 'orpad.skill') node.config = { skillRef: '' };
  if (type === 'orpad.tree') node.config = { treeRef: '' };
  if (type === 'orpad.graph') node.config = { graphRef: '' };
  if (type === 'orpad.rule') node.config = { ruleRef: '' };
  if (type === 'OrchTree') node.tree = {
    id: `${id}-tree`,
    label: 'Tree subflow',
    root: { id: 'root', type: 'Sequence', label: 'Tree subflow' },
  };
  if (children.length) node.children = children;
  return node;
}

function setOrchNodeEditField(node, field, value) {
  const parts = String(field || '').split('.').filter(Boolean);
  if (parts.length <= 1) {
    node[field] = value;
    return;
  }
  let target = node;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) target[part] = {};
    target = target[part];
  }
  target[parts[parts.length - 1]] = value;
}

function applyOrchTypeDefaults(node, type) {
  if (type === 'Skill' && !node.file) node.file = '';
  if (type === 'OrchTree' && !node.tree) {
    node.tree = {
      id: `${node.id || 'subflow'}-tree`,
      label: node.label || 'Tree subflow',
      root: { id: 'root', type: 'Sequence', label: node.label || 'Tree subflow' },
    };
  }
  if (type === 'orpad.skill') node.config = { ...(node.config || {}), skillRef: node.config?.skillRef || '' };
  if (type === 'orpad.tree') node.config = { ...(node.config || {}), treeRef: node.config?.treeRef || node.config?.ref || '' };
  if (type === 'orpad.graph') node.config = { ...(node.config || {}), graphRef: node.config?.graphRef || '' };
  if (type === 'orpad.rule') node.config = { ...(node.config || {}), ruleRef: node.config?.ruleRef || '' };
}

function createOrchSubtree(siblings = []) {
  const subtree = createOrchNode('Sequence', [], siblings);
  subtree.label = 'New subtree';
  subtree.children = [
    { id: 'context', type: 'Context', label: 'Collect context' },
    { id: 'gate', type: 'Gate', label: 'Confirm readiness' },
  ];
  return subtree;
}

function orchMetaPathForRunbook(filePath = getActiveTab()?.filePath) {
  if (!filePath || !(/\.orch-(tree|graph)\.json$/i.test(filePath) || /\.or-(tree|graph)$/i.test(filePath))) return '';
  if (/\.or-graph$/i.test(filePath)) return filePath.replace(/\.or-graph$/i, '.or-graph.meta.json');
  if (/\.or-tree$/i.test(filePath)) return filePath.replace(/\.or-tree$/i, '.or-tree.meta.json');
  if (/\.orch-graph\.json$/i.test(filePath)) return filePath.replace(/\.orch-graph\.json$/i, '.orch-graph.meta.json');
  return filePath.replace(/\.orch-tree\.json$/i, '.orch-tree.meta.json');
}

function createDefaultOrchMeta(filePath = getActiveTab()?.filePath) {
  return {
    version: 1,
    source: filePath ? runbookRelativePath(filePath) : '',
    layout: { nodes: {} },
    transitions: {},
  };
}

function normalizeOrchMeta(meta, filePath = getActiveTab()?.filePath) {
  const normalized = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  if (!normalized.version) normalized.version = 1;
  if (!normalized.source) normalized.source = filePath ? runbookRelativePath(filePath) : '';
  if (!normalized.layout || typeof normalized.layout !== 'object' || Array.isArray(normalized.layout)) normalized.layout = {};
  if (!normalized.layout.nodes || typeof normalized.layout.nodes !== 'object' || Array.isArray(normalized.layout.nodes)) normalized.layout.nodes = {};
  if (!normalized.transitions || typeof normalized.transitions !== 'object' || Array.isArray(normalized.transitions)) normalized.transitions = {};
  return normalized;
}

function currentOrchMetaEntry() {
  const metaPath = orchMetaPathForRunbook();
  if (!metaPath) return null;
  const key = runbookNormalizePath(metaPath).toLowerCase();
  let entry = orchGraphMetaCache.get(key);
  if (!entry) {
    entry = { path: metaPath, meta: createDefaultOrchMeta(), loaded: false, loading: true };
    orchGraphMetaCache.set(key, entry);
    window.orpad.readFile(metaPath).then(result => {
      if (result?.content) {
        try {
          entry.meta = normalizeOrchMeta(JSON.parse(result.content), getActiveTab()?.filePath);
        } catch {
          entry.meta = normalizeOrchMeta(entry.meta, getActiveTab()?.filePath);
        }
      }
      entry.loaded = true;
      entry.loading = false;
      if (orchMetaPathForRunbook() === metaPath && isOrchViewType(getActiveTab()?.viewType)) {
        rerenderOrchPreview();
      }
    }).catch(() => {
      entry.loaded = true;
      entry.loading = false;
    });
  }
  return entry;
}

function currentOrchMeta() {
  return normalizeOrchMeta(currentOrchMetaEntry()?.meta || createDefaultOrchMeta(), getActiveTab()?.filePath);
}

function persistCurrentOrchMeta() {
  const entry = currentOrchMetaEntry();
  if (!entry?.path) return;
  entry.meta = normalizeOrchMeta(entry.meta, getActiveTab()?.filePath);
  window.orpad.saveFile(entry.path, JSON.stringify(entry.meta, null, 2)).catch(() => {});
}

function cloneOrchData(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

function getOrchHistoryState(tab = getActiveTab()) {
  if (!tab) return null;
  if (!tab.orchEditHistory) tab.orchEditHistory = { undo: [], redo: [] };
  return tab.orchEditHistory;
}

function captureOrchHistorySnapshot(content = editor.state.doc.toString()) {
  return {
    content,
    meta: cloneOrchData(currentOrchMeta()),
    selection: {
      nodePath: selectedOrchNodePath,
      nodePaths: [...selectedOrchNodePaths],
      edgeId: selectedOrchEdgeId,
    },
    viewport: { ...orchGraphViewport },
  };
}

function sameOrchHistoryData(a, b) {
  if (!a || !b) return false;
  return a.content === b.content && JSON.stringify(a.meta || null) === JSON.stringify(b.meta || null);
}

function pushOrchHistorySnapshot(before, after = captureOrchHistorySnapshot()) {
  if (!isOrchViewType(getActiveTab()?.viewType) || sameOrchHistoryData(before, after)) return false;
  const history = getOrchHistoryState();
  if (!history) return false;
  history.undo.push(before);
  if (history.undo.length > ORCH_HISTORY_LIMIT) history.undo.shift();
  history.redo = [];
  return true;
}

function restoreOrchHistorySnapshot(snapshot) {
  if (!snapshot) return false;
  const entry = currentOrchMetaEntry();
  if (entry?.path) {
    entry.meta = normalizeOrchMeta(cloneOrchData(snapshot.meta), getActiveTab()?.filePath);
    persistCurrentOrchMeta();
  }
  selectedOrchNodePath = snapshot.selection?.nodePath || '';
  selectedOrchNodePaths = new Set(snapshot.selection?.nodePaths || []);
  selectedOrchEdgeId = snapshot.selection?.edgeId || '';
  orchGraphViewport = {
    x: Number.isFinite(snapshot.viewport?.x) ? snapshot.viewport.x : orchGraphViewport.x,
    y: Number.isFinite(snapshot.viewport?.y) ? snapshot.viewport.y : orchGraphViewport.y,
    scale: Number.isFinite(snapshot.viewport?.scale) ? clampOrchZoom(snapshot.viewport.scale) : orchGraphViewport.scale,
  };
  orchGraphTemporaryTool = '';
  const currentContent = editor.state.doc.toString();
  if (snapshot.content !== currentContent) {
    skipNextRenderPreview = true;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: snapshot.content },
      annotations: Transaction.addToHistory.of(false),
    });
  }
  invalidateRenderCache();
  rerenderOrchPreview(snapshot.content);
  return true;
}

function runOrchHistoryCommand(direction) {
  const history = getOrchHistoryState();
  if (!history || !isOrchViewType(getActiveTab()?.viewType)) return false;
  const source = direction === 'redo' ? history.redo : history.undo;
  const target = direction === 'redo' ? history.undo : history.redo;
  if (!source.length) return false;
  const snapshot = source.pop();
  target.push(captureOrchHistorySnapshot());
  if (target.length > ORCH_HISTORY_LIMIT) target.shift();
  return restoreOrchHistorySnapshot(snapshot);
}

function runCodeMirrorHistoryCommand(direction, rerenderOrch = false) {
  const before = editor.state.doc.toString();
  const didRun = direction === 'redo' ? cmRedo(editor) : cmUndo(editor);
  const after = editor.state.doc.toString();
  if (rerenderOrch && (didRun || before !== after)) {
    invalidateRenderCache();
    rerenderOrchPreview(after);
  }
  return didRun || before !== after;
}

function mutateCurrentOrchMeta(mutator) {
  const before = orchHistoryBatchDepth === 0 ? captureOrchHistorySnapshot() : null;
  orchHistoryBatchDepth += 1;
  try {
    mutator(currentOrchMeta());
  } finally {
    orchHistoryBatchDepth -= 1;
  }
  persistCurrentOrchMeta();
  if (before) pushOrchHistorySnapshot(before);
}

function orchMetaNodePosition(path) {
  const position = currentOrchMeta().layout.nodes[path];
  if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) return { x: position.x, y: position.y };
  return null;
}

function setOrchMetaNodePosition(path, x, y) {
  mutateCurrentOrchMeta((meta) => {
    meta.layout.nodes[path] = { x: Math.round(x), y: Math.round(y) };
  });
}

function orchTransitionMeta(edgeId) {
  const meta = currentOrchMeta();
  if (!meta.transitions[edgeId]) meta.transitions[edgeId] = { style: 'curve', points: [] };
  const transition = meta.transitions[edgeId];
  transition.style = transition.style === 'straight' ? 'straight' : 'curve';
  if (!Array.isArray(transition.points)) transition.points = [];
  return transition;
}

function setOrchTransitionMeta(edgeId, patch) {
  mutateCurrentOrchMeta((meta) => {
    const current = meta.transitions[edgeId] || { style: 'curve', points: [] };
    meta.transitions[edgeId] = {
      ...current,
      ...patch,
      style: patch?.style === 'straight' || current.style === 'straight' ? (patch?.style || current.style) : 'curve',
      points: Array.isArray(patch?.points) ? patch.points : Array.isArray(current.points) ? current.points : [],
    };
  });
}

function pruneOrchMetaForPath(path) {
  mutateCurrentOrchMeta((meta) => {
    Object.keys(meta.layout.nodes).forEach(key => {
      if (key === path || key.startsWith(`${path}.`)) delete meta.layout.nodes[key];
    });
    Object.keys(meta.transitions).forEach(key => {
      if (key.includes(path)) delete meta.transitions[key];
    });
  });
}

function applyOrchTreeMutation(mutator) {
  let doc;
  try {
    doc = JSON.parse(editor.state.doc.toString());
  } catch (err) {
    notifyFormatError('Pipeline flow', err);
    return;
  }
  const before = captureOrchHistorySnapshot();
  orchHistoryBatchDepth += 1;
  try {
    mutator(doc);
  } finally {
    orchHistoryBatchDepth -= 1;
  }
  const serialized = JSON.stringify(doc, null, 2);
  pushOrchHistorySnapshot(before, captureOrchHistorySnapshot(serialized));
  skipNextRenderPreview = true;
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: serialized },
    annotations: Transaction.addToHistory.of(false),
  });
  rerenderOrchPreview(serialized);
}

function rerenderOrchPreview(content = editor.state.doc.toString()) {
  if (getActiveTab()?.viewType === 'orch-pipeline') renderOrchPipelinePreview(content);
  else if (getActiveTab()?.viewType === 'orch-graph') renderOrchGraphPreview(content);
  else renderOrchTreePreview(content);
}

function rerenderOrchTree() {
  rerenderOrchPreview();
}

function resetOrchGraphLayout() {
  orchGraphFitAfterRender = true;
  mutateCurrentOrchMeta((meta) => {
    meta.layout.nodes = {};
  });
  rerenderOrchPreview();
}

function defaultOrchTransitionPoint(source, target, style = 'curve') {
  const x1 = source.x + Math.round(ORCH_NODE_WIDTH / 2);
  const y1 = source.y + ORCH_NODE_HEIGHT;
  const x2 = target.x + Math.round(ORCH_NODE_WIDTH / 2);
  const y2 = target.y;
  if (style === 'straight') return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
  return { x: Math.round((x1 + x2) / 2), y: Math.round(y1 + Math.max(54, (y2 - y1) * 0.48)) };
}

function orchTransitionPoint(edgeId, source, target) {
  const transition = currentOrchMeta().transitions[edgeId];
  const style = transition?.style === 'straight' ? 'straight' : 'curve';
  const point = Array.isArray(transition?.points) ? transition.points[0] : null;
  if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) return { x: point.x, y: point.y };
  return defaultOrchTransitionPoint(source, target, style);
}

function orchEdgePath(source, target, edgeId) {
  const transition = currentOrchMeta().transitions[edgeId];
  const style = transition?.style === 'straight' ? 'straight' : 'curve';
  const point = orchTransitionPoint(edgeId, source, target);
  return orchEdgePathWithPoint(source, target, style, point);
}

function orchEdgePathWithPoint(source, target, style, point) {
  const x1 = source.x + Math.round(ORCH_NODE_WIDTH / 2);
  const y1 = source.y + ORCH_NODE_HEIGHT;
  const x2 = target.x + Math.round(ORCH_NODE_WIDTH / 2);
  const y2 = target.y;
  if (style === 'straight') {
    return `M ${x1} ${y1} L ${x1} ${point.y} L ${x2} ${point.y} L ${x2} ${y2}`;
  }
  return `M ${x1} ${y1} Q ${point.x} ${point.y} ${x2} ${y2}`;
}

function snapOrchCoordinate(value) {
  return Math.round(value / ORCH_GRID_SIZE) * ORCH_GRID_SIZE;
}

function snapOrchPoint(point, force = false) {
  if (!force && !orchGridSnapEnabled) return point;
  return { x: snapOrchCoordinate(point.x), y: snapOrchCoordinate(point.y) };
}

function collectOrchGraph(tree, treeIndex, rootPath = `trees.${treeIndex}.root`) {
  const nodes = [];
  const edges = [];
  const positions = new Map();
  let leafCursor = ORCH_GRAPH_MARGIN;

  function layout(node, path, depth) {
    if (!node || typeof node !== 'object') return;
    const children = Array.isArray(node.children) ? node.children : [];
    const autoChildren = children.map((child, index) => layout(child, `${path}.children.${index}`, depth + 1)).filter(Boolean);
    let x;
    if (autoChildren.length) {
      x = (autoChildren[0].x + autoChildren[autoChildren.length - 1].x) / 2;
    } else {
      x = leafCursor;
      leafCursor += ORCH_NODE_WIDTH + ORCH_X_GAP;
    }
    const saved = orchMetaNodePosition(path);
    const y = ORCH_GRAPH_MARGIN + depth * (ORCH_NODE_HEIGHT + ORCH_Y_GAP);
    const position = { x: saved?.x ?? x, y: saved?.y ?? y };
    positions.set(path, position);
    return { x, y };
  }

  function walk(node, path, parentPath = '') {
    if (!node || typeof node !== 'object') return;
    const position = positions.get(path) || { x: ORCH_GRAPH_MARGIN, y: ORCH_GRAPH_MARGIN };
    nodes.push({ path, node, ...position });
    if (parentPath) edges.push({ id: `${parentPath}->${path}`, source: parentPath, target: path });
    (Array.isArray(node.children) ? node.children : []).forEach((child, index) => {
      walk(child, `${path}.children.${index}`, path);
    });
  }

  if (tree?.root) {
    layout(tree.root, rootPath, 0);
    walk(tree.root, rootPath);
  }
  const minX = Math.min(0, ...nodes.map(item => item.x - ORCH_GRAPH_MARGIN));
  const minY = Math.min(0, ...nodes.map(item => item.y - ORCH_GRAPH_MARGIN));
  const maxX = Math.max(...nodes.map(item => item.x + ORCH_NODE_WIDTH + ORCH_GRAPH_MARGIN), 760);
  const maxY = Math.max(...nodes.map(item => item.y + ORCH_NODE_HEIGHT + ORCH_GRAPH_MARGIN), 520);
  const width = Math.max(760, maxX - minX);
  const height = Math.max(520, maxY - minY);
  return { tree, treeIndex, nodes, edges, minX, minY, width, height };
}

function orchTreeEntriesFromDoc(doc) {
  if (Array.isArray(doc?.trees)) {
    return doc.trees
      .map((tree, index) => ({ tree, index, rootPath: `trees.${index}.root` }))
      .filter(item => item.tree && typeof item.tree === 'object' && !Array.isArray(item.tree));
  }
  if (doc?.root && typeof doc.root === 'object' && !Array.isArray(doc.root)) {
    return [{
      tree: {
        id: doc.id || 'tree',
        label: doc.label || doc.id || 'Tree',
        root: doc.root,
      },
      index: 0,
      rootPath: 'root',
    }];
  }
  return [];
}

function collectOrchStateGraph(doc) {
  const graphDoc = doc?.graph && typeof doc.graph === 'object' && !Array.isArray(doc.graph) ? doc.graph : {};
  const rawNodes = Array.isArray(graphDoc.nodes) ? graphDoc.nodes : [];
  const rawTransitions = Array.isArray(graphDoc.transitions) ? graphDoc.transitions : [];
  const byId = new Map();
  const outgoing = new Map();
  const incoming = new Map();
  const depths = new Map();
  const nodes = [];

  rawNodes.forEach((node, index) => {
    const id = String(node?.id || `node-${index + 1}`);
    const path = `graph.nodes.${index}`;
    byId.set(id, { index, id, path, node: { ...node, id } });
    incoming.set(id, 0);
  });
  rawTransitions.forEach((transition) => {
    const from = String(transition?.from || '');
    const to = String(transition?.to || '');
    if (!from || !to || !byId.has(from) || !byId.has(to)) return;
    if (!outgoing.has(from)) outgoing.set(from, []);
    outgoing.get(from).push(to);
    incoming.set(to, (incoming.get(to) || 0) + 1);
  });

  const queue = [];
  const start = String(graphDoc.start || rawNodes[0]?.id || '');
  if (byId.has(start)) {
    depths.set(start, 0);
    queue.push(start);
  }
  rawNodes.forEach((node) => {
    const id = String(node?.id || '');
    if (id && (incoming.get(id) || 0) === 0 && !depths.has(id)) {
      depths.set(id, 0);
      queue.push(id);
    }
  });
  while (queue.length) {
    const id = queue.shift();
    const depth = depths.get(id) || 0;
    (outgoing.get(id) || []).forEach((to) => {
      if (!depths.has(to)) {
        depths.set(to, depth + 1);
        queue.push(to);
      }
    });
  }

  const levelCounts = new Map();
  rawNodes.forEach((node, index) => {
    const id = String(node?.id || `node-${index + 1}`);
    const entry = byId.get(id);
    const depth = depths.has(id) ? depths.get(id) : index;
    const lane = levelCounts.get(depth) || 0;
    levelCounts.set(depth, lane + 1);
    const saved = orchMetaNodePosition(entry.path);
    nodes.push({
      path: entry.path,
      node: entry.node,
      x: saved?.x ?? ORCH_GRAPH_MARGIN + lane * (ORCH_NODE_WIDTH + ORCH_X_GAP),
      y: saved?.y ?? ORCH_GRAPH_MARGIN + depth * (ORCH_NODE_HEIGHT + ORCH_Y_GAP),
    });
  });

  const nodePathById = new Map(nodes.map(item => [String(item.node?.id || ''), item.path]));
  const edges = [];
  rawTransitions.forEach((transition) => {
    const from = String(transition?.from || '');
    const to = String(transition?.to || '');
    const source = nodePathById.get(from);
    const target = nodePathById.get(to);
    if (!source || !target) return;
    edges.push({ id: `${source}->${target}`, source, target, from, to });
  });
  const minX = Math.min(0, ...nodes.map(item => item.x - ORCH_GRAPH_MARGIN));
  const minY = Math.min(0, ...nodes.map(item => item.y - ORCH_GRAPH_MARGIN));
  const maxX = Math.max(...nodes.map(item => item.x + ORCH_NODE_WIDTH + ORCH_GRAPH_MARGIN), 760);
  const maxY = Math.max(...nodes.map(item => item.y + ORCH_NODE_HEIGHT + ORCH_GRAPH_MARGIN), 520);
  return {
    tree: { id: graphDoc.id || '', label: graphDoc.label || 'Main flow' },
    treeIndex: 0,
    nodes,
    edges,
    minX,
    minY,
    width: Math.max(760, maxX - minX),
    height: Math.max(520, maxY - minY),
  };
}

function clampOrchZoom(scale, minScale = ORCH_ZOOM_MIN) {
  return Math.max(minScale, Math.min(ORCH_ZOOM_MAX, scale));
}

function orchViewportTransform() {
  const x = Math.round(orchGraphViewport.x);
  const y = Math.round(orchGraphViewport.y);
  const scale = Number(orchGraphViewport.scale.toFixed(3));
  return `translate(${x}px, ${y}px) scale(${scale})`;
}

function updateOrchViewportDom() {
  const activeTool = orchGraphTemporaryTool || orchGraphTool;
  const zoomText = `${Math.round(orchGraphViewport.scale * 100)}%`;
  const frames = contentEl.querySelectorAll('[data-orch-frame]');
  frames.forEach(frame => {
    const viewport = frame.querySelector('[data-orch-viewport]');
    if (viewport) viewport.style.transform = orchViewportTransform();
    frame.classList.toggle('hand', activeTool === 'hand');
  });
  contentEl.querySelectorAll('[data-orch-tool]').forEach(button => {
    button.classList.toggle('active', button.dataset.orchTool === activeTool);
  });
  contentEl.querySelectorAll('[data-orch-action="snap-toggle"]').forEach(button => {
    button.classList.toggle('active', orchGridSnapEnabled || orchTempSnap);
  });
  contentEl.querySelectorAll('[data-orch-zoom-label]').forEach(label => {
    label.dataset.zoomValue = zoomText;
    label.title = `Zoom ${zoomText}`;
    label.textContent = '';
  });
}

function setOrchViewport(next, options = {}) {
  const defaultMinScale = orchGraphViewport.scale < ORCH_ZOOM_MIN ? ORCH_FIT_ZOOM_MIN : ORCH_ZOOM_MIN;
  const minScale = Number.isFinite(options.minScale) ? options.minScale : defaultMinScale;
  orchGraphViewport = {
    x: Number.isFinite(next.x) ? next.x : orchGraphViewport.x,
    y: Number.isFinite(next.y) ? next.y : orchGraphViewport.y,
    scale: clampOrchZoom(Number.isFinite(next.scale) ? next.scale : orchGraphViewport.scale, minScale),
  };
  updateOrchViewportDom();
}

function setOrchGraphTool(tool) {
  orchGraphTemporaryTool = '';
  orchGraphTool = tool === 'hand' ? 'hand' : 'select';
  updateOrchViewportDom();
}

function setTempSnap(active) {
  if (orchTempSnap === active) return;
  orchTempSnap = active;
  updateOrchViewportDom();
}

function releaseOrchPointerCapture(el, pointerId) {
  try { el.releasePointerCapture?.(pointerId); } catch {}
}

function setOrchPointerCapture(el, pointerId) {
  try { el.setPointerCapture?.(pointerId); } catch {}
}

function zoomOrchGraph(frame, scaleMultiplier, origin) {
  if (!frame) return;
  const rect = frame.getBoundingClientRect();
  const localX = origin?.x ?? rect.width / 2;
  const localY = origin?.y ?? rect.height / 2;
  const graphX = (localX - orchGraphViewport.x) / orchGraphViewport.scale;
  const graphY = (localY - orchGraphViewport.y) / orchGraphViewport.scale;
  const minScale = orchGraphViewport.scale < ORCH_ZOOM_MIN ? ORCH_FIT_ZOOM_MIN : ORCH_ZOOM_MIN;
  const scale = clampOrchZoom(orchGraphViewport.scale * scaleMultiplier, minScale);
  setOrchViewport({
    scale,
    x: localX - graphX * scale,
    y: localY - graphY * scale,
  }, { minScale });
}

function orchGraphFitRect(frame, frameRect) {
  const padding = 22;
  const fitRect = {
    left: padding,
    top: padding,
    right: Math.max(padding, frameRect.width - padding),
    bottom: Math.max(padding, frameRect.height - padding),
  };
  const inspector = frame.closest('.orch-graph-main')?.querySelector('.orch-floating-inspector');
  if (!inspector) return fitRect;
  const inspectorStyle = getComputedStyle(inspector);
  const inspectorRect = inspector.getBoundingClientRect();
  const visible = inspectorStyle.display !== 'none'
    && inspectorStyle.visibility !== 'hidden'
    && inspectorRect.width > 0
    && inspectorRect.height > 0;
  if (!visible) return fitRect;
  const overlapsFrame = inspectorRect.left < frameRect.right
    && inspectorRect.right > frameRect.left
    && inspectorRect.top < frameRect.bottom
    && inspectorRect.bottom > frameRect.top;
  if (!overlapsFrame) return fitRect;
  fitRect.right = Math.max(fitRect.left, Math.min(fitRect.right, inspectorRect.left - frameRect.left - 12));
  return fitRect;
}

function fitOrchGraphToFrame(frame = contentEl.querySelector('[data-orch-frame]')) {
  if (!frame) return;
  const rect = frame.getBoundingClientRect();
  const width = Number(frame.dataset.w) || 760;
  const height = Number(frame.dataset.h) || 420;
  const minX = Number(frame.dataset.x) || 0;
  const minY = Number(frame.dataset.y) || 0;
  if (!rect.width || !rect.height) return;
  const fitRect = orchGraphFitRect(frame, rect);
  const fitWidth = Math.max(1, fitRect.right - fitRect.left);
  const fitHeight = Math.max(1, fitRect.bottom - fitRect.top);
  const scale = clampOrchZoom(Math.min(1.1, fitWidth / width, fitHeight / height), ORCH_FIT_ZOOM_MIN);
  setOrchViewport({
    scale,
    x: fitRect.left + (fitWidth - width * scale) / 2 - minX * scale,
    y: fitRect.top + (fitHeight - height * scale) / 2 - minY * scale,
  }, { minScale: ORCH_FIT_ZOOM_MIN });
}

function orchFramePoint(frame, event) {
  const rect = frame.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function orchFramePointToGraph(point) {
  return {
    x: (point.x - orchGraphViewport.x) / orchGraphViewport.scale,
    y: (point.y - orchGraphViewport.y) / orchGraphViewport.scale,
  };
}

function orchRectFromPoints(a, b) {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

function orchRectsIntersect(a, b) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

function orchTransitionTarget(target) {
  return target?.closest?.('.orch-transition, .orch-transition-hit');
}

function shouldSuppressOrchContextMenu(event) {
  if (Date.now() > suppressOrchContextMenuUntil) return false;
  if (suppressOrchContextMenuPoint && Math.hypot(event.clientX - suppressOrchContextMenuPoint.x, event.clientY - suppressOrchContextMenuPoint.y) > 8) return false;
  suppressOrchContextMenuUntil = 0;
  suppressOrchContextMenuPoint = null;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function orchNodePositionsInFrame(frame) {
  const positions = new Map();
  frame.querySelectorAll('.orch-graph-node').forEach(nodeEl => {
    positions.set(nodeEl.dataset.orchPath, {
      x: parseFloat(nodeEl.style.left) || 0,
      y: parseFloat(nodeEl.style.top) || 0,
    });
  });
  return positions;
}

function updateOrchGraphEdges(frame) {
  const nodePositions = orchNodePositionsInFrame(frame);
  frame.querySelectorAll('.orch-transition').forEach(pathEl => {
    const source = nodePositions.get(pathEl.dataset.source);
    const target = nodePositions.get(pathEl.dataset.target);
    if (source && target) {
      const d = orchEdgePath(source, target, pathEl.dataset.orchEdge);
      pathEl.setAttribute('d', d);
      pathEl.previousElementSibling?.setAttribute('d', d);
    }
  });
  frame.querySelectorAll('.orch-transition-handle').forEach(handle => {
    const pathEl = frame.querySelector(`.orch-transition[data-orch-edge="${CSS.escape(handle.dataset.orchEdge || '')}"]`);
    if (!pathEl) return;
    const source = nodePositions.get(pathEl.dataset.source);
    const target = nodePositions.get(pathEl.dataset.target);
    if (!source || !target) return;
    const point = orchTransitionPoint(handle.dataset.orchEdge, source, target);
    handle.setAttribute('cx', String(Math.round(point.x)));
    handle.setAttribute('cy', String(Math.round(point.y)));
  });
}

function closeOrchContextMenu() {
  contentEl.querySelector('[data-orch-context-menu]')?.remove();
}

function showOrchContextMenu({ x, y, path = '', edgeId = '', readwrite = false, frame = null, doc = null, baseFilePath = getActiveTab()?.filePath }) {
  closeOrchContextMenu();
  const targetPath = path || selectedOrchNodePath;
  const isGraphView = getActiveTab()?.viewType === 'orch-graph';
  const canOpenTree = canOpenOrchSubtree(path, doc);
  const canOpenFile = !!orchNodeFileTarget(path, doc, baseFilePath);
  const items = [];
  if (edgeId) {
    if (readwrite) {
      items.push(['transition-curve', 'Curve']);
      items.push(['transition-straight', 'Straight']);
      items.push(['delete-transition', 'Delete']);
    }
    items.push(['fit', 'Fit']);
  } else {
  if (canOpenTree) {
    items.push(['open-subtree', canOpenFile ? 'Open layer' : 'Open']);
  }
  if (canOpenFile) {
    items.push(['open-file', canOpenTree ? 'Open file' : 'Open']);
  }
  if (readwrite && (targetPath || (isGraphView && !activeOrchGraphLayerPath()))) {
    items.push(['add-context', 'Add Context']);
    items.push(['add-skill', 'Add Skill']);
    items.push(['insert-subtree', 'Insert subtree']);
  }
  if (readwrite && isGraphView && path && selectedOrchNodePath && selectedOrchNodePath !== path) {
    items.push(['connect-selected', 'Connect selected']);
  }
  if (readwrite && path) {
    if (!selectedOrchNodeIsRoot(path)) items.push(['delete-node', 'Delete node']);
  }
  if (readwrite && !path) {
    items.push(['auto-layout', 'Auto layout']);
  }
  items.push(['fit', 'Fit']);
  if (!readwrite && !items.length) items.push(['fit', 'Fit']);
  }

  const menu = document.createElement('div');
  menu.className = 'orch-context-menu';
  menu.dataset.orchContextMenu = 'true';
  menu.style.left = `${Math.round(x)}px`;
  menu.style.top = `${Math.round(y)}px`;
  menu.innerHTML = items.map(([action, label]) => `<button data-orch-context-action="${action}" data-orch-path="${escapeHtml(path)}" data-orch-edge="${escapeHtml(edgeId)}">${escapeHtml(label)}</button>`).join('');
  contentEl.querySelector('.orch-preview')?.appendChild(menu);
  const menuRect = menu.getBoundingClientRect();
  const hostRect = contentEl.getBoundingClientRect();
  if (menuRect.right > hostRect.right) menu.style.left = `${Math.max(8, Math.round(x - (menuRect.right - hostRect.right) - 8))}px`;
  if (menuRect.bottom > hostRect.bottom) menu.style.top = `${Math.max(8, Math.round(y - (menuRect.bottom - hostRect.bottom) - 8))}px`;
  menu.querySelectorAll('[data-orch-context-action]').forEach(button => {
    button.addEventListener('click', () => {
      const action = button.dataset.orchContextAction;
      closeOrchContextMenu();
      runOrchContextAction(action, button.dataset.orchPath || targetPath, frame, button.dataset.orchEdge || edgeId, doc, baseFilePath);
    });
  });
}

function addOrchChild(draft, path, type) {
  const node = orchValueAtPath(draft, path);
  if (!node || typeof node !== 'object') return;
  if (!Array.isArray(node.children)) node.children = [];
  const child = createOrchNode(type, [], node.children);
  node.children.push(child);
  setOrchSelection(`${path}.children.${node.children.length - 1}`);
}

function insertOrchSubtree(draft, path) {
  const node = orchValueAtPath(draft, path);
  if (!node || typeof node !== 'object') return;
  if (!Array.isArray(node.children)) node.children = [];
  node.children.push(createOrchSubtree(node.children));
  setOrchSelection(`${path}.children.${node.children.length - 1}`);
}

function ensureOrchGraphDoc(draft) {
  if (!draft.graph || typeof draft.graph !== 'object' || Array.isArray(draft.graph)) {
    draft.graph = { id: 'main-flow', label: 'Main flow', nodes: [], transitions: [] };
  }
  if (!Array.isArray(draft.graph.nodes)) draft.graph.nodes = [];
  if (!Array.isArray(draft.graph.transitions)) draft.graph.transitions = [];
  return draft.graph;
}

function isGraphNodePath(path) {
  return /^graph\.nodes\.\d+$/.test(String(path || ''));
}

function graphNodeIndex(path) {
  const match = String(path || '').match(/^graph\.nodes\.(\d+)$/);
  return match ? Number(match[1]) : -1;
}

function uniqueGraphTransitionId(graph, from, to) {
  const used = new Set((graph.transitions || []).map(item => item?.id).filter(Boolean));
  const base = `${from || 'node'}-to-${to || 'node'}`.replace(/[^a-zA-Z0-9_-]+/g, '-');
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function addGraphTransition(draft, fromPath, toPath) {
  const graph = ensureOrchGraphDoc(draft);
  const from = orchValueAtPath(draft, fromPath);
  const to = orchValueAtPath(draft, toPath);
  if (!from?.id || !to?.id || fromPath === toPath) return;
  if (graph.transitions.some(item => item?.from === from.id && item?.to === to.id)) return;
  graph.transitions.push({ id: uniqueGraphTransitionId(graph, from.id, to.id), from: from.id, to: to.id });
}

function addGraphNode(draft, sourcePath, type) {
  const graph = ensureOrchGraphDoc(draft);
  const node = createOrchNode(type, [], graph.nodes);
  graph.nodes.push(node);
  if (!graph.start) graph.start = node.id;
  const newPath = `graph.nodes.${graph.nodes.length - 1}`;
  if (sourcePath && orchValueAtPath(draft, sourcePath)?.id) addGraphTransition(draft, sourcePath, newPath);
  setOrchSelection(newPath);
}

function addOrchLinkedNode(draft, path, type) {
  if (isOrchGraphStateLayer()) addGraphNode(draft, path, type);
  else addOrchChild(draft, path, type);
}

function insertOrchLinkedSubtree(draft, path) {
  if (isOrchGraphStateLayer()) addGraphNode(draft, path, 'orpad.tree');
  else insertOrchSubtree(draft, path);
}

function deleteOrchNodeAtPath(draft, path) {
  if (isGraphNodePath(path)) {
    const graph = ensureOrchGraphDoc(draft);
    const index = graphNodeIndex(path);
    if (index < 0 || index >= graph.nodes.length) return;
    const id = graph.nodes[index]?.id;
    graph.nodes.splice(index, 1);
    graph.transitions = graph.transitions.filter(item => item?.from !== id && item?.to !== id);
    if (graph.start === id) graph.start = graph.nodes[0]?.id || '';
    mutateCurrentOrchMeta((meta) => {
      meta.layout.nodes = {};
      Object.keys(meta.transitions).forEach(key => delete meta.transitions[key]);
    });
    setOrchSelection('');
    return;
  }
  const parentInfo = parentArrayPathForOrchNode(path);
  if (!parentInfo) return;
  const siblings = orchValueAtPath(draft, parentInfo.arrayPath);
  if (Array.isArray(siblings)) {
    siblings.splice(parentInfo.index, 1);
    pruneOrchMetaForPath(path);
    setOrchSelection('');
  }
}

function edgeTargetPath(edgeId) {
  return String(edgeId || '').split('->')[1] || '';
}

function deleteOrchTransition(draft, edgeId) {
  const targetPath = edgeTargetPath(edgeId);
  if (!targetPath) return;
  const sourcePath = String(edgeId || '').split('->')[0] || '';
  if (getActiveTab()?.viewType === 'orch-graph' && isGraphNodePath(sourcePath) && isGraphNodePath(targetPath)) {
    const graph = ensureOrchGraphDoc(draft);
    const source = orchValueAtPath(draft, sourcePath);
    const target = orchValueAtPath(draft, targetPath);
    const index = graph.transitions.findIndex(item => item?.from === source?.id && item?.to === target?.id);
    if (index !== -1) graph.transitions.splice(index, 1);
    mutateCurrentOrchMeta((meta) => {
      delete meta.transitions[edgeId];
    });
    selectedOrchEdgeId = '';
    return;
  }
  deleteOrchNodeAtPath(draft, targetPath);
  mutateCurrentOrchMeta((meta) => {
    delete meta.transitions[edgeId];
  });
  selectedOrchEdgeId = '';
}

function runOrchContextAction(action, path, frame, edgeId = selectedOrchEdgeId, doc = null, baseFilePath = getActiveTab()?.filePath) {
  if (action === 'open-subtree') {
    openOrchGraphLayer(path);
    return;
  }
  if (action === 'open-file') {
    openOrchNodeFile(path, doc, baseFilePath).catch(err => notifyFormatError('Pipeline node file', err));
    return;
  }
  if (action === 'fit') {
    fitOrchGraphToFrame(frame || contentEl.querySelector('[data-orch-frame]'));
    return;
  }
  if (action === 'transition-curve' || action === 'transition-straight') {
    if (!edgeId) return;
    setOrchTransitionMeta(edgeId, {
      style: action === 'transition-straight' ? 'straight' : 'curve',
      points: [],
    });
    rerenderOrchTree();
    return;
  }
  if (action === 'auto-layout') {
    resetOrchGraphLayout();
    return;
  }
  if (action === 'delete-transition') {
    if (!edgeId) return;
    applyOrchTreeMutation((draft) => deleteOrchTransition(draft, edgeId));
    return;
  }
  if (!path && getActiveTab()?.viewType !== 'orch-graph') return;
  applyOrchTreeMutation((draft) => {
    if (action === 'add-context') addOrchLinkedNode(draft, path, isOrchGraphStateLayer() ? 'orpad.context' : 'Context');
    else if (action === 'add-skill') addOrchLinkedNode(draft, path, isOrchGraphStateLayer() ? 'orpad.skill' : 'Skill');
    else if (action === 'insert-subtree') insertOrchLinkedSubtree(draft, path);
    else if (action === 'connect-selected') addGraphTransition(draft, selectedOrchNodePath, path);
    else if (action === 'delete-node') deleteOrchNodeAtPath(draft, path);
  });
}

function deleteSelectedOrchGraphItems() {
  if (!isOrchViewType(getActiveTab()?.viewType)) return;
  if (orchTreeGraphMode !== 'readwrite') return;
  if (selectedOrchEdgeId) {
    applyOrchTreeMutation((draft) => deleteOrchTransition(draft, selectedOrchEdgeId));
    return;
  }
  const paths = [...selectedOrchNodePaths].filter(path => path && !selectedOrchNodeIsRoot(path));
  if (!paths.length && selectedOrchNodePath && !selectedOrchNodeIsRoot(selectedOrchNodePath)) paths.push(selectedOrchNodePath);
  if (!paths.length) return;
  applyOrchTreeMutation((draft) => {
    [...new Set(paths)].sort((a, b) => {
      const pa = parentArrayPathForOrchNode(a);
      const pb = parentArrayPathForOrchNode(b);
      if (pa?.arrayPath && pa.arrayPath === pb?.arrayPath) return pb.index - pa.index;
      return b.length - a.length;
    }).forEach(path => deleteOrchNodeAtPath(draft, path));
    setOrchSelection('');
  });
}

function handleOrchGraphKeydown(event) {
  if (!isOrchViewType(getActiveTab()?.viewType)) return;
  if (!contentEl.querySelector('.orch-preview')) return;
  if (event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    deleteSelectedOrchGraphItems();
  }
}

document.addEventListener('keydown', handleOrchGraphKeydown);

function handleOrchTransitionMouseDown(event) {
  if (!isOrchViewType(getActiveTab()?.viewType) || orchGraphTool !== 'select') return;
  if (event.button !== 0) return;
  const frame = event.target?.closest?.('[data-orch-frame]');
  if (!frame || event.target?.closest?.('.orch-graph-node')) return;
  const edgeEl = orchTransitionTarget(event.target);
  if (!edgeEl) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
  setOrchEdgeSelection(edgeEl.getAttribute('data-orch-edge') || edgeEl.dataset.orchEdge);
  rerenderOrchPreview();
}

document.addEventListener('mousedown', handleOrchTransitionMouseDown, true);

function handleOrchTransitionContextMenu(event) {
  if (!isOrchViewType(getActiveTab()?.viewType)) return;
  if (shouldSuppressOrchContextMenu(event)) return;
  const frame = event.target?.closest?.('[data-orch-frame]');
  if (!frame || event.target?.closest?.('.orch-graph-node')) return;
  const edgeEl = orchTransitionTarget(event.target);
  if (!edgeEl) return;
  event.preventDefault();
  event.stopPropagation();
  const edgeId = edgeEl.getAttribute('data-orch-edge') || edgeEl.dataset.orchEdge;
  setOrchEdgeSelection(edgeId);
  const hostRect = contentEl.querySelector('.orch-preview')?.getBoundingClientRect() || contentEl.getBoundingClientRect();
  showOrchContextMenu({
    x: event.clientX - hostRect.left,
    y: event.clientY - hostRect.top,
    edgeId,
    readwrite: orchTreeGraphMode === 'readwrite',
    frame,
  });
}

document.addEventListener('contextmenu', handleOrchTransitionContextMenu, true);

function orchTypeClass(type) {
  return String(type || 'node').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

function countOrchNestedNodes(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return 0;
  return 1 + (Array.isArray(node.children) ? node.children.reduce((sum, child) => sum + countOrchNestedNodes(child), 0) : 0);
}

function renderOrchGraphNode(item, readwrite, runProjection = null) {
  const { node, path, x, y } = item;
  const selected = isOrchNodeSelected(path);
  const primary = path === selectedOrchNodePath;
  const children = Array.isArray(node?.children) ? node.children.length : 0;
  const treeNodes = isOrchTreeRefType(node?.type) ? countOrchNestedNodes(node.tree?.root) : 0;
  const title = node?.label || node?.id || node?.type || 'Untitled node';
  const typeLabel = orchNodeTypeLabel(node?.type) || 'Node';
  const runtime = machineRuntimeStatusForGraphNode(item, runProjection);
  const progress = machineNodeProgress(item, runProjection);
  // The graph wrapper's node.completed fires once per executeRunStep but the underlying queue
  // can still hold unfinished items waiting for the next step (e.g. paused at patch-review).
  // Prefer the queue truth over the wrapper's stale completed status so users do not see
  // "Done" next to a half-filled progress bar.
  const displayRuntime = (runtime?.state === 'completed' && progress?.pattern === 'queue' && progress.done < progress.total)
    ? {
      ...runtime,
      state: 'blocked',
      label: `Paused (${progress.done}/${progress.total})`,
      title: `${progress.done} of ${progress.total} items processed; remaining items will resume on the next run step.`,
    }
    : runtime;
  const runtimeClass = displayRuntime ? ` runtime-${displayRuntime.state}` : '';
  return `
    <div class="orch-graph-node type-${escapeHtml(orchTypeClass(node?.type))}${runtimeClass} ${selected ? 'selected' : ''} ${primary ? 'primary' : ''} ${readwrite ? 'draggable' : ''}"
      data-orch-path="${escapeHtml(path)}"
      ${displayRuntime?.nodePath ? `data-machine-node-path="${escapeHtml(displayRuntime.nodePath)}"` : ''}
      role="button"
      tabindex="0"
      style="left:${Math.round(x)}px;top:${Math.round(y)}px">
      ${renderMachineNodeProgressBadge(progress)}
      <div class="orch-graph-node-top">
        <strong>${escapeHtml(title)}</strong>
        <span title="${escapeHtml(node?.type || '')}">${escapeHtml(typeLabel)}</span>
      </div>
      <div class="orch-graph-node-meta">
        <code>${escapeHtml(node?.id || '(no id)')}</code>
        ${treeNodes ? `<span>${treeNodes} tree nodes</span>` : children ? `<span>${children} child${children === 1 ? '' : 'ren'}</span>` : '<span>leaf</span>'}
      </div>
      ${displayRuntime ? `<div class="orch-runtime-status" title="${escapeHtml(displayRuntime.title)}"><span class="orch-runtime-dot"></span><span>${escapeHtml(displayRuntime.label)}</span></div>` : ''}
      ${renderMachineNodeProgressBar(progress)}
      ${isOrchSkillType(node?.type) && (node?.file || node?.config?.skillRef) ? `<small>${escapeHtml(node.file || node.config.skillRef)}</small>` : ''}
    </div>
  `;
}

function renderOrchEdge(edge, byPath, runProjection = null) {
  const source = byPath.get(edge.source);
  const target = byPath.get(edge.target);
  if (!source || !target) return '';
  const transition = currentOrchMeta().transitions[edge.id];
  const style = transition?.style === 'straight' ? 'straight' : 'curve';
  const selected = selectedOrchEdgeId === edge.id;
  const runtime = machineRuntimeStatusForGraphEdge(edge, source, target, runProjection);
  const runtimeClass = runtime ? ` runtime-${runtime.state}` : '';
  const point = orchTransitionPoint(edge.id, source, target);
  const edgePath = orchEdgePath(source, target, edge.id);
  const edgeDomId = `orch-edge-${hash32(`${edge.id}:${edgePath}`)}`;
  const activeFlow = runtime?.state === 'active'
    ? `
    <text class="orch-transition-flow-arrows" dy="-5" aria-hidden="true">
      <textPath href="#${escapeHtml(edgeDomId)}" startOffset="8%"><animate attributeName="startOffset" values="8%;72%" dur="1.35s" repeatCount="indefinite" />&gt; &gt; &gt; &gt;</textPath>
    </text>
    <text class="orch-transition-flow-arrows secondary" dy="-5" aria-hidden="true">
      <textPath href="#${escapeHtml(edgeDomId)}" startOffset="-24%"><animate attributeName="startOffset" values="-24%;42%" dur="1.35s" repeatCount="indefinite" />&gt; &gt; &gt; &gt;</textPath>
    </text>`
    : '';
  return `
    <path class="orch-transition-hit"
      data-orch-edge="${escapeHtml(edge.id)}"
      d="${edgePath}" />
    <path id="${escapeHtml(edgeDomId)}"
      class="orch-transition${runtimeClass} ${selected ? 'selected' : ''} style-${style}"
      data-orch-edge="${escapeHtml(edge.id)}"
      data-source="${escapeHtml(edge.source)}"
      data-target="${escapeHtml(edge.target)}"
      ${runtime ? `data-machine-edge-state="${escapeHtml(runtime.state)}"` : ''}
      d="${edgePath}" />
    ${activeFlow}
    ${selected ? `<circle class="orch-transition-handle" data-orch-edge="${escapeHtml(edge.id)}" cx="${Math.round(point.x)}" cy="${Math.round(point.y)}" r="6" />` : ''}
  `;
}

function renderOrchGraphCanvas(graph, readwrite, tools = true, runProjection = null) {
  const byPath = new Map(graph.nodes.map(node => [node.path, node]));
  const gx = Math.round(graph.minX);
  const gy = Math.round(graph.minY);
  const gw = Math.round(graph.width);
  const gh = Math.round(graph.height);
  return `
    <section class="orch-tree">
      <header>
        <strong>${escapeHtml(graph.tree?.label || graph.tree?.id || `Tree ${graph.treeIndex + 1}`)}</strong>
        <span>${escapeHtml(graph.tree?.id || '')}</span>
      </header>
      <div class="orch-graph-frame ${orchGraphTool === 'hand' ? 'hand' : ''}" data-orch-frame data-x="${gx}" data-y="${gy}" data-w="${gw}" data-h="${gh}">
        ${tools ? `<div class="orch-graph-tools">
          <button class="orch-tool-btn" data-orch-history="undo" title="Undo" aria-label="Undo" ${getOrchHistoryState()?.undo?.length ? '' : 'disabled'}>${ORCH_TOOL_ICON_UNDO}</button>
          <button class="orch-tool-btn" data-orch-history="redo" title="Redo" aria-label="Redo" ${getOrchHistoryState()?.redo?.length ? '' : 'disabled'}>${ORCH_TOOL_ICON_REDO}</button>
          <button class="orch-tool-btn ${orchGraphTool === 'select' ? 'active' : ''}" data-orch-tool="select">${ORCH_TOOL_ICON_SELECT}</button>
          <button class="orch-tool-btn ${orchGraphTool === 'hand' ? 'active' : ''}" data-orch-tool="hand">${ORCH_TOOL_ICON_HAND}</button>
          <button class="orch-tool-btn ${orchGridSnapEnabled || orchTempSnap ? 'active' : ''}" data-orch-action="snap-toggle">${ORCH_TOOL_ICON_SNAP}</button>
          <button class="orch-tool-btn orch-zoom-btn" data-orch-zoom="out" title="Zoom out" aria-label="Zoom out">${ORCH_TOOL_ICON_ZOOM_OUT}</button>
          <span class="orch-zoom-label" data-orch-zoom-label data-zoom-value="${Math.round(orchGraphViewport.scale * 100)}%" title="Zoom ${Math.round(orchGraphViewport.scale * 100)}%"></span>
          <button class="orch-tool-btn orch-zoom-btn" data-orch-zoom="in" title="Zoom in" aria-label="Zoom in">${ORCH_TOOL_ICON_ZOOM_IN}</button>
          <button class="orch-tool-btn" data-orch-action="fit" title="Fit" aria-label="Fit">${ORCH_TOOL_ICON_FIT}</button>
        </div>` : ''}
        <div class="orch-graph-viewport" data-orch-viewport style="width:${gw}px;height:${gh}px;transform:${orchViewportTransform()}">
          <div class="orch-graph-canvas" style="width:${gw}px;height:${gh}px">
            <svg class="orch-graph-edges" style="left:${gx}px;top:${gy}px;width:${gw}px;height:${gh}px" viewBox="${gx} ${gy} ${gw} ${gh}">
              ${graph.edges.map(edge => renderOrchEdge(edge, byPath, runProjection)).join('')}
            </svg>
            ${graph.nodes.map(node => renderOrchGraphNode(node, readwrite, runProjection)).join('')}
          </div>
        </div>
      </div>
    </section>
  `;
}

function orchLayerNodeLabel(doc, path) {
  const node = orchValueAtPath(doc, path);
  return node?.label || node?.id || 'Tree subflow';
}

function renderOrchGraphLayerBar(doc) {
  if (getActiveTab()?.viewType !== 'orch-graph') return '';
  const stack = currentOrchGraphLayerStack();
  const activePath = activeOrchGraphLayerPath();
  const crumbs = [
    `<button class="${activePath ? '' : 'active'}" data-orch-layer-index="-1">Main flow</button>`,
    ...stack.map((entry, index) => `<button class="${index === stack.length - 1 ? 'active' : ''}" data-orch-layer-index="${index}">${escapeHtml(orchLayerNodeLabel(doc, entry.path))}</button>`),
  ];
  return `
    <div class="orch-layer-bar" aria-label="Current flow layer">
      <div class="orch-layer-crumbs">${crumbs.join('<span>/</span>')}</div>
      ${stack.length ? `<button class="orch-layer-up" data-orch-layer-up="true">Up</button>` : ''}
    </div>
  `;
}

function selectedOrchNodeIsRoot(path) {
  return String(path || '') === 'root'
    || /^trees\.\d+\.root$/.test(String(path || ''))
    || /\.tree\.root$/.test(String(path || ''));
}

function renderOrchTypeField(path, node) {
  const types = orchNodeTypesForPath(path);
  const currentType = String(node?.type || '');
  const typeAllowed = types.includes(currentType);
  const scopeLabel = isOrchGraphNodeTypeTarget(path) ? 'flow' : 'tree';
  const options = [
    typeAllowed ? '' : `<option value="" disabled selected>Select ${scopeLabel} node type</option>`,
    ...types.map(type => `<option value="${type}" ${currentType === type ? 'selected' : ''}>${escapeHtml(orchNodeTypeLabel(type))}</option>`),
  ].join('');
  return `
    <label><span>Kind</span><select data-orch-edit="type" data-orch-path="${escapeHtml(path)}">${options}</select></label>
    ${currentType && !typeAllowed ? `<div class="runbook-empty">Current type ${escapeHtml(orchNodeTypeLabel(currentType))} is not addable in this ${scopeLabel} editor. Choose a listed type to convert it.</div>` : ''}
  `;
}

function renderOrchInspector(doc, readwrite, baseFilePath = getActiveTab()?.filePath) {
  if (selectedOrchEdgeId) {
    const transition = orchTransitionMeta(selectedOrchEdgeId);
    return `
      <aside class="orch-inspector">
        <h3>Transition</h3>
        <dl>
          <dt>Style</dt><dd>${escapeHtml(transition.style === 'straight' ? 'Straight' : 'Curve')}</dd>
          <dt>Target</dt><dd>${escapeHtml(edgeTargetPath(selectedOrchEdgeId))}</dd>
        </dl>
        ${readwrite ? `<div class="orch-inspector-actions">
          <button data-orch-action="transition-curve" data-orch-edge="${escapeHtml(selectedOrchEdgeId)}">Curve</button>
          <button data-orch-action="transition-straight" data-orch-edge="${escapeHtml(selectedOrchEdgeId)}">Straight</button>
          <button data-orch-action="delete-transition" data-orch-edge="${escapeHtml(selectedOrchEdgeId)}">Delete</button>
        </div>` : ''}
      </aside>
    `;
  }
  const selectedList = [...selectedOrchNodePaths].filter(path => !!orchValueAtPath(doc, path));
  if (selectedList.length > 1) {
    return `
      <aside class="orch-inspector">
        <h3>${selectedList.length} Nodes</h3>
        <div class="runbook-empty">Right-click a selected node for subtree actions.</div>
      </aside>
    `;
  }
  const node = selectedOrchNodePath ? orchValueAtPath(doc, selectedOrchNodePath) : null;
  if (!node || typeof node !== 'object') {
    return `
      <aside class="orch-inspector">
        <h3>Node</h3>
        <div class="runbook-empty">Select a step in the flow.</div>
      </aside>
    `;
  }
  const diagnostics = graphNodeDiagnostics(doc, selectedOrchNodePath, baseFilePath);
  const nodeDiagnostic = diagnostics[0] || null;
  if (!readwrite) {
    return `
      <aside class="orch-inspector">
        <h3>${escapeHtml(node.label || node.id || 'Node')}</h3>
        <dl>
          <dt>Kind</dt><dd title="${escapeHtml(node.type || '')}">${escapeHtml(orchNodeTypeLabel(node.type))}</dd>
          ${node.file ? `<dt>File</dt><dd>${escapeHtml(node.file)}</dd>` : ''}
          ${isOrchTreeRefType(node.type) && node.tree?.id ? `<dt>Tree</dt><dd>${escapeHtml(node.tree.id)}</dd>` : ''}
          ${isOrchTreeRefType(node.type) && node.tree?.root ? `<dt>Tree nodes</dt><dd>${countOrchNestedNodes(node.tree.root)}</dd>` : ''}
        </dl>
        ${renderPipelineInlineDiagnostic(nodeDiagnostic)}
      </aside>
    `;
  }
  return `
    <aside class="orch-inspector">
      <h3>Edit Node</h3>
      ${renderOrchInspectorField('Step key', 'id', selectedOrchNodePath, node.id || '')}
      ${renderOrchInspectorField('Label', 'label', selectedOrchNodePath, node.label || '')}
      ${renderOrchTypeField(selectedOrchNodePath, node)}
      ${node.type === 'Skill' ? renderOrchInspectorField('Skill file', 'file', selectedOrchNodePath, node.file || '', graphNodeFieldDiagnostic(diagnostics, 'file', node)) : ''}
      ${node.type === 'orpad.skill' ? renderOrchInspectorField('Skill ref', 'config.skillRef', selectedOrchNodePath, node.config?.skillRef || '', graphNodeFieldDiagnostic(diagnostics, 'config.skillRef', node)) : ''}
      ${node.type === 'orpad.tree' ? renderOrchInspectorField('Tree ref', 'config.treeRef', selectedOrchNodePath, node.config?.treeRef || node.config?.ref || '', graphNodeFieldDiagnostic(diagnostics, 'config.treeRef', node)) : ''}
      ${node.type === 'orpad.graph' ? renderOrchInspectorField('Flow ref', 'config.graphRef', selectedOrchNodePath, node.config?.graphRef || '', graphNodeFieldDiagnostic(diagnostics, 'config.graphRef', node)) : ''}
      ${['orpad.probe', 'orpad.triage', 'orpad.dispatcher', 'orpad.workerLoop'].includes(node.type) ? renderOrchInspectorField('Queue ref', 'config.queueRef', selectedOrchNodePath, node.config?.queueRef || '', graphNodeFieldDiagnostic(diagnostics, 'config.queueRef', node)) : ''}
      ${node.type === 'orpad.dispatcher' ? renderOrchInspectorField('Worker loop ref', 'config.workerLoopRef', selectedOrchNodePath, node.config?.workerLoopRef || '', graphNodeFieldDiagnostic(diagnostics, 'config.workerLoopRef', node)) : ''}
      <div class="orch-inspector-actions">
        ${canOpenOrchSubtree(selectedOrchNodePath, doc) ? `<button data-orch-action="open-subtree" data-orch-path="${escapeHtml(selectedOrchNodePath)}">Open</button>` : ''}
        ${!canOpenOrchSubtree(selectedOrchNodePath, doc) && orchNodeFileTarget(selectedOrchNodePath, doc, baseFilePath) ? `<button data-orch-action="open-file" data-orch-path="${escapeHtml(selectedOrchNodePath)}">Open file</button>` : ''}
        <button data-orch-action="add-child" data-orch-path="${escapeHtml(selectedOrchNodePath)}">${isOrchGraphStateLayer() ? 'Add linked node' : 'Add child'}</button>
        ${selectedOrchNodeIsRoot(selectedOrchNodePath) ? '' : `<button data-orch-action="delete-node" data-orch-path="${escapeHtml(selectedOrchNodePath)}">Delete node</button>`}
      </div>
    </aside>
  `;
}

function renderOrchTreePreview(content) {
  contentEl.innerHTML = '';
  let doc;
  try {
    doc = JSON.parse(content);
  } catch (err) {
    contentEl.innerHTML = '<div class="preview-error">Invalid orch-tree JSON: ' + escapeHtml(err.message || String(err)) + '</div>';
    return;
  }
  const pipelineContext = pipelineContextForPath();
  const pipelineRunInProgress = isPipelineMachineRunInProgress(pipelineContext?.pipelinePath);
  if (pipelineRunInProgress && orchTreeGraphMode === 'readwrite') orchTreeGraphMode = 'readonly';
  const readwrite = orchTreeGraphMode === 'readwrite' && !pipelineRunInProgress;
  const editLockTitle = pipelineRunInProgress ? 'Run in progress; editing is locked.' : 'Edit';
  const treeEntries = orchTreeEntriesFromDoc(doc);
  const graphs = treeEntries.map(({ tree, index, rootPath }) => collectOrchGraph(tree, index, rootPath));
  if (!selectedOrchEdgeId || !graphs.some(graph => graph.edges.some(edge => edge.id === selectedOrchEdgeId))) {
    selectedOrchEdgeId = '';
    normalizeOrchSelection(doc, graphs[0]?.nodes[0]?.path || '');
  }
  contentEl.innerHTML = `
    <div class="orch-preview">
      <div class="orch-toolbar">
        <strong>Tree setup</strong>
        <div class="orch-toolbar-actions">
          <div class="jedit-seg">
            <button class="jedit-seg-btn ${readwrite ? '' : 'active'}" data-orch-mode="readonly">View</button>
            <button class="jedit-seg-btn ${readwrite ? 'active' : ''}" data-orch-mode="readwrite" title="${escapeHtml(editLockTitle)}" ${pipelineRunInProgress ? 'disabled' : ''}>Edit</button>
          </div>
        </div>
      </div>
      <div class="orch-graph-layout orch-graph-layout-internal-inspector">
        <div class="orch-graph-main">
          ${graphs.length ? graphs.map(graph => renderOrchGraphCanvas(graph, readwrite)).join('') : '<div class="runbook-empty">No trees found.</div>'}
          <div class="orch-floating-inspector">${renderOrchInspector(doc, readwrite)}</div>
        </div>
      </div>
    </div>
  `;

  contentEl.querySelectorAll('[data-orch-mode]').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.orchMode === 'readwrite' && isPipelineMachineRunInProgress(pipelineContext?.pipelinePath)) {
        orchTreeGraphMode = 'readonly';
        lastRendered = { tabId: null, viewType: null, content: null };
        rerenderOrchTree();
        return;
      }
      orchTreeGraphMode = button.dataset.orchMode;
      lastRendered = { tabId: null, viewType: null, content: null };
      orchGraphFitAfterRender = true;
      rerenderOrchTree();
    });
  });
  contentEl.querySelectorAll('[data-orch-tool]').forEach(button => {
    button.addEventListener('click', () => {
      setOrchGraphTool(button.dataset.orchTool);
    });
  });
  contentEl.querySelectorAll('[data-orch-history]').forEach(button => {
    button.addEventListener('click', () => {
      runOrchHistoryCommand(button.dataset.orchHistory);
    });
  });
  contentEl.querySelectorAll('[data-orch-zoom]').forEach(button => {
    button.addEventListener('click', () => {
      const frame = contentEl.querySelector('[data-orch-frame]');
      zoomOrchGraph(frame, button.dataset.orchZoom === 'in' ? 1.2 : 1 / 1.2);
    });
  });
  contentEl.querySelectorAll('[data-orch-frame]').forEach(frame => {
    let pan = null;
    let rightPan = null;
    let selectDrag = null;
    frame.addEventListener('pointerdown', (event) => {
      if (event.button !== 2 || event.target.closest('.orch-graph-tools')) return;
      if (event.target.closest('.orch-graph-node') || orchTransitionTarget(event.target)) return;
      closeOrchContextMenu();
      rightPan = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        viewX: orchGraphViewport.x,
        viewY: orchGraphViewport.y,
        moved: false,
      };
      orchGraphTemporaryTool = 'hand';
      updateOrchViewportDom();
      frame.classList.add('panning');
      setOrchPointerCapture(frame, event.pointerId);
    }, true);
    frame.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || orchGraphTool !== 'hand') return;
      if (event.target.closest('.orch-graph-tools')) return;
      event.preventDefault();
      event.stopPropagation();
      pan = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        viewX: orchGraphViewport.x,
        viewY: orchGraphViewport.y,
      };
      frame.classList.add('panning');
      setOrchPointerCapture(frame, event.pointerId);
    }, true);
    frame.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || orchGraphTool !== 'select') return;
      if (event.target.closest('.orch-graph-node')) return;
      if (event.target.closest('.orch-graph-tools') || orchTransitionTarget(event.target)) return;
      event.preventDefault();
      closeOrchContextMenu();
      const start = orchFramePoint(frame, event);
      const marquee = document.createElement('div');
      marquee.className = 'orch-selection-marquee';
      frame.appendChild(marquee);
      selectDrag = {
        pointerId: event.pointerId,
        start,
        current: start,
        marquee,
        moved: false,
      };
      setOrchPointerCapture(frame, event.pointerId);
    });
    frame.addEventListener('pointermove', (event) => {
      if (!pan || pan.pointerId !== event.pointerId) return;
      setOrchViewport({
        x: pan.viewX + event.clientX - pan.startX,
        y: pan.viewY + event.clientY - pan.startY,
        scale: orchGraphViewport.scale,
      });
    });
    frame.addEventListener('pointermove', (event) => {
      if (!rightPan) return;
      const dx = event.clientX - rightPan.startX;
      const dy = event.clientY - rightPan.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) rightPan.moved = true;
      if (rightPan.moved) event.preventDefault();
      setOrchViewport({
        x: rightPan.viewX + dx,
        y: rightPan.viewY + dy,
        scale: orchGraphViewport.scale,
      });
    });
    const updateSelectDrag = (event) => {
      const current = orchFramePoint(frame, event);
      selectDrag.current = current;
      const rect = orchRectFromPoints(selectDrag.start, current);
      if (Math.abs(current.x - selectDrag.start.x) + Math.abs(current.y - selectDrag.start.y) > 5) selectDrag.moved = true;
      Object.assign(selectDrag.marquee.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.right - rect.left}px`,
        height: `${rect.bottom - rect.top}px`,
      });
    };
    const finishPan = (event) => {
      if (!pan || pan.pointerId !== event.pointerId) return;
      releaseOrchPointerCapture(frame, event.pointerId);
      frame.classList.remove('panning');
      pan = null;
    };
    const finishRightPan = (event) => {
      if (!rightPan) return;
      const wasMoved = rightPan.moved;
      releaseOrchPointerCapture(frame, event.pointerId);
      frame.classList.remove('panning');
      rightPan = null;
      orchGraphTemporaryTool = '';
      updateOrchViewportDom();
      if (wasMoved) {
        suppressOrchContextMenuUntil = Date.now() + 350;
        suppressOrchContextMenuPoint = { x: event.clientX, y: event.clientY };
      }
    };
    const finishSelectDragCore = () => {
      const wasMoved = selectDrag.moved;
      const marquee = selectDrag.marquee;
      const frameRect = orchRectFromPoints(selectDrag.start, selectDrag.current);
      marquee.remove();
      selectDrag = null;
      if (!wasMoved) {
        setOrchSelection('');
        rerenderOrchTree();
        return;
      }
      const hostRect = frame.getBoundingClientRect();
      const screenRect = {
        left: hostRect.left + frameRect.left,
        top: hostRect.top + frameRect.top,
        right: hostRect.left + frameRect.right,
        bottom: hostRect.top + frameRect.bottom,
      };
      const hits = [...frame.querySelectorAll('.orch-graph-node')].filter(nodeEl => {
        const rect = nodeEl.getBoundingClientRect();
        return orchRectsIntersect(screenRect, rect);
      }).map(nodeEl => nodeEl.dataset.orchPath).filter(Boolean);
      setOrchSelection(hits);
      rerenderOrchTree();
    };
    const finishSelectDrag = (event) => {
      if (!selectDrag || selectDrag.pointerId !== event.pointerId) return;
      releaseOrchPointerCapture(frame, event.pointerId);
      finishSelectDragCore();
    };
    frame.addEventListener('pointermove', (event) => {
      if (!selectDrag || selectDrag.pointerId !== event.pointerId) return;
      updateSelectDrag(event);
    });
    frame.addEventListener('pointerup', finishPan);
    frame.addEventListener('pointercancel', finishPan);
    frame.addEventListener('pointerup', finishRightPan);
    frame.addEventListener('pointercancel', finishRightPan);
    frame.addEventListener('pointerup', finishSelectDrag);
    frame.addEventListener('pointercancel', finishSelectDrag);
    frame.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = frame.getBoundingClientRect();
      zoomOrchGraph(frame, event.deltaY < 0 ? 1.12 : 1 / 1.12, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    }, { passive: false });
    frame.addEventListener('contextmenu', (event) => {
      if (shouldSuppressOrchContextMenu(event)) return;
      if (event.target.closest('.orch-graph-node')) return;
      if (event.target.closest('.orch-graph-tools') || orchTransitionTarget(event.target)) return;
      event.preventDefault();
      const hostRect = contentEl.querySelector('.orch-preview')?.getBoundingClientRect() || contentEl.getBoundingClientRect();
      showOrchContextMenu({
        x: event.clientX - hostRect.left,
        y: event.clientY - hostRect.top,
        readwrite,
        frame,
      });
    });
  });
  contentEl.querySelectorAll('.orch-transition-handle').forEach(handleEl => {
    let drag = null;
    handleEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !readwrite) return;
      event.preventDefault();
      event.stopPropagation();
      const frame = handleEl.closest('[data-orch-frame]');
      const edgeId = handleEl.dataset.orchEdge;
      const pathEl = frame?.querySelector(`.orch-transition[data-orch-edge="${CSS.escape(edgeId || '')}"]`);
      if (!frame || !pathEl) return;
      drag = { pointerId: event.pointerId, frame, edgeId, pathEl };
      setTempSnap(event.ctrlKey || event.metaKey);
      setOrchPointerCapture(handleEl, event.pointerId);
    });
    handleEl.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const forceSnap = event.ctrlKey || event.metaKey;
      setTempSnap(forceSnap);
      const graphPoint = snapOrchPoint(orchFramePointToGraph(orchFramePoint(drag.frame, event)), forceSnap);
      const nodePositions = orchNodePositionsInFrame(drag.frame);
      const source = nodePositions.get(drag.pathEl.dataset.source);
      const target = nodePositions.get(drag.pathEl.dataset.target);
      if (!source || !target) return;
      drag.graphPoint = graphPoint;
      const style = orchTransitionMeta(drag.edgeId).style;
      const d = orchEdgePathWithPoint(source, target, style, graphPoint);
      drag.pathEl.setAttribute('d', d);
      drag.pathEl.previousElementSibling?.setAttribute('d', d);
      handleEl.setAttribute('cx', String(Math.round(graphPoint.x)));
      handleEl.setAttribute('cy', String(Math.round(graphPoint.y)));
    });
    handleEl.addEventListener('pointerup', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const graphPoint = drag.graphPoint || snapOrchPoint(orchFramePointToGraph(orchFramePoint(drag.frame, event)), event.ctrlKey || event.metaKey);
      releaseOrchPointerCapture(handleEl, event.pointerId);
      setTempSnap(false);
      setOrchTransitionMeta(drag.edgeId, {
        ...orchTransitionMeta(drag.edgeId),
        points: [{ x: Math.round(graphPoint.x), y: Math.round(graphPoint.y) }],
      });
      drag = null;
      rerenderOrchTree();
    });
    handleEl.addEventListener('pointercancel', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      releaseOrchPointerCapture(handleEl, event.pointerId);
      drag = null;
      setTempSnap(false);
    });
  });
  contentEl.querySelectorAll('[data-orch-edit]').forEach(control => {
    control.addEventListener('change', () => {
      const field = control.dataset.orchEdit;
      const path = control.dataset.orchPath;
      applyOrchTreeMutation((draft) => {
        const node = orchValueAtPath(draft, path);
        if (!node || typeof node !== 'object') return;
        const previousId = node.id;
        setOrchNodeEditField(node, field, control.value);
        if (getActiveTab()?.viewType === 'orch-graph' && field === 'id' && previousId && previousId !== node.id) {
          const graph = ensureOrchGraphDoc(draft);
          if (graph.start === previousId) graph.start = node.id;
          graph.transitions.forEach(transition => {
            if (transition.from === previousId) transition.from = node.id;
            if (transition.to === previousId) transition.to = node.id;
          });
        }
        if (field === 'type') applyOrchTypeDefaults(node, control.value);
      });
    });
  });
  contentEl.querySelectorAll('.orch-graph-node').forEach(nodeEl => {
    let drag = null;
    nodeEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (orchGraphTool === 'hand') return;
      if (event.detail >= 2 && hasOrchNodeOpenTarget(nodeEl.dataset.orchPath)) {
        event.preventDefault();
        event.stopPropagation();
        openOrchNodeTarget(nodeEl.dataset.orchPath);
        return;
      }
      event.stopPropagation();
      const startLeft = parseFloat(nodeEl.style.left) || 0;
      const startTop = parseFloat(nodeEl.style.top) || 0;
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLeft,
        startTop,
        moved: false,
      };
      setOrchPointerCapture(nodeEl, event.pointerId);
      if (readwrite) setTempSnap(event.ctrlKey || event.metaKey);
      if (readwrite) nodeEl.classList.add('dragging');
    });
    nodeEl.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId || !readwrite) return;
      const dx = (event.clientX - drag.startX) / orchGraphViewport.scale;
      const dy = (event.clientY - drag.startY) / orchGraphViewport.scale;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      const forceSnap = event.ctrlKey || event.metaKey;
      setTempSnap(forceSnap);
      const next = snapOrchPoint({ x: drag.startLeft + dx, y: drag.startTop + dy }, forceSnap);
      nodeEl.style.left = `${next.x}px`;
      nodeEl.style.top = `${next.y}px`;
      const frame = nodeEl.closest('[data-orch-frame]');
      if (frame) updateOrchGraphEdges(frame);
    });
    nodeEl.addEventListener('pointerup', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      releaseOrchPointerCapture(nodeEl, event.pointerId);
      nodeEl.classList.remove('dragging');
      setTempSnap(false);
      const path = nodeEl.dataset.orchPath;
      const moved = drag.moved;
      const x = parseFloat(nodeEl.style.left) || 0;
      const y = parseFloat(nodeEl.style.top) || 0;
      drag = null;
      if (readwrite && moved) {
        setOrchSelection(path);
        setOrchMetaNodePosition(path, x, y);
        rerenderOrchTree();
      } else if (!moved && hasOrchNodeOpenTarget(path) && event.detail >= 2) {
        if (orchNodeClickTimer) clearTimeout(orchNodeClickTimer);
        orchNodeClickTimer = 0;
        openOrchNodeTarget(path);
        return;
      } else if (!moved && hasOrchNodeOpenTarget(path) && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (isOnlyOrchNodeSelected(path)) return;
        if (orchNodeClickTimer) clearTimeout(orchNodeClickTimer);
        orchNodeClickTimer = window.setTimeout(() => {
          setOrchSelection(path);
          rerenderOrchTree();
          orchNodeClickTimer = 0;
        }, 220);
        return;
      } else {
        if (!event.ctrlKey && !event.metaKey && !event.shiftKey && isOnlyOrchNodeSelected(path)) return;
        if (event.ctrlKey || event.metaKey || event.shiftKey) toggleOrchSelection(path);
        else setOrchSelection(path);
        rerenderOrchTree();
      }
    });
    nodeEl.addEventListener('pointercancel', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      releaseOrchPointerCapture(nodeEl, event.pointerId);
      nodeEl.classList.remove('dragging');
      drag = null;
      setTempSnap(false);
    });
    nodeEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      setOrchSelection(nodeEl.dataset.orchPath);
      rerenderOrchTree();
    });
    nodeEl.addEventListener('click', (event) => {
      if (orchGraphTool === 'hand') return;
      event.preventDefault();
      event.stopPropagation();
      const path = nodeEl.dataset.orchPath;
      if (event.detail >= 2 && hasOrchNodeOpenTarget(path)) {
        if (orchNodeClickTimer) clearTimeout(orchNodeClickTimer);
        orchNodeClickTimer = 0;
        openOrchNodeTarget(path);
        return;
      }
      if (hasOrchNodeOpenTarget(path) && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (isOnlyOrchNodeSelected(path)) return;
        if (orchNodeClickTimer) clearTimeout(orchNodeClickTimer);
        orchNodeClickTimer = window.setTimeout(() => {
          setOrchSelection(path);
          rerenderOrchTree();
          orchNodeClickTimer = 0;
        }, 220);
        return;
      }
      if (!event.ctrlKey && !event.metaKey && !event.shiftKey && isOnlyOrchNodeSelected(path)) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey) toggleOrchSelection(path);
      else setOrchSelection(path);
      rerenderOrchTree();
    });
    nodeEl.addEventListener('dblclick', (event) => {
      if (orchGraphTool === 'hand') return;
      const path = nodeEl.dataset.orchPath;
      if (!hasOrchNodeOpenTarget(path)) return;
      event.preventDefault();
      event.stopPropagation();
      if (orchNodeClickTimer) clearTimeout(orchNodeClickTimer);
      orchNodeClickTimer = 0;
      openOrchNodeTarget(path);
    });
    nodeEl.addEventListener('contextmenu', (event) => {
      if (shouldSuppressOrchContextMenu(event)) return;
      event.preventDefault();
      const path = nodeEl.dataset.orchPath;
      if (!isOrchNodeSelected(path)) setOrchSelection(path);
      const hostRect = contentEl.querySelector('.orch-preview')?.getBoundingClientRect() || contentEl.getBoundingClientRect();
      showOrchContextMenu({
        x: event.clientX - hostRect.left,
        y: event.clientY - hostRect.top,
        path,
        readwrite,
        frame: nodeEl.closest('[data-orch-frame]'),
      });
    });
  });
  contentEl.querySelectorAll('[data-orch-action]').forEach(button => {
    button.addEventListener('click', () => {
      const action = button.dataset.orchAction;
      const path = button.dataset.orchPath;
      const edgeId = button.dataset.orchEdge || selectedOrchEdgeId;
      if (action === 'fit') {
        fitOrchGraphToFrame();
        return;
      }
      if (action === 'snap-toggle') {
        orchGridSnapEnabled = !orchGridSnapEnabled;
        updateOrchViewportDom();
        button.classList.toggle('active', orchGridSnapEnabled || orchTempSnap);
        return;
      }
      if (action === 'open-subtree' || action === 'open-file') {
        runOrchContextAction(action, path, contentEl.querySelector('[data-orch-frame]'), edgeId);
        return;
      }
      if (action === 'transition-curve' || action === 'transition-straight' || action === 'delete-transition') {
        runOrchContextAction(action, path, contentEl.querySelector('[data-orch-frame]'), edgeId);
        return;
      }
      if (action === 'auto-layout') {
        resetOrchGraphLayout();
        return;
      }
      applyOrchTreeMutation((draft) => {
        const node = orchValueAtPath(draft, path);
        if (action === 'add-child' && node && typeof node === 'object') {
          addOrchLinkedNode(draft, path, isOrchGraphStateLayer() ? 'orpad.context' : 'Context');
        } else if (action === 'delete-node') {
          deleteOrchNodeAtPath(draft, path);
        }
      });
    });
  });
  document.addEventListener('click', closeOrchContextMenu, { once: true, capture: true });
  updateOrchViewportDom();
  if (orchGraphFitAfterRender) {
    orchGraphFitAfterRender = false;
    requestAnimationFrame(() => fitOrchGraphToFrame());
  }
}

function bindOrchGraphEditorInteractions(readwrite, graphDoc = null, graphBaseFilePath = getActiveTab()?.filePath, pipelineContext = pipelineContextForPath()) {
  contentEl.querySelectorAll('[data-orch-layer-index]').forEach(button => {
    button.addEventListener('click', () => navigateOrchGraphLayer(Number(button.dataset.orchLayerIndex)));
  });
  contentEl.querySelectorAll('[data-orch-layer-up]').forEach(button => {
    button.addEventListener('click', () => navigateOrchGraphLayer(currentOrchGraphLayerStack().length - 2));
  });
  contentEl.querySelectorAll('[data-orch-mode]').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.orchMode === 'readwrite' && isPipelineMachineRunInProgress(pipelineContext?.pipelinePath)) {
        orchTreeGraphMode = 'readonly';
        lastRendered = { tabId: null, viewType: null, content: null };
        orchGraphFitAfterRender = true;
        rerenderOrchPreview();
        return;
      }
      orchTreeGraphMode = button.dataset.orchMode;
      lastRendered = { tabId: null, viewType: null, content: null };
      orchGraphFitAfterRender = true;
      rerenderOrchPreview();
    });
  });
  contentEl.querySelectorAll('[data-orch-tool]').forEach(button => {
    button.addEventListener('click', () => setOrchGraphTool(button.dataset.orchTool));
  });
  contentEl.querySelectorAll('[data-orch-history]').forEach(button => {
    button.addEventListener('click', () => runOrchHistoryCommand(button.dataset.orchHistory));
  });
  contentEl.querySelectorAll('[data-orch-zoom]').forEach(button => {
    button.addEventListener('click', () => {
      zoomOrchGraph(contentEl.querySelector('[data-orch-frame]'), button.dataset.orchZoom === 'in' ? 1.2 : 1 / 1.2);
    });
  });
  contentEl.querySelectorAll('[data-orch-frame]').forEach(frame => {
    let pan = null;
    let rightPan = null;
    let selectDrag = null;
    frame.addEventListener('pointerdown', (event) => {
      if (event.button !== 2 || event.target.closest('.orch-graph-tools')) return;
      if (event.target.closest('.orch-graph-node') || orchTransitionTarget(event.target)) return;
      closeOrchContextMenu();
      rightPan = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, viewX: orchGraphViewport.x, viewY: orchGraphViewport.y, moved: false };
      orchGraphTemporaryTool = 'hand';
      updateOrchViewportDom();
      frame.classList.add('panning');
      setOrchPointerCapture(frame, event.pointerId);
    }, true);
    frame.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || orchGraphTool !== 'hand' || event.target.closest('.orch-graph-tools')) return;
      event.preventDefault();
      event.stopPropagation();
      pan = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, viewX: orchGraphViewport.x, viewY: orchGraphViewport.y };
      frame.classList.add('panning');
      setOrchPointerCapture(frame, event.pointerId);
    }, true);
    frame.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || orchGraphTool !== 'select') return;
      if (event.target.closest('.orch-graph-node') || event.target.closest('.orch-graph-tools') || orchTransitionTarget(event.target)) return;
      event.preventDefault();
      closeOrchContextMenu();
      const start = orchFramePoint(frame, event);
      const marquee = document.createElement('div');
      marquee.className = 'orch-selection-marquee';
      frame.appendChild(marquee);
      selectDrag = { pointerId: event.pointerId, start, current: start, marquee, moved: false };
      setOrchPointerCapture(frame, event.pointerId);
    });
    frame.addEventListener('pointermove', (event) => {
      if (pan && pan.pointerId === event.pointerId) {
        setOrchViewport({ x: pan.viewX + event.clientX - pan.startX, y: pan.viewY + event.clientY - pan.startY, scale: orchGraphViewport.scale });
      }
      if (rightPan) {
        const dx = event.clientX - rightPan.startX;
        const dy = event.clientY - rightPan.startY;
        if (Math.abs(dx) + Math.abs(dy) > 3) rightPan.moved = true;
        if (rightPan.moved) event.preventDefault();
        setOrchViewport({ x: rightPan.viewX + dx, y: rightPan.viewY + dy, scale: orchGraphViewport.scale });
      }
      if (selectDrag && selectDrag.pointerId === event.pointerId) {
        const current = orchFramePoint(frame, event);
        selectDrag.current = current;
        const rect = orchRectFromPoints(selectDrag.start, current);
        if (Math.abs(current.x - selectDrag.start.x) + Math.abs(current.y - selectDrag.start.y) > 5) selectDrag.moved = true;
        Object.assign(selectDrag.marquee.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.right - rect.left}px`, height: `${rect.bottom - rect.top}px` });
      }
    });
    const finishPan = (event) => {
      if (!pan || pan.pointerId !== event.pointerId) return;
      releaseOrchPointerCapture(frame, event.pointerId);
      frame.classList.remove('panning');
      pan = null;
    };
    const finishRightPan = (event) => {
      if (!rightPan) return;
      const wasMoved = rightPan.moved;
      releaseOrchPointerCapture(frame, event.pointerId);
      frame.classList.remove('panning');
      rightPan = null;
      orchGraphTemporaryTool = '';
      updateOrchViewportDom();
      if (wasMoved) {
        suppressOrchContextMenuUntil = Date.now() + 350;
        suppressOrchContextMenuPoint = { x: event.clientX, y: event.clientY };
      }
    };
    const finishSelectDrag = (event) => {
      if (!selectDrag || selectDrag.pointerId !== event.pointerId) return;
      releaseOrchPointerCapture(frame, event.pointerId);
      const wasMoved = selectDrag.moved;
      const rect = orchRectFromPoints(selectDrag.start, selectDrag.current);
      selectDrag.marquee.remove();
      selectDrag = null;
      if (!wasMoved) {
        setOrchSelection('');
        rerenderOrchPreview();
        return;
      }
      const hostRect = frame.getBoundingClientRect();
      const screenRect = { left: hostRect.left + rect.left, top: hostRect.top + rect.top, right: hostRect.left + rect.right, bottom: hostRect.top + rect.bottom };
      const hits = [...frame.querySelectorAll('.orch-graph-node')]
        .filter(nodeEl => orchRectsIntersect(screenRect, nodeEl.getBoundingClientRect()))
        .map(nodeEl => nodeEl.dataset.orchPath)
        .filter(Boolean);
      setOrchSelection(hits);
      rerenderOrchPreview();
    };
    frame.addEventListener('pointerup', finishPan);
    frame.addEventListener('pointercancel', finishPan);
    frame.addEventListener('pointerup', finishRightPan);
    frame.addEventListener('pointercancel', finishRightPan);
    frame.addEventListener('pointerup', finishSelectDrag);
    frame.addEventListener('pointercancel', finishSelectDrag);
    frame.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = frame.getBoundingClientRect();
      zoomOrchGraph(frame, event.deltaY < 0 ? 1.12 : 1 / 1.12, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    }, { passive: false });
    frame.addEventListener('contextmenu', (event) => {
      if (shouldSuppressOrchContextMenu(event)) return;
      if (event.target.closest('.orch-graph-node') || event.target.closest('.orch-graph-tools') || orchTransitionTarget(event.target)) return;
      event.preventDefault();
      const hostRect = contentEl.querySelector('.orch-preview')?.getBoundingClientRect() || contentEl.getBoundingClientRect();
      showOrchContextMenu({ x: event.clientX - hostRect.left, y: event.clientY - hostRect.top, readwrite, frame, doc: graphDoc, baseFilePath: graphBaseFilePath });
    });
  });
  contentEl.querySelectorAll('.orch-transition-handle').forEach(handleEl => {
    let drag = null;
    handleEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !readwrite) return;
      event.preventDefault();
      event.stopPropagation();
      const frame = handleEl.closest('[data-orch-frame]');
      const edgeId = handleEl.dataset.orchEdge;
      const pathEl = frame?.querySelector(`.orch-transition[data-orch-edge="${CSS.escape(edgeId || '')}"]`);
      if (!frame || !pathEl) return;
      drag = { pointerId: event.pointerId, frame, edgeId, pathEl };
      setTempSnap(event.ctrlKey || event.metaKey);
      setOrchPointerCapture(handleEl, event.pointerId);
    });
    handleEl.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const forceSnap = event.ctrlKey || event.metaKey;
      setTempSnap(forceSnap);
      const graphPoint = snapOrchPoint(orchFramePointToGraph(orchFramePoint(drag.frame, event)), forceSnap);
      const nodePositions = orchNodePositionsInFrame(drag.frame);
      const source = nodePositions.get(drag.pathEl.dataset.source);
      const target = nodePositions.get(drag.pathEl.dataset.target);
      if (!source || !target) return;
      drag.graphPoint = graphPoint;
      const d = orchEdgePathWithPoint(source, target, orchTransitionMeta(drag.edgeId).style, graphPoint);
      drag.pathEl.setAttribute('d', d);
      drag.pathEl.previousElementSibling?.setAttribute('d', d);
      handleEl.setAttribute('cx', String(Math.round(graphPoint.x)));
      handleEl.setAttribute('cy', String(Math.round(graphPoint.y)));
    });
    const finishTransitionDrag = (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const graphPoint = drag.graphPoint || snapOrchPoint(orchFramePointToGraph(orchFramePoint(drag.frame, event)), event.ctrlKey || event.metaKey);
      releaseOrchPointerCapture(handleEl, event.pointerId);
      setTempSnap(false);
      setOrchTransitionMeta(drag.edgeId, { ...orchTransitionMeta(drag.edgeId), points: [{ x: Math.round(graphPoint.x), y: Math.round(graphPoint.y) }] });
      drag = null;
      rerenderOrchPreview();
    };
    handleEl.addEventListener('pointerup', finishTransitionDrag);
    handleEl.addEventListener('pointercancel', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      releaseOrchPointerCapture(handleEl, event.pointerId);
      drag = null;
      setTempSnap(false);
    });
  });
  contentEl.querySelectorAll('[data-orch-edit]').forEach(control => {
    control.addEventListener('change', () => {
      const field = control.dataset.orchEdit;
      const path = control.dataset.orchPath;
      applyOrchTreeMutation((draft) => {
        const node = orchValueAtPath(draft, path);
        if (!node || typeof node !== 'object') return;
        const previousId = node.id;
        setOrchNodeEditField(node, field, control.value);
        if (field === 'id' && previousId && previousId !== node.id) {
          const graph = ensureOrchGraphDoc(draft);
          if (graph.start === previousId) graph.start = node.id;
          graph.transitions.forEach(transition => {
            if (transition.from === previousId) transition.from = node.id;
            if (transition.to === previousId) transition.to = node.id;
          });
        }
        if (field === 'type') applyOrchTypeDefaults(node, control.value);
      });
    });
  });
  contentEl.querySelectorAll('.orch-graph-node').forEach(nodeEl => {
    let drag = null;
    nodeEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || orchGraphTool === 'hand') return;
      if (event.detail >= 2 && hasOrchNodeOpenTarget(nodeEl.dataset.orchPath, graphDoc, graphBaseFilePath)) {
        event.preventDefault();
        event.stopPropagation();
        openOrchNodeTarget(nodeEl.dataset.orchPath, graphDoc, graphBaseFilePath);
        return;
      }
      event.stopPropagation();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: parseFloat(nodeEl.style.left) || 0,
        startTop: parseFloat(nodeEl.style.top) || 0,
        moved: false,
      };
      setOrchPointerCapture(nodeEl, event.pointerId);
      if (readwrite) setTempSnap(event.ctrlKey || event.metaKey);
      if (readwrite) nodeEl.classList.add('dragging');
    });
    nodeEl.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId || !readwrite) return;
      const dx = (event.clientX - drag.startX) / orchGraphViewport.scale;
      const dy = (event.clientY - drag.startY) / orchGraphViewport.scale;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      const forceSnap = event.ctrlKey || event.metaKey;
      setTempSnap(forceSnap);
      const next = snapOrchPoint({ x: drag.startLeft + dx, y: drag.startTop + dy }, forceSnap);
      nodeEl.style.left = `${next.x}px`;
      nodeEl.style.top = `${next.y}px`;
      const frame = nodeEl.closest('[data-orch-frame]');
      if (frame) updateOrchGraphEdges(frame);
    });
    const finishNodeDrag = (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      releaseOrchPointerCapture(nodeEl, event.pointerId);
      nodeEl.classList.remove('dragging');
      setTempSnap(false);
      const path = nodeEl.dataset.orchPath;
      const moved = drag.moved;
      const x = parseFloat(nodeEl.style.left) || 0;
      const y = parseFloat(nodeEl.style.top) || 0;
      drag = null;
      if (readwrite && moved) {
        setOrchSelection(path);
        setOrchMetaNodePosition(path, x, y);
      } else if (!moved && hasOrchNodeOpenTarget(path, graphDoc, graphBaseFilePath) && event.detail >= 2) {
        if (orchNodeClickTimer) clearTimeout(orchNodeClickTimer);
        orchNodeClickTimer = 0;
        openOrchNodeTarget(path, graphDoc, graphBaseFilePath);
        return;
      } else if (!moved && hasOrchNodeOpenTarget(path, graphDoc, graphBaseFilePath) && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (orchNodeClickTimer) clearTimeout(orchNodeClickTimer);
        orchNodeClickTimer = window.setTimeout(() => {
          setOrchSelection(path);
          rerenderOrchPreview();
          orchNodeClickTimer = 0;
        }, 220);
        return;
      } else if (event.ctrlKey || event.metaKey || event.shiftKey) toggleOrchSelection(path);
      else {
        if (isOnlyOrchNodeSelected(path)) return;
        setOrchSelection(path);
      }
      rerenderOrchPreview();
    };
    nodeEl.addEventListener('pointerup', finishNodeDrag);
    nodeEl.addEventListener('pointercancel', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      releaseOrchPointerCapture(nodeEl, event.pointerId);
      nodeEl.classList.remove('dragging');
      drag = null;
      setTempSnap(false);
    });
    nodeEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      setOrchSelection(nodeEl.dataset.orchPath);
      rerenderOrchPreview();
    });
    nodeEl.addEventListener('click', (event) => {
      if (orchGraphTool === 'hand') return;
      event.preventDefault();
      event.stopPropagation();
      const path = nodeEl.dataset.orchPath;
      if (event.detail >= 2 && hasOrchNodeOpenTarget(path, graphDoc, graphBaseFilePath)) {
        if (orchNodeClickTimer) clearTimeout(orchNodeClickTimer);
        orchNodeClickTimer = 0;
        openOrchNodeTarget(path, graphDoc, graphBaseFilePath);
        return;
      }
      if (hasOrchNodeOpenTarget(path, graphDoc, graphBaseFilePath) && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (isOnlyOrchNodeSelected(path)) return;
        if (orchNodeClickTimer) clearTimeout(orchNodeClickTimer);
        orchNodeClickTimer = window.setTimeout(() => {
          setOrchSelection(path);
          rerenderOrchPreview();
          orchNodeClickTimer = 0;
        }, 220);
        return;
      }
      if (event.ctrlKey || event.metaKey || event.shiftKey) toggleOrchSelection(path);
      else {
        if (isOnlyOrchNodeSelected(path)) return;
        setOrchSelection(path);
      }
      rerenderOrchPreview();
    });
    nodeEl.addEventListener('dblclick', (event) => {
      if (orchGraphTool === 'hand') return;
      const path = nodeEl.dataset.orchPath;
      if (!hasOrchNodeOpenTarget(path, graphDoc, graphBaseFilePath)) return;
      event.preventDefault();
      event.stopPropagation();
      if (orchNodeClickTimer) clearTimeout(orchNodeClickTimer);
      orchNodeClickTimer = 0;
      openOrchNodeTarget(path, graphDoc, graphBaseFilePath);
    });
    nodeEl.addEventListener('contextmenu', (event) => {
      if (shouldSuppressOrchContextMenu(event)) return;
      event.preventDefault();
      const path = nodeEl.dataset.orchPath;
      const keepSourceSelection = readwrite && getActiveTab()?.viewType === 'orch-graph' && selectedOrchNodePath && selectedOrchNodePath !== path;
      if (!keepSourceSelection && !isOrchNodeSelected(path)) setOrchSelection(path);
      const hostRect = contentEl.querySelector('.orch-preview')?.getBoundingClientRect() || contentEl.getBoundingClientRect();
      showOrchContextMenu({ x: event.clientX - hostRect.left, y: event.clientY - hostRect.top, path, readwrite, frame: nodeEl.closest('[data-orch-frame]'), doc: graphDoc, baseFilePath: graphBaseFilePath });
    });
  });
  contentEl.querySelectorAll('[data-orch-action]').forEach(button => {
    button.addEventListener('click', () => {
      const action = button.dataset.orchAction;
      const path = button.dataset.orchPath;
      const edgeId = button.dataset.orchEdge || selectedOrchEdgeId;
      if (action === 'fit') { fitOrchGraphToFrame(); return; }
      if (action === 'snap-toggle') { orchGridSnapEnabled = !orchGridSnapEnabled; updateOrchViewportDom(); return; }
      if (action === 'open-subtree' || action === 'open-file') { runOrchContextAction(action, path, contentEl.querySelector('[data-orch-frame]'), edgeId, graphDoc, graphBaseFilePath); return; }
      if (action === 'transition-curve' || action === 'transition-straight' || action === 'delete-transition') {
        runOrchContextAction(action, path, contentEl.querySelector('[data-orch-frame]'), edgeId, graphDoc, graphBaseFilePath);
        return;
      }
      if (action === 'auto-layout') { resetOrchGraphLayout(); return; }
      applyOrchTreeMutation((draft) => {
        if (action === 'add-child') addOrchLinkedNode(draft, path, isOrchGraphStateLayer() ? 'orpad.context' : 'Context');
        else if (action === 'delete-node') deleteOrchNodeAtPath(draft, path);
      });
    });
  });
  document.addEventListener('click', closeOrchContextMenu, { once: true, capture: true });
  updateOrchViewportDom();
  if (orchGraphFitAfterRender) {
    orchGraphFitAfterRender = false;
    requestAnimationFrame(() => fitOrchGraphToFrame());
  }
}

function renderOrchPipelinePreview(content) {
  contentEl.innerHTML = '';
  let doc;
  try {
    doc = JSON.parse(content);
  } catch (err) {
    contentEl.innerHTML = '<div class="preview-error">Invalid OrPAD pipeline: ' + escapeHtml(err.message || String(err)) + '</div>';
    return;
  }
  const pipelineContext = pipelineContextForPath();
  const pipelineRunInProgress = isPipelineMachineRunInProgress(pipelineContext?.pipelinePath);
  if (pipelineRunInProgress && orchTreeGraphMode === 'readwrite') orchTreeGraphMode = 'readonly';
  const readwrite = orchTreeGraphMode === 'readwrite' && !pipelineRunInProgress;
  const editLockTitle = pipelineRunInProgress ? 'Run in progress; editing is locked.' : 'Edit';
  const graphRefs = pipelineRefEntries(doc, 'graphs').entries;
  const treeRefs = pipelineRefEntries(doc, 'trees').entries;
  const skillRefs = pipelineRefEntries(doc, 'skills').entries;
  const ruleRefs = pipelineRefEntries(doc, 'rules').entries;
  const entryGraph = doc.entryGraph || doc.entry?.graph || doc.graph?.file || graphRefs[0]?.file || '';
  const entryGraphPath = pipelineEditorGraphPathFromDoc(doc, pipelineContext);
  const diagnostics = pipelineValidationDiagnostics(selectedPipelineValidation(pipelineContext?.pipelinePath));
  const externalResearchLimitation = doc.metadata?.externalResearch?.limitation || doc.run?.externalResearchLimitation || '';
  contentEl.innerHTML = `
    <div class="orch-preview">
      <div class="orch-toolbar">
        <strong>Pipeline setup</strong>
        <div class="orch-toolbar-actions">
          <span class="runbook-chip">Details</span>
          <span class="runbook-chip good">${escapeHtml(doc.trustLevel || 'local-authored')}</span>
          <span class="runbook-chip">${escapeHtml(doc.version || 'unversioned')}</span>
          <div class="jedit-seg">
            <button class="jedit-seg-btn ${readwrite ? '' : 'active'}" data-pipeline-mode="readonly">View</button>
            <button class="jedit-seg-btn ${readwrite ? 'active' : ''}" data-pipeline-mode="readwrite" title="${escapeHtml(editLockTitle)}" ${pipelineRunInProgress ? 'disabled' : ''}>Edit</button>
          </div>
        </div>
      </div>
      ${renderPipelinePreviewRunBar(pipelineContext, doc)}
      ${externalResearchLimitation ? `<div class="runbook-diagnostic warning">${escapeHtml(externalResearchLimitation)}</div>` : ''}
      ${renderPipelineEditorTabs(pipelineContext, 'manifest', entryGraphPath)}
      <div class="orch-graph-layout">
        <div class="orch-graph-main">
          <section class="runbook-panel-section">
            <header class="pipeline-section-header">
              <div>
                <h3>${escapeHtml(doc.title || doc.id || 'OrPAD Pipeline')}</h3>
                <p>${escapeHtml(doc.description || 'Pipeline package for an OrPAD orchestration run.')}</p>
              </div>
              ${entryGraphPath ? `<button class="primary" data-pipeline-editor-target="${escapeHtml(entryGraphPath)}">Open Flow</button>` : ''}
            </header>
            <div class="runbook-chip-row">
              <span class="runbook-chip">${graphRefs.length || (entryGraph ? 1 : 0)} flows</span>
              <span class="runbook-chip">${treeRefs.length} trees</span>
              <span class="runbook-chip">${skillRefs.length} skills</span>
              <span class="runbook-chip">${ruleRefs.length} rules</span>
              <span class="runbook-chip">${doc.executionPolicy?.mode || 'no execution policy'}</span>
              ${doc.maintenancePolicy?.repeatable ? '<span class="runbook-chip good">repeatable maintenance</span>' : ''}
            </div>
          </section>
          <section class="runbook-panel-section">
            <header class="pipeline-section-header">
              <div>
                <h3>Pipeline Details</h3>
                <p>Core identity, trust, schema, and entry flow settings.</p>
              </div>
            </header>
            <div class="pipeline-field-grid">
              ${renderPipelineField({ key: '$schema', label: 'Schema' }, doc.$schema || '', readwrite)}
              ${renderPipelineField({ key: 'kind', label: 'Kind' }, doc.kind || 'orpad.pipeline', readwrite)}
              ${renderPipelineField({ key: 'version', label: 'Version' }, doc.version || '1.0', readwrite)}
              ${renderPipelineField({ key: 'trustLevel', label: 'Trust', options: ORCH_PIPELINE_TRUST_LEVELS }, doc.trustLevel || 'local-authored', readwrite)}
              ${renderPipelineField({ key: 'id', label: 'ID' }, doc.id || '', readwrite)}
              ${renderPipelineField({ key: 'title', label: 'Title' }, doc.title || '', readwrite)}
              ${renderPipelineEntryField(entryGraph, readwrite, diagnostics)}
              ${renderPipelineField({ key: 'description', label: 'Description', multiline: true }, doc.description || '', readwrite)}
            </div>
          </section>
          ${ORCH_PIPELINE_REF_SECTIONS.map(section => renderPipelineRefSection(doc, section, readwrite, diagnostics)).join('')}
          ${renderPipelineJsonSection(doc, 'nodePacks', 'Node Packs', 'Built-in and custom node packs required by this pipeline.', readwrite)}
          ${renderPipelineJsonSection(doc, 'run', 'Run Contract', 'Evidence storage, work-state protocol, coverage policy, and auditable latest run/cycle evidence.', readwrite)}
          ${renderPipelineJsonSection(doc, 'maintenancePolicy', 'Maintenance Cycle Policy', 'Repeatability, cadence, triggers, backlog carry-over, and latest-run cycle semantics.', readwrite)}
          ${renderPipelineExecutionPolicy(doc, readwrite)}
          ${renderPipelineJsonSection(doc, 'metadata', 'Reference Metadata', 'Reference families, source dates, and maintenance lenses used by path-launched agents.', readwrite)}
        </div>
        <aside class="orch-inspector">
          <h3>Package</h3>
          <dl>
            <dt>Pipeline key</dt><dd>${escapeHtml(doc.id || '')}</dd>
            <dt>Kind</dt><dd>${escapeHtml(doc.kind || 'orpad.pipeline')}</dd>
            <dt>Entry</dt><dd>${escapeHtml(entryGraph ? pipelineDisplayTitle(entryGraph, 'Entry flow') : 'not set')}</dd>
            <dt>Harness</dt><dd>${escapeHtml(doc.harness?.path || 'harness/generated')}</dd>
            <dt>Cycle</dt><dd>${escapeHtml(doc.maintenancePolicy?.repeatable ? 'repeatable' : 'single run')}</dd>
            <dt>Prompt</dt><dd>${escapeHtml(doc.executionPolicy?.promptRole || 'launch-only')}</dd>
          </dl>
          <h3>Harness</h3>
          ${readwrite ? `
            <label><span>Path</span><input data-pipeline-harness-field="path" value="${escapeHtml(doc.harness?.path || 'harness/generated')}"></label>
            <label><span>Description</span><input data-pipeline-harness-field="description" value="${escapeHtml(doc.harness?.description || '')}"></label>
          ` : ''}
          <h3>Additional</h3>
          ${renderPipelineAdditionalProperties(doc, readwrite)}
        </aside>
      </div>
    </div>
  `;
  bindOrchPipelineEditorInteractions(readwrite, pipelineContext);
}

function bindOrchPipelineEditorInteractions(readwrite, pipelineContext = pipelineContextForPath()) {
  contentEl.querySelectorAll('[data-pipeline-mode]').forEach(button => {
    button.addEventListener('click', () => {
      if (button.dataset.pipelineMode === 'readwrite' && isPipelineMachineRunInProgress(pipelineContext?.pipelinePath)) {
        orchTreeGraphMode = 'readonly';
        invalidateRenderCache();
        renderOrchPipelinePreview(editor.state.doc.toString());
        return;
      }
      orchTreeGraphMode = button.dataset.pipelineMode;
      invalidateRenderCache();
      renderOrchPipelinePreview(editor.state.doc.toString());
    });
  });
  bindPipelineEditorTabs();

  contentEl.querySelectorAll('[data-pipeline-open-ref]').forEach(button => {
    button.addEventListener('click', async (event) => {
      const ref = event.currentTarget?.dataset?.pipelineOpenRef || '';
      const target = resolveRunbookFileRef(ref);
      if (target?.filePath) await openFileFromQuickOpen(target.filePath, { symbol: target.anchor });
    });
  });

  if (!readwrite) return;

  contentEl.querySelectorAll('[data-pipeline-field]').forEach(control => {
    control.addEventListener('change', () => {
      const key = control.dataset.pipelineField;
      applyOrchPipelineMutation((doc) => {
        setPipelineOptionalString(doc, key, control.value);
      });
    });
  });

  contentEl.querySelectorAll('[data-pipeline-harness-field]').forEach(control => {
    control.addEventListener('change', () => {
      const key = control.dataset.pipelineHarnessField;
      applyOrchPipelineMutation((doc) => {
        const harness = ensurePipelineHarness(doc);
        const value = pipelineValueText(control.value);
        if (value) harness[key] = value;
        else delete harness[key];
      });
    });
  });

  contentEl.querySelectorAll('[data-pipeline-ref-edit]').forEach(control => {
    control.addEventListener('change', () => {
      const key = control.dataset.pipelineRefEdit;
      const index = Number(control.dataset.refIndex);
      const field = control.dataset.refField;
      applyOrchPipelineMutation((doc) => {
        const state = pipelineRefEntries(doc, key);
        if (!state.entries[index]) return;
        state.entries[index][field] = pipelineValueText(control.value);
        setPipelineRefEntries(doc, key, state.entries, state.shape);
      });
    });
  });

  contentEl.querySelectorAll('[data-pipeline-ref-add]').forEach(button => {
    button.addEventListener('click', () => {
      const key = button.dataset.pipelineRefAdd;
      const section = ORCH_PIPELINE_REF_SECTIONS.find(item => item.key === key);
      applyOrchPipelineMutation((doc) => {
        const state = pipelineRefEntries(doc, key);
        state.entries.push({
          id: section?.defaultId || `${key}-${state.entries.length + 1}`,
          file: section?.defaultFile || `${key}/new-file`,
          description: '',
        });
        setPipelineRefEntries(doc, key, state.entries, state.shape);
      });
    });
  });

  contentEl.querySelectorAll('[data-pipeline-ref-remove]').forEach(button => {
    button.addEventListener('click', () => {
      const key = button.dataset.pipelineRefRemove;
      const index = Number(button.dataset.refIndex);
      applyOrchPipelineMutation((doc) => {
        const state = pipelineRefEntries(doc, key);
        state.entries.splice(index, 1);
        setPipelineRefEntries(doc, key, state.entries, state.shape);
      });
    });
  });

  contentEl.querySelectorAll('[data-pipeline-policy-field]').forEach(control => {
    control.addEventListener('change', () => {
      const key = control.dataset.pipelinePolicyField;
      applyOrchPipelineMutation((doc) => {
        const policy = ensurePipelineExecutionPolicy(doc);
        const value = pipelineValueText(control.value);
        if (value) policy[key] = value;
        else delete policy[key];
      });
    });
  });

  contentEl.querySelectorAll('[data-pipeline-policy-list]').forEach(control => {
    control.addEventListener('change', () => {
      const key = control.dataset.pipelinePolicyList;
      const index = Number(control.dataset.policyIndex);
      applyOrchPipelineMutation((doc) => {
        const policy = ensurePipelineExecutionPolicy(doc);
        const list = pipelinePolicyList(policy, key);
        list[index] = pipelineValueText(control.value);
        policy[key] = list.filter(Boolean);
      });
    });
  });

  contentEl.querySelectorAll('[data-pipeline-policy-add]').forEach(button => {
    button.addEventListener('click', () => {
      const key = button.dataset.pipelinePolicyAdd;
      applyOrchPipelineMutation((doc) => {
        const policy = ensurePipelineExecutionPolicy(doc);
        const list = pipelinePolicyList(policy, key);
        list.push(key === 'doneCriteria' ? 'required evidence updated' : 'approval-required');
        policy[key] = list;
      });
    });
  });

  contentEl.querySelectorAll('[data-pipeline-policy-remove]').forEach(button => {
    button.addEventListener('click', () => {
      const key = button.dataset.pipelinePolicyRemove;
      const index = Number(button.dataset.policyIndex);
      applyOrchPipelineMutation((doc) => {
        const policy = ensurePipelineExecutionPolicy(doc);
        const list = pipelinePolicyList(policy, key);
        list.splice(index, 1);
        policy[key] = list;
      });
    });
  });

  contentEl.querySelectorAll('[data-pipeline-json-section]').forEach(control => {
    control.addEventListener('change', () => {
      const key = control.dataset.pipelineJsonSection;
      const parsed = parsePipelineExtraValue(control.value || 'null');
      if (!parsed.ok) return;
      applyOrchPipelineMutation((doc) => {
        if (parsed.value === null || parsed.value === undefined) delete doc[key];
        else doc[key] = parsed.value;
      });
    });
  });

  contentEl.querySelectorAll('[data-pipeline-extra-key]').forEach(control => {
    control.addEventListener('change', () => {
      const index = Number(control.dataset.pipelineExtraKey);
      const nextKey = pipelineValueText(control.value).trim();
      if (!nextKey || ORCH_PIPELINE_KNOWN_KEYS.has(nextKey)) return;
      applyOrchPipelineMutation((doc) => {
        const keys = pipelineAdditionalKeys(doc);
        const previousKey = keys[index];
        if (!previousKey || previousKey === nextKey) return;
        if (Object.prototype.hasOwnProperty.call(doc, nextKey)) return;
        doc[nextKey] = doc[previousKey];
        delete doc[previousKey];
      });
    });
  });

  contentEl.querySelectorAll('[data-pipeline-extra-value]').forEach(control => {
    control.addEventListener('change', () => {
      const index = Number(control.dataset.pipelineExtraValue);
      const parsed = parsePipelineExtraValue(control.value);
      if (!parsed.ok) return;
      applyOrchPipelineMutation((doc) => {
        const key = pipelineAdditionalKeys(doc)[index];
        if (!key) return;
        doc[key] = parsed.value;
      });
    });
  });

  contentEl.querySelectorAll('[data-pipeline-extra-remove]').forEach(button => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.pipelineExtraRemove);
      applyOrchPipelineMutation((doc) => {
        const key = pipelineAdditionalKeys(doc)[index];
        if (key) delete doc[key];
      });
    });
  });

  contentEl.querySelectorAll('[data-pipeline-extra-add]').forEach(button => {
    button.addEventListener('click', () => {
      applyOrchPipelineMutation((doc) => {
        doc[uniquePipelineExtraKey(doc)] = {};
      });
    });
  });
}

function renderOrchGraphPreview(content) {
  contentEl.innerHTML = '';
  let doc;
  try {
    doc = JSON.parse(content);
  } catch (err) {
    contentEl.innerHTML = '<div class="preview-error">Invalid flow JSON: ' + escapeHtml(err.message || String(err)) + '</div>';
    return;
  }
  const pipelineContext = pipelineContextForPath();
  const pipelineRunInProgress = isPipelineMachineRunInProgress(pipelineContext?.pipelinePath);
  if (pipelineRunInProgress && orchTreeGraphMode === 'readwrite') orchTreeGraphMode = 'readonly';
  const readwrite = orchTreeGraphMode === 'readwrite' && !pipelineRunInProgress;
  const editLockTitle = pipelineRunInProgress ? 'Run in progress; editing is locked.' : 'Edit';
  normalizeOrchGraphLayerStack(doc);
  const layerPath = activeOrchGraphLayerPath();
  const layerEntry = activeOrchGraphLayerEntry();
  const layerNode = layerPath ? orchValueAtPath(doc, layerPath) : null;
  const linkedLayer = layerPath && !layerNode?.tree?.root ? layerEntry : null;
  if (linkedLayer) ensureExternalOrchGraphLayerLoaded(linkedLayer, layerPath, doc);
  const linkedTreeEntry = linkedLayer?.treeEntry || null;
  const linkedGraphLayer = linkedLayer?.layerKind === 'graph' && linkedLayer?.doc ? linkedLayer : null;
  const graphDoc = linkedTreeEntry || linkedGraphLayer ? linkedLayer.doc : doc;
  const graphBaseFilePath = linkedTreeEntry || linkedGraphLayer ? linkedLayer.filePath : getActiveTab()?.filePath;
  const graph = layerNode?.tree?.root
    ? collectOrchGraph(layerNode.tree, 0, `${layerPath}.tree.root`)
    : linkedTreeEntry
      ? collectOrchGraph(linkedTreeEntry.tree, linkedTreeEntry.index || 0, linkedTreeEntry.rootPath || 'root')
      : linkedGraphLayer
        ? collectOrchStateGraph(linkedGraphLayer.doc)
      : layerPath
        ? { nodes: [], edges: [] }
        : collectOrchStateGraph(doc);
  const effectiveReadwrite = readwrite && !linkedLayer;
  if (!selectedOrchEdgeId || !graph.edges.some(edge => edge.id === selectedOrchEdgeId)) {
    selectedOrchEdgeId = '';
    normalizeOrchSelection(graphDoc, graph.nodes[0]?.path || '');
  }
  const runProjection = machineRuntimeProjectionForGraph(pipelineContext, graphDoc);
  const graphBody = graph.nodes.length
    ? renderOrchGraphCanvas(graph, effectiveReadwrite, true, runProjection)
    : linkedLayer?.loading
      ? '<div class="runbook-empty">Loading linked OrPAD layer...</div>'
      : linkedLayer?.error
        ? `<div class="preview-error">Linked OrPAD layer could not be loaded: ${escapeHtml(linkedLayer.error)}</div>`
        : '<div class="runbook-empty">No flow steps found.</div>';
  const layerKindLabel = linkedGraphLayer ? 'Flow layer' : layerPath ? 'Tree layer' : 'Main flow';
  const layerSourceLabel = linkedGraphLayer ? 'Linked file' : linkedLayer ? 'Linked tree file' : layerPath ? 'Embedded flow' : 'Flow steps';
  contentEl.innerHTML = `
    <div class="orch-preview">
      <div class="orch-toolbar">
        <strong>${pipelineContext ? 'Pipeline setup' : (linkedGraphLayer || !layerPath ? 'Flow setup' : 'Tree setup')}</strong>
        <div class="orch-toolbar-actions">
          ${pipelineContext ? `<span class="runbook-chip">Flow</span>` : ''}
          <span class="runbook-chip good">${layerKindLabel}</span>
          <span class="runbook-chip">${layerSourceLabel}</span>
          <div class="jedit-seg">
            <button class="jedit-seg-btn ${effectiveReadwrite ? '' : 'active'}" data-orch-mode="readonly">View</button>
            <button class="jedit-seg-btn ${effectiveReadwrite ? 'active' : ''}" data-orch-mode="readwrite" title="${escapeHtml(editLockTitle)}" ${pipelineRunInProgress ? 'disabled' : ''}>Edit</button>
          </div>
        </div>
      </div>
      ${renderPipelinePreviewRunBar(pipelineContext)}
      ${renderPipelineEditorTabs(pipelineContext, 'graph', getActiveTab()?.filePath || '')}
      ${renderOrchGraphLayerBar(doc)}
      <div class="orch-graph-layout orch-graph-layout-internal-inspector">
        <div class="orch-graph-main">
          ${graphBody}
          <div class="orch-floating-inspector">${renderOrchInspector(graphDoc, effectiveReadwrite, graphBaseFilePath)}</div>
        </div>
      </div>
    </div>
  `;
  bindPipelineEditorTabs();
  bindOrchGraphEditorInteractions(effectiveReadwrite, graphDoc, graphBaseFilePath, pipelineContext);
}

// Line-level LCS diff. Returns array of ops: {op: 'equal'|'del'|'add', a?, b?}.
function lcsLineDiff(a, b) {
  const n = a.length, m = b.length;
  // Large inputs: skip alignment, just mark each side distinctly.
  // 250_000 - 500 - 00 lines - above this the O(n-m) DP freezes the UI.
  if (n * m > 250_000) {
    const out = [];
    for (const l of a) out.push({ op: 'del', a: l });
    for (const l of b) out.push({ op: 'add', b: l });
    return out;
  }
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { out.unshift({ op: 'equal', a: a[i - 1], b: b[j - 1] }); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { out.unshift({ op: 'del', a: a[i - 1] }); i--; }
    else { out.unshift({ op: 'add', b: b[j - 1] }); j--; }
  }
  while (i > 0) { out.unshift({ op: 'del', a: a[i - 1] }); i--; }
  while (j > 0) { out.unshift({ op: 'add', b: b[j - 1] }); j--; }
  return out;
}

function tryPrettyJSON(text) {
  const trimmed = text.trim();
  if (!trimmed) return text;
  try { return JSON.stringify(JSON.parse(trimmed), null, 2); }
  catch { return text; }
}

function renderJSONDiffPreview(content) {
  contentEl.innerHTML = '';
  const panel = document.createElement('div');
  panel.className = 'json-diff-panel';
  panel.innerHTML = `
    <div class="json-diff-header">
      <span class="json-diff-title">${escapeHtml(t('diff.panelTitle'))}</span>
      <span class="json-diff-stats" aria-live="polite"></span>
      <span class="json-diff-spacer"></span>
      <label class="json-diff-toggle" title="${escapeHtml(t('diff.prettyToggle'))}">
        <input type="checkbox" class="json-diff-pretty" checked />
        <span>${escapeHtml(t('diff.prettyLabel'))}</span>
      </label>
      <button class="json-diff-btn json-diff-clear">${escapeHtml(t('diff.clear'))}</button>
      <button class="json-diff-btn json-diff-close" title="${escapeHtml(t('modal.close'))}">&times;</button>
    </div>
    <div class="json-diff-sbs">
      <div class="diff-pane diff-left">
        <div class="diff-pane-label">${escapeHtml(t('diff.currentLabel'))}</div>
        <div class="diff-pane-body">
          <div class="diff-bg" data-side="left"></div>
          <textarea class="diff-text" wrap="off" spellcheck="false"></textarea>
        </div>
      </div>
      <div class="diff-pane diff-right">
        <div class="diff-pane-label">${escapeHtml(t('diff.targetLabel'))}</div>
        <div class="diff-pane-body">
          <div class="diff-bg" data-side="right"></div>
          <textarea class="diff-text" wrap="off" spellcheck="false" placeholder="${escapeHtml(t('diff.placeholder'))}"></textarea>
        </div>
      </div>
    </div>
  `;
  contentEl.appendChild(panel);

  const leftTa  = panel.querySelector('.diff-left textarea');
  const rightTa = panel.querySelector('.diff-right textarea');
  const leftBg  = panel.querySelector('.diff-left .diff-bg');
  const rightBg = panel.querySelector('.diff-right .diff-bg');
  const statsEl = panel.querySelector('.json-diff-stats');
  const prettyCb = panel.querySelector('.json-diff-pretty');

  const savedPretty = localStorage.getItem('orpad-diff-pretty');
  if (savedPretty !== null) prettyCb.checked = savedPretty === 'true';

  rightTa.value = localStorage.getItem('orpad-diff-other') || '';

  function renderSideBg(bg, side, lines, ops) {
    // Per-side: each of its lines gets a diff-line div with coloring.
    // Walk ops; for 'left' include equal+del only (skip add). For 'right' include equal+add only (skip del).
    const cls = new Array(lines.length);
    let idx = 0;
    for (const op of ops) {
      if (side === 'left') {
        if (op.op === 'equal')    { cls[idx++] = ''; }
        else if (op.op === 'del') { cls[idx++] = 'diff-del'; }
      } else {
        if (op.op === 'equal')    { cls[idx++] = ''; }
        else if (op.op === 'add') { cls[idx++] = 'diff-add'; }
      }
    }
    // Reconcile existing children instead of full rebuild - saves N node allocations per recompute.
    const want = lines.length;
    for (let i = 0; i < want; i++) {
      const desiredClass = 'diff-line' + (cls[i] ? ' ' + cls[i] : '');
      // Render text or nbsp placeholder so the div has height even when empty
      const desiredText = lines[i] === '' ? '\u00a0' : lines[i];
      let div = bg.children[i];
      if (!div) {
        div = document.createElement('div');
        div.className = desiredClass;
        div.textContent = desiredText;
        bg.appendChild(div);
      } else {
        if (div.className !== desiredClass) div.className = desiredClass;
        if (div.textContent !== desiredText) div.textContent = desiredText;
      }
    }
    while (bg.children.length > want) bg.removeChild(bg.lastChild);
  }

  function recompute() {
    const editorText = editor.state.doc.toString();
    const leftRaw = leftTa.value;
    const rightRaw = rightTa.value;
    localStorage.setItem('orpad-diff-other', rightRaw);
    localStorage.setItem('orpad-diff-pretty', String(prettyCb.checked));
    // Left: show editor content. Don't overwrite if user is actively editing the left textarea.
    if (document.activeElement !== leftTa) {
      leftTa.value = prettyCb.checked ? tryPrettyJSON(editorText) : editorText;
    }
    // Right: auto pretty when not focused
    const rightText = prettyCb.checked ? tryPrettyJSON(rightRaw) : rightRaw;
    if (prettyCb.checked && rightText !== rightRaw && document.activeElement !== rightTa) {
      rightTa.value = rightText;
    }
    const aLines = leftTa.value.split('\n');
    const bLines = rightTa.value.split('\n');
    const ops = lcsLineDiff(aLines, bLines);
    renderSideBg(leftBg,  'left',  aLines, ops);
    renderSideBg(rightBg, 'right', bLines, ops);
    let adds = 0, dels = 0;
    for (const op of ops) { if (op.op === 'add') adds++; else if (op.op === 'del') dels++; }
    if (!rightRaw.trim() && !leftRaw.trim()) statsEl.textContent = t('diff.empty');
    else if (adds === 0 && dels === 0) statsEl.textContent = t('diff.noDiff');
    else statsEl.textContent = `+${adds} / -${dels}`;
    syncScrollNow();
  }

  // Diff recompute is debounced - unthrottled was the primary bottleneck the user felt.
  let recomputeTimer = null;
  function scheduleRecompute() {
    if (recomputeTimer) clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(() => { recomputeTimer = null; recompute(); }, 150);
  }

  // Left textarea edits flow back to the CodeMirror doc.
  // The dispatch triggers the debounced renderPreview - currentDiffPanel.recompute() path.
  // Suppress that echo so recompute fires exactly once per keystroke (debounced).
  leftTa.addEventListener('input', () => {
    suppressNextDiffRecompute = true;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: leftTa.value } });
    scheduleRecompute();
  });

  // Scroll sync: textarea - its BG (vertical + horizontal)
  const syncBg = (ta, bg) => { bg.scrollTop = ta.scrollTop; bg.scrollLeft = ta.scrollLeft; };
  // Cross-pane sync: when one textarea scrolls, scroll the other to match
  const crossSync = (src, dst) => {
    if (Math.abs(dst.scrollTop - src.scrollTop) > 1) dst.scrollTop = src.scrollTop;
  };
  let syncing = false;
  leftTa.addEventListener('scroll', () => {
    syncBg(leftTa, leftBg);
    if (syncing) return;
    syncing = true;
    crossSync(leftTa, rightTa);
    syncBg(rightTa, rightBg);
    syncing = false;
  });
  rightTa.addEventListener('scroll', () => {
    syncBg(rightTa, rightBg);
    if (syncing) return;
    syncing = true;
    crossSync(rightTa, leftTa);
    syncBg(leftTa, leftBg);
    syncing = false;
  });
  function syncScrollNow() {
    syncBg(leftTa, leftBg);
    syncBg(rightTa, rightBg);
  }

  rightTa.addEventListener('input', scheduleRecompute);
  prettyCb.addEventListener('change', recompute);

  // Drag-drop files (both sides)
  const stopEvt = (e) => { e.preventDefault(); e.stopPropagation(); };
  const wireDropArea = (ta, onText) => {
    ta.addEventListener('dragenter', (e) => { stopEvt(e); ta.classList.add('dragover'); });
    ta.addEventListener('dragover',  (e) => { stopEvt(e); ta.classList.add('dragover'); });
    ta.addEventListener('dragleave', () => ta.classList.remove('dragover'));
    ta.addEventListener('drop', async (e) => {
      stopEvt(e);
      ta.classList.remove('dragover');
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      try { onText(await file.text()); } catch {}
    });
  };
  wireDropArea(rightTa, (text) => { rightTa.value = text; recompute(); });
  wireDropArea(leftTa,  (text) => {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
    leftTa.value = text;
    recompute();
  });

  panel.querySelector('.json-diff-clear').addEventListener('click', () => {
    // Route the clear through the textarea's native input pipeline so the
    // browser records it in the undo stack. Assigning .value = '' would
    // clear instantly but leave Ctrl+Z unable to bring the text back.
    rightTa.focus();
    if (rightTa.value.length > 0) {
      rightTa.setSelectionRange(0, rightTa.value.length);
      const ok = document.execCommand('insertText', false, '');
      if (!ok || rightTa.value.length > 0) {
        // Fallback: older engines / contentEditable quirks - at least clear.
        rightTa.value = '';
      }
    }
    recompute();
  });
  panel.querySelector('.json-diff-close').addEventListener('click', () => setJsonViewMode('tree'));

  currentDiffPanel = { el: panel, recompute };
  recompute();
}

function parseJsonlLines(text) {
  const lines = text.split(/\r?\n/);
  const objs = [];
  const lineIdx = []; // which source line each object came from
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    try { objs.push(JSON.parse(l)); lineIdx.push(i); } catch { /* skip invalid line */ }
  }
  return { objs, lineIdx };
}
function renderJSONLPreview(content) {
  const { objs } = parseJsonlLines(content);
  if (objs.length === 0) {
    contentEl.innerHTML = '<div class="preview-placeholder">No valid JSONL lines found.</div>';
    return;
  }
  const allPlainObjects = objs.every(x => x && typeof x === 'object' && !Array.isArray(x));
  if (!allPlainObjects) {
    // heterogeneous JSONL - show as JSON array in read-only tree
    mountJSONEditor(JSON.stringify(objs, null, 2), JSON.parse, 'JSONL', { readOnly: true });
    return;
  }
  const keys = [...new Set(objs.flatMap(o => Object.keys(o)))];
  const fmtCell = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  const rows = [keys, ...objs.map(o => keys.map(k => fmtCell(o[k])))];
  const csvText = Papa.unparse(rows);
  contentEl.innerHTML = '';
  currentGrid = new SpreadsheetGrid(contentEl, {
    content: csvText,
    delimiter: ',',
    onChange: (csv) => {
      try {
        const parsed = Papa.parse(csv, { skipEmptyLines: false });
        const rowArr = parsed.data.filter(r => !(r.length === 1 && r[0] === ''));
        if (rowArr.length === 0) return;
        const hdr = rowArr[0];
        const outLines = rowArr.slice(1).map(row => JSON.stringify(rowToObject(hdr, row)));
        skipNextRenderPreview = true;
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: outLines.join('\n') } });
      } catch {}
    },
  });
}
function rowToObject(hdr, row) {
  const obj = {};
  hdr.forEach((h, i) => {
    const v = row[i];
    if (v === undefined || v === '') { obj[h] = ''; return; }
    const s = String(v);
    if (s === 'null') obj[h] = null;
    else if (s === 'true') obj[h] = true;
    else if (s === 'false') obj[h] = false;
    else if (/^-?\d+$/.test(s) && Number.isFinite(+s)) obj[h] = +s;
    else if (/^-?\d*\.\d+$/.test(s) || /^-?\d+\.\d*$/.test(s)) obj[h] = +s;
    else if (/^[{[]/.test(s)) { try { obj[h] = JSON.parse(s); } catch { obj[h] = s; } }
    else obj[h] = s;
  });
  return obj;
}
function renderYAMLPreview(content) { mountJSONEditor(content, (c) => yamljs.load(c), 'YAML', { readOnly: true }); }
function renderTOMLPreview(content) { mountJSONEditor(content, tomlParse, 'TOML', { readOnly: true }); }

// ==================== CSV / TSV table view ====================
function renderDelimitedPreview(content, delimiter, label) {
  contentEl.innerHTML = '';
  try {
    currentGrid = new SpreadsheetGrid(contentEl, {
      content,
      delimiter,
      onChange: (serialized) => {
        skipNextRenderPreview = true;
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: serialized } });
      },
    });
  } catch (err) {
    contentEl.innerHTML = '<div class="preview-error">Invalid ' + label + ': ' + escapeHtml(err.message) + '</div>';
  }
}

// ==================== XML DOM tree view ====================
function buildXMLNode(node, nodeMap) {
  const wrap = document.createElement('div');
  wrap.className = 'xml-node';
  if (node.nodeType !== 1) return wrap; // only elements
  if (nodeMap) nodeMap.set(node, wrap);
  const elements = Array.from(node.children);
  const attrs = Array.from(node.attributes || []).map(a =>
    ' <span class="xml-attr-name">' + escapeHtml(a.name) + '</span>=<span class="xml-attr-value">"' + escapeHtml(a.value) + '"</span>'
  ).join('');
  const text = elements.length === 0 ? (node.textContent || '').trim() : '';

  if (elements.length > 0) {
    const details = document.createElement('details');
    details.open = true;
    const summary = document.createElement('summary');
    summary.innerHTML = '<span class="xml-tag">&lt;' + escapeHtml(node.tagName) + attrs + '&gt;</span>';
    details.appendChild(summary);
    const inner = document.createElement('div');
    inner.className = 'xml-children';
    for (const child of elements) inner.appendChild(buildXMLNode(child, nodeMap));
    details.appendChild(inner);
    wrap.appendChild(details);
  } else {
    const line = document.createElement('div');
    line.className = 'xml-leaf';
    const content = text ? '<span class="xml-text">' + escapeHtml(text) + '</span>' : '';
    line.innerHTML = '<span class="xml-tag">&lt;' + escapeHtml(node.tagName) + attrs + (text ? '&gt;' : '/&gt;') + '</span>' + content + (text ? '<span class="xml-tag">&lt;/' + escapeHtml(node.tagName) + '&gt;</span>' : '');
    wrap.appendChild(line);
  }
  return wrap;
}

function renderXMLPreview(content) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(content, 'application/xml');
  const perr = doc.querySelector('parsererror');
  if (perr) {
    contentEl.innerHTML = '<div class="preview-error">Invalid XML: ' + escapeHtml(perr.textContent || '') + '</div>';
    return;
  }
  contentEl.innerHTML = '';
  const nodeMap = new WeakMap();
  const wrap = document.createElement('div');
  wrap.className = 'xml-tree';
  wrap.appendChild(buildXMLNode(doc.documentElement, nodeMap));
  contentEl.appendChild(wrap);
  contentEl._xmlDoc = doc;
  contentEl._xmlNodeMap = nodeMap;
}

// ==================== .env key-value view ====================
const SENSITIVE_ENV_RE = /(SECRET|TOKEN|KEY|PASSWORD|PASS|API|AUTH|CREDENTIAL|PRIVATE|CERT|SIGNATURE|HASH)/i;

function parseDotenv(content) {
  const parsed = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    const quoted = /^["']/.test(value);
    if (!quoted) {
      const cmt = value.indexOf(' #');
      if (cmt >= 0) value = value.slice(0, cmt);
    }
    value = value.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"');
    }
    parsed[m[1]] = value;
  }
  return parsed;
}

function expandDotenv(parsed) {
  const out = {};
  const resolve = (v) => String(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => parsed[k] !== undefined ? parsed[k] : '');
  for (const [k, v] of Object.entries(parsed)) out[k] = resolve(v);
  return out;
}

function renderEnvPreview(content) {
  const parsed = expandDotenv(parseDotenv(content));
  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    contentEl.innerHTML = '<div class="preview-placeholder">No key=value entries found.</div>';
    return;
  }
  renderKeyValueTable(entries, { maskSensitive: true });
}

const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M17.94 17.94A10 10 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9 9 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
const ICON_EYE_ON  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_COPY    = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_CHECK   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

function renderKeyValueTable(entries, opts = {}) {
  const maskSensitive = !!opts.maskSensitive;
  const table = document.createElement('table');
  table.className = 'data-table env-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Key</th><th>Value</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const [key, value] of entries) {
    const tr = document.createElement('tr');
    const kTd = document.createElement('td');
    kTd.textContent = key;
    kTd.className = 'env-key';
    const vTd = document.createElement('td');
    vTd.className = 'env-value';
    const sensitive = maskSensitive && SENSITIVE_ENV_RE.test(key);
    const valueSpan = document.createElement('span');
    valueSpan.className = 'env-value-text' + (sensitive ? ' masked' : '');
    valueSpan.dataset.raw = value;
    valueSpan.textContent = sensitive ? '********' : String(value);
    vTd.appendChild(valueSpan);
    if (sensitive) {
      const toggle = document.createElement('button');
      toggle.className = 'env-action';
      const updateToggle = () => {
        const masked = valueSpan.classList.contains('masked');
        toggle.innerHTML = masked ? ICON_EYE_OFF : ICON_EYE_ON;
        toggle.classList.toggle('active', !masked);
        toggle.title = masked ? 'Reveal' : 'Hide';
        toggle.setAttribute('aria-pressed', String(!masked));
      };
      updateToggle();
      toggle.addEventListener('click', () => {
        const masked = valueSpan.classList.toggle('masked');
        valueSpan.textContent = masked ? '********' : valueSpan.dataset.raw;
        updateToggle();
      });
      vTd.appendChild(toggle);
    }
    const copyBtn = document.createElement('button');
    copyBtn.className = 'env-action';
    copyBtn.title = 'Copy value';
    copyBtn.innerHTML = ICON_COPY;
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(String(value));
        copyBtn.innerHTML = ICON_CHECK;
        copyBtn.classList.add('active');
        setTimeout(() => { copyBtn.innerHTML = ICON_COPY; copyBtn.classList.remove('active'); }, 1200);
      } catch {}
    });
    vTd.appendChild(copyBtn);
    tr.appendChild(kTd);
    tr.appendChild(vTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  contentEl.innerHTML = '';
  contentEl.appendChild(table);
}

// ==================== .ini / .properties ====================
function renderINIPreview(content) {
  mountJSONEditor(content, (c) => ini.parse(c), 'INI', { readOnly: true });
}

function renderPropertiesPreview(content) {
  const entries = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const m = line.match(/^([^=:\s]+)\s*[=:]\s*(.*)$/);
    if (!m) continue;
    entries.push([m[1], m[2]]);
  }
  if (entries.length === 0) {
    contentEl.innerHTML = '<div class="preview-placeholder">No properties entries found.</div>';
    return;
  }
  renderKeyValueTable(entries, { maskSensitive: true });
}

// ==================== Editor - eview line sync ====================
function buildPreviewLineMap(source) {
  const tokens = marked.lexer(source);
  const children = Array.from(contentEl.children);
  let charOffset = 0;
  let childIdx = 0;
  for (const token of tokens) {
    if (token.type === 'space') { charOffset += token.raw.length; continue; }
    const line = source.substring(0, charOffset).split('\n').length - 1;
    if (childIdx < children.length) {
      children[childIdx].setAttribute('data-source-line', line);
      childIdx++;
    }
    charOffset += token.raw.length;
  }
}

function highlightPreviewLine(editorLine) {
  if (tocScrolling) return;
  const prev = contentEl.querySelector('.line-highlight');
  if (prev) prev.classList.remove('line-highlight');
  const elements = contentEl.querySelectorAll('[data-source-line]');
  let closest = null;
  for (const el of elements) {
    const line = parseInt(el.getAttribute('data-source-line'));
    if (line <= editorLine) closest = el;
    else break;
  }
  if (closest) {
    closest.classList.add('line-highlight');
    if (!editorMouseDown) {
      const rect = closest.getBoundingClientRect();
      const paneRect = previewPaneEl.getBoundingClientRect();
      if (rect.bottom < paneRect.top || rect.top > paneRect.bottom) {
        closest.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }
}

// ==================== Outline (per-format TOC) ====================
// Each builder returns null (= "outline not supported for this format") or [] (= "no
// items found") or an array of {label, level, line?, target?, sourceLine?}. `target`
// is a DOM node for markdown preview-pane scrolling. `line` is a 1-based editor line
// (other formats jump the editor caret).
function buildOutlineMarkdown() {
  const headings = contentEl.querySelectorAll('h1, h2, h3, h4, h5, h6');
  return Array.from(headings).map((h) => ({
    label: h.textContent,
    level: parseInt(h.tagName.charAt(1)) - 1,
    target: h,
    sourceLine: parseInt(h.getAttribute('data-source-line') || (h.closest('[data-source-line]') || {}).getAttribute?.('data-source-line')),
  }));
}
function buildOutlineHtml(text) {
  const items = [];
  const re = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(text)) && items.length < 200) {
    const label = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    items.push({
      label,
      level: parseInt(m[1].charAt(1)) - 1,
      line: text.substring(0, m.index).split('\n').length,
    });
  }
  return items;
}
// Walks a parsed JSON/YAML tree depth-first, capping items + max nesting depth.
// `level` doubles as both the visual indent and the toc-item.toc-level-N CSS class.
function walkObjectOutline(obj, items, opts) {
  const { maxItems = 200, maxDepth = 5, level = 0 } = opts;
  if (items.length >= maxItems || level > maxDepth) return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (items.length >= maxItems) return;
      const v = obj[i];
      const isObj = v !== null && typeof v === 'object';
      items.push({ label: '[' + i + ']', level });
      if (isObj) walkObjectOutline(v, items, { ...opts, level: level + 1 });
    }
    return;
  }
  for (const k of Object.keys(obj)) {
    if (items.length >= maxItems) return;
    const v = obj[k];
    const isObj = v !== null && typeof v === 'object';
    items.push({ label: k, level });
    if (isObj) walkObjectOutline(v, items, { ...opts, level: level + 1 });
  }
}
function buildOutlineJson(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  if (parsed === null || typeof parsed !== 'object') return [];
  const items = [];
  walkObjectOutline(parsed, items, {});
  return items;
}
function buildOutlineYaml(text) {
  let parsed;
  try { parsed = yamljs.load(text); } catch { return []; }
  if (parsed === null || typeof parsed !== 'object') return [];
  const items = [];
  walkObjectOutline(parsed, items, {});
  return items;
}
function buildOutlineSectioned(text) {
  const items = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && items.length < 200; i++) {
    const m = lines[i].trim().match(/^\[([^\]]+)\]/);
    if (m) {
      const path = m[1];
      items.push({ label: path, level: Math.min(path.split('.').length - 1, 5), line: i + 1 });
    }
  }
  return items;
}
function buildOutlineXml(text) {
  const items = [];
  const re = /^\s*<([A-Za-z_][\w:.-]*)/gm;
  let m;
  while ((m = re.exec(text)) && items.length < 200) {
    const tag = m[1];
    if (tag.startsWith('?') || tag.startsWith('!')) continue;
    items.push({ label: tag, level: 0, line: text.substring(0, m.index).split('\n').length });
  }
  return items;
}
function buildOutlineKeyValue(text, sep) {
  const items = [];
  const lines = text.split('\n');
  const re = sep === ':' ? /^([A-Za-z_][\w.-]*)\s*:/ : /^([A-Za-z_][\w.-]*)\s*=/;
  for (let i = 0; i < lines.length && items.length < 200; i++) {
    const line = lines[i];
    if (!line || line.trim().startsWith('#')) continue;
    const m = line.match(re);
    if (m) items.push({ label: m[1], level: 0, line: i + 1 });
  }
  return items;
}
function buildOutlineDelimited(text, sep) {
  const firstLine = text.split('\n')[0] || '';
  if (!firstLine) return [];
  return firstLine.split(sep).map((c, i) => ({
    label: c.trim() || ('column ' + (i + 1)),
    level: 0,
    line: 1,
  }));
}

function buildOutline(viewType, content) {
  switch (viewType) {
    case 'markdown': return buildOutlineMarkdown();
    case 'html': return buildOutlineHtml(content);
    case 'json':
    case 'jsonl':
      return buildOutlineJson(content);
    case 'yaml': return buildOutlineYaml(content);
    case 'toml':
    case 'ini':
    case 'conf':
      return buildOutlineSectioned(content);
    case 'properties':
    case 'env':
      return buildOutlineKeyValue(content, '=');
    case 'xml': return buildOutlineXml(content);
    case 'csv': return buildOutlineDelimited(content, ',');
    case 'tsv': return buildOutlineDelimited(content, '\t');
  }
  return null;
}

// ==================== TOC ====================
const tocSourceHeader = document.getElementById('toc-source-header');
const tocSourceLabel = document.getElementById('toc-source-label');

function setTocSource(text) {
  if (!tocSourceLabel || !tocSourceHeader) return;
  if (!text) {
    tocSourceHeader.classList.add('hidden');
    tocSourceLabel.textContent = '';
  } else {
    tocSourceHeader.classList.remove('hidden');
    tocSourceLabel.textContent = text;
  }
}

function buildTOC() {
  const tab = getActiveTab();
  if (tocScrollHandler) { contentEl.removeEventListener('scroll', tocScrollHandler); tocScrollHandler = null; }
  if (!tab) {
    setTocSource('');
    tocNav.innerHTML = `<p class="toc-empty">${t('outline.noFile')}</p>`;
    return;
  }
  const viewType = tab.viewType || 'markdown';
  const fileName = tab.filePath ? tab.filePath.split(/[/\\]/).pop() : t('untitled');
  setTocSource(fileName + '  -  ' + viewTypeDisplayLabel(viewType));

  const content = editor.state.doc.toString();
  const items = buildOutline(viewType, content);

  if (items === null) {
    tocNav.innerHTML = `<p class="toc-empty">${t('outline.notSupported')}</p>`;
    return;
  }
  if (items.length === 0) {
    tocNav.innerHTML = `<p class="toc-empty">${t('noHeadings')}</p>`;
    return;
  }

  const list = document.createElement('ul');
  list.className = 'toc-list';
  items.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'toc-item toc-level-' + Math.min(Math.max(item.level + 1, 1), 6);
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = item.label;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      tocScrolling = true;
      tocNav.querySelectorAll('a').forEach(l => l.classList.remove('active'));
      a.classList.add('active');

      if (viewType === 'markdown' && item.target) {
        const h = item.target;
        a.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const paneRect = previewPaneEl.getBoundingClientRect();
        const headingRect = h.getBoundingClientRect();
        previewPaneEl.scrollTo({ top: contentEl.scrollTop + headingRect.top - paneRect.top, behavior: 'smooth' });
        if (!isNaN(item.sourceLine)) {
          setTimeout(() => {
            const line = editor.state.doc.line(Math.min(item.sourceLine + 1, editor.state.doc.lines));
            editor.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start' }) });
            setTimeout(() => { tocScrolling = false; }, 200);
          }, 100);
        } else {
          setTimeout(() => { tocScrolling = false; }, 200);
        }
      } else if (item.line && item.line >= 1 && item.line <= editor.state.doc.lines) {
        const line = editor.state.doc.line(item.line);
        editor.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start' }) });
        editor.focus();
        setTimeout(() => { tocScrolling = false; }, 200);
      } else {
        setTimeout(() => { tocScrolling = false; }, 200);
      }
    });
    li.appendChild(a);
    list.appendChild(li);
  });
  tocNav.innerHTML = '';
  tocNav.appendChild(list);

  // Scroll spy only for markdown (other formats have no preview-side anchor to track).
  if (viewType === 'markdown') {
    const headings = items.map(it => it.target).filter(Boolean);
    const links = Array.from(tocNav.querySelectorAll('a'));
    tocScrollHandler = () => {
      if (tocScrolling) return;
      let currentIdx = -1;
      headings.forEach((h, idx) => { if (h.getBoundingClientRect().top <= 100) currentIdx = idx; });
      links.forEach((l, idx) => l.classList.toggle('active', idx === currentIdx));
    };
    contentEl.addEventListener('scroll', tocScrollHandler);
  }
}

// ==================== Backlinks ====================
async function refreshBacklinks() {
  if (!backlinksContentEl) return;
  const tab = getActiveTab();
  if (!tab?.filePath || !workspacePath) {
    backlinksContentEl.innerHTML = '<p class="backlinks-empty">' + t('backlinks.noFile') + '</p>';
    return;
  }
  // Backlinks are wiki-link-based and only meaningful in markdown.
  if ((tab.viewType || 'markdown') !== 'markdown') {
    backlinksContentEl.innerHTML = '<p class="backlinks-empty">' + t('backlinks.markdownOnly') + '</p>';
    return;
  }
  const data = await window.orpad.getBacklinks(workspacePath, tab.filePath);
  renderBacklinks(data);
}

function renderBacklinks(data) {
  backlinksContentEl.innerHTML = '';
  const { linked, unlinked } = data;

  if (linked.length === 0 && unlinked.length === 0) {
    backlinksContentEl.innerHTML = '<p class="backlinks-empty">' + t('backlinks.none') + '</p>';
    return;
  }

  if (linked.length > 0) {
    backlinksContentEl.appendChild(createBacklinkSection(t('backlinks.linked'), linked));
  }
  if (unlinked.length > 0) {
    backlinksContentEl.appendChild(createBacklinkSection(t('backlinks.unlinked'), unlinked));
  }
}

function createBacklinkSection(title, items) {
  const section = document.createElement('div');
  section.className = 'backlink-section';

  const header = document.createElement('div');
  header.className = 'backlink-section-header';
  header.textContent = title + ' (' + items.length + ')';
  header.addEventListener('click', () => {
    const list = section.querySelector('.backlink-list');
    if (list) list.classList.toggle('collapsed');
    header.classList.toggle('collapsed');
  });
  section.appendChild(header);

  const list = document.createElement('div');
  list.className = 'backlink-list';

  for (const item of items) {
    const group = document.createElement('div');
    group.className = 'backlink-item';

    const name = document.createElement('div');
    name.className = 'backlink-file-name';
    name.textContent = item.sourceTitle;
    name.addEventListener('click', () => openFileInTab(item.sourcePath));
    group.appendChild(name);

    const ctx = document.createElement('div');
    ctx.className = 'backlink-context';
    ctx.textContent = item.context.trim().substring(0, 150);
    ctx.addEventListener('click', () => openSearchResult(item.sourcePath, item.line));
    group.appendChild(ctx);

    list.appendChild(group);
  }

  section.appendChild(list);
  return section;
}

// ==================== Sidebar ====================
function showSidebar(panel) {
  if (sidebarVisible && sidebarActivePanel === panel) {
    sidebarVisible = false;
    sidebarEl.classList.add('hidden');
    document.getElementById('btn-files').classList.remove('active');
    document.getElementById('btn-toc').classList.remove('active');
    localStorage.setItem('orpad-sidebar-visible', 'false');
    return;
  }

  sidebarVisible = true;
  sidebarActivePanel = panel || sidebarActivePanel || 'files';
  sidebarEl.classList.remove('hidden');
  const savedWidth = parseInt(localStorage.getItem('orpad-sidebar-width'));
  if (savedWidth > 0) { sidebarEl.style.width = savedWidth + 'px'; sidebarEl.style.minWidth = savedWidth + 'px'; }

  document.querySelectorAll('.sidebar-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.panel === sidebarActivePanel);
  });
  document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('sidebar-' + sidebarActivePanel).classList.add('active');

  document.getElementById('btn-files').classList.toggle('active', sidebarVisible && sidebarActivePanel === 'files');
  document.getElementById('btn-toc').classList.toggle('active', sidebarVisible && sidebarActivePanel === 'toc');

  localStorage.setItem('orpad-sidebar-visible', 'true');
  localStorage.setItem('orpad-sidebar-panel', sidebarActivePanel);

  if (sidebarActivePanel === 'search') {
    setTimeout(() => searchInputEl.focus(), 100);
  }
  if (sidebarActivePanel === 'runbooks') {
    renderRunbooksPanel();
    void refreshWorkspaceRunbookSummary();
  }
}

function ensureSidebar(panel) {
  if (sidebarVisible && sidebarActivePanel === panel) return;
  showSidebar(panel);
}

document.querySelectorAll('.sidebar-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const panel = btn.dataset.panel;
    sidebarActivePanel = panel;
    document.querySelectorAll('.sidebar-tab').forEach(b => b.classList.toggle('active', b.dataset.panel === panel));
    document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('sidebar-' + panel).classList.add('active');
    localStorage.setItem('orpad-sidebar-panel', panel);
    document.getElementById('btn-toc').classList.toggle('active', panel === 'toc');
    if (panel === 'search') setTimeout(() => searchInputEl.focus(), 100);
    if (panel === 'backlinks') refreshBacklinks();
    if (panel === 'runbooks') {
      renderRunbooksPanel();
      void refreshWorkspaceRunbookSummary();
    }
  });
});

// ==================== Sidebar Resize ====================
const sidebarResizeEl = document.getElementById('sidebar-resize');
let sidebarDragging = false;

sidebarResizeEl.addEventListener('mousedown', (e) => {
  if (!sidebarVisible) return;
  sidebarDragging = true;
  sidebarResizeEl.classList.add('dragging');
  sidebarEl.style.transition = 'none';
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!sidebarDragging) return;
  const rect = workspaceEl.getBoundingClientRect();
  const newWidth = Math.max(160, Math.min(500, e.clientX - rect.left));
  sidebarEl.style.width = newWidth + 'px';
  sidebarEl.style.minWidth = newWidth + 'px';
});

document.addEventListener('mouseup', () => {
  if (sidebarDragging) {
    sidebarDragging = false;
    sidebarResizeEl.classList.remove('dragging');
    sidebarEl.style.transition = '';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('orpad-sidebar-width', sidebarEl.offsetWidth);
  }
});

sidebarResizeEl.addEventListener('dblclick', () => {
  sidebarEl.style.width = '';
  sidebarEl.style.minWidth = '';
  localStorage.removeItem('orpad-sidebar-width');
});

// ==================== Git UI ====================
function gitBadgeForPath(filePath) {
  if (!gitRepoState.isRepo || !workspacePath || !filePath) return null;
  return gitRepoState.statuses.get(gitRelativePath(workspacePath, filePath)) || null;
}

function appendGitBadge(itemEl, filePath) {
  const badge = gitBadgeForPath(filePath);
  if (!badge) return;
  const node = document.createElement('span');
  node.className = `git-badge git-badge-${badge === '?' ? 'unknown' : badge.toLowerCase()}`;
  node.textContent = badge;
  node.title = {
    M: 'Modified',
    A: 'Added',
    D: 'Deleted',
    U: 'Untracked',
    '?': 'Git status loading',
  }[badge] || 'Git status';
  itemEl.appendChild(node);
}

function updateGitStatusBar() {
  if (!statusGitEl) return;
  if (!gitRepoState.isRepo || !gitRepoState.branch) {
    statusGitEl.classList.add('hidden');
    statusGitEl.textContent = '';
    return;
  }
  let label = `Git: ${gitRepoState.branch}`;
  if (Number.isInteger(gitRepoState.ahead) && Number.isInteger(gitRepoState.behind)) {
    const parts = [];
    if (gitRepoState.ahead > 0) parts.push(`${gitRepoState.ahead} ahead`);
    if (gitRepoState.behind > 0) parts.push(`${gitRepoState.behind} behind`);
    if (parts.length) label += ` ${parts.join(' ')}`;
  }
  statusGitEl.textContent = label;
  statusGitEl.title = 'Open Git commands';
  statusGitEl.classList.remove('hidden');
}

function gitStatusCounts() {
  const counts = { modified: 0, added: 0, deleted: 0, untracked: 0, other: 0 };
  for (const badge of gitRepoState.statuses?.values?.() || []) {
    if (badge === 'M') counts.modified += 1;
    else if (badge === 'A') counts.added += 1;
    else if (badge === 'D') counts.deleted += 1;
    else if (badge === 'U' || badge === '?') counts.untracked += 1;
    else counts.other += 1;
  }
  return counts;
}

function formatGitCounts(counts) {
  const parts = [];
  if (counts.modified) parts.push(`${counts.modified} modified`);
  if (counts.added) parts.push(`${counts.added} added`);
  if (counts.deleted) parts.push(`${counts.deleted} deleted`);
  if (counts.untracked) parts.push(`${counts.untracked} untracked`);
  if (counts.other) parts.push(`${counts.other} other`);
  return parts.join(', ') || 'No working tree changes detected';
}

function showGitSlowBanner() {
  if (!workspacePath || !fileTreeEl) return;
  let banner = fileTreeEl.querySelector('.git-slow-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'git-slow-banner';
    banner.textContent = 'Git status load is slow - scanning...';
    fileTreeEl.prepend(banner);
  }
}

function clearGitSlowBanner() {
  fileTreeEl?.querySelector('.git-slow-banner')?.remove();
}

function scheduleGitRefresh(delay = 500) {
  if (gitStatusTimer) clearTimeout(gitStatusTimer);
  gitStatusTimer = setTimeout(() => refreshGitStatus(), delay);
}

async function refreshGitStatus() {
  if (!workspacePath) {
    gitRepoState = { isRepo: false, statuses: new Map(), branch: null, ahead: null, behind: null, slow: false };
    updateGitStatusBar();
    return;
  }
  const token = ++gitRefreshToken;
  let slowTimer = setTimeout(() => {
    if (token === gitRefreshToken) {
      gitRepoState = { ...gitRepoState, slow: true };
      showGitSlowBanner();
    }
  }, 3000);
  try {
    const [state, branchInfo] = await Promise.all([
      gitStatus(workspacePath),
      gitAheadBehind(workspacePath),
    ]);
    if (token !== gitRefreshToken) return;
    clearTimeout(slowTimer);
    slowTimer = null;
    clearGitSlowBanner();
    gitRepoState = {
      isRepo: !!state?.isRepo,
      statuses: state?.statuses || new Map(),
      branch: branchInfo?.branch || (state?.isRepo ? await gitCurrentBranch(workspacePath) : null),
      ahead: branchInfo?.ahead ?? null,
      behind: branchInfo?.behind ?? null,
      slow: false,
    };
    updateGitStatusBar();
    if (fileTreeCache.length) renderFileTree(fileTreeCache, 0);
    refreshGitHunks();
  } catch (err) {
    if (token !== gitRefreshToken) return;
    if (slowTimer) clearTimeout(slowTimer);
    clearGitSlowBanner();
    gitRepoState = { isRepo: false, statuses: new Map(), branch: null, ahead: null, behind: null, slow: false };
    updateGitStatusBar();
    console.warn('[git] status refresh failed', err);
  }
}

function scheduleGitHunkRefresh(delay = 350) {
  if (gitHunkTimer) clearTimeout(gitHunkTimer);
  gitHunkTimer = setTimeout(refreshGitHunks, delay);
}

async function refreshGitHunks() {
  const tab = getActiveTab();
  if (!gitRepoState.isRepo || !workspacePath || !tab?.filePath) {
    updateGitHunkGutter(editor, []);
    return;
  }
  try {
    const diff = await gitDiffAgainstHead(workspacePath, tab.filePath, editor.state.doc.toString());
    updateGitHunkGutter(editor, diff.hunks);
  } catch (err) {
    updateGitHunkGutter(editor, []);
    console.warn('[git] hunk gutter refresh failed', err);
  }
}

function buildHunkRevertChange(doc, hunk) {
  const oldLines = Array.isArray(hunk?.oldLines) ? hunk.oldLines : [];
  const newLineCount = Math.max(0, Number(hunk?.newLinesCount || 0));
  const newStart = Math.max(1, Number(hunk?.newStart || 1));

  if (newLineCount === 0) {
    if (!oldLines.length) return null;
    if (doc.length === 0) {
      return { from: 0, to: 0, insert: oldLines.join('\n') };
    }
    if (newStart > doc.lines) {
      const prefix = doc.toString().endsWith('\n') ? '' : '\n';
      return { from: doc.length, to: doc.length, insert: prefix + oldLines.join('\n') };
    }
    const line = doc.line(Math.max(1, Math.min(doc.lines, newStart)));
    return { from: line.from, to: line.from, insert: oldLines.join('\n') + '\n' };
  }

  const fromLine = Math.max(1, Math.min(doc.lines, newStart));
  const toLineNumber = Math.max(fromLine, Math.min(doc.lines, fromLine + newLineCount - 1));
  const first = doc.line(fromLine);
  const last = doc.line(toLineNumber);
  const includesTrailingBreak = toLineNumber < doc.lines;
  let from = first.from;
  let to = last.to + (includesTrailingBreak ? 1 : 0);
  let insert = oldLines.join('\n');

  if (oldLines.length && includesTrailingBreak) insert += '\n';
  if (!oldLines.length && !includesTrailingBreak && fromLine > 1) {
    from = doc.line(fromLine - 1).to;
  }
  return { from, to, insert };
}

async function revertGitHunk(hunk) {
  const tab = getActiveTab();
  if (!hunk || !tab?.filePath) return;
  const ok = window.confirm('Revert this hunk to HEAD?');
  if (!ok) return;
  const doc = editor.state.doc;
  const change = buildHunkRevertChange(doc, hunk);
  if (!change) return;
  editor.dispatch({
    changes: change,
    selection: { anchor: change.from + change.insert.length },
  });
  tab.isModified = editor.state.doc.toString() !== tab.lastSavedContent;
  updateTitle();
  renderTabBar();
  scheduleGitRefresh(0);
}

function renderGitDiffPreview() {
  const tab = getActiveTab();
  const diff = tab?.gitDiff;
  contentEl.innerHTML = '';
  if (!diff) {
    contentEl.innerHTML = '<div class="preview-placeholder">No Git diff data.</div>';
    return;
  }
  const panel = document.createElement('div');
  panel.className = 'git-diff-panel';
  const rows = [];
  for (const op of diff.ops || []) {
    if (op.op === 'equal') {
      rows.push(`<div class="git-diff-line"><span>${escapeHtml(String(op.oldLine || ''))}</span><span>${escapeHtml(String(op.newLine || ''))}</span><code>${escapeHtml(op.text || '')}</code></div>`);
    } else if (op.op === 'del') {
      rows.push(`<div class="git-diff-line deleted"><span>${escapeHtml(String(op.oldLine || ''))}</span><span></span><code>${escapeHtml(op.text || '')}</code></div>`);
    } else {
      rows.push(`<div class="git-diff-line added"><span></span><span>${escapeHtml(String(op.newLine || ''))}</span><code>${escapeHtml(op.text || '')}</code></div>`);
    }
  }
  panel.innerHTML = `
    <div class="git-diff-head">
      <strong>${escapeHtml(diff.filepath || 'Git diff')}</strong>
      <span>HEAD vs working tree</span>
    </div>
    <div class="git-diff-grid">
      <div class="git-diff-label">HEAD</div>
      <div class="git-diff-label">Working tree</div>
      <div class="git-diff-body">${rows.join('')}</div>
    </div>
  `;
  contentEl.appendChild(panel);
}

async function showGitDiffForActiveFile() {
  const tab = getActiveTab();
  if (!workspacePath || !tab?.filePath) return;
  const diff = await gitDiffAgainstHead(workspacePath, tab.filePath, editor.state.doc.toString());
  const diffTab = createTab(null, null, '', '', {
    title: `Diff: ${getTabDisplayName(tab)}`,
    viewType: 'git-diff',
    forceUnsaved: false,
  });
  diffTab.gitDiff = diff;
  lastRendered = { tabId: null, viewType: null, content: null };
  renderPreview('');
  updateFormatBar('git-diff');
}

async function revertGitCurrentFile() {
  const tab = getActiveTab();
  if (!workspacePath || !tab?.filePath) return;
  const ok = window.confirm(`Revert "${getTabDisplayName(tab)}" to HEAD?`);
  if (!ok) return;
  await gitRevertFile(workspacePath, tab.filePath);
  const result = await window.orpad.readFile(tab.filePath);
  if (!result?.error) {
    const content = normalizeLineEndings(result.content);
    tab.lastSavedContent = content;
    tab.isModified = false;
    tab.editorState = createEditorState(content, tab.viewType);
    editor.setState(tab.editorState);
    renderPreview(content);
    renderTabBar();
    updateTitle();
  }
  scheduleGitRefresh(0);
}

function syncActiveTabSnapshot() {
  const tab = getActiveTab();
  if (!tab) return;
  tab.editorState = editor.state;
  tab.isModified = editor.state.doc.toString() !== tab.lastSavedContent;
}

function getOpenWorkspaceFileTabs() {
  syncActiveTabSnapshot();
  return tabs.filter(tab => tab.filePath && isPathInsideWorkspace(tab.filePath));
}

async function reloadOpenWorkspaceTabsAfterCheckout(previousBranch) {
  const workspaceTabs = getOpenWorkspaceFileTabs();
  for (const tab of workspaceTabs) {
    if (tab.isModified) continue;
    const oldPath = tab.filePath;
    const result = await window.orpad.readFile(oldPath);
    if (result?.error) {
      const oldContent = tab.editorState?.doc?.toString?.() || '';
      tab.title = `${getTabDisplayName(tab)} (${previousBranch || 'previous branch'})`;
      tab.source = 'git-checkout';
      tab.sourceUrl = oldPath;
      tab.filePath = null;
      tab.dirPath = null;
      tab.lastSavedContent = '';
      tab.isModified = true;
      tab.editorState = createEditorState(oldContent, tab.viewType);
    } else {
      const content = normalizeLineEndings(result.content);
      tab.lastSavedContent = content;
      tab.isModified = false;
      tab.editorState = createEditorState(content, tab.viewType);
    }

    if (tab.id === activeTabId) {
      switchingTabs = true;
      editor.setState(tab.editorState);
      switchingTabs = false;
      renderPreview(editor.state.doc.toString());
      updateFormatBar(tab.viewType);
    }
  }
  renderTabBar();
  updateTitle();
  refreshGitHunks();
}

async function checkoutGitBranchSafely(branch) {
  if (!workspacePath || !branch || branch === gitRepoState.branch) return;
  const dirtyTabs = getOpenWorkspaceFileTabs().filter(tab => tab.isModified);
  if (dirtyTabs.length) {
    const names = dirtyTabs.slice(0, 5).map(getTabDisplayName).join(', ');
    const suffix = dirtyTabs.length > 5 ? `, and ${dirtyTabs.length - 5} more` : '';
    alert(`Save or close modified workspace tabs before switching branches: ${names}${suffix}`);
    return;
  }

  const previousBranch = gitRepoState.branch;
  const ok = window.confirm(`Checkout "${branch}"? Open workspace tabs will be reloaded from the target branch.`);
  if (!ok) return;
  await gitCheckoutBranch(workspacePath, branch);
  await loadFileTree();
  await reloadOpenWorkspaceTabsAfterCheckout(previousBranch);
  scheduleGitRefresh(0);
}

function appendGitPanelButton(actions, label, enabled, handler, primary = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.disabled = !enabled;
  if (primary) button.className = 'primary';
  button.addEventListener('click', async () => {
    try {
      await handler();
    } catch (err) {
      notifyFormatError('Git', err);
    }
  });
  actions.appendChild(button);
  return button;
}

function openGitPanel() {
  const body = document.createElement('div');
  body.className = 'git-command-panel';
  const summary = document.createElement('div');
  summary.className = 'git-command-summary';
  const actions = document.createElement('div');
  actions.className = 'git-command-actions';

  if (!workspacePath) {
    summary.innerHTML = `
      <strong>No workspace is open.</strong>
      <span>Open a folder first to enable Git status, branch switching, diff, and revert commands.</span>
    `;
    appendGitPanelButton(actions, 'Open Folder...', true, async () => {
      closeFmtModal();
      await openFolder();
    }, true);
  } else if (!gitRepoState.isRepo) {
    summary.innerHTML = `
      <strong>No Git repository detected.</strong>
      <span>${escapeHtml(workspacePath)}</span>
      <span>OrPAD scans the opened workspace root for Git status.</span>
    `;
    appendGitPanelButton(actions, 'Refresh Status', true, async () => {
      await refreshGitStatus();
      closeFmtModal();
      openGitPanel();
    }, true);
    appendGitPanelButton(actions, 'Open Command Palette: Git', true, () => {
      closeFmtModal();
      commandPalette?.open('Git: ');
    });
  } else {
    const counts = gitStatusCounts();
    const activeTab = getActiveTab();
    const activeFileInWorkspace = !!activeTab?.filePath && isPathInsideWorkspace(activeTab.filePath);
    summary.innerHTML = `
      <strong>Git repository active</strong>
      <span>Branch: ${escapeHtml(gitRepoState.branch || 'unknown')}</span>
      <span>Changes: ${escapeHtml(formatGitCounts(counts))}</span>
      ${Number.isInteger(gitRepoState.ahead) && Number.isInteger(gitRepoState.behind)
        ? `<span>Remote: ${gitRepoState.ahead} ahead, ${gitRepoState.behind} behind</span>`
        : ''}
    `;
    appendGitPanelButton(actions, 'Refresh Status', true, async () => {
      await refreshGitStatus();
      closeFmtModal();
      openGitPanel();
    });
    appendGitPanelButton(actions, 'Branch Switcher...', true, async () => {
      closeFmtModal();
      await openGitBranchSwitcher();
    }, true);
    appendGitPanelButton(actions, 'Show Active File Diff', activeFileInWorkspace, async () => {
      closeFmtModal();
      await showGitDiffForActiveFile();
    });
    appendGitPanelButton(actions, 'Revert Active File', activeFileInWorkspace, async () => {
      closeFmtModal();
      await revertGitCurrentFile();
    });
    appendGitPanelButton(actions, 'Command Palette: Git', true, () => {
      closeFmtModal();
      commandPalette?.open('Git: ');
    });
  }

  body.append(summary, actions);
  openFmtModal({
    title: 'Git Status and Commands',
    body,
    footer: [{ label: 'Close', primary: true, onClick: closeFmtModal }],
  });
}

async function openGitBranchSwitcher() {
  if (!workspacePath) return;
  const branches = await gitListBranches(workspacePath);
  const body = document.createElement('div');
  body.className = 'git-branch-list';
  if (!branches.length) {
    body.textContent = 'No branches found.';
  } else {
    for (const branch of branches) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = branch;
      btn.className = branch === gitRepoState.branch ? 'active' : '';
      btn.addEventListener('click', async () => {
        closeFmtModal();
        await checkoutGitBranchSafely(branch);
      });
      body.appendChild(btn);
    }
  }
  openFmtModal({
    title: 'Git: Open Branch Switcher',
    body,
    footer: [{ label: 'Close', primary: true, onClick: closeFmtModal }],
  });
}

statusGitEl?.addEventListener('click', openGitPanel);
document.getElementById('editor')?.addEventListener('orpad-git-revert-hunk', (event) => {
  revertGitHunk(event.detail?.hunk).catch(err => notifyFormatError('Git', err));
});

// ==================== Runbooks / Workspace Cockpit ====================
function runbookNormalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function runbookRelativePath(filePath) {
  const fp = runbookNormalizePath(filePath);
  const root = runbookNormalizePath(workspacePath).replace(/\/+$/, '');
  if (root && fp.toLowerCase().startsWith((root + '/').toLowerCase())) {
    return fp.slice(root.length + 1);
  }
  return fp;
}

function runbookBaseName(filePath, fallback = 'Workspace') {
  const normalized = runbookNormalizePath(filePath).replace(/\/+$/, '');
  const base = normalized.split('/').filter(Boolean).pop();
  return base || fallback;
}

function runbookPipelineDisplayName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const stem = raw
    .replace(/\.or-pipeline$/i, '')
    .replace(/[-_]+(?:19|20)\d{6}$/i, '');
  if (!/[-_]/.test(stem)) return stem;
  const acronyms = new Map([
    ['api', 'API'],
    ['cli', 'CLI'],
    ['ipc', 'IPC'],
    ['json', 'JSON'],
    ['llm', 'LLM'],
    ['mcp', 'MCP'],
    ['mvp', 'MVP'],
    ['orpad', 'OrPAD'],
    ['ui', 'UI'],
    ['ux', 'UX'],
  ]);
  return stem
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => acronyms.get(part.toLowerCase()) || `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function runbookListItemTitle(item) {
  if (item.format === 'or-pipeline') {
    return runbookPipelineDisplayName(item.displayName || runbookDirname(item.path).split('/').pop() || item.name)
      || item.name
      || 'Pipeline';
  }
  return item.displayName
    || item.name
    || 'Pipeline';
}

function runbookCompactText(text, maxLength = 120) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function runbookListItemSubtitle(item) {
  if (item.format === 'or-pipeline') {
    return runbookCompactText(item.description, 112) || (item.template ? 'Template pipeline' : 'OrPAD pipeline');
  }
  return runbookRelativePath(item.path);
}

function runbookSummaryItemForPath(filePath) {
  const summary = workspaceRunbookSummary || buildWorkspaceRunbookSummary();
  const key = runbookNormalizePath(filePath).toLowerCase();
  return (summary?.runbooks || []).find(item => runbookNormalizePath(item.path).toLowerCase() === key) || null;
}

function isWorkspacePipelinePackagePath(filePath) {
  const root = runbookNormalizePath(workspacePath).replace(/\/+$/, '').toLowerCase();
  const normalized = runbookNormalizePath(filePath).toLowerCase();
  if (!root || !normalized.startsWith(`${root}/.orpad/pipelines/`)) return false;
  return normalized.endsWith('/pipeline.or-pipeline');
}

function renderRunbookListItems(items, selectedKey) {
  return items.map(item => {
    const relativePath = runbookRelativePath(item.path);
    const itemSelected = runbookNormalizePath(item.path).toLowerCase() === selectedKey;
    const title = runbookListItemTitle(item);
    const subtitle = runbookListItemSubtitle(item);
    const tooltip = item.format === 'or-pipeline'
      ? [title, subtitle].filter(Boolean).join(' - ')
      : relativePath;
    return `
      <div class="runbook-item ${itemSelected ? 'selected' : ''}" data-runbook-path="${escapeHtml(item.path)}" data-runbook-format="${escapeHtml(item.format || '')}" data-selected="${itemSelected ? 'true' : 'false'}" role="button" tabindex="0" aria-pressed="${itemSelected ? 'true' : 'false'}" title="${escapeHtml(tooltip)}">
        <div class="runbook-item-title">
          <strong>${escapeHtml(title)}</strong>
        </div>
        <small>${escapeHtml(subtitle || relativePath)}</small>
      </div>
    `;
  }).join('');
}

function runbookStateKeys(filePath) {
  const full = runbookNormalizePath(filePath).toLowerCase();
  const relative = runbookRelativePath(filePath).toLowerCase();
  return [...new Set([full, relative].filter(Boolean))];
}

function setRunbookCache(cache, filePath, value) {
  for (const key of runbookStateKeys(filePath)) cache.set(key, value);
}

function getRunbookCache(cache, filePath) {
  for (const key of runbookStateKeys(filePath)) {
    if (cache.has(key)) return cache.get(key);
  }
  return null;
}

function runbookFlattenTree(items, out = []) {
  for (const item of items || []) {
    if (item.isDirectory) {
      out.push({ ...item, kind: 'directory' });
      runbookFlattenTree(item.children || [], out);
    } else {
      out.push({ ...item, kind: 'file' });
    }
  }
  return out;
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

function isOrpadPipelineFile(name) {
  return String(name || '').toLowerCase().endsWith('.or-pipeline');
}

function isLegacyRunbookFile(name) {
  const lower = String(name || '').toLowerCase();
  return lower.endsWith('.orch-graph.json') || lower.endsWith('.orch-tree.json') || lower.endsWith('.orch');
}

function isRiskyWorkspaceFile(name) {
  const lower = String(name || '').toLowerCase();
  return lower === '.env'
    || lower.includes('secret')
    || lower.includes('token')
    || lower.includes('password')
    || lower.endsWith('.pem')
    || lower.endsWith('.key')
    || lower.endsWith('.p12')
    || lower.endsWith('.pfx');
}

function buildWorkspaceRunbookSummary() {
  const entries = runbookFlattenTree(fileTreeCache);
  const files = entries.filter(item => item.kind === 'file');
  const dirs = entries.filter(item => item.kind === 'directory');
  const extCounts = new Map();
  const runbooks = [];
  const pipelines = [];
  const templatePipelines = [];
  const legacyRunbooks = [];
  const risky = [];
  let markdownCount = 0;
  let dataCount = 0;
  let diagramCount = 0;
  let logCount = 0;

  for (const file of files) {
    const ext = runbookExt(file.name);
    extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
    if (isOrpadPipelineFile(file.name)) {
      const isWorkspacePipeline = isWorkspacePipelinePackagePath(file.path);
      const displayNameSource = isWorkspacePipeline
        ? runbookDirname(file.path).split('/').pop() || file.name
        : file.name.replace(/\.or-pipeline$/i, '') || file.name;
      const displayName = runbookPipelineDisplayName(displayNameSource);
      const item = { ...file, format: 'or-pipeline', displayName, template: !isWorkspacePipeline };
      if (item.template) templatePipelines.push(item);
      else pipelines.push(item);
      runbooks.push(item);
    } else if (isLegacyRunbookFile(file.name)) {
      const item = { ...file, format: file.name.toLowerCase().endsWith('.orch-graph.json') ? 'orch-graph' : 'orch-tree' };
      legacyRunbooks.push(item);
      runbooks.push(item);
    }
    if (isRiskyWorkspaceFile(file.name)) risky.push(file);
    if (['md', 'markdown', 'mkd', 'mdx'].includes(ext)) markdownCount += 1;
    if (['json', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'xml', 'ini', 'conf', 'properties'].includes(ext)) dataCount += 1;
    if (['mmd', 'mermaid'].includes(ext)) diagramCount += 1;
    if (ext === 'log') logCount += 1;
  }

  const hasObsidian = dirs.some(item => item.name === '.obsidian');
  const hasRuns = dirs.some(item => item.name === '.orch-runs' || (item.name === 'runs' && runbookNormalizePath(item.path).includes('/.orpad/pipelines/')));
  const pipelineLikeCount = pipelines.length + templatePipelines.length;
  let workspaceType = 'Project workspace';
  if (hasObsidian && pipelines.length) workspaceType = 'Obsidian + OrPAD Pipeline workspace';
  else if (hasObsidian && pipelineLikeCount) workspaceType = 'Obsidian + OrPAD Template workspace';
  else if (hasObsidian && runbooks.length) workspaceType = 'Obsidian + Legacy Runbook workspace';
  else if (hasObsidian) workspaceType = 'Obsidian vault';
  else if (pipelines.length) workspaceType = 'OrPAD Pipeline workspace';
  else if (pipelineLikeCount) workspaceType = 'OrPAD Template workspace';
  else if (runbooks.length) workspaceType = 'Legacy Runbook workspace';

  return {
    source: 'file-tree',
    workspaceType,
    files,
    dirs,
    fileCount: files.length,
    dirCount: dirs.length,
    runbooks,
    pipelines,
    templatePipelines,
    legacyRunbooks,
    risky,
    hasObsidian,
    hasRuns,
    markdownCount,
    dataCount,
    diagramCount,
    logCount,
    topExts: [...extCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
}

function chooseSelectedRunbook(summary) {
  const runbooks = summary?.runbooks || [];
  if (!workspacePath || !summary) {
    selectedRunbookPath = null;
    selectedRunbookValidation = null;
    lastRunRecord = null;
    return;
  }
  if (!selectedRunbookPath) return;

  const selected = runbookNormalizePath(selectedRunbookPath);
  const root = runbookNormalizePath(workspacePath).replace(/\/+$/, '');
  const selectedInWorkspace = selected && root && (
    selected.toLowerCase() === root.toLowerCase()
    || selected.toLowerCase().startsWith((root + '/').toLowerCase())
  );
  const selectedKey = selected.toLowerCase();
  const stillPresent = selectedRunbookPath && runbooks.some(item => runbookNormalizePath(item.path).toLowerCase() === selectedKey);
  const selectedLooksCanonicalPipeline = selected.includes('/.orpad/pipelines/');
  const canProveAbsence = summary.source !== 'file-tree' || (runbooks.length > 0 && !selectedLooksCanonicalPipeline);

  if (!selectedInWorkspace || (!stillPresent && canProveAbsence)) {
    selectedRunbookPath = null;
    selectedRunbookValidation = null;
    lastRunRecord = null;
  }
}

async function refreshWorkspaceRunbookSummary() {
  const pipelineApi = window.orpad?.pipelines || window.orpad?.runbooks;
  if (!workspacePath || !pipelineApi?.scanWorkspace) return;
  const requestedWorkspace = workspacePath;
  const requestId = ++runbookScanRequestId;
  try {
    const summary = await pipelineApi.scanWorkspace(requestedWorkspace);
    if (requestId !== runbookScanRequestId || requestedWorkspace !== workspacePath || summary?.success === false) return;
    workspaceRunbookSummary = summary;
    chooseSelectedRunbook(workspaceRunbookSummary);
    renderRunbooksPanel();
  } catch {
    // The file-tree-derived summary is still useful when the desktop scanner is unavailable.
  }
}

function updateWorkspaceRunbookSummary() {
  workspaceRunbookSummary = workspacePath ? buildWorkspaceRunbookSummary() : null;
  chooseSelectedRunbook(workspaceRunbookSummary);
  renderRunbooksPanel();
  void refreshWorkspaceRunbookSummary();
}

async function refreshPipesPanelState() {
  const previousSelection = selectedRunbookPath || '';
  await loadFileTree();
  await refreshWorkspaceRunbookSummary();
  const previousKey = runbookNormalizePath(previousSelection).toLowerCase();
  const previousStillPresent = previousKey && (workspaceRunbookSummary?.runbooks || [])
    .some(item => runbookNormalizePath(item.path).toLowerCase() === previousKey);
  const selected = selectedRunbookPath || (previousStillPresent ? previousSelection : '');
  if (!selected) {
    renderRunbooksPanel();
    return;
  }
  if (selectedRunbookPath !== selected) selectedRunbookPath = selected;
  runbookValidationCache.delete(selected);
  machineRunRecordCache.delete(selected);
  machineRunListCache.delete(selected);
  await validateSelectedRunbook(selected);
  await refreshMachineRuntimeStatus({ force: true });
  void hydrateLatestMachineRunForSelection(selected);
  rerenderPipelinePreviewIfActive(selected);
}

function isDiagnosticError(item) {
  return item?.level === 'error' || item?.severity === 'error';
}

function isAgentOrchestratedPipeline(validation) {
  if (!validation?.ok || validation.format !== 'or-pipeline') return false;
  if (validation.canExecute) return false;
  if ((validation.diagnostics || []).some(isDiagnosticError)) return false;
  if ((validation.diagnostics || []).some(item => item?.code === 'PIPELINE_AGENT_ORCHESTRATED')) return true;
  return (validation.renderOnlyNodeTypes || []).some(type => String(type || '').startsWith('orpad.'));
}

function isMachineApiAvailable() {
  return !!window.orpad?.machine;
}

function machineRuntimeBlockReason() {
  if (!isMachineApiAvailable()) return 'Managed runs are unavailable in this build.';
  if (!machineRuntimeStatus) return '';
  if (machineRuntimeStatus.success === false || machineRuntimeStatus.ok === false) {
    return machineRuntimeStatus.error || 'Managed run status check failed.';
  }
  if (machineRuntimeStatus.enabled === false) {
    return machineRuntimeStatus.sessionEnableAvailable
      ? 'Managed runs need your permission for this OrPAD session.'
      : 'Managed runs are unavailable in this session. Relaunch OrPAD with managed-run support enabled.';
  }
  if (machineRuntimeStatus.mutatingCapabilityConfigured === false) {
    return machineRuntimeStatus.sessionEnableAvailable
      ? 'Managed runs need your permission for this OrPAD session.'
      : 'Managed runs need a run authorization token before run-store mutations are allowed.';
  }
  return '';
}

async function refreshMachineRuntimeStatus({ force = false } = {}) {
  if (machineRuntimeStatusLoading) return machineRuntimeStatus;
  if (machineRuntimeStatus && !force) return machineRuntimeStatus;
  if (!window.orpad?.machine?.status) {
    machineRuntimeStatus = {
      success: isMachineApiAvailable(),
      ok: isMachineApiAvailable(),
      enabled: isMachineApiAvailable(),
      mutatingCapabilityConfigured: null,
      sessionEnableAvailable: false,
    };
    if (sidebarActivePanel === 'runbooks') renderRunbooksPanel();
    rerenderPipelinePreviewIfActive(selectedRunbookPath);
    return machineRuntimeStatus;
  }
  machineRuntimeStatusLoading = true;
  try {
    machineRuntimeStatus = await window.orpad.machine.status();
  } catch (err) {
    machineRuntimeStatus = {
      success: false,
      ok: false,
      error: err?.message || String(err),
    };
  } finally {
    machineRuntimeStatusLoading = false;
  }
  if (sidebarActivePanel === 'runbooks') renderRunbooksPanel();
  rerenderPipelinePreviewIfActive(selectedRunbookPath);
  return machineRuntimeStatus;
}

function canEnableManagedRunsForSession() {
  return !!window.orpad?.machine?.enableSession
    && machineRuntimeStatus?.sessionEnableAvailable === true
    && (machineRuntimeStatus.enabled === false || machineRuntimeStatus.mutatingCapabilityConfigured === false);
}

async function enableManagedRunsForSession() {
  if (!canEnableManagedRunsForSession()) return false;
  const approved = confirm(
    'Allow OrPAD to start runs in this session?\n\n'
    + 'OrPAD will own work state, run status, and evidence files for this pipeline. '
    + 'Source files are not changed unless an allowed adapter step applies a patch.',
  );
  if (!approved) return null;
  const enabled = await window.orpad.machine.enableSession();
  if (!enabled?.success) {
    alert(enabled?.error || 'Runs could not be enabled for this session.');
    return false;
  }
  machineRuntimeStatus = {
    success: true,
    ok: true,
    enabled: enabled.enabled === true,
    mutatingCapabilityConfigured: enabled.mutatingCapabilityConfigured === true,
    sessionEnableAvailable: enabled.sessionEnableAvailable === true,
    enabledBy: enabled.enabledBy || 'session',
  };
  if (enabled.capabilityToken) machineCapabilityToken = enabled.capabilityToken;
  if (sidebarActivePanel === 'runbooks') renderRunbooksPanel();
  rerenderPipelinePreviewIfActive(selectedRunbookPath);
  return !machineRuntimeBlockReason();
}

async function ensureMachineRuntimeReady() {
  await refreshMachineRuntimeStatus({ force: !machineRuntimeStatus });
  let blockReason = machineRuntimeBlockReason();
  if (!blockReason) return true;
  const enabledForSession = await enableManagedRunsForSession();
  if (enabledForSession === true) return true;
  if (enabledForSession === null) return false;
  blockReason = machineRuntimeBlockReason() || blockReason;
  alert(blockReason);
  return false;
}

function isMachineCompatiblePipeline(validation) {
  return !!validation?.ok
    && validation.format === 'or-pipeline'
    && validation.canMachineExecute === true
    && !(validation.diagnostics || []).some(isDiagnosticError);
}

function isMachineStartablePipeline(validation) {
  return isMachineCompatiblePipeline(validation) && validation.canMachineExecuteStep === true;
}

function machineStartBlockReason(validation) {
  if (!validation) return 'Check this pipeline before starting.';
  if (!isMachineCompatiblePipeline(validation)) {
    return (validation.machineBlockedReasons || []).join(', ') || 'This pipeline is not ready to start yet.';
  }
  const reasons = validation.machineStepBlockedReasons || [];
  if (reasons.includes('machine-harness-required')) {
    return 'Cannot start yet: this pipeline needs run.machineHarness or run.machineAdapter.';
  }
  if (reasons.length) return `Cannot start yet: ${reasons.join(', ')}.`;
  return '';
}

function agentOrchestratedPipelineIssue(validation) {
  if (!isAgentOrchestratedPipeline(validation)) return null;
  return (validation.diagnostics || []).find(item => item?.code === 'PIPELINE_AGENT_ORCHESTRATED') || {
    code: 'PIPELINE_AGENT_ORCHESTRATED',
    message: 'Path-launched agent required; the local MVP runner does not execute workstream nodes.',
  };
}

function renderAgentHandoffPromptShape(shape, runbookPath) {
  const source = typeof shape === 'string' ? shape.trim() : '';
  if (!source) return '';
  let rendered = source;
  let replaced = false;
  [
    /<pipeline\.or-pipeline path>/gi,
    /<pipeline path>/gi,
    /<path>/gi,
    /\{pipelinePath\}/g,
    /\$\{pipelinePath\}/g,
  ].forEach((pattern) => {
    const next = rendered.replace(pattern, runbookPath);
    if (next !== rendered) replaced = true;
    rendered = next;
  });
  if (!replaced && !rendered.includes(runbookPath)) return `${runbookPath} ${rendered}`;
  return rendered;
}

function agentHandoffLaunchPrompt(runbookPath, pipelineDoc = null) {
  const manifestShape = pipelineDoc?.maintenancePolicy?.handoff?.launchPromptShape;
  const normalizedPath = runbookNormalizePath(runbookPath).trim();
  return renderAgentHandoffPromptShape(manifestShape, normalizedPath) || `Run this OrPAD pipeline: ${normalizedPath}`;
}

function agentHandoffSummaryPath(runbookPath, pipelineDoc = null) {
  const summaryRef = typeof pipelineDoc?.run?.summaryPath === 'string' && pipelineDoc.run.summaryPath.trim()
    ? pipelineDoc.run.summaryPath.trim()
    : 'harness/generated/latest-run/summary.md';
  return runbookJoinPath(runbookDirname(runbookPath), summaryRef);
}

function agentHandoffAuditCommand(runbookPath) {
  return `npm run audit:orpad-run -- "${runbookRelativePath(runbookPath)}"`;
}

function agentHandoffAuditCommands(runbookPath, pipelineDoc) {
  const defaults = Array.isArray(pipelineDoc?.executionPolicy?.verificationDefaults)
    ? pipelineDoc.executionPolicy.verificationDefaults
    : [];
  const commands = defaults
    .filter(command => typeof command === 'string' && /\baudit:orpad-|scripts[\\/]+audit-orpad-/i.test(command))
    .map(command => command.trim())
    .filter(Boolean);
  if (!commands.some(command => /\baudit:orpad-run\b|scripts[\\/]+audit-orpad-run\.mjs\b/i.test(command))) {
    commands.push(agentHandoffAuditCommand(runbookPath));
  }
  return [...new Set(commands)];
}

function renderAgentHandoffAuditChecklist(commands) {
  const items = commands.length ? commands : ['Evidence check unavailable.'];
  return `
    <h3>Required Checks</h3>
    <ul class="runbook-audit-list">
      ${items.map(command => `<li><code>${escapeHtml(command)}</code></li>`).join('')}
    </ul>
  `;
}

function summaryWithSelectedRunbook(summary, selectedPath) {
  if (!summary || !selectedPath) return summary;
  const key = runbookNormalizePath(selectedPath).toLowerCase();
  const runbooks = summary.runbooks || [];
  if (runbooks.some(item => runbookNormalizePath(item.path).toLowerCase() === key)) return summary;
  const name = selectedPath.split(/[\\/]/).pop() || selectedPath;
  const lower = name.toLowerCase();
  const isPipeline = lower.endsWith('.or-pipeline');
  const isWorkspacePipeline = isPipeline && isWorkspacePipelinePackagePath(selectedPath);
  const item = {
    path: selectedPath,
    name,
    kind: 'file',
    format: isPipeline ? 'or-pipeline' : lower.endsWith('.orch-graph.json') ? 'orch-graph' : 'orch-tree',
    displayName: isPipeline && isWorkspacePipeline
      ? runbookPipelineDisplayName(runbookDirname(selectedPath).split('/').pop() || name)
      : isPipeline
        ? runbookPipelineDisplayName(name.replace(/\.or-pipeline$/i, '') || name)
        : name,
    description: isPipeline ? 'OrPAD pipeline' : '',
    template: isPipeline && !isWorkspacePipeline,
  };
  const next = {
    ...summary,
    runbooks: [item, ...runbooks],
    pipelines: isPipeline && isWorkspacePipeline ? [item, ...(summary.pipelines || [])] : (summary.pipelines || []),
    templatePipelines: isPipeline && !isWorkspacePipeline ? [item, ...(summary.templatePipelines || [])] : (summary.templatePipelines || []),
    legacyRunbooks: isPipeline ? (summary.legacyRunbooks || []) : [item, ...(summary.legacyRunbooks || [])],
  };
  return next;
}

function runbookDirname(filePath) {
  const normalized = runbookNormalizePath(filePath);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

function runbookJoinPath(baseDir, ref) {
  const raw = String(ref || '').split('#')[0];
  if (!raw) return '';
  if (/^[a-z]:\//i.test(raw) || raw.startsWith('/')) return raw;
  const parts = `${baseDir}/${raw}`.split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function collectRendererRefItems(value) {
  if (Array.isArray(value)) return value.map(item => {
    if (typeof item === 'string') return { id: item.split(/[\\/]/).pop() || item, file: item };
    if (!item || typeof item !== 'object') return null;
    const file = item.file || item.path || item.ref || '';
    const id = item.id || item.name || file;
    return file ? { ...item, id, file } : null;
  }).filter(Boolean);
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([id, item]) => {
      if (typeof item === 'string') return { id, file: item };
      if (!item || typeof item !== 'object') return null;
      const file = item.file || item.path || item.ref || '';
      return file ? { ...item, id: item.id || item.name || id, file } : null;
    }).filter(Boolean);
  }
  return [];
}

function rendererGraphObject(doc) {
  if (doc?.graph && typeof doc.graph === 'object' && !Array.isArray(doc.graph)) return doc.graph;
  return Array.isArray(doc?.nodes) ? doc : null;
}

function rendererTreeEntries(doc) {
  if (doc?.root && typeof doc.root === 'object' && !Array.isArray(doc.root)) {
    return [{ id: doc.id || 'tree', root: doc.root, __baseDir: doc.__baseDir || '' }];
  }
  return Array.isArray(doc?.trees) ? doc.trees : [];
}

async function readRendererJson(filePath) {
  const result = await window.orpad.readFile(filePath);
  if (result?.error) return null;
  return JSON.parse(result.content || '{}');
}

function collectRendererRunbookSkillRefs(node, out = [], baseDir = '') {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return out;
  if (isOrchSkillType(node.type)) {
    const ref = node.file || node.config?.file || '';
    const skillRef = node.skillRef || node.config?.skillRef || '';
    if (ref || skillRef) out.push({ id: node.id || '', label: node.label || node.id || 'Skill', ref, skillRef, baseDir });
  }
  if (isOrchTreeRefType(node.type) && node.tree?.root) {
    collectRendererRunbookSkillRefs(node.tree.root, out, node.tree.__baseDir || baseDir);
  }
  for (const child of Array.isArray(node.children) ? node.children : []) {
    collectRendererRunbookSkillRefs(child, out, baseDir);
  }
  return out;
}

async function collectRendererExternalTreeRefs(node, baseDir, addIncluded, skillRefs, visited = new Set()) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  if (isOrchTreeRefType(node.type)) {
    const treeRef = node.treeRef || node.config?.treeRef || node.ref || node.config?.ref || '';
    if (treeRef && !node.tree) {
      const treePath = runbookJoinPath(baseDir, treeRef);
      addIncluded('tree', treePath, node.label || node.id || treeRef);
      const key = runbookNormalizePath(treePath).toLowerCase();
      if (!visited.has(key)) {
        visited.add(key);
        const treeDoc = await readRendererJson(treePath);
        const treeBaseDir = runbookDirname(treePath);
        for (const tree of rendererTreeEntries({ ...(treeDoc || {}), __baseDir: treeBaseDir })) {
          collectRendererRunbookSkillRefs(tree.root, skillRefs, treeBaseDir);
          await collectRendererExternalTreeRefs(tree.root, treeBaseDir, addIncluded, skillRefs, visited);
        }
      }
    } else if (node.tree?.root) {
      const treeBaseDir = node.tree.__baseDir || baseDir;
      collectRendererRunbookSkillRefs(node.tree.root, skillRefs, treeBaseDir);
      await collectRendererExternalTreeRefs(node.tree.root, treeBaseDir, addIncluded, skillRefs, visited);
    }
  }
  for (const child of Array.isArray(node.children) ? node.children : []) {
    await collectRendererExternalTreeRefs(child, baseDir, addIncluded, skillRefs, visited);
  }
}

async function buildRunbookContextEstimate(runbookPath, validation) {
  const summary = summaryWithSelectedRunbook(workspaceRunbookSummary || buildWorkspaceRunbookSummary(), selectedRunbookPath);
  const included = [{ role: /\.or-pipeline$/i.test(runbookPath) ? 'pipeline' : 'runbook', path: runbookPath }];
  const addIncluded = (role, filePath, label = '') => {
    if (!filePath) return;
    const key = runbookNormalizePath(filePath).toLowerCase();
    if (included.some(item => runbookNormalizePath(item.path).toLowerCase() === key && item.role === role)) return;
    included.push({ role, path: filePath, label });
  };
  try {
    const result = await window.orpad.readFile(runbookPath);
    if (!result?.error) {
      const parsed = JSON.parse(result.content || '');
      const baseDir = runbookDirname(runbookPath);
      const skillMap = new Map();
      if (parsed.kind === 'orpad.pipeline' || parsed.entryGraph) {
        const graphRefs = collectRendererRefItems(parsed.graphs);
        const treeRefs = collectRendererRefItems(parsed.trees);
        const skillRefs = collectRendererRefItems(parsed.skills);
        const ruleRefs = collectRendererRefItems(parsed.rules);
        const entryGraph = parsed.entryGraph || parsed.entry?.graph || parsed.graph?.file || graphRefs[0]?.file || '';
        if (entryGraph) addIncluded('graph', runbookJoinPath(baseDir, entryGraph));
        for (const item of graphRefs) {
          if (item?.file) addIncluded('graph', runbookJoinPath(baseDir, item.file), item.id || item.file);
        }
        for (const item of treeRefs) {
          if (item?.file) addIncluded('tree', runbookJoinPath(baseDir, item.file), item.id || item.file);
        }
        for (const item of skillRefs) {
          if (item?.file) {
            const skillPath = runbookJoinPath(baseDir, item.file);
            skillMap.set(String(item.id || '').trim(), skillPath);
            addIncluded('skill', skillPath, item.id || item.file);
          }
        }
        for (const item of ruleRefs) {
          if (item?.file) addIncluded('rule', runbookJoinPath(baseDir, item.file), item.id || item.file);
        }
        if (entryGraph) {
          const graphPath = runbookJoinPath(baseDir, entryGraph);
          const graphDoc = await readRendererJson(graphPath);
          const graph = rendererGraphObject(graphDoc);
          const graphBaseDir = runbookDirname(graphPath);
          const graphSkillRefs = [];
          for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
            collectRendererRunbookSkillRefs(node, graphSkillRefs, graphBaseDir);
            await collectRendererExternalTreeRefs(node, graphBaseDir, addIncluded, graphSkillRefs);
          }
          for (const ref of graphSkillRefs) {
            const target = ref.ref ? runbookJoinPath(ref.baseDir || graphBaseDir, ref.ref) : skillMap.get(String(ref.skillRef || '').trim());
            addIncluded('skill', target, ref.label);
          }
        }
      }
      const refs = [];
      for (const tree of rendererTreeEntries({ ...parsed, __baseDir: baseDir })) {
        collectRendererRunbookSkillRefs(tree.root, refs, tree.__baseDir || baseDir);
        await collectRendererExternalTreeRefs(tree.root, tree.__baseDir || baseDir, addIncluded, refs);
      }
      const graph = rendererGraphObject(parsed);
      for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
        collectRendererRunbookSkillRefs(node, refs, baseDir);
        await collectRendererExternalTreeRefs(node, baseDir, addIncluded, refs);
      }
      for (const ref of refs) {
        const target = ref.ref ? runbookJoinPath(ref.baseDir || baseDir, ref.ref) : skillMap.get(String(ref.skillRef || '').trim());
        addIncluded('skill', target, ref.label);
      }
    }
  } catch {
    // The main-process validator remains authoritative; the UI estimate can stay minimal.
  }
  const excluded = (summary.risky || []).map(item => ({
    role: 'redaction-candidate',
    path: item.path,
    reason: 'secret/token/password/key-like filename',
  }));
  return {
    included,
    excluded,
    tokenEstimate: Math.max(128, Math.ceil((validation?.nodeCount || 1) * 120 + included.length * 180)),
    indexFacts: {
      workspaceType: summary.workspaceType,
      fileCount: summary.fileCount,
      runbookCount: summary.runbooks.length,
      pipelineCount: (summary.pipelines || []).length,
      redactionCandidateCount: summary.risky.length,
    },
  };
}

function renderContextRows(items, emptyText) {
  if (!items.length) return `<div class="runbook-diagnostic">${escapeHtml(emptyText)}</div>`;
  return `<div class="runbook-list">${items.map(item => `
    <div class="runbook-item">
      <strong>${escapeHtml(item.role || 'file')}</strong>
      <small>${escapeHtml(runbookRelativePath(item.path))}</small>
      ${item.reason ? `<small>${escapeHtml(item.reason)}</small>` : ''}
    </div>
  `).join('')}</div>`;
}

async function openRunbookContextInspector(runbookPath, validation) {
  const context = await buildRunbookContextEstimate(runbookPath, validation || selectedRunbookValidation);
  const body = document.createElement('div');
  body.className = 'runbook-modal-body';
  body.innerHTML = `
    <div class="runbook-chip-row">
      <span class="runbook-chip">${context.tokenEstimate} est. tokens</span>
      <span class="runbook-chip">${context.indexFacts.fileCount} files indexed</span>
      <span class="runbook-chip warn">${context.excluded.length} excluded/redacted</span>
    </div>
    <h3>Included</h3>
    ${renderContextRows(context.included, 'No included files detected.')}
    <h3>Excluded By Default</h3>
    ${renderContextRows(context.excluded, 'No filename risk hits detected.')}
    <pre class="runbook-context-preview">${escapeHtml([
      'default policy: include selected pipeline/flow/tree, declared skill files, and workspace facts',
      'redaction: exclude .env, key-like files, and secret-like filenames',
      'terminal attachments: none by default',
      'MCP resources: none by default',
    ].join('\n'))}</pre>
  `;
  openFmtModal({
    title: 'Pipeline Context Inspector',
    body,
    footer: [{ label: 'Close', onClick: closeFmtModal }],
  });
  return context;
}

async function getRunbookEvidenceAudit(runbookPath) {
  const pipelineApi = window.orpad?.pipelines || window.orpad?.runbooks;
  if (!workspacePath || !pipelineApi?.auditRunEvidence) return null;
  try {
    return await pipelineApi.auditRunEvidence(workspacePath, runbookPath);
  } catch (err) {
    return { success: false, ok: false, error: err?.message || String(err), diagnostics: [] };
  }
}

function renderRunEvidenceAudit(audit) {
  if (!audit) {
    return '<div class="runbook-diagnostic warning">Evidence check is unavailable in this environment.</div>';
  }
  const diagnostics = audit.diagnostics || [];
  const noCycleCodes = new Set([
    'RUN_REQUIRED_ARTIFACT_MISSING',
    'RUN_REQUIRED_QUEUE_ARTIFACT_MISSING',
    'RUN_SUMMARY_MISSING',
    'RUN_METADATA_MISSING_OR_INVALID',
    'DISCOVERY_COVERAGE_MISSING_OR_INVALID',
    'CANDIDATE_INVENTORY_MISSING_OR_INVALID',
  ]);
  const noCycleYet = !audit.ok && diagnostics.length > 0 && diagnostics.every(item => noCycleCodes.has(item?.code || ''));
  const status = audit.ok ? 'PASS' : (noCycleYet ? 'NO CYCLE YET' : 'STALE OR FAIL');
  const formatDiagnostic = (item) => {
    const code = item?.code || 'RUN_AUDIT';
    if (code === 'RUN_ARTIFACT_ROOT_MISSING') {
      return `${code}: no latest run/cycle evidence exists yet. Launch the agent handoff to create a fresh maintenance cycle.`;
    }
    if (code === 'RUN_SUMMARY_MISSING') {
      return `${code}: no latest cycle summary exists yet. Launch the agent handoff to create one.`;
    }
    if (code === 'RUN_METADATA_MISSING_OR_INVALID') {
      return `${code}: no latest cycle metadata exists yet, or it is not valid JSON. Launch the agent handoff to create fresh metadata.`;
    }
    if (code === 'RUN_METADATA_WORKTREE_STALE') {
      return `${code}: latest run/cycle evidence was created before the current workspace edits. Commit/stash the edits or rerun the pipeline before trusting this cycle snapshot.`;
    }
    if (code === 'RUN_METADATA_HEAD_STALE') {
      return `${code}: latest run/cycle evidence was created for a different commit. Rerun the pipeline on the current HEAD before trusting this cycle snapshot.`;
    }
    return `${code}: ${item?.message || ''}`;
  };
  return `
    <div class="runbook-chip-row">
      <span class="runbook-chip ${audit.ok ? 'good' : (noCycleYet ? 'warn' : 'danger')}">${escapeHtml(noCycleYet ? 'ready for first cycle' : `cycle check ${status}`)}</span>
      <span class="runbook-chip">${escapeHtml(String(audit.queueAudit?.itemCount ?? 0))} queue items</span>
    </div>
    ${noCycleYet ? `
      <div class="runbook-diagnostic warning">
        No latest cycle evidence exists yet. Copy the launch prompt into a supervised agent session to create the first latest-run snapshot.
      </div>
    ` : ''}
    ${diagnostics.length ? `
      <div class="runbook-diagnostic ${audit.ok || noCycleYet ? 'warning' : 'error'}">
        ${escapeHtml(noCycleYet ? 'Evidence check becomes meaningful after the first cycle creates required evidence files.' : diagnostics.slice(0, 5).map(formatDiagnostic).join('\n'))}
      </div>
    ` : '<div class="runbook-diagnostic">Latest run/cycle evidence check passed.</div>'}
  `;
}

async function openAgentHandoffModal(runbookPath, validation) {
  const issue = agentOrchestratedPipelineIssue(validation || selectedRunbookValidation);
  const renderOnlyTypes = [...new Set((validation?.renderOnlyNodeTypes || selectedRunbookValidation?.renderOnlyNodeTypes || [])
    .filter(type => String(type || '').startsWith('orpad.')))].sort();
  const renderOnlyTypeLabels = orchNodeTypeListLabels(renderOnlyTypes);
  const pipelineDoc = await readRendererJson(runbookPath);
  const launchPrompt = agentHandoffLaunchPrompt(runbookPath, pipelineDoc);
  const auditCommand = agentHandoffAuditCommand(runbookPath);
  const auditCommands = agentHandoffAuditCommands(runbookPath, pipelineDoc);
  const audit = await getRunbookEvidenceAudit(runbookPath);
  const summaryPath = agentHandoffSummaryPath(runbookPath, pipelineDoc);
  const body = document.createElement('div');
  body.className = 'runbook-modal-body';
  body.innerHTML = `
    <p>This pipeline is valid for a supervised path-launched agent, but the local MVP runner does not execute its workstream nodes.</p>
    <div class="runbook-chip-row">
      <span class="runbook-chip good">agent handoff</span>
      <span class="runbook-chip warn">local runner unsupported</span>
      ${renderOnlyTypeLabels.length ? `<span class="runbook-chip">${renderOnlyTypeLabels.length} agent-only steps</span>` : ''}
    </div>
    ${issue ? `<div class="runbook-diagnostic warning">${escapeHtml(issue.code || 'PIPELINE_AGENT_ORCHESTRATED')} - ${escapeHtml(issue.message || '')}</div>` : ''}
    <h3>Launch Prompt</h3>
    <textarea class="runbook-task-input" rows="3" readonly data-agent-handoff-prompt>${escapeHtml(launchPrompt)}</textarea>
    <h3>Latest Run / Cycle Evidence</h3>
    ${renderRunEvidenceAudit(audit)}
    ${renderAgentHandoffAuditChecklist(auditCommands)}
    <pre class="runbook-context-preview">${escapeHtml([
      `workspace: ${workspacePath || ''}`,
      `pipeline: ${runbookRelativePath(runbookPath)}`,
      `latest cycle summary: ${runbookRelativePath(summaryPath)}`,
      `evidence check: ${auditCommand}`,
      `required checks: ${auditCommands.length}`,
      'latest-run is the most recent cycle snapshot, not proof that the maintenance pipeline is finished; trust it only after the evidence check passes.',
      renderOnlyTypeLabels.length ? `agent-only steps: ${renderOnlyTypeLabels.join(', ')}` : '',
    ].filter(Boolean).join('\n'))}</pre>
  `;
  openFmtModal({
    title: 'Prepare Agent Handoff',
    body,
    footer: [
      {
        label: 'Open Summary',
        disabled: !audit?.ok,
        onClick: () => {
          openFileInTab(summaryPath).catch(err => notifyFormatError('Agent Handoff', err));
        },
      },
      {
        label: 'Copy Audits',
        onClick: () => {
          navigator.clipboard?.writeText(auditCommands.join('\n')).catch(() => {});
        },
      },
      {
        label: 'Copy Prompt',
        primary: true,
        onClick: () => {
          navigator.clipboard?.writeText(launchPrompt).catch(() => {});
        },
      },
      { label: 'Close', onClick: closeFmtModal },
    ],
  });
}

async function requestRunbookApproval(runbookPath, validation) {
  const context = await buildRunbookContextEstimate(runbookPath, validation);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (decision) => {
      if (settled) return;
      settled = true;
      closeFmtModal();
      resolve(decision);
    };
    const body = document.createElement('div');
    body.className = 'runbook-modal-body';
    body.innerHTML = `
      <p>Allow one local MVP run for <strong>${escapeHtml(runbookRelativePath(runbookPath))}</strong>.</p>
      <pre class="runbook-context-preview">${escapeHtml([
        `target: ${runbookRelativePath(runbookPath)}`,
        'action: provider-send gated local run',
        'scope: this run only',
        `included files: ${context.included.map(item => runbookRelativePath(item.path)).join(', ') || '(none)'}`,
        `excluded/redacted: ${context.excluded.map(item => runbookRelativePath(item.path)).join(', ') || '(none)'}`,
        'commands/MCP/URL/file writes outside the run evidence folder: not executed by this MVP step',
      ].join('\n'))}</pre>
    `;
    openFmtModal({
      title: 'Allow Local Run',
      body,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve({ allowed: false, reason: 'Permission modal closed.' });
        }
      },
      footer: [
        {
          label: 'Decline',
          onClick: () => finish({ allowed: false, reason: 'User declined local run permission.' }),
        },
        {
          label: 'Allow Once',
          primary: true,
          onClick: () => finish({
            allowed: true,
            action: 'provider-send',
            scope: 'run',
            target: runbookRelativePath(runbookPath),
          }),
        },
      ],
    });
  });
}

function renderRunRecordPanel(record = lastRunRecord) {
  if (!record) return '';
  const events = record.events || [];
  const runStatus = record.run?.status || 'created';
  const runLabel = machineRunDisplayLabel(record.run || {});
  return `
    <section class="runbook-panel-section">
      <h3>Replay</h3>
      <div class="runbook-chip-row">
        <span class="runbook-chip ${escapeHtml(machineStatusChipClass(runStatus))}" title="${escapeHtml(`Status: ${machineLifecycleStatusLabel(runStatus)}`)}">${escapeHtml(machineLifecycleStatusLabel(runStatus))}</span>
        <span class="runbook-chip">${escapeHtml(runLabel)}</span>
      </div>
      <div class="runbook-replay-events">
        ${events.slice(0, 12).map(event => `<div class="runbook-event">${escapeHtml(event.timestamp || '')} ${escapeHtml(event.type || '')}</div>`).join('') || '<div class="runbook-event">No events recorded.</div>'}
      </div>
    </section>
  `;
}

function machineEventLabel(event) {
  const type = event?.eventType || event?.type || '';
  const payload = event?.payload || {};
  switch (type) {
    case 'run.created':
      return 'Run started';
    case 'run.status': {
      const status = event?.toState || payload.toState || payload.lifecycleStatus || payload.status;
      return status ? `Status changed to ${machineLifecycleStatusLabel(status)}` : 'Status updated';
    }
    case 'run.summary': {
      const status = payload.summaryStatus || event?.summaryStatus;
      return status ? `Summary updated to ${machineSummaryStatusLabel(status)}` : 'Summary updated';
    }
    case 'adapter.requested':
      return 'Agent request prepared';
    case 'adapter.result':
      return 'Agent response accepted';
    case 'worker.result':
      return String(payload.status || '').toLowerCase() === 'blocked'
        ? 'Work needs review'
        : 'Work completed';
    case 'queue.dedupe':
      return 'Duplicate work skipped';
    case 'queue.transition': {
      const state = payload.toState || event?.toState;
      return machineQueueTransitionEventLabel(state);
    }
    case 'artifact.registered':
      return 'Evidence file saved';
    case 'patch.applied':
      return 'Patch applied';
    case 'patch.review_skipped':
      return 'Patch kept as evidence';
    case 'patch.apply_failed':
      return 'Patch apply blocked';
    case 'approval.requested':
      return 'Permission requested';
    case 'approval.decided': {
      const decision = payload.decision || event?.decision || payload.status;
      return decision ? `Permission ${machinePermissionDecisionLabel(decision)}` : 'Permission decided';
    }
    case 'claim.lease-created':
      return 'Work started';
    case 'claim.heartbeat':
      return 'Work still running';
    case 'claim.lease-released':
      return 'Work reservation released';
    case 'write-set.acquired':
      return 'Files reserved';
    case 'write-set.released':
      return 'File reservation released';
    case 'node.scheduled':
      return 'Step scheduled';
    case 'node.started':
      return 'Step started';
    case 'node.completed':
      return 'Step completed';
    case 'node.failed':
      return 'Step failed';
    case 'node.skipped':
      return 'Step skipped';
    case 'node.blocked':
      return 'Step blocked';
    default:
      return type.replace(/[._-]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase()) || 'Event recorded';
  }
}

function machineEventTimeLabel(event) {
  return machineRunDateLabel(event?.timestamp) || '';
}

function machineWorkStateLabel(value) {
  const state = String(value || '').trim().toLowerCase();
  const labels = {
    queued: 'ready',
    claimed: 'in progress',
    blocked: 'stopped',
    done: 'completed',
  };
  return labels[state] || state.replace(/[._-]+/g, ' ') || 'unknown';
}

function machineQueueTransitionEventLabel(state) {
  const normalized = String(state || '').trim().toLowerCase();
  const labels = {
    queued: 'Work is ready',
    claimed: 'Work started',
    blocked: 'Work stopped',
    done: 'Work completed',
  };
  return labels[normalized] || (normalized ? `Work updated to ${machineWorkStateLabel(normalized)}` : 'Work updated');
}

function machineWorkInProgressLabel(count) {
  return `${machineCountLabel(count, 'work item')} in progress`;
}

function machineLatestWorkerEvent(record) {
  return record?.worker?.event || latestMachineEvent(record?.events, 'worker.result');
}

function machineWorkerResultState(record) {
  const event = machineLatestWorkerEvent(record);
  if (!event) return 'warn';
  const status = String(event.payload?.status || '').toLowerCase();
  if (['blocked', 'failed', 'rejected'].includes(status)) return 'warn';
  return 'good';
}

function machineWorkerStatusLabel(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'blocked') return 'review needed';
  if (value === 'done') return 'done';
  if (value === 'failed') return 'failed';
  return status || 'worker result';
}

function machineLatestWorkerSummary(record) {
  return latestMachineEvent(record?.events, 'run.summary', event => (
    event?.reason === 'worker-result.accepted'
    || event?.payload?.workerStatus
    || event?.payload?.itemId
  ));
}

function machineWorkerSummaryForEvent(record, workerEvent) {
  if (!workerEvent) return null;
  return latestMachineEvent(record?.events, 'run.summary', event => (
    event?.reason === 'worker-result.accepted'
    && (!workerEvent.itemId || event?.payload?.itemId === workerEvent.itemId)
  )) || machineLatestWorkerSummary(record);
}

function machineLatestPartialArtifactContract(record) {
  return latestMachineEvent(record?.events, 'node.completed', event => {
    const payload = event?.payload || {};
    return payload.nodeType === 'orpad.artifactContract'
      && ((Number(payload.missingArtifactCount) || 0) > 0 || (Number(payload.missingQueueCount) || 0) > 0);
  });
}

function machineWorkerReviewInfo(record) {
  const event = machineLatestWorkerEvent(record);
  return machineWorkerReviewInfoForEvent(record, event);
}

const MACHINE_PATCH_DECISION_EVENT_TYPES = [
  'patch.applied',
  'patch.review_skipped',
  'patch.approved',
  'patch.apply_conflict',
  'patch.apply_failed',
];

const MACHINE_PATCH_RESOLVED_EVENT_TYPES = ['patch.applied', 'patch.review_skipped'];

const MACHINE_PATCH_STATUS_BY_EVENT = {
  'patch.applied': 'applied',
  'patch.review_skipped': 'skipped',
  'patch.approved': 'approved',
  'patch.apply_conflict': 'conflict',
  'patch.apply_failed': 'failed',
};

function machinePatchReviewDecisionForArtifact(record, patchArtifact) {
  const artifact = String(patchArtifact || '').trim();
  if (!artifact) return null;
  return [...(record?.events || [])].reverse().find(event => (
    MACHINE_PATCH_DECISION_EVENT_TYPES.includes(event?.eventType)
    && event?.payload?.patchArtifact === artifact
  )) || null;
}

function machinePatchBatchInFlight(record) {
  let started = null;
  let finished = null;
  for (const event of record?.events || []) {
    if (event?.eventType === 'patches.apply_started') started = event;
    else if (event?.eventType === 'patches.apply_finished') finished = event;
  }
  if (!started) return false;
  if (!finished) return true;
  return (finished.sequence ?? 0) < (started.sequence ?? 0);
}

function machineHasBlockedPatchReviewNode(record) {
  const latestByPath = new Map();
  for (const event of record?.events || []) {
    if (!String(event?.eventType || '').startsWith('node.')) continue;
    if (!event?.nodePath) continue;
    latestByPath.set(event.nodePath, event);
  }
  return [...latestByPath.values()].some(event => (
    event?.eventType === 'node.blocked'
    && event?.payload?.nodeType === 'orpad.patchReview'
  ));
}

function machineWorkerReviewInfoForEvent(record, event) {
  if (!event) return null;
  const payload = event.payload || {};
  const verification = payload.verification || [];
  const patchArtifact = payload.patchArtifact || '';
  const patchReviewDecision = machinePatchReviewDecisionForArtifact(record, patchArtifact);
  const decisionType = patchReviewDecision?.eventType || '';
  const patchReviewStatus = MACHINE_PATCH_STATUS_BY_EVENT[decisionType] || 'pending';
  const patchReviewResolved = MACHINE_PATCH_RESOLVED_EVENT_TYPES.includes(decisionType);
  return {
    event,
    itemId: event.itemId || '',
    status: String(payload.status || ''),
    patchArtifact,
    patchReviewDecision,
    patchReviewStatus,
    patchReviewResolved,
    patchReviewSelectedFiles: Array.isArray(patchReviewDecision?.payload?.selectedFiles)
      ? patchReviewDecision.payload.selectedFiles
      : [],
    patchReviewMismatches: Array.isArray(patchReviewDecision?.payload?.mismatches)
      ? patchReviewDecision.payload.mismatches
      : [],
    changedFiles: payload.changedFiles || [],
    evidenceArtifacts: event.artifactRefs || [],
    missingExpectedChanges: [...new Set(verification.flatMap(item => item.missingExpectedChanges || []))],
    message: machineWorkerSummaryForEvent(record, event)?.payload?.message || '',
  };
}

function machineWorkerReviewInfos(record) {
  return (record?.events || [])
    .filter(event => event?.eventType === 'worker.result')
    .map(event => machineWorkerReviewInfoForEvent(record, event))
    .filter(Boolean);
}

function machineRunAttentionDetails(record) {
  if (!record) return '';
  const notices = [];
  const workerReview = machineWorkerReviewInfo(record);
  const workerStatus = String(workerReview?.status || '').toLowerCase();
  if (workerReview?.patchArtifact && !workerReview.patchReviewResolved && workerReview.changedFiles.length && workerStatus !== 'blocked') {
    notices.push({
      state: 'warning',
      title: 'Patch ready',
      text: `${machineCountLabel(workerReview.changedFiles.length, 'changed file')} staged in run evidence. Review Patch to apply selected files or cancel to keep evidence only.`,
    });
  } else if (workerStatus === 'blocked' && !workerReview?.patchReviewResolved) {
    notices.push({
      state: 'warning',
      title: 'Review required',
      text: [
        workerReview.changedFiles.length
          ? `${machineCountLabel(workerReview.changedFiles.length, 'changed file')} staged in run evidence; workspace files were not changed.`
          : 'Work stopped before producing an applicable workspace change.',
        workerReview.patchArtifact ? `Patch evidence: ${workerReview.patchArtifact}.` : '',
        workerReview.missingExpectedChanges.length
          ? `Missing expected change: ${workerReview.missingExpectedChanges.slice(0, 3).join(', ')}${workerReview.missingExpectedChanges.length > 3 ? `, +${workerReview.missingExpectedChanges.length - 3} more` : ''}.`
          : '',
        workerReview.message || '',
      ].filter(Boolean).join(' '),
    });
  }
  const contract = machineLatestPartialArtifactContract(record)?.payload || null;
  if (contract) {
    const missingArtifacts = Number(contract.missingArtifactCount) || 0;
    const missingQueue = Number(contract.missingQueueCount) || 0;
    notices.push({
      state: 'warning',
      title: 'Evidence incomplete',
      text: [
        missingArtifacts ? `${machineCountLabel(missingArtifacts, 'required evidence file')} missing` : '',
        missingQueue ? `${machineCountLabel(missingQueue, 'required queue file')} missing` : '',
        'Save and review evidence before treating this run as complete.',
      ].filter(Boolean).join('; '),
    });
  }
  return notices.map(notice => `
    <div class="runbook-diagnostic ${escapeHtml(notice.state)}">
      <strong>${escapeHtml(notice.title)}</strong> ${escapeHtml(notice.text)}
    </div>
  `).join('');
}

function machineFailureDetails(record) {
  if (!record || record.success !== false) return '';
  const failure = record.failure || {};
  const failedNodes = (record.events || [])
    .filter(event => event?.eventType === 'node.failed')
    .map(event => event.nodePath || event.payload?.nodePath || '')
    .filter(Boolean);
  const contract = failure.contract
    ? `Required evidence missing: ${machineCountLabel(failure.contract.missingArtifactCount, 'evidence file')}, ${machineCountLabel(failure.contract.missingQueueCount, 'queue file')}.`
    : '';
  const gate = failure.gate
    ? `Gate failed: ${(failure.gate.failed || []).map(item => item.criterion).filter(Boolean).join(', ') || 'criteria unmet'}.`
    : '';
  const barrier = failure.barrier
    ? `Barrier failed: ${(failure.barrier.dependencies || []).filter(item => !item.completed).map(item => item.nodePath).join(', ') || 'dependency incomplete'}.`
    : '';
  return `
    <div class="runbook-diagnostic error">
      ${escapeHtml([record.code || 'MACHINE_EXECUTION_FAILED', record.error || '', contract, gate, barrier]
        .filter(Boolean)
        .join('\n'))}
    </div>
    ${failedNodes.length ? `
      <div class="runbook-chip-row">
        ${failedNodes.slice(0, 4).map(nodePath => `<span class="runbook-chip danger">${escapeHtml(nodePath)}</span>`).join('')}
      </div>
    ` : ''}
  `;
}

function machineCountLabel(count, singular, plural = `${singular}s`) {
  const value = Number(count) || 0;
  return `${value} ${value === 1 ? singular : plural}`;
}

function machineStatusFallbackLabel(status) {
  return String(status || 'unknown')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Unknown';
}

function machineLifecycleStatusLabel(status) {
  const labels = {
    created: 'Ready',
    running: 'Running',
    waiting: 'Waiting',
    completed: 'Complete',
    done: 'Complete',
    failed: 'Failed',
    cancelled: 'Cancelled',
    canceled: 'Cancelled',
    blocked: 'Blocked',
    'approval-required': 'Needs permission',
    approval_required: 'Needs permission',
  };
  return labels[String(status || '').toLowerCase()] || machineStatusFallbackLabel(status);
}

function machineSummaryStatusLabel(status) {
  const labels = {
    pending: 'Needs evidence',
    partial: 'Partial proof',
    done: 'Proof complete',
    completed: 'Proof complete',
    blocked: 'Blocked',
    failed: 'Failed',
    'approval-required': 'Needs permission',
    approval_required: 'Needs permission',
  };
  return labels[String(status || '').toLowerCase()] || machineStatusFallbackLabel(status);
}

function machinePermissionDecisionLabel(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'approved') return 'allowed';
  if (value === 'denied') return 'declined';
  return machineStatusFallbackLabel(status);
}

function machineStatusChipClass(status, kind = 'lifecycle') {
  const value = String(status || '').toLowerCase();
  if (['failed', 'cancelled', 'canceled', 'blocked'].includes(value)) return 'danger';
  if (['running', 'waiting', 'pending', 'partial', 'approval-required', 'approval_required'].includes(value)) return 'warn';
  if (['created', 'completed', 'done', 'success'].includes(value)) return 'good';
  return kind === 'summary' ? 'warn' : '';
}

function machineDisplayStatus(record, runInProgress) {
  const runState = record?.runState || {};
  const workerReview = machineWorkerReviewInfo(record);
  const workerStatus = String(workerReview?.status || '').toLowerCase();
  const incompleteEvidence = !!machineLatestPartialArtifactContract(record);
  const lifecycleValue = String(runState.lifecycleStatus || '').toLowerCase();
  const summaryValue = String(runState.summaryStatus || '').toLowerCase();
  const needsReview = (!!workerReview?.patchArtifact && !workerReview.patchReviewResolved)
    || workerStatus === 'blocked'
    || summaryValue === 'blocked'
    || (workerReview?.missingExpectedChanges || []).length > 0;
  if (!runInProgress && ['cancelled', 'canceled'].includes(String(runState.lifecycleStatus || '').toLowerCase())) {
    return {
      lifecycleLabel: 'Cancelled',
      lifecycleClass: 'danger',
      lifecycleTitle: 'Lifecycle: Cancelled',
      summaryLabel: 'Stopped',
      summaryClass: 'danger',
      summaryTitle: `Summary: ${machineSummaryStatusLabel(runState.summaryStatus || 'blocked')}`,
    };
  }
  if (!runInProgress && lifecycleValue === 'waiting') {
    const lifecycleStatus = runState.lifecycleStatus || 'waiting';
    if (needsReview || incompleteEvidence || ['partial', 'blocked'].includes(summaryValue)) {
      return {
        lifecycleLabel: needsReview ? 'Review needed' : (incompleteEvidence ? 'Evidence incomplete' : 'Ready to continue'),
        lifecycleClass: 'warn',
        lifecycleTitle: `Lifecycle: ${machineLifecycleStatusLabel(lifecycleStatus)}`,
        summaryLabel: incompleteEvidence ? 'Evidence incomplete' : (needsReview ? 'Review required' : machineSummaryStatusLabel(runState.summaryStatus || 'partial')),
        summaryClass: 'warn',
        summaryTitle: `Summary: ${machineSummaryStatusLabel(runState.summaryStatus || 'partial')}`,
      };
    }
    return {
      lifecycleLabel: 'Ready to continue',
      lifecycleClass: 'warn',
      lifecycleTitle: `Lifecycle: ${machineLifecycleStatusLabel(lifecycleStatus)}`,
      summaryLabel: machineSummaryStatusLabel(runState.summaryStatus || 'pending'),
      summaryClass: machineStatusChipClass(runState.summaryStatus || 'pending', 'summary'),
      summaryTitle: `Summary: ${machineSummaryStatusLabel(runState.summaryStatus || 'pending')}`,
    };
  }
  const lifecycleStatus = runInProgress ? 'running' : (runState.lifecycleStatus || 'created');
  const summaryStatus = runState.summaryStatus || 'pending';
  return {
    lifecycleLabel: machineLifecycleStatusLabel(lifecycleStatus),
    lifecycleClass: machineStatusChipClass(lifecycleStatus),
    lifecycleTitle: `Lifecycle: ${machineLifecycleStatusLabel(lifecycleStatus)}`,
    summaryLabel: machineSummaryStatusLabel(summaryStatus),
    summaryClass: machineStatusChipClass(summaryStatus, 'summary'),
    summaryTitle: `Summary: ${machineSummaryStatusLabel(summaryStatus)}`,
  };
}

function machineRunDateLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const currentYear = new Date().getFullYear();
  const year = date.getFullYear() === currentYear ? '' : ` ${date.getFullYear()}`;
  return `${months[date.getMonth()]} ${date.getDate()}${year}, ${hours}:${minutes}`;
}

function machineRunLabelFromId(runId) {
  const text = String(runId || '').trim();
  const timestamp = text.match(/^(?:run_)?(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_|$)/);
  if (timestamp) {
    const [, year, month, day, hour, minute, second] = timestamp;
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
    return machineRunDateLabel(parsed);
  }
  const acronyms = new Set(['ai', 'api', 'id', 'ipc', 'mcp', 'mvp', 'ui', 'url', 'ux']);
  return text.replace(/^run[_-]?/i, '')
    .split(/[_\-.]+/)
    .filter(Boolean)
    .map(part => (acronyms.has(part.toLowerCase())
      ? part.toUpperCase()
      : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ') || 'Run';
}

function machineRunDisplayLabel(run = {}) {
  const runId = typeof run === 'string' ? run : run.runId;
  return machineRunDateLabel(run.createdAt || run.updatedAt) || machineRunLabelFromId(runId);
}

function latestMachineEvent(events, eventType, predicate = () => true) {
  return [...(events || [])].reverse().find(event => (
    event?.eventType === eventType
    && predicate(event)
  )) || null;
}

function machineCandidateInventoryDetails(record) {
  const inventory = record?.candidateInventory || null;
  if (inventory) {
    const emptyPassCount = Number(inventory.emptyPassCount) || 0;
    return [
      `${machineCountLabel(inventory.candidateCount, 'work item')} found`,
      emptyPassCount ? `${machineCountLabel(emptyPassCount, 'scan')} found no work` : '',
      inventory.artifactPath ? 'Discovery evidence saved' : '',
    ].filter(Boolean).join(', ');
  }
  const event = latestMachineEvent(record?.events, 'artifact.registered', item => (
    item.payload?.file?.schemaVersion === 'orpad.machineCandidateInventory.v1'
    || item.payload?.file?.producedBy === 'orpad.machine.candidate-inventory'
  ));
  return event?.payload?.file?.path ? 'Discovery evidence saved' : 'No work discovery yet';
}

function machineWorkerProofDetails(record) {
  const workerEvents = (record?.events || []).filter(event => event?.eventType === 'worker.result');
  const event = workerEvents[workerEvents.length - 1] || null;
  if (!event) return 'No work result yet';
  if (workerEvents.length > 1) {
    const evidenceCount = workerEvents.reduce((sum, item) => sum + (item.artifactRefs || []).length, 0);
    const checkCount = workerEvents.reduce((sum, item) => sum + (item.payload?.verification || []).length, 0);
    const changedFileCount = workerEvents.reduce((sum, item) => sum + (item.payload?.changedFiles || []).length, 0);
    return [
      machineCountLabel(workerEvents.length, 'work result'),
      machineCountLabel(evidenceCount, 'evidence file'),
      machineCountLabel(checkCount, 'check'),
      machineCountLabel(changedFileCount, 'changed file'),
    ].filter(Boolean).join('; ');
  }
  const payload = event.payload || {};
  const artifacts = event.artifactRefs || [];
  const verification = payload.verification || [];
  const changedFiles = payload.changedFiles || [];
  return [
    machineWorkerStatusLabel(payload.status),
    machineCountLabel(artifacts.length, 'evidence file'),
    machineCountLabel(verification.length, 'check'),
    machineCountLabel(changedFiles.length, 'changed file'),
  ].filter(Boolean).join('; ');
}

function machineNodeCompletionDetails(record) {
  const completed = (record?.events || []).filter(event => event?.eventType === 'node.completed');
  return completed.length ? `${machineCountLabel(completed.length, 'step')} completed` : 'No steps completed yet';
}

function machineApprovalDetails(record) {
  const approvals = record?.approvals || {};
  const pending = approvals.pending || [];
  if (pending.length) {
    const names = pending
      .map(item => item.itemId || item.approvalId || '')
      .filter(Boolean)
      .slice(0, 3)
      .join(', ');
    return `${machineCountLabel(pending.length, 'permission request')} waiting${names ? `: ${names}` : ''}`;
  }
  const decisions = (approvals.all || []).filter(item => item.status && item.status !== 'requested');
  if (decisions.length) {
    return `${machineCountLabel(decisions.length, 'permission decision')}: ${decisions.map(item => machinePermissionDecisionLabel(item.status)).join(', ')}`;
  }
  return 'No permission needed';
}

function machineActiveClaimDetails(record) {
  const activeClaims = record?.activeClaims || [];
  if (!activeClaims.length) return 'No work in progress';
  const first = activeClaims[0];
  const label = first.itemId || '';
  return `${machineWorkInProgressLabel(activeClaims.length)}${label ? `: ${label}` : ''}`;
}

function machineActiveWriteSetDetails(record) {
  const activeWriteSets = record?.activeWriteSets || [];
  if (!activeWriteSets.length) return 'No reserved files';
  const first = activeWriteSets[0];
  const paths = (first.paths || [])
    .slice(0, 3)
    .join(', ');
  const fileCount = activeWriteSets.reduce((sum, item) => sum + Math.max(1, (item.paths || []).length), 0);
  const more = fileCount > 3 ? `, +${fileCount - 3} more` : '';
  return `${machineCountLabel(fileCount || activeWriteSets.length, 'reserved file')}${paths ? `: ${paths}${more}` : ''}`;
}

function machineAuditDetails(record) {
  const runRoot = record?.runRoot || '';
  const exportRoot = record?.exported?.targetRoot
    || record?.exported?.latestRunExportPath
    || '';
  if (!runRoot) {
    return { state: 'warn', text: 'Check unavailable' };
  }
  if (!exportRoot) {
    return { state: 'warn', text: 'Save evidence before checking' };
  }
  return {
    state: 'good',
    text: 'Evidence ready for review',
  };
}

function machineArtifactManifestFiles(record) {
  const exportedFiles = record?.exported?.metadata?.artifactManifest?.files;
  if (Array.isArray(exportedFiles)) {
    return exportedFiles
      .filter(file => file?.path)
      .map(file => ({ ...file }))
      .sort((a, b) => String(a.path).localeCompare(String(b.path)));
  }
  const filesByPath = new Map();
  for (const event of record?.events || []) {
    if (event?.eventType !== 'artifact.registered') continue;
    const file = event.payload?.file;
    if (!file?.path) continue;
    filesByPath.set(file.path, { ...file });
  }
  return [...filesByPath.values()]
    .sort((a, b) => String(a.path).localeCompare(String(b.path)));
}

function machineArtifactManifestSource(record) {
  return Array.isArray(record?.exported?.metadata?.artifactManifest?.files)
    ? 'saved evidence'
    : 'run events';
}

function machineArtifactSummary(record) {
  const files = machineArtifactManifestFiles(record);
  if (!files.length) return 'No evidence files yet';
  const preview = files
    .slice(0, 3)
    .map(file => file.path)
    .filter(Boolean)
    .join(', ');
  const more = files.length > 3 ? `, +${files.length - 3} more` : '';
  return `${machineCountLabel(files.length, 'file')} from ${machineArtifactManifestSource(record)}${preview ? `: ${preview}${more}` : ''}`;
}

function machineQueueInventorySummary(inventory) {
  const counts = inventory?.counts || {};
  const labels = ['queued', 'claimed', 'blocked', 'done']
    .map(state => counts[state] ? `${counts[state]} ${machineWorkStateLabel(state)}` : '')
    .filter(Boolean);
  return labels.length ? labels.join(', ') : 'no work state';
}

function machineRunStatusLabel(runState) {
  return [runState?.lifecycleStatus, runState?.summaryStatus]
    .filter(Boolean)
    .join('/');
}

function machineStaleActiveClaims(record) {
  const now = Date.now();
  return (record?.activeClaims || []).filter(claim => {
    const expiresAt = Date.parse(claim?.expiresAt || '');
    return !Number.isFinite(expiresAt) || expiresAt <= now;
  });
}

function machineHasOnlyStaleActiveClaims(record) {
  const activeClaims = record?.activeClaims || [];
  return activeClaims.length > 0 && machineStaleActiveClaims(record).length === activeClaims.length;
}

function machineRunActionKey(runbookPath, runId) {
  return `${runbookNormalizePath(runbookPath).toLowerCase()}::${runId || ''}`;
}

function stopMachineRunProgressPollingByKey(key) {
  const timer = machineRunProgressTimers.get(key);
  if (!timer) return;
  clearInterval(timer);
  machineRunProgressTimers.delete(key);
}

function clearMachineRunProgressState() {
  for (const key of [...machineRunProgressTimers.keys()]) {
    stopMachineRunProgressPollingByKey(key);
  }
  machineRunStartPendingPaths.clear();
  machineRunPendingActions.clear();
}

function setMachineRunStartPending(runbookPath, pending) {
  if (!runbookPath) return;
  const key = runbookNormalizePath(runbookPath).toLowerCase();
  if (pending) {
    machineRunStartPendingPaths.add(key);
  } else {
    machineRunStartPendingPaths.delete(key);
  }
  rerenderPipelinePreviewIfActive(runbookPath);
}

function setMachineRunActionPending(runbookPath, runId, pending) {
  if (!runbookPath || !runId) return;
  const key = machineRunActionKey(runbookPath, runId);
  const previous = machineRunPendingActions.get(key) || 0;
  if (pending) {
    machineRunPendingActions.set(key, previous + 1);
    return;
  }
  const next = Math.max(previous - 1, 0);
  if (next === 0) {
    machineRunPendingActions.delete(key);
    stopMachineRunProgressPollingByKey(key);
    return;
  }
  machineRunPendingActions.set(key, next);
}

function isMachineRunActionPending(runbookPath, runId) {
  if (!runbookPath || !runId) return false;
  return (machineRunPendingActions.get(machineRunActionKey(runbookPath, runId)) || 0) > 0;
}

function machineActiveNodeExecutions(record) {
  const active = new Map();
  for (const event of record?.events || []) {
    const type = String(event?.eventType || '');
    const nodeExecutionId = event?.payload?.nodeExecutionId
      || event?.nodeExecutionId
      || event?.nodePath
      || event?.nodeId
      || '';
    if (!nodeExecutionId) continue;
    if (type === 'node.started') {
      active.set(nodeExecutionId, event);
    } else if (['node.completed', 'node.failed', 'node.blocked', 'node.skipped'].includes(type)) {
      active.delete(nodeExecutionId);
    }
  }
  return [...active.values()];
}

function machineNodeRuntimeStatusFromEvent(event) {
  const type = String(event?.eventType || '');
  const reason = String(event?.payload?.reason || event?.reason || '');
  switch (type) {
    case 'node.scheduled':
      return { state: 'queued', label: 'Queued' };
    case 'node.started':
      return { state: 'running', label: 'Running' };
    case 'node.completed':
      return { state: 'completed', label: 'Done' };
    case 'node.blocked':
      if (reason === 'exit.evidence-incomplete') return { state: 'blocked', label: 'Evidence incomplete' };
      return { state: 'blocked', label: 'Blocked' };
    case 'node.failed':
      return { state: 'failed', label: 'Failed' };
    case 'node.skipped':
      return { state: 'skipped', label: 'Skipped' };
    default:
      return null;
  }
}

function machineRuntimeNodeExecutionKey(event) {
  return event?.payload?.nodeExecutionId
    || event?.nodeExecutionId
    || `${event?.nodePath || ''}:attempt-${event?.payload?.attempt || 1}`;
}

function machineRuntimeNodeProjection(record) {
  const statuses = new Map();
  const events = record?.events || [];
  let cancelSequence = null;
  for (const event of events) {
    if (
      event?.eventType === 'run.status'
      && ['cancelled', 'canceled'].includes(String(event?.toState || event?.payload?.toState || '').toLowerCase())
    ) {
      cancelSequence = event.sequence;
    }
  }
  for (const event of events) {
    if (cancelSequence != null && Number(event?.sequence) > Number(cancelSequence)) continue;
    const type = String(event?.eventType || '');
    if (!type.startsWith('node.')) continue;
    const nodePath = String(event?.nodePath || '').trim();
    if (!nodePath) continue;
    const status = machineNodeRuntimeStatusFromEvent(event);
    if (!status) continue;
    const sequence = Number(event?.sequence) || 0;
    statuses.set(nodePath, {
      ...status,
      nodePath,
      sequence,
      eventType: type,
      nodeExecutionId: machineRuntimeNodeExecutionKey(event),
      title: `${status.label}: ${nodePath}`,
    });
  }
  const lifecycle = String(record?.runState?.lifecycleStatus || '').toLowerCase();
  if (['cancelled', 'canceled'].includes(lifecycle)) {
    for (const [nodePath, status] of statuses.entries()) {
      if (status.state !== 'running') continue;
      statuses.set(nodePath, {
        ...status,
        state: 'cancelled',
        label: 'Stopped',
        title: `Stopped: ${nodePath}`,
      });
    }
  }
  return statuses;
}

function machineRuntimeGraphKeyCandidates(context, graphDoc) {
  const keys = [];
  const add = (value) => {
    const key = String(value || '').trim();
    if (key && !keys.includes(key)) keys.push(key);
  };
  const activeRelativePath = runbookNormalizePath(context?.activeRelativePath || '');
  const fileName = activeRelativePath.split('/').pop() || '';
  add(fileName.replace(/\.or-graph$/i, ''));
  add(graphDoc?.graph?.id);
  add(graphDoc?.id);
  add('main');
  add(context?.pipelineName);
  return keys;
}

function machineRuntimeGraphRefKeyCandidates(graphRef) {
  const normalized = runbookNormalizePath(graphRef || '');
  const fileName = normalized.split('/').pop() || '';
  const withoutExt = fileName.replace(/\.or-graph$/i, '');
  return [...new Set([
    withoutExt,
    fileName,
    normalized.replace(/\.or-graph$/i, ''),
    normalized,
  ].map(value => String(value || '').trim()).filter(Boolean))];
}

function machineRuntimeAggregateGraphStatus(item, runProjection) {
  if (item?.node?.type !== 'orpad.graph' || !runProjection?.statuses?.size) return null;
  const candidates = machineRuntimeGraphRefKeyCandidates(item.node?.config?.graphRef || item.node?.graphRef || '');
  if (!candidates.length) return null;
  const childStatuses = [...runProjection.statuses.entries()]
    .filter(([nodePath]) => candidates.some(graphKey => nodePath.startsWith(`${graphKey}/`)))
    .map(([, status]) => status);
  if (!childStatuses.length) return null;
  const hasState = state => childStatuses.some(status => status.state === state);
  const childPath = candidates.find(graphKey => childStatuses.some(status => status.nodePath?.startsWith(`${graphKey}/`))) || candidates[0];
  if (hasState('running') || hasState('queued')) {
    return {
      state: 'running',
      label: 'Running',
      nodePath: childPath,
      title: `Running inside ${item.node?.label || item.node?.id || childPath}`,
    };
  }
  if (hasState('failed')) {
    return {
      state: 'failed',
      label: 'Failed',
      nodePath: childPath,
      title: `Failed inside ${item.node?.label || item.node?.id || childPath}`,
    };
  }
  if (hasState('blocked')) {
    return {
      state: 'blocked',
      label: 'Blocked',
      nodePath: childPath,
      title: `Blocked inside ${item.node?.label || item.node?.id || childPath}`,
    };
  }
  if (hasState('cancelled')) {
    return {
      state: 'cancelled',
      label: 'Stopped',
      nodePath: childPath,
      title: `Stopped inside ${item.node?.label || item.node?.id || childPath}`,
    };
  }
  return null;
}

function machineRunRecordForPipelinePath(runbookPath) {
  if (!runbookPath) return null;
  const selectedMatches = runbookNormalizePath(selectedRunbookPath).toLowerCase() === runbookNormalizePath(runbookPath).toLowerCase();
  return getRunbookCache(machineRunRecordCache, runbookPath) || (selectedMatches ? lastMachineRunRecord : null);
}

const MACHINE_QUEUE_TERMINAL_STATES = ['done', 'blocked', 'skipped', 'cancelled', 'partial'];
const MACHINE_PROGRESS_TERMINAL_STATES = ['completed', 'failed', 'blocked', 'skipped', 'cancelled'];

function machineQueueProgressFromEvents(record) {
  const events = record?.events || [];
  if (!events.length) return null;
  const itemOrder = [];
  const seen = new Set();
  const itemStates = new Map();
  for (const event of events) {
    if (event?.eventType !== 'queue.transition' || !event.itemId) continue;
    if (!seen.has(event.itemId)) {
      seen.add(event.itemId);
      itemOrder.push(event.itemId);
    }
    itemStates.set(event.itemId, event.toState);
  }
  if (!itemStates.size) return null;
  const total = itemStates.size;
  let done = 0;
  let active = 0;
  const steps = itemOrder.map(itemId => {
    const state = itemStates.get(itemId);
    if (MACHINE_QUEUE_TERMINAL_STATES.includes(state)) {
      done += 1;
      return { state: 'completed', label: itemId };
    }
    if (state === 'claimed') {
      active += 1;
      return { state: 'running', label: itemId };
    }
    return { state: 'queued', label: itemId };
  });
  return {
    pattern: 'queue',
    total,
    done,
    active,
    percent: Math.round((done / total) * 100),
    steps,
  };
}

function machineParallelProgressFromStatuses(childStatuses) {
  const distinct = new Map();
  for (const status of childStatuses) {
    if (!status?.nodePath) continue;
    const existing = distinct.get(status.nodePath);
    if (!existing || (Number(status.sequence) || 0) > (Number(existing.sequence) || 0)) {
      distinct.set(status.nodePath, status);
    }
  }
  const total = distinct.size;
  if (!total) return null;
  let done = 0;
  let active = 0;
  const steps = [];
  for (const status of distinct.values()) {
    const state = String(status.state || '');
    if (MACHINE_PROGRESS_TERMINAL_STATES.includes(state)) {
      done += 1;
      steps.push({ state: state === 'failed' ? 'failed' : 'completed', label: status.nodePath });
    } else if (state === 'running' || state === 'queued') {
      active += 1;
      steps.push({ state: 'running', label: status.nodePath });
    } else {
      steps.push({ state: 'queued', label: status.nodePath });
    }
  }
  return {
    pattern: 'parallel',
    total,
    done,
    active,
    percent: Math.round((done / total) * 100),
    steps,
  };
}

function machineNodeProgress(item, runProjection) {
  if (!runProjection?.statuses?.size) return null;
  if (item?.node?.type !== 'orpad.graph') return null;
  const graphRef = item.node?.config?.graphRef || item.node?.graphRef || '';
  const candidates = machineRuntimeGraphRefKeyCandidates(graphRef);
  if (!candidates.length) return null;
  const childStatuses = [...runProjection.statuses.entries()]
    .filter(([nodePath]) => candidates.some(key => nodePath.startsWith(`${key}/`)))
    .map(([nodePath, status]) => ({ nodePath, ...status }));
  if (!childStatuses.length) return null;
  const hasIteration = childStatuses.some(status => /\/(dispatcher|workerLoop|worker)$/.test(status.nodePath));
  if (hasIteration) {
    const queue = machineQueueProgressFromEvents(runProjection.record);
    if (queue && queue.total > 0) return queue;
  }
  return machineParallelProgressFromStatuses(childStatuses);
}

function renderMachineNodeProgressBadge(progress) {
  if (!progress || progress.total <= 1) return '';
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  const counter = `${progress.done}/${progress.total}`;
  const titleText = `${counter} (${percent}%)`;
  return `<div class="orch-node-progress-badge${progress.active > 0 ? ' active' : ''}" title="${escapeHtml(titleText)}">
      <span class="orch-node-progress-spinner" aria-hidden="true"></span>
      <span class="orch-node-progress-percent">${percent}%</span>
    </div>`;
}

const MACHINE_PROGRESS_STEP_ORDER = { completed: 0, failed: 1, running: 2, queued: 3 };

function renderMachineNodeProgressBar(progress) {
  if (!progress || progress.total <= 1) return '';
  const MAX_VISIBLE_STEPS = 40;
  // Sort segments by state so completed bunches at the start, running blinks in the middle,
  // and queued tails to the end. Without this the bar looks duty-cycled when the dispatcher
  // claims items out of enqueue order.
  const ordered = [...progress.steps].sort((a, b) => (
    (MACHINE_PROGRESS_STEP_ORDER[a.state] ?? 4) - (MACHINE_PROGRESS_STEP_ORDER[b.state] ?? 4)
  ));
  const steps = ordered.slice(0, MAX_VISIBLE_STEPS);
  const overflow = ordered.length - steps.length;
  const segments = steps.map(step => (
    `<span class="orch-node-progress-step state-${escapeHtml(step.state || 'queued')}" title="${escapeHtml(step.label || '')}"></span>`
  )).join('');
  const counter = overflow > 0
    ? `${progress.done}/${progress.total} (+${overflow} more)`
    : `${progress.done}/${progress.total}`;
  return `<div class="orch-node-progress-bar" aria-label="${escapeHtml(counter)}">${segments}</div>`;
}

function isPipelineMachineRunInProgress(runbookPath) {
  if (!runbookPath) return false;
  if (machineRunStartPendingPaths.has(runbookNormalizePath(runbookPath).toLowerCase())) return true;
  return isMachineRunInProgress(machineRunRecordForPipelinePath(runbookPath), runbookPath);
}

function machineRuntimeProjectionForGraph(context, graphDoc) {
  if (!context?.pipelinePath) return null;
  const record = machineRunRecordForPipelinePath(context.pipelinePath);
  const statuses = machineRuntimeNodeProjection(record);
  if (!statuses.size) return null;
  return {
    graphKeys: machineRuntimeGraphKeyCandidates(context, graphDoc),
    runInProgress: isMachineRunInProgress(record, context.pipelinePath),
    statuses,
    record,
  };
}

function machineRuntimeStatusForGraphNode(item, runProjection) {
  if (!runProjection?.statuses?.size) return null;
  const aggregate = machineRuntimeAggregateGraphStatus(item, runProjection);
  if (aggregate) return aggregate;
  const nodeId = String(item?.node?.id || '').trim();
  if (!nodeId) return null;
  const direct = runProjection.statuses.get(nodeId);
  if (direct) return direct;
  for (const graphKey of runProjection.graphKeys || []) {
    const nodePath = `${graphKey}/${nodeId}`;
    const status = runProjection.statuses.get(nodePath);
    if (status) return status;
  }
  const suffix = `/${nodeId}`;
  const matches = [...runProjection.statuses.entries()]
    .filter(([nodePath]) => nodePath.endsWith(suffix))
    .map(([, status]) => status);
  if (matches.length === 1) return matches[0];
  return null;
}

function machineRuntimeEdgeStatusFromNodes(sourceStatus, targetStatus, runProjection = null) {
  const sourceState = sourceStatus?.state || '';
  const targetState = targetStatus?.state || '';
  if (runProjection?.runInProgress && ['running', 'queued'].includes(targetState)) return { state: 'active' };
  if (targetState === 'cancelled' || sourceState === 'cancelled') return { state: 'muted' };
  if (['failed', 'blocked'].includes(targetState)) return { state: 'blocked' };
  if (sourceState === 'completed' && targetState === 'completed') return { state: 'completed' };
  return null;
}

function machineRuntimeStatusForGraphEdge(edge, source, target, runProjection) {
  if (!runProjection?.statuses?.size) return null;
  const sourceStatus = machineRuntimeStatusForGraphNode(source, runProjection);
  const targetStatus = machineRuntimeStatusForGraphNode(target, runProjection);
  return machineRuntimeEdgeStatusFromNodes(sourceStatus, targetStatus, runProjection);
}

function isMachineRunInProgress(record, runbookPath = selectedRunbookPath) {
  const runState = record?.runState || {};
  const runId = runState.runId || record?.runId || '';
  if (isMachineRunTerminal(runState)) return false;
  const activeNodes = machineActiveNodeExecutions(record);
  const activeClaims = record?.activeClaims || [];
  const freshActiveClaims = activeClaims.length - machineStaleActiveClaims(record).length;
  if (isMachineRunActionPending(runbookPath, runId)) {
    if (
      !activeNodes.length
      && freshActiveClaims <= 0
      && ['waiting', 'approval-required', 'completed', 'cancelled', 'canceled', 'failed'].includes(String(runState.lifecycleStatus || '').toLowerCase())
    ) {
      return false;
    }
    return true;
  }
  if (['running', 'cancelling'].includes(String(runState.lifecycleStatus || '').toLowerCase())) {
    return activeNodes.length > 0 || freshActiveClaims > 0;
  }
  return activeNodes.length > 0;
}

function machineUpdateRunRecord(runbookPath, record) {
  if (!record) return null;
  const runId = record.runState?.runId || record.runId || '';
  const selectedMatches = !selectedRunbookPath || runbookNormalizePath(selectedRunbookPath).toLowerCase() === runbookNormalizePath(runbookPath).toLowerCase();
  const current = getRunbookCache(machineRunRecordCache, runbookPath) || (selectedMatches ? lastMachineRunRecord : null) || {};
  const next = {
    ...current,
    ...record,
    runId: runId || current.runId,
    exported: record.exported || record.export || current.exported || null,
  };
  if (runbookPath) setRunbookCache(machineRunRecordCache, runbookPath, next);
  if (selectedMatches) {
    selectedRunbookPath = runbookPath || selectedRunbookPath;
    lastMachineRunRecord = next;
  }
  return next;
}

async function refreshMachineRunPanelSnapshot(runbookPath, runId) {
  const snapshot = await loadMachineRunRecord(runbookPath, runId);
  if (!snapshot) return null;
  const record = machineUpdateRunRecord(runbookPath, snapshot);
  renderRunbooksPanel();
  rerenderPipelinePreviewIfActive(runbookPath);
  return record;
}

async function refreshVisibleMachineRunSnapshot() {
  if (document.hidden || !selectedRunbookPath) return;
  const record = lastMachineRunRecord || getRunbookCache(machineRunRecordCache, selectedRunbookPath);
  const runId = record?.runState?.runId || record?.runId || '';
  if (!runId) return;
  await refreshMachineRunPanelSnapshot(selectedRunbookPath, runId);
}

function startMachineRunProgressPolling(runbookPath, runId) {
  if (!runbookPath || !runId) return;
  const key = machineRunActionKey(runbookPath, runId);
  if (machineRunProgressTimers.has(key)) return;
  let polling = false;
  const tick = async () => {
    if (polling) return;
    if (!isMachineRunActionPending(runbookPath, runId)) {
      stopMachineRunProgressPollingByKey(key);
      return;
    }
    polling = true;
    try {
      const record = await refreshMachineRunPanelSnapshot(runbookPath, runId);
      if (isMachineRunTerminal(record?.runState)) {
        setMachineRunActionPending(runbookPath, runId, false);
      }
      if (record && !isMachineRunInProgress(record, runbookPath)) {
        await maybeOpenMachinePatchReviewModal(runbookPath, record);
      }
    } catch {
      // Keep the optimistic running state visible; the execute response will surface failures.
    } finally {
      polling = false;
    }
  };
  machineRunProgressTimers.set(key, setInterval(tick, 2000));
  void tick();
}

function markMachineRunExecuting(runbookPath, runId) {
  const cached = lastMachineRunRecord || getRunbookCache(machineRunRecordCache, runbookPath) || {};
  const cachedRunId = cached.runId || cached.runState?.runId || '';
  const sameRun = cachedRunId && cachedRunId === runId;
  // When starting a new runId, drop stale events / runRoot / failure state so
  // the in-progress preview never shows the previous run's failed adapter
  // cards before polling catches up.
  const baseRecord = sameRun
    ? cached
    : {
      runId,
      runState: {},
      events: [],
      runRoot: '',
      candidateInventory: undefined,
      worker: undefined,
      approvals: undefined,
      activeClaims: [],
      activeWriteSets: [],
      exported: null,
    };
  const baseRunState = sameRun ? (cached.runState || {}) : {};
  const record = machineUpdateRunRecord(runbookPath, {
    ...baseRecord,
    runId,
    runState: {
      ...baseRunState,
      runId,
      lifecycleStatus: 'running',
      summaryStatus: baseRunState.summaryStatus || 'pending',
      updatedAt: new Date().toISOString(),
    },
  });
  renderRunbooksPanel();
  rerenderPipelinePreviewIfActive(runbookPath);
  return record;
}

window.addEventListener('focus', () => {
  refreshVisibleMachineRunSnapshot().catch(err => notifyFormatError('Pipes', err));
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    refreshVisibleMachineRunSnapshot().catch(err => notifyFormatError('Pipes', err));
  }
});

function machineExecuteControlDetails(record, validation = null, runbookPath = selectedRunbookPath) {
  const runState = record?.runState || {};
  const runId = runState.runId || record?.runId || '';
  const pendingApprovals = Number(record?.approvals?.pendingCount) || (record?.approvals?.pending || []).length;
  const activeClaims = record?.activeClaims || [];
  if (!runId) return 'Continue unavailable: no run selected';
  if (validation && !isMachineStartablePipeline(validation)) return machineStartBlockReason(validation);
  if (isMachineRunTerminal(runState)) return `Continue unavailable: ${machineRunStatusLabel(runState) || 'run'} is finished`;
  if (isMachineRunInProgress(record, runbookPath)) return 'Continue paused: OrPAD is already working on this run.';
  if (pendingApprovals > 0) return `Continue blocked: decide ${machineCountLabel(pendingApprovals, 'permission request')} first`;
  if (activeClaims.length) return `Continue paused: ${machineWorkInProgressLabel(activeClaims.length)}; cancel or wait before continuing`;
  return 'Continue this run.';
}

function machineResumeControlDetails(record, runbookPath = selectedRunbookPath) {
  const runState = record?.runState || {};
  const runId = runState.runId || record?.runId || '';
  const pendingApprovals = Number(record?.approvals?.pendingCount) || (record?.approvals?.pending || []).length;
  const activeClaims = record?.activeClaims || [];
  const resume = record?.resume || null;
  if (!runId) {
    return { state: 'warn', text: 'Recovery unavailable: no run selected' };
  }
  if (!window.orpad?.machine?.resumeRun) {
    return { state: 'warn', text: 'Recovery unavailable in this session' };
  }
  if (isMachineRunTerminal(runState)) {
    return { state: 'warn', text: `Recovery unavailable: ${machineRunStatusLabel(runState) || 'run'} is finished` };
  }
  if (isMachineRunInProgress(record, runbookPath)) {
    return { state: 'warn', text: 'Recovery paused: OrPAD is already working on this run' };
  }
  if (pendingApprovals > 0) {
    return { state: 'warn', text: `Recovery blocked: decide ${machineCountLabel(pendingApprovals, 'permission request')} first` };
  }
  if (activeClaims.length) {
    const staleClaims = machineStaleActiveClaims(record);
    if (staleClaims.length === activeClaims.length) {
      return { state: 'good', text: `Recovery ready: ${machineCountLabel(staleClaims.length, 'interrupted work item')} can be recovered before continuing` };
    }
    return { state: 'warn', text: `Recovery paused: ${machineWorkInProgressLabel(activeClaims.length)}; cancel or wait before continuing` };
  }
  if (resume) {
    const repaired = resume.queueRepair?.repaired?.length || 0;
    return {
      state: 'good',
      text: `Last recovery: ${machineCountLabel(repaired, 'work state repair')}; ${machineCountLabel(resume.staleClaimCount, 'interrupted work item')} recovered; ${machineQueueInventorySummary(resume.inventory)}`,
    };
  }
  return { state: 'good', text: 'Recovery ready: OrPAD can repair work state and recover interrupted work before continuing' };
}

function machineCancellationControlDetails(record) {
  const activeClaims = record?.activeClaims || [];
  const cancellation = record?.cancellation || null;
  if (cancellation) {
    return {
      state: 'good',
      text: `Stopped: ${cancellation.itemId || 'work item'}; work reservation released`,
    };
  }
  if (activeClaims.length) {
    const first = activeClaims[0];
    return {
      state: 'warn',
      text: `Ready to stop: ${first.itemId || 'work item'} is in progress; ${machineActiveWriteSetDetails(record)}`,
    };
  }
  return { state: 'good', text: 'No work to stop' };
}

function isMachineRunTerminal(runState) {
  return ['completed', 'cancelled', 'failed'].includes(runState?.lifecycleStatus)
    || runState?.summaryStatus === 'done';
}

function machineRunListForRunbook(runbookPath) {
  const cached = getRunbookCache(machineRunListCache, runbookPath);
  return Array.isArray(cached?.runs) ? cached.runs : [];
}

function renderMachineRunHistory(runbookPath, currentRunId) {
  const runs = machineRunListForRunbook(runbookPath);
  if (!runs.length) return '';
  return `
    <div class="runbook-machine-history">
      <div class="runbook-item-title">
        <strong>History</strong>
        <span class="runbook-chip">${escapeHtml(machineCountLabel(runs.length, 'entry', 'entries'))}</span>
      </div>
      <div class="runbook-action-row">
        ${runs.slice(0, 6).map(run => {
          const selected = run.runId === currentRunId;
          const label = machineRunDisplayLabel(run);
          const title = [
            machineLifecycleStatusLabel(run.lifecycleStatus),
            machineSummaryStatusLabel(run.summaryStatus),
            machineRunDateLabel(run.updatedAt || run.createdAt),
          ].filter(Boolean).join(' - ');
          return `<button data-runbook-action="machine-select-run" data-path="${escapeHtml(runbookPath)}" data-run-id="${escapeHtml(run.runId || '')}" class="${selected ? 'primary' : ''}" title="${escapeHtml(title)}">${escapeHtml(label)}</button>`;
        }).join('')}
      </div>
    </div>
  `;
}

function renderMachineRunPanel(record = lastMachineRunRecord, runbookPath = selectedRunbookPath) {
  if (!record) return '';
  const runState = record.runState || {};
  const events = record.events || [];
  const queueEvents = events.filter(event => event?.itemId || String(event?.eventType || '').startsWith('queue.'));
  const exported = record.exported || null;
  const runTerminal = isMachineRunTerminal(runState);
  const pendingApprovals = record.approvals?.pending || [];
  const approvalPending = (record.approvals?.pendingCount || 0) > 0;
  const activeClaims = record.activeClaims || [];
  const firstActiveClaim = activeClaims[0] || null;
  const candidateDetails = machineCandidateInventoryDetails(record);
  const workerProofDetails = machineWorkerProofDetails(record);
  const nodeCompletionDetails = machineNodeCompletionDetails(record);
  const approvalDetails = machineApprovalDetails(record);
  const activeClaimDetails = machineActiveClaimDetails(record);
  const activeWriteSetDetails = machineActiveWriteSetDetails(record);
  const auditDetails = machineAuditDetails(record);
  const artifactDetails = machineArtifactSummary(record);
  const taskText = normalizeRunbookTask(runState.metadata?.taskText || record.metadata?.taskText || '');
  const validation = selectedPipelineValidation(runbookPath);
  const machineStepUnavailable = !!validation && !isMachineStartablePipeline(validation);
  const runInProgress = isMachineRunInProgress(record, runbookPath);
  const executeDetails = machineExecuteControlDetails(record, validation, runbookPath);
  const resumeDetails = machineResumeControlDetails(record, runbookPath);
  const cancellationDetails = machineCancellationControlDetails(record);
  const attentionDetails = machineRunAttentionDetails(record);
  const runId = runState.runId || record.runId || '';
  const runLabel = machineRunDisplayLabel({
    runId,
    createdAt: runState.createdAt || record.createdAt,
    updatedAt: runState.updatedAt || record.updatedAt,
  });
  const lifecycleStatus = runInProgress ? 'running' : (runState.lifecycleStatus || 'created');
  const summaryStatus = runState.summaryStatus || 'pending';
  const displayStatus = machineDisplayStatus(record, runInProgress);
  const hasActiveClaims = activeClaims.length > 0;
  const hasFreshActiveClaims = hasActiveClaims && machineStaleActiveClaims(record).length !== activeClaims.length;
  const executeDisabled = !runId || machineStepUnavailable || runTerminal || runInProgress || approvalPending || hasActiveClaims;
  const resumeDisabled = !runId || runTerminal || runInProgress || approvalPending || hasFreshActiveClaims || !window.orpad?.machine?.resumeRun;
  const cancelDisabled = runTerminal || (!window.orpad?.machine?.cancelRun && !window.orpad?.machine?.cancelClaim);
  const approvalActions = pendingApprovals.length ? `
        <div class="runbook-action-row">
          ${pendingApprovals.slice(0, 3).map(approval => `
            <button data-runbook-action="machine-approve-approval" data-run-id="${escapeHtml(runId)}" data-approval-id="${escapeHtml(approval.approvalId || '')}" title="${escapeHtml(approval.title || approval.itemId || approval.approvalId || 'Permission request')}">Allow</button>
            <button data-runbook-action="machine-deny-approval" data-run-id="${escapeHtml(runId)}" data-approval-id="${escapeHtml(approval.approvalId || '')}" title="${escapeHtml(approval.title || approval.itemId || approval.approvalId || 'Permission request')}">Decline</button>
          `).join('')}
        </div>
      ` : '';
  return `
    <section class="runbook-panel-section">
      <h3>Latest Run</h3>
      <div class="runbook-chip-row">
        <span class="runbook-chip ${escapeHtml(displayStatus.lifecycleClass)}" title="${escapeHtml(displayStatus.lifecycleTitle)}">${escapeHtml(displayStatus.lifecycleLabel)}</span>
        <span class="runbook-chip ${escapeHtml(displayStatus.summaryClass)}" title="${escapeHtml(displayStatus.summaryTitle)}">${escapeHtml(displayStatus.summaryLabel)}</span>
        <span class="runbook-chip">${escapeHtml(runLabel)}</span>
      </div>
      ${taskText ? `<p class="runbook-muted"><strong>Objective</strong> ${escapeHtml(taskText)}</p>` : ''}
      ${renderMachineRunHistory(runbookPath, runId)}
      ${machineFailureDetails(record)}
      ${attentionDetails}
      <div class="runbook-action-row">
        ${runInProgress ? '' : `<button data-runbook-action="machine-execute-step" data-run-id="${escapeHtml(runId)}" ${executeDisabled ? 'disabled' : ''} title="${escapeHtml(executeDetails)}">Continue</button>`}
        <button data-runbook-action="machine-resume-run" data-run-id="${escapeHtml(runId)}" ${resumeDisabled ? 'disabled' : ''} title="${escapeHtml(resumeDetails.text)}">Recover</button>
        ${!runInProgress && firstActiveClaim ? `<button data-runbook-action="machine-cancel-claim" data-run-id="${escapeHtml(runId)}" data-claim-id="${escapeHtml(firstActiveClaim.claimId || '')}" data-item-id="${escapeHtml(firstActiveClaim.itemId || '')}" ${cancelDisabled ? 'disabled' : ''} title="${escapeHtml(cancellationDetails.text)}">Stop Work</button>` : ''}
        <button data-runbook-action="machine-export" data-run-id="${escapeHtml(runId)}" ${runId ? '' : 'disabled'} title="Save a reviewable evidence snapshot.">Save Evidence</button>
        <button data-runbook-action="machine-view-artifacts" data-run-id="${escapeHtml(runId)}" ${runId ? '' : 'disabled'} title="Review evidence files for this run.">Review Evidence</button>
      </div>
      <div class="runbook-replay-events">
        ${events.slice(-24).map(event => {
          const timeLabel = machineEventTimeLabel(event);
          return `<div class="runbook-event">${timeLabel ? `${escapeHtml(timeLabel)} ` : ''}${escapeHtml(machineEventLabel(event))}</div>`;
        }).join('') || '<div class="runbook-event">No run events recorded.</div>'}
      </div>
      <div class="runbook-machine-grid">
        <div class="runbook-guide ${record.candidateInventory ? 'good' : 'warn'}">
          <strong>Work found</strong>
          <span>${escapeHtml(candidateDetails)}</span>
        </div>
        <div class="runbook-guide ${escapeHtml(machineWorkerResultState(record))}">
          <strong>Work result</strong>
          <span>${escapeHtml(workerProofDetails)}</span>
        </div>
        <div class="runbook-guide">
          <strong>Step progress</strong>
          <span>${escapeHtml(nodeCompletionDetails)}</span>
        </div>
        <div class="runbook-guide">
          <strong>Work status</strong>
          <span>${escapeHtml([queueEvents.length ? machineCountLabel(queueEvents.length, 'work update') : 'No work updates yet', activeClaimDetails, activeWriteSetDetails].join('; '))}</span>
        </div>
        <div class="runbook-guide ${escapeHtml(resumeDetails.state)}">
          <strong>Recovery</strong>
          <span>${escapeHtml(resumeDetails.text)}</span>
        </div>
        <div class="runbook-guide ${escapeHtml(cancellationDetails.state)}">
          <strong>Stop work</strong>
          <span>${escapeHtml(cancellationDetails.text)}</span>
        </div>
        <div class="runbook-guide">
          <strong>Evidence files</strong>
          <span>${escapeHtml(artifactDetails)}</span>
        </div>
        <div class="runbook-guide ${exported ? 'good' : 'warn'}">
          <strong>Evidence snapshot</strong>
          <span>${escapeHtml(exported ? 'Snapshot saved' : 'No snapshot saved yet')}</span>
        </div>
        <div class="runbook-guide ${escapeHtml(auditDetails.state)}">
          <strong>Evidence check</strong>
          <span>${escapeHtml(auditDetails.text)}</span>
        </div>
        <div class="runbook-guide ${approvalPending ? 'warn' : 'good'}">
          <strong>Permission</strong>
          <span>${escapeHtml(approvalDetails)}</span>
          ${approvalActions}
        </div>
      </div>
    </section>
  `;
}

function renderRunbooksPanel() {
  if (!runbooksContentEl) return;
  if (!workspacePath) {
    runbooksContentEl.innerHTML = `
      <div class="runbook-empty">
        Open a project folder to design and run an OrPAD pipeline.
      </div>
      <section class="runbook-panel-section">
        <button class="primary" data-runbook-action="open-folder">Open Folder</button>
      </section>
    `;
    return;
  }

  const summary = workspaceRunbookSummary || buildWorkspaceRunbookSummary();
  const pipelineItems = summary.pipelines || [];
  const templateItems = summary.templatePipelines || [];
  const legacyItems = summary.legacyRunbooks || [];
  const pipelineCount = (summary.pipelines || []).length;
  const templateCount = templateItems.length;
  const legacyCount = legacyItems.length;
  const selected = selectedRunbookPath || '';
  const selectedRunRecord = lastRunRecord || getRunbookCache(runbookRecordCache, selected);
  const selectedMachineRunRecord = lastMachineRunRecord || getRunbookCache(machineRunRecordCache, selected);
  const selectedKey = runbookNormalizePath(selected).toLowerCase();
  const workspaceMeta = [
    machineCountLabel(pipelineCount, 'pipeline'),
    legacyCount ? machineCountLabel(legacyCount, 'legacy flow') : '',
    machineCountLabel(summary.fileCount, 'file'),
  ].filter(Boolean);
  runbooksContentEl.innerHTML = `
    <section class="runbook-panel-section">
      <h3>Describe the work</h3>
      <textarea class="runbook-task-input" data-runbook-task rows="4" placeholder="Example: improve the OrPAD Pipes panel so I can type a task, generate a pipeline, validate it, and run it.">${escapeHtml(runbookDraftTask)}</textarea>
      ${renderRunbookExternalResearchWarning(runbookDraftTask)}
      <div class="runbook-action-row">
        <button class="primary" data-runbook-action="starter">Generate Pipeline</button>
        <button data-runbook-action="refresh">Refresh</button>
      </div>
      <div class="runbook-workspace-meta" data-runbook-workspace-meta title="${escapeHtml(runbookNormalizePath(workspacePath))}">
        <strong>${escapeHtml(runbookBaseName(workspacePath))}</strong>
        <span class="runbook-chip-row">
          ${workspaceMeta.map(item => `<span class="runbook-chip">${escapeHtml(item)}</span>`).join('')}
        </span>
      </div>
    </section>
    <section class="runbook-panel-section" data-runbook-section="pipelines">
      <div class="runbook-section-heading">
        <h3>Pipelines</h3>
        <span class="runbook-chip">${escapeHtml(machineCountLabel(pipelineCount, 'pipeline'))}</span>
      </div>
      ${pipelineItems.length ? `
        <div class="runbook-list">
          ${renderRunbookListItems(pipelineItems, selectedKey)}
        </div>
      ` : '<div class="runbook-empty">No OrPAD pipelines found yet. Describe the work, then generate one.</div>'}
    </section>
    ${templateItems.length ? `
      <section class="runbook-panel-section" data-runbook-section="templates">
        <div class="runbook-section-heading">
          <h3>Templates</h3>
          <span class="runbook-chip">${escapeHtml(machineCountLabel(templateCount, 'template'))}</span>
        </div>
        <div class="runbook-list">
          ${renderRunbookListItems(templateItems, selectedKey)}
        </div>
      </section>
    ` : ''}
    ${legacyItems.length ? `
      <section class="runbook-panel-section" data-runbook-section="legacy">
        <div class="runbook-section-heading">
          <h3>Legacy Workflows</h3>
          <span class="runbook-chip">${escapeHtml(machineCountLabel(legacyCount, 'legacy flow'))}</span>
        </div>
        <div class="runbook-list">
          ${renderRunbookListItems(legacyItems, selectedKey)}
        </div>
      </section>
    ` : ''}
    ${renderRunRecordPanel(selected ? selectedRunRecord : null)}
    ${renderMachineRunPanel(selected ? selectedMachineRunRecord : null, selected)}
  `;
}

async function validateSelectedRunbook(runbookPath) {
  if (!runbookPath) return;
  const pipelineApi = window.orpad?.pipelines || window.orpad?.runbooks;
  selectedRunbookPath = runbookPath;
  selectedRunbookValidation = await pipelineApi.validateFile(runbookPath, { trustLevel: 'local-authored' });
  setRunbookCache(runbookValidationCache, runbookPath, selectedRunbookValidation);
  lastRunRecord = null;
  lastMachineRunRecord = getRunbookCache(machineRunRecordCache, runbookPath);
  renderRunbooksPanel();
  rerenderPipelinePreviewIfActive(runbookPath);
  if (isMachineCompatiblePipeline(selectedRunbookValidation)) {
    const latestMachineRun = await loadLatestMachineRunRecord(runbookPath);
    if (latestMachineRun && runbookNormalizePath(selectedRunbookPath).toLowerCase() === runbookNormalizePath(runbookPath).toLowerCase()) {
      lastMachineRunRecord = latestMachineRun;
      setRunbookCache(machineRunRecordCache, runbookPath, lastMachineRunRecord);
      renderRunbooksPanel();
      rerenderPipelinePreviewIfActive(runbookPath);
    }
  }
}

function rerenderPipelinePreviewIfActive(runbookPath) {
  const context = pipelineContextForPath();
  if (!context?.pipelinePath || !runbookPath) return;
  if (runbookNormalizePath(context.pipelinePath).toLowerCase() !== runbookNormalizePath(runbookPath).toLowerCase()) return;
  invalidateRenderCache();
  if (getActiveTab()?.viewType === 'orch-pipeline' || getActiveTab()?.viewType === 'orch-graph') {
    renderPreview(editor.state.doc.toString());
  }
}

async function ensurePipelinePreviewValidation(runbookPath) {
  if (!runbookPath) return null;
  const selectedKey = runbookNormalizePath(selectedRunbookPath).toLowerCase();
  const targetKey = runbookNormalizePath(runbookPath).toLowerCase();
  if (!selectedKey || selectedKey !== targetKey || !selectedRunbookValidation) {
    await validateSelectedRunbook(runbookPath);
  }
  return selectedPipelineValidation(runbookPath);
}

const ADAPTER_PICKER_MUTATING_CHANNELS = new Set([
  'machine-set-provider-selection',
]);

function buildAdapterPickerBridge() {
  const machine = window?.orpad?.machine;
  if (!machine) {
    throw new Error('Machine IPC bridge is not available. Enable managed runs first.');
  }
  return {
    async invoke(channel, payload) {
      const enriched = { ...(payload || {}) };
      if (ADAPTER_PICKER_MUTATING_CHANNELS.has(channel)
        && !enriched.capabilityToken
        && machineCapabilityToken) {
        enriched.capabilityToken = machineCapabilityToken;
      }
      let response;
      if (channel === 'machine-list-providers') response = await machine.listProviders(enriched);
      else if (channel === 'machine-list-models') response = await machine.listModels(enriched);
      else if (channel === 'machine-set-provider-selection') response = await machine.setProviderSelection(enriched);
      else if (channel === 'machine-read-budget-ledger') response = await machine.readBudgetLedger(enriched);
      else if (channel === 'machine-enable-session') response = await machine.enableSession();
      else if (channel === 'machine-status') response = await machine.status();
      else throw new Error(`AdapterPicker bridge: unsupported channel ${channel}`);
      // Capture session-enable token so subsequent mutating calls work without a
      // separate refresh through the existing managed-runs UI.
      if (channel === 'machine-enable-session' && response?.success === true) {
        if (response.capabilityToken) machineCapabilityToken = response.capabilityToken;
        machineRuntimeStatus = {
          success: true,
          ok: true,
          enabled: response.enabled === true,
          mutatingCapabilityConfigured: response.mutatingCapabilityConfigured === true,
          sessionEnableAvailable: response.sessionEnableAvailable === true,
          enabledBy: response.enabledBy || 'session',
        };
      }
      // If a mutating call rejects with capability denied, drop the cached
      // token so the next session-enable click can replace it.
      if (channel === 'machine-set-provider-selection'
        && response
        && (response.success === false || response.ok === false)
        && response.code === 'MACHINE_IPC_CAPABILITY_DENIED') {
        machineCapabilityToken = '';
      }
      return response;
    },
  };
}

async function openAdapterPickerDialog(runbookPath) {
  const machine = window?.orpad?.machine;
  if (!machine) {
    notifyFormatError('AI Provider', new Error('Machine IPC is not available.'));
    return;
  }
  try { await refreshMachineRuntimeStatus(); } catch { /* picker surfaces the error */ }

  const overlay = document.createElement('div');
  overlay.className = 'orpad-adapter-picker-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9000;';

  const panel = document.createElement('div');
  panel.style.cssText = [
    'width:min(640px, 92vw)',
    'max-height:88vh',
    'overflow:auto',
    'padding:18px 20px',
    'border-radius:10px',
    'background:#1d1f23',
    'color:#e6e6e6',
    'box-shadow:0 12px 32px rgba(0,0,0,0.5)',
    'font-family:inherit',
  ].join(';');

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;';
  const title = document.createElement('div');
  title.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
  const titleMain = document.createElement('div');
  titleMain.textContent = 'AI Provider 선택';
  titleMain.style.cssText = 'font-size:15px;font-weight:600;';
  const titleSub = document.createElement('div');
  titleSub.textContent = runbookPath;
  titleSub.style.cssText = 'font-size:11px;opacity:0.65;word-break:break-all;';
  title.appendChild(titleMain);
  title.appendChild(titleSub);
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = '✕';
  closeButton.style.cssText = 'background:none;border:0;color:#e6e6e6;font-size:18px;cursor:pointer;padding:0 6px;';
  closeButton.addEventListener('click', () => overlay.remove());
  header.appendChild(title);
  header.appendChild(closeButton);
  panel.appendChild(header);

  const helpBox = document.createElement('div');
  helpBox.style.cssText = 'margin-bottom:12px;padding:10px 12px;border:1px solid rgba(255,255,255,0.08);border-radius:6px;background:rgba(255,255,255,0.03);font-size:11.5px;line-height:1.5;opacity:0.85;';
  helpBox.innerHTML = [
    '<div><strong>저장 위치:</strong> 같은 폴더의 <code>&lt;pipeline-stem&gt;.adapter-overrides.json</code> (사용자의 pipeline.or-pipeline은 수정되지 않음)</div>',
    '<div><strong>적용 시점:</strong> 다음 Machine run부터 events.jsonl의 providerId가 새 값으로 기록됨</div>',
    '<div><strong>현 단계:</strong> codex-cli/claude-code는 실제 CLI를 실행. anthropic/openai/ollama는 plugin 있으나 invoke 일부 stub (메뉴에 표시).</div>',
  ].join('');
  panel.appendChild(helpBox);

  let picker;
  try {
    picker = createAdapterPicker({
      bridge: buildAdapterPickerBridge(),
      scope: 'pipeline',
      pipelinePath: runbookPath,
      onCommit: async (response) => {
        if (response?.persistedTo) {
          try { notifyFormatError('AI Provider', new Error(`Saved → ${response.persistedTo}`)); } catch {}
        }
      },
      onError: err => notifyFormatError('AI Provider', err),
    });
    panel.appendChild(picker.root);
  } catch (err) {
    const fail = document.createElement('div');
    fail.style.cssText = 'color:#ffb4b4;font-size:12px;padding:10px;border:1px solid rgba(220,38,38,0.4);border-radius:6px;background:rgba(220,38,38,0.1);';
    fail.textContent = `Picker mount 실패: ${err.message}`;
    panel.appendChild(fail);
  }

  overlay.appendChild(panel);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
  if (picker && typeof picker.refresh === 'function') {
    picker.refresh().catch(() => {});
  }
}

async function runPipelinePreviewAction(action, runbookPath) {
  if (!runbookPath) return;
  if (action === 'check') {
    await validateSelectedRunbook(runbookPath);
    return;
  }
  if (action === 'managed') {
    await startSelectedMachineRun(runbookPath);
    return;
  }
  if (action === 'choose-adapter') {
    await openAdapterPickerDialog(runbookPath);
    return;
  }
  const validation = await ensurePipelinePreviewValidation(runbookPath);
  if (action === 'handoff') {
    await openAgentHandoffModal(runbookPath, validation);
    return;
  }
  if (action === 'local') {
    await startSelectedLocalRun(runbookPath);
    return;
  }
  if (isMachineCompatiblePipeline(validation)) {
    await startSelectedMachineRun(runbookPath);
    return;
  }
  if (isAgentOrchestratedPipeline(validation)) {
    await openAgentHandoffModal(runbookPath, validation);
    return;
  }
  await startSelectedLocalRun(runbookPath);
}

async function openPipelineEntryOrFile(filePath) {
  if (/\.or-pipeline$/i.test(filePath)) {
    try {
      const result = await window.orpad.readFile(filePath);
      const parsed = JSON.parse(result?.content || '{}');
      const entryGraph = parsed.entryGraph || parsed.entry?.graph || parsed.graph?.file || '';
      if (entryGraph) {
        const base = runbookDirname(filePath);
        await openFileInTab(normalizeRunbookFilePath(`${base}/${entryGraph}`));
        return;
      }
    } catch {
      // Fall through and open the manifest when the entrypoint cannot be read.
    }
  }
  await openFileInTab(filePath);
}

async function toggleRunbookSlot(runbookPath) {
  if (!runbookPath) return;
  const selectedKey = runbookNormalizePath(selectedRunbookPath).toLowerCase();
  const targetKey = runbookNormalizePath(runbookPath).toLowerCase();
  if (selectedKey && selectedKey === targetKey) {
    selectedRunbookPath = null;
    selectedRunbookValidation = null;
    lastRunRecord = null;
    lastMachineRunRecord = null;
    renderRunbooksPanel();
    return;
  }
  selectedRunbookPath = runbookPath;
  selectedRunbookValidation = getRunbookCache(runbookValidationCache, runbookPath);
  lastRunRecord = getRunbookCache(runbookRecordCache, runbookPath);
  lastMachineRunRecord = getRunbookCache(machineRunRecordCache, runbookPath);
  renderRunbooksPanel();
  await openPipelineEntryOrFile(runbookPath);
  await validateSelectedRunbook(runbookPath);
  void hydrateLatestMachineRunForSelection(runbookPath);
}

async function hydrateLatestMachineRunForSelection(runbookPath) {
  if (!workspacePath || !runbookPath) return;
  if (selectedRunbookPath !== runbookPath) return;
  if (lastMachineRunRecord?.runState?.runId || lastMachineRunRecord?.runId) return;
  try {
    const record = await loadLatestMachineRunRecord(runbookPath);
    if (!record || selectedRunbookPath !== runbookPath) return;
    lastMachineRunRecord = record;
    renderRunbooksPanel();
  } catch {
    // Latest run hydration is best-effort; failures stay silent so panel rendering proceeds.
  }
}

async function createSelectedRunRecord(runbookPath) {
  if (!workspacePath || !runbookPath) return;
  const pipelineApi = window.orpad?.pipelines || window.orpad?.runbooks;
  const result = await pipelineApi.createRunRecord(workspacePath, runbookPath, {
    trustLevel: 'local-authored',
    title: 'Local pipeline dry run',
  });
  if (result.error) {
    alert(result.error);
    return;
  }
  lastRunRecord = {
    run: result.run,
    events: [{ timestamp: result.run?.createdAt || '', type: 'run.created' }],
  };
  setRunbookCache(runbookRecordCache, runbookPath, lastRunRecord);
  renderRunbooksPanel();
  const readBack = await pipelineApi.readRunRecord(workspacePath, result.runDir);
  lastRunRecord = readBack.success ? readBack : { run: result.run, events: [] };
  setRunbookCache(runbookRecordCache, runbookPath, lastRunRecord);
  renderRunbooksPanel();
  rerenderPipelinePreviewIfActive(runbookPath);
  void refreshWorkspaceRunbookSummary();
}

async function startSelectedLocalRun(runbookPath) {
  if (!workspacePath || !runbookPath) return;
  if (!selectedRunbookValidation || selectedRunbookPath !== runbookPath) {
    await validateSelectedRunbook(runbookPath);
  }
  const validation = selectedRunbookValidation || getRunbookCache(runbookValidationCache, runbookPath);
  if (!validation?.ok || !validation?.canExecute) {
    const agentIssue = agentOrchestratedPipelineIssue(validation);
    alert(agentIssue?.message || 'Pipeline must validate as MVP executable before starting a local run.');
    return;
  }
  const approval = await requestRunbookApproval(runbookPath, validation);
  if (!approval?.allowed) return;
  const pipelineApi = window.orpad?.pipelines || window.orpad?.runbooks;
  const result = await pipelineApi.startLocalRun(workspacePath, runbookPath, {
    trustLevel: 'local-authored',
    title: 'Local pipeline MVP run',
    approval,
  });
  if (result.error) {
    alert(result.error);
    return;
  }
  selectedRunbookPath = runbookPath;
  selectedRunbookValidation = result.validation || validation;
  setRunbookCache(runbookValidationCache, runbookPath, selectedRunbookValidation);
  const readBack = await pipelineApi.readRunRecord(workspacePath, result.runDir);
  lastRunRecord = readBack.success ? readBack : { run: result.run, events: [] };
  setRunbookCache(runbookRecordCache, runbookPath, lastRunRecord);
  renderRunbooksPanel();
  void refreshWorkspaceRunbookSummary();
}

async function loadLatestMachineRunRecord(runbookPath) {
  if (!workspacePath || !runbookPath || !window.orpad?.machine?.listRuns || !window.orpad?.machine?.getRun) return null;
  try {
    const runs = await refreshMachineRunList(runbookPath);
    if (!runs.length) return null;
    return loadMachineRunRecord(runbookPath, runs[0].runId);
  } catch {
    return null;
  }
}

async function refreshMachineRunList(runbookPath) {
  if (!workspacePath || !runbookPath || !window.orpad?.machine?.listRuns) return [];
  const listed = await window.orpad.machine.listRuns({
    workspacePath,
    pipelinePath: runbookPath,
  });
  const runs = listed?.success && Array.isArray(listed.runs) ? listed.runs : [];
  setRunbookCache(machineRunListCache, runbookPath, {
    runs,
    loadedAt: new Date().toISOString(),
  });
  return runs;
}

async function loadMachineRunRecord(runbookPath, runId) {
  if (!workspacePath || !runbookPath || !runId || !window.orpad?.machine?.getRun) return null;
  const snapshot = await window.orpad.machine.getRun({
    workspacePath,
    pipelinePath: runbookPath,
    runId,
  });
  return snapshot?.success ? snapshot : {
    runId,
    runState: { runId },
    events: [],
  };
}

async function selectMachineRunRecord(runbookPath, runId) {
  const snapshot = await loadMachineRunRecord(runbookPath, runId);
  if (!snapshot) return;
  selectedRunbookPath = runbookPath;
  lastMachineRunRecord = snapshot;
  setRunbookCache(machineRunRecordCache, runbookPath, lastMachineRunRecord);
  renderRunbooksPanel();
}

async function requestMachineCapabilityToken() {
  if (machineCapabilityToken) return machineCapabilityToken;
  return new Promise((resolve) => {
    let settled = false;
    const body = document.createElement('div');
    body.className = 'runbook-modal-body';
    body.innerHTML = `
      <p>Enter the run authorization token for this desktop session.</p>
      <input class="runbook-task-input" type="password" data-machine-token-input autocomplete="off" placeholder="Capability token">
      <div class="runbook-diagnostic warning">The token stays in session memory and is used only to update run state.</div>
    `;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeFmtModal();
      resolve(value || '');
    };
    openFmtModal({
      title: 'Run Authorization',
      body,
      onClose: () => finish(''),
      footer: [
        { label: 'Cancel', onClick: () => finish('') },
        {
          label: 'Use Token',
          primary: true,
          onClick: () => {
            const token = body.querySelector('[data-machine-token-input]')?.value || '';
            machineCapabilityToken = token.trim();
            finish(machineCapabilityToken);
          },
        },
      ],
    });
    setTimeout(() => body.querySelector('[data-machine-token-input]')?.focus(), 30);
  });
}

async function startSelectedMachineRun(runbookPath) {
  if (!workspacePath || !runbookPath) return;
  if (!window.orpad?.machine) {
    alert('Managed runs are unavailable in this build.');
    return;
  }
  const cachedRecord = getRunbookCache(machineRunRecordCache, runbookPath);
  const runbookKey = runbookNormalizePath(runbookPath).toLowerCase();
  if (machineRunStartPendingPaths.has(runbookKey) || isMachineRunInProgress(cachedRecord, runbookPath)) return;
  if (!await ensureMachineRuntimeReady()) return;
  if (!selectedRunbookValidation || selectedRunbookPath !== runbookPath) {
    await validateSelectedRunbook(runbookPath);
  }
  const validation = selectedRunbookValidation || getRunbookCache(runbookValidationCache, runbookPath);
  if (!isMachineCompatiblePipeline(validation)) {
    alert('Pipeline must be ready before starting.');
    return;
  }
  if (!isMachineStartablePipeline(validation)) {
    alert(machineStartBlockReason(validation));
    return;
  }
  const token = await requestMachineCapabilityToken();
  if (!token) return;
  const taskText = currentRunbookTaskText();
  const externalResearch = await ensureExternalResearchRunState(runbookPath, taskText);
  if (externalResearch === null && (await externalResearchLaunchContext(runbookPath, taskText)).intentDetected) return;
  setMachineRunStartPending(runbookPath, true);
  let created = null;
  try {
    created = await window.orpad.machine.createRun({
      workspacePath,
      pipelinePath: runbookPath,
      capabilityToken: token,
      options: {
        trustLevel: 'local-authored',
        ...(taskText ? { taskText } : {}),
        ...(externalResearch ? { externalResearch } : {}),
      },
    });
  } catch (err) {
    setMachineRunStartPending(runbookPath, false);
    alert(err?.message || 'Managed run could not be created.');
    return;
  }
  if (!created?.success) {
    setMachineRunStartPending(runbookPath, false);
    if (created?.code === 'MACHINE_IPC_CAPABILITY_DENIED') {
      machineCapabilityToken = '';
    }
    alert(created?.error || 'Managed run could not be created.');
    return;
  }
  const snapshot = await window.orpad.machine.getRun({
    workspacePath,
    pipelinePath: runbookPath,
    runId: created.runId,
  });
  selectedRunbookPath = runbookPath;
  selectedRunbookValidation = created.validation || validation;
  setRunbookCache(runbookValidationCache, runbookPath, selectedRunbookValidation);
  lastMachineRunRecord = snapshot?.success ? snapshot : {
    runId: created.runId,
    runState: created.runState,
    events: created.event ? [created.event] : [],
  };
  setRunbookCache(machineRunRecordCache, runbookPath, lastMachineRunRecord);
  if (externalResearch) {
    machineRunExternalResearchDecisions.set(externalResearchDecisionKey(runbookPath, created.runId), externalResearch);
  }
  setMachineRunActionPending(runbookPath, created.runId, true);
  setMachineRunStartPending(runbookPath, false);
  await refreshMachineRunList(runbookPath);
  renderRunbooksPanel();
  rerenderPipelinePreviewIfActive(runbookPath);
  void refreshWorkspaceRunbookSummary();
  await executeSelectedMachineRunStep(runbookPath, created.runId, externalResearch);
}

async function executeSelectedMachineRunStep(runbookPath, runId, providedExternalResearch = null) {
  if (!workspacePath || !runbookPath || !runId || !window.orpad?.machine?.executeRunStep) return;
  if (!await ensureMachineRuntimeReady()) return;
  const token = await requestMachineCapabilityToken();
  if (!token) return;
  const taskText = currentRunbookTaskText();
  const externalResearch = await ensureExternalResearchRunState(runbookPath, taskText, runId, providedExternalResearch);
  if (externalResearch === null && (await externalResearchLaunchContext(runbookPath, taskText)).intentDetected) return;
  setMachineRunActionPending(runbookPath, runId, true);
  markMachineRunExecuting(runbookPath, runId);
  startMachineRunProgressPolling(runbookPath, runId);
  let executed = null;
  try {
    executed = await window.orpad.machine.executeRunStep({
      workspacePath,
      pipelinePath: runbookPath,
      runId,
      capabilityToken: token,
      exportLatestRun: true,
      options: {
        ...(taskText ? { taskText } : {}),
        ...(externalResearch ? { externalResearch } : {}),
      },
    });
  } catch (err) {
    setMachineRunActionPending(runbookPath, runId, false);
    try {
      await refreshMachineRunPanelSnapshot(runbookPath, runId);
    } catch {
      renderRunbooksPanel();
    }
    alert(err?.message || 'Run step failed.');
    return;
  }
  setMachineRunActionPending(runbookPath, runId, false);
  if (!executed?.success) {
    if (executed?.code === 'MACHINE_IPC_CAPABILITY_DENIED') {
      machineCapabilityToken = '';
      alert(executed?.error || 'Managed run step failed.');
      return;
    }
    lastMachineRunRecord = machineUpdateRunRecord(runbookPath, executed);
    await refreshMachineRunList(runbookPath);
    renderRunbooksPanel();
    return;
  }
  selectedRunbookPath = runbookPath;
  lastMachineRunRecord = machineUpdateRunRecord(runbookPath, executed);
  await refreshMachineRunList(runbookPath);
  renderRunbooksPanel();
  void refreshWorkspaceRunbookSummary();
  await maybeOpenMachinePatchReviewModal(runbookPath, lastMachineRunRecord);
}

async function resumeSelectedMachineRun(runbookPath, runId) {
  if (!workspacePath || !runbookPath || !runId || !window.orpad?.machine?.resumeRun) return;
  if (!await ensureMachineRuntimeReady()) return;
  const token = await requestMachineCapabilityToken();
  if (!token) return;
  const resumed = await window.orpad.machine.resumeRun({
    workspacePath,
    pipelinePath: runbookPath,
    runId,
    capabilityToken: token,
    exportLatestRun: true,
  });
  if (!resumed?.success) {
    if (resumed?.code === 'MACHINE_IPC_CAPABILITY_DENIED') {
      machineCapabilityToken = '';
      alert(resumed?.error || 'Recovery failed.');
      return;
    }
    lastMachineRunRecord = {
      ...(lastMachineRunRecord || getRunbookCache(machineRunRecordCache, runbookPath) || {}),
      ...resumed,
      exported: resumed?.exported || resumed?.export || lastMachineRunRecord?.exported || null,
    };
    setRunbookCache(machineRunRecordCache, runbookPath, lastMachineRunRecord);
    await refreshMachineRunList(runbookPath);
    renderRunbooksPanel();
    return;
  }
  selectedRunbookPath = runbookPath;
  const cached = lastMachineRunRecord || getRunbookCache(machineRunRecordCache, runbookPath) || {};
  lastMachineRunRecord = {
    ...cached,
    ...resumed,
    exported: resumed.exported || resumed.export,
  };
  setRunbookCache(machineRunRecordCache, runbookPath, lastMachineRunRecord);
  await refreshMachineRunList(runbookPath);
  renderRunbooksPanel();
  void refreshWorkspaceRunbookSummary();
}

async function cancelSelectedMachineClaim(runbookPath, runId, claimId, itemId) {
  if (!workspacePath || !runbookPath || !runId || !claimId || !itemId || !window.orpad?.machine?.cancelClaim) return;
  if (!await ensureMachineRuntimeReady()) return;
  const token = await requestMachineCapabilityToken();
  if (!token) return;
  const cancelled = await window.orpad.machine.cancelClaim({
    workspacePath,
    pipelinePath: runbookPath,
    runId,
    claimId,
    itemId,
    toState: 'blocked',
    capabilityToken: token,
    exportLatestRun: true,
  });
  if (!cancelled?.success) {
    if (cancelled?.code === 'MACHINE_IPC_CAPABILITY_DENIED') {
      machineCapabilityToken = '';
      alert(cancelled?.error || 'Could not stop work.');
      return;
    }
    lastMachineRunRecord = {
      ...(lastMachineRunRecord || getRunbookCache(machineRunRecordCache, runbookPath) || {}),
      ...cancelled,
      exported: cancelled?.exported || cancelled?.export || lastMachineRunRecord?.exported || null,
    };
    setRunbookCache(machineRunRecordCache, runbookPath, lastMachineRunRecord);
    await refreshMachineRunList(runbookPath);
    renderRunbooksPanel();
    return;
  }
  selectedRunbookPath = runbookPath;
  const cached = lastMachineRunRecord || getRunbookCache(machineRunRecordCache, runbookPath) || {};
  lastMachineRunRecord = {
    ...cached,
    ...cancelled,
    exported: cancelled.exported || cancelled.export,
  };
  setRunbookCache(machineRunRecordCache, runbookPath, lastMachineRunRecord);
  await refreshMachineRunList(runbookPath);
  renderRunbooksPanel();
  void refreshWorkspaceRunbookSummary();
}

async function cancelSelectedMachineRun(runbookPath, runId) {
  if (!workspacePath || !runbookPath || !runId || !window.orpad?.machine?.cancelRun) return;
  if (!await ensureMachineRuntimeReady()) return;
  const token = await requestMachineCapabilityToken();
  if (!token) return;
  setMachineRunActionPending(runbookPath, runId, true);
  rerenderPipelinePreviewIfActive(runbookPath);
  let cancelled = null;
  try {
    cancelled = await window.orpad.machine.cancelRun({
      workspacePath,
      pipelinePath: runbookPath,
      runId,
      toState: 'blocked',
      capabilityToken: token,
      exportLatestRun: true,
    });
  } catch (err) {
    setMachineRunActionPending(runbookPath, runId, false);
    rerenderPipelinePreviewIfActive(runbookPath);
    alert(err?.message || 'Could not stop the run.');
    return;
  }
  setMachineRunActionPending(runbookPath, runId, false);
  if (!cancelled?.success) {
    if (cancelled?.code === 'MACHINE_IPC_CAPABILITY_DENIED') machineCapabilityToken = '';
    alert(cancelled?.error || 'Could not stop the run.');
    rerenderPipelinePreviewIfActive(runbookPath);
    return;
  }
  selectedRunbookPath = runbookPath;
  lastMachineRunRecord = machineUpdateRunRecord(runbookPath, cancelled);
  await refreshMachineRunList(runbookPath);
  renderRunbooksPanel();
  rerenderPipelinePreviewIfActive(runbookPath);
  void refreshWorkspaceRunbookSummary();
}

async function exportSelectedMachineRun(runbookPath, runId) {
  if (!workspacePath || !runbookPath || !runId || !window.orpad?.machine) return;
  if (!await ensureMachineRuntimeReady()) return;
  const token = await requestMachineCapabilityToken();
  if (!token) return;
  const exported = await window.orpad.machine.exportLatestRun({
    workspacePath,
    pipelinePath: runbookPath,
    runId,
    capabilityToken: token,
    allowOverwrite: true,
  });
  if (!exported?.success) {
    if (exported?.code === 'MACHINE_IPC_CAPABILITY_DENIED') {
      machineCapabilityToken = '';
    }
    alert(exported?.error || 'Evidence save failed.');
    return;
  }
  const cached = lastMachineRunRecord || getRunbookCache(machineRunRecordCache, runbookPath) || { runId, events: [] };
  lastMachineRunRecord = {
    ...cached,
    exported,
  };
  setRunbookCache(machineRunRecordCache, runbookPath, lastMachineRunRecord);
  await refreshMachineRunList(runbookPath);
  renderRunbooksPanel();
}

async function decideSelectedMachineApproval(runbookPath, runId, approvalId, decision) {
  if (!workspacePath || !runbookPath || !runId || !approvalId || !window.orpad?.machine?.decideApproval) return;
  if (!await ensureMachineRuntimeReady()) return;
  const token = await requestMachineCapabilityToken();
  if (!token) return;
  const decided = await window.orpad.machine.decideApproval({
    workspacePath,
    pipelinePath: runbookPath,
    runId,
    approvalId,
    decision,
    capabilityToken: token,
    exportLatestRun: true,
  });
  if (!decided?.success) {
    if (decided?.code === 'MACHINE_IPC_CAPABILITY_DENIED') {
      machineCapabilityToken = '';
    }
    alert(decided?.error || 'Permission decision failed.');
    return;
  }
  selectedRunbookPath = runbookPath;
  const cached = lastMachineRunRecord || getRunbookCache(machineRunRecordCache, runbookPath) || {};
  lastMachineRunRecord = {
    ...cached,
    ...decided,
    exported: decided.exported || decided.export,
  };
  setRunbookCache(machineRunRecordCache, runbookPath, lastMachineRunRecord);
  await refreshMachineRunList(runbookPath);
  renderRunbooksPanel();
  void refreshWorkspaceRunbookSummary();
}

function machineMarkdownCell(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function machineSafeRunArtifactPath(record, artifactPath) {
  const rawRunRoot = runbookNormalizePath(record?.runRoot || '');
  const runRoot = (/^[a-z]:\//i.test(rawRunRoot) || rawRunRoot.startsWith('/'))
    ? rawRunRoot
    : normalizeRunbookFilePath(`${runbookNormalizePath(workspacePath || '')}/${rawRunRoot}`);
  const ref = runbookNormalizePath(artifactPath || '');
  if (!runRoot || !ref || /^[a-z]:\//i.test(ref) || ref.startsWith('/')) return '';
  const normalized = normalizeRunbookFilePath(`${runRoot}/${ref}`);
  const root = runRoot.replace(/\/+$/, '').toLowerCase();
  return normalized.toLowerCase().startsWith(`${root}/`) ? normalized : '';
}

function machineLineCount(value, exists = true) {
  if (!exists) return 0;
  const text = String(value ?? '');
  if (!text) return 0;
  return text.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

async function machineSha256Text(value) {
  if (!window.crypto?.subtle || typeof TextEncoder === 'undefined') return '';
  const bytes = new TextEncoder().encode(String(value ?? ''));
  const digest = await window.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function machineWorkspacePatchPath(relativePath) {
  const root = runbookNormalizePath(workspacePath || '').replace(/\/+$/g, '');
  const rel = runbookNormalizePath(relativePath || '').replace(/^\/+/g, '');
  if (!root || !rel || rel === '.' || rel === '..' || rel.startsWith('../') || /^[a-z]:\//i.test(rel)) return '';
  return normalizeRunbookFilePath(`${root}/${rel}`);
}

function machinePatchChangeStats(change) {
  const beforeLines = machineLineCount(change?.beforeContent, change?.beforeExists !== false);
  const afterLines = machineLineCount(change?.afterContent, change?.afterExists !== false);
  let action = 'Modified';
  if (change?.beforeExists === false && change?.afterExists !== false) action = 'Added';
  else if (change?.beforeExists !== false && change?.afterExists === false) action = 'Deleted';
  const delta = afterLines - beforeLines;
  const deltaLabel = delta > 0 ? `+${delta}` : String(delta);
  return {
    action,
    beforeLines,
    afterLines,
    deltaLabel,
    beforeSha: String(change?.beforeSha256 || '').slice(0, 12),
    afterSha: String(change?.afterSha256 || '').slice(0, 12),
  };
}

async function machinePatchChangeSummary(change) {
  const expectedSha = change?.beforeExists === false ? '' : String(change?.beforeSha256 || '');
  const summary = {
    path: change.path,
    ...machinePatchChangeStats(change),
    baseMatches: null,
    currentSha: '',
    expectedSha: expectedSha.slice(0, 12),
    baseMessage: '',
  };
  const filePath = machineWorkspacePatchPath(change.path);
  if (!filePath || !window.orpad?.readFile || !window.crypto?.subtle) return summary;
  try {
    const result = await window.orpad.readFile(filePath);
    const currentText = result?.error ? null : String(result?.content ?? '');
    const currentSha = currentText === null ? '' : await machineSha256Text(currentText);
    summary.currentSha = currentSha.slice(0, 12);
    summary.baseMatches = currentSha === expectedSha;
    summary.baseMessage = summary.baseMatches
      ? 'Workspace matches this patch base.'
      : 'Workspace already differs from this patch base.';
  } catch (err) {
    summary.baseMessage = `Workspace base could not be checked: ${err?.message || err}`;
  }
  return summary;
}

async function machinePatchArtifactSummary(record, workerReview) {
  if (!workerReview?.patchArtifact) return null;
  const filePath = machineSafeRunArtifactPath(record, workerReview.patchArtifact);
  if (!filePath || !window.orpad?.readFile) {
    return { error: 'Patch artifact could not be read from the run snapshot.' };
  }
  try {
    const result = await window.orpad.readFile(filePath);
    const patch = JSON.parse(result?.content || '{}');
    if (patch?.schemaVersion !== 'orpad.patchArtifact.v1') {
      return { error: 'Patch artifact schema is not recognized.' };
    }
    const changes = Array.isArray(patch.changes) ? patch.changes : [];
    const violations = Array.isArray(patch.violations) ? patch.violations : [];
    const allowedFiles = Array.isArray(patch.allowedFiles) ? patch.allowedFiles : [];
    const summarizedChanges = await Promise.all(changes
      .filter(change => change?.path)
      .slice(0, 12)
      .map(change => machinePatchChangeSummary(change)));
    return {
      schemaVersion: patch.schemaVersion,
      createdAt: patch.createdAt || '',
      allowedFileCount: allowedFiles.length,
      changeCount: changes.length,
      violationCount: violations.length,
      changes: summarizedChanges,
      hasMoreChanges: changes.length > 12,
      violations: violations
        .filter(violation => violation?.path || violation?.reason)
        .slice(0, 5)
        .map(violation => `${violation.path || 'unknown'}${violation.reason ? ` (${violation.reason})` : ''}`),
    };
  } catch (err) {
    return { error: `Patch artifact summary unavailable: ${err?.message || err}` };
  }
}

function machinePatchArtifactMarkdown(summary) {
  if (!summary) return [];
  if (summary.error) return [`Patch artifact summary: ${summary.error}`];
  const lines = [
    `Patch artifact summary: ${machineCountLabel(summary.changeCount, 'file change')}; ${machineCountLabel(summary.allowedFileCount, 'allowed file')}; ${machineCountLabel(summary.violationCount, 'write-set violation')}.`,
    summary.createdAt ? `Patch created: ${summary.createdAt}` : '',
    '',
    'What this means:',
    '- The worker produced a patch artifact in run evidence.',
    '- The canonical workspace files were not changed by opening this review.',
    '- Review the changed files below before applying anything manually.',
    '',
    'Next actions:',
    '- Save Evidence keeps a reviewable snapshot of this run.',
    '- Review Evidence shows what the worker proposed.',
    '- Continue runs the next machine step; it does not apply this patch to the workspace.',
  ].filter(Boolean);
  if (summary.changes.length) {
    lines.push(
      '',
      'Changed files:',
      ...summary.changes.map(change => (
        `- \`${change.path}\`: ${change.action}; ${change.beforeLines} -> ${change.afterLines} lines (${change.deltaLabel}); SHA ${change.beforeSha || 'none'} -> ${change.afterSha || 'none'}`
      )),
    );
    if (summary.hasMoreChanges) lines.push('', `_Additional file changes are recorded in the patch artifact._`);
  }
  if (summary.violations.length) {
    lines.push('', `Write-set violations: ${summary.violations.join(', ')}`);
  }
  return lines;
}

function machinePatchReviewKey(runbookPath, runId, patchArtifact) {
  return `${runbookNormalizePath(runbookPath).toLowerCase()}::${runId}::${patchArtifact}`;
}

async function approveMachinePatchSelection(runbookPath, runId, workerReview, selectedFiles) {
  if (!workspacePath || !runbookPath || !runId || !workerReview?.patchArtifact || !window.orpad?.machine?.approvePatch) return null;
  const token = await requestMachineCapabilityToken();
  if (!token) return null;
  const approved = await window.orpad.machine.approvePatch({
    workspacePath,
    pipelinePath: runbookPath,
    runId,
    capabilityToken: token,
    patchArtifact: workerReview.patchArtifact,
    selectedFiles,
    exportLatestRun: true,
  });
  if (!approved?.success) {
    if (approved?.code === 'MACHINE_IPC_CAPABILITY_DENIED') machineCapabilityToken = '';
    alert(approved?.error || 'Patch approval could not be recorded.');
    return null;
  }
  selectedRunbookPath = runbookPath;
  lastMachineRunRecord = machineUpdateRunRecord(runbookPath, approved);
  await refreshMachineRunList(runbookPath);
  renderRunbooksPanel();
  void refreshWorkspaceRunbookSummary();
  return approved;
}

async function applyAllApprovedMachinePatches(runbookPath, runId) {
  if (!workspacePath || !runbookPath || !runId || !window.orpad?.machine?.applyApprovedPatches) return null;
  const token = await requestMachineCapabilityToken();
  if (!token) return null;
  const applied = await window.orpad.machine.applyApprovedPatches({
    workspacePath,
    pipelinePath: runbookPath,
    runId,
    capabilityToken: token,
    exportLatestRun: true,
  });
  if (!applied?.success) {
    if (applied?.code === 'MACHINE_IPC_CAPABILITY_DENIED') machineCapabilityToken = '';
    if (applied?.code === 'BATCH_APPLY_IN_FLIGHT') {
      // Another window or invocation is already running the batch; let it finish.
      if (applied?.runState || applied?.events) {
        lastMachineRunRecord = machineUpdateRunRecord(runbookPath, applied);
        renderRunbooksPanel();
      }
      return null;
    }
    alert(applied?.error || 'Approved patches could not be applied.');
    return null;
  }
  selectedRunbookPath = runbookPath;
  lastMachineRunRecord = machineUpdateRunRecord(runbookPath, applied);
  await refreshMachineRunList(runbookPath);
  renderRunbooksPanel();
  await loadFileTree();
  void refreshWorkspaceRunbookSummary();
  if (applied.appliedCount > 0 || applied.conflictCount > 0) {
    rerenderPipelinePreviewIfActive(runbookPath);
  }
  if (applied.conflictCount > 0) {
    const conflictDetails = (applied.results || [])
      .filter(item => item && !item.ok)
      .slice(0, 5)
      .map(item => {
        const paths = (item.mismatches || []).map(entry => `- ${entry.path || 'unknown'}`).join('\n');
        return `${item.patchArtifact}: ${item.message || item.code || 'apply failed'}${paths ? `\n${paths}` : ''}`;
      })
      .join('\n\n');
    alert(`${applied.appliedCount} patch${applied.appliedCount === 1 ? '' : 'es'} applied; ${applied.conflictCount} could not be applied because the workspace already moved.\n\n${conflictDetails}`);
  }
  return applied;
}

async function finalizePatchReviewQueue(runbookPath, runId, record) {
  const apply = await applyAllApprovedMachinePatches(runbookPath, runId);
  const latest = lastMachineRunRecord || record;
  if (machineHasBlockedPatchReviewNode(latest)) {
    await executeSelectedMachineRunStep(runbookPath, runId);
  }
  return apply;
}

async function recordMachinePatchReviewDecision(runbookPath, runId, workerReview, decision = 'skipped') {
  if (!workspacePath || !runbookPath || !runId || !workerReview?.patchArtifact || !window.orpad?.machine?.reviewPatch) return null;
  const token = await requestMachineCapabilityToken();
  if (!token) return null;
  const reviewed = await window.orpad.machine.reviewPatch({
    workspacePath,
    pipelinePath: runbookPath,
    runId,
    capabilityToken: token,
    patchArtifact: workerReview.patchArtifact,
    decision,
    exportLatestRun: true,
  });
  if (!reviewed?.success) {
    if (reviewed?.code === 'MACHINE_IPC_CAPABILITY_DENIED') machineCapabilityToken = '';
    alert(reviewed?.error || 'Patch review could not be recorded.');
    return null;
  }
  selectedRunbookPath = runbookPath;
  lastMachineRunRecord = machineUpdateRunRecord(runbookPath, reviewed);
  await refreshMachineRunList(runbookPath);
  renderRunbooksPanel();
  void refreshWorkspaceRunbookSummary();
  return reviewed;
}

async function machineWorkerItemDetails(record, workerReview) {
  const itemId = workerReview?.itemId || machineLatestWorkerEvent(record)?.itemId || '';
  if (!itemId || !window.orpad?.readFile) return null;
  const transition = [...(record?.events || [])].reverse().find(event => (
    event?.eventType === 'queue.transition'
    && event.itemId === itemId
    && (event.artifactRefs || []).some(ref => /^queue\//.test(ref))
  ));
  const itemPath = (transition?.artifactRefs || []).find(ref => /^queue\//.test(ref)) || '';
  const filePath = machineSafeRunArtifactPath(record, itemPath);
  if (!filePath) return { itemId };
  try {
    const result = await window.orpad.readFile(filePath);
    const item = JSON.parse(result?.content || '{}');
    return {
      itemId,
      title: item.title || itemId,
      issueType: item.issueType || '',
      userImpact: item.userImpact || '',
      expectedBehavior: item.expectedBehavior || '',
      actualBehavior: item.actualBehavior || '',
      acceptanceCriteria: Array.isArray(item.acceptanceCriteria) ? item.acceptanceCriteria : [],
    };
  } catch {
    return { itemId };
  }
}

function openMachinePatchReviewModal(runbookPath, runId, record, workerReview, patchSummary, itemDetails = null, options = {}) {
  if (!workerReview?.patchArtifact || !patchSummary || patchSummary.error || !patchSummary.changes?.length) return;
  const body = document.createElement('div');
  body.className = 'runbook-modal-body';
  const title = itemDetails?.title || itemDetails?.itemId || 'Machine patch';
  const reviewIndex = Number(options.reviewIndex) || 1;
  const reviewCount = Number(options.reviewCount) || 1;
  const pendingCount = Number(options.pendingCount) || 1;
  const reviewTitle = reviewCount > 1 ? `Review Patch ${reviewIndex} of ${reviewCount}` : 'Review Patch';
  // hasNextReview reflects whether any other patch is still awaiting a decision after this
  // one resolves, regardless of where the current patch sits in production order. This keeps
  // the "Approve & Apply" button on the very last pending review even when earlier patches
  // were skipped or already applied in a prior batch.
  const hasNextReview = pendingCount > 1;
  const criteria = (itemDetails?.acceptanceCriteria || []).slice(0, 3);
  const conflictCount = patchSummary.changes.filter(change => change.baseMatches === false).length;
  const applicableCount = patchSummary.changes.filter(change => change.baseMatches !== false).length;
  const changeRows = patchSummary.changes.map((change, index) => `
    <label class="runbook-diagnostic ${change.baseMatches === false ? 'warning' : ''}" style="display:block; margin:8px 0;">
      <input type="checkbox" data-machine-patch-file value="${escapeHtml(change.path)}" ${change.baseMatches === false ? 'disabled' : ''} ${change.baseMatches !== false && index < 20 ? 'checked' : ''}>
      <strong>${escapeHtml(change.path)}</strong><br>
      <span>${escapeHtml(String(change.action))}; ${escapeHtml(String(change.beforeLines))} -> ${escapeHtml(String(change.afterLines))} lines (${escapeHtml(String(change.deltaLabel))}); SHA ${escapeHtml(change.beforeSha || 'none')} -> ${escapeHtml(change.afterSha || 'none')}</span>
      ${change.baseMessage ? `<br><span>${escapeHtml(change.baseMessage)}${change.baseMatches === false ? ` Expected ${escapeHtml(change.expectedSha || 'none')}, current ${escapeHtml(change.currentSha || 'none')}.` : ''}</span>` : ''}
    </label>
  `).join('');
  const openNextReview = () => {
    setTimeout(() => {
      maybeOpenMachinePatchReviewModal(runbookPath, lastMachineRunRecord || record)
        .catch(err => notifyFormatError('Pipes', err));
    }, 0);
  };
  body.innerHTML = `
    <p>The run produced a patch for <strong>${escapeHtml(title)}</strong>. Choose the files to apply to the workspace, or cancel and keep it as review-only evidence.</p>
    ${reviewCount > 1 ? `<div class="runbook-diagnostic warning"><strong>${escapeHtml(String(reviewCount))} patch results</strong> Review each worker patch before treating the run as applied.</div>` : ''}
    ${itemDetails?.userImpact ? `<div class="runbook-diagnostic"><strong>Why</strong> ${escapeHtml(itemDetails.userImpact)}</div>` : ''}
    ${itemDetails?.actualBehavior || itemDetails?.expectedBehavior ? `<div class="runbook-diagnostic"><strong>Change goal</strong> ${escapeHtml([itemDetails.actualBehavior, itemDetails.expectedBehavior].filter(Boolean).join(' -> '))}</div>` : ''}
    ${criteria.length ? `<div class="runbook-diagnostic"><strong>Acceptance</strong><ul>${criteria.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
    <div class="runbook-diagnostic warning"><strong>Workspace not changed yet.</strong> ${reviewCount > 1
      ? 'Approving queues the selection. Files are written together after every patch in this run is reviewed.'
      : 'Approving applies the selected files immediately after a fresh base SHA check.'}</div>
    ${conflictCount ? `<div class="runbook-diagnostic warning"><strong>${escapeHtml(machineCountLabel(conflictCount, 'conflicting file'))}</strong> already changed in the workspace, likely by an earlier approved patch. Conflicting files are unchecked and cannot be applied from this patch without a follow-up run.</div>` : ''}
    <div class="runbook-diagnostic">Patch artifact: ${escapeHtml(workerReview.patchArtifact)}</div>
    <div class="runbook-diagnostic">${escapeHtml(machineCountLabel(patchSummary.changeCount, 'file change'))}; ${escapeHtml(machineCountLabel(patchSummary.violationCount, 'write-set violation'))}</div>
    <div style="max-height:280px; overflow:auto; margin-top:8px;">${changeRows}</div>
    <label style="display:block; margin-top:12px;">
      Follow-up prompt
      <textarea class="runbook-task-input" data-machine-patch-prompt rows="3" placeholder="Optional: tell OrPAD what to do in the next Continue run."></textarea>
    </label>
  `;
  const selectedFiles = () => [...body.querySelectorAll('[data-machine-patch-file]:checked')]
    .map(input => input.value)
    .filter(Boolean);
  openFmtModal({
    title: reviewTitle,
    body,
    footer: [
      {
        label: reviewCount > 1 ? 'Skip Patch' : 'Cancel',
        onClick: async () => {
          const reviewed = await recordMachinePatchReviewDecision(runbookPath, runId, workerReview, 'skipped');
          if (reviewed) {
            closeFmtModal();
            if (hasNextReview) openNextReview();
            else await finalizePatchReviewQueue(runbookPath, runId, record);
          }
        },
      },
      {
        label: 'Continue with Prompt',
        onClick: async () => {
          const prompt = body.querySelector('[data-machine-patch-prompt]')?.value || '';
          if (prompt.trim()) {
            runbookDraftTask = prompt;
            localStorage.setItem(RUNBOOK_TASK_STORAGE_KEY, runbookDraftTask);
          }
          const reviewed = await recordMachinePatchReviewDecision(runbookPath, runId, workerReview, 'follow-up');
          if (reviewed) {
            closeFmtModal();
            await applyAllApprovedMachinePatches(runbookPath, runId);
            await executeSelectedMachineRunStep(runbookPath, runId);
          }
        },
      },
      {
        label: hasNextReview ? 'Approve & Next' : 'Approve & Apply',
        primary: true,
        disabled: applicableCount === 0,
        onClick: async () => {
          const files = selectedFiles();
          if (!files.length) {
            alert('Select at least one file to approve.');
            return;
          }
          const approved = await approveMachinePatchSelection(runbookPath, runId, workerReview, files);
          if (approved) {
            closeFmtModal();
            if (hasNextReview) openNextReview();
            else await finalizePatchReviewQueue(runbookPath, runId, record);
          }
        },
      },
    ],
  });
}

async function maybeOpenMachinePatchReviewModal(runbookPath, record) {
  const runId = record?.runState?.runId || record?.runId || '';
  if (!runbookPath || !runId) return;
  if (isMachineRunInProgress(record, runbookPath)) return;
  if (machinePatchBatchInFlight(record)) return;
  // Never replace a modal the user is currently looking at — openFmtModal would silently
  // overwrite their pending decision. The next polling tick (or the modal's onClick chain)
  // will pick the next patch up after the current modal closes.
  if (fmtModalEl && !fmtModalEl.classList.contains('hidden')) return;
  const allReviews = machineWorkerReviewInfos(record)
    .filter(review => review?.patchArtifact);
  const pendingReviews = allReviews.filter(review => review.patchReviewStatus === 'pending');
  const workerReview = pendingReviews.find(review => (
    !machinePatchReviewShown.has(machinePatchReviewKey(runbookPath, runId, review.patchArtifact))
  ));
  if (!workerReview?.patchArtifact) return;
  const key = machinePatchReviewKey(runbookPath, runId, workerReview.patchArtifact);
  let patchSummary = await machinePatchArtifactSummary(record, workerReview);
  if (!patchSummary || patchSummary.error || !patchSummary.changes?.length) {
    const changedFiles = workerReview.changedFiles || [];
    if (!changedFiles.length) return;
    patchSummary = {
      changeCount: changedFiles.length,
      violationCount: 0,
      changes: changedFiles.map(path => ({
        path,
        action: 'Changed',
        beforeLines: '?',
        afterLines: '?',
        deltaLabel: '?',
        beforeSha: '',
        afterSha: '',
      })),
    };
  }
  machinePatchReviewShown.add(key);
  const itemDetails = await machineWorkerItemDetails(record, workerReview);
  // Counter shows linear progress through every patch produced this run, not just the
  // pending ones, so approvals do not shrink the denominator (1/14 -> 2/14, never 1/13).
  openMachinePatchReviewModal(runbookPath, runId, record, workerReview, patchSummary, itemDetails, {
    reviewIndex: allReviews.findIndex(review => review.patchArtifact === workerReview.patchArtifact) + 1,
    reviewCount: allReviews.length,
    pendingCount: pendingReviews.length,
  });
}

async function openMachineArtifactViewer(runbookPath, runId) {
  if (!workspacePath || !runbookPath || !runId) return;
  let record = getRunbookCache(machineRunRecordCache, runbookPath) || lastMachineRunRecord;
  const recordRunId = record?.runState?.runId || record?.runId || '';
  if (!record || recordRunId !== runId) {
    record = await loadMachineRunRecord(runbookPath, runId);
  }
  if (!record) {
    alert('Run snapshot could not be loaded.');
    return;
  }

  const runState = record.runState || {};
  const files = machineArtifactManifestFiles(record);
  const exported = record.exported || null;
  const manifest = exported?.metadata?.artifactManifest || null;
  const auditDetails = machineAuditDetails(record);
  const actualRunId = runState.runId || record.runId || runId;
  const workerReviews = machineWorkerReviewInfos(record)
    .filter(review => review.patchArtifact || review.changedFiles.length || review.status);
  const patchArtifactSummaries = await Promise.all(workerReviews.map(review => machinePatchArtifactSummary(record, review)));
  const actualRunLabel = machineRunDisplayLabel({
    runId: actualRunId,
    createdAt: runState.createdAt || record.createdAt,
    updatedAt: runState.updatedAt || record.updatedAt,
  });
  const artifactTitleLabel = actualRunLabel.replace(/[<>:"/\\|?*]+/g, '-');
  const table = files.length ? [
    '| Path | Size | Produced by | Registered by | SHA-256 |',
    '| --- | ---: | --- | --- | --- |',
    ...files.map(file => [
      '|',
      machineMarkdownCell(file.path),
      '|',
      machineMarkdownCell(file.size),
      '|',
      machineMarkdownCell(file.producedBy),
      '|',
      machineMarkdownCell(file.registeredBy),
      '|',
      machineMarkdownCell(file.sha256),
      '|',
    ].join(' ')),
  ] : ['_No evidence files recorded yet._'];
  const patchReview = workerReviews.length ? [
    '## Patch Review',
    '',
    `${machineCountLabel(workerReviews.length, 'worker result')} recorded.`,
    ...workerReviews.flatMap((review, index) => [
      '',
      `### Worker Patch ${index + 1}`,
      '',
      review.itemId ? `Work item: ${review.itemId}` : '',
      `Worker result: ${machineWorkerStatusLabel(review.status)}`,
      `Workspace changed: no, changes are staged in run evidence only`,
      review.patchArtifact ? `Patch artifact: ${review.patchArtifact}` : '',
      ...machinePatchArtifactMarkdown(patchArtifactSummaries[index]),
      review.changedFiles.length ? `Changed files staged in evidence: ${review.changedFiles.join(', ')}` : '',
      review.missingExpectedChanges.length ? `Missing expected changes: ${review.missingExpectedChanges.join(', ')}` : '',
      review.evidenceArtifacts.length ? `Worker evidence: ${review.evidenceArtifacts.join(', ')}` : '',
      review.message ? `Message: ${review.message}` : '',
    ].filter(Boolean)),
    '',
  ].filter(Boolean) : [];
  const metadataLines = [
    `Run: ${actualRunLabel}`,
    `Lifecycle: ${runState.lifecycleStatus || 'unknown'}`,
    `Summary: ${runState.summaryStatus || 'unknown'}`,
    `Evidence source: ${machineArtifactManifestSource(record)}`,
    `Files: ${machineCountLabel(files.length, 'file')}`,
    record.runRoot ? 'Storage: Run snapshot available' : '',
    exported?.targetRoot || exported?.latestRunExportPath ? 'Evidence snapshot saved' : '',
    manifest?.sourceEventSequence != null ? `Source event sequence: ${manifest.sourceEventSequence}` : '',
  ].filter(Boolean);
  const body = [
    '# Run Evidence',
    '',
    ...metadataLines,
    '',
    '## Audit',
    '',
    auditDetails.text,
    '',
    ...patchReview,
    '## Files',
    '',
    ...table,
    '',
  ].join('\n');

  createTab(null, null, body, body, {
    title: `Run Evidence ${artifactTitleLabel}.md`,
    viewType: 'markdown',
    forceUnsaved: false,
  });
}

function openWorkspaceDashboardNote() {
  const summary = workspaceRunbookSummary || buildWorkspaceRunbookSummary();
  const body = [
    '# OrPAD Workspace Dashboard',
    '',
    `Workspace: ${workspacePath || ''}`,
    `Type: ${summary.workspaceType}`,
    '',
    '## Facts',
    '',
    `- Files indexed: ${summary.fileCount}`,
    `- Pipelines: ${(summary.pipelines || []).length}`,
    `- Legacy runbooks: ${(summary.legacyRunbooks || []).length}`,
    `- Markdown/docs: ${summary.markdownCount}`,
    `- Structured files: ${summary.dataCount}`,
    `- Redaction candidates: ${summary.risky.length}`,
    '',
    '## Pipelines',
    '',
    ...(summary.runbooks.length ? summary.runbooks.map(item => `- ${runbookRelativePath(item.path)}`) : ['- None detected']),
    '',
    '## Default Context Policy',
    '',
    '- Include selected pipeline, entry flow, declared skill files, rules, and workspace index facts.',
    '- Exclude `.env`, key-like files, and secret-like paths by default.',
    '- Require exact permission before command, write, URL, MCP, or provider-send actions.',
  ].join('\n');
  createTab(null, null, body, '', { title: 'Workspace Dashboard.md', viewType: 'markdown', forceUnsaved: true });
}

function workspaceChildPath(...parts) {
  const root = runbookNormalizePath(workspacePath).replace(/\/+$/, '');
  return [root, ...parts.map(part => String(part || '').replace(/^\/+|\/+$/g, ''))].filter(Boolean).join('/');
}

function runbookTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function runbookSlug(value, fallback = 'orpad-pipeline') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function normalizeRunbookTask(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function currentRunbookTaskText() {
  return normalizeRunbookTask(runbookDraftTask);
}

function hasExternalResearchIntent(taskText) {
  return EXTERNAL_RESEARCH_INTENT_PATTERN.test(normalizeRunbookTask(taskText));
}

function externalResearchLimitationText() {
  return 'Local-only generated run: external competitor claims require approved browsing or attached research evidence. Without that evidence, the run must report a research gap and propose only local evidence-backed work.';
}

function externalResearchDecisionKey(runbookPath, runId = '') {
  return `${runbookNormalizePath(runbookPath).toLowerCase()}::${runId || 'draft'}`;
}

async function externalResearchLaunchContext(runbookPath, taskText) {
  const normalizedTaskText = normalizeRunbookTask(taskText);
  let doc = null;
  try {
    if (runbookPath && /\.or-pipeline$/i.test(runbookPath)) doc = await readRendererJson(runbookPath);
  } catch {
    doc = null;
  }
  const metadata = doc?.metadata?.externalResearch || {};
  const limitation = metadata.limitation || doc?.run?.externalResearchLimitation || '';
  const intentText = [normalizedTaskText, doc?.title, doc?.description].filter(Boolean).join(' ');
  const intentDetected = hasExternalResearchIntent(intentText) || !!limitation;
  return {
    intentDetected,
    limitation: limitation || externalResearchLimitationText(),
    requiredEvidence: metadata.requiredEvidence || 'approved browsing or attached research evidence',
    fallback: metadata.fallback || 'report a research gap and propose only local evidence-backed work',
  };
}

function buildExternalResearchRunState(context, mode) {
  const localOnly = mode === 'local-only-research-gap';
  return {
    schemaVersion: 'orpad.externalResearchRun.v1',
    intentDetected: true,
    mode: localOnly ? 'local-only-research-gap' : 'approved-or-attached-evidence',
    evidence: {
      status: localOnly ? 'not-provided' : 'approved-or-attached',
      source: 'user-prelaunch-choice',
    },
    limitation: context.limitation,
    requiredEvidence: context.requiredEvidence,
    fallback: context.fallback,
    downstreamInstruction: localOnly
      ? 'Treat external competitor research as unavailable; report a research gap and use only local workspace evidence.'
      : 'Use only the approved browsing result or attached research evidence; do not invent competitor claims.',
  };
}

function requestExternalResearchRunState(context) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (state) => {
      if (settled) return;
      settled = true;
      closeFmtModal();
      resolve(state);
    };
    const body = document.createElement('div');
    body.innerHTML = `
      <p>This task asks for external competitor, market, benchmark, or web research.</p>
      <div class="runbook-diagnostic warning">${escapeHtml(context.limitation)}</div>
      <div class="runbook-diagnostic"><strong>Evidence mode</strong> Choose whether approved browsing or attached research evidence is available, or run local-only and record a research gap.</div>
    `;
    openFmtModal({
      title: 'External Research Mode',
      body,
      onClose: () => finish(null),
      footer: [
        { label: 'Cancel', onClick: () => finish(null) },
        {
          label: 'Use Approved Evidence',
          onClick: () => finish(buildExternalResearchRunState(context, 'approved-or-attached-evidence')),
        },
        {
          label: 'Run Local-Only',
          primary: true,
          onClick: () => finish(buildExternalResearchRunState(context, 'local-only-research-gap')),
        },
      ],
    });
  });
}

async function ensureExternalResearchRunState(runbookPath, taskText, runId = '', providedState = null) {
  if (providedState?.intentDetected) return providedState;
  const context = await externalResearchLaunchContext(runbookPath, taskText);
  if (!context.intentDetected) return null;
  const keys = [
    externalResearchDecisionKey(runbookPath, runId),
    externalResearchDecisionKey(runbookPath),
  ];
  for (const key of keys) {
    const cached = machineRunExternalResearchDecisions.get(key);
    if (cached?.intentDetected) return cached;
  }
  const state = await requestExternalResearchRunState(context);
  if (!state) return null;
  machineRunExternalResearchDecisions.set(externalResearchDecisionKey(runbookPath), state);
  if (runId) machineRunExternalResearchDecisions.set(externalResearchDecisionKey(runbookPath, runId), state);
  return state;
}

function renderRunbookExternalResearchWarning(taskText) {
  const visible = hasExternalResearchIntent(taskText);
  return `
    <div class="runbook-diagnostic warning" data-runbook-external-research-warning ${visible ? '' : 'hidden'}>
      ${visible ? escapeHtml(externalResearchLimitationText()) : ''}
    </div>
  `;
}

function syncRunbookExternalResearchWarning(taskText) {
  const warning = runbooksContentEl?.querySelector('[data-runbook-external-research-warning]');
  if (!warning) return;
  const visible = hasExternalResearchIntent(taskText);
  warning.hidden = !visible;
  warning.textContent = visible ? externalResearchLimitationText() : '';
}

function extractMarkdownFence(text) {
  const match = String(text || '').match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
  return (match?.[1] || text || '').trim();
}

function externalResearchSkillGuard(taskText) {
  if (!hasExternalResearchIntent(taskText)) return '';
  return [
    '## External Competitor Research Guard',
    '',
    '- External competitor, market, benchmark, and web research claims require approved browsing or attached research evidence.',
    '- If approved browsing or attached evidence is unavailable, report a research gap instead of presenting competitor claims as verified.',
    '- Propose and implement only improvements backed by local workspace evidence until external research evidence is supplied.',
    '',
  ].join('\n');
}

function addExternalResearchSkillGuard(markdown, taskText) {
  const guard = externalResearchSkillGuard(taskText);
  if (!guard) return markdown;
  const base = String(markdown || '').trim();
  if (base.includes('## External Competitor Research Guard')) return `${base}\n`;
  return `${base}\n\n${guard}`;
}

function defaultOrpadRunbookSkill(taskText) {
  return [
    '# OrPAD Pipeline Skill',
    '',
    'Use the current workspace to implement the user request through a small, reviewable OrPAD run.',
    '',
    '## User Request',
    '',
    taskText,
    '',
    '## Include',
    '',
    '- README.md',
    '- package metadata',
    '- existing pipeline, flow, tree, and harness files',
    '- relevant source files',
    '- tests and harness summaries when relevant',
    '- Markdown notes already inside this workspace when they clarify the task',
    '',
    '## Exclude',
    '',
    '- `.env` and secret-like files',
    '- raw terminal scrollback unless explicitly attached',
    '',
    '## Acceptance Criteria',
    '',
    '- Generate or update the `.orpad/pipelines/<pipeline>/` package needed for the requested work.',
    '- Keep the flow definition in `.or-graph` using workstream nodes that OrPAD can run with owned work state, progress, and evidence files.',
    '- Validate the flow before running implementation work.',
    '- Run the approved managed pipeline flow and write evidence under the pipeline `runs/` folder.',
    '- Keep source edits focused on the requested OrPAD behavior.',
    '',
  ].join('\n');
}

async function buildOrpadRunbookSkill(taskText) {
  if (aiController?.canUseProvider?.() && typeof aiController.complete === 'function') {
    try {
      const response = await aiController.complete({
        timeoutMs: 90000,
        system: 'Draft concise OrPAD skill Markdown only.',
        prompt: [
          'Create a usable OrPAD skill for this request.',
          'Include context, implementation loop, acceptance criteria, and safety constraints.',
          'It is referenced by an `.or-tree` subflow inside an OrPAD `.or-pipeline` package.',
          '',
          '<user-request>',
          taskText,
          '</user-request>',
        ].join('\n'),
      });
      const markdown = extractMarkdownFence(response);
      if (markdown) return addExternalResearchSkillGuard(markdown, taskText);
    } catch {
      // Fall back to the local template when no provider is reachable.
    }
  }
  return addExternalResearchSkillGuard(defaultOrpadRunbookSkill(taskText), taskText);
}

async function createOrpadRunbookStarter() {
  if (!workspacePath) {
    ensureSidebar('runbooks');
    return;
  }
  const taskText = normalizeRunbookTask(runbookDraftTask)
    || 'Improve this OrPAD workspace from the current user request, generate evidence, and keep changes reviewable.';
  const externalResearchIntent = hasExternalResearchIntent(taskText);
  const externalResearchLimitation = externalResearchIntent ? externalResearchLimitationText() : '';
  const stamp = runbookTimestamp();
  const slug = `${runbookSlug(taskText, 'orpad-improvement')}-${stamp.toLowerCase()}`;
  const orpadPath = workspaceChildPath('.orpad');
  const instructionsPath = workspaceChildPath('.orpad', 'instructions');
  const pipelinesPath = workspaceChildPath('.orpad', 'pipelines');
  const pipelineFolderPath = workspaceChildPath('.orpad', 'pipelines', slug);
  const graphFolderPath = workspaceChildPath('.orpad', 'pipelines', slug, 'graphs');
  const skillFolderPath = workspaceChildPath('.orpad', 'pipelines', slug, 'skills');
  const ruleFolderPath = workspaceChildPath('.orpad', 'pipelines', slug, 'rules');
  const harnessFolderPath = workspaceChildPath('.orpad', 'pipelines', slug, 'harness');
  const harnessGeneratedPath = workspaceChildPath('.orpad', 'pipelines', slug, 'harness', 'generated');
  const skillName = `orpad-improvement-${stamp}.md`;
  const pipelinePath = workspaceChildPath('.orpad', 'pipelines', slug, 'pipeline.or-pipeline');
  const graphPath = workspaceChildPath('.orpad', 'pipelines', slug, 'graphs', 'main.or-graph');
  const contextRulePath = workspaceChildPath('.orpad', 'pipelines', slug, 'rules', 'context.or-rule');
  const skillPath = `skills/${skillName}`;
  const skillFilePath = workspaceChildPath('.orpad', 'pipelines', slug, skillPath);
  const generatedCandidateLimit = 5;
  const generatedProcessUntil = [
    'queue-empty',
    'approval-required-next',
    'scope-split-required',
    'verification-blocked',
    'risk-budget-exceeded',
    'handoff-required',
  ];
  const graphNodes = [
    { id: 'entry', type: 'orpad.entry', label: 'Entry', config: { summary: 'Begin managed run.' } },
    { id: 'context', type: 'orpad.context', label: 'Prepare workspace', config: { ruleRef: 'context', skillRef: 'request-context', summary: taskText } },
    ...(externalResearchIntent ? [{
      id: 'external-research-mode',
      type: 'orpad.selector',
      label: 'Confirm external research mode',
      config: {
        selector: 'externalResearchMode',
        options: ['local-only-research-gap', 'approved-or-attached-evidence'],
        default: 'local-only-research-gap',
        externalResearchLimitation,
        requiredEvidence: 'approved browsing or attached research evidence',
        fallback: 'report a research gap and propose only local evidence-backed work',
      },
    }] : []),
    {
      id: 'probe',
      type: 'orpad.probe',
      label: 'Find evidence-backed candidate work',
      config: {
        lens: 'request-focused',
        userTask: taskText,
        skillRef: 'request-context',
        candidateLimitPolicy: 'collect-all-visible',
        ...(externalResearchIntent ? { externalResearchLimitation } : {}),
      },
    },
    { id: 'queue', type: 'orpad.workQueue', label: 'Own candidate queue state', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
    { id: 'triage', type: 'orpad.triage', label: 'Prioritize bounded work', config: { queueRef: 'queue' } },
    { id: 'dispatch', type: 'orpad.dispatcher', label: 'Claim one safe work item', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
    { id: 'worker', type: 'orpad.workerLoop', label: 'Implement claimed work in overlay', config: { queueRef: 'queue' } },
    { id: 'patch-review', type: 'orpad.patchReview', label: 'Review patch results', config: { reviewMode: 'user-selected-files' } },
    { id: 'verification-gate', type: 'orpad.gate', label: 'Verify work result', config: { criteria: ['work result accepted', 'queue empty'], onFail: 'warn' } },
    {
      id: 'artifact',
      type: 'orpad.artifactContract',
      label: 'Record run evidence',
      config: {
        artifactRoot: 'harness/generated/latest-run/artifacts',
        queueRoot: 'harness/generated/latest-run/queue',
        required: ['discovery/candidate-inventory.json'],
        requiredQueue: ['journal.jsonl'],
        onMissing: 'mark-partial',
      },
    },
    { id: 'exit', type: 'orpad.exit', label: 'Exit', config: { summary: 'Close after review and evidence checks.' } },
  ];
  const graphTransitions = [
    { id: 'entry-to-context', from: 'entry', to: 'context' },
    ...(externalResearchIntent ? [
      { id: 'context-to-external-research-mode', from: 'context', to: 'external-research-mode' },
      { id: 'external-research-mode-to-probe', from: 'external-research-mode', to: 'probe' },
    ] : [
      { id: 'context-to-probe', from: 'context', to: 'probe' },
    ]),
    { id: 'probe-to-queue', from: 'probe', to: 'queue' },
    { id: 'queue-to-triage', from: 'queue', to: 'triage' },
    { id: 'triage-to-dispatch', from: 'triage', to: 'dispatch' },
    { id: 'dispatch-to-worker', from: 'dispatch', to: 'worker' },
    { id: 'worker-to-patch-review', from: 'worker', to: 'patch-review' },
    { id: 'patch-review-to-verification-gate', from: 'patch-review', to: 'verification-gate' },
    { id: 'verification-gate-to-artifact', from: 'verification-gate', to: 'artifact' },
    { id: 'artifact-to-exit', from: 'artifact', to: 'exit' },
  ];
  const graph = {
    $schema: 'https://orpad.dev/schemas/or-graph/v1.json',
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'orpad-improvement',
      label: taskText.slice(0, 96),
      start: 'entry',
      nodes: graphNodes,
      transitions: graphTransitions,
    },
  };
  const pipeline = {
    $schema: 'https://orpad.dev/schemas/or-pipeline/v1.json',
    kind: 'orpad.pipeline',
    version: '1.0',
    id: slug,
    title: taskText.slice(0, 96),
    description: externalResearchIntent
      ? `Generated from Pipes as a local-only managed workstream pipeline. ${externalResearchLimitation}`
      : 'Generated from Pipes as a managed, queue-driven workstream pipeline.',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    nodePacks: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3', origin: 'built-in' },
      { id: 'orpad.workstream', version: '>=0.1.0', origin: 'built-in' },
    ],
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
    skills: [{ id: 'request-context', file: skillPath }],
    rules: [{ id: 'context', file: 'rules/context.or-rule' }],
    harness: { path: 'harness/generated' },
    run: {
      artifactRoot: 'harness/generated/latest-run/artifacts',
      artifactRootResolution: 'relative-to-pipeline-directory',
      queueRoot: 'harness/generated/latest-run/queue',
      queueRootResolution: 'relative-to-pipeline-directory',
      candidateInventoryPath: 'harness/generated/latest-run/artifacts/discovery/candidate-inventory.json',
      candidateInventoryPathResolution: 'relative-to-pipeline-directory',
      summaryPath: 'harness/generated/latest-run/summary.md',
      summaryPathResolution: 'relative-to-pipeline-directory',
      durableRunRoot: 'runs',
      durableRunRootResolution: 'relative-to-pipeline-directory',
      externalResearchLimitation: externalResearchIntent ? externalResearchLimitation : undefined,
      runSelection: {
        collectAllVisibleCandidates: true,
        queueAllActionableCandidates: true,
        defaultAction: 'continue-claiming',
        processUntil: generatedProcessUntil,
      },
      machineAdapter: {
        type: 'codex-cli',
        enabled: true,
        mode: 'live-mvp',
        command: 'codex',
        sandbox: 'read-only',
        proposalSandbox: 'read-only',
        workerSandbox: 'workspace-write',
        approvalPolicy: 'never',
        ephemeral: true,
        candidateLimit: generatedCandidateLimit,
        proposalTimeoutMs: 600000,
        workerTimeoutMs: 900000,
        claimLeaseMs: 1800000,
        probeNodePaths: ['main/probe'],
        triageNodePath: 'main/triage',
        dispatcherNodePath: 'main/dispatch',
        workerNodePath: 'main/worker',
        supportNodePolicy: 'record-gate-warnings-and-mark-artifact-partial',
        description: 'Generated managed-run adapter. OrPAD owns work state, run status, and evidence files; Codex CLI submits candidate/result/proof through adapter contracts.',
      },
      queueProtocol: {
        schema: 'orpad.workItem.v1',
        claimPolicy: {
          concurrency: 1,
          defaultAction: 'continue-claiming',
          processUntil: generatedProcessUntil,
          stopWhenQueueEmpty: true,
          stopOnApprovalRequired: true,
        },
      },
    },
    metadata: externalResearchIntent ? {
      externalResearch: {
        limitation: externalResearchLimitation,
        requiredEvidence: 'approved browsing or attached research evidence',
        fallback: 'report a research gap and propose only local evidence-backed work',
      },
    } : undefined,
  };
  const contextRule = {
    kind: 'orpad.rule',
    version: '1.0',
    id: 'context',
    include: ['README.md', 'package.json', '.orpad/pipelines/**'],
    exclude: ['.env', '**/*secret*', '**/*token*', '**/*.pem', '**/*.key'],
  };
  const skill = await buildOrpadRunbookSkill(taskText);

  await window.orpad.createFolder(orpadPath).catch(() => {});
  await window.orpad.createFolder(instructionsPath).catch(() => {});
  await window.orpad.createFolder(pipelinesPath).catch(() => {});
  await window.orpad.createFolder(pipelineFolderPath).catch(() => {});
  await window.orpad.createFolder(graphFolderPath).catch(() => {});
  await window.orpad.createFolder(skillFolderPath).catch(() => {});
  await window.orpad.createFolder(ruleFolderPath).catch(() => {});
  await window.orpad.createFolder(harnessFolderPath).catch(() => {});
  await window.orpad.createFolder(harnessGeneratedPath).catch(() => {});
  const pipelineCreate = await window.orpad.createFile(pipelinePath);
  if (pipelineCreate?.error) throw new Error(pipelineCreate.error);
  const graphCreate = await window.orpad.createFile(graphPath);
  if (graphCreate?.error) throw new Error(graphCreate.error);
  const skillCreate = await window.orpad.createFile(skillFilePath);
  if (skillCreate?.error) throw new Error(skillCreate.error);
  await window.orpad.createFile(contextRulePath).catch(() => {});
  const savedPipeline = await window.orpad.saveFile(pipelinePath, JSON.stringify(pipeline, null, 2));
  const savedGraph = await window.orpad.saveFile(graphPath, JSON.stringify(graph, null, 2));
  const savedSkill = await window.orpad.saveFile(skillFilePath, skill);
  const savedContextRule = await window.orpad.saveFile(contextRulePath, JSON.stringify(contextRule, null, 2));
  if (!savedPipeline || !savedGraph || !savedSkill || !savedContextRule) throw new Error('Failed to write OrPAD pipeline files.');

  selectedRunbookPath = pipelinePath;
  selectedRunbookValidation = null;
  lastRunRecord = null;
  await loadFileTree();
  workspaceRunbookSummary = buildWorkspaceRunbookSummary();
  chooseSelectedRunbook(workspaceRunbookSummary);
  renderRunbooksPanel();
  await openFileInTab(graphPath);
  await validateSelectedRunbook(pipelinePath);
  ensureSidebar('runbooks');
}

function openObsidianImportReview() {
  const summary = workspaceRunbookSummary || buildWorkspaceRunbookSummary();
  const body = [
    '# Obsidian Files Review',
    '',
    `Workspace: ${workspacePath || ''}`,
    '',
    'OrPAD reads Markdown and project files in place.',
    '',
    '## Detected',
    '',
    `- Obsidian settings folder: ${summary.hasObsidian ? '.obsidian/ detected' : 'not detected'}`,
    `- Markdown/docs: ${summary.markdownCount}`,
    `- Existing pipelines: ${(summary.pipelines || []).length}`,
    `- Legacy runbooks: ${(summary.legacyRunbooks || []).length}`,
    `- Redaction candidates: ${summary.risky.length}`,
    '',
    '## Current Policy',
    '',
    '- Read notes and project files from the opened folder.',
    '- Do not mutate `.obsidian/` settings.',
    '- Keep generated pipelines as drafts until the user saves and checks them.',
    '',
    '## Suggested Local Runs',
    '',
    '- Release claim audit from selected project/release notes.',
    '- Task evidence review from selected Markdown task lists.',
    '',
  ].join('\n');
  createTab(null, null, body, '', {
    title: 'Obsidian Import Review.md',
    viewType: 'markdown',
    forceUnsaved: true,
  });
}

contentEl?.addEventListener('click', async (event) => {
  const probeButton = event.target.closest?.('[data-probe-action]');
  if (probeButton && contentEl.contains(probeButton)) {
    event.preventDefault();
    event.stopPropagation();
    const probeAction = probeButton.dataset.probeAction || '';
    if (probeAction === 'open-artifact') {
      const artifactPath = probeButton.dataset.artifactPath || '';
      if (artifactPath) {
        try {
          await openFileInTab(artifactPath);
        } catch (err) {
          notifyFormatError('Probe artifact', err);
        }
      }
    }
    return;
  }
  const button = event.target.closest?.('[data-pipeline-run-action]');
  if (!button || !contentEl.contains(button)) return;
  event.preventDefault();
  event.stopPropagation();
  button.closest('details')?.removeAttribute('open');
  const action = button.dataset.pipelineRunAction || '';
  const runbarPath = button.closest('[data-pipeline-preview-runbar]')?.dataset.pipelinePath || '';
  const targetPath = runbarPath || button.dataset.path || pipelineContextForPath()?.pipelinePath || selectedRunbookPath || '';
  try {
    if (action === 'machine-cancel-run') {
      await cancelSelectedMachineRun(targetPath, button.dataset.runId || lastMachineRunRecord?.runState?.runId || '');
    } else {
      await runPipelinePreviewAction(action, targetPath);
    }
  } catch (err) {
    notifyFormatError('Pipeline', err);
  }
});

runbooksContentEl?.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-runbook-action]');
  if (!button) {
    const slot = event.target.closest('.runbook-item[data-runbook-path]');
    if (slot) {
      try {
        await toggleRunbookSlot(slot.dataset.runbookPath || '');
      } catch (err) {
        notifyFormatError('Runbooks', err);
      }
    }
    return;
  }
  const action = button.dataset.runbookAction;
  const targetPath = button.dataset.path || selectedRunbookPath || '';
  try {
    if (action === 'open-folder') await openFolder();
    else if (action === 'refresh') {
      const previousLabel = button.textContent;
      button.disabled = true;
      button.textContent = 'Refreshing...';
      try {
        await refreshPipesPanelState();
      } finally {
        button.disabled = false;
        button.textContent = previousLabel;
      }
    }
    else if (action === 'starter') {
      const previousLabel = button.textContent;
      button.disabled = true;
      button.textContent = 'Generating...';
      try {
        await createOrpadRunbookStarter();
      } finally {
        button.disabled = false;
        button.textContent = previousLabel;
      }
    }
    else if (action === 'import-review') openObsidianImportReview();
    else if (action === 'open-dashboard') openWorkspaceDashboardNote();
    else if (action === 'open') {
      await openFileInTab(targetPath);
      ensureSidebar('runbooks');
      renderRunbooksPanel();
    }
    else if (action === 'validate') await validateSelectedRunbook(targetPath);
    else if (action === 'run-record') await createSelectedRunRecord(targetPath);
    else if (action === 'context') await openRunbookContextInspector(targetPath, selectedRunbookValidation);
    else if (action === 'agent-handoff') await openAgentHandoffModal(targetPath, selectedRunbookValidation);
    else if (action === 'start-local') await startSelectedLocalRun(targetPath);
    else if (action === 'run-machine') await startSelectedMachineRun(targetPath);
    else if (action === 'machine-execute-step') await executeSelectedMachineRunStep(targetPath, button.dataset.runId || lastMachineRunRecord?.runState?.runId || '');
    else if (action === 'machine-resume-run') await resumeSelectedMachineRun(targetPath, button.dataset.runId || lastMachineRunRecord?.runState?.runId || '');
    else if (action === 'machine-cancel-run') await cancelSelectedMachineRun(targetPath, button.dataset.runId || lastMachineRunRecord?.runState?.runId || '');
    else if (action === 'machine-cancel-claim') await cancelSelectedMachineClaim(targetPath, button.dataset.runId || lastMachineRunRecord?.runState?.runId || '', button.dataset.claimId || '', button.dataset.itemId || '');
    else if (action === 'machine-approve-approval') await decideSelectedMachineApproval(targetPath, button.dataset.runId || lastMachineRunRecord?.runState?.runId || '', button.dataset.approvalId || '', 'approved');
    else if (action === 'machine-deny-approval') await decideSelectedMachineApproval(targetPath, button.dataset.runId || lastMachineRunRecord?.runState?.runId || '', button.dataset.approvalId || '', 'denied');
    else if (action === 'machine-export') await exportSelectedMachineRun(targetPath, button.dataset.runId || lastMachineRunRecord?.runState?.runId || '');
    else if (action === 'machine-view-artifacts') await openMachineArtifactViewer(targetPath, button.dataset.runId || lastMachineRunRecord?.runState?.runId || '');
    else if (action === 'machine-select-run') await selectMachineRunRecord(targetPath, button.dataset.runId || '');
  } catch (err) {
    notifyFormatError('Runbooks', err);
  }
});

runbooksContentEl?.addEventListener('input', (event) => {
  if (!event.target.matches?.('[data-runbook-task]')) return;
  runbookDraftTask = event.target.value || '';
  localStorage.setItem(RUNBOOK_TASK_STORAGE_KEY, runbookDraftTask);
  syncRunbookExternalResearchWarning(runbookDraftTask);
});

runbooksContentEl?.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.altKey && !event.shiftKey) {
    event.preventDefault();
    const targetPath = selectedRunbookPath || '';
    if (targetPath) {
      runPipelinePreviewAction('default', targetPath).catch(err => notifyFormatError('Pipes', err));
    } else {
      createOrpadRunbookStarter().catch(err => notifyFormatError('Pipes', err));
    }
    return;
  }
  const slot = event.target.closest?.('.runbook-item[data-runbook-path]');
  if (!slot || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  toggleRunbookSlot(slot.dataset.runbookPath || '').catch(err => notifyFormatError('Runbooks', err));
});

// ==================== File Tree ====================
async function openFolder() {
  const folderPath = await window.orpad.openFolderDialog();
  if (folderPath) {
    workspacePath = folderPath;
    expandedPaths.clear();
    selectedRunbookPath = null;
    selectedRunbookValidation = null;
    lastRunRecord = null;
    lastMachineRunRecord = null;
    clearMachineRunProgressState();
    runbookValidationCache.clear();
    runbookRecordCache.clear();
    machineRunRecordCache.clear();
    machineRunListCache.clear();
    localStorage.setItem('orpad-workspace-path', workspacePath);
    await loadFileTree();
    window.orpad.watchDirectory(folderPath);
    window.orpad.buildLinkIndex(folderPath).then(() => refreshFileNameCache());
    scheduleGitRefresh(0);
    scheduleSnippetRefresh(0);
    if (!sidebarVisible) showSidebar('files');
  }
}

async function loadFileTree() {
  if (!workspacePath) {
    fileTreeCache = [];
    fileTreeEl.innerHTML = `<div class="tree-empty">${t('sidebar.openFolder')}</div>`;
    updateWorkspaceRunbookSummary();
    return;
  }
  const tree = await window.orpad.readDirectory(workspacePath);
  fileTreeCache = tree || [];
  renderFileTree(tree, 0);
  updateWorkspaceRunbookSummary();
  scheduleGitRefresh(0);
}

function renderFileTree(items, depth) {
  if (depth === 0) fileTreeEl.innerHTML = '';
  const container = depth === 0 ? fileTreeEl : document.createDocumentFragment();

  if (items.length === 0 && depth === 0) {
    fileTreeEl.innerHTML = `<div class="tree-empty">${t('sidebar.openFolder')}</div>`;
    return;
  }

  for (const item of items) {
    if (item.isDirectory) {
      const wrapper = document.createElement('div');
      const itemEl = document.createElement('div');
      itemEl.className = 'tree-item';
      itemEl.style.paddingLeft = (depth * 12 + 8) + 'px';
      itemEl.innerHTML =
        '<span class="tree-item-icon"><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M6.427 3.573l3.396 3.396a.25.25 0 0 1 0 .354l-3.396 3.396A.25.25 0 0 1 6 7.396V3.75a.25.25 0 0 1 .427-.177z"/></svg></span>' +
        '<span class="tree-item-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/></svg></span>' +
        `<span class="tree-item-name">${escapeHtml(item.name)}</span>`;

      const childContainer = document.createElement('div');
      const wasExpanded = expandedPaths.has(item.path);
      childContainer.className = 'tree-children' + (wasExpanded ? '' : ' collapsed');

      let expanded = wasExpanded;
      let childrenRendered = false;

      if (wasExpanded && item.children) {
        childrenRendered = true;
        const arrow = itemEl.querySelector('.tree-item-icon:first-child');
        arrow.style.transform = 'rotate(90deg)';
        const frag = document.createDocumentFragment();
        renderSubTree(item.children, depth + 1, frag);
        childContainer.appendChild(frag);
      }

      itemEl.addEventListener('click', () => {
        expanded = !expanded;
        if (expanded) expandedPaths.add(item.path); else expandedPaths.delete(item.path);
        childContainer.classList.toggle('collapsed', !expanded);
        const arrow = itemEl.querySelector('.tree-item-icon:first-child');
        arrow.style.transform = expanded ? 'rotate(90deg)' : '';
        if (expanded && !childrenRendered && item.children) {
          childrenRendered = true;
          const frag = document.createDocumentFragment();
          renderSubTree(item.children, depth + 1, frag);
          childContainer.appendChild(frag);
        }
      });

      itemEl.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, item.path, true); });

      wrapper.appendChild(itemEl);
      wrapper.appendChild(childContainer);
      container.appendChild(wrapper);
    } else {
      const itemEl = document.createElement('div');
      itemEl.className = 'tree-item';
      itemEl.style.paddingLeft = (depth * 12 + 24) + 'px';
      const isMd = /\.(md|markdown|mkd|mdx)$/i.test(item.name);
      const isSupported = isSupportedFormat(item.name);
      itemEl.innerHTML =
        '<span class="tree-item-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25V1.75C2 .784 2.784 0 3.75 0Z"/></svg></span>' +
        `<span class="tree-item-name" style="${isSupported ? '' : 'opacity:0.5'}">${escapeHtml(item.name)}</span>`;
      appendGitBadge(itemEl, item.path);

      if (isSupported) {
        itemEl.addEventListener('click', () => openFileInTab(item.path));
      }
      if (isMd) {
        // Drag .md file to editor - insert [[link]]
        itemEl.draggable = true;
        itemEl.addEventListener('dragstart', (e) => {
          const baseName = item.name.replace(/\.(md|markdown|mkd|mdx)$/i, '');
          e.dataTransfer.setData('text/plain', '[[' + baseName + ']]');
          e.dataTransfer.setData('application/x-orpad-link', baseName);
          e.dataTransfer.effectAllowed = 'copy';
        });
      }
      itemEl.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, item.path, false); });
      container.appendChild(itemEl);
    }
  }

  if (depth === 0) return;
  return container;
}

function renderSubTree(items, depth, container) {
  for (const item of items) {
    if (item.isDirectory) {
      const wrapper = document.createElement('div');
      const itemEl = document.createElement('div');
      itemEl.className = 'tree-item';
      itemEl.style.paddingLeft = (depth * 12 + 8) + 'px';
      itemEl.innerHTML =
        '<span class="tree-item-icon"><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M6.427 3.573l3.396 3.396a.25.25 0 0 1 0 .354l-3.396 3.396A.25.25 0 0 1 6 7.396V3.75a.25.25 0 0 1 .427-.177z"/></svg></span>' +
        '<span class="tree-item-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/></svg></span>' +
        `<span class="tree-item-name">${escapeHtml(item.name)}</span>`;

      const childContainer = document.createElement('div');
      const wasExpanded = expandedPaths.has(item.path);
      childContainer.className = 'tree-children' + (wasExpanded ? '' : ' collapsed');
      let expanded = wasExpanded;
      let childrenRendered = false;

      if (wasExpanded && item.children) {
        childrenRendered = true;
        itemEl.querySelector('.tree-item-icon:first-child').style.transform = 'rotate(90deg)';
        const frag = document.createDocumentFragment();
        renderSubTree(item.children, depth + 1, frag);
        childContainer.appendChild(frag);
      }

      itemEl.addEventListener('click', () => {
        expanded = !expanded;
        if (expanded) expandedPaths.add(item.path); else expandedPaths.delete(item.path);
        childContainer.classList.toggle('collapsed', !expanded);
        itemEl.querySelector('.tree-item-icon:first-child').style.transform = expanded ? 'rotate(90deg)' : '';
        if (expanded && !childrenRendered && item.children) {
          childrenRendered = true;
          const frag = document.createDocumentFragment();
          renderSubTree(item.children, depth + 1, frag);
          childContainer.appendChild(frag);
        }
      });
      itemEl.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, item.path, true); });
      wrapper.appendChild(itemEl);
      wrapper.appendChild(childContainer);
      container.appendChild(wrapper);
    } else {
      const itemEl = document.createElement('div');
      itemEl.className = 'tree-item';
      itemEl.style.paddingLeft = (depth * 12 + 24) + 'px';
      const isMd = /\.(md|markdown|mkd|mdx)$/i.test(item.name);
      const isSupported = isSupportedFormat(item.name);
      itemEl.innerHTML =
        '<span class="tree-item-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25V1.75C2 .784 2.784 0 3.75 0Z"/></svg></span>' +
        `<span class="tree-item-name" style="${isSupported ? '' : 'opacity:0.5'}">${escapeHtml(item.name)}</span>`;
      appendGitBadge(itemEl, item.path);
      if (isSupported) {
        itemEl.addEventListener('click', () => openFileInTab(item.path));
      }
      if (isMd) {
        itemEl.draggable = true;
        itemEl.addEventListener('dragstart', (e) => {
          const baseName = item.name.replace(/\.(md|markdown|mkd|mdx)$/i, '');
          e.dataTransfer.setData('text/plain', '[[' + baseName + ']]');
          e.dataTransfer.setData('application/x-orpad-link', baseName);
          e.dataTransfer.effectAllowed = 'copy';
        });
      }
      itemEl.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, item.path, false); });
      container.appendChild(itemEl);
    }
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function openFileInTab(filePath) {
  const existing = findTabByPath(filePath);
  if (existing) { switchToTab(existing.id); return true; }
  const result = await window.orpad.readFile(filePath);
  if (result.error) return false;
  createTab(result.filePath, result.dirPath, result.content);
  return true;
}

// File tree toolbar
document.getElementById('btn-open-folder').addEventListener('click', openFolder);
document.getElementById('btn-refresh-tree').addEventListener('click', loadFileTree);

// Blank-area right-click in the file tree - context menu rooted at the workspace.
document.getElementById('file-tree').addEventListener('contextmenu', (e) => {
  if (e.target.closest('.tree-item')) return;
  if (!workspacePath) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, workspacePath, true);
});

// File watcher
let fileTreeRefreshTimer = null;
let linkIndexRefreshTimer = null;
window.orpad.onDirectoryChanged(() => {
  if (fileTreeRefreshTimer) clearTimeout(fileTreeRefreshTimer);
  fileTreeRefreshTimer = setTimeout(loadFileTree, 500);
  scheduleGitRefresh(500);
  scheduleSnippetRefresh(500);
  if (linkIndexRefreshTimer) clearTimeout(linkIndexRefreshTimer);
  linkIndexRefreshTimer = setTimeout(() => {
    if (workspacePath) window.orpad.buildLinkIndex(workspacePath).then(() => refreshFileNameCache());
  }, 1000);
});

// ==================== Context Menu ====================
function showContextMenu(x, y, targetPath, isDir) {
  contextMenuTarget = targetPath;
  contextMenuIsDir = isDir;
  const menu = document.getElementById('context-menu');
  menu.classList.remove('hidden');

  const isRoot = workspacePath && targetPath === workspacePath;

  document.getElementById('ctx-new-file').style.display = isDir ? '' : 'none';
  document.getElementById('ctx-new-md').style.display = isDir ? '' : 'none';
  document.getElementById('ctx-new-folder').style.display = isDir ? '' : 'none';
  document.getElementById('ctx-sep-new').style.display = isDir ? '' : 'none';

  document.getElementById('ctx-reveal').style.display = '';

  document.getElementById('ctx-rename').style.display = isRoot ? 'none' : '';
  document.getElementById('ctx-delete').style.display = isRoot ? 'none' : '';
  document.getElementById('ctx-sep-mutate').style.display = isRoot ? 'none' : '';

  const menuW = menu.offsetWidth;
  const menuH = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - menuW - 4) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - menuH - 4) + 'px';
}

document.addEventListener('click', () => document.getElementById('context-menu').classList.add('hidden'));

document.getElementById('ctx-new-file').addEventListener('click', async () => {
  const name = prompt(t('context.newFile') + ':', 'untitled.md');
  if (!name) return;
  const fullPath = contextMenuTarget.replace(/\\/g, '/') + '/';
  const result = await window.orpad.createFile(fullPath);
  if (result.success) { await loadFileTree(); await openFileInTab(fullPath); }
});

document.getElementById('ctx-new-folder').addEventListener('click', async () => {
  const name = prompt(t('context.newFolder') + ':');
  if (!name) return;
  const fullPath = contextMenuTarget.replace(/\\/g, '/') + '/';
  const result = await window.orpad.createFolder(fullPath);
  if (result.success) await loadFileTree();
});

document.getElementById('ctx-new-md').addEventListener('click', async () => {
  const name = prompt(t('context.newMdFile') + ':', 'untitled.md');
  if (!name) return;
  const finalName = /\.(md|markdown|mkd|mdx)$/i.test(name) ? name : name + '.md';
  const fullPath = contextMenuTarget.replace(/\\/g, '/') + '/' + finalName;
  const result = await window.orpad.createFile(fullPath);
  if (result.success) { await loadFileTree(); await openFileInTab(fullPath); }
});

document.getElementById('ctx-reveal').addEventListener('click', () => {
  window.orpad.revealInExplorer(contextMenuTarget);
});

document.getElementById('ctx-rename').addEventListener('click', async () => {
  const oldName = contextMenuTarget.split(/[/\\]/).pop();
  const newName = prompt(t('context.rename') + ':', oldName);
  if (!newName || newName === oldName) return;
  const dir = contextMenuTarget.substring(0, contextMenuTarget.length - oldName.length);
  const newPath = dir + newName;
  const result = await window.orpad.renameFile(contextMenuTarget, newPath);
  if (result.success) {
    for (const tab of tabs) {
      if (tab.filePath && tab.filePath.replace(/\\/g, '/').toLowerCase() === contextMenuTarget.replace(/\\/g, '/').toLowerCase()) {
        tab.filePath = newPath;
        tab.dirPath = dir.replace(/[/\\]$/, '');
      }
    }
    await loadFileTree();
    renderTabBar();
    updateTitle();
  }
});

document.getElementById('ctx-delete').addEventListener('click', async () => {
  const name = contextMenuTarget.split(/[/\\]/).pop();
  if (!confirm(t('dialog.deleteConfirm').replace('{0}', name))) return;
  const result = await window.orpad.deleteFile(contextMenuTarget);
  if (result.success) {
    const tab = findTabByPath(contextMenuTarget);
    if (tab) { tab.isModified = false; await closeTab(tab.id); }
    await loadFileTree();
  }
});

// ==================== Search ====================
document.getElementById('btn-search-regex').addEventListener('click', (e) => {
  searchRegex = !searchRegex;
  e.currentTarget.classList.toggle('active', searchRegex);
  performSearch();
});

document.getElementById('btn-search-case').addEventListener('click', (e) => {
  searchCaseSensitive = !searchCaseSensitive;
  e.currentTarget.classList.toggle('active', searchCaseSensitive);
  performSearch();
});

searchInputEl.addEventListener('input', () => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(performSearch, 300);
});

searchInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); performSearch(); }
});

// Order roughly matches FORMAT_BAR_VIEWS - keeps the popover skim-friendly.
const SEARCH_FILTER_EXTS = [
  'md', 'markdown', 'mdx', 'mmd',
  'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'conf', 'properties', 'env',
  'csv', 'tsv',
  'xml', 'html', 'htm',
  'log', 'txt',
];
const SEARCH_EXT_LS_KEY = 'orpad-search-ext-filter';
let searchSelectedExts = null;
try {
  const raw = localStorage.getItem(SEARCH_EXT_LS_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) searchSelectedExts = parsed;
  }
} catch {}

async function performSearch() {
  const query = searchInputEl.value.trim();
  if (!query) { searchResultsEl.innerHTML = ''; searchStatusEl.textContent = ''; return; }
  if (!workspacePath) {
    searchResultsEl.innerHTML = `<div class="search-empty">${t('sidebar.openFolder')}</div>`;
    return;
  }
  const results = await window.orpad.searchFiles(workspacePath, query, {
    regex: searchRegex,
    caseSensitive: searchCaseSensitive,
    extensions: searchSelectedExts,
  });
  renderSearchResults(results);
}

(() => {
  const btn = document.getElementById('btn-search-ext');
  const popover = document.getElementById('search-ext-popover');
  const list = document.getElementById('search-ext-list');
  const label = document.getElementById('search-ext-label');
  if (!btn || !popover || !list || !label) return;

  function updateLabel() {
    if (!searchSelectedExts || searchSelectedExts.length === 0) {
      label.textContent = t('search.extAll');
    } else if (searchSelectedExts.length === 1) {
      label.textContent = '*.' + searchSelectedExts[0];
    } else if (searchSelectedExts.length <= 3) {
      label.textContent = searchSelectedExts.map(e => '*.' + e).join(', ');
    } else {
      label.textContent = t('search.extCount').replace('{0}', String(searchSelectedExts.length));
    }
  }

  function syncCheckboxes() {
    const set = searchSelectedExts ? new Set(searchSelectedExts) : null;
    list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = set ? set.has(cb.value) : true;
    });
  }

  function persist() {
    try {
      if (searchSelectedExts === null) localStorage.removeItem(SEARCH_EXT_LS_KEY);
      else localStorage.setItem(SEARCH_EXT_LS_KEY, JSON.stringify(searchSelectedExts));
    } catch {}
  }

  function rebuildList() {
    list.innerHTML = '';
    for (const ext of SEARCH_FILTER_EXTS) {
      const row = document.createElement('label');
      row.className = 'search-ext-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = ext;
      cb.checked = !searchSelectedExts || searchSelectedExts.includes(ext);
      cb.addEventListener('change', () => {
        const checked = Array.from(list.querySelectorAll('input[type="checkbox"]:checked')).map(c => c.value);
        searchSelectedExts = (checked.length === SEARCH_FILTER_EXTS.length) ? null : checked;
        persist();
        updateLabel();
        if (searchInputEl.value.trim()) performSearch();
      });
      const name = document.createElement('span');
      name.textContent = '*.' + ext;
      row.appendChild(cb);
      row.appendChild(name);
      list.appendChild(row);
    }
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    popover.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!popover.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      popover.classList.add('hidden');
    }
  });
  document.getElementById('btn-search-ext-all').addEventListener('click', () => {
    searchSelectedExts = null;
    syncCheckboxes();
    persist();
    updateLabel();
    if (searchInputEl.value.trim()) performSearch();
  });
  document.getElementById('btn-search-ext-none').addEventListener('click', () => {
    searchSelectedExts = [];
    syncCheckboxes();
    persist();
    updateLabel();
    if (searchInputEl.value.trim()) performSearch();
  });

  rebuildList();
  updateLabel();
})();

function renderSearchResults(results) {
  searchResultsEl.innerHTML = '';
  if (results.length === 0) {
    searchResultsEl.innerHTML = `<div class="search-empty">${t('search.noResults')}</div>`;
    searchStatusEl.textContent = '';
    return;
  }
  let totalMatches = 0;
  for (const file of results) {
    totalMatches += file.matches.length;
    const group = document.createElement('div');
    group.className = 'search-file-group';

    const fileName = document.createElement('div');
    fileName.className = 'search-file-name';
    fileName.textContent = file.relativePath;
    fileName.addEventListener('click', () => openFileInTab(file.filePath));
    group.appendChild(fileName);

    for (const match of file.matches) {
      const matchEl = document.createElement('div');
      matchEl.className = 'search-match';
      const lineNum = document.createElement('span');
      lineNum.className = 'search-match-line';
      lineNum.textContent = match.lineNumber;
      const lineText = document.createElement('span');
      lineText.textContent = match.lineText.trim().substring(0, 120);
      matchEl.appendChild(lineNum);
      matchEl.appendChild(lineText);
      matchEl.addEventListener('click', () => openSearchResult(file.filePath, match.lineNumber));
      group.appendChild(matchEl);
    }
    searchResultsEl.appendChild(group);
  }
  searchStatusEl.textContent = t('search.results').replace('{0}', totalMatches).replace('{1}', results.length);
}

async function openSearchResult(filePath, lineNumber) {
  await openFileInTab(filePath);
  requestAnimationFrame(() => jumpToLine(lineNumber));
}

function jumpToLine(lineNumber) {
  const n = Math.max(1, Math.min(parseInt(lineNumber, 10) || 1, editor.state.doc.lines));
  const line = editor.state.doc.line(n);
  editor.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
  });
  editor.focus();
}

function findSymbolLine(symbol) {
  const needle = String(symbol || '').trim().toLowerCase();
  if (!needle) return null;
  const tab = getActiveTab();
  const lines = editor.state.doc.toString().replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let label = '';
    if (tab?.viewType === 'markdown') {
      const heading = raw.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
      if (heading) label = heading[1];
    } else {
      const key = raw.match(/^\s*"([^"]+)"\s*:/)
        || raw.match(/^\s*([A-Za-z0-9_.-]+)\s*(?:=|:)/)
        || raw.match(/^\s*\[([^\]]+)\]/);
      if (key) label = key[1];
    }
    if (label && label.toLowerCase().includes(needle)) return i + 1;
  }
  return null;
}

async function openFileFromQuickOpen(filePath, options = {}) {
  const opened = await openFileInTab(filePath);
  if (opened === false) return;
  requestAnimationFrame(() => {
    const line = options.line || findSymbolLine(options.symbol);
    if (line) jumpToLine(line);
  });
}

function workspaceRelativePath(filePath) {
  const fp = String(filePath || '').replace(/\\/g, '/');
  const root = String(workspacePath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (root && fp.toLowerCase().startsWith((root + '/').toLowerCase())) {
    return fp.slice(root.length + 1);
  }
  return fp.replace(/^\/+/, '');
}

function flattenFileTree(items, out = []) {
  for (const item of items || []) {
    if (item.isDirectory) {
      flattenFileTree(item.children || [], out);
      continue;
    }
    if (!isSupportedFormat(item.name || item.path)) continue;
    out.push({
      filePath: item.path,
      relativePath: workspaceRelativePath(item.path),
      baseName: item.name || item.path.split(/[\\/]/).pop(),
      kind: getViewType(item.path),
    });
  }
  return out;
}

async function getQuickOpenFiles() {
  if (workspacePath && fileTreeCache.length === 0) {
    try {
      fileTreeCache = await window.orpad.readDirectory(workspacePath) || [];
    } catch {
      fileTreeCache = [];
    }
  }
  const files = flattenFileTree(fileTreeCache);
  if (files.length || !workspacePath) return files;
  const names = await window.orpad.getFileNames(workspacePath);
  return (names || []).map(item => ({
    filePath: item.filePath,
    relativePath: workspaceRelativePath(item.filePath),
    baseName: item.baseName || (item.filePath || '').split(/[\\/]/).pop(),
    kind: getViewType(item.filePath),
  }));
}

async function readFileForQuickOpen(filePath) {
  const tab = findTabByPath(filePath);
  if (tab) {
    const content = tab.id === activeTabId ? editor.state.doc.toString() : tab.editorState.doc.toString();
    return { filePath: tab.filePath, dirPath: tab.dirPath, content };
  }
  const result = await window.orpad.readFile(filePath);
  if (result?.error) throw new Error(result.error);
  return result;
}

function promptGoToLine() {
  const body = document.createElement('div');
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Line number';
  input.value = String(editor.state.doc.lineAt(editor.state.selection.main.head).number);
  body.appendChild(input);
  const go = () => {
    closeFmtModal();
    jumpToLine(input.value);
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      go();
    }
  });
  openFmtModal({
    title: 'Go to Line',
    body,
    footer: [
      { label: 'Cancel', onClick: closeFmtModal },
      { label: 'Go', primary: true, onClick: go },
    ],
  });
  setTimeout(() => input.focus(), 0);
}

function openFindInEditor() {
  editor.focus();
  openSearchPanel(editor);
}

function openReplaceInEditor() {
  editor.focus();
  openSearchPanel(editor);
  requestAnimationFrame(() => {
    const panel = document.querySelector('.cm-search');
    const field = panel?.querySelector('input[name="replace"]') || panel?.querySelector('input[name="search"]');
    field?.focus();
    field?.select?.();
  });
}

function openSettingsModal() {
  const body = document.createElement('div');
  body.className = 'fmt-modal-result';
  body.textContent = 'Settings live in Theme, Language, AI, and Terminal panels.';
  openFmtModal({
    title: 'Settings',
    body,
    footer: [{ label: 'Close', primary: true, onClick: closeFmtModal }],
  });
}

async function closeAllUnpinnedTabs() {
  const targets = tabs.filter(tb => !tb.pinned).map(tb => tb.id);
  for (const id of targets) await closeTab(id);
}

function getCommandContext() {
  const active = getActiveTab();
  return {
    activeTab: active,
    hasActiveTab: !!active,
    workspacePath,
    viewMode,
    vimEnabled,
    minimapEnabled,
    zenMode: document.body.classList.contains('zen-mode'),
    isWeb: IS_WEB,
  };
}

function openThemePanel() {
  themePanel.classList.remove('hidden');
  updateTopBarsBottom();
  renderThemePanel();
}

function commandButtonTitle(button) {
  return (button.getAttribute('title') || button.textContent || button.id)
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isElementCommandAvailable(button) {
  if (!button || button.disabled || button.hidden) return false;
  const bar = document.getElementById('format-bar');
  if (bar?.hidden) return false;
  const group = button.closest('.fmt-group');
  if (group?.hidden) return false;
  return true;
}

function collectFormatCommands() {
  const buttons = Array.from(document.querySelectorAll('#format-bar button[id]'));
  return buttons.map(button => ({
    id: `format.${button.id.replace(/^fmt-/, '').replace(/-/g, '.')}`,
    title: commandButtonTitle(button),
    category: 'Format',
    keywords: ['toolbar', button.id],
    enabled: () => isElementCommandAvailable(button),
    run: () => button.click(),
  }));
}

function collectThemeCommands() {
  return Object.entries(builtinThemes).map(([id, theme]) => ({
    id: `theme.${id}`,
    title: theme.name,
    category: 'Theme',
    keywords: [id, theme.type],
    run: () => switchTheme(id),
  }));
}

function collectLanguageCommands() {
  return LANGUAGES.map(({ code, name }) => ({
    id: `language.${code}`,
    title: name,
    category: 'Language',
    keywords: [code],
    run: () => {
      langSelect.value = code;
      changeAppLocale(code);
    },
  }));
}

function setupCommandRegistry() {
  const baseCommands = [
    { id: 'file.new', title: 'New File', category: 'File', keybinding: 'Ctrl N', priority: 100, run: () => { createTab(null, null, ''); editor.focus(); } },
    { id: 'file.newTemplate', title: 'New from Template', category: 'File', keybinding: 'Ctrl Alt N', run: openNewFromTemplate },
    { id: 'file.open', title: 'Open File', category: 'File', keybinding: 'Ctrl O', run: () => window.orpad.openFileDialog() },
    { id: 'file.openFolder', title: 'Open Folder', category: 'File', run: openFolder },
    { id: 'file.save', title: 'Save', category: 'File', keybinding: 'Ctrl S', enabled: ({ hasActiveTab }) => hasActiveTab, run: saveFile },
    { id: 'file.saveAs', title: 'Save As', category: 'File', keybinding: 'Ctrl Shift S', enabled: ({ hasActiveTab }) => hasActiveTab, run: saveFileAs },
    { id: 'file.closeTab', title: 'Close Tab', category: 'File', keybinding: 'Ctrl W', enabled: ({ hasActiveTab }) => hasActiveTab, run: () => activeTabId && closeTab(activeTabId) },
    { id: 'file.closeAll', title: 'Close All Tabs', category: 'File', enabled: () => tabs.length > 0, run: closeAllUnpinnedTabs },
    { id: 'git.openPanel', title: 'Open Git Status and Commands', category: 'Git', run: openGitPanel },
    { id: 'git.refresh', title: 'Refresh Status', category: 'Git', enabled: () => !!workspacePath, run: () => refreshGitStatus() },
    { id: 'git.branchSwitcher', title: 'Open Branch Switcher', category: 'Git', enabled: () => gitRepoState.isRepo, run: openGitBranchSwitcher },
    { id: 'git.showDiff', title: 'Show diff (vs HEAD)', category: 'Git', enabled: ({ activeTab }) => gitRepoState.isRepo && !!activeTab?.filePath, run: showGitDiffForActiveFile },
    { id: 'git.revertFile', title: 'Revert current file', category: 'Git', enabled: ({ activeTab }) => gitRepoState.isRepo && !!activeTab?.filePath, run: revertGitCurrentFile },
    { id: 'snippets.insert', title: 'Insert Snippet...', category: 'Snippets', enabled: ({ hasActiveTab }) => hasActiveTab, run: openSnippetPicker },
    { id: 'snippets.editUser', title: 'Edit User Snippets', category: 'Snippets', run: editUserSnippets },
    { id: 'edit.find', title: 'Find in Editor', category: 'Edit', keybinding: 'Ctrl F', enabled: ({ hasActiveTab }) => hasActiveTab, run: openFindInEditor },
    { id: 'edit.replace', title: 'Replace in Editor', category: 'Edit', keybinding: 'Ctrl H', enabled: ({ hasActiveTab }) => hasActiveTab, run: openReplaceInEditor },
    { id: 'edit.goToLine', title: 'Go to Line', category: 'Edit', keybinding: 'Ctrl G', enabled: ({ hasActiveTab }) => hasActiveTab, run: promptGoToLine },
    { id: 'editor.toggleVim', title: 'Toggle Vim Mode', category: 'Editor', keywords: ['vim', 'modal'], run: () => setVimEnabled(!vimEnabled) },
    { id: 'editor.toggleMinimap', title: 'Toggle Minimap', category: 'Editor', keywords: ['map', 'overview'], run: () => setMinimapEnabled(!minimapEnabled) },
    { id: 'editor.toggleZen', title: 'Toggle Zen Mode', category: 'Editor', keybinding: 'Ctrl K Z', keywords: ['focus', 'distraction free'], run: toggleZenMode },
    { id: 'editor.addCursorAbove', title: 'Add Cursor Above', category: 'Editor', keybinding: 'Ctrl Alt Up', enabled: ({ hasActiveTab }) => hasActiveTab, run: () => runEditorCommand(addCursorAbove) },
    { id: 'editor.addCursorBelow', title: 'Add Cursor Below', category: 'Editor', keybinding: 'Ctrl Alt Down', enabled: ({ hasActiveTab }) => hasActiveTab, run: () => runEditorCommand(addCursorBelow) },
    { id: 'editor.selectNextOccurrence', title: 'Select Next Occurrence', category: 'Editor', keybinding: 'Ctrl D', enabled: ({ hasActiveTab }) => hasActiveTab, run: () => runEditorCommand(selectNextOccurrence) },
    { id: 'editor.selectAllOccurrences', title: 'Select All Occurrences', category: 'Editor', keybinding: 'Ctrl Shift L', enabled: ({ hasActiveTab }) => hasActiveTab, run: () => runEditorCommand(selectMatches) },
    { id: 'editor.moveLineUp', title: 'Move Line Up', category: 'Editor', keybinding: 'Alt Up', enabled: ({ hasActiveTab }) => hasActiveTab, run: () => runEditorCommand(moveLineUp) },
    { id: 'editor.moveLineDown', title: 'Move Line Down', category: 'Editor', keybinding: 'Alt Down', enabled: ({ hasActiveTab }) => hasActiveTab, run: () => runEditorCommand(moveLineDown) },
    { id: 'editor.copyLineUp', title: 'Copy Line Up', category: 'Editor', keybinding: 'Shift Alt Up', enabled: ({ hasActiveTab }) => hasActiveTab, run: () => runEditorCommand(copyLineUp) },
    { id: 'editor.copyLineDown', title: 'Copy Line Down', category: 'Editor', keybinding: 'Shift Alt Down', enabled: ({ hasActiveTab }) => hasActiveTab, run: () => runEditorCommand(copyLineDown) },
    { id: 'editor.toggleLineComment', title: 'Toggle Line Comment', category: 'Editor', keybinding: 'Ctrl /', enabled: ({ hasActiveTab }) => hasActiveTab, run: () => runEditorCommand(toggleComment) },
    { id: 'editor.toggleBlockComment', title: 'Toggle Block Comment', category: 'Editor', keybinding: 'Ctrl Shift /', enabled: ({ hasActiveTab }) => hasActiveTab, run: () => runEditorCommand(toggleBlockComment) },
    { id: 'editor.foldSelection', title: 'Fold Selection', category: 'Editor', keybinding: 'Ctrl Shift [', enabled: ({ hasActiveTab }) => hasActiveTab, run: () => runEditorCommand(foldCode) },
    { id: 'editor.unfoldSelection', title: 'Unfold Selection', category: 'Editor', keybinding: 'Ctrl Shift ]', enabled: ({ hasActiveTab }) => hasActiveTab, run: () => runEditorCommand(unfoldCode) },
    { id: 'view.toc', title: 'Toggle Table of Contents', category: 'View', keybinding: 'Ctrl T', run: () => showSidebar('toc') },
    { id: 'view.files', title: 'Toggle File Explorer', category: 'View', keybinding: 'Ctrl Shift E', run: () => showSidebar('files') },
    { id: 'view.search', title: 'Search in Files', category: 'View', keybinding: 'Ctrl Shift F', run: () => showSidebar('search') },
    { id: 'view.backlinks', title: 'Toggle Backlinks', category: 'View', keybinding: 'Ctrl Shift B', run: () => showSidebar('backlinks') },
    { id: 'view.runbooks', title: 'Open Pipes', category: 'View', run: () => showSidebar('runbooks') },
    { id: 'runbook.validateActive', title: 'Check Active Pipeline', category: 'Pipeline', enabled: ({ activeTab }) => !!activeTab?.filePath && /(\.or-pipeline|\.or-graph|\.or-tree|\.orch-(tree|graph)\.json|\.orch)$/i.test(activeTab.filePath), run: async (_args, { activeTab }) => { ensureSidebar('runbooks'); await validateSelectedRunbook(activeTab.filePath); } },
    { id: 'runbook.createRunRecord', title: 'Save Evidence', category: 'Pipeline', enabled: ({ activeTab, workspacePath }) => !!workspacePath && !!activeTab?.filePath && /(\.or-pipeline|\.or-graph|\.or-tree|\.orch-(tree|graph)\.json|\.orch)$/i.test(activeTab.filePath), run: async (_args, { activeTab }) => { ensureSidebar('runbooks'); await validateSelectedRunbook(activeTab.filePath); await createSelectedRunRecord(activeTab.filePath); } },
    { id: 'runbook.inspectContext', title: 'AI Context', category: 'Pipeline', enabled: ({ activeTab }) => !!activeTab?.filePath && /(\.or-pipeline|\.or-graph|\.or-tree|\.orch-(tree|graph)\.json|\.orch)$/i.test(activeTab.filePath), run: async (_args, { activeTab }) => { ensureSidebar('runbooks'); await validateSelectedRunbook(activeTab.filePath); await openRunbookContextInspector(activeTab.filePath, selectedRunbookValidation); } },
    { id: 'runbook.startLocal', title: 'Run Locally Or Prepare Handoff', category: 'Pipeline', enabled: ({ activeTab, workspacePath }) => !!workspacePath && !!activeTab?.filePath && /(\.or-pipeline|\.or-graph|\.or-tree|\.orch-(tree|graph)\.json|\.orch)$/i.test(activeTab.filePath), run: async (_args, { activeTab }) => { ensureSidebar('runbooks'); await validateSelectedRunbook(activeTab.filePath); if (isAgentOrchestratedPipeline(selectedRunbookValidation)) await openAgentHandoffModal(activeTab.filePath, selectedRunbookValidation); else await startSelectedLocalRun(activeTab.filePath); } },
    { id: 'runbook.newClaimAuditStarter', title: 'New Pipeline', category: 'Pipeline', run: () => createOrpadRunbookStarter() },
    { id: 'view.terminal', title: 'Toggle Terminal', category: 'View', keybinding: 'Ctrl `', run: () => terminalController?.toggle() },
    { id: 'view.ai', title: 'Toggle AI Sidebar', category: 'View', keybinding: 'Ctrl L', run: () => aiController?.toggle() },
    { id: 'view.zen', title: 'Zen Mode', category: 'View', keywords: ['focus'], run: toggleZenMode },
    { id: 'view.editor', title: 'Editor Only', category: 'View', run: () => setViewMode('editor') },
    { id: 'view.split', title: 'Split View', category: 'View', run: () => setViewMode('split') },
    { id: 'view.preview', title: 'Preview Only', category: 'View', run: () => setViewMode('preview') },
    { id: 'view.themePanel', title: 'Open Theme Panel', category: 'View', run: openThemePanel },
    { id: 'ai.openChat', title: 'Open AI Chat', category: 'AI', run: () => aiController?.openChat?.() },
    { id: 'ai.newChat', title: 'New AI Chat', category: 'AI', run: () => aiController?.newChat?.() },
    { id: 'ai.openActions', title: 'Open AI Assist Tools', category: 'AI', run: () => aiController?.openActions?.() },
    { id: 'ai.switchProvider', title: 'Switch AI Provider', category: 'AI', run: () => aiController?.openSettings?.() },
    { id: 'ai.runLastAction', title: 'Run Suggested AI Assist Tool', category: 'AI', run: () => aiController?.runLastAction?.() },
    { id: 'mcp.openServers', title: 'Open MCP Servers', category: 'MCP', run: () => aiController?.openMcp?.() },
    { id: 'terminal.newTerminal', title: 'New Terminal', category: 'Terminal', keybinding: 'Ctrl Shift `', run: () => terminalController?.newTerminal?.() },
    { id: 'terminal.commandRunner', title: 'Run Command in Command Runner', category: 'Terminal', run: () => terminalController?.openRunner?.() },
    { id: 'settings.open', title: 'Open Settings', category: 'Settings', run: openSettingsModal },
    { id: 'settings.reloadWindow', title: 'Reload Window', category: 'Settings', run: () => window.location.reload() },
  ];

  registerCommands([
    ...baseCommands,
    ...collectFormatCommands(),
    ...collectThemeCommands(),
    ...collectLanguageCommands(),
  ]);

  const publicCommands = {
    registerCommand,
    registerCommands,
    runCommand: (id, args) => runCommand(id, args, getCommandContext()),
    getCommands: () => getCommands(getCommandContext()).map(({ run, when, enabled, ...command }) => command),
  };
  try { window.orpad.commands = publicCommands; } catch {}
  if (!window.orpad.commands) {
    try { Object.defineProperty(window.orpad, 'commands', { value: publicCommands, configurable: true }); } catch {}
  }
  window.orpadCommands = publicCommands;
}

// ==================== View Modes ====================
let viewMode = 'split';
const viewBtns = { editor: document.getElementById('btn-editor'), split: document.getElementById('btn-split'), preview: document.getElementById('btn-preview') };

function setViewMode(mode) {
  viewMode = mode;
  localStorage.setItem('orpad-view-mode', mode);
  document.body.classList.remove('view-editor', 'view-split', 'view-preview');
  document.body.classList.add('view-' + mode);
  Object.entries(viewBtns).forEach(([k, btn]) => btn.classList.toggle('active', k === mode));
  updateZenLayoutClass();
  if (mode === 'editor') editor.focus();
}

viewBtns.editor.addEventListener('click', () => setViewMode('editor'));
viewBtns.split.addEventListener('click', () => setViewMode('split'));
viewBtns.preview.addEventListener('click', () => setViewMode('preview'));

// ==================== Divider Resize ====================
let isDragging = false;
dividerEl.addEventListener('mousedown', (e) => {
  isDragging = true;
  dividerEl.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});
document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const rect = workspaceEl.getBoundingClientRect();
  const sidebarWidth = sidebarVisible ? sidebarEl.offsetWidth : 0;
  const available = rect.width - sidebarWidth - dividerEl.offsetWidth;
  const offset = e.clientX - rect.left - sidebarWidth;
  const ratio = Math.max(0.15, Math.min(0.85, offset / available));
  editorPaneEl.style.flex = 'none';
  editorPaneEl.style.width = (ratio * available) + 'px';
  previewPaneEl.style.flex = '1';
});
document.addEventListener('mouseup', () => {
  if (isDragging) {
    isDragging = false;
    dividerEl.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const rect = workspaceEl.getBoundingClientRect();
    const sidebarWidth = sidebarVisible ? sidebarEl.offsetWidth : 0;
    const available = rect.width - sidebarWidth - dividerEl.offsetWidth;
    if (available > 0) {
      localStorage.setItem('orpad-divider-ratio', (editorPaneEl.offsetWidth / available).toFixed(4));
    }
  }
});

dividerEl.addEventListener('dblclick', () => {
  editorPaneEl.style.flex = '1';
  editorPaneEl.style.width = '';
  previewPaneEl.style.flex = '1';
  localStorage.removeItem('orpad-divider-ratio');
});

// ==================== File Operations ====================
async function saveFile() {
  const tab = getActiveTab();
  if (!tab) return;
  let content = editor.state.doc.toString();
  const prepared = prepareTemplateContentForSave(content);
  if (prepared !== content) {
    replaceEditorDoc(prepared);
    content = prepared;
  }
  if (tab.filePath) {
    const ok = await window.orpad.saveFile(tab.filePath, content);
    if (ok) {
      const editDuration = Math.round((Date.now() - (tab.openedAt || Date.now())) / 1000);
      tab.lastSavedContent = content;
      tab.isModified = false;
      tab.lastAutoSavedContent = null;
      updateTitle();
      renderTabBar();
      showSaveFlash();
      window.orpad.clearRecovery(getRecoveryKey(tab));
      track('file_save', { format: tab.viewType, edit_duration_sec: String(editDuration) });
      scheduleGitRefresh(0);
      if (isUserSnippetPath(tab.filePath)) scheduleSnippetRefresh(0);
    } else {
      alert(t('failedSave'));
    }
  } else {
    await saveFileAs();
  }
}

async function saveFileAs() {
  const tab = getActiveTab();
  if (!tab) return;
  let content = editor.state.doc.toString();
  const prepared = prepareTemplateContentForSave(content);
  if (prepared !== content) {
    replaceEditorDoc(prepared);
    content = prepared;
  }
  const oldKey = getRecoveryKey(tab);
  const result = await window.orpad.saveFileAs(content);
  if (result) {
    window.orpad.clearRecovery(oldKey);
    tab.filePath = result;
    tab.dirPath = result.substring(0, Math.max(result.lastIndexOf('/'), result.lastIndexOf('\\')));
    tab.title = null;
    tab.source = null;
    tab.sourceUrl = null;
    tab.lastSavedContent = content;
    tab.lastAutoSavedContent = null;
    tab.isModified = false;
    updateTitle();
    renderTabBar();
    showSaveFlash();
    scheduleGitRefresh(0);
    if (isUserSnippetPath(tab.filePath)) scheduleSnippetRefresh(0);
  }
}

// ==================== Unsaved Changes Protection ====================
window.orpad.onCheckBeforeClose(async () => {
  const unsavedTabs = tabs.filter(tb => tb.isModified);
  if (unsavedTabs.length === 0) { window.orpad.confirmClose(); return; }
  for (const tab of unsavedTabs) {
    switchToTab(tab.id);
    const result = await window.orpad.showSaveDialog();
    if (result === 'save') {
      await saveFile();
      if (getActiveTab()?.isModified) return;
    } else if (result === 'cancel') {
      return;
    }
  }
  window.orpad.confirmClose();
});

// ==================== Toolbar ====================
document.getElementById('btn-new').addEventListener('click', () => {
  createTab(null, null, '');
  editor.focus();
});
document.getElementById('btn-template')?.addEventListener('click', openNewFromTemplate);
document.getElementById('btn-open').addEventListener('click', () => {
  window.orpad.openFileDialog();
});
document.getElementById('btn-save').addEventListener('click', saveFile);
document.getElementById('btn-files').addEventListener('click', () => showSidebar('files'));
document.getElementById('btn-toc').addEventListener('click', () => showSidebar('toc'));
document.getElementById('btn-set-default').addEventListener('click', () => window.orpad.openDefaultAppsSettings());

// ==================== Language Selector ====================
const langSelect = document.getElementById('lang-select');
LANGUAGES.forEach(({ code, name }) => {
  const opt = document.createElement('option');
  opt.value = code;
  opt.textContent = name;
  langSelect.appendChild(opt);
});

function refreshLocalizedSurfaces() {
  applyLocaleToDOM();
  updateTitle();
  if (getActiveTab()) renderPreview(editor.state.doc.toString());
  renderThemePanel();
  terminalController?.refreshLocale?.();
  aiController?.refreshLocale?.();
  syncAiToolbarButton();
}

function changeAppLocale(code, { persist = true, broadcast = true } = {}) {
  if (!code) return;
  if (persist) localStorage.setItem('orpad-locale', code);
  setLocale(code);
  if (langSelect.value !== getLocaleCode()) langSelect.value = getLocaleCode();
  if (broadcast) window.orpad.setLocale(getLocaleCode());
  refreshLocalizedSurfaces();
}

langSelect.addEventListener('change', () => {
  changeAppLocale(langSelect.value);
});

window.orpad.onLocaleChanged?.(({ code } = {}) => {
  if (!code || code === getLocaleCode()) {
    refreshLocalizedSurfaces();
    return;
  }
  changeAppLocale(code, { persist: false, broadcast: false });
});

// ==================== Drag & Drop ====================
// Use capture phase so that dropped files never reach CodeMirror's built-in
// drop handler (which would treat the coordinates as a text insertion point
// and mark the existing document as modified).
let dragCounter = 0;
function isUrlTransfer(dataTransfer) {
  return Boolean(dataTransfer?.types?.includes('text/uri-list') || dataTransfer?.types?.includes('text/plain'));
}
function isTabBarDragTarget(e) {
  return Boolean(e.target?.closest?.('#tab-bar'));
}
function getDroppedUrl(dataTransfer) {
  const uriList = dataTransfer?.getData('text/uri-list') || '';
  const plain = dataTransfer?.getData('text/plain') || '';
  const candidate = (uriList.split(/\r?\n/).find((line) => line && !line.startsWith('#')) || plain).trim();
  return /^https?:\/\//i.test(candidate) ? candidate : '';
}
document.addEventListener('dragenter', (e) => {
  if (isTabBarDragTarget(e)) return;
  if (e.dataTransfer.types.includes('application/x-orpad-link')) return;
  if (!e.dataTransfer.types.includes('Files') && !isUrlTransfer(e.dataTransfer)) return;
  if (e.target && e.target.closest && e.target.closest('.diff-text')) return; // let diff textarea handle
  e.preventDefault();
  e.stopPropagation();
  dragCounter++;
  document.body.classList.add('drag-over');
}, true);
document.addEventListener('dragover', (e) => {
  if (isTabBarDragTarget(e)) return;
  if (e.dataTransfer.types.includes('application/x-orpad-link')) return;
  if (e.target && e.target.closest && e.target.closest('.diff-text')) return; // let diff textarea handle
  if (e.dataTransfer.types.includes('Files') || isUrlTransfer(e.dataTransfer)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  e.preventDefault();
}, true);
document.addEventListener('dragleave', (e) => {
  if (isTabBarDragTarget(e)) return;
  if (e.dataTransfer.types.includes('application/x-orpad-link')) return;
  if (!e.dataTransfer.types.includes('Files') && !isUrlTransfer(e.dataTransfer)) return;
  if (e.target && e.target.closest && e.target.closest('.diff-text')) return;
  e.preventDefault();
  e.stopPropagation();
  dragCounter--;
  if (dragCounter <= 0) { dragCounter = 0; document.body.classList.remove('drag-over'); }
}, true);
document.addEventListener('drop', (e) => {
  if (isTabBarDragTarget(e)) return;
  // Internal drag (file tree - editor): let CodeMirror handle it
  if (e.dataTransfer.types.includes('application/x-orpad-link')) return;
  // Diff panel: let the textarea's own drop handler load the file text
  if (e.target && e.target.closest && e.target.closest('.diff-text')) {
    dragCounter = 0;
    document.body.classList.remove('drag-over');
    return;
  }
  dragCounter = 0;
  document.body.classList.remove('drag-over');
  e.preventDefault();
  e.stopPropagation();
  const droppedUrl = getDroppedUrl(e.dataTransfer);
  if (droppedUrl) {
    window.orpad.openUrl?.(droppedUrl).catch((err) => {
      if (err?.name !== 'AbortError') notifyFormatError('URL import', err);
    });
    return;
  }
  const files = e.dataTransfer.files;
  for (const file of files) {
    if (isSupportedFormat(file.name)) {
      window.orpad.dropFile(file);
    }
  }
}, true);

// ==================== Status Bar ====================
function updateStatusBar() {
  const state = editor.state;
  const { main } = state.selection;
  const line = state.doc.lineAt(main.head);
  const col = main.head - line.from + 1;
  statusCursorEl.textContent = `Ln ${line.number}, Col ${col}`;
  if (state.selection.ranges.length > 1) {
    const selected = state.selection.ranges.reduce((sum, range) => sum + Math.abs(range.to - range.from), 0);
    statusSelectionEl.textContent = `${state.selection.ranges.length} cursors${selected ? `, ${selected} selected` : ''}`;
  } else if (main.from !== main.to) {
    const len = Math.abs(main.to - main.from);
    statusSelectionEl.textContent = `(${len} selected)`;
  } else {
    statusSelectionEl.textContent = '';
  }
  const text = state.doc.toString();
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  statusWordsEl.textContent = `${words} words`;
  statusReadTimeEl.textContent = `~${Math.max(1, Math.ceil(words / 200))} min`;
  updateVimStatusBar();
}

// ==================== Format Toolbar ====================
// Prevent format bar clicks from stealing editor focus (preserves selection)
document.getElementById('format-bar').addEventListener('mousedown', (e) => { e.preventDefault(); });
function wrapSelection(before, after, placeholder) {
  const { from, to } = editor.state.selection.main;
  const selected = editor.state.sliceDoc(from, to);
  const text = selected || placeholder;
  const insert = before + text + after;
  editor.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + before.length, head: from + before.length + text.length },
  });
  editor.focus();
}

function toggleLinePrefix(prefix) {
  const { from } = editor.state.selection.main;
  const line = editor.state.doc.lineAt(from);
  const lineText = line.text;
  if (lineText.startsWith(prefix)) {
    editor.dispatch({ changes: { from: line.from, to: line.from + prefix.length, insert: '' } });
  } else {
    const headingMatch = lineText.match(/^#{1,6}\s/);
    const removeLen = headingMatch ? headingMatch[0].length : 0;
    editor.dispatch({ changes: { from: line.from, to: line.from + removeLen, insert: prefix } });
  }
  editor.focus();
}

function insertBlock(text) {
  const { from, to } = editor.state.selection.main;
  const before = from > 0 && editor.state.sliceDoc(from - 1, from) !== '\n' ? '\n' : '';
  const after = to < editor.state.doc.length && editor.state.sliceDoc(to, to + 1) !== '\n' ? '\n' : '';
  editor.dispatch({ changes: { from, to, insert: before + text + after } });
  editor.focus();
}

document.getElementById('fmt-bold').addEventListener('click', () => wrapSelection('**', '**', 'bold'));
document.getElementById('fmt-italic').addEventListener('click', () => wrapSelection('*', '*', 'italic'));
document.getElementById('fmt-strike').addEventListener('click', () => wrapSelection('~~', '~~', 'strikethrough'));
document.getElementById('fmt-highlight').addEventListener('click', () => wrapSelection('==', '==', 'highlight'));
document.getElementById('fmt-code').addEventListener('click', () => wrapSelection('`', '`', 'code'));

// Heading dropdown
const headingMenu = document.getElementById('heading-menu');
document.getElementById('fmt-heading').addEventListener('click', (e) => { e.stopPropagation(); headingMenu.classList.toggle('hidden'); });
headingMenu.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => { toggleLinePrefix('#'.repeat(parseInt(btn.dataset.level)) + ' '); headingMenu.classList.add('hidden'); });
});
document.addEventListener('click', () => headingMenu.classList.add('hidden'));
document.getElementById('fmt-link').addEventListener('click', () => {
  const { from, to } = editor.state.selection.main;
  const selected = editor.state.sliceDoc(from, to);
  if (selected) {
    const insert = `[${selected}](url)`;
    editor.dispatch({ changes: { from, to, insert }, selection: { anchor: from + selected.length + 3, head: from + selected.length + 6 } });
  } else {
    const insert = '[link text](url)';
    editor.dispatch({ changes: { from, to, insert }, selection: { anchor: from + 1, head: from + 10 } });
  }
  editor.focus();
});
document.getElementById('fmt-image').addEventListener('click', () => {
  const { from, to } = editor.state.selection.main;
  const selected = editor.state.sliceDoc(from, to);
  const insert = selected ? `![${selected}](image-url)` : '![alt text](image-url)';
  editor.dispatch({ changes: { from, to, insert } });
  editor.focus();
});
document.getElementById('fmt-ul').addEventListener('click', () => toggleLinePrefix('- '));
document.getElementById('fmt-ol').addEventListener('click', () => toggleLinePrefix('1. '));
document.getElementById('fmt-task').addEventListener('click', () => toggleLinePrefix('- [ ] '));
document.getElementById('fmt-quote').addEventListener('click', () => toggleLinePrefix('> '));
document.getElementById('fmt-hr').addEventListener('click', () => insertBlock('\n---\n'));
document.getElementById('fmt-codeblock').addEventListener('click', () => {
  const { from, to } = editor.state.selection.main;
  const selected = editor.state.sliceDoc(from, to);
  const insert = '```\n' + (selected || 'code') + '\n```';
  editor.dispatch({ changes: { from, to, insert } });
  editor.focus();
});
document.getElementById('fmt-table').addEventListener('click', () => {
  insertBlock('| Header | Header |\n| ------ | ------ |\n| Cell   | Cell   |\n| Cell   | Cell   |');
});

// Insert dropdown
const insertMenu = document.getElementById('insert-menu');
document.getElementById('fmt-insert').addEventListener('click', (e) => { e.stopPropagation(); insertMenu.classList.toggle('hidden'); });
document.addEventListener('click', () => insertMenu.classList.add('hidden'));

document.getElementById('fmt-math-inline').addEventListener('click', () => { insertMenu.classList.add('hidden'); wrapSelection('$', '$', 'E=mc^2'); });
document.getElementById('fmt-math-block').addEventListener('click', () => { insertMenu.classList.add('hidden'); insertBlock('$$\n\\sum_{i=1}^{n} x_i\n$$'); });
document.getElementById('fmt-mermaid').addEventListener('click', () => { insertMenu.classList.add('hidden'); insertBlock('```mermaid\ngraph TD\n    A[Start] --> B{Decision}\n    B -->|Yes| C[OK]\n    B -->|No| D[End]\n```'); });
document.getElementById('fmt-sup').addEventListener('click', () => { insertMenu.classList.add('hidden'); wrapSelection('<sup>', '</sup>', 'text'); });
document.getElementById('fmt-sub').addEventListener('click', () => { insertMenu.classList.add('hidden'); wrapSelection('<sub>', '</sub>', 'text'); });
document.getElementById('fmt-footnote').addEventListener('click', () => {
  insertMenu.classList.add('hidden');
  const { from, to } = editor.state.selection.main;
  const ref = '[^1]';
  const def = '\n\n[^1]: footnote text';
  const docLen = editor.state.doc.length;
  editor.dispatch({ changes: [{ from, to, insert: ref }, { from: docLen, insert: def }] });
  editor.focus();
});
document.getElementById('fmt-comment').addEventListener('click', () => { insertMenu.classList.add('hidden'); wrapSelection('<!-- ', ' -->', 'comment'); });
document.getElementById('fmt-details').addEventListener('click', () => {
  insertMenu.classList.add('hidden');
  insertBlock('<details>\n<summary>Click to expand</summary>\n\nContent here...\n\n</details>');
});

// ==================== Per-viewType Toolbars ====================
// Handlers mutate the live viewer (currentGrid / currentJsonEditor) when possible,
// or replace editor text for operations that restructure content. Replacing text
// triggers preview re-render, which remounts the structured viewer cleanly.

function replaceEditorDoc(text) {
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
  editor.focus();
}

function getEditorSelectionText() {
  const { from, to } = editor.state.selection.main;
  return from === to ? '' : editor.state.sliceDoc(from, to);
}

function replaceSelectionOrDoc(text) {
  const { from, to } = editor.state.selection.main;
  if (from !== to) {
    editor.dispatch({ changes: { from, to, insert: text } });
    editor.focus();
    return;
  }
  replaceEditorDoc(text);
}

function insertRunnerTroubleshootingBlock(markdown) {
  const tab = getActiveTab();
  const block = String(markdown || '').trim();
  if (!block) return;
  if (!tab || tab.viewType !== 'markdown') {
    const newTab = createTab(null, null, `## Troubleshooting\n\n${block}\n`);
    newTab.title = 'Troubleshooting.md';
    newTab.viewType = 'markdown';
    newTab.editorState = createEditorState(editor.state.doc.toString(), 'markdown');
    renderTabBar();
    return;
  }
  const current = editor.state.doc.toString();
  const headingRe = /^## Troubleshooting\s*$/m;
  const insert = `\n\n${block}\n`;
  const next = headingRe.test(current)
    ? `${current.replace(/\s*$/, '')}${insert}`
    : `${current.replace(/\s*$/, '')}\n\n## Troubleshooting${insert}`;
  replaceEditorDoc(next);
}

function notifyFormatError(label, err) {
  const msg = err?.message || String(err);
  console.warn('[' + label + ']', msg);
  const info = document.getElementById('file-info');
  if (!info) return;
  const prev = info.textContent;
  const prevColor = info.style.color;
  info.textContent = label + ': ' + msg;
  info.style.color = 'var(--syntax-tag, #f7768e)';
  setTimeout(() => { info.textContent = prev; info.style.color = prevColor; }, 2500);
}

// ========== CSV / TSV ==========
function csvAction(act) { if (currentGrid) currentGrid.runAction(act); }
document.getElementById('fmt-csv-row-above').addEventListener('click', () => csvAction('row-above'));
document.getElementById('fmt-csv-row-below').addEventListener('click', () => csvAction('row-below'));
document.getElementById('fmt-csv-col-left').addEventListener('click', () => csvAction('col-left'));
document.getElementById('fmt-csv-col-right').addEventListener('click', () => csvAction('col-right'));
document.getElementById('fmt-csv-del-row').addEventListener('click', () => csvAction('del-row'));
document.getElementById('fmt-csv-del-col').addEventListener('click', () => csvAction('del-col'));

document.getElementById('fmt-csv-clear-sort').addEventListener('click', () => {
  if (!currentGrid) return;
  currentGrid.sort = null;
  currentGrid.render();
});
document.getElementById('fmt-csv-clear-filters').addEventListener('click', () => {
  if (!currentGrid) return;
  currentGrid.filters = {};
  currentGrid.hideFilterPopup?.();
  currentGrid.render();
});
document.getElementById('fmt-csv-trim').addEventListener('click', () => {
  if (!currentGrid || currentGrid.readOnly) return;
  let changed = false;
  for (let c = 0; c < currentGrid.headers.length; c++) {
    const v = String(currentGrid.headers[c] ?? '');
    const t = v.trim();
    if (t !== v) { currentGrid.headers[c] = t; changed = true; }
  }
  for (let r = 0; r < currentGrid.data.length; r++) {
    for (let c = 0; c < currentGrid.data[r].length; c++) {
      const v = String(currentGrid.data[r][c] ?? '');
      const t = v.trim();
      if (t !== v) { currentGrid.data[r][c] = t; changed = true; }
    }
  }
  if (changed) { currentGrid.render(); currentGrid.notify(); }
});
document.getElementById('fmt-csv-dedupe').addEventListener('click', () => {
  if (!currentGrid || currentGrid.readOnly) return;
  const seen = new Set();
  const kept = [];
  for (const row of currentGrid.data) {
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(row);
  }
  if (kept.length === currentGrid.data.length) return;
  currentGrid.data = kept;
  currentGrid.sort = null;
  currentGrid.render();
  currentGrid.notify();
});
document.getElementById('fmt-csv-copy-md').addEventListener('click', () => {
  if (!currentGrid) return;
  const hdr = currentGrid.headers;
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [];
  lines.push('| ' + hdr.map(esc).join(' | ') + ' |');
  lines.push('| ' + hdr.map(() => '---').join(' | ') + ' |');
  for (const row of currentGrid.data) {
    lines.push('| ' + hdr.map((_, i) => esc(row[i])).join(' | ') + ' |');
  }
  navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
});
document.getElementById('fmt-csv-transpose').addEventListener('click', () => {
  if (!currentGrid || currentGrid.readOnly) return;
  const matrix = [currentGrid.headers.slice(), ...currentGrid.data.map(r => r.slice())];
  if (matrix.length === 0) return;
  const nCols = Math.max(...matrix.map(r => r.length));
  const out = [];
  for (let c = 0; c < nCols; c++) {
    const newRow = [];
    for (let r = 0; r < matrix.length; r++) newRow.push(matrix[r][c] ?? '');
    out.push(newRow);
  }
  if (out.length === 0) return;
  currentGrid.headers = out[0];
  currentGrid.data = out.slice(1);
  if (currentGrid.data.length === 0) currentGrid.data = [Array(currentGrid.headers.length).fill('')];
  currentGrid.colWidths = currentGrid.headers.map(() => 120);
  currentGrid.sort = null;
  currentGrid.filters = {};
  currentGrid.setActive(0, 0);
  currentGrid.render();
  currentGrid.notify();
});

// ========== JSON ==========
function jsonBeautify(indent) {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    replaceEditorDoc(JSON.stringify(JSON.parse(text), null, indent));
  } catch (err) { notifyFormatError('JSON', err); }
}
document.getElementById('fmt-json-beautify2').addEventListener('click', () => jsonBeautify(2));
document.getElementById('fmt-json-beautify4').addEventListener('click', () => jsonBeautify(4));
document.getElementById('fmt-json-minify').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    replaceEditorDoc(JSON.stringify(JSON.parse(text)));
  } catch (err) { notifyFormatError('JSON', err); }
});
function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
    return out;
  }
  return v;
}
document.getElementById('fmt-json-sort-keys').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    replaceEditorDoc(JSON.stringify(sortKeysDeep(JSON.parse(text)), null, 2));
  } catch (err) { notifyFormatError('JSON', err); }
});
document.getElementById('fmt-json-to-yaml').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    const out = yamljs.dump(JSON.parse(text), { indent: 2, lineWidth: -1 });
    navigator.clipboard.writeText(out).catch(() => {});
  } catch (err) { notifyFormatError('JSON to YAML', err); }
});
function walkExpandable(data, visit) {
  const seen = new WeakSet();
  const inner = (v) => {
    if (v === null || typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    visit(v);
    if (Array.isArray(v)) for (const c of v) inner(c);
    else for (const k of Object.keys(v)) inner(v[k]);
  };
  inner(data);
}
function setAllJsonExpanded(flag) {
  if (!currentJsonEditor || !currentJsonEditor.data) return;
  walkExpandable(currentJsonEditor.data, (v) => {
    try {
      if (Object.prototype.hasOwnProperty.call(v, 'jeditExpanded')) v.jeditExpanded = flag;
      else Object.defineProperty(v, 'jeditExpanded', { value: flag, writable: true, enumerable: false, configurable: true });
    } catch {}
  });
  currentJsonEditor.render();
}
document.getElementById('fmt-json-expand-all').addEventListener('click', () => setAllJsonExpanded(true));
document.getElementById('fmt-json-collapse-all').addEventListener('click', () => setAllJsonExpanded(false));
document.getElementById('fmt-json-escape').addEventListener('click', () => {
  const { from, to } = editor.state.selection.main;
  if (from === to) { notifyFormatError('Escape', new Error('Select text first')); return; }
  const text = editor.state.sliceDoc(from, to);
  editor.dispatch({ changes: { from, to, insert: JSON.stringify(text) } });
  editor.focus();
});
document.getElementById('fmt-json-unescape').addEventListener('click', () => {
  const { from, to } = editor.state.selection.main;
  if (from === to) { notifyFormatError('Unescape', new Error('Select a JSON string first')); return; }
  const text = editor.state.sliceDoc(from, to);
  try {
    const decoded = JSON.parse(text);
    if (typeof decoded !== 'string') throw new Error('Selection is not a JSON string literal');
    editor.dispatch({ changes: { from, to, insert: decoded } });
    editor.focus();
  } catch (err) { notifyFormatError('Unescape', err); }
});

// ========== YAML ==========
document.getElementById('fmt-yaml-beautify').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    replaceEditorDoc(yamljs.dump(yamljs.load(text), { indent: 2, lineWidth: -1 }));
  } catch (err) { notifyFormatError('YAML', err); }
});
document.getElementById('fmt-yaml-to-json').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    const obj = yamljs.load(text);
    navigator.clipboard.writeText(JSON.stringify(obj, null, 2)).catch(() => {});
  } catch (err) { notifyFormatError('YAML to JSON', err); }
});
document.getElementById('fmt-yaml-expand-all').addEventListener('click', () => setAllJsonExpanded(true));
document.getElementById('fmt-yaml-collapse-all').addEventListener('click', () => setAllJsonExpanded(false));

// ========== TOML / INI ==========
document.getElementById('fmt-kv-expand-all').addEventListener('click', () => setAllJsonExpanded(true));
document.getElementById('fmt-kv-collapse-all').addEventListener('click', () => setAllJsonExpanded(false));

// ========== Mermaid ==========
const MERMAID_TEMPLATES = {
  flowchart: 'flowchart TD\n    A[Start] --> B{Condition}\n    B -->|Yes| C[Action]\n    B -->|No| D[End]',
  sequence:  'sequenceDiagram\n    participant A as Alice\n    participant B as Bob\n    A->>B: Hello\n    B-->>A: Hi!',
  class:     'classDiagram\n    class Animal {\n      +name: String\n      +eat() void\n    }\n    class Dog {\n      +bark() void\n    }\n    Animal <|-- Dog',
  state:     'stateDiagram-v2\n    [*] --> Idle\n    Idle --> Active: start\n    Active --> Idle: stop\n    Active --> [*]',
  er:        'erDiagram\n    CUSTOMER ||--o{ ORDER : places\n    ORDER ||--|{ ITEM : contains\n    CUSTOMER {\n      string name\n      string email\n    }',
  gantt:     'gantt\n    title Project Timeline\n    dateFormat YYYY-MM-DD\n    section Phase 1\n    Task 1 :a1, 2026-01-01, 7d\n    Task 2 :after a1, 5d',
  pie:       'pie title Distribution\n    "Red"   : 45\n    "Blue"  : 30\n    "Green" : 25',
  mindmap:   'mindmap\n  root((Topic))\n    Branch 1\n      Leaf A\n      Leaf B\n    Branch 2',
  timeline:  'timeline\n    title Project Timeline\n    2025 : Kickoff\n    2026 : Launch\n    2027 : Expansion',
  journey:   'journey\n    title User Journey\n    section Onboarding\n      Sign up: 5: User\n      Verify email: 3: User\n    section Use\n      Explore features: 4: User',
};
const mmdMenu = document.getElementById('mmd-insert-menu');
document.getElementById('fmt-mmd-insert').addEventListener('click', (e) => { e.stopPropagation(); mmdMenu.classList.toggle('hidden'); });
document.addEventListener('click', () => mmdMenu.classList.add('hidden'));
mmdMenu.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    mmdMenu.classList.add('hidden');
    const tpl = MERMAID_TEMPLATES[btn.dataset.mmd];
    if (!tpl) return;
    // Mermaid files hold one diagram each - inserting into non-empty content
    // produces invalid multi-diagram text. Replace entire doc; Ctrl+Z restores prior.
    replaceEditorDoc(tpl + '\n');
  });
});
document.getElementById('fmt-mmd-arrow').addEventListener('click', () => wrapSelection(' --> ', '', 'Target'));
document.getElementById('fmt-mmd-node-decision').addEventListener('click', () => wrapSelection('{', '}', 'Decision?'));
document.getElementById('fmt-mmd-subgraph').addEventListener('click', () => insertBlock('subgraph Group\n    A --> B\nend'));

// ========== HTML / XML ==========
const VOID_TAGS = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);

function serializeMarkupNode(node, depth, isXml) {
  const pad = '  '.repeat(depth);
  if (node.nodeType === 3) {
    const txt = node.nodeValue;
    if (!txt || !txt.trim()) return '';
    return pad + txt.trim() + '\n';
  }
  if (node.nodeType === 8) return pad + '<!--' + node.nodeValue + '-->\n';
  if (node.nodeType !== 1) return '';
  const tag = isXml ? node.tagName : node.tagName.toLowerCase();
  const attrs = Array.from(node.attributes || [])
    .map(a => ` ${a.name}="${String(a.value).replace(/"/g, '&quot;')}"`).join('');
  if (!isXml && VOID_TAGS.has(tag)) return `${pad}<${tag}${attrs}>\n`;
  const children = Array.from(node.childNodes);
  if (children.length === 0) return `${pad}<${tag}${attrs}></${tag}>\n`;
  if (children.length === 1 && children[0].nodeType === 3) {
    const txt = (children[0].nodeValue || '').trim();
    if (txt && !txt.includes('\n')) return `${pad}<${tag}${attrs}>${txt}</${tag}>\n`;
  }
  let out = `${pad}<${tag}${attrs}>\n`;
  for (const c of children) out += serializeMarkupNode(c, depth + 1, isXml);
  out += `${pad}</${tag}>\n`;
  return out;
}

function beautifyMarkup(text, isXml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, isXml ? 'application/xml' : 'text/html');
  const perr = doc.querySelector('parsererror');
  if (perr) throw new Error(perr.textContent?.split('\n')[0] || 'Parse error');
  if (isXml) {
    const decl = text.match(/^\s*(<\?xml[^?]*\?>)/i);
    const body = serializeMarkupNode(doc.documentElement, 0, true).trimEnd();
    return decl ? decl[1] + '\n' + body : body;
  }
  const hasFullDoc = /^\s*(<!doctype|<html\b)/i.test(text);
  if (hasFullDoc) {
    return ('<!DOCTYPE html>\n' + serializeMarkupNode(doc.documentElement, 0, false)).trimEnd();
  }
  const body = doc.body;
  if (!body) throw new Error('Empty document');
  let out = '';
  for (const c of body.childNodes) out += serializeMarkupNode(c, 0, false);
  return out.trimEnd();
}

function minifyMarkup(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function stripMarkupTags(text) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'text/html');
  if (doc.body) doc.body.querySelectorAll('script, style, noscript').forEach(el => el.remove());
  const out = (doc.body ? doc.body.textContent : text) || '';
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

document.getElementById('fmt-markup-beautify').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  const isXml = getActiveTab()?.viewType === 'xml';
  try { replaceEditorDoc(beautifyMarkup(text, isXml)); }
  catch (err) { notifyFormatError(isXml ? 'XML' : 'HTML', err); }
});
document.getElementById('fmt-markup-minify').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  replaceEditorDoc(minifyMarkup(text));
});
document.getElementById('fmt-markup-strip').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  replaceEditorDoc(stripMarkupTags(text));
});

// ==================== Format Modal (shared for XPath/JSONPath/Schema/Diff) ====================
const fmtModalEl = document.getElementById('fmt-modal');
const fmtModalTitleEl = document.getElementById('fmt-modal-title');
const fmtModalBodyEl = document.getElementById('fmt-modal-body');
const fmtModalFooterEl = document.getElementById('fmt-modal-footer');
let fmtModalOnClose = null;

function openFmtModal({ title, body, footer, onClose }) {
  if (!fmtModalEl.classList.contains('hidden')) {
    const previousOnClose = fmtModalOnClose;
    fmtModalOnClose = null;
    previousOnClose?.();
  }
  fmtModalOnClose = typeof onClose === 'function' ? onClose : null;
  fmtModalTitleEl.textContent = title;
  fmtModalBodyEl.innerHTML = '';
  if (typeof body === 'string') fmtModalBodyEl.innerHTML = body;
  else if (body instanceof Node) fmtModalBodyEl.appendChild(body);
  fmtModalFooterEl.innerHTML = '';
  for (const btn of (footer || [])) {
    const b = document.createElement('button');
    b.textContent = btn.label;
    if (btn.primary) b.classList.add('primary');
    if (btn.disabled) b.disabled = true;
    b.addEventListener('click', btn.onClick);
    fmtModalFooterEl.appendChild(b);
  }
  fmtModalEl.classList.remove('hidden');
}
function closeFmtModal() {
  if (fmtModalEl.classList.contains('locked')) return;
  if (fmtModalEl.classList.contains('hidden')) return;
  fmtModalEl.classList.add('hidden');
  const onClose = fmtModalOnClose;
  fmtModalOnClose = null;
  onClose?.();
}
document.getElementById('fmt-modal-close').addEventListener('click', closeFmtModal);
document.getElementById('fmt-modal-backdrop').addEventListener('click', closeFmtModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !fmtModalEl.classList.contains('hidden')) {
    if (fmtModalEl.classList.contains('locked')) return;
    e.preventDefault();
    closeFmtModal();
  }
});

function confirmUrlFetchModal(detail) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      closeFmtModal();
      resolve(ok);
    };
    const body = document.createElement('div');
    body.className = 'share-modal';
    const title = detail.kind === 'large' ? 'Large URL import' : 'External URL import';
    const summary = document.createElement('p');
    summary.textContent = detail.message || `Fetch file from ${detail.hostname}?`;
    const urlBox = document.createElement('textarea');
    urlBox.className = 'share-link-box';
    urlBox.readOnly = true;
    urlBox.value = detail.url || '';
    body.append(summary, urlBox);

    openFmtModal({
      title,
      body,
      onClose: () => finish(false),
      footer: [
        { label: 'Cancel', onClick: () => finish(false) },
        { label: 'Fetch file', primary: true, onClick: () => finish(true) },
      ],
    });
  });
}

window.orpad.setUrlConfirmHandler?.(confirmUrlFetchModal);
window.orpad.setUrlErrorHandler?.((err) => notifyFormatError('URL import', err));

function openShareModal() {
  const tab = getActiveTab();
  if (!tab) return;
  const content = editor.state.doc.toString();
  const name = getTabDisplayName(tab);
  const bytes = sharedByteLength(content);
  const shareUrl = buildFragmentShareUrl({
    content,
    name,
    baseHref: window.location.href,
  });

  const body = document.createElement('div');
  body.className = 'share-modal';
  const intro = document.createElement('p');
  intro.textContent = 'Copy a one-way snapshot link for the current tab. Anyone opening it gets an unsaved copy in OrPAD Web.';
  const linkBox = document.createElement('textarea');
  linkBox.className = 'share-link-box';
  linkBox.readOnly = true;
  linkBox.value = shareUrl;
  linkBox.addEventListener('focus', () => linkBox.select());
  body.append(intro, linkBox);

  if (bytes > SHARE_WARN_BYTES) {
    const warning = document.createElement('div');
    warning.className = 'share-warning';
    warning.textContent = bytes > SHARE_GIST_BYTES
      ? 'This document is over 256 KB; practical URL length limits may break the link. Create Gist is the recommended next path.'
      : 'This document is over 128 KB; the generated URL may be too long for some browsers or chat apps.';
    body.appendChild(warning);
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      linkBox.select();
    } catch (err) {
      notifyFormatError('Share', err);
    }
  };
  const showGistStub = () => {
    notifyFormatError('Create Gist', new Error('Configure a GitHub PAT in Settings first. TODO: add Settings > GitHub token and POST /gists wiring.'));
  };

  openFmtModal({
    title: 'Share current tab',
    body,
    footer: [
      { label: 'Create Gist', onClick: showGistStub },
      { label: bytes > SHARE_GIST_BYTES ? 'Copy long link' : 'Copy link', primary: true, onClick: copyLink },
      { label: 'Close', onClick: closeFmtModal },
    ],
  });
  setTimeout(() => linkBox.select(), 0);
}

document.getElementById('btn-share')?.addEventListener('click', openShareModal);

// ==================== Auto-update Modal ====================
function showUpdateModal({ currentVersion, latestVersion, releaseBody, hasInstaller, verificationNotice }) {
  const body = document.createElement('div');
  body.className = 'update-modal';
  const notesBlock = releaseBody
    ? `<div class="update-modal-notes-header">${escapeHtml(t('update.releaseNotes'))}</div>
       <div class="update-modal-notes">${escapeHtml(releaseBody)}</div>`
    : '';
  const verificationBlock = verificationNotice
    ? `<div class="share-warning">${escapeHtml(verificationNotice)}</div>`
    : '';
  body.innerHTML = `
    <div class="update-modal-hero">
      <img src="orpad-mark.png" class="update-modal-icon" alt="">
      <div class="update-modal-hero-text">
        <div class="update-modal-headline">${escapeHtml(t('update.message').replace('{0}', latestVersion))}</div>
        <div class="update-modal-versions">
          <div class="update-modal-version">
            <span class="update-modal-version-label">${escapeHtml(t('update.current'))}</span>
            <span class="update-modal-version-value">v${escapeHtml(currentVersion)}</span>
          </div>
          <span class="update-modal-version-arrow">-&gt;</span>
          <div class="update-modal-version">
            <span class="update-modal-version-label">${escapeHtml(t('update.latest'))}</span>
            <span class="update-modal-version-value update-modal-version-new">v${escapeHtml(latestVersion)}</span>
          </div>
        </div>
      </div>
    </div>
    ${notesBlock}
    ${verificationBlock}
  `;

  const act = (action) => { closeFmtModal(); window.orpad.updateAction(action); };
  const footer = [
    { label: t('update.remindLater'), onClick: () => act('later') },
    { label: t('update.skipVersion'), onClick: () => act('skip') },
    { label: t('update.viewRelease'), onClick: () => act('view-release') },
  ];
  if (hasInstaller) {
    footer.push({ label: t('update.downloadInstall'), primary: true, onClick: () => showUpdateConfirmModal() });
  }
  openFmtModal({ title: t('update.title'), body, footer });
}

function showUpdateConfirmModal() {
  const body = document.createElement('div');
  body.className = 'update-confirm';
  const isMac = window.orpad?.platform === 'darwin';
  const msgKey = isMac ? 'update.confirmMessage.mac' : 'update.confirmMessage';
  body.innerHTML = `
    <div class="update-confirm-icon">!</div>
    <div class="update-confirm-text">${escapeHtml(t(msgKey))}</div>
  `;
  openFmtModal({
    title: t('update.confirmTitle'),
    body,
    footer: [
      { label: t('update.confirmCancel'), onClick: () => closeFmtModal() },
      { label: t('update.confirmContinue'), primary: true, onClick: () => {
        showUpdateProgressModal();
        window.orpad.updateAction('download-install');
      }},
    ],
  });
}

function showUpdateProgressModal() {
  const body = document.createElement('div');
  body.className = 'update-progress';
  body.innerHTML = `
    <div class="update-progress-label">${escapeHtml(t('update.downloading'))}</div>
    <div class="update-progress-bar"><div class="update-progress-fill" id="update-progress-fill"></div></div>
    <div class="update-progress-pct" id="update-progress-pct">0%</div>
  `;
  openFmtModal({ title: t('update.title'), body, footer: [] });
  fmtModalEl.classList.add('locked');
}

if (window.orpad?.onShowUpdateDialog) {
  window.orpad.onShowUpdateDialog((data) => showUpdateModal(data));
}
if (window.orpad?.onUpdateProgress) {
  window.orpad.onUpdateProgress((progress) => {
    const fill = document.getElementById('update-progress-fill');
    const pct = document.getElementById('update-progress-pct');
    const v = Math.max(0, Math.min(1, progress));
    if (fill) fill.style.width = (v * 100).toFixed(1) + '%';
    if (pct) pct.textContent = Math.floor(v * 100) + '%';
  });
}
if (window.orpad?.onUpdateError) {
  window.orpad.onUpdateError(() => {
    fmtModalEl.classList.remove('locked');
    closeFmtModal();
  });
}

// ==================== Extended: Markdown ====================
// Align table columns: detect | ... | blocks, pad each cell to column max width
function alignMarkdownTables(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Look for pipe-based table: row, separator (---), more rows
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:-]+\|\s*$/.test(lines[i + 1])) {
      const block = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { block.push(lines[i]); i++; }
      out.push(...formatPipeTable(block));
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}
function formatPipeTable(block) {
  const parseRow = (row) => {
    const trimmed = row.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
    return trimmed.split('|').map(c => c.trim());
  };
  const rows = block.map(parseRow);
  const nCols = Math.max(...rows.map(r => r.length));
  for (const row of rows) while (row.length < nCols) row.push('');
  // Determine alignment from separator row (index 1)
  const alignRow = rows[1] || [];
  const aligns = Array.from({ length: nCols }, (_, i) => {
    const cell = (alignRow[i] || '').trim();
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
  const widths = Array(nCols).fill(0);
  for (let r = 0; r < rows.length; r++) {
    if (r === 1) continue;
    for (let c = 0; c < nCols; c++) widths[c] = Math.max(widths[c], displayWidth(rows[r][c]));
  }
  const pad = (s, w, align) => {
    const dw = displayWidth(s);
    const need = Math.max(0, w - dw);
    if (align === 'right') return ' '.repeat(need) + s;
    if (align === 'center') {
      const l = Math.floor(need / 2), r = need - l;
      return ' '.repeat(l) + s + ' '.repeat(r);
    }
    return s + ' '.repeat(need);
  };
  const lines = [];
  for (let r = 0; r < rows.length; r++) {
    if (r === 1) {
      const sepCells = aligns.map((a, c) => {
        const w = Math.max(3, widths[c]);
        if (a === 'center') return ':' + '-'.repeat(Math.max(1, w - 2)) + ':';
        if (a === 'right')  return '-'.repeat(Math.max(2, w - 1)) + ':';
        return '-'.repeat(Math.max(3, w));
      });
      lines.push('| ' + sepCells.join(' | ') + ' |');
    } else {
      const cells = rows[r].map((s, c) => pad(s, widths[c], aligns[c]));
      lines.push('| ' + cells.join(' | ') + ' |');
    }
  }
  return lines;
}
function displayWidth(s) {
  // Rough CJK-aware width; counts CJK chars as 2
  let w = 0;
  for (const ch of String(s || '')) w += ch.charCodeAt(0) > 127 ? 2 : 1;
  return w;
}
document.getElementById('fmt-md-table-align').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text) return;
  replaceEditorDoc(alignMarkdownTables(text));
});
// Renumber ordered lists: rewrite `N. ` on consecutive lines at same indent to 1,2,3,...
function renumberMarkdownOLs(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (!m) { out.push(lines[i]); i++; continue; }
    const indent = m[1];
    let n = 1;
    while (i < lines.length) {
      const m2 = lines[i].match(/^(\s*)(\d+)\.\s+(.*)$/);
      if (!m2 || m2[1] !== indent) break;
      out.push(`${indent}${n}. ${m2[3]}`);
      n++;
      i++;
    }
  }
  return out.join('\n');
}
document.getElementById('fmt-md-ol-renum').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text) return;
  replaceEditorDoc(renumberMarkdownOLs(text));
});

// ==================== Extended: CSV / TSV ====================
document.getElementById('fmt-csv-fill-down').addEventListener('click', () => {
  if (!currentGrid || currentGrid.readOnly) return;
  let changed = false;
  for (let c = 0; c < currentGrid.headers.length; c++) {
    for (let r = 1; r < currentGrid.data.length; r++) {
      const cur = String(currentGrid.data[r][c] ?? '');
      if (cur === '') {
        const above = String(currentGrid.data[r - 1][c] ?? '');
        if (above !== '') { currentGrid.data[r][c] = above; changed = true; }
      }
    }
  }
  if (changed) { currentGrid.render(); currentGrid.notify(); }
});
document.getElementById('fmt-csv-split-col').addEventListener('click', () => {
  if (!currentGrid || currentGrid.readOnly) return;
  const delim = prompt('Split by delimiter:', ',');
  if (delim === null || delim === '') return;
  const col = currentGrid.active.col;
  let maxParts = 1;
  for (const row of currentGrid.data) {
    const val = String(row[col] ?? '');
    if (val === '') continue;
    const n = val.split(delim).length;
    if (n > maxParts) maxParts = n;
  }
  if (maxParts === 1) { notifyFormatError('Split', new Error('No delimiter found in column')); return; }
  const baseHeader = currentGrid.headers[col] || 'col';
  const newHeaders = Array.from({ length: maxParts }, (_, i) => `${baseHeader}_${i + 1}`);
  currentGrid.headers.splice(col, 1, ...newHeaders);
  currentGrid.colWidths.splice(col, 1, ...newHeaders.map(() => 120));
  for (const row of currentGrid.data) {
    const val = String(row[col] ?? '');
    const parts = val.split(delim);
    while (parts.length < maxParts) parts.push('');
    row.splice(col, 1, ...parts);
  }
  currentGrid.sort = null;
  currentGrid.filters = {};
  currentGrid.render();
  currentGrid.notify();
});
function csvRowsAsObjects() {
  if (!currentGrid) return null;
  const hdr = currentGrid.headers;
  return currentGrid.data.map(row => {
    const obj = {};
    hdr.forEach((h, i) => { obj[h] = row[i] ?? ''; });
    return obj;
  });
}
document.getElementById('fmt-csv-to-json').addEventListener('click', () => {
  const rows = csvRowsAsObjects();
  if (!rows) return;
  navigator.clipboard.writeText(JSON.stringify(rows, null, 2)).catch(() => {});
});
document.getElementById('fmt-csv-to-yaml').addEventListener('click', () => {
  const rows = csvRowsAsObjects();
  if (!rows) return;
  navigator.clipboard.writeText(yamljs.dump(rows, { indent: 2, lineWidth: -1 })).catch(() => {});
});

// ==================== Extended: JSON ====================
document.getElementById('fmt-json-repair').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  // If already valid, nothing to repair
  try {
    JSON.parse(text);
    notifyFormatError('Repair', new Error('JSON is already valid - nothing to repair'));
    return;
  } catch { /* invalid - proceed */ }
  // Attempt repair
  let fixed;
  try {
    fixed = jsonrepair(text);
    fixed = JSON.stringify(JSON.parse(fixed), null, 2);
  } catch (err) { notifyFormatError('Repair', err); return; }
  // Show diff dialog before applying
  const taStyle = 'width:100%;height:180px;resize:vertical;font-family:monospace;font-size:11px;' +
    'background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border-color);' +
    'border-radius:4px;padding:6px;box-sizing:border-box;';
  const body = document.createElement('div');
  body.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:12px;';
  const leftDiv = document.createElement('div');
  leftDiv.innerHTML = '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px">Original (broken)</div>';
  const leftTa = document.createElement('textarea');
  leftTa.readOnly = true; leftTa.value = text; leftTa.style.cssText = taStyle;
  leftDiv.appendChild(leftTa);
  const rightDiv = document.createElement('div');
  rightDiv.innerHTML = '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px">Repaired</div>';
  const rightTa = document.createElement('textarea');
  rightTa.readOnly = true; rightTa.value = fixed; rightTa.style.cssText = taStyle;
  rightDiv.appendChild(rightTa);
  body.appendChild(leftDiv);
  body.appendChild(rightDiv);
  openFmtModal({
    title: 'JSON Repair',
    body,
    footer: [
      { label: 'Apply', primary: true, onClick: () => { replaceEditorDoc(fixed); closeFmtModal(); } },
      { label: 'Cancel', onClick: closeFmtModal },
    ],
  });
});
// Inline JSONPath query (format bar)
{
  const pathInput = document.getElementById('fmt-json-path-input');
  const pathRun = document.getElementById('fmt-json-path-run');
  const pathCount = document.getElementById('fmt-json-path-count');

  function runJsonPath() {
    const path = pathInput.value.trim();
    pathInput.classList.remove('fmt-query-error');
    pathInput.title = '';
    pathCount.textContent = '';
    if (currentJsonEditor) currentJsonEditor.clearHighlights();
    if (!path) return;
    try {
      const data = JSON.parse(editor.state.doc.toString());
      const pointers = JSONPath({ path, json: data, resultType: 'pointer' });
      const count = Array.isArray(pointers) ? pointers.length : 0;
      if (count === 0) {
        notifyFormatError('JSONPath', new Error('0 results'));
        return;
      }
      pathCount.textContent = `(${count} result${count === 1 ? '' : 's'})`;
      if (currentJsonEditor) currentJsonEditor.highlightPointers(pointers);
    } catch (err) {
      pathInput.classList.add('fmt-query-error');
      pathInput.title = err.message || String(err);
    }
  }

  pathRun.addEventListener('click', runJsonPath);
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); runJsonPath(); }
  });
}
const ajvSchemaCache = new Map(); // schema JSON string -> { ajv, validate }
document.getElementById('fmt-json-schema').addEventListener('click', () => {
  const container = document.createElement('div');
  container.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

  // URL fetch row
  const urlRow = document.createElement('div');
  urlRow.style.cssText = 'display:flex;gap:6px;align-items:center;';
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.placeholder = 'Schema URL - paste and Fetch';
  urlInput.style.cssText = 'flex:1;';
  const fetchBtn = document.createElement('button');
  fetchBtn.textContent = 'Fetch';
  urlRow.appendChild(urlInput);
  urlRow.appendChild(fetchBtn);

  const label = document.createElement('label');
  label.textContent = 'Schema JSON (paste, drop file, or fetch URL above)';

  const schemaTa = document.createElement('textarea');
  schemaTa.placeholder = t('modal.schema.placeholder');
  const saved = localStorage.getItem('orpad-last-schema');
  if (saved) schemaTa.value = saved;

  const result = document.createElement('div');
  result.className = 'fmt-modal-result';
  result.textContent = '(paste schema and Validate)';

  container.append(urlRow, label, schemaTa, result);

  // File drop on textarea
  schemaTa.addEventListener('dragover', (e) => { e.preventDefault(); });
  schemaTa.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { schemaTa.value = reader.result; };
    reader.readAsText(file);
  });

  // URL fetch
  fetchBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    fetchBtn.textContent = '...';
    fetchBtn.disabled = true;
    try {
      if (window.orpad.fetchUrlText) {
        const result = await window.orpad.fetchUrlText(url);
        schemaTa.value = result.content;
      } else {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') throw new Error('HTTPS required for schema URL fetch.');
        const resp = await fetch(parsed.href);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const length = Number(resp.headers.get('content-length') || 0);
        if (length > 10 * 1024 * 1024) throw new Error('Schema URL is larger than 10 MB.');
        const text = await resp.text();
        if (new TextEncoder().encode(text).length > 10 * 1024 * 1024) throw new Error('Schema URL is larger than 10 MB.');
        schemaTa.value = text;
      }
    } catch (err) {
      result.classList.remove('ok');
      result.classList.add('error');
      result.textContent = 'Fetch error: ' + (err.message || String(err));
    } finally {
      fetchBtn.textContent = 'Fetch';
      fetchBtn.disabled = false;
    }
  });

  const run = () => {
    try {
      const schemaText = schemaTa.value.trim();
      if (!schemaText) { result.textContent = '(paste schema and Validate)'; return; }
      const schema = JSON.parse(schemaText);
      const data = JSON.parse(editor.state.doc.toString());
      localStorage.setItem('orpad-last-schema', schemaText);
      // Per-schema Ajv cache
      let entry = ajvSchemaCache.get(schemaText);
      if (!entry) {
        const ajv = new Ajv({ allErrors: true, strict: false });
        const validate = ajv.compile(schema);
        entry = { validate };
        ajvSchemaCache.set(schemaText, entry);
      }
      const valid = entry.validate(data);
      if (valid) {
        result.classList.remove('error');
        result.classList.add('ok');
        result.textContent = 'Valid';
      } else {
        result.classList.remove('ok');
        result.classList.add('error');
        result.textContent = entry.validate.errors
          .map(e => `${e.instancePath || '(root)'} - ${e.message}`)
          .join('\n');
      }
    } catch (err) {
      result.classList.remove('ok');
      result.classList.add('error');
      result.textContent = err.message || String(err);
    }
  };
  openFmtModal({
    title: t('modal.schema.title'),
    body: container,
    footer: [
      { label: t('modal.validate'), primary: true, onClick: run },
      { label: t('modal.close'), onClick: closeFmtModal },
    ],
  });
  setTimeout(() => schemaTa.focus(), 30);
});
function applyDiffWorkspaceMode() {
  const on = jsonViewMode === 'diff' && getActiveTab()?.viewType === 'json';
  document.body.classList.toggle('json-diff-mode', on);
}
function setJsonViewMode(mode) {
  if (jsonViewMode === mode) return;
  jsonViewMode = mode;
  const diffBtn = document.getElementById('fmt-json-diff');
  if (diffBtn) diffBtn.classList.toggle('fmt-active', mode === 'diff');
  applyDiffWorkspaceMode();
  invalidateRenderCache(); // mode change forces re-render even with same content
  if (getActiveTab()?.viewType === 'json') renderPreview(editor.state.doc.toString());
}
document.getElementById('fmt-json-diff').addEventListener('click', () => {
  setJsonViewMode(jsonViewMode === 'diff' ? 'tree' : 'diff');
});

// ==================== Extended: JSONL ====================
document.getElementById('fmt-jsonl-minify-each').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    const out = text.split(/\r?\n/).map(l => {
      if (!l.trim()) return l;
      return JSON.stringify(JSON.parse(l));
    }).join('\n');
    replaceEditorDoc(out);
  } catch (err) { notifyFormatError('JSONL', err); }
});
document.getElementById('fmt-jsonl-to-array').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    const arr = text.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
    replaceEditorDoc(JSON.stringify(arr, null, 2));
  } catch (err) { notifyFormatError('JSONL to Array', err); }
});
document.getElementById('fmt-jsonl-from-array').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error('Not a JSON array');
    replaceEditorDoc(arr.map(x => JSON.stringify(x)).join('\n'));
  } catch (err) { notifyFormatError('Array to JSONL', err); }
});
document.getElementById('fmt-jsonl-to-csv').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    const { objs } = parseJsonlLines(text);
    if (objs.length === 0) { notifyFormatError('JSONL to CSV', new Error('No valid lines')); return; }
    if (!objs.every(x => x && typeof x === 'object' && !Array.isArray(x))) throw new Error('JSONL contains non-object values');
    const keys = [...new Set(objs.flatMap(o => Object.keys(o)))];
    const fmtCell = (v) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    };
    const rows = [keys, ...objs.map(o => keys.map(k => fmtCell(o[k])))];
    navigator.clipboard.writeText(Papa.unparse(rows)).catch(() => {});
  } catch (err) { notifyFormatError('JSONL to CSV', err); }
});
document.getElementById('fmt-jsonl-stats').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  const { objs } = parseJsonlLines(text);
  const totalLines = text.split(/\r?\n/).filter(l => l.trim()).length;
  const validLines = objs.length;
  const invalidLines = totalLines - validLines;
  const keyCount = new Map();
  for (const o of objs) {
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      for (const k of Object.keys(o)) keyCount.set(k, (keyCount.get(k) || 0) + 1);
    }
  }
  const keyStats = [...keyCount.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `  ${k}: ${n}/${validLines} (${Math.round(n / validLines * 100)}%)`).join('\n');
  const result = document.createElement('div');
  result.className = 'fmt-modal-result';
  result.textContent = [
    `Total lines: ${totalLines}`,
    `Valid JSON:  ${validLines}`,
    invalidLines > 0 ? `Invalid:     ${invalidLines}` : null,
    '',
    'Key frequency:',
    keyStats || '  (no keys)',
  ].filter(Boolean).join('\n');
  openFmtModal({
    title: 'JSONL Statistics',
    body: result,
    footer: [{ label: t('modal.close'), onClick: closeFmtModal }],
  });
});

// ==================== Extended: YAML ====================
document.getElementById('fmt-yaml-sort-keys').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    const sorted = sortKeysDeep(yamljs.load(text));
    replaceEditorDoc(yamljs.dump(sorted, { indent: 2, lineWidth: -1 }));
  } catch (err) { notifyFormatError('YAML', err); }
});

// ==================== Extended: HTML ====================
function encodeHtmlEntities(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function decodeHtmlEntities(s) {
  const d = document.createElement('div');
  d.innerHTML = String(s);
  return d.textContent || '';
}
function transformHtmlSelection(fn) {
  const { from, to } = editor.state.selection.main;
  if (from === to) {
    const text = editor.state.doc.toString();
    if (!text) return;
    replaceEditorDoc(fn(text));
  } else {
    editor.dispatch({ changes: { from, to, insert: fn(editor.state.sliceDoc(from, to)) } });
    editor.focus();
  }
}
document.getElementById('fmt-html-ent-enc').addEventListener('click', () => transformHtmlSelection(encodeHtmlEntities));
document.getElementById('fmt-html-ent-dec').addEventListener('click', () => transformHtmlSelection(decodeHtmlEntities));
document.getElementById('fmt-html-to-md').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  if (!text.trim()) return;
  try {
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
    const md = td.turndown(text);
    navigator.clipboard.writeText(md).catch(() => {});
  } catch (err) { notifyFormatError('HTML to Markdown', err); }
});

// ==================== Extended: XML ====================
// Inline XPath query (format bar)
{
  const xpathInput = document.getElementById('fmt-xml-xpath-input');
  const xpathRun = document.getElementById('fmt-xml-xpath-run');
  const xpathCount = document.getElementById('fmt-xml-xpath-count');

  function clearXPathHighlights() {
    for (const el of contentEl.querySelectorAll('.xml-highlight')) el.classList.remove('xml-highlight');
  }

  function runXPath() {
    const query = xpathInput.value.trim();
    xpathInput.classList.remove('fmt-query-error');
    xpathInput.title = '';
    xpathCount.textContent = '';
    clearXPathHighlights();
    if (!query) return;
    try {
      const doc = contentEl._xmlDoc;
      if (!doc) { notifyFormatError('XPath', new Error('No XML document loaded')); return; }
      // Namespace resolver: read prefixes from the root element
      const resolver = (prefix) => doc.documentElement.lookupNamespaceURI(prefix);
      const xres = doc.evaluate(query, doc, resolver, XPathResult.ANY_TYPE, null);
      const nodeMap = contentEl._xmlNodeMap;
      const type = xres.resultType;
      if (type === XPathResult.NUMBER_TYPE) {
        xpathCount.textContent = '= ' + xres.numberValue;
      } else if (type === XPathResult.STRING_TYPE) {
        xpathCount.textContent = '= ' + JSON.stringify(xres.stringValue);
      } else if (type === XPathResult.BOOLEAN_TYPE) {
        xpathCount.textContent = '= ' + xres.booleanValue;
      } else {
        let node, count = 0, firstEl = null;
        while ((node = xres.iterateNext()) !== null) {
          count++;
          const el = nodeMap?.get(node);
          if (el) { el.classList.add('xml-highlight'); if (!firstEl) firstEl = el; }
        }
        if (count === 0) {
          notifyFormatError('XPath', new Error('0 results'));
        } else {
          xpathCount.textContent = `(${count} result${count === 1 ? '' : 's'})`;
          if (firstEl) firstEl.scrollIntoView({ block: 'nearest' });
        }
      }
    } catch (err) {
      xpathInput.classList.add('fmt-query-error');
      xpathInput.title = err.message || String(err);
    }
  }

  xpathRun.addEventListener('click', runXPath);
  xpathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); runXPath(); }
  });
}

// ==================== Extended: .env ====================
document.getElementById('fmt-env-validate').addEventListener('click', () => {
  const text = editor.state.doc.toString();
  const result = document.createElement('div');
  result.className = 'fmt-modal-result';
  const seen = new Map();
  const issues = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) { issues.push({ line: i + 1, kind: 'syntax', msg: 'Invalid format (expected KEY=VALUE)' }); continue; }
    const key = m[1];
    let value = m[2];
    const first = value[0];
    if (first === '"' || first === "'") {
      const last = value[value.length - 1];
      if (value.length < 2 || last !== first) issues.push({ line: i + 1, kind: 'quote', msg: `Unterminated ${first === '"' ? 'double' : 'single'} quote` });
    }
    if (seen.has(key)) issues.push({ line: i + 1, kind: 'duplicate', msg: `Duplicate key "${key}" (first at line ${seen.get(key)})` });
    else seen.set(key, i + 1);
  }
  if (issues.length === 0) {
    result.classList.add('ok');
    result.textContent = `${seen.size} keys, no issues`;
  } else {
    result.classList.add('error');
    result.textContent = issues.map(x => `L${x.line} [${x.kind}] ${x.msg}`).join('\n');
  }
  openFmtModal({
    title: 'Validate .env',
    body: result,
    footer: [{ label: t('modal.close'), onClick: closeFmtModal }],
  });
});

// ==================== Extended: Mermaid theme ====================
const mmdThemeMenu = document.getElementById('mmd-theme-menu');
document.getElementById('fmt-mmd-theme').addEventListener('click', (e) => { e.stopPropagation(); mmdThemeMenu.classList.toggle('hidden'); });
document.addEventListener('click', () => mmdThemeMenu.classList.add('hidden'));
mmdThemeMenu.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    mmdThemeMenu.classList.add('hidden');
    mmdTheme = btn.dataset.theme;
    localStorage.setItem('orpad-mmd-theme', mmdTheme);
    invalidateRenderCache();
    if (getActiveTab()?.viewType === 'mermaid') renderPreview(editor.state.doc.toString());
  });
});

// ==================== Clipboard Image Paste ====================
document.getElementById('editor').addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) return;
      const buffer = await blob.arrayBuffer();
      const ext = item.type.split('/')[1] === 'png' ? 'png' : 'jpg';
      const tab = getActiveTab();
      const result = await window.orpad.saveImage(tab?.filePath, new Uint8Array(buffer), ext);
      if (result) {
        const { from, to } = editor.state.selection.main;
        const insert = `![image](${result})`;
        editor.dispatch({ changes: { from, to, insert } });
      }
      return;
    }
  }
});

// ==================== Mermaid Rendering ====================
let mmdLastAppliedTheme = null;
// Per-block debounce timers and SVG cache, keyed by data-mermaid-hash.
const mermaidTimers = new Map();
const mermaidSvgCache = new Map();

async function _renderMermaidBlock(block, code, cacheKey) {
  let valid = true;
  try { valid = await mermaidModule.parse(code, { suppressErrors: true }); }
  catch { valid = false; }
  if (!valid) {
    block.innerHTML = '<div class="preview-error">Invalid Mermaid diagram.</div>';
    return;
  }
  try {
    const id = 'mermaid-' + Math.random().toString(36).substring(2, 9);
    const { svg } = await mermaidModule.render(id, code);
    if (cacheKey) mermaidSvgCache.set(cacheKey, svg);
    block.innerHTML = svg;
    block.classList.add('mermaid-rendered');
  } catch { block.innerHTML = '<div class="preview-error">Mermaid render failed.</div>'; }
  // Purge any stray error element Mermaid may have appended to <body>.
  document.querySelectorAll('body > [id^="dmermaid"], body > svg[id^="mermaid"]').forEach((el) => el.remove());
}

async function renderMermaidBlocks() {
  const blocks = contentEl.querySelectorAll('.mermaid-block');
  if (blocks.length === 0) return;
  if (!mermaidModule) {
    try {
      mermaidModule = (await import('mermaid')).default;
      mermaidModule.initialize({ startOnLoad: false, theme: mmdTheme, securityLevel: 'strict', logLevel: 'fatal' });
      mmdLastAppliedTheme = mmdTheme;
      mermaidReady = true;
    } catch { return; }
  } else if (mmdLastAppliedTheme !== mmdTheme) {
    try { mermaidModule.initialize({ startOnLoad: false, theme: mmdTheme, securityLevel: 'strict', logLevel: 'fatal' }); }
    catch {}
    mmdLastAppliedTheme = mmdTheme;
    mermaidSvgCache.clear();
  }
  for (const block of blocks) {
    const code = block.getAttribute('data-mermaid');
    if (!code) continue;
    const h = block.getAttribute('data-mermaid-hash');

    // Blocks without a hash (e.g. .mmd file preview) render immediately.
    if (!h) {
      await _renderMermaidBlock(block, code, null);
      continue;
    }

    // Cache hit: inject previously rendered SVG without re-invoking mermaid.
    if (mermaidSvgCache.has(h)) {
      block.innerHTML = mermaidSvgCache.get(h);
      block.classList.add('mermaid-rendered');
      continue;
    }

    // 400ms per-block debounce: typing in one block doesn't re-render others.
    if (mermaidTimers.has(h)) clearTimeout(mermaidTimers.get(h));
    mermaidTimers.set(h, setTimeout(async () => {
      mermaidTimers.delete(h);
      const el = contentEl.querySelector('[data-mermaid-hash="' + h + '"]');
      if (!el) return;
      await _renderMermaidBlock(el, el.getAttribute('data-mermaid'), h);
    }, 400));
  }
}

// ==================== Keyboard Shortcuts ====================
function isSaveShortcut(event) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's';
}

function shouldIgnoreGlobalShortcut(event) {
  const target = event.target;
  const el = target instanceof Element ? target : target?.parentElement;
  if (!el) return false;
  if (el.closest('.cm-editor')) return false;
  if (typeof fmtModalEl !== 'undefined' && fmtModalEl && !fmtModalEl.classList.contains('hidden')) return true;
  const editableField = el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]');
  if (!editableField) return false;
  if (isSaveShortcut(event) && editableField.closest('.orch-preview')) return false;
  return true;
}

document.addEventListener('keydown', (e) => {
  if (e.orpadInternal) return;
  if (shouldIgnoreGlobalShortcut(e)) return;
  const key = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  const runShortcut = (id) => {
    e.preventDefault();
    runCommand(id, {}, getCommandContext()).catch(err => notifyFormatError('Command', err));
  };
  const clearZenChord = () => {
    zenChordArmed = false;
    if (zenChordTimer) {
      clearTimeout(zenChordTimer);
      zenChordTimer = null;
    }
  };
  if (commandPalette?.shouldHandleShortcut(e)) { e.preventDefault(); commandPalette.open(); return; }
  if (quickOpen?.shouldHandleShortcut(e)) { e.preventDefault(); quickOpen.open(); return; }
  if (zenChordArmed) {
    if (key === 'z' && !e.altKey && !e.shiftKey) {
      clearZenChord();
      runShortcut('editor.toggleZen');
      return;
    }
    clearZenChord();
  }
  if (mod && key === 'b' && !e.shiftKey) { runShortcut('format.bold'); return; }
  if (mod && key === 'i' && !e.shiftKey) { runShortcut('format.italic'); return; }
  if (mod && key === 'k' && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    zenChordArmed = true;
    zenChordTimer = setTimeout(() => {
      clearZenChord();
      runCommand('format.link', {}, getCommandContext()).catch(err => notifyFormatError('Command', err));
    }, 650);
    return;
  }
  if (mod && e.altKey && key === 'n') { runShortcut('file.newTemplate'); return; }
  if (mod && key === 'n') { runShortcut('file.new'); return; }
  if (mod && key === 'o' && !e.shiftKey) { runShortcut('file.open'); return; }
  if (mod && key === 't' && !e.shiftKey) { runShortcut('view.toc'); return; }
  if (mod && key === 's' && !e.defaultPrevented) { runShortcut(e.shiftKey ? 'file.saveAs' : 'file.save'); return; }
  if (mod && key === 'w') { runShortcut('file.closeTab'); return; }
  if (mod && key === 'f' && !e.shiftKey) { runShortcut('edit.find'); return; }
  if (mod && key === 'h' && !e.shiftKey) { runShortcut('edit.replace'); return; }
  if (mod && key === 'g' && !e.shiftKey) { runShortcut('edit.goToLine'); return; }
  // Ctrl+Tab / Ctrl+Shift+Tab to cycle tabs
  if (mod && e.key === 'Tab') {
    e.preventDefault();
    if (tabs.length > 1) {
      const currentIdx = tabs.findIndex(tb => tb.id === activeTabId);
      const nextIdx = e.shiftKey
        ? (currentIdx - 1 + tabs.length) % tabs.length
        : (currentIdx + 1) % tabs.length;
      switchToTab(tabs[nextIdx].id);
    }
  }
  // Ctrl+Shift+E - file explorer
  if (mod && e.shiftKey && key === 'e') { runShortcut('view.files'); return; }
  // Ctrl+Shift+F - search in files
  if (mod && e.shiftKey && key === 'f') { runShortcut('view.search'); return; }
  // Ctrl+Shift+B - backlinks
  if (mod && e.shiftKey && key === 'b') { runShortcut('view.backlinks'); return; }
  if (key === 'escape') {
    if (document.body.classList.contains('zen-mode')) setZenMode(false);
    if (!themePanel.classList.contains('hidden')) themePanel.classList.add('hidden');
    if (!exportMenu.classList.contains('hidden')) exportMenu.classList.add('hidden');
    document.getElementById('context-menu').classList.add('hidden');
  }
}, true);

// ==================== IPC ====================
window.orpad.onLoadMarkdown((data) => {
  const tab = createTab(data.filePath, data.dirPath, data.content, data.savedContent, {
    title: data.title,
    source: data.source,
    sourceUrl: data.sourceUrl,
    forceUnsaved: data.forceUnsaved,
  });
  if ('savedContent' in data) {
    tab.lastSavedContent = normalizeLineEndings(data.savedContent);
    tab.isModified = data.forceUnsaved === true || editor.state.doc.toString() !== tab.lastSavedContent;
    updateTitle();
    renderTabBar();
  }
});
window.orpad.onNewFromTemplate?.(() => openNewFromTemplate());

// ==================== Init ====================
function applyLocaleToDOM() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.body.dataset.dropText = t('dropHere');
}

function applyDividerRatio(ratio) {
  const rect = workspaceEl.getBoundingClientRect();
  const sidebarWidth = sidebarVisible ? sidebarEl.offsetWidth : 0;
  const available = rect.width - sidebarWidth - dividerEl.offsetWidth;
  if (available > 0) {
    editorPaneEl.style.flex = 'none';
    editorPaneEl.style.width = (ratio * available) + 'px';
    previewPaneEl.style.flex = '1';
  }
}

// Editor pane width is stored as a pixel value once the user drags the divider,
// so window resizes would otherwise leave it stuck at an absolute width while
// preview absorbs/loses all the delta. Re-apply the saved ratio on resize so
// both panes scale proportionally. Debounce mildly to avoid thrashing.
let resizeRaf = 0;
window.addEventListener('resize', () => {
  if (isDragging) return;
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    const savedRatio = parseFloat(localStorage.getItem('orpad-divider-ratio'));
    if (savedRatio > 0 && savedRatio < 1) {
      applyDividerRatio(savedRatio);
    } else {
      // No saved ratio - make sure the editor pane is back to flex:1 so the
      // two panes share the width equally on any window size.
      editorPaneEl.style.flex = '1';
      editorPaneEl.style.width = '';
      previewPaneEl.style.flex = '1';
    }
  });
});

(async () => {
  // Load locale
  const { code: installerLocale, mtime } = await window.orpad.getLocale();
  const prevMtime = localStorage.getItem('orpad-locale-mtime');
  if (String(mtime) !== prevMtime) {
    localStorage.removeItem('orpad-locale');
    localStorage.setItem('orpad-locale-mtime', String(mtime));
  }
  const userLocale = localStorage.getItem('orpad-locale');
  setLocale(userLocale || installerLocale);
  applyLocaleToDOM();
  langSelect.value = getLocaleCode();

  await initTheme();

  // Restore sidebar state (migrate from legacy TOC)
  const legacyTocVisible = localStorage.getItem('orpad-toc-visible');
  const savedSidebarVisible = localStorage.getItem('orpad-sidebar-visible');
  const savedSidebarPanel = localStorage.getItem('orpad-sidebar-panel') || 'files';

  if (savedSidebarVisible === 'true' || (savedSidebarVisible === null && legacyTocVisible === 'true')) {
    sidebarActivePanel = legacyTocVisible === 'true' && savedSidebarVisible === null ? 'toc' : savedSidebarPanel;
    sidebarEl.style.transition = 'none';
    showSidebar(sidebarActivePanel);
    sidebarEl.offsetHeight;
    sidebarEl.style.transition = '';
  }
  if (legacyTocVisible !== null) localStorage.removeItem('orpad-toc-visible');

  // Restore document zoom level
  applyZoom(zoomLevel);

  // Restore view mode
  setViewMode(localStorage.getItem('orpad-view-mode') || 'split');

  // Hide format-bar until a tab is active
  updateFormatBar(getActiveTab()?.viewType || null);

  // Restore divider ratio
  const savedRatio = parseFloat(localStorage.getItem('orpad-divider-ratio'));
  if (savedRatio > 0 && savedRatio < 1) applyDividerRatio(savedRatio);

  const approvedWorkspace = await window.orpad.getApprovedWorkspace?.().catch(() => null);
  if (approvedWorkspace) {
    workspacePath = approvedWorkspace;
    localStorage.setItem('orpad-workspace-path', workspacePath);
  } else if (workspacePath) {
    workspacePath = null;
    localStorage.removeItem('orpad-workspace-path');
  }

  // Restore workspace & file tree
  if (workspacePath) {
    loadFileTree();
    window.orpad.watchDirectory(workspacePath);
    window.orpad.buildLinkIndex(workspacePath).then(() => refreshFileNameCache());
    scheduleGitRefresh(0);
    scheduleSnippetRefresh(0);
  }
  await refreshUserSnippets();
  window.orpad.userSnippets?.watch?.();
  window.orpad.userSnippets?.onChanged?.(() => scheduleSnippetRefresh(100));

  terminalController = createTerminalPanel({
    track,
    hooks: {
      getActiveTab() {
        const tab = getActiveTab();
        if (!tab) return null;
        return {
          id: tab.id,
          filePath: tab.filePath,
          dirPath: tab.dirPath,
          viewType: tab.viewType,
        };
      },
      getWorkspacePath() { return workspacePath; },
      openModal: openFmtModal,
      closeModal: closeFmtModal,
      notify: notifyFormatError,
      insertRunnerBlock: insertRunnerTroubleshootingBlock,
    },
  });
  document.getElementById('btn-terminal')?.addEventListener('click', () => terminalController?.toggle());

  aiController = initAISidebar({
    workspaceEl,
    track,
    hooks: {
      getActiveTab() {
        const tab = getActiveTab();
        if (!tab) return null;
        return {
          id: tab.id,
          filePath: tab.filePath,
          name: tab.filePath ? tab.filePath.split(/[/\\]/).pop() : (tab.title || t('untitled')),
          dirPath: tab.dirPath,
          viewType: tab.viewType,
          content: editor.state.doc.toString(),
          selection: getEditorSelectionText(),
          isModified: tab.isModified,
        };
      },
      getOpenTabs() {
        return tabs.map(tab => ({
          id: tab.id,
          filePath: tab.filePath,
          name: tab.filePath ? tab.filePath.split(/[/\\]/).pop() : (tab.title || t('untitled')),
          viewType: tab.viewType,
          isModified: tab.isModified,
        }));
      },
      getWorkspacePath() { return workspacePath; },
      activateTab(tabId) {
        if (!tabs.some(tab => tab.id === tabId)) return false;
        switchToTab(tabId);
        return true;
      },
      getRunnerAttachment() { return terminalController?.getLastOutput?.() || null; },
      getTemplateSection(section) {
        const active = getActiveTab();
        if (!active || active.viewType !== 'markdown') return null;
        const range = findSectionRange(editor.state.doc.toString(), section);
        return range ? { section, text: range.text } : null;
      },
      replaceTemplateSection(section, text) {
        const active = getActiveTab();
        if (!active || active.viewType !== 'markdown') return;
        const next = replaceSectionContent(editor.state.doc.toString(), section, text);
        replaceEditorDoc(next);
        renderTemplateStatusChip();
      },
      async getWorkspaceFiles() {
        if (!workspacePath) return [];
        try {
          const names = await window.orpad.getFileNames(workspacePath);
          return (names || []).slice(0, 100).map(item => item.filePath || item.baseName || '');
        } catch {
          return [];
        }
      },
      replaceSelectionOrDocument: replaceSelectionOrDoc,
      replaceDocument: replaceEditorDoc,
      createTextTab(name, content, viewType) {
        const tab = createTab(null, null, content || '');
        tab.title = name || t('untitled');
        if (viewType) {
          tab.viewType = viewType;
          tab.editorState = createEditorState(content || '', viewType);
          editor.setState(tab.editorState);
          renderPreview(content || '');
          updateFormatBar(viewType);
        }
        renderTabBar();
        return tab;
      },
      showCsvFilterChip(label) {
        currentGrid?.showFilterChip?.(label);
      },
      openModal: openFmtModal,
      closeModal: closeFmtModal,
      notify: notifyFormatError,
      onVisibilityChange: syncAiToolbarButton,
    },
  });
  btnAiEl?.addEventListener('click', () => aiController?.toggle?.());
  syncAiToolbarButton();

  const commandRoot = document.getElementById('command-palette-root') || document.body;
  commandPalette = createCommandPalette({
    root: commandRoot,
    getCommands,
    runCommand: (id, args) => runCommand(id, args, getCommandContext()),
    getContext: getCommandContext,
    notify: notifyFormatError,
  });
  quickOpen = createQuickOpen({
    root: commandRoot,
    getFiles: getQuickOpenFiles,
    readFile: readFileForQuickOpen,
    openFile: openFileFromQuickOpen,
    getWorkspacePath: () => workspacePath,
    notify: notifyFormatError,
  });
  setupCommandRegistry();

  // Auto-save recovery (every 30 seconds)
  autoSaveTimer = setInterval(() => {
    for (const tab of tabs) {
      if (!tab.isModified) continue;
      const content = tab.id === activeTabId
        ? editor.state.doc.toString()
        : tab.editorState.doc.toString();
      if (content === tab.lastAutoSavedContent) continue;
      tab.lastAutoSavedContent = content;
      window.orpad.autoSaveRecovery(getRecoveryKey(tab), content);
    }
  }, 30000);

  // Analytics
  const appInfo = await window.orpad.getAppInfo();
  initAnalytics({
    domain: process.env.PLAUSIBLE_DOMAIN,
    apiHost: 'https://plausible.io',
    isPackaged: appInfo.isPackaged,
    isWeb: IS_WEB,
  });
  const firstRun = !localStorage.getItem('orpad-first-run');
  if (firstRun) localStorage.setItem('orpad-first-run', '1');
  track('session_start', {
    platform: window.orpad?.platform || 'web',
    version: appInfo.version || process.env.APP_VERSION,
    first_run: String(firstRun),
  });
})();

// ==================== Analytics event hooks ====================
const _analyticsSessionStart = Date.now();

window.addEventListener('beforeunload', () => {
  track('session_end', {
    duration_min: String(Math.round((Date.now() - _analyticsSessionStart) / 60000)),
  });
});

window.addEventListener('error', (e) => {
  const tab = getActiveTab();
  track('error', {
    type: e.error?.name || 'Error',
    format: tab?.viewType || 'unknown',
    stack_sig: stackSig(e.error || e),
  });
});

document.getElementById('format-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[id]');
  if (!btn) return;
  const tab = getActiveTab();
  track('format_bar_click', {
    format: tab?.viewType || 'unknown',
    button_name: btn.id,
  });
});

// TODO: Add "Send usage data" toggle to Settings UI (required before P1).
// Opt-out via: localStorage.setItem("analytics-opt-out", "1") and reload.

// (v2 had a `onSetWorkspaceDir` listener for when the tree editor launched the MD editor as
// a sub-window. In v3 OrPAD is a standalone process, so this hook is no longer needed.)
