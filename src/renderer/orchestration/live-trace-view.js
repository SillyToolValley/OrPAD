// OrPAD orchestration-core — live-trace Run view.
//
// Renders the EMERGENT graph of a governed-delegation run as it streams in:
// each forwarded trace event ({ev:'phase'|'node'|'run'}) is accumulated and the
// graph is rebuilt via buildEmergentGraph. There is NO pre-authored node graph —
// the footprint grows in execution order, the still-filling node shows a spinner,
// and every node closes out when the run completes. Reuses the preserved
// orch-graph node visual primitives (.orch-graph-node + type/runtime classes).
//
// When given an `onRun(request)` callback the view also renders a Run form (goal +
// write-set + time cap) that launches a REAL governed delegation; trace events
// then stream back in and drive the graph live.

import { buildEmergentGraph } from './emergent-trace.js';

const TYPE_LABEL = {
  recon: 'Recon',
  isolate: 'Isolate',
  guidance: 'Guidance',
  delegate: 'Delegate',
  enforce: 'Enforce',
  inspect: 'Inspect',
  edit: 'Edit',
  exec: 'Exec',
  research: 'Research',
  subagent: 'Subagent',
  plan: 'Plan',
  reason: 'Reason',
  tool: 'Tool',
  phase: 'Phase',
};

function typeLabel(type) {
  return TYPE_LABEL[type] || (type ? String(type) : 'Node');
}

function parseLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

// onRun: optional async (request) => summary. When omitted the Run form is hidden
// (e.g. read-only/replay-only surfaces).
export function createLiveTraceView({ onRun = null } = {}) {
  const el = document.createElement('section');
  el.className = 'core-run-view';
  el.innerHTML = `
    <header class="core-run-header">
      <h2 class="core-run-title">Live run</h2>
      <div class="core-run-status" data-core-run-status role="status">Idle — no run yet.</div>
    </header>
    <form class="core-run-form" data-core-run-form>
      <label class="core-run-field">
        <span>Goal</span>
        <textarea data-core-run-goal rows="3" placeholder="Describe the task to delegate to the agent…"></textarea>
      </label>
      <label class="core-run-field">
        <span>Write-set <small>optional — files the agent may change. Leave empty to build freely; the whole result is applied to the workspace.</small></span>
        <textarea data-core-run-writeset rows="2" placeholder="src/feature.js"></textarea>
      </label>
      <label class="core-run-field">
        <span>Read-only context <small>optional — extra files seeded read-only, one per line</small></span>
        <textarea data-core-run-readonly rows="1" placeholder="src/types.ts"></textarea>
      </label>
      <div class="core-run-form-row">
        <label class="core-run-field core-run-field-inline">
          <span>Time cap (min)</span>
          <input type="number" data-core-run-timeout min="0" step="1" value="0" inputmode="numeric" />
        </label>
        <button type="submit" class="core-run-btn" data-core-run-submit>Run</button>
      </div>
      <div class="core-run-form-row core-run-form-opts">
        <label class="core-run-check"><input type="checkbox" data-core-run-ground checked /> Research prior art first (grounding)</label>
        <label class="core-run-check"><input type="checkbox" data-core-run-apply checked /> Apply result to workspace</label>
      </div>
      <p class="core-run-form-note">Spawns the configured agent (claude) under the isolation moat. A real run — it may take minutes and incur cost. Time cap 0 = no stop-signal.</p>
      <p class="core-run-form-error" data-core-run-error hidden></p>
      <p class="core-run-form-result" data-core-run-result hidden></p>
    </form>
    <div class="core-run-graph" data-core-run-graph aria-live="polite"></div>
  `;
  const statusEl = el.querySelector('[data-core-run-status]');
  const graphEl = el.querySelector('[data-core-run-graph]');
  const formEl = el.querySelector('[data-core-run-form]');
  const goalEl = el.querySelector('[data-core-run-goal]');
  const writesetEl = el.querySelector('[data-core-run-writeset]');
  const readonlyEl = el.querySelector('[data-core-run-readonly]');
  const timeoutEl = el.querySelector('[data-core-run-timeout]');
  const submitEl = el.querySelector('[data-core-run-submit]');
  const errorEl = el.querySelector('[data-core-run-error]');
  const resultEl = el.querySelector('[data-core-run-result]');
  const groundEl = el.querySelector('[data-core-run-ground]');
  const applyEl = el.querySelector('[data-core-run-apply]');

  let events = [];
  let errorMessage = '';
  let busy = false;

  function reset() {
    events = [];
    errorMessage = '';
    render();
  }

  function applyEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.ev === 'run' && ev.state === 'start') { reset(); return; }
    if (ev.ev === 'run' && ev.state === 'error') {
      errorMessage = String(ev.error || 'Run failed.');
    }
    events.push(ev);
    render();
  }

  function showFormError(message) {
    errorEl.textContent = message;
    errorEl.hidden = !message;
  }

  function showFormResult(message) {
    if (!resultEl) return;
    resultEl.textContent = message || '';
    resultEl.hidden = !message;
  }

  function setBusy(next) {
    busy = next;
    if (submitEl) {
      submitEl.disabled = next;
      submitEl.textContent = next ? 'Running…' : 'Run';
    }
  }

  if (onRun && formEl) {
    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      showFormError('');
      showFormResult('');
      const goal = (goalEl?.value || '').trim();
      if (!goal) { showFormError('Enter a goal first.'); goalEl?.focus(); return; }
      const allowedFiles = parseLines(writesetEl?.value);
      const readOnlyFiles = parseLines(readonlyEl?.value);
      const timeoutMin = Math.max(0, Number(timeoutEl?.value) || 0);
      const request = {
        goal,
        allowedFiles,
        readOnlyFiles,
        timeoutMs: timeoutMin > 0 ? Math.round(timeoutMin * 60000) : 0,
        ground: groundEl ? groundEl.checked : true,
        apply: applyEl ? applyEl.checked : true,
      };
      setBusy(true);
      try {
        const res = await onRun(request);
        if (res && res.ok === false) {
          showFormError(res.error || 'Run failed.');
        } else if (res) {
          const parts = [];
          parts.push(res.appliedCount ? `Applied ${res.appliedCount} file${res.appliedCount === 1 ? '' : 's'} to the workspace` : 'No files applied');
          if (res.grounded) parts.push(res.groundingBrief ? 'grounded (prior-art brief produced)' : 'grounding requested');
          if (res.violationCount) parts.push(`${res.violationCount} out-of-write-set violation${res.violationCount === 1 ? '' : 's'}`);
          if (res.stopped) parts.push(`stopped: ${res.stopReason || 'time-cap'}`);
          showFormResult(parts.join(' · '));
        }
      } catch (err) {
        showFormError(String(err?.message || err));
      } finally {
        setBusy(false);
      }
    });
  } else if (formEl) {
    formEl.remove();
  }

  function nodeEl(node, isActive) {
    const node$ = document.createElement('div');
    const runtime = node.state === 'active' ? 'runtime-running' : 'runtime-completed';
    node$.className = `orch-graph-node core-run-node type-${node.type || 'tool'} ${runtime}`;
    node$.dataset.nodeId = node.id;
    node$.dataset.nodeType = node.type || 'tool';
    node$.dataset.nodeState = node.state;
    if (node.phase) node$.dataset.phase = 'true';
    if (isActive) node$.dataset.active = 'true';

    const top = document.createElement('div');
    top.className = 'orch-graph-node-top';
    const strong = document.createElement('strong');
    strong.textContent = node.label || node.type || 'node';
    const badge = document.createElement('span');
    badge.textContent = typeLabel(node.type);
    top.append(strong, badge);

    const status = document.createElement('div');
    status.className = 'core-run-node-status';
    if (node.state === 'active') {
      const spinner = document.createElement('span');
      spinner.className = 'runbook-spinner core-run-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      status.append(spinner, document.createTextNode('Working…'));
    } else {
      status.textContent = 'Done';
    }

    node$.append(top, status);
    return node$;
  }

  function render() {
    const { nodes, activeId, done } = buildEmergentGraph(events);
    graphEl.replaceChildren();

    nodes.forEach((node, i) => {
      if (i > 0) {
        const edge = document.createElement('div');
        edge.className = 'core-run-edge';
        edge.setAttribute('aria-hidden', 'true');
        graphEl.appendChild(edge);
      }
      graphEl.appendChild(nodeEl(node, node.id === activeId));
    });

    if (errorMessage) {
      statusEl.textContent = `Error — ${errorMessage}`;
      statusEl.dataset.state = 'error';
    } else if (!nodes.length) {
      statusEl.textContent = 'Idle — no run yet.';
      statusEl.dataset.state = 'idle';
    } else if (done) {
      statusEl.textContent = `Run complete — ${nodes.length} node${nodes.length === 1 ? '' : 's'}.`;
      statusEl.dataset.state = 'done';
    } else {
      const active = nodes.find((n) => n.id === activeId);
      statusEl.textContent = `Running — ${active ? (active.label || typeLabel(active.type)) : 'working'}…`;
      statusEl.dataset.state = 'running';
    }
  }

  render();
  return { el, applyEvent, reset };
}
