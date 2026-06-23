// OrPAD orchestration-core — live-trace Run view (3D "galaxy + DNA helix").
//
// One unified 3D scene (three.js via 3d-force-graph), freely orbit/zoom/drag-able:
//   • The workspace link graph (Obsidian-style vault) is the CORE — a solid ball
//     of note spheres pulled to the origin (the galaxy centre).
//   • A run's work nodes spiral OUTWARD from the core as a DNA-like helix, in
//     execution order (read bottom→top = chronological). Fanned-out sub-agents
//     braid alongside as extra strands, so a read/write node can be traced back
//     along its strand.
//   • When a work node reads/writes a file it gets a data-flow link to that file —
//     a glowing line with particles streaming along it (data physically moving):
//     READ streams the file's data INTO the node (file→node, teal); WRITE streams
//     OUT (node→file, orange).
//   • Files the run touches that are NOT vault notes (e.g. source files) don't
//     belong in the core — they hang just OUTSIDE the work node that touched them
//     (a "leaf"), so the flow reads radially (core → helix → leaf) instead of
//     crisscrossing back through the core.
//
// Data: buildEmergentGraph(events) → run nodes/edges/files (+ per-node `branch`);
// onLinkGraph() → the vault note↔note link graph. Both feed one { nodes, links }.

import { buildEmergentGraph } from './emergent-trace.js';
import ForceGraph3D from '3d-force-graph';

const TYPE_LABEL = {
  recon: 'Recon', isolate: 'Isolate', guidance: 'Guidance', delegate: 'Delegate',
  enforce: 'Enforce', inspect: 'Inspect', edit: 'Edit', exec: 'Exec',
  research: 'Research', subagent: 'Subagent', plan: 'Plan', reason: 'Reason',
  tool: 'Tool', phase: 'Phase', agent: 'Agent',
};
function typeLabel(type) { return TYPE_LABEL[type] || (type ? String(type) : 'Node'); }

function parseLines(value) {
  return String(value || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// --- palette (data-flow accents; background follows the app theme) -------------
const TYPE_COLOR = {
  recon: '#7aa2f7', isolate: '#bb9af7', guidance: '#e0af68', delegate: '#7dcfff',
  enforce: '#9ece6a', inspect: '#9ece6a', edit: '#ff9e64', exec: '#bb9af7',
  research: '#e0af68', subagent: '#7dcfff', plan: '#7aa2f7', reason: '#9aa5ce',
  tool: '#9aa5ce', agent: '#7dcfff',
};
const FILE_COLOR = '#5b6699';
const FILE_TOUCHED_COLOR = '#ff9e64';
const ACTIVE_COLOR = '#ffffff';
const ACCESS_READ = '#73f0c0';   // bright teal — reading a file
const ACCESS_WRITE = '#ff9e64';  // orange — writing a file
const ACCESS_TOUCH = '#7dcfff';
const FLOW_COLOR = '#5fa8ff';    // intra-planet execution order
const VAULT_LINK_COLOR = '#2e3b66';

function nodeColor(n) {
  if (n.kind === 'file') return n.touched ? FILE_TOUCHED_COLOR : FILE_COLOR;
  if (n.active) return ACTIVE_COLOR;
  return TYPE_COLOR[n.ntype] || '#9aa5ce';
}
function linkColor(l) {
  if (l.kind === 'access') return l.access === 'write' ? ACCESS_WRITE : l.access === 'read' ? ACCESS_READ : ACCESS_TOUCH;
  if (l.kind === 'flow') return FLOW_COLOR;
  return VAULT_LINK_COLOR;
}

// --- galaxy + helix layout ----------------------------------------------------
// Tunables — one-liners; tweak then Ctrl+R in the dev build.
const FILE_GRAVITY = 0.045;       // pull of vault-note files to origin (tightness of the core ball)
const HELIX_PULL   = 0.16;        // pull of each work node toward its own helix slot
const HELIX_RADIUS = 90;          // radius of the helix cylinder
const HELIX_PITCH  = 30;          // +Y rise per work node (helix "stretch" — bigger = more traceable)
const HELIX_TURN   = Math.PI / 4; // angle step per node (~8 nodes per turn)
const STRAND_PHASE = Math.PI;     // angular offset of each braided sub-agent strand (π = opposite side)
const STRAND_GAP   = 18;          // radius bump per braided strand

const ORIGIN = { x: 0, y: 0, z: 0 };

// Core-ball radius grows (slowly) with the note count so the helix can start just
// OUTSIDE the core rather than buried inside it.
function coreRadius(noteCount) {
  return Math.max(70, Math.cbrt(Math.max(1, noteCount)) * 40);
}
// Per-node helix slot: rises with global execution order `g`, braided per strand.
// Reading the strand bottom→top replays the run in order.
function helixSlot(g, strand, base) {
  const ang = HELIX_TURN * g + strand * STRAND_PHASE;
  const rad = HELIX_RADIUS + strand * STRAND_GAP;
  return { x: Math.cos(ang) * rad, y: base + HELIX_PITCH * g, z: Math.sin(ang) * rad };
}
// Small deterministic spawn jitter so freshly-born nodes aren't coincident (charge
// would NaN) — they're born AT the core and visibly travel out to their slot/leaf.
function seedPos(seed) {
  const f = (k) => { const x = Math.sin(seed * k) * 43758.5453; return (x - Math.floor(x) - 0.5) * 9; };
  return { x: f(12.9898), y: f(78.233), z: f(37.719) };
}

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
    <div class="core-run-graph-viewport core-run-graph-viewport-3d" data-core-run-viewport>
      <div class="core-run-3d" data-core-run-3d></div>
      <div class="core-run-graph-controls">
        <button type="button" class="core-run-zoom-btn" data-core-run-refresh title="Re-scan the workspace link graph">↻ Graph</button>
        <button type="button" class="core-run-zoom-btn" data-core-run-fit title="Frame the whole galaxy">Reset view</button>
      </div>
      <div class="core-run-legend" aria-hidden="true">
        <span><i class="dot" style="background:${TYPE_COLOR.delegate}"></i>agent</span>
        <span><i class="dot" style="background:${FILE_COLOR}"></i>file</span>
        <span><i class="dot" style="background:${ACCESS_WRITE}"></i>write</span>
        <span><i class="dot" style="background:${ACCESS_READ}"></i>read</span>
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
  const graph3dEl = el.querySelector('[data-core-run-3d]');
  const refreshBtn = el.querySelector('[data-core-run-refresh]');
  const fitBtn = el.querySelector('[data-core-run-fit]');

  let events = [];
  let currentRunId = null;
  let errorMessage = '';
  let busy = false;

  // Workspace link graph (lazy-loaded once via onLinkGraph; "↻ Graph" re-scans).
  let linkGraph = null;
  let linkGraphLoading = false;
  let linkGraphTried = false;

  // 3D graph state.
  let fg = null;
  const fgNodeById = new Map();  // id -> node object (reused so the layout is stable)
  let lastSig = '';
  let framedOnce = false;        // auto-frame the galaxy once after it first settles
  let lastFitCount = 0;          // node count at the last auto-frame (re-frame as the helix grows)

  function showFormError(message) { errorEl.textContent = message; errorEl.hidden = !message; }
  function showFormResult(message) { if (!resultEl) return; resultEl.textContent = message || ''; resultEl.hidden = !message; }
  function setBusy(next) {
    busy = next;
    if (submitEl) { submitEl.disabled = next; submitEl.textContent = next ? 'Running…' : 'Run'; }
    if (stopEl) stopEl.hidden = !next;
  }

  function reset() { events = []; errorMessage = ''; lastSig = ''; render(); }
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
      lastSig = '';
      render();
    }).catch(() => { linkGraphLoading = false; });
  }

  // --- 3D graph ----------------------------------------------------------------
  // A custom d3 force:
  //   • vault-note files fall toward the origin (the core ball),
  //   • each work node falls toward its OWN helix slot (n.slot) → a traceable strand,
  //   • touched non-vault "leaf" files get no gravity — their access spring parks
  //     them just outside the work node that touched them (radial, not crisscrossing).
  function galaxyForce() {
    let nodes = [];
    function force(alpha) {
      const kf = FILE_GRAVITY * alpha, kh = HELIX_PULL * alpha;
      for (const n of nodes) {
        if (n.kind === 'file') {
          if (n.leaf) continue; // parked by its access link, not pulled into the core
          n.vx -= n.x * kf; n.vy -= n.y * kf; n.vz -= n.z * kf;
        } else {
          const c = n.slot || ORIGIN;
          n.vx += (c.x - n.x) * kh; n.vy += (c.y - n.y) * kh; n.vz += (c.z - n.z) * kh;
        }
      }
    }
    force.initialize = (n) => { nodes = n; };
    return force;
  }

  function ensureFG() {
    if (fg) return fg;
    if (!graph3dEl || !graph3dEl.clientWidth) return null;
    fg = ForceGraph3D()(graph3dEl)
      .backgroundColor('rgba(0,0,0,0)') // transparent → the app theme shows through
      .width(graph3dEl.clientWidth)
      .height(graph3dEl.clientHeight)
      .showNavInfo(false)
      // Slower settle → a new node visibly travels out from the core instead of
      // snapping into place (the "pulled from the Obsidian graph" effect, calmed).
      .d3AlphaDecay(0.018)
      .d3VelocityDecay(0.42)
      .cooldownTime(20000)
      .nodeLabel((n) => (n.kind === 'file' ? `📄 ${n.path}` : `${typeLabel(n.ntype)} — ${n.name}`))
      .nodeColor(nodeColor)
      .nodeVal((n) => (n.kind === 'file' ? Math.max(1.5, (n.deg || 0) + 1) : (n.phase ? 4 : 2.5)))
      .nodeOpacity(0.95)
      .nodeResolution(12)
      .linkColor(linkColor)
      .linkWidth((l) => (l.kind === 'access' ? 1.8 : l.kind === 'flow' ? 0.9 : 0.4))
      .linkOpacity((l) => (l.kind === 'access' ? 0.6 : l.kind === 'flow' ? 0.45 : 0.22))
      .linkDirectionalParticles((l) => (l.kind === 'access' ? 4 : l.kind === 'flow' ? 2 : 0))
      // Calmer particle flow (lower speed = more "latency"; data drifts, not races).
      .linkDirectionalParticleSpeed((l) => (l.kind === 'access' ? 0.006 : 0.004))
      .linkDirectionalParticleWidth(2.6)
      .linkDirectionalParticleColor((l) => linkColor(l))
      .onNodeClick((node) => {
        const d = 90;
        const r = 1 + d / Math.hypot(node.x || 1, node.y || 1, node.z || 1);
        fg.cameraPosition({ x: (node.x || 0) * r, y: (node.y || 0) * r, z: (node.z || 0) * r }, node, 700);
      });

    // Forces: core/helix positioning + tuned charge & link springs.
    fg.d3Force('galaxy', galaxyForce());
    const charge = fg.d3Force('charge');
    // Repulsion keeps clear gaps (a spaced core ball, not touching "frog-eggs");
    // lighter on work/leaf nodes so the helix and its leaves stay legible.
    if (charge && charge.strength) charge.strength((n) => (n.kind === 'file' ? (n.leaf ? -22 : -70) : -30));
    if (charge && charge.distanceMax) charge.distanceMax(700); // localise repulsion for big vaults
    const link = fg.d3Force('link');
    if (link) {
      if (link.distance) link.distance((l) => (l.kind === 'flow' ? 22 : l.kind === 'link' ? 46 : (l.leaf ? 26 : 60)));
      // Vault-note access links are visual-only (the note stays in the core, the line
      // just radiates out). LEAF access links DO spring — parking the file just off
      // the work node that touched it, so the structure reads core → helix → leaf.
      if (link.strength) link.strength((l) => {
        if (l.kind === 'flow') return 0.5;
        if (l.kind === 'link') return 0.12;
        if (l.kind === 'access') return l.leaf ? 0.45 : 0;
        return 0.1;
      });
    }
    fg.d3Force('center', null); // the galaxy force centres things on the origin

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
    // `spawn` is applied only on first creation: a new node is born AT the core (a
    // small jitter ball) and travels out to its slot/leaf — the "pulled out" effect.
    const ensure = (id, init, spawn) => {
      let o = fgNodeById.get(id);
      const isNew = !o;
      if (!o) { o = { id }; fgNodeById.set(id, o); }
      Object.assign(o, init);
      if (isNew && spawn) { o.x = spawn.x; o.y = spawn.y; o.z = spawn.z; o.vx = 0; o.vy = 0; o.vz = 0; }
      wanted.add(id);
      nodes.push(o);
      return o;
    };

    // Vault (the core ball). Known up front so the helix base sits just outside it.
    const vault = (linkGraph && linkGraph.ok && Array.isArray(linkGraph.nodes)) ? linkGraph.nodes : [];
    const vaultList = vault.slice(0, 600);
    const vaultPaths = new Set(vaultList.map((v) => v.path));
    const base = coreRadius(vaultList.length) + 40;

    // Strand index per branch (first-seen order): main = 0, each sub-agent braids next.
    const strandIndex = new Map();
    for (const n of runNodes) { const b = n.branch || 'main'; if (!strandIndex.has(b)) strandIndex.set(b, strandIndex.size); }

    // Work nodes — each gets its OWN helix slot, rising with global execution order g.
    runNodes.forEach((n, g) => {
      const branch = n.branch || 'main';
      const o = ensure(
        `r:${n.id}`,
        { kind: 'run', ntype: n.type, name: n.label || n.type, phase: !!n.phase, active: n.id === activeId, branch },
        seedPos(g + 1),
      );
      o.slot = helixSlot(g, strandIndex.get(branch) || 0, base);
    });

    // Vault notes — the core ball at the origin (born in a small jitter ball there).
    let fseed = 1000;
    for (const v of vaultList) {
      ensure(`f:${v.path}`, { kind: 'file', path: v.path, name: v.name, deg: (v.out || 0) + (v.in || 0), touched: false, leaf: false }, seedPos(fseed++));
    }
    // Touched non-vault files — LEAVES: no core gravity, parked just off their node.
    const touched = new Set((files || []).map((f) => f.path));
    for (const f of (files || [])) {
      if (!vaultPaths.has(f.path)) ensure(`f:${f.path}`, { kind: 'file', path: f.path, name: f.path.split(/[\\/]/).pop(), deg: (f.reads || 0) + (f.writes || 0), touched: true, leaf: true }, seedPos(fseed++));
    }
    for (const o of nodes) if (o.kind === 'file' && touched.has(o.path)) o.touched = true;

    for (const id of [...fgNodeById.keys()]) if (!wanted.has(id)) fgNodeById.delete(id);

    const links = [];
    for (const e of (runEdges || [])) links.push({ source: `r:${e.from}`, target: `r:${e.to}`, kind: 'flow' });
    for (const n of runNodes) {
      if (n.file && fgNodeById.has(`f:${n.file}`)) {
        const access = n.access || 'touch';
        const leaf = !!fgNodeById.get(`f:${n.file}`).leaf;
        // Particle direction tells the story: a READ streams the file's data INTO the
        // workflow (file → run node); a WRITE streams data OUT (run node → file).
        links.push(access === 'write'
          ? { source: `r:${n.id}`, target: `f:${n.file}`, kind: 'access', access, leaf }
          : { source: `f:${n.file}`, target: `r:${n.id}`, kind: 'access', access, leaf });
      }
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
    const runNodes = nodes.map((n) => ({ id: n.id, type: n.type, label: n.label, phase: n.phase, file: n.file, access: n.access, branch: n.branch, active: n.id === activeId }));
    const data = buildGraphData(runNodes, edges, files, activeId);
    const statNodes = data.nodes.filter((n) => n.kind === 'run');
    setStatus(statNodes, done);

    const graph = ensureFG();
    if (graph) {
      const sig = `${data.nodes.length}:${data.links.length}:${activeId || ''}:${linkGraph ? linkGraph.nodes.length : 0}`;
      if (sig !== lastSig) { lastSig = sig; graph.graphData(data); }
      else { graph.nodeColor(nodeColor); } // refresh colours (e.g. active node) without reheating
      // Frame once after the helix first expands, then re-frame whenever it has grown
      // enough that the newest nodes would otherwise drift out of view.
      const n = data.nodes.length;
      if (n && (!framedOnce || n > lastFitCount * 1.6)) {
        const first = !framedOnce;
        framedOnce = true; lastFitCount = n;
        setTimeout(() => { if (fg) fg.zoomToFit(900, 80); }, first ? 1800 : 1200);
      }
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
  if (fitBtn) fitBtn.addEventListener('click', () => { if (fg) fg.zoomToFit(700, 80); });

  // First paint may run before the element is laid out (clientWidth 0); retry once
  // the viewport has size so the 3D scene initialises.
  render();
  if (graph3dEl && !graph3dEl.clientWidth && typeof requestAnimationFrame !== 'undefined') {
    const tryInit = () => { if (graph3dEl.clientWidth) { render(); } else { requestAnimationFrame(tryInit); } };
    requestAnimationFrame(tryInit);
  }
  return { el, applyEvent, reset };
}
