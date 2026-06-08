import { createPtyTerminalGroup } from './terminal/pty-view.js';
import { setLocale, t } from './i18n.js';
import {
  DEFAULT_THEME_ID,
  applyThemeColors,
  builtinThemes,
  deriveFullColors,
  getCustomThemes,
  getSavedThemeId,
} from './themes.js';

const STORAGE_THEME_ID = 'orpad-theme';
const STORAGE_CUSTOM_THEMES = 'orpad-custom-themes';
let activeThemeSignature = '';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function messageFromError(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.message || String(value);
}

function readSavedTheme() {
  const requestedThemeId = getSavedThemeId();
  const customThemes = getCustomThemes();
  const builtinTheme = builtinThemes[requestedThemeId];
  const customTheme = customThemes[requestedThemeId];
  const theme = builtinTheme || customTheme || builtinThemes[DEFAULT_THEME_ID];
  const id = builtinTheme || customTheme ? requestedThemeId : DEFAULT_THEME_ID;
  return { id, theme, isCustom: !builtinTheme && Boolean(customTheme) };
}

function applySavedTerminalTheme() {
  try {
    const { id, theme, isCustom } = readSavedTheme();
    const type = theme.type || 'dark';
    const signature = `${id}:${type}:${JSON.stringify(theme.colors || {})}`;
    if (signature === activeThemeSignature) return;
    const colors = isCustom || !theme.colors ? deriveFullColors(theme.colors || {}, type !== 'light') : theme.colors;
    applyThemeColors(colors);
    document.documentElement.dataset.theme = id;
    document.documentElement.dataset.themeType = type;
    document.documentElement.style.colorScheme = type === 'light' ? 'light' : 'dark';
    activeThemeSignature = signature;
  } catch {
    activeThemeSignature = '';
  }
}

function startTerminalThemeSync() {
  const onStorage = (event) => {
    if (event.key === null || event.key === STORAGE_THEME_ID || event.key === STORAGE_CUSTOM_THEMES) {
      applySavedTerminalTheme();
    }
  };
  const onVisibility = () => {
    if (document.visibilityState !== 'hidden') applySavedTerminalTheme();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener('focus', applySavedTerminalTheme);
  document.addEventListener('visibilitychange', onVisibility);
  const interval = window.setInterval(applySavedTerminalTheme, 1000);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('focus', applySavedTerminalTheme);
    document.removeEventListener('visibilitychange', onVisibility);
    window.clearInterval(interval);
  };
}

async function applyInitialLocale() {
  try {
    const { code } = await window.orpad?.getLocale?.();
    if (code) setLocale(code);
  } catch {}
}

async function createTerminalWindowApp() {
  applySavedTerminalTheme();
  const stopThemeSync = startTerminalThemeSync();
  await applyInitialLocale();
  const root = document.getElementById('terminal-window-root');
  root.className = 'terminal-window-shell';
  root.innerHTML = `
    <header class="terminal-window-head">
      <div>
        <strong>${t('terminal.window.title')}</strong>
        <span class="terminal-window-context">${t('terminal.window.loadingWorkspace')}</span>
      </div>
      <div class="terminal-window-actions">
        <span class="terminal-window-status"></span>
        <button type="button" class="terminal-window-dock">${t('terminal.window.dockToMain')}</button>
        <button type="button" class="terminal-window-close">${t('terminal.window.close')}</button>
      </div>
    </header>
    <section class="terminal-window-stage"></section>
  `;

  const contextEl = root.querySelector('.terminal-window-context');
  const statusEl = root.querySelector('.terminal-window-status');
  const stage = root.querySelector('.terminal-window-stage');
  const dockBtn = root.querySelector('.terminal-window-dock');
  const closeBtn = root.querySelector('.terminal-window-close');
  let modal = null;
  let modalOnClose = null;
  let group = null;
  let context = { workspaceRoot: '', cwd: '' };

  function setStatus(message) {
    statusEl.textContent = message || '';
    statusEl.classList.toggle('active', Boolean(message));
  }

  function refreshLocale() {
    document.title = t('terminal.window.title');
    root.querySelector('.terminal-window-head strong').textContent = t('terminal.window.title');
    dockBtn.textContent = t('terminal.window.dockToMain');
    closeBtn.textContent = t('terminal.window.close');
    contextEl.textContent = contextLabel();
    group?.refreshLocale?.();
  }

  function notify(title, value) {
    const message = messageFromError(value) || String(title || '');
    setStatus(message);
    if (message) setTimeout(() => {
      if (statusEl.textContent === message) setStatus('');
    }, 4500);
  }

  function closeModal(options = {}) {
    const currentOnClose = modalOnClose;
    modalOnClose = null;
    if (modal) {
      modal.remove();
      modal = null;
    }
    if (options.notifyClose && currentOnClose) currentOnClose();
  }

  function openModal({ title, body, footer = [], onClose } = {}) {
    closeModal();
    modalOnClose = onClose;
    modal = el('div', 'terminal-window-modal-backdrop');
    const panel = el('div', 'terminal-window-modal');
    const head = el('div', 'terminal-window-modal-head');
    head.appendChild(el('strong', '', title || t('terminal.window.confirm')));
    const dismiss = el('button', '', 'x');
    dismiss.type = 'button';
    dismiss.addEventListener('click', () => closeModal({ notifyClose: true }));
    head.appendChild(dismiss);
    const content = el('div', 'terminal-window-modal-body');
    if (body instanceof Node) content.appendChild(body);
    else content.textContent = String(body || '');
    const foot = el('div', 'terminal-window-modal-foot');
    for (const item of footer) {
      const button = el('button', item.primary ? 'primary' : '', item.label || t('dialog.ok'));
      button.type = 'button';
      button.addEventListener('click', () => item.onClick?.());
      foot.appendChild(button);
    }
    panel.append(head, content, foot);
    modal.appendChild(panel);
    modal.addEventListener('mousedown', (event) => {
      if (event.target === modal) closeModal({ notifyClose: true });
    });
    document.body.appendChild(modal);
  }

  function contextLabel() {
    const cwd = context.cwd || context.workspaceRoot || '';
    if (!cwd) return t('terminal.window.noWorkspace');
    return cwd;
  }

  function confirmDockToMain() {
    if (!group?.sessionCount?.()) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      const finish = (allowed) => {
        if (settled) return;
        settled = true;
        closeModal();
        resolve(allowed);
      };
      const body = el('div', 'terminal-confirm');
      body.innerHTML = `
        <p>${t('terminal.window.confirmDockBody1')}</p>
        <p>${t('terminal.window.confirmDockBody2')}</p>
      `;
      openModal({
        title: t('terminal.window.confirmDockTitle'),
        body,
        onClose: () => finish(false),
        footer: [
          { label: t('dialog.cancel'), onClick: () => finish(false) },
          { label: t('terminal.window.dockToMain'), primary: true, onClick: () => finish(true) },
        ],
      });
    });
  }

  async function dockToMain() {
    if (!await confirmDockToMain()) return;
    dockBtn.disabled = true;
    setStatus(t('terminal.window.docking'));
    try {
      await window.terminalWindow?.dockToMain?.();
    } catch (err) {
      dockBtn.disabled = false;
      notify('Terminal', err);
    }
  }

  async function init() {
    context = await window.terminalWindow?.context?.().catch(err => {
      notify('Terminal', err);
      return { workspaceRoot: '', cwd: '' };
    }) || { workspaceRoot: '', cwd: '' };
    contextEl.textContent = contextLabel();
    group = createPtyTerminalGroup({
      mount: stage,
      hooks: {
        getWorkspacePath: () => context.workspaceRoot || context.cwd || '',
        getActiveTab: () => context.cwd ? { dirPath: context.cwd } : null,
        notify,
        openModal,
        closeModal,
        insertRunnerBlock: async (markdown) => {
          await navigator.clipboard.writeText(String(markdown || ''));
          notify(t('terminal.title'), t('terminal.window.blockCopied'));
        },
      },
      track: () => {},
    });
    await group.activate();
  }

  dockBtn.addEventListener('click', dockToMain);
  closeBtn.addEventListener('click', () => window.close());
  window.orpad?.onLocaleChanged?.(({ code } = {}) => {
    if (code) setLocale(code);
    refreshLocale();
  });
  window.addEventListener('beforeunload', () => {
    stopThemeSync();
    closeModal();
    group?.destroy?.();
  });
  window.addEventListener('orpad-ai-prefill', async (event) => {
    const text = String(event.detail?.text || '');
    if (!text) return;
    await navigator.clipboard.writeText(text);
    notify(t('terminal.window.aiContextCopied'));
  });

  init().catch(err => notify('Terminal', err));
}

createTerminalWindowApp().catch((err) => {
  const root = document.getElementById('terminal-window-root');
  if (root) root.textContent = messageFromError(err) || String(err);
});
