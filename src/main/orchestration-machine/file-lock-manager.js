const path = require('path');

// File-Lock Queue Phase 1 (per File-Lock-Queue-Design.md): pure
// in-memory lock manager. Workers declare `config.targetFiles` (a
// conservative upper bound on writes); the manager grants them
// exclusive write access to those files for the duration of the
// dispatch. A task with empty `targetFiles` is treated as "writes
// anywhere" and holds a global exclusive lock — safe default for
// un-annotated nodes. Two tasks whose declared file sets are
// disjoint can run concurrently; overlapping sets queue
// deterministically.
//
// Deadlock-free via ALL-OR-NOTHING acquire: a task gets every
// declared file at once, never a partial set. Combined with FIFO
// waiter scanning (every release re-scans the queue and grants
// any waiter whose full set is now free), this avoids the classic
// hold-and-wait cycle.
//
// Pure: no fs IO, no events.jsonl writes — that wiring lives in
// machine.js / worker-loop.js (Phase 1.C). The manager's state is
// in-memory only; on process crash + restart, the run resumes
// from events.jsonl and every in-flight node is considered failed
// and re-dispatched. No persisted lock state needed.

// Codex Phase 2 P2 #4 fix: normalize incoming path strings so
// 'src/a.js', 'src/./a.js', and 'src\\a.js' all lock as the same
// path. Without normalization, manually-authored graphs that mix
// separator styles or include `./` segments would lock different
// keys for the same logical file — silently breaking the
// serialization contract for routine concurrent writes.
function normalizeLockPath(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  // Convert backslashes to forward slashes, then collapse '.' / '..'
  // segments + duplicate separators.
  let normalized = path.posix.normalize(trimmed.replace(/\\/g, '/'));
  // Strip leading './'.
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (normalized === '.') return '';
  // Strip trailing slash (except if the whole path is '/').
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function pathsOverlap(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function createFileLockManager() {
  const heldByFile = new Map(); // filePath -> taskId
  const filesByTask = new Map(); // taskId -> Set<filePath>
  let globalLockHolder = null;
  const waiters = []; // { taskId, files, resolve, requestedAt }

  function normalizeFiles(files) {
    if (!Array.isArray(files)) return [];
    const out = [];
    const seen = new Set();
    for (const file of files) {
      const normalized = normalizeLockPath(file);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  }

  function isGrantable(taskId, files) {
    if (!Array.isArray(files) || files.length === 0) {
      // Empty declared set => wants the global exclusive lock.
      // Codex Fix1: re-entrant — if the SAME task already holds the
      // global lock OR any file lock, treat the upgrade-to-global as
      // immediately grantable. Otherwise an inner task that acquired
      // {A,B} and then tries to upgrade to global would queue
      // behind itself forever.
      if (globalLockHolder === taskId) return true;
      const heldOnlyBySelf = [...heldByFile.values()].every(holder => holder === taskId);
      if (heldOnlyBySelf && globalLockHolder === null) return true;
      return heldByFile.size === 0 && globalLockHolder === null;
    }
    // Specific file set => no global holder may block, and each
    // file must be free or self-held (re-entrant on the same task).
    // Prefix-overlap matches the fs-backed write-set store:
    // locking "src" conflicts with "src/a.js".
    if (globalLockHolder !== null && globalLockHolder !== taskId) return false;
    for (const file of files) {
      for (const [heldFile, holder] of heldByFile.entries()) {
        if (holder !== taskId && pathsOverlap(heldFile, file)) return false;
      }
    }
    return true;
  }

  function grantLock(taskId, files) {
    // Codex Fix1 follow-up: grant must ADD to the task's existing
    // holdings, not OVERWRITE. A self-upgrade from file holdings
    // {A,B} to the global lock must preserve {A,B} in filesByTask
    // so release frees them too. The previous overwrite caused a
    // leak — heldByFile entries stayed owned by the upgraded task
    // and release missed them, deadlocking subsequent waiters.
    const fileSet = filesByTask.get(taskId) || new Set();
    if (!Array.isArray(files) || files.length === 0) {
      globalLockHolder = taskId;
      fileSet.add('__global__');
    } else {
      for (const file of files) {
        heldByFile.set(file, taskId);
        fileSet.add(file);
      }
    }
    filesByTask.set(taskId, fileSet);
  }

  // acquire returns a Promise that resolves once the task holds all
  // its declared files. If the set is immediately grantable, the
  // promise resolves on the next microtask so the caller's
  // continuation runs after their own current frame (consistent
  // ordering for the dispatch path).
  function acquire(taskId, files = []) {
    if (typeof taskId !== 'string' || !taskId) {
      throw new Error('file-lock-manager.acquire: taskId must be a non-empty string');
    }
    // Codex P2 #4: normalize every incoming path so equivalent
    // declarations across authors / probes / canonicalizers all
    // resolve to the same lock key.
    const normalizedFiles = normalizeFiles(files);
    if (isGrantable(taskId, normalizedFiles)) {
      grantLock(taskId, normalizedFiles);
      return Promise.resolve({ taskId, granted: [...(filesByTask.get(taskId) || [])], waited: false });
    }
    return new Promise(resolve => {
      waiters.push({
        taskId,
        files: normalizedFiles,
        resolve,
        requestedAt: Date.now(),
      });
    });
  }

  function wouldWait(taskId, files = []) {
    if (typeof taskId !== 'string' || !taskId) {
      throw new Error('file-lock-manager.wouldWait: taskId must be a non-empty string');
    }
    return !isGrantable(taskId, normalizeFiles(files));
  }

  // release frees every lock held by taskId, then scans waiters in
  // FIFO order and grants any whose full set is now available. The
  // scan keeps going after each grant — releasing two files can
  // unblock multiple waiters in a single release call.
  function release(taskId) {
    if (typeof taskId !== 'string' || !taskId) {
      throw new Error('file-lock-manager.release: taskId must be a non-empty string');
    }
    const ownedFiles = filesByTask.get(taskId);
    if (!ownedFiles) return { released: [] };
    const releasedPaths = [];
    if (globalLockHolder === taskId) {
      globalLockHolder = null;
      releasedPaths.push('__global__');
    }
    for (const file of ownedFiles) {
      if (file === '__global__') continue;
      if (heldByFile.get(file) === taskId) {
        heldByFile.delete(file);
        releasedPaths.push(file);
      }
    }
    filesByTask.delete(taskId);
    drainWaiters();
    return { released: releasedPaths };
  }

  function drainWaiters() {
    let index = 0;
    while (index < waiters.length) {
      const waiter = waiters[index];
      if (isGrantable(waiter.taskId, waiter.files)) {
        grantLock(waiter.taskId, waiter.files);
        waiters.splice(index, 1);
        try {
          waiter.resolve({
            taskId: waiter.taskId,
            granted: [...(filesByTask.get(waiter.taskId) || [])],
            waited: true,
            waitedMs: Date.now() - waiter.requestedAt,
          });
        } catch {
          // Resolver throwing must not stop other waiters from being
          // granted. Worker-loop's await of the acquire promise
          // catches its own errors; the manager's state is already
          // committed via grantLock.
        }
        // Don't advance index — the next waiter is now at this slot.
      } else {
        index += 1;
      }
    }
  }

  function snapshot() {
    return {
      heldByFile: new Map(heldByFile),
      filesByTask: new Map([...filesByTask.entries()].map(([k, v]) => [k, new Set(v)])),
      globalLockHolder,
      waitersCount: waiters.length,
      waiters: waiters.map(w => ({ taskId: w.taskId, files: [...w.files], requestedAt: w.requestedAt })),
    };
  }

  return { acquire, release, snapshot, wouldWait };
}

module.exports = { createFileLockManager, normalizeLockPath };
