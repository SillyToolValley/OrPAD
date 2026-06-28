import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ipc = require(path.join(repoRoot, 'src/main/orchestration-core/ipc.cjs'));
const { collectOverlayPatch } = require(path.join(repoRoot, 'src/main/orchestration-machine/patches.js'));

function mk(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function write(root, rel, body = 'x') {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, 'utf8');
}

// The contract ipc.cjs depends on: a dist/ artifact is tagged 'overlay-generated-build-output' (delivered),
// while tool-cache / coverage stay as their own reasons (filtered, NOT delivered).
test('collectOverlayPatch classifies build outputs vs caches/validation distinctly', async () => {
  const ws = mk('orpad-bo-ws-');
  const overlay = mk('orpad-bo-ov-');
  try {
    write(overlay, 'dist/app.exe', 'MZ');
    write(overlay, 'release/setup.exe', 'MZ');
    write(overlay, 'build/icon.png', 'PNG');           // electron-builder CONFIG, NOT output — must NOT deliver
    write(overlay, '__pycache__/m.cpython-312.pyc', 'cache');
    write(overlay, 'coverage/index.html', 'cov');
    const patch = await collectOverlayPatch({ workspaceRoot: ws, overlayRoot: overlay, allowedFiles: [] });

    const reasonOf = (p) => (patch.ignoredGeneratedFiles.find((f) => f.path === p) || {}).reason;
    assert.equal(reasonOf('dist/app.exe'), 'overlay-generated-build-output');
    assert.equal(reasonOf('release/setup.exe'), 'overlay-generated-build-output');
    assert.equal(reasonOf('build/icon.png'), 'overlay-generated-build-dir', 'build/ is ambiguous — its own reason, not output');
    assert.equal(reasonOf('__pycache__/m.cpython-312.pyc'), 'overlay-generated-tool-cache');
    assert.equal(reasonOf('coverage/index.html'), 'overlay-generated-validation-artifact');
    assert.equal(patch.changes.length, 0, 'none applied as normal changes');

    // The exact filter ipc uses to pick what to deliver — build/ is excluded (ambiguous config vs output).
    const delivered = patch.ignoredGeneratedFiles
      .filter((f) => f.reason === 'overlay-generated-build-output').map((f) => f.path).sort();
    assert.deepEqual(delivered, ['dist/app.exe', 'release/setup.exe']);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(overlay, { recursive: true, force: true });
  }
});

test('copyOverlayPathsToDir copies into the dest dir and rejects path-escape', async () => {
  const overlay = mk('orpad-bo-ov-');
  const dest = mk('orpad-bo-dest-');
  try {
    write(overlay, 'dist/app.exe', 'BIN');
    const copied = await ipc.copyOverlayPathsToDir(overlay, dest, ['dist/app.exe', '../escape.txt', '/abs.txt']);
    assert.deepEqual(copied, ['dist/app.exe'], 'only the contained path is copied');
    assert.equal(fs.readFileSync(path.join(dest, 'dist', 'app.exe'), 'utf8'), 'BIN');
    assert.ok(!fs.existsSync(path.join(path.dirname(dest), 'escape.txt')), 'no .. escape');
  } finally {
    fs.rmSync(overlay, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('copyOverlayPathsToDir refuses to write THROUGH a destination symlink (no escape)', async (t) => {
  const overlay = mk('orpad-bo-ov-');
  const dest = mk('orpad-bo-dest-');
  const outside = mk('orpad-bo-out-');
  try {
    write(overlay, 'dist/app.exe', 'BIN');
    // Make <dest>/dist a symlink/junction to an outside dir. Skip where the env forbids symlinks.
    try {
      fs.symlinkSync(outside, path.join(dest, 'dist'), 'junction');
    } catch (e) {
      t.skip(`cannot create symlink/junction here: ${e.code || e.message}`);
      return;
    }
    const copied = await ipc.copyOverlayPathsToDir(overlay, dest, ['dist/app.exe']);
    assert.deepEqual(copied, [], 'nothing copied through the symlink');
    assert.ok(!fs.existsSync(path.join(outside, 'app.exe')), 'no escape: file not written outside the dest root');
  } finally {
    fs.rmSync(overlay, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
