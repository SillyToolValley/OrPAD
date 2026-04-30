const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCliAgentAdapter, cliOverlayRoot } = require('./adapters/cli-agent');
const { createAdapterRequest } = require('./adapters/proposal-adapter');
const { claimNextQueuedItem } = require('./dispatcher');
const { createCommandGrant } = require('./command-grants');
const { exportLatestRun } = require('./exporters/latest-run-exporter');
const { buildTraversalPlan } = require('./traversal');
const { loadPipelineGraphSet } = require('./graph-loader');
const { readMachineEvents } = require('./events');
const { readRunState } = require('./run-store');
const { recordNodeLifecycleEvent } = require('./node-lifecycle');
const { runProposalProbe } = require('./probe-runner');
const { runProposalTriage } = require('./triage-runner');
const { runWorkerLoopOnce } = require('./worker-loop');
const { normalizeWriteSetPath } = require('./write-sets');

const fsp = fs.promises;

function machineExecutionError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function readJsonFile(filePath, label = 'JSON file') {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    throw machineExecutionError('MACHINE_EXECUTION_SCHEMA_INVALID', `${label} must be valid JSON.`);
  }
}

function harnessFromPipeline(pipeline) {
  return pipeline?.run && typeof pipeline.run === 'object' && !Array.isArray(pipeline.run)
    ? pipeline.run.machineHarness
    : null;
}

function nodeExecutableForHarness() {
  return process.env.ORPAD_MACHINE_NODE_EXEC_PATH
    || process.env.npm_node_execpath
    || process.env.NODE
    || process.execPath;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw machineExecutionError('MACHINE_EXECUTION_SCHEMA_INVALID', `${label} must be an object.`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw machineExecutionError('MACHINE_EXECUTION_SCHEMA_INVALID', `${label} is required.`);
  }
  return value;
}

function nodeCliPatchCommandSpec(patchConfig, cwd, options = {}) {
  const patch = assertPlainObject(patchConfig, 'machineHarness.nodeCliPatch');
  const file = normalizeWriteSetPath(requiredString(patch.file, 'machineHarness.nodeCliPatch.file'));
  const content = typeof patch.content === 'string' ? patch.content : `${String(patch.content ?? '')}`;
  const script = [
    'const fs=require("fs");',
    'const path=require("path");',
    `const file=${JSON.stringify(file)};`,
    `const content=${JSON.stringify(content)};`,
    'fs.mkdirSync(path.dirname(file),{recursive:true});',
    'fs.writeFileSync(file,content,"utf8");',
  ].join('');
  return {
    command: options.nodeExecutable || nodeExecutableForHarness(),
    args: ['-e', script],
    cwd,
    file,
  };
}

function flattenTraversalNodes(plan) {
  const byPath = new Map(plan.inventory.map(node => [node.nodePath, node]));
  const ordered = [];
  for (const graphPlan of plan.graphPlans) {
    for (const nodePath of graphPlan.nodePaths) {
      const node = byPath.get(nodePath);
      if (node) ordered.push(node);
    }
  }
  return ordered;
}

function selectNode(orderedNodes, nodeType, explicitNodePath = '') {
  if (explicitNodePath) {
    const explicit = orderedNodes.find(node => node.nodePath === explicitNodePath);
    if (!explicit) {
      throw machineExecutionError('MACHINE_EXECUTION_NODE_NOT_FOUND', `Machine execution node not found: ${explicitNodePath}`);
    }
    if (explicit.nodeType !== nodeType) {
      throw machineExecutionError('MACHINE_EXECUTION_NODE_TYPE_MISMATCH', `Machine execution node ${explicitNodePath} is not ${nodeType}.`);
    }
    return explicit;
  }
  return orderedNodes.find(node => node.nodeType === nodeType) || null;
}

function proposalResultForRequest(request, options = {}) {
  return {
    schemaVersion: 'orpad.workerResult.v1',
    adapterCallId: request.adapterCallId,
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    status: options.status || 'done',
    summary: options.summary || 'Machine graph harness submitted a proposal result.',
    artifacts: options.artifacts || [],
    candidateProposals: options.candidateProposals || [],
    triageTransitions: options.triageTransitions || [],
    ...(options.emptyPass ? { emptyPass: options.emptyPass } : {}),
  };
}

async function withNodeLifecycle(runRoot, node, options = {}, fn) {
  const { runId } = options;
  await recordNodeLifecycleEvent(runRoot, {
    runId,
    nodePath: node.nodePath,
    nodeType: node.nodeType,
    status: 'scheduled',
    payload: options.scheduledPayload || {},
  });
  await recordNodeLifecycleEvent(runRoot, {
    runId,
    nodePath: node.nodePath,
    nodeType: node.nodeType,
    status: 'started',
    payload: options.startedPayload || {},
  });
  try {
    const result = await fn();
    await recordNodeLifecycleEvent(runRoot, {
      runId,
      nodePath: node.nodePath,
      nodeType: node.nodeType,
      status: 'completed',
      payload: typeof options.completedPayload === 'function'
        ? options.completedPayload(result)
        : (options.completedPayload || {}),
    });
    return result;
  } catch (err) {
    await recordNodeLifecycleEvent(runRoot, {
      runId,
      nodePath: node.nodePath,
      nodeType: node.nodeType,
      status: 'failed',
      payload: {
        code: err?.code || 'MACHINE_NODE_FAILED',
        message: err?.message || String(err),
      },
    });
    throw err;
  }
}

async function executeMachineRunStep(options = {}) {
  const {
    workspaceRoot,
    pipelinePath,
    pipelineDir = pipelinePath ? path.dirname(path.resolve(pipelinePath)) : '',
    runRoot,
    runId,
    exportLatestRunAfterStep = true,
    nodeExecutable = '',
    createWorkerCommandSpec = null,
    overlayRoot = '',
    overlayRootMode = 'run-root',
    dangerousSandboxBypassApproval = null,
    allowDangerousSandboxBypass = false,
    timeoutMs = 60_000,
  } = options;
  if (!workspaceRoot) throw new Error('workspaceRoot is required.');
  if (!pipelinePath) throw new Error('pipelinePath is required.');
  if (!pipelineDir) throw new Error('pipelineDir is required.');
  if (!runRoot) throw new Error('runRoot is required.');
  if (!runId) throw new Error('runId is required.');

  const graphSet = await loadPipelineGraphSet({ pipelinePath });
  const plan = buildTraversalPlan(graphSet);
  const orderedNodes = flattenTraversalNodes(plan);
  const pipeline = graphSet.pipeline || await readJsonFile(pipelinePath, 'Machine pipeline');
  const harnessSource = harnessFromPipeline(pipeline);
  if (!harnessSource) {
    throw machineExecutionError(
      'MACHINE_EXECUTION_HARNESS_REQUIRED',
      'This MVP execute step requires a local deterministic run.machineHarness fixture.',
    );
  }
  const harness = assertPlainObject(harnessSource, 'run.machineHarness');
  const candidate = assertPlainObject(harness.candidateProposal, 'machineHarness.candidateProposal');
  const expectedChangedFiles = (harness.expectedChangedFiles || candidate.sourceOfTruthTargets || [])
    .map(file => normalizeWriteSetPath(file));
  const patchConfig = assertPlainObject(harness.nodeCliPatch, 'machineHarness.nodeCliPatch');
  const patchFile = normalizeWriteSetPath(requiredString(patchConfig.file, 'machineHarness.nodeCliPatch.file'));
  if (!expectedChangedFiles.includes(patchFile)) {
    throw machineExecutionError(
      'MACHINE_EXECUTION_HARNESS_INVALID',
      'machineHarness.nodeCliPatch.file must be listed in expectedChangedFiles or candidate.sourceOfTruthTargets.',
    );
  }

  const probeNode = selectNode(orderedNodes, 'orpad.probe', harness.probeNodePath);
  const triageNode = selectNode(orderedNodes, 'orpad.triage', harness.triageNodePath);
  const dispatcherNode = selectNode(orderedNodes, 'orpad.dispatcher', harness.dispatcherNodePath);
  const workerNode = selectNode(orderedNodes, 'orpad.workerLoop', harness.workerNodePath);
  for (const [label, node] of Object.entries({ probeNode, triageNode, dispatcherNode, workerNode })) {
    if (!node) throw machineExecutionError('MACHINE_EXECUTION_NODE_NOT_FOUND', `Machine graph harness could not find ${label}.`);
  }

  const probe = await withNodeLifecycle(runRoot, probeNode, {
    runId,
    completedPayload: result => ({
      proposalCount: result.proposals?.length || 0,
      summaryStatus: result.summaryStatus,
    }),
  }, () => runProposalProbe({
    runRoot,
    runId,
    nodePath: probeNode.nodePath,
    workspaceRoot,
    fixtureResult: request => proposalResultForRequest(request, {
      summary: 'Machine graph probe produced harness candidate proposal.',
      candidateProposals: [candidate],
    }),
  }));

  const triage = await withNodeLifecycle(runRoot, triageNode, {
    runId,
    completedPayload: result => ({
      triageTransitionCount: result.triage?.length || 0,
      summaryStatus: result.summaryStatus,
    }),
  }, () => runProposalTriage({
    runRoot,
    runId,
    nodePath: triageNode.nodePath,
    workspaceRoot,
    fixtureResult: request => proposalResultForRequest(request, {
      summary: 'Machine graph triage accepted harness candidate.',
      triageTransitions: [{
        itemId: candidate.suggestedWorkItemId,
        toState: 'queued',
        reason: 'machine-graph-harness.triage.accepted',
      }],
    }),
  }));

  const claim = await withNodeLifecycle(runRoot, dispatcherNode, {
    runId,
    completedPayload: result => ({
      claimed: result.claimed === true,
      stopReason: result.stopReason || '',
      itemId: result.item?.id || '',
    }),
  }, () => claimNextQueuedItem(runRoot, {
    runId,
    claimId: options.claimId || `claim-${candidate.suggestedWorkItemId}`,
  }));

  let worker = null;
  if (claim.claimed) {
    worker = await withNodeLifecycle(runRoot, workerNode, {
      runId,
      completedPayload: result => ({
        workerStatus: result.result?.event?.payload?.status || '',
        itemId: claim.item?.id || '',
      }),
    }, async () => {
      const adapterCallId = options.adapterCallId || `${claim.claim.claimId}-graph-cli`;
      const adapterRequest = createAdapterRequest({
        adapter: 'cli-agent-overlay',
        runId,
        nodePath: workerNode.nodePath,
        taskKind: 'workerLoop',
        workspaceRoot,
        workspaceMode: 'read-only-plus-overlay',
        allowedFiles: claim.writeSet.paths,
        inputArtifacts: [`queue/claimed/${claim.item.id}.json`],
        outputContract: 'orpad.workerResult.v1',
        adapterCallId,
        attemptId: `${adapterCallId}-attempt-1`,
        idempotencyKey: `${adapterCallId}:attempt-1`,
      });
      adapterRequest.expectedChangedFiles = expectedChangedFiles;
      adapterRequest.overlayRootMode = overlayRootMode === 'system-temp' ? 'system-temp' : 'run-root';
      adapterRequest.overlayRoot = overlayRoot
        || (adapterRequest.overlayRootMode === 'system-temp'
          ? await fsp.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-cli-overlay-'))
          : cliOverlayRoot(runRoot, adapterRequest));
      if (dangerousSandboxBypassApproval) {
        adapterRequest.dangerousSandboxBypassApproval = dangerousSandboxBypassApproval;
      }
      const commandSpec = createWorkerCommandSpec
        ? await createWorkerCommandSpec({
          request: adapterRequest,
          overlayRoot: adapterRequest.overlayRoot,
          claim,
          candidate,
          workerNode,
          harness,
          patchConfig,
        })
        : nodeCliPatchCommandSpec(patchConfig, adapterRequest.overlayRoot, { nodeExecutable });
      adapterRequest.commandSpec = {
        command: commandSpec.command,
        args: commandSpec.args,
        cwd: commandSpec.cwd,
      };
      adapterRequest.commandGrants = [createCommandGrant({
        ...adapterRequest.commandSpec,
        grantId: `grant-${adapterCallId}`,
        scope: 'machine-graph-harness',
        allowDangerousSandboxBypass: allowDangerousSandboxBypass === true,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        reason: 'explicit Machine graph harness command',
      })];
      return runWorkerLoopOnce({
        runRoot,
        runId,
        workspaceRoot,
        claim,
        request: adapterRequest,
        adapter: createCliAgentAdapter({
          enabled: true,
          runRoot,
          workspaceRoot,
          allowDangerousSandboxBypass: allowDangerousSandboxBypass === true,
          timeoutMs,
          maxOutputBytes: 64 * 1024,
        }),
      });
    });
  }

  let exported = null;
  if (exportLatestRunAfterStep) {
    exported = await exportLatestRun({
      runRoot,
      pipelineDir,
      allowOverwrite: true,
    });
  }

  return {
    runId,
    graphPlan: plan,
    selectedNodes: {
      probe: probeNode.nodePath,
      triage: triageNode.nodePath,
      dispatcher: dispatcherNode.nodePath,
      worker: workerNode.nodePath,
    },
    probe,
    triage,
    claim,
    worker,
    exported,
    runState: await readRunState(runRoot),
    events: await readMachineEvents(runRoot),
  };
}

module.exports = {
  executeMachineRunStep,
  flattenTraversalNodes,
  harnessFromPipeline,
  nodeCliPatchCommandSpec,
  nodeExecutableForHarness,
  proposalResultForRequest,
  selectNode,
};
