// OrPAD orchestration-core — live-trace Run view (3D "galaxy + sunflower arms").
//
// One unified 3D scene (three.js via 3d-force-graph), freely orbit/zoom/drag-able:
//   • The workspace link graph (Obsidian-style vault) is the CORE — a solid ball
//     of note spheres pulled to the origin (the galaxy centre).
//   • Each WORK-UNIT of a run (the main agent, plus one per fanned-out sub-agent)
//     is a sunflower ARM radiating from the core: its nodes wind outward on a
//     golden-angle (phyllotaxis) spiral. One continuous, traceable sequence, but
//     the eye reads several spiral arms — and √k growth keeps it compact, not a
//     long line. Many work-units → many arms spread over a sphere from the core.
//   • The agent's transient "thinking" nodes (reason/respond) are collapsed out:
//     they aren't data flow and ~half the nodes are these. The flow DAG is rewired
//     so the arm shows only real work (reads / writes / exec / tools).
//   • When a work node reads/writes a file it gets a data-flow link to that file —
//     a glowing line with particles streaming along it (data physically moving):
//     READ streams the file's data INTO the node (file→node, teal); WRITE streams
//     OUT (node→file, orange).
//   • Files the run touches that are NOT vault notes (e.g. source files) don't
//     belong in the core — they hang just OUTSIDE the work node that touched them
//     (a "leaf"), so the flow reads radially (core → arm → leaf) instead of
//     crisscrossing back through the core.
//
// Data: buildEmergentGraph(events) → run nodes/edges/files (+ per-node `branch`);
// onLinkGraph() → the vault note↔note link graph. Both feed one { nodes, links }.

import { buildEmergentGraph } from './emergent-trace.js';
import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';

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
// Node colours encode a SMALL, legible taxonomy (see the legend), not every tool
// type — the read/write STORY is carried by file colour + link colour, so an agent
// step is one muted colour, with phases and (delegation) sub-agents called out.
const FILE_COLOR = '#5b6699';      // a vault note (untouched) — the core ball
const FILE_READ_COLOR = '#73f0c0'; // a file the run only READ (teal)
const FILE_WRITE_COLOR = '#ff9e64';// a file the run WROTE (orange)
const STEP_COLOR = '#9aa5ce';      // a generic agent step (read/edit/exec/tool/…)
const SUBAGENT_COLOR = '#7dcfff';  // a delegation step (Task → sub-agent)
const PHASE_COLOR = '#cdd6ff';     // a governed-envelope phase marker
const ACTIVE_COLOR = '#ffffff';    // the step currently running — white-hot, distinct from orange writes

const ACCESS_READ = '#73f0c0';   // link: reading a file (file → step)
const ACCESS_WRITE = '#ff9e64';  // link: writing a file (step → file)
const ACCESS_TOUCH = '#7dcfff';
const FLOW_COLOR = '#5fa8ff';    // link: execution order (step → step)
const VAULT_LINK_COLOR = '#2e3b66'; // link: note ↔ note (the vault graph)
const DIM_NODE = '#aab2c6';      // hover-faded node (recedes toward the theme background)
const DIM_LINK = '#c2c8d6';      // hover-faded link

function nodeColor(n) {
  if (n.active) return ACTIVE_COLOR;
  if (n.kind === 'file') {
    if (!n.touched) return FILE_COLOR;
    return n.writtenFile ? FILE_WRITE_COLOR : FILE_READ_COLOR;
  }
  if (n.phase) return PHASE_COLOR;
  if (n.ntype === 'subagent') return SUBAGENT_COLOR;
  return STEP_COLOR;
}
function linkColor(l) {
  if (l.kind === 'access') return l.access === 'write' ? ACCESS_WRITE : l.access === 'read' ? ACCESS_READ : ACCESS_TOUCH;
  if (l.kind === 'flow') return FLOW_COLOR;
  return VAULT_LINK_COLOR;
}

// --- galaxy + sunflower-arm layout --------------------------------------------
// Tunables — one-liners; tweak then rebuild + reload the dev build.
const FILE_GRAVITY = 0.06;  // pull of vault notes toward the core SHELL (firmness of the globe)
const ARM_PULL     = 0.36;  // pull of each work node to its slot — must DOMINATE charge so the
                            // sunflower forms cleanly instead of collapsing into a force-blob
const ARM_SPACING  = 16;    // in-plane phyllotaxis spacing (radius grows ARM_SPACING*√k)
const ARM_RISE     = 11;    // out-of-plane cone depth per √k (gives the arm 3D body, not a flat disc)
const STEM_FACTOR  = 0.85;  // stem length as a fraction of the core radius (pot → stem → bloom)
const PARTICLE_SPEED = 0.42; // data-flow particle speed in world-units per tick (constant for all edges)
const ACTIVE_GLOW_COLOR = '#dff1ff'; // icy-white glow halo (distinct from warm write/orange)
const ACTIVE_GLOW_SCALE = 8;         // halo size as a multiple of the node's radius

const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // golden angle (137.5°) — the phyllotaxis winding
const ORIGIN = { x: 0, y: 0, z: 0 };

// Core-ball radius grows (slowly) with the note count so arms start OUTSIDE the core.
function coreRadius(noteCount) {
  return Math.max(70, Math.cbrt(Math.max(1, noteCount)) * 40);
}

// Outward axis for a work-unit (strand). The main strand is the central stem,
// straight up; fanned-out sub-agents are extra stems in a BOUQUET — tilted up and
// out around the main one (not a full sphere), so they read as flowers from a vase.
const STRAND_TILT = 0.6; // radians a sub-agent stem leans off vertical (~34°)
function strandAxis(s, total) {
  if (total <= 1 || s === 0) return { x: 0, y: 1, z: 0 };
  const az = (2 * Math.PI * (s - 1)) / Math.max(1, total - 1);
  const sy = Math.cos(STRAND_TILT), sr = Math.sin(STRAND_TILT);
  return { x: Math.cos(az) * sr, y: sy, z: Math.sin(az) * sr };
}
// Two unit vectors spanning the plane perpendicular to axis d.
function perpBasis(d) {
  const a = Math.abs(d.y) < 0.99 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  let ux = a.y * d.z - a.z * d.y, uy = a.z * d.x - a.x * d.z, uz = a.x * d.y - a.y * d.x;
  const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
  const vx = d.y * uz - d.z * uy, vy = d.z * ux - d.x * uz, vz = d.x * uy - d.y * ux;
  return { u: { x: ux, y: uy, z: uz }, v: { x: vx, y: vy, z: vz } };
}
// Per-node slot: a phyllotaxis (sunflower) spiral on a shallow cone along the strand's
// axis. k = ordinal WITHIN the strand. The sequence is one continuous winding thread
// (traceable via edges), but the eye reads the parastichies as several spiral arms,
// and √k growth keeps ~100 nodes compact instead of a long line.
function armSlot(k, axis, base) {
  const { u, v } = perpBasis(axis);
  const r = ARM_SPACING * Math.sqrt(k + 0.5);
  const th = k * GOLDEN;
  const px = Math.cos(th) * r, py = Math.sin(th) * r;     // in-plane
  const out = base + ARM_RISE * Math.sqrt(k + 0.5);       // push out along the axis
  return {
    x: axis.x * out + u.x * px + v.x * py,
    y: axis.y * out + u.y * px + v.y * py,
    z: axis.z * out + u.z * px + v.z * py,
  };
}

// --- four selectable layout themes --------------------------------------------
// All share the note "core" pulled to the origin; only the WORK-NODE arrangement
// (n.slot) differs. computeSlot dispatches by theme. ctx = { g, k, strand,
// strandCount, total, base, coreR } where g = global exec order, k = ordinal within
// the strand (branch), strand = branch index.
export const LAYOUT_THEMES = ['vase', 'helix', 'solar', 'molecule'];

// Each parallel strand (the main run + every fanned-out sub-agent) is laid out as its
// OWN separated sub-structure — k = ordinal WITHIN the strand, and a per-strand anchor
// keeps the structures apart. A ring offset distributes strands around the centre.
function strandRing(strand, strandCount, sep) {
  if (strandCount <= 1) return { x: 0, z: 0 };
  const az = (2 * Math.PI * strand) / strandCount;
  return { x: Math.cos(az) * sep, z: Math.sin(az) * sep };
}

// HELIX (나선): one separate vertical DNA helix per strand, on a ring of offsets.
const HELIX_RADIUS = 90, HELIX_PITCH = 13, HELIX_TURN = Math.PI / 5, HELIX_SEP = 300;
function helixSlot(k, strand, strandCount, coreR) {
  const c = strandRing(strand, strandCount, HELIX_SEP);
  const ang = HELIX_TURN * k;
  return { x: c.x + Math.cos(ang) * HELIX_RADIUS, y: coreR + 30 + HELIX_PITCH * k, z: c.z + Math.sin(ang) * HELIX_RADIUS };
}

// SOLAR (태양계): the note vault is the SUN (gizmo added in ensureDecor); each strand
// is a PLANET — a small node cluster orbiting on its OWN tilted elliptical orbit.
const SOLAR_A = 2.4, SOLAR_ECC = 0.62, SOLAR_TILT = 0.16, PLANET_SPACING = 14;
function solarOrbit(strand, strandCount, coreR) {
  const a = Math.max(330, coreR * SOLAR_A) + strand * Math.max(150, coreR * 0.9); // each strand a wider orbit
  const b = a * SOLAR_ECC;
  const th = strandCount > 1 ? GOLDEN * strand : 0; // the planet's angle on its orbit
  return { a, b, th };
}
function planetSlot(k, strand, strandCount, branchSize, coreR) {
  const o = solarOrbit(strand, strandCount, coreR);
  const cx = Math.cos(o.th) * o.a, cz = Math.sin(o.th) * o.b, cy = Math.sin(o.th) * o.a * SOLAR_TILT;
  // Distribute the strand's nodes evenly over a SPHERE shell (Fibonacci sphere) so the
  // planet reads as a round ball, not an outward-expanding spray.
  const n = Math.max(1, branchSize);
  const R = Math.min(coreR * 0.9, Math.max(32, PLANET_SPACING * Math.sqrt(n) * 0.7));
  const yy = n <= 1 ? 0 : 1 - (k / (n - 1)) * 2; // 1 .. -1 across the shell
  const rr = Math.sqrt(Math.max(0, 1 - yy * yy));
  const th = GOLDEN * k;
  return { x: cx + Math.cos(th) * rr * R, y: cy + yy * R, z: cz + Math.sin(th) * rr * R };
}

// MOLECULE (분자 결정구조): each strand is its OWN simple-cubic crystal, offset onto a
// ring; flow edges read as bonds.
const LATTICE_SPACING = 84, LATTICE_SEP = 560;
function latticeSlot(k, strand, strandCount, branchSize, coreR) {
  const c = strandRing(strand, strandCount, LATTICE_SEP);
  const side = Math.max(1, Math.ceil(Math.cbrt(Math.max(1, branchSize))));
  const ix = k % side, iy = Math.floor(k / side) % side, iz = Math.floor(k / (side * side));
  const half = (side - 1) / 2;
  return { x: c.x + (ix - half) * LATTICE_SPACING, y: coreR + 60 + iy * LATTICE_SPACING, z: c.z + (iz - half) * LATTICE_SPACING };
}

function computeSlot(theme, c) {
  switch (theme) {
    case 'helix': return helixSlot(c.k, c.strand, c.strandCount, c.coreR);
    case 'solar': return planetSlot(c.k, c.strand, c.strandCount, c.branchSize, c.coreR);
    case 'molecule': return latticeSlot(c.k, c.strand, c.strandCount, c.branchSize, c.coreR);
    case 'vase':
    default: return armSlot(c.k, strandAxis(c.strand, c.strandCount), c.base);
  }
}

// Small deterministic spawn jitter so freshly-born nodes aren't coincident (charge
// would NaN) — they're born AT the core and visibly travel out to their slot/leaf.
function seedPos(seed) {
  const f = (k) => { const x = Math.sin(seed * k) * 43758.5453; return (x - Math.floor(x) - 0.5) * 9; };
  return { x: f(12.9898), y: f(78.233), z: f(37.719) };
}

// World-space length of a (post-layout) link, for constant particle speed.
function linkLen(l) {
  const s = l && l.source, t = l && l.target;
  if (!s || !t || typeof s.x !== 'number' || typeof t.x !== 'number') return 120;
  return Math.hypot(t.x - s.x, t.y - s.y, t.z - s.z);
}

// Drop the agent's TRANSIENT "thinking" nodes (reason/respond) — they're not data
// flow and, at ~half of all nodes, they bloat the arm into an unreadable line. The
// flow DAG is rewired so kept nodes link through the dropped chain (order preserved).
// Returns { nodes, edges, activeId } over the kept set. activeId is remapped to the
// nearest kept ancestor if the active node was itself transient.
function collapseTransient(nodes, edges, activeId) {
  const drop = new Set();
  for (const n of nodes) if (n.transient) drop.add(n.id);
  if (!drop.size) return { nodes, edges, activeId };
  const inTo = new Map();
  for (const e of edges) { if (!inTo.has(e.to)) inTo.set(e.to, []); inTo.get(e.to).push(e.from); }
  const keptAncestors = (id, seen) => {
    const res = [];
    for (const p of (inTo.get(id) || [])) {
      if (seen.has(p)) continue; seen.add(p);
      if (drop.has(p)) res.push(...keptAncestors(p, seen)); else res.push(p);
    }
    return res;
  };
  const keptNodes = nodes.filter((n) => !drop.has(n.id));
  const keptEdges = [];
  const seenPair = new Set();
  for (const n of keptNodes) {
    for (const a of keptAncestors(n.id, new Set())) {
      const key = `${a}>${n.id}`;
      if (!seenPair.has(key)) { seenPair.add(key); keptEdges.push({ from: a, to: n.id }); }
    }
  }
  let active = activeId;
  if (active && drop.has(active)) { const anc = keptAncestors(active, new Set()); active = anc[0] || null; }
  return { nodes: keptNodes, edges: keptEdges, activeId: active };
}

export function createLiveTraceView({ onRun = null, onContinue = null, onLinkGraph = null, onStop = null, onListRuns = null, onReplay = null } = {}) {
  const el = document.createElement('section');
  el.className = 'core-run-view';
  el.innerHTML = `
    <div class="core-run-side">
      <header class="core-run-header">
        <h2 class="core-run-title">Runs</h2>
        <div class="core-run-status" data-core-run-status role="status">Idle — no run yet.</div>
      </header>
      <div class="run-gui-runs" data-run-gui-runs>
        <div class="run-gui-runs-head">
          <button type="button" class="run-gui-runs-toggle" data-run-gui-toggle aria-expanded="true" title="Collapse / expand the run list">▾ Sessions</button>
          <button type="button" class="run-gui-runs-refresh" data-run-gui-refresh title="Refresh run history">↻</button>
        </div>
        <ul class="run-gui-run-list" data-run-list></ul>
      </div>
      <!-- The Run GUI is a PURE VIEWER: pick a run on the left, see its status here + its graph on the right.
           Runs are launched from the TERMINAL (launch an AI CLI → "Apply orchestration"; configure via the
           terminal's "Orchestration Options" button). No provider/goal form or options live in this window. -->
      <div class="run-gui-status" data-run-gui-status>
        <p class="core-run-form-error" data-core-run-error hidden></p>
        <p class="core-run-form-result" data-core-run-result hidden></p>
        <div class="core-run-result-loc" data-core-run-result-loc hidden></div>
        <div class="core-run-transcript" data-core-run-transcript hidden>
          <div class="core-run-transcript-head">Conversation</div>
          <div class="core-run-transcript-body" data-core-run-transcript-body></div>
        </div>
      </div>
    </div>
    <div class="core-run-graph-viewport core-run-graph-viewport-3d" data-core-run-viewport>
      <div class="core-run-3d" data-core-run-3d></div>
      <div class="core-run-graph-controls">
        <select class="core-run-theme-select" data-core-run-theme title="Graph layout">
          <option value="vase">🌷 Vase</option>
          <option value="helix">🧬 Helix</option>
          <option value="solar">🪐 Solar</option>
          <option value="molecule">💎 Molecule</option>
        </select>
        <button type="button" class="core-run-zoom-btn" data-core-run-refresh title="Re-scan the workspace link graph">↻ Graph</button>
        <button type="button" class="core-run-zoom-btn" data-core-run-fit title="Frame the layout">Reset view</button>
      </div>
      <div class="core-run-legend" aria-hidden="true">
        <div class="core-run-legend-group">
          <span class="core-run-legend-title">Nodes</span>
          <span><i class="dot" style="background:${FILE_COLOR}"></i>note (vault)</span>
          <span><i class="dot" style="background:${FILE_READ_COLOR}"></i>read file</span>
          <span><i class="dot" style="background:${FILE_WRITE_COLOR}"></i>write file</span>
          <span><i class="dot" style="background:${STEP_COLOR}"></i>agent step</span>
          <span><i class="dot" style="background:${SUBAGENT_COLOR}"></i>sub-agent</span>
          <span><i class="dot" style="background:${PHASE_COLOR}"></i>phase</span>
        </div>
        <div class="core-run-legend-group">
          <span class="core-run-legend-title">Flows</span>
          <span><i class="bar" style="background:${ACCESS_READ}"></i>read (file→step)</span>
          <span><i class="bar" style="background:${ACCESS_WRITE}"></i>write (step→file)</span>
          <span><i class="bar" style="background:${FLOW_COLOR}"></i>order (step→step)</span>
          <span><i class="bar core-run-legend-bar-thin" style="background:${VAULT_LINK_COLOR}"></i>link (note↔note)</span>
        </div>
      </div>
    </div>
  `;

  // Pure-viewer refs: a run-list sidebar + a selected-run status panel + the 3D graph. No form/inputs.
  const statusEl = el.querySelector('[data-core-run-status]');
  const errorEl = el.querySelector('[data-core-run-error]');
  const resultEl = el.querySelector('[data-core-run-result]');
  const viewportEl = el.querySelector('[data-core-run-viewport]');
  const graph3dEl = el.querySelector('[data-core-run-3d]');
  const refreshBtn = el.querySelector('[data-core-run-refresh]');
  const fitBtn = el.querySelector('[data-core-run-fit]');
  const themeSelect = el.querySelector('[data-core-run-theme]');
  const resultLocEl = el.querySelector('[data-core-run-result-loc]');
  const transcriptEl = el.querySelector('[data-core-run-transcript]');
  const transcriptBodyEl = el.querySelector('[data-core-run-transcript-body]');
  const runListEl = el.querySelector('[data-run-list]');
  const runsToggleEl = el.querySelector('[data-run-gui-toggle]');
  const runsRefreshEl = el.querySelector('[data-run-gui-refresh]');

  // --- Multi-run model -------------------------------------------------------
  // Each run (form run, terminal-launched, replayed, or observed TUI) keeps its OWN event buffer + status +
  // side-panel state. The single 3D scene renders the SELECTED run; off-screen runs keep buffering so their
  // sidebar badges stay live. render()/transcript/status read straight from `selected` (no fragile aliases).
  const runs = new Map();          // runId -> RunEntry (insertion order = sidebar order)
  let selected = null;             // the RunEntry shown in `fg`
  const EMPTY = [];

  function createRunEntry(runId, meta = {}) {
    const entry = {
      runId, events: [], transcript: [],
      goal: meta.goal || '', agent: meta.agent || '',
      status: meta.status || 'inactive', errorMessage: '',
      startedMs: meta.startedMs || Date.now(),
      isReplay: /^replay-/.test(String(runId || '')),
      isObserve: /^observe-/.test(String(runId || '')),
      seeded: !!meta.seeded,
      traceFile: meta.traceFile || null,
      resultText: '', resultIsError: false, resultRes: null,
    };
    runs.set(runId, entry);
    return entry;
  }
  function entryFor(runId, meta) { return runs.get(runId) || createRunEntry(runId, meta); }

  // Workspace link graph (lazy-loaded once via onLinkGraph; "↻ Graph" re-scans).
  let linkGraph = null;
  let linkGraphLoading = false;
  let linkGraphTried = false;

  // 3D graph state.
  let fg = null;
  const fgNodeById = new Map();  // id -> node object (reused so the layout is stable)
  let lastSig = '';
  let lastLinkSig = '';          // vault content signature — skip needless re-heats on refresh
  let framedOnce = false;        // auto-frame the galaxy once after it first settles
  let lastFitCount = 0;          // node count at the last auto-frame (re-frame as the helix grows)
  let coreR = 120;               // current core-shell radius (set from the note count each build)
  let stemLen = 100;             // current stem length (pot → bloom), set each build
  let layoutTheme = 'vase';      // vase | helix | solar | molecule (user-selectable)
  // Hover focus: highlight a node + its neighbours, dim the rest.
  const highlightNodes = new Set();
  const highlightLinks = new Set();
  let hoverNode = null;
  let dragging = false;        // keep the hover-highlight alive while a node is dragged
  let activeNodeObjs = [];     // ALL in-progress run nodes (parallel branches each have one)
  const activeSet = new Set(); // fast membership test for "is this link live?"
  let glowMat = null;          // shared additive halo material
  const glowSprites = [];      // halo pool — one per concurrently-active node
  // Plant decor (three.js meshes added to the scene): the pot frame + one stem per strand.
  let potMesh = null;
  let stemMeshes = [];  // one curved tube per work-unit strand (main + each sub-agent)
  let stemMat = null;
  let stemKey = '';     // rebuild key (core size + strand count) so stems track the run
  let currentStrandAxes = [{ x: 0, y: 1, z: 0 }]; // strand directions, set each build
  let sunMesh = null;   // SOLAR theme: the note vault rendered as a sun gizmo
  let orbitRings = [];  // SOLAR theme: one elliptical orbit line per strand
  let orbitKey = '';    // rebuild key for the orbit rings

  function showFormError(message) { errorEl.textContent = message; errorEl.hidden = !message; }
  function showFormResult(message) { if (!resultEl) return; resultEl.textContent = message || ''; resultEl.hidden = !message; }

  // After a run, surface WHERE the built result lives (the run overlay) + an Open-folder
  // button — essential now that "Apply to workspace" defaults OFF, so the output isn't
  // dumped into a notes vault but you still need to find it.
  function showResultLocation(res) {
    if (!resultLocEl) return;
    resultLocEl.innerHTML = '';
    const rows = [];
    const overlay = res && res.overlayPath;
    if (overlay && res.builtCount) {
      rows.push({
        label: res.appliedCount
          ? 'Applied to your workspace. The built result also lives in the run overlay:'
          : 'Result built but NOT applied — it lives in the run overlay:',
        path: overlay,
      });
    }
    // Build outputs delivered to the run dir (apply off, or apply on but stopped/gate-failed).
    if (res && res.buildOutputDest && res.buildOutputDest !== 'workspace' && res.buildOutputCount) {
      rows.push({
        label: `${res.buildOutputCount} build output${res.buildOutputCount === 1 ? '' : 's'} delivered to the run dir:`,
        path: res.buildOutputDest,
      });
    }
    if (!rows.length) { resultLocEl.hidden = true; return; }
    for (const row of rows) {
      const wrap = document.createElement('div');
      wrap.className = 'core-run-loc-row';
      const label = document.createElement('span');
      label.className = 'core-run-loc-label';
      label.textContent = row.label;
      const pathEl = document.createElement('code');
      pathEl.className = 'core-run-loc-path';
      pathEl.textContent = row.path;
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'core-run-loc-btn';
      openBtn.textContent = 'Open folder';
      openBtn.addEventListener('click', () => {
        if (window.orpad && typeof window.orpad.revealInExplorer === 'function') window.orpad.revealInExplorer(row.path);
      });
      wrap.append(label, pathEl, openBtn);
      resultLocEl.append(wrap);
    }
    resultLocEl.hidden = false;
  }

  // Conversation transcript — the human-facing session log (the user's turn + the agent's reply per turn).
  // The graph shows the MACHINERY; this shows the DIALOGUE. Cleared on a fresh run (reset), grows per turn.
  function renderTranscript() {
    if (!transcriptBodyEl) return;
    const list = selected ? selected.transcript : EMPTY;
    transcriptBodyEl.innerHTML = '';
    for (const m of list) {
      const row = document.createElement('div');
      row.className = `core-run-msg core-run-msg-${m.role === 'user' ? 'user' : 'agent'}`;
      const who = document.createElement('span');
      who.className = 'core-run-msg-who';
      who.textContent = m.role === 'user' ? 'You' : 'Agent';
      const body = document.createElement('div');
      body.className = 'core-run-msg-text';
      body.textContent = m.text;
      row.append(who, body);
      transcriptBodyEl.append(row);
    }
    if (transcriptEl) transcriptEl.hidden = list.length === 0;
    transcriptBodyEl.scrollTop = transcriptBodyEl.scrollHeight;
  }
  // Push into a SPECIFIC run's transcript (defaults to the selected one) — a form/continue handler logs into
  // the run it launched even if the user has since switched the sidebar selection to another run.
  function pushTranscript(role, text, entry = selected) {
    const t = String(text || '').trim();
    if (!t || !entry) return;
    entry.transcript.push({ role, text: t });
    if (entry === selected) renderTranscript();
  }

  function resetEntry(entry) {
    if (!entry) return;
    entry.events = []; entry.transcript = []; entry.errorMessage = '';
    entry.status = 'inactive'; entry.nodeCount = 0; // a cleared buffer must not keep a stale 'active' status
    entry.resultText = ''; entry.resultIsError = false; entry.resultRes = null;
    if (entry === selected) {
      lastSig = ''; fgNodeById.clear(); framedOnce = false; lastFitCount = 0; // a fresh run starts a fresh scene
      renderTranscript(); showFormResult(''); showFormError('');
      if (resultLocEl) resultLocEl.hidden = true;
    }
  }
  // Back-compat public reset(): clear the currently selected run.
  function reset() { resetEntry(selected); render(); }

  function restoreResultPanel(entry) {
    if (entry && entry.resultText) {
      if (entry.resultIsError) { showFormError(entry.resultText); showFormResult(''); }
      else { showFormResult(entry.resultText); showFormError(''); }
    } else { showFormError(''); showFormResult(''); }
    if (entry && entry.resultRes) showResultLocation(entry.resultRes);
    else if (resultLocEl) resultLocEl.hidden = true;
  }

  function selectRun(runId) {
    const entry = runs.get(runId);
    if (!entry || entry === selected) return;
    selected = entry;
    // R1: clear the shared 3D instance so geometry from the previous run doesn't bleed in (node ids repeat).
    fgNodeById.clear(); lastSig = ''; framedOnce = false; lastFitCount = 0;
    renderTranscript();
    restoreResultPanel(entry);
    renderSidebar();
    render();
    // Reheat on the NEXT frame (after render()'s graphData has established the layout) and guard it — reheating
    // a layout that isn't ready was crashing the lib's tick loop on reopen.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { try { if (fg) fg.d3ReheatSimulation(); } catch (_) { /* ignore */ } });
    }
  }

  let pendingReplayInto = null; // seeded runId we're replaying INTO (merge the replay-* stream onto its row)

  // --- Run sidebar -----------------------------------------------------------
  function runLabel(entry) {
    const g = (entry.goal || '').trim();
    if (g) return g.length > 48 ? `${g.slice(0, 47)}…` : g;
    if (entry.isObserve) return `observed ${entry.agent || 'session'}`;
    if (entry.isReplay) return 'replay';
    return entry.runId;
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }
  function renderSidebar() {
    if (!runListEl) return;
    runListEl.innerHTML = '';
    if (!runs.size) {
      const empty = document.createElement('li');
      empty.className = 'run-gui-run-empty';
      empty.textContent = 'No runs yet.';
      runListEl.append(empty);
      return;
    }
    for (const entry of runs.values()) runListEl.append(buildRunRow(entry));
  }
  function buildRunRow(entry) {
    const li = document.createElement('li');
    li.className = `run-gui-run-row${entry === selected ? ' is-selected' : ''}`;
    li.dataset.runId = entry.runId;
    const active = entry.status === 'active';
    const badge = document.createElement('span');
    badge.className = `run-gui-badge ${active ? 'is-active' : (entry.errorMessage ? 'is-error' : 'is-inactive')}`;
    const label = document.createElement('span');
    label.className = 'run-gui-run-label';
    label.textContent = runLabel(entry);
    const meta = document.createElement('span');
    meta.className = 'run-gui-run-meta';
    // Use a CACHED count for every row: render() caches the selected run; scheduleBgCount caches the rest on a
    // throttle. Only build the graph here the first time a row is created — never per incoming event. (Rebuilding
    // a background run's whole emergent graph on every event is O(n^2) and re-introduces the lag this PR fixes.)
    if (entry.nodeCount == null) entry.nodeCount = entry.events.length ? buildEmergentGraph(entry.events).nodes.length : 0;
    const nodeCount = entry.nodeCount;
    const stateText = active ? `● ${nodeCount}` : (entry.errorMessage ? 'error' : (entry.seeded && !entry.events.length ? 'history' : `done ${nodeCount}`));
    meta.textContent = [entry.agent || '', stateText].filter(Boolean).join(' · ');
    li.append(badge, label, meta);
    li.addEventListener('click', () => onRowClick(entry));
    return li;
  }
  // Refresh a non-selected (background) run's cached node count at most ~once per 800ms and update its row —
  // instead of rebuilding its full graph on every streamed event.
  function scheduleBgCount(entry) {
    if (entry._countTimer) return;
    entry._countTimer = setTimeout(() => {
      entry._countTimer = null;
      if (!runs.has(entry.runId)) return; // row was removed (e.g. merged into a replay)
      entry.nodeCount = entry.events.length ? buildEmergentGraph(entry.events).nodes.length : 0;
      updateSidebarRow(entry);
    }, 800);
  }
  function updateSidebarRow(entry) {
    if (!runListEl) return;
    const existing = runListEl.querySelector(`[data-run-id="${cssEsc(entry.runId)}"]`);
    if (!existing) { renderSidebar(); return; }
    existing.replaceWith(buildRunRow(entry));
  }
  function onRowClick(entry) {
    // A seeded (history) row has no live events — replay it, merging the replay stream onto this row.
    if (entry.seeded && !entry.events.length && onReplay && entry.traceFile) {
      const target = entry.runId;
      pendingReplayInto = target;
      // If the replay fails (missing/empty trace), drop the pending merge so it can't later merge an unrelated
      // fresh run into — and delete — this stale seeded row.
      Promise.resolve(onReplay(entry.traceFile)).catch(() => { if (pendingReplayInto === target) pendingReplayInto = null; });
      return;
    }
    selectRun(entry.runId);
  }
  // Seed the sidebar from recorded run history (metadata only; events load lazily on replay).
  async function seedRunsFromHistory() {
    if (!onListRuns) return;
    let res = null;
    try { res = await onListRuns(); } catch (_) { res = null; }
    const list = res && res.ok && Array.isArray(res.runs) ? res.runs : [];
    // A run already represented by a loaded replay row (entry.sourceRunId) must not be re-added as a duplicate
    // seeded row. Computed from LIVE entries each refresh (not a persistent set) so a source reappears if its
    // replay row is later cleared — never permanently hidden.
    const replayedSources = new Set();
    for (const e of runs.values()) if (e.sourceRunId) replayedSources.add(e.sourceRunId);
    for (const r of list) {
      if (!r || !r.runId || runs.has(r.runId) || replayedSources.has(r.runId)) continue;
      createRunEntry(r.runId, { goal: r.goal || '', agent: r.agent || '', startedMs: r.startedMs, seeded: true, traceFile: r.traceFile });
    }
    renderSidebar();
  }

  // Coalesce renders to one per animation frame. A reopen replays the whole event buffer in a synchronous burst
  // (dozens-to-hundreds of events in a few ms); calling render() — which rebuilds graphData + reheats the d3
  // simulation — per event churns the 3D layout so hard it crashes the lib's rAF tick loop ("reading 'tick'"),
  // leaving the graph blank. One coalesced render per frame builds the final graph cleanly (and is far cheaper).
  let renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    const run = () => { renderScheduled = false; try { render(); } catch (_) { /* keep the stream alive */ } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else setTimeout(run, 16);
  }
  function applyEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    const runId = ev.runId || (selected && selected.runId);
    if (!runId) return;
    const fresh = !runs.has(runId);
    const entry = entryFor(runId);
    let pushed = true;
    if (ev.ev === 'notice') {
      // Notices (e.g. the observer's "Observing … / no session found") are human-facing status — show them in
      // the selected run's status panel rather than the graph.
      pushed = false;
      entry.transcript.push({ role: 'agent', text: `${ev.level === 'warn' ? '⚠ ' : ''}${ev.text || ''}` });
      if (entry === selected) renderTranscript();
    } else if (ev.ev === 'run' && ev.state === 'start') {
      pushed = false;
      if (!ev.continued) resetEntry(entry); // fresh run/turn-less start: clear THIS run's buffer
      // Carry the run's identity into the sidebar label (observe runs send agent/goal here).
      if (ev.agent && !entry.agent) entry.agent = String(ev.agent);
      if (ev.goal && !entry.goal) entry.goal = String(ev.goal);
      entry.status = 'active';
    } else if (ev.ev === 'run' && ev.state === 'done') {
      entry.status = 'inactive';
    } else if (ev.ev === 'run' && ev.state === 'error') {
      entry.status = 'inactive';
      entry.errorMessage = String(ev.error || 'Run failed.');
    } else if (ev.ev === 'turn' && ev.state === 'start') {
      entry.status = 'active';
    }
    if (pushed) entry.events.push(ev);
    // Selection: a user-initiated replay merge FIRST (so it runs even when nothing is selected yet — first-ever
    // replay); otherwise auto-select the first run that ever appears. Observe runs streamed into a fresh window
    // are the first run, so they auto-select; later runs surface in the sidebar for the user to pick.
    if (fresh && pendingReplayInto) { mergeReplayRow(runId, pendingReplayInto); pendingReplayInto = null; selectRun(runId); }
    else if (!selected) selectRun(runId);
    if (entry === selected) { scheduleRender(); updateSidebarRow(entry); } // coalesced — never per-event during a replay burst
    else scheduleBgCount(entry); // background run: throttled count refresh, never a per-event full rebuild
  }

  // When a seeded history row is replayed, the replay streams under a fresh replay-* runId. Carry the seeded
  // row's label onto the new entry and drop the placeholder, so there's one sidebar row per logical run.
  function mergeReplayRow(newRunId, seededRunId) {
    const seed = runs.get(seededRunId);
    const fresh = runs.get(newRunId);
    if (seed && fresh) {
      fresh.goal = fresh.goal || seed.goal; fresh.agent = fresh.agent || seed.agent;
      fresh.sourceRunId = seededRunId; fresh.traceFile = fresh.traceFile || seed.traceFile;
    }
    if (seed && seed !== fresh) runs.delete(seededRunId); // the replay-* row (with sourceRunId) now represents it
    renderSidebar();
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
      // Only force a full rebuild + physics re-heat when the vault CONTENT actually
      // changed. A "↻ Graph" on an unchanged vault used to reheat the whole layout for
      // seconds (the temporary frame drops) for nothing.
      const sig = res && res.ok ? `${res.nodes.length}:${(res.edges || []).length}` : '';
      if (sig !== lastLinkSig) { lastLinkSig = sig; lastSig = ''; }
      render();
    }).catch(() => { linkGraphLoading = false; });
  }

  // --- 3D graph ----------------------------------------------------------------
  // A custom d3 force:
  //   • vault-note files are pulled toward the ORIGIN (a centred root-ball that sits
  //     squarely in the pot); strong charge puffs it into a round globe rather than a
  //     flat clump. (A shell force was tried but let the notes drift off-centre.)
  //   • each work node falls toward its OWN slot (n.slot) on its arm → traceable,
  //   • touched non-vault "leaf" files get no gravity — their access spring parks them
  //     just outside the work node that touched them (radial, not crisscrossing).
  function galaxyForce() {
    let nodes = [];
    function force(alpha) {
      const kg = FILE_GRAVITY * alpha, kh = ARM_PULL * alpha;
      for (const n of nodes) {
        if (n.kind === 'file') {
          if (n.leaf) continue; // parked by its access link, not part of the root-ball
          n.vx -= n.x * kg; n.vy -= n.y * kg; n.vz -= n.z * kg; // pull to origin → centred ball
        } else {
          const c = n.slot || ORIGIN;
          n.vx += (c.x - n.x) * kh; n.vy += (c.y - n.y) * kh; n.vz += (c.z - n.z) * kh;
        }
      }
    }
    force.initialize = (n) => { nodes = n; };
    return force;
  }

  // Re-apply the styling accessors so 3d-force-graph recomputes them after a hover
  // change (no layout reheat).
  function refreshHoverStyles() {
    if (!fg) return;
    fg.nodeColor(fg.nodeColor()).nodeVal(fg.nodeVal())
      .linkColor(fg.linkColor()).linkWidth(fg.linkWidth())
      .linkDirectionalParticles(fg.linkDirectionalParticles());
  }

  // Highlight a node + its direct neighbours (dim the rest). Shared by hover AND drag
  // so the emphasis survives while you drag a node around.
  function applyHighlight(node) {
    if (node === hoverNode) return;
    highlightNodes.clear(); highlightLinks.clear();
    hoverNode = node || null;
    if (node && fg) {
      highlightNodes.add(node);
      for (const l of fg.graphData().links) {
        if (l.source === node || l.target === node) {
          highlightLinks.add(l);
          highlightNodes.add(l.source === node ? l.target : l.source);
        }
      }
    }
    if (graph3dEl) graph3dEl.style.cursor = node ? 'pointer' : '';
    refreshHoverStyles();
  }
  // A link is "live" when it touches ANY in-progress node — only these stream particles
  // (parallel research: every running branch's edges stream at once, not one at a time).
  function isActiveLink(l) {
    return activeSet.size > 0 && (activeSet.has(l.source) || activeSet.has(l.target));
  }

  // Soft additive glow halo — emissive "発光" on the running node(s). (True post-process
  // bloom whitewashes a light theme bg, so this per-node additive sprite gives the same
  // glow selectively, on any background.)
  function glowTexture() {
    const size = 128;
    const cv = document.createElement('canvas'); cv.width = size; cv.height = size;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.28, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(cv);
  }
  function ensureActiveGlow() {
    if (glowMat || !fg || typeof fg.scene !== 'function') return;
    glowMat = new THREE.SpriteMaterial({
      map: glowTexture(), color: new THREE.Color(ACTIVE_GLOW_COLOR),
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.95,
    });
  }
  // Position one halo per concurrently-active node; grow the pool on demand, hide spares.
  function updateActiveGlow() {
    if (!glowMat || !fg || typeof fg.scene !== 'function') return;
    const scene = fg.scene(); if (!scene) return;
    const live = activeNodeObjs.filter((n) => n && typeof n.x === 'number');
    while (glowSprites.length < live.length) {
      const s = new THREE.Sprite(glowMat); s.renderOrder = 2; scene.add(s); glowSprites.push(s);
    }
    for (let i = 0; i < glowSprites.length; i += 1) {
      const s = glowSprites[i];
      if (i < live.length) {
        const n = live[i];
        s.position.set(n.x, n.y, n.z || 0);
        const radius = Math.cbrt(Math.max(0.1, n.phase ? 4 : 2.5)) * 4; // ~3d-force-graph node radius
        s.scale.setScalar(Math.max(18, radius * ACTIVE_GLOW_SCALE));
        s.visible = true;
      } else {
        s.visible = false;
      }
    }
  }

  // The "pot" (planter frame around the vault root-ball) + the "stem" rising to the
  // bloom. three.js meshes added to the scene once, then scaled to the core radius.
  function ensurePlant() {
    if (!fg || typeof fg.scene !== 'function') return;
    const scene = fg.scene();
    if (!scene) return;
    if (!potMesh) {
      // A rounded VASE — lathe of a bulb+neck profile (radius, height) — holding the
      // note root-ball; the bloom rises from its neck.
      const prof = [[0.06, -1.0], [0.46, -0.96], [0.82, -0.6], [1.0, -0.16], [0.97, 0.22], [0.7, 0.56], [0.54, 0.74], [0.62, 0.9]];
      const potGeo = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 30);
      const potMat = new THREE.MeshBasicMaterial({ color: 0x5fa86a, wireframe: true, transparent: true, opacity: 0.4 });
      potMesh = new THREE.Mesh(potGeo, potMat);
      potMesh.renderOrder = -1;
      scene.add(potMesh);
      stemMat = new THREE.MeshBasicMaterial({ color: 0x5fa86a, transparent: true, opacity: 0.6 });
    }
    // Vase CO-CENTRED with the root-ball (origin) so the globe sits inside the bulb.
    potMesh.scale.set(coreR * 1.12, coreR * 1.15, coreR * 1.12);
    potMesh.position.set(0, 0, 0);
    // ONE curved stem per strand — ALL emerging from the vase NECK (so they don't pierce
    // the bulb wall) and bowing out to each strand's bloom base.
    const stemKeyNew = `${Math.round(coreR)}:${currentStrandAxes.length}:${Math.round(stemLen)}`;
    if (stemKey !== stemKeyNew) {
      stemKey = stemKeyNew;
      for (const m of stemMeshes) { scene.remove(m); m.geometry.dispose(); }
      stemMeshes = [];
      const neck = new THREE.Vector3(0, coreR * 0.95, 0); // shared origin at the vase neck
      const rt = coreR + stemLen;
      for (const axis of currentStrandAxes) {
        const top = new THREE.Vector3(axis.x * rt, axis.y * rt, axis.z * rt);
        const { u } = perpBasis(axis); const off = coreR * 0.16;
        const ctrl = new THREE.Vector3(
          (neck.x + top.x) / 2 + u.x * off, (neck.y + top.y) / 2 + u.y * off, (neck.z + top.z) / 2 + u.z * off,
        );
        const geo = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(neck, ctrl, top), 24, Math.max(2, coreR * 0.02), 8, false);
        const m = new THREE.Mesh(geo, stemMat);
        scene.add(m);
        stemMeshes.push(m);
      }
    }

    // SOLAR gizmo: the note vault as a glowing SUN + an elliptical orbit ring per strand.
    if (!sunMesh) {
      sunMesh = new THREE.Mesh(
        new THREE.SphereGeometry(1, 24, 16),
        new THREE.MeshBasicMaterial({ color: 0xffcf66, wireframe: true, transparent: true, opacity: 0.3 }),
      );
      sunMesh.renderOrder = -1;
      scene.add(sunMesh);
    }
    sunMesh.scale.setScalar(coreR * 1.18);
    const orbitKeyNew = `${Math.round(coreR)}:${currentStrandAxes.length}`;
    if (orbitKey !== orbitKeyNew) {
      orbitKey = orbitKeyNew;
      for (const r of orbitRings) { scene.remove(r); r.geometry.dispose(); }
      orbitRings = [];
      const sc = currentStrandAxes.length;
      const orbitMat = new THREE.LineBasicMaterial({ color: 0x8aa0c8, transparent: true, opacity: 0.32 });
      for (let s = 0; s < sc; s += 1) {
        const o = solarOrbit(s, sc, coreR);
        const pts = [];
        for (let i = 0; i <= 100; i += 1) {
          const th = (2 * Math.PI * i) / 100;
          pts.push(new THREE.Vector3(Math.cos(th) * o.a, Math.sin(th) * o.a * SOLAR_TILT, Math.sin(th) * o.b));
        }
        const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), orbitMat);
        scene.add(ring);
        orbitRings.push(ring);
      }
    }

    // Show each theme's gizmos only under that theme.
    const isVase = layoutTheme === 'vase', isSolar = layoutTheme === 'solar';
    potMesh.visible = isVase;
    for (const m of stemMeshes) m.visible = isVase;
    sunMesh.visible = isSolar;
    for (const r of orbitRings) r.visible = isSolar;
  }

  function ensureFG() {
    if (fg) return fg;
    if (!graph3dEl || !graph3dEl.clientWidth || !graph3dEl.clientHeight) return null; // need BOTH dims, else 0-size canvas
    fg = ForceGraph3D()(graph3dEl)
      .backgroundColor('rgba(0,0,0,0)') // transparent → the app theme background shows through
      .width(graph3dEl.clientWidth)
      .height(graph3dEl.clientHeight)
      .showNavInfo(false)
      // Settle reasonably fast then STOP — a long cooldown keeps the physics + render
      // loop pegged for seconds, which makes orbiting/dragging lag. These let the sim
      // quiesce in a few seconds so interaction stays smooth.
      .d3AlphaDecay(0.028)
      .d3VelocityDecay(0.45)
      .cooldownTime(4000)
      .nodeResolution(8) // fewer triangles per node sphere (hundreds of nodes → real saving)
      .nodeLabel((n) => (n.kind === 'file' ? `📄 ${n.path}` : `${typeLabel(n.ntype)} — ${n.name}`))
      // On hover: the hovered node + its neighbours keep their colour; everything else
      // fades to a faint grey so the connections stand out (both vault + run graphs).
      .nodeColor((n) => (hoverNode && !highlightNodes.has(n) ? DIM_NODE : nodeColor(n)))
      .nodeVal((n) => {
        const base = n.kind === 'file' ? Math.max(1.5, (n.deg || 0) + 1) : (n.phase ? 4 : 2.5);
        if (n === hoverNode) return base * 1.9;
        return n.active ? base * 1.5 : base; // the in-progress node sits a little larger
      })
      .nodeOpacity(0.95)
      .linkColor((l) => (hoverNode && !highlightLinks.has(l) ? DIM_LINK : linkColor(l)))
      .linkWidth((l) => {
        // Keep edges THIN so the data particle (a sphere wider than the line, below)
        // rides ON the edge — OrPAD's art concept — rather than inside a fat tube.
        const base = l.kind === 'access' ? 1.5 : l.kind === 'flow' ? 0.8 : 0.4;
        if (hoverNode) return highlightLinks.has(l) ? base * 1.4 : 0.2;
        return base;
      })
      .linkOpacity(0.55)
      // Flow (order) links bend into gentle arcs for the organic VASE; straight bonds
      // for the other (helix / solar / crystalline) themes.
      .linkCurvature((l) => (l.kind === 'flow' && layoutTheme === 'vase' ? 0.22 : 0))
      // Particles ONLY on the live flow: while hovering, the hovered node's links; else
      // the in-progress node's links. Nothing streams once a run is done.
      .linkDirectionalParticles((l) => {
        const cnt = l.kind === 'access' ? 4 : l.kind === 'flow' ? 2 : 0;
        if (hoverNode) return highlightLinks.has(l) ? cnt : 0;
        return isActiveLink(l) ? cnt : 0;
      })
      // CONSTANT world-speed: 3d-force-graph's speed is a fraction of link LENGTH per
      // tick (so a fixed value = same crossing TIME, different speed). Divide by the
      // link's length so every particle drifts at the same units/tick regardless of span.
      .linkDirectionalParticleSpeed((l) => PARTICLE_SPEED / Math.max(24, linkLen(l)))
      .linkDirectionalParticleWidth(3.4) // wider than the edge → a sphere riding the line
      .linkDirectionalParticleColor((l) => linkColor(l))
      // Hover highlights connections; while DRAGGING keep the dragged node highlighted
      // (the cursor leaves the node, so ignore hover-out until the drag ends).
      .onNodeHover((node) => { if (!dragging) applyHighlight(node); })
      .onNodeDrag((node) => { dragging = true; applyHighlight(node); })
      .onNodeDragEnd(() => { dragging = false; })
      .onNodeClick((node) => {
        const d = 90;
        const r = 1 + d / Math.hypot(node.x || 1, node.y || 1, node.z || 1);
        fg.cameraPosition({ x: (node.x || 0) * r, y: (node.y || 0) * r, z: (node.z || 0) * r }, node, 700);
      });

    // Forces: core/helix positioning + tuned charge & link springs.
    fg.d3Force('galaxy', galaxyForce());
    const charge = fg.d3Force('charge');
    // Repulsion keeps clear gaps; lighter on work nodes so charge can't fight the slot
    // pull, and lighter still on leaves so they tuck close to their step (not a blob).
    if (charge && charge.strength) charge.strength((n) => (n.kind === 'file' ? (n.leaf ? -14 : -90) : -16));
    if (charge && charge.distanceMax) charge.distanceMax(600); // localise repulsion for big vaults
    const link = fg.d3Force('link');
    if (link) {
      if (link.distance) link.distance((l) => (l.kind === 'flow' ? 22 : l.kind === 'link' ? 46 : (l.leaf ? 24 : 60)));
      // FLOW links are visual-only now (strength 0): work nodes are positioned by their
      // sunflower slot, so a flow spring would only FIGHT it and smear the arm. The line
      // is still drawn to show order. LEAF access links DO spring — parking the file just
      // off the step that touched it (core → arm → leaf). Vault-note access = visual-only.
      if (link.strength) link.strength((l) => {
        if (l.kind === 'flow') return 0;
        if (l.kind === 'link') return 0.1;
        if (l.kind === 'access') return l.leaf ? 0.35 : 0;
        return 0.1;
      });
    }
    fg.d3Force('center', null); // the galaxy force centres things on the origin

    // The active (in-progress) node's GLOW halo — a soft additive sprite that follows
    // the running node each tick. This is the only "発光", per the design: nothing else
    // glows. (Post-process bloom was dropped — it can't be selective on a light theme bg.)
    ensureActiveGlow();
    fg.onEngineTick(updateActiveGlow);
    // Safety frame: once the instance exists and the sim has had a moment to spread the nodes, frame them once.
    // Covers a replay-built graph (reopen) where the incremental framedOnce path might not frame a burst-loaded
    // graph against a just-sized canvas — without this the nodes can render off-screen and look blank.
    setTimeout(() => { try { if (fg && graph3dEl && graph3dEl.clientWidth) fg.zoomToFit(800, 80); } catch (_) { /* ignore */ } }, 2200);
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

    // Vault (the core globe). Known up front so arms start just outside the shell.
    const vault = (linkGraph && linkGraph.ok && Array.isArray(linkGraph.nodes)) ? linkGraph.nodes : [];
    const vaultList = vault.slice(0, 600);
    const vaultPaths = new Set(vaultList.map((v) => v.path));
    coreR = coreRadius(vaultList.length);   // shell radius (read by galaxyForce)
    stemLen = coreR * STEM_FACTOR;          // pot → stem → bloom (read by ensurePlant)
    const base = coreR + stemLen;           // the bloom sits at the top of the stem
    // A file is "written" if the run wrote it at least once (else read-only) — drives
    // the read/write colour split on file nodes.
    const writeSet = new Set((files || []).filter((f) => (f.writes || 0) > 0).map((f) => f.path));

    // Strand index per branch (first-seen order): main = 0, each sub-agent = next strand.
    const strandIndex = new Map();
    for (const n of runNodes) { const b = n.branch || 'main'; if (!strandIndex.has(b)) strandIndex.set(b, strandIndex.size); }
    const strandCount = Math.max(1, strandIndex.size);
    const total = runNodes.length;
    const branchSizes = new Map();
    for (const n of runNodes) { const b = n.branch || 'main'; branchSizes.set(b, (branchSizes.get(b) || 0) + 1); }
    // Stem directions (vase): one per strand, so ensurePlant can root each bloom.
    currentStrandAxes = [];
    for (let s = 0; s < strandCount; s += 1) currentStrandAxes.push(strandAxis(s, strandCount));

    // Work nodes — each gets its OWN slot, computed by the selected layout theme
    // (vase / helix / solar / molecule). g = global exec order, k = ordinal in strand.
    const ordinal = new Map(); // branch -> running count
    runNodes.forEach((n, g) => {
      const branch = n.branch || 'main';
      const strand = strandIndex.get(branch) || 0;
      const k = ordinal.get(branch) || 0; ordinal.set(branch, k + 1);
      const o = ensure(
        `r:${n.id}`,
        { kind: 'run', ntype: n.type, name: n.label || n.type, phase: !!n.phase, active: !!n.active, branch },
        seedPos(g + 1),
      );
      o.slot = computeSlot(layoutTheme, { g, k, strand, strandCount, total, base, coreR, branchSize: branchSizes.get(branch) || 1 });
    });

    // Vault notes — distributed over the core shell (born in a small jitter ball).
    let fseed = 1000;
    for (const v of vaultList) {
      ensure(`f:${v.path}`, { kind: 'file', path: v.path, name: v.name, deg: (v.out || 0) + (v.in || 0), touched: false, leaf: false, writtenFile: false }, seedPos(fseed++));
    }
    // Touched non-vault files — LEAVES: no shell pull, parked just off their step.
    const touched = new Set((files || []).map((f) => f.path));
    for (const f of (files || [])) {
      if (!vaultPaths.has(f.path)) ensure(`f:${f.path}`, { kind: 'file', path: f.path, name: f.path.split(/[\\/]/).pop(), deg: (f.reads || 0) + (f.writes || 0), touched: true, leaf: true, writtenFile: writeSet.has(f.path) }, seedPos(fseed++));
    }
    for (const o of nodes) if (o.kind === 'file' && touched.has(o.path)) { o.touched = true; o.writtenFile = writeSet.has(o.path); }

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
    const errMsg = selected ? selected.errorMessage : '';
    if (errMsg) { statusEl.textContent = `Error — ${errMsg}`; statusEl.dataset.state = 'error'; return; }
    const running = !!(selected && selected.status === 'active') && !done;
    if (running) {
      const active = runNodes.find((n) => n.active);
      statusEl.textContent = !runNodes.length ? 'Starting run…' : `Running — ${active ? (active.name || typeLabel(active.ntype)) : 'working'}…`;
      statusEl.dataset.state = 'running';
      return;
    }
    if (!runNodes.length) { statusEl.textContent = 'Idle — no run yet.'; statusEl.dataset.state = 'idle'; return; }
    statusEl.textContent = `Run complete — ${runNodes.length} node${runNodes.length === 1 ? '' : 's'}.`;
    statusEl.dataset.state = 'done';
  }

  function render() {
    loadLinkGraph(false);
    const emergent = buildEmergentGraph(selected ? selected.events : EMPTY);
    const { done, files } = emergent;
    // Collapse the agent's transient "thinking" nodes so the arm shows real data flow.
    const { nodes, edges, activeId } = collapseTransient(emergent.nodes, emergent.edges, emergent.activeId);
    // Mark EVERY still-open work node active (parallel branches each have one), not just
    // the single most-recent one — so all concurrent work glows + streams.
    const runNodes = nodes.map((n) => ({ id: n.id, type: n.type, label: n.label, phase: n.phase, file: n.file, access: n.access, branch: n.branch, active: n.state === 'active' && !n.phase }));
    const data = buildGraphData(runNodes, edges, files, activeId);
    const statNodes = data.nodes.filter((n) => n.kind === 'run');
    if (selected) selected.nodeCount = statNodes.length; // cache for the sidebar badge (buildRunRow reuses it)
    // The in-progress nodes drive the glow halos + which flows stream particles.
    activeNodeObjs = done ? [] : data.nodes.filter((n) => n.kind === 'run' && n.active);
    activeSet.clear();
    for (const n of activeNodeObjs) activeSet.add(n);
    setStatus(statNodes, done);

    const graph = ensureFG();
    if (graph) {
      ensurePlant(); // pot + stem, sized to the current core radius
      // NOTE: activeId is deliberately NOT in the signature. A changing active node only
      // affects styling (glow/particles), so handle it with the light refresh below
      // instead of a full graphData() rebuild + physics reheat (the orbit-lag culprit).
      const sig = `${data.nodes.length}:${data.links.length}:${linkGraph ? linkGraph.nodes.length : 0}`;
      if (sig !== lastSig) { lastSig = sig; graph.graphData(data); }
      else { refreshHoverStyles(); } // restyle for the new active node without reheating
      updateActiveGlow(); // keep the halo correct even when the sim is cold (not ticking)
      // Frame once after the bloom first expands, then re-frame whenever it has grown
      // enough that the newest nodes would otherwise drift out of view.
      const n = data.nodes.length;
      if (n && (!framedOnce || n > lastFitCount * 1.6)) {
        const first = !framedOnce;
        framedOnce = true; lastFitCount = n;
        setTimeout(() => {
          if (!fg) return;
          fg.zoomToFit(900, 80);
          // Re-evaluate particle speed now that link lengths have settled, so the
          // constant-speed division uses final lengths.
          fg.linkDirectionalParticleSpeed(fg.linkDirectionalParticleSpeed());
        }, first ? 1800 : 1200);
      }
    }
  }

  // (Run launching + orchestration options live in the TERMINAL now — this window is a pure viewer. There is
  //  no goal form, options modal, provider-help modal, or follow-up input here.)

  if (refreshBtn) refreshBtn.addEventListener('click', () => { loadLinkGraph(true); });
  if (fitBtn) fitBtn.addEventListener('click', () => { if (fg) fg.zoomToFit(700, 80); });

  // Run-list sidebar: collapse toggle (persisted) + history refresh.
  if (runsToggleEl) {
    const applyCollapsed = (collapsed) => {
      el.classList.toggle('run-gui-runs-collapsed', collapsed);
      runsToggleEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    };
    runsToggleEl.addEventListener('click', () => {
      const collapsed = !el.classList.contains('run-gui-runs-collapsed');
      applyCollapsed(collapsed);
      try { localStorage.setItem('orpad-rungui-runs-collapsed', collapsed ? 'true' : 'false'); } catch (_) { /* ignore */ }
    });
    try { if (localStorage.getItem('orpad-rungui-runs-collapsed') === 'true') applyCollapsed(true); } catch (_) { /* ignore */ }
  }
  if (runsRefreshEl) runsRefreshEl.addEventListener('click', () => { seedRunsFromHistory(); });
  if (themeSelect) {
    themeSelect.value = layoutTheme;
    themeSelect.addEventListener('change', () => {
      if (!LAYOUT_THEMES.includes(themeSelect.value)) return;
      layoutTheme = themeSelect.value;
      lastSig = '';                       // force a graphData re-apply with the new slots
      framedOnce = false; lastFitCount = 0; // re-frame for the new layout's extent
      render();
      if (fg) fg.d3ReheatSimulation();    // animate nodes to their new theme positions
    });
  }

  // While the window is unfocused the browser throttles the physics loop, so nodes that
  // streamed in during that time stay stuck at their spawn point (the origin). Re-heat
  // on focus so they travel out to their slots — but only mid-run, to avoid jiggling a
  // settled idle graph.
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => { if (fg && activeNodeObjs.length) fg.d3ReheatSimulation(); });
  }

  // Seed the run list from history, then first paint. First paint may run before the element is laid out
  // (clientWidth 0); retry once the viewport has size so the 3D scene initialises.
  renderSidebar();
  seedRunsFromHistory();
  render();
  if (graph3dEl && !graph3dEl.clientWidth && typeof requestAnimationFrame !== 'undefined') {
    const tryInit = () => { if (graph3dEl.clientWidth) { render(); } else { requestAnimationFrame(tryInit); } };
    requestAnimationFrame(tryInit);
  }
  // Keep the 3D scene in sync with the container size. CRITICAL for reopen: events replayed into a freshly
  // opened window arrive ~1ms after load, BEFORE the canvas is laid out (clientWidth 0), so ensureFG can't build
  // the graph yet. When the canvas finally gains a size this BUILDS the graph (fg null → render()), not just
  // resizes an existing one — otherwise the replayed graph would never paint.
  if (graph3dEl && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (!graph3dEl.clientWidth || !graph3dEl.clientHeight) return;
      if (fg) fg.width(graph3dEl.clientWidth).height(graph3dEl.clientHeight);
      else render(); // canvas just gained real size — build the graph now (replay may have arrived pre-layout)
    });
    ro.observe(graph3dEl);
  }
  return { el, applyEvent, reset, selectRun, seedRunsFromHistory };
}
