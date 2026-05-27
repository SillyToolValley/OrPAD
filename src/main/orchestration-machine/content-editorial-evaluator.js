const fs = require('fs');
const path = require('path');

const { assertNoSymlinkInRunPath, registerArtifact } = require('./artifacts');
const { normalizeLockPath } = require('./file-lock-manager');
const { loadRunPatchArtifact } = require('./patches');

const fsp = fs.promises;

const CONTENT_EDITORIAL_EVALUATION_SCHEMA_VERSION = 'orpad.contentEditorialEvaluation.v1';
const CONTENT_EDITORIAL_EVALUATOR_ID = 'orpad.content-editorial-evaluator';
const CONTENT_EDITORIAL_EVALUATOR_VERSION = '3';
const CONTENT_EDITORIAL_EVALUATION_ROOT = 'artifacts/evaluations/content-editorial/workers';
const CONTENT_EDITORIAL_JUDGE_POLICIES = new Set(['rule-only', 'rule-then-llm', 'llm-required']);

const CONTENT_TARGET_PATH_PATTERN = /(^|\/)(readme\.md|docs?|documentation|slides?|presentations?|lesson|lecture|course|tutorial|locales?|templates?)(\/|$)|\.(md|markdown|mdx|txt)$|(^|\/)[^/]*(slides?|lesson|lecture|tutorial|onboarding|course)[^/]*\.(json|html|xml|ya?ml|txt)$/i;
const PRESENTATION_PATH_PATTERN = /(^|\/)(slides?|presentations?|lecture|lesson|course)(\/|$)|(^|\/)[^/]*(slide|slides|deck|presentation|lecture)[^/]*\.(md|markdown|mdx|html|xml|ya?ml|json)$/i;
const BULLET_PATTERN = /^\s*(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)/;
const HEADING_PATTERN = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const MARKDOWN_FENCE_PATTERN = /^\s*```/;
const MARKDOWN_TABLE_PATTERN = /^\s*\|.*\|\s*$/;
const RESULT_STATUS_TEMPLATE_PATTERN = /\bpass\s*(?:\||\/)\s*fail\s*(?:\||\/)\s*blocked\b/i;
const README_EXECUTION_PATTERN = /\b(?:npm|pnpm|yarn)\s+(?:install|run|test|build|start)\b|\bdotnet\s+(?:run|test|build|restore)\b|\bpython\s+-m\b|\bpip\s+install\b|\bgo\s+(?:run|test|build)\b|\bcargo\s+(?:run|test|build)\b|\b(?:clone|checkout)\s+the\s+repo\b|\bcd\s+[\w./-]+|\bcopy\s+and\s+run\b|\brun\s+(?:this|the)\s+command\b|```(?:bash|sh|powershell|ps1|cmd)\b/i;
const AI_SCAFFOLDING_PATTERN = /\b(?:in\s+summary|in\s+conclusion|it\s+is\s+important\s+to\s+note|let'?s\s+dive\s+in|delve\s+into|robust\s+and\s+seamless|comprehensive\s+(?:guide|overview|solution)|this\s+section\s+will\s+cover|as\s+an\s+ai|generated\s+by\s+ai|model\s+language|ai-sounding|scaffolding\s+phrase)\b/i;
const CHECKLIST_GROWTH_PATTERN = /\b(?:checklist|acceptance\s+criteria|todo|must|should|ensure|verify|validate|done\s+when)\b/i;

function toPortablePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function safeSlug(value, fallback = 'worker') {
  const slug = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

function normalizeJudgePolicy(value) {
  const policy = String(value || 'rule-only').trim();
  return CONTENT_EDITORIAL_JUDGE_POLICIES.has(policy) ? policy : 'rule-only';
}

function contentTargetPath(value) {
  const portable = normalizeLockPath(value).toLowerCase();
  return Boolean(portable && CONTENT_TARGET_PATH_PATTERN.test(portable));
}

function presentationContentPath(value) {
  const portable = normalizeLockPath(value).toLowerCase();
  return Boolean(portable && PRESENTATION_PATH_PATTERN.test(portable));
}

function workerProofHasContentTarget(event) {
  return (event?.payload?.changedFiles || []).some(contentTargetPath);
}

function acceptedWorkerProofEvents(events) {
  return (events || []).filter(event => (
    event.eventType === 'worker.result'
    && event.payload?.status === 'done'
    && (
      (event.artifactRefs || []).length > 0
      || Boolean(event.payload?.patchArtifact)
    )
    && (event.payload?.verification || []).length > 0
  ));
}

function safeWorkspaceRelativePath(value) {
  const portable = normalizeLockPath(value);
  if (
    !portable
    || portable.startsWith('/')
    || /^[a-zA-Z]:\//.test(portable)
    || portable === '.'
    || portable === '..'
    || portable.startsWith('../')
    || portable.split('/').some(segment => !segment || segment === '.' || segment === '..')
  ) {
    return '';
  }
  return portable;
}

async function readWorkspaceText(workspaceRoot, filePath) {
  const safePath = safeWorkspaceRelativePath(filePath);
  if (!workspaceRoot || !safePath) return '';
  const root = path.resolve(workspaceRoot);
  const abs = path.join(root, ...safePath.split('/'));
  try {
    const rootReal = await fsp.realpath(root);
    const absReal = await fsp.realpath(abs);
    const rel = path.relative(rootReal, absReal);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
    const stat = await fsp.stat(absReal);
    if (!stat.isFile() || stat.size > 192 * 1024) return '';
    return await fsp.readFile(absReal, 'utf8');
  } catch {
    return '';
  }
}

async function readRunJsonArtifact(runRoot, artifactPath) {
  if (!runRoot || !artifactPath) return null;
  let safePath = '';
  try {
    safePath = await assertNoSymlinkInRunPath(runRoot, artifactPath);
  } catch {
    return null;
  }
  try {
    const abs = path.join(path.resolve(runRoot), ...safePath.split('/'));
    const stat = await fsp.stat(abs);
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
    return JSON.parse(await fsp.readFile(abs, 'utf8'));
  } catch {
    return null;
  }
}

function splitLines(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function wordCount(value) {
  const words = String(value || '').match(/[A-Za-z0-9_\u00c0-\uffff]+(?:[-'][A-Za-z0-9_\u00c0-\uffff]+)*/g);
  return words ? words.length : 0;
}

function isTechnicalToken(value) {
  const raw = String(value || '');
  return /^[A-Z0-9]{2,}$/.test(raw)
    || /[a-z][A-Z]/.test(raw)
    || raw.includes('_')
    || /^\d+$/.test(raw);
}

function isCodeDenseLine(value) {
  const line = String(value || '').trim();
  if (!line) return true;
  if (MARKDOWN_TABLE_PATTERN.test(line)) return true;
  if (RESULT_STATUS_TEMPLATE_PATTERN.test(line)) return true;
  if (/^(?:\$|>|PS>|C:\\|[A-Za-z]:\\|\w+@[\w.-]+[:$])\s*/.test(line)) return true;
  if (/[\\/][\w.-]+[\\/]/.test(line)) return true;
  if (/`[^`]+`/.test(line) && wordCount(line) <= 16) return true;
  const punctuation = (line.match(/[{}[\]();$=<>|]/g) || []).length;
  const words = wordCount(line);
  return words > 0 && punctuation >= Math.max(6, words);
}

function proseAnalysisLines(lines, options = {}) {
  const includeBullets = options.includeBullets !== false;
  const output = [];
  let inFence = false;
  for (const line of lines) {
    const text = String(line || '');
    if (MARKDOWN_FENCE_PATTERN.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (HEADING_PATTERN.test(trimmed)) continue;
    if (!includeBullets && BULLET_PATTERN.test(trimmed)) continue;
    if (isCodeDenseLine(trimmed)) continue;
    output.push(trimmed);
  }
  return output;
}

function sentenceCandidates(lines) {
  const candidates = [];
  let paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    candidates.push(...paragraph.join(' ').split(/(?<=[.!?])\s+/).map(item => item.trim()).filter(Boolean));
    paragraph = [];
  };
  let inFence = false;
  for (const line of lines) {
    const text = String(line || '');
    if (MARKDOWN_FENCE_PATTERN.test(text)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const trimmed = text.trim();
    if (
      !trimmed
      || HEADING_PATTERN.test(trimmed)
      || BULLET_PATTERN.test(trimmed)
      || isCodeDenseLine(trimmed)
    ) {
      flush();
      continue;
    }
    paragraph.push(trimmed);
    if (/[.!?]\s*$/.test(trimmed)) flush();
  }
  flush();
  return candidates;
}

function excerpt(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 3).trim()}...`;
}

function makeEvidenceRef(type, data = {}) {
  return {
    id: safeSlug(data.id || `${type}-${data.path || 'artifact'}-${data.lineStart || 0}`, `${type}-evidence`),
    type,
    path: toPortablePath(data.path || ''),
    hunkId: data.hunkId || '',
    lineStart: Number.isFinite(data.lineStart) ? data.lineStart : null,
    lineEnd: Number.isFinite(data.lineEnd) ? data.lineEnd : null,
    excerpt: excerpt(data.excerpt || ''),
  };
}

function diffLineParts(beforeLines, afterLines) {
  const before = beforeLines.slice(0, 900);
  const after = afterLines.slice(0, 900);
  if (before.length * after.length > 220000) {
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    return [
      ...before.map((line, index) => ({ kind: afterSet.has(line) ? 'context' : 'removed', text: line, beforeLine: index + 1, afterLine: null })),
      ...after.map((line, index) => ({ kind: beforeSet.has(line) ? 'context' : 'added', text: line, beforeLine: null, afterLine: index + 1 })),
    ].filter(part => part.kind !== 'context');
  }

  const rows = before.length + 1;
  const cols = after.length + 1;
  const dp = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      dp[i][j] = before[i] === after[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const parts = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      parts.push({ kind: 'context', text: before[i], beforeLine: i + 1, afterLine: j + 1 });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      parts.push({ kind: 'removed', text: before[i], beforeLine: i + 1, afterLine: null });
      i += 1;
    } else {
      parts.push({ kind: 'added', text: after[j], beforeLine: null, afterLine: j + 1 });
      j += 1;
    }
  }
  while (i < before.length) {
    parts.push({ kind: 'removed', text: before[i], beforeLine: i + 1, afterLine: null });
    i += 1;
  }
  while (j < after.length) {
    parts.push({ kind: 'added', text: after[j], beforeLine: null, afterLine: j + 1 });
    j += 1;
  }
  return parts;
}

function groupChangedHunks(parts, filePath) {
  const hunks = [];
  let current = null;
  let contextAfterChange = 0;
  const flush = () => {
    if (!current) return;
    current.addedLines = current.lines.filter(line => line.kind === 'added').map(line => line.text);
    current.removedLines = current.lines.filter(line => line.kind === 'removed').map(line => line.text);
    current.contextLines = current.lines.filter(line => line.kind === 'context').map(line => line.text);
    current.addedLineCount = current.addedLines.length;
    current.removedLineCount = current.removedLines.length;
    current.lines = current.lines
      .filter(line => line.kind !== 'context' || current.lines.length <= 30)
      .slice(0, 50);
    current.preview = current.lines
      .filter(line => line.kind !== 'context')
      .slice(0, 12)
      .map(line => `${line.kind === 'added' ? '+' : '-'} ${line.text}`)
      .join('\n');
    hunks.push(current);
    current = null;
    contextAfterChange = 0;
  };

  for (const part of parts) {
    const changed = part.kind === 'added' || part.kind === 'removed';
    if (changed && !current) {
      current = {
        id: `${safeSlug(filePath, 'content')}:hunk-${hunks.length + 1}`,
        path: filePath,
        beforeStart: Number.isFinite(part.beforeLine) ? part.beforeLine : null,
        beforeEnd: Number.isFinite(part.beforeLine) ? part.beforeLine : null,
        afterStart: Number.isFinite(part.afterLine) ? part.afterLine : null,
        afterEnd: Number.isFinite(part.afterLine) ? part.afterLine : null,
        lines: [],
      };
    }
    if (!current) continue;
    if (part.beforeLine !== null) {
      current.beforeStart = current.beforeStart === null ? part.beforeLine : Math.min(current.beforeStart, part.beforeLine);
      current.beforeEnd = current.beforeEnd === null ? part.beforeLine : Math.max(current.beforeEnd, part.beforeLine);
    }
    if (part.afterLine !== null) {
      current.afterStart = current.afterStart === null ? part.afterLine : Math.min(current.afterStart, part.afterLine);
      current.afterEnd = current.afterEnd === null ? part.afterLine : Math.max(current.afterEnd, part.afterLine);
    }
    current.lines.push({
      kind: part.kind,
      beforeLine: part.beforeLine,
      afterLine: part.afterLine,
      text: part.text,
    });
    if (changed) {
      contextAfterChange = 0;
    } else {
      contextAfterChange += 1;
      if (contextAfterChange >= 3) flush();
    }
  }
  flush();
  return hunks;
}

function hunksFromBeforeAfter(filePath, beforeContent, afterContent) {
  const beforeLines = splitLines(beforeContent);
  const afterLines = splitLines(afterContent);
  const parts = diffLineParts(beforeLines, afterLines);
  return groupChangedHunks(parts, filePath);
}

function hunksFromCurrentFile(filePath, content) {
  const lines = splitLines(content).filter(line => line.trim());
  if (!lines.length) return [];
  const bounded = lines.slice(0, 80);
  return [{
    id: `${safeSlug(filePath, 'content')}:current-file`,
    path: filePath,
    beforeStart: null,
    beforeEnd: null,
    afterStart: 1,
    afterEnd: bounded.length,
    addedLines: bounded,
    removedLines: [],
    contextLines: [],
    addedLineCount: bounded.length,
    removedLineCount: 0,
    lines: bounded.slice(0, 50).map((line, index) => ({
      kind: 'added',
      beforeLine: null,
      afterLine: index + 1,
      text: line,
    })),
    preview: bounded.slice(0, 12).map(line => `+ ${line}`).join('\n'),
    source: 'changed-content-file',
  }];
}

function styleSampleFromContent(content) {
  const lines = splitLines(content)
    .map(line => line.trim())
    .filter(line => line && !BULLET_PATTERN.test(line) && !HEADING_PATTERN.test(line) && line.length >= 35)
    .slice(0, 6);
  return lines.map(line => excerpt(line, 220));
}

async function collectWorkerContentDiff(input = {}, workerEvent) {
  const diagnostics = [];
  const patchArtifact = String(workerEvent?.payload?.patchArtifact || '').trim();
  const changedFiles = (workerEvent?.payload?.changedFiles || []).map(normalizeLockPath).filter(Boolean);
  const contentFiles = [...new Set(changedFiles.filter(contentTargetPath))].sort();
  const changes = [];
  let patch = null;

  if (patchArtifact) {
    try {
      patch = await loadRunPatchArtifact(input.runRoot, patchArtifact);
    } catch (err) {
      diagnostics.push({
        code: 'CONTENT_EDITORIAL_PATCH_UNREADABLE',
        message: 'Patch artifact could not be read by the OrPAD content evaluator.',
        patchArtifact,
        error: err?.code || err?.message || String(err),
      });
    }
  }

  if (patch?.changes?.length) {
    for (const change of patch.changes) {
      const filePath = normalizeLockPath(change.path);
      if (!contentTargetPath(filePath)) continue;
      if (change.contentEncoding === 'base64' || change.afterContentBase64 || change.beforeContentBase64) {
        diagnostics.push({
          code: 'CONTENT_EDITORIAL_BINARY_CONTENT_SKIPPED',
          message: 'Binary or base64 content change skipped by editorial evaluator.',
          path: filePath,
        });
        continue;
      }
      changes.push({
        path: filePath,
        source: 'patch-artifact',
        beforeExists: change.beforeExists !== false,
        afterExists: change.afterExists !== false,
        beforeContent: change.beforeContent || '',
        afterContent: change.afterContent || '',
        beforeSha256: change.beforeSha256 || '',
        afterSha256: change.afterSha256 || '',
      });
    }
  }

  const patchedPaths = new Set(changes.map(change => change.path));
  for (const filePath of contentFiles) {
    if (patchedPaths.has(filePath)) continue;
    const current = await readWorkspaceText(input.workspaceRoot, filePath);
    if (!current) {
      diagnostics.push({
        code: 'CONTENT_EDITORIAL_CHANGED_FILE_UNREADABLE',
        message: 'Changed content file could not be read by the OrPAD content evaluator.',
        path: filePath,
      });
      continue;
    }
    changes.push({
      path: filePath,
      source: 'changed-content-file',
      beforeExists: null,
      afterExists: true,
      beforeContent: '',
      afterContent: current,
      beforeSha256: '',
      afterSha256: '',
    });
  }

  const changedHunks = [];
  const styleSample = [];
  for (const change of changes) {
    const hunks = change.source === 'patch-artifact'
      ? hunksFromBeforeAfter(change.path, change.beforeContent, change.afterContent)
      : hunksFromCurrentFile(change.path, change.afterContent);
    for (const hunk of hunks) {
      changedHunks.push({
        ...hunk,
        source: change.source,
        presentationContent: presentationContentPath(change.path),
      });
    }
    styleSample.push(...styleSampleFromContent(change.beforeContent || change.afterContent));
  }

  return {
    patchArtifact,
    changedFiles,
    contentFiles,
    changes: changes.map(change => ({
      path: change.path,
      source: change.source,
      beforeExists: change.beforeExists,
      afterExists: change.afterExists,
      beforeSha256: change.beforeSha256,
      afterSha256: change.afterSha256,
    })),
    changedHunks: changedHunks.slice(0, 24),
    styleSample: [...new Set(styleSample)].slice(0, 8),
    diagnostics,
  };
}

function countDuplicateHeadings(lines) {
  const counts = new Map();
  for (const line of lines) {
    const match = HEADING_PATTERN.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, ' ').trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1);
}

function repeatedPhrases(lines) {
  const counts = new Map();
  const stop = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you', 'are', 'will']);
  for (const line of proseAnalysisLines(lines)) {
    const tokens = (line.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) || [])
      .map((raw, index) => ({
        raw,
        lower: raw.toLowerCase(),
        index,
      }));
    const words = tokens.filter(token => token.lower.length > 2 && !stop.has(token.lower));
    const seenInLine = new Set();
    for (let size = 3; size <= 5; size += 1) {
      for (let index = 0; index <= words.length - size; index += 1) {
        const span = words.slice(index, index + size);
        const start = span[0].index;
        const end = span[span.length - 1].index;
        const nearby = tokens.slice(Math.max(0, start - 1), Math.min(tokens.length, end + 2));
        if (nearby.some(token => isTechnicalToken(token.raw))) continue;
        const phrase = span.map(token => token.lower).join(' ');
        if (seenInLine.has(phrase)) continue;
        seenInLine.add(phrase);
        counts.set(phrase, (counts.get(phrase) || 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .filter(([phrase, count]) => count >= 3 && phrase.length >= 14)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
}

function checkResult(id, label, passed, severity, reason, evidenceRefs = [], requiredFixes = []) {
  return {
    id,
    label,
    passed: Boolean(passed),
    severity,
    reason,
    evidenceRefs,
    requiredFixes,
  };
}

function ruleScores(checks) {
  const failed = new Set(checks.filter(check => !check.passed).map(check => check.id));
  return {
    voiceTone: failed.has('ai-scaffolding-phrase') || failed.has('duplicate-heading-or-repeated-phrase') ? 1 : 3,
    density: failed.has('bullet-list-density') || failed.has('long-sentence-or-bullet') || failed.has('checklist-growth-only') ? 1 : 3,
    roleSeparation: failed.has('readme-instructions-in-presentation') ? 1 : 3,
    beforeAfter: failed.has('before-after-rewrite-evidence') || failed.has('checklist-growth-only') ? 1 : 3,
  };
}

function analyzeContentDiffRules(workerDiff) {
  const hunks = workerDiff.changedHunks || [];
  const addedLines = hunks.flatMap(hunk => hunk.addedLines || []).filter(line => line.trim());
  const removedLines = hunks.flatMap(hunk => hunk.removedLines || []).filter(line => line.trim());
  const allChangedLines = [...addedLines, ...removedLines];
  const bulletLines = addedLines.filter(line => BULLET_PATTERN.test(line));
  const bulletRatio = addedLines.length ? bulletLines.length / addedLines.length : 0;
  const longBullets = bulletLines
    .map(line => ({ line, words: wordCount(line) }))
    .filter(item => item.words > 34);
  const longSentences = sentenceCandidates(addedLines)
    .map(line => ({ line, words: wordCount(line) }))
    .filter(item => item.words > 42);
  const duplicateHeadings = countDuplicateHeadings(addedLines);
  const repeated = repeatedPhrases(addedLines);
  const scaffoldingMatches = addedLines.filter(line => AI_SCAFFOLDING_PATTERN.test(line));
  const slideInstructionHunks = hunks.filter(hunk => (
    hunk.presentationContent
    && (hunk.addedLines || []).some(line => README_EXECUTION_PATTERN.test(line))
  ));
  const checklistGrowthOnly = addedLines.length >= 3
    && removedLines.length === 0
    && bulletLines.length >= 2
    && (bulletRatio >= 0.45 || addedLines.some(line => CHECKLIST_GROWTH_PATTERN.test(line)));
  const hasRewriteEvidence = removedLines.length > 0 && addedLines.length > 0;
  const checks = [];

  checks.push(checkResult(
    'content-hunks-present',
    'Content diff hunks are available',
    hunks.length > 0,
    'error',
    hunks.length ? 'content-hunks-present' : 'content-hunks-missing',
    hunks.length ? [makeEvidenceRef('changed-hunk', {
      id: 'content-hunks-present',
      path: hunks[0].path,
      hunkId: hunks[0].id,
      lineStart: hunks[0].afterStart,
      lineEnd: hunks[0].afterEnd,
      excerpt: hunks[0].preview,
    })] : [],
    ['Provide a registered patch artifact or readable changed content files for the content worker.'],
  ));

  checks.push(checkResult(
    'bullet-list-density',
    'Bullet/list density stays editorially useful',
    !(addedLines.length >= 6 && bulletRatio > 0.68),
    'error',
    `added bullet ratio ${bulletRatio.toFixed(2)} (${bulletLines.length}/${addedLines.length || 0})`,
    bulletLines.slice(0, 3).map((line, index) => makeEvidenceRef('added-line', {
      id: `bullet-density-${index + 1}`,
      path: hunks.find(hunk => (hunk.addedLines || []).includes(line))?.path || '',
      excerpt: line,
    })),
    ['Convert checklist-like additions into prose, examples, or shorter slide/section content.'],
  ));

  checks.push(checkResult(
    'long-sentence-or-bullet',
    'Long sentences and bullets are bounded',
    longBullets.length === 0 && longSentences.length === 0,
    'warning',
    longBullets.length || longSentences.length
      ? 'long sentence or bullet found'
      : 'sentence and bullet length within limits',
    [...longBullets, ...longSentences].slice(0, 4).map((item, index) => makeEvidenceRef('added-line', {
      id: `long-line-${index + 1}`,
      path: hunks.find(hunk => (hunk.addedLines || []).includes(item.line))?.path || '',
      excerpt: item.line,
    })),
    ['Split long bullets/sentences and keep one teaching point per sentence or list item.'],
  ));

  checks.push(checkResult(
    'duplicate-heading-or-repeated-phrase',
    'Duplicate headings and repeated phrases are avoided',
    duplicateHeadings.length === 0 && repeated.length === 0,
    'warning',
    duplicateHeadings.length || repeated.length
      ? 'duplicate heading or repeated phrase found'
      : 'no duplicate heading or repeated phrase found',
    [
      ...duplicateHeadings.slice(0, 3).map(([heading], index) => makeEvidenceRef('added-line', {
        id: `duplicate-heading-${index + 1}`,
        excerpt: heading,
      })),
      ...repeated.slice(0, 3).map(([phrase], index) => makeEvidenceRef('added-line', {
        id: `repeated-phrase-${index + 1}`,
        excerpt: phrase,
      })),
    ],
    ['Merge duplicate headings and rewrite repeated phrasing instead of restating the same scaffold.'],
  ));

  checks.push(checkResult(
    'ai-scaffolding-phrase',
    'AI-like scaffolding phrases are absent',
    scaffoldingMatches.length === 0,
    'error',
    scaffoldingMatches.length ? 'ai-like scaffolding phrase found' : 'no ai-like scaffolding phrase found',
    scaffoldingMatches.slice(0, 4).map((line, index) => makeEvidenceRef('added-line', {
      id: `ai-scaffold-${index + 1}`,
      path: hunks.find(hunk => (hunk.addedLines || []).includes(line))?.path || '',
      excerpt: line,
    })),
    ['Remove generic model meta-language and write in the surrounding material voice.'],
  ));

  checks.push(checkResult(
    'readme-instructions-in-presentation',
    'README execution instructions stay out of slide/presentation content',
    slideInstructionHunks.length === 0,
    'error',
    slideInstructionHunks.length ? 'readme-style execution instruction found in presentation content' : 'presentation role separation preserved',
    slideInstructionHunks.slice(0, 4).map((hunk, index) => makeEvidenceRef('changed-hunk', {
      id: `slide-readme-instruction-${index + 1}`,
      path: hunk.path,
      hunkId: hunk.id,
      lineStart: hunk.afterStart,
      lineEnd: hunk.afterEnd,
      excerpt: hunk.preview,
    })),
    ['Move runnable commands to README/lab handout material unless the slide is explicitly a lab instruction sheet.'],
  ));

  checks.push(checkResult(
    'before-after-rewrite-evidence',
    'Before/after rewrite evidence exists in the diff',
    hasRewriteEvidence,
    'error',
    hasRewriteEvidence ? 'diff contains additions and removals' : 'diff lacks removal, merge, or rewrite evidence',
    hasRewriteEvidence ? [makeEvidenceRef('changed-hunk', {
      id: 'before-after-diff-evidence',
      path: hunks.find(hunk => hunk.addedLineCount && hunk.removedLineCount)?.path || hunks[0]?.path || '',
      hunkId: hunks.find(hunk => hunk.addedLineCount && hunk.removedLineCount)?.id || '',
      excerpt: hunks.find(hunk => hunk.addedLineCount && hunk.removedLineCount)?.preview || '',
    })] : [],
    ['Rewrite, merge, or remove low-value prose; do not provide only additive editorial claims.'],
  ));

  checks.push(checkResult(
    'checklist-growth-only',
    'Checklist-only additions without rewrite are rejected',
    !checklistGrowthOnly,
    'error',
    checklistGrowthOnly ? 'only additive checklist/list growth detected' : 'not checklist-only growth',
    checklistGrowthOnly ? bulletLines.slice(0, 4).map((line, index) => makeEvidenceRef('added-line', {
      id: `checklist-growth-${index + 1}`,
      path: hunks.find(hunk => (hunk.addedLines || []).includes(line))?.path || '',
      excerpt: line,
    })) : [],
    ['Reduce, consolidate, or rewrite existing prose instead of adding checklist-only content.'],
  ));

  const failedChecks = checks.filter(check => !check.passed);
  const scores = ruleScores(checks);
  return {
    passed: failedChecks.length === 0,
    scores,
    metrics: {
      changedFileCount: workerDiff.contentFiles.length,
      hunkCount: hunks.length,
      addedLineCount: addedLines.length,
      removedLineCount: removedLines.length,
      bulletLineCount: bulletLines.length,
      bulletLineRatio: Number(bulletRatio.toFixed(3)),
      maxSentenceWords: Math.max(0, ...sentenceCandidates(addedLines).map(wordCount)),
      maxBulletWords: Math.max(0, ...bulletLines.map(wordCount)),
      duplicateHeadingCount: duplicateHeadings.length,
      repeatedPhraseCount: repeated.length,
      scaffoldingPhraseCount: scaffoldingMatches.length,
      readmeInstructionInSlidesCount: slideInstructionHunks.length,
      checklistGrowthOnly,
    },
    checks,
    findings: failedChecks.map(check => ({
      checkId: check.id,
      severity: check.severity,
      message: check.reason,
      evidenceRefs: check.evidenceRefs.map(ref => ref.id),
    })),
    evidenceRefs: checks.flatMap(check => check.evidenceRefs).slice(0, 24),
    requiredFixes: [...new Set(failedChecks.flatMap(check => check.requiredFixes))],
    changedHunks: hunks.map(hunk => ({
      id: hunk.id,
      path: hunk.path,
      beforeStart: hunk.beforeStart,
      beforeEnd: hunk.beforeEnd,
      afterStart: hunk.afterStart,
      afterEnd: hunk.afterEnd,
      addedLineCount: hunk.addedLineCount,
      removedLineCount: hunk.removedLineCount,
      presentationContent: Boolean(hunk.presentationContent),
      preview: excerpt(hunk.preview, 600),
    })).slice(0, 16),
    analyzedLineSample: allChangedLines.slice(0, 20).map(line => excerpt(line, 160)),
  };
}

function nodePackRubricFromConfig(config = {}, criteria = []) {
  const rubric = [];
  if (Array.isArray(config.nodePackRubric)) rubric.push(...config.nodePackRubric);
  if (Array.isArray(config.criteria)) rubric.push(...config.criteria);
  if (Array.isArray(criteria)) rubric.push(...criteria);
  if (Array.isArray(config.qualityDimensions)) rubric.push(...config.qualityDimensions);
  return [...new Set(rubric.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 12);
}

function buildContentEditorialJudgeInput(input = {}) {
  const ruleResult = input.ruleResult || {};
  return {
    schemaVersion: 'orpad.contentEditorialJudgeInput.v1',
    evaluationKind: 'content-editorial-quality',
    worker: input.worker || {},
    ruleResult: {
      passed: Boolean(ruleResult.passed),
      scores: ruleResult.scores || {},
      metrics: ruleResult.metrics || {},
      findings: (ruleResult.findings || []).slice(0, 12),
      requiredFixes: (ruleResult.requiredFixes || []).slice(0, 12),
      evidenceRefs: (ruleResult.evidenceRefs || []).slice(0, 18),
    },
    changedHunks: (ruleResult.changedHunks || []).slice(0, 12),
    styleSample: (input.styleSample || []).slice(0, 8),
    nodePackRubric: (input.nodePackRubric || []).slice(0, 12),
    responseContract: {
      format: 'json-only',
      requiredFields: [
        'passed',
        'scores.voiceTone',
        'scores.density',
        'scores.roleSeparation',
        'scores.beforeAfter',
        'findings[]',
        'evidenceRefs[]',
        'requiredFixes[]',
      ],
      evidenceRule: 'Judgments without evidenceRefs are failed or weak evidence.',
    },
  };
}

function contentEditorialJudgePrompt(judgeInput) {
  return [
    'Return exactly one JSON object. No markdown, no prose outside JSON.',
    'Judge only the supplied OrPAD content-editorial evidence. Do not infer from missing full files.',
    'Use this schema:',
    JSON.stringify({
      passed: false,
      scores: { voiceTone: 0, density: 0, roleSeparation: 0, beforeAfter: 0 },
      findings: [],
      evidenceRefs: [],
      requiredFixes: [],
      skipped: false,
      blockedReason: '',
      skippedReason: '',
    }, null, 2),
    'Evidence refs must cite supplied ruleResult.evidenceRefs or changedHunks ids.',
    JSON.stringify(judgeInput, null, 2),
  ].join('\n');
}

function normalizeScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(3, number));
}

function normalizeJudgeResult(raw, source = 'adapter') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      status: 'blocked',
      passed: false,
      skipped: false,
      blockedReason: 'judge result was not a JSON object',
      source,
      scores: { voiceTone: 0, density: 0, roleSeparation: 0, beforeAfter: 0 },
      findings: [],
      evidenceRefs: [],
      requiredFixes: ['Provide a JSON-only content editorial judge result.'],
      weakEvidence: true,
    };
  }
  const skipped = raw.skipped === true;
  const blockedReason = String(raw.blockedReason || raw.blocked || '').trim();
  const skippedReason = String(raw.skippedReason || '').trim();
  const evidenceRefs = Array.isArray(raw.evidenceRefs)
    ? raw.evidenceRefs.map(item => String(item || '').trim()).filter(Boolean).slice(0, 30)
    : [];
  const findings = Array.isArray(raw.findings)
    ? raw.findings.map(item => (typeof item === 'string' ? { message: item } : item)).filter(Boolean).slice(0, 30)
    : [];
  const requiredFixes = Array.isArray(raw.requiredFixes)
    ? raw.requiredFixes.map(item => String(item || '').trim()).filter(Boolean).slice(0, 30)
    : [];
  const weakEvidence = !skipped && !blockedReason && evidenceRefs.length === 0;
  return {
    status: blockedReason ? 'blocked' : (skipped ? 'skipped' : 'completed'),
    passed: Boolean(raw.passed) && !weakEvidence && !blockedReason && !skipped,
    skipped,
    blocked: Boolean(blockedReason),
    blockedReason,
    skippedReason,
    source,
    scores: {
      voiceTone: normalizeScore(raw.scores?.voiceTone),
      density: normalizeScore(raw.scores?.density),
      roleSeparation: normalizeScore(raw.scores?.roleSeparation),
      beforeAfter: normalizeScore(raw.scores?.beforeAfter),
    },
    findings,
    evidenceRefs,
    requiredFixes: weakEvidence
      ? [...requiredFixes, 'Judge result must include evidenceRefs tied to supplied hunks or rule evidence.']
      : requiredFixes,
    weakEvidence,
  };
}

function enforceJudgeEvidenceRefsForInput(judge, judgeInput) {
  if (!judge || judge.status !== 'completed') return judge;
  const allowedRefs = new Set([
    ...(judgeInput.ruleResult?.evidenceRefs || []).map(ref => ref.id).filter(Boolean),
    ...(judgeInput.changedHunks || []).map(hunk => hunk.id).filter(Boolean),
  ]);
  const invalidEvidenceRefs = (judge.evidenceRefs || []).filter(ref => !allowedRefs.has(ref));
  if (!invalidEvidenceRefs.length) return judge;
  return {
    ...judge,
    passed: false,
    weakEvidence: true,
    invalidEvidenceRefs,
    requiredFixes: [
      ...(judge.requiredFixes || []),
      'Judge evidenceRefs must cite evidence or changed hunk ids from the same worker evaluation input.',
    ],
  };
}

function expandJudgeArtifactPathTemplate(value, worker = {}) {
  const workerId = safeSlug(worker.itemId || worker.adapterCallId || `event-${worker.eventSequence ?? 'unknown'}`, 'worker');
  return String(value || '')
    .replace(/<worker-id>/g, workerId)
    .replace(/<item-id>/g, safeSlug(worker.itemId || workerId, workerId))
    .replace(/<adapter-call-id>/g, safeSlug(worker.adapterCallId || workerId, workerId))
    .replace(/<attempt-id>/g, safeSlug(worker.attemptId || workerId, workerId))
    .replace(/<event-sequence>/g, String(worker.eventSequence ?? 'unknown'));
}

function configuredJudgeArtifactPaths(config = {}, worker = {}) {
  const paths = [];
  const candidates = [
    config.judgeArtifact,
    config.judgeResultArtifact,
    config.expectedJudgeArtifact,
    ...(Array.isArray(config.judgeArtifacts) ? config.judgeArtifacts : []),
    ...(Array.isArray(config.judgeResultArtifacts) ? config.judgeResultArtifacts : []),
    ...(Array.isArray(config.expectedJudgeArtifacts) ? config.expectedJudgeArtifacts : []),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      paths.push(expandJudgeArtifactPathTemplate(candidate, worker));
    } else if (candidate && typeof candidate === 'object') {
      const sequenceMatches = candidate.workerEventSequence === undefined
        || Number(candidate.workerEventSequence) === Number(worker.eventSequence);
      const itemMatches = !candidate.itemId || candidate.itemId === worker.itemId;
      if (sequenceMatches && itemMatches) paths.push(expandJudgeArtifactPathTemplate(candidate.path || candidate.artifactPath || '', worker));
    }
  }
  return [...new Set(paths.map(toPortablePath).filter(Boolean))];
}

async function runContentEditorialJudge(input = {}) {
  const policy = normalizeJudgePolicy(input.judgePolicy);
  if (policy === 'rule-only') {
    return {
      status: 'skipped',
      passed: true,
      skipped: true,
      blocked: false,
      skippedReason: 'judgePolicy rule-only',
      blockedReason: '',
      source: 'policy',
      scores: input.ruleResult?.scores || { voiceTone: 0, density: 0, roleSeparation: 0, beforeAfter: 0 },
      findings: [],
      evidenceRefs: [],
      requiredFixes: [],
      weakEvidence: false,
    };
  }

  const judgeInput = buildContentEditorialJudgeInput(input);
  const artifactPaths = configuredJudgeArtifactPaths(input.config || {}, input.worker || {});
  for (const artifactPath of artifactPaths) {
    const raw = await readRunJsonArtifact(input.runRoot, artifactPath);
    if (!raw) continue;
    return {
      ...enforceJudgeEvidenceRefsForInput(normalizeJudgeResult(raw, artifactPath), judgeInput),
      inputSummary: {
        changedHunkCount: judgeInput.changedHunks.length,
        styleSampleCount: judgeInput.styleSample.length,
        rubricCount: judgeInput.nodePackRubric.length,
      },
    };
  }

  const adapter = input.judgeAdapter;
  if (adapter && typeof adapter.invoke === 'function') {
    try {
      const rawResult = await adapter.invoke({
        prompt: contentEditorialJudgePrompt(judgeInput),
        input: judgeInput,
        responseFormat: 'json-only',
      });
      const parsed = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
      return {
        ...enforceJudgeEvidenceRefsForInput(normalizeJudgeResult(parsed, 'adapter'), judgeInput),
        inputSummary: {
          changedHunkCount: judgeInput.changedHunks.length,
          styleSampleCount: judgeInput.styleSample.length,
          rubricCount: judgeInput.nodePackRubric.length,
        },
      };
    } catch (err) {
      return {
        status: 'blocked',
        passed: false,
        skipped: false,
        blocked: true,
        blockedReason: `LLM judge adapter failed: ${err?.message || err}`,
        skippedReason: '',
        source: 'adapter',
        scores: { voiceTone: 0, density: 0, roleSeparation: 0, beforeAfter: 0 },
        findings: [],
        evidenceRefs: [],
        requiredFixes: policy === 'llm-required' ? ['Provide a valid JSON-only LLM judge artifact or fix the judge adapter.'] : [],
        weakEvidence: true,
        inputSummary: {
          changedHunkCount: judgeInput.changedHunks.length,
          styleSampleCount: judgeInput.styleSample.length,
          rubricCount: judgeInput.nodePackRubric.length,
        },
      };
    }
  }

  return {
    status: 'blocked',
    passed: false,
    skipped: false,
    blocked: true,
    blockedReason: 'No content editorial LLM judge adapter or judge artifact is configured.',
    skippedReason: '',
    source: 'none',
    scores: { voiceTone: 0, density: 0, roleSeparation: 0, beforeAfter: 0 },
    findings: [],
    evidenceRefs: [],
    requiredFixes: policy === 'llm-required' ? ['Configure a content editorial LLM judge or attach a judge artifact.'] : [],
    weakEvidence: true,
    inputSummary: {
      changedHunkCount: judgeInput.changedHunks.length,
      styleSampleCount: judgeInput.styleSample.length,
      rubricCount: judgeInput.nodePackRubric.length,
    },
  };
}

function workerIdentity(workerEvent) {
  const payload = workerEvent?.payload || {};
  const sequence = workerEvent?.sequence ?? null;
  return {
    eventSequence: sequence,
    nodePath: workerEvent?.nodePath || '',
    itemId: workerEvent?.itemId || payload.itemId || '',
    adapterCallId: payload.adapterCallId || '',
    attemptId: payload.attemptId || '',
    patchArtifact: payload.patchArtifact || '',
    changedFiles: Array.isArray(payload.changedFiles) ? payload.changedFiles.map(normalizeLockPath).filter(Boolean) : [],
  };
}

function evaluationArtifactPath(worker) {
  const key = safeSlug(worker.itemId || worker.adapterCallId || `event-${worker.eventSequence ?? 'unknown'}`, 'worker');
  const suffix = worker.eventSequence === null || worker.eventSequence === undefined
    ? key
    : `${key}-seq-${worker.eventSequence}`;
  return `${CONTENT_EDITORIAL_EVALUATION_ROOT}/${suffix}.json`;
}

function evaluationArtifactRegisteredByOrpad(event, worker) {
  const file = event?.payload?.file || {};
  if (
    event?.eventType !== 'artifact.registered'
    || file.schemaVersion !== CONTENT_EDITORIAL_EVALUATION_SCHEMA_VERSION
    || file.producedBy !== CONTENT_EDITORIAL_EVALUATOR_ID
  ) {
    return false;
  }
  const pathMatches = file.path === evaluationArtifactPath(worker);
  return pathMatches || String(file.path || '').startsWith(`${CONTENT_EDITORIAL_EVALUATION_ROOT}/`);
}

async function readExistingEvaluationArtifact(input = {}, worker) {
  const events = input.events || [];
  const expectedJudgePolicy = normalizeJudgePolicy(input.config?.judgePolicy);
  const candidates = [...events].reverse().filter(event => evaluationArtifactRegisteredByOrpad(event, worker));
  for (const event of candidates) {
    const filePath = event?.payload?.file?.path;
    const artifact = await readRunJsonArtifact(input.runRoot, filePath);
    if (
      artifact?.schemaVersion === CONTENT_EDITORIAL_EVALUATION_SCHEMA_VERSION
      && String(artifact?.evaluator?.version || '') === CONTENT_EDITORIAL_EVALUATOR_VERSION
      && Number(artifact?.worker?.eventSequence) === Number(worker.eventSequence)
      && artifact?.worker?.nodePath === worker.nodePath
      && normalizeJudgePolicy(artifact?.policy?.judgePolicy) === expectedJudgePolicy
    ) {
      return { artifactPath: filePath, evaluation: artifact, reused: true };
    }
  }
  return null;
}

function overallFromRuleAndJudge(ruleResult, judge, judgePolicy) {
  const residualRisks = [];
  let passed = Boolean(ruleResult.passed);
  const requiredFixes = [...ruleResult.requiredFixes];
  if (judgePolicy === 'llm-required') {
    if (judge.status !== 'completed') {
      passed = false;
      requiredFixes.push('LLM judge result is required by judgePolicy but is missing or blocked.');
    } else if (!judge.passed) {
      passed = false;
      requiredFixes.push(...judge.requiredFixes);
    }
  } else if (judgePolicy === 'rule-then-llm') {
    if (judge.status === 'completed') {
      if (!judge.passed) {
        passed = false;
        requiredFixes.push(...judge.requiredFixes);
      }
    } else if (judge.status === 'blocked') {
      residualRisks.push(`LLM judge blocked; gate used deterministic rule-only result. Reason: ${judge.blockedReason}`);
    }
  }
  if (judge.weakEvidence && judge.status === 'completed') {
    passed = false;
    requiredFixes.push('LLM judge result has weak evidence because evidenceRefs is empty.');
  }
  return {
    passed,
    residualRisks,
    requiredFixes: [...new Set(requiredFixes.filter(Boolean))],
  };
}

async function createWorkerEvaluationArtifact(input = {}, workerEvent) {
  const config = input.config || {};
  const worker = workerIdentity(workerEvent);
  const existing = await readExistingEvaluationArtifact(input, worker);
  if (existing) return existing;

  const judgePolicy = normalizeJudgePolicy(config.judgePolicy);
  const workerDiff = await collectWorkerContentDiff(input, workerEvent);
  const ruleResult = analyzeContentDiffRules(workerDiff);
  const nodePackRubric = nodePackRubricFromConfig(config, input.criteria || []);
  const judge = await runContentEditorialJudge({
    runRoot: input.runRoot,
    config,
    worker,
    ruleResult,
    changedHunks: ruleResult.changedHunks,
    styleSample: workerDiff.styleSample,
    nodePackRubric,
    judgePolicy,
    judgeAdapter: input.judgeAdapter || null,
  });
  const overall = overallFromRuleAndJudge(ruleResult, judge, judgePolicy);
  const evaluation = {
    schemaVersion: CONTENT_EDITORIAL_EVALUATION_SCHEMA_VERSION,
    evaluationKind: 'content-editorial-quality',
    createdAt: input.now || new Date().toISOString(),
    evaluator: {
      id: CONTENT_EDITORIAL_EVALUATOR_ID,
      version: CONTENT_EDITORIAL_EVALUATOR_VERSION,
      ownership: 'orpad-machine',
    },
    worker,
    policy: {
      evaluationMode: 'content-editorial-quality',
      judgePolicy,
    },
    inputs: {
      patchArtifact: workerDiff.patchArtifact,
      changedFiles: workerDiff.changedFiles,
      contentFiles: workerDiff.contentFiles,
      contentChangeCount: workerDiff.changes.length,
      diagnostics: workerDiff.diagnostics,
      styleSample: workerDiff.styleSample,
      nodePackRubric,
    },
    ruleResult,
    judge,
    overall,
  };
  const artifactPath = evaluationArtifactPath(worker);
  if (input.runRoot && input.runId) {
    await registerArtifact(input.runRoot, {
      runId: input.runId,
      artifactPath,
      content: `${JSON.stringify(evaluation, null, 2)}\n`,
      producedBy: CONTENT_EDITORIAL_EVALUATOR_ID,
      registeredBy: 'machine',
      schemaVersion: CONTENT_EDITORIAL_EVALUATION_SCHEMA_VERSION,
    });
  }
  return { artifactPath, evaluation, reused: false };
}

function gateEvaluationFromWorkerEvaluation(entry) {
  const evaluation = entry.evaluation || {};
  const worker = evaluation.worker || {};
  const overall = evaluation.overall || {};
  const ruleResult = evaluation.ruleResult || {};
  const judge = evaluation.judge || {};
  const failedRuleChecks = (ruleResult.checks || []).filter(check => !check.passed);
  const reason = overall.passed
    ? 'content-editorial-evaluation-passed'
    : (failedRuleChecks[0]?.id || (judge.status !== 'completed' && evaluation.policy?.judgePolicy === 'llm-required'
      ? 'llm-judge-required-missing'
      : 'content-editorial-evaluation-failed'));
  return {
    criterion: 'worker content editorial evaluation artifact passes',
    supported: true,
    passed: Boolean(overall.passed),
    reason,
    workerEventSequence: worker.eventSequence ?? null,
    workerNodePath: worker.nodePath || '',
    itemId: worker.itemId || '',
    artifactPath: entry.artifactPath || '',
    reusedEvaluationArtifact: Boolean(entry.reused),
    judgePolicy: evaluation.policy?.judgePolicy || 'rule-only',
    rulePassed: Boolean(ruleResult.passed),
    judgeStatus: judge.status || '',
    residualRisks: overall.residualRisks || [],
    requiredFixes: overall.requiredFixes || [],
    failedChecks: failedRuleChecks.map(check => ({
      id: check.id,
      reason: check.reason,
      evidenceRefs: (check.evidenceRefs || []).map(ref => ref.id),
    })),
  };
}

function aggregateEvaluation(label, passed, reason, details = {}) {
  return {
    criterion: label,
    supported: true,
    passed: Boolean(passed),
    reason,
    ...details,
  };
}

async function evaluateContentEditorialQualityGate(input = {}) {
  const events = input.events || [];
  const runId = input.runId || events.find(event => event?.runId)?.runId || '';
  const config = input.config || {};
  const judgePolicy = normalizeJudgePolicy(config.judgePolicy);
  const proofEvents = acceptedWorkerProofEvents(events);
  const contentProofs = proofEvents.filter(workerProofHasContentTarget);
  if (proofEvents.length > 0 && contentProofs.length === 0) {
    return [aggregateEvaluation(
      'content editorial evaluation applicability',
      true,
      'no-content-target-worker-result',
      { workerProofCount: proofEvents.length, contentWorkerCount: 0 },
    )];
  }

  const workerEntries = [];
  for (const event of contentProofs) {
    workerEntries.push(await createWorkerEvaluationArtifact({
      ...input,
      runId,
      config,
      judgeAdapter: input.contentEditorialJudgeAdapter || input.judgeAdapter || null,
    }, event));
  }
  const workerEvaluations = workerEntries.map(gateEvaluationFromWorkerEvaluation);
  const failedWorkers = workerEvaluations.filter(item => !item.passed);
  const residualRisks = workerEvaluations.flatMap(item => item.residualRisks || []);
  return [
    aggregateEvaluation(
      'accepted worker proof exists',
      proofEvents.length > 0,
      proofEvents.length ? 'worker-proof-accepted' : 'worker-proof-missing',
      {
        eventSequences: proofEvents.map(event => event.sequence ?? null).filter(value => value !== null),
      },
    ),
    aggregateEvaluation(
      'content-target workers have OrPAD-owned editorial evaluation artifacts',
      contentProofs.length > 0 && workerEntries.length === contentProofs.length,
      contentProofs.length > 0 ? 'content-editorial-evaluation-artifacts-present' : 'content-editorial-evaluation-artifacts-missing',
      {
        judgePolicy,
        contentWorkerCount: contentProofs.length,
        evaluationArtifactPaths: workerEntries.map(entry => entry.artifactPath),
      },
    ),
    ...workerEvaluations,
    aggregateEvaluation(
      'content editorial residual risk recorded',
      true,
      residualRisks.length ? 'residual-risk-recorded' : 'no-residual-risk',
      { residualRisks },
    ),
    aggregateEvaluation(
      'each content worker independently passes editorial evaluation',
      contentProofs.length > 0 && failedWorkers.length === 0,
      failedWorkers.length ? 'content-worker-editorial-evaluation-failed' : 'content-workers-editorial-evaluation-passed',
      {
        failedWorkerEventSequences: failedWorkers.map(item => item.workerEventSequence).filter(value => value !== null),
        failedWorkerCount: failedWorkers.length,
      },
    ),
  ];
}

module.exports = {
  CONTENT_EDITORIAL_EVALUATION_ROOT,
  CONTENT_EDITORIAL_EVALUATION_SCHEMA_VERSION,
  CONTENT_EDITORIAL_EVALUATOR_ID,
  acceptedWorkerProofEvents,
  analyzeContentDiffRules,
  buildContentEditorialJudgeInput,
  contentEditorialJudgePrompt,
  contentTargetPath,
  createWorkerEvaluationArtifact,
  evaluateContentEditorialQualityGate,
  normalizeJudgePolicy,
  normalizeJudgeResult,
  runContentEditorialJudge,
  workerProofHasContentTarget,
};
