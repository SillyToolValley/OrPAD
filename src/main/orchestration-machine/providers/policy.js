const SESSION_STRATEGIES = Object.freeze([
  'none',
  'sdk-session',
  'conversation-id',
  'previous-response-id',
]);

const TELEMETRY_CAPABILITIES = Object.freeze([
  'use.tracing',
  'export.telemetry',
]);

const TOOL_POLICIES = Object.freeze([
  'none',
]);

function normalizeProviderSelection(input = {}) {
  const providerId = String(input.providerId || input.provider || '').trim();
  const model = String(input.model || '').trim();
  if (!providerId) throw new Error('providerId is required.');
  if (!model) throw new Error('model is required.');
  const sessionStrategy = input.sessionStrategy || 'none';
  if (!SESSION_STRATEGIES.includes(sessionStrategy)) {
    throw new Error(`Unsupported API adapter session strategy: ${sessionStrategy}`);
  }
  const toolPolicy = input.toolPolicy || 'none';
  if (!TOOL_POLICIES.includes(toolPolicy)) {
    const err = new Error(`Unsupported API adapter tool policy: ${toolPolicy}`);
    err.code = 'API_TOOL_POLICY_UNAPPROVED';
    throw err;
  }
  return {
    providerId,
    model,
    qualityTier: input.qualityTier || 'standard',
    sessionStrategy,
    toolPolicy,
  };
}

function hasCapabilityGrant(grants = [], capability) {
  return (grants || []).some(grant => {
    if (grant === capability) return true;
    return grant?.capability === capability && grant?.granted === true;
  });
}

function assertTelemetryPolicy(requestedCapabilities = [], grants = []) {
  for (const capability of requestedCapabilities || []) {
    if (!TELEMETRY_CAPABILITIES.includes(capability)) continue;
    if (!hasCapabilityGrant(grants, capability)) {
      const err = new Error(`API adapter capability is not granted: ${capability}`);
      err.code = capability === 'use.tracing'
        ? 'API_TRACING_NOT_GRANTED'
        : 'API_TELEMETRY_EXPORT_NOT_GRANTED';
      throw err;
    }
  }
  return {
    tracingEnabled: hasCapabilityGrant(grants, 'use.tracing'),
    telemetryExportEnabled: hasCapabilityGrant(grants, 'export.telemetry'),
  };
}

function assertProviderKeySourceAllowed(input = {}) {
  const runtime = input.runtime || 'desktop';
  const keySource = input.keySource || 'safeStorage';
  if (keySource === 'localStorage') {
    const err = new Error('Provider keys must never be read from localStorage.');
    err.code = 'API_KEY_LOCAL_STORAGE_FORBIDDEN';
    throw err;
  }
  if (runtime === 'desktop' && !['safeStorage', 'in-memory-test'].includes(keySource)) {
    const err = new Error(`Unsupported desktop provider key source: ${keySource}`);
    err.code = 'API_KEY_SOURCE_UNAPPROVED';
    throw err;
  }
  if (runtime === 'web' && keySource !== 'indexeddb-consented') {
    const err = new Error('Web provider keys require explicit IndexedDB risk consent.');
    err.code = 'API_WEB_KEY_CONSENT_REQUIRED';
    throw err;
  }
  if (runtime === 'web' && input.webRiskConsent !== true) {
    const err = new Error('Web provider key access requires an explicit risk-consent flag.');
    err.code = 'API_WEB_KEY_CONSENT_REQUIRED';
    throw err;
  }
  return {
    runtime,
    keySource,
    keyReadable: true,
  };
}

function createApiSessionEnvelope(input = {}) {
  const selection = normalizeProviderSelection(input.selection || input);
  const strategy = selection.sessionStrategy;
  const envelope = {
    schemaVersion: 'orpad.apiAdapterSession.v1',
    authoritative: false,
    sessionStrategy: strategy,
    providerId: selection.providerId,
    model: selection.model,
    adapterCallId: input.adapterCallId || '',
    checkpointRef: '',
  };
  if (strategy === 'sdk-session') envelope.sdkSessionId = input.sdkSessionId || '';
  if (strategy === 'conversation-id') envelope.conversationId = input.conversationId || '';
  if (strategy === 'previous-response-id') envelope.previousResponseId = input.previousResponseId || '';
  return envelope;
}

function createNonAuthoritativeTraceRecord(input = {}) {
  return {
    schemaVersion: 'orpad.apiTraceRef.v1',
    authoritative: false,
    providerId: input.providerId || '',
    model: input.model || '',
    adapterCallId: input.adapterCallId || '',
    traceId: input.traceId || '',
    exported: input.exported === true,
  };
}

module.exports = {
  SESSION_STRATEGIES,
  TELEMETRY_CAPABILITIES,
  TOOL_POLICIES,
  assertProviderKeySourceAllowed,
  assertTelemetryPolicy,
  createApiSessionEnvelope,
  createNonAuthoritativeTraceRecord,
  hasCapabilityGrant,
  normalizeProviderSelection,
};
