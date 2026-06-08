import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditNodeSchemas } from './audit-orpad-node-schemas.mjs';
// Static (not createRequire) import so esbuild can inline this dependency when the
// script is bundled for packaging. work-items is CommonJS, so default-import the
// module object and destructure. Behaviour is identical when run standalone.
import workItems from '../src/main/runbooks/work-items.js';

const { auditWorkQueue } = workItems;

const RUN_METADATA_SCHEMA = 'orpad.runEvidence.v1';
const DISCOVERY_COVERAGE_SCHEMA = 'orpad.discoveryCoverage.v1';
const CANDIDATE_INVENTORY_SCHEMA = 'orpad.candidateInventory.v1';
const STATUS_MARKER_RE = /## Status: (done|partial|blocked)\s*$/;
const LIVE_EVIDENCE_TYPES = new Set(['app-or-dom', 'viewport-or-state']);
const CANDIDATE_INVENTORY_STATUSES = new Set(['candidate', 'deferred', 'deduped-into', 'empty-pass']);
const OBSERVATION_KINDS = new Set([
  'playwright',
  'manual-dom',
  'screenshot',
  'renderer-state',
  'app-run',
  'browser',
  'source-read',
  'test-run',
  'command',
]);

function usage() {
  return 'Usage: node scripts/audit-orpad-run.mjs <pipeline.or-pipeline>';
}

function diagnostic(code, message, details = {}) {
  return { code, message, ...details };
}

function normalizeRef(baseDir, ref) {
  return path.resolve(baseDir, String(ref || '').replace(/\\/g, path.sep));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const source = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(source);
}

async function fileDigest(filePath) {
  const bytes = await fs.readFile(filePath);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}

function evidenceManifestPath(pipelineDir, filePath) {
  return path.relative(pipelineDir, filePath).replace(/\\/g, '/');
}

async function collectFilesUnder(dirPath, predicate, results = []) {
  let entries = [];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) await collectFilesUnder(entryPath, predicate, results);
    else if (entry.isFile() && predicate(entryPath)) results.push(entryPath);
  }
  return results;
}

function tryGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function gitStatusDigest(statusText) {
  return createHash('sha256').update(statusText.replace(/\r\n/g, '\n')).digest('hex');
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function timestampMs(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function auditRunMetadata(metadata, metadataPath, summaryStatus) {
  const diagnostics = [];
  for (const field of ['pipelineId', 'runId', 'startedAt', 'endedAt', 'status', 'headSha', 'workspaceStatusDigest']) {
    if (isBlank(metadata?.[field])) {
      diagnostics.push(diagnostic('RUN_METADATA_FIELD_MISSING', `Run metadata must include ${field}.`, {
        field,
        path: metadataPath,
      }));
    }
  }

  const startedAt = timestampMs(metadata?.startedAt);
  const endedAt = timestampMs(metadata?.endedAt);
  if (!isBlank(metadata?.startedAt) && startedAt === null) {
    diagnostics.push(diagnostic('RUN_METADATA_TIMESTAMP_INVALID', 'Run metadata startedAt must be a valid timestamp.', {
      field: 'startedAt',
      value: metadata.startedAt,
      path: metadataPath,
    }));
  }
  if (!isBlank(metadata?.endedAt) && endedAt === null) {
    diagnostics.push(diagnostic('RUN_METADATA_TIMESTAMP_INVALID', 'Run metadata endedAt must be a valid timestamp.', {
      field: 'endedAt',
      value: metadata.endedAt,
      path: metadataPath,
    }));
  }
  if (startedAt !== null && endedAt !== null && endedAt < startedAt) {
    diagnostics.push(diagnostic('RUN_METADATA_TIME_ORDER_INVALID', 'Run metadata endedAt must not be earlier than startedAt.', {
      startedAt: metadata.startedAt,
      endedAt: metadata.endedAt,
      path: metadataPath,
    }));
  }

  if (!isBlank(metadata?.status) && !['done', 'partial', 'blocked'].includes(String(metadata.status))) {
    diagnostics.push(diagnostic('RUN_METADATA_STATUS_INVALID', 'Run metadata status must be done, partial, or blocked.', {
      status: metadata.status,
      path: metadataPath,
    }));
  }
  if (summaryStatus && metadata?.status && metadata.status !== summaryStatus) {
    diagnostics.push(diagnostic('RUN_METADATA_STATUS_MISMATCH', 'Run metadata status must match the summary status marker.', {
      expected: summaryStatus,
      actual: metadata.status,
      path: metadataPath,
    }));
  }

  return diagnostics;
}

function workspaceRootForPipeline(pipelineDir) {
  const gitRoot = tryGit(['rev-parse', '--show-toplevel'], pipelineDir);
  if (gitRoot) return gitRoot;
  const parts = path.resolve(pipelineDir).split(path.sep);
  const orpadIndex = parts.lastIndexOf('.orpad');
  if (orpadIndex > 0 && parts[orpadIndex + 1] === 'pipelines') {
    return parts.slice(0, orpadIndex).join(path.sep);
  }
  return pipelineDir;
}

function auditCommandName(command) {
  const source = String(command || '').trim();
  const npmMatch = source.match(/\bnpm\s+run\s+(audit:orpad-[a-z0-9:-]+)/i);
  if (npmMatch) return npmMatch[1].toLowerCase();

  const scriptMatch = source.match(/(?:^|\s)scripts[\\/](audit-orpad-[a-z0-9-]+)\.mjs\b/i);
  if (!scriptMatch) return '';
  return scriptMatch[1].replace(/^audit-/, 'audit:').toLowerCase();
}

function requiredAuditCommandNames(pipeline) {
  const names = new Set();
  for (const command of pipeline?.executionPolicy?.verificationDefaults || []) {
    const name = auditCommandName(command);
    if (name) names.add(name);
  }
  return [...names].sort();
}

function auditMetadataCommands(metadata, pipeline, metadataPath) {
  const diagnostics = [];
  const requiredNames = requiredAuditCommandNames(pipeline);
  if (!requiredNames.length) return diagnostics;

  const commands = Array.isArray(metadata.auditCommands) ? metadata.auditCommands : [];
  if (!commands.length) {
    return [diagnostic('RUN_METADATA_AUDIT_COMMANDS_MISSING', 'Run metadata must include audit command summaries for required audit verification defaults.', {
      requiredCommands: requiredNames,
      path: metadataPath,
    })];
  }

  for (const requiredName of requiredNames) {
    const matching = commands.filter(item => auditCommandName(item?.command) === requiredName);
    if (!matching.length) {
      diagnostics.push(diagnostic('RUN_METADATA_AUDIT_COMMAND_MISSING', 'Run metadata is missing a required audit command summary.', {
        command: requiredName,
        path: metadataPath,
      }));
      continue;
    }
    if (!matching.some(item => item?.ok === true)) {
      diagnostics.push(diagnostic('RUN_METADATA_AUDIT_COMMAND_NOT_PASSED', 'Run metadata must include a passing summary for each required audit command.', {
        command: requiredName,
        path: metadataPath,
      }));
    }
    if (!matching.some(item => typeof item?.summary === 'string' && item.summary.trim().length >= 12)) {
      diagnostics.push(diagnostic('RUN_METADATA_AUDIT_COMMAND_SUMMARY_WEAK', 'Run metadata audit command entries must include a concrete summary.', {
        command: requiredName,
        path: metadataPath,
      }));
    }
  }

  return diagnostics;
}

async function expectedManifestFiles({ pipelineDir, artifactRoot, queueRoot, summaryPath, coveragePath, candidateInventoryPath, run }) {
  const files = new Map();
  const addFile = (filePath) => {
    if (!filePath) return;
    files.set(path.resolve(filePath), true);
  };

  addFile(summaryPath);
  addFile(coveragePath);
  addFile(candidateInventoryPath);
  for (const ref of run.requiredArtifacts || []) addFile(path.join(artifactRoot, String(ref || '').replace(/\\/g, path.sep)));
  for (const ref of run.requiredQueueArtifacts || []) addFile(path.join(queueRoot, String(ref || '').replace(/\\/g, path.sep)));
  if (queueRoot) {
    for (const filePath of await collectFilesUnder(queueRoot, itemPath => itemPath.toLowerCase().endsWith('.json'))) {
      addFile(filePath);
    }
  }
  const workItemArtifactRoot = run.workItemArtifactRoot ? normalizeRef(pipelineDir, run.workItemArtifactRoot) : '';
  if (workItemArtifactRoot) {
    for (const filePath of await collectFilesUnder(workItemArtifactRoot, () => true)) {
      addFile(filePath);
    }
  }

  return [...files.keys()].map(filePath => ({
    path: evidenceManifestPath(pipelineDir, filePath),
    filePath,
  })).sort((a, b) => a.path.localeCompare(b.path));
}

async function auditArtifactManifest(metadata, context) {
  const diagnostics = [];
  const manifest = metadata?.artifactManifest;
  const metadataPath = context.metadataPath;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [diagnostic('RUN_METADATA_ARTIFACT_MANIFEST_MISSING', 'Run metadata must include an artifactManifest with hashes for ignored run evidence files.', {
      path: metadataPath,
    })];
  }

  const entries = Array.isArray(manifest.files) ? manifest.files : [];
  const entriesByPath = new Map(entries
    .filter(item => item && typeof item === 'object' && typeof item.path === 'string')
    .map(item => [item.path.replace(/\\/g, '/'), item]));

  for (const expected of await expectedManifestFiles(context)) {
    let digest;
    try {
      digest = await fileDigest(expected.filePath);
    } catch {
      continue;
    }
    const entry = entriesByPath.get(expected.path);
    if (!entry) {
      diagnostics.push(diagnostic('RUN_METADATA_ARTIFACT_MANIFEST_ENTRY_MISSING', 'Run metadata artifactManifest is missing a required evidence file.', {
        ref: expected.path,
        path: metadataPath,
      }));
      continue;
    }
    if (entry.sha256 !== digest.sha256) {
      diagnostics.push(diagnostic('RUN_METADATA_ARTIFACT_MANIFEST_HASH_MISMATCH', 'Run metadata artifactManifest sha256 does not match the current evidence file.', {
        ref: expected.path,
        expected: digest.sha256,
        actual: entry.sha256,
        path: metadataPath,
      }));
    }
    if (Number(entry.size) !== digest.size) {
      diagnostics.push(diagnostic('RUN_METADATA_ARTIFACT_MANIFEST_SIZE_MISMATCH', 'Run metadata artifactManifest size does not match the current evidence file.', {
        ref: expected.path,
        expected: digest.size,
        actual: entry.size,
        path: metadataPath,
      }));
    }
  }

  return diagnostics;
}

async function readQueueJournalEvents(queueRoot) {
  const journalPath = path.join(queueRoot, 'journal.jsonl');
  let source = '';
  try {
    source = await fs.readFile(journalPath, 'utf-8');
  } catch {
    return [];
  }

  const events = [];
  source.split(/\r?\n/).forEach((line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event);
    } catch {
      // The queue audit reports malformed journal JSON; proof discovery can ignore it here.
    }
  });
  return events;
}

async function claimedWorkItemIds(queueRoot, queueAudit) {
  const itemIds = new Set();
  for (const item of queueAudit?.items || []) {
    if (item?.state === 'claimed' || item?.state === 'done') itemIds.add(String(item.id));
  }

  for (const event of await readQueueJournalEvents(queueRoot)) {
    const itemId = String(event.itemId || '').trim();
    if (!itemId) continue;
    const action = String(event.action || '');
    const fromState = String(event.fromState || '');
    const toState = String(event.toState || '');
    if (action === 'claim' || fromState === 'claimed' || toState === 'claimed') itemIds.add(itemId);
  }

  return [...itemIds].sort();
}

async function auditWorkItemArtifacts({ queueRoot, workItemArtifactRoot, queueAudit }) {
  const diagnostics = [];
  const claimedIds = await claimedWorkItemIds(queueRoot, queueAudit);
  if (!claimedIds.length) return diagnostics;

  if (!workItemArtifactRoot) {
    diagnostics.push(diagnostic(
      'RUN_WORK_ITEM_ARTIFACT_ROOT_MISSING',
      'Run configuration must declare workItemArtifactRoot when claimed queue items exist.',
      { itemIds: claimedIds },
    ));
    return diagnostics;
  }

  for (const itemId of claimedIds) {
    const itemArtifactDir = path.join(workItemArtifactRoot, itemId);
    const files = await collectFilesUnder(itemArtifactDir, () => true);
    if (!files.length) {
      diagnostics.push(diagnostic(
        'RUN_WORK_ITEM_PROOF_MISSING',
        'Claimed work items must have item-level proof evidence files.',
        { itemId, path: itemArtifactDir },
      ));
    }
  }

  return diagnostics;
}

function auditQueueCycleStatus(queueAudit, summaryStatus, runSelection = {}) {
  if (summaryStatus !== 'done' || runSelection?.doneRequiresNoActiveQueueItems !== true || !queueAudit) {
    return [];
  }
  const activeStateIds = collectStringArray(runSelection.activeQueueStates);
  const activeStates = new Set(activeStateIds.length ? activeStateIds : ['candidate', 'queued', 'claimed']);
  const activeItems = (queueAudit.items || [])
    .filter(item => activeStates.has(String(item?.state || '')))
    .map(item => ({
      id: item.id,
      state: item.state,
      path: item.path,
    }));
  if (!activeItems.length) return [];
  return [diagnostic('RUN_QUEUE_ACTIVE_ITEMS_WITH_DONE_STATUS', 'Run summary cannot use done while candidate, queued, or claimed queue items remain active.', {
    activeItems,
    expectedStatus: runSelection.residualActionableWorkStatus || 'partial',
  })];
}

function collectEvidenceValues(evidence, key) {
  const values = new Set();
  for (const item of Array.isArray(evidence) ? evidence : []) {
    if (!item || typeof item !== 'object') continue;
    const raw = item[key];
    const list = Array.isArray(raw) ? raw : [raw];
    for (const value of list) {
      if (typeof value === 'string' && value.trim()) values.add(value.trim());
    }
  }
  return values;
}

function valueSetCovers(values, required) {
  return [...values].some(value => value.toLowerCase() === required.toLowerCase());
}

function evidenceFileExists(workspaceRoot, evidence) {
  const file = typeof evidence.file === 'string' ? evidence.file.trim() : '';
  if (!file) return true;
  const resolved = path.resolve(workspaceRoot, file.replace(/\\/g, path.sep));
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return fsSync.existsSync(resolved);
}

function evidenceArtifactExists(workspaceRoot, evidence) {
  const artifact = typeof evidence.artifact === 'string' ? evidence.artifact.trim() : '';
  if (!artifact) return true;
  const resolved = path.resolve(workspaceRoot, artifact.replace(/\\/g, path.sep));
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return fsSync.existsSync(resolved);
}

function stagedCandidateExists(probeInboxRoot, lensId, candidateId) {
  if (!probeInboxRoot) return true;
  const filePath = path.join(probeInboxRoot, lensId, 'candidate', `${candidateId}.json`);
  return fsSync.existsSync(filePath);
}

function isWeakEmptyPass(reason) {
  const text = String(reason || '').trim();
  return text.length < 80 || /^(no (issue|issues|problem|problems) found|none|n\/a|ok|pass)$/i.test(text);
}

function collectCoverageEvidenceIds(coverage) {
  const ids = new Set();
  const lenses = coverage?.lenses && typeof coverage.lenses === 'object' ? coverage.lenses : {};
  for (const lens of Object.values(lenses)) {
    for (const item of Array.isArray(lens?.evidence) ? lens.evidence : []) {
      if (typeof item?.id === 'string' && item.id.trim()) ids.add(item.id.trim());
    }
  }
  return ids;
}

function collectCoverageEvidenceById(coverage) {
  const byId = new Map();
  const lenses = coverage?.lenses && typeof coverage.lenses === 'object' ? coverage.lenses : {};
  for (const lens of Object.values(lenses)) {
    for (const item of Array.isArray(lens?.evidence) ? lens.evidence : []) {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (id && !byId.has(id)) byId.set(id, item);
    }
  }
  return byId;
}

function collectCoverageCandidatesByLens(coverage) {
  const candidatesByLens = new Map();
  const lenses = coverage?.lenses && typeof coverage.lenses === 'object' ? coverage.lenses : {};
  for (const [lensId, lens] of Object.entries(lenses)) {
    candidatesByLens.set(lensId, new Set((Array.isArray(lens?.candidatesStaged) ? lens.candidatesStaged : [])
      .filter(candidateId => typeof candidateId === 'string' && candidateId.trim())
      .map(candidateId => candidateId.trim())));
  }
  return candidatesByLens;
}

function collectCoverageScenariosByLens(coverage) {
  const scenariosByLens = new Map();
  const lenses = coverage?.lenses && typeof coverage.lenses === 'object' ? coverage.lenses : {};
  for (const [lensId, lens] of Object.entries(lenses)) {
    scenariosByLens.set(lensId, new Set((Array.isArray(lens?.scenarios) ? lens.scenarios : [])
      .filter(scenario => scenario && typeof scenario.id === 'string' && scenario.id.trim())
      .map(scenario => scenario.id.trim())));
  }
  return scenariosByLens;
}

function getInventoryItems(inventory) {
  if (Array.isArray(inventory?.items)) return inventory.items;
  if (Array.isArray(inventory?.candidateInventory)) return inventory.candidateInventory;
  return [];
}

function inventoryReasonWeak(value) {
  return String(value || '').trim().length < 40;
}

function inventoryEmptyPassReasonWeak(value) {
  const text = String(value || '').trim();
  return inventoryReasonWeak(text)
    || /current evidence directly probed/i.test(text)
    || /did not leave a separate actionable failure/i.test(text)
    || /any observed risks were already covered/i.test(text)
    || /no separate actionable candidate/i.test(text);
}

function inventoryTextBoilerplate(value) {
  const text = String(value || '').trim();
  return /current evidence directly probed/i.test(text)
    || /did not leave a separate actionable failure/i.test(text)
    || /current source,\s*focused tests,\s*or audit command evidence/i.test(text)
    || /should either produce a staged work item or have concrete passing evidence/i.test(text)
    || /current run evidence linked to this row/i.test(text)
    || /showed the risk was covered/i.test(text)
    || /covered without a separate actionable candidate/i.test(text)
    || /^risk check passed:/i.test(text);
}

function hasConcreteProbeDetail(value) {
  const text = String(value || '').trim();
  return /\b(src|tests|scripts|nodes|assets|\.orpad)[\\/][^\s,;:]+/i.test(text)
    || /\b[A-Za-z]:[\\/][^\s,;:]+/.test(text)
    || /\bnpm run\b/i.test(text)
    || /\bnode\s+--check\b/i.test(text)
    || /\bplaywright\b/i.test(text)
    || /\.(?:cjs|mjs|js|ts|tsx|json|md|or-pipeline|or-graph|or-tree|or-rule|or-node)\b/i.test(text);
}

function coverageEvidenceSourceTokens(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return [];
  const tokens = [];
  for (const field of ['file', 'artifact', 'command']) {
    const value = typeof evidence[field] === 'string' ? evidence[field].trim() : '';
    if (!value) continue;
    tokens.push(value, value.replace(/\\/g, '/'));
    if (field !== 'command') {
      const baseName = path.basename(value.replace(/\\/g, path.sep));
      if (baseName && baseName !== value) tokens.push(baseName);
    }
  }
  return [...new Set(tokens.filter(token => token && token.length >= 4))];
}

function textReferencesCoverageEvidenceSource(text, evidence) {
  const haystack = String(text || '').replace(/\\/g, '/').toLowerCase();
  if (!haystack) return false;
  return coverageEvidenceSourceTokens(evidence)
    .map(token => token.replace(/\\/g, '/').toLowerCase())
    .some(token => haystack.includes(token));
}

function negativeCheckDiagnostics(item, context = {}) {
  const diagnostics = [];
  const { coverageEvidenceById, ...diagnosticContext } = context;
  const negativeCheck = item?.negativeCheck;
  if (!negativeCheck || typeof negativeCheck !== 'object' || Array.isArray(negativeCheck)) {
    return [diagnostic('CANDIDATE_INVENTORY_NEGATIVE_CHECK_MISSING', 'Empty-pass inventory rows must include a structured negativeCheck object.', diagnosticContext)];
  }
  for (const field of ['method', 'expected', 'observed']) {
    const value = negativeCheck[field];
    if (typeof value !== 'string' || value.trim().length < 12) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_NEGATIVE_CHECK_FIELD_WEAK', `negativeCheck.${field} must describe the concrete risk probe.`, {
        ...diagnosticContext,
        field,
      }));
      continue;
    }
    if (inventoryTextBoilerplate(value)) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_NEGATIVE_CHECK_BOILERPLATE', `negativeCheck.${field} must describe the specific probe result, not a reusable no-issue template.`, {
        ...diagnosticContext,
        field,
      }));
    }
    if ((field === 'method' || field === 'observed') && !hasConcreteProbeDetail(value)) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_NEGATIVE_CHECK_NOT_CONCRETE', `negativeCheck.${field} must name a concrete file, command, assertion, selector, evidence file, or observed behavior.`, {
        ...diagnosticContext,
        field,
      }));
    }
  }
  const evidenceIds = collectStringArray(item?.evidenceIds);
  if (coverageEvidenceById instanceof Map && evidenceIds.length) {
    const sourceText = `${negativeCheck.method || ''}\n${negativeCheck.observed || ''}`;
    const referencedEvidence = evidenceIds
      .map(evidenceId => coverageEvidenceById.get(evidenceId))
      .filter(Boolean);
    const hasSourceReference = referencedEvidence
      .some(evidence => textReferencesCoverageEvidenceSource(sourceText, evidence));
    if (!hasSourceReference) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_NEGATIVE_CHECK_EVIDENCE_UNLINKED', 'negativeCheck.method or negativeCheck.observed must cite a file, command, or evidence file from one of the row evidenceIds.', diagnosticContext));
    }
  }
  return diagnostics;
}

function collectStringArray(value) {
  return (Array.isArray(value) ? value : [])
    .filter(item => typeof item === 'string' && item.trim())
    .map(item => item.trim());
}

function targetMatrixByLens(policy) {
  const matrix = new Map();
  const raw = policy?.targetMatrix && typeof policy.targetMatrix === 'object' ? policy.targetMatrix : {};
  for (const [lensId, targets] of Object.entries(raw)) {
    const entries = (Array.isArray(targets) ? targets : [])
      .filter(target => target && typeof target === 'object' && typeof target.id === 'string' && target.id.trim())
      .map(target => ({
        id: target.id.trim(),
        target: typeof target.target === 'string' ? target.target.trim() : '',
        scenarios: collectStringArray(target.scenarios),
        riskChecks: (Array.isArray(target.riskChecks) ? target.riskChecks : [])
          .filter(riskCheck => riskCheck && typeof riskCheck === 'object' && typeof riskCheck.id === 'string' && riskCheck.id.trim())
          .map(riskCheck => ({
            id: riskCheck.id.trim(),
            question: typeof riskCheck.question === 'string' ? riskCheck.question.trim() : '',
          })),
      }));
    if (entries.length) matrix.set(lensId, entries);
  }
  return matrix;
}

function expectedInventoryCheckResult(status) {
  if (status === 'candidate') return 'fail';
  if (status === 'empty-pass') return 'pass';
  if (status === 'deferred') return 'deferred';
  if (status === 'deduped-into') return 'deduped';
  return '';
}

function auditCandidateInventory(inventory, policy, options = {}) {
  const diagnostics = [];
  const probeInboxRoot = options.probeInboxRoot || '';
  const coverageEvidenceIds = options.coverageEvidenceIds || new Set();
  const coverageEvidenceById = options.coverageEvidenceById || new Map();
  const candidatesByLens = options.candidatesByLens || new Map();
  const scenariosByLens = options.scenariosByLens || new Map();
  const inventoryPath = options.inventoryPath || '';

  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
    return [diagnostic('CANDIDATE_INVENTORY_INVALID', 'Candidate inventory must be a JSON object.', { path: inventoryPath })];
  }
  if (inventory.schemaVersion !== CANDIDATE_INVENTORY_SCHEMA) {
    diagnostics.push(diagnostic('CANDIDATE_INVENTORY_SCHEMA_UNSUPPORTED', `Candidate inventory schemaVersion must be ${CANDIDATE_INVENTORY_SCHEMA}.`, {
      schemaVersion: inventory.schemaVersion,
      path: inventoryPath,
    }));
  }

  const items = getInventoryItems(inventory);
  if (!items.length) {
    diagnostics.push(diagnostic('CANDIDATE_INVENTORY_ITEMS_MISSING', 'Candidate inventory must include an items array with at least one row per required lens.', {
      path: inventoryPath,
    }));
  }

  const requiredLensIds = new Set(Object.keys(policy?.minimumLensEvidence || {}));
  const targetMatrix = targetMatrixByLens(policy);
  const rowLensIds = new Set();
  const inventoryCandidateIdsByLens = new Map();
  const inventoryScenarioIdsByLens = new Map();
  const inventoryTargetIdsByLens = new Map();
  const inventoryScenarioIdsByTarget = new Map();
  const inventoryRiskCheckIdsByTarget = new Map();
  const addInventoryCandidate = (lensId, candidateId) => {
    if (!inventoryCandidateIdsByLens.has(lensId)) inventoryCandidateIdsByLens.set(lensId, new Set());
    inventoryCandidateIdsByLens.get(lensId).add(candidateId);
  };
  const addInventoryScenarios = (lensId, scenarioIds) => {
    if (!inventoryScenarioIdsByLens.has(lensId)) inventoryScenarioIdsByLens.set(lensId, new Set());
    const scenarioSet = inventoryScenarioIdsByLens.get(lensId);
    scenarioIds.forEach(scenarioId => scenarioSet.add(scenarioId));
  };
  const addInventoryTargets = (lensId, targetIds, scenarioIds, riskCheckIds) => {
    if (!inventoryTargetIdsByLens.has(lensId)) inventoryTargetIdsByLens.set(lensId, new Set());
    const targetSet = inventoryTargetIdsByLens.get(lensId);
    for (const targetId of targetIds) {
      targetSet.add(targetId);
      const targetKey = `${lensId}\0${targetId}`;
      if (!inventoryScenarioIdsByTarget.has(targetKey)) inventoryScenarioIdsByTarget.set(targetKey, new Set());
      const scenarioSet = inventoryScenarioIdsByTarget.get(targetKey);
      scenarioIds.forEach(scenarioId => scenarioSet.add(scenarioId));
      if (!inventoryRiskCheckIdsByTarget.has(targetKey)) inventoryRiskCheckIdsByTarget.set(targetKey, new Set());
      const riskCheckSet = inventoryRiskCheckIdsByTarget.get(targetKey);
      riskCheckIds.forEach(riskCheckId => riskCheckSet.add(riskCheckId));
    }
  };

  items.forEach((item, index) => {
    const itemPath = `items[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_ITEM_INVALID', 'Candidate inventory rows must be objects.', { path: itemPath, inventoryPath }));
      return;
    }

    const id = String(item.id || '').trim();
    const lensId = String(item.lensId || item.sourceNode || '').trim();
    const status = String(item.status || '').trim();
    const targetIds = collectStringArray(item.targetIds);
    const riskCheckIds = collectStringArray(item.riskCheckIds);
    const scenarioIds = collectStringArray(item.scenarioIds);
    const inspectedTargets = collectStringArray(item.inspectedTargets);
    const checkResult = String(item.checkResult || '').trim();
    if (!id) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_ID_MISSING', 'Candidate inventory rows must include id.', { path: itemPath, inventoryPath }));
    }
    if (!lensId) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_LENS_MISSING', 'Candidate inventory rows must include lensId.', { id, path: itemPath, inventoryPath }));
    } else {
      rowLensIds.add(lensId);
    }
    if (!CANDIDATE_INVENTORY_STATUSES.has(status)) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_STATUS_INVALID', 'Candidate inventory status must be candidate, deferred, deduped-into, or empty-pass.', {
        id,
        status,
        path: itemPath,
        inventoryPath,
      }));
    }
    const expectedCheckResult = expectedInventoryCheckResult(status);
    if (!checkResult) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_CHECK_RESULT_MISSING', 'Candidate inventory rows must include checkResult.', {
        id,
        status,
        path: itemPath,
        inventoryPath,
      }));
    } else if (expectedCheckResult && checkResult !== expectedCheckResult) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_CHECK_RESULT_MISMATCH', 'Candidate inventory checkResult must match its disposition status.', {
        id,
        status,
        expected: expectedCheckResult,
        actual: checkResult,
        path: itemPath,
        inventoryPath,
      }));
    }
    if (typeof item.title !== 'string' || item.title.trim().length < 8) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_TITLE_WEAK', 'Candidate inventory rows must include a concrete title.', {
        id,
        path: itemPath,
        inventoryPath,
      }));
    }
    const evidenceIds = Array.isArray(item.evidenceIds) ? item.evidenceIds : [];
    if (!evidenceIds.length) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_EVIDENCE_MISSING', 'Candidate inventory rows must link to coverage evidence ids.', {
        id,
        path: itemPath,
        inventoryPath,
      }));
    }
    for (const evidenceId of evidenceIds) {
      if (typeof evidenceId !== 'string' || !coverageEvidenceIds.has(evidenceId.trim())) {
        diagnostics.push(diagnostic('CANDIDATE_INVENTORY_EVIDENCE_UNKNOWN', 'Candidate inventory evidenceIds must reference coverage manifest evidence ids.', {
          id,
          evidenceId,
          path: itemPath,
          inventoryPath,
        }));
      }
    }
    if (!inspectedTargets.length) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_TARGETS_MISSING', 'Candidate inventory rows must include inspectedTargets so empty passes and candidates are tied to concrete surfaces.', {
        id,
        path: itemPath,
        inventoryPath,
      }));
    }
    const knownTargets = new Set((targetMatrix.get(lensId) || []).map(target => target.id));
    const knownRiskCheckIds = new Set((targetMatrix.get(lensId) || [])
      .filter(target => !targetIds.length || targetIds.includes(target.id))
      .flatMap(target => target.riskChecks.map(riskCheck => riskCheck.id)));
    if (knownTargets.size && !targetIds.length) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_TARGET_IDS_MISSING', 'Candidate inventory rows for target-matrix lenses must include targetIds.', {
        id,
        lensId,
        path: itemPath,
        inventoryPath,
      }));
    }
    for (const targetId of targetIds) {
      if (knownTargets.size && !knownTargets.has(targetId)) {
        diagnostics.push(diagnostic('CANDIDATE_INVENTORY_TARGET_ID_UNKNOWN', 'Candidate inventory targetIds must reference run.discoveryCoveragePolicy.targetMatrix ids for the same lens.', {
          id,
          lensId,
          targetId,
          path: itemPath,
          inventoryPath,
        }));
      }
    }
    if (knownRiskCheckIds.size && !riskCheckIds.length) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_RISK_CHECK_IDS_MISSING', 'Candidate inventory rows for risk-matrix targets must include riskCheckIds.', {
        id,
        lensId,
        path: itemPath,
        inventoryPath,
      }));
    }
    for (const riskCheckId of riskCheckIds) {
      if (knownRiskCheckIds.size && !knownRiskCheckIds.has(riskCheckId)) {
        diagnostics.push(diagnostic('CANDIDATE_INVENTORY_RISK_CHECK_ID_UNKNOWN', 'Candidate inventory riskCheckIds must reference targetMatrix riskChecks for the same lens target.', {
          id,
          lensId,
          riskCheckId,
          path: itemPath,
          inventoryPath,
        }));
      }
    }
    if (status === 'empty-pass' && targetIds.length !== 1) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_EMPTY_PASS_TARGET_SCOPE_TOO_BROAD', 'Empty-pass inventory rows must cover exactly one target id so broad lens-level pass summaries do not hide backlog.', {
        id,
        lensId,
        targetIds,
        path: itemPath,
        inventoryPath,
      }));
    }
    if (status === 'empty-pass' && riskCheckIds.length !== 1) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_EMPTY_PASS_RISK_SCOPE_TOO_BROAD', 'Empty-pass inventory rows must cover exactly one risk check id so broad pass summaries do not hide backlog.', {
        id,
        lensId,
        riskCheckIds,
        path: itemPath,
        inventoryPath,
      }));
    }
    if (status === 'empty-pass') {
      diagnostics.push(...negativeCheckDiagnostics(item, {
        id,
        lensId,
        path: itemPath,
        inventoryPath,
        coverageEvidenceById,
      }));
    }
    const knownScenarios = scenariosByLens.get(lensId) || new Set();
    const lensPolicy = lensId ? policy?.minimumLensEvidence?.[lensId] || {} : {};
    if ((lensPolicy.requiredScenarios || []).length && !scenarioIds.length) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_SCENARIO_IDS_MISSING', 'Candidate inventory rows for scenario-based lenses must include scenarioIds.', {
        id,
        lensId,
        path: itemPath,
        inventoryPath,
      }));
    }
    for (const scenarioId of scenarioIds) {
      if (knownScenarios.size && !knownScenarios.has(scenarioId)) {
        diagnostics.push(diagnostic('CANDIDATE_INVENTORY_SCENARIO_UNKNOWN', 'Candidate inventory scenarioIds must reference coverage manifest scenarios for the same lens.', {
          id,
          lensId,
          scenarioId,
          path: itemPath,
          inventoryPath,
        }));
      }
    }
    if (lensId && scenarioIds.length) addInventoryScenarios(lensId, scenarioIds);
    if (lensId && targetIds.length) addInventoryTargets(lensId, targetIds, scenarioIds, riskCheckIds);

    if (status === 'candidate') {
      const stagedCandidateId = String(item.stagedCandidateId || item.candidateId || id).trim();
      if (!stagedCandidateId) {
        diagnostics.push(diagnostic('CANDIDATE_INVENTORY_STAGED_ID_MISSING', 'Candidate inventory rows with status candidate must include stagedCandidateId.', {
          id,
          path: itemPath,
          inventoryPath,
        }));
      } else if (!stagedCandidateExists(probeInboxRoot, lensId, stagedCandidateId)) {
        diagnostics.push(diagnostic('CANDIDATE_INVENTORY_STAGED_FILE_MISSING', 'Candidate inventory candidate rows must have a matching staged inbox candidate file.', {
          id,
          stagedCandidateId,
          lensId,
          path: itemPath,
          inventoryPath,
        }));
      } else {
        addInventoryCandidate(lensId, stagedCandidateId);
      }
    } else if (status === 'deduped-into') {
      const dedupedInto = String(item.dedupedInto || item.canonicalCandidateId || '').trim();
      if (!dedupedInto) {
        diagnostics.push(diagnostic('CANDIDATE_INVENTORY_DEDUPE_TARGET_MISSING', 'Deduped inventory rows must name the canonical candidate id.', {
          id,
          path: itemPath,
          inventoryPath,
        }));
      }
      if (inventoryReasonWeak(item.reason)) {
        diagnostics.push(diagnostic('CANDIDATE_INVENTORY_DEDUPE_REASON_WEAK', 'Deduped inventory rows must include a concrete reason.', {
          id,
          path: itemPath,
          inventoryPath,
        }));
      }
    } else if (status === 'empty-pass' && inventoryEmptyPassReasonWeak(item.reason)) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_EMPTY_PASS_REASON_WEAK', 'Empty-pass inventory rows must explain the concrete inspected behavior, not use a generic no-issue template.', {
        id,
        status,
        path: itemPath,
        inventoryPath,
      }));
    } else if (status === 'deferred' && inventoryReasonWeak(item.reason)) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_REASON_WEAK', 'Deferred and empty-pass inventory rows must include a concrete evidence-backed reason.', {
        id,
        status,
        path: itemPath,
        inventoryPath,
      }));
    }
  });

  for (const lensId of requiredLensIds) {
    if (!rowLensIds.has(lensId)) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_LENS_ROW_MISSING', 'Candidate inventory must include at least one row for every required discovery lens.', {
        lensId,
        path: inventoryPath,
      }));
    }
  }

  for (const [lensId, candidateIds] of candidatesByLens.entries()) {
    const inventoryIds = inventoryCandidateIdsByLens.get(lensId) || new Set();
    for (const candidateId of candidateIds) {
      if (!inventoryIds.has(candidateId)) {
        diagnostics.push(diagnostic('CANDIDATE_INVENTORY_COVERAGE_CANDIDATE_MISSING', 'Coverage candidatesStaged entries must be represented in candidate inventory.', {
          lensId,
          candidateId,
          path: inventoryPath,
        }));
      }
    }
  }

  for (const [lensId, lensPolicy] of Object.entries(policy?.minimumLensEvidence || {})) {
    const coveredScenarioIds = inventoryScenarioIdsByLens.get(lensId) || new Set();
    for (const requiredScenario of lensPolicy.requiredScenarios || []) {
      if (!coveredScenarioIds.has(String(requiredScenario))) {
        diagnostics.push(diagnostic('CANDIDATE_INVENTORY_SCENARIO_MISSING', 'Candidate inventory must account for every required discovery scenario.', {
          lensId,
          requiredScenario,
          path: inventoryPath,
        }));
      }
    }
  }

  for (const [lensId, targets] of targetMatrix.entries()) {
    const coveredTargetIds = inventoryTargetIdsByLens.get(lensId) || new Set();
    for (const target of targets) {
      if (!coveredTargetIds.has(target.id)) {
        diagnostics.push(diagnostic('CANDIDATE_INVENTORY_TARGET_ID_MISSING', 'Candidate inventory must account for every discovery targetMatrix target id.', {
          lensId,
          targetId: target.id,
          target: target.target,
          path: inventoryPath,
        }));
      }
      const coveredScenarios = inventoryScenarioIdsByTarget.get(`${lensId}\0${target.id}`) || new Set();
      for (const scenarioId of target.scenarios || []) {
        if (!coveredScenarios.has(scenarioId)) {
          diagnostics.push(diagnostic('CANDIDATE_INVENTORY_TARGET_SCENARIO_MISSING', 'Candidate inventory target rows must account for each scenario assigned to that target.', {
            lensId,
            targetId: target.id,
            scenarioId,
            path: inventoryPath,
          }));
        }
      }
      const coveredRiskChecks = inventoryRiskCheckIdsByTarget.get(`${lensId}\0${target.id}`) || new Set();
      for (const riskCheck of target.riskChecks || []) {
        if (!coveredRiskChecks.has(riskCheck.id)) {
          diagnostics.push(diagnostic('CANDIDATE_INVENTORY_TARGET_RISK_CHECK_MISSING', 'Candidate inventory target rows must account for each risk check assigned to that target.', {
            lensId,
            targetId: target.id,
            riskCheckId: riskCheck.id,
            question: riskCheck.question,
            path: inventoryPath,
          }));
        }
      }
    }
  }

  return diagnostics;
}

function auditInventoryCycleStatus(inventory, summaryStatus, runSelection = {}, inventoryPath = '') {
  if (summaryStatus !== 'done' || runSelection?.doneRequiresNoDeferredInventory === false) {
    return [];
  }
  const deferredItems = getInventoryItems(inventory)
    .filter(item => String(item?.status || '').trim() === 'deferred')
    .map(item => ({
      id: String(item?.id || '').trim(),
      lensId: String(item?.lensId || item?.sourceNode || '').trim(),
      reason: String(item?.reason || '').trim(),
    }));
  if (!deferredItems.length) return [];
  return [diagnostic('RUN_INVENTORY_DEFERRED_WITH_DONE_STATUS', 'Run summary cannot use done while candidate inventory contains deferred observations; use partial or blocked unless the observations are resolved as candidate, deduped-into, empty-pass, rejected, blocked, or done.', {
    deferredItems,
    expectedStatus: runSelection.residualDeferredWorkStatus || runSelection.residualActionableWorkStatus || 'partial',
    path: inventoryPath,
  })];
}

function auditCoverageManifest(coverage, policy, options = {}) {
  const diagnostics = [];
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const probeInboxRoot = options.probeInboxRoot || '';
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
    return [diagnostic('DISCOVERY_COVERAGE_INVALID', 'Discovery coverage manifest must be a JSON object.')];
  }
  if (coverage.schemaVersion !== DISCOVERY_COVERAGE_SCHEMA) {
    diagnostics.push(diagnostic('DISCOVERY_COVERAGE_SCHEMA_UNSUPPORTED', `Discovery coverage schemaVersion must be ${DISCOVERY_COVERAGE_SCHEMA}.`, {
      schemaVersion: coverage.schemaVersion,
    }));
  }

  const lenses = coverage.lenses && typeof coverage.lenses === 'object' ? coverage.lenses : {};
  for (const [lensId, lensPolicy] of Object.entries(policy?.minimumLensEvidence || {})) {
    const lens = lenses[lensId];
    if (!lens || typeof lens !== 'object' || Array.isArray(lens)) {
      diagnostics.push(diagnostic('DISCOVERY_LENS_COVERAGE_MISSING', 'Discovery coverage is missing a required lens.', { lensId }));
      continue;
    }

    const evidence = Array.isArray(lens.evidence) ? lens.evidence : [];
    const evidenceIds = new Set();
    evidence.forEach((item, index) => {
      const itemPath = `lenses.${lensId}.evidence[${index}]`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        diagnostics.push(diagnostic('DISCOVERY_EVIDENCE_INVALID', 'Coverage evidence must be an object.', { lensId, path: itemPath }));
        return;
      }
      if (typeof item.id !== 'string' || !item.id.trim()) {
        diagnostics.push(diagnostic('DISCOVERY_EVIDENCE_ID_MISSING', 'Coverage evidence must include a stable id.', { lensId, path: itemPath }));
      } else {
        evidenceIds.add(item.id.trim());
      }
      if (typeof item.type !== 'string' || !item.type.trim()) {
        diagnostics.push(diagnostic('DISCOVERY_EVIDENCE_TYPE_MISSING', 'Coverage evidence must include a type.', { lensId, path: itemPath }));
      }
      if (typeof item.target !== 'string' || !item.target.trim()) {
        diagnostics.push(diagnostic('DISCOVERY_EVIDENCE_TARGET_MISSING', 'Coverage evidence must include a target.', { lensId, path: itemPath }));
      }
      if (typeof item.summary !== 'string' || item.summary.trim().length < 12) {
        diagnostics.push(diagnostic('DISCOVERY_EVIDENCE_SUMMARY_WEAK', 'Coverage evidence must include a concrete summary.', { lensId, path: itemPath }));
      }
      if (typeof item.observedAt !== 'string' || !item.observedAt.trim()) {
        diagnostics.push(diagnostic('DISCOVERY_EVIDENCE_OBSERVED_AT_MISSING', 'Coverage evidence must include observedAt for the current run.', { lensId, path: itemPath }));
      } else if (timestampMs(item.observedAt) === null) {
        diagnostics.push(diagnostic('DISCOVERY_EVIDENCE_OBSERVED_AT_INVALID', 'Coverage evidence observedAt must be a valid timestamp.', { lensId, path: itemPath, observedAt: item.observedAt }));
      }
      if (typeof item.observationKind !== 'string' || !item.observationKind.trim()) {
        diagnostics.push(diagnostic('DISCOVERY_EVIDENCE_OBSERVATION_KIND_MISSING', 'Coverage evidence must include observationKind.', { lensId, path: itemPath }));
      } else if (!OBSERVATION_KINDS.has(item.observationKind)) {
        diagnostics.push(diagnostic('DISCOVERY_EVIDENCE_OBSERVATION_KIND_UNKNOWN', 'Coverage evidence observationKind must be a known observation mode.', {
          lensId,
          path: itemPath,
          observationKind: item.observationKind,
        }));
      }
      if (!item.file && !item.command && !item.artifact) {
        diagnostics.push(diagnostic('DISCOVERY_EVIDENCE_SOURCE_MISSING', 'Coverage evidence must include file, command, or evidence file.', { lensId, path: itemPath }));
      }
      if (LIVE_EVIDENCE_TYPES.has(String(item.type || '').toLowerCase()) && !item.command && !item.artifact) {
        diagnostics.push(diagnostic('DISCOVERY_EVIDENCE_LIVE_SOURCE_MISSING', 'Live app or viewport evidence must include a command or evidence file from this run, not only a source file.', { lensId, path: itemPath }));
      }
      if (item.file && !evidenceFileExists(workspaceRoot, item)) {
        diagnostics.push(diagnostic('DISCOVERY_EVIDENCE_FILE_NOT_FOUND', 'Coverage evidence file must exist inside the workspace.', {
          lensId,
          path: itemPath,
          file: item.file,
        }));
      }
      if (item.artifact && !evidenceArtifactExists(workspaceRoot, item)) {
        diagnostics.push(diagnostic('DISCOVERY_EVIDENCE_ARTIFACT_NOT_FOUND', 'Coverage evidence file must exist inside the workspace.', {
          lensId,
          path: itemPath,
          artifact: item.artifact,
        }));
      }
      if (item.command && !['pass', 'fail', 'skipped', 'observed'].includes(String(item.result || '').toLowerCase())) {
        diagnostics.push(diagnostic('DISCOVERY_EVIDENCE_COMMAND_RESULT_MISSING', 'Command evidence must include result pass, fail, skipped, or observed.', {
          lensId,
          path: itemPath,
          command: item.command,
        }));
      }
    });

    const minimumEvidenceItems = Number(lensPolicy.minimumEvidenceItems || 0);
    if (minimumEvidenceItems && evidence.length < minimumEvidenceItems) {
      diagnostics.push(diagnostic('DISCOVERY_LENS_EVIDENCE_TOO_LOW', 'Discovery lens does not include enough current evidence items.', {
        lensId,
        expected: minimumEvidenceItems,
        actual: evidence.length,
      }));
    }

    const evidenceTypes = collectEvidenceValues(evidence, 'type');
    for (const requiredType of lensPolicy.requiredEvidenceTypes || []) {
      if (!valueSetCovers(evidenceTypes, requiredType)) {
        diagnostics.push(diagnostic('DISCOVERY_LENS_EVIDENCE_TYPE_MISSING', 'Discovery lens is missing a required evidence type.', {
          lensId,
          requiredType,
        }));
      }
    }

    const targets = collectEvidenceValues(evidence, 'target');
    for (const requiredTarget of lensPolicy.requiredTargets || []) {
      if (!valueSetCovers(targets, requiredTarget)) {
        diagnostics.push(diagnostic('DISCOVERY_LENS_TARGET_MISSING', 'Discovery lens is missing a required inspected target.', {
          lensId,
          requiredTarget,
        }));
      }
    }

    const scenarios = Array.isArray(lens.scenarios) ? lens.scenarios : [];
    const scenariosById = new Map(scenarios
      .filter(item => item && typeof item === 'object' && typeof item.id === 'string')
      .map(item => [item.id.trim(), item]));
    for (const [index, scenario] of scenarios.entries()) {
      const scenarioPath = `lenses.${lensId}.scenarios[${index}]`;
      if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
        diagnostics.push(diagnostic('DISCOVERY_SCENARIO_INVALID', 'Discovery scenarios must be objects.', { lensId, path: scenarioPath }));
        continue;
      }
      if (typeof scenario.id !== 'string' || !scenario.id.trim()) {
        diagnostics.push(diagnostic('DISCOVERY_SCENARIO_ID_MISSING', 'Discovery scenarios must include a stable id.', { lensId, path: scenarioPath }));
      }
      if (!['pass', 'fail', 'blocked'].includes(String(scenario.status || '').toLowerCase())) {
        diagnostics.push(diagnostic('DISCOVERY_SCENARIO_STATUS_INVALID', 'Discovery scenario status must be pass, fail, or blocked.', { lensId, path: scenarioPath }));
      }
      const scenarioEvidenceIds = Array.isArray(scenario.evidenceIds) ? scenario.evidenceIds : [];
      if (!scenarioEvidenceIds.length) {
        diagnostics.push(diagnostic('DISCOVERY_SCENARIO_EVIDENCE_MISSING', 'Discovery scenarios must link to coverage evidence ids.', { lensId, path: scenarioPath }));
      }
      for (const evidenceId of scenarioEvidenceIds) {
        if (typeof evidenceId !== 'string' || !evidenceIds.has(evidenceId.trim())) {
          diagnostics.push(diagnostic('DISCOVERY_SCENARIO_EVIDENCE_UNKNOWN', 'Discovery scenario evidenceIds must reference existing coverage evidence.', {
            lensId,
            path: scenarioPath,
            evidenceId,
          }));
        }
      }
      if (String(scenario.status || '').toLowerCase() === 'fail') {
        const candidateIds = Array.isArray(scenario.candidateIds) ? scenario.candidateIds : [];
        if (!candidateIds.length) {
          diagnostics.push(diagnostic('DISCOVERY_SCENARIO_FAIL_CANDIDATE_MISSING', 'A failed discovery scenario must stage at least one candidate id.', { lensId, path: scenarioPath }));
        }
      }
    }
    for (const requiredScenario of lensPolicy.requiredScenarios || []) {
      if (!scenariosById.has(String(requiredScenario))) {
        diagnostics.push(diagnostic('DISCOVERY_LENS_SCENARIO_MISSING', 'Discovery lens is missing a required scenario observation.', {
          lensId,
          requiredScenario,
        }));
      }
    }

    const candidates = Array.isArray(lens.candidatesStaged) ? lens.candidatesStaged : [];
    for (const candidateId of candidates) {
      if (typeof candidateId !== 'string' || !candidateId.trim()) {
        diagnostics.push(diagnostic('DISCOVERY_LENS_CANDIDATE_ID_INVALID', 'Coverage candidatesStaged entries must be non-empty ids.', { lensId }));
      } else if (!stagedCandidateExists(probeInboxRoot, lensId, candidateId.trim())) {
        diagnostics.push(diagnostic('DISCOVERY_LENS_CANDIDATE_FILE_MISSING', 'Coverage candidatesStaged entries must correspond to staged probe inbox candidate files.', {
          lensId,
          candidateId: candidateId.trim(),
        }));
      }
    }
    if (!candidates.length && !String(lens.emptyPassReason || '').trim()) {
      diagnostics.push(diagnostic('DISCOVERY_LENS_EMPTY_PASS_REASON_MISSING', 'A lens with no staged candidates must explain its evidence-backed empty pass.', {
        lensId,
      }));
    } else if (!candidates.length && isWeakEmptyPass(lens.emptyPassReason)) {
      diagnostics.push(diagnostic('DISCOVERY_LENS_EMPTY_PASS_REASON_WEAK', 'A lens with no staged candidates must include a concrete evidence-backed empty pass reason.', {
        lensId,
      }));
    }
  }

  return diagnostics;
}

function auditWorkItemCoverageLinks(queueAudit, coverageEvidenceIds, candidatesByLens) {
  const diagnostics = [];
  if ((!coverageEvidenceIds || coverageEvidenceIds.size === 0) && (!candidatesByLens || candidatesByLens.size === 0)) {
    return diagnostics;
  }
  for (const item of [...(queueAudit?.items || []), ...(queueAudit?.stagedCandidates || [])]) {
    for (const evidenceId of item.coverageEvidenceIds || []) {
      if (typeof evidenceId !== 'string' || !coverageEvidenceIds.has(evidenceId.trim())) {
        diagnostics.push(diagnostic('WORK_ITEM_COVERAGE_EVIDENCE_UNKNOWN', 'Work item coverageEvidenceIds must reference coverage manifest evidence ids.', {
          itemId: item.id,
          evidenceId,
          path: item.path,
        }));
      }
    }
  }
  if (candidatesByLens && candidatesByLens.size) {
    for (const stagedCandidate of queueAudit?.stagedCandidates || []) {
      const lensCandidates = candidatesByLens.get(stagedCandidate.probeId);
      if (lensCandidates && !lensCandidates.has(stagedCandidate.id)) {
        diagnostics.push(diagnostic('WORK_ITEM_COVERAGE_CANDIDATE_NOT_DECLARED', 'Staged inbox candidates must be declared by the matching coverage lens candidatesStaged list.', {
          itemId: stagedCandidate.id,
          lensId: stagedCandidate.probeId,
          path: stagedCandidate.path,
        }));
      }
    }
  }
  return diagnostics;
}

async function auditRun(pipelinePath) {
  const resolvedPipelinePath = path.resolve(pipelinePath);
  const pipelineDir = path.dirname(resolvedPipelinePath);
  const pipeline = await readJson(resolvedPipelinePath);
  const run = pipeline.run || {};
  const diagnostics = [];
  const workspaceRoot = workspaceRootForPipeline(pipelineDir);

  const artifactRoot = run.artifactRoot ? normalizeRef(pipelineDir, run.artifactRoot) : '';
  const queueRoot = run.queueRoot ? normalizeRef(pipelineDir, run.queueRoot) : '';
  const probeInboxRoot = run.probeInboxRoot ? normalizeRef(pipelineDir, run.probeInboxRoot) : queueRoot ? path.join(queueRoot, 'inbox') : '';
  const workItemArtifactRoot = run.workItemArtifactRoot ? normalizeRef(pipelineDir, run.workItemArtifactRoot) : '';
  const summaryPath = run.summaryPath ? normalizeRef(pipelineDir, run.summaryPath) : '';
  const metadataPath = run.metadataPath ? normalizeRef(pipelineDir, run.metadataPath) : '';
  const coveragePath = run.coverageManifestPath ? normalizeRef(pipelineDir, run.coverageManifestPath) : '';
  const candidateInventoryPath = run.candidateInventoryPath ? normalizeRef(pipelineDir, run.candidateInventoryPath) : '';
  let coverageEvidenceIds = new Set();
  let coverageEvidenceById = new Map();
  let coverageCandidatesByLens = new Map();
  let coverageScenariosByLens = new Map();

  if (!artifactRoot) diagnostics.push(diagnostic('RUN_ARTIFACT_ROOT_MISSING', 'Pipeline run.artifactRoot is missing.'));
  if (!queueRoot) diagnostics.push(diagnostic('RUN_QUEUE_ROOT_MISSING', 'Pipeline run.queueRoot is missing.'));
  if (!summaryPath) diagnostics.push(diagnostic('RUN_SUMMARY_PATH_MISSING', 'Pipeline run.summaryPath is missing.'));
  if (!metadataPath) diagnostics.push(diagnostic('RUN_METADATA_PATH_MISSING', 'Pipeline run.metadataPath is missing.'));
  if (!coveragePath && pipeline.run?.discoveryCoveragePolicy) {
    diagnostics.push(diagnostic('RUN_COVERAGE_MANIFEST_PATH_MISSING', 'Pipeline run.coverageManifestPath is required when discoveryCoveragePolicy is declared.'));
  }
  if (!candidateInventoryPath && pipeline.run?.discoveryCoveragePolicy?.candidateInventory) {
    diagnostics.push(diagnostic('RUN_CANDIDATE_INVENTORY_PATH_MISSING', 'Pipeline run.candidateInventoryPath is required when discoveryCoveragePolicy.candidateInventory is declared.'));
  }
  let summaryStatus = '';

  for (const ref of run.requiredArtifacts || []) {
    const filePath = path.join(artifactRoot, String(ref || '').replace(/\\/g, path.sep));
    if (!(await exists(filePath))) {
      diagnostics.push(diagnostic('RUN_REQUIRED_ARTIFACT_MISSING', 'Required run evidence file is missing.', { ref, path: filePath }));
    }
  }

  for (const ref of run.requiredQueueArtifacts || []) {
    const filePath = path.join(queueRoot, String(ref || '').replace(/\\/g, path.sep));
    if (!(await exists(filePath))) {
      diagnostics.push(diagnostic('RUN_REQUIRED_QUEUE_ARTIFACT_MISSING', 'Required queue evidence file is missing.', { ref, path: filePath }));
    }
  }

  if (summaryPath) {
    try {
      const summary = await fs.readFile(summaryPath, 'utf-8');
      const statusMatch = summary.match(STATUS_MARKER_RE);
      if (!statusMatch) {
        diagnostics.push(diagnostic('RUN_SUMMARY_STATUS_MISSING', 'Run summary must end with ## Status: done, partial, or blocked.', { path: summaryPath }));
      } else {
        summaryStatus = statusMatch[1];
      }
    } catch {
      diagnostics.push(diagnostic('RUN_SUMMARY_MISSING', 'Run summary is missing.', { path: summaryPath }));
    }
  }

  if (metadataPath) {
    try {
      const metadata = await readJson(metadataPath);
      if (metadata.schemaVersion !== RUN_METADATA_SCHEMA) {
        diagnostics.push(diagnostic('RUN_METADATA_SCHEMA_UNSUPPORTED', `Run metadata schemaVersion must be ${RUN_METADATA_SCHEMA}.`, {
          schemaVersion: metadata.schemaVersion,
          path: metadataPath,
        }));
      }
      diagnostics.push(...auditRunMetadata(metadata, metadataPath, summaryStatus));
      if (pipeline.id && metadata.pipelineId !== pipeline.id) {
        diagnostics.push(diagnostic('RUN_METADATA_PIPELINE_ID_MISMATCH', 'Run metadata pipelineId must match the pipeline id.', {
          expected: pipeline.id,
          actual: metadata.pipelineId,
          path: metadataPath,
        }));
      }
      const currentHead = tryGit(['rev-parse', 'HEAD'], pipelineDir);
      const currentStatus = tryGit(['status', '--short'], pipelineDir);
      const currentDigest = gitStatusDigest(currentStatus);
      if (currentHead && metadata.headSha !== currentHead) {
        diagnostics.push(diagnostic('RUN_METADATA_HEAD_STALE', 'Run metadata headSha does not match the current workspace HEAD.', {
          expected: currentHead,
          actual: metadata.headSha,
          path: metadataPath,
        }));
      }
      if (currentHead && metadata.workspaceStatusDigest !== currentDigest) {
        diagnostics.push(diagnostic('RUN_METADATA_WORKTREE_STALE', 'Run metadata workspaceStatusDigest does not match the current git status.', {
          expected: currentDigest,
          actual: metadata.workspaceStatusDigest,
          path: metadataPath,
        }));
      }
      diagnostics.push(...auditMetadataCommands(metadata, pipeline, metadataPath));
      diagnostics.push(...await auditArtifactManifest(metadata, {
        pipelineDir,
        artifactRoot,
        queueRoot,
        summaryPath,
        coveragePath,
        candidateInventoryPath,
        metadataPath,
        run,
      }));
    } catch (err) {
      diagnostics.push(diagnostic('RUN_METADATA_MISSING_OR_INVALID', 'Run metadata is missing or invalid JSON.', {
        path: metadataPath,
        error: err.message,
      }));
    }
  }

  if (coveragePath) {
    try {
      const coverage = await readJson(coveragePath);
      coverageEvidenceIds = collectCoverageEvidenceIds(coverage);
      coverageEvidenceById = collectCoverageEvidenceById(coverage);
      coverageCandidatesByLens = collectCoverageCandidatesByLens(coverage);
      coverageScenariosByLens = collectCoverageScenariosByLens(coverage);
      diagnostics.push(...auditCoverageManifest(coverage, run.discoveryCoveragePolicy, {
        workspaceRoot,
        probeInboxRoot,
      }));
    } catch (err) {
      diagnostics.push(diagnostic('DISCOVERY_COVERAGE_MISSING_OR_INVALID', 'Discovery coverage manifest is missing or invalid JSON.', {
        path: coveragePath,
        error: err.message,
      }));
    }
  }

  if (candidateInventoryPath) {
    try {
      const candidateInventory = await readJson(candidateInventoryPath);
      diagnostics.push(...auditCandidateInventory(candidateInventory, run.discoveryCoveragePolicy, {
        workspaceRoot,
        probeInboxRoot,
        coverageEvidenceIds,
        coverageEvidenceById,
        candidatesByLens: coverageCandidatesByLens,
        scenariosByLens: coverageScenariosByLens,
        inventoryPath: candidateInventoryPath,
      }));
      diagnostics.push(...auditInventoryCycleStatus(candidateInventory, summaryStatus, pipeline.maintenancePolicy?.runSelection || {}, candidateInventoryPath));
    } catch (err) {
      diagnostics.push(diagnostic('CANDIDATE_INVENTORY_MISSING_OR_INVALID', 'Candidate inventory is missing or invalid JSON.', {
        path: candidateInventoryPath,
        error: err.message,
      }));
    }
  }

  let queueAudit = null;
  if (queueRoot) {
    queueAudit = await auditWorkQueue(queueRoot, { queueProtocol: run.queueProtocol || {} });
    diagnostics.push(...queueAudit.diagnostics);
    diagnostics.push(...auditWorkItemCoverageLinks(queueAudit, coverageEvidenceIds, coverageCandidatesByLens));
    diagnostics.push(...await auditWorkItemArtifacts({
      queueRoot,
      workItemArtifactRoot,
      queueAudit,
    }));
    diagnostics.push(...auditQueueCycleStatus(queueAudit, summaryStatus, pipeline.maintenancePolicy?.runSelection || {}));
  }

  let nodeSchemaAudit = null;
  try {
    nodeSchemaAudit = await auditNodeSchemas(resolvedPipelinePath, workspaceRoot);
    diagnostics.push(...nodeSchemaAudit.diagnostics);
  } catch (err) {
    diagnostics.push(diagnostic('NODE_SCHEMA_AUDIT_FAILED', 'Node-pack schema drift audit failed to run.', {
      error: err.message,
    }));
  }

  return {
    ok: diagnostics.length === 0,
    pipelinePath: resolvedPipelinePath,
    artifactRoot,
    queueRoot,
    probeInboxRoot,
    workItemArtifactRoot,
    summaryPath,
    metadataPath,
    coveragePath,
    candidateInventoryPath,
    queueAudit,
    nodeSchemaAudit,
    diagnostics,
  };
}

const [, , pipelinePath] = process.argv;
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  if (!pipelinePath) {
    console.error(usage());
    process.exit(2);
  }

  try {
    const result = await auditRun(pipelinePath);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    console.error(err?.message || String(err));
    process.exit(2);
  }
}

export {
  CANDIDATE_INVENTORY_SCHEMA,
  DISCOVERY_COVERAGE_SCHEMA,
  RUN_METADATA_SCHEMA,
  auditCandidateInventory,
  auditCoverageManifest,
  auditInventoryCycleStatus,
  auditRun,
};
