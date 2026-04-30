const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCliAgentAdapter, cliOverlayRoot } = require('./adapters/cli-agent');
const { createAdapterRequest } = require('./adapters/proposal-adapter');
const { registerArtifact, writeArtifactManifest } = require('./artifacts');
const { claimNextQueuedItem } = require('./dispatcher');
const { createCommandGrant } = require('./command-grants');
const { SCHEMA_VERSIONS, createContractValidator } = require('./contracts');
const { exportLatestRun } = require('./exporters/latest-run-exporter');
const { buildTraversalPlan } = require('./traversal');
const { loadPipelineGraphSet } = require('./graph-loader');
const { finalizeRunFromInventory, summarizeQueueInventory } = require('./lifecycle');
const { readMachineEvents } = require('./events');
const { readRunState } = require('./run-store');
const { recordNodeLifecycleEvent } = require('./node-lifecycle');
const { runProposalProbe } = require('./probe-runner');
const { runProposalTriage } = require('./triage-runner');
const { runWorkerLoopOnce } = require('./worker-loop');
const { normalizeWriteSetPath } = require('./write-sets');

const fsp = fs.promises;
const contractValidator = createContractValidator();
const MACHINE_CANDIDATE_INVENTORY_SCHEMA = SCHEMA_VERSIONS.candidateInventory;
const SUPPORT_NODE_TYPES = new Set([
  'orpad.context',
  'orpad.workQueue',
  'orpad.gate',
  'orpad.barrier',
  'orpad.artifactContract',
  'orpad.graph',
]);

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

function idSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'item';
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

function candidateProposalsFromHarness(harness) {
  const candidates = Array.isArray(harness.candidateProposals)
    ? harness.candidateProposals
    : (harness.candidateProposal ? [harness.candidateProposal] : []);
  if (!candidates.length) {
    throw machineExecutionError('MACHINE_EXECUTION_SCHEMA_INVALID', 'machineHarness.candidateProposal is required.');
  }
  return candidates.map((candidate, index) => assertPlainObject(candidate, `machineHarness.candidateProposals[${index}]`));
}

function expectedChangedFilesFromHarness(harness, candidates) {
  const files = harness.expectedChangedFiles || candidates.flatMap(candidate => candidate.sourceOfTruthTargets || []);
  return [...new Set(files.map(file => normalizeWriteSetPath(file)))];
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
  const nodePaths = plan.inlinePlan?.nodePaths?.length
    ? plan.inlinePlan.nodePaths
    : plan.graphPlans.flatMap(graphPlan => graphPlan.nodePaths);
  for (const nodePath of nodePaths) {
    const node = byPath.get(nodePath);
    if (node) ordered.push(node);
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

function selectNodes(orderedNodes, nodeType, explicitNodePaths = []) {
  const explicitPaths = Array.isArray(explicitNodePaths)
    ? explicitNodePaths.filter(Boolean)
    : (explicitNodePaths ? [explicitNodePaths] : []);
  if (!explicitPaths.length) return orderedNodes.filter(node => node.nodeType === nodeType);
  return explicitPaths.map(nodePath => selectNode(orderedNodes, nodeType, nodePath));
}

function supportNodesForExecution(orderedNodes, operationNodes) {
  const operationPaths = new Set(operationNodes.filter(Boolean).map(node => node.nodePath));
  return orderedNodes.filter(node => (
    SUPPORT_NODE_TYPES.has(node.nodeType)
    && !operationPaths.has(node.nodePath)
  ));
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

function outputRefs(config = {}) {
  return Array.isArray(config.outputs) ? config.outputs : [];
}

function inputRefs(config = {}) {
  return Array.isArray(config.inputs) ? config.inputs : [];
}

async function executeSupportNode(runRoot, node, options = {}) {
  const { runId } = options;
  return withNodeLifecycle(runRoot, node, {
    runId,
    completedPayload: result => result,
  }, async () => {
    const config = node.config || {};
    if (node.nodeType === 'orpad.context') {
      return {
        summary: config.summary || '',
        outputCount: outputRefs(config).length,
      };
    }
    if (node.nodeType === 'orpad.workQueue') {
      const inventory = await summarizeQueueInventory(runRoot);
      return {
        queueRef: config.queueRef || '',
        schema: config.schema || '',
        inventory,
      };
    }
    if (node.nodeType === 'orpad.barrier') {
      return {
        waitForCount: Array.isArray(config.waitFor) ? config.waitFor.length : 0,
        mergePolicy: config.mergePolicy || '',
        outputCount: outputRefs(config).length,
      };
    }
    if (node.nodeType === 'orpad.gate') {
      const inventory = await summarizeQueueInventory(runRoot);
      return {
        criteriaCount: Array.isArray(config.criteria) ? config.criteria.length : 0,
        inputCount: inputRefs(config).length,
        outputCount: outputRefs(config).length,
        inventory,
      };
    }
    if (node.nodeType === 'orpad.artifactContract') {
      const manifest = await writeArtifactManifest(runRoot);
      const inventory = await summarizeQueueInventory(runRoot);
      return {
        artifactCount: manifest.files.length,
        manifestSourceEventSequence: manifest.sourceEventSequence,
        requiredCount: Array.isArray(config.required) ? config.required.length : 0,
        requiredQueueCount: Array.isArray(config.requiredQueue) ? config.requiredQueue.length : 0,
        inventory,
      };
    }
    if (node.nodeType === 'orpad.graph') {
      return {
        graphRef: config.graphRef || '',
        executionMode: config.executionMode || '',
        viewMode: config.viewMode || '',
      };
    }
    return {};
  });
}

function candidatesForProbeNode(probeNode, probeNodes, candidates) {
  const probePaths = new Set(probeNodes.map(node => node.nodePath));
  const matching = candidates.filter(candidate => candidate.sourceNode === probeNode.nodePath);
  if (matching.length) return matching;
  const hasAnyExplicitProbeMatch = candidates.some(candidate => probePaths.has(candidate.sourceNode));
  if (!hasAnyExplicitProbeMatch && probeNode.nodePath === probeNodes[0]?.nodePath) return candidates;
  return [];
}

function candidateInventoryRowForProposal(probeEntry, candidateProposal) {
  return {
    id: candidateProposal.proposalId || candidateProposal.suggestedWorkItemId,
    status: 'candidate',
    nodePath: probeEntry.nodePath,
    proposalId: candidateProposal.proposalId || '',
    suggestedWorkItemId: candidateProposal.suggestedWorkItemId || '',
    fingerprint: candidateProposal.fingerprint || '',
    title: candidateProposal.title || '',
    severity: candidateProposal.severity || '',
    confidence: candidateProposal.confidence ?? null,
    evidence: candidateProposal.evidence || [],
    sourceOfTruthTargets: candidateProposal.sourceOfTruthTargets || [],
  };
}

function emptyPassInventoryRow(probeEntry) {
  return {
    id: `empty-pass-${idSegment(probeEntry.nodePath)}`,
    status: 'empty-pass',
    nodePath: probeEntry.nodePath,
    reason: 'No deterministic harness candidate was assigned to this probe node.',
    evidence: [`node:${probeEntry.nodePath}`],
  };
}

async function registerCandidateInventoryArtifact(runRoot, options = {}) {
  const {
    runId,
    probes = [],
    artifactPath = 'artifacts/discovery/candidate-inventory.json',
  } = options;
  const rows = [];
  for (const probeEntry of probes) {
    const proposals = probeEntry.candidateProposals || [];
    if (proposals.length) {
      rows.push(...proposals.map(candidateProposal => candidateInventoryRowForProposal(probeEntry, candidateProposal)));
    } else {
      rows.push(emptyPassInventoryRow(probeEntry));
    }
  }
  const events = await readMachineEvents(runRoot);
  const sourceEventSequence = events.length ? events[events.length - 1].sequence : 0;
  const inventory = {
    schemaVersion: MACHINE_CANDIDATE_INVENTORY_SCHEMA,
    runId,
    createdAt: new Date().toISOString(),
    sourceEventSequence,
    selectedProbeNodes: probes.map(probeEntry => probeEntry.nodePath),
    candidateCount: rows.filter(row => row.status === 'candidate').length,
    emptyPassCount: rows.filter(row => row.status === 'empty-pass').length,
    items: rows,
  };
  contractValidator.assertValid('candidateInventory', inventory);
  const artifact = await registerArtifact(runRoot, {
    runId,
    artifactPath,
    content: `${JSON.stringify(inventory, null, 2)}\n`,
    producedBy: 'orpad.machine.candidate-inventory',
    registeredBy: 'machine',
    schemaVersion: MACHINE_CANDIDATE_INVENTORY_SCHEMA,
  });
  return { artifact, inventory };
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
  const candidates = candidateProposalsFromHarness(harness);
  const candidate = candidates[0];
  const expectedChangedFiles = expectedChangedFilesFromHarness(harness, candidates);
  const patchConfig = assertPlainObject(harness.nodeCliPatch, 'machineHarness.nodeCliPatch');
  const patchFile = normalizeWriteSetPath(requiredString(patchConfig.file, 'machineHarness.nodeCliPatch.file'));
  if (!expectedChangedFiles.includes(patchFile)) {
    throw machineExecutionError(
      'MACHINE_EXECUTION_HARNESS_INVALID',
      'machineHarness.nodeCliPatch.file must be listed in expectedChangedFiles or candidate.sourceOfTruthTargets.',
    );
  }

  const probeNodes = selectNodes(orderedNodes, 'orpad.probe', harness.probeNodePaths || harness.probeNodePath);
  const triageNode = selectNode(orderedNodes, 'orpad.triage', harness.triageNodePath);
  const dispatcherNode = selectNode(orderedNodes, 'orpad.dispatcher', harness.dispatcherNodePath);
  const workerNode = selectNode(orderedNodes, 'orpad.workerLoop', harness.workerNodePath);
  if (!probeNodes.length) {
    throw machineExecutionError('MACHINE_EXECUTION_NODE_NOT_FOUND', 'Machine graph harness could not find probeNode.');
  }
  const probeNode = probeNodes[0];
  for (const [label, node] of Object.entries({ triageNode, dispatcherNode, workerNode })) {
    if (!node) throw machineExecutionError('MACHINE_EXECUTION_NODE_NOT_FOUND', `Machine graph harness could not find ${label}.`);
  }

  const operationNodes = [...probeNodes, triageNode, dispatcherNode, workerNode];
  const supportNodes = supportNodesForExecution(orderedNodes, operationNodes);
  const executablePaths = new Set([
    ...operationNodes.map(node => node.nodePath),
    ...supportNodes.map(node => node.nodePath),
  ]);
  let probe = null;
  const probes = [];
  let triage = null;
  let claim = null;
  let worker = null;
  let candidateInventory = null;
  const support = [];

  for (const node of orderedNodes) {
    if (!executablePaths.has(node.nodePath)) continue;
    if (probeNodes.some(probeEntry => probeEntry.nodePath === node.nodePath)) {
      const currentProbeNode = node;
      const probeCandidates = candidatesForProbeNode(currentProbeNode, probeNodes, candidates);
      const probeResult = await withNodeLifecycle(runRoot, currentProbeNode, {
        runId,
        completedPayload: result => ({
          proposalCount: result.proposals?.length || 0,
          summaryStatus: result.summaryStatus,
        }),
      }, () => runProposalProbe({
        runRoot,
        runId,
        nodePath: currentProbeNode.nodePath,
        workspaceRoot,
        fixtureResult: request => proposalResultForRequest(request, {
          summary: probeCandidates.length
            ? 'Machine graph probe produced harness candidate proposal.'
            : 'Machine graph probe completed with no harness candidate for this node.',
          candidateProposals: probeCandidates,
          ...(probeCandidates.length ? {} : {
            emptyPass: {
              reason: 'No deterministic harness candidate was assigned to this probe node.',
              evidence: [`node:${currentProbeNode.nodePath}`],
            },
          }),
        }),
      }));
      probes.push({
        nodePath: currentProbeNode.nodePath,
        candidateProposals: probeCandidates,
        result: probeResult,
      });
      if (!probe) probe = probeResult;
    } else if (node.nodePath === triageNode.nodePath) {
      candidateInventory = await registerCandidateInventoryArtifact(runRoot, {
        runId,
        probes,
      });
      triage = await withNodeLifecycle(runRoot, triageNode, {
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
        inputArtifacts: [candidateInventory.artifact.file.path],
        fixtureResult: request => proposalResultForRequest(request, {
          summary: 'Machine graph triage accepted harness candidate.',
          artifacts: [candidateInventory.artifact.file.path],
          triageTransitions: candidates.map(candidateProposal => ({
            itemId: candidateProposal.suggestedWorkItemId,
            toState: 'queued',
            reason: 'machine-graph-harness.triage.accepted',
          })),
        }),
      }));
    } else if (node.nodePath === dispatcherNode.nodePath) {
      claim = await withNodeLifecycle(runRoot, dispatcherNode, {
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
    } else if (node.nodePath === workerNode.nodePath) {
      if (!claim?.claimed) continue;
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
    } else {
      support.push({
        nodePath: node.nodePath,
        nodeType: node.nodeType,
        result: await executeSupportNode(runRoot, node, { runId }),
      });
    }
  }

  const finalization = await finalizeRunFromInventory(runRoot, {
    runId,
    reason: 'machine-graph-step.finalize',
  });

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
    selectedProbeNodes: probeNodes.map(node => node.nodePath),
    supportNodes: support.map(entry => ({
      nodePath: entry.nodePath,
      nodeType: entry.nodeType,
    })),
    probe,
    probes,
    candidateInventory: candidateInventory ? {
      artifactPath: candidateInventory.artifact.file.path,
      candidateCount: candidateInventory.inventory.candidateCount,
      emptyPassCount: candidateInventory.inventory.emptyPassCount,
    } : null,
    triage,
    claim,
    worker,
    finalization,
    exported,
    runState: await readRunState(runRoot),
    events: await readMachineEvents(runRoot),
  };
}

module.exports = {
  executeMachineRunStep,
  flattenTraversalNodes,
  harnessFromPipeline,
  registerCandidateInventoryArtifact,
  nodeCliPatchCommandSpec,
  nodeExecutableForHarness,
  proposalResultForRequest,
  selectNode,
  selectNodes,
  supportNodesForExecution,
};
