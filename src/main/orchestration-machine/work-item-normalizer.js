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
  const sourceOfTruthTargets = proposal.sourceOfTruthTargets?.length
    ? proposal.sourceOfTruthTargets
    : evidenceFiles(proposal.evidence);
  const targetFiles = Object.prototype.hasOwnProperty.call(proposal, 'targetFiles')
    ? normalizeTargetFiles(proposal.targetFiles)
    : normalizeTargetFiles(sourceOfTruthTargets);

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
};
