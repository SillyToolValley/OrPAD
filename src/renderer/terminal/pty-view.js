import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebglAddon } from '@xterm/addon-webgl';
import xtermCss from '@xterm/xterm/css/xterm.css';
import { t } from '../i18n.js';

const MAX_BLOCK_CHARS = 240_000;
// When a window is minimized/hidden, requestAnimationFrame stops firing (backgroundThrottling:false only keeps
// timers, not rAF), so the rAF-batched flush wouldn't run and session.pendingData would grow without bound on a
// high-output session. Past this many buffered chars, flush synchronously into xterm's (scrollback-bounded)
// buffer instead of waiting for a frame.
const MAX_PENDING_FLUSH = 256_000;
const DEFAULT_MAX_COMMAND_BLOCKS = 120;
const LAST_SHELL_KEY = 'orpad-terminal-last-shell';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmt(key, vars = {}) {
  let text = t(key);
  for (const [name, value] of Object.entries(vars)) {
    text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

function ensureXtermCss() {
  if (document.getElementById('orpad-xterm-css')) return;
  const style = document.createElement('style');
  style.id = 'orpad-xterm-css';
  style.textContent = xtermCss;
  document.head.appendChild(style);
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function truncateForUi(text) {
  const raw = stripAnsi(text);
  if (raw.length <= MAX_BLOCK_CHARS) return raw;
  return `${raw.slice(0, MAX_BLOCK_CHARS)}\n\n${fmt('terminal.output.truncated', { count: MAX_BLOCK_CHARS })}`;
}

function commandBlockRetentionLimit() {
  const testOverride = typeof window !== 'undefined'
    ? Number(window.__ORPAD_TERMINAL_HISTORY_LIMIT__)
    : NaN;
  const limit = Number.isFinite(testOverride) ? testOverride : DEFAULT_MAX_COMMAND_BLOCKS;
  return Math.max(1, Math.floor(limit));
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isInsidePath(child, parent) {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (!c || !p) return false;
  return c === p || c.startsWith(`${p}/`);
}

function fileName(value) {
  return String(value || '').split(/[\\/]/).pop() || value || '';
}

function shellIcon(shell = {}) {
  const id = String(shell.id || shell.family || '').toLowerCase();
  if (id.includes('claude')) return 'CL';
  if (id.includes('codex')) return 'CX';
  if (id.includes('gemini')) return 'GM';
  if (id.includes('powershell')) return 'PS';
  if (id.includes('cmd')) return 'CMD';
  if (id.includes('git')) return 'Git';
  if (id.includes('wsl')) return 'WSL';
  if (id.includes('zsh')) return 'zsh';
  if (id.includes('fish')) return 'fish';
  return 'sh';
}

function shellDescription(shell = {}) {
  if (shell.available === false) return shell.installHint || t('terminal.shell.installHint');
  if (shell.description) return shell.description;
  const command = shell.command || '';
  const family = shell.family ? fmt('terminal.shell.family', { family: shell.family }) : t('terminal.shell.generic');
  return command ? `${family} - ${command}` : family;
}

function nowId(prefix = 'pty') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeMarkdownCode(text) {
  return String(text || '').replace(/`/g, '\\`');
}

function terminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  const css = name => styles.getPropertyValue(name).trim();
  return {
    background: css('--editor-bg') || css('--bg-primary') || '#1a1b26',
    foreground: css('--text-primary') || '#c0caf5',
    cursor: css('--editor-cursor') || css('--accent-color') || '#7aa2f7',
    selectionBackground: css('--editor-selection') || 'rgba(122,162,247,0.4)',
    black: css('--bg-primary') || '#1a1b26',
    brightBlack: css('--text-tertiary') || '#565f89',
    red: css('--syntax-deleted') || '#f7768e',
    green: css('--syntax-added') || '#9ece6a',
    yellow: css('--syntax-meta') || '#e0af68',
    blue: css('--accent-color') || '#7aa2f7',
    magenta: css('--syntax-keyword') || '#bb9af7',
    cyan: css('--syntax-operator') || '#89ddff',
    white: css('--text-primary') || '#c0caf5',
  };
}

function processTypedBuffer(session, data) {
  for (const ch of String(data || '')) {
    if (ch === '\r') {
      const command = session.commandBuffer.trim();
      session.commandBuffer = '';
      if (command) startCommandBlock(session, command, true);
      continue;
    }
    if (ch === '\u007f' || ch === '\b') {
      session.commandBuffer = session.commandBuffer.slice(0, -1);
      continue;
    }
    if (ch === '\u0015') {
      session.commandBuffer = '';
      continue;
    }
    if (ch >= ' ' && ch !== '\u007f') {
      session.commandBuffer += ch;
    }
  }
}

function blockMarkdown(block) {
  const command = block.commandLine || t('terminal.command.fallback');
  return [
    `### Terminal command: \`${escapeMarkdownCode(command)}\``,
    '',
    `- CWD: \`${escapeMarkdownCode(block.cwd || '')}\``,
    `- Exit: ${block.exitCode === null || block.exitCode === undefined ? t('terminal.unknown') : block.exitCode}`,
    '',
    '```text',
    stripAnsi(block.output || ''),
    '```',
    '',
  ].join('\n');
}

function dispatchTerminalOutput(block) {
  window.dispatchEvent(new CustomEvent('orpad-runner-output', {
    detail: {
      runId: block.id,
      source: 'terminal',
      commandLine: block.commandLine,
      cwd: block.cwd,
      exitCode: block.exitCode,
      output: stripAnsi(block.output || ''),
      finishedAt: block.finishedAt,
    },
  }));
}

function disposeCommandBlock(block) {
  if (!block) return;
  if (block.pre) block.pre.textContent = '';
  block.output = '';
  block.details?.remove();
  block.details = null;
  block.pre = null;
  block.badge = null;
  block.toolbar = null;
}

function pruneCompletedCommandBlocks(session) {
  const limit = commandBlockRetentionLimit();
  let retained = 0;
  for (let index = 0; index < session.blocks.length;) {
    const block = session.blocks[index];
    if (block.finishedAt) {
      retained += 1;
      if (retained > limit) {
        session.blocks.splice(index, 1);
        disposeCommandBlock(block);
        continue;
      }
    }
    index += 1;
  }
}

function latestFinishedBlock(sessions) {
  let latest = null;
  for (const session of sessions) {
    for (const block of session.blocks) {
      if (!block.finishedAt) continue;
      if (!latest || String(block.finishedAt || '') > String(latest.finishedAt || '')) {
        latest = block;
      }
    }
  }
  return latest;
}

async function writeClipboardText(text) {
  const value = String(text || '');
  if (!value) return false;
  // Prefer the Electron main-process clipboard (reliable from a sandboxed renderer); fall back to navigator.
  if (typeof window !== 'undefined' && window.clipboard?.writeText) {
    try { if (await window.clipboard.writeText(value)) return true; } catch {}
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {}
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-10000px';
  textarea.style.top = '-10000px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function copyTerminalSelection(term) {
  const selected = term?.getSelection?.() || '';
  if (!selected) return Promise.resolve(false);
  return writeClipboardText(selected);
}

function startCommandBlock(session, commandLine, provisional = false) {
  if (session.currentBlock) return session.currentBlock;
  const block = {
    id: nowId('cmd'),
    commandLine: commandLine || session.pendingCommand || 'shell command',
    cwd: session.cwd || '',
    output: '',
    exitCode: null,
    startedAt: new Date().toISOString(),
    provisional,
  };
  session.pendingCommand = '';

  const details = el('details', 'terminal-block terminal-pty-block');
  details.open = true;
  const summary = document.createElement('summary');
  const title = el('span', 'terminal-command', `> ${block.commandLine}`);
  const badge = el('span', 'terminal-badge running', t('terminal.badge.running'));
  summary.append(title, badge);

  const toolbar = el('div', 'terminal-block-toolbar');
  const pre = document.createElement('pre');
  details.append(summary, toolbar, pre);
  if (session.isActive?.()) session.blockList.prepend(details);

  const actions = [
    [t('terminal.action.copy'), async () => navigator.clipboard.writeText(stripAnsi(block.output || ''))],
    [t('terminal.action.askAi'), () => {
      window.dispatchEvent(new CustomEvent('orpad-ai-prefill', {
        detail: { text: `<terminal_output>\n${stripAnsi(block.output || '')}\n</terminal_output>\n\nExplain this terminal output:` },
      }));
    }],
    [t('terminal.action.insertDoc'), () => session.hooks.insertRunnerBlock?.(blockMarkdown(block))],
  ];
  for (const [label, handler] of actions) {
    const button = el('button', '', label);
    button.type = 'button';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const result = handler();
      if (result?.catch) result.catch(err => session.hooks.notify?.('Terminal', err));
    });
    toolbar.appendChild(button);
  }

  block.details = details;
  block.pre = pre;
  block.badge = badge;
  block.toolbar = toolbar;
  session.blocks.unshift(block);
  session.currentBlock = block;
  session.renderBlockCount?.();
  return block;
}

function appendBlockOutput(session, text) {
  const block = session.currentBlock;
  if (!block || !text) return;
  // Once a block reaches the cap, STOP accumulating + re-stripping. Previously every chunk did
  // `output += text` then re-stripped the ENTIRE history (truncateForUi) → O(n²) on long output, the main
  // source of the "lag as content piles up". The cap bounds it; the rAF batching (handlePtyEvent) makes the
  // pre-cap render at most once per frame.
  if (block.truncated) return;
  block.output += text;
  if (block.output.length >= MAX_BLOCK_CHARS) block.truncated = true;
  block.pre.textContent = truncateForUi(block.output);
}

function finishCommandBlock(session, exitCode) {
  const block = session.currentBlock;
  if (!block) return;
  block.exitCode = Number.isFinite(Number(exitCode)) ? Number(exitCode) : null;
  block.finishedAt = new Date().toISOString();
  block.badge.classList.remove('running');
  block.badge.classList.toggle('ok', block.exitCode === 0);
  block.badge.classList.toggle('fail', block.exitCode !== 0);
  block.badge.textContent = block.exitCode === 0 ? t('terminal.badge.exit0') : fmt('terminal.badge.exit', { code: block.exitCode ?? t('terminal.unknown') });
  block.details.classList.toggle('terminal-failed', block.exitCode !== 0);

  if (block.exitCode !== 0) {
    const explain = el('button', '', t('terminal.action.explainError'));
    explain.type = 'button';
    explain.addEventListener('click', (event) => {
      event.stopPropagation();
      window.dispatchEvent(new CustomEvent('orpad-ai-prefill', {
        detail: {
          text: `<terminal_error command="${block.commandLine || ''}" exit="${block.exitCode ?? ''}">\n${stripAnsi(block.output || '')}\n</terminal_error>\n\nExplain the failure and suggest the safest next command.`,
        },
      }));
    });
    block.toolbar.prepend(explain);
  }

  session.currentBlock = null;
  dispatchTerminalOutput(block);
  pruneCompletedCommandBlocks(session);
  session.renderBlockCount?.();
}

// Render all PTY data that accumulated since the last frame in ONE batched write. Coalescing across the many
// small IPC 'data' events (instead of one term.write per chunk) is what removes the refocus backlog burst and
// the per-chunk overhead. consumeOsc633 already buffers a split OSC across calls, so joining chunks first is
// strictly safer for escape-sequence parsing.
function flushSessionData(session) {
  session.flushScheduled = false;
  if (session.disposed) return; // closed before the frame fired — term is gone
  const raw = session.pendingData || '';
  session.pendingData = '';
  if (!raw) return;
  const cleaned = consumeOsc633(session, raw);
  if (cleaned) {
    session.term.write(cleaned);
    appendBlockOutput(session, cleaned);
  }
}

function handleOsc633(session, code, param) {
  if (code === 'P') {
    const cwd = String(param || '').replace(/^Cwd=/, '');
    if (cwd) {
      session.cwd = cwd;
      session.renderTabs();
    }
    return;
  }
  if (code === 'A') {
    startCommandBlock(session, session.pendingCommand || session.commandBuffer.trim() || t('terminal.command.fallback'));
    return;
  }
  if (code === 'D') {
    finishCommandBlock(session, parseInt(param, 10));
  }
}

// OSC 52 = clipboard write. A TUI (e.g. claude's drag-to-copy) sends the selection this way; xterm ignores it,
// so the system clipboard never gets it. Decode the base64 payload and write it to the OS clipboard ourselves.
function handleOsc52(b64) {
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    if (text && typeof window !== 'undefined' && window.clipboard?.writeText) {
      Promise.resolve(window.clipboard.writeText(text)).catch(() => {}); // fire-and-forget; never throw on a TUI copy
    }
  } catch (_) { /* malformed base64 — ignore */ }
}

function consumeOsc633(session, chunk) {
  let input = `${session.oscBuffer || ''}${String(chunk || '')}`;
  session.oscBuffer = '';

  // Hold back a trailing INCOMPLETE OSC 633/52 sequence (split across PTY chunks) for the next chunk.
  const partialAt = Math.max(input.lastIndexOf('\x1b]633;'), input.lastIndexOf('\x1b]52;'));
  if (partialAt >= 0) {
    const tail = input.slice(partialAt);
    if (!tail.includes('\x07') && !tail.includes('\x1b\\')) {
      session.oscBuffer = tail;
      input = input.slice(0, partialAt);
    }
  }

  const re = /\x1b]633;([A-DP])(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)/g;
  let cleaned = '';
  let last = 0;
  let match;
  while ((match = re.exec(input))) {
    cleaned += input.slice(last, match.index);
    handleOsc633(session, match[1], match[2] || '');
    last = re.lastIndex;
  }
  cleaned += input.slice(last);

  // Intercept OSC 52 clipboard writes (selection -> OS clipboard) and strip them from the rendered output.
  if (cleaned.indexOf('\x1b]52;') >= 0) {
    cleaned = cleaned.replace(/\x1b\]52;[cpqs0-7]*;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/g, (_m, data) => {
      if (data && data !== '?') handleOsc52(data);
      return '';
    });
  }
  return cleaned;
}

function terminalTabTitle(info) {
  return info?.shell?.label || info?.shell?.id || fileName(info?.cwd) || t('terminal.title');
}

export function createPtyTerminalGroup({ mount, hooks, track }) {
  ensureXtermCss();
  const available = typeof window !== 'undefined' && !!window.pty;

  const root = el('div', 'terminal-pty-root');
  root.innerHTML = `
    <div class="terminal-pty-topbar">
      <div class="terminal-tab-strip"></div>
      <div class="terminal-pty-toolbar">
        <span class="terminal-active-context"></span>
        <button type="button" class="terminal-orch-opts-btn" title="Orchestration options — applied when you launch an AI CLI and choose Apply">Orchestration Options</button>
        <button type="button" class="terminal-rungui-btn" title="Open the Run GUI — visualise AI runs as a live graph">Run GUI</button>
        <span class="terminal-pty-status"></span>
      </div>
    </div>
    <div class="terminal-new-popover hidden" role="menu" aria-label="New terminal profile picker">
      <div class="terminal-new-popover-head">
        <div>
          <strong>${t('terminal.new.title')}</strong>
          <span>${t('terminal.new.subtitle')}</span>
        </div>
      </div>
      <label class="terminal-new-cwd">
        <span>${t('terminal.cwd')}</span>
        <input type="text" spellcheck="false">
      </label>
      <div class="terminal-shell-list"></div>
    </div>
    <div class="terminal-draft hidden">
      <div>
        <strong>${t('terminal.draft.title')}</strong>
        <span>${t('terminal.draft.subtitle')}</span>
      </div>
      <pre></pre>
      <div>
        <button type="button" class="terminal-draft-paste">${t('terminal.draft.paste')}</button>
        <button type="button" class="terminal-draft-copy">${t('terminal.action.copy')}</button>
        <button type="button" class="terminal-draft-close">${t('terminal.draft.dismiss')}</button>
      </div>
    </div>
    <div class="terminal-pty-stage">
      <div class="terminal-pty-empty">
        <strong>${t('terminal.empty.title')}</strong>
        <span>${t('terminal.empty.subtitle')}</span>
        <button type="button" class="terminal-empty-new">${t('terminal.empty.selectShell')}</button>
      </div>
    </div>
    <details class="terminal-block-drawer">
      <summary>
        <span>${t('terminal.blocks.title')}</span>
        <span class="terminal-block-count">0</span>
      </summary>
      <div class="terminal-block-list"></div>
    </details>
  `;
  mount.appendChild(root);

  const tabStrip = root.querySelector('.terminal-tab-strip');
  const activeContextEl = root.querySelector('.terminal-active-context');
  const runGuiBtn = root.querySelector('.terminal-rungui-btn');
  const statusEl = root.querySelector('.terminal-pty-status');

  // The terminal is the entry point to orchestration: a "Run GUI" button opens the viewer, and launching an
  // AI CLI offers to layer OrPAD's orchestration on top. Both route through window.orpad.orchestrationWindow.
  const orchestrationApi = (typeof window !== 'undefined' && window.orpad && window.orpad.orchestrationWindow) || null;
  function openRunGui(seed) {
    if (!orchestrationApi || !orchestrationApi.open) return;
    Promise.resolve(orchestrationApi.open(seed ? { seed } : {})).catch(() => {});
  }
  // Build an observe seed for the CURRENTLY-ACTIVE AI-CLI terminal session (if any). Lets "Run GUI" attach the
  // graph to a session you're already working in — observe only auto-starts at Apply-time, so opening the Run GUI
  // mid-session would otherwise show nothing. Idempotent: if that session is already observed, observeStart
  // reattaches to the live observer (no duplicate).
  function activeObserveSeed() {
    const s = activeSession();
    if (!s || !s.shell || s.shell.kind !== 'ai-cli') return undefined;
    const agent = aiCliAgent(s.shell);
    return {
      agent, cwd: s.cwd, sessionId: s.id,
      cols: (s.term && s.term.cols) || null, rows: (s.term && s.term.rows) || null,
      observe: true, // observe any AI-CLI TUI (claude + codex have detector grammars; others still show the run)
      options: loadOrchestrationOptions(),
    };
  }

  // Orchestration options live HERE in the terminal (not in the Run GUI viewer): the default config applied
  // when you launch an AI CLI and choose "Apply". Persisted to localStorage; included in the Apply seed.
  const ORCH_OPTS_KEY = 'orpad-orchestration-options';
  const ORCH_OPTS_DEFAULTS = { ground: true, parallelResearch: true, apply: false, vault: false, verify: true, writeset: '', readonly: '', gates: '', verifyCycles: 3, timeoutMin: 0, buildOutputTo: 'auto' };
  function loadOrchestrationOptions() {
    try { return { ...ORCH_OPTS_DEFAULTS, ...(JSON.parse(localStorage.getItem(ORCH_OPTS_KEY) || '{}') || {}) }; }
    catch (_) { return { ...ORCH_OPTS_DEFAULTS }; }
  }
  function saveOrchestrationOptions(opts) {
    try { localStorage.setItem(ORCH_OPTS_KEY, JSON.stringify(opts)); } catch (_) { /* ignore */ }
  }
  function openOrchestrationOptions() {
    if (!hooks.openModal) return;
    const o = loadOrchestrationOptions();
    const body = el('div', 'terminal-orch-options');
    body.innerHTML = `
      <p class="terminal-orch-hint">Defaults for OrPAD's <strong>governed runs</strong> (sandboxed execute + verify). Note: launching an AI CLI in the terminal and choosing “Apply” is <strong>read-only observation</strong> — these options do not apply to it (a live terminal session can't be sandboxed).</p>
      <label class="terminal-orch-check"><input type="checkbox" data-o-ground> Research prior art first (grounding)</label>
      <label class="terminal-orch-check"><input type="checkbox" data-o-parallel> Parallel research (fan-out)</label>
      <label class="terminal-orch-check"><input type="checkbox" data-o-vault> Knowledge vault (ground in + capture notes)</label>
      <label class="terminal-orch-check"><input type="checkbox" data-o-verify> Verify (auto QA: smoke + critic + retry)</label>
      <label class="terminal-orch-check"><input type="checkbox" data-o-apply> Apply result to workspace</label>
      <label class="terminal-orch-field"><span>Write-set (one path per line)</span><textarea data-o-writeset rows="2"></textarea></label>
      <label class="terminal-orch-field"><span>Read-only context (one path per line)</span><textarea data-o-readonly rows="1"></textarea></label>
      <label class="terminal-orch-field"><span>Verification gates (one shell check per line)</span><textarea data-o-gates rows="2"></textarea></label>
      <div class="terminal-orch-row">
        <label class="terminal-orch-field"><span>Verify retry cycles</span><input type="number" min="0" max="5" step="1" data-o-cycles></label>
        <label class="terminal-orch-field"><span>Time cap (min, 0=none)</span><input type="number" min="0" step="1" data-o-timeout></label>
        <label class="terminal-orch-field"><span>Build output</span><select data-o-buildout><option value="auto">Auto</option><option value="workspace">Workspace</option><option value="run-dir">Run dir</option></select></label>
      </div>
    `;
    const q = (s) => body.querySelector(s);
    q('[data-o-ground]').checked = !!o.ground;
    q('[data-o-parallel]').checked = !!o.parallelResearch;
    q('[data-o-vault]').checked = !!o.vault;
    q('[data-o-verify]').checked = !!o.verify;
    q('[data-o-apply]').checked = !!o.apply;
    q('[data-o-writeset]').value = o.writeset || '';
    q('[data-o-readonly]').value = o.readonly || '';
    q('[data-o-gates]').value = o.gates || '';
    q('[data-o-cycles]').value = String(o.verifyCycles ?? 3);
    q('[data-o-timeout]').value = String(o.timeoutMin ?? 0);
    q('[data-o-buildout]').value = o.buildOutputTo || 'auto';
    hooks.openModal({
      title: 'Orchestration Options',
      body,
      onClose: () => hooks.closeModal?.(),
      footer: [
        { label: 'Cancel', onClick: () => hooks.closeModal?.() },
        { label: 'Save', primary: true, onClick: () => {
          saveOrchestrationOptions({
            ground: q('[data-o-ground]').checked,
            parallelResearch: q('[data-o-parallel]').checked,
            vault: q('[data-o-vault]').checked,
            verify: q('[data-o-verify]').checked,
            apply: q('[data-o-apply]').checked,
            writeset: q('[data-o-writeset]').value,
            readonly: q('[data-o-readonly]').value,
            gates: q('[data-o-gates]').value,
            verifyCycles: Math.max(0, Math.min(5, Number(q('[data-o-cycles]').value) || 0)),
            timeoutMin: Math.max(0, Number(q('[data-o-timeout]').value) || 0),
            buildOutputTo: q('[data-o-buildout]').value,
          });
          hooks.closeModal?.();
        } },
      ],
    });
  }
  function aiCliAgent(shell) {
    const id = String((shell && shell.id) || '');
    if (id.includes('codex')) return 'codex';
    if (id.includes('gemini')) return 'gemini';
    return 'claude';
  }
  function offerOrchestration(info) {
    if (!orchestrationApi || !orchestrationApi.open || !hooks.openModal) return;
    const agent = aiCliAgent(info.shell);
    const body = el('div', 'terminal-confirm');
    body.innerHTML = `
      <p>Watch this <strong>${agent}</strong> session as a live graph in the Run GUI?</p>
      <p>This is <strong>read-only observation</strong> — OrPAD visualises the tools the CLI runs in the terminal. It does not sandbox or change what the CLI does (it works directly in your workspace). Skip to use the CLI without the graph.</p>
    `;
    const finish = () => hooks.closeModal?.();
    hooks.openModal({
      title: 'Apply orchestration?',
      body,
      onClose: () => finish(),
      footer: [
        { label: 'Skip', onClick: () => finish() },
        // claude → observe the live session as a graph. PRIMARY: the pty `sessionId` lets the observer tap this
        // exact terminal's stream and reconstruct the rendered screen (no session-log dependency). Pass the live
        // terminal dims so the screen reconstruction matches what claude is rendering. (pid kept for the legacy
        // log-tail fallback.)
        { label: 'Apply', primary: true, onClick: () => {
          finish();
          const s = sessions.find((x) => x.id === info.sessionId);
          const cols = (s && s.term && s.term.cols) || info.cols || null;
          const rows = (s && s.term && s.term.rows) || info.rows || null;
          openRunGui({ agent, cwd: info.cwd, sessionId: info.sessionId, pid: info.aiPid || null, cols, rows, observe: true, options: loadOrchestrationOptions() });
        } },
      ],
    });
  }
  if (runGuiBtn) {
    // Opening the Run GUI also attaches observe to the active AI-CLI session (so the graph shows the session
    // you're working in, even if you never clicked Apply at launch).
    if (orchestrationApi && orchestrationApi.open) runGuiBtn.addEventListener('click', () => openRunGui(activeObserveSeed()));
    else runGuiBtn.style.display = 'none';
  }
  const orchOptsBtn = root.querySelector('.terminal-orch-opts-btn');
  if (orchOptsBtn) {
    if (hooks.openModal) orchOptsBtn.addEventListener('click', openOrchestrationOptions);
    else orchOptsBtn.style.display = 'none';
  }
  const newPopover = root.querySelector('.terminal-new-popover');
  const shellList = root.querySelector('.terminal-shell-list');
  const newCwdInput = root.querySelector('.terminal-new-cwd input');
  const stage = root.querySelector('.terminal-pty-stage');
  const emptyState = root.querySelector('.terminal-pty-empty');
  const emptyNewBtn = root.querySelector('.terminal-empty-new');
  const blockDrawer = root.querySelector('.terminal-block-drawer');
  const blockCount = root.querySelector('.terminal-block-count');
  const blockList = root.querySelector('.terminal-block-list');
  const draft = root.querySelector('.terminal-draft');
  const draftPre = root.querySelector('.terminal-draft pre');
  const draftPaste = root.querySelector('.terminal-draft-paste');
  const draftCopy = root.querySelector('.terminal-draft-copy');
  const draftClose = root.querySelector('.terminal-draft-close');

  const sessions = [];
  let activeId = '';
  let shells = [];
  let shellsPromise = null;
  let shellProfilesLoading = false;
  let terminalStarting = false;
  let removePtyListener = null;
  let restored = false;
  let draftText = '';
  let newPopoverOpen = false;
  let newPopoverPoint = null;
  let pendingNewCwd = '';
  let ptyStatus = available ? { available: true } : { available: false, reason: t('terminal.desktopOnly.full') };

  function defaultCwd() {
    return hooks.getWorkspacePath?.() || hooks.getActiveTab?.()?.dirPath || '';
  }

  function setStatus(text) {
    statusEl.textContent = text || '';
  }

  function refreshLocale() {
    const newHead = root.querySelector('.terminal-new-popover-head');
    const newTitle = newHead?.querySelector('strong');
    const newSubtitle = newHead?.querySelector('span');
    if (newTitle) newTitle.textContent = t('terminal.new.title');
    if (newSubtitle) newSubtitle.textContent = t('terminal.new.subtitle');
    const cwdLabel = root.querySelector('.terminal-new-cwd span');
    if (cwdLabel) cwdLabel.textContent = t('terminal.cwd');
    const draftTitle = root.querySelector('.terminal-draft strong');
    const draftSubtitle = root.querySelector('.terminal-draft span');
    if (draftTitle) draftTitle.textContent = t('terminal.draft.title');
    if (draftSubtitle) draftSubtitle.textContent = t('terminal.draft.subtitle');
    draftPaste.textContent = t('terminal.draft.paste');
    draftCopy.textContent = t('terminal.action.copy');
    draftClose.textContent = t('terminal.draft.dismiss');
    const emptyTitle = root.querySelector('.terminal-pty-empty strong');
    const emptySubtitle = root.querySelector('.terminal-pty-empty span');
    if (emptyTitle) emptyTitle.textContent = t('terminal.empty.title');
    if (emptySubtitle) emptySubtitle.textContent = t('terminal.empty.subtitle');
    if (emptyNewBtn) emptyNewBtn.textContent = t('terminal.empty.selectShell');
    const drawerTitle = root.querySelector('.terminal-block-drawer summary span:first-child');
    if (drawerTitle) drawerTitle.textContent = t('terminal.blocks.title');
    renderTabs();
    renderNewTerminalPanel();
    updateActiveContext();
  }

  function setControlsEnabled(enabled) {
    root.querySelectorAll('.terminal-shell-card, .terminal-empty-new, .terminal-tab-add').forEach(button => {
      button.disabled = !enabled || terminalStarting || button.dataset.available === 'false';
    });
  }

  function activeSession() {
    return sessions.find(item => item.id === activeId) || null;
  }

  function updateEmptyState() {
    emptyState?.classList.toggle('hidden', sessions.length > 0);
  }

  function updateActiveContext() {
    const session = activeSession();
    if (!activeContextEl) return;
    if (!session) {
      activeContextEl.textContent = t('terminal.context.none');
      return;
    }
    const cwd = fileName(session.cwd) || session.cwd || t('terminal.context.workspace');
    activeContextEl.textContent = `${session.shell?.label || 'Shell'} - ${cwd}`;
  }

  function updateBlockCount() {
    const count = activeSession()?.blocks?.length || 0;
    if (blockCount) blockCount.textContent = String(count);
    blockDrawer?.classList.toggle('hidden', count === 0);
  }

  function fitActiveTerminal() {
    const session = activeSession();
    if (!session) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          session.fitAddon.fit();
          window.pty.resize(session.id, session.term.cols, session.term.rows);
          session.term.refresh(0, Math.max(0, session.term.rows - 1));
          session.term.focus();
        } catch {}
      });
    });
  }

  function renderTabs() {
    tabStrip.innerHTML = '';
    for (const session of sessions) {
      const item = el('button', `terminal-tab ${session.id === activeId ? 'active' : ''}`);
      item.type = 'button';
      item.draggable = true;
      item.dataset.sessionId = session.id;
      item.title = session.cwd || session.shell?.label || t('terminal.title');
      item.appendChild(el('span', '', session.title || session.shell?.label || t('terminal.title')));
      const close = el('span', 'terminal-tab-close', 'x');
      item.appendChild(close);
      item.addEventListener('click', () => activateSession(session.id));
      item.addEventListener('mousedown', (event) => {
        if (event.button === 1) {
          event.preventDefault();
          closeSession(session.id);
        }
      });
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        closeSession(session.id);
      });
      item.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/plain', session.id);
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => item.classList.remove('dragging'));
      item.addEventListener('dragover', (event) => {
        event.preventDefault();
        item.classList.add('drag-over-tab');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over-tab'));
      item.addEventListener('drop', (event) => {
        event.preventDefault();
        item.classList.remove('drag-over-tab');
        const draggedId = event.dataTransfer.getData('text/plain');
        const from = sessions.findIndex(found => found.id === draggedId);
        const to = sessions.findIndex(found => found.id === session.id);
        if (from >= 0 && to >= 0 && from !== to) {
          const [moved] = sessions.splice(from, 1);
          sessions.splice(to, 0, moved);
          renderTabs();
        }
      });
      tabStrip.appendChild(item);
    }
    const add = el('button', 'terminal-tab terminal-tab-add', '+');
    add.type = 'button';
    add.title = t('terminal.new.selectShellTitle');
    add.disabled = !available || terminalStarting;
    add.addEventListener('click', (event) => openNewTerminalPanel(event));
    tabStrip.appendChild(add);
    setControlsEnabled(available && ptyStatus.available !== false);
    updateEmptyState();
    updateBlockCount();
    updateActiveContext();
  }

  function resolveNewPopoverPoint(trigger) {
    if (trigger && Number.isFinite(trigger.clientX) && Number.isFinite(trigger.clientY)) {
      return { x: trigger.clientX, y: trigger.clientY };
    }
    const target = trigger?.currentTarget || trigger?.target || root.querySelector('.terminal-tab-add') || emptyNewBtn || root;
    const rect = target.getBoundingClientRect?.();
    if (!rect) return { x: 16, y: 48 };
    return { x: rect.left, y: rect.bottom };
  }

  function positionNewTerminalPopover() {
    if (!newPopoverOpen || !newPopoverPoint) return;
    const margin = 8;
    const offset = 6;
    const rect = newPopover.getBoundingClientRect();
    const width = rect.width || 360;
    const height = rect.height || 280;
    let left = newPopoverPoint.x;
    let top = newPopoverPoint.y + offset;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
    if (top + height > window.innerHeight - margin) top = newPopoverPoint.y - height - offset;
    newPopover.style.left = `${Math.max(margin, Math.round(left))}px`;
    newPopover.style.top = `${Math.max(margin, Math.round(top))}px`;
  }

  function renderNewTerminalPanel() {
    newPopover.classList.toggle('hidden', !newPopoverOpen);
    if (!newPopoverOpen) return;

    if (!pendingNewCwd) pendingNewCwd = defaultCwd();
    newCwdInput.value = pendingNewCwd;
    shellList.innerHTML = '';

    if (!available || ptyStatus.available === false) {
      const message = el('div', 'terminal-shell-empty');
      message.textContent = ptyStatus.reason || t('terminal.unavailable.environment');
      shellList.appendChild(message);
      positionNewTerminalPopover();
      return;
    }

    if (shellProfilesLoading && !shells.length) {
      const loading = el('div', 'terminal-shell-loading');
      loading.append(el('span', 'ai-spinner'), el('span', '', t('terminal.new.detectingProfiles')));
      shellList.appendChild(loading);
      positionNewTerminalPopover();
      return;
    }

    if (!shells.length) {
      const message = el('div', 'terminal-shell-empty');
      message.textContent = t('terminal.new.noProfiles');
      shellList.appendChild(message);
      positionNewTerminalPopover();
      return;
    }

    const firstAvailable = shells.find(item => item.available !== false && item.command)?.id || '';
    const savedPreferred = localStorage.getItem(LAST_SHELL_KEY) || '';
    const preferred = shells.some(item => item.id === savedPreferred && item.available !== false && item.command)
      ? savedPreferred
      : firstAvailable;

    if (terminalStarting) {
      const loading = el('div', 'terminal-shell-loading');
      loading.append(el('span', 'ai-spinner'), el('span', '', t('terminal.new.startingSession')));
      shellList.appendChild(loading);
    }

    const renderProfile = (shell) => {
      const isAvailable = shell.available !== false && Boolean(shell.command);
      const card = el('button', `terminal-shell-card ${shell.id === preferred ? 'preferred' : ''} ${shell.kind === 'ai-cli' ? 'ai-cli' : ''} ${isAvailable ? '' : 'unavailable'}`);
      card.type = 'button';
      card.dataset.profileId = shell.id || '';
      card.dataset.profileKind = shell.kind || 'shell';
      card.dataset.available = isAvailable ? 'true' : 'false';
      card.disabled = !isAvailable || ptyStatus.available === false || terminalStarting;
      card.title = shell.command || shell.label || 'Shell';
      card.appendChild(el('span', 'terminal-shell-icon', shellIcon(shell)));
      const copy = el('span', 'terminal-shell-copy');
      copy.appendChild(el('strong', '', shell.label || shell.id || 'Shell'));
      copy.appendChild(el('small', '', shellDescription(shell)));
      card.appendChild(copy);
      if (!isAvailable) card.appendChild(el('span', 'terminal-shell-badge missing', t('terminal.new.notFound')));
      else if (shell.id === preferred) card.appendChild(el('span', 'terminal-shell-badge', t('terminal.new.defaultBadge')));
      else if (shell.kind === 'ai-cli') card.appendChild(el('span', 'terminal-shell-badge ai', t('terminal.new.aiCliBadge')));
      card.addEventListener('click', () => {
        if (!isAvailable || terminalStarting) return;
        localStorage.setItem(LAST_SHELL_KEY, shell.id);
        newTerminal({ shell: shell.id, cwd: newCwdInput.value.trim() || defaultCwd() });
      });
      shellList.appendChild(card);
    };

    const appendSection = (title, profiles) => {
      if (!profiles.length) return;
      shellList.appendChild(el('div', 'terminal-profile-section-title', title));
      profiles.forEach(renderProfile);
    };

    appendSection(t('terminal.new.shells'), shells.filter(item => item.kind !== 'ai-cli'));
    appendSection(t('terminal.new.aiCliApps'), shells.filter(item => item.kind === 'ai-cli'));
    positionNewTerminalPopover();
  }

  async function openNewTerminalPanel(trigger) {
    newPopoverOpen = true;
    newPopoverPoint = resolveNewPopoverPoint(trigger);
    pendingNewCwd = defaultCwd();
    shellProfilesLoading = available && !shells.length;
    renderNewTerminalPanel();
    if (!available) {
      setStatus(t('terminal.new.desktopOnly'));
      return;
    }
    await ensureShells();
    renderNewTerminalPanel();
    setTimeout(() => newCwdInput?.focus(), 0);
  }

  function closeNewTerminalPanel(options = {}) {
    newPopoverOpen = false;
    newPopoverPoint = null;
    renderNewTerminalPanel();
    if (options.focus !== false) activeSession()?.term.focus();
  }

  function handleDocumentPointerDown(event) {
    if (!newPopoverOpen) return;
    const target = event.target;
    if (newPopover.contains(target)) return;
    if (target?.closest?.('.terminal-tab-add, .terminal-empty-new')) return;
    closeNewTerminalPanel({ focus: false });
  }

  function handleDocumentKeyDown(event) {
    if (!newPopoverOpen || event.key !== 'Escape') return;
    event.preventDefault();
    closeNewTerminalPanel();
  }

  function activateSession(id) {
    activeId = id;
    closeNewTerminalPanel();
    for (const session of sessions) {
      session.container.classList.toggle('hidden', session.id !== id);
    }
    const session = activeSession();
    if (session) {
      blockList.innerHTML = '';
      for (const block of [...session.blocks].reverse()) blockList.prepend(block.details);
      fitActiveTerminal();
    }
    renderTabs();
  }

  function askOutsideWorkspace(cwd, workspaceRoot) {
    return new Promise(resolve => {
      let settled = false;
      const finish = (allowed) => {
        if (settled) return;
        settled = true;
        hooks.closeModal?.();
        resolve(allowed);
      };
      const body = el('div', 'terminal-confirm');
      body.innerHTML = `
        <p>${t('terminal.outside.body')}</p>
        <pre></pre>
        <p>${t('terminal.outside.scope')}</p>
      `;
      body.querySelector('pre').textContent = `${t('terminal.workspace')}: ${workspaceRoot || t('terminal.none')}\n${t('terminal.cwd')}: ${cwd}`;
      hooks.openModal?.({
        title: t('terminal.outside.title'),
        body,
        onClose: () => finish(false),
        footer: [
          { label: t('dialog.cancel'), onClick: () => finish(false) },
          { label: t('terminal.allowOnce'), primary: true, onClick: () => finish(true) },
        ],
      });
    });
  }

  async function ensurePtyAvailable() {
    if (!available) {
      setStatus(ptyStatus.reason);
      setControlsEnabled(false);
      return false;
    }
    ptyStatus = await window.pty.status().catch(err => ({
      available: false,
      reason: err.message || String(err),
    }));
    if (!ptyStatus.available) {
      setStatus(ptyStatus.reason || t('terminal.unavailable.build'));
      setControlsEnabled(false);
      return false;
    }
    return true;
  }

  async function ensureShells() {
    if (shells.length) return shells;
    if (!available) return [];
    if (!shellsPromise) {
      shellProfilesLoading = true;
      renderNewTerminalPanel();
      shellsPromise = window.pty.shells()
        .catch(err => {
          setStatus(err.message || String(err));
          return [];
        })
        .then(result => {
          shells = result || [];
          return shells;
        })
        .finally(() => {
          shellProfilesLoading = false;
          shellsPromise = null;
          renderNewTerminalPanel();
          renderTabs();
        });
    }
    return shellsPromise;
  }

  function createTerminalSession(info, opts = {}) {
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const serializeAddon = new SerializeAddon();
    const term = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'Cascadia Mono, Consolas, Menlo, monospace',
      fontSize: 13,
      theme: terminalTheme(),
      scrollback: 5000,
    });
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(searchAddon);
    term.loadAddon(serializeAddon);
    try {
      term.loadAddon(new WebglAddon());
    } catch {}

    const container = el('div', 'terminal-pty-container');
    stage.appendChild(container);
    term.open(container);
    const copyCurrentSelection = () => {
      setTimeout(() => {
        if (!term.hasSelection?.()) return;
        copyTerminalSelection(term).catch(() => {});
      }, 0);
    };
    term.attachCustomKeyEventHandler((event) => {
      const key = String(event.key || '').toLowerCase();
      const mod = event.ctrlKey || event.metaKey;
      // Copy: Ctrl/Cmd+C ONLY when there's a selection (otherwise Ctrl+C must pass through as SIGINT), or the
      // explicit Ctrl+Shift+C. Routed through the OS clipboard via writeClipboardText.
      const copyShortcut = mod && key === 'c';
      const explicitCopyShortcut = event.ctrlKey && event.shiftKey && key === 'c';
      if ((copyShortcut || explicitCopyShortcut) && term.hasSelection?.()) {
        if (event.type === 'keydown') copyTerminalSelection(term).catch(() => {});
        event.preventDefault();
        event.stopPropagation();
        return false;
      }
      // Paste: Ctrl+V / Ctrl+Shift+V (Win/Linux) or Cmd+V (mac). Routed through term.paste(), which honors the
      // app's bracketed-paste mode — so a multi-line paste reaches claude/readline as ONE paste (not line-by-line
      // Enters that submit early). (We restored plain Ctrl+V because that's what users actually press to paste.)
      const pasteShortcut = mod && key === 'v';
      if (pasteShortcut) {
        if (event.type === 'keydown') {
          const read = (typeof window !== 'undefined' && window.clipboard?.readText)
            ? window.clipboard.readText()
            : (navigator.clipboard?.readText ? navigator.clipboard.readText() : Promise.resolve(''));
          Promise.resolve(read).then((text) => {
            if (!text) return;
            if (typeof term.paste === 'function') term.paste(text); // bracketed-paste aware; fires onData -> PTY
            else window.pty.write(session.id, text);
          }).catch(() => {});
        }
        event.preventDefault();
        event.stopPropagation();
        return false;
      }
      return true;
    });
    container.addEventListener('mouseup', copyCurrentSelection);
    container.addEventListener('touchend', copyCurrentSelection);

    const session = {
      id: info.sessionId,
      term,
      fitAddon,
      searchAddon,
      serializeAddon,
      container,
      shell: info.shell,
      cwd: info.cwd,
      title: terminalTabTitle(info),
      blocks: [],
      blockList,
      hooks,
      renderTabs,
      renderBlockCount: updateBlockCount,
      isActive: () => session.id === activeId,
      commandBuffer: '',
      pendingCommand: '',
      currentBlock: null,
      oscBuffer: '',
    };

    term.onData(data => {
      processTypedBuffer(session, data);
      window.pty.write(session.id, data);
    });

    const resizeObserver = new ResizeObserver(() => {
      if (session.id !== activeId) return;
      fitAddon.fit();
      window.pty.resize(session.id, term.cols, term.rows);
    });
    resizeObserver.observe(container);
    // Also observe the STAGE: when the command-blocks drawer appears/grows it shrinks the stage (flex sibling),
    // but the absolutely-positioned container's intrinsic size may not fire on its own — without this the xterm
    // keeps the old row count and the drawer overlaps/clips the bottom rows of a TUI.
    resizeObserver.observe(stage);
    session.resizeObserver = resizeObserver;

    sessions.push(session);
    activateSession(session.id);
    fitActiveTerminal();
    setStatus(fmt('terminal.maskedEnv', { count: info.maskedEnvCount || 0 }));
    track?.('terminal_pty_spawn', { shell: info.shell?.id || 'unknown' });
    // Launching an AI CLI TUI offers to observe it as a live graph — but NOT for tabs re-created on startup by
    // restoreSaved (that would pop a modal per restored AI-CLI tab on every launch).
    if (!opts.fromRestore && info.shell && info.shell.kind === 'ai-cli') {
      try { offerOrchestration(info); } catch (_) { /* non-fatal */ }
    }
    return session;
  }

  async function newTerminal(options = {}) {
    if (!await ensurePtyAvailable()) {
      return null;
    }
    try {
      await ensureShells();
      const workspaceRoot = hooks.getWorkspacePath?.() || '';
      const cwd = options.cwd || defaultCwd();
      let allowOutsideWorkspace = options.allowOutsideWorkspace === true;
      if (!allowOutsideWorkspace && (!workspaceRoot || !isInsidePath(cwd, workspaceRoot))) {
        allowOutsideWorkspace = await askOutsideWorkspace(cwd, workspaceRoot);
        if (!allowOutsideWorkspace) {
          setStatus(t('terminal.start.canceled'));
          return null;
        }
      }
      const firstAvailable = shells.find(item => item.available !== false && item.command)?.id || '';
      const savedPreferred = localStorage.getItem(LAST_SHELL_KEY) || '';
      const preferredAvailable = shells.find(item => item.id === savedPreferred && item.available !== false && item.command);
      const selectedShell = options.shell || preferredAvailable?.id || firstAvailable;
      setStatus(t('terminal.start.startingShell'));
      terminalStarting = true;
      renderTabs();
      renderNewTerminalPanel();
      const info = await window.pty.spawn({
        shell: selectedShell,
        cwd,
        workspaceRoot,
        allowOutsideWorkspace,
        cols: 100,
        rows: 28,
        restore: options.restore !== false,
      });
      return createTerminalSession(info, { fromRestore: options.fromRestore === true });
    } catch (err) {
      setStatus(err.message || String(err));
      hooks.notify?.('Terminal', err);
      return null;
    } finally {
      terminalStarting = false;
      renderTabs();
      renderNewTerminalPanel();
    }
  }

  function closeSession(id) {
    const index = sessions.findIndex(item => item.id === id);
    if (index < 0) return;
    const [session] = sessions.splice(index, 1);
    session.disposed = true; // a queued rAF flush must not touch the disposed term
    try { session.resizeObserver?.disconnect(); } catch {}
    try { session.term.dispose(); } catch {}
    try { session.container.remove(); } catch {}
    window.pty?.kill(id);
    if (activeId === id) activeId = sessions[Math.max(0, index - 1)]?.id || sessions[0]?.id || '';
    if (activeId) activateSession(activeId);
    else {
      blockList.innerHTML = '';
      renderTabs();
    }
    updateEmptyState();
  }

  function handlePtyEvent(payload) {
    if (!payload?.sessionId) return;
    const session = sessions.find(item => item.id === payload.sessionId);
    if (!session) return;
    if (payload.type === 'data') {
      // Buffer the chunk and flush once per animation frame (coalesced) instead of writing per chunk.
      session.pendingData = (session.pendingData || '') + (payload.chunk || '');
      // Safety valve for a hidden window (no rAF): drain immediately once the buffer is large, so it can't grow
      // unbounded under a high-output workload while minimized.
      if (session.pendingData.length >= MAX_PENDING_FLUSH) {
        flushSessionData(session);
        return;
      }
      if (!session.flushScheduled) {
        session.flushScheduled = true;
        requestAnimationFrame(() => flushSessionData(session));
      }
      return;
    }
    if (payload.type === 'exit') {
      flushSessionData(session); // drain any buffered output before the exit notice
      if (session.currentBlock) finishCommandBlock(session, payload.exitCode ?? null);
      session.term.writeln('');
      session.term.writeln(fmt('terminal.processExitedLine', { code: payload.exitCode ?? t('terminal.unknown') }));
      session.title = fmt('terminal.session.exitedTitle', { title: session.title || t('terminal.title') });
      renderTabs();
      setStatus(t('terminal.start.processExited'));
    }
  }

  async function restoreSaved() {
    if (restored || !await ensurePtyAvailable()) return;
    restored = true;
    try {
      await ensureShells();
      const saved = await window.pty.restore();
      const workspaceRoot = hooks.getWorkspacePath?.() || '';
      for (const item of saved || []) {
        if (workspaceRoot && !isInsidePath(item.cwd, workspaceRoot)) continue;
        await newTerminal({ shell: item.shell, cwd: item.cwd, allowOutsideWorkspace: true, restore: true, fromRestore: true });
      }
    } catch {}
  }

  function showDraft(command) {
    draftText = String(command || '').trim();
    if (!draftText) return;
    draftPre.textContent = draftText;
    draft.classList.remove('hidden');
    activate();
  }

  async function pasteDraft() {
    if (!draftText) return;
    if (/\r|\n/.test(draftText)) {
      hooks.notify?.(t('terminal.title'), new Error(t('terminal.start.multilineCopyOnly')));
      return;
    }
    let session = activeSession();
    if (!session) session = await newTerminal();
    if (!session) return;
    window.pty.write(session.id, draftText);
    draft.classList.add('hidden');
    session.term.focus();
  }

  async function activate() {
    if (!available) {
      setStatus(ptyStatus.reason);
      setControlsEnabled(false);
      return;
    }
    await ensureShells();
    if (!sessions.length) {
      setStatus(shells.length ? t('terminal.start.chooseShell') : t('terminal.start.noProfilesStatus'));
      renderTabs();
      return;
    }
    activeSession()?.term.focus();
  }

  emptyNewBtn?.addEventListener('click', (event) => openNewTerminalPanel(event));
  newCwdInput?.addEventListener('input', () => {
    pendingNewCwd = newCwdInput.value;
  });
  newCwdInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeNewTerminalPanel();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const savedPreferred = localStorage.getItem(LAST_SHELL_KEY) || '';
      const preferred = shells.find(item => item.id === savedPreferred && item.available !== false && item.command)?.id
        || shells.find(item => item.available !== false && item.command)?.id;
      if (preferred) {
        newTerminal({ shell: preferred, cwd: newCwdInput.value.trim() || defaultCwd() });
      }
    }
  });
  document.addEventListener('pointerdown', handleDocumentPointerDown, true);
  document.addEventListener('keydown', handleDocumentKeyDown, true);
  window.addEventListener('resize', positionNewTerminalPopover);
  draftPaste.addEventListener('click', pasteDraft);
  draftCopy.addEventListener('click', async () => {
    if (draftText) await navigator.clipboard.writeText(draftText);
  });
  draftClose.addEventListener('click', () => draft.classList.add('hidden'));

  if (available) {
    removePtyListener = window.pty.onEvent(handlePtyEvent);
    if (Array.isArray(window.__orpadTerminalPtyListeners) && !window.__orpadTerminalPtyListeners.includes(handlePtyEvent)) {
      window.__orpadTerminalPtyListeners.push(handlePtyEvent);
    }
    ensureShells().catch(() => {});
  } else {
    setControlsEnabled(false);
    setStatus(t('terminal.new.desktopOnly'));
  }
  renderTabs();

  return {
    activate,
    newTerminal,
    prefill(command) {
      showDraft(command);
    },
    openNewTerminalPanel,
    layoutChanged() {
      fitActiveTerminal();
    },
    focus() {
      activeSession()?.term.focus();
    },
    sessionCount() {
      return sessions.length;
    },
    refreshLocale,
    getLastOutput() {
      const block = latestFinishedBlock(sessions);
      return block ? {
        runId: block.id,
        source: 'terminal',
        commandLine: block.commandLine,
        cwd: block.cwd,
        exitCode: block.exitCode,
        output: stripAnsi(block.output || ''),
        finishedAt: block.finishedAt,
      } : null;
    },
    destroy() {
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      document.removeEventListener('keydown', handleDocumentKeyDown, true);
      window.removeEventListener('resize', positionNewTerminalPopover);
      if (removePtyListener) removePtyListener();
      if (Array.isArray(window.__orpadTerminalPtyListeners)) {
        window.__orpadTerminalPtyListeners = window.__orpadTerminalPtyListeners
          .filter(listener => listener !== handlePtyEvent);
      }
      for (const session of sessions.slice()) closeSession(session.id);
    },
  };
}
