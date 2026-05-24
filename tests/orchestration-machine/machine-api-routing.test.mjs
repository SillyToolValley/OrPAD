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

function workerResultForRequest(request, overrides = {}) {
  return {
    schemaVersion: 'orpad.workerResult.v1',
    adapterCallId: request.adapterCallId,
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    status: 'done',
    summary: 'Mock probe completed with no candidates.',
    artifacts: [],
    candidateProposals: [],
    emptyPass: {
      reason: 'Mock probe found no candidates this run.',
      evidence: [`mock:${request.adapterCallId}`],
    },
    ...overrides,
  };
}

function fallbackMachineAdapter(fallback) {
  return {
    schemaVersion: 'orpad.machineAdapter.v2',
    enabled: true,
    default: {
      family: 'api',
      providerId: 'anthropic',
      model: 'claude-3-5-sonnet-latest',
      qualityTier: 'standard',
      sessionStrategy: 'none',
      toolPolicy: 'none',
      sandbox: null,
      approvalPolicy: 'never',
      timeoutMs: 5000,
      ephemeral: true,
    },
    fallback,
    probeNodePaths: ['main/probe'],
    candidateLimit: 1,
    proposalTimeoutMs: 5000,
    workerTimeoutMs: 5000,
  };
}

async function makeAnthropicProbeWorkspace(runId, options = {}) {
  const {
    machineAdapter = {
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
    adapterOverrides = {
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
    },
  } = options;
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
      // By default the pipeline file declares codex-cli and the override
      // below swaps it to anthropic. Fallback tests pass a v2 adapter
      // directly so the router can consume its fallback chain.
      machineAdapter,
    },
    graphs: [{ id: 'main', file: 'graphs/main.or-graph' }],
  }, null, 2), 'utf8');
  if (adapterOverrides) {
    await fs.writeFile(
      path.join(pipelineDir, 'pipeline.adapter-overrides.json'),
      JSON.stringify(adapterOverrides, null, 2),
      'utf8',
    );
  }
  const run = await orchestration.createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId,
  });
  return { workspaceRoot, pipelineDir, pipelinePath, run };
}

test('anthropic v2 override routes the probe through the router and plugin.invokeApi with mocked fetch', async () => {
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
    const probeAttemptStarted = events.find(e =>
      e.eventType === 'adapter.attempt.started'
      && e.nodePath === 'main/probe'
      && e.payload?.providerId === 'anthropic');
    assert.equal(Boolean(probeAttemptStarted), true, 'expected router attempt event for anthropic probe');
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

test('machine API probe routes KEY_MISSING through router fallback to a keyless successor', async () => {
  const { workspaceRoot, pipelinePath, pipelineDir, run } = await makeAnthropicProbeWorkspace(
    'run_api_probe_keyless_fallback',
    {
      adapterOverrides: null,
      machineAdapter: fallbackMachineAdapter([
        { family: 'api', providerId: 'openai', model: 'gpt-4o-mini', reason: 'requires-key' },
        { family: 'cli', providerId: 'codex-cli', model: 'codex', reason: 'keyless-local' },
      ]),
    },
  );
  try {
    const calls = [];
    let fallbackRequest = null;
    let fallbackResult = null;
    await orchestration.executeMachineRunStep({
      workspaceRoot,
      pipelinePath,
      pipelineDir,
      runRoot: run.runRoot,
      runId: run.runId,
      exportLatestRunAfterStep: false,
      apiProbeProviderInvoker: async ({ request }) => {
        calls.push(request.providerSelection.providerId);
        if (request.providerSelection.providerId === 'anthropic') {
          const err = new Error('missing key');
          err.code = 'KEY_MISSING';
          throw err;
        }
        assert.equal(request.providerSelection.providerId, 'codex-cli');
        fallbackRequest = request;
        fallbackResult = workerResultForRequest(request, {
          summary: 'Keyless fallback probe completed.',
        });
        return fallbackResult;
      },
    });

    assert.deepEqual(calls, ['anthropic', 'codex-cli']);
    assert.equal(fallbackResult.adapterCallId, fallbackRequest.adapterCallId);
    assert.equal(fallbackResult.attemptId, fallbackRequest.attemptId);
    assert.equal(fallbackResult.idempotencyKey, fallbackRequest.idempotencyKey);
    assert.equal(fallbackResult.routingDecision, undefined, 'fake result should be decorated by the router, not the fake invoker');

    const events = await orchestration.readMachineEvents(run.runRoot);
    const fallbackEvent = events.find(e =>
      e.eventType === 'adapter.attempt.fallback'
      && e.nodePath === 'main/probe'
      && e.payload?.classification === 'KEY_MISSING');
    assert.equal(fallbackEvent?.payload?.toProviderId, 'codex-cli');
    const resultEvent = events.find(e =>
      e.eventType === 'adapter.result'
      && e.nodePath === 'main/probe'
      && e.payload?.status === 'done');
    assert.equal(Boolean(resultEvent), true,
      `expected successful adapter.result; saw ${[...new Set(events.map(e => e.eventType))].join(', ')}`);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('machine API probe records RATE_LIMIT fallback event before succeeding on fallback candidate (5x)', async () => {
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const { workspaceRoot, pipelinePath, pipelineDir, run } = await makeAnthropicProbeWorkspace(
      `run_api_probe_rate_fallback_${iteration}`,
      {
        adapterOverrides: null,
        machineAdapter: fallbackMachineAdapter([
          { family: 'cli', providerId: 'codex-cli', model: 'codex', reason: 'rate-limit-local-fallback' },
        ]),
      },
    );
    try {
      const calls = [];
      await orchestration.executeMachineRunStep({
        workspaceRoot,
        pipelinePath,
        pipelineDir,
        runRoot: run.runRoot,
        runId: run.runId,
        exportLatestRunAfterStep: false,
        apiProbeProviderInvoker: async ({ request }) => {
          calls.push(request.providerSelection.providerId);
          if (request.providerSelection.providerId === 'anthropic') {
            const err = new Error('rate limited');
            err.code = 'RATE_LIMIT';
            throw err;
          }
          return workerResultForRequest(request, {
            summary: `Rate-limit fallback probe completed on iteration ${iteration}.`,
          });
        },
      });
      assert.deepEqual(calls, ['anthropic', 'codex-cli']);

      const events = await orchestration.readMachineEvents(run.runRoot);
      const primaryFinished = events.find(e =>
        e.eventType === 'adapter.attempt.finished'
        && e.nodePath === 'main/probe'
        && e.payload?.providerId === 'anthropic'
        && e.payload?.classification === 'RATE_LIMIT');
      const fallbackEvent = events.find(e =>
        e.eventType === 'adapter.attempt.fallback'
        && e.nodePath === 'main/probe');
      const fallbackStarted = events.find(e =>
        e.eventType === 'adapter.attempt.started'
        && e.nodePath === 'main/probe'
        && e.payload?.providerId === 'codex-cli');
      assert.equal(fallbackEvent?.payload?.fromProviderId, 'anthropic');
      assert.equal(fallbackEvent?.payload?.toProviderId, 'codex-cli');
      assert.equal(fallbackEvent?.payload?.classification, 'RATE_LIMIT');
      assert.equal(
        primaryFinished.sequence < fallbackEvent.sequence && fallbackEvent.sequence < fallbackStarted.sequence,
        true,
        `fallback ordering failed on iteration ${iteration}`,
      );
      const resultEvent = events.find(e =>
        e.eventType === 'adapter.result'
        && e.nodePath === 'main/probe'
        && e.payload?.status === 'done');
      assert.equal(Boolean(resultEvent), true, `expected successful adapter.result on iteration ${iteration}`);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  }
});

test('machine API probe forwards AbortSignal and does not fallback after cancellation (10x)', async () => {
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const controller = new AbortController();
    const { workspaceRoot, pipelinePath, pipelineDir, run } = await makeAnthropicProbeWorkspace(
      `run_api_probe_cancel_${iteration}`,
      {
        adapterOverrides: null,
        machineAdapter: fallbackMachineAdapter([
          { family: 'cli', providerId: 'codex-cli', model: 'codex', reason: 'cancel-should-not-fallback' },
        ]),
      },
    );
    try {
      const calls = [];
      let capturedSignal = null;
      await assert.rejects(
        orchestration.executeMachineRunStep({
          workspaceRoot,
          pipelinePath,
          pipelineDir,
          runRoot: run.runRoot,
          runId: run.runId,
          exportLatestRunAfterStep: false,
          signal: controller.signal,
          apiProbeProviderInvoker: async ({ request, signal }) => {
            calls.push(request.providerSelection.providerId);
            capturedSignal = signal;
            assert.equal(signal, controller.signal);
            return new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                const err = new Error('fake provider invocation aborted by test');
                err.name = 'AbortError';
                err.code = 'ABORT_ERR';
                reject(err);
              }, { once: true });
              setImmediate(() => controller.abort(new Error(`cancel iteration ${iteration}`)));
            });
          },
        }),
        error => error?.code === 'MACHINE_RUN_CANCELLED'
          && error?.classification === 'CANCELLED'
          && error?.retryable === false
          && error?.fallbackAllowed === false,
      );
      assert.deepEqual(calls, ['anthropic']);
      assert.equal(capturedSignal, controller.signal);

      const events = await orchestration.readMachineEvents(run.runRoot);
      const fallbackEvent = events.find(e =>
        e.eventType === 'adapter.attempt.fallback'
        && e.nodePath === 'main/probe');
      assert.equal(fallbackEvent, undefined, `cancelled probe must not fallback on iteration ${iteration}`);
      const nodeCancelled = events.find(e =>
        e.eventType === 'node.cancelled'
        && e.nodePath === 'main/probe'
        && e.payload?.code === 'MACHINE_RUN_CANCELLED'
        && e.payload?.classification === 'CANCELLED');
      assert.equal(Boolean(nodeCancelled), true,
        `expected node.cancelled for cancellation; saw ${[...new Set(events.map(e => e.eventType))].join(', ')}`);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
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
