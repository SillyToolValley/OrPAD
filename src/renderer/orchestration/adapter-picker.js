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

function describeProvider(plugin, catalogEntry) {
  const family = (plugin?.family || catalogEntry?.family || 'api').toUpperCase();
  const needsKey = (plugin?.needsKey ?? catalogEntry?.needsKey) === true ? 'API key required' : 'Keyless';
  const isStub = plugin && typeof plugin.invokeApi !== 'function' && family === 'API'
    ? '· stub (invokeApi not yet implemented)'
    : '';
  return `${family} · ${needsKey} ${isStub}`.trim();
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
      registered: false,
    };
    slot.registered = true;
    slot.displayName = plugin.displayName || slot.displayName;
    slot.family = plugin.family || slot.family;
    slot.needsKey = plugin.needsKey ?? slot.needsKey;
    slot.defaultModel = plugin.defaultModel || slot.defaultModel;
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

  const modelHeading = el('div', { style: 'font-size:12px;opacity:0.8;font-weight:600;' }, ['Model']);
  const modelSelect = el('select', {
    class: 'orpad-adapter-picker__model',
    style: 'padding:6px 8px;background:rgba(255,255,255,0.04);color:inherit;border:1px solid rgba(255,255,255,0.12);border-radius:4px;font-size:13px;',
  });

  const tierRow = el('div', { style: 'display:flex;gap:8px;align-items:center;font-size:12px;' });
  const tierLabel = el('label', { style: 'opacity:0.75;' }, ['Quality tier:']);
  const tierSelect = el('select', { style: 'padding:4px 6px;background:rgba(255,255,255,0.04);color:inherit;border:1px solid rgba(255,255,255,0.12);border-radius:4px;' });
  for (const tier of DEFAULT_QUALITY_TIERS) {
    tierSelect?.appendChild(el('option', { value: tier }, [tier]));
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
    root.appendChild(currentRow);
    root.appendChild(providerHeading);
    root.appendChild(providerGrid);
    root.appendChild(modelHeading);
    root.appendChild(modelSelect);
    root.appendChild(tierRow);
    root.appendChild(actionRow);
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
      const card = el('button', {
        type: 'button',
        dataset: { providerId: provider.id },
        style: 'display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:10px;border:1px solid rgba(255,255,255,0.12);border-radius:6px;background:rgba(255,255,255,0.03);color:inherit;cursor:pointer;text-align:left;font-family:inherit;',
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
      card.appendChild(el('div', { style: 'font-size:13px;font-weight:600;' }, [provider.displayName || provider.id]));
      card.appendChild(el('div', { style: 'font-size:11px;opacity:0.7;' }, [describeProvider(provider, provider)]));
      if (provider.registered === false) {
        card.appendChild(el('div', { style: 'font-size:10px;color:#ffd58a;' }, ['Catalog metadata only — IPC plugin lookup failed']));
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
      modelSelect.appendChild(el('option', { value: modelId }, [modelId]));
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

  async function refresh() {
    state.busy = true;
    setBanner('Loading providers…', 'info');
    let inventory = state.inventory;
    let registryFailed = false;
    try {
      inventory = await fetchProviderInventory(bridge);
    } catch (err) {
      registryFailed = true;
      state.lastError = err;
      const fallback = fallbackInventoryFromCatalog();
      inventory = fallback;
      const reason = err?.code === 'MACHINE_IPC_FEATURE_DISABLED'
        ? 'Machine IPC가 꺼져 있습니다. ORPAD_MACHINE_IPC=1 환경변수로 OrPAD를 다시 시작하세요. 그 동안 catalog metadata로만 표시합니다.'
        : `Plugin registry IPC 실패 (${err.message}). catalog metadata로 fallback합니다.`;
      setBanner(reason, err?.code === 'MACHINE_IPC_FEATURE_DISABLED' ? 'warn' : 'error');
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
