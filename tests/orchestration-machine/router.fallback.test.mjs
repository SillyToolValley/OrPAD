import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  DEFAULT_RETRY_BUDGET,
  decideActionForError,
  decideAttempts,
  dispatchAdapter,
  indexOfNextKeylessCandidate,
  nextKeylessCandidate,
  SCHEMA_VERSIONS,
} = require('../../src/main/orchestration-machine');

function buildAdapterRequest(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSIONS.adapterRequest,
    adapter: 'router-fallback-test',
    runId: 'run_20260506_fallback',
    adapterCallId: 'adapter_call_001',
    attemptId: 'attempt_001',
    idempotencyKey: 'run_20260506_fallback:probe:attempt_001',
    nodePath: 'main/probe',
    taskKind: 'probe',
    workspaceMode: 'read-only',
    inputArtifacts: ['queue/inbox/x.json'],
    adapterResultPath: 'runs/run_20260506_fallback/adapters/adapter_call_001/response.json',
    outputContract: SCHEMA_VERSIONS.adapterResult,
    ...overrides,
  };
}

function workerResult(overrides = {}) {
  return {
    schemaVersion: 'orpad.workerResult.v1',
    adapterCallId: 'adapter_call_001',
    attemptId: 'attempt_001',
    idempotencyKey: 'run_20260506_fallback:probe:attempt_001',
    status: 'done',
    summary: 'sample',
    artifacts: ['a/b'],
    ...overrides,
  };
}

const v2WithFallback = {
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
    timeoutMs: 600000,
    ephemeral: true,
  },
  fallback: [
    {
      family: 'api',
      providerId: 'openai',
      model: 'gpt-4o-mini',
      reason: 'cost',
    },
    {
      family: 'cli',
      providerId: 'codex-cli',
      model: 'codex',
      reason: 'keyless-local',
    },
  ],
};

test('DEFAULT_RETRY_BUDGET pins maxAttempts and selfRepairAttempts', () => {
  assert.equal(DEFAULT_RETRY_BUDGET.maxAttempts >= 1, true);
  assert.equal(DEFAULT_RETRY_BUDGET.selfRepairAttempts >= 0, true);
  assert.equal(typeof DEFAULT_RETRY_BUDGET.backoffMs, 'number');
});

test('decideActionForError(FATAL) always fails without fallback', () => {
  const action = decideActionForError({
    error: { code: 'FATAL' },
    candidate: { selection: { providerId: 'anthropic' } },
    remainingCandidates: [{ selection: { providerId: 'codex-cli' } }],
  });
  assert.equal(action.action, 'fail');
  assert.equal(action.classification, 'FATAL');
});

test('decideActionForError(BUDGET_EXCEEDED) fails even when fallback exists', () => {
  const action = decideActionForError({
    error: { code: 'BUDGET_EXCEEDED' },
    candidate: { selection: { providerId: 'anthropic' } },
    remainingCandidates: [{ selection: { providerId: 'codex-cli' } }],
  });
  assert.equal(action.action, 'fail');
  assert.equal(action.classification, 'BUDGET_EXCEEDED');
});

test('decideActionForError(RETRYABLE) retries while budget remains', () => {
  const candidate = { selection: { providerId: 'anthropic' } };
  let result = decideActionForError({
    error: { code: 'RETRYABLE' },
    candidate,
    remainingCandidates: [],
    attemptCounters: { sameCandidateAttempts: 1 },
    retryBudget: { maxAttempts: 2 },
  });
  assert.equal(result.action, 'retry');
  result = decideActionForError({
    error: { code: 'RETRYABLE' },
    candidate,
    remainingCandidates: [],
    attemptCounters: { sameCandidateAttempts: 2 },
    retryBudget: { maxAttempts: 2 },
  });
  assert.equal(result.action, 'fail', 'no fallback after retry budget exhausted');
});

test('decideActionForError(RETRYABLE) falls back when budget exhausted but fallback exists', () => {
  const result = decideActionForError({
    error: { code: 'RETRYABLE' },
    candidate: { selection: { providerId: 'anthropic' } },
    remainingCandidates: [{ selection: { providerId: 'openai' } }],
    attemptCounters: { sameCandidateAttempts: 2 },
    retryBudget: { maxAttempts: 2 },
  });
  assert.equal(result.action, 'fallback');
  assert.equal(result.target.selection.providerId, 'openai');
});

test('decideActionForError(RATE_LIMIT) falls back immediately', () => {
  const result = decideActionForError({
    error: { code: 'RATE_LIMIT' },
    candidate: { selection: { providerId: 'anthropic' } },
    remainingCandidates: [{ selection: { providerId: 'openai' } }],
  });
  assert.equal(result.action, 'fallback');
});

test('decideActionForError(RATE_LIMIT) without fallback fails', () => {
  const result = decideActionForError({
    error: { code: 'RATE_LIMIT' },
    candidate: { selection: { providerId: 'anthropic' } },
    remainingCandidates: [],
  });
  assert.equal(result.action, 'fail');
});

test('decideActionForError(KEY_MISSING) skips key-required successors and lands on a keyless plugin', () => {
  const result = decideActionForError({
    error: { code: 'KEY_MISSING' },
    candidate: { selection: { providerId: 'anthropic' } },
    remainingCandidates: [
      { selection: { providerId: 'openai' } },        // needsKey:true → skipped
      { selection: { providerId: 'codex-cli' } },     // needsKey:false → chosen
    ],
  });
  assert.equal(result.action, 'fallback');
  assert.equal(result.target.selection.providerId, 'codex-cli');
});

test('decideActionForError(KEY_MISSING) without keyless successor fails', () => {
  const result = decideActionForError({
    error: { code: 'KEY_MISSING' },
    candidate: { selection: { providerId: 'anthropic' } },
    remainingCandidates: [{ selection: { providerId: 'openai' } }],
  });
  assert.equal(result.action, 'fail');
});

test('decideActionForError(OUTPUT_VIOLATES_CONTRACT) self-repairs once before fallback', () => {
  const candidate = { selection: { providerId: 'anthropic' } };
  let result = decideActionForError({
    error: { code: 'OUTPUT_VIOLATES_CONTRACT' },
    candidate,
    remainingCandidates: [{ selection: { providerId: 'openai' } }],
    attemptCounters: { selfRepairAttempts: 0 },
    retryBudget: { selfRepairAttempts: 1 },
  });
  assert.equal(result.action, 'self-repair');
  result = decideActionForError({
    error: { code: 'OUTPUT_VIOLATES_CONTRACT' },
    candidate,
    remainingCandidates: [{ selection: { providerId: 'openai' } }],
    attemptCounters: { selfRepairAttempts: 1 },
    retryBudget: { selfRepairAttempts: 1 },
  });
  assert.equal(result.action, 'fallback');
});

test('nextKeylessCandidate returns the first keyless plugin', () => {
  const list = [
    { selection: { providerId: 'openai' } },
    { selection: { providerId: 'codex-cli' } },
    { selection: { providerId: 'ollama' } },
  ];
  const target = nextKeylessCandidate(list);
  assert.equal(target.selection.providerId, 'codex-cli');
  assert.equal(indexOfNextKeylessCandidate(list), 1);
});

test('nextKeylessCandidate returns null when no keyless plugin remains', () => {
  assert.equal(nextKeylessCandidate([{ selection: { providerId: 'openai' } }]), null);
  assert.equal(indexOfNextKeylessCandidate([{ selection: { providerId: 'anthropic' } }]), -1);
});

test('dispatchAdapter falls back from anthropic → codex-cli on KEY_MISSING (keyless successor)', async () => {
  const calls = [];
  const result = await dispatchAdapter({
    pipelineAdapter: v2WithFallback,
    request: buildAdapterRequest(),
    invoker: async (req) => {
      calls.push(req.providerSelection.providerId);
      if (req.providerSelection.providerId === 'anthropic') {
        const err = new Error('no key');
        err.code = 'KEY_MISSING';
        throw err;
      }
      return workerResult({ summary: `${req.providerSelection.providerId}-ok` });
    },
  });
  // anthropic (KEY_MISSING) → openai (skipped, needsKey) → codex-cli (keyless)
  assert.deepEqual(calls, ['anthropic', 'codex-cli']);
  assert.equal(result.routingDecision.providerId, 'codex-cli');
  assert.equal(result.summary, 'codex-cli-ok');
});

test('dispatchAdapter skips openai stub and falls back to codex-cli on RATE_LIMIT', async () => {
  const calls = [];
  const result = await dispatchAdapter({
    pipelineAdapter: v2WithFallback,
    request: buildAdapterRequest(),
    invoker: async (req) => {
      calls.push(req.providerSelection.providerId);
      if (req.providerSelection.providerId === 'anthropic') {
        const err = new Error('rate-limited');
        err.code = 'RATE_LIMIT';
        throw err;
      }
      return workerResult({ summary: `${req.providerSelection.providerId}-ok` });
    },
  });
  assert.deepEqual(calls, ['anthropic', 'codex-cli']);
  assert.equal(result.routingDecision.providerId, 'codex-cli');
  assert.equal(result.routingDecision.fallbackChainConsumed, 2);
});

test('dispatchAdapter repeatedly records diagnostics when skipping openai stub fallback', async () => {
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const calls = [];
    const beforeEvents = [];
    const fallbackEvents = [];
    const result = await dispatchAdapter({
      pipelineAdapter: v2WithFallback,
      request: buildAdapterRequest({
        adapterCallId: `adapter_call_rate_${iteration}`,
        attemptId: `attempt_rate_${iteration}`,
        idempotencyKey: `run_20260506_fallback:probe:attempt_rate_${iteration}`,
      }),
      beforeAttempt: e => beforeEvents.push(e),
      onFallback: e => fallbackEvents.push(e),
      invoker: async (req) => {
        calls.push(req.providerSelection.providerId);
        if (req.providerSelection.providerId === 'anthropic') {
          const err = new Error('rate-limited');
          err.code = 'RATE_LIMIT';
          throw err;
        }
        if (req.providerSelection.providerId === 'openai') {
          assert.fail('stub openai provider must not be invoked as a fallback candidate');
        }
        return workerResult({ summary: `${req.providerSelection.providerId}-ok` });
      },
    });
    assert.deepEqual(calls, ['anthropic', 'codex-cli']);
    assert.equal(result.routingDecision.providerId, 'codex-cli');
    assert.equal(result.routingDecision.fallbackChainConsumed, 2);

    const skipped = beforeEvents.find(e => e.eventType === 'adapter.attempt.skipped');
    assert.equal(skipped?.payload?.providerId, 'openai');
    assert.equal(skipped?.payload?.reason, 'provider-implementation-status-stub');
    assert.equal(skipped?.payload?.nextAction.includes('runnable provider'), true);

    assert.equal(fallbackEvents.length, 1);
    assert.equal(fallbackEvents[0].payload.requestedProviderId, 'openai');
    assert.equal(fallbackEvents[0].payload.toProviderId, 'codex-cli');
    assert.deepEqual(fallbackEvents[0].payload.skippedProviderIds, ['openai']);
  }
});

test('dispatchAdapter surfaces stub diagnostic when no runnable fallback successor exists', async () => {
  const calls = [];
  const beforeEvents = [];
  await assert.rejects(
    dispatchAdapter({
      pipelineAdapter: {
        ...v2WithFallback,
        fallback: [{ family: 'api', providerId: 'openai', model: 'gpt-4o-mini', reason: 'cost' }],
      },
      request: buildAdapterRequest(),
      beforeAttempt: e => beforeEvents.push(e),
      invoker: async (req) => {
        calls.push(req.providerSelection.providerId);
        if (req.providerSelection.providerId === 'anthropic') {
          const err = new Error('rate-limited');
          err.code = 'RATE_LIMIT';
          throw err;
        }
        assert.fail('stub-only fallback chain should not invoke a successor');
      },
    }),
    error => error?.code === 'MACHINE_API_PLUGIN_STUB'
      && error?.providerId === 'openai'
      && /fallback chain/.test(error?.nextAction || ''),
  );
  assert.deepEqual(calls, ['anthropic']);
  const skipped = beforeEvents.find(e => e.eventType === 'adapter.attempt.skipped');
  assert.equal(skipped?.payload?.providerId, 'openai');
  assert.equal(skipped?.payload?.reason, 'provider-implementation-status-stub');
});

test('dispatchAdapter direct openai stub selection fails before invoking or falling back', async () => {
  let invokerCalls = 0;
  await assert.rejects(
    dispatchAdapter({
      pipelineAdapter: {
        ...v2WithFallback,
        default: { family: 'api', providerId: 'openai', model: 'gpt-4o-mini' },
        fallback: [{ family: 'cli', providerId: 'codex-cli', model: 'codex', reason: 'keyless-local' }],
      },
      request: buildAdapterRequest(),
      invoker: async () => {
        invokerCalls += 1;
        return workerResult();
      },
    }),
    error => error?.code === 'MACHINE_API_PLUGIN_STUB' && error?.providerId === 'openai',
  );
  assert.equal(invokerCalls, 0);
});

test('dispatchAdapter retries the same candidate on RETRYABLE before falling back', async () => {
  const calls = [];
  const events = [];
  const result = await dispatchAdapter({
    pipelineAdapter: v2WithFallback,
    request: buildAdapterRequest(),
    retryBudget: { maxAttempts: 3, backoffMs: 0, selfRepairAttempts: 0 },
    invoker: async (req) => {
      calls.push(req.providerSelection.providerId);
      if (req.providerSelection.providerId === 'anthropic' && calls.length < 3) {
        const err = new Error('transient');
        err.code = 'RETRYABLE';
        throw err;
      }
      return workerResult({ summary: 'recovered' });
    },
    onRetry: e => events.push(e),
  });
  assert.equal(calls.filter(p => p === 'anthropic').length, 3);
  assert.equal(result.routingDecision.providerId, 'anthropic');
  assert.equal(events.filter(e => e.eventType === 'adapter.attempt.retry').length, 2);
});

test('dispatchAdapter self-repairs OUTPUT_VIOLATES_CONTRACT once before falling back', async () => {
  const calls = [];
  const events = [];
  await dispatchAdapter({
    pipelineAdapter: v2WithFallback,
    request: buildAdapterRequest(),
    retryBudget: { maxAttempts: 2, backoffMs: 0, selfRepairAttempts: 1 },
    invoker: async (req) => {
      calls.push(req.providerSelection.providerId);
      if (req.providerSelection.providerId === 'anthropic') {
        const err = new Error('bad json');
        err.code = 'OUTPUT_VIOLATES_CONTRACT';
        throw err;
      }
      return workerResult({ summary: `${req.providerSelection.providerId}-ok` });
    },
    onSelfRepair: e => events.push(e),
    onFallback: e => events.push(e),
  });
  // anthropic primary, 1 self-repair, then openai stub is skipped for codex-cli.
  assert.equal(calls.filter(p => p === 'anthropic').length, 2);
  assert.equal(calls.includes('openai'), false);
  assert.equal(calls.includes('codex-cli'), true);
  assert.equal(events.filter(e => e.eventType === 'adapter.attempt.self-repair').length, 1);
  assert.equal(events.filter(e => e.eventType === 'adapter.attempt.fallback').length, 1);
  assert.deepEqual(
    events.find(e => e.eventType === 'adapter.attempt.fallback')?.payload?.skippedProviderIds,
    ['openai'],
  );
});

test('dispatchAdapter throws BUDGET_EXCEEDED instead of falling back', async () => {
  await assert.rejects(
    dispatchAdapter({
      pipelineAdapter: v2WithFallback,
      request: buildAdapterRequest(),
      invoker: async () => {
        const err = new Error('over budget');
        err.code = 'BUDGET_EXCEEDED';
        throw err;
      },
    }),
    error => error?.code === 'BUDGET_EXCEEDED' || error?.classification === 'BUDGET_EXCEEDED',
  );
});

test('dispatchAdapter throws FATAL without consuming fallback', async () => {
  let fallbackCalls = 0;
  await assert.rejects(
    dispatchAdapter({
      pipelineAdapter: v2WithFallback,
      request: buildAdapterRequest(),
      invoker: async () => {
        const err = new Error('fatal');
        err.code = 'FATAL';
        throw err;
      },
      onFallback: () => { fallbackCalls += 1; },
    }),
    error => error?.classification === 'FATAL',
  );
  assert.equal(fallbackCalls, 0);
});

test('dispatchAdapter exhausts the fallback chain and surfaces the last error if all fail', async () => {
  const calls = [];
  const beforeEvents = [];
  await assert.rejects(
    dispatchAdapter({
      pipelineAdapter: v2WithFallback,
      request: buildAdapterRequest(),
      beforeAttempt: e => beforeEvents.push(e),
      invoker: async (req) => {
        calls.push(req.providerSelection.providerId);
        const err = new Error('rate');
        err.code = 'RATE_LIMIT';
        throw err;
      },
    }),
    error => error?.classification === 'RATE_LIMIT',
  );
  assert.deepEqual(calls, ['anthropic', 'codex-cli']);
  assert.equal(
    beforeEvents.find(e => e.eventType === 'adapter.attempt.skipped')?.payload?.providerId,
    'openai',
  );
});

test('per-fallback budget guard halts the chain when concurrent ledger growth blows the cap', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const orchestration = require('../../src/main/orchestration-machine');
  const runRoot = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'orpad-budget-fallback-'));
  try {
    const pipeline = {
      schemaVersion: 'orpad.machineAdapter.v2',
      enabled: true,
      default: { family: 'api', providerId: 'anthropic', model: 'claude-3-5-sonnet-latest' },
      fallback: [{ family: 'cli', providerId: 'codex-cli', model: 'codex', reason: 'keyless-local' }],
      budget: { perCallUsd: 5, perRunUsd: 1, hardStop: true },
    };
    let invokerCalls = 0;
    await assert.rejects(
      dispatchAdapter({
        runRoot,
        pipelineAdapter: pipeline,
        request: buildAdapterRequest({ adapterCallId: 'next', attemptId: 'next', idempotencyKey: 'next' }),
        invoker: async () => {
          invokerCalls += 1;
          if (invokerCalls === 1) {
            // Simulate a concurrent ledger update happening between the
            // first attempt's failure and the fallback dispatch — e.g.
            // another node in the same run completed an expensive
            // adapter call. This is exactly what the per-fallback
            // budget re-check is designed to catch.
            await orchestration.appendBudgetEntry(runRoot, {
              runId: 'run_x',
              adapterCallId: 'concurrent',
              attemptId: 'concurrent',
              providerId: 'anthropic',
              model: 'claude-3-5-sonnet-latest',
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costEstimateUsd: 0.95 },
            });
            const err = new Error('rate-limited');
            err.code = 'RATE_LIMIT';
            throw err;
          }
          return workerResult({ summary: 'should-not-reach' });
        },
        // Pre-call estimate would push past perRunUsd=1.0 only after the
        // concurrent 0.95 entry lands.
        estimateNextCostUsd: () => 0.5,
      }),
      error => error?.code === 'BUDGET_EXCEEDED' || error?.classification === 'BUDGET_EXCEEDED',
    );
    assert.equal(invokerCalls, 1, 'fallback attempt must be blocked by the per-fallback budget guard');
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('routingDecision.fallbackChainConsumed reports the index of the candidate that succeeded', async () => {
  const result = await dispatchAdapter({
    pipelineAdapter: v2WithFallback,
    request: buildAdapterRequest(),
    invoker: async (req) => {
      if (req.providerSelection.providerId !== 'codex-cli') {
        const err = new Error('rate');
        err.code = 'RATE_LIMIT';
        throw err;
      }
      return workerResult({ summary: 'cli ok' });
    },
  });
  // codex-cli is index 2 in [anthropic, openai, codex-cli].
  assert.equal(result.routingDecision.fallbackChainConsumed, 2);
});

test('decideAttempts shape compatibility with the fallback loop', () => {
  const candidates = decideAttempts({ pipelineAdapter: v2WithFallback });
  // 1 default + 2 fallback
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].chosenBy, 'pipeline');
  assert.equal(candidates[1].chosenBy, 'fallback');
  assert.equal(candidates[2].chosenBy, 'fallback');
});
