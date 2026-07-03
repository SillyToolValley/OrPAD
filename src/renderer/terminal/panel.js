import { createPtyTerminalGroup } from './pty-view.js';
import { t } from '../i18n.js';

const SHELL_OPERATORS = new Set(['&&', '||', ';', '|', '>', '>>', '<', '&']);
const MAX_RENDERED_CHARS = 240_000;
const DEFAULT_MAX_COMMAND_BLOCKS = 120;
const TERMINAL_LAYOUT_KEY = 'orpad-terminal-layout-state';
const TERMINAL_LAYOUTS = ['bottom', 'left', 'right', 'floating'];
const TERMINAL_DOCK_TARGETS = ['left', 'right', 'bottom', 'floating'];
const DOCK_DRAG_THRESHOLD = 8;
const EDGE_DOCK_ZONE = 86;
const DEFAULT_LAYOUT_STATE = {
  layout: 'bottom',
  sizes: { bottom: 360, left: 480, right: 480 },
  floating: { x: 96, y: 86, width: 820, height: 520 },
};

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

function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function quoteCommand(tokens) {
  return tokens.map(token => /\s/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token).join(' ');
}

function tokenizeCommandLine(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error(t('terminal.runner.error.emptyCommand'));
  const tokens = [];
  let current = '';
  let quote = '';
  let escaping = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += '\\';
  if (quote) throw new Error(t('terminal.runner.error.unclosedQuote'));
  if (current) tokens.push(current);
  if (!tokens.length) throw new Error(t('terminal.runner.error.emptyCommand'));
  const op = tokens.find(token => SHELL_OPERATORS.has(token));
  if (op) {
    throw new Error(fmt('terminal.runner.error.shellOperator', { op }));
  }
  return { command: tokens[0], args: tokens.slice(1), commandLine: raw };
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

function truncateForUi(text) {
  const raw = stripAnsi(text);
  if (raw.length <= MAX_RENDERED_CHARS) return raw;
  return `${raw.slice(0, MAX_RENDERED_CHARS)}\n\n${fmt('terminal.output.truncated', { count: MAX_RENDERED_CHARS })}`;
}

function commandBlockRetentionLimit() {
  const testOverride = typeof window !== 'undefined'
    ? Number(window.__ORPAD_TERMINAL_HISTORY_LIMIT__)
    : NaN;
  const limit = Number.isFinite(testOverride) ? testOverride : DEFAULT_MAX_COMMAND_BLOCKS;
  return Math.max(1, Math.floor(limit));
}

function nowId() {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value, min, max) {
  const next = Number(value);
  if (!Number.isFinite(next)) return min;
  return Math.max(min, Math.min(max, next));
}

function loadLayoutState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TERMINAL_LAYOUT_KEY) || '{}');
    const layout = TERMINAL_LAYOUTS.includes(parsed.layout) && parsed.layout !== 'floating'
      ? parsed.layout
      : DEFAULT_LAYOUT_STATE.layout;
    return {
      layout,
      sizes: {
        ...DEFAULT_LAYOUT_STATE.sizes,
        ...(parsed.sizes && typeof parsed.sizes === 'object' ? parsed.sizes : {}),
      },
      floating: {
        ...DEFAULT_LAYOUT_STATE.floating,
        ...(parsed.floating && typeof parsed.floating === 'object' ? parsed.floating : {}),
      },
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_LAYOUT_STATE));
  }
}

export function createTerminalPanel({ hooks, track }) {
  const available = typeof window !== 'undefined' && !!window.terminal;
  const statusbar = document.getElementById('statusbar');
  const workspace = document.getElementById('workspace');
  const root = el('section', 'terminal-panel hidden');
  root.innerHTML = `
    <div class="terminal-head">
      <div>
        <strong>${t('terminal.title')}</strong>
        <span>${t('terminal.subtitle')}</span>
      </div>
      <div class="terminal-head-actions">
        <div class="terminal-mode-tabs">
          <button type="button" data-terminal-mode="terminal" class="active">${t('terminal.mode.terminal')}</button>
          <button type="button" data-terminal-mode="runner">${t('terminal.mode.runner')}</button>
        </div>
        <span class="terminal-dock-hint" role="img"><span aria-hidden="true"></span></span>
        <span class="terminal-env"></span>
        <button type="button" class="terminal-cancel" disabled>${t('terminal.cancel')}</button>
        <button type="button" class="terminal-close" aria-label="${t('terminal.closeTerminal')}" title="${t('terminal.closeTerminal')}"><span aria-hidden="true"></span></button>
      </div>
    </div>
    <div class="terminal-runner-view hidden">
      <div class="terminal-banner">${t('terminal.runner.banner')}</div>
      <div class="terminal-cwd-row">
        <label>${t('terminal.cwd')} <input type="text" class="terminal-cwd"></label>
      </div>
      <div class="terminal-output"></div>
      <form class="terminal-form">
        <span>&gt;</span>
        <input type="text" class="terminal-input" autocomplete="off" spellcheck="false" list="terminal-history-list" placeholder="node -v">
        <datalist id="terminal-history-list"></datalist>
        <button type="submit">${t('modal.run')}</button>
      </form>
    </div>
    <div class="terminal-pty-view"></div>
    <div class="terminal-resize-handle" aria-hidden="true"></div>
  `;
  document.body.insertBefore(root, statusbar || null);
  const dockOverlay = el('div', 'terminal-dock-overlay hidden');
  dockOverlay.innerHTML = `
    <div class="terminal-dock-preview"></div>
    <div class="terminal-dock-guide">
      <div class="terminal-dock-target terminal-dock-left" data-terminal-dock-target="left" role="img"><span class="terminal-dock-icon" aria-hidden="true"></span><span class="terminal-dock-label"></span></div>
      <div class="terminal-dock-target terminal-dock-float" data-terminal-dock-target="floating" role="img"><span class="terminal-dock-icon" aria-hidden="true"></span><span class="terminal-dock-label"></span></div>
      <div class="terminal-dock-target terminal-dock-right" data-terminal-dock-target="right" role="img"><span class="terminal-dock-icon" aria-hidden="true"></span><span class="terminal-dock-label"></span></div>
      <div class="terminal-dock-target terminal-dock-bottom" data-terminal-dock-target="bottom" role="img"><span class="terminal-dock-icon" aria-hidden="true"></span><span class="terminal-dock-label"></span></div>
    </div>
  `;
  document.body.appendChild(dockOverlay);

  const envEl = root.querySelector('.terminal-env');
  const cwdInput = root.querySelector('.terminal-cwd');
  const outputEl = root.querySelector('.terminal-output');
  const form = root.querySelector('.terminal-form');
  const input = root.querySelector('.terminal-input');
  const runBtn = root.querySelector('.terminal-form button');
  const cancelBtn = root.querySelector('.terminal-cancel');
  const closeBtn = root.querySelector('.terminal-close');
  const historyList = root.querySelector('#terminal-history-list');
  const runnerView = root.querySelector('.terminal-runner-view');
  const ptyView = root.querySelector('.terminal-pty-view');
  const modeBtns = Array.from(root.querySelectorAll('.terminal-mode-tabs button'));
  const resizeHandle = root.querySelector('.terminal-resize-handle');
  const dockPreview = dockOverlay.querySelector('.terminal-dock-preview');
  const dockTargets = Array.from(dockOverlay.querySelectorAll('[data-terminal-dock-target]'));

  function dockTargetLabel(layout) {
    if (layout === 'left') return t('terminal.dock.left');
    if (layout === 'right') return t('terminal.dock.right');
    if (layout === 'bottom') return t('terminal.dock.bottom');
    return t('terminal.dock.window');
  }

  function refreshDockTargetLabels() {
    for (const target of dockTargets) {
      const label = dockTargetLabel(target.dataset.terminalDockTarget);
      target.setAttribute('aria-label', label);
      target.setAttribute('title', label);
      const text = target.querySelector('.terminal-dock-label');
      if (text) text.textContent = label;
    }
  }

  function refreshDockHintLabel() {
    const dragHint = root.querySelector('.terminal-dock-hint');
    if (!dragHint) return;
    const label = t('terminal.dragHint');
    dragHint.setAttribute('aria-label', label);
    dragHint.setAttribute('title', label);
  }

  function refreshCloseButtonLabel() {
    closeBtn.setAttribute('aria-label', t('terminal.closeTerminal'));
    closeBtn.setAttribute('title', t('terminal.closeTerminal'));
  }

  const blocks = [];
  let activeRunId = '';
  let activeBlock = null;
  let removeTerminalListener = null;
  let activeMode = 'terminal';
  let ptyGroup = null;
  let layoutState = loadLayoutState();
  let terminalLayout = layoutState.layout;
  let resizeState = null;
  let dockDragState = null;
  let removeTerminalWindowDockListener = null;
  const handleWindowResize = () => applyTerminalLayout({ persist: false });

  function ensurePtyGroup() {
    if (!ptyGroup) {
      ptyGroup = createPtyTerminalGroup({
        mount: ptyView,
        hooks,
        track,
      });
    }
    return ptyGroup;
  }

  function refreshLocale() {
    const title = root.querySelector('.terminal-head strong');
    const subtitle = root.querySelector('.terminal-head span');
    if (title) title.textContent = t('terminal.title');
    if (subtitle) subtitle.textContent = t('terminal.subtitle');
    root.querySelector('[data-terminal-mode="terminal"]').textContent = t('terminal.mode.terminal');
    root.querySelector('[data-terminal-mode="runner"]').textContent = t('terminal.mode.runner');
    refreshDockHintLabel();
    refreshCloseButtonLabel();
    cancelBtn.textContent = t('terminal.cancel');
    root.querySelector('.terminal-banner').textContent = t('terminal.runner.banner');
    const cwdLabel = root.querySelector('.terminal-cwd-row label');
    if (cwdLabel?.firstChild) cwdLabel.firstChild.textContent = `${t('terminal.cwd')} `;
    runBtn.textContent = t('modal.run');
    refreshDockTargetLabels();
    ptyGroup?.refreshLocale?.();
  }

  function saveLayoutState() {
    localStorage.setItem(TERMINAL_LAYOUT_KEY, JSON.stringify(layoutState));
  }

  function currentFloatingGeometry() {
    const margin = 10;
    const maxWidth = Math.max(420, window.innerWidth - margin * 2);
    const maxHeight = Math.max(280, window.innerHeight - margin * 2);
    const width = clamp(layoutState.floating.width, 420, maxWidth);
    const height = clamp(layoutState.floating.height, 280, maxHeight);
    return {
      width,
      height,
      x: clamp(layoutState.floating.x, margin, Math.max(margin, window.innerWidth - width - margin)),
      y: clamp(layoutState.floating.y, margin, Math.max(margin, window.innerHeight - height - margin)),
    };
  }

  function dockPreviewGeometry(layout, point = {}) {
    const margin = 10;
    const workspaceRect = workspace?.getBoundingClientRect?.();
    const statusRect = statusbar?.getBoundingClientRect?.();
    const top = Math.max(0, Math.round(workspaceRect?.top || 105));
    const bottom = Math.max(0, Math.round(window.innerHeight - (statusRect?.top || window.innerHeight - 24)));
    const availableHeight = Math.max(280, window.innerHeight - top - bottom);
    if (layout === 'left') {
      const width = clamp(layoutState.sizes.left, 320, Math.max(320, window.innerWidth - 180));
      return { x: 0, y: top, width, height: availableHeight };
    }
    if (layout === 'right') {
      const width = clamp(layoutState.sizes.right, 320, Math.max(320, window.innerWidth - 180));
      return { x: window.innerWidth - width, y: top, width, height: availableHeight };
    }
    if (layout === 'bottom') {
      const height = clamp(layoutState.sizes.bottom, 260, Math.max(260, window.innerHeight - 160));
      return { x: 0, y: window.innerHeight - bottom - height, width: window.innerWidth, height };
    }
    const width = clamp(layoutState.floating.width, 420, Math.max(420, window.innerWidth - margin * 2));
    const height = clamp(layoutState.floating.height, 280, Math.max(280, window.innerHeight - margin * 2));
    return {
      width,
      height,
      x: clamp((point.x || window.innerWidth / 2) - width / 2, margin, window.innerWidth - width - margin),
      y: clamp((point.y || window.innerHeight / 2) - 28, margin, window.innerHeight - height - margin),
    };
  }

  function targetFromDockGuide(point) {
    for (const target of dockTargets) {
      const rect = target.getBoundingClientRect();
      if (
        point.x >= rect.left
        && point.x <= rect.right
        && point.y >= rect.top
        && point.y <= rect.bottom
      ) {
        return target.dataset.terminalDockTarget;
      }
    }
    return '';
  }

  function targetFromPointer(point) {
    const guideTarget = targetFromDockGuide(point);
    if (guideTarget) return guideTarget;
    if (point.x <= EDGE_DOCK_ZONE) return 'left';
    if (point.x >= window.innerWidth - EDGE_DOCK_ZONE) return 'right';
    if (point.y >= window.innerHeight - EDGE_DOCK_ZONE) return 'bottom';
    return 'floating';
  }

  function updateDockOverlay(point) {
    const target = targetFromPointer(point);
    dockDragState.target = TERMINAL_DOCK_TARGETS.includes(target) ? target : 'floating';
    dockOverlay.classList.remove('hidden');
    dockOverlay.dataset.target = dockDragState.target;
    dockTargets.forEach(item => {
      item.classList.toggle('active', item.dataset.terminalDockTarget === dockDragState.target);
    });
    const geom = dockPreviewGeometry(dockDragState.target, point);
    dockDragState.preview = geom;
    dockPreview.style.left = `${Math.round(geom.x)}px`;
    dockPreview.style.top = `${Math.round(geom.y)}px`;
    dockPreview.style.width = `${Math.round(geom.width)}px`;
    dockPreview.style.height = `${Math.round(geom.height)}px`;
  }

  function hideDockOverlay() {
    dockOverlay.classList.add('hidden');
    dockOverlay.removeAttribute('data-target');
    dockTargets.forEach(item => item.classList.remove('active'));
  }

  function scheduleTerminalFit() {
    if (root.classList.contains('hidden')) return;
    requestAnimationFrame(() => {
      ptyGroup?.layoutChanged?.();
    });
  }

  function updateDockFrameVars() {
    const workspaceRect = workspace?.getBoundingClientRect?.();
    const statusRect = statusbar?.getBoundingClientRect?.();
    const top = Math.max(0, Math.round(workspaceRect?.top || 105));
    const bottom = Math.max(0, Math.round(window.innerHeight - (statusRect?.top || window.innerHeight - 24)));
    document.body.style.setProperty('--terminal-frame-top', `${top}px`);
    document.body.style.setProperty('--terminal-frame-bottom', `${bottom}px`);
  }

  function syncDockBodyState() {
    document.body.classList.remove(
      'terminal-docked-left',
      'terminal-docked-right',
      'terminal-docked-bottom',
      'terminal-docked-floating',
    );
    if (root.classList.contains('hidden')) {
      document.body.style.removeProperty('--terminal-docked-side-size');
      return;
    }
    document.body.classList.add(`terminal-docked-${terminalLayout}`);
    if (terminalLayout === 'left' || terminalLayout === 'right') {
      document.body.style.setProperty('--terminal-docked-side-size', `${layoutState.sizes[terminalLayout]}px`);
    } else {
      document.body.style.removeProperty('--terminal-docked-side-size');
    }
  }

  function applyTerminalLayout({ persist = true } = {}) {
    terminalLayout = TERMINAL_LAYOUTS.includes(terminalLayout) ? terminalLayout : 'bottom';
    updateDockFrameVars();
    layoutState.layout = terminalLayout;
    root.classList.remove(...TERMINAL_LAYOUTS.map(item => `terminal-layout-${item}`));
    root.classList.add(`terminal-layout-${terminalLayout}`);

    if (terminalLayout === 'floating') {
      const geom = currentFloatingGeometry();
      layoutState.floating = geom;
      root.style.left = `${geom.x}px`;
      root.style.top = `${geom.y}px`;
      root.style.width = `${geom.width}px`;
      root.style.height = `${geom.height}px`;
      root.style.removeProperty('--terminal-panel-size');
    } else {
      const size = clamp(layoutState.sizes[terminalLayout], 300, Math.max(320, Math.min(window.innerWidth, window.innerHeight) - 32));
      layoutState.sizes[terminalLayout] = size;
      root.style.setProperty('--terminal-panel-size', `${size}px`);
      root.style.left = '';
      root.style.top = '';
      root.style.width = '';
      root.style.height = '';
    }

    syncDockBodyState();
    if (persist) saveLayoutState();
    scheduleTerminalFit();
  }

  function setTerminalLayout(layout) {
    if (!TERMINAL_LAYOUTS.includes(layout)) return;
    terminalLayout = layout;
    applyTerminalLayout();
    track?.('terminal_layout_change', { layout });
  }

  function setMode(mode) {
    activeMode = mode === 'terminal' ? 'terminal' : 'runner';
    modeBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.terminalMode === activeMode));
    runnerView.classList.toggle('hidden', activeMode !== 'runner');
    ptyView.classList.toggle('hidden', activeMode !== 'terminal');
    cancelBtn.classList.toggle('hidden', activeMode !== 'runner');
    envEl.classList.toggle('hidden', activeMode !== 'runner');
    if (activeMode === 'terminal') {
      ensurePtyGroup().activate();
    }
  }

  function defaultCwd() {
    return hooks.getWorkspacePath?.() || hooks.getActiveTab?.()?.dirPath || '';
  }

  function screenBoundsForFloatingWindow(geom) {
    if (!geom) return null;
    return {
      x: Math.round((window.screenX || 0) + geom.x),
      y: Math.round((window.screenY || 0) + geom.y),
      width: Math.round(geom.width),
      height: Math.round(geom.height),
    };
  }

  async function openDetachedTerminalWindow(preview) {
    if (!window.terminalWindow?.open) {
      if (preview) layoutState.floating = { ...preview };
      setTerminalLayout('floating');
      return false;
    }
    try {
      await window.terminalWindow.open({
        cwd: defaultCwd(),
        bounds: screenBoundsForFloatingWindow(preview),
      });
      root.classList.add('hidden');
      terminalLayout = 'bottom';
      layoutState.layout = 'bottom';
      saveLayoutState();
      applyTerminalLayout({ persist: false });
      syncDockBodyState();
      track?.('terminal_layout_change', { layout: 'detached-window' });
      return true;
    } catch (err) {
      hooks.notify?.('Terminal', err);
      if (preview) layoutState.floating = { ...preview };
      setTerminalLayout('floating');
      return false;
    }
  }

  async function focusDetachedTerminalWindow() {
    if (!window.terminalWindow?.status || !window.terminalWindow?.focus) return false;
    const status = await window.terminalWindow.status().catch(() => null);
    if (!status?.open) return false;
    await window.terminalWindow.focus().catch(() => {});
    return true;
  }

  function refreshCwdIfEmpty() {
    if (!cwdInput.value.trim()) cwdInput.value = defaultCwd();
  }

  function setVisible(visible) {
    root.classList.toggle('hidden', !visible);
    if (visible) {
      applyTerminalLayout({ persist: false });
      refreshCwdIfEmpty();
      if (activeMode === 'terminal') ensurePtyGroup().activate();
      else input.focus();
    } else {
      syncDockBodyState();
    }
  }

  async function toggle(force) {
    const wantsOpen = force === undefined ? root.classList.contains('hidden') : force;
    if (wantsOpen && root.classList.contains('hidden') && await focusDetachedTerminalWindow()) return;
    setVisible(force === undefined ? root.classList.contains('hidden') : force);
  }

  function setRunning(running) {
    input.disabled = running || !available;
    runBtn.disabled = running || !available;
    cancelBtn.disabled = !running;
  }

  function loadHistory() {
    if (!available) return;
    window.terminal.history().then(items => {
      historyList.innerHTML = '';
      for (const command of items || []) {
        const option = document.createElement('option');
        option.value = command;
        historyList.appendChild(option);
      }
    }).catch(() => {});
  }

  function blockMarkdown(block) {
    const command = block.commandLine || quoteCommand([block.command, ...(block.args || [])]);
    return [
      `### Command: \`${command.replace(/`/g, '\\`')}\``,
      '',
      `- CWD: \`${block.cwd || ''}\``,
      `- Exit: ${block.exitCode === null || block.exitCode === undefined ? 'running' : block.exitCode}`,
      '',
      '```text',
      stripAnsi(block.output || ''),
      '```',
      '',
    ].join('\n');
  }

  function dispatchRunnerOutput(block) {
    window.dispatchEvent(new CustomEvent('orpad-runner-output', {
      detail: {
        runId: block.id,
        commandLine: block.commandLine,
        cwd: block.cwd,
        exitCode: block.exitCode,
        output: stripAnsi(block.output || ''),
        finishedAt: block.finishedAt,
      },
    }));
  }

  function disposeRunnerBlock(block) {
    if (!block || block === activeBlock) return;
    if (block.pre) block.pre.textContent = '';
    block.output = '';
    block.details?.remove();
    block.details = null;
    block.pre = null;
    block.badge = null;
  }

  function pruneCompletedRunnerBlocks() {
    const limit = commandBlockRetentionLimit();
    let retained = 0;
    for (let index = 0; index < blocks.length;) {
      const block = blocks[index];
      if (block.finishedAt) {
        retained += 1;
        if (retained > limit) {
          blocks.splice(index, 1);
          disposeRunnerBlock(block);
          continue;
        }
      }
      index += 1;
    }
  }

  function createBlock({ id, commandLine, command, args, cwd }) {
    const block = {
      id,
      commandLine,
      command,
      args,
      cwd,
      output: '',
      exitCode: null,
      startedAt: new Date().toISOString(),
    };
    const details = el('details', 'terminal-block');
    details.open = true;
    const summary = document.createElement('summary');
    const title = el('span', 'terminal-command', `> ${commandLine}`);
    const badge = el('span', 'terminal-badge running', 'running');
    summary.append(title, badge);
    const toolbar = el('div', 'terminal-block-toolbar');
    for (const [label, handler] of [
      [t('terminal.action.copy'), async () => navigator.clipboard.writeText(stripAnsi(block.output || ''))],
      [t('terminal.action.insertEditor'), () => hooks.insertRunnerBlock?.(blockMarkdown(block))],
    ]) {
      const btn = el('button', '', label);
      btn.type = 'button';
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const result = handler();
        if (result?.catch) result.catch(err => hooks.notify?.(t('terminal.mode.runner'), err));
      });
      toolbar.appendChild(btn);
    }
    const pre = document.createElement('pre');
    details.append(summary, toolbar, pre);
    outputEl.prepend(details);
    block.details = details;
    block.pre = pre;
    block.badge = badge;
    blocks.unshift(block);
    return block;
  }

  function appendToBlock(block, stream, chunk) {
    if (!block) return;
    block.output += chunk;
    block.pre.textContent = truncateForUi(block.output);
    block.pre.dataset.stream = stream;
  }

  function finishBlock(block, payload) {
    if (!block) return;
    block.exitCode = payload.code;
    block.signal = payload.signal;
    block.cancelled = payload.cancelled === true;
    block.finishedAt = new Date().toISOString();
    block.badge.classList.remove('running');
    block.badge.classList.toggle('ok', payload.code === 0);
    block.badge.classList.toggle('fail', payload.code !== 0);
    block.badge.textContent = block.cancelled
      ? t('terminal.badge.cancelled')
      : (payload.code === 0 ? t('terminal.badge.exit0') : fmt('terminal.badge.exit', { code: payload.code ?? payload.signal ?? t('terminal.badge.error') }));
    block.details.classList.toggle('terminal-failed', payload.code !== 0);
    activeRunId = '';
    activeBlock = null;
    setRunning(false);
    loadHistory();
    dispatchRunnerOutput(block);
    pruneCompletedRunnerBlocks();
    track?.('terminal_run', {
      command: block.command,
      exit_code: String(payload.code ?? ''),
      success: String(payload.code === 0),
    });
  }

  function showSyntheticError(commandLine, message) {
    const block = createBlock({
      id: nowId(),
      commandLine,
      command: '',
      args: [],
      cwd: cwdInput.value.trim(),
    });
    appendToBlock(block, 'err', `${message}\n`);
    finishBlock(block, { code: 1, signal: null, cancelled: false });
  }

  function handleTerminalEvent(payload) {
    if (!payload || payload.runId !== activeRunId) return;
    if (payload.type === 'start') {
      envEl.textContent = fmt('terminal.maskedEnv', { count: payload.maskedEnvCount || 0 });
      return;
    }
    if (payload.type === 'chunk') {
      appendToBlock(activeBlock, payload.stream, payload.chunk || '');
      return;
    }
    if (payload.type === 'error') {
      appendToBlock(activeBlock, 'err', `\n${payload.message || t('terminal.runner.failedStart')}\n`);
      return;
    }
    if (payload.type === 'timeout') {
      appendToBlock(activeBlock, 'err', `\n${fmt('terminal.runner.timeout', { ms: payload.timeoutMs })}\n`);
      return;
    }
    if (payload.type === 'exit') finishBlock(activeBlock, payload);
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
        <p>${t('terminal.runner.outside.body')}</p>
        <pre></pre>
        <p>${t('terminal.runner.outside.scope')}</p>
      `;
      body.querySelector('pre').textContent = `${t('terminal.workspace')}: ${workspaceRoot || t('terminal.none')}\n${t('terminal.cwd')}: ${cwd}`;
      hooks.openModal?.({
        title: t('terminal.runner.outside.title'),
        body,
        onClose: () => finish(false),
        footer: [
          { label: t('dialog.cancel'), onClick: () => finish(false) },
          { label: t('terminal.allowOnce'), primary: true, onClick: () => finish(true) },
        ],
      });
    });
  }

  async function runFromInput() {
    if (!available) {
      showSyntheticError(input.value, t('terminal.desktopOnly.runner'));
      return;
    }
    if (activeRunId) return;
    let parsed;
    try {
      parsed = tokenizeCommandLine(input.value);
    } catch (err) {
      showSyntheticError(input.value, err.message || String(err));
      return;
    }
    const cwd = cwdInput.value.trim() || defaultCwd();
    const workspaceRoot = hooks.getWorkspacePath?.() || '';
    let allowOutsideWorkspace = false;
    if (!workspaceRoot || !isInsidePath(cwd, workspaceRoot)) {
      allowOutsideWorkspace = await askOutsideWorkspace(cwd, workspaceRoot);
      if (!allowOutsideWorkspace) return;
    }
    const runId = nowId();
    activeRunId = runId;
    activeBlock = createBlock({ id: runId, ...parsed, cwd });
    setRunning(true);
    input.value = '';
    try {
      const result = await window.terminal.run({
        runId,
        commandLine: parsed.commandLine,
        command: parsed.command,
        args: parsed.args,
        cwd,
        workspaceRoot,
        allowOutsideWorkspace,
        timeoutMs: 300_000,
      });
      envEl.textContent = fmt('terminal.maskedEnv', { count: result.maskedEnvCount || 0 });
    } catch (err) {
      appendToBlock(activeBlock, 'err', `${err.message || String(err)}\n`);
      finishBlock(activeBlock, { code: 1, signal: null, cancelled: false });
      hooks.notify?.(t('terminal.mode.runner'), err);
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    runFromInput();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeRunId) {
      event.preventDefault();
      window.terminal?.cancel(activeRunId);
    }
  });
  cancelBtn.addEventListener('click', () => {
    if (activeRunId) window.terminal?.cancel(activeRunId);
  });
  closeBtn.addEventListener('click', () => toggle(false));
  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      setMode(btn.dataset.terminalMode);
      setVisible(true);
    });
  });

  root.querySelector('.terminal-head')?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target?.closest?.('button, input, select, textarea, a')) return;
    dockDragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      target: terminalLayout,
      preview: null,
    };
    root.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  resizeHandle?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rect = root.getBoundingClientRect();
    resizeState = {
      pointerId: event.pointerId,
      layout: terminalLayout,
      startX: event.clientX,
      startY: event.clientY,
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
    root.setPointerCapture?.(event.pointerId);
    root.classList.add('terminal-resizing');
    event.preventDefault();
  });

  root.addEventListener('pointermove', (event) => {
    if (dockDragState && event.pointerId === dockDragState.pointerId) {
      const dx = event.clientX - dockDragState.startX;
      const dy = event.clientY - dockDragState.startY;
      if (!dockDragState.active && Math.hypot(dx, dy) >= DOCK_DRAG_THRESHOLD) {
        dockDragState.active = true;
        root.classList.add('terminal-dock-drag-source');
      }
      if (dockDragState.active) {
        updateDockOverlay({ x: event.clientX, y: event.clientY });
      }
      return;
    }
    if (!resizeState || event.pointerId !== resizeState.pointerId) return;
    if (resizeState.layout === 'floating') {
      const next = {
        x: resizeState.x,
        y: resizeState.y,
        width: clamp(resizeState.width + event.clientX - resizeState.startX, 420, window.innerWidth - resizeState.x - 10),
        height: clamp(resizeState.height + event.clientY - resizeState.startY, 280, window.innerHeight - resizeState.y - 10),
      };
      layoutState.floating = next;
      root.style.width = `${next.width}px`;
      root.style.height = `${next.height}px`;
      scheduleTerminalFit();
      return;
    }
    if (resizeState.layout === 'bottom') {
      const next = clamp(resizeState.height - (event.clientY - resizeState.startY), 260, window.innerHeight - 160);
      layoutState.sizes.bottom = next;
      root.style.setProperty('--terminal-panel-size', `${next}px`);
      scheduleTerminalFit();
      return;
    }
    if (resizeState.layout === 'right') {
      const next = clamp(resizeState.width - (event.clientX - resizeState.startX), 320, window.innerWidth - 180);
      layoutState.sizes.right = next;
      root.style.setProperty('--terminal-panel-size', `${next}px`);
      syncDockBodyState();
      scheduleTerminalFit();
      return;
    }
    if (resizeState.layout === 'left') {
      const next = clamp(resizeState.width + event.clientX - resizeState.startX, 320, window.innerWidth - 180);
      layoutState.sizes.left = next;
      root.style.setProperty('--terminal-panel-size', `${next}px`);
      syncDockBodyState();
      scheduleTerminalFit();
    }
  });

  root.addEventListener('pointerup', (event) => {
    if (dockDragState?.pointerId === event.pointerId) {
      if (dockDragState.active) {
        const target = dockDragState.target || targetFromPointer({ x: event.clientX, y: event.clientY });
        if (target === 'floating') {
          openDetachedTerminalWindow(dockDragState.preview);
        } else {
          setTerminalLayout(TERMINAL_DOCK_TARGETS.includes(target) ? target : 'bottom');
        }
      }
      dockDragState = null;
      root.classList.remove('terminal-dock-drag-source');
      hideDockOverlay();
      root.releasePointerCapture?.(event.pointerId);
      return;
    }
    if (resizeState?.pointerId === event.pointerId) {
      resizeState = null;
      root.classList.remove('terminal-resizing');
      saveLayoutState();
      scheduleTerminalFit();
    }
    root.releasePointerCapture?.(event.pointerId);
  });
  root.addEventListener('pointercancel', (event) => {
    if (dockDragState?.pointerId === event.pointerId) {
      dockDragState = null;
      hideDockOverlay();
    }
    if (resizeState?.pointerId === event.pointerId) resizeState = null;
    root.classList.remove('terminal-dock-drag-source', 'terminal-resizing');
    root.releasePointerCapture?.(event.pointerId);
  });
  window.addEventListener('resize', handleWindowResize);
  if (window.terminalWindow?.onDocked) {
    removeTerminalWindowDockListener = window.terminalWindow.onDocked((payload = {}) => {
      terminalLayout = TERMINAL_LAYOUTS.includes(payload.layout) && payload.layout !== 'floating'
        ? payload.layout
        : 'bottom';
      layoutState.layout = terminalLayout;
      saveLayoutState();
      setMode('terminal');
      setVisible(true);
    });
  }

  document.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    const isBackquote = event.code === 'Backquote' || key === '`';
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && isBackquote) {
      event.preventDefault();
      focusDetachedTerminalWindow().then(focused => {
        if (focused) return;
        toggle(true);
        setMode('terminal');
        ensurePtyGroup().openNewTerminalPanel?.();
      });
      return;
    }
    if ((event.ctrlKey || event.metaKey) && isBackquote) {
      event.preventDefault();
      toggle();
    }
  });

  window.addEventListener('orpad-terminal-prefill', (event) => {
    const command = String(event.detail?.command || event.detail?.text || '').trim();
    if (!command) return;
    toggle(true);
    if (event.detail?.mode === 'terminal' || event.detail?.target === 'terminal') {
      setMode('terminal');
      ensurePtyGroup().prefill(command);
      return;
    }
    setMode('runner');
    input.value = command;
    input.focus();
    input.select();
  });

  if (available) {
    removeTerminalListener = window.terminal.onEvent(handleTerminalEvent);
    loadHistory();
  } else {
    envEl.textContent = 'desktop only';
    setRunning(false);
    input.disabled = true;
    runBtn.disabled = true;
  }

  refreshDockHintLabel();
  refreshCloseButtonLabel();
  refreshDockTargetLabels();
  refreshCwdIfEmpty();
  applyTerminalLayout({ persist: false });

  return {
    toggle,
    openRunner() {
      toggle(true);
      setMode('runner');
      input.focus();
      input.select();
    },
    newTerminal() {
      focusDetachedTerminalWindow().then(focused => {
        if (focused) return;
        toggle(true);
        setMode('terminal');
        ensurePtyGroup().openNewTerminalPanel?.();
      });
    },
    setLayout(layout) {
      setTerminalLayout(layout);
    },
    prefill(command) {
      window.dispatchEvent(new CustomEvent('orpad-terminal-prefill', { detail: { command } }));
    },
    getLastOutput() {
      const block = blocks.find(item => item.finishedAt);
      const runner = block ? {
        runId: block.id,
        source: 'runner',
        commandLine: block.commandLine,
        cwd: block.cwd,
        exitCode: block.exitCode,
        output: stripAnsi(block.output || ''),
        finishedAt: block.finishedAt,
      } : null;
      const terminal = ptyGroup?.getLastOutput?.() || null;
      if (!runner) return terminal;
      if (!terminal) return runner;
      return String(terminal.finishedAt || '') > String(runner.finishedAt || '') ? terminal : runner;
    },
    destroy() {
      if (removeTerminalListener) removeTerminalListener();
      if (removeTerminalWindowDockListener) removeTerminalWindowDockListener();
      window.removeEventListener('resize', handleWindowResize);
      dockOverlay.remove();
      ptyGroup?.destroy?.();
    },
    refreshLocale,
  };
}
