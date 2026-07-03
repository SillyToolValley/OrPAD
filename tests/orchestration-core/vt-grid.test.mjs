import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { createVtGrid } = require(path.join(repoRoot, 'src/main/orchestration-core/vt-grid.cjs'));

test('plain text + newlines reconstruct as rows', () => {
  const g = createVtGrid(10, 40);
  g.write('hello\r\nworld');
  const lines = g.lines();
  assert.equal(lines[0], 'hello');
  assert.equal(lines[1], 'world');
});

test('cursor moves (CUF/CUB/CUP) and \\r overwrite reconstruct the rendered line, not the byte order', () => {
  const g = createVtGrid(6, 40);
  // The exact pathology of a raw TUI stream: a word split by cursor-forward ops between letters.
  g.write('\x1b[H');           // home
  g.write('A\x1b[CB\x1b[CC');  // A, →, B, →, C  → "A B C" (a space where the cursor skipped)
  assert.equal(g.lines()[0], 'A B C');
  // \r returns to col 0; subsequent text overwrites only the cells it lands on (spinner repaint pattern):
  // X→col0, Y→col1 (the old skip-space), so B at col2 is now adjacent → "XYB"; col4 still holds C.
  g.write('\rXY');
  assert.equal(g.lines()[0], 'XYB C');
});

test('erase-in-line (EL) and erase-in-display (ED) clear as a real terminal does', () => {
  const g = createVtGrid(6, 40);
  g.write('keepme NOISE');
  g.write('\r\x1b[6C\x1b[K');   // col 6 (the space), erase to end of line → drop " NOISE", keep cols 0..5
  assert.equal(g.lines()[0], 'keepme');
  g.write('\x1b[2J');           // clear whole display
  assert.equal(g.lines().join(''), '');
});

test('OSC sequences (title / hyperlink) are skipped, not rendered', () => {
  const g = createVtGrid(4, 40);
  g.write('\x1b]0;some terminal title\x07ok');
  assert.equal(g.lines()[0], 'ok');
  // OSC terminated by ST (ESC \) instead of BEL — the ST must be fully consumed (no stray '\' leaks into text).
  const g2 = createVtGrid(4, 40);
  g2.write('\x1b]8;;http://x\x1b\\link');
  assert.equal(g2.lines()[0], 'link');
  assert.equal(g2.lines()[0].includes('http'), false);
  // OSC-8 hyperlink wrapping a label, then a real tool marker after the closing ST — marker survives intact.
  const g3 = createVtGrid(4, 60);
  g3.write('\x1b]8;;file:///x\x07● \x1b]8;;\x07Write(a.txt)');
  assert.equal(g3.lines()[0], '● Write(a.txt)');
});

test('SGR colour codes are stripped from the rendered text', () => {
  const g = createVtGrid(4, 40);
  g.write('\x1b[31m● \x1b[0mWrite(out.txt)');
  assert.equal(g.lines()[0], '● Write(out.txt)');
});

test('a malformed huge cursor-move param does not hang (clamped scroll, no 1e9-iteration loop)', () => {
  const g = createVtGrid(10, 20);
  g.write('top\r\n');
  g.write('\x1b[999999999B'); // CUD with an absurd row count — must NOT spin the scroll loop ~1e9 times
  g.write('bottom');
  const all = g.lines();
  assert.equal(all.some((l) => l.includes('bottom')), true, 'still renders after the clamped scroll');
  assert.equal(all.length <= 10 + 2000, true, 'scrollback stays bounded'); // (no hang = test returns at all)
  // a huge absolute CUP row is clamped too
  const g2 = createVtGrid(8, 20);
  g2.write('\x1b[999999999;1Hx');
  assert.equal(g2.lines().some((l) => l.includes('x')), true);
});

test('an escape sequence split across PTY chunks is reassembled (real chunk boundaries)', () => {
  const g = createVtGrid(4, 40);
  // CSI split mid-sequence: "\x1b[3" arrives, then "1m● Write(a.txt)"
  g.write('\x1b[3');
  g.write('1m● Write(a.txt)');
  assert.equal(g.lines()[0], '● Write(a.txt)'); // colour stripped, marker intact (not corrupted by the split)
  // a bare trailing ESC is held too
  const g2 = createVtGrid(4, 40);
  g2.write('hi\x1b');
  g2.write('[K!');
  assert.equal(g2.lines()[0], 'hi!');
  // OSC split across chunks
  const g3 = createVtGrid(4, 40);
  g3.write('\x1b]0;ti');
  g3.write('tle\x07done');
  assert.equal(g3.lines()[0], 'done');
});

test('content flowing past the last row scrolls up; scrolled-off rows are archived to scrollback', () => {
  const g = createVtGrid(4, 20);
  for (let i = 0; i < 8; i += 1) g.write(`line${i}\r\n`);
  // The VISIBLE screen stays exactly R rows and holds the latest.
  const vis = g.visibleLines();
  assert.equal(vis.length, 4);
  assert.equal(vis.some((l) => l.includes('line7')), true);
  assert.equal(vis.some((l) => l.includes('line0')), false);
  // But scrolled-off rows survive in lines() (scrollback + visible) — the detector still sees early tools.
  const all = g.lines();
  assert.equal(all.some((l) => l.includes('line0')), true, 'early line preserved in scrollback');
  assert.equal(all.some((l) => l.includes('line7')), true);
});

test('resize: columns truncate/pad in place; shrinking rows DROP the top rows (repaint re-delivers them)', () => {
  const g = createVtGrid(6, 40);
  g.write('hello world\r\nsecond line\r\n');
  g.resize(20, 6); // narrower — existing text (within 20 cols) survives
  assert.equal(g.cols, 20);
  assert.equal(g.lines()[0], 'hello world');
  g.resize(60, 6); // wider again — rows padded; new full-width text renders intact
  assert.equal(g.cols, 60);
  assert.equal(g.lines()[1], 'second line');
  g.write('a-line-after-widening-that-is-longer-than-40-chars!\r\n');
  assert.ok(g.lines().some((l) => l.includes('longer-than-40-chars!')));

  // rows SHRINK: the overflowing TOP rows are DROPPED, not archived — the TUI repaints for the new geometry,
  // so an archived copy + the repaint would double-count every line (the detector would read it as re-runs).
  const g2 = createVtGrid(6, 30);
  for (let i = 0; i < 4; i += 1) g2.write(`row${i}\r\n`);
  g2.resize(30, 4);
  assert.equal(g2.rows, 4);
  assert.deepEqual(g2.visibleLines().slice(0, 2), ['row2', 'row3']);
  assert.equal(g2.lines().includes('row0'), false, 'dropped, not archived to scrollback');
  assert.equal(g2.lines().includes('row1'), false, 'the repaint re-delivers this content');
  g2.write('tail');
  assert.equal(g2.visibleLines()[2], 'tail', 'cursor tracked the shrink');

  // rows GROW: blank rows append at the bottom; the cursor keeps flowing
  const g3 = createVtGrid(4, 30);
  g3.write('top');
  g3.resize(30, 8);
  assert.equal(g3.rows, 8);
  g3.write('\r\n\r\n\r\n\r\n\r\nmore');
  assert.equal(g3.visibleLines()[0], 'top');
  assert.ok(g3.visibleLines().includes('more'));

  // cursor clamped when it would land outside the new box
  const g4 = createVtGrid(8, 40);
  g4.write('\x1b[8;35Hx'); // park the cursor near the bottom-right
  g4.resize(24, 4);
  g4.write('y'); // must not throw / write out of bounds
  assert.equal(g4.cols, 24);
  assert.equal(g4.rows, 4);
});

test('a tool line that scrolls off-screen between ticks is still detected via scrollback', () => {
  const g = createVtGrid(4, 30);
  g.write('● Write(early.txt)\r\n');     // tool rendered...
  for (let i = 0; i < 10; i += 1) g.write(`filler ${i}\r\n`); // ...then pushed far past the 4 visible rows
  assert.equal(g.visibleLines().some((l) => l.includes('early.txt')), false, 'no longer visible');
  assert.equal(g.lines().some((l) => l.includes('● Write(early.txt)')), true, 'recoverable from scrollback');
});
