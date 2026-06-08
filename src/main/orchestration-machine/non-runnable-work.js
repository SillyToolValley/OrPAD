function collectWorkText(value, options = {}) {
  const {
    depth = 0,
    seen = new Set(),
    output = [],
  } = options;
  if (output.length >= 180 || depth > 7 || value == null) return output;
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }
  if (typeof value !== 'object') return output;
  if (seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectWorkText(item, { depth: depth + 1, seen, output });
    return output;
  }
  for (const item of Object.values(value)) collectWorkText(item, { depth: depth + 1, seen, output });
  return output;
}

function isUnityGeneratedMetaWork(value) {
  const text = collectWorkText(value).join('\n');
  if (!/\.meta\b/i.test(text) || !/\bunity\b/i.test(text)) return false;
  return /\b(?:generated\s+by\s+unity|unity[-\s]?generated|unity\s+import|unity\s+has\s+imported|let\s+unity\s+generate|should\s+generate|must\s+generate|automatically\s+generate|not\s+hand[-\s]?author|do\s+not\s+hand[-\s]?author|no\s+\.meta\s+files\s+are\s+hand[-\s]?authored|cannot\s+be\s+safely\s+hand[-\s]?authored)\b/i.test(text);
}

function collectTargetFiles(value = {}) {
  const out = [];
  const append = entries => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const file = typeof entry === 'string'
        ? entry
        : (entry?.file || entry?.path || '');
      const text = String(file || '').trim().replace(/\\/g, '/');
      if (text) out.push(text);
    }
  };
  append(value.targetFiles);
  append(value.sourceOfTruthTargets);
  append(value.expectedChangedFiles);
  append(value.evidence);
  return [...new Set(out)].sort();
}

function hasPathEnding(files = [], suffix = '') {
  const needle = String(suffix || '').toLowerCase();
  return files.some(file => String(file || '').toLowerCase().endsWith(needle));
}

function workScopeText(value = {}) {
  return [
    value.title,
    value.issueType,
    value.userImpact,
    value.expectedBehavior,
    value.actualBehavior,
    ...(Array.isArray(value.acceptanceCriteria) ? value.acceptanceCriteria : []),
  ].map(item => String(item || '')).join('\n');
}

function isOversizedWorkerScope(value) {
  const text = workScopeText(value);
  const title = String(value?.title || '');
  const files = collectTargetFiles(value);
  const criteriaCount = Array.isArray(value?.acceptanceCriteria) ? value.acceptanceCriteria.length : 0;
  const editsRendererAndBaseCss = hasPathEnding(files, 'src/renderer/renderer.js')
    && hasPathEnding(files, 'src/renderer/styles/base.css');
  const e2eFileCount = files.filter(file => /(^|\/)tests\/e2e\//i.test(file)).length;
  const broadVisualLanguage = /\b(?:whole[-\s]?surface|full[-\s]?surface|entire\s+surface|overhaul|deep[-\s]?navy|glowing|hero[-\s]?style|orchestration\s+surface|readiness\s+dashboard)\b/i.test(title);
  const broadUiRewrite = /\b(?:rework|redesign|upgrade|turn|transform)\b/i.test(title)
    && /\b(?:canvas|surface|dashboard|cockpit|terminal|harness|orchestration)\b/i.test(title);
  if (editsRendererAndBaseCss && e2eFileCount >= 1 && broadVisualLanguage) return true;
  if (editsRendererAndBaseCss && criteriaCount >= 4 && /\b(?:dashboard|overhaul|deep[-\s]?navy|glowing|hero[-\s]?style|orchestration\s+surface|ui\s+surface)\b/i.test(title)) return true;
  if (files.length >= 4 && broadUiRewrite && /\b(?:overhaul|surface|dashboard|cockpit|deep[-\s]?navy|glowing|hero[-\s]?style)\b/i.test(text)) return true;
  return false;
}

function classifyNonRunnableWork(value) {
  if (isUnityGeneratedMetaWork(value)) {
    return {
      classifier: 'non-runnable-external-generation',
      reason: 'Requires Unity-generated .meta files, but the Machine worker must not hand-author Unity import output.',
    };
  }
  if (isOversizedWorkerScope(value)) {
    return {
      classifier: 'oversized-worker-scope',
      reason: 'Work item is too broad for a single worker timeout. Split it into smaller component, selector, or state-specific work items before dispatch.',
    };
  }
  return null;
}

function isNonRunnableExternalGenerationWork(value) {
  return isUnityGeneratedMetaWork(value);
}

function nonRunnableExternalGenerationReason(value) {
  return classifyNonRunnableWork(value)?.reason
    || 'Requires external generated artifacts that the Machine worker cannot safely produce in the overlay.';
}

module.exports = {
  classifyNonRunnableWork,
  collectWorkText,
  isNonRunnableExternalGenerationWork,
  isOversizedWorkerScope,
  isUnityGeneratedMetaWork,
  nonRunnableExternalGenerationReason,
};
