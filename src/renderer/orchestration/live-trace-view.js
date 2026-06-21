// OrPAD orchestration-core — live-trace Run view (2D data-flow).
//
// One flat 2D scene that reads like the OrPAD sketch: the workspace link graph
// (Obsidian-style) is a force-directed cluster of round FILE nodes on the left;
// the governed-delegation run is a small tree of rounded-rect AGENT chips on the
// right; and the files a run reads/writes are joined to it by blue, flowing
// data-flow curves bridging the two. Pan (drag bg), zoom (wheel), drag a node,
// click a node to focus it, Reset view to frame everything. The Run form lives in
// the left sidebar.
//
// Data: buildEmergentGraph(events) gives the run nodes/edges/files; onLinkGraph()
// gives the vault note↔note link graph. A tiny built-in force simulation lays the
// unified graph out (no graph dependency) and runs incrementally so the layout
// stays stable as the run streams in.

import { buildEmergentGraph } from './emergent-trace.js';

const SVGNS = 'http://www.w3.org/2000/svg';

const TYPE_LABEL = {
  recon: 'Recon', research: 'Research', plan: 'Plan', build: 'Build',
  verify: 'Verify', apply: 'Apply', delegate: 'Delegate', agent: 'Agent',
};
function typeLabel(type) { return TYPE_LABEL[type] || (type ? String(type) : 'Node'); }

function parseLines(value) {
  return String(value || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  } catch (_) { return fallback; }
}

// Node-type accent colours for the agent chips.
const TYPE_COLOR = {
  recon: '#7dcfff', research: '#bb9af7', plan: '#7aa2f7', build: '#9ece6a',
  verify: '#e0af68', apply: '#73daca', delegate: '#7dcfff', agent: '#7dcfff',
};
function runColor(n) { return n.active ? '#ffffff' : (TYPE_COLOR[n.ntype] || '#7dcfff'); }

// --- force-simulation parameters ----------------------------------------------
// Only the FILE nodes are force-laid-out (the Obsidian-style cluster). The agent
// chips get a deterministic tree layout (layoutRunNodes) and are pinned, so the
// run reads as a tidy tree on the right and the vault as an organic web on the left.
const REPULSE = 6500;        // file-file repulsion strength (spreads the cluster)
const CENTER_PULL = 0.006;   // gentle pull toward centre
const SIDE_PULL = 0.06;      // pull the file cluster left of centre
const VELOCITY_DECAY = 0.82;
const ALPHA_DECAY = 0.992;   // slow cool-down so the cluster has time to spread
const LINK = {
  link:   { dist: 70,  k: 0.06 },  // vault note↔note
  flow:   { dist: 78,  k: 0.10 },  // agent→agent (the run tree — pinned, advisory)
  access: { dist: 150, k: 0.02 },  // agent→file (the data-flow bridge — weak + long)
};

export function createLiveTraceView({ onRun = null, onLinkGraph = null, onStop = null } = {}) {
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
          <button type="button" class="core-run-btn core-run-btn-stop" data-core-run-stop hidden>Stop</button>
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
      <svg class="core-run-graph2d" data-core-run-svg>
        <g data-core-run-scene>
          <g data-core-run-edges class="core-run-edges"></g>
          <g data-core-run-nodes class="core-run-nodes"></g>
        </g>
      </svg>
      <div class="core-run-graph-controls">
        <button type="button" class="core-run-zoom-btn" data-core-run-refresh title="Re-scan the workspace link graph">↻ Graph</button>
        <button type="button" class="core-run-zoom-btn" data-core-run-zoomout title="Zoom out">−</button>
        <button type="button" class="core-run-zoom-btn" data-core-run-fit title="Frame the whole graph">Reset view</button>
        <button type="button" class="core-run-zoom-btn" data-core-run-zoomin title="Zoom in">+</button>
      </div>
      <div class="core-run-legend" aria-hidden="true">
        <span><i class="dot" style="background:#7dcfff"></i>agent</span>
        <span><i class="dot" style="background:#6b7194"></i>file</span>
        <span><i class="dot" style="background:#ff9e64"></i>touched / write</span>
        <span><i class="dot" style="background:#9ece6a"></i>read</span>
      </div>
    </div>
  `;

  const statusEl = el.querySelector('[data-core-run-status]');
  const formEl = el.querySelector('[data-core-run-form]');
  const goalEl = el.querySelector('[data-core-run-goal]');
  const writesetEl = el.querySelector('[data-core-run-writeset]');
  const readonlyEl = el.querySelector('[data-core-run-readonly]');
  const timeoutEl = el.querySelector('[data-core-run-timeout]');
  const submitEl = el.querySelector('[data-core-run-submit]');
  const stopEl = el.querySelector('[data-core-run-stop]');
  const errorEl = el.querySelector('[data-core-run-error]');
  const resultEl = el.querySelector('[data-core-run-result]');
  const groundEl = el.querySelector('[data-core-run-ground]');
  const applyEl = el.querySelector('[data-core-run-apply]');
  const parallelEl = el.querySelector('[data-core-run-parallel]');
  const gatesEl = el.querySelector('[data-core-run-gates]');
  const verifyCyclesEl = el.querySelector('[data-core-run-verify-cycles]');
  const viewportEl = el.querySelector('[data-core-run-viewport]');
  const svgEl = el.querySelector('[data-core-run-svg]');
  const sceneEl = el.querySelector('[data-core-run-scene]');
  const edgesEl = el.querySelector('[data-core-run-edges]');
  const nodesEl = el.querySelector('[data-core-run-nodes]');
  const refreshBtn = el.querySelector('[data-core-run-refresh]');
  const fitBtn = el.querySelector('[data-core-run-fit]');
  const zoomInBtn = el.querySelector('[data-core-run-zoomin]');
  const zoomOutBtn = el.querySelector('[data-core-run-zoomout]');

  let events = [];
  let currentRunId = null;
  let errorMessage = '';
  let busy = false;

  // Workspace link graph (lazy-loaded once via onLinkGraph; "↻ Graph" re-scans).
  let linkGraph = null;
  let linkGraphLoading = false;
  let linkGraphTried = false;

  // Persistent graph model (positions survive re-feeds so the layout is stable).
  const nodeById = new Map();   // id -> node object (x, y, vx, vy, kind, __el, …)
  let links = [];
  let alpha = 0;                // simulation "heat"; >0 means keep ticking
  let hadNodes = false;
  let lastFlyId = null;
  let hoverId = null;
  let dragNode = null;

  // View transform (scene = translate(view.x,view.y) scale(view.k)).
  const view = { x: 0, y: 0, k: 1 };
  const viewTarget = { x: 0, y: 0, k: 1, active: false };

  function showFormError(message) { errorEl.textContent = message; errorEl.hidden = !message; }
  function showFormResult(message) { if (!resultEl) return; resultEl.textContent = message || ''; resultEl.hidden = !message; }
  function setBusy(next) {
    busy = next;
    if (submitEl) { submitEl.disabled = next; submitEl.textContent = next ? 'Running…' : 'Run'; }
    if (stopEl) stopEl.hidden = !next;
  }

  function reset() { events = []; errorMessage = ''; lastFlyId = null; render(); }
  function applyEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.runId) currentRunId = ev.runId;
    if (ev.ev === 'run' && ev.state === 'start') { reset(); return; }
    if (ev.ev === 'run' && ev.state === 'error') errorMessage = String(ev.error || 'Run failed.');
    events.push(ev);
    render();
  }

  if (stopEl) {
    stopEl.addEventListener('click', () => {
      if (!currentRunId) return;
      stopEl.disabled = true;
      statusEl.textContent = 'Stopping…';
      statusEl.dataset.state = 'running';
      Promise.resolve(onStop ? onStop(currentRunId) : null).finally(() => { stopEl.disabled = false; });
    });
  }

  function loadLinkGraph(force) {
    if (!onLinkGraph) return;
    if (force) { linkGraph = null; linkGraphTried = false; }
    if (linkGraph || linkGraphLoading || linkGraphTried) return;
    linkGraphTried = true;
    linkGraphLoading = true;
    Promise.resolve(onLinkGraph()).then((res) => {
      linkGraphLoading = false;
      if (res && res.ok) linkGraph = res;
      render();
    }).catch(() => { linkGraphLoading = false; });
  }

  // ---- graph model build ------------------------------------------------------
  function fileRadius(deg) { return Math.max(5, Math.min(22, 5 + Math.sqrt(deg || 0) * 3.4)); }
  function chipSize(name) {
    const w = Math.max(64, Math.min(230, 26 + String(name || '').length * 7.4));
    return { w, h: 30 };
  }

  // Deterministic tree layout for the agent run nodes: depth from the flow DAG
  // gives the row, siblings spread across the column. Pinned (fixed) so the run
  // reads as a tidy tree on the right while the file cluster floats free.
  function layoutRunNodes(runNodes, runEdges) {
    if (!runNodes.length) return;
    const vw = svgEl.clientWidth || 800;
    const vh = svgEl.clientHeight || 600;
    const idIndex = new Map(runNodes.map((n, i) => [n.id, i]));
    const depth = new Map(runNodes.map((n) => [n.id, 0]));
    const edges = (runEdges || []).filter((e) => idIndex.has(e.from) && idIndex.has(e.to));
    for (let pass = 0; pass < runNodes.length; pass++) {
      let changed = false;
      for (const e of edges) {
        const nd = depth.get(e.from) + 1;
        if (nd > depth.get(e.to)) { depth.set(e.to, nd); changed = true; }
      }
      if (!changed) break;
    }
    const levels = new Map();
    for (const n of runNodes) {
      const d = depth.get(n.id);
      if (!levels.has(d)) levels.set(d, []);
      levels.get(d).push(n.id);
    }
    const colX = vw * 0.72;
    const topY = 64;
    const rowGap = Math.max(46, Math.min(66, (vh - 128) / Math.max(1, levels.size)));
    for (const [d, list] of levels) {
      list.forEach((id, i) => {
        const o = nodeById.get(`r:${id}`);
        if (!o) return;
        o.x = colX + (i - (list.length - 1) / 2) * 190;
        o.y = topY + d * rowGap;
        o.fixed = true;
        o.__rr = Math.max(o.w, o.h) / 2 + 8;
      });
    }
  }

  function buildModel(runNodes, runEdges, files, activeId) {
    const wanted = new Set();
    const vw = svgEl.clientWidth || 800;
    const vh = svgEl.clientHeight || 600;

    const ensure = (id, init, seed) => {
      let o = nodeById.get(id);
      if (!o) {
        o = { id, x: seed.x, y: seed.y, vx: 0, vy: 0, fixed: false, __el: null };
        nodeById.set(id, o);
        alpha = Math.max(alpha, 0.9); // reheat when topology grows
      }
      Object.assign(o, init);
      wanted.add(id);
      return o;
    };

    // Agent/run chips — created here; positioned by the deterministic tree layout below.
    runNodes.forEach((n) => {
      ensure(`r:${n.id}`, {
        kind: 'run', ntype: n.type, name: n.label || typeLabel(n.type),
        phase: !!n.phase, active: n.id === activeId,
        ...chipSize(n.label || typeLabel(n.type)),
      }, { x: vw * 0.72, y: vh * 0.5 });
    });
    layoutRunNodes(runNodes, runEdges);

    // File circles — vault notes (left cluster) ∪ run-touched files.
    const vault = (linkGraph && linkGraph.ok && Array.isArray(linkGraph.nodes)) ? linkGraph.nodes : [];
    const vaultPaths = new Set(vault.map((v) => v.path));
    vault.slice(0, 400).forEach((v) => {
      ensure(`f:${v.path}`, { kind: 'file', path: v.path, name: v.name, deg: (v.out || 0) + (v.in || 0), touched: false, r: fileRadius((v.out || 0) + (v.in || 0)) },
        { x: vw * 0.3 + (Math.random() - 0.5) * vw * 0.4, y: vh * 0.5 + (Math.random() - 0.5) * vh * 0.6 });
    });
    const touched = new Set((files || []).map((f) => f.path));
    (files || []).forEach((f) => {
      if (vaultPaths.has(f.path)) return;
      ensure(`f:${f.path}`, { kind: 'file', path: f.path, name: f.path.split(/[\\/]/).pop(), deg: (f.reads || 0) + (f.writes || 0), touched: true, r: fileRadius((f.reads || 0) + (f.writes || 0)) },
        { x: vw * 0.45 + (Math.random() - 0.5) * 60, y: vh * 0.5 + (Math.random() - 0.5) * 60 });
    });
    for (const o of nodeById.values()) if (o.kind === 'file' && touched.has(o.path)) o.touched = true;

    // Drop stale nodes (and their DOM).
    for (const id of [...nodeById.keys()]) {
      if (wanted.has(id)) continue;
      const o = nodeById.get(id);
      if (o.__el && o.__el.parentNode) o.__el.parentNode.removeChild(o.__el);
      nodeById.delete(id);
    }

    // Links.
    const next = [];
    for (const e of (runEdges || [])) {
      const s = nodeById.get(`r:${e.from}`), t = nodeById.get(`r:${e.to}`);
      if (s && t) next.push({ source: s, target: t, kind: 'flow' });
    }
    for (const n of runNodes) {
      const f = n.file && nodeById.get(`f:${n.file}`);
      const s = nodeById.get(`r:${n.id}`);
      if (f && s) next.push({ source: s, target: f, kind: 'access', access: n.access || 'touch', active: n.id === activeId });
    }
    const vedges = (linkGraph && Array.isArray(linkGraph.edges)) ? linkGraph.edges : [];
    for (const e of vedges) {
      const s = nodeById.get(`f:${e.from}`), t = nodeById.get(`f:${e.to}`);
      if (s && t) next.push({ source: s, target: t, kind: 'link' });
    }
    links = next;
  }

  // ---- force simulation (incremental) ----------------------------------------
  function step() {
    const nodes = [...nodeById.values()];
    const n = nodes.length;
    if (!n) return;
    const vw = svgEl.clientWidth || 800;
    const vh = svgEl.clientHeight || 600;
    const cx = vw / 2, cy = vh / 2;
    const a = alpha;

    // Radius (used for soft collision so dense clusters spread, chips never overlap files).
    const rOf = (p) => p.__rr || (p.kind === 'file' ? (p.r || 6) + 8 : Math.max(p.w || 80, p.h || 30) / 2 + 8);
    // Pairwise repulsion (capped node count keeps this cheap).
    for (let i = 0; i < n; i++) {
      const p = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const q = nodes[j];
        let dx = p.x - q.x, dy = p.y - q.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); d2 = 0.25; }
        const d = Math.sqrt(d2);
        let f = (REPULSE * a) / d2;
        // Hard-ish floor when overlapping radii so nodes never stack.
        const minD = rOf(p) + rOf(q);
        if (d < minD) f += (minD - d) * 0.5;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        p.vx += fx; p.vy += fy; q.vx -= fx; q.vy -= fy;
      }
    }
    // Link springs.
    for (const l of links) {
      const cfg = LINK[l.kind] || LINK.link;
      const s = l.source, t = l.target;
      let dx = t.x - s.x, dy = t.y - s.y;
      let d = Math.hypot(dx, dy) || 0.01;
      const f = (d - cfg.dist) * cfg.k * a;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      s.vx += fx; s.vy += fy; t.vx -= fx; t.vy -= fy;
    }
    // Centering + leftward bias — files only (agent chips are pinned by layout).
    const fileTargetX = cx - vw * 0.24;
    for (const p of nodes) {
      if (p.kind !== 'file') continue;
      p.vy += (cy - p.y) * CENTER_PULL * a;
      p.vx += (fileTargetX - p.x) * SIDE_PULL * a;
    }
    // Integrate.
    for (const p of nodes) {
      if (p.fixed) { p.vx = 0; p.vy = 0; continue; }
      p.vx *= VELOCITY_DECAY; p.vy *= VELOCITY_DECAY;
      p.x += p.vx; p.y += p.vy;
    }
    alpha *= ALPHA_DECAY;
    if (alpha < 0.004) alpha = 0;
  }

  // ---- rendering --------------------------------------------------------------
  function edgeColor(l) {
    if (l.kind === 'access') {
      if (l.access === 'write') return cssVar('--syntax-number', '#ff9e64');
      if (l.access === 'read') return cssVar('--syntax-string', '#9ece6a');
      return cssVar('--accent-color', '#7dcfff');
    }
    if (l.kind === 'flow') return cssVar('--text-tertiary', '#7a8194');
    return cssVar('--border-color', '#444a66');
  }

  function ensureNodeEl(node) {
    if (node.__el) return node.__el;
    if (node.kind === 'file') {
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'crn-file');
      const c = document.createElementNS(SVGNS, 'circle');
      g.appendChild(c);
      const t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('class', 'crn-file-label');
      t.setAttribute('text-anchor', 'middle');
      g.appendChild(t);
      node.__circle = c; node.__label = t;
      g.addEventListener('pointerenter', () => { hoverId = node.id; paintHighlight(); });
      g.addEventListener('pointerleave', () => { if (hoverId === node.id) { hoverId = null; paintHighlight(); } });
      attachDrag(g, node);
      nodesEl.appendChild(g);
      node.__el = g;
    } else {
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'crn-run');
      const r = document.createElementNS(SVGNS, 'rect');
      r.setAttribute('rx', '8'); r.setAttribute('ry', '8');
      g.appendChild(r);
      const t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('class', 'crn-run-label');
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('dominant-baseline', 'central');
      g.appendChild(t);
      node.__rect = r; node.__label = t;
      g.addEventListener('pointerenter', () => { hoverId = node.id; paintHighlight(); });
      g.addEventListener('pointerleave', () => { if (hoverId === node.id) { hoverId = null; paintHighlight(); } });
      g.addEventListener('click', (e) => { e.stopPropagation(); focusNode(node); });
      attachDrag(g, node);
      nodesEl.appendChild(g);
      node.__el = g;
    }
    return node.__el;
  }

  function paintNode(node) {
    const g = ensureNodeEl(node);
    if (node.kind === 'file') {
      const r = node.r || 6;
      node.__circle.setAttribute('cx', node.x);
      node.__circle.setAttribute('cy', node.y);
      node.__circle.setAttribute('r', r);
      node.__circle.setAttribute('fill', node.touched ? cssVar('--syntax-number', '#ff9e64') : cssVar('--text-tertiary', '#6b7194'));
      node.__circle.setAttribute('stroke', node.touched ? cssVar('--syntax-number', '#ff9e64') : cssVar('--border-color', '#444a66'));
      node.__label.textContent = node.name || '';
      node.__label.setAttribute('x', node.x);
      node.__label.setAttribute('y', node.y + r + 11);
    } else {
      const { w, h } = node;
      node.__rect.setAttribute('x', node.x - w / 2);
      node.__rect.setAttribute('y', node.y - h / 2);
      node.__rect.setAttribute('width', w);
      node.__rect.setAttribute('height', h);
      node.__rect.setAttribute('fill', cssVar('--bg-secondary', '#1f2335'));
      node.__rect.setAttribute('stroke', runColor(node));
      node.__rect.setAttribute('stroke-width', node.active ? 2.4 : 1.4);
      node.__el.classList.toggle('is-active', !!node.active);
      node.__el.classList.toggle('is-phase', !!node.phase);
      node.__label.textContent = node.name || '';
      node.__label.setAttribute('x', node.x);
      node.__label.setAttribute('y', node.y);
      node.__label.setAttribute('fill', cssVar('--text-primary', '#c0caf5'));
    }
  }

  function paintEdges() {
    // Reconcile edge <path> elements (rebuild — edges are few and cheap).
    while (edgesEl.firstChild) edgesEl.removeChild(edgesEl.firstChild);
    for (const l of links) {
      const s = l.source, t = l.target;
      const path = document.createElementNS(SVGNS, 'path');
      let cls = 'crn-edge crn-edge-' + l.kind;
      if (l.kind === 'access') {
        cls += ' access-' + (l.access || 'touch');
        if (l.active) cls += ' is-active';
        // Curved bridge for the data-flow.
        const mx = (s.x + t.x) / 2;
        const dy = (t.y - s.y) * 0.2;
        path.setAttribute('d', `M ${s.x} ${s.y} C ${mx} ${s.y + dy} ${mx} ${t.y - dy} ${t.x} ${t.y}`);
      } else {
        path.setAttribute('d', `M ${s.x} ${s.y} L ${t.x} ${t.y}`);
      }
      path.setAttribute('class', cls);
      path.setAttribute('stroke', edgeColor(l));
      l.__el = path;
      l.__s = s; l.__t = t;
      edgesEl.appendChild(path);
    }
  }

  function paintHighlight() {
    if (!hoverId) {
      nodesEl.classList.remove('has-hover');
      for (const n of nodeById.values()) { if (n.__el) { n.__el.classList.remove('is-hot', 'is-dim'); } }
      for (const l of links) if (l.__el) l.__el.classList.remove('is-dim');
      return;
    }
    nodesEl.classList.add('has-hover');
    const hot = new Set([hoverId]);
    for (const l of links) {
      if (l.source.id === hoverId) hot.add(l.target.id);
      if (l.target.id === hoverId) hot.add(l.source.id);
    }
    for (const n of nodeById.values()) {
      if (!n.__el) continue;
      n.__el.classList.toggle('is-hot', hot.has(n.id));
      n.__el.classList.toggle('is-dim', !hot.has(n.id));
    }
    for (const l of links) {
      if (!l.__el) continue;
      l.__el.classList.toggle('is-dim', !(l.source.id === hoverId || l.target.id === hoverId));
    }
  }

  function paintPositions() {
    for (const n of nodeById.values()) if (n.__el) paintNode(n);
    for (const l of links) {
      if (!l.__el) continue;
      const s = l.__s, t = l.__t;
      if (l.kind === 'access') {
        const mx = (s.x + t.x) / 2;
        const dy = (t.y - s.y) * 0.2;
        l.__el.setAttribute('d', `M ${s.x} ${s.y} C ${mx} ${s.y + dy} ${mx} ${t.y - dy} ${t.x} ${t.y}`);
      } else {
        l.__el.setAttribute('d', `M ${s.x} ${s.y} L ${t.x} ${t.y}`);
      }
    }
  }

  function applyTransform() {
    sceneEl.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
  }

  // ---- camera (fit / focus / follow) -----------------------------------------
  function nodeBBox() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    for (const n of nodeById.values()) {
      any = true;
      const pad = n.kind === 'file' ? (n.r || 6) + 14 : (n.w || 80) / 2 + 6;
      const padY = n.kind === 'file' ? (n.r || 6) + 14 : (n.h || 30) / 2 + 6;
      minX = Math.min(minX, n.x - pad); maxX = Math.max(maxX, n.x + pad);
      minY = Math.min(minY, n.y - padY); maxY = Math.max(maxY, n.y + padY);
    }
    return any ? { minX, minY, maxX, maxY } : null;
  }
  function zoomToFit(pad = 40) {
    const bb = nodeBBox();
    if (!bb) return;
    const vw = svgEl.clientWidth || 800, vh = svgEl.clientHeight || 600;
    const bw = Math.max(1, bb.maxX - bb.minX), bh = Math.max(1, bb.maxY - bb.minY);
    const k = Math.max(0.2, Math.min(1.6, Math.min((vw - pad * 2) / bw, (vh - pad * 2) / bh)));
    const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
    setViewTarget(vw / 2 - cx * k, vh / 2 - cy * k, k);
  }
  function focusNode(node) {
    if (!node) return;
    const vw = svgEl.clientWidth || 800, vh = svgEl.clientHeight || 600;
    const k = Math.max(view.k, 1.1);
    setViewTarget(vw / 2 - node.x * k, vh / 2 - node.y * k, k);
  }
  function setViewTarget(x, y, k) { viewTarget.x = x; viewTarget.y = y; viewTarget.k = k; viewTarget.active = true; }
  function setViewNow(x, y, k) { view.x = x; view.y = y; view.k = k; viewTarget.active = false; applyTransform(); }

  // ---- animation loop ---------------------------------------------------------
  let rafId = null;
  function loop() {
    rafId = null;
    if (alpha > 0) { step(); paintPositions(); }
    if (viewTarget.active) {
      view.x += (viewTarget.x - view.x) * 0.18;
      view.y += (viewTarget.y - view.y) * 0.18;
      view.k += (viewTarget.k - view.k) * 0.18;
      applyTransform();
      if (Math.abs(viewTarget.x - view.x) < 0.4 && Math.abs(viewTarget.y - view.y) < 0.4 && Math.abs(viewTarget.k - view.k) < 0.002) {
        view.x = viewTarget.x; view.y = viewTarget.y; view.k = viewTarget.k; viewTarget.active = false; applyTransform();
      }
    }
    if (alpha > 0 || viewTarget.active || dragNode) schedule();
  }
  function schedule() { if (rafId == null && typeof requestAnimationFrame !== 'undefined') rafId = requestAnimationFrame(loop); }

  // ---- interaction ------------------------------------------------------------
  function screenToGraph(clientX, clientY) {
    const rect = svgEl.getBoundingClientRect();
    return { x: (clientX - rect.left - view.x) / view.k, y: (clientY - rect.top - view.y) / view.k };
  }
  function attachDrag(g, node) {
    g.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      dragNode = node;
      node.fixed = true;
      const p = screenToGraph(e.clientX, e.clientY);
      node.__dx = node.x - p.x; node.__dy = node.y - p.y;
      g.setPointerCapture && g.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const q = screenToGraph(ev.clientX, ev.clientY);
        node.x = q.x + node.__dx; node.y = q.y + node.__dy;
        paintPositions();
      };
      const up = (ev) => {
        node.fixed = false;
        dragNode = null;
        alpha = Math.max(alpha, 0.4); schedule();
        g.releasePointerCapture && g.releasePointerCapture(ev.pointerId);
        g.removeEventListener('pointermove', move);
        g.removeEventListener('pointerup', up);
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
    });
  }
  // Pan by dragging the background.
  let panning = null;
  svgEl.addEventListener('pointerdown', (e) => {
    if (e.target !== svgEl && e.target.tagName !== 'svg') return;
    panning = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    viewportEl.classList.add('is-panning');
    svgEl.setPointerCapture && svgEl.setPointerCapture(e.pointerId);
  });
  svgEl.addEventListener('pointermove', (e) => {
    if (!panning) return;
    view.x = panning.vx + (e.clientX - panning.x);
    view.y = panning.vy + (e.clientY - panning.y);
    viewTarget.active = false;
    applyTransform();
  });
  const endPan = () => { panning = null; viewportEl.classList.remove('is-panning'); };
  svgEl.addEventListener('pointerup', endPan);
  svgEl.addEventListener('pointerleave', endPan);
  // Wheel zoom anchored at the cursor.
  svgEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = svgEl.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const k = Math.max(0.2, Math.min(2.5, view.k * factor));
    // keep the graph point under the cursor fixed
    view.x = mx - ((mx - view.x) / view.k) * k;
    view.y = my - ((my - view.y) / view.k) * k;
    view.k = k;
    viewTarget.active = false;
    applyTransform();
  }, { passive: false });

  // ---- status -----------------------------------------------------------------
  function setStatus(runNodes, done) {
    if (errorMessage) { statusEl.textContent = `Error — ${errorMessage}`; statusEl.dataset.state = 'error'; return; }
    if (busy) {
      const active = runNodes.find((n) => n.active);
      statusEl.textContent = !runNodes.length ? 'Starting run…' : `Running — ${active ? (active.name || typeLabel(active.ntype)) : 'working'}…`;
      statusEl.dataset.state = 'running';
      return;
    }
    if (!runNodes.length) { statusEl.textContent = 'Idle — no run yet.'; statusEl.dataset.state = 'idle'; return; }
    if (done) { statusEl.textContent = `Run complete — ${runNodes.length} node${runNodes.length === 1 ? '' : 's'}.`; statusEl.dataset.state = 'done'; return; }
    statusEl.textContent = `Running — ${runNodes.length} node${runNodes.length === 1 ? '' : 's'}…`;
    statusEl.dataset.state = 'running';
  }

  function render() {
    loadLinkGraph(false);
    const { nodes, edges, activeId, done, files } = buildEmergentGraph(events);
    const runNodes = nodes.map((n) => ({ id: n.id, type: n.type, label: n.label, phase: n.phase, file: n.file, access: n.access, active: n.id === activeId }));
    buildModel(runNodes, edges, files, activeId);

    const statNodes = [...nodeById.values()].filter((n) => n.kind === 'run');
    setStatus(statNodes, done);

    paintEdges();
    for (const n of nodeById.values()) paintNode(n);
    paintHighlight();
    schedule();

    // Frame on first appearance and on completion; follow the active node live.
    if (!hadNodes && nodeById.size) { hadNodes = true; setTimeout(() => zoomToFit(50), 500); }
    if (done && nodeById.size) setTimeout(() => zoomToFit(50), 400);
    if (busy && activeId && activeId !== lastFlyId) {
      lastFlyId = activeId;
      const obj = nodeById.get(`r:${activeId}`);
      if (obj) setTimeout(() => focusNode(obj), 350);
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

  if (refreshBtn) refreshBtn.addEventListener('click', () => { loadLinkGraph(true); });
  if (fitBtn) fitBtn.addEventListener('click', () => zoomToFit(50));
  if (zoomInBtn) zoomInBtn.addEventListener('click', () => {
    const vw = svgEl.clientWidth / 2, vh = svgEl.clientHeight / 2;
    const k = Math.min(2.5, view.k * 1.2);
    view.x = vw - ((vw - view.x) / view.k) * k; view.y = vh - ((vh - view.y) / view.k) * k; view.k = k; applyTransform();
  });
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => {
    const vw = svgEl.clientWidth / 2, vh = svgEl.clientHeight / 2;
    const k = Math.max(0.2, view.k / 1.2);
    view.x = vw - ((vw - view.x) / view.k) * k; view.y = vh - ((vh - view.y) / view.k) * k; view.k = k; applyTransform();
  });

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => { schedule(); });
    ro.observe(viewportEl);
  }

  render();
  return { el, applyEvent, reset };
}
