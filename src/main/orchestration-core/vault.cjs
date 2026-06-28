'use strict';
// OrPAD knowledge vault — durable, workspace-contained domain knowledge that COMPOUNDS across runs.
// See "OrPAD Development Docs/OrPAD-Knowledge-Vault-Spec.md".
//
// The vault is fixed at <workspaceRoot>/.orpad/knowledge (a sibling of .orpad/core-runs — never nested,
// so a run overlay can never self-copy the vault). It is READ to ground each build and WRITTEN back from
// each verified run. This module is the pure store layer: load/render the index for retrieval, and the
// single serialized promotion step (persist notes through the TRANSACTIONAL moat + supersede-in-place +
// deterministic index rebuild). The runner that orchestrates read -> research -> build lives in core.cjs.
//
// Design rails earned from adversarial review:
//  - Write-back goes through applyPatchArtifact (deletions, per-segment symlink checks, base-SHA), NEVER
//    the copy-only applyOverlayToWorkspace.
//  - Promotion is serialized behind an in-memory per-vault lock (concurrent runs in one process).
//  - The index is rebuilt with a locale-INDEPENDENT byte-wise sort and written atomically (temp+rename,
//    EPERM retry for Windows) so rebuilds are reproducible.
//  - Every read is defensive: a missing/empty/malformed vault returns "no notes" and never throws, so a
//    vault miss degrades to web grounding and never blocks a cold start.

const fs = require('fs');
const path = require('path');

const { applyPatchArtifact } = require('../orchestration-machine/patches');
const { createFileLockManager } = require('../orchestration-machine/file-lock-manager');

// Workspace-relative root of the vault (also the directory write-set entry for every vault write-back).
const VAULT_REL = '.orpad/knowledge';

function nowIso() { return new Date().toISOString(); }
function vaultRootFor(workspaceRoot) { return path.join(path.resolve(workspaceRoot), '.orpad', 'knowledge'); }

// Locale-INDEPENDENT ordering for reproducible index rebuilds (String.prototype.localeCompare is
// ICU/locale-dependent and case-folding — it would order the index differently across machines).
function byteCompare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// --- Minimal frontmatter parse/edit (controlled schema; no YAML dependency) ----------------------------
// Parses only TOP-LEVEL `key: value`, `key: [a, b]`, and `key: null` lines between --- fences. Nested
// blocks, comments, and blank lines are ignored. This covers the note schema; arbitrary nested YAML the
// agent might emit is simply not surfaced (safe — those keys are not part of the index contract).
function unquote(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}
function parseFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(String(text || ''));
  if (!m) return null;
  const out = {};
  for (const rawLine of m[1].split(/\r?\n/)) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine) || /^\s/.test(rawLine)) continue; // blank / comment / nested
    const mm = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(rawLine);
    if (!mm) continue;
    const key = mm[1];
    const val = mm[2].trim();
    if (val === '') { out[key] = ''; }
    else if (/^\[.*\]$/.test(val)) { out[key] = val.slice(1, -1).split(',').map(s => unquote(s.trim())).filter(s => s.length); }
    else if (/^(null|~)$/i.test(val)) { out[key] = null; }
    else { out[key] = unquote(val); }
  }
  return out;
}
// Rewrite/insert top-level frontmatter keys in place, preserving the body. Returns the new file text.
function setFrontmatterFields(text, fields) {
  const m = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---)/.exec(String(text || ''));
  if (!m) return text;
  const nl = m[2].includes('\r\n') ? '\r\n' : '\n';
  let fm = m[2];
  for (const [k, v] of Object.entries(fields)) {
    const val = v === null ? 'null' : String(v);
    const re = new RegExp(`^${k}\\s*:.*$`, 'm');
    // Function replacer so a value containing `$` (e.g. an agent-authored id) is inserted LITERALLY and
    // never interpreted as a String.replace `$&`/`$1`/`$$` pattern.
    if (re.test(fm)) fm = fm.replace(re, () => `${k}: ${val}`);
    else fm = `${fm}${nl}${k}: ${val}`;
  }
  return text.slice(0, m.index) + m[1] + fm + m[3] + text.slice(m.index + m[0].length);
}

// --- Retrieval (P1) ------------------------------------------------------------------------------------
// Load + parse the vault index; defensive (mirror loadGuidanceCatalog): any failure -> {notes:[]}.
// Filters to status==='active' so superseded/retired notes never reach retrieval.
function loadVaultIndex(workspaceRoot) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(vaultRootFor(workspaceRoot), 'index.json'), 'utf8'));
    const list = Array.isArray(doc) ? doc : (Array.isArray(doc.notes) ? doc.notes : []);
    const notes = list
      .filter(n => n && typeof n === 'object')
      .filter(n => (n.status || 'active') === 'active');
    return { notes };
  } catch (_) {
    return { notes: [] };
  }
}

// Render active notes into a compact INDEX brief block; '' (no-op) when empty. The agent Reads the full
// note files it judges relevant — the index is the retrieval surface, not the whole corpus.
function composeVaultBrief(index) {
  const notes = index && Array.isArray(index.notes) ? index.notes : [];
  if (!notes.length) return '';
  const lines = notes.map((n) => {
    const id = n.id || 'note';
    const file = n.file || `${id}.md`;
    const tags = Array.isArray(n.tags) && n.tags.length ? ` [${n.tags.join(', ')}]` : '';
    const summary = String(n.summary || n.title || '').trim();
    return `- (${id}) ${String(n.title || '').trim()}${tags}: ${summary} — read ${VAULT_REL}/${file}`;
  });
  return [
    'Project knowledge vault — durable notes earned from prior runs. READ the full note files you judge',
    'relevant before building, and REUSE the recorded tools/decisions/techniques instead of reinventing:',
    ...lines,
  ].join('\n');
}

// Compose the vault gap-research goal: read existing notes, research ONLY the gaps + prior-art + OSS,
// then WRITE new/updated notes back under the vault. This step both grounds the build and grows the vault.
function composeVaultResearchGoal(buildGoal, opts = {}) {
  const vaultRel = opts.vaultRel || VAULT_REL;
  const vaultBrief = String(opts.vaultBrief || '').trim();
  const earnedFrom = String(opts.earnedFrom || '').trim();
  return [
    'You are doing PRODUCT-PLANNING RESEARCH and KNOWLEDGE CAPTURE. Do NOT build the product or write its',
    `code. Investigate, then record durable knowledge as markdown notes under ${vaultRel}/.`,
    '',
    vaultBrief || `The knowledge vault ${vaultRel}/ is currently empty.`,
    '',
    'For the task below:',
    '1. READ the existing vault notes you judge relevant (do not re-derive what is already recorded).',
    '2. Research ONLY what is MISSING or STALE: prior art (real products, open-source tools, libraries and',
    '   papers — names, links, how each works), the must-have requirements, where existing solutions fall',
    '   short for THIS task and how to overcome it, and whether to REUSE/ADAPT a proven library/tool',
    '   (which one, why, over what alternatives) versus build new. Prefer reuse; cite sources.',
    `3. WRITE your findings as one or more notes ${vaultRel}/<id>.md. Each note MUST start with YAML`,
    '   frontmatter and these keys: id, title, summary (one line), tags (task-class keywords used for',
    '   retrieval — not surface words), status: active, supersedes (id of a note you are correcting, or',
    `   null), earnedFrom: "${earnedFrom || 'this run'}". Capture CONCRETE, REUSABLE artifacts — a`,
    '   technique + a snippet + the failure it fixes + when it applies; for a tool/library decision record',
    '   capability -> chosen library, alternatives considered, why, and install/gotchas. To correct an',
    '   existing note, write a NEW note whose frontmatter sets supersedes:<oldId>.',
    'Keep notes specific and actionable — they are handed to the builder as grounding and reused by future runs.',
    '',
    '--- Task to ground ---',
    buildGoal,
  ].join('\n');
}

// Read the notes a research delegation just produced (from its collected patch) into a compact brief that
// grounds the build. Text content is taken from the patch's afterContent; total injected text is capped.
function readVaultNotesFromPatch(patch, opts = {}) {
  const cap = Number.isFinite(opts.cap) ? opts.cap : 16000;
  const changes = patch && Array.isArray(patch.changes) ? patch.changes : [];
  const parts = [];
  let budget = cap;
  for (const c of changes) {
    if (!c || typeof c.path !== 'string' || !/\.md$/i.test(c.path) || c.afterExists === false) continue;
    let text = typeof c.afterContent === 'string' ? c.afterContent : '';
    if (!text && typeof c.afterContentBase64 === 'string') {
      try { text = Buffer.from(c.afterContentBase64, 'base64').toString('utf8'); } catch (_) { text = ''; }
    }
    if (!text.trim()) continue;
    const slice = text.slice(0, Math.max(0, budget));
    budget -= slice.length;
    parts.push(`## ${c.path}\n${slice}`);
    if (budget <= 0) break;
  }
  return parts.length ? ['Fresh research captured this run (now also saved to the vault):', ...parts].join('\n\n') : '';
}

// --- Write-back (P2) -----------------------------------------------------------------------------------
// Single in-process lock serializing every vault mutation (concurrent run-start handlers in one OrPAD
// process). Module-scoped so all requires share one instance.
const _vaultLock = createFileLockManager();

// Atomic-ish index write: temp + rename, with retry on Windows EPERM/EBUSY (AV/indexer rename races); a
// last-resort direct overwrite keeps the index current even if rename never wins. Best-effort -> bool.
function writeIndexAtomic(root, doc) {
  const dest = path.join(root, 'index.json');
  const tmp = path.join(root, `.index.json.tmp-${process.pid}`);
  const data = `${JSON.stringify(doc, null, 2)}\n`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.writeFileSync(tmp, data, 'utf8');
      try {
        fs.renameSync(tmp, dest);
      } catch (e) {
        if (e && ['EPERM', 'EBUSY', 'EACCES'].includes(e.code) && attempt < 3) {
          try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
          continue; // retry the whole write
        }
        fs.writeFileSync(dest, data, 'utf8'); // last resort: non-atomic overwrite
        try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
      }
      return true;
    } catch (_) { /* retry */ }
  }
  return false;
}

// Deterministically rebuild .orpad/knowledge/index.json from note frontmatter. Locale-independent
// byte-wise note ordering; atomic write. Best-effort -> bool (a stale index never crashes a run).
function rebuildVaultIndex(workspaceRoot) {
  const root = vaultRootFor(workspaceRoot);
  let files;
  try {
    files = fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isFile() && /\.md$/i.test(d.name))
      .map(d => d.name)
      .sort(byteCompare);
  } catch (_) {
    return false; // no vault dir yet
  }
  const notes = [];
  for (const name of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(root, name), 'utf8'); } catch (_) { continue; }
    const fm = parseFrontmatter(text);
    if (!fm) continue;
    const tags = Array.isArray(fm.tags)
      ? fm.tags
      : (typeof fm.tags === 'string' ? fm.tags.split(',').map(s => s.trim()).filter(Boolean) : []);
    notes.push({
      id: fm.id || name.replace(/\.md$/i, ''),
      file: name,
      title: fm.title || '',
      summary: fm.summary || '',
      tags,
      status: fm.status || 'active',
      supersededBy: fm.supersededBy || null,
      supersedes: fm.supersedes || null,
      earnedFrom: fm.earnedFrom || '',
      promotedAt: fm.promotedAt || '',
      lastValidatedRunId: fm.lastValidatedRunId || null,
    });
  }
  notes.sort((a, b) => byteCompare(a.id, b.id));
  return writeIndexAtomic(root, { version: 1, notes });
}

// Supersede-in-place: for every freshly-written note carrying `supersedes: <oldId>`, flip the OLD note's
// status to 'superseded' (+ supersededBy) in the same promotion. Corrections REPLACE, never accrete.
function applySupersedes(workspaceRoot, writtenRelPaths) {
  const root = vaultRootFor(workspaceRoot);
  let dirFiles = [];
  try { dirFiles = fs.readdirSync(root).filter(f => /\.md$/i.test(f)); } catch (_) { return; }
  for (const rel of writtenRelPaths) {
    const name = String(rel).split('/').pop();
    let text = '';
    try { text = fs.readFileSync(path.join(root, name), 'utf8'); } catch (_) { continue; }
    const fm = parseFrontmatter(text);
    if (!fm || !fm.supersedes) continue;
    const newId = fm.id || name.replace(/\.md$/i, '');
    const oldId = fm.supersedes;
    for (const f of dirFiles) {
      if (f === name) continue;
      let otext = '';
      try { otext = fs.readFileSync(path.join(root, f), 'utf8'); } catch (_) { continue; }
      const ofm = parseFrontmatter(otext);
      if (!ofm) continue;
      const id = ofm.id || f.replace(/\.md$/i, '');
      if (id !== oldId) continue;
      try { fs.writeFileSync(path.join(root, f), setFrontmatterFields(otext, { status: 'superseded', supersededBy: newId }), 'utf8'); } catch (_) { /* best effort */ }
      break;
    }
  }
}

// Persist a vault write-set patch (the notes a run produced) into the canonical vault, then apply
// supersedes and rebuild the index — ALL under one per-vault lock. Routes through applyPatchArtifact (the
// transactional moat: deletions via fs.rm, per-segment symlink checks, base-SHA conflict detection), NOT
// applyOverlayToWorkspace. Returns { written:string[], skipped:[{path,reason}], indexed:boolean }.
async function promoteVaultPatch({ workspaceRoot, patch, runId, now = nowIso() }) {
  const written = [];
  const skipped = [];
  let indexed = false;
  const allChanges = patch && Array.isArray(patch.changes) ? patch.changes : [];
  const inVault = (p) => p === VAULT_REL || p.startsWith(`${VAULT_REL}/`);
  const changes = allChanges.filter(c => c && typeof c.path === 'string' && inVault(c.path));
  // Surface (rather than silently drop) a vault-ish path whose casing doesn't match VAULT_REL exactly —
  // on a case-insensitive FS such a note would otherwise vanish with no trace. Fail closed (not applied).
  for (const c of allChanges) {
    if (c && typeof c.path === 'string' && !inVault(c.path)
      && c.path.toLowerCase().startsWith(`${VAULT_REL.toLowerCase()}/`)) {
      skipped.push({ path: c.path, reason: 'vault-path-casing-mismatch (expected .orpad/knowledge/)' });
    }
  }
  if (!changes.length) return { written, skipped, indexed };

  const lockId = `vault-${runId || 'run'}-${process.pid}`;
  await _vaultLock.acquire(lockId, [VAULT_REL]);
  try {
    const vaultPatch = {
      schemaVersion: 'orpad.patchArtifact.v1',
      createdAt: (patch && patch.createdAt) || now,
      allowedFiles: [VAULT_REL],
      changes,
      violations: [],
    };
    try {
      const res = await applyPatchArtifact({
        workspaceRoot, patch: vaultPatch, allowedFiles: [VAULT_REL], now,
        treatAlreadyAppliedAsSuccess: true,
      });
      for (const a of res.applied || []) written.push(a.path);
    } catch (e) {
      // base-SHA mismatch / symlink-unsafe / path-escape: fail SAFE (skip), surface the reason.
      skipped.push({ path: (e && e.path) || VAULT_REL, reason: (e && e.code) || String((e && e.message) || e) });
    }
    if (written.length) applySupersedes(workspaceRoot, written);
    indexed = rebuildVaultIndex(workspaceRoot);
  } finally {
    _vaultLock.release(lockId);
  }
  return { written: written.sort(byteCompare), skipped, indexed };
}

module.exports = {
  VAULT_REL,
  vaultRootFor,
  byteCompare,
  parseFrontmatter,
  setFrontmatterFields,
  loadVaultIndex,
  composeVaultBrief,
  composeVaultResearchGoal,
  readVaultNotesFromPatch,
  rebuildVaultIndex,
  applySupersedes,
  promoteVaultPatch,
  // exposed for tests
  _vaultLock,
};
