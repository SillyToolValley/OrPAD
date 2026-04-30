function createCliAgentProposalOnlyAdapter(options = {}) {
  const { fixtureResult = null } = options;
  return {
    adapter: 'cli-agent-proposal-only',
    async invoke(request) {
      if (!fixtureResult) {
        throw new Error('Real CLI adapter execution is disabled; provide a proposal-only fixture result.');
      }
      return typeof fixtureResult === 'function' ? fixtureResult(request) : fixtureResult;
    },
  };
}

module.exports = {
  createCliAgentProposalOnlyAdapter,
};
