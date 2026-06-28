'use strict';
// OrPAD — minimal VT (terminal) screen reconstructor.
//
// An interactive AI-CLI TUI (claude/codex/…) RENDERS its activity to the terminal using cursor moves and
// erases — the raw PTY byte stream interleaves text with control sequences (\x1b[H, \x1b[C, \x1b[K, …) and
// spinner repaints, so the bytes alone are unreadable (words get split by cursor ops). To detect tool calls
// we need the RENDERED SCREEN, not the bytes. This is a tiny VT emulator: feed it the PTY chunks, read back
// the current grid of lines. It implements just the ops these TUIs use (CUP/CUU/CUD/CUF/CUB/CHA, EL, ED, CR,
// LF, BS, and OSC skip) — enough to reconstruct the visible text. Validated against a live claude run.
//
// Pure + dependency-free (no xterm in the main process) → unit-testable.

function createVtGrid(rows = 40, cols = 120) {
  const R = Math.max(4, rows | 0);
  const C = Math.max(20, cols | 0);
  let grid = Array.from({ length: R }, () => new Array(C).fill(' '));
  let cr = 0; // cursor row
  let cc = 0; // cursor col
  let carry = ''; // an escape sequence split across PTY chunks — held until the rest arrives
  // A real CSI is short, but an OSC-8 hyperlink can carry a long URL; 4096 covers legitimate sequences while
  // still bounding a never-terminated (malformed) escape so carry can't grow unbounded.
  const CARRY_CAP = 4096;

  // Scrollback: rows that scroll OFF the top are archived (text only). The detector reads a tick every ~600ms,
  // but a fast-flowing TUI can render a tool line and scroll it past the visible rows before the next tick —
  // it would be MISSED (the detector dedups, so it only fires once). Keeping scrolled-off rows here lets the
  // detector still see them. The VISIBLE grid stays exactly R rows so cursor positioning matches the PTY.
  const scrollback = [];
  const SCROLLBACK_CAP = 2000;

  function blankRow() { return new Array(C).fill(' '); }
  function archive(row) {
    scrollback.push(row.join('').replace(/\s+$/, ''));
    if (scrollback.length > SCROLLBACK_CAP) scrollback.shift();
  }
  function clampRow() {
    // Cap how far past the bottom the cursor can be BEFORE scrolling — a malformed escape (e.g. "\x1b[999999999B"
    // or a huge CUP row) would otherwise spin this loop ~1e9 times and hang the main process. Scrolling more than
    // R rows in one step just clears the screen anyway.
    if (cr >= 2 * R) cr = 2 * R - 1;
    // scroll up when the cursor passes the last row (TUIs that flow content downward)
    while (cr >= R) { archive(grid.shift()); grid.push(blankRow()); cr -= 1; }
    if (cr < 0) cr = 0;
  }
  function put(ch) {
    if (cc >= C) cc = C - 1;
    grid[cr][cc] = ch;
    cc += 1;
    if (cc >= C) cc = C - 1; // clamp at the right margin (no auto-wrap; TUIs position explicitly)
  }

  function write(input) {
    const s = carry + String(input == null ? '' : input);
    carry = '';
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (ch === '\x1b') {
        if (i + 1 >= s.length) { carry = s.slice(i); break; } // bare trailing ESC → wait for the rest
        if (s[i + 1] === '[') {
          // CSI: ESC [ params final
          let j = i + 2;
          let params = '';
          while (j < s.length && /[0-9;?]/.test(s[j])) { params += s[j]; j += 1; }
          if (j >= s.length) { carry = s.slice(i); break; } // CSI split across chunks → hold for the next write
          const fin = s[j];
          i = j; // consume through the final byte
          const nums = params.replace(/[?]/g, '').split(';').map((x) => (x === '' ? null : parseInt(x, 10)));
          const n = nums[0];
          if (fin === 'H' || fin === 'f') { cr = (nums[0] || 1) - 1; cc = (nums[1] || 1) - 1; clampRow(); if (cc < 0) cc = 0; }
          else if (fin === 'A') { cr -= (n || 1); if (cr < 0) cr = 0; }
          else if (fin === 'B') { cr += (n || 1); clampRow(); }
          else if (fin === 'C') { cc += (n || 1); if (cc >= C) cc = C - 1; }
          else if (fin === 'D') { cc -= (n || 1); if (cc < 0) cc = 0; }
          else if (fin === 'G') { cc = (n || 1) - 1; if (cc < 0) cc = 0; if (cc >= C) cc = C - 1; }
          else if (fin === 'd') { cr = (n || 1) - 1; clampRow(); }
          else if (fin === 'K') { // erase in line
            const m = n || 0;
            if (m === 0) { for (let x = cc; x < C; x += 1) grid[cr][x] = ' '; }
            else if (m === 1) { for (let x = 0; x <= cc && x < C; x += 1) grid[cr][x] = ' '; }
            else { for (let x = 0; x < C; x += 1) grid[cr][x] = ' '; }
          }
          else if (fin === 'J') { // erase in display
            const m = n || 0;
            if (m === 2 || m === 3) { grid = Array.from({ length: R }, () => blankRow()); cr = 0; cc = 0; }
            else if (m === 0) { for (let x = cc; x < C; x += 1) grid[cr][x] = ' '; for (let y = cr + 1; y < R; y += 1) grid[y] = blankRow(); }
            else if (m === 1) { for (let y = 0; y < cr; y += 1) grid[y] = blankRow(); for (let x = 0; x <= cc && x < C; x += 1) grid[cr][x] = ' '; }
          }
          // other CSI (SGR colour 'm', mode set/reset 'h'/'l', etc.) are visually irrelevant → skip
        } else if (s[i + 1] === ']') {
          // OSC: ESC ] … (BEL | ESC \) — title/hyperlink/etc.; skip to the terminator
          let j = i + 2;
          while (j < s.length && s[j] !== '\x07' && s[j] !== '\x1b') j += 1;
          if (j >= s.length) { carry = s.slice(i); break; } // OSC split across chunks → hold for the next write
          // BEL terminator: land on it, the loop's i++ consumes it. ESC terminator (ESC \ ST): step back one so
          // the ESC is re-parsed as an escape PAIR next iteration — otherwise i++ would skip the ESC and render
          // the following '\\' (and payload) as stray text.
          i = (s[j] === '\x1b') ? j - 1 : j;
        } else {
          i += 1; // ESC + single byte (e.g. ESC = / ESC > / charset) → skip the pair
        }
      } else if (ch === '\r') { cc = 0; }
      else if (ch === '\n') { cr += 1; cc = 0; clampRow(); }
      else if (ch === '\b') { if (cc > 0) cc -= 1; }
      else if (ch === '\t') { cc = Math.min(C - 1, (cc + 8) - (cc % 8)); }
      else if (ch >= ' ') { put(ch); }
      // other control chars (BEL, etc.) ignored
    }
    if (carry.length > CARRY_CAP) carry = ''; // never-terminated escape = garbage; don't hold it forever
  }

  // Scrolled-off history THEN the current visible screen — the detector dedups, so any overlap is harmless.
  function lines() { return scrollback.concat(grid.map((row) => row.join('').replace(/\s+$/, ''))); }
  function visibleLines() { return grid.map((row) => row.join('').replace(/\s+$/, '')); }

  return { write, lines, visibleLines, get cols() { return C; }, get rows() { return R; } };
}

module.exports = { createVtGrid };
