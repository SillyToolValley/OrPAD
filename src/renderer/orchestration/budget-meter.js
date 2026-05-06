// OrPAD budget meter (renderer-side).
//
// PR M9: small renderer module that polls the M5 budget ledger via the
// machine-read-budget-ledger IPC and renders a cumulative-cost meter for a
// given run root. The renderer never reads disk directly; the main process
// validates path containment before returning the ledger.

function ensureBridge(bridge) {
  if (!bridge || typeof bridge.invoke !== 'function') {
    throw new Error('BudgetMeter requires a bridge with invoke(channel, payload).');
  }
  return bridge;
}

async function fetchBudgetLedger(bridge, runRoot) {
  const safeBridge = ensureBridge(bridge);
  if (!runRoot) {
    throw Object.assign(new Error('runRoot is required.'), { code: 'METER_RUN_ROOT_REQUIRED' });
  }
  const response = await safeBridge.invoke('machine-read-budget-ledger', { runRoot });
  if (!response || response.ok === false || response.success === false) {
    throw Object.assign(new Error(response?.error || 'machine-read-budget-ledger rejected.'), {
      code: response?.code || 'METER_FETCH_FAILED',
    });
  }
  return response;
}

function summarizeAgainstBudget(summary = {}, budget = {}) {
  const totalCostUsd = Number(summary.totalCostUsd) || 0;
  const perRunUsd = Number(budget.perRunUsd) || 0;
  const perCallUsd = Number(budget.perCallUsd) || 0;
  const perRunRemainingUsd = perRunUsd > 0 ? Math.max(0, perRunUsd - totalCostUsd) : null;
  const utilization = perRunUsd > 0 ? Math.min(1, totalCostUsd / perRunUsd) : 0;
  return {
    totalCostUsd,
    attemptCount: Number(summary.attemptCount) || 0,
    cacheHitCount: Number(summary.cacheHitCount) || 0,
    perRunUsd,
    perRunRemainingUsd,
    perCallUsd,
    utilization,
    overBudget: perRunUsd > 0 && totalCostUsd > perRunUsd,
  };
}

function formatUsd(amount) {
  const value = Number(amount) || 0;
  return `$${value.toFixed(4)}`;
}

function formatPercent(fraction) {
  return `${Math.round((Number(fraction) || 0) * 100)}%`;
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

function createBudgetMeter({ bridge, runRoot, budget = {}, pollIntervalMs = 0, onUpdate, onError }) {
  ensureBridge(bridge);
  const state = {
    runRoot,
    budget,
    summary: null,
    snapshot: null,
    busy: false,
    lastError: null,
  };

  const root = createElement('div', { class: 'orpad-budget-meter', dataset: { runRoot } });
  const labelEl = createElement('div', { class: 'orpad-budget-meter__label' }, ['Cost: --']);
  const barOuter = createElement('div', { class: 'orpad-budget-meter__bar' });
  const barInner = createElement('div', { class: 'orpad-budget-meter__bar-inner' });
  if (barOuter && barInner) barOuter.appendChild(barInner);
  const detail = createElement('div', { class: 'orpad-budget-meter__detail' });

  function setLabel(text, kind = 'info') {
    if (!labelEl) return;
    labelEl.textContent = text;
    labelEl.dataset.kind = kind;
  }

  function setUtilization(fraction) {
    if (!barInner) return;
    const percent = Math.max(0, Math.min(1, Number(fraction) || 0));
    barInner.style.width = `${(percent * 100).toFixed(1)}%`;
  }

  function setDetailText(text) {
    if (detail) detail.textContent = text;
  }

  async function refresh() {
    state.busy = true;
    try {
      const response = await fetchBudgetLedger(bridge, state.runRoot);
      state.summary = response.summary;
      state.snapshot = summarizeAgainstBudget(response.summary, state.budget);
      const snap = state.snapshot;
      setLabel(`Cost: ${formatUsd(snap.totalCostUsd)} / ${snap.perRunUsd ? formatUsd(snap.perRunUsd) : '∞'}`, snap.overBudget ? 'over' : 'info');
      setUtilization(snap.utilization);
      setDetailText(
        snap.perRunUsd
          ? `${snap.attemptCount} attempts · ${snap.cacheHitCount} cache hits · ${formatPercent(snap.utilization)} of run budget`
          : `${snap.attemptCount} attempts · ${snap.cacheHitCount} cache hits`,
      );
      if (typeof onUpdate === 'function') await onUpdate(snap);
      return snap;
    } catch (err) {
      state.lastError = err;
      setLabel(`Cost: error (${err.message})`, 'error');
      if (typeof onError === 'function') onError(err);
      return null;
    } finally {
      state.busy = false;
    }
  }

  let pollHandle = null;
  function startPolling(intervalMs = pollIntervalMs) {
    stopPolling();
    if (typeof setInterval !== 'function' || !Number.isFinite(intervalMs) || intervalMs <= 0) return;
    pollHandle = setInterval(() => { refresh().catch(() => {}); }, intervalMs);
  }
  function stopPolling() {
    if (pollHandle) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  if (root) {
    if (labelEl) root.appendChild(labelEl);
    if (barOuter) root.appendChild(barOuter);
    if (detail) root.appendChild(detail);
  }

  return {
    root,
    state,
    refresh,
    startPolling,
    stopPolling,
    getSnapshot: () => (state.snapshot ? { ...state.snapshot } : null),
    setBudget: next => { state.budget = next || {}; },
    setRunRoot: next => { state.runRoot = next; },
  };
}

export {
  createBudgetMeter,
  fetchBudgetLedger,
  formatPercent,
  formatUsd,
  summarizeAgainstBudget,
};
