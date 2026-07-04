# Implement a `codex` provider adapter for OrPAD orchestration

You are the **OpenAI Codex CLI**. Implement first-class support for running OrPAD's
governed delegation **with the codex CLI**, so that selecting "Codex" in the GUI
runs `codex` and the live trace graph fills with per-tool nodes — the same way the
existing `claude` adapter does.

You know the codex CLI (its non-interactive flags + stdout format) far better than
the original author did. The author knows OrPAD's internals; everything OrPAD-specific
you need is written below so you don't have to guess OrPAD's schema.

---

## Hard constraints (read first)

1. **DO NOT modify the `claude` adapter's behavior.** Same flags, same output parsing.
   Only ADD codex support + the minimal shared plumbing below.
2. **DO NOT change** the renderer / graph code (`src/renderer/**`), the IPC trace tee,
   or the trace **event schema**. You only PRODUCE events in that schema.
3. Keep the goal delivered on **stdin** (multi-line prompts must not go through argv
   under `shell: true`).
4. After your change, `npx playwright test --project=electron tests/e2e/core-live-trace.spec.ts --workers=1`
   must still pass **3/3**, and `npm run build:renderer` must pass.
5. Prefer a small, surgical diff. No dependency additions.

---

## How a run works (context)

- IPC handler `orpad-core-run-start` (`src/main/orchestration-core/ipc.cjs`) builds
  `baseOpts` (includes `agent` = the provider key from the GUI) and calls
  `core.runGroundedDelegation` / `core.runGovernedDelegation`.
- The run executes the agent **inside an isolated overlay dir** (a git-free copy). The
  agent edits files there; OrPAD later diffs the overlay and applies the result to the
  workspace. **This overlay/apply path is provider-agnostic and already works** — your
  job is only the *agent invocation + trace*, not apply.
- Every trace event is streamed to the renderer AND appended to `run/trace.jsonl`
  (the IPC `send` tee). The renderer's `buildEmergentGraph` turns the event stream into
  the live graph.

## The single function you touch for invocation

`delegateToAgent(...)` in `src/main/orchestration-core/core.cjs`. It:
- resolves a provider via `getProvider(agent)` from the `PROVIDERS` map (already added),
- spawns `provider.command` with `provider.buildArgs({ allowedTools, streamMode })`,
  `cwd: overlayRoot`, `shell: true`,
- writes the goal to `child.stdin` and ends it,
- if `streamMode` (currently `provider.stream && (traceFile||onTraceEvent)`) parses each
  stdout NDJSON line with `trace.streamEventToTrace(obj)` — **this is claude-specific and
  is the part you must make provider-driven** (see Task B).

The existing `PROVIDERS` entry to replace:
```js
codex: { command: 'codex', stream: false, buildArgs: () => ['exec', '--full-auto', '-'] },
```

---

## TASK A — correct codex invocation

Fix the codex `PROVIDERS` entry so `codex` runs **non-interactively** in `overlayRoot`,
auto-approves file edits/commands (it is sandboxed in the overlay), reads the **goal from
stdin**, and (if codex can emit machine-readable output) emits a parseable stream on
stdout. Use whatever flags codex actually supports (e.g. `exec`, a non-interactive/CI
flag, an auto-approve flag, a JSON/JSONL output flag). Set `stream: true` only if you
implement Task B's parser; otherwise leave `stream: false` (the run still works, the
graph just shows the 5 phase nodes without per-tool detail).

`buildArgs({ allowedTools, streamMode })` may use `allowedTools` (an array of tool names)
if codex supports an allow-list; otherwise ignore it.

## TASK B — stdout → OrPAD trace parser (this is what fills the graph)

Make the stream parsing **provider-driven** instead of hardcoded:
1. Give each provider an optional `parseLine(obj|string, atIso) -> traceEvent[]`.
   - For `claude`, `parseLine = (obj, at) => trace.streamEventToTrace(obj, at)` (NO behavior
     change — just move the existing call behind the adapter).
   - For `codex`, write a parser that converts **codex's actual stdout** into the OrPAD
     trace events below.
2. In `delegateToAgent`'s stdout handler, call `provider.parseLine(...)` instead of
   `trace.streamEventToTrace(...)` directly. If codex emits NDJSON, parse per line like
   claude; if it emits something else, adapt the line handling accordingly (but keep
   claude's NDJSON path identical).

### The trace event schema you must emit (consumed by `buildEmergentGraph`)

Emit a flat array of these objects, in execution order, as codex works:

- **Tool/step starts** (a file read, edit, shell command, web search, sub-agent, etc.):
  ```js
  { ev: 'node', state: 'active', toolId: '<stable id or null>',
    type: '<see classifyTool>', label: '<short human label>',
    file: '<absolute/relative file path or null>', at: '<iso>' }
  ```
- **Tool/step finishes** (close the matching node; OrPAD matches by `toolId`, else the
  most recent open node):
  ```js
  { ev: 'node', state: 'done', toolId: '<same id as the start>', at: '<iso>' }
  ```
- **Model thinking / prose** (optional, shown as a transient node, collapsed in the graph):
  ```js
  { ev: 'node', state: 'active', toolId: null, type: 'reason', transient: true,
    label: 'Reason', at: '<iso>' }
  ```
- **Run finished** (emit once at the end if codex reports completion/cost):
  ```js
  { ev: 'run', state: 'done', at: '<iso>', costUsd: <number|null>, numTurns: <number|null> }
  ```

`type` must be one of the buckets from `classifyTool` (`src/main/orchestration-core/trace.cjs`):
`inspect` (read/grep/glob/ls), `edit` (write/edit/multiedit/applypatch), `exec` (bash/shell),
`research` (websearch/webfetch), `subagent` (task), `plan` (todowrite), `tool` (anything else).
Map codex's tool/event names onto these. `file` should be the path for read/write-type tools
(so the file-access layer links it), else `null`.

**Reference implementation:** `streamEventToTrace` in `src/main/orchestration-core/trace.cjs`
(lines ~48-90) shows exactly how claude's `tool_use` / `tool_result` / `result` events map to
the above. Mirror that mapping for codex's event names/shape.

---

## Test

1. `npm run build:renderer` (must pass).
2. `npx playwright test --project=electron tests/e2e/core-live-trace.spec.ts --workers=1` (3/3).
3. Manual: in the orchestration window, pick **Codex** above Goal, enter a tiny goal
   (e.g. "create hello.txt with the text hi"), Run. Confirm: codex runs, `hello.txt`
   is applied to the workspace, and the live graph shows tool-use nodes (not just the
   5 phase nodes). Open the run again from "Run history" and confirm replay matches.

## Out of scope (do NOT do)

- API/HTTP providers (CLI only here).
- Touching gemini, the graph themes, the form, or apply/verify logic.
- Renderer changes.
