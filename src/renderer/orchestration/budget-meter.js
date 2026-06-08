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
  // Provenance split (R4): estimated spend (flat-rate CLI workers that report no
  // usage) is kept separate from measured spend (API usage) so the meter can
  // mark an estimate-bearing total honestly rather than presenting it as a
  // measured dollar figure.
  const measuredCostUsd = Number(summary.measuredCostUsd) || 0;
  const estimatedCostUsd = Number(summary.estimatedCostUsd) || 0;
  const totalTokens = Number(summary.totalTokens)
    || ((Number(summary.totalPromptTokens) || 0) + (Number(summary.totalCompletionTokens) || 0));
  const estimatedTokens = Number(summary.estimatedTokens) || 0;
  const measuredTokens = Number(summary.measuredTokens) || 0;
  const estimatedEntryCount = Number(summary.estimatedEntryCount) || 0;
  const measuredEntryCount = Number(summary.measuredEntryCount) || 0;
  const perRunUsd = Number(budget.perRunUsd) || 0;
  const perCallUsd = Number(budget.perCallUsd) || 0;
  const perRunTokens = Number(budget.perRunTokens) || 0;
  const perRunRemainingUsd = perRunUsd > 0 ? Math.max(0, perRunUsd - totalCostUsd) : null;
  const perRunTokensRemaining = perRunTokens > 0 ? Math.max(0, perRunTokens - totalTokens) : null;
  const utilization = perRunUsd > 0 ? Math.min(1, totalCostUsd / perRunUsd) : 0;
  const tokenUtilization = perRunTokens > 0 ? Math.min(1, totalTokens / perRunTokens) : 0;
  return {
    totalCostUsd,
    measuredCostUsd,
    estimatedCostUsd,
    totalTokens,
    estimatedTokens,
    measuredTokens,
    estimatedEntryCount,
    measuredEntryCount,
    // True when any part of the ledger is an estimate (drives the detail line).
    hasEstimates: estimatedEntryCount > 0 || estimatedTokens > 0 || estimatedCostUsd > 0,
    // Per-dimension provenance: a flat-rate CLI worker contributes estimated
    // TOKENS but $0 estimated cost, so the "≈" marker must be gated on the
    // dimension actually being displayed — never mark an all-measured $ figure
    // just because estimated tokens exist elsewhere.
    hasEstimatedCost: estimatedCostUsd > 0,
    hasEstimatedTokens: estimatedTokens > 0 || estimatedEntryCount > 0,
    attemptCount: Number(summary.attemptCount) || 0,
    cacheHitCount: Number(summary.cacheHitCount) || 0,
    perRunUsd,
    perRunRemainingUsd,
    perCallUsd,
    perRunTokens,
    perRunTokensRemaining,
    utilization,
    tokenUtilization,
    // The bar tracks whichever budget dimension is configured; for flat-rate CLI
    // runs that is the token ceiling (USD stays 0), so the bar still moves.
    displayUtilization: Math.max(utilization, tokenUtilization),
    overBudget: perRunUsd > 0 && totalCostUsd > perRunUsd,
    overTokenBudget: perRunTokens > 0 && totalTokens > perRunTokens,
  };
}

function formatUsd(amount) {
  const value = Number(amount) || 0;
  return `$${value.toFixed(4)}`;
}

// Compact token count for the meter label (e.g. 1234 -> "1.2k", 2_500_000 -> "2.5M").
function formatTokens(amount) {
  const value = Number(amount) || 0;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value)}`;
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
      // "≈" marks a displayed figure that includes estimated (non-measured)
      // spend, so an estimate is never shown as measured — and is gated on the
      // displayed dimension so an all-measured $ figure is not falsely marked
      // when only estimated tokens exist.
      const costMark = snap.hasEstimatedCost ? ' ≈' : '';
      const tokenMark = snap.hasEstimatedTokens ? ' ≈' : '';
      let labelText;
      if (snap.perRunUsd) {
        labelText = `Cost:${costMark} ${formatUsd(snap.totalCostUsd)} / ${formatUsd(snap.perRunUsd)}`;
      } else if (snap.perRunTokens) {
        labelText = `Tokens:${tokenMark} ${formatTokens(snap.totalTokens)} / ${formatTokens(snap.perRunTokens)}`;
      } else {
        labelText = `Cost:${costMark} ${formatUsd(snap.totalCostUsd)} / ∞`;
      }
      setLabel(labelText, (snap.overBudget || snap.overTokenBudget) ? 'over' : 'info');
      setUtilization(snap.displayUtilization);
      const detailParts = [`${snap.attemptCount} attempts`, `${snap.cacheHitCount} cache hits`];
      if (snap.perRunUsd) detailParts.push(`${formatPercent(snap.utilization)} of run budget`);
      else if (snap.perRunTokens) detailParts.push(`${formatPercent(snap.tokenUtilization)} of token budget`);
      if (snap.hasEstimates) {
        detailParts.push(`${formatTokens(snap.estimatedTokens)} est. tokens (worker)`);
      }
      setDetailText(detailParts.join(' · '));
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
  formatTokens,
  formatUsd,
  summarizeAgainstBudget,
};
