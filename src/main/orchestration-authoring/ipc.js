const path = require('path');
const fs = require('fs/promises');
const { isInsidePath } = require('../authority');
const { runMachineProcess } = require('../orchestration-machine/adapters/process-runner');
const {
  codexCliCommand,
  codexCliExecArgs,
  codexCliInvocation,
} = require('../orchestration-machine/providers/plugins/codex-cli');
const {
  claudeCodeCommand,
  claudeCodeExecArgs,
  claudeCodeInvocation,
} = require('../orchestration-machine/providers/plugins/claude-code');

// Providers that can act as the Generate authoring agent. The renderer modal
// is the source of truth for the user-facing list, but the backend re-checks
// the selection here so that an unsupported providerId never silently
// degrades to codex-cli.
const GENERATE_AUTHORING_SUPPORTED_PROVIDERS = new Set(['codex-cli', 'claude-code']);

const GENERATE_EVENT_CHANNEL = 'orchestration-generate-pipeline-event';
const activeGenerateRunsByRequest = new Map();
const activeGenerateRunsByWorkspace = new Map();

function workspaceRunKey(workspaceRoot) {
  return path.resolve(String(workspaceRoot || '')).toLowerCase();
}

function emitGenerateEvent(sender, requestId, payload = {}) {
  if (!requestId || sender?.isDestroyed?.()) return;
  sender.send(GENERATE_EVENT_CHANNEL, {
    requestId,
    updatedAt: new Date().toISOString(),
    ...payload,
  });
}

function parseCliJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('OrPAD CLI returned no output.');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`OrPAD CLI returned invalid JSON: ${err.message}`);
  }
}

function extractJsonText(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Authoring agent returned no output.');
  try {
    JSON.parse(raw);
    return raw;
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const candidate = fenced[1].trim();
    JSON.parse(candidate);
    return candidate;
  }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const candidate = raw.slice(first, last + 1);
    JSON.parse(candidate);
    return candidate;
  }
  throw new Error('Authoring agent did not return CLI JSON.');
}

function tryExtractJson(text) {
  try {
    return JSON.parse(extractJsonText(text));
  } catch {
    return null;
  }
}

function looksLikeAuthoringSpec(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  // The authoring spec contract requires a graph with nodes; the OrPAD CLI
  // response, on the other hand, always carries `success` + `pipelinePath`.
  // We accept either shape: CLI response signals success directly, spec shape
  // routes through the fallback in-process generator.
  if (candidate.success === true && (candidate.pipelinePath || candidate.graphPath)) return false;
  const graph = candidate.graph;
  if (graph && typeof graph === 'object' && Array.isArray(graph.nodes)) return true;
  if (Array.isArray(candidate.nodes)) return true;
  return false;
}

async function loadAuthoringSpecFromSources({ stdoutSource, authoringSpecPath }) {
  // Priority 1: parse the model's stdout (handles plain JSON, fenced JSON, or
  // text wrapped around JSON).
  const fromStdout = tryExtractJson(stdoutSource || '');
  if (looksLikeAuthoringSpec(fromStdout)) return fromStdout;
  // Priority 2: read whatever the model wrote to authoringSpecPath on disk —
  // this is the canonical handoff file when the model couldn't (or wouldn't)
  // spawn the OrPAD CLI itself.
  if (authoringSpecPath) {
    let diskText = '';
    try { diskText = await fs.readFile(authoringSpecPath, 'utf-8'); } catch {}
    if (diskText) {
      const fromDisk = tryExtractJson(diskText);
      if (looksLikeAuthoringSpec(fromDisk)) return fromDisk;
    }
  }
  return null;
}

function summarizeForError(label, text, limit = 320) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return `${label}: (empty)`;
  return `${label}(${value.length}b): ${value.slice(0, limit)}${value.length > limit ? '…' : ''}`;
}

async function materializePipelineFromAuthoringSpec({ workspaceRoot, prompt, authoringSpec }) {
  // Lazy-require to avoid pulling generator.js into the IPC module's
  // require graph during test bootstrap.
  const { createOrchestrationPipeline } = require('./generator');
  return createOrchestrationPipeline({
    workspaceRoot,
    taskText: prompt,
    authoringSpec,
  });
}

function assertGeneratedPath(workspaceRoot, filePath, label) {
  const target = path.resolve(String(filePath || ''));
  if (!target || !isInsidePath(target, workspaceRoot)) {
    throw new Error(`${label} was outside the approved workspace.`);
  }
  return target;
}

async function collectWorkspaceSnapshot(workspaceRoot, maxFiles = 120) {
  const files = [];
  const skip = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage']);
  async function walk(dir, depth = 0) {
    if (files.length >= maxFiles || depth > 4) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(workspaceRoot, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  }
  await walk(workspaceRoot);
  return { files };
}

function authoringAgentPrompt({ workspaceRoot, appRoot, cliPath, promptFile, authoringSpecPath, prompt, snapshot }) {
  const input = {
    workspaceRoot,
    appRoot,
    orpadCliPath: cliPath,
    promptFile,
    authoringSpecPath,
  };
  const files = Array.isArray(snapshot.files) ? snapshot.files.slice(0, 120) : [];
  return [
    'You are the OrPAD Generate authoring agent.',
    '',
    'Your job is to design a deterministic OrPAD orchestration graph that conducts non-deterministic LLM work for the user request.',
    'OrPAD principle: the LLM is non-deterministic; the pipeline is the deterministic structure that conducts it. A flat linear chain is almost always wrong — real tasks need branching, loops, verification, retrieval, agents, sub-graphs, or combinations of those.',
    '',
    'You MUST use the OrPAD CLI to materialize the pipeline. Do not hand-write `.or-pipeline` or `.or-graph` files directly. You may write exactly one authoring spec JSON file, then run OrPAD CLI with that spec.',
    '',
    '<orpad-authoring-input>',
    JSON.stringify(input, null, 2),
    '</orpad-authoring-input>',
    '',
    '<user-request>',
    prompt,
    '</user-request>',
    '',
    '<workspace-files>',
    files.length ? files.map(file => `- ${file}`).join('\n') : '- No file snapshot supplied.',
    '</workspace-files>',
    '',
    'Required steps (two-pass authoring):',
    '1. INSPECT — read just enough of the workspace to make the graph concrete to this request. Do not start editing source files.',
    '2. DRAFT — internally draft an authoring spec. Pick from the OrPAD Pattern Catalog (Linear, Ralph loop, Fork-Join, Cross-Validation, Behavior-Tree Sub-graph, RAG Retrieval, Ontology Scan, Multi-Agent Cross-Verification). Real tasks usually combine 2–3 patterns.',
    '3. CRITIQUE — before writing the file, mentally answer this checklist:',
    '   a. Is my draft a flat 9-node linear chain? If yes, REDESIGN (rare exception: a truly single-pass deterministic edit).',
    '   b. Does the request imply iteration or refinement (writing, refactor, slides, agent prompts, doc rewrites)? If yes, the spec MUST contain a gate whose `onFail` transition loops back to a worker.',
    '   c. Are there independent sub-scopes (multiple services, modules, files, lessons)? If yes, use `orpad.selector` + multiple `orpad.workerLoop` + `orpad.barrier` to fork-join.',
    '   d. Does correctness matter (bug fix, schema migration, security)? If yes, chain at least two distinct verifications (e.g. `orpad.patchReview` + `orpad.gate`, or two `orpad.gate` nodes with different criteria).',
    '   e. Does the task decompose hierarchically? If yes, extract sub-stages into `orpad.graph` (sub-graph) or `orpad.tree` (behavior-tree leaves).',
    '   f. Does the work need workspace grounding? If yes, make `orpad.context` and `orpad.probe` carry a SPECIFIC retrieval lens (e.g. lens: "auth-middleware-refactor"), not generic "inspect-files".',
    '   g. Have I encoded loop-back transitions explicitly (transition.from = gate, transition.to = earlier worker, transition.condition = "revise") and given selectors/gates distinct `condition` values on their outgoing transitions?',
    '   h. Every `orpad.gate` MUST have concrete task-specific `criteria` strings. Reject placeholders like "task-specific checks pass".',
    '   i. Are node IDs and labels in the user\'s domain language? Reject generic labels like "worker" / "verify" / "find risks".',
    '4. REVISE — if the critique flags anything, redesign the spec before writing. Record the chosen pattern combination and rejected alternatives in `metadata.authoringNotes` (one sentence each).',
    '5. WRITE — write the FINAL spec JSON to authoringSpecPath. Do not write a draft and a final; only the final survives.',
    '6. INVOKE — try to run the OrPAD CLI exactly in this form:',
    '     node "<orpadCliPath>" generate --workspace "<workspaceRoot>" --prompt-file "<promptFile>" --authoring-spec-file "<authoringSpecPath>" --json',
    '   The CLI prints a JSON response on stdout; capture that JSON.',
    '7. RETURN — choose the matching path:',
    '   - If the OrPAD CLI ran successfully: output ONLY the JSON stdout it produced. No Markdown. No commentary.',
    '   - If you could NOT run the OrPAD CLI (no shell tool available, permission denied, command not found, sandbox blocked, etc.): output ONLY the FINAL authoring spec JSON itself — the exact same content you wrote to authoringSpecPath. OrPAD will materialize the pipeline in-process from that JSON. Do not add Markdown fences, prefatory prose, or summaries.',
    '',
    'Authoring spec expectations:',
    '- Top-level keys: title, description, graph, skill, rule, metadata.',
    '- graph contains: id, label, start, nodes[], transitions[].',
    '- The 17 valid node types are: orpad.entry, orpad.exit, orpad.selector, orpad.gate, orpad.barrier, orpad.context, orpad.probe, orpad.rule, orpad.skill, orpad.graph, orpad.tree, orpad.workQueue, orpad.triage, orpad.dispatcher, orpad.workerLoop, orpad.patchReview, orpad.artifactContract.',
    '- Loop-back is just a transition whose target is an earlier node. Use a `condition` string to disambiguate gate/selector branches.',
    '- Include queue + triage + dispatcher + workerLoop + patchReview + artifactContract whenever implementation work runs. Those are how OrPAD owns the work state; they can still be combined with selectors, barriers, gates, sub-graphs, and loop-backs.',
    '- Place `orpad.artifactContract` immediately before `orpad.exit`. Do not put task-specific files in `artifactContract.required`; put them in node summaries or `skill.acceptanceCriteria`.',
    '- `metadata.authoringNotes` MUST name the chosen pattern(s) (e.g. "Pattern B+D") and justify why the alternative patterns were rejected.',
    '',
    'Common failure mode to avoid: emitting Pattern A (Linear) for every request. If your draft looks like entry → context → probe → queue → triage → dispatch → worker → patchReview → gate → artifact → exit with no branches, loops, sub-graphs, or barriers, you almost certainly missed the actual task requirements. Redesign.',
  ].join('\n');
}

async function prepareAuthoringWorkspace({ workspaceRoot, prompt, emit }) {
  emit?.({
    type: 'progress',
    stage: 'snapshot',
    message: 'Collecting workspace context for the LLM authoring agent.',
  });
  const snapshot = await collectWorkspaceSnapshot(workspaceRoot);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').toLowerCase();
  const authoringRoot = path.join(workspaceRoot, '.orpad', 'authoring', `generate-${stamp}`);
  emit?.({
    type: 'progress',
    stage: 'prepare',
    message: 'Preparing the authoring workspace and request snapshot.',
    authoringRoot,
  });
  await fs.mkdir(authoringRoot, { recursive: true });
  const promptFile = path.join(authoringRoot, 'user-request.txt');
  const authoringSpecPath = path.join(authoringRoot, 'authoring-spec.json');
  const outputLastMessagePath = path.join(authoringRoot, 'authoring-agent-result.json');
  await fs.writeFile(promptFile, `${prompt}\n`, 'utf-8');
  return { snapshot, stamp, authoringRoot, promptFile, authoringSpecPath, outputLastMessagePath };
}

async function authorPipelineWithCodexCli({ app, workspaceRoot, prompt, request, signal, emit }) {
  const appRoot = app?.getAppPath ? app.getAppPath() : path.join(__dirname, '..', '..', '..');
  const cliPath = path.join(appRoot, 'bin', 'orpad-cli.mjs');
  const { snapshot, stamp, authoringRoot, promptFile, authoringSpecPath, outputLastMessagePath } =
    await prepareAuthoringWorkspace({ workspaceRoot, prompt, emit });

  const invocation = codexCliInvocation(request.authoringCommand || codexCliCommand(), request.authoringCommandPrefixArgs);
  const agentPrompt = authoringAgentPrompt({
    workspaceRoot,
    appRoot,
    cliPath,
    promptFile,
    authoringSpecPath,
    prompt,
    snapshot,
  });
  emit?.({
    type: 'progress',
    stage: 'agent-started',
    message: 'Starting Codex CLI as the orchestration authoring agent.',
    authoringRoot,
    promptFile,
    authoringSpecPath,
  });
  emit?.({
    type: 'progress',
    stage: 'agent-running',
    message: 'Codex CLI is authoring the graph spec (typical: 4–8 min, timeout: 20 min).',
    authoringRoot,
  });
  const processResult = await runMachineProcess({
    command: invocation.command,
    args: codexCliExecArgs({
      prefixArgs: invocation.prefixArgs,
      sandbox: request.authoringSandbox || 'workspace-write',
      approvalPolicy: request.authoringApprovalPolicy || 'never',
      outputLastMessagePath,
      prompt: agentPrompt,
      ephemeral: request.authoringEphemeral !== false,
      json: request.authoringJson === true,
      cd: workspaceRoot,
    }),
    cwd: workspaceRoot,
    timeoutMs: Number(request.authoringTimeoutMs) || 20 * 60 * 1000,
    maxOutputBytes: 1024 * 1024,
    processKey: `orchestration-authoring:${String(request.requestId || stamp)}`,
    signal,
  });
  if (processResult.cancelled) {
    throw new Error('Generate was cancelled.');
  }
  if (processResult.code !== 0 || processResult.timedOut) {
    const detail = processResult.timedOut
      ? 'authoring agent timed out'
      : (processResult.stderr || processResult.stdout || `exit code ${processResult.code}`);
    throw new Error(`Generate requires the LLM authoring agent to complete: ${detail}`);
  }

  emit?.({
    type: 'progress',
    stage: 'materialize',
    message: 'Reading the OrPAD CLI result from the authoring agent.',
    authoringRoot,
  });
  let raw = '';
  try {
    raw = await fs.readFile(outputLastMessagePath, 'utf-8');
  } catch {
    raw = processResult.stdout || '';
  }
  let generated = null;
  let cliParseError = null;
  try {
    generated = parseCliJson(extractJsonText(raw));
  } catch (err) {
    cliParseError = err;
  }
  // Three possibilities:
  //  (1) parsed an OrPAD CLI response → use it directly.
  //  (2) parsed something that LOOKS like an authoring spec → run the
  //      generator in-process from that spec.
  //  (3) didn't parse anything OR parsed an opaque object → fall back to
  //      authoringSpecPath on disk, then surface a debug-rich error.
  if (generated && looksLikeAuthoringSpec(generated)) {
    emit?.({
      type: 'progress',
      stage: 'materialize-fallback',
      message: 'Authoring agent emitted a spec instead of an OrPAD CLI response; materializing pipeline in-process.',
      authoringRoot,
    });
    generated = await materializePipelineFromAuthoringSpec({
      workspaceRoot,
      prompt,
      authoringSpec: generated,
    });
  } else if (!generated) {
    const fallbackSpec = await loadAuthoringSpecFromSources({
      stdoutSource: raw,
      authoringSpecPath,
    });
    if (fallbackSpec) {
      emit?.({
        type: 'progress',
        stage: 'materialize-fallback',
        message: 'OrPAD CLI output was missing; materializing pipeline from the authoring spec in-process.',
        authoringRoot,
      });
      generated = await materializePipelineFromAuthoringSpec({
        workspaceRoot,
        prompt,
        authoringSpec: fallbackSpec,
      });
    } else {
      const debug = [
        summarizeForError('stdout', processResult.stdout || raw),
        summarizeForError('stderr', processResult.stderr),
        `outputFile: ${outputLastMessagePath}`,
        `authoringSpec: ${authoringSpecPath}`,
      ].join(' | ');
      throw new Error(`${cliParseError?.message || 'Authoring agent did not return CLI JSON.'} ${debug}`);
    }
  }
  if (!generated?.success) {
    const debug = [
      summarizeForError('cliResponse', JSON.stringify(generated || {})),
      summarizeForError('stdout', processResult.stdout || raw),
      summarizeForError('stderr', processResult.stderr),
      `outputFile: ${outputLastMessagePath}`,
      `authoringSpec: ${authoringSpecPath}`,
    ].join(' | ');
    throw new Error(`OrPAD CLI failed inside the LLM authoring agent: ${generated?.error || '(no error field)'}. ${debug}`);
  }
  return {
    generated,
    provider: 'codex-cli',
    model: 'codex',
    snapshot,
    authoringRoot,
    promptFile,
    authoringSpecPath,
    outputLastMessagePath,
    processResult,
  };
}

function unwrapClaudeCliResult(stdout) {
  // Claude Code CLI with --output-format json emits an envelope like
  //   {"type":"result","result":"<assistant text or JSON>","session_id":"...", ...}
  // The OrPAD CLI itself prints JSON, so the assistant text is usually already
  // valid JSON, possibly inside a Markdown fence. We peel one layer when present.
  const text = String(stdout || '').trim();
  if (!text) return '';
  try {
    const envelope = JSON.parse(text);
    if (envelope && typeof envelope === 'object' && typeof envelope.result === 'string') {
      return envelope.result;
    }
  } catch {}
  return text;
}

async function authorPipelineWithClaudeCodeCli({ app, workspaceRoot, prompt, request, signal, emit }) {
  const appRoot = app?.getAppPath ? app.getAppPath() : path.join(__dirname, '..', '..', '..');
  const cliPath = path.join(appRoot, 'bin', 'orpad-cli.mjs');
  const { snapshot, stamp, authoringRoot, promptFile, authoringSpecPath, outputLastMessagePath } =
    await prepareAuthoringWorkspace({ workspaceRoot, prompt, emit });

  const invocation = claudeCodeInvocation(request.authoringCommand || claudeCodeCommand(), request.authoringCommandPrefixArgs);
  const agentPrompt = authoringAgentPrompt({
    workspaceRoot,
    appRoot,
    cliPath,
    promptFile,
    authoringSpecPath,
    prompt,
    snapshot,
  });
  emit?.({
    type: 'progress',
    stage: 'agent-started',
    message: 'Starting Claude Code CLI as the orchestration authoring agent.',
    authoringRoot,
    promptFile,
    authoringSpecPath,
  });
  emit?.({
    type: 'progress',
    stage: 'agent-running',
    message: 'Claude Code CLI is authoring the graph spec (typical: 4–8 min, timeout: 20 min).',
    authoringRoot,
  });
  const processResult = await runMachineProcess({
    command: invocation.command,
    args: claudeCodeExecArgs({
      prefixArgs: invocation.prefixArgs,
      outputFormat: request.authoringOutputFormat || 'json',
      dangerouslySkipPermissions: request.authoringDangerouslySkipPermissions === true,
      allowedTools: request.authoringAllowedTools,
      disallowedTools: request.authoringDisallowedTools,
      // Note: do NOT pass `cd` here. Some Claude Code CLI builds reject the
      // `--cd` flag with `error: unknown option '--cd'`. The working directory
      // is already set via runMachineProcess({ cwd: workspaceRoot }) below,
      // which is the canonical way to scope a child process.
      prompt: agentPrompt,
    }),
    cwd: workspaceRoot,
    timeoutMs: Number(request.authoringTimeoutMs) || 20 * 60 * 1000,
    maxOutputBytes: 1024 * 1024,
    processKey: `orchestration-authoring:${String(request.requestId || stamp)}`,
    signal,
  });
  if (processResult.cancelled) {
    throw new Error('Generate was cancelled.');
  }
  if (processResult.code !== 0 || processResult.timedOut) {
    const detail = processResult.timedOut
      ? 'authoring agent timed out'
      : (processResult.stderr || processResult.stdout || `exit code ${processResult.code}`);
    throw new Error(`Generate requires the LLM authoring agent to complete: ${detail}`);
  }

  emit?.({
    type: 'progress',
    stage: 'materialize',
    message: 'Reading the OrPAD CLI result from the Claude Code authoring agent.',
    authoringRoot,
  });
  // Persist the raw stdout for debugging — Claude Code CLI has no
  // --output-last-message flag, so we capture it ourselves.
  try {
    await fs.writeFile(outputLastMessagePath, processResult.stdout || '', 'utf-8');
  } catch {}
  const unwrapped = unwrapClaudeCliResult(processResult.stdout || '');
  let generated = null;
  let cliParseError = null;
  try {
    generated = parseCliJson(extractJsonText(unwrapped));
  } catch (err) {
    cliParseError = err;
  }
  // Three possibilities: same as the codex-cli branch above. The most common
  // case for Claude --print is (2) — it emits the authoring spec inline rather
  // than invoking the OrPAD CLI through a Bash tool.
  if (generated && looksLikeAuthoringSpec(generated)) {
    emit?.({
      type: 'progress',
      stage: 'materialize-fallback',
      message: 'Claude CLI emitted an authoring spec instead of an OrPAD CLI response; materializing pipeline in-process.',
      authoringRoot,
    });
    generated = await materializePipelineFromAuthoringSpec({
      workspaceRoot,
      prompt,
      authoringSpec: generated,
    });
  } else if (!generated) {
    const fallbackSpec = await loadAuthoringSpecFromSources({
      stdoutSource: unwrapped || processResult.stdout || '',
      authoringSpecPath,
    });
    if (fallbackSpec) {
      emit?.({
        type: 'progress',
        stage: 'materialize-fallback',
        message: 'Claude CLI returned a spec without invoking the OrPAD CLI; materializing the pipeline in-process.',
        authoringRoot,
      });
      generated = await materializePipelineFromAuthoringSpec({
        workspaceRoot,
        prompt,
        authoringSpec: fallbackSpec,
      });
    } else {
      const debug = [
        summarizeForError('stdout', processResult.stdout),
        summarizeForError('unwrapped', unwrapped),
        summarizeForError('stderr', processResult.stderr),
        `outputFile: ${outputLastMessagePath}`,
        `authoringSpec: ${authoringSpecPath}`,
      ].join(' | ');
      throw new Error(`${cliParseError?.message || 'Authoring agent did not return CLI JSON.'} ${debug}`);
    }
  }
  if (!generated?.success) {
    const debug = [
      summarizeForError('cliResponse', JSON.stringify(generated || {})),
      summarizeForError('stdout', processResult.stdout),
      summarizeForError('unwrapped', unwrapped),
      summarizeForError('stderr', processResult.stderr),
      `outputFile: ${outputLastMessagePath}`,
      `authoringSpec: ${authoringSpecPath}`,
    ].join(' | ');
    throw new Error(`OrPAD CLI failed inside the Claude Code authoring agent: ${generated?.error || '(no error field)'}. ${debug}`);
  }
  return {
    generated,
    provider: 'claude-code',
    model: request.authoringModel || 'claude-code',
    snapshot,
    authoringRoot,
    promptFile,
    authoringSpecPath,
    outputLastMessagePath,
    processResult,
  };
}

async function authorPipelineWithSelectedProvider(args) {
  const selection = args.request?.providerSelection || null;
  const providerId = String(selection?.providerId || '').trim() || 'codex-cli';
  if (!GENERATE_AUTHORING_SUPPORTED_PROVIDERS.has(providerId)) {
    throw new Error(
      `Generate provider "${providerId}" is not wired for authoring yet. ` +
      'Use Codex CLI or Claude Code CLI from the Generate modal. ' +
      'Anthropic API and other API providers will arrive in a follow-up PR.',
    );
  }
  args.emit?.({
    type: 'progress',
    stage: 'provider-selected',
    message: `Using ${providerId}${selection?.model ? ` (${selection.model})` : ''} as the authoring agent.`,
    provider: providerId,
    model: selection?.model || '',
  });
  if (providerId === 'claude-code') return authorPipelineWithClaudeCodeCli(args);
  return authorPipelineWithCodexCli(args);
}

function registerOrchestrationAuthoringHandlers({ ipcMain, app, authority }) {
  ipcMain.handle('orchestration-generate-pipeline', async (event, request = {}) => {
    const requestId = String(request.requestId || `generate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const emit = (payload) => emitGenerateEvent(event.sender, requestId, payload);
    let workspaceKey = '';
    let activeRecord = null;
    try {
      emit({
        type: 'progress',
        stage: 'validating',
        message: 'Validating the workspace and Generate request.',
      });
      const workspaceRoot = await authority.assertWorkspacePath(event.sender, request.workspacePath, {
        label: 'Orchestration workspace',
      });
      const prompt = String(request.prompt || '').trim();
      if (!prompt) throw new Error('Generate requires a prompt.');
      workspaceKey = workspaceRunKey(workspaceRoot);
      const existing = activeGenerateRunsByWorkspace.get(workspaceKey);
      if (existing) {
        return {
          success: false,
          ok: false,
          requestId,
          activeRequestId: existing.requestId,
          code: 'ORCHESTRATION_GENERATE_BUSY',
          error: 'Generate is already running for this workspace.',
        };
      }
      activeRecord = {
        requestId,
        senderId: event.sender.id,
        workspaceKey,
        controller: new AbortController(),
        startedAt: new Date().toISOString(),
      };
      activeGenerateRunsByRequest.set(requestId, activeRecord);
      activeGenerateRunsByWorkspace.set(workspaceKey, activeRecord);
      emit({
        type: 'started',
        stage: 'started',
        message: 'Generate started.',
        workspaceRoot,
      });
      const authored = await authorPipelineWithSelectedProvider({
        app,
        workspaceRoot,
        prompt,
        request: { ...request, requestId },
        signal: activeRecord.controller.signal,
        emit,
      });
      const generated = authored.generated;
      const response = {
        ...generated,
        requestId,
        authoringProvider: authored?.provider || '',
        authoringModel: authored?.model || '',
        authoringRoot: assertGeneratedPath(workspaceRoot, authored.authoringRoot, 'Authoring workspace'),
        authoringSpecPath: assertGeneratedPath(workspaceRoot, authored.authoringSpecPath, 'LLM authoring spec'),
        authoringAgentResultPath: assertGeneratedPath(workspaceRoot, authored.outputLastMessagePath, 'LLM authoring result'),
        pipelinePath: assertGeneratedPath(workspaceRoot, generated.pipelinePath, 'Generated pipeline'),
        graphPath: assertGeneratedPath(workspaceRoot, generated.graphPath, 'Generated graph'),
        promptPath: assertGeneratedPath(workspaceRoot, generated.promptPath, 'Generated orchestration prompt'),
      };
      emit({
        type: 'completed',
        stage: 'completed',
        message: 'Pipeline generated.',
        workspaceRoot,
        pipelinePath: response.pipelinePath,
        graphPath: response.graphPath,
        authoringRoot: response.authoringRoot,
      });
      return response;
    } catch (err) {
      const stdout = err?.stdout || '';
      if (stdout) {
        try {
          const parsed = parseCliJson(stdout);
          return { success: false, ok: false, error: parsed.error || err.message };
        } catch {
          // Fall through to the process error.
        }
      }
      const cancelled = activeRecord?.controller?.signal?.aborted || /cancelled/i.test(err?.message || '');
      const error = cancelled ? 'Generate was cancelled.' : (err?.message || String(err));
      emit({
        type: cancelled ? 'cancelled' : 'error',
        stage: cancelled ? 'cancelled' : 'failed',
        message: error,
        error,
      });
      return { success: false, ok: false, requestId, cancelled, error };
    } finally {
      if (activeRecord) {
        const requestEntry = activeGenerateRunsByRequest.get(requestId);
        if (requestEntry === activeRecord) activeGenerateRunsByRequest.delete(requestId);
        const workspaceEntry = activeGenerateRunsByWorkspace.get(workspaceKey);
        if (workspaceEntry === activeRecord) activeGenerateRunsByWorkspace.delete(workspaceKey);
      }
    }
  });

  ipcMain.handle('orchestration-cancel-generate-pipeline', (event, requestId) => {
    const id = String(requestId || '').trim();
    const entry = activeGenerateRunsByRequest.get(id);
    if (!entry || entry.senderId !== event.sender.id) {
      return { success: false, error: 'No active Generate request matched this window.' };
    }
    entry.controller.abort();
    emitGenerateEvent(event.sender, id, {
      type: 'cancelling',
      stage: 'cancelling',
      message: 'Cancelling Generate...',
    });
    return { success: true, requestId: id };
  });
}

module.exports = {
  registerOrchestrationAuthoringHandlers,
  // Exported for offline harness scripts that drive Generate without Electron.
  authoringAgentPrompt,
  collectWorkspaceSnapshot,
  loadAuthoringSpecFromSources,
  materializePipelineFromAuthoringSpec,
  unwrapClaudeCliResult,
  extractJsonText,
};
