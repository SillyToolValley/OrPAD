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
export function createLiveTraceView({ onRun = null, onLinkGraph = null } = {}) {
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
          <label class="core-run-check"><input type="checkbox" data-core-run-parallel /> Parallel research (fan-out)</label>
        </div>
        <p class="core-run-form-note">Spawns the configured agent (claude) under the isolation moat. A real run — it may take minutes and incur cost. Time cap 0 = no stop-signal.</p>
        <p class="core-run-form-error" data-core-run-error hidden></p>
        <p class="core-run-form-result" data-core-run-result hidden></p>
      </form>
    </div>
    <div class="core-run-graph-viewport" data-core-run-viewport>
      <div class="core-run-mode-toggle">
        <button type="button" class="core-run-mode-btn is-active" data-core-run-mode="run">Run</button>
        <button type="button" class="core-run-mode-btn" data-core-run-mode="project">Project graph</button>
      </div>
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
  const parallelEl = el.querySelector('[data-core-run-parallel]');
  const gatesEl = el.querySelector('[data-core-run-gates]');
  const verifyCyclesEl = el.querySelector('[data-core-run-verify-cycles]');
  const viewportEl = el.querySelector('[data-core-run-viewport]');
  const canvasEl = el.querySelector('[data-core-run-canvas]');
  const zoomInEl = el.querySelector('[data-core-run-zoom-in]');
  const zoomOutEl = el.querySelector('[data-core-run-zoom-out]');
  const zoomResetEl = el.querySelector('[data-core-run-zoom-reset]');
  const modeBtns = [...el.querySelectorAll('[data-core-run-mode]')];

  // View mode: 'run' (the live emergent graph) or 'project' (the Obsidian-style
  // workspace link graph). Project graph is fetched lazily via onLinkGraph.
  let viewMode = 'run';
  let linkGraph = null;
  let linkGraphError = null;
  let linkGraphLoading = false;
  let lastRunFiles = [];
  let draggingNode = null;

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
      if (e.target.closest && e.target.closest('.core-run-node, .core-run-graph-controls, .core-run-mode-toggle, .core-run-file-graph-node')) return;
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
        parallelResearch: parallelEl ? parallelEl.checked : false,
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

  // Draw the DAG edges after layout. Coords are accumulated up the offsetParent
  // chain to the graph container, so they're correct whatever the lane positioning
  // and unaffected by the canvas pan/zoom transform.
  function drawEdges(svg, nodes, edges, activeId, nodeEls, fileEls) {
    const w = graphEl.scrollWidth;
    const h = graphEl.scrollHeight;
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const at = (el) => {
      let x = 0; let y = 0; let cur = el;
      while (cur && cur !== graphEl) { x += cur.offsetLeft; y += cur.offsetTop; cur = cur.offsetParent; }
      return { x, y, w: el.offsetWidth, h: el.offsetHeight };
    };
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // Cross-branch DAG edges (fork/join) — the structure that vertical stacking
    // can't show: a fan-out splits here and re-converges there.
    for (const e of (edges || [])) {
      const fn = byId.get(e.from);
      const tn = byId.get(e.to);
      if (!fn || !tn || fn.branch === tn.branch) continue;
      const a = nodeEls.get(e.from);
      const b = nodeEls.get(e.to);
      if (!a || !b) continue;
      const ra = at(a);
      const rb = at(b);
      const x1 = ra.x + ra.w / 2; const y1 = ra.y + ra.h;
      const x2 = rb.x + rb.w / 2; const y2 = rb.y;
      const dy = Math.max(20, (y2 - y1) / 2);
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`);
      p.setAttribute('class', 'core-run-branch-edge');
      svg.appendChild(p);
    }
    // node→file edges (read=green inbound, write=orange outbound).
    for (const node of nodes) {
      if (!node.file) continue;
      const a = nodeEls.get(node.id);
      const f = fileEls.get(node.file);
      if (!a || !f) continue;
      const ra = at(a);
      const rf = at(f);
      const x1 = ra.x + ra.w; const y1 = ra.y + ra.h / 2;
      const x2 = rf.x; const y2 = rf.y + rf.h / 2;
      const dx = Math.max(40, (x2 - x1) / 2);
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`);
      path.setAttribute('class', `core-run-edge-line access-${node.access || 'touch'}${node.id === activeId ? ' is-active' : ''}`);
      svg.appendChild(path);
    }
  }
  function setMode(mode) {
    viewMode = mode === 'project' ? 'project' : 'run';
    modeBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.coreRunMode === viewMode));
    userAdjusted = false;
    if (viewMode === 'project' && !linkGraph && !linkGraphLoading && onLinkGraph) {
      linkGraphLoading = true;
      linkGraphError = null;
      render();
      Promise.resolve(onLinkGraph()).then((res) => {
        linkGraphLoading = false;
        if (res && res.ok) { linkGraph = res; linkGraphError = null; } else { linkGraphError = (res && res.error) || 'No project link graph.'; }
        render();
      }).catch((e) => { linkGraphLoading = false; linkGraphError = String(e && e.message || e); render(); });
      return;
    }
    render();
  }
  modeBtns.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.coreRunMode)));

  // Deterministic force-directed layout for the project link graph (Obsidian-style).
  function layoutForce(nodes, edges) {
    const n = nodes.length;
    if (!n) return { pos: [], w: 1, h: 1 };
    const R = Math.max(140, n * 16);
    const pos = nodes.map((_, i) => ({ x: R * Math.cos((2 * Math.PI * i) / n), y: R * Math.sin((2 * Math.PI * i) / n) }));
    const idx = new Map(nodes.map((nd, i) => [nd.path, i]));
    const E = edges.map((e) => [idx.get(e.from), idx.get(e.to)]).filter(([a, b]) => a != null && b != null && a !== b);
    const iters = Math.min(260, 90 + n);
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let dx = pos[i].x - pos[j].x; let dy = pos[i].y - pos[j].y;
          const d2 = dx * dx + dy * dy + 0.01; const d = Math.sqrt(d2);
          const f = 2600 / d2; dx /= d; dy /= d;
          pos[i].x += dx * f; pos[i].y += dy * f; pos[j].x -= dx * f; pos[j].y -= dy * f;
        }
      }
      for (const [a, b] of E) {
        let dx = pos[b].x - pos[a].x; let dy = pos[b].y - pos[a].y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.01; const f = (d - 96) * 0.018;
        dx /= d; dy /= d;
        pos[a].x += dx * f; pos[a].y += dy * f; pos[b].x -= dx * f; pos[b].y -= dy * f;
      }
    }
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const p of pos) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    const pad = 70;
    for (const p of pos) { p.x = p.x - minX + pad; p.y = p.y - minY + pad; }
    return { pos, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
  }

  function fileGraphNodeEl(node, touched) {
    const fg = document.createElement('div');
    fg.className = `core-run-file-graph-node${touched ? ' is-touched' : ''}`;
    fg.dataset.file = node.path;
    const deg = (node.out || 0) + (node.in || 0);
    const dot = document.createElement('span');
    dot.className = 'core-run-fg-dot';
    const r = Math.max(8, Math.min(22, 8 + deg * 2));
    dot.style.width = `${r}px`;
    dot.style.height = `${r}px`;
    const label = document.createElement('span');
    label.className = 'core-run-fg-label';
    label.textContent = node.name;
    label.title = node.path;
    fg.append(dot, label);
    return fg;
  }

  function renderProjectGraph() {
    graphEl.replaceChildren();
    graphEl.style.width = '';
    graphEl.style.height = '';
    if (linkGraphLoading) { statusEl.textContent = 'Loading project graph…'; statusEl.dataset.state = 'running'; return; }
    if (linkGraphError) { statusEl.textContent = `Project graph — ${linkGraphError}`; statusEl.dataset.state = 'error'; return; }
    const g = linkGraph;
    if (!g || !Array.isArray(g.nodes) || !g.nodes.length) {
      statusEl.textContent = 'Project graph — no notes found.'; statusEl.dataset.state = 'idle'; return;
    }
    const nodes = g.nodes.slice(0, 400);
    const { pos, w, h } = layoutForce(nodes, g.edges || []);
    graphEl.style.width = `${Math.ceil(w)}px`;
    graphEl.style.height = `${Math.ceil(h)}px`;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'core-run-edges');
    svg.setAttribute('width', String(Math.ceil(w)));
    svg.setAttribute('height', String(Math.ceil(h)));
    svg.setAttribute('viewBox', `0 0 ${Math.ceil(w)} ${Math.ceil(h)}`);
    graphEl.appendChild(svg);
    const idx = new Map(nodes.map((nd, i) => [nd.path, i]));
    const edgeRecords = [];
    for (const e of (g.edges || [])) {
      const a = idx.get(e.from); const b = idx.get(e.to);
      if (a == null || b == null || a === b) continue;
      const line = document.createElementNS(SVGNS, 'path');
      line.setAttribute('class', 'core-run-link-edge');
      svg.appendChild(line);
      edgeRecords.push({ el: line, a, b });
    }
    const updateEdge = (rec) => rec.el.setAttribute('d', `M${pos[rec.a].x},${pos[rec.a].y} L${pos[rec.b].x},${pos[rec.b].y}`);
    edgeRecords.forEach(updateEdge);

    // Adjacency for hover-highlight (Obsidian-style: lift a node + its neighbours).
    const adj = nodes.map(() => new Set());
    edgeRecords.forEach((r) => { adj[r.a].add(r.b); adj[r.b].add(r.a); });

    const touched = new Set((lastRunFiles || []).map((f) => f.path));
    const nodeEls = [];
    nodes.forEach((nd, i) => {
      const fg = fileGraphNodeEl(nd, touched.has(nd.path));
      fg.style.left = `${pos[i].x}px`;
      fg.style.top = `${pos[i].y}px`;
      fg.addEventListener('pointerenter', () => {
        if (draggingNode != null) return;
        nodeEls.forEach((el, j) => {
          const hot = j === i || adj[i].has(j);
          el.classList.toggle('is-hot', hot);
          el.classList.toggle('is-dim', !hot);
        });
        edgeRecords.forEach((r) => {
          const hot = r.a === i || r.b === i;
          r.el.classList.toggle('is-hot', hot);
          r.el.classList.toggle('is-dim', !hot);
        });
      });
      fg.addEventListener('pointerleave', () => {
        if (draggingNode != null) return;
        nodeEls.forEach((el) => el.classList.remove('is-hot', 'is-dim'));
        edgeRecords.forEach((r) => r.el.classList.remove('is-hot', 'is-dim'));
      });
      // Drag to reposition (screen delta → graph coords via the current zoom scale).
      fg.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        userAdjusted = true;
        draggingNode = i;
        fg.classList.add('is-dragging');
        let lastX = ev.clientX; let lastY = ev.clientY;
        try { fg.setPointerCapture(ev.pointerId); } catch (_) {}
        const move = (m) => {
          pos[i].x += (m.clientX - lastX) / scale;
          pos[i].y += (m.clientY - lastY) / scale;
          lastX = m.clientX; lastY = m.clientY;
          fg.style.left = `${pos[i].x}px`;
          fg.style.top = `${pos[i].y}px`;
          edgeRecords.forEach((r) => { if (r.a === i || r.b === i) updateEdge(r); });
        };
        const up = (u) => {
          draggingNode = null;
          fg.classList.remove('is-dragging');
          fg.removeEventListener('pointermove', move);
          fg.removeEventListener('pointerup', up);
          try { fg.releasePointerCapture(u.pointerId); } catch (_) {}
        };
        fg.addEventListener('pointermove', move);
        fg.addEventListener('pointerup', up);
      });
      graphEl.appendChild(fg);
      nodeEls.push(fg);
    });
    const edgeCount = (g.edges || []).length;
    statusEl.textContent = `Project graph — ${g.nodes.length} note${g.nodes.length === 1 ? '' : 's'}, ${edgeCount} link${edgeCount === 1 ? '' : 's'}`;
    statusEl.dataset.state = 'done';
    if (!userAdjusted) fitView();
  }
  function render() {
    if (viewMode === 'project') { renderProjectGraph(); return; }
    graphEl.style.width = '';
    graphEl.style.height = '';
    const { nodes, edges, activeId, done, files, segments } = buildEmergentGraph(events);
    lastRunFiles = files;
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
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const makeCard = (id) => {
      const n = nodeById.get(id);
      const c = nodeEl(n, n.id === activeId);
      nodeEls.set(id, c);
      return c;
    };
    const connector = () => {
      const edge = document.createElement('div');
      edge.className = 'core-run-edge';
      edge.setAttribute('aria-hidden', 'true');
      return edge;
    };
    (segments || []).forEach((seg, si) => {
      if (seg.kind === 'parallel') {
        if (si > 0) agentLane.appendChild(connector());
        const row = document.createElement('div');
        row.className = 'core-run-parallel-row';
        seg.branches.forEach((b) => {
          const col = document.createElement('div');
          col.className = 'core-run-branch-col';
          const head = document.createElement('div');
          head.className = 'core-run-branch-head';
          head.textContent = b.label;
          col.appendChild(head);
          b.nodeIds.forEach((id, i) => {
            if (i > 0) col.appendChild(connector());
            col.appendChild(makeCard(id));
          });
          row.appendChild(col);
        });
        agentLane.appendChild(row);
      } else {
        seg.nodeIds.forEach((id, i) => {
          if (si > 0 || i > 0) agentLane.appendChild(connector());
          agentLane.appendChild(makeCard(id));
        });
      }
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
    drawEdges(svg, nodes, edges, activeId, nodeEls, fileEls);
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
