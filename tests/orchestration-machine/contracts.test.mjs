import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  CONTRACT_SCHEMA_NAMES,
  SCHEMA_VERSIONS,
  createContractValidator,
  loadAllContractSchemas,
} = require('../../src/main/orchestration-machine');

const now = '2026-04-30T00:00:00.000Z';

function samples() {
  return {
    machineEvent: {
      schemaVersion: SCHEMA_VERSIONS.machineEvent,
      runId: 'run_20260430_000001',
      sequence: 1,
      timestamp: now,
      actor: 'machine',
      nodePath: 'main/queue-and-triage/triage',
      eventType: 'queue.transition',
      itemId: 'item-1',
      fromState: 'candidate',
      toState: 'queued',
      reason: 'triage.accepted',
      artifactRefs: ['artifacts/queue/triage-log.md'],
    },
    machineRun: {
      schemaVersion: SCHEMA_VERSIONS.machineRun,
      runId: 'run_20260430_000001',
      pipelineId: 'orpad-maintenance-quality-workstream-20260429',
      pipelinePath: '.orpad/pipelines/orpad-maintenance-quality-workstream-20260429/pipeline.or-pipeline',
      runRoot: '.orpad/pipelines/orpad-maintenance-quality-workstream-20260429/runs/run_20260430_000001',
      latestRunExportPath: '.orpad/pipelines/orpad-maintenance-quality-workstream-20260429/harness/generated/latest-run',
      lifecycleStatus: 'created',
      summaryStatus: 'pending',
      createdAt: now,
      updatedAt: now,
      eventSequence: 1,
      canonicalStoreKind: 'jsonl',
    },
    workItem: {
      schemaVersion: SCHEMA_VERSIONS.workItem,
      id: 'graph-editor-graph-specific-node-types',
      state: 'candidate',
      title: 'Show graph-specific node types in the graph editor picker',
      sourceNode: 'ux-ui-probe',
      contentArea: 'graph editor node type filtering',
      issueType: 'renderer-validator-parity',
      severity: 'P2',
      confidence: 0.84,
      fingerprint: 'ux:graph-editor:graph-specific-node-types',
      evidence: [{ id: 'ux-graph-editor-source', file: 'src/renderer/renderer.js' }],
      acceptanceCriteria: ['Graph editor type picker includes graph-specific node types.'],
      userImpact: 'Users cannot select validator-supported graph node types.',
      reproSteps: ['Open a pipeline graph and inspect the Type dropdown.'],
      expectedBehavior: 'Graph-specific node types are available.',
      actualBehavior: 'Graph-specific node types are omitted.',
      sourceOfTruthTargets: ['src/renderer/renderer.js'],
      verificationPlan: 'Run renderer build and focused graph editor tests.',
      coverageEvidenceIds: ['ux-graph-editor-source'],
      approvalRequired: false,
      createdAt: now,
      updatedAt: now,
    },
    candidateProposal: {
      schemaVersion: SCHEMA_VERSIONS.candidateProposal,
      proposalId: 'proposal-1',
      suggestedWorkItemId: 'graph-editor-graph-specific-node-types',
      sourceNode: 'ux-ui-probe',
      title: 'Show graph-specific node types in the graph editor picker',
      fingerprint: 'ux:graph-editor:graph-specific-node-types',
      confidence: 0.84,
      evidence: [{ id: 'ux-graph-editor-source', file: 'src/renderer/renderer.js' }],
      acceptanceCriteria: ['Graph editor type picker includes graph-specific node types.'],
      coverageEvidenceIds: ['ux-graph-editor-source'],
    },
    candidateInventory: {
      schemaVersion: SCHEMA_VERSIONS.candidateInventory,
      runId: 'run_20260430_000001',
      createdAt: now,
      sourceEventSequence: 6,
      selectedProbeNodes: ['main/probe'],
      candidateCount: 1,
      emptyPassCount: 1,
      items: [
        {
          id: 'proposal-1',
          status: 'candidate',
          nodePath: 'main/probe',
          proposalId: 'proposal-1',
          suggestedWorkItemId: 'graph-editor-graph-specific-node-types',
          fingerprint: 'ux:graph-editor:graph-specific-node-types',
          title: 'Show graph-specific node types in the graph editor picker',
          confidence: 0.84,
          evidence: [{ id: 'ux-graph-editor-source', file: 'src/renderer/renderer.js' }],
          sourceOfTruthTargets: ['src/renderer/renderer.js'],
        },
        {
          id: 'empty-pass-main-probe',
          status: 'empty-pass',
          nodePath: 'main/probe',
          reason: 'No deterministic harness candidate was assigned to this probe node.',
          evidence: ['node:main/probe'],
        },
      ],
    },
    artifactManifest: {
      schemaVersion: SCHEMA_VERSIONS.artifactManifest,
      runId: 'run_20260430_000001',
      createdAt: now,
      sourceEventSequence: 7,
      files: [
        {
          path: 'artifacts/queue/triage-log.md',
          sha256: 'abc123',
          size: 42,
          producedBy: 'adapter:proposal-only',
          registeredBy: 'machine',
        },
      ],
    },
    adapterRequest: {
      schemaVersion: SCHEMA_VERSIONS.adapterRequest,
      adapter: 'cli-agent',
      runId: 'run_20260430_000001',
      adapterCallId: 'adapter_call_001',
      attemptId: 'attempt_001',
      idempotencyKey: 'run_20260430_000001:worker:attempt_001',
      nodePath: 'main/worker-loop/worker',
      taskKind: 'worker-loop',
      workspaceMode: 'read-only-plus-overlay',
      inputArtifacts: ['queue/claimed/item.json'],
      adapterResultPath: 'runs/run_20260430_000001/adapters/adapter_call_001/response.json',
      outputContract: SCHEMA_VERSIONS.adapterResult,
    },
    adapterResult: {
      schemaVersion: SCHEMA_VERSIONS.adapterResult,
      adapterCallId: 'adapter_call_001',
      attemptId: 'attempt_001',
      idempotencyKey: 'run_20260430_000001:worker:attempt_001',
      status: 'done',
      summary: 'Implemented graph node type exposure.',
      artifacts: ['artifacts/work-items/item/proof.md'],
    },
  };
}

test('all Orchestration Machine contract schemas load and expose versions', () => {
  const schemas = loadAllContractSchemas();

  assert.deepEqual(Object.keys(schemas).sort(), [...CONTRACT_SCHEMA_NAMES].sort());
  for (const [name, schema] of Object.entries(schemas)) {
    assert.equal(schema.$id, SCHEMA_VERSIONS[name]);
  }
});

test('contract validator accepts minimal valid Machine contract samples', () => {
  const validator = createContractValidator();

  for (const [name, sample] of Object.entries(samples())) {
    const result = validator.validate(name, sample);
    assert.equal(result.ok, true, `${name} should validate: ${JSON.stringify(result.errors)}`);
  }
});

test('contract validator rejects missing required Machine event fields', () => {
  const validator = createContractValidator();
  const event = samples().machineEvent;
  delete event.sequence;

  const result = validator.validate('machineEvent', event);

  assert.equal(result.ok, false);
  assert.equal(result.errors.some(error => error.keyword === 'required'), true);
});

test('contract validator rejects unsafe Machine event identity refs', () => {
  const validator = createContractValidator();

  assert.equal(validator.validate('machineEvent', {
    ...samples().machineEvent,
    runId: '../run',
  }).ok, false);
  assert.equal(validator.validate('machineEvent', {
    ...samples().machineEvent,
    itemId: '../item',
  }).ok, false);
  assert.equal(validator.validate('machineEvent', {
    ...samples().machineEvent,
    artifactRefs: ['artifacts\\queue\\triage-log.md'],
  }).ok, false);
});

test('contract validator rejects unsafe work item storage ids', () => {
  const validator = createContractValidator();

  assert.equal(validator.validate('workItem', { ...samples().workItem, id: '../escape' }).ok, false);
  assert.equal(validator.validate('candidateProposal', {
    ...samples().candidateProposal,
    suggestedWorkItemId: 'unsafe/item',
  }).ok, false);
  assert.equal(validator.validate('candidateInventory', {
    ...samples().candidateInventory,
    items: [{
      ...samples().candidateInventory.items[0],
      suggestedWorkItemId: 'unsafe\\item',
    }],
  }).ok, false);
});

test('contract validator rejects unsafe artifact manifest paths', () => {
  const validator = createContractValidator();
  for (const artifactPath of ['../outside.md', '/tmp/outside.md', 'C:/tmp/outside.md', 'artifacts/queue/../x.md', 'artifacts\\queue\\x.md']) {
    const manifest = {
      ...samples().artifactManifest,
      files: [{ ...samples().artifactManifest.files[0], path: artifactPath }],
    };
    assert.equal(validator.validate('artifactManifest', manifest).ok, false, artifactPath);
  }
});

test('contract validator rejects unsafe adapter request and result paths', () => {
  const validator = createContractValidator();

  assert.equal(validator.validate('adapterRequest', {
    ...samples().adapterRequest,
    adapterCallId: '../adapter',
  }).ok, false);
  assert.equal(validator.validate('adapterRequest', {
    ...samples().adapterRequest,
    inputArtifacts: ['artifacts\\queue\\x.md'],
  }).ok, false);
  assert.equal(validator.validate('adapterResult', {
    ...samples().adapterResult,
    artifacts: ['../outside.md'],
  }).ok, false);
  assert.equal(validator.validate('adapterResult', {
    ...samples().adapterResult,
    patchArtifact: 'artifacts/patches/../x.json',
  }).ok, false);
});

test('adapter contracts require retry identity fields', () => {
  const validator = createContractValidator();
  const request = samples().adapterRequest;
  const result = validator.validate('adapterRequest', { ...request, idempotencyKey: '' });

  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some(error => String(error.dataPath || '').endsWith('/idempotencyKey') || error.params?.missingProperty === 'idempotencyKey'),
    true,
  );
});

test('unknown contract schema names fail closed', () => {
  const validator = createContractValidator();

  assert.throws(() => validator.validate('notAContract', {}), /Unknown Orchestration Machine contract schema/);
});
