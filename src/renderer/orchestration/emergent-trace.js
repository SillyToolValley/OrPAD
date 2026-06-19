// OrPAD orchestration-core — emergent-graph trace model (browser port).
//
// Mirror of src/main/orchestration-core/trace.cjs. The main process classifies a
// governed delegation's stream into trace events ({ev:'phase'|'node'|'run'}) and
// forwards them to the renderer over IPC; this module replays an ordered list of
// those events into a graph that GROWS as work proceeds. Kept in lockstep with
// trace.cjs (pure + deterministic; see tests/orchestration-core/trace.test.mjs and
// tests/e2e/core-live-trace.spec.ts for the contract).

// Core phases (the governed-delegation envelope) + work-node types derived from
// the capable agent's NATIVE tool use.
export const PHASE_NODE = {
  recon: { type: 'recon', label: 'Recon workspace' },
  overlay_seeded: { type: 'isolate', label: 'Isolate (write-set overlay)' },
  guidance_injected: { type: 'guidance', label: 'Inject standing guidance' },
  agent_run: { type: 'delegate', label: 'Delegate to agent' },
  patch_collected: { type: 'enforce', label: 'Enforce write-set' },
};

// Map an agent tool name to a work-node type.
export function classifyTool(name) {
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
export function isInProgress(node) { return !!node && SPINNER_STATES.has(node.state); }

// Build an emergent graph from an ordered list of trace events. Each 'node' active
// event opens a node (in-progress spinner); the matching done event (by toolId,
// else the most recent open node of any) closes it. Nodes are linked in execution
// order. Returns { nodes, edges, activeId, done }.
export function buildEmergentGraph(traceEvents) {
  const nodes = [];
  const edges = [];
  const byTool = new Map();
  let prevId = null;
  let seq = 0;
  let runDone = false;

  const openNode = (type, label, toolId, at, transient) => {
    // a transient node (reason/respond) has no async result; close it when the next opens.
    const prev = prevId ? nodes.find((n) => n.id === prevId) : null;
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
      openNode(e.type || 'tool', e.label, e.toolId, e.at, e.transient);
    } else if (e.ev === 'node' && e.state === 'done') {
      const id = e.toolId && byTool.get(e.toolId);
      const node = id ? nodes.find((n) => n.id === id) : lastActive(nodes);
      if (node) node.state = 'done';
    } else if (e.ev === 'run' && e.state === 'done') {
      runDone = true;
      for (const n of nodes) if (n.state === 'active') n.state = 'done';
    }
  }

  // The in-progress node is the most recent active WORK node (prefer non-phase).
  const activeWork = [...nodes].reverse().find((n) => n.state === 'active' && !n.phase);
  const active = activeWork || nodes.find((n) => n.state === 'active') || null;
  return { nodes, edges, activeId: active ? active.id : null, done: runDone };
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
