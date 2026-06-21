'use strict';
// OrPAD orchestration-core — live trace model for the EMERGENT-graph GUI.
//
// The new orchestration does NOT pre-author a node graph. Instead a governed
// delegation STREAMS activity, and this module turns that stream into a graph
// that GROWS as work proceeds: each chunk of agent output is buffered and
// classified into a node TYPE, the node fed by the still-filling buffer is marked
// in-progress (spinner), and finished nodes are linked in execution order. The
// GUI replays these trace events (or tails them live) to draw the footprint.
//
// Pure + deterministic: no electron, no model calls. Consumed by the live-trace
// GUI (renderer) and testable standalone.

// --- Node-type taxonomy ---------------------------------------------------------
// Core phases (the governed-delegation envelope) + work-node types derived from
// the capable agent's NATIVE tool use (we do not invent control-flow nodes).
const PHASE_NODE = {
  recon: { type: 'recon', label: 'Recon workspace' },
  overlay_seeded: { type: 'isolate', label: 'Isolate (write-set overlay)' },
  guidance_injected: { type: 'guidance', label: 'Inject standing guidance' },
  agent_run: { type: 'delegate', label: 'Delegate to agent' },
  patch_collected: { type: 'enforce', label: 'Enforce write-set' },
  verify: { type: 'enforce', label: 'Verify gates' },
};

// Map an agent tool name to a work-node type (the "what kind of node" decision).
function classifyTool(name) {
  const n = String(name || '').toLowerCase();
  if (['read', 'grep', 'glob', 'ls', 'notebookread'].includes(n)) return 'inspect';
  if (['write', 'edit', 'multiedit', 'notebookedit', 'applypatch', 'apply_patch'].includes(n)) return 'edit';
  if (['bash', 'bashoutput', 'killbash', 'killshell'].includes(n)) return 'exec';
  if (['websearch', 'webfetch'].includes(n)) return 'research';
  if (n === 'task') return 'subagent';
  if (n === 'todowrite') return 'plan';
  if (n.startsWith('mcp__')) return 'tool';
  return 'tool';
}

const SPINNER_STATES = new Set(['active', 'running']);
function isInProgress(node) { return !!node && SPINNER_STATES.has(node.state); }

// Convert ONE claude stream-json event into zero or more trace events.
// Recognized stream shapes:
//   {type:'system',subtype:'init'|...}                      -> ignored (session)
//   {type:'assistant',message:{content:[{type:'text'|'thinking'|'tool_use',id,name,input}]}}
//   {type:'user',message:{content:[{type:'tool_result',tool_use_id,...}]}}
//   {type:'result',...}                                     -> run done
function streamEventToTrace(obj, at) {
  if (!obj || typeof obj !== 'object') return [];
  const ts = at || obj.at || null;
  const out = [];
  if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
    for (const block of obj.message.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use') {
        out.push({ ev: 'node', state: 'active', toolId: block.id || null,
          type: classifyTool(block.name), label: toolLabel(block), file: toolFile(block), at: ts });
      } else if (block.type === 'thinking' || block.type === 'text') {
        out.push({ ev: 'node', state: 'active', toolId: null, type: 'reason', transient: true,
          label: block.type === 'thinking' ? 'Reason' : 'Respond', at: ts });
      }
    }
  } else if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
    for (const block of obj.message.content) {
      if (block && block.type === 'tool_result') {
        out.push({ ev: 'node', state: 'done', toolId: block.tool_use_id || null, at: ts });
      }
    }
  } else if (obj.type === 'result') {
    out.push({ ev: 'run', state: 'done', at: ts,
      costUsd: obj.total_cost_usd ?? null, numTurns: obj.num_turns ?? null });
  }
  return out;
}

function toolLabel(block) {
  const name = block.name || 'tool';
  const input = block.input || {};
  const hint = input.file_path || input.path || input.pattern || input.command || input.query || input.description;
  const short = hint ? String(hint).split(/[\\/]/).pop().slice(0, 40) : '';
  return short ? `${name}: ${short}` : String(name);
}

// The file a tool touches (read/write targets only — not patterns/commands/queries).
// Full path so the live file-access layer can dedupe and link files. null otherwise.
function toolFile(block) {
  const input = (block && block.input) || {};
  const f = input.file_path || input.path || input.notebook_path;
  return f ? String(f) : null;
}

// Build an emergent graph from an ordered list of trace events. Each 'node'
// active event opens a node (in-progress spinner); the matching done event (by
// toolId, else the most recent open node of any) closes it. Nodes are linked in
// execution order. Returns { nodes, edges, activeId, done }.
function buildEmergentGraph(traceEvents) {
  const nodes = [];
  const edges = [];
  const byTool = new Map();
  const files = new Map();
  const lastByBranch = new Map();   // branch -> last node id (sequential within a branch)
  const forkAnchor = new Map();     // branch -> the node id it forked from
  const branchLabels = new Map();   // branch -> display label
  let pendingJoin = null;           // { into, from:[nodeIds] } — next 'into' node links from these
  let seq = 0;
  let runDone = false;

  // Segments drive the layout: a run is a vertical stack of linear runs and
  // parallel (fork/join) sections; a parallel section lays its branches side by side.
  const segments = [];
  let parallel = null; // active parallel section: { branches:[{id,label,nodeIds}], byId:Map }

  const segPush = (branch, id) => {
    if (parallel && branch !== 'main') {
      let b = parallel.byId.get(branch);
      if (!b) { b = { id: branch, label: branchLabels.get(branch) || branch, nodeIds: [] }; parallel.byId.set(branch, b); parallel.branches.push(b); }
      b.nodeIds.push(id);
      return;
    }
    let last = segments[segments.length - 1];
    if (!last || last.kind !== 'linear') { last = { kind: 'linear', nodeIds: [] }; segments.push(last); }
    last.nodeIds.push(id);
  };

  const openNode = (type, label, toolId, at, transient, branch) => {
    const br = branch || 'main';
    // a transient node (reason/respond) closes when the next node in its branch opens.
    const prevId = lastByBranch.get(br);
    const prev = prevId ? nodes.find(n => n.id === prevId) : null;
    if (prev && prev.state === 'active' && prev.transient) prev.state = 'done';
    const id = `n${seq++}`;
    const node = { id, type, label: label || type, state: 'active', at: at || null, branch: br };
    if (transient) node.transient = true;
    nodes.push(node);
    let parents;
    if (pendingJoin && br === pendingJoin.into) { parents = pendingJoin.from.slice(); pendingJoin = null; }
    else {
      const p = lastByBranch.has(br) ? lastByBranch.get(br)
        : (forkAnchor.has(br) ? forkAnchor.get(br) : lastByBranch.get('main'));
      parents = p ? [p] : [];
    }
    for (const pid of parents) if (pid) edges.push({ from: pid, to: id });
    lastByBranch.set(br, id);
    if (toolId) byTool.set(toolId, id);
    segPush(br, id);
    return node;
  };

  for (const e of (Array.isArray(traceEvents) ? traceEvents : [])) {
    if (!e || typeof e !== 'object') continue;
    if (e.ev === 'phase' && e.state === 'start') {
      const meta = PHASE_NODE[e.kind] || { type: e.type || 'phase', label: e.label || e.kind };
      const node = openNode(meta.type, e.label || meta.label, e.id || null, e.at, false, 'main');
      node.phase = true;
    } else if (e.ev === 'phase' && e.state === 'done') {
      const target = phaseNodeOf(nodes, e) || lastActive(nodes);
      if (target) target.state = 'done';
    } else if (e.ev === 'fork') {
      // Fan-out: parallel branches all spring from the current frontier of `from`.
      const anchor = lastByBranch.get(e.from || 'main') || null;
      parallel = { branches: [], byId: new Map() };
      for (const b of (Array.isArray(e.branches) ? e.branches : [])) {
        const bid = typeof b === 'string' ? b : (b && b.id);
        if (!bid) continue;
        const label = typeof b === 'string' ? b : (b.label || b.id);
        forkAnchor.set(bid, anchor);
        branchLabels.set(bid, label);
        const bucket = { id: bid, label, nodeIds: [] };
        parallel.byId.set(bid, bucket);
        parallel.branches.push(bucket);
      }
      segments.push({ kind: 'parallel', anchor, branches: parallel.branches });
    } else if (e.ev === 'join') {
      const from = Array.isArray(e.from) ? e.from : [...(parallel ? parallel.byId.keys() : [])];
      pendingJoin = { into: e.into || 'main', from: from.map(b => lastByBranch.get(b)).filter(Boolean) };
      parallel = null;
    } else if (e.ev === 'node' && e.state === 'active') {
      const br = e.branch || 'main';
      // A main-branch work node means the enclosing phase (agent_run "Delegate to
      // agent") has handed off — close it so only the work frontier spins. Branch
      // (subagent) nodes never close a main phase.
      if (br === 'main') {
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
          if (nodes[i].phase) { if (nodes[i].state === 'active') nodes[i].state = 'done'; break; }
        }
      }
      const work = openNode(e.type || 'tool', e.label, e.toolId, e.at, e.transient, br);
      if (e.file) {
        // File-access layer: which work node touches which file (reads vs writes).
        const access = work.type === 'edit' ? 'write' : (work.type === 'inspect' ? 'read' : 'touch');
        work.file = e.file;
        work.access = access;
        const rec = files.get(e.file) || { path: e.file, reads: 0, writes: 0, nodes: [] };
        if (access === 'write') rec.writes += 1; else if (access === 'read') rec.reads += 1;
        rec.nodes.push(work.id);
        files.set(e.file, rec);
      }
    } else if (e.ev === 'node' && e.state === 'done') {
      const id = e.toolId && byTool.get(e.toolId);
      const node = id ? nodes.find(n => n.id === id) : lastActive(nodes);
      if (node) node.state = 'done';
    } else if (e.ev === 'run' && e.state === 'done') {
      runDone = true;
      for (const n of nodes) if (n.state === 'active') n.state = 'done';
    }
  }

  // The in-progress node is the most recent active WORK node (prefer non-phase).
  const activeWork = [...nodes].reverse().find(n => n.state === 'active' && !n.phase);
  const active = activeWork || nodes.find(n => n.state === 'active') || null;
  // A run is complete only when the terminal run-done arrived AND every node is
  // closed. A grounded run streams TWO agents (research, then build); the first
  // agent's result emits an intermediate run-done, so requiring all nodes closed
  // prevents that from flipping the graph to "complete" while the build runs on.
  const done = runDone && nodes.every(n => n.state === 'done');
  return { nodes, edges, activeId: active ? active.id : null, done, files: [...files.values()], segments };
}

function lastActive(nodes) {
  for (let i = nodes.length - 1; i >= 0; i -= 1) if (nodes[i].state === 'active') return nodes[i];
  return null;
}
function phaseNodeOf(nodes, e) {
  const meta = PHASE_NODE[e.kind];
  if (!meta) return null;
  for (let i = nodes.length - 1; i >= 0; i -= 1) if (nodes[i].phase && nodes[i].type === meta.type) return nodes[i];
  return null;
}

module.exports = {
  PHASE_NODE,
  classifyTool,
  isInProgress,
  toolLabel,
  streamEventToTrace,
  buildEmergentGraph,
};
