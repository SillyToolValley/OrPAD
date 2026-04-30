const { createAdapterRequest, runProposalOnlyAdapter } = require('./adapters/proposal-adapter');

async function runProposalTriage(options = {}) {
  const {
    runRoot,
    runId,
    nodePath,
    workspaceRoot = '',
    adapter = null,
    fixtureResult = null,
    inputArtifacts = [],
  } = options;
  const request = options.request || createAdapterRequest({
    adapter: adapter?.adapter || 'proposal-only-fixture',
    runId,
    nodePath,
    taskKind: 'triage',
    workspaceRoot,
    inputArtifacts,
    outputContract: 'orpad.candidateProposal.v1',
  });
  return runProposalOnlyAdapter({
    ...options,
    runRoot,
    request,
    adapter,
    fixtureResult,
  });
}

module.exports = {
  runProposalTriage,
};
