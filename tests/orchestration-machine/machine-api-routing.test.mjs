import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const orchestration = require('../../src/main/orchestration-machine');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const anthropicFixtureDir = path.resolve(__dirname, '../fixtures/orchestration-machine/anthropic');

function jsonResponse(payload, { status = 200, statusText = 'OK', headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get(name) {
        const lower = String(name || '').toLowerCase();
        for (const [key, value] of Object.entries(headers)) {
          if (key.toLowerCase() === lower) return value;
        }
        return null;
      },
    },
    async json() { return payload; },
  };
}

async function makeAnthropicProbeWorkspace(runId) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-api-probe-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/api-probe');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'src/target.md'), 'before\n', 'utf8');
  await fs.writeFile(path.join(pipelineDir, 'graphs/main.or-graph'), JSON.stringify({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      id: 'api-probe',
      nodes: [
        { id: 'context', type: 'orpad.context', config: { summary: 'Context.' } },
        { id: 'probe', type: 'orpad.probe', config: { lens: 'api-routing' } },
        { id: 'barrier', type: 'orpad.barrier', config: { waitFor: ['probe'], mergePolicy: 'all' } },
        { id: 'queue', type: 'orpad.workQueue', config: { queueRoot: 'harness/generated/latest-run/queue', schema: 'orpad.workItem.v1' } },
        { id: 'triage', type: 'orpad.triage', config: { queueRef: 'queue' } },
        { id: 'dispatch', type: 'orpad.dispatcher', config: { queueRef: 'queue', workerLoopRef: 'worker' } },
        { id: 'worker', type: 'orpad.workerLoop', config: { queueRef: 'queue' } },
      ],
      transitions: [
        { from: 'context', to: 'probe' },
        { from: 'probe', to: 'barrier' },
        { from: 'barrier', to: 'queue' },
        { from: 'queue', to: 'triage' },
        { from: 'triage', to: 'dispatch' },
        { from: 'dispatch', to: 'worker' },
      ],
    },
  }, null, 2), 'utf8');
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'api-probe',
    trustLevel: 'local-authored',
    entryGraph: 'graphs/main.or-graph',
    nodePacks: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3', origin: 'built-in' },
      { id: 'orpad.workstream', version: '>=0.1.0', origin: 'built-in' },
    ],
    run: {
      artifactRoot: 'harness/generated/latest-run/artifacts',
      queueRoot: 'harness/generated/latest-run/queue',
      metadataPath: 'harness/generated/latest-run/run-metadata.json',
      summaryPath: 'harness/generated/latest-run/summary.md',
      // Pipeline file declares codex-cli as default; the override below
      // swaps it to anthropic for this run.
      machineAdapter: {
        type: 'codex-cli',
        enabled: true,
        sandbox: 'read-only',
        workerSandbox: 'workspace-write',
        approvalPolicy: 'never',
        probeNodePaths: ['main/probe'],
        candidateLimit: 1,
        proposalTimeoutMs: 5000,
        workerTimeoutMs: 5000,
      },
    },
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
  }, null, 2), 'utf8');
  // Apply an anthropic override.
  await fs.writeFile(
    path.join(pipelineDir, 'pipeline.adapter-overrides.json'),
    JSON.stringify({
      schemaVersion: 'orpad.adapterOverrides.v1',
      updatedAt: '2026-05-06T00:00:00.000Z',
      pipelineDefault: {
        providerId: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        family: 'api',
        qualityTier: 'standard',
        sessionStrategy: 'none',
        toolPolicy: 'none',
      },
      nodeOverrides: {},
    }, null, 2),
    'utf8',
  );
  const run = await orchestration.createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId,
  });
  return { workspaceRoot, pipelineDir, pipelinePath, run };
}

test('anthropic v2 override routes the probe through plugin.invokeApi with mocked fetch', async () => {
  const { workspaceRoot, pipelinePath, pipelineDir, run } = await makeAnthropicProbeWorkspace('run_api_probe_001');
  try {
    let capturedHeaders = null;
    let capturedBody = null;
    let fetchCalls = 0;
    // Build the response dynamically so the synthesized workerResult.v1
    // carries the same adapterCallId / attemptId / idempotencyKey the
    // proposal adapter is about to validate against.
    const fetchImpl = async (url, init) => {
      fetchCalls += 1;
      capturedHeaders = init?.headers || {};
      capturedBody = init?.body || '';
      const body = JSON.parse(init.body);
      const userText = String(body?.messages?.[0]?.content || '');
      const grab = (label) => {
        const match = userText.match(new RegExp(`${label}:\\s*([^\\n]+)`));
        return match ? match[1].trim() : '';
      };
      const adapterCallId = grab('adapterCallId');
      const attemptId = grab('attemptId');
      const adapterResult = {
        schemaVersion: 'orpad.workerResult.v1',
        adapterCallId,
        attemptId,
        idempotencyKey: `${adapterCallId}:${attemptId}`,
        status: 'done',
        summary: 'Anthropic mock probe responded with no candidates.',
        artifacts: [],
        candidateProposals: [],
        emptyPass: {
          reason: 'Anthropic mock probe found no candidates this run.',
          evidence: [`mock:${adapterCallId}`],
        },
      };
      return jsonResponse({
        id: 'msg_mock_routing',
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-sonnet-latest',
        content: [{ type: 'text', text: JSON.stringify(adapterResult) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 250, output_tokens: 80 },
      }, { headers: { 'request-id': 'req_test_routing_001' } });
    };
    try {
      await orchestration.executeMachineRunStep({
        workspaceRoot,
        pipelinePath,
        pipelineDir,
        runRoot: run.runRoot,
        runId: run.runId,
        exportLatestRunAfterStep: false,
        loadProviderKey: async (providerId) => providerId === 'anthropic' ? 'sk-ant-test-key-routing' : '',
        fetchImpl,
      });
    } catch {
      // Worker step or downstream nodes may still throw; we only need the
      // probe path to have invoked the API.
    }
    assert.equal(fetchCalls >= 1, true, `expected at least one fetch call to anthropic, got ${fetchCalls}`);
    assert.equal(capturedHeaders['x-api-key'], 'sk-ant-test-key-routing');
    assert.equal(typeof capturedBody, 'string');
    assert.equal(capturedBody.includes('claude-3-5-sonnet-latest'), true, 'request body should target the chosen model');
    assert.equal(capturedBody.includes('sk-ant-test-key-routing'), false, 'API key must not appear in request body');

    const events = await orchestration.readMachineEvents(run.runRoot);
    const probeAdapterRequested = events.find(e =>
      e.eventType === 'adapter.requested'
      && e.nodePath === 'main/probe'
      && /anthropic/.test(String(e.payload?.adapter || '')));
    assert.equal(Boolean(probeAdapterRequested), true,
      `expected adapter.requested for anthropic probe; eventTypes=${[...new Set(events.map(e => e.eventType))].join(', ')}`);
    const probeAdapterResult = events.find(e =>
      e.eventType === 'adapter.result'
      && e.nodePath === 'main/probe'
      && /anthropic/.test(String(e.payload?.adapter || '')));
    assert.equal(Boolean(probeAdapterResult), true, 'expected adapter.result for anthropic probe');
    assert.equal(probeAdapterResult.payload.status, 'done');
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('anthropic override without provider key fails fast with KEY_MISSING classification', async () => {
  const { workspaceRoot, pipelinePath, pipelineDir, run } = await makeAnthropicProbeWorkspace('run_api_probe_002');
  try {
    let fetchCalls = 0;
    try {
      await orchestration.executeMachineRunStep({
        workspaceRoot,
        pipelinePath,
        pipelineDir,
        runRoot: run.runRoot,
        runId: run.runId,
        exportLatestRunAfterStep: false,
        loadProviderKey: async () => '',
        fetchImpl: async () => { fetchCalls += 1; return jsonResponse({}); },
      });
    } catch {
      // expected
    }
    assert.equal(fetchCalls, 0, 'no fetch call should land when the provider key is missing');
    const events = await orchestration.readMachineEvents(run.runRoot);
    // Adapter throws KEY_MISSING before runProposalProbe can write an
    // adapter.result; failure is reflected via node.failed for the probe.
    const probeFailed = events.find(e =>
      (e.eventType === 'node.failed' && e.nodePath === 'main/probe')
      || (e.eventType === 'adapter.result' && e.nodePath === 'main/probe' && e.payload?.status === 'failed'));
    assert.equal(Boolean(probeFailed), true,
      `expected probe failure; saw ${[...new Set(events.map(e => e.eventType))].join(', ')}`);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('openai override fails fast with MACHINE_API_PLUGIN_STUB before any traversal', async () => {
  const { workspaceRoot, pipelinePath, pipelineDir, run } = await makeAnthropicProbeWorkspace('run_api_probe_003');
  try {
    // Replace the override file with one selecting openai (stub plugin).
    await fs.writeFile(
      path.join(pipelineDir, 'pipeline.adapter-overrides.json'),
      JSON.stringify({
        schemaVersion: 'orpad.adapterOverrides.v1',
        updatedAt: '2026-05-06T00:00:00.000Z',
        pipelineDefault: {
          providerId: 'openai',
          model: 'gpt-4o-mini',
          family: 'api',
          qualityTier: 'standard',
          sessionStrategy: 'none',
          toolPolicy: 'none',
        },
        nodeOverrides: {},
      }, null, 2),
      'utf8',
    );
    await assert.rejects(
      orchestration.executeMachineRunStep({
        workspaceRoot,
        pipelinePath,
        pipelineDir,
        runRoot: run.runRoot,
        runId: run.runId,
        exportLatestRunAfterStep: false,
      }),
      error => error?.code === 'MACHINE_API_PLUGIN_STUB' && /openai/.test(error.message || ''),
    );
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
