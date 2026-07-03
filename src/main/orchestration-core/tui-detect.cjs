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
// A remainder is a file only when it is path-shaped AS A WHOLE: a single path-like token, or a
// space-containing path that is clearly filesystem-anchored (drive/UNC/home/relative prefix, e.g.
// "C:\My Project\file.ts"). Prose that merely MENTIONS a path ("error handling to src/parser.js")
// stays prose — otherwise codex prose bullets become phantom Write nodes with sentence-long files.
function looksLikeWholePath(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/^\S+$/.test(t)) return looksLikePath(t);
  return /^(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\.{0,2}\/)/.test(t) && looksLikePath(t.split(/\s+/).pop());
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
  // (6) "• Added/Edited/Updated/Created/Wrote/Modified/Patched <file>" → a file write (edit). The capture is
  //     the FULL remainder minus codex's trailing "(+N -M)" diff stat — so a space-containing path
  //     ("C:\My Project\file.ts") survives — and it must LOOK LIKE A PATH: a prose bullet that happens to
  //     start with one of these verbs ("• Added error handling to the parser") is NOT a write (no phantom
  //     Write node; it falls through like any other prose line).
  m = t.match(/^[•·]\s*(?:Added|Edited|Updated|Created|Wrote|Modified|Patched|Removed|Deleted)\s+(.+)$/);
  if (m) {
    const f = m[1].trim().replace(/\s*\(\+\d+\s+-\d+\)\s*$/, '').trim();
    if (looksLikeWholePath(f)) return { type: 'edit', name: 'Write', file: f, label: `Write: ${shorten(f)}` };
    // not path-shaped as a whole → prose, not a file action
  }
  // (7) "• Read/Reading/Viewed/Opened <file>" → inspect (explicit read marker, if codex emits one). Same
  //     widened-capture + whole-path rule as (6).
  m = t.match(/^[•·]\s*(?:Read|Reading|Viewed|Opened)\s+(.+)$/);
  if (m) {
    const f = m[1].trim().replace(/\s*\(\+\d+\s+-\d+\)\s*$/, '').trim();
    if (looksLikeWholePath(f)) return { type: 'inspect', name: 'Read', file: f, label: `Read: ${shorten(f)}` };
  }
  void nx; // reserved for future multi-line grammars

  return null;
}

// --- transcript-level grammars (not tools) -----------------------------------------------------------------
// The user's SUBMITTED prompt echoed into claude's transcript ("❯ fix the tests"). Column-0 marker only, and
// content required — the EMPTY input prompt ("❯") is the idle marker, not a turn.
function matchUserEcho(t) {
  const m = /^❯\s+(\S.*)$/.exec(t);
  return m ? m[1].trim() : null;
}
// An assistant PROSE bullet ("● I'll do the three steps in order.") — claude's ● only, and only when it is
// clearly NOT a tool line: never a "Verb(target)" form (rule 1 owns those), never a batching summary
// ("● Reading 1 file, running 1 shell command…"), and it must read as a finished sentence. Conservative:
// better to skip a prose line than to misclassify a tool line.
function matchAssistantProse(t) {
  const m = /^●\s+(\S.*)$/.exec(t);
  if (!m) return null;
  const text = m[1].trim();
  if (/^[A-Za-z][\w]*\(/.test(text)) return null; // tool form (guard; rule 1 already consumed real ones)
  if (/^(read|reading|run|running|writ|creat|updat|edit|search|fetch|bash|task|glob|grep|list)/i.test(text)) return null; // tool-ish summary
  if (!/[.!?:…]$/.test(text)) return null;
  return text;
}

// --- idle detection (per tick, on the VISIBLE grid) ---------------------------------------------------------
// Mid-tool markers: an interruptible spinner ("esc to interrupt" — claude AND codex render it while working),
// braille spinner frames, or claude's star-glyph thinking spinner. While any is visible, nothing gets closed.
function looksBusy(line) {
  return /esc to interrupt/i.test(line)
    || /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠛⠓⠿⣿]/.test(line)
    || /^\s*[✢✳✶✻✽]\s/.test(line)
    // A permission/trust dialog awaiting the user is BUSY, not idle: the screen sits static and no
    // spinner renders while claude waits for a choice, so without this the static-screen fallback
    // would close the in-flight tool node mid-approval.
    || /Do you want|Do you trust/i.test(line)
    || /^\s*[│|]?\s*❯\s+\d+\./.test(line); // selection caret on a numbered dialog option
}
// Idle-at-input marker: claude's EMPTY prompt box ("❯" / "│ ❯ │"). NOT the "⏵⏵ …" permissions
// footer — claude renders that persistently, including while a tool is mid-flight, so it proves
// nothing about idleness. Codex has no marker we trust — static-screen fallback covers it.
function looksIdlePrompt(line) {
  return /^[│|]?\s*[❯>]\s*[│|]?$/.test(line);
}

// Stateful, incremental detector.
//   ingest(lines)          -> array of NEW trace events (node active/done, transcript, transient respond)
//   idleTick(visibleLines) -> close-the-open-node events when the TUI sits idle at its input prompt
//   finish()               -> terminal close events (open node done + run done)
function createTuiDetector() {
  // Dedup is RECENCY-SCOPED, not forever. A TUI repaint re-presents the SAME rendered lines every tick and
  // must never re-emit (rock solid); a GENUINE re-run (re-read after an edit, `npm test` again) must count
  // again. A signature may re-emit only when BOTH hold:
  //   • its occurrence COUNT across grid+scrollback GREW (a new line appeared — a repaint never adds one), and
  //   • ≥ REPEAT_AFTER other detections happened since its last emission (so adjacent "Running/Ran" pairs and
  //     rare archive/repaint double-counts stay deduped).
  // Growth seen too early is ABSORBED (count recorded without emitting) — conservative: better to under-count
  // a fast repeat than to double-count a repaint.
  const seen = new Map(); // sig -> { seq: emission counter at last emit, count: occurrences then }
  // Bound memory on a multi-hour session. The cap is far above the number of distinct tool lines that can be
  // on screen + in the grid's scrollback at once, so a still-visible tool's signature is never evicted (which
  // would let it re-emit as a duplicate). Insertion-order eviction (Map preserves order).
  const SEEN_CAP = 5000;
  const REPEAT_AFTER = 3;
  const said = new Set(); // transcript/prose lines already emitted (forever-dedup; conservative)
  let seq = 0;
  let emitSeq = 0;         // total tool emissions (the recency clock for REPEAT_AFTER)
  let lastActiveId = null;
  // Static-screen fallback state for idleTick.
  let lastVisSig = null;
  let unchangedTicks = 0;
  const IDLE_TICKS = 3;

  function ingest(lines) {
    const out = [];
    const arr = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
    const now = Date.now();
    // Pass 1: match every line, counting tool-signature occurrences (the repaint-vs-genuine-repeat evidence).
    const matches = [];
    const counts = new Map();
    for (let i = 0; i < arr.length; i += 1) {
      const hit = matchToolLine(arr[i], arr[i + 1]);
      if (hit) {
        const sig = `${hit.type}|${hit.label}|${hit.file || ''}`;
        counts.set(sig, (counts.get(sig) || 0) + 1);
        matches.push({ kind: 'tool', hit, sig });
        continue;
      }
      const t = String(arr[i] || '').replace(/[ ]/g, ' ').trim();
      const echo = matchUserEcho(t);
      if (echo != null) {
        // Only a SUBMITTED prompt (claude's output flows right below it) — never the live input box, whose
        // next line is chrome (border/footer/blank). Without this, every 600ms tick would emit a typing prefix.
        const nx = String(arr[i + 1] || '').replace(/[ ]/g, ' ').trim();
        if (/^[●⎿✳✻✶✢✽]/.test(nx)) matches.push({ kind: 'user', text: echo });
        continue;
      }
      const prose = matchAssistantProse(t);
      if (prose != null) matches.push({ kind: 'prose', text: prose });
    }
    // Repaint-storm guard: a transcript redraw (clear + repaint) or a resize re-render can grow the
    // occurrence counts of MANY already-seen signatures in one tick — a genuine re-run grows exactly
    // one. When several known sigs grow together, absorb ALL growth this tick (record counts, emit
    // nothing for them) so the graph never re-emits the whole tool history. New sigs still emit.
    let grownKnownSigs = 0;
    for (const [sig, total] of counts) {
      const rec = seen.get(sig);
      if (rec && total > rec.count) grownKnownSigs += 1;
    }
    const repaintStorm = grownKnownSigs >= 2;
    // Pass 2: emit in line order.
    for (const mt of matches) {
      if (mt.kind === 'tool') {
        const rec = seen.get(mt.sig);
        const total = counts.get(mt.sig);
        if (rec) {
          if (total <= rec.count) continue;                                      // repaint — never re-emit
          if (repaintStorm || emitSeq - rec.seq < REPEAT_AFTER) { rec.count = total; continue; } // absorb
        }
        if (lastActiveId) out.push({ ev: 'node', state: 'done', toolId: lastActiveId, at: now });
        const id = `tui${seq++}`;
        out.push({ ev: 'node', state: 'active', toolId: id, type: mt.hit.type, label: mt.hit.label, file: mt.hit.file || null, at: now });
        lastActiveId = id;
        emitSeq += 1;
        seen.set(mt.sig, { seq: emitSeq, count: total });
        if (seen.size > SEEN_CAP) seen.delete(seen.keys().next().value);
      } else {
        const key = `${mt.kind}|${mt.text}`;
        if (said.has(key)) continue;
        said.add(key);
        if (said.size > SEEN_CAP) said.delete(said.values().next().value);
        if (mt.kind === 'user') {
          out.push({ ev: 'transcript', role: 'user', text: mt.text, at: now });
        } else {
          // Assistant prose after a tool means that tool finished — close it, then show a transient Respond
          // (mirrors streamEventToTrace's text-block shape; the next node or run-done auto-closes it).
          if (lastActiveId) { out.push({ ev: 'node', state: 'done', toolId: lastActiveId, at: now }); lastActiveId = null; }
          out.push({ ev: 'node', state: 'active', toolId: null, type: 'reason', transient: true, label: 'Respond', at: now });
        }
      }
    }
    return out;
  }

  // Close the open node when the TUI is idle at its input prompt — a node otherwise only closes when the NEXT
  // tool appears, so the last tool of a turn would spin forever. Conservative: any busy marker (spinner /
  // "esc to interrupt") on the VISIBLE screen blocks the close; without an idle-prompt marker the screen must
  // additionally sit UNCHANGED for IDLE_TICKS ticks. Closes the node only — the run stays open.
  function idleTick(visibleLines) {
    const vis = Array.isArray(visibleLines) ? visibleLines : String(visibleLines || '').split(/\r?\n/);
    const sig = vis.join('\n');
    if (sig === lastVisSig) unchangedTicks += 1;
    else { unchangedTicks = 0; lastVisSig = sig; }
    if (!lastActiveId) return [];
    if (vis.some(looksBusy)) return [];
    if (!vis.some(looksIdlePrompt) && unchangedTicks < IDLE_TICKS) return [];
    const out = [{ ev: 'node', state: 'done', toolId: lastActiveId, at: Date.now() }];
    lastActiveId = null;
    return out;
  }

  function finish() {
    const out = [];
    const now = Date.now();
    if (lastActiveId) { out.push({ ev: 'node', state: 'done', toolId: lastActiveId, at: now }); lastActiveId = null; }
    out.push({ ev: 'run', state: 'done', at: now });
    return out;
  }
  return { ingest, idleTick, finish };
}

module.exports = { createTuiDetector, matchToolLine, verbToType };
