function normalizedWorkerStatus(value) {
  return String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function workerResultHasPatchArtifact(payload = {}) {
  return Boolean(String(payload?.patchArtifact || '').trim());
}

function workerResultPatchEligibleStatus(payload = {}) {
  const status = normalizedWorkerStatus(payload.status);
  const toState = normalizedWorkerStatus(payload.toState);
  if (status && status !== 'done' && status !== 'blocked') return false;
  if (toState && toState !== 'done' && toState !== 'blocked') return false;
  return true;
}

function workerResultIsPatchReviewEligible(payload = {}) {
  if (!workerResultPatchEligibleStatus(payload)) return false;
  const status = normalizedWorkerStatus(payload.status);
  const toState = normalizedWorkerStatus(payload.toState);
  if ((status === 'blocked' || (!status && toState === 'blocked')) && workerResultHasPatchArtifact(payload)) return true;
  if (status && status !== 'done') return false;
  if (toState && toState !== 'done') return false;
  return true;
}

function workerResultRequiresManualPatchReview(payload = {}) {
  if (!workerResultPatchEligibleStatus(payload)) return false;
  const status = normalizedWorkerStatus(payload.status);
  const toState = normalizedWorkerStatus(payload.toState);
  return workerResultHasPatchArtifact(payload) && (status === 'blocked' || (!status && toState === 'blocked'));
}

module.exports = {
  normalizedWorkerStatus,
  workerResultIsPatchReviewEligible,
  workerResultPatchEligibleStatus,
  workerResultRequiresManualPatchReview,
};
