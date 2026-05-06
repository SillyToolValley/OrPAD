// OrPAD adapter picker (renderer-side).
//
// PR M9 / 시각화 개선판: provider/model을 카드 그리드로 보여주고, 현재 선택된
// 값을 상단에 명시한다. IPC가 실패해도 shared catalog로 폴백해서 최소 카드는
// 보여주며, 에러는 모달 상단에 빨간 배너로 표시한다.

import { listProviderEntries, getProviderEntry } from '../../shared/ai/provider-catalog.js';

const DEFAULT_QUALITY_TIERS = Object.freeze(['fast', 'standard', 'deep']);

function ensureBridge(bridge) {
  if (!bridge || typeof bridge.invoke !== 'function') {
    throw new Error('AdapterPicker requires a bridge with invoke(channel, payload).');
  }
  return bridge;
}

function ensurePluginCatalogShape(payload) {
  if (!payload || typeof payload !== 'object') return { plugins: [], catalog: [] };
  const plugins = Array.isArray(payload.plugins) ? payload.plugins : [];
  const catalog = Array.isArray(payload.catalog) ? payload.catalog : [];
  return { plugins, catalog };
}

async function fetchProviderInventory(bridge) {
  const safeBridge = ensureBridge(bridge);
  const response = await safeBridge.invoke('machine-list-providers', {});
  if (!response || response.ok === false || response.success === false) {
    const err = new Error(response?.error || 'machine-list-providers rejected.');
    err.code = response?.code || 'MACHINE_LIST_PROVIDERS_FAILED';
    throw err;
  }
  return ensurePluginCatalogShape(response);
}

async function fetchModelsForProvider(bridge, providerId) {
  const safeBridge = ensureBridge(bridge);
  const response = await safeBridge.invoke('machine-list-models', { providerId });
  if (!response || response.ok === false || response.success === false) {
    const err = new Error(response?.error || 'machine-list-models rejected.');
    err.code = response?.code || 'MACHINE_LIST_MODELS_FAILED';
    throw err;
  }
  return response;
}

function buildSelectionPayload({ providerId, model, family, qualityTier, sessionStrategy, toolPolicy }) {
  return {
    providerId: String(providerId || '').trim(),
    model: String(model || '').trim(),
    family: family || 'api',
    qualityTier: qualityTier || 'standard',
    sessionStrategy: sessionStrategy || 'none',
    toolPolicy: toolPolicy || 'none',
  };
}

async function commitSelection(bridge, { scope, target, selection, pipelinePath }) {
  const safeBridge = ensureBridge(bridge);
  if (scope !== 'pipeline' && scope !== 'node') {
    throw Object.assign(new Error('scope must be pipeline or node.'), { code: 'PICKER_SCOPE_INVALID' });
  }
  const response = await safeBridge.invoke('machine-set-provider-selection', {
    scope,
    target,
    pipelinePath: pipelinePath || undefined,
    selection: buildSelectionPayload(selection || {}),
  });
  if (!response || response.ok === false || response.success === false) {
    const err = new Error(response?.error || 'machine-set-provider-selection rejected.');
    err.code = response?.code || 'PICKER_COMMIT_REJECTED';
    throw err;
  }
  return response;
}

function el(tag, attrs = {}, children = []) {
  if (typeof document === 'undefined') return null;
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'style') node.setAttribute('style', value);
    else if (key === 'dataset' && value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) node.dataset[k] = v;
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== undefined && value !== null) {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children).filter(c => c !== null && c !== undefined && c !== false)) {
    if (typeof child === 'string') node.appendChild(document.createTextNode(child));
    else node.appendChild(child);
  }
  return node;
}

function describeProvider(provider) {
  const family = (provider?.family || 'api').toUpperCase();
  const needsKey = provider?.needsKey === true ? 'API key required' : 'Keyless';
  const status = provider?.implementationStatus || 'unknown';
  const segments = [family, needsKey];
  if (status === 'ready') segments.push('✓ ready');
  else if (status === 'stub') segments.push('stub (not yet implemented)');
  return segments.filter(s => typeof s === 'string' && s.trim()).join(' · ');
}

function statusBadgeColor(status) {
  if (status === 'ready') return { color: '#9be0a3', bg: 'rgba(34,197,94,0.14)', border: 'rgba(34,197,94,0.5)' };
  if (status === 'stub') return { color: '#ffd58a', bg: 'rgba(202,138,4,0.18)', border: 'rgba(202,138,4,0.5)' };
  return { color: '#cccccc', bg: 'rgba(255,255,255,0.06)', border: 'rgba(255,255,255,0.18)' };
}

function mergeProviderInventory(plugins, catalog) {
  const byId = new Map();
  for (const entry of catalog || []) {
    byId.set(entry.id, {
      id: entry.id,
      displayName: entry.displayName,
      family: entry.family,
      needsKey: Boolean(entry.needsKey),
      defaultModel: entry.defaultModel,
      models: [...(entry.models || [])],
      implementationStatus: entry.implementationStatus || 'unknown',
      statusNote: entry.statusNote || '',
      registered: false,
    });
  }
  for (const plugin of plugins || []) {
    const slot = byId.get(plugin.id) || {
      id: plugin.id,
      displayName: plugin.displayName,
      family: plugin.family,
      needsKey: Boolean(plugin.needsKey),
      defaultModel: plugin.defaultModel,
      models: [...(plugin.models || [])],
      implementationStatus: 'unknown',
      statusNote: '',
      registered: false,
    };
    slot.registered = true;
    slot.displayName = plugin.displayName || slot.displayName;
    slot.family = plugin.family || slot.family;
    slot.needsKey = plugin.needsKey ?? slot.needsKey;
    slot.defaultModel = plugin.defaultModel || slot.defaultModel;
    if (plugin.implementationStatus) slot.implementationStatus = plugin.implementationStatus;
    if (plugin.statusNote) slot.statusNote = plugin.statusNote;
    if ((!slot.models || slot.models.length === 0) && plugin.models) slot.models = [...plugin.models];
    byId.set(plugin.id, slot);
  }
  return [...byId.values()];
}

function fallbackInventoryFromCatalog() {
  const entries = listProviderEntries();
  return {
    plugins: [],
    catalog: entries.map(entry => ({
      id: entry.id,
      displayName: entry.displayName,
      family: entry.family,
      needsKey: Boolean(entry.needsKey),
      defaultModel: entry.defaultModel,
      implementationStatus: entry.implementationStatus || 'unknown',
      statusNote: entry.statusNote || '',
      models: entry.models.map(model => model.id),
    })),
  };
}

function createAdapterPicker({
  bridge,
  scope = 'pipeline',
  target = null,
  pipelinePath = '',
  initial = null,
  onCommit,
  onError,
} = {}) {
  ensureBridge(bridge);
  const state = {
    scope,
    target,
    pipelinePath,
    inventory: fallbackInventoryFromCatalog(),
    providers: [],
    selection: buildSelectionPayload(initial || { providerId: '', model: '' }),
    busy: false,
    lastError: null,
    bannerMessage: '',
    bannerKind: 'info',
  };

  const root = el('div', {
    class: 'orpad-adapter-picker',
    dataset: { scope },
    style: 'display:flex;flex-direction:column;gap:14px;font-family:inherit;',
  });

  const banner = el('div', {
    class: 'orpad-adapter-picker__banner',
    style: 'display:none;padding:8px 10px;border-radius:6px;font-size:12px;line-height:1.4;border:1px solid transparent;',
  });

  const ipcRow = el('div', {
    class: 'orpad-adapter-picker__ipc',
    style: 'display:none;padding:10px 12px;border-radius:6px;border:1px solid rgba(202,138,4,0.5);background:rgba(202,138,4,0.12);font-size:12px;line-height:1.5;',
  });
  const ipcRowText = el('div', {}, []);
  const ipcRowEnableButton = el('button', {
    type: 'button',
    style: 'margin-top:6px;padding:5px 10px;font-size:12px;background:#ca8a04;color:#1d1f23;border:0;border-radius:4px;cursor:pointer;font-weight:600;',
  }, ['Enable Machine IPC for this session']);
  ipcRow.appendChild(ipcRowText);
  ipcRow.appendChild(ipcRowEnableButton);

  const currentRow = el('div', {
    class: 'orpad-adapter-picker__current',
    style: 'display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid rgba(255,255,255,0.08);border-radius:6px;background:rgba(255,255,255,0.03);',
  });
  const currentLabel = el('div', { style: 'font-size:11px;opacity:0.65;text-transform:uppercase;letter-spacing:0.04em;' }, ['Current selection']);
  const currentText = el('div', { style: 'font-size:13px;font-weight:600;' }, ['Loading…']);
  const currentNote = el('div', { style: 'font-size:11px;opacity:0.7;' }, []);
  currentRow.appendChild(currentLabel);
  currentRow.appendChild(currentText);
  currentRow.appendChild(currentNote);

  const providerHeading = el('div', { style: 'font-size:12px;opacity:0.8;font-weight:600;' }, ['Provider']);
  const providerGrid = el('div', {
    class: 'orpad-adapter-picker__providers',
    style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;',
  });

  const SELECT_STYLE = [
    'padding:6px 10px',
    'background:#2a2d33',
    'color:#e6e6e6',
    'border:1px solid rgba(255,255,255,0.18)',
    'border-radius:4px',
    'font-size:13px',
    'font-family:inherit',
    // explicit appearance keeps Windows native chrome from resetting colors
    '-webkit-appearance:none',
    'appearance:none',
    // small inline arrow so the dropdown indicator stays visible after we remove appearance
    'background-image:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\' viewBox=\'0 0 10 6\'><path fill=\'%23a0a0a0\' d=\'M0 0l5 6 5-6z\'/></svg>")',
    'background-repeat:no-repeat',
    'background-position:right 8px center',
    'background-size:10px 6px',
    'padding-right:24px',
    'cursor:pointer',
  ].join(';');
  const OPTION_STYLE = 'background:#2a2d33;color:#e6e6e6;';

  const modelHeading = el('div', { style: 'font-size:12px;opacity:0.8;font-weight:600;' }, ['Model']);
  const modelSelect = el('select', {
    class: 'orpad-adapter-picker__model',
    style: SELECT_STYLE,
  });

  const tierRow = el('div', { style: 'display:flex;gap:8px;align-items:center;font-size:12px;' });
  const tierLabel = el('label', { style: 'opacity:0.85;color:#e6e6e6;' }, ['Quality tier:']);
  const tierSelect = el('select', { style: SELECT_STYLE });
  for (const tier of DEFAULT_QUALITY_TIERS) {
    tierSelect?.appendChild(el('option', { value: tier, style: OPTION_STYLE }, [tier]));
  }
  tierRow.appendChild(tierLabel);
  tierRow.appendChild(tierSelect);

  const actionRow = el('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:6px;' });
  const applyButton = el('button', {
    type: 'button',
    class: 'orpad-adapter-picker__apply',
    style: 'padding:6px 14px;font-size:13px;background:#3b82f6;color:white;border:0;border-radius:4px;cursor:pointer;font-weight:600;',
  }, ['Apply selection']);
  applyButton.disabled = true;
  applyButton.style.opacity = '0.5';
  actionRow.appendChild(applyButton);

  if (root) {
    root.appendChild(banner);
    root.appendChild(ipcRow);
    root.appendChild(currentRow);
    root.appendChild(providerHeading);
    root.appendChild(providerGrid);
    root.appendChild(modelHeading);
    root.appendChild(modelSelect);
    root.appendChild(tierRow);
    root.appendChild(actionRow);
  }

  function setIpcGateMessage(message) {
    if (!ipcRow) return;
    if (!message) {
      ipcRow.style.display = 'none';
      return;
    }
    ipcRowText.textContent = message;
    ipcRow.style.display = 'block';
  }

  function setBanner(message, kind = 'info') {
    state.bannerMessage = message || '';
    state.bannerKind = kind;
    if (!banner) return;
    if (!message) {
      banner.style.display = 'none';
      banner.textContent = '';
      return;
    }
    banner.style.display = 'block';
    banner.textContent = message;
    if (kind === 'error') {
      banner.style.background = 'rgba(220,38,38,0.18)';
      banner.style.borderColor = 'rgba(220,38,38,0.6)';
      banner.style.color = '#ffb4b4';
    } else if (kind === 'warn') {
      banner.style.background = 'rgba(202,138,4,0.18)';
      banner.style.borderColor = 'rgba(202,138,4,0.5)';
      banner.style.color = '#ffd58a';
    } else {
      banner.style.background = 'rgba(59,130,246,0.15)';
      banner.style.borderColor = 'rgba(59,130,246,0.45)';
      banner.style.color = '#9cc1ff';
    }
  }

  function setCurrentText(providerId, model) {
    if (!currentText) return;
    if (!providerId) {
      currentText.textContent = 'No provider selected yet';
      currentNote.textContent = scope === 'node' ? `Node: ${target || ''}` : 'Pipeline default';
      return;
    }
    const entry = state.providers.find(p => p.id === providerId);
    const display = entry ? `${entry.displayName || entry.id}` : providerId;
    const familyTag = (entry?.family || '').toUpperCase();
    currentText.textContent = `${display}${model ? ` · ${model}` : ''}`;
    currentNote.textContent = `${familyTag}${entry?.registered === false ? ' · catalog only' : ''}${scope === 'node' ? ` · node ${target || ''}` : ' · pipeline default'}`;
  }

  function highlightSelectedProvider() {
    if (!providerGrid) return;
    for (const card of providerGrid.querySelectorAll('[data-provider-id]')) {
      const isActive = card.dataset.providerId === state.selection.providerId;
      card.style.borderColor = isActive ? '#3b82f6' : 'rgba(255,255,255,0.12)';
      card.style.background = isActive ? 'rgba(59,130,246,0.12)' : 'rgba(255,255,255,0.03)';
      card.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    }
  }

  function renderProviderCards() {
    if (!providerGrid) return;
    providerGrid.innerHTML = '';
    if (!state.providers.length) {
      providerGrid.appendChild(el('div', {
        style: 'grid-column:1/-1;padding:12px;font-size:12px;opacity:0.7;border:1px dashed rgba(255,255,255,0.2);border-radius:6px;text-align:center;',
      }, ['No providers available. Make sure ORPAD_MACHINE_IPC=1 is set, or check the SECURITY console for errors.']));
      return;
    }
    for (const provider of state.providers) {
      const badge = statusBadgeColor(provider.implementationStatus);
      const card = el('button', {
        type: 'button',
        dataset: { providerId: provider.id },
        title: provider.statusNote || '',
        style: `display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:10px;border:1px solid rgba(255,255,255,0.12);border-radius:6px;background:rgba(255,255,255,0.03);color:inherit;cursor:pointer;text-align:left;font-family:inherit;transition:border-color 0.1s ease,background 0.1s ease;`,
        onClick: () => {
          state.selection.providerId = provider.id;
          state.selection.family = provider.family;
          highlightSelectedProvider();
          updateModelOptions(provider).catch(err => {
            state.lastError = err;
            setBanner(`모델 목록을 불러올 수 없습니다: ${err.message}`, 'error');
          });
        },
      });
      const titleRow = el('div', { style: 'display:flex;align-items:center;gap:6px;width:100%;justify-content:space-between;' });
      titleRow.appendChild(el('div', { style: 'font-size:13px;font-weight:600;' }, [provider.displayName || provider.id]));
      titleRow.appendChild(el('span', {
        style: `font-size:10px;padding:2px 6px;border-radius:10px;border:1px solid ${badge.border};background:${badge.bg};color:${badge.color};`,
      }, [provider.implementationStatus === 'ready' ? 'ready' : provider.implementationStatus === 'stub' ? 'stub' : 'unknown']));
      card.appendChild(titleRow);
      card.appendChild(el('div', { style: 'font-size:11px;opacity:0.75;' }, [describeProvider(provider)]));
      if (provider.statusNote) {
        card.appendChild(el('div', { style: 'font-size:10.5px;opacity:0.7;line-height:1.4;' }, [provider.statusNote]));
      }
      if (provider.registered === false) {
        card.appendChild(el('div', { style: 'font-size:10px;color:#ffd58a;' }, ['Plugin registry IPC 미응답 — catalog metadata 사용']));
      }
      providerGrid.appendChild(card);
    }
    highlightSelectedProvider();
  }

  async function updateModelOptions(provider) {
    if (!modelSelect) return;
    modelSelect.innerHTML = '';
    let modelIds = [];
    let defaultModel = '';
    try {
      const response = await fetchModelsForProvider(bridge, provider.id);
      modelIds = (response.models || []).map(m => m.id || m);
      defaultModel = response.defaultModel || provider.defaultModel || '';
    } catch (err) {
      // Fall back to catalog model ids
      modelIds = (provider.models || []).map(m => typeof m === 'string' ? m : m.id);
      defaultModel = provider.defaultModel || (modelIds[0] || '');
      setBanner(`모델 목록 IPC 실패 → catalog metadata로 fallback (${err.message})`, 'warn');
    }
    if (!modelIds.length && provider.defaultModel) modelIds = [provider.defaultModel];
    for (const modelId of modelIds) {
      modelSelect.appendChild(el('option', { value: modelId, style: OPTION_STYLE }, [modelId]));
    }
    if (modelIds.includes(state.selection.model)) {
      modelSelect.value = state.selection.model;
    } else if (defaultModel && modelIds.includes(defaultModel)) {
      modelSelect.value = defaultModel;
    } else if (modelIds.length) {
      modelSelect.value = modelIds[0];
    }
    state.selection.model = modelSelect.value || '';
    applyButton.disabled = !state.selection.providerId || !state.selection.model;
    applyButton.style.opacity = applyButton.disabled ? '0.5' : '1';
    setCurrentText(state.selection.providerId, state.selection.model);
  }

  if (modelSelect) {
    modelSelect.addEventListener('change', () => {
      state.selection.model = modelSelect.value;
      applyButton.disabled = !state.selection.providerId || !state.selection.model;
      applyButton.style.opacity = applyButton.disabled ? '0.5' : '1';
      setCurrentText(state.selection.providerId, state.selection.model);
    });
  }
  if (tierSelect) {
    tierSelect.addEventListener('change', () => {
      state.selection.qualityTier = tierSelect.value;
    });
  }

  applyButton.addEventListener('click', () => { commit().catch(() => {}); });

  async function tryEnableSession() {
    const safeBridge = ensureBridge(bridge);
    setIpcGateMessage('Enabling Machine IPC for this session…');
    try {
      const response = await safeBridge.invoke('machine-enable-session', {});
      if (!response || response.ok === false || response.success === false) {
        const reason = response?.error || 'machine-enable-session rejected.';
        setIpcGateMessage(`Enable 실패: ${reason}. OrPAD를 ORPAD_MACHINE_IPC=1 환경변수와 함께 다시 시작하세요.`);
        return false;
      }
      setIpcGateMessage('Machine IPC가 켜졌습니다. provider 목록을 새로 불러옵니다…');
      return true;
    } catch (err) {
      setIpcGateMessage(`Enable 실패: ${err.message}. ORPAD_MACHINE_IPC=1로 다시 시작하세요.`);
      return false;
    }
  }
  ipcRowEnableButton.addEventListener('click', async () => {
    ipcRowEnableButton.disabled = true;
    ipcRowEnableButton.style.opacity = '0.6';
    const enabled = await tryEnableSession();
    ipcRowEnableButton.disabled = false;
    ipcRowEnableButton.style.opacity = '1';
    if (enabled) {
      setIpcGateMessage('');
      await refresh();
    }
  });

  async function refresh() {
    state.busy = true;
    setBanner('Loading providers…', 'info');
    let inventory = state.inventory;
    let registryFailed = false;
    let gateBlocked = false;
    try {
      inventory = await fetchProviderInventory(bridge);
      setIpcGateMessage('');
    } catch (err) {
      registryFailed = true;
      state.lastError = err;
      gateBlocked = err?.code === 'MACHINE_IPC_FEATURE_DISABLED';
      const fallback = fallbackInventoryFromCatalog();
      inventory = fallback;
      if (gateBlocked) {
        setBanner('Machine IPC가 꺼져 있어 catalog metadata만 표시합니다. 아래 버튼으로 이 세션에서 IPC를 켜거나, OrPAD를 ORPAD_MACHINE_IPC=1 환경변수와 함께 다시 시작하세요.', 'warn');
        setIpcGateMessage('Machine IPC가 꺼져 있습니다. 이 세션에서만 IPC를 켜려면 아래 버튼을 누르세요.');
      } else {
        setBanner(`Plugin registry IPC 실패 (${err.message}). catalog metadata로 fallback합니다.`, 'error');
        setIpcGateMessage('');
      }
    }
    state.inventory = inventory;
    state.providers = mergeProviderInventory(inventory.plugins, inventory.catalog);
    if (!state.selection.providerId) {
      const codex = state.providers.find(p => p.id === 'codex-cli');
      const first = codex || state.providers[0];
      if (first) {
        state.selection.providerId = first.id;
        state.selection.family = first.family;
        state.selection.model = first.defaultModel || (first.models?.[0]?.id || first.models?.[0] || '');
      }
    }
    renderProviderCards();
    if (tierSelect && state.selection.qualityTier) tierSelect.value = state.selection.qualityTier;
    if (state.selection.providerId) {
      const provider = state.providers.find(p => p.id === state.selection.providerId);
      if (provider) await updateModelOptions(provider).catch(() => {});
    }
    setCurrentText(state.selection.providerId, state.selection.model);
    if (!registryFailed) setBanner('', 'info');
    state.busy = false;
  }

  async function commit() {
    if (!state.selection.providerId) {
      setBanner('Provider를 먼저 선택하세요.', 'error');
      return null;
    }
    if (!state.selection.model) {
      setBanner('Model을 먼저 선택하세요.', 'error');
      return null;
    }
    state.busy = true;
    setBanner('Saving…', 'info');
    try {
      const response = await commitSelection(bridge, {
        scope: state.scope,
        target: state.target,
        pipelinePath: state.pipelinePath,
        selection: state.selection,
      });
      const where = response?.persistedTo ? `→ ${response.persistedTo}` : '';
      setBanner(`Saved ${where}`.trim(), 'info');
      if (typeof onCommit === 'function') await onCommit(response);
      return response;
    } catch (err) {
      state.lastError = err;
      const reason = err?.code === 'MACHINE_IPC_FEATURE_DISABLED'
        ? 'Machine IPC가 꺼져 있어 저장되지 않습니다. ORPAD_MACHINE_IPC=1로 다시 시작하세요.'
        : `Save 실패: ${err.message}`;
      setBanner(reason, 'error');
      if (typeof onError === 'function') onError(err);
      return null;
    } finally {
      state.busy = false;
    }
  }

  return {
    root,
    state,
    refresh,
    commit,
    getSelection: () => ({ ...state.selection }),
    setSelection: next => { state.selection = buildSelectionPayload({ ...state.selection, ...next }); },
    setPipelinePath: nextPath => { state.pipelinePath = nextPath || ''; },
  };
}

export {
  buildSelectionPayload,
  commitSelection,
  createAdapterPicker,
  describeProvider,
  fallbackInventoryFromCatalog,
  fetchModelsForProvider,
  fetchProviderInventory,
  mergeProviderInventory,
};
