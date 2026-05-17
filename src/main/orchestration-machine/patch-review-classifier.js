const { normalizeLockPath } = require('./file-lock-manager');
const { pathsOverlap } = require('./write-sets');

const PATCH_REVIEW_REASONS = Object.freeze({
  destructiveScope: 'destructive_scope',
  baseMismatch: 'base_mismatch',
  explicitReviewRequired: 'explicit_review_required',
});

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => normalizeLockPath(value))
    .filter(Boolean))].sort();
}

function changedFilesForEvent(event = {}, context = {}) {
  const payload = event?.payload || event || {};
  const patchChanges = Array.isArray(context.patch?.changes)
    ? context.patch.changes.map(change => change?.path)
    : [];
  return uniqueStrings([
    ...(Array.isArray(payload.changedFiles) ? payload.changedFiles : []),
    ...(Array.isArray(context.changedFiles) ? context.changedFiles : []),
    ...patchChanges,
  ]);
}

function declaredTargetFilesForEvent(event = {}, context = {}) {
  const payload = event?.payload || event || {};
  const declaredTargetFiles = uniqueStrings([
    ...(Array.isArray(payload.declaredTargetFiles) ? payload.declaredTargetFiles : []),
    ...(Array.isArray(context.declaredTargetFiles) ? context.declaredTargetFiles : []),
    ...(Array.isArray(context.targetFiles) ? context.targetFiles : []),
  ]);
  if (declaredTargetFiles.length) return declaredTargetFiles;
  return uniqueStrings([
    ...(Array.isArray(payload.lockTargetFiles) ? payload.lockTargetFiles : []),
    ...(Array.isArray(context.lockTargetFiles) ? context.lockTargetFiles : []),
  ]);
}

function filesOutsideDeclaredTargets(changedFiles = [], declaredTargetFiles = []) {
  if (!changedFiles.length) return [];
  if (!declaredTargetFiles.length) return [...changedFiles];
  return changedFiles.filter(file => (
    !declaredTargetFiles.some(target => pathsOverlap(file, target))
  ));
}

function decisionRequestsBaseMismatch(decision = null) {
  if (!decision) return false;
  if (decision.eventType === 'patch.apply_conflict') return true;
  return String(decision.code || '').toUpperCase() === 'PATCH_BASE_MISMATCH';
}

function decisionRequestsDestructiveScope(decision = null) {
  if (!decision) return false;
  if (decision.eventType === 'patch.apply_failed') return true;
  return String(decision.code || '').toUpperCase() === 'PATCH_WRITE_SET_VIOLATION';
}

function normalizeRequestReasons(reviewRequest = null) {
  const raw = [
    reviewRequest?.reason,
    ...(Array.isArray(reviewRequest?.reasons) ? reviewRequest.reasons : []),
  ].filter(Boolean);
  return raw.filter(reason => Object.values(PATCH_REVIEW_REASONS).includes(reason));
}

function shouldRequestPatchReview(event = {}, context = {}) {
  const payload = event?.payload || event || {};
  const reasons = [];
  const requestReasons = normalizeRequestReasons(context.reviewRequest);
  reasons.push(...requestReasons);

  if (context.reviewRequired === true || payload.reviewRequired === true) {
    reasons.push(PATCH_REVIEW_REASONS.explicitReviewRequired);
  }

  const decision = context.decision || null;
  if (decisionRequestsBaseMismatch(decision)) {
    reasons.push(PATCH_REVIEW_REASONS.baseMismatch);
  }
  if (decisionRequestsDestructiveScope(decision)) {
    reasons.push(PATCH_REVIEW_REASONS.destructiveScope);
  }

  const changedFiles = changedFilesForEvent(event, context);
  const declaredTargetFiles = declaredTargetFilesForEvent(event, context);
  if (payload.patchArtifact && changedFiles.length === 0) {
    reasons.push(PATCH_REVIEW_REASONS.destructiveScope);
  }
  const outsideTargetFiles = filesOutsideDeclaredTargets(changedFiles, declaredTargetFiles);
  if (outsideTargetFiles.length) {
    reasons.push(PATCH_REVIEW_REASONS.destructiveScope);
  }

  const uniqueReasons = [...new Set(reasons)];
  return {
    requestReview: uniqueReasons.length > 0,
    reason: uniqueReasons[0] || '',
    reasons: uniqueReasons,
    changedFiles,
    declaredTargetFiles,
    outsideTargetFiles,
    missingDeclaredTargetFiles: changedFiles.length > 0 && declaredTargetFiles.length === 0,
  };
}

module.exports = {
  PATCH_REVIEW_REASONS,
  shouldRequestPatchReview,
};
