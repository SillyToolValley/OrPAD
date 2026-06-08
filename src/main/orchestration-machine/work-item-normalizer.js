const { SCHEMA_VERSIONS, createContractValidator } = require('./contracts');
const { assertMachineStorageId } = require('./ids');
const { normalizeLockPath } = require('./file-lock-manager');

const validator = createContractValidator();

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function evidenceIds(evidence) {
  return (evidence || [])
    .map(item => item?.id)
    .filter(Boolean)
    .map(String);
}

function evidenceFiles(evidence) {
  return [...new Set((evidence || [])
    .map(item => item?.file || item?.path)
    .filter(Boolean)
    .map(String))];
}

function normalizeTargetFiles(files) {
  if (!Array.isArray(files)) return [];
  return [...new Set(files
    .map(file => normalizeLockPath(file))
    .filter(Boolean))]
    .sort();
}

const VISUAL_REFERENCE_CANDIDATE_RE = /\b(reference[-\s]?(image|visual|style)|visual[-\s]?reference|hero|palette|theme|surface|glass|material|typography|built[-\s]?in|screenshot|before[-\s]?after)\b/i;
const VALIDATION_OR_EVIDENCE_PATH_RE = /(^|\/)(tests?|e2e|__tests__|playwright-report|test-results|coverage)(\/|$)|(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)playwright\.config\.[cm]?[jt]s$/i;

function proposalSearchText(proposal = {}) {
  return [
    proposal.title,
    proposal.contentArea,
    proposal.issueType,
    proposal.userImpact,
    proposal.expectedBehavior,
    proposal.actualBehavior,
    proposal.verificationPlan,
    ...(Array.isArray(proposal.acceptanceCriteria) ? proposal.acceptanceCriteria : []),
    ...(Array.isArray(proposal.reproSteps) ? proposal.reproSteps : []),
    ...(Array.isArray(proposal.evidence) ? proposal.evidence.flatMap(item => [
      item?.id,
      item?.file,
      item?.path,
      item?.summary,
    ]) : []),
  ].filter(Boolean).map(String).join('\n');
}

function visualReferenceCandidate(proposal = {}) {
  return VISUAL_REFERENCE_CANDIDATE_RE.test(proposalSearchText(proposal));
}

function validationOrEvidencePath(file) {
  return VALIDATION_OR_EVIDENCE_PATH_RE.test(String(file || '').replace(/\\/g, '/'));
}

function splitVisualReferenceTargetFiles(proposal = {}, targetFiles = []) {
  if (!targetFiles.length || !visualReferenceCandidate(proposal)) {
    return { targetFiles, demotedTargetFiles: [] };
  }
  const implementationTargets = targetFiles.filter(file => !validationOrEvidencePath(file));
  if (!implementationTargets.length || implementationTargets.length === targetFiles.length) {
    return { targetFiles, demotedTargetFiles: [] };
  }
  return {
    targetFiles: implementationTargets,
    demotedTargetFiles: targetFiles.filter(file => validationOrEvidencePath(file)),
  };
}

function normalizeCandidateProposal(proposal, options = {}) {
  if (proposal?.suggestedWorkItemId !== undefined) {
    assertMachineStorageId(proposal.suggestedWorkItemId, 'workItem.id');
  }
  validator.assertValid('candidateProposal', proposal);
  const now = options.now || new Date().toISOString();
  const id = assertMachineStorageId(
    proposal.suggestedWorkItemId || slugify(proposal.proposalId || proposal.title),
    'workItem.id',
  );
  const coverageEvidenceIds = proposal.coverageEvidenceIds?.length
    ? proposal.coverageEvidenceIds
    : evidenceIds(proposal.evidence);
  const explicitSourceOfTruthTargets = proposal.sourceOfTruthTargets?.length
    ? normalizeTargetFiles(proposal.sourceOfTruthTargets)
    : [];
  const evidenceSourceOfTruthTargets = normalizeTargetFiles(evidenceFiles(proposal.evidence));
  let sourceOfTruthTargets = [...new Set([
    ...explicitSourceOfTruthTargets,
    ...evidenceSourceOfTruthTargets,
  ])].sort();
  const fallbackTargetFiles = explicitSourceOfTruthTargets.length
    ? explicitSourceOfTruthTargets
    : sourceOfTruthTargets;
  const candidateTargetFiles = Object.prototype.hasOwnProperty.call(proposal, 'targetFiles')
    ? normalizeTargetFiles(proposal.targetFiles)
    : normalizeTargetFiles(fallbackTargetFiles);
  const splitTargetFiles = splitVisualReferenceTargetFiles(proposal, candidateTargetFiles);
  const targetFiles = splitTargetFiles.targetFiles;
  if (splitTargetFiles.demotedTargetFiles.length) {
    sourceOfTruthTargets = [...new Set([
      ...sourceOfTruthTargets,
      ...splitTargetFiles.demotedTargetFiles,
    ])].sort();
  }
  const expectedChangedFiles = normalizeTargetFiles(proposal.expectedChangedFiles || []);

  const workItem = {
    schemaVersion: SCHEMA_VERSIONS.workItem,
    id,
    state: 'candidate',
    title: proposal.title,
    sourceNode: proposal.sourceNode,
    contentArea: proposal.contentArea || 'unspecified',
    issueType: proposal.issueType || 'candidate-proposal',
    severity: proposal.severity || 'P3',
    confidence: proposal.confidence ?? 0.5,
    fingerprint: proposal.fingerprint,
    evidence: proposal.evidence,
    acceptanceCriteria: proposal.acceptanceCriteria,
    userImpact: proposal.userImpact || proposal.title,
    reproSteps: proposal.reproSteps?.length ? proposal.reproSteps : ['Review the candidate proposal evidence.'],
    expectedBehavior: proposal.expectedBehavior || proposal.acceptanceCriteria[0],
    actualBehavior: proposal.actualBehavior || proposal.title,
    sourceOfTruthTargets: sourceOfTruthTargets.length ? sourceOfTruthTargets : ['unresolved-source-target'],
    targetFiles,
    ...(expectedChangedFiles.length ? { expectedChangedFiles } : {}),
    verificationPlan: proposal.verificationPlan || 'Verify the accepted implementation against the candidate acceptance criteria.',
    coverageEvidenceIds: coverageEvidenceIds.length ? coverageEvidenceIds : [`${proposal.sourceNode}:proposal`],
    approvalRequired: proposal.approvalRequired === true,
    createdAt: proposal.createdAt || now,
    updatedAt: proposal.updatedAt || now,
  };

  validator.assertValid('workItem', workItem);
  return workItem;
}

module.exports = {
  normalizeCandidateProposal,
  slugify,
  splitVisualReferenceTargetFiles,
  validationOrEvidencePath,
  visualReferenceCandidate,
};
