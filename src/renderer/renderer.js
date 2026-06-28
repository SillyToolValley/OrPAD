import { initAnalytics, track, sizeBucket, stackSig } from './analytics.js';
import { createLiveTraceView } from './orchestration/live-trace-view.js';
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
import { foldCode, foldedRanges, foldEffect, LanguageDescription, syntaxHighlighting, unfoldCode } from '@codemirror/language';
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
const btnOrchestrationEl = document.getElementById('btn-orchestration');
const orchestrationRunbarSlotEl = document.getElementById('orchestration-runbar-slot');
const contextReturnBarEl = document.getElementById('context-return-bar');
const APP_SEARCH_PARAMS = new URLSearchParams(window.location.search || '');
const IS_ORCHESTRATION_WINDOW = APP_SEARCH_PARAMS.get('mode') === 'orchestration';
let coreRunView = null;
if (IS_ORCHESTRATION_WINDOW) {
  document.body.classList.add('orchestration-window');
  btnOrchestrationEl?.classList.add('active');
  btnOrchestrationEl?.setAttribute('aria-pressed', 'true');
  setupCoreRunView();
} else {
  // Run-history is an orchestration-only control; remove it from the editor toolbar
  // entirely (a bare CSS hide loses to `#toolbar button { display:flex }`).
  document.getElementById('btn-core-runs')?.remove();
}

// Live-trace Run view: mount the emergent-graph panel into the orchestration
// window and forward every core trace event to it. The core streams events on
// 'orpad-core-trace' (live runs + recorded-trace replays); a 'run/start' event
// resets the graph so a new run draws fresh.
function setupCoreRunView() {
  if (coreRunView || !previewPaneEl || !window.orpad?.core?.onCoreTrace) return;
  const canRun = typeof window.orpad?.core?.startRun === 'function';
  // The Run GUI window is a PURE VIEWER — it never launches runs (that happens in the terminal). It only
  // lists/replays recorded runs and renders the live trace stream.
  coreRunView = createLiveTraceView({
    onLinkGraph: typeof window.orpad?.getLinkGraph === 'function'
      ? () => window.orpad.getLinkGraph()
      : null,
    onListRuns: typeof window.orpad?.core?.listRuns === 'function'
      ? () => window.orpad.core.listRuns()
      : null,
    onReplay: typeof window.orpad?.core?.replayTrace === 'function'
      ? (traceFile) => window.orpad.core.replayTrace({ traceFile, intervalMs: 5 })
      : null,
  });
  coreRunView.el.id = 'core-run-view';
  previewPaneEl.appendChild(coreRunView.el);
  window.orpad.core.onCoreTrace((payload) => {
    if (coreRunView) coreRunView.applyEvent(payload);
  });
  // Seed from a terminal AI-CLI launch ("Apply orchestration"): OBSERVE the live session so it streams into this
  // viewer as a graph. PRIMARY = parse the terminal's PTY stream (sessionId); the graph builds from the rendered
  // screen, no session-log dependency. Works for ANY AI CLI (claude + codex have detector grammars; others still
  // show the run). Dedup PER SESSION (not a single boolean): the same seed may arrive twice (push + pull), but a
  // SECOND Apply on a different session must start its OWN observer — the backend supports N concurrent sessions.
  const seededSessions = new Set();
  const handleSeed = (seed) => {
    if (!coreRunView || !seed) return;
    if (seed.observe && typeof window.orpad?.core?.observeStart === 'function') {
      const sid = String(seed.sessionId || '');
      if (sid && seededSessions.has(sid)) return; // already observing this exact session
      if (sid) seededSessions.add(sid);
      window.orpad.core.observeStart({
        cwd: seed.cwd, agent: seed.agent, pid: seed.pid || null,
        sessionId: seed.sessionId || null, cols: seed.cols || null, rows: seed.rows || null,
      }).catch(() => {});
    }
  };
  // Delivered two ways (whichever wins): a push for an already-open window + a pull on init (race-proof).
  if (typeof window.orpad?.core?.onSeed === 'function') window.orpad.core.onSeed(handleSeed);
  if (typeof window.orpad?.core?.pullSeed === 'function') {
    window.orpad.core.pullSeed().then((seed) => handleSeed(seed)).catch(() => {});
  }
  // Re-sync on (re)open: reattach to any live observers for this workspace (their PTY sessions are still
  // running) and replay their buffered graph — so closing+reopening the Run GUI doesn't lose the live graph.
  // Replayed events arrive via onCoreTrace above. (No-op on a fresh first open with no active observers.)
  if (typeof window.orpad?.core?.observeReattach === 'function') {
    window.orpad.core.observeReattach().catch(() => {});
  }
  void canRun;
  // The run-history picker is superseded by the in-view Runs sidebar; the toolbar button now refreshes it.
  const coreRunsBtn = document.getElementById('btn-core-runs');
  if (coreRunsBtn && typeof window.orpad?.core?.listRuns === 'function') {
    coreRunsBtn.addEventListener('click', () => { coreRunView?.seedRunsFromHistory?.(); });
  } else if (coreRunsBtn) {
    coreRunsBtn.style.display = 'none';
  }
}

// (The old run-history picker modal + replayCoreRun/formatRunTime helpers were removed — superseded by the
// in-view Runs sidebar, which lists + replays recorded runs via the view's onListRuns/onReplay callbacks.)

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

function isPathInsideWorkspaceRoot(filePath, rootPath) {
  if (!rootPath || !filePath) return false;
  const root = normalizeComparablePath(rootPath);
  const full = normalizeComparablePath(filePath);
  return full === root || full.startsWith(root + '/');
}

function isPathInsideWorkspace(filePath) {
  return isPathInsideWorkspaceRoot(filePath, workspacePath);
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
let pipelineGenerateState = null;
const EXTERNAL_RESEARCH_INTENT_PATTERN = /\b(search|competing products|competitors?|market|benchmarks?|benchmarking|web research|external research|browse|internet|online)\b/i;
const ORPAD_WORK_ITEM_SCHEMA_VERSION = 'orpad.workItem.v1';
const ORPAD_WORK_ITEM_STATES = Object.freeze(['candidate', 'queued', 'claimed', 'done', 'blocked', 'rejected']);
const runbookValidationCache = new Map();
const runbookRecordCache = new Map();
const machineRunRecordCache = new Map();
const machineRunListCache = new Map();
const machineLatestRunHydrationPending = new Set();
const ORCHESTRATION_SELECTED_PIPELINE_STORAGE_PREFIX = 'orpad-orchestration-selected-pipeline:';
// Live event log state -Phase 1.2:
//   stickRunIds: runIds whose event log auto-scrolls to bottom on render.
//     Default ON; user toggles off when they want to inspect older events.
//   lastRendered: tracks the highest event sequence rendered per runId so
//     freshly arrived events can be flashed (the .runbook-event-fresh
//     class) without flagging the entire backlog as new on first render.
const machineRunReplayStickRunIds = new Set();
const lastReplayRenderedSequence = new Map();
const machineRunReplayStickDefault = true;
// Time travel state -Phase 2.4:
//   replayPositionByRunId: runId -1-based event index. When set,
//     renders truncate events to events[0..position] so the entire UI
//     reflects the run state AT THAT POINT. null / unset = live view.
const machineRunReplayPosition = new Map();
const machineApprovalPromptSeen = new Set();
const machineBlockedDecisionPromptSeen = new Set();

function machineRunTransientScopeKey(runbookPath, runId) {
  const normalizedRunId = String(runId || '');
  if (!normalizedRunId) return '';
  const normalizedWorkspace = normalizeComparablePath(workspacePath || '');
  const normalizedRunbook = runbookNormalizePath(runbookPath || selectedRunbookPath || '').toLowerCase();
  return `${normalizedWorkspace}::${normalizedRunbook}::${normalizedRunId}`;
}

const MACHINE_LATEST_RUN_EVENT_PROJECTION_CACHE_LIMIT = 24;
const machineLatestRunEventProjectionCache = new Map();

function machineInventoryProjectionSignature(inventory) {
  if (!inventory?.counts) return '';
  const counts = inventory.counts || {};
  return ORPAD_WORK_ITEM_STATES.map(state => `${state}:${Number(counts[state]) || 0}`).join(',');
}

function machineLatestRunEventProjectionScope(record) {
  const runId = String(record?.runState?.runId || record?.runId || '').trim();
  if (!runId) return '';
  const runRoot = String(record?.runRoot || record?.runState?.runRoot || '').trim();
  return `${runRoot}::${runId}`;
}

function machineLatestRunEventProjectionKey(record) {
  const scope = machineLatestRunEventProjectionScope(record);
  if (!scope) return '';
  const events = Array.isArray(record?.events) ? record.events : [];
  const lastEvent = events[events.length - 1] || null;
  const replay = record?.__replay
    ? `${record.__replay.position ?? ''}/${record.__replay.total ?? events.length}`
    : 'live';
  const directInventory = record?.finalization?.inventory || record?.resume?.inventory || record?.inventory || null;
  return [
    scope,
    replay,
    events.length,
    lastEvent?.sequence ?? '',
    lastEvent?.eventType || lastEvent?.type || '',
    machineInventoryProjectionSignature(directInventory),
  ].join('|');
}

function machineQueueInventoryFromItemStates(itemStates) {
  if (!itemStates?.size) return null;
  const counts = Object.fromEntries(ORPAD_WORK_ITEM_STATES.map(state => [state, 0]));
  for (const state of itemStates.values()) counts[state] = (counts[state] || 0) + 1;
  const activeCount = ['candidate', 'queued', 'claimed'].reduce((sum, state) => sum + (Number(counts[state]) || 0), 0);
  const terminalCount = ['done', 'blocked', 'rejected'].reduce((sum, state) => sum + (Number(counts[state]) || 0), 0);
  return {
    counts,
    activeCount,
    terminalCount,
    blockedCount: Number(counts.blocked) || 0,
    doneCount: Number(counts.done) || 0,
  };
}

function machineWorkerProofDetailsFromProjection(projection) {
  if (!projection?.workerResultCount) return 'No work result yet';
  if (projection.workerResultCount > 1) {
    return [
      machineCountLabel(projection.workerResultCount, 'work result'),
      machineCountLabel(projection.workerEvidenceCount, 'evidence file'),
      machineCountLabel(projection.workerCheckCount, 'check'),
      machineCountLabel(projection.workerChangedFileCount, 'changed file'),
    ].filter(Boolean).join('; ');
  }
  return [
    machineWorkerStatusLabel(projection.latestWorkerStatus),
    machineCountLabel(projection.latestWorkerEvidenceCount, 'evidence file'),
    machineCountLabel(projection.latestWorkerCheckCount, 'check'),
    machineCountLabel(projection.latestWorkerChangedFileCount, 'changed file'),
  ].filter(Boolean).join('; ');
}

function machineBuildLatestRunEventProjection(record) {
  const events = Array.isArray(record?.events) ? record.events : [];
  const queueItemStates = new Map();
  let queueUpdateCount = 0;
  let latestSummaryInventory = null;
  let latestStatusInventory = null;
  let latestWorkerEvent = null;
  let latestBlockedWorkerEvent = null;
  let latestBlockedQueueTransitionEvent = null;
  let latestPartialArtifactContract = null;
  let latestCompletionBlock = null;
  let workerResultCount = 0;
  let workerEvidenceCount = 0;
  let workerCheckCount = 0;
  let workerChangedFileCount = 0;
  let latestWorkerStatus = '';
  let latestWorkerEvidenceCount = 0;
  let latestWorkerCheckCount = 0;
  let latestWorkerChangedFileCount = 0;
  let nodeCompletedCount = 0;
  let modelDowngradeCount = 0;
  for (const event of events) {
    const type = String(event?.eventType || event?.type || '');
    const payload = event?.payload || {};
    if (event?.itemId || type.startsWith('queue.')) queueUpdateCount += 1;
    if (type === 'queue.transition') {
      const itemId = String(event.itemId || payload.itemId || '').trim();
      const toState = String(event.toState || payload.toState || '').trim();
      if (itemId && ORPAD_WORK_ITEM_STATES.includes(toState)) queueItemStates.set(itemId, toState);
      if (String(toState).toLowerCase() === 'blocked') latestBlockedQueueTransitionEvent = event;
    } else if (type === 'run.summary') {
      if (payload.inventory?.counts) latestSummaryInventory = payload.inventory;
      if (payload.completionBlocked) latestCompletionBlock = payload.completionBlocked;
    } else if (type === 'run.status') {
      if (payload.inventory?.counts) latestStatusInventory = payload.inventory;
      if (payload.completionBlocked) latestCompletionBlock = payload.completionBlocked;
    } else if (type === 'worker.result') {
      const artifacts = Array.isArray(event.artifactRefs) ? event.artifactRefs : [];
      const verification = Array.isArray(payload.verification) ? payload.verification : [];
      const changedFiles = Array.isArray(payload.changedFiles) ? payload.changedFiles : [];
      latestWorkerEvent = event;
      latestWorkerStatus = String(payload.status || '');
      latestWorkerEvidenceCount = artifacts.length;
      latestWorkerCheckCount = verification.length;
      latestWorkerChangedFileCount = changedFiles.length;
      workerResultCount += 1;
      workerEvidenceCount += artifacts.length;
      workerCheckCount += verification.length;
      workerChangedFileCount += changedFiles.length;
      if (String(payload.status || '').toLowerCase() === 'blocked') latestBlockedWorkerEvent = event;
    } else if (type === 'node.completed') {
      nodeCompletedCount += 1;
      if (
        payload.nodeType === 'orpad.artifactContract'
        && ((Number(payload.missingArtifactCount) || 0) > 0 || (Number(payload.missingQueueCount) || 0) > 0)
      ) {
        latestPartialArtifactContract = event;
      }
    } else if (type === 'adapter.model.downgraded') {
      modelDowngradeCount += 1;
    }
  }
  const directInventory = record?.finalization?.inventory || record?.resume?.inventory || record?.inventory || null;
  const queueInventoryFromEvents = machineQueueInventoryFromItemStates(queueItemStates);
  const queueInventory = latestSummaryInventory?.counts
    ? latestSummaryInventory
    : (latestStatusInventory?.counts
      ? latestStatusInventory
      : (directInventory?.counts ? directInventory : queueInventoryFromEvents));
  const rejectableItems = [];
  for (const [itemId, state] of queueItemStates) {
    if (['queued', 'candidate', 'blocked'].includes(state)) rejectableItems.push({ itemId, state });
  }
  if (!latestCompletionBlock) latestCompletionBlock = record?.runState?.completionBlocked || null;
  const projection = {
    eventCount: events.length,
    lastSequence: Number(events[events.length - 1]?.sequence) || 0,
    queueItemStates,
    queueUpdateCount,
    queueInventory,
    queueInventoryFromEvents,
    rejectableItems,
    recentEvents: events.slice(-100),
    latestWorkerEvent,
    latestBlockedWorkerEvent,
    latestBlockedQueueTransitionEvent,
    latestPartialArtifactContract,
    latestCompletionBlock,
    workerResultCount,
    workerEvidenceCount,
    workerCheckCount,
    workerChangedFileCount,
    latestWorkerStatus,
    latestWorkerEvidenceCount,
    latestWorkerCheckCount,
    latestWorkerChangedFileCount,
    nodeCompletedCount,
    nodeCompletionDetails: nodeCompletedCount ? `${machineCountLabel(nodeCompletedCount, 'step')} completed` : 'No steps completed yet',
    modelDowngradeCount,
  };
  projection.workerProofDetails = machineWorkerProofDetailsFromProjection(projection);
  return projection;
}

function machineLatestRunEventProjection(record) {
  if (!record) return machineBuildLatestRunEventProjection(record);
  const scope = machineLatestRunEventProjectionScope(record);
  const cacheKey = machineLatestRunEventProjectionKey(record);
  if (scope && cacheKey) {
    const cached = machineLatestRunEventProjectionCache.get(scope);
    if (cached?.cacheKey === cacheKey) {
      machineLatestRunEventProjectionCache.delete(scope);
      machineLatestRunEventProjectionCache.set(scope, cached);
      return cached.projection;
    }
  }
  const projection = machineBuildLatestRunEventProjection(record);
  if (scope && cacheKey) {
    machineLatestRunEventProjectionCache.set(scope, { cacheKey, projection });
    while (machineLatestRunEventProjectionCache.size > MACHINE_LATEST_RUN_EVENT_PROJECTION_CACHE_LIMIT) {
      const oldest = machineLatestRunEventProjectionCache.keys().next().value;
      machineLatestRunEventProjectionCache.delete(oldest);
    }
  }
  return projection;
}
// Breakpoints -Phase 3.7:
//   per-pipeline (NOT per-run) Set<nodePath>. Persists across runs in
//   localStorage so the user does not have to re-mark them each time.
//   These are renderer-only visual markers + pre-run confirmation - the dispatcher does not halt automatically. A "Bypass once" toggle
//   lets Continue dispatch despite an active breakpoint.
const MACHINE_BREAKPOINTS_STORAGE_PREFIX = 'orpad-machine-breakpoints:';
// History-inspection cache is separate from the active run cache so that
// "user clicked an old run in History" does NOT pollute the Pipeline
// setup panel's banner / failure cards. To bring an inspected run into
// the active panel the user must explicitly press Recover, which calls
// resumeRun and transfers the snapshot via adoptInspectedRunAsActive.
const machineHistoryInspectionCache = new Map();
// Tracks the (runbookKey:runId) pairs currently mid-Recover so the
// History detail can show a spinner instead of the default Recover
// button. Cleared synchronously in finally.
const machineHistoryRecoverPending = new Set();
const machineRunStartPendingPaths = new Set();
const machineRunPendingActions = new Map();
const machineRunProgressTimers = new Map();
// PUSH STREAM: state for the main->renderer per-step progress subscription. The
// push is a nudge to refresh the live surface immediately during a long drive;
// refreshes are coalesced so a burst of fast steps can't hammer getRun.
const machineRunProgressRefreshState = new Map();
// Per-run promise chain so a push-triggered refresh and a poll-tick refresh for
// the same run never interleave (which could render an older snapshot after a
// newer one). Both paths go through serializedMachineRunRefresh.
const machineRunRefreshChains = new Map();
const MACHINE_RUN_PROGRESS_REFRESH_MS = 400;
const machineRunExternalResearchDecisions = new Map();
const deferredPipelinePreviewRefreshPaths = new Set();
const pipelineHarnessImplementedAtCache = new Map();
const pipelineHarnessAuthoringBadgeCache = new Map();
const pipelineHarnessImplementationStatusCache = new Map();
const pipelineHarnessImplementationPendingPaths = new Set();
const pipelineHarnessRequiredBeforeRunCache = new Set();
const machinePatchReviewShown = new Set();
const ORCHESTRATION_REFRESH_DEFER_MS = 650;
const ORCHESTRATION_REFRESH_FLUSH_RETRY_MS = 250;
let lastMachineRunRecord = null;
let machineRuntimeStatus = null;
let machineRuntimeStatusLoading = false;
let orchestrationUiActivePointers = 0;
let orchestrationUiDeferUntil = 0;
let orchestrationUiFlushTimer = 0;
let deferredRunbooksPanelRefresh = false;
const orchestrationPersistedUiState = { scroll: new Map(), details: new Map() };
let gitRepoState = { isRepo: false, statuses: new Map(), branch: null, ahead: null, behind: null, slow: false };
let gitStatusTimer = null;
let gitRefreshToken = 0;
let gitHunkTimer = null;
let snippetsRefreshTimer = null;
let userSnippetsPath = null;
let userSnippetsSource = 'none';

function elementFromEventTarget(target) {
  if (!target) return null;
  if (target.nodeType === Node.ELEMENT_NODE) return target;
  return target.parentElement || null;
}

function isOrchestrationPreviewVisible() {
  return !!contentEl?.classList?.contains('view-orch-tree')
    || !!contentEl?.classList?.contains('view-orch-graph')
    || !!contentEl?.classList?.contains('view-orch-pipeline');
}

function orchestrationRefreshSurfaceFromTarget(target) {
  const el = elementFromEventTarget(target);
  if (!el) return null;
  const direct = el.closest?.(
    '.orch-preview, .orch-floating-inspector, .orch-inspector, '
    + '[data-runbook-run-details], [data-runbook-replay-events], '
    + '.runbook-machine-history, #runbooks-content, #orchestration-runbar-slot',
  );
  if (direct) return direct;
  if (isOrchestrationPreviewVisible() && contentEl?.contains(el)) return contentEl;
  return null;
}

function selectionTouchesOrchestrationRefreshSurface() {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  if (orchestrationRefreshSurfaceFromTarget(selection.anchorNode)) return true;
  if (orchestrationRefreshSurfaceFromTarget(selection.focusNode)) return true;
  for (let i = 0; i < selection.rangeCount; i += 1) {
    if (orchestrationRefreshSurfaceFromTarget(selection.getRangeAt(i).commonAncestorContainer)) return true;
  }
  return false;
}

function markOrchestrationUiInteraction(durationMs = ORCHESTRATION_REFRESH_DEFER_MS) {
  orchestrationUiDeferUntil = Math.max(orchestrationUiDeferUntil, Date.now() + durationMs);
}

function shouldDeferOrchestrationRefresh() {
  if (orchestrationUiActivePointers > 0) return true;
  if (Date.now() < orchestrationUiDeferUntil) return true;
  if (selectionTouchesOrchestrationRefreshSurface()) return true;
  return false;
}

function scheduleDeferredOrchestrationRefreshFlush(delayMs = ORCHESTRATION_REFRESH_FLUSH_RETRY_MS) {
  if (orchestrationUiFlushTimer) clearTimeout(orchestrationUiFlushTimer);
  orchestrationUiFlushTimer = setTimeout(() => {
    orchestrationUiFlushTimer = 0;
    flushDeferredOrchestrationRefreshes();
  }, Math.max(0, delayMs));
}

function deferRunbooksPanelRefresh() {
  deferredRunbooksPanelRefresh = true;
  scheduleDeferredOrchestrationRefreshFlush();
}

function deferPipelinePreviewRefresh(runbookPath) {
  if (runbookPath) deferredPipelinePreviewRefreshPaths.add(runbookNormalizePath(runbookPath));
  scheduleDeferredOrchestrationRefreshFlush();
}

function flushDeferredOrchestrationRefreshes() {
  if (!deferredRunbooksPanelRefresh && deferredPipelinePreviewRefreshPaths.size === 0) return;
  if (shouldDeferOrchestrationRefresh()) {
    const retryDelay = Math.max(ORCHESTRATION_REFRESH_FLUSH_RETRY_MS, orchestrationUiDeferUntil - Date.now() + 50);
    scheduleDeferredOrchestrationRefreshFlush(retryDelay);
    return;
  }
  const shouldRenderRunbooks = deferredRunbooksPanelRefresh;
  const previewPaths = [...deferredPipelinePreviewRefreshPaths];
  deferredRunbooksPanelRefresh = false;
  deferredPipelinePreviewRefreshPaths.clear();
  if (shouldRenderRunbooks) renderRunbooksPanel({ force: true });
  previewPaths.forEach(runbookPath => rerenderPipelinePreviewIfActive(runbookPath, { force: true }));
}

function orchestrationUiStateKey(el) {
  if (!el) return '';
  if (el.id === 'sidebar-runbooks') return 'scroll:sidebar-runbooks';
  if (el.id === 'runbooks-content') return 'scroll:runbooks-content';
  if (el.id === 'content') return `scroll:content:${getActiveTab()?.viewType || ''}`;
  if (el.matches?.('[data-runbook-replay-events]')) {
    return `scroll:replay-events:${el.dataset.path || ''}:${el.dataset.runId || ''}`;
  }
  if (el.matches?.('[data-runbook-run-details]')) {
    return `details:run:${el.dataset.path || ''}:${el.dataset.runId || ''}`;
  }
  if (el.matches?.('[data-orch-inspector-runtime]')) {
    return `details:orch-runtime:${el.dataset.nodePath || selectedOrchNodePath || selectedOrchEdgeId || ''}`;
  }
  if (el.matches?.('.orch-floating-inspector')) {
    return `scroll:orch-floating-inspector:${selectedOrchEdgeId || selectedOrchNodePath || ''}`;
  }
  if (el.matches?.('.orch-inspector')) {
    return `scroll:orch-inspector:${selectedOrchEdgeId || selectedOrchNodePath || ''}`;
  }
  return '';
}

function captureOrchestrationUiState() {
  const scroll = new Map();
  const details = new Map();
  const addScrollable = (el) => {
    const key = orchestrationUiStateKey(el);
    if (!key || scroll.has(key)) return;
    scroll.set(key, {
      top: el.scrollTop || 0,
      left: el.scrollLeft || 0,
      atBottom: (el.scrollHeight || 0) - (el.clientHeight || 0) - (el.scrollTop || 0) <= 8,
      path: el.dataset?.path || '',
      runId: el.dataset?.runId || '',
    });
  };
  const addDetails = (el) => {
    const key = orchestrationUiStateKey(el);
    if (!key || details.has(key)) return;
    details.set(key, !!el.open);
  };
  [
    document.getElementById('sidebar-runbooks'),
    runbooksContentEl,
    contentEl,
  ].filter(Boolean).forEach(addScrollable);
  document.querySelectorAll([
    '[data-runbook-replay-events]',
    '.orch-floating-inspector',
    '.orch-inspector',
  ].join(',')).forEach(addScrollable);
  document.querySelectorAll([
    '[data-runbook-run-details]',
    '[data-orch-inspector-runtime]',
  ].join(',')).forEach(addDetails);
  return { scroll, details };
}

function cloneOrchestrationUiState(state) {
  const scroll = new Map();
  const details = new Map();
  if (state?.scroll) {
    state.scroll.forEach((value, key) => {
      scroll.set(key, { ...value });
    });
  }
  if (state?.details) {
    state.details.forEach((value, key) => {
      details.set(key, value);
    });
  }
  return { scroll, details };
}

function mergeOrchestrationUiState(state) {
  if (!state) return;
  state.scroll?.forEach((value, key) => {
    orchestrationPersistedUiState.scroll.set(key, { ...value });
  });
  state.details?.forEach((value, key) => {
    orchestrationPersistedUiState.details.set(key, value);
  });
}

function restoreOrchestrationUiState(state) {
  if (!state) return;
  document.querySelectorAll([
    '[data-runbook-run-details]',
    '[data-orch-inspector-runtime]',
  ].join(',')).forEach(el => {
    const key = orchestrationUiStateKey(el);
    if (key && state.details.has(key)) el.open = state.details.get(key);
  });
  const restoreScrollable = (el) => {
    const key = orchestrationUiStateKey(el);
    const saved = key ? state.scroll.get(key) : null;
    if (!saved) return;
    const previousScrollBehavior = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';
    if (el.matches?.('[data-runbook-replay-events]') && isReplayStickEnabled(saved.path, saved.runId) && saved.atBottom) {
      el.scrollTop = el.scrollHeight;
    } else {
      const maxTop = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
      el.scrollTop = Math.min(saved.top, maxTop);
    }
    el.scrollLeft = saved.left;
    if (previousScrollBehavior) el.style.scrollBehavior = previousScrollBehavior;
    else el.style.removeProperty('scroll-behavior');
  };
  [
    document.getElementById('sidebar-runbooks'),
    runbooksContentEl,
    contentEl,
  ].filter(Boolean).forEach(restoreScrollable);
  document.querySelectorAll([
    '[data-runbook-replay-events]',
    '.orch-floating-inspector',
    '.orch-inspector',
  ].join(',')).forEach(restoreScrollable);
}

// Focus survives the run-bar/graph rebuild. The innerHTML swap (and the 2s poll
// that re-renders) otherwise dumps a keyboard user's focus back to <body> mid-
// supervision — and the Pause control morphs into Resume, so we restore by
// control ROLE + container rather than the exact element, mapping Pause->Resume.
function captureOrchestrationFocusKey() {
  const el = document.activeElement;
  if (!el || el === document.body || typeof el.matches !== 'function') return null;
  if (el.closest('.orch-graph-run-controls') && el.matches('[data-graph-run-action]')) {
    return { kind: 'graph-control' };
  }
  if (el.closest('.pipeline-runbar-actions')) {
    if (el.matches('.pipeline-run-control')) return { kind: 'runbar-toggle' };
    if (el.matches('.pipeline-run-primary')) return { kind: 'runbar-primary' };
  }
  return null;
}

function restoreOrchestrationFocusKey(key) {
  if (!key) return;
  let target = null;
  if (key.kind === 'graph-control') {
    target = contentEl?.querySelector('.orch-graph-run-controls [data-graph-run-action]:not([disabled])')
      || contentEl?.querySelector('.orch-graph-run-controls [data-graph-run-action]');
  } else if (key.kind === 'runbar-toggle') {
    target = document.querySelector('.pipeline-runbar-actions .pipeline-run-control');
  } else if (key.kind === 'runbar-primary') {
    target = document.querySelector('.pipeline-runbar-actions .pipeline-run-primary');
  }
  if (target && typeof target.focus === 'function') {
    try { target.focus({ preventScroll: true }); } catch { target.focus(); }
  }
}

function withOrchestrationUiStatePreserved(renderFn) {
  mergeOrchestrationUiState(captureOrchestrationUiState());
  const state = cloneOrchestrationUiState(orchestrationPersistedUiState);
  const focusKey = captureOrchestrationFocusKey();
  try {
    return renderFn();
  } finally {
    restoreOrchestrationUiState(state);
    restoreOrchestrationFocusKey(focusKey);
    mergeOrchestrationUiState(captureOrchestrationUiState());
  }
}

document.addEventListener('pointerdown', (event) => {
  if (!orchestrationRefreshSurfaceFromTarget(event.target)) return;
  orchestrationUiActivePointers += 1;
  markOrchestrationUiInteraction();
}, true);

['pointerup', 'pointercancel'].forEach(type => {
  document.addEventListener(type, () => {
    if (orchestrationUiActivePointers > 0) orchestrationUiActivePointers -= 1;
    markOrchestrationUiInteraction(250);
    scheduleDeferredOrchestrationRefreshFlush();
  }, true);
});

window.addEventListener('blur', () => {
  orchestrationUiActivePointers = 0;
  markOrchestrationUiInteraction(250);
  scheduleDeferredOrchestrationRefreshFlush();
});

document.addEventListener('scroll', (event) => {
  if (!orchestrationRefreshSurfaceFromTarget(event.target)) return;
  markOrchestrationUiInteraction(450);
  scheduleDeferredOrchestrationRefreshFlush(500);
}, true);

document.addEventListener('toggle', (event) => {
  const el = elementFromEventTarget(event.target);
  if (!el?.matches?.('[data-runbook-run-details], [data-orch-inspector-runtime]')) return;
  const key = orchestrationUiStateKey(el);
  if (key) orchestrationPersistedUiState.details.set(key, !!el.open);
  markOrchestrationUiInteraction(250);
  scheduleDeferredOrchestrationRefreshFlush(250);
}, true);

document.addEventListener('wheel', (event) => {
  if (!orchestrationRefreshSurfaceFromTarget(event.target)) return;
  markOrchestrationUiInteraction();
}, { capture: true, passive: true });

document.addEventListener('selectionchange', () => {
  scheduleDeferredOrchestrationRefreshFlush(300);
});

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
  refreshVisibleMermaidTheme();
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
  refreshVisibleMermaidTheme();
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
  // Legacy OrPAD orchestration artifacts (.or-graph/.or-tree/.or-pipeline/.orch*)
  // open as read-only JSON after the static-graph editor was removed in the G2
  // rebuild; the new surface is the live-trace Run view.
  if (/\.or-pipeline$/.test(name)) return 'json';
  if (/\.or-graph$/.test(name)) return 'json';
  if (/\.or-tree$/.test(name)) return 'json';
  if (/\.(or-rule|or-run)$/.test(name)) return 'json';
  if (/\.orch-graph\.json$/.test(name)) return 'json';
  if (/\.orch-tree\.json$/.test(name)) return 'json';
  if (/\.orch$/.test(name)) return 'json';
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
  const codeLanguage = getCodeLanguageDescription(filePath);
  if (codeLanguage) return codeViewTypeForLanguage(codeLanguage.name);
  return 'plain';
}

function getLangExtension(viewType, filePath = '') {
  switch (viewType) {
    case 'markdown':
    case 'mermaid':
      return markdown({ base: markdownLanguage, codeLanguages: languages });
    case 'orch-pipeline':
    case 'orch-graph':
    case 'orch-tree':
    case 'json':
    case 'jsonl':
      return json();
    case 'yaml': return yaml();
    case 'xml':  return xml();
    case 'html': return htmlLang();
    default: {
      const codeLanguage = getCodeLanguageDescription(filePath, viewType);
      return codeLanguage?.support || null;
    }
  }
}

function viewTypeDisplayLabel(viewType) {
  if (String(viewType || '').startsWith('code-')) {
    return codeLanguageNameForViewType(viewType) || 'Code';
  }
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

const PLAIN_TEXT_EXTS = new Set(['txt', 'text', 'log']);
const CODE_LANGUAGE_EXT_ALIASES = new Map([
  ['bash', 'shell'],
  ['ksh', 'shell'],
  ['sh', 'shell'],
  ['zsh', 'shell'],
]);
const codeViewTypeLanguages = new Map();

function fileBaseName(filePath) {
  return String(filePath || '').split(/[\\/]/).pop() || String(filePath || '');
}

function fileExtension(filePath) {
  const name = fileBaseName(filePath).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1);
}

function codeViewTypeForLanguage(languageName) {
  const slug = String(languageName || 'code')
    .toLowerCase()
    .replace(/\+/g, 'p')
    .replace(/#/g, 'sharp')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'code';
  const viewType = `code-${slug}`;
  codeViewTypeLanguages.set(viewType, languageName);
  return viewType;
}

function codeLanguageNameForViewType(viewType) {
  const raw = String(viewType || '');
  if (!raw.startsWith('code-')) return '';
  return codeViewTypeLanguages.get(raw) || raw.slice(5).replace(/-/g, ' ');
}

function getCodeLanguageDescription(filePath, viewType = '') {
  const viewLanguage = codeLanguageNameForViewType(viewType);
  if (viewLanguage) {
    const byViewType = LanguageDescription.matchLanguageName(languages, viewLanguage, false);
    if (byViewType) return byViewType;
  }

  const base = fileBaseName(filePath);
  if (!base) return null;
  const ext = fileExtension(base);
  if (PLAIN_TEXT_EXTS.has(ext)) return null;

  const alias = CODE_LANGUAGE_EXT_ALIASES.get(ext);
  if (alias) {
    const byAlias = LanguageDescription.matchLanguageName(languages, alias, false);
    if (byAlias) return byAlias;
  }

  return LanguageDescription.matchFilename(languages, base)
    || LanguageDescription.matchFilename(languages, base.toLowerCase());
}

function isSupportedFormat(filename) {
  const name = (filename || '').toLowerCase();
  const m = name.match(/\.([^./\\]+)$/);
  const ext = m ? m[1] : '';
  if (!ext) return true; // no extension - Dockerfile, Makefile, dotfiles, etc.
  return !BINARY_EXTS.has(ext);
}

// ==================== CodeMirror Editor ====================
const languageCompartment = new Compartment();
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

function createEditorState(content, viewType = 'markdown', filePath = '') {
  const langExt = getLangExtension(viewType, filePath);
  return EditorState.create({
    doc: content,
    extensions: [
      basicSetup,
      syntaxHighlighting(classHighlighter),
      languageCompartment.of(langExt || []),
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
  state: createEditorState('', 'plain'),
  parent: document.getElementById('editor'),
});
document.getElementById('editor').addEventListener('contextmenu', () => {
  if (getActiveTab()?.viewType === 'markdown') {
    window.dispatchEvent(new CustomEvent('orpad-ai-open-actions', { detail: { format: 'markdown', scope: getEditorSelectionText() ? 'selection' : 'document' } }));
  }
});

function tabLanguageLoadKey(tab) {
  return `${tab?.viewType || ''}:${tab?.filePath || tab?.title || ''}`;
}

function tabNeedsAsyncLanguage(tab) {
  const viewType = String(tab?.viewType || '');
  return viewType.startsWith('code-') || viewType === 'toml' || viewType === 'ini' || viewType === 'properties';
}

function applyTabLanguageSupport(tab, support) {
  if (!tab || !support) return;
  if (tab.id === activeTabId) {
    editor.dispatch({ effects: languageCompartment.reconfigure(support) });
    tab.editorState = editor.state;
    return;
  }
  if (tab.editorState) {
    tab.editorState = tab.editorState.update({
      effects: languageCompartment.reconfigure(support),
    }).state;
  }
}

function ensureTabLanguageLoaded(tab) {
  if (!tabNeedsAsyncLanguage(tab)) return;
  const codeLanguage = getCodeLanguageDescription(tab?.filePath || tab?.title || '', tab?.viewType || '');
  if (!codeLanguage || codeLanguage.support) return;
  const loadKey = tabLanguageLoadKey(tab);
  tab.pendingLanguageLoadKey = loadKey;
  codeLanguage.load()
    .then((support) => {
      if (tab.pendingLanguageLoadKey !== loadKey) return;
      applyTabLanguageSupport(tab, support);
    })
    .catch((err) => {
      console.warn('Failed to load editor language mode:', codeLanguage.name, err);
    });
}

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
  const editorState = restoreEditorSessionState(createEditorState(normContent, viewType, tabName), filePath);
  const scrollTop = getRestoredScrollTop(filePath);
  const tab = {
    id: 'tab-' + (++tabIdCounter),
    filePath: filePath || null,
    dirPath: dirPath || null,
    title: options.title || null,
    source: options.source || null,
    sourceUrl: options.sourceUrl || null,
    returnContext: normalizeTabReturnContext(options.returnContext),
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
  updateContextReturnBar();

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
  ensureTabLanguageLoaded(newTab);
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
    editor.setState(createEditorState('', 'plain'));
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
    document.title = 'OrPAD';
    window.orpad.setTitle('OrPAD');
    return;
  }
  const name = getTabDisplayName(tab);
  const sourceLabel = tab.source ? ' - Unsaved (from URL)' : '';
  const nextTitle = (tab.isModified ? '* ' : '') + name + ' - OrPAD';
  fileInfoEl.textContent = (tab.isModified ? '* ' : '') + name + sourceLabel;
  fileInfoEl.title = tab.sourceUrl || tab.filePath || '';
  renderTemplateStatusChip();
  document.title = nextTitle;
  window.orpad.setTitle(nextTitle);
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
  tab.editorState = createEditorState(file.content || '', tab.viewType, tab.title);
  tab.isModified = true;
  editor.setState(tab.editorState);
  ensureTabLanguageLoaded(tab);
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
let selectedOrchNodePath = '';
let selectedOrchEdgeId = '';
let orchGraphTool = 'select'; // 'select' | 'hand'
let orchGraphTemporaryTool = '';
let orchGraphViewport = { x: 0, y: 0, scale: 1 };
let orchGraphResizeFitRaf = 0;
let orchGraphResponsiveFitSuppressedUntil = 0;
let orchGridSnapEnabled = false;
let orchTempSnap = false;
let currentDiffPanel = null; // { el, recompute } - valid while diff panel is mounted
// Set when the left diff textarea echoes into CodeMirror - the debounced renderPreview
// would otherwise trigger a second recompute for the same keystroke.
let suppressNextDiffRecompute = false;
const LEGACY_MMD_THEME_STORAGE_KEY = 'orpad-mmd-theme';

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
  'Timeout', 'Retry', 'Catch', 'CrossCheck', 'Decorator', 'Action', 'Skill', 'Planner', 'OrchTree',
];
const ORCH_GRAPH_NODE_TYPES = [
  'orpad.entry', 'orpad.context', 'orpad.gate', 'orpad.selector', 'orpad.skill', 'orpad.tree', 'orpad.graph',
  'orpad.rule', 'orpad.artifactContract', 'orpad.patchReview', 'orpad.exit', 'orpad.probe', 'orpad.workQueue',
  'orpad.triage', 'orpad.dispatcher', 'orpad.workerLoop', 'orpad.barrier', 'orpad.provision',
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
  'orpad.provision': 'Provision',
  State: 'Step',
  Tool: 'Tool',
  Human: 'Human',
  Wait: 'Wait',
  Decorator: 'Decorator',
  Action: 'Action',
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


function orchToolIcon(path) {
  // Decorative: the host button always carries an aria-label, so hide the glyph
  // from the accessibility tree and keep it out of the tab/focus order.
  return `<svg class="ogi" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
}

const ORCH_TOOL_ICON_SELECT = orchToolIcon('M3 3h10v10H3z');
const ORCH_TOOL_ICON_HAND = orchToolIcon('M8 3v10M3 8h10M5 5l3-3 3 3M5 11l3 3 3-3');
const ORCH_TOOL_ICON_SNAP = orchToolIcon('M4 4h8v8H4zM8 4v8M4 8h8');
const ORCH_TOOL_ICON_ZOOM_OUT = orchToolIcon('M4 8h8');
const ORCH_TOOL_ICON_ZOOM_IN = orchToolIcon('M4 8h8M8 4v8');
const ORCH_TOOL_ICON_FIT = orchToolIcon('M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3');
const ORCH_TOOL_ICON_UNDO = orchToolIcon('M6 4H3v3M3 4c2-2 6-2 8 .5 1.8 2.2.7 5.5-2.5 6.2');
const ORCH_TOOL_ICON_REDO = orchToolIcon('M10 4h3v3M13 4c-2-2-6-2-8 .5-1.8 2.2-.7 5.5 2.5 6.2');















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











function pipelineContextForPath(filePath = getActiveTab()?.filePath) {
  const normalized = runbookNormalizePath(filePath);
  if (workspacePath && !isPathInsideWorkspaceRoot(normalized, workspacePath)) return null;
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

function sameNormalizedRunbookPath(left, right) {
  const a = runbookNormalizePath(left).toLowerCase();
  const b = runbookNormalizePath(right).toLowerCase();
  return !!a && !!b && a === b;
}

function normalizeTabReturnContext(context) {
  if (!context || context === false || typeof context !== 'object') return null;
  const pipelinePath = normalizeRunbookFilePath(context.pipelinePath || '');
  if (!pipelinePath) return null;
  const graphPath = context.graphPath ? normalizeRunbookFilePath(context.graphPath) : '';
  return {
    kind: 'pipeline-flow',
    pipelinePath,
    graphPath,
    label: String(context.label || '').trim(),
    source: String(context.source || '').trim(),
  };
}

function pipelineReturnContextLabel(pipelinePath) {
  const item = runbookSummaryItemForPath(pipelinePath);
  if (item) return runbookListItemTitle(item);
  return runbookPipelineDisplayName(runbookDirname(pipelinePath).split('/').pop() || 'Pipeline');
}

function createPipelineReturnContext(runbookPath = selectedRunbookPath, options = {}) {
  const activeTab = getActiveTab();
  const activeContext = pipelineContextForPath(activeTab?.filePath);
  const pipelinePath = normalizeRunbookFilePath(
    runbookPath
      || activeTab?.returnContext?.pipelinePath
      || activeContext?.pipelinePath
      || selectedRunbookPath
      || '',
  );
  if (!pipelinePath) return null;
  const graphPath = options.graphPath
    ? normalizeRunbookFilePath(options.graphPath)
    : (activeContext?.isGraph && sameNormalizedRunbookPath(activeContext.pipelinePath, pipelinePath)
      ? activeContext.activePath
      : (activeTab?.returnContext?.graphPath || ''));
  return normalizeTabReturnContext({
    pipelinePath,
    graphPath,
    label: options.label || activeTab?.returnContext?.label || pipelineReturnContextLabel(pipelinePath),
    source: options.source || 'context-open',
  });
}

function returnContextForFileOpen(filePath, options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'returnContext')) {
    return normalizeTabReturnContext(options.returnContext);
  }
  const activeReturnContext = normalizeTabReturnContext(getActiveTab()?.returnContext);
  if (activeReturnContext) {
    const targetContext = pipelineContextForPath(filePath);
    if (
      targetContext?.isGraph
      && sameNormalizedRunbookPath(targetContext.pipelinePath, activeReturnContext.pipelinePath)
    ) {
      return null;
    }
    if (sameNormalizedRunbookPath(filePath, activeReturnContext.pipelinePath)) return null;
    return activeReturnContext;
  }
  const activeContext = pipelineContextForPath(getActiveTab()?.filePath);
  if (!activeContext?.pipelinePath) return null;
  const targetContext = pipelineContextForPath(filePath);
  if (
    targetContext?.isGraph
    && sameNormalizedRunbookPath(targetContext.pipelinePath, activeContext.pipelinePath)
  ) {
    return null;
  }
  if (!activeContext.isGraph && !activeContext.isManifest) return null;
  return createPipelineReturnContext(activeContext.pipelinePath, { source: 'open-file' });
}

function shouldShowTabReturnContext(tab = getActiveTab()) {
  const context = normalizeTabReturnContext(tab?.returnContext);
  if (!context) return false;
  if (tab?.filePath && context.graphPath && sameNormalizedRunbookPath(tab.filePath, context.graphPath)) return false;
  if (tab?.filePath && sameNormalizedRunbookPath(tab.filePath, context.pipelinePath)) return false;
  return true;
}

function updateContextReturnBar() {
  if (!contextReturnBarEl) return;
  const tab = getActiveTab();
  const context = normalizeTabReturnContext(tab?.returnContext);
  if (!shouldShowTabReturnContext(tab) || !context) {
    contextReturnBarEl.classList.add('hidden');
    contextReturnBarEl.innerHTML = '';
    return;
  }
  const label = context.label || pipelineReturnContextLabel(context.pipelinePath);
  const activeName = getTabDisplayName(tab);
  contextReturnBarEl.innerHTML = `
    <div class="context-return-bar-inner">
      <button class="context-return-primary" data-context-return-action="flow" title="Return to the graph editor for this pipeline.">${orchToolIcon('M3 8h9M7 4 3 8l4 4')}</button>
      <div class="context-return-text">
        <strong>${escapeHtml(label)}</strong>
        <span>Viewing ${escapeHtml(activeName)} from this pipeline</span>
      </div>
      <button data-context-return-action="details" title="Open the pipeline manifest details.">Details</button>
    </div>
  `;
  contextReturnBarEl.classList.remove('hidden');
}

async function openPipelineReturnTarget(context, action = 'flow') {
  const normalized = normalizeTabReturnContext(context);
  if (!normalized?.pipelinePath) return;
  selectedRunbookPath = normalized.pipelinePath;
  selectedRunbookValidation = getRunbookCache(runbookValidationCache, normalized.pipelinePath);
  lastRunRecord = getRunbookCache(runbookRecordCache, normalized.pipelinePath);
  lastMachineRunRecord = getRunbookCache(machineRunRecordCache, normalized.pipelinePath);
  renderRunbooksPanel();
  if (action === 'details') {
    await openFileInTab(normalized.pipelinePath, { returnContext: false });
  } else {
    await openPipelineEntryOrFile(normalized.pipelinePath, {
      returnContext: false,
      graphPath: normalized.graphPath,
    });
  }
  void validateSelectedRunbook(normalized.pipelinePath);
  void hydrateLatestMachineRunForSelection(normalized.pipelinePath);
}






















function machineQueueInventoryFromEvents(record) {
  return machineLatestRunEventProjection(record).queueInventoryFromEvents;
}


// STEER: per-item list of still-pending work items (queued/candidate/blocked) a
// human can reject mid-run. Derived from the same queue.transition replay as the
// counts, so it stays a projection of events (the source of truth).
















// Compact metrics for the sticky pipeline run-bar header. Returns
// { currentNode, progressLabel, progressTitle, elapsed, startedAt }
// derived from the active run record's events. Values default to ''
// when not applicable (no record, no started events, etc).



// Failure detection / artifact path helpers live in
// src/shared/orchestration/failure-summary.js so node tests can verify the
// same logic that renders here. Local thin wrappers stay for diff stability.









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


































































































// Loop-back arc amplitude: how far sideways (in px) the control point sits
// from the source/target column. Scales with the number of intermediate
// nodes the arc has to clear. Kept smaller than ORCH_NODE_WIDTH so the
// graph viewport doesn't have to grow much when a loop-back exists.
const ORCH_LOOPBACK_BASE_AMP = Math.round(ORCH_NODE_WIDTH * 0.55);
const ORCH_LOOPBACK_STEP_AMP = 32;


// Lane offset for an edge that is one of `total` siblings sharing a source.
// Spreads edges symmetrically around 0 so a 1-edge source stays centered and a
// 3-edge source gets [-1, 0, +1] * step. Used for fan-out (Pattern J) and
// fan-in to prevent overlapping curves.










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

function isActiveOrchPreviewTab() {
  const viewType = getActiveTab()?.viewType;
  return viewType === 'orch-pipeline' || viewType === 'orch-graph' || viewType === 'orch-tree';
}












function orchGraphFitRect(frame, frameRect) {
  const padding = 22;
  const fitRect = {
    left: padding,
    top: padding,
    right: Math.max(padding, frameRect.width - padding),
    bottom: Math.max(padding, frameRect.height - padding),
  };
  const reserveOverlay = (selector, edge) => {
    const overlay = frame.querySelector(selector);
    if (!overlay) return;
    const overlayStyle = getComputedStyle(overlay);
    const overlayRect = overlay.getBoundingClientRect();
    const visible = overlayStyle.display !== 'none'
      && overlayStyle.visibility !== 'hidden'
      && overlayRect.width > 0
      && overlayRect.height > 0;
    if (!visible) return;
    const overlapsFrame = overlayRect.left < frameRect.right
      && overlayRect.right > frameRect.left
      && overlayRect.top < frameRect.bottom
      && overlayRect.bottom > frameRect.top;
    if (!overlapsFrame) return;
    if (edge === 'top') {
      fitRect.top = Math.max(fitRect.top, overlayRect.bottom - frameRect.top + 12);
    } else if (edge === 'bottom') {
      fitRect.bottom = Math.max(fitRect.top, Math.min(fitRect.bottom, overlayRect.top - frameRect.top - 12));
    }
  };
  ['.orch-graph-tools', '.orch-graph-run-banner', '.orch-graph-run-controls'].forEach(selector => reserveOverlay(selector, 'top'));
  reserveOverlay('.orch-graph-legend', 'bottom');
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


function scheduleOrchGraphResponsiveFit(frame = contentEl.querySelector('[data-orch-frame]')) {
  if (!frame || !contentEl.querySelector('.orch-preview')) return;
  if (Date.now() < orchGraphResponsiveFitSuppressedUntil) return;
  if (orchGraphResizeFitRaf) cancelAnimationFrame(orchGraphResizeFitRaf);
  orchGraphResizeFitRaf = requestAnimationFrame(() => {
    orchGraphResizeFitRaf = 0;
    if (!isActiveOrchPreviewTab()) return;
    if (Date.now() < orchGraphResponsiveFitSuppressedUntil) return;
    const activeFrame = frame.isConnected ? frame : contentEl.querySelector('[data-orch-frame]');
    if (!activeFrame || !contentEl.contains(activeFrame)) return;
    fitOrchGraphToFrame(activeFrame);
  });
}




























































const NODE_PACK_MANAGER_DEFAULT_REGISTRY_SOURCE = 'https://raw.githubusercontent.com/OrPAD-Lab/orpad-registry/main/registry/packages.json';
const NODE_PACK_MANAGER_REGISTRY_SOURCE_KEY = 'orpad.nodePackRegistrySource';
const NODE_PACK_MANAGER_RECENT_REGISTRY_SOURCES_KEY = 'orpad.nodePackRegistryRecentSources';
const NODE_PACK_MANAGER_RECENT_REGISTRY_LIMIT = 5;

const NODE_PACK_MANAGER_CONFLICT_CODES = new Set([
  'NODE_PACK_DISCOVERY_DUPLICATE_ID',
  'NODE_PACK_TYPE_CONFLICT',
]);
const NODE_PACK_MANAGER_INVALID_CODES = new Set([
  'NODE_PACK_DISCOVERY_VALIDATION_FAILED',
]);
const NODE_PACK_MANAGER_HIGH_RISK_CODES = new Set([
  'NODE_PACK_HIGH_RISK_CAPABILITY_REVIEW_REQUIRED',
  'NODE_PACK_HIGH_RISK_CAPABILITY_REQUIRES_APPROVAL',
]);
const NODE_PACK_MANAGER_HIGH_RISK_CAPABILITIES = new Set([
  'use.credentials',
  'use.network',
  'call.aiProvider',
  'publish',
  'sign',
  'deploy',
  'mcp.tool.sideEffect',
  'terminal.execute',
  'filesystem.destructive',
  'git.destructive',
]);
const NODE_PACK_MANAGER_DETAIL_ORDER = [
  'rootKind',
  'root',
  'packId',
  'manifestPath',
  'keptManifestPath',
  'skippedManifestPath',
  'nodeType',
  'firstPackId',
  'firstManifestPath',
  'secondPackId',
  'secondManifestPath',
  'packPath',
  'path',
  'assetKind',
  'assetId',
  'capability',
  'required',
  'current',
  'expected',
  'actual',
  'valueType',
  'error',
];
const NODE_PACK_MANAGER_DETAIL_LABELS = {
  rootKind: 'Root kind',
  root: 'Root path',
  packId: 'Package id',
  manifestPath: 'Manifest path',
  keptManifestPath: 'Kept manifest',
  skippedManifestPath: 'Skipped manifest',
  nodeType: 'Node type',
  firstPackId: 'First package',
  firstManifestPath: 'First manifest',
  secondPackId: 'Second package',
  secondManifestPath: 'Second manifest',
  packPath: 'Package path',
  path: 'Path',
  assetKind: 'Asset kind',
  assetId: 'Asset id',
  capability: 'Capability',
  required: 'Required',
  current: 'Current',
  expected: 'Expected',
  actual: 'Actual',
  valueType: 'Value type',
  error: 'Error',
  packDiagnostics: 'Package diagnostics',
};



















































































































































const NODE_PACK_BROWSER_SAFE_RESOLUTION_STATES = new Set(['', 'resolved', 'valid', 'ok']);
const NODE_PACK_BROWSER_BLOCKING_STATUS_LABELS = new Set([
  'conflict',
  'invalid',
  'validation-error',
  'disabled',
  'incompatible',
  'capability-denied',
  'approval-required',
  'missing',
]);



























// Compact action row rendered inside a graph node when its runtime
// state is failed or blocked. The buttons mirror the right-click menu
// (Details / Prompt / Model) and add the machine-side Retry / Skip
// pair that used to live only in the run inspector. Always-visible so
// the user does not have to guess that those operations are hidden
// behind a context menu. Event delegation: `data-orch-action` buttons
// reuse the existing handler at the bottom of the graph rerender,
// `data-probe-action` buttons go through the global probe-action
// listener -both already know how to look up the node path / run id.

// Bucket a transition into a visual category so the user can read the graph
// at a glance: forward / loop-back / pass / fail / accepted / rejected /
// queue-not-empty / queue-empty / selector-branch / etc. Each category gets a
// distinct stroke colour + label colour via the .category-* CSS classes below.
// The legend in renderOrchGraphCanvas mirrors these categories so users can
// match colour -meaning without reading the JSON.

const ORCH_EDGE_CATEGORY_LABELS = Object.freeze({
  forward: { color: 'var(--orch-edge-forward, #6cb6ff)', label: 'forward' },
  branch: { color: 'var(--orch-edge-branch, #b48ead)', label: 'branch' },
  accept: { color: 'var(--orch-edge-accept, #9ece6a)', label: 'accept / pass' },
  reject: { color: 'var(--orch-edge-reject, #f7768e)', label: 'reject' },
  'queue-empty': { color: 'var(--orch-edge-queue-empty, #56c2c5)', label: 'queue empty' },
  'queue-not-empty': { color: 'var(--orch-edge-queue-loop, #e0af68)', label: 'queue drain loop' },
  'loop-back': { color: 'var(--orch-edge-loopback, #e0af68)', label: 'loop-back' },
  'loop-revise': { color: 'var(--orch-edge-loop-revise, #e0af68)', label: 'gate revise loop' },
  'loop-reject': { color: 'var(--orch-edge-loop-reject, #f7768e)', label: 'patch reject loop' },
  'loop-fail': { color: 'var(--orch-edge-loop-fail, #e88787)', label: 'check fail loop' },
});

// Codex 2026-05-15 cross-review (Top 5 fix #3): edge label placement
// pass. Previously labels were always pinned to the right of the control
// point with a fixed 10/14 px offset, which would happily sit on top of
// the next node in a tight column or overlap a sibling label on a
// parallel edge. We now try a small set of candidate offsets around the
// control point and pick the first that does not collide with any node
// rect or any label already placed in this render. Falls back to the
// original "right of control point" position when every candidate
// collides -better to draw a slightly overlapped label than to hide it.
const ORCH_LABEL_COLLISION_PAD = 4;





















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
function sidebarWidthStorageKey() {
  return IS_ORCHESTRATION_WINDOW ? 'orpad-orchestration-sidebar-width' : 'orpad-sidebar-width';
}

function sidebarUnitScale() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--us');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function sidebarWidthLimits() {
  const scale = sidebarUnitScale();
  const workspaceWidth = Math.max(0, workspaceEl?.getBoundingClientRect?.().width || window.innerWidth || 0);
  if (IS_ORCHESTRATION_WINDOW) {
    const min = 400 * scale;
    const reservedPreview = Math.max(320 * scale, workspaceWidth * 0.34);
    const maxByWorkspace = workspaceWidth > 0 ? Math.max(min, workspaceWidth - reservedPreview) : 760 * scale;
    return {
      min,
      max: Math.max(min, Math.min(760 * scale, maxByWorkspace)),
    };
  }
  return { min: 160 * scale, max: 500 * scale };
}

function clampSidebarWidth(width) {
  const { min, max } = sidebarWidthLimits();
  return Math.round(Math.max(min, Math.min(max, Number(width) || min)));
}

function applySidebarWidth(width, options = {}) {
  if (!sidebarEl) return;
  const nextWidth = clampSidebarWidth(width);
  sidebarEl.style.width = `${nextWidth}px`;
  sidebarEl.style.minWidth = `${nextWidth}px`;
  sidebarEl.style.flexBasis = IS_ORCHESTRATION_WINDOW ? `${nextWidth}px` : '';
  if (options.persist) localStorage.setItem(sidebarWidthStorageKey(), String(nextWidth));
}

function applyStoredSidebarWidth() {
  const savedWidth = Number.parseInt(localStorage.getItem(sidebarWidthStorageKey()) || '', 10);
  if (savedWidth > 0) applySidebarWidth(savedWidth);
}

function resetSidebarWidth() {
  sidebarEl.style.width = '';
  sidebarEl.style.minWidth = '';
  sidebarEl.style.flexBasis = '';
  localStorage.removeItem(sidebarWidthStorageKey());
}

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
  applyStoredSidebarWidth();

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

function isRunbooksPanelVisible() {
  return !!runbooksContentEl
    && sidebarVisible
    && sidebarActivePanel === 'runbooks'
    && !sidebarEl.classList.contains('hidden');
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
  if (IS_ORCHESTRATION_WINDOW && document.body.classList.contains('orchestration-rail-collapsed')) return;
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
  applySidebarWidth(e.clientX - rect.left);
});

document.addEventListener('mouseup', () => {
  if (sidebarDragging) {
    sidebarDragging = false;
    sidebarResizeEl.classList.remove('dragging');
    sidebarEl.style.transition = '';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    applySidebarWidth(sidebarEl.offsetWidth, { persist: true });
  }
});

sidebarResizeEl.addEventListener('dblclick', () => {
  resetSidebarWidth();
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
    tab.editorState = createEditorState(content, tab.viewType, tab.filePath || tab.title);
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

function clearWorkspacePipelineState() {
  selectedRunbookPath = null;
  selectedRunbookValidation = null;
  lastRunRecord = null;
  lastMachineRunRecord = null;
  clearMachineRunProgressState();
  runbookValidationCache.clear();
  runbookRecordCache.clear();
  machineRunRecordCache.clear();
  machineRunListCache.clear();
  machineHistoryInspectionCache.clear();
  machineHistoryRecoverPending.clear();
  machineRunHistoryFilter.clear();
  machineRunReplayPosition.clear();
  machineRunReplayStickRunIds.clear();
  lastReplayRenderedSequence.clear();
  machineRunStartPendingPaths.clear();
  machineRunPendingActions.clear();
  machineRunExternalResearchDecisions.clear();
  machineApprovalPromptSeen.clear();
  machineBlockedDecisionPromptSeen.clear();
  pipelineHarnessImplementedAtCache.clear();
  pipelineHarnessAuthoringBadgeCache.clear();
  pipelineHarnessImplementationStatusCache.clear();
  pipelineHarnessImplementationPendingPaths.clear();
  pipelineHarnessRequiredBeforeRunCache.clear();
  machinePatchReviewShown.clear();
}

function pruneOpenTabsOutsideWorkspace(rootPath) {
  if (!rootPath) return;
  syncActiveTabSnapshot();
  for (let i = tabs.length - 1; i >= 0; i -= 1) {
    const tab = tabs[i];
    if (!tab.filePath || isPathInsideWorkspaceRoot(tab.filePath, rootPath) || tab.isModified) continue;
    tabs.splice(i, 1);
  }

  const active = getActiveTab();
  const activeOutsideWorkspace = !!active?.filePath && !isPathInsideWorkspaceRoot(active.filePath, rootPath);
  if (!active || activeOutsideWorkspace) {
    const replacement = tabs.find(tab => !tab.filePath || isPathInsideWorkspaceRoot(tab.filePath, rootPath));
    if (replacement) {
      switchToTab(replacement.id);
      return;
    }
    activeTabId = null;
    createTab(null, null, '');
    return;
  }
  renderTabBar();
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
      tab.editorState = createEditorState(oldContent, tab.viewType, tab.filePath || tab.title);
    } else {
      const content = normalizeLineEndings(result.content);
      tab.lastSavedContent = content;
      tab.isModified = false;
      tab.editorState = createEditorState(content, tab.viewType, tab.filePath || tab.title);
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


function isPipelineGenerationRunning(state = pipelineGenerateState) {
  return ['queued', 'running', 'cancelling'].includes(String(state?.status || ''));
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

function isNestedWorkspacePipelinePackagePath(filePath) {
  const root = runbookNormalizePath(workspacePath).replace(/\/+$/, '').toLowerCase();
  const normalized = runbookNormalizePath(filePath).toLowerCase();
  if (!root || !normalized.startsWith(`${root}/`)) return false;
  const relative = normalized.slice(root.length + 1);
  return !relative.startsWith('.orpad/pipelines/')
    && relative.includes('/.orpad/pipelines/')
    && relative.endsWith('/pipeline.or-pipeline');
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

function orchestrationSelectedPipelineStorageKey() {
  if (!workspacePath) return '';
  return `${ORCHESTRATION_SELECTED_PIPELINE_STORAGE_PREFIX}${normalizeComparablePath(workspacePath)}`;
}

function rememberOrchestrationSelectedPipeline(runbookPath) {
  if (!IS_ORCHESTRATION_WINDOW || !runbookPath) return;
  const key = orchestrationSelectedPipelineStorageKey();
  if (key) localStorage.setItem(key, runbookNormalizePath(runbookPath));
}

function rememberedOrchestrationSelectedPipeline() {
  if (!IS_ORCHESTRATION_WINDOW) return '';
  const key = orchestrationSelectedPipelineStorageKey();
  return key ? runbookNormalizePath(localStorage.getItem(key) || '') : '';
}

function hasMachineRunRecordId(record) {
  return !!(record?.runState?.runId || record?.runId);
}

function machineLatestHydrationKey(runbookPath) {
  const normalizedWorkspace = normalizeComparablePath(workspacePath || '');
  const normalizedRunbook = runbookNormalizePath(runbookPath || '').toLowerCase();
  return normalizedWorkspace && normalizedRunbook ? `${normalizedWorkspace}::${normalizedRunbook}` : '';
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
      if (isNestedWorkspacePipelinePackagePath(file.path)) continue;
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
  if (!selectedRunbookPath && IS_ORCHESTRATION_WINDOW) {
    const remembered = rememberedOrchestrationSelectedPipeline();
    const rememberedKey = runbookNormalizePath(remembered).toLowerCase();
    const rememberedItem = rememberedKey
      ? runbooks.find(item => runbookNormalizePath(item.path).toLowerCase() === rememberedKey)
      : null;
    const firstPipeline = (summary.pipelines || [])[0]
      || runbooks.find(item => item.format === 'or-pipeline')
      || runbooks[0]
      || null;
    selectedRunbookPath = rememberedItem?.path || firstPipeline?.path || null;
    if (selectedRunbookPath) rememberOrchestrationSelectedPipeline(selectedRunbookPath);
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
    lastMachineRunRecord = null;
    if (IS_ORCHESTRATION_WINDOW) {
      const firstPipeline = (summary.pipelines || [])[0]
        || runbooks.find(item => item.format === 'or-pipeline')
        || runbooks[0]
        || null;
      selectedRunbookPath = firstPipeline?.path || null;
      if (selectedRunbookPath) rememberOrchestrationSelectedPipeline(selectedRunbookPath);
    }
  } else if (selectedRunbookPath) {
    rememberOrchestrationSelectedPipeline(selectedRunbookPath);
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




function isMachineCompatiblePipeline(validation) {
  return !!validation?.ok
    && validation.format === 'or-pipeline'
    && validation.canMachineExecute === true
    && !(validation.diagnostics || []).some(isDiagnosticError);
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








function machineWorkerStatusLabel(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'blocked') return 'review needed';
  if (value === 'done') return 'done';
  if (value === 'failed') return 'failed';
  return status || 'worker result';
}





const MACHINE_PATCH_DECISION_EVENT_TYPES = [
  'patch.applied',
  'patch.review_skipped',
  'patch.review_rejected',
  'patch.approved',
  'patch.apply_conflict',
  'patch.apply_failed',
];

const MACHINE_PATCH_RESOLVED_EVENT_TYPES = ['patch.applied', 'patch.review_skipped', 'patch.review_rejected'];

const MACHINE_PATCH_STATUS_BY_EVENT = {
  'patch.applied': 'applied',
  'patch.review_skipped': 'skipped',
  'patch.review_rejected': 'rejected',
  'patch.approved': 'approved',
  'patch.apply_conflict': 'conflict',
  'patch.apply_failed': 'failed',
};

















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



function machineStatusChipClass(status, kind = 'lifecycle') {
  const value = String(status || '').toLowerCase();
  if (['failed', 'cancelled', 'canceled', 'blocked'].includes(value)) return 'danger';
  if (['running', 'waiting', 'pending', 'partial', 'approval-required', 'approval_required'].includes(value)) return 'warn';
  if (['created', 'completed', 'done', 'success'].includes(value)) return 'good';
  return kind === 'summary' ? 'warn' : '';
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
































function machineRunActionKeyRunbookPart(key) {
  const index = String(key || '').lastIndexOf('::');
  return index >= 0 ? String(key).slice(0, index) : String(key || '');
}

function disposeMachineRunProgressRefreshStateByKey(key) {
  if (!key) return;
  const state = machineRunProgressRefreshState.get(key);
  if (state?.timer) clearTimeout(state.timer);
  machineRunProgressRefreshState.delete(key);
}

function stopMachineRunProgressPollingByKey(key) {
  if (!key) return;
  const timer = machineRunProgressTimers.get(key);
  if (timer) clearInterval(timer);
  machineRunProgressTimers.delete(key);
  disposeMachineRunProgressRefreshStateByKey(key);
}

function stopMachineRunProgressPollingForUnselectedRunbooks(selectedPath = selectedRunbookPath) {
  const selectedKey = runbookNormalizePath(selectedPath || '').toLowerCase();
  const keys = new Set([
    ...machineRunProgressTimers.keys(),
    ...machineRunProgressRefreshState.keys(),
  ]);
  for (const key of keys) {
    if (!selectedKey || machineRunActionKeyRunbookPart(key) !== selectedKey) {
      stopMachineRunProgressPollingByKey(key);
    }
  }
}

function clearMachineRunProgressState() {
  for (const key of [...machineRunProgressTimers.keys()]) {
    stopMachineRunProgressPollingByKey(key);
  }
  // PUSH STREAM: cancel any pending throttled-refresh timers (so a stale refresh
  // can't fire after teardown/navigation) and drop the per-run coalesce + chain
  // state so neither Map grows unbounded across runs/workspace switches.
  for (const state of machineRunProgressRefreshState.values()) {
    if (state?.timer) clearTimeout(state.timer);
  }
  machineRunProgressRefreshState.clear();
  machineRunRefreshChains.clear();
  machineRunStartPendingPaths.clear();
  machineRunPendingActions.clear();
}


// Synchronous mutation guard: held during any user-initiated lifecycle
// action (start / continue / resume / cancel / cancelClaim / approval).
// Lives in the renderer so a duplicate click can be rejected before the
// first `await` (the IPC mutex is the second line of defense). The
// visual side of the lock is the existing `previewRunInProgress` chrome
// plus a fresh toast on contention; the runtime side is a Set keyed by
// (runbookKey, runId|'__start__').
// Supervised-autonomy intent acks. Pause/resume are intent-then-ack (the run
// only reaches 'paused'/'running' at the driver's next step boundary, which can
// be a long worker step away), so — exactly like cancel — we record an
// optimistic "requested" flag synchronously on click and surface it until the
// durable lifecycle lands. Without this the click looks inert for seconds.












// The pause/resume "requested" flags are intent acks: a pause-pending only makes
// sense while the autonomous drive is still in flight and not yet paused (an
// autonomous run briefly flips running<->waiting between driver steps, so we key
// off the in-progress predicate, not the literal 'running' string), and a
// resume-pending only while still 'paused'. Once the durable lifecycle settles,
// the flag is stale — clear it so it never bleeds into a later state of the same
// runId. Idempotent and cheap; safe to call from the run-bar render path.








function harnessImplementationKey(runbookPath) {
  return runbookNormalizePath(runbookPath || '').toLowerCase();
}

function pipelineDocHarnessImplementedAt(pipelineDoc, runbookKey = '') {
  return pipelineDoc?.metadata?.harnessImplementation?.implementedAt
    || pipelineDoc?.harness?.implementedAt
    || (runbookKey ? pipelineHarnessImplementedAtCache.get(runbookKey) : '')
    || '';
}

function pipelineHarnessStatePath(runbookPath, pipelineDoc = {}) {
  const pipelineDir = runbookDirPath(runbookPath);
  const stateRef = String(
    pipelineDoc?.metadata?.harnessImplementation?.statePath
      || pipelineDoc?.harness?.implementationState
      || '',
  ).trim();
  const harnessRoot = String(pipelineDoc?.harness?.path || 'harness/generated').trim() || 'harness/generated';
  const ref = stateRef || `${harnessRoot.replace(/\/+$/, '')}/implementation-state.json`;
  const normalizedRef = runbookNormalizePath(ref);
  const absolute = /^[A-Za-z]:\//.test(normalizedRef) || normalizedRef.startsWith('/');
  return normalizeRunbookFilePath(absolute ? normalizedRef : `${pipelineDir}/${normalizedRef}`);
}

async function readPersistedHarnessImplementationState(runbookPath, pipelineDoc = {}) {
  const statePath = pipelineHarnessStatePath(runbookPath, pipelineDoc);
  if (!statePath) return null;
  try {
    const state = await readRendererJson(statePath);
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
    return state;
  } catch {
    return null;
  }
}

function pipelineDocHarnessAuthoringBadge(pipelineDoc, harnessImplementedAt = '', runbookKey = '') {
  if (!harnessImplementedAt) return null;
  const cached = runbookKey ? pipelineHarnessAuthoringBadgeCache.get(runbookKey) : null;
  const implementation = pipelineDoc?.metadata?.harnessImplementation || {};
  const mode = String(
    implementation.harnessAuthoringMode
      || pipelineDoc?.harness?.actualAuthoringMode
      || pipelineDoc?.harness?.authoringResultMode
      || cached?.mode
      || '',
  ).trim();
  const requestedMode = String(pipelineDoc?.harness?.authoringMode || '').trim();
  const error = String(
    implementation.harnessAuthoringError
      || pipelineDoc?.harness?.authoringError
      || cached?.error
      || '',
  ).trim();
  if (!mode && !error) return null;
  const title = [
    mode ? `Actual harness authoring: ${mode}` : '',
    requestedMode ? `Requested mode: ${requestedMode}` : '',
    error ? `Authoring error: ${error}` : '',
  ].filter(Boolean).join(' | ');
  let badge = null;
  if (mode === 'llm-authored-spec') {
    badge = { state: 'done', label: 'AI-authored', title };
  } else if (mode.includes('fallback') || error) {
    badge = { state: 'warn', label: 'Fallback harness', title };
  } else {
    badge = { state: 'done', label: mode, title };
  }
  if (runbookKey) pipelineHarnessAuthoringBadgeCache.set(runbookKey, { ...badge, mode, error, requestedMode });
  return badge;
}



async function refreshPipelineHarnessMetadataCache(runbookPath) {
  const key = harnessImplementationKey(runbookPath);
  if (!key) return;
  try {
    const doc = await readRendererJson(runbookPath);
    const state = await readPersistedHarnessImplementationState(runbookPath, doc);
    if (state) {
      pipelineHarnessImplementationStatusCache.set(key, state);
      const stateImplementedAt = String(state.implementedAt || '').trim();
      if (stateImplementedAt) pipelineHarnessImplementedAtCache.set(key, stateImplementedAt);
    }
    const implementedAt = pipelineDocHarnessImplementedAt(doc, key) || String(state?.implementedAt || '').trim();
    if (implementedAt) {
      pipelineHarnessImplementedAtCache.set(key, implementedAt);
      pipelineDocHarnessAuthoringBadge(doc, implementedAt, key);
    }
  } catch {
    // Cache refresh is best-effort; validation/rendering owns user-visible errors.
  }
}

































const MACHINE_QUEUE_TERMINAL_STATES = ['done', 'blocked', 'skipped', 'cancelled', 'partial'];
const MACHINE_PROGRESS_TERMINAL_STATES = ['completed', 'failed', 'blocked', 'skipped', 'cancelled'];





const MACHINE_PROGRESS_STEP_ORDER = { completed: 0, failed: 1, running: 2, queued: 3 };







// LangGraph Studio-style node inspector. When the user clicks a node in
// the graph (read-only run view), this renders the node's full machine
// runtime history: lifecycle events, attempt-grouped adapter calls,
// transcript / artifact links, and any error payload. Empty when the
// run does not yet have data for this node.





















// PUSH STREAM: refresh the live run surface, coalescing bursts of fast steps into
// at most one getRun per window. Decision prompts are suppressed because a push
// arrives WHILE the drive is still in flight — the execute response handles those
// once the drive returns; opening a modal mid-drive would be wrong.
// Is this run the one the user is currently viewing? Re-checked both when a nudge
// arrives AND just before a throttled refresh fires, because the user may navigate
// away during the throttle window (a stale refresh would render the wrong run).

// Serialize all refreshes for one run (push nudge + poll tick) through a promise
// chain so an older snapshot can never render after a newer one.



// Idempotent: wire the push subscription once, lazily, the first time a run begins
// polling. The poll remains the fallback/reconciler if the push is ever missed.









// Phase 3.8: history filter state. Per-runbook filter spec (status
// + free-text query) lets the user narrow a long History list. Default
// shows everything; chip + input both reset on Refresh runs.
const machineRunHistoryFilter = new Map();
const HISTORY_LIFECYCLE_FILTERS = Object.freeze([
  { id: 'all', label: 'All', match: () => true },
  { id: 'running', label: 'Live', match: r => ['running', 'cancelling', 'waiting', 'created', 'approval-required', 'paused'].includes(String(r.lifecycleStatus || '').toLowerCase()) },
  { id: 'completed', label: 'Done', match: r => String(r.lifecycleStatus || '').toLowerCase() === 'completed' && String(r.summaryStatus || '').toLowerCase() === 'done' },
  { id: 'partial', label: 'Partial', match: r => String(r.summaryStatus || '').toLowerCase() === 'partial' },
  { id: 'failed', label: 'Failed', match: r => String(r.lifecycleStatus || '').toLowerCase() === 'failed' },
  { id: 'cancelled', label: 'Cancelled', match: r => ['cancelled', 'canceled'].includes(String(r.lifecycleStatus || '').toLowerCase()) },
  { id: 'blocked', label: 'Blocked', match: r => String(r.summaryStatus || '').toLowerCase() === 'blocked' && !['cancelled', 'canceled', 'failed'].includes(String(r.lifecycleStatus || '').toLowerCase()) },
]);









// Read-only History inspection panel. Shown ONLY when the user has clicked
// a past run in the History strip. Does not let the user mutate the run
// directly -the only action is Recover, which transfers the snapshot to
// the active run cache and unlocks the existing Latest Run controls.

function renderRunbooksPanel(options = {}) {
  if (!runbooksContentEl) return;
  if (!isRunbooksPanelVisible()) {
    deferredRunbooksPanelRefresh = true;
    return;
  }
  if (!options.force && shouldDeferOrchestrationRefresh()) {
    deferRunbooksPanelRefresh();
    return;
  }
  deferredRunbooksPanelRefresh = false;
  return withOrchestrationUiStatePreserved(() => {
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
  stopMachineRunProgressPollingForUnselectedRunbooks(selected);
  const selectedRunRecord = lastRunRecord || getRunbookCache(runbookRecordCache, selected);
  const selectedMachineRunRecord = selected ? getActiveMachineRunRecord(selected) : null;
  const selectedMachineRunList = selected ? getRunbookCache(machineRunListCache, selected) : null;
  if (selected) {
    rememberOrchestrationSelectedPipeline(selected);
    const shouldHydrateLatestRun = !selectedMachineRunRecord
      && (!selectedMachineRunList
        || !Array.isArray(selectedMachineRunList.runs)
        || selectedMachineRunList.runs.length > 0);
    if (shouldHydrateLatestRun) void hydrateLatestMachineRunForSelection(selected);
  }
  const inspectedHistoryRecord = selected ? getHistoryInspectionRecord(selected) : null;
  const selectedKey = runbookNormalizePath(selected).toLowerCase();
  const generationRunning = isPipelineGenerationRunning();
  const workspaceMeta = [
    machineCountLabel(pipelineCount, 'pipeline'),
    legacyCount ? machineCountLabel(legacyCount, 'legacy flow') : '',
    machineCountLabel(summary.fileCount, 'file'),
  ].filter(Boolean);
  const pipelineListSection = IS_ORCHESTRATION_WINDOW ? '' : `
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
  `;
  runbooksContentEl.innerHTML = `
    <section class="runbook-panel-section">
      <div class="runbook-action-row">
        <button data-runbook-action="refresh">Refresh</button>
      </div>
      <div class="runbook-workspace-meta" data-runbook-workspace-meta title="${escapeHtml(runbookNormalizePath(workspacePath))}">
        <strong>${escapeHtml(runbookBaseName(workspacePath))}</strong>
        <span class="runbook-chip-row">
          ${workspaceMeta.map(item => `<span class="runbook-chip">${escapeHtml(item)}</span>`).join('')}
        </span>
      </div>
    </section>
    ${pipelineListSection}
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

  `;
  // Phase 1.2: stick the live event log to the bottom (auto-scroll on)
  // and snapshot the highest rendered sequence so the next render flags
  // only genuinely new events as fresh.
  applyReplayStickAfterRender();

  });
}

async function validateSelectedRunbook(runbookPath) {
  if (!runbookPath) return;
  const pipelineApi = window.orpad?.pipelines || window.orpad?.runbooks;
  selectedRunbookPath = runbookPath;
  rememberOrchestrationSelectedPipeline(runbookPath);
  selectedRunbookValidation = await pipelineApi.validateFile(runbookPath, { trustLevel: 'local-authored' });
  await refreshPipelineHarnessMetadataCache(runbookPath);
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

function rerenderPipelinePreviewIfActive(runbookPath, options = {}) {
  const context = pipelineContextForPath();
  if (!context?.pipelinePath || !runbookPath) return;
  if (runbookNormalizePath(context.pipelinePath).toLowerCase() !== runbookNormalizePath(runbookPath).toLowerCase()) return;
  if (!options.force && shouldDeferOrchestrationRefresh()) {
    deferPipelinePreviewRefresh(runbookPath);
    return;
  }
  invalidateRenderCache();
  if (getActiveTab()?.viewType === 'orch-pipeline' || getActiveTab()?.viewType === 'orch-graph') {
    withOrchestrationUiStatePreserved(() => renderPreview(editor.state.doc.toString()));
  }
}


const ADAPTER_PICKER_MUTATING_CHANNELS = new Set([
  'machine-set-provider-selection',
]);








const HARNESS_PROFILE_IGNORED_DIRS = new Set([
  '.git',
  '.orpad',
  '.vs',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'bin',
  'obj',
  'release',
  'playwright-report',
  'test-results',
]);
const HARNESS_PROFILE_MAX_FILES = 1500;



























async function openPipelineEntryOrFile(filePath, options = {}) {
  if (/\.or-pipeline$/i.test(filePath)) {
    try {
      const result = await window.orpad.readFile(filePath);
      const parsed = JSON.parse(result?.content || '{}');
      const entryGraph = parsed.entryGraph || parsed.entry?.graph || parsed.graph?.file || '';
      if (options.graphPath) {
        await openFileInTab(options.graphPath, options);
        return;
      }
      if (entryGraph) {
        const base = runbookDirname(filePath);
        await openFileInTab(normalizeRunbookFilePath(`${base}/${entryGraph}`), options);
        return;
      }
    } catch {
      // Fall through and open the manifest when the entrypoint cannot be read.
    }
  }
  await openFileInTab(filePath, options);
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
    renderRunbooksPanel({ force: true });
    return;
  }
  selectedRunbookPath = runbookPath;
  rememberOrchestrationSelectedPipeline(runbookPath);
  selectedRunbookValidation = getRunbookCache(runbookValidationCache, runbookPath);
  lastRunRecord = getRunbookCache(runbookRecordCache, runbookPath);
  lastMachineRunRecord = getRunbookCache(machineRunRecordCache, runbookPath);
  renderRunbooksPanel({ force: true });
  await openPipelineEntryOrFile(runbookPath);
  await validateSelectedRunbook(runbookPath);
  void hydrateLatestMachineRunForSelection(runbookPath);
}

async function hydrateLatestMachineRunForSelection(runbookPath) {
  if (!workspacePath || !runbookPath) return;
  if (!sameNormalizedRunbookPath(selectedRunbookPath, runbookPath)) return;
  const cached = getRunbookCache(machineRunRecordCache, runbookPath);
  if (hasMachineRunRecordId(cached)) {
    lastMachineRunRecord = cached;
    return;
  }
  const hydrationKey = machineLatestHydrationKey(runbookPath);
  if (!hydrationKey || machineLatestRunHydrationPending.has(hydrationKey)) return;
  machineLatestRunHydrationPending.add(hydrationKey);
  try {
    const record = await loadLatestMachineRunRecord(runbookPath);
    if (!record || !sameNormalizedRunbookPath(selectedRunbookPath, runbookPath)) return;
    lastMachineRunRecord = record;
    setRunbookCache(machineRunRecordCache, runbookPath, lastMachineRunRecord);
    renderRunbooksPanel();
    rerenderPipelinePreviewIfActive(runbookPath);
  } catch {
    // Latest run hydration is best-effort; failures stay silent so panel rendering proceeds.
  } finally {
    machineLatestRunHydrationPending.delete(hydrationKey);
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
  if (listed?.success) pruneMachineRunReplayTransientStateForRunList(runbookPath, runs);
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

// Phase 2.4: time travel state helpers. Replay position is a 1-based
// index into the run's events array. null/unset = live view.
function getReplayPosition(runbookPath, runId) {
  const key = machineRunTransientScopeKey(runbookPath, runId);
  if (!key) return null;
  const v = machineRunReplayPosition.get(key);
  return Number.isFinite(v) && v > 0 ? v : null;
}


function clearReplayPosition(runbookPath, runId) {
  const key = machineRunTransientScopeKey(runbookPath, runId);
  if (!key) return;
  machineRunReplayPosition.delete(key);
}

function machineRunTransientScopePrefix(runbookPath) {
  const normalizedRunbook = runbookNormalizePath(runbookPath || selectedRunbookPath || '').toLowerCase();
  if (!normalizedRunbook) return '';
  const normalizedWorkspace = normalizeComparablePath(workspacePath || '');
  return `${normalizedWorkspace}::${normalizedRunbook}::`;
}

function machineRunIdFromReplayTransientKey(key, scopePrefix) {
  const normalized = String(key || '');
  const scopedKey = normalized.startsWith('off:') ? normalized.slice(4) : normalized;
  return scopedKey.startsWith(scopePrefix) ? scopedKey.slice(scopePrefix.length) : '';
}


function machineRunVisibleTransientRunIds(runbookPath, options = {}) {
  const ids = new Set();
  const addRecord = (record) => {
    const runId = String(record?.runState?.runId || record?.runId || '').trim();
    if (runId) ids.add(runId);
  };
  addRecord(getRunbookCache(machineRunRecordCache, runbookPath));
  const selectedMatches = runbookPath
    && selectedRunbookPath
    && runbookNormalizePath(selectedRunbookPath).toLowerCase() === runbookNormalizePath(runbookPath).toLowerCase();
  if (selectedMatches) addRecord(lastMachineRunRecord);
  if (options.includeHistoryInspection !== false) addRecord(getHistoryInspectionRecord(runbookPath));
  return ids;
}


function pruneMachineRunReplayTransientState(runbookPath, retainedRunIds) {
  const scopePrefix = machineRunTransientScopePrefix(runbookPath);
  if (!scopePrefix) return;
  const retained = new Set([...(retainedRunIds || [])].map(runId => String(runId || '').trim()).filter(Boolean));
  const shouldPrune = key => {
    const runId = machineRunIdFromReplayTransientKey(key, scopePrefix);
    return runId && !retained.has(runId);
  };
  for (const key of [...machineRunReplayPosition.keys()]) {
    if (shouldPrune(key)) machineRunReplayPosition.delete(key);
  }
  for (const key of [...lastReplayRenderedSequence.keys()]) {
    if (shouldPrune(key)) lastReplayRenderedSequence.delete(key);
  }
  for (const key of [...machineRunReplayStickRunIds]) {
    if (shouldPrune(key)) machineRunReplayStickRunIds.delete(key);
  }
}

function pruneMachineRunReplayTransientStateForRunList(runbookPath, runs) {
  const retained = new Set();
  for (const run of runs || []) {
    const runId = String(run?.runId || run?.runState?.runId || run || '').trim();
    if (runId) retained.add(runId);
  }
  for (const runId of machineRunVisibleTransientRunIds(runbookPath, { includeHistoryInspection: false })) retained.add(runId);
  pruneMachineRunReplayTransientState(runbookPath, retained);
}


function machineReplayRunStateFromEvents(record, events) {
  const base = record?.runState || {};
  const runId = base.runId || record?.runId || '';
  const next = {
    ...base,
    runId,
    lifecycleStatus: 'created',
    summaryStatus: 'pending',
  };
  for (const event of events || []) {
    const payload = event?.payload || {};
    if (event?.eventType === 'run.created') {
      next.lifecycleStatus = payload.lifecycleStatus || event.lifecycleStatus || 'created';
      next.createdAt = event.timestamp || next.createdAt;
      next.updatedAt = event.timestamp || next.updatedAt;
    } else if (event?.eventType === 'run.status') {
      const status = event.toState || payload.toState || payload.lifecycleStatus || payload.status;
      if (status) next.lifecycleStatus = status;
      next.updatedAt = event.timestamp || next.updatedAt;
    } else if (event?.eventType === 'run.summary') {
      const status = payload.summaryStatus || event.summaryStatus || payload.toState || event.toState || payload.status;
      if (status) next.summaryStatus = status;
      next.updatedAt = event.timestamp || next.updatedAt;
    }
  }
  if (!next.createdAt) next.createdAt = base.createdAt || record?.createdAt || '';
  if (!next.updatedAt) next.updatedAt = base.updatedAt || record?.updatedAt || next.createdAt || '';
  return next;
}

// Apply replay snapshot if a position is set for this record's runId.
// Returns a new record with events truncated to events[0..position-1].
// Other fields are passed through unchanged -the recompute happens in
// the renderers (lifecycle banner / runtime projection / etc) which
// derive from events.
function applyReplaySnapshot(record, runbookPath = selectedRunbookPath) {
  if (!record) return record;
  const runId = record.runState?.runId || record.runId || '';
  const position = getReplayPosition(runbookPath, runId);
  if (position == null) return record;
  const events = Array.isArray(record.events) ? record.events : [];
  if (position >= events.length) {
    clearReplayPosition(runbookPath, runId);
    return record;
  }
  const truncated = events.slice(0, position);
  return {
    ...record,
    events: truncated,
    runState: machineReplayRunStateFromEvents(record, truncated),
    activeClaims: [],
    activeWriteSets: [],
    approvals: undefined,
    candidateInventory: undefined,
    exported: null,
    finalization: undefined,
    inventory: machineQueueInventoryFromEvents({ events: truncated }),
    resume: undefined,
    worker: undefined,
    __replay: { position, total: events.length },
  };
}


// Phase 2.4: time travel slider markup. Total event count comes from
// the live record (preserved as record.__replay.total when a snapshot
// is active). Renders only when there are events to scrub through.

function isReplayStickEnabled(runbookPath, runId) {
  const key = machineRunTransientScopeKey(runbookPath, runId);
  if (!key) return machineRunReplayStickDefault;
  // Default ON: a runId is "stick-enabled" unless the user explicitly
  // disabled stick-to-bottom. Set membership inverted so we don't have
  // to seed the set on every new run.
  return !machineRunReplayStickRunIds.has(`off:${key}`);
}

function setReplayStickEnabled(runbookPath, runId, enabled) {
  const key = machineRunTransientScopeKey(runbookPath, runId);
  if (!key) return;
  if (enabled) machineRunReplayStickRunIds.delete(`off:${key}`);
  else machineRunReplayStickRunIds.add(`off:${key}`);
}

function applyReplayStickAfterRender() {
  // Called after every renderRunbooksPanel pass. For each event log
  // element in the DOM, if the user's stick-toggle is on AND there
  // are new events since the last snapshot, auto-scroll to bottom.
  // Also updates the lastRendered map so the NEXT render's freshness
  // calculation is anchored at the highest sequence we just painted.
  const elements = document.querySelectorAll('[data-runbook-replay-events]');
  for (const el of elements) {
    const runId = el.getAttribute('data-run-id') || '';
    const runbookPath = el.getAttribute('data-path') || selectedRunbookPath || '';
    const scopeKey = machineRunTransientScopeKey(runbookPath, runId);
    if (!runId) continue;
    const eventNodes = el.querySelectorAll('[data-event-seq]');
    let maxSeq = 0;
    for (const ev of eventNodes) {
      const seq = Number(ev.getAttribute('data-event-seq')) || 0;
      if (seq > maxSeq) maxSeq = seq;
    }
    if (isReplayStickEnabled(runbookPath, runId)) {
      // scrollIntoView would jump the parent; setting scrollTop
      // directly is contained to the events list.
      el.scrollTop = el.scrollHeight;
    }
    if (maxSeq > 0 && scopeKey) lastReplayRenderedSequence.set(scopeKey, maxSeq);
    // Auto-disable stick when the user manually scrolls up -matches
    // the LangGraph Studio / terminal UX where any upward gesture is
    // an intent to inspect history. Re-enable when they scroll back
    // to the bottom. Updates the toggle button class directly to
    // avoid a full re-render loop while scrolling.
    if (!el.dataset.scrollHandlerWired) {
      el.dataset.scrollHandlerWired = '1';
      el.addEventListener('scroll', () => {
        const tolerance = 8;
        const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop <= tolerance;
        const wasEnabled = isReplayStickEnabled(runbookPath, runId);
        if (atBottom !== wasEnabled) {
          setReplayStickEnabled(runbookPath, runId, atBottom);
          // Targeted DOM update -find the matching toggle button and
          // flip its class without triggering a full re-render.
          const toggle = document.querySelector(`.runbook-replay-stick-toggle[data-run-id="${CSS.escape(runId)}"][data-path="${CSS.escape(runbookPath)}"]`)
            || document.querySelector(`.runbook-replay-stick-toggle[data-run-id="${CSS.escape(runId)}"]`);
          if (toggle) {
            toggle.classList.toggle('active', atBottom);
            toggle.textContent = atBottom ? 'Auto-scroll' : 'Manual scroll';
            toggle.title = atBottom ? 'Auto-scroll on. Click to disable.' : 'Auto-scroll off. Click to enable.';
          }
        }
      }, { passive: true });
    }
  }
}

function getHistoryInspectionRecord(runbookPath) {
  if (!runbookPath) return null;
  const key = runbookNormalizePath(runbookPath).toLowerCase();
  return machineHistoryInspectionCache.get(key) || null;
}






// Read the actual active run for this runbook (NOT the history inspection).
// Pipeline setup panel and Latest Run "Active" subsection MUST use this so
// they are not polluted by the user clicking around in History.
//
// Phase 2.4: when the user has scrubbed the time travel slider, return
// a snapshot record with events truncated to the slider position. The
// rest of the UI (lifecycle banner / graph projection / failure cards /
// run-bar metrics) derives from events.length so they all see the
// snapshot consistently.
function getActiveMachineRunRecord(runbookPath) {
  if (!runbookPath) return null;
  const cached = getRunbookCache(machineRunRecordCache, runbookPath);
  if (cached) return applyReplaySnapshot(cached, runbookPath);
  const selectedMatches = selectedRunbookPath
    && runbookNormalizePath(selectedRunbookPath).toLowerCase() === runbookNormalizePath(runbookPath).toLowerCase();
  return selectedMatches ? applyReplaySnapshot(lastMachineRunRecord, runbookPath) : null;
}

// For Latest Run panel renderer -returns the LIVE record (no snapshot)
// so the slider itself can show position out of total event count, and
// so the auto-scroll/freshness logic operates on the actual feed even
// while the user is scrubbing.







// Supervised-autonomy pause (RC-IPC). Records pause intent so the autonomous
// driver suspends at its NEXT step boundary — in-flight work always finishes
// first; this never kills a running subprocess. Uses a distinct mutation-lock
// key (runId + ":pause") so the request can be issued WHILE executeRunStep /
// the driver holds the base (runId) lock — requestRunPause is lock-free on the
// main side. The run flips to 'paused' asynchronously, so we keep polling.




// Adopt the inspected History snapshot as the active run. The user's
// mental model: clicking a History entry is read-only; pressing Recover
// brings that run "back" -recovers stale claims if non-terminal, then
// promotes the snapshot to the active cache so Continue / Cancel work
// against it.


// STEER "leave this out": reject a still-pending queue item. The main side
// fail-fast rejects (MACHINE_RUN_BUSY) if a step is in flight — the flow is
// pause -> reject -> resume — so the UI disables Reject while the run is running.

// STEER "do this first": pull a queued item to the front of the claim order.
// Like reject, the main side is fail-fast while a step runs (pause -> steer -> resume).

// STEER add/edit: gather a work item's human-meaningful fields via a modal
// (Electron has no window.prompt). Reuses the openFmtModal helper so the input
// survives the 2s panel re-render (a separate overlay, not inline). Shared by
// "Inject task" (empty initial) and "Edit" (prefilled from the current item) so
// both flows feel identical. Resolves { title, targetFiles, acceptanceCriteria }
// or null if cancelled.


// Read a queue item's current human-editable content from its on-disk snapshot
// (the latest queue/ transition artifact for the item), so the Edit modal can be
// prefilled with what's actually there. Returns null if it can't be read — the
// edit flow then aborts rather than risk overwriting fields blind.

// STEER "fix this": edit a queued item's title / target files / acceptance
// criteria in place. Prefills from the current snapshot so the human edits what's
// really there (aborts if it can't be read, rather than blank-overwriting). Like
// the other steer ops, the main side is fail-fast while a step runs (pause ->
// steer -> resume) and the button is disabled until then.



// Retry a probe whose adapter returned status='failed'. The IPC layer
// appends a fresh node.scheduled event so the dispatcher re-evaluates
// the node on the next executeRunStep call. Then we kick off
// executeSelectedMachineRunStep so the user does not also have to click
// Continue afterwards.





























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








function hasExternalResearchIntent(taskText) {
  return EXTERNAL_RESEARCH_INTENT_PATTERN.test(normalizeRunbookTask(taskText));
}

function externalResearchLimitationText() {
  return 'Local-only generated run: external competitor claims require approved browsing or attached research evidence. Without that evidence, the run must report a research gap and propose only local evidence-backed work.';
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

const GENERATE_PROVIDER_SELECTION_KEY = 'orpad-generate-provider-selection';
// Legacy generate-pipeline provider gate. The authoring backend
// (orchestration-authoring) was removed in the G2 rebuild; this only gates
// stale UI paths pending full removal of the generate flow.
const GENERATE_PROVIDER_READY_IDS = new Set(['codex-cli', 'claude-code']);





async function createOrpadRunbookStarter(options = {}) {
  const requestedWorkspacePath = options.workspacePath || workspacePath;
  if (!requestedWorkspacePath) {
    ensureSidebar('runbooks');
    return;
  }
  const taskText = normalizeRunbookTask(options.taskText || runbookDraftTask)
    || 'Improve this OrPAD workspace from the current user request, generate evidence, and keep changes reviewable.';
  if (typeof window.orpad?.orchestration?.generatePipeline === 'function') {
    const generated = await window.orpad.orchestration.generatePipeline({
      requestId: options.requestId || '',
      workspacePath: requestedWorkspacePath,
      prompt: taskText,
      providerSelection: options.providerSelection || null,
    });
    if (!generated?.success) {
      throw new Error(generated?.error || 'OrPAD CLI could not generate a pipeline.');
    }
    const stillCurrentWorkspace = normalizeComparablePath(workspacePath) === normalizeComparablePath(requestedWorkspacePath);
    const stillCurrentRequest = !options.requestId || pipelineGenerateState?.requestId === options.requestId;
    if (!stillCurrentWorkspace || !stillCurrentRequest) return generated;
    selectedRunbookPath = runbookNormalizePath(generated.pipelinePath || '');
    if (!selectedRunbookPath) throw new Error('OrPAD CLI did not return a pipeline path.');
    pipelineHarnessRequiredBeforeRunCache.add(harnessImplementationKey(selectedRunbookPath));
    selectedRunbookValidation = null;
    lastRunRecord = null;
    await loadFileTree();
    workspaceRunbookSummary = buildWorkspaceRunbookSummary();
    chooseSelectedRunbook(workspaceRunbookSummary);
    renderRunbooksPanel();
    await openFileInTab(runbookNormalizePath(generated.graphPath || selectedRunbookPath));
    await validateSelectedRunbook(selectedRunbookPath);
    ensureSidebar('runbooks');
    return generated;
  }
  throw new Error('OrPAD Generate requires the orchestration authoring IPC bridge.');
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
    { id: 'queue', type: 'orpad.workQueue', label: 'Own candidate queue state', config: { queueRoot: 'harness/generated/latest-run/queue', schema: ORPAD_WORK_ITEM_SCHEMA_VERSION } },
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
      { id: 'orpad.core', version: '>=1.0.0-beta.4', origin: 'built-in' },
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
        claimPolicy: {
          concurrency: 1,
        },
        probeNodePaths: ['main/probe'],
        triageNodePath: 'main/triage',
        dispatcherNodePath: 'main/dispatch',
        workerNodePath: 'main/worker',
        supportNodePolicy: 'record-gate-warnings-and-mark-artifact-partial',
        description: 'Generated managed-run adapter. OrPAD owns work state, run status, and evidence files; Codex CLI submits candidate/result/proof through adapter contracts.',
      },
      queueProtocol: {
        schema: ORPAD_WORK_ITEM_SCHEMA_VERSION,
        states: [...ORPAD_WORK_ITEM_STATES],
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
          const runbookPath = probeButton.dataset.runbookPath
            || probeButton.dataset.path
            || pipelineContextForPath()?.pipelinePath
            || selectedRunbookPath
            || '';
          const opened = await openFileInTab(artifactPath, {
            returnContext: createPipelineReturnContext(runbookPath, { source: 'run-artifact' }),
          });
          if (!opened) {
            // openFileInTab returns false (without throwing) when the
            // backend read fails -typically because the file doesn't
            // exist yet. summary.md in particular is only written when
            // the run finalizes; clicking it on a waiting/blocked run
            // would otherwise produce zero feedback.
            const hint = /summary\.md$/i.test(artifactPath)
              ? 'Summary is only written when the run finalizes (completed / cancelled / failed). Try again after the run terminates, or open events.jsonl.'
              : 'File could not be opened - it may not exist yet for this run state.';
            notifyFormatError('Open file', new Error(`${hint}\nPath: ${artifactPath}`));
          }
        } catch (err) {
          notifyFormatError('Probe artifact', err);
        }
      }
    }
    return;
  }
});

contextReturnBarEl?.addEventListener('click', async (event) => {
  const button = event.target.closest?.('[data-context-return-action]');
  if (!button || !contextReturnBarEl.contains(button)) return;
  event.preventDefault();
  event.stopPropagation();
  const previousLabel = button.textContent;
  button.disabled = true;
  button.textContent = button.dataset.contextReturnAction === 'details' ? 'Opening...' : 'Returning...';
  try {
    await openPipelineReturnTarget(getActiveTab()?.returnContext, button.dataset.contextReturnAction || 'flow');
  } catch (err) {
    notifyFormatError('Return to pipeline', err);
  } finally {
    if (contextReturnBarEl.contains(button)) {
      button.disabled = false;
      button.textContent = previousLabel;
    }
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
  } catch (err) {
    notifyFormatError('Runbooks', err);
  }
});


runbooksContentEl?.addEventListener('keydown', (event) => {
  const slot = event.target.closest?.('.runbook-item[data-runbook-path]');
  if (!slot || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  toggleRunbookSlot(slot.dataset.runbookPath || '').catch(err => notifyFormatError('Runbooks', err));
});

// ==================== File Tree ====================
async function openFolder({ revealSidebar = true } = {}) {
  const folderPath = await window.orpad.openFolderDialog();
  if (folderPath) {
    workspacePath = folderPath;
    expandedPaths.clear();
    clearWorkspacePipelineState();
    pruneOpenTabsOutsideWorkspace(workspacePath);
    localStorage.setItem('orpad-workspace-path', workspacePath);
    await loadFileTree();
    window.orpad.watchDirectory(folderPath);
    window.orpad.buildLinkIndex(folderPath).then(() => refreshFileNameCache());
    scheduleGitRefresh(0);
    scheduleSnippetRefresh(0);
    if (revealSidebar && !sidebarVisible) showSidebar('files');
  }
  return folderPath || null;
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
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function openFileInTab(filePath, options = {}) {
  const existing = findTabByPath(filePath);
  const returnContext = returnContextForFileOpen(filePath, options);
  if (existing) {
    if (Object.prototype.hasOwnProperty.call(options, 'returnContext')) {
      existing.returnContext = returnContext;
    } else if (!existing.returnContext && returnContext) {
      existing.returnContext = returnContext;
    }
    switchToTab(existing.id);
    return true;
  }
  const result = await window.orpad.readFile(filePath);
  if (result.error) return false;
  createTab(result.filePath, result.dirPath, result.content, undefined, { returnContext });
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
  const opened = await openFileInTab(filePath, options);
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
    { id: 'view.orchestration', title: 'Open Run GUI', category: 'View', run: openOrchestrationWindow },
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
    const nextViewType = getViewType(tab.filePath);
    if (nextViewType !== tab.viewType) {
      tab.viewType = nextViewType;
      tab.editorState = createEditorState(content, tab.viewType, tab.filePath);
      switchingTabs = true;
      editor.setState(tab.editorState);
      switchingTabs = false;
      renderPreview(content);
      updateFormatBar(tab.viewType);
    }
    ensureTabLanguageLoaded(tab);
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
btnOrchestrationEl?.addEventListener('click', openOrchestrationWindow);
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
    newTab.editorState = createEditorState(editor.state.doc.toString(), 'markdown', newTab.title);
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
let fmtModalBusy = false;

function setFmtModalBusy(busy, message = '') {
  if (!fmtModalEl) return;
  fmtModalBusy = Boolean(busy);
  fmtModalEl.classList.toggle('busy', fmtModalBusy);
  fmtModalEl.classList.toggle('locked', fmtModalBusy);
  if (fmtModalBusy) fmtModalEl.setAttribute('aria-busy', 'true');
  else fmtModalEl.removeAttribute('aria-busy');

  let statusEl = fmtModalFooterEl.querySelector('[data-fmt-modal-busy-status]');
  if (fmtModalBusy) {
    if (!statusEl) {
      statusEl = document.createElement('span');
      statusEl.className = 'fmt-modal-busy-status';
      statusEl.setAttribute('data-fmt-modal-busy-status', 'true');
      fmtModalFooterEl.prepend(statusEl);
    }
    statusEl.textContent = message || 'Working...';
  } else {
    statusEl?.remove();
  }

  for (const control of fmtModalEl.querySelectorAll('button, input, textarea, select')) {
    if (fmtModalBusy) {
      if (!control.dataset.fmtModalPrevDisabled) {
        control.dataset.fmtModalPrevDisabled = control.disabled ? 'true' : 'false';
      }
      control.disabled = true;
    } else if (control.dataset.fmtModalPrevDisabled) {
      control.disabled = control.dataset.fmtModalPrevDisabled === 'true';
      delete control.dataset.fmtModalPrevDisabled;
    }
  }
}


function openFmtModal({ title, body, footer, onClose }) {
  if (fmtModalBusy) setFmtModalBusy(false);
  if (!fmtModalEl.classList.contains('hidden')) {
    const previousOnClose = fmtModalOnClose;
    fmtModalOnClose = null;
    previousOnClose?.();
  }
  delete fmtModalEl.dataset.machineModalKind;
  delete fmtModalEl.dataset.machineBlockedDecisionKey;
  delete fmtModalEl.dataset.machineBlockedRunId;
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
    b.addEventListener('click', (event) => {
      if (fmtModalBusy) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      try {
        const result = btn.onClick?.(event);
        if (result && typeof result.catch === 'function') {
          result.catch(err => notifyFormatError('Modal action', err));
        }
      } catch (err) {
        notifyFormatError('Modal action', err);
      }
    });
    fmtModalFooterEl.appendChild(b);
  }
  fmtModalEl.classList.remove('hidden');
}
function closeFmtModal(options = {}) {
  const force = options?.force === true;
  if (!force && fmtModalEl.classList.contains('locked')) return;
  if (fmtModalEl.classList.contains('hidden')) return;
  if (fmtModalBusy) setFmtModalBusy(false);
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
    localStorage.removeItem(LEGACY_MMD_THEME_STORAGE_KEY);
    invalidateRenderCache();
    refreshVisibleMermaidTheme();
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
let mermaidLastThemeSignature = null;
// Per-block debounce timers and SVG cache, keyed by data-mermaid-hash.
const mermaidTimers = new Map();
const mermaidSvgCache = new Map();

function readThemeCssValue(styles, names, fallback = '') {
  for (const name of names) {
    const value = styles.getPropertyValue(name).trim();
    if (value) return value;
  }
  return fallback;
}

function buildMermaidThemeState() {
  const rootStyles = getComputedStyle(document.documentElement);
  const bodyStyles = getComputedStyle(document.body);
  const bgPrimary = readThemeCssValue(rootStyles, ['--bg-primary'], bodyStyles.backgroundColor);
  const bgSecondary = readThemeCssValue(rootStyles, ['--bg-secondary', '--bg-primary'], bgPrimary);
  const bgTertiary = readThemeCssValue(rootStyles, ['--bg-tertiary', '--bg-secondary', '--bg-primary'], bgSecondary);
  const textPrimary = readThemeCssValue(rootStyles, ['--text-primary'], bodyStyles.color);
  const textSecondary = readThemeCssValue(rootStyles, ['--text-secondary', '--text-primary'], textPrimary);
  const borderColor = readThemeCssValue(rootStyles, ['--border-color', '--text-secondary', '--text-primary'], textSecondary);
  const accentColor = readThemeCssValue(rootStyles, ['--accent-color', '--syntax-keyword', '--text-primary'], textPrimary);
  const accentSoft = readThemeCssValue(rootStyles, ['--syntax-string', '--accent-color', '--text-secondary'], accentColor);
  const theme = getThemeById(currentThemeId);
  const themeVariables = {
    darkMode: theme?.type === 'dark',
    background: bgPrimary,
    mainBkg: bgSecondary,
    primaryColor: bgSecondary,
    primaryTextColor: textPrimary,
    primaryBorderColor: borderColor,
    lineColor: accentColor,
    secondaryColor: bgTertiary,
    secondaryTextColor: textPrimary,
    secondaryBorderColor: borderColor,
    tertiaryColor: bgPrimary,
    tertiaryTextColor: textPrimary,
    tertiaryBorderColor: borderColor,
    textColor: textPrimary,
    edgeLabelBackground: bgPrimary,
    clusterBkg: bgSecondary,
    clusterBorder: borderColor,
    titleColor: textPrimary,
    noteBkgColor: bgSecondary,
    noteTextColor: textPrimary,
    noteBorderColor: borderColor,
    actorBkg: bgSecondary,
    actorBorder: borderColor,
    actorTextColor: textPrimary,
    actorLineColor: accentColor,
    signalColor: accentColor,
    signalTextColor: textPrimary,
    labelBoxBkgColor: bgSecondary,
    labelBoxBorderColor: borderColor,
    labelTextColor: textPrimary,
    loopTextColor: textPrimary,
    activationBkgColor: bgTertiary,
    activationBorderColor: accentColor,
    sequenceNumberColor: bgPrimary,
    sectionBkgColor: bgSecondary,
    altSectionBkgColor: bgTertiary,
    gridColor: borderColor,
    c0: bgSecondary,
    c1: bgTertiary,
    c2: accentSoft,
    c3: accentColor,
    cText: textPrimary,
    cText0: textPrimary,
    cText1: textPrimary,
    cText2: textPrimary,
    cText3: textPrimary,
    stateLabelColor: textPrimary,
    stateBkg: bgSecondary,
    stateBorder: borderColor,
    compositeBackground: bgSecondary,
    fontFamily: bodyStyles.fontFamily,
  };
  const normalizedVariables = Object.fromEntries(
    Object.entries(themeVariables).filter(([, value]) => typeof value === 'boolean' || String(value || '').trim())
  );
  return {
    signature: JSON.stringify(normalizedVariables),
    config: {
      startOnLoad: false,
      theme: 'base',
      securityLevel: 'strict',
      logLevel: 'fatal',
      themeVariables: normalizedVariables,
    },
  };
}

function invalidateMermaidRenderCache() {
  for (const timer of mermaidTimers.values()) clearTimeout(timer);
  mermaidTimers.clear();
  mermaidSvgCache.clear();
}

function refreshVisibleMermaidTheme() {
  invalidateMermaidRenderCache();
  mermaidLastThemeSignature = null;
  if (contentEl?.querySelector?.('.mermaid-block')) {
    void renderMermaidBlocks();
  }
}

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
  const themeState = buildMermaidThemeState();
  if (!mermaidModule) {
    try {
      mermaidModule = (await import('mermaid')).default;
      mermaidModule.initialize(themeState.config);
      mermaidLastThemeSignature = themeState.signature;
      mermaidReady = true;
    } catch { return; }
  } else if (mermaidLastThemeSignature !== themeState.signature) {
    try { mermaidModule.initialize(themeState.config); }
    catch {}
    mermaidLastThemeSignature = themeState.signature;
    invalidateMermaidRenderCache();
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

async function openOrchestrationWindow() {
  if (IS_ORCHESTRATION_WINDOW) {
    toggleOrchestrationRail();
    return;
  }
  if (!workspacePath) {
    await openFolder({ revealSidebar: false });
    if (!workspacePath) return;
  }
  const api = window.orpad?.orchestrationWindow;
  if (!api?.open) {
    ensureSidebar('runbooks');
    return;
  }
  try {
    const response = await api.open({ workspacePath });
    if (response?.success === false) {
      throw new Error(response.error || 'Run GUI window could not be opened.');
    }
  } catch (err) {
    notifyFormatError('Run GUI', err);
  }
}

function setOrchestrationRailCollapsed(collapsed) {
  if (!IS_ORCHESTRATION_WINDOW) return;
  document.body.classList.toggle('orchestration-rail-collapsed', !!collapsed);
  localStorage.setItem('orpad-orchestration-rail-collapsed', collapsed ? 'true' : 'false');
  if (!collapsed) applyStoredSidebarWidth();
  if (btnOrchestrationEl) {
    btnOrchestrationEl.classList.toggle('rail-collapsed', !!collapsed);
    btnOrchestrationEl.title = collapsed ? 'Show Orchestration Panel' : 'Hide Orchestration Panel';
    btnOrchestrationEl.setAttribute('aria-label', btnOrchestrationEl.title);
    btnOrchestrationEl.setAttribute('aria-expanded', String(!collapsed));
  }
  requestAnimationFrame(() => {
    if (contentEl.querySelector('.orch-graph-node')) fitOrchGraphToFrame();
  });
}

function toggleOrchestrationRail() {
  setOrchestrationRailCollapsed(!document.body.classList.contains('orchestration-rail-collapsed'));
}

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
    if (IS_ORCHESTRATION_WINDOW && sidebarVisible && !document.body.classList.contains('orchestration-rail-collapsed')) {
      applySidebarWidth(sidebarEl.offsetWidth);
    }
    scheduleOrchGraphResponsiveFit();
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

  if (!IS_ORCHESTRATION_WINDOW && (savedSidebarVisible === 'true' || (savedSidebarVisible === null && legacyTocVisible === 'true'))) {
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

  const storedWorkspacePath = workspacePath;
  const approvedWorkspace = await window.orpad.getApprovedWorkspace?.().catch(() => null);
  if (approvedWorkspace) {
    const workspaceChanged = storedWorkspacePath && normalizeComparablePath(storedWorkspacePath) !== normalizeComparablePath(approvedWorkspace);
    workspacePath = approvedWorkspace;
    if (workspaceChanged) {
      expandedPaths.clear();
      clearWorkspacePipelineState();
      pruneOpenTabsOutsideWorkspace(workspacePath);
    }
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
  if (IS_ORCHESTRATION_WINDOW) {
    sidebarVisible = true;
    sidebarActivePanel = 'runbooks';
    sidebarEl?.classList.remove('hidden');
    applyStoredSidebarWidth();
    btnAiEl?.setAttribute('hidden', '');
    document.getElementById('sidebar-runbooks')?.classList.add('active');
    window.orpad?.setTitle?.('OrPAD Run GUI');
    setOrchestrationRailCollapsed(localStorage.getItem('orpad-orchestration-rail-collapsed') === 'true');
    renderRunbooksPanel();
    void refreshWorkspaceRunbookSummary();
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

  if (!IS_ORCHESTRATION_WINDOW) {
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
            tab.editorState = createEditorState(content || '', viewType, tab.filePath || tab.title);
            editor.setState(tab.editorState);
            ensureTabLanguageLoaded(tab);
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
  }

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
