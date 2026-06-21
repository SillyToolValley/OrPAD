// OrPAD orchestration-core — live-trace Run view.
//
// Renders the EMERGENT graph of a governed-delegation run as it streams in:
// each forwarded trace event ({ev:'phase'|'node'|'run'}) is accumulated and the
// graph is rebuilt via buildEmergentGraph. There is NO pre-authored node graph —
// the footprint grows in execution order, the still-filling node shows a spinner,
// and every node closes out when the run completes. Reuses the preserved
// orch-graph node visual primitives (.orch-graph-node + type/runtime classes).
//
// When given an `onRun` callback the view also renders a Run form (goal +
// write-set + grounding/apply toggles + time cap) in a LEFT sidebar that
// launches a REAL grounded/governed delegation; the emergent graph fills the
// right pane on a drag-to-pan / wheel-to-zoom canvas as trace events stream in.

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
    <div class="core-run-side">
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
        <label class="core-run-field">
          <span>Verification gates <small>optional — shell checks, one per line; exit 0 = pass. The trust gate: a failing check BLOCKS apply, so nothing unverified reaches your workspace.</small></span>
          <textarea data-core-run-gates rows="2" placeholder="npm test"></textarea>
        </label>
        <label class="core-run-field core-run-field-inline">
          <span>Auto-fix cycles <small>retries on gate failure</small></span>
          <input type="number" data-core-run-verify-cycles min="0" max="5" step="1" value="0" inputmode="numeric" />
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
    </div>
    <div class="core-run-graph-viewport" data-core-run-viewport>
      <div class="core-run-graph-canvas" data-core-run-canvas>
        <div class="core-run-graph" data-core-run-graph aria-live="polite"></div>
      </div>
      <div class="core-run-graph-controls">
        <button type="button" class="core-run-zoom-btn" data-core-run-zoom-out title="Zoom out" aria-label="Zoom out">−</button>
        <button type="button" class="core-run-zoom-btn" data-core-run-zoom-reset title="Reset view">Reset view</button>
        <button type="button" class="core-run-zoom-btn" data-core-run-zoom-in title="Zoom in" aria-label="Zoom in">+</button>
      </div>
    </div>
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
  const gatesEl = el.querySelector('[data-core-run-gates]');
  const verifyCyclesEl = el.querySelector('[data-core-run-verify-cycles]');
  const viewportEl = el.querySelector('[data-core-run-viewport]');
  const canvasEl = el.querySelector('[data-core-run-canvas]');
  const zoomInEl = el.querySelector('[data-core-run-zoom-in]');
  const zoomOutEl = el.querySelector('[data-core-run-zoom-out]');
  const zoomResetEl = el.querySelector('[data-core-run-zoom-reset]');

  // Pan/zoom canvas — drag the empty graph background to pan, wheel to zoom
  // (zoom anchored at the cursor), zoom buttons step around the viewport center.
  const ZOOM_MIN = 0.3;
  const ZOOM_MAX = 2.5;
  let panX = 0;
  let panY = 0;
  let scale = 1;
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let panBaseX = 0;
  let panBaseY = 0;
  let userAdjusted = false;

  function applyTransform() {
    if (canvasEl) canvasEl.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }
  // Fit the whole 2-lane graph into the viewport (default view), 1:1 if it already fits.
  function fitView() {
    if (!viewportEl || !canvasEl) return;
    const gw = graphEl.scrollWidth || 1;
    const gh = graphEl.scrollHeight || 1;
    const vw = viewportEl.clientWidth || 1;
    const vh = viewportEl.clientHeight || 1;
    const pad = 56;
    const s = Math.min(1, (vw - pad) / gw, (vh - pad) / gh);
    scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s || 1));
    panX = Math.max(8, (vw - gw * scale) / 2);
    panY = 16;
    applyTransform();
  }
  function resetView() {
    userAdjusted = false;
    fitView();
  }
  function zoomAt(nextScaleRaw, cx, cy) {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextScaleRaw));
    if (next === scale) return;
    // Keep the point under (cx, cy) stationary while scaling.
    panX = cx - (cx - panX) * (next / scale);
    panY = cy - (cy - panY) * (next / scale);
    scale = next;
    applyTransform();
  }
  if (viewportEl && canvasEl) {
    viewportEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // Let node text stay selectable; only pan from the empty background.
      if (e.target.closest && e.target.closest('.core-run-node, .core-run-graph-controls')) return;
      dragging = true;
      userAdjusted = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      panBaseX = panX;
      panBaseY = panY;
      viewportEl.classList.add('is-panning');
      try { viewportEl.setPointerCapture(e.pointerId); } catch (_) {}
    });
    viewportEl.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      panX = panBaseX + (e.clientX - dragStartX);
      panY = panBaseY + (e.clientY - dragStartY);
      applyTransform();
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      viewportEl.classList.remove('is-panning');
      try { viewportEl.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    viewportEl.addEventListener('pointerup', endDrag);
    viewportEl.addEventListener('pointercancel', endDrag);
    viewportEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      userAdjusted = true;
      const rect = viewportEl.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAt(scale * factor, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });
    const centerZoom = (factor) => {
      userAdjusted = true;
      const rect = viewportEl.getBoundingClientRect();
      zoomAt(scale * factor, rect.width / 2, rect.height / 2);
    };

    zoomInEl?.addEventListener('click', () => centerZoom(1.2));
    zoomOutEl?.addEventListener('click', () => centerZoom(1 / 1.2));
    zoomResetEl?.addEventListener('click', resetView);
  }

  let events = [];
  let errorMessage = '';
  let busy = false;

  function reset() {
    events = [];
    errorMessage = '';
    resetView();
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
      const verifyCommands = parseLines(gatesEl?.value);
      const verifyCycles = Math.max(0, Math.min(5, Number(verifyCyclesEl?.value) || 0));
      const request = {
        goal,
        allowedFiles,
        readOnlyFiles,
        timeoutMs: timeoutMin > 0 ? Math.round(timeoutMin * 60000) : 0,
        ground: groundEl ? groundEl.checked : true,
        apply: applyEl ? applyEl.checked : true,
        verifyCommands,
        verifyCycles,
      };
      setBusy(true);
      try {
        const res = await onRun(request);
        if (res && res.ok === false) {
          showFormError(res.error || 'Run failed.');
        } else if (res) {
          const parts = [];
          const gateList = Array.isArray(res.gates) ? res.gates : [];
          if (res.gated) {
            const passedN = gateList.filter((g) => g.passed).length;
            parts.push(res.met
              ? `Verified ✓ ${passedN}/${gateList.length} checks passed`
              : `Verification FAILED ✗ ${passedN}/${gateList.length} — NOT applied (nothing unverified reaches your workspace)`);
            if (res.verifyCycles) parts.push(`${res.verifyCycles} fix cycle${res.verifyCycles === 1 ? '' : 's'}`);
          }
          if (res.met !== false) {
            parts.push(res.appliedCount ? `Applied ${res.appliedCount} file${res.appliedCount === 1 ? '' : 's'} to the workspace` : 'No files applied');
          }
          if (res.grounded) parts.push(res.groundingBrief ? 'grounded (prior-art brief)' : 'grounding requested');
          const vCount = Array.isArray(res.violations) ? res.violations.length : 0;
          if (vCount) parts.push(`${vCount} out-of-write-set violation${vCount === 1 ? '' : 's'}`);
          if (res.stopped) parts.push(`stopped: ${res.stopReason || 'time-cap'}`);
          const summary = parts.join(' · ');
          // A blocked apply (gate failed) is shown in the attention/error style so
          // it reads as "output rejected", not "run succeeded".
          if (res.met === false) { showFormError(summary); } else { showFormResult(summary); }
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

    // File-access chip: which file this node reads/writes (the data layer).
    let fileEl = null;
    if (node.file) {
      fileEl = document.createElement('div');
      fileEl.className = `core-run-node-file access-${node.access || 'touch'}`;
      const tag = document.createElement('span');
      tag.className = 'core-run-file-tag';
      tag.textContent = node.access || 'touch';
      const pathEl = document.createElement('span');
      pathEl.className = 'core-run-file-path';
      pathEl.textContent = node.file;
      pathEl.title = node.file;
      fileEl.append(tag, pathEl);
    }

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

    node$.append(top, ...(fileEl ? [fileEl] : []), status);
    return node$;
  }

  const SVGNS = 'http://www.w3.org/2000/svg';

  // Layer-2 node: a file the run reads/writes (the Obsidian-style file graph).
  function fileNodeEl(f, isActive) {
    const el = document.createElement('div');
    el.className = `core-run-file-node${isActive ? ' is-active' : ''}`;
    el.dataset.file = f.path;
    const name = document.createElement('div');
    name.className = 'core-run-file-node-name';
    name.textContent = f.path.split(/[\\/]/).pop();
    name.title = f.path;
    const meta = document.createElement('div');
    meta.className = 'core-run-file-node-meta';
    const parts = [];
    if (f.reads) parts.push(`R×${f.reads}`);
    if (f.writes) parts.push(`W×${f.writes}`);
    meta.textContent = parts.join('  ') || 'touch';
    el.append(name, meta);
    return el;
  }

  // Draw node→file edges (read=green inbound, write=orange outbound) after layout.
  // offset* are layout coords relative to the position:relative graph container, so
  // they are unaffected by the canvas pan/zoom transform.
  function drawEdges(svg, nodes, activeId, nodeEls, fileEls) {
    const w = graphEl.scrollWidth;
    const h = graphEl.scrollHeight;
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    for (const node of nodes) {
      if (!node.file) continue;
      const a = nodeEls.get(node.id);
      const f = fileEls.get(node.file);
      if (!a || !f) continue;
      const x1 = a.offsetLeft + a.offsetWidth;
      const y1 = a.offsetTop + a.offsetHeight / 2;
      const x2 = f.offsetLeft;
      const y2 = f.offsetTop + f.offsetHeight / 2;
      const dx = Math.max(40, (x2 - x1) / 2);
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`);
      path.setAttribute('class', `core-run-edge-line access-${node.access || 'touch'}${node.id === activeId ? ' is-active' : ''}`);
      svg.appendChild(path);
    }
  }
  function render() {
    const { nodes, activeId, done, files } = buildEmergentGraph(events);
    graphEl.replaceChildren();

    // SVG edge overlay (behind the cards).
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'core-run-edges');
    graphEl.appendChild(svg);

    const lanes = document.createElement('div');
    lanes.className = 'core-run-lanes';

    // Layer 1: agent lane (phases + work nodes in execution order).
    const agentLane = document.createElement('div');
    agentLane.className = 'core-run-agent-lane';
    const nodeEls = new Map();
    nodes.forEach((node, i) => {
      if (i > 0) {
        const edge = document.createElement('div');
        edge.className = 'core-run-edge';
        edge.setAttribute('aria-hidden', 'true');
        agentLane.appendChild(edge);
      }
      const cardEl = nodeEl(node, node.id === activeId);
      agentLane.appendChild(cardEl);
      nodeEls.set(node.id, cardEl);
    });
    lanes.appendChild(agentLane);

    // Layer 2: file lane (distinct files, the one the active node touches highlighted).
    const activeFile = (nodes.find((n) => n.id === activeId) || {}).file || null;
    const fileEls = new Map();
    if (files.length) {
      const fileLane = document.createElement('div');
      fileLane.className = 'core-run-file-lane';
      files.forEach((f) => {
        const fe = fileNodeEl(f, f.path === activeFile);
        fileLane.appendChild(fe);
        fileEls.set(f.path, fe);
      });
      lanes.appendChild(fileLane);
    }
    graphEl.appendChild(lanes);
    drawEdges(svg, nodes, activeId, nodeEls, fileEls);
    // Auto-fit the whole 2-lane graph by default; yield once the user pans/zooms.
    if (!userAdjusted) fitView();

    if (errorMessage) {
      statusEl.textContent = `Error — ${errorMessage}`;
      statusEl.dataset.state = 'error';
    } else if (busy) {
      // A live run is in flight — the IPC promise is authoritative over any
      // intermediate trace run-done (a grounded run streams research THEN build,
      // plus a post-run apply step), so never show "complete" until it resolves.
      const active = nodes.find((n) => n.id === activeId);
      statusEl.textContent = !nodes.length
        ? 'Starting run…'
        : `Running — ${active ? (active.label || typeLabel(active.type)) : 'working'}…`;
      statusEl.dataset.state = 'running';
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
