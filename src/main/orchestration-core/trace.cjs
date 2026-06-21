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
  let prevId = null;
  let seq = 0;
  let runDone = false;

  const openNode = (type, label, toolId, at, transient) => {
    // a transient node (reason/respond) has no async result; close it when the next opens.
    const prev = prevId ? nodes.find(n => n.id === prevId) : null;
    if (prev && prev.state === 'active' && prev.transient) prev.state = 'done';
    const id = `n${seq++}`;
    const node = { id, type, label: label || type, state: 'active', at: at || null };
    if (transient) node.transient = true;
    nodes.push(node);
    if (prevId) edges.push({ from: prevId, to: id });
    prevId = id;
    if (toolId) byTool.set(toolId, id);
    return node;
  };

  for (const e of (Array.isArray(traceEvents) ? traceEvents : [])) {
    if (!e || typeof e !== 'object') continue;
    if (e.ev === 'phase' && e.state === 'start') {
      const meta = PHASE_NODE[e.kind] || { type: e.type || 'phase', label: e.label || e.kind };
      const node = openNode(meta.type, e.label || meta.label, e.id || null, e.at);
      node.phase = true;
    } else if (e.ev === 'phase' && e.state === 'done') {
      const target = phaseNodeOf(nodes, e) || lastActive(nodes);
      if (target) target.state = 'done';
    } else if (e.ev === 'node' && e.state === 'active') {
      // The enclosing phase (e.g. agent_run "Delegate to agent") has handed off
      // once real work streams in — close it so only the work frontier spins,
      // not an earlier phase node sitting above its finished children.
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        if (nodes[i].phase) { if (nodes[i].state === 'active') nodes[i].state = 'done'; break; }
      }
      const work = openNode(e.type || 'tool', e.label, e.toolId, e.at, e.transient);
      if (e.file) {
        // File-access layer: record which work node touches which file (the data
        // layer behind the live graph — reads vs writes per file).
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
  return { nodes, edges, activeId: active ? active.id : null, done, files: [...files.values()] };
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
