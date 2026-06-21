// OrPAD orchestration-core — live-trace Run view (3D).
//
// One unified 3D scene (three.js via 3d-force-graph): the governed-delegation run
// graph AND the workspace link graph (the Obsidian-style file layer) together.
// Run work-nodes connect to the file nodes they read/write with directional
// PARTICLE edges — data physically moving along the link. Orbit/zoom/drag are
// built in; click a node to fly to it. The Run form lives in the left sidebar.
//
// Data: buildEmergentGraph(events) gives the run nodes/edges/files; onLinkGraph()
// gives the vault note↔note link graph. Both feed one { nodes, links } graph.

import { buildEmergentGraph } from './emergent-trace.js';
import ForceGraph3D from '3d-force-graph';

const TYPE_LABEL = {
  recon: 'Recon', isolate: 'Isolate', guidance: 'Guidance', delegate: 'Delegate',
  enforce: 'Enforce', inspect: 'Inspect', edit: 'Edit', exec: 'Exec',
  research: 'Research', subagent: 'Subagent', plan: 'Plan', reason: 'Reason',
  tool: 'Tool', phase: 'Phase',
};
function typeLabel(type) { return TYPE_LABEL[type] || (type ? String(type) : 'Node'); }

function parseLines(value) {
  return String(value || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// Node-type colours (mirror the 2D type accents).
const TYPE_COLOR = {
  recon: '#7aa2f7', isolate: '#bb9af7', guidance: '#e0af68', delegate: '#7dcfff',
  enforce: '#9ece6a', inspect: '#9ece6a', edit: '#ff9e64', exec: '#bb9af7',
  research: '#e0af68', subagent: '#7dcfff', plan: '#7aa2f7', reason: '#9aa5ce', tool: '#9aa5ce',
};
const FILE_COLOR = '#6b7194';
const FILE_TOUCHED_COLOR = '#ff9e64';
const ACTIVE_COLOR = '#ffffff';

function nodeColor(n) {
  if (n.kind === 'file') return n.touched ? FILE_TOUCHED_COLOR : FILE_COLOR;
  if (n.active) return ACTIVE_COLOR;
  return TYPE_COLOR[n.ntype] || '#9aa5ce';
}
function linkColor(l) {
  if (l.kind === 'access') return l.access === 'write' ? '#ff9e64' : l.access === 'read' ? '#9ece6a' : '#9aa5ce';
  if (l.kind === 'flow') return '#7dcfff';
  return '#444a66';
}

// onRun: optional async (request) => summary (hides the form when omitted).
// onLinkGraph: optional async () => { ok, nodes, edges } for the workspace link graph.
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
      <div class="core-run-graph3d" data-core-run-graph3d></div>
      <div class="core-run-graph-controls">
        <button type="button" class="core-run-zoom-btn" data-core-run-refresh title="Re-scan the workspace link graph">↻ Graph</button>
        <button type="button" class="core-run-zoom-btn" data-core-run-fit title="Frame the whole graph">Reset view</button>
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
  const errorEl = el.querySelector('[data-core-run-error]');
  const resultEl = el.querySelector('[data-core-run-result]');
  const groundEl = el.querySelector('[data-core-run-ground]');
  const applyEl = el.querySelector('[data-core-run-apply]');
  const parallelEl = el.querySelector('[data-core-run-parallel]');
  const gatesEl = el.querySelector('[data-core-run-gates]');
  const verifyCyclesEl = el.querySelector('[data-core-run-verify-cycles]');
  const graph3dEl = el.querySelector('[data-core-run-graph3d]');
  const refreshBtn = el.querySelector('[data-core-run-refresh]');
  const fitBtn = el.querySelector('[data-core-run-fit]');

  let events = [];
  let errorMessage = '';
  let busy = false;

  // Workspace link graph (lazy-loaded once via onLinkGraph; "↻ Graph" re-scans).
  let linkGraph = null;
  let linkGraphLoading = false;
  let linkGraphTried = false;

  // 3D graph instance + persistent node objects (so positions survive re-feeds).
  let fg = null;
  const fgNodeById = new Map();
  let lastSig = '';

  function showFormError(message) { errorEl.textContent = message; errorEl.hidden = !message; }
  function showFormResult(message) { if (!resultEl) return; resultEl.textContent = message || ''; resultEl.hidden = !message; }
  function setBusy(next) {
    busy = next;
    if (submitEl) { submitEl.disabled = next; submitEl.textContent = next ? 'Running…' : 'Run'; }
  }

  function reset() { events = []; errorMessage = ''; render(); }
  function applyEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.ev === 'run' && ev.state === 'start') { reset(); return; }
    if (ev.ev === 'run' && ev.state === 'error') errorMessage = String(ev.error || 'Run failed.');
    events.push(ev);
    render();
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
      lastSig = '';
      render();
    }).catch(() => { linkGraphLoading = false; });
  }

  // --- 3D graph ----------------------------------------------------------------
  function ensureFG() {
    if (fg) return fg;
    if (!graph3dEl || !graph3dEl.clientWidth) return null;
    fg = ForceGraph3D()(graph3dEl)
      .backgroundColor('rgba(0,0,0,0)')
      .width(graph3dEl.clientWidth)
      .height(graph3dEl.clientHeight)
      .showNavInfo(false)
      .nodeLabel((n) => (n.kind === 'file' ? `📄 ${n.path}` : `${typeLabel(n.ntype)} — ${n.name}`))
      .nodeColor(nodeColor)
      .nodeVal((n) => (n.kind === 'file' ? Math.max(1.5, (n.deg || 0) + 1) : (n.phase ? 3 : 2)))
      .nodeOpacity(0.92)
      .linkColor(linkColor)
      .linkWidth((l) => (l.kind === 'access' ? 1.2 : 0.5))
      .linkOpacity(0.35)
      .linkDirectionalParticles((l) => (l.kind === 'access' ? 3 : l.kind === 'flow' ? 1 : 0))
      .linkDirectionalParticleSpeed(0.012)
      .linkDirectionalParticleWidth(2)
      .linkDirectionalParticleColor((l) => linkColor(l))
      .onNodeClick((node) => {
        const d = 90;
        const r = 1 + d / Math.hypot(node.x || 1, node.y || 1, node.z || 1);
        fg.cameraPosition({ x: (node.x || 0) * r, y: (node.y || 0) * r, z: (node.z || 0) * r }, node, 700);
      });
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => { if (fg && graph3dEl.clientWidth) fg.width(graph3dEl.clientWidth).height(graph3dEl.clientHeight); });
      ro.observe(graph3dEl);
    }
    return fg;
  }

  // Build the unified { nodes, links } graph, reusing node objects so the 3D layout
  // is stable as the run streams in.
  function buildGraphData(runNodes, runEdges, files, activeId) {
    const wanted = new Set();
    const nodes = [];
    const ensure = (id, init) => {
      let o = fgNodeById.get(id);
      if (!o) { o = { id }; fgNodeById.set(id, o); }
      Object.assign(o, init);
      wanted.add(id);
      nodes.push(o);
      return o;
    };
    for (const n of runNodes) {
      ensure(`r:${n.id}`, { kind: 'run', ntype: n.type, name: n.label || n.type, phase: !!n.phase, active: n.id === activeId });
    }
    const vault = (linkGraph && linkGraph.ok && Array.isArray(linkGraph.nodes)) ? linkGraph.nodes : [];
    const vaultPaths = new Set(vault.map((v) => v.path));
    for (const v of vault.slice(0, 600)) {
      ensure(`f:${v.path}`, { kind: 'file', path: v.path, name: v.name, deg: (v.out || 0) + (v.in || 0), touched: false });
    }
    const touched = new Set((files || []).map((f) => f.path));
    for (const f of (files || [])) {
      if (!vaultPaths.has(f.path)) ensure(`f:${f.path}`, { kind: 'file', path: f.path, name: f.path.split(/[\\/]/).pop(), deg: (f.reads || 0) + (f.writes || 0), touched: true });
    }
    // mark touched on vault nodes too
    for (const o of nodes) if (o.kind === 'file' && touched.has(o.path)) o.touched = true;

    // drop stale nodes
    for (const id of [...fgNodeById.keys()]) if (!wanted.has(id)) fgNodeById.delete(id);

    const links = [];
    for (const e of (runEdges || [])) links.push({ source: `r:${e.from}`, target: `r:${e.to}`, kind: 'flow' });
    for (const n of runNodes) {
      if (n.file && fgNodeById.has(`f:${n.file}`)) links.push({ source: `r:${n.id}`, target: `f:${n.file}`, kind: 'access', access: n.access || 'touch' });
    }
    const vedges = (linkGraph && Array.isArray(linkGraph.edges)) ? linkGraph.edges : [];
    for (const e of vedges) {
      if (fgNodeById.has(`f:${e.from}`) && fgNodeById.has(`f:${e.to}`)) links.push({ source: `f:${e.from}`, target: `f:${e.to}`, kind: 'link' });
    }
    return { nodes, links };
  }

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
    const data = buildGraphData(runNodes, edges, files, activeId);
    // active flag for status
    const statNodes = data.nodes.filter((n) => n.kind === 'run');
    setStatus(statNodes, done);

    const graph = ensureFG();
    if (graph) {
      const sig = `${data.nodes.length}:${data.links.length}:${activeId || ''}:${linkGraph ? linkGraph.nodes.length : 0}`;
      if (sig !== lastSig) { lastSig = sig; graph.graphData(data); }
      else { graph.nodeColor(nodeColor); } // refresh colours (e.g. active node) without reheating
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
  if (fitBtn) fitBtn.addEventListener('click', () => { if (fg) fg.zoomToFit(600, 60); });

  // First paint may run before the element is laid out (clientWidth 0); retry once
  // the viewport has size so the 3D scene initialises.
  render();
  if (graph3dEl && !graph3dEl.clientWidth && typeof requestAnimationFrame !== 'undefined') {
    const tryInit = () => { if (graph3dEl.clientWidth) { render(); } else { requestAnimationFrame(tryInit); } };
    requestAnimationFrame(tryInit);
  }
  return { el, applyEvent, reset };
}
