const contracts = require('./contracts');
const apiAgentAdapter = require('./adapters/api-agent');
const approvals = require('./approvals');
const cliAgentAdapter = require('./adapters/cli-agent');
const commandGrants = require('./command-grants');
const proposalAdapter = require('./adapters/proposal-adapter');
const claims = require('./claims');
const dispatcher = require('./dispatcher');
const edgeEvaluator = require('./edge-evaluator');
const events = require('./events');
const fileLockManager = require('./file-lock-manager');
const artifacts = require('./artifacts');
const latestRunExporter = require('./exporters/latest-run-exporter');
const legacyJournalExporter = require('./exporters/legacy-journal-exporter');
const graphLoader = require('./graph-loader');
const ids = require('./ids');
const ipc = require('./ipc');
const lifecycle = require('./lifecycle');
const machine = require('./machine');
const metadataStore = require('./metadata-store');
const nodeLifecycle = require('./node-lifecycle');
const nodePacks = require('./node-packs');
const patches = require('./patches');
const patchReviewClassifier = require('./patch-review-classifier');
const pathResolver = require('./path-resolver');
const processRunner = require('./adapters/process-runner');
const processContainment = require('./adapters/process-containment');
const probeRunner = require('./probe-runner');
const providerPolicy = require('./providers/policy');
const providerRegistry = require('./providers/registry');
const providerCatalog = require('../../shared/ai/provider-catalog');
const codexCliPlugin = require('./providers/plugins/codex-cli');
const anthropicPlugin = require('./providers/plugins/anthropic');
const claudeCodePlugin = require('./providers/plugins/claude-code');
const genericCliPlugin = require('./providers/plugins/generic-cli');
const adapterRouter = require('./router/adapter-router');
const budgetLedger = require('./router/budget-ledger');
const responseCache = require('./router/response-cache');
const errorClassifier = require('./router/error-classifier');
const queueStore = require('./queue-store');
const runStore = require('./run-store');
const triageRunner = require('./triage-runner');
const traversal = require('./traversal');
const workerLoop = require('./worker-loop');
const workItemNormalizer = require('./work-item-normalizer');
const writeSets = require('./write-sets');

module.exports = {
  ...contracts,
  ...apiAgentAdapter,
  ...approvals,
  ...cliAgentAdapter,
  ...commandGrants,
  ...proposalAdapter,
  ...claims,
  ...dispatcher,
  ...edgeEvaluator,
  ...events,
  ...fileLockManager,
  ...artifacts,
  ...latestRunExporter,
  ...legacyJournalExporter,
  ...graphLoader,
  ...ids,
  ...ipc,
  ...lifecycle,
  ...machine,
  ...metadataStore,
  ...nodeLifecycle,
  ...nodePacks,
  ...patches,
  ...patchReviewClassifier,
  ...pathResolver,
  ...processRunner,
  ...processContainment,
  ...probeRunner,
  ...providerPolicy,
  ...providerRegistry,
  ...providerCatalog,
  ...adapterRouter,
  ...budgetLedger,
  ...responseCache,
  ...errorClassifier,
  codexCliCommand: codexCliPlugin.codexCliCommand,
  codexCliExecArgs: codexCliPlugin.codexCliExecArgs,
  codexCliInvocation: codexCliPlugin.codexCliInvocation,
  createCodexCliProposalAdapter: codexCliPlugin.createCodexCliProposalAdapter,
  nodeExecutableForCli: codexCliPlugin.nodeExecutableForCli,
  readCodexAdapterResult: codexCliPlugin.readCodexAdapterResult,
  anthropicInvokeApi: anthropicPlugin.invokeApi,
  anthropicParseUsage: anthropicPlugin.parseUsage,
  anthropicEstimateCost: anthropicPlugin.estimateCost,
  classifyAnthropicHttpStatus: anthropicPlugin.classifyAnthropicHttpStatus,
  claudeCodeCommand: claudeCodePlugin.claudeCodeCommand,
  claudeCodeExecArgs: claudeCodePlugin.claudeCodeExecArgs,
  claudeCodeInvocation: claudeCodePlugin.claudeCodeInvocation,
  parseClaudeAdapterResultFromStdout: claudeCodePlugin.parseClaudeAdapterResultFromStdout,
  claudeProcessLooksApprovalRequired: claudeCodePlugin.claudeProcessLooksApprovalRequired,
  ...genericCliPlugin,
  ...queueStore,
  ...runStore,
  ...triageRunner,
  ...traversal,
  ...workerLoop,
  ...workItemNormalizer,
  ...writeSets,
};
