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
  vault_read: { type: 'recon', label: 'Read knowledge vault' },
  overlay_seeded: { type: 'isolate', label: 'Isolate (write-set overlay)' },
  guidance_injected: { type: 'guidance', label: 'Inject standing guidance' },
  agent_run: { type: 'delegate', label: 'Delegate to agent' },
  patch_collected: { type: 'enforce', label: 'Enforce write-set' },
  vault_writeback: { type: 'enforce', label: 'Capture to knowledge vault' },
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

// Convert ONE Claude Code on-disk SESSION-LOG entry (~/.claude/projects/<slug>/<id>.jsonl) into trace events.
// This is how we OBSERVE a live interactive TUI (which the user drives) without OrPAD running the agent: the
// session log reuses the SAME assistant/user message shape as `-p` stream-json (tool_use / tool_result / text
// / thinking blocks), so we delegate to streamEventToTrace. Differences handled here:
//   • a human 'user' turn carries a plain STRING content (not blocks) → streamEventToTrace's Array.isArray
//     guard skips it (no node), which is what we want;
//   • there is NO {type:'result'} terminal entry → run-done is synthesized by the watcher on idle / PTY exit,
//     so we only forward assistant/user message entries and ignore everything else
//     (mode / permission-mode / attachment / file-history-snapshot / summary / system).
function sessionEntryToTrace(input, at) {
  const obj = typeof input === 'string' ? parseJsonOrNull(input) : input;
  if (!obj || typeof obj !== 'object') return [];
  if (obj.type !== 'assistant' && obj.type !== 'user') return [];
  return streamEventToTrace(obj, at || obj.timestamp || null);
}

// Convert ONE Codex CLI `exec --json` event into zero or more trace events.
// Recognized stream shapes:
//   {type:'thread.started'|...}                       -> ignored (session)
//   {type:'item.started',item:{id,type,...}}          -> node active
//   {type:'item.completed'|'item.failed',item:{id}}   -> node done / prose transient
//   {type:'turn.completed'|'turn.failed'|'error'}     -> run done
function codexEventToTrace(input, at) {
  const obj = typeof input === 'string' ? parseJsonOrNull(input) : input;
  if (!obj || typeof obj !== 'object') return [];
  const ts = at || obj.at || null;
  const item = obj.item && typeof obj.item === 'object' ? obj.item : null;
  if (obj.type === 'item.started' && item) {
    if (codexItemKind(item) === 'reasoning') {
      return [{ ev: 'node', state: 'active', toolId: null, type: 'reason',
        transient: true, label: 'Reason', at: ts }];
    }
    const work = codexItemWork(item, ts);
    return work ? [work] : [];
  }
  if ((obj.type === 'item.completed' || obj.type === 'item.failed') && item) {
    if (codexItemKind(item) === 'agent_message') {
      return [{ ev: 'node', state: 'active', toolId: null, type: 'reason',
        transient: true, label: 'Respond', at: ts }];
    }
    if (codexItemKind(item) === 'reasoning') {
      return [{ ev: 'node', state: 'active', toolId: null, type: 'reason',
        transient: true, label: 'Reason', at: ts }];
    }
    if (codexItemKind(item) === 'plan_update' && !item.id) {
      return [
        { ev: 'node', state: 'active', toolId: null, type: 'plan',
          label: codexItemLabel(item), file: null, at: ts },
        { ev: 'node', state: 'done', toolId: null, at: ts },
      ];
    }
    if (codexItemTraceType(item)) {
      return [{ ev: 'node', state: 'done', toolId: item.id || null, at: ts }];
    }
  }
  if (obj.type === 'turn.completed') {
    return [{ ev: 'run', state: 'done', at: ts, costUsd: null, numTurns: 1 }];
  }
  if (obj.type === 'turn.failed' || obj.type === 'error') {
    return [{ ev: 'run', state: 'done', at: ts, costUsd: null, numTurns: null }];
  }
  return [];
}

function codexResultFromEvent(input, current) {
  const obj = typeof input === 'string' ? parseJsonOrNull(input) : input;
  if (!obj || typeof obj !== 'object') return current || null;
  const item = obj.item && typeof obj.item === 'object' ? obj.item : null;
  const next = current && typeof current === 'object' ? { ...current } : {};
  if (item && obj.type === 'item.completed' && codexItemKind(item) === 'agent_message') {
    next.result = String(item.text || item.message || item.content || next.result || '');
    return next;
  }
  if (obj.type === 'turn.completed') {
    next.is_error = false;
    next.usage = obj.usage || next.usage || null;
    next.num_turns = (Number.isInteger(next.num_turns) ? next.num_turns : 0) + 1;
    return next;
  }
  if (obj.type === 'turn.failed' || obj.type === 'error') {
    next.is_error = true;
    const errorMessage = obj.error && typeof obj.error === 'object'
      ? (obj.error.message || obj.error.code || '')
      : obj.error;
    next.result = String(obj.message || errorMessage || next.result || '');
    next.api_error_status = obj.status || obj.code || next.api_error_status || null;
    return next;
  }
  return current || null;
}

function parseJsonOrNull(text) {
  try { return JSON.parse(String(text || '').trim()); } catch (_) { return null; }
}

function codexItemWork(item, at) {
  const type = codexItemTraceType(item);
  if (!type) return null;
  return {
    ev: 'node',
    state: 'active',
    toolId: item.id || null,
    type,
    label: codexItemLabel(item),
    file: codexItemFile(item),
    at,
  };
}

function codexItemTraceType(item) {
  const kind = codexItemKind(item);
  if (kind === 'command_execution' || kind === 'shell_command' || kind === 'exec_command' || kind === 'local_shell') return 'exec';
  if (kind === 'file_change' || kind === 'file_changes' || kind === 'file_edit' || kind === 'apply_patch') return 'edit';
  if (kind === 'file_read' || kind === 'read_file' || kind === 'grep' || kind === 'glob' || kind === 'list_files') return 'inspect';
  if (kind === 'web_search' || kind === 'web_search_call' || kind === 'web_fetch') return 'research';
  if (kind === 'subagent' || kind === 'agent_task' || kind === 'task') return 'subagent';
  if (kind === 'plan_update' || kind === 'update_plan') return 'plan';
  if (kind === 'mcp_tool_call' || kind === 'tool_call' || kind === 'dynamic_tool_call') return 'tool';
  if (kind === 'agent_message') return null;
  return null;
}

function codexItemKind(item) {
  // Real `codex exec --json` items carry their kind as `item_type` (e.g. {"type":"item.completed","item":
  // {"id":"item_1","item_type":"file_change","changes":[{"path":"...","kind":"update"}]}}); older/other
  // shapes use `type`/`kind`/`name`. Tolerate all of them.
  return String((item && (item.item_type || item.type || item.kind || item.name)) || '').toLowerCase();
}

function codexItemLabel(item) {
  const kind = codexItemKind(item);
  const name = codexItemDisplayName(item);
  const hint = codexItemHint(item);
  const short = hint ? truncateMiddle(String(hint).replace(/\s+/g, ' ').trim(), 64) : '';
  if (kind === 'reasoning') return 'Reason';
  if (kind === 'plan_update' || kind === 'update_plan') return short ? `Plan: ${short}` : 'Plan';
  if (short) return `${name}: ${short}`;
  return name;
}

function codexItemDisplayName(item) {
  const kind = codexItemKind(item);
  const raw = item.name || item.tool_name || item.tool || item.command_name || '';
  if (raw) return String(raw);
  if (kind === 'command_execution' || kind === 'shell_command' || kind === 'exec_command' || kind === 'local_shell') return 'Bash';
  if (kind === 'file_change' || kind === 'file_changes' || kind === 'file_edit' || kind === 'apply_patch') return 'Edit';
  if (kind === 'file_read' || kind === 'read_file') return 'Read';
  if (kind === 'grep') return 'Grep';
  if (kind === 'glob') return 'Glob';
  if (kind === 'list_files') return 'LS';
  if (kind === 'web_search' || kind === 'web_search_call') return 'WebSearch';
  if (kind === 'web_fetch') return 'WebFetch';
  if (kind === 'subagent' || kind === 'agent_task' || kind === 'task') return 'Task';
  if (kind === 'mcp_tool_call') return 'MCP';
  return kind || 'tool';
}

function codexItemHint(item) {
  const command = item.command || item.cmd || item.argv;
  if (Array.isArray(command)) return command.join(' ');
  const direct = command || item.path || item.file_path || item.filename || item.query || item.url
    || item.description || item.summary || item.text;
  if (direct) return direct;
  if (Array.isArray(item.files) && item.files.length) return item.files[0];
  if (Array.isArray(item.changes) && item.changes.length) {
    const first = item.changes[0];
    if (first && typeof first === 'object') return first.path || first.file_path || first.filename || '';
    return first;
  }
  if (item.input && typeof item.input === 'object') {
    return item.input.file_path || item.input.path || item.input.command || item.input.query
      || item.input.url || item.input.description || '';
  }
  return '';
}

function codexItemFile(item) {
  const direct = item.path || item.file_path || item.filename;
  if (direct) return String(direct);
  if (Array.isArray(item.files) && item.files.length) return String(item.files[0]);
  if (Array.isArray(item.changes) && item.changes.length) {
    const first = item.changes[0];
    if (first && typeof first === 'object') {
      const f = first.path || first.file_path || first.filename;
      if (f) return String(f);
    } else if (first) {
      return String(first);
    }
  }
  const input = item.input && typeof item.input === 'object' ? item.input : null;
  if (input) {
    const f = input.file_path || input.path || input.notebook_path;
    if (f) return String(f);
  }
  return null;
}

function truncateMiddle(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  const head = Math.ceil((max - 3) / 2);
  const tail = Math.floor((max - 3) / 2);
  return `${s.slice(0, head)}...${s.slice(-tail)}`;
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
  sessionEntryToTrace,
  codexEventToTrace,
  codexResultFromEvent,
  buildEmergentGraph,
};
