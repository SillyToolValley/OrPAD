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

function isNonRunnableExternalGenerationWork(value) {
  return isUnityGeneratedMetaWork(value);
}

function nonRunnableExternalGenerationReason(value) {
  if (isUnityGeneratedMetaWork(value)) {
    return 'Requires Unity-generated .meta files, but the Machine worker must not hand-author Unity import output.';
  }
  return 'Requires external generated artifacts that the Machine worker cannot safely produce in the overlay.';
}

module.exports = {
  collectWorkText,
  isNonRunnableExternalGenerationWork,
  isUnityGeneratedMetaWork,
  nonRunnableExternalGenerationReason,
};
