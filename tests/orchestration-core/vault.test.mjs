import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = require(path.join(repoRoot, 'src/main/orchestration-core/core.cjs'));
const vault = require(path.join(repoRoot, 'src/main/orchestration-core/vault.cjs'));
const { collectOverlayPatch } = require(path.join(repoRoot, 'src/main/orchestration-machine/patches.js'));

const VAULT_REL = vault.VAULT_REL; // '.orpad/knowledge'

function mkWs(prefix = 'orpad-vault-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function vaultDir(ws) { return path.join(ws, '.orpad', 'knowledge'); }
function note(fm, body = 'body') {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`);
  return `---\n${lines.join('\n')}\n---\n${body}\n`;
}
function writeNote(dir, name, fm, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), note(fm, body), 'utf8');
}

// --- Defensive cold-start contract (the vault must never block a run) ---------------------------------
test('loadVaultIndex is a no-op {notes:[]} on missing / empty / malformed', () => {
  const ws = mkWs();
  try {
    assert.deepEqual(core.loadVaultIndex(ws), { notes: [] }, 'missing vault -> no notes');

    fs.mkdirSync(vaultDir(ws), { recursive: true });
    fs.writeFileSync(path.join(vaultDir(ws), 'index.json'), '', 'utf8');
    assert.deepEqual(core.loadVaultIndex(ws), { notes: [] }, 'empty index -> no notes');

    fs.writeFileSync(path.join(vaultDir(ws), 'index.json'), '{not json', 'utf8');
    assert.deepEqual(core.loadVaultIndex(ws), { notes: [] }, 'malformed index -> no notes');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('composeVaultBrief is "" on an empty index, and renders active notes otherwise', () => {
  assert.equal(core.composeVaultBrief({ notes: [] }), '');
  assert.equal(core.composeVaultBrief(null), '');
  const brief = core.composeVaultBrief({ notes: [{ id: 'n1', title: 'Use Picovoice', summary: 'wake word', tags: ['wake-word'], file: 'n1.md' }] });
  assert.match(brief, /n1/);
  assert.match(brief, /Use Picovoice/);
  assert.match(brief, /wake-word/);
  assert.match(brief, /\.orpad\/knowledge\/n1\.md/);
});

test('loadVaultIndex filters out status !== active', () => {
  const ws = mkWs();
  try {
    fs.mkdirSync(vaultDir(ws), { recursive: true });
    fs.writeFileSync(path.join(vaultDir(ws), 'index.json'), JSON.stringify({
      notes: [
        { id: 'live', status: 'active' },
        { id: 'dead', status: 'superseded' },
        { id: 'gone', status: 'retired' },
        { id: 'default-active' }, // no status -> treated active
      ],
    }), 'utf8');
    const ids = core.loadVaultIndex(ws).notes.map(n => n.id).sort();
    assert.deepEqual(ids, ['default-active', 'live']);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('parseFrontmatter reads scalars, arrays, null; ignores nested/blank/comment lines', () => {
  const fm = vault.parseFrontmatter([
    '---',
    'id: alpha',
    'title: "Quoted Title"',
    'tags: [a, b, c]',
    'supersedes: null',
    '# a comment',
    '',
    'nested:',
    '  key: ignored',
    '---',
    'body',
  ].join('\n'));
  assert.equal(fm.id, 'alpha');
  assert.equal(fm.title, 'Quoted Title');
  assert.deepEqual(fm.tags, ['a', 'b', 'c']);
  assert.equal(fm.supersedes, null);
  assert.equal('key' in fm, false, 'nested key not surfaced');
});

// --- Write-set capture (the safety property the whole write-back relies on) ----------------------------
test('a brand-new note under the vault directory write-set is a change, not a violation', async () => {
  const ws = mkWs();
  const overlay = mkWs('orpad-vault-ov-');
  try {
    writeNote(path.join(overlay, '.orpad', 'knowledge'), 'fresh.md', { id: 'fresh', status: 'active' });
    const patch = await collectOverlayPatch({ workspaceRoot: ws, overlayRoot: overlay, allowedFiles: [VAULT_REL] });
    const changed = patch.changes.map(c => c.path);
    assert.ok(changed.includes('.orpad/knowledge/fresh.md'), 'new note captured as a change');
    assert.equal(patch.violations.length, 0, 'no out-of-write-set violation');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(overlay, { recursive: true, force: true });
  }
});

// --- Deterministic, reproducible index rebuild --------------------------------------------------------
test('rebuildVaultIndex is deterministic (byte-wise sort, reproducible across rebuilds)', () => {
  const ws = mkWs();
  try {
    const dir = vaultDir(ws);
    // 'Zebra' (Z=0x5A) sorts BEFORE 'apple' (a=0x61) byte-wise — the opposite of locale-aware sort.
    writeNote(dir, 'apple.md', { id: 'apple', title: 'Apple', status: 'active' });
    writeNote(dir, 'Zebra.md', { id: 'Zebra', title: 'Zebra', status: 'active' });

    assert.equal(core.rebuildVaultIndex(ws), true);
    const first = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
    const doc = JSON.parse(first);
    assert.deepEqual(doc.notes.map(n => n.id), ['Zebra', 'apple'], 'byte-wise order, not localeCompare');

    assert.equal(core.rebuildVaultIndex(ws), true);
    const second = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
    assert.equal(first, second, 'rebuild is reproducible byte-for-byte');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// --- Promotion round-trip: create / update / delete / supersede through the transactional moat ---------
async function promoteFromOverlay(ws, overlay, runId) {
  const patch = await collectOverlayPatch({ workspaceRoot: ws, overlayRoot: overlay, allowedFiles: [VAULT_REL] });
  return core.promoteVaultPatch({ workspaceRoot: ws, patch, runId });
}

test('promoteVaultPatch creates a note in the workspace and builds the index', async () => {
  const ws = mkWs();
  const overlay = mkWs('orpad-vault-ov-');
  try {
    writeNote(path.join(overlay, '.orpad', 'knowledge'), 'tool-x.md', { id: 'tool-x', title: 'Reuse lib X', summary: 'why X', tags: ['parsing'], status: 'active' });
    const res = await promoteFromOverlay(ws, overlay, 'run-create');
    assert.deepEqual(res.written, ['.orpad/knowledge/tool-x.md']);
    assert.equal(res.indexed, true);
    assert.ok(fs.existsSync(path.join(vaultDir(ws), 'tool-x.md')), 'note landed in canonical vault');
    const idx = core.loadVaultIndex(ws);
    assert.deepEqual(idx.notes.map(n => n.id), ['tool-x']);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(overlay, { recursive: true, force: true });
  }
});

test('promoteVaultPatch deletes a note when the overlay removed it (proves applyPatchArtifact path)', async () => {
  const ws = mkWs();
  const overlay = mkWs('orpad-vault-ov-');
  try {
    // Canonical vault already has a note; overlay (seeded then note removed) does NOT contain it.
    writeNote(vaultDir(ws), 'old.md', { id: 'old', status: 'active' });
    fs.mkdirSync(path.join(overlay, '.orpad', 'knowledge'), { recursive: true }); // empty vault in overlay
    const res = await promoteFromOverlay(ws, overlay, 'run-delete');
    assert.ok(!fs.existsSync(path.join(vaultDir(ws), 'old.md')), 'note deleted from canonical vault');
    assert.ok(res.written.includes('.orpad/knowledge/old.md'), 'deletion reported as written/applied');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(overlay, { recursive: true, force: true });
  }
});

test('supersede-in-place flips the old note status and excludes it from the next brief', async () => {
  const ws = mkWs();
  const overlay = mkWs('orpad-vault-ov-');
  try {
    // Seed an existing active note in the canonical vault.
    writeNote(vaultDir(ws), 'v1.md', { id: 'v1', title: 'Old approach', summary: 'old', status: 'active' });
    core.rebuildVaultIndex(ws);
    assert.equal(core.loadVaultIndex(ws).notes.length, 1);

    // Overlay seeds the vault (v1 present) and adds a correcting note that supersedes v1.
    writeNote(path.join(overlay, '.orpad', 'knowledge'), 'v1.md', { id: 'v1', title: 'Old approach', summary: 'old', status: 'active' });
    writeNote(path.join(overlay, '.orpad', 'knowledge'), 'v2.md', { id: 'v2', title: 'New approach', summary: 'new', status: 'active', supersedes: 'v1' });

    await promoteFromOverlay(ws, overlay, 'run-supersede');

    const active = core.loadVaultIndex(ws).notes;
    assert.deepEqual(active.map(n => n.id).sort(), ['v2'], 'only the superseding note is active');
    const v1fm = vault.parseFrontmatter(fs.readFileSync(path.join(vaultDir(ws), 'v1.md'), 'utf8'));
    assert.equal(v1fm.status, 'superseded');
    assert.equal(v1fm.supersededBy, 'v2');
    assert.ok(!core.composeVaultBrief(core.loadVaultIndex(ws)).includes('v1'), 'superseded note not in brief');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(overlay, { recursive: true, force: true });
  }
});

test('promoteVaultPatch is a no-op for a patch with no vault-scoped changes', async () => {
  const ws = mkWs();
  try {
    const res = await core.promoteVaultPatch({ workspaceRoot: ws, patch: { changes: [], violations: [] }, runId: 'run-empty' });
    assert.deepEqual(res, { written: [], skipped: [], indexed: false });
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// --- Regression guards for the gated-path + supersede fixes from the implementation review ------------
test('setFrontmatterFields inserts a $-containing value literally (no replace-pattern interpretation)', () => {
  const text = '---\nid: old\nstatus: active\nsupersededBy: null\n---\nbody\n';
  const out = vault.setFrontmatterFields(text, { status: 'superseded', supersededBy: 'new$1$&id' });
  const fm = vault.parseFrontmatter(out);
  assert.equal(fm.status, 'superseded');
  assert.equal(fm.supersededBy, 'new$1$&id', '$ in the value is preserved verbatim');
});

test('runVerifiedBuildLoop does NOT retry a stopped grounded/vault wrapper (stop-guard unwrap)', async () => {
  let calls = 0;
  // Grounded/vault runner returns a wrapper whose stop flag is nested at build.build.stopped.
  const buildFn = async () => { calls += 1; return { build: { stopped: true, stopReason: 'time-cap' }, summary: {} }; };
  const verifyFn = () => ({ passed: false, results: [{ id: 'g', passed: false, detail: 'x' }] });
  const loop = await core.runVerifiedBuildLoop({ buildFn, verifyFn, maxCycles: 3 });
  assert.equal(calls, 1, 'a stopped wrapper is not retried');
  assert.equal(loop.cycles, 0);
});

test('runVerifiedBuildLoop retries a non-stopped failing build up to maxCycles', async () => {
  let calls = 0;
  const buildFn = async () => { calls += 1; return { build: { stopped: false }, summary: {} }; };
  const verifyFn = () => ({ passed: false, results: [{ id: 'g', passed: false, detail: 'x' }] });
  const loop = await core.runVerifiedBuildLoop({ buildFn, verifyFn, maxCycles: 2 });
  assert.equal(calls, 3, '1 initial attempt + 2 retries');
  assert.equal(loop.cycles, 2);
});
