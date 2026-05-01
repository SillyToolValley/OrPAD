import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  assertProviderKeySourceAllowed,
  buildApiAdapterPrompt,
  createAdapterRequest,
  createApiAgentAdapter,
  createApiSessionEnvelope,
  createMachineRun,
  normalizeProviderSelection,
  parseStructuredAdapterResult,
  readMachineEvents,
} = require('../../src/main/orchestration-machine');

const fixedNow = new Date('2026-04-30T00:00:00.000Z');

async function makeRun(runId = 'run_20260430_api_adapter') {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpad-machine-api-adapter-'));
  const pipelineDir = path.join(workspaceRoot, '.orpad/pipelines/sample-machine-pipeline');
  await fs.mkdir(path.join(pipelineDir, 'graphs'), { recursive: true });
  const pipelinePath = path.join(pipelineDir, 'pipeline.or-pipeline');
  await fs.writeFile(pipelinePath, JSON.stringify({
    kind: 'orpad.pipeline',
    version: '1.0',
    id: 'sample-machine-pipeline',
    entryGraph: 'graphs/main.or-graph',
  }, null, 2), 'utf8');
  return createMachineRun({
    workspaceRoot,
    pipelinePath,
    runId,
    now: fixedNow,
  });
}

function requestFor(run, overrides = {}) {
  return createAdapterRequest({
    adapter: 'api-agent-skeleton',
    runId: run.runId,
    nodePath: 'discovery/api-probe',
    taskKind: 'probe',
    workspaceRoot: run.workspaceRoot,
    workspaceMode: 'read-only',
    inputArtifacts: ['queue/candidate/input.json'],
    adapterCallId: 'api-call',
    attemptId: 'api-attempt-1',
    idempotencyKey: 'api-call:attempt-1',
    outputContract: 'orpad.workerResult.v1',
    ...overrides,
  });
}

function structuredResult(request, overrides = {}) {
  return {
    schemaVersion: 'orpad.workerResult.v1',
    adapterCallId: request.adapterCallId,
    attemptId: request.attemptId,
    idempotencyKey: request.idempotencyKey,
    status: 'blocked',
    summary: 'API adapter returned a structured proposal result.',
    artifacts: [],
    deferredReason: 'skeleton-only',
    ...overrides,
  };
}

test('API adapter is disabled by default and records no Machine events', async () => {
  const run = await makeRun();
  const request = requestFor(run);

  await assert.rejects(
    createApiAgentAdapter().invoke(request),
    error => error?.code === 'API_ADAPTER_DISABLED',
  );

  assert.equal((await readMachineEvents(run.runRoot)).length, 1);
});

test('API response parses to adapter result but cannot mutate Machine queue or run state directly', async () => {
  const run = await makeRun('run_20260430_api_no_mutation');
  const request = requestFor(run);
  const adapter = createApiAgentAdapter({
    enabled: true,
    selection: {
      providerId: 'test-provider',
      model: 'test-model',
      sessionStrategy: 'none',
    },
    keyAccess: {
      runtime: 'desktop',
      keySource: 'in-memory-test',
    },
    fixtureResponse: {
      result: structuredResult(request, {
        status: 'done',
        summary: 'Structured API result only.',
        artifacts: ['artifacts/api/result.json'],
        verification: [{ kind: 'structured-output', status: 'parsed' }],
      }),
    },
  });

  const result = await adapter.invoke(request);

  assert.equal(result.status, 'done');
  assert.equal(result.apiSession.authoritative, false);
  assert.equal((await readMachineEvents(run.runRoot)).length, 1);
});

test('API tracing and telemetry are denied unless capability grants are explicit', async () => {
  const run = await makeRun('run_20260430_api_tracing');
  const request = requestFor(run);

  await assert.rejects(
    createApiAgentAdapter({
      enabled: true,
      selection: { providerId: 'test-provider', model: 'test-model' },
      keyAccess: { runtime: 'desktop', keySource: 'in-memory-test' },
      requestedCapabilities: ['use.tracing'],
      fixtureResponse: { result: structuredResult(request), traceId: 'trace-denied' },
    }).invoke(request),
    error => error?.code === 'API_TRACING_NOT_GRANTED',
  );

  const result = await createApiAgentAdapter({
    enabled: true,
    selection: { providerId: 'test-provider', model: 'test-model' },
    keyAccess: { runtime: 'desktop', keySource: 'in-memory-test' },
    requestedCapabilities: ['use.tracing'],
    capabilityGrants: [{ capability: 'use.tracing', granted: true }],
    fixtureResponse: { result: structuredResult(request), traceId: 'trace-allowed' },
  }).invoke(request);

  assert.equal(result.apiTrace.traceId, 'trace-allowed');
  assert.equal(result.apiTrace.authoritative, false);
  assert.equal(result.apiTrace.exported, false);
});

test('provider key policy rejects localStorage and requires web IndexedDB consent', () => {
  assert.throws(
    () => assertProviderKeySourceAllowed({ runtime: 'desktop', keySource: 'localStorage' }),
    error => error?.code === 'API_KEY_LOCAL_STORAGE_FORBIDDEN',
  );
  assert.throws(
    () => assertProviderKeySourceAllowed({ runtime: 'web', keySource: 'indexeddb-consented' }),
    error => error?.code === 'API_WEB_KEY_CONSENT_REQUIRED',
  );
  assert.deepEqual(
    assertProviderKeySourceAllowed({
      runtime: 'web',
      keySource: 'indexeddb-consented',
      webRiskConsent: true,
    }),
    {
      runtime: 'web',
      keySource: 'indexeddb-consented',
      keyReadable: true,
    },
  );
});

test('API provider selection rejects side-effecting tool policies', () => {
  assert.throws(
    () => normalizeProviderSelection({
      providerId: 'test-provider',
      model: 'test-model',
      toolPolicy: 'execute-shell',
    }),
    error => error?.code === 'API_TOOL_POLICY_UNAPPROVED',
  );
});

test('API session envelope is adapter-local non-authoritative metadata', async () => {
  const envelope = createApiSessionEnvelope({
    selection: {
      providerId: 'test-provider',
      model: 'test-model',
      sessionStrategy: 'previous-response-id',
    },
    adapterCallId: 'api-call',
    previousResponseId: 'resp_123',
  });

  assert.equal(envelope.authoritative, false);
  assert.equal(envelope.previousResponseId, 'resp_123');
  assert.equal(envelope.checkpointRef, '');
});

test('API prompt assembly and structured result parsing preserve request identity', async () => {
  const run = await makeRun('run_20260430_api_parse');
  const request = requestFor(run);
  const prompt = buildApiAdapterPrompt({
    request,
    instructions: 'Return only the worker result JSON.',
    contextArtifacts: ['artifacts/context/source.json'],
  });

  assert.equal(prompt.outputContract, 'orpad.workerResult.v1');
  assert.deepEqual(prompt.contextArtifacts, ['artifacts/context/source.json']);
  assert.equal(
    parseStructuredAdapterResult(JSON.stringify({ result: structuredResult(request) }), request).idempotencyKey,
    request.idempotencyKey,
  );
  assert.throws(
    () => parseStructuredAdapterResult({
      result: structuredResult(request, { idempotencyKey: 'wrong' }),
    }, request),
    /Adapter result idempotencyKey does not match the request/,
  );
});
