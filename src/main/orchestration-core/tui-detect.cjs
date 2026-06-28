'use strict';
// OrPAD — TUI activity detector (provider-agnostic).
//
// Observing a LIVE interactive AI-CLI TUI can't rely on a session log (claude doesn't write one under ConPTY),
// but the TUI RENDERS every tool call to the terminal screen — which OrPAD already holds (xterm). This module
// turns the rendered screen lines into the SAME trace events buildEmergentGraph consumes (the one ontology),
// so the live graph works from the terminal alone. Per-provider line grammars map into that ontology.
//
// Pure + incremental: feed it the current screen lines each tick; it remembers what it already emitted
// (dedup by signature) and returns only the NEW node events. No DOM, no model calls — unit-testable.

// Map a detected tool verb to the OrPAD node ontology (mirrors trace.cjs classifyTool).
function verbToType(verb) {
  const v = String(verb || '').toLowerCase();
  if (/^read|^reading|^grep|^glob|^search|^searching|^list|^ls|^notebookread/.test(v)) return 'inspect';
  if (/^writ|^creat|^edit|^updat|^multiedit|^applypatch|^apply_patch|^notebookedit/.test(v)) return 'edit';
  if (/^bash|^run|^running|^shell|^exec/.test(v)) return 'exec';
  if (/^web|^fetch|^websearch|^webfetch/.test(v)) return 'research';
  if (/^task|^subagent|^launch/.test(v)) return 'subagent';
  if (/^todo|^plan/.test(v)) return 'plan';
  return 'tool';
}

function looksLikePath(s) {
  const t = String(s || '').trim();
  return /[\\/]/.test(t) || /\.[a-z0-9]{1,8}$/i.test(t);
}
function shorten(s, n = 48) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// Detect a tool action from a screen line (+ the next line, for the "● Reading…\n⎿ <file>" shape).
// Returns { type, name, label, file } or null.
function matchToolLine(line, next) {
  const t = String(line || '').replace(/[ ]/g, ' ').trim();
  const nx = String(next || '').trim();

  // (1) The explicit "● Verb(target)" form — the most reliable (e.g. "● Write(out.txt)", "● Bash(npm test)").
  // Greedy to the LAST ')' so targets that themselves contain parens survive — e.g. a Windows path
  // "● Write(C:\\Program Files (x86)\\out.txt)" or "● Bash(echo '(hi)')". (Bounded to one rendered line.)
  let m = t.match(/^[●○•*]\s*([A-Za-z][\w]*)\((.*)\)/);
  if (m) {
    const name = m[1]; const target = m[2].trim();
    const type = verbToType(name);
    return { type, name, file: looksLikePath(target) ? target : null, label: target ? `${name}: ${shorten(target)}` : name };
  }

  // (2) The "⎿ $ <command>" form → a shell command (exec).
  m = t.match(/^⎿\s*\$\s*(.+)$/);
  if (m) { const cmd = m[1].trim(); return { type: 'exec', name: 'Bash', file: null, label: `Bash: ${shorten(cmd)}` }; }

  // (3) "⎿ Wrote N lines to <file>" → a write (edit).
  m = t.match(/^⎿\s*Wrote\b.*\bto\s+(.+)$/i);
  if (m) { const f = m[1].trim(); return { type: 'edit', name: 'Write', file: looksLikePath(f) ? f : null, label: `Write: ${shorten(f)}` }; }

  // (4) "⎿ <bare path>" → a file read. The "⎿" continuation under a "● Reading…" bullet carries just the path
  // (e.g. "⎿ note.txt"). We key off this ATOMIC line, NOT the "● Reading 1 file, running 1 shell command…"
  // SUMMARY bullet (which batches multiple tools and would mislabel them). Require a single path-like token.
  m = t.match(/^⎿\s*(\S+)\s*$/);
  if (m && looksLikePath(m[1]) && !/^\$/.test(m[1])) {
    const f = m[1].trim();
    return { type: 'inspect', name: 'Read', file: f, label: `Read: ${shorten(f)}` };
  }

  // --- Codex CLI TUI grammar -------------------------------------------------------------------------------------
  // Codex renders activity as "•" bullets with distinct VERBS (vs claude's "●"/"⎿"). Match only the tool verbs so
  // its prose bullets ("• I'll…", "• Done…", "• Working…", "• Starting MCP…") are skipped.
  // (5) "• Ran <cmd>" / "• Running <cmd>" → a shell action. Codex READS files via the shell (Get-Content/cat/…), so
  //     a read-like command is classified inspect, else exec. "Running" + "Ran" for the same cmd dedupe to one node.
  m = t.match(/^[•·]\s*(?:Ran|Running|Run)\s+(.+)$/);
  if (m) {
    const cmd = m[1].trim();
    const readish = /^(?:Get-Content|cat|type|head|tail|less|more|Select-String|sls|rg|grep|ls|dir|Get-ChildItem|gci|find|fd|Test-Path|Read-)/i.test(cmd);
    return readish
      ? { type: 'inspect', name: 'Read', file: null, label: `Read: ${shorten(cmd)}` }
      : { type: 'exec', name: 'Bash', file: null, label: `Bash: ${shorten(cmd)}` };
  }
  // (6) "• Added/Edited/Updated/Created/Wrote/Modified/Patched <file>" → a file write (edit). Codex appends a
  //     "(+N -M)" diff stat; capture just the path token before it.
  m = t.match(/^[•·]\s*(?:Added|Edited|Updated|Created|Wrote|Modified|Patched|Removed|Deleted)\s+([^\s(]+)/);
  if (m) {
    const f = m[1].trim();
    return { type: 'edit', name: 'Write', file: looksLikePath(f) ? f : null, label: `Write: ${shorten(f)}` };
  }
  // (7) "• Read/Reading/Viewed/Opened <file>" → inspect (explicit read marker, if codex emits one).
  m = t.match(/^[•·]\s*(?:Read|Reading|Viewed|Opened)\s+([^\s(]+)/);
  if (m && looksLikePath(m[1])) {
    const f = m[1].trim();
    return { type: 'inspect', name: 'Read', file: f, label: `Read: ${shorten(f)}` };
  }
  void nx; // reserved for future multi-line grammars

  return null;
}

// Stateful, incremental detector. `ingest(lines)` -> array of NEW trace node events (active/done).
function createTuiDetector() {
  const seen = new Set();
  // Bound memory on a multi-hour session. The cap is far above the number of distinct tool lines that can be
  // on screen + in the grid's scrollback at once, so a still-visible tool's signature is never evicted (which
  // would let it re-emit as a duplicate). Insertion-order eviction (Set preserves order).
  const SEEN_CAP = 5000;
  let seq = 0;
  let lastActiveId = null;
  function ingest(lines) {
    const out = [];
    const arr = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
    for (let i = 0; i < arr.length; i += 1) {
      const hit = matchToolLine(arr[i], arr[i + 1]);
      if (!hit) continue;
      const sig = `${hit.type}|${hit.label}|${hit.file || ''}`;
      if (seen.has(sig)) continue; // dedup: TUI repaints redraw the same line many times
      seen.add(sig);
      if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value);
      if (lastActiveId) out.push({ ev: 'node', state: 'done', toolId: lastActiveId });
      const id = `tui${seq++}`;
      out.push({ ev: 'node', state: 'active', toolId: id, type: hit.type, label: hit.label, file: hit.file || null });
      lastActiveId = id;
    }
    return out;
  }
  function finish() {
    const out = [];
    if (lastActiveId) { out.push({ ev: 'node', state: 'done', toolId: lastActiveId }); lastActiveId = null; }
    out.push({ ev: 'run', state: 'done', at: null });
    return out;
  }
  return { ingest, finish };
}

module.exports = { createTuiDetector, matchToolLine, verbToType };
