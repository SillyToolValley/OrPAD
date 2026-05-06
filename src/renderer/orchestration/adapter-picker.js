// OrPAD adapter picker (renderer-side).
//
// PR M9: standalone module that mounts a tiny picker widget for the v2
// machineAdapter envelope. Pipeline-level default and per-node overrides
// emit a structured `selection` payload via the
// `machine-set-provider-selection` IPC. The main process re-validates the
// selection against the plugin registry before persisting any change to the
// pipeline graph, so a renderer compromise cannot inject an unregistered
// provider.

const DEFAULT_QUALITY_TIERS = Object.freeze(['fast', 'standard', 'deep', 'draft']);
const DEFAULT_SESSION_STRATEGIES = Object.freeze(['none', 'sdk-session', 'conversation-id', 'previous-response-id']);
const DEFAULT_TOOL_POLICIES = Object.freeze(['none']);

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
    throw Object.assign(new Error(response?.error || 'machine-list-providers rejected.'), {
      code: response?.code || 'MACHINE_LIST_PROVIDERS_FAILED',
    });
  }
  return ensurePluginCatalogShape(response);
}

async function fetchModelsForProvider(bridge, providerId) {
  const safeBridge = ensureBridge(bridge);
  const response = await safeBridge.invoke('machine-list-models', { providerId });
  if (!response || response.ok === false || response.success === false) {
    throw Object.assign(new Error(response?.error || 'machine-list-models rejected.'), {
      code: response?.code || 'MACHINE_LIST_MODELS_FAILED',
    });
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

async function commitSelection(bridge, { scope, target, selection }) {
  const safeBridge = ensureBridge(bridge);
  if (scope !== 'pipeline' && scope !== 'node') {
    throw Object.assign(new Error('scope must be pipeline or node.'), { code: 'PICKER_SCOPE_INVALID' });
  }
  const response = await safeBridge.invoke('machine-set-provider-selection', {
    scope,
    target,
    selection: buildSelectionPayload(selection || {}),
  });
  if (!response || response.ok === false || response.success === false) {
    const err = new Error(response?.error || 'machine-set-provider-selection rejected.');
    err.code = response?.code || 'PICKER_COMMIT_REJECTED';
    throw err;
  }
  return response;
}

function createElement(tag, attrs = {}, children = []) {
  if (typeof document === 'undefined') return null;
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') el.className = value;
    else if (key === 'dataset' && value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) el.dataset[k] = v;
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== undefined && value !== null) {
      el.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children).filter(Boolean)) {
    if (typeof child === 'string') el.appendChild(document.createTextNode(child));
    else el.appendChild(child);
  }
  return el;
}

function createAdapterPicker({ bridge, scope = 'pipeline', target = null, initial = null, onCommit, onError }) {
  ensureBridge(bridge);
  const state = {
    scope,
    target,
    inventory: { plugins: [], catalog: [] },
    selection: buildSelectionPayload(initial || { providerId: '', model: '' }),
    busy: false,
    lastError: null,
  };

  const root = createElement('div', { class: 'orpad-adapter-picker', dataset: { scope } });
  const providerSelect = createElement('select', { class: 'orpad-adapter-picker__provider', name: 'providerId' });
  const modelSelect = createElement('select', { class: 'orpad-adapter-picker__model', name: 'model' });
  const tierSelect = createElement('select', { class: 'orpad-adapter-picker__quality-tier', name: 'qualityTier' });
  for (const tier of DEFAULT_QUALITY_TIERS) {
    const opt = createElement('option', { value: tier }, [tier]);
    tierSelect?.appendChild(opt);
  }
  const sessionSelect = createElement('select', { class: 'orpad-adapter-picker__session', name: 'sessionStrategy' });
  for (const strat of DEFAULT_SESSION_STRATEGIES) {
    const opt = createElement('option', { value: strat }, [strat]);
    sessionSelect?.appendChild(opt);
  }
  const toolSelect = createElement('select', { class: 'orpad-adapter-picker__tool', name: 'toolPolicy' });
  for (const policy of DEFAULT_TOOL_POLICIES) {
    const opt = createElement('option', { value: policy }, [policy]);
    toolSelect?.appendChild(opt);
  }
  const status = createElement('div', { class: 'orpad-adapter-picker__status' });
  const commitButton = createElement('button', { type: 'button', class: 'orpad-adapter-picker__commit' }, ['Apply selection']);

  function setStatus(message, kind = 'info') {
    if (!status) return;
    status.textContent = message || '';
    status.dataset.kind = kind;
  }

  function syncSelectionFromInputs() {
    state.selection = buildSelectionPayload({
      providerId: providerSelect?.value || state.selection.providerId,
      model: modelSelect?.value || state.selection.model,
      family: state.selection.family,
      qualityTier: tierSelect?.value || state.selection.qualityTier,
      sessionStrategy: sessionSelect?.value || state.selection.sessionStrategy,
      toolPolicy: toolSelect?.value || state.selection.toolPolicy,
    });
  }

  async function loadProviderModels() {
    if (!providerSelect) return;
    const providerId = providerSelect.value;
    const entry = state.inventory.catalog.find(c => c.id === providerId);
    if (entry) {
      state.selection.family = entry.family;
    }
    if (modelSelect) {
      modelSelect.innerHTML = '';
      try {
        const models = await fetchModelsForProvider(bridge, providerId);
        for (const model of models.models || []) {
          const opt = createElement('option', { value: model.id }, [model.id]);
          modelSelect.appendChild(opt);
        }
        if (models.defaultModel) modelSelect.value = models.defaultModel;
      } catch (err) {
        state.lastError = err;
        setStatus(`Could not list models: ${err.message}`, 'error');
        if (typeof onError === 'function') onError(err);
      }
    }
    syncSelectionFromInputs();
  }

  async function refresh() {
    state.busy = true;
    setStatus('Loading providers…');
    try {
      const inventory = await fetchProviderInventory(bridge);
      state.inventory = inventory;
      if (providerSelect) {
        providerSelect.innerHTML = '';
        const eligible = inventory.plugins.length ? inventory.plugins : inventory.catalog;
        for (const provider of eligible) {
          const opt = createElement('option', { value: provider.id }, [`${provider.displayName || provider.id} (${provider.family})`]);
          providerSelect.appendChild(opt);
        }
        if (state.selection.providerId) providerSelect.value = state.selection.providerId;
      }
      await loadProviderModels();
      if (tierSelect && state.selection.qualityTier) tierSelect.value = state.selection.qualityTier;
      if (sessionSelect && state.selection.sessionStrategy) sessionSelect.value = state.selection.sessionStrategy;
      if (toolSelect && state.selection.toolPolicy) toolSelect.value = state.selection.toolPolicy;
      setStatus('Ready.');
    } catch (err) {
      state.lastError = err;
      setStatus(`Could not load providers: ${err.message}`, 'error');
      if (typeof onError === 'function') onError(err);
    } finally {
      state.busy = false;
    }
  }

  async function commit() {
    syncSelectionFromInputs();
    if (!state.selection.providerId) {
      setStatus('Choose a provider first.', 'error');
      return null;
    }
    state.busy = true;
    setStatus('Saving selection…');
    try {
      const response = await commitSelection(bridge, {
        scope: state.scope,
        target: state.target,
        selection: state.selection,
      });
      setStatus('Selection applied.');
      if (typeof onCommit === 'function') await onCommit(response);
      return response;
    } catch (err) {
      state.lastError = err;
      setStatus(`Selection rejected: ${err.message}`, 'error');
      if (typeof onError === 'function') onError(err);
      return null;
    } finally {
      state.busy = false;
    }
  }

  if (providerSelect) providerSelect.addEventListener('change', () => { loadProviderModels().catch(() => {}); });
  if (modelSelect) modelSelect.addEventListener('change', syncSelectionFromInputs);
  if (tierSelect) tierSelect.addEventListener('change', syncSelectionFromInputs);
  if (sessionSelect) sessionSelect.addEventListener('change', syncSelectionFromInputs);
  if (toolSelect) toolSelect.addEventListener('change', syncSelectionFromInputs);
  if (commitButton) commitButton.addEventListener('click', () => { commit().catch(() => {}); });

  if (root) {
    if (providerSelect) root.appendChild(providerSelect);
    if (modelSelect) root.appendChild(modelSelect);
    if (tierSelect) root.appendChild(tierSelect);
    if (sessionSelect) root.appendChild(sessionSelect);
    if (toolSelect) root.appendChild(toolSelect);
    if (commitButton) root.appendChild(commitButton);
    if (status) root.appendChild(status);
  }

  return {
    root,
    state,
    refresh,
    commit,
    getSelection: () => ({ ...state.selection }),
    setSelection: next => { state.selection = buildSelectionPayload({ ...state.selection, ...next }); },
  };
}

export {
  buildSelectionPayload,
  commitSelection,
  createAdapterPicker,
  fetchModelsForProvider,
  fetchProviderInventory,
};
