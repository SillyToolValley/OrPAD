import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
  addWorktree,
  removeWorktree,
  resolveGitToplevel,
  worktreeChangedPaths,
} = require(path.join(repoRoot, 'src/main/orchestration-machine/git-isolation'));
const { collectWorktreePatch } = require(path.join(repoRoot, 'src/main/orchestration-machine/patches'));

async function makeRepo(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-wt-patch-'));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
  const git = (args) => execFileP('git', args, { cwd: root, windowsHide: true });
  await git(['init']);
  await git(['add', '-A']);
  await git([
    '-c', 'user.email=orpad@test.local',
    '-c', 'user.name=OrPAD Test',
    '-c', 'commit.gpgsign=false',
    'commit', '-m', 'init',
  ]);
  return root;
}

// The core correctness claim of the git-worktree backend: the patch is the
// worker's delta inside the worktree (git-attributed), so a file the user left
// dirty in the canonical workspace but that the worker never touched produces
// NO change and NO false out-of-write-set violation; a real worker edit outside
// the write set IS flagged.
test('collectWorktreePatch ignores dirty-but-untouched canonical files and flags real out-of-write-set edits', async () => {
  const canonical = await makeRepo({
    'a.txt': 'A1\n',
    'b.txt': 'B1\n',
    'src/keep.txt': 'KEEP\n',
  });
  const worktreeParent = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-worktree-'));
  const worktreeRoot = path.join(worktreeParent, 'wt');
  try {
    // Canonical has an uncommitted edit to b.txt — b.txt is NOT in the write set
    // and is NOT touched by the worker. It must not appear in the patch.
    await fs.writeFile(path.join(canonical, 'b.txt'), 'B2-DIRTY-IN-CANONICAL\n', 'utf8');

    const top = await resolveGitToplevel(canonical);
    const added = await addWorktree({ repoRoot: top, worktreePath: worktreeRoot, ref: 'HEAD' });
    assert.equal(added.ok, true, 'worktree created');

    // Worker edits a.txt (in write set) and creates d.txt (OUTSIDE write set).
    await fs.writeFile(path.join(worktreeRoot, 'a.txt'), 'A2-FROM-WORKER\n', 'utf8');
    await fs.writeFile(path.join(worktreeRoot, 'd.txt'), 'D-FROM-WORKER\n', 'utf8');

    const changed = await worktreeChangedPaths(worktreeRoot);
    assert.equal(changed.ok, true, 'change detection ok');
    assert.deepEqual(changed.paths, ['a.txt', 'd.txt'], 'only worker-touched paths (b.txt dirty in canonical is ignored)');

    const patch = await collectWorktreePatch({
      workspaceRoot: canonical,
      worktreeRoot,
      changedPaths: changed.paths,
      allowedFiles: ['a.txt'],
    });

    assert.deepEqual((patch.changes || []).map(c => c.path), ['a.txt'], 'only the write-set edit is a change');
    assert.equal(patch.changes[0].beforeContent, 'A1\n', 'baseline before is canonical content (HEAD here)');
    assert.equal(patch.changes[0].afterContent, 'A2-FROM-WORKER\n', 'after is the worker edit');
    assert.deepEqual((patch.violations || []).map(v => v.path), ['d.txt'], 'the out-of-write-set worker edit is flagged');
    // The dirty canonical b.txt is neither a change nor a violation.
    assert.ok(!(patch.changes || []).some(c => c.path === 'b.txt'), 'dirty canonical b.txt is not a change');
    assert.ok(!(patch.violations || []).some(v => v.path === 'b.txt'), 'dirty canonical b.txt is not a violation');
  } finally {
    await removeWorktree({ repoRoot: canonical, worktreePath: worktreeRoot }).catch(() => {});
    await fs.rm(worktreeParent, { recursive: true, force: true });
    await fs.rm(canonical, { recursive: true, force: true });
  }
});

test('collectWorktreePatch records a deletion when the worker removes a write-set file', async () => {
  const canonical = await makeRepo({ 'gone.txt': 'DELETE ME\n', 'stay.txt': 'STAY\n' });
  const worktreeParent = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-worktree-'));
  const worktreeRoot = path.join(worktreeParent, 'wt');
  try {
    const added = await addWorktree({ repoRoot: canonical, worktreePath: worktreeRoot, ref: 'HEAD' });
    assert.equal(added.ok, true, 'worktree created');

    await fs.rm(path.join(worktreeRoot, 'gone.txt'));

    const changed = await worktreeChangedPaths(worktreeRoot);
    assert.deepEqual(changed.paths, ['gone.txt'], 'deletion detected');

    const patch = await collectWorktreePatch({
      workspaceRoot: canonical,
      worktreeRoot,
      changedPaths: changed.paths,
      allowedFiles: ['gone.txt'],
    });
    assert.equal(patch.changes.length, 1);
    assert.equal(patch.changes[0].path, 'gone.txt');
    assert.equal(patch.changes[0].beforeExists, true, 'before existed in canonical');
    assert.equal(patch.changes[0].afterExists, false, 'after is deleted');
  } finally {
    await removeWorktree({ repoRoot: canonical, worktreePath: worktreeRoot }).catch(() => {});
    await fs.rm(worktreeParent, { recursive: true, force: true });
    await fs.rm(canonical, { recursive: true, force: true });
  }
});
