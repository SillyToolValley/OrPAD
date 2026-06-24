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
          <span>AI provider <small>which agent runs the task</small></span>
          <select data-core-run-provider>
            <option value="claude">Claude (claude CLI)</option>
            <option value="codex">Codex (codex CLI)</option>
            <option value="gemini">Gemini (gemini CLI)</option>
          </select>
        </label>
        <label class="core-run-field">
          <span>Goal</span>
          <textarea data-core-run-goal rows="3" placeholder="Describe the task to delegate to the agent…"></textarea>
        </label>
        <div class="core-run-form-row core-run-form-opts">
          <label class="core-run-check"><input type="checkbox" data-core-run-ground checked /> Research prior art first (grounding)</label>
          <label class="core-run-check"><input type="checkbox" data-core-run-parallel checked /> Parallel research (fan-out)</label>
          <label class="core-run-check"><input type="checkbox" data-core-run-apply /> Apply result to workspace <small>off = result stays in the run overlay</small></label>
        </div>
        <div class="core-run-form-row">
          <button type="submit" class="core-run-btn" data-core-run-submit>Run</button>
          <button type="button" class="core-run-btn core-run-btn-stop" data-core-run-stop hidden>Stop</button>
        </div>
        <details class="core-run-advanced">
          <summary>Advanced options</summary>
          <label class="core-run-field">
            <span>Write-set <small>optional — files the agent may change. Leave empty to build freely; the whole result is applied to the workspace.</small></span>
            <textarea data-core-run-writeset rows="2" placeholder="src/feature.js"></textarea>
          </label>
          <label class="core-run-field">
            <span>Read-only context <small>optional — extra files seeded read-only, one per line</small></span>
            <textarea data-core-run-readonly rows="1" placeholder="src/types.ts"></textarea>
          </label>
          <label class="core-run-field">
            <span>Verification gates <small>optional — shell checks, one per line; exit 0 = pass. A failing check BLOCKS apply, so nothing unverified reaches your workspace.</small></span>
            <textarea data-core-run-gates rows="2" placeholder="npm test"></textarea>
          </label>
          <div class="core-run-form-row">
            <label class="core-run-field core-run-field-inline">
              <span>Auto-fix cycles <small>retries on gate failure</small></span>
              <input type="number" data-core-run-verify-cycles min="0" max="5" step="1" value="0" inputmode="numeric" />
            </label>
            <label class="core-run-field core-run-field-inline">
              <span>Time cap (min) <small>0 = no stop-signal</small></span>
              <input type="number" data-core-run-timeout min="0" step="1" value="0" inputmode="numeric" />
            </label>
          </div>
        </details>
        <p class="core-run-form-note">Spawns the selected agent under the isolation moat. A real run — it may take minutes and incur cost.</p>
        <p class="core-run-form-error" data-core-run-error hidden></p>
        <p class="core-run-form-result" data-core-run-result hidden></p>
        <div class="core-run-result-loc" data-core-run-result-loc hidden></div>
      </form>
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
    <div class="core-run-modal" data-core-run-modal hidden>
      <div class="core-run-modal-backdrop" data-core-run-modal-close></div>
      <div class="core-run-modal-card" role="alertdialog" aria-modal="true">
        <h3 class="core-run-modal-title" data-core-run-modal-title></h3>
        <div class="core-run-modal-body" data-core-run-modal-body></div>
        <div class="core-run-modal-actions">
          <button type="button" class="core-run-btn" data-core-run-modal-close>Got it</button>
        </div>
      </div>
    </div>
  `;

  const statusEl = el.querySelector('[data-core-run-status]');
  const formEl = el.querySelector('[data-core-run-form]');
  const providerEl = el.querySelector('[data-core-run-provider]');
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
  const themeSelect = el.querySelector('[data-core-run-theme]');
  const modalEl = el.querySelector('[data-core-run-modal]');
  const modalTitleEl = el.querySelector('[data-core-run-modal-title]');
  const modalBodyEl = el.querySelector('[data-core-run-modal-body]');
  const resultLocEl = el.querySelector('[data-core-run-result-loc]');

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
    const overlay = res && res.overlayPath;
    if (!overlay || !res.builtCount) { resultLocEl.hidden = true; return; }
    const label = document.createElement('span');
    label.className = 'core-run-loc-label';
    label.textContent = res.appliedCount
      ? 'Applied to your workspace. The built result also lives in the run overlay:'
      : 'Result built but NOT applied — it lives in the run overlay:';
    const pathEl = document.createElement('code');
    pathEl.className = 'core-run-loc-path';
    pathEl.textContent = overlay;
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'core-run-loc-btn';
    openBtn.textContent = 'Open folder';
    openBtn.addEventListener('click', () => {
      if (window.orpad && typeof window.orpad.revealInExplorer === 'function') window.orpad.revealInExplorer(overlay);
    });
    resultLocEl.append(label, pathEl, openBtn);
    resultLocEl.hidden = false;
  }

  const PROVIDER_HELP = {
    claude: 'Install Claude Code (e.g. `npm i -g @anthropic-ai/claude-code`) and make sure `claude` runs in a terminal.',
    codex: 'Install the OpenAI Codex CLI (e.g. `npm i -g @openai/codex`), sign in (`codex login`), and make sure `codex` runs in a terminal.',
    gemini: 'Install the Gemini CLI (e.g. `npm i -g @google/gemini-cli`), authenticate, and make sure `gemini` runs in a terminal.',
  };
  function closeModal() { if (modalEl) modalEl.hidden = true; }
  function showProviderModal(info) {
    if (!modalEl) return;
    const provider = (info && info.provider) || 'claude';
    const command = (info && info.command) || provider;
    modalTitleEl.textContent = `${command} CLI not found`;
    modalBodyEl.innerHTML = '';
    const p1 = document.createElement('p');
    p1.textContent = `The selected AI provider “${provider}” couldn't be reached — its command “${command}” isn't on your PATH, so the run can't start.`;
    const p2 = document.createElement('p');
    p2.textContent = PROVIDER_HELP[provider] || `Install the ${provider} CLI and make sure “${command}” runs in a terminal.`;
    const p3 = document.createElement('p');
    p3.className = 'core-run-modal-verify';
    p3.innerHTML = `Verify with <code>${command} --version</code>, then pick the provider again and re-run.`;
    modalBodyEl.append(p1, p2, p3);
    modalEl.hidden = false;
  }
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
    if (!graph3dEl || !graph3dEl.clientWidth) return null;
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
    const emergent = buildEmergentGraph(events);
    const { done, files } = emergent;
    // Collapse the agent's transient "thinking" nodes so the arm shows real data flow.
    const { nodes, edges, activeId } = collapseTransient(emergent.nodes, emergent.edges, emergent.activeId);
    // Mark EVERY still-open work node active (parallel branches each have one), not just
    // the single most-recent one — so all concurrent work glows + streams.
    const runNodes = nodes.map((n) => ({ id: n.id, type: n.type, label: n.label, phase: n.phase, file: n.file, access: n.access, branch: n.branch, active: n.state === 'active' && !n.phase }));
    const data = buildGraphData(runNodes, edges, files, activeId);
    const statNodes = data.nodes.filter((n) => n.kind === 'run');
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

  if (onRun && formEl) {
    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      showFormError('');
      showFormResult('');
      if (resultLocEl) resultLocEl.hidden = true;
      const goal = (goalEl?.value || '').trim();
      if (!goal) { showFormError('Enter a goal first.'); goalEl?.focus(); return; }
      const allowedFiles = parseLines(writesetEl?.value);
      const readOnlyFiles = parseLines(readonlyEl?.value);
      const timeoutMin = Math.max(0, Number(timeoutEl?.value) || 0);
      const verifyCommands = parseLines(gatesEl?.value);
      const verifyCycles = Math.max(0, Math.min(5, Number(verifyCyclesEl?.value) || 0));
      const request = {
        goal,
        agent: providerEl && providerEl.value ? providerEl.value : 'claude',
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
        if (res && res.providerMissing) {
          showProviderModal(res.providerMissing); // help modal: the provider CLI isn't installed
          showFormError(res.error || 'Provider not available.');
        } else if (res && res.ok === false) {
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
          showResultLocation(res);
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
  if (modalEl) {
    el.querySelectorAll('[data-core-run-modal-close]').forEach((b) => b.addEventListener('click', closeModal));
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modalEl.hidden) closeModal(); });
  }
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
    window.addEventListener('focus', () => { if (fg && (busy || activeNodeObjs.length)) fg.d3ReheatSimulation(); });
  }

  // First paint may run before the element is laid out (clientWidth 0); retry once
  // the viewport has size so the 3D scene initialises.
  render();
  if (graph3dEl && !graph3dEl.clientWidth && typeof requestAnimationFrame !== 'undefined') {
    const tryInit = () => { if (graph3dEl.clientWidth) { render(); } else { requestAnimationFrame(tryInit); } };
    requestAnimationFrame(tryInit);
  }
  return { el, applyEvent, reset };
}
