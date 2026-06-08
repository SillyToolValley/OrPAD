# OrPAD Security Baseline

_Generated during P0-10 security scan on 2026-04-24. Updated through P1-5 template work. Re-run on every major release._

## Electron hardening

| Setting | Value | Status |
|---------|-------|--------|
| `nodeIntegration` | `false` | PASS |
| `contextIsolation` | `true` | PASS |
| `sandbox` | `true` | PASS |

`src/main/main.js` line 181–186. All three are set to their secure values. The renderer
process is fully sandboxed with no direct Node.js access.

**Navigation hardening:** `will-navigate` events are blocked in `app.on('web-contents-created')`. Navigation is only permitted for `file:///` URLs that resolve to a supported extension (via `isSupportedFile()`). All other navigations are cancelled.

**Window opening:** `setWindowOpenHandler` returns `{ action: 'deny' }` for every request; http/https URLs are passed to `shell.openExternal` (the OS browser). Both `http://` and `https://` are forwarded. See Follow-ups #2.

**preload.js — contextBridge surface** (`window.orpad`):

| Method | Proxies to | Risk class |
|--------|-----------|------------|
| `platform` | `process.platform` (static) | LOW |
| `getAppInfo()` | `get-app-info` — returns version + isPackaged | LOW |
| `aiKeys.status()` / `set()` / `getDecrypted()` / `remove()` | `safeStorage` encrypted provider keys | MEDIUM (secret broker) |
| `aiConversations.*` | `.orpad/conversations/*.json` inside selected workspace | MEDIUM |
| `getSystemTheme()` | `get-system-theme` | LOW |
| `openFileDialog()` | `open-file-dialog` — shows native file picker | LOW |
| `saveFile(filePath, content)` | `save-file` — writes to filePath | MEDIUM (see IPC handlers) |
| `saveFileAs(content)` | `save-file-as` — shows save dialog | LOW |
| `dropFile(p)` | `drop-file` — opens dropped file path | LOW (isSupportedFile check) |
| `getPathForFile(f)` | `webUtils.getPathForFile` — File → path | LOW |
| `openDefaultAppsSettings()` | `open-default-apps-settings` | LOW |
| `showSaveDialog()` | `show-save-dialog` | LOW |
| `onCheckBeforeClose(cb)` / `onNewFromTemplate(cb)` / `confirmClose()` | window close/menu flow | LOW |
| `getLocale()` / `setLocale(code)` | locale read/write | LOW |
| `autoSaveRecovery(filePath, content)` | `auto-save-recovery` — SHA-256 keyed recovery dir | LOW |
| `clearRecovery(filePath)` | `clear-recovery` — deletes recovery file | LOW |
| `saveImage(filePath, buffer, ext)` | `save-image` — writes to `./assets/` subdir | LOW |
| `setTitle(title)` | `set-title` | LOW |
| `readFile(filePath)` | `read-file` — reads arbitrary path | MEDIUM |
| `openFolderDialog()` | `open-folder-dialog` — shows native picker | LOW |
| `readDirectory(dirPath)` / `watchDirectory` / `unwatchDirectory` | directory watch | MEDIUM |
| `onDirectoryChanged(cb)` | receives directory-change events | LOW |
| `createFile(filePath)` / `createFolder` / `renameFile` / `deleteFile` | filesystem mutations | MEDIUM |
| `searchFiles(dirPath, query, options)` | workspace search | MEDIUM |
| `buildLinkIndex` / `resolveWikiLink` / `getBacklinks` / `getFileNames` | wiki-link graph | MEDIUM |
| `pipelines.*` / `runbooks.*` validation, scan, run-record, and local-run APIs | `.or-pipeline`, `.or-graph`, `.or-tree`, and legacy `.orch-*` validation plus local MVP run evidence | HIGH (future execution substrate) |
| `machine.*` validation, run-store, readback, listing, resume, run/claim cancellation, approval decision, execute-step adapter, patch-apply, and evidence snapshot APIs | Feature-gated Orchestration Machine IPC for durable run metadata plus deterministic harness and recognized Codex CLI adapter execution | HIGH (execution substrate) |
| `revealInExplorer(targetPath)` | `shell.showItemInFolder` | LOW |
| `saveBinary` / `saveText` | save-dialog before write | LOW |
| `svgToPng(svg, w, h, bg)` | offscreen BrowserWindow render | LOW |
| `onShowUpdateDialog` / `onUpdateProgress` / `onUpdateError` / `updateAction` | auto-updater UI | LOW |

No Node.js or Electron internals are exposed directly. Filesystem and pipeline/runbook methods that
accept paths must go through the main-process authority model described in IPC Handlers.
`dropFile()` and `getPathForFile()` accept string paths only when the Electron test harness sets
`ORPAD_TEST_USER_DATA`; production builds require browser `File` objects for dropped files.

**preload.js - MCP surface** (`window.mcp`, desktop only):

| Method family | Proxies to | Risk class |
|---------------|------------|------------|
| `listServers()` / `upsertServer()` / `removeServer()` / `exportConfig()` / `importConfig()` | `mcp-*-server/config` handlers, stored in `userData/mcp-servers.json` | MEDIUM |
| `setEnabled(id, enabled, workspacePath)` / `refreshServer(id)` | Start/stop/list metadata for a configured stdio MCP server | HIGH (process launch, opt-in) |
| `listTools()` / `listResources()` / `readResource()` | MCP client read operations | MEDIUM |
| `prepareToolCall()` / `grantPermission()` / `revokeGlobalPermission()` / `callTool()` | Permission-token gated MCP tool execution | HIGH (server-defined capability) |

**preload.js - Command Runner surface** (`window.terminal`, desktop only):

| Method family | Proxies to | Risk class |
|---------------|------------|------------|
| `history()` | Reads command-only history from `userData/runner-history.json` | LOW |
| `run(request)` | Starts one shell-less child process via `spawn(shell:false)` | HIGH (user command execution) |
| `cancel(runId)` / `status()` | Cancels or inspects the active run | MEDIUM |
| `onEvent(cb)` | Streams stdout/stderr/exit events from main to renderer | MEDIUM |

**preload.js - PTY Terminal surface** (`window.pty`, desktop only):

| Method family | Proxies to | Risk class |
|---------------|------------|------------|
| `shells()` / `restore()` | Lists detected shells and saved `{ shell, cwd }` metadata | LOW |
| `spawn(request)` | Starts a native PTY shell via `@homebridge/node-pty-prebuilt-multiarch` | HIGH (interactive user shell) |
| `write(sessionId, data)` / `resize(sessionId, cols, rows)` / `kill(sessionId)` | Sends input/control to an existing PTY session | HIGH |
| `onEvent(cb)` | Streams PTY data/exit events from main to renderer | MEDIUM |

## Content Security Policy

**Electron desktop:** enforced by two mechanisms simultaneously (both must be satisfied):
1. `<meta http-equiv="Content-Security-Policy">` in `src/renderer/index.html` line 5.
2. `session.defaultSession.webRequest.onHeadersReceived` in `src/main/main.js` line 976.

**Effective CSP:**
```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self' https: http://localhost:* http://127.0.0.1:*;
worker-src 'self' blob:;
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
```

| Check | Result |
|-------|--------|
| `unsafe-eval` anywhere | NONE FOUND — PASS |
| `<script src="http://...">` | NONE — PASS |
| Non-HTTPS external scripts | NONE — PASS |

**`unsafe-inline` on `style-src`:** Accepted. The theme engine generates inline `<style>` blocks dynamically at runtime; removing this would require a nonce-based approach or a full style-in-JS rewrite. Documented as Follow-up #3.

**P0-10 fix applied:** `RENDERER_CSP` constant in `main.js` was missing `https://plausible.io`
relative to the meta tag, silently blocking analytics in the desktop app. Fixed by adding the
origin to the constant (comment already stated the two must match).

**P1-1 AI provider update:** `connect-src` is now intentionally broader:
- `https:` supports BYO OpenAI-compatible HTTPS endpoints as well as OpenAI, Anthropic,
  OpenRouter, GitHub release checks, and Plausible.
- `http://localhost:*` and `http://127.0.0.1:*` support local Ollama and local
  OpenAI-compatible servers.

This does not allow external scripts, frames, or navigation. It does increase the impact of a
future renderer XSS because a compromised renderer could exfiltrate over HTTPS; mitigations
remain `script-src 'self'`, sandboxed renderer, DOMPurify, and no remote script loading.

**P1-3 MCP update:** MCP stdio traffic runs through Electron IPC and child stdio, not browser
network fetches, so no new CSP `connect-src` origin is required for MCP itself. Enabling an MCP
server may launch `npx` and that process may perform its own network or filesystem operations
according to the server implementation; this is handled by the MCP permission model below, not
by CSP.

**Web build:** CSP is enforced via the meta tag only (no server-side headers). GitHub Pages
serves static files without custom headers. This is expected — the meta tag provides the same
policy. A future improvement would add a `_headers` or `vercel.json` to serve a CSP header from
the web host (Follow-up #4).

## localStorage / IndexedDB surface

All keys use the `orpad-` prefix convention. Inventory as of P0-10:

| Key | What it stores | Contains secret/PII? | Encrypted? |
|-----|---------------|---------------------|-----------|
| `orpad-workspace-path` | Last opened folder path | No | No |
| `orpad-zoom` | Zoom level 0–200% | No | No |
| `orpad-mmd-theme` | Mermaid diagram theme name | No | No |
| `orpad-diff-pretty` | Diff mode flag | No | No |
| `orpad-diff-other` | Right-pane diff text | No (document content only) | No |
| `orpad-sidebar-visible` | Sidebar open/closed | No | No |
| `orpad-sidebar-width` | Sidebar width in pixels | No | No |
| `orpad-sidebar-panel` | Active sidebar panel | No | No |
| `orpad-ai-sidebar-visible` | AI sidebar open/closed | No | No |
| `orpad-ai-sidebar-width` | AI sidebar width in pixels | No | No |
| `orpad-ai-provider` | Selected AI provider id | No | No |
| `orpad-ai-model-*` | Selected AI model id per provider | No | No |
| `orpad-ai-endpoint-*` | User-configured AI endpoint URL | No | No |
| `orpad-ai-include-tabs` / `orpad-ai-include-tree` | AI context toggles | No | No |
| `orpad-ai-web-key-warning-ok` | Web key-storage warning acknowledgement | No | No |
| `orpad-view-mode` | Editor/split/preview mode | No | No |
| `orpad-divider-ratio` | Editor/preview split ratio | No | No |
| `orpad-locale` | UI language code | No | No |
| `orpad-locale-mtime` | Locale file mtime | No | No |
| `orpad-last-schema` | Last JSON schema text | No (user JSON schema) | No |
| `orpad-search-exts` | Selected search file extensions | No | No |
| `orpad-toc-visible` | TOC legacy flag | No | No |
| `orpad-first-run` | First-run sentinel | No | No |
| `theme-id` | Active theme ID | No | No |
| `custom-themes` | Custom theme JSON blob | No | No |
| `sentry-opt-out` | Crash reporting opt-out flag | No | No |
| `analytics-opt-out` | Analytics opt-out flag | No | No |

**Result: No secrets, tokens, or PII are stored in localStorage.**

**P1-1 AI provider keys:**
- **Desktop (Electron):** `src/main/ai-keys.js` stores encrypted key blobs under
  `app.getPath('userData')/ai-keys.json` using `safeStorage.encryptString` /
  `safeStorage.decryptString`. If OS encryption is unavailable, the app refuses to save keys
  rather than falling back to plaintext.
- **Web:** keys are stored in IndexedDB only after an explicit warning modal with a checkbox.
  This is browser-origin storage and is not OS-encrypted.
- The settings UI stores/display masks only (`sk-****last4`) and never logs raw keys.

**P1-1 conversation storage:** Desktop conversations are stored per workspace under
`.orpad/conversations/*.json` with path normalization that keeps writes inside that
subdirectory. Web/untitled conversations use IndexedDB (`orpad-ai`, store
`conversations`).

**P1-3 MCP storage:** Desktop MCP server config and persisted read-only tool permissions live
under `app.getPath('userData')` as `mcp-servers.json` and `mcp-permissions.json`. No MCP
configuration or permission grants are stored in localStorage. Global persisted permission is
restricted to tool names matching `^(list|get|read|search|query)_`.

**P1-4a Command Runner storage:** Desktop command history is stored under
`app.getPath('userData')/runner-history.json`, capped at 200 commands. Outputs are kept in
renderer memory only and are cleared on app quit. Obvious `key/token/secret/password=...`
arguments are redacted before commands are persisted, but users should still avoid putting
secrets directly on the command line.

**P1-4b PTY Terminal storage:** Desktop terminal restore metadata is stored under
`app.getPath('userData')/terminal-sessions.json` as `{ shell, cwd }` only. Output, scrollback,
typed input, and command blocks are not persisted. Terminal output can be attached to AI only
through the same transient renderer-memory attachment path used by Command Runner.

**P1-5 template storage:** Built-in templates are static renderer modules. New documents are
ordinary unsaved Markdown tabs until the user saves them. Template status is derived from the
active document/frontmatter and is not stored separately.

**P2 OrPAD Pipeline MVP storage:** Pipeline validation and workspace fact scanning are exposed
through desktop IPC. The scanner returns counts and candidate file paths only; it does not read
arbitrary workspace file contents. A metadata-only workspace index snapshot is cached under app
`userData` at `workspace-index/{workspaceHash}.json`; it stores counts, relative pipeline and
legacy runbook paths, redaction candidates, and marker state, with `contentIncluded: false`.
Pipeline-local MVP runs write only under the approved workspace's
`.orpad/pipelines/<pipeline>/runs/{runId}/` directory and currently include `run.or-run`,
`events.jsonl`, `context/context-manifest.json`, `artifacts/manifest.json`,
`artifacts/claim-register.md`, and empty `checkpoints/` folders. Legacy `.orch-*` targets continue
to write under `.orch-runs/{runId}/run.json`. The context manifest records included/excluded path
metadata and token estimates, not raw context file contents.

## MCP security model

P1-3 introduces an MCP client in the Electron main process. This intentionally changes the
security baseline: main can now launch configured stdio MCP servers when the user enables them.
The implementation adds the following guardrails:

- All default MCP servers are disabled by default.
- Default package specs are exact-version pinned: `@modelcontextprotocol/sdk@1.29.0`,
  `@modelcontextprotocol/server-filesystem@2026.1.14`,
  `@modelcontextprotocol/server-github@2025.4.8`, and fallback
  `@cyanheads/git-mcp-server@2.14.2`.
- The official npm package `@modelcontextprotocol/server-git` was unavailable during P1-3, so
  the git default uses a pinned third-party fallback and remains disabled by default.
- MCP tool execution is not automatic. The renderer must first request a one-minute permission
  token from main, show a user approval modal, then pass that token to `mcp-call-tool`.
- Session and global grants are allowed only for read-only-looking tool names matching
  `^(list|get|read|search|query)_`; mutating-looking tools require a fresh approval every time.
- AI provider tool calls use aliased MCP tool names and are resolved back to server/tool only by
  the MCP UI controller. Unknown aliases are rejected.
- MCP resources can be opened from the MCP panel as user-initiated reads and are loaded into a
  new unsaved editor tab.

Residual risk: once a user enables a custom MCP server, that server process runs with the OS
permissions of the app process. This is an explicit opt-in power-user feature and should be
treated like installing a local plugin or CLI tool.

## Command Runner security model

P1-4a introduces a minimal one-command-at-a-time runner in the Electron main process. It is a
deliberate desktop-only power feature with these guardrails:

- Commands are tokenized in the renderer into `{ command, args[] }`; shell operators such as
  `&&`, `||`, `;`, pipes, and redirects are rejected with a clear message.
- Main process uses `child_process.spawn` with `shell:false`. There is no shell expansion,
  glob expansion, piping, or implicit `cmd.exe` / PowerShell wrapping.
- The working directory must be inside the current workspace root unless the user grants a
  one-time outside-workspace approval in the UI. This approval is not persisted.
- Only one command can run at a time. Cancellation kills immediately on Windows and uses
  SIGTERM then SIGKILL on Unix-like platforms.
- The inherited environment is filtered before spawn. `SENTRY_DSN`, `GITHUB_TOKEN`, `PASSWORD`,
  and any `*_KEY`, `*_TOKEN`, or `*_SECRET` variables are removed; the UI displays how many
  environment variables were masked.
- AI can prefill commands from fenced `bash` / `sh` / `powershell` blocks, but cannot execute
  them. The user must press Enter or the Run button.
- Command output can be attached to the next AI message for 60 seconds and is visible as a
  user-controlled attachment chip. This does not re-run commands.

## PTY Terminal security model

P1-4b adds a full interactive terminal backed by a native PTY. This is intentionally more
powerful than Command Runner and should be treated like an embedded VS Code terminal:

- PTY spawn is desktop-only and exposed only through `contextBridge`; the sandboxed renderer
  still has no direct Node.js access.
- The initial working directory must be inside the current workspace root unless the user grants
  a one-time outside-workspace approval. Once a shell is running, it has normal OS shell powers,
  including `cd`, just like any local terminal.
- The inherited environment is filtered before shell spawn using the same `SENTRY_DSN`,
  `GITHUB_TOKEN`, `PASSWORD`, `*_KEY`, `*_TOKEN`, and `*_SECRET` rules as Command Runner.
- PowerShell starts with `-NoProfile`; bash and zsh use OrPAD-owned init files for OSC 633
  shell integration. This avoids loading user profile scripts for the integration path.
- OSC 633 command boundaries are parsed in the renderer to create transient command blocks.
  Output and scrollback are not written to disk.
- AI shell suggestions are never auto-executed. Runner mode pre-fills an input; Terminal mode
  creates a reviewable draft. Multiline drafts are copy-only to avoid accidental execution.
- Web builds replace the PTY view with a stub and do not expose `window.pty`.

## OrPAD Pipeline MVP security model

P2 introduces the first OrPAD Pipeline substrate for `.or-pipeline`, `.or-graph`, and `.or-tree`
files while preserving legacy `.orch-tree.json` and `.orch-graph.json` compatibility. This slice
validates pipelines and creates minimal local run records; it does not yet execute AI, terminal,
MCP, URL, or file-write pipeline steps.

- Pipeline file reads use the same renderer authority model as ordinary workspace files.
- Workspace pipeline scanning is metadata-only and stays inside the approved workspace.
- Referenced Skill, Rule, Graph, and Tree files must stay inside the pipeline directory for MVP
  validation. Existing referenced files are checked with realpath-based containment so symlinks
  cannot point a pipeline ref outside its allowed root. Legacy `.orch-*` Skill refs must stay
  inside the legacy runbook directory.
- `Generate Pipeline` may use the existing configured AI provider to draft the
  referenced Skill Markdown from the user's typed task. It uses the same
  `ai-provider-chat` proxy/key-storage rules as the AI sidebar and falls back
  to a local template when no provider is available.
- Imported or generated trust levels (`imported-review`, `generated-draft`, `unknown`) are
  marked as review-required and are not executable. A file-declared trust level wins over caller
  options so renderer/API defaults cannot promote an imported pipeline to executable.
- MVP executable node types are limited to `Sequence`, `Skill`, `Gate`, `Context`, simple
  `Retry`, simple `Timeout`, `OrchTree`, and the canonical package-backed equivalents
  `orpad.context`, `orpad.gate`, `orpad.skill`, and `orpad.tree`. Other valid
  orchestration node types are render/validate-only.
- Minimal pipeline run records can be created only inside the approved workspace under
  `.orpad/pipelines/<pipeline>/runs/` for canonical packages, or beside a noncanonical
  workspace-local `.or-pipeline` under `runs/`; legacy records remain restricted to
  `.orch-runs/`. Readback verifies the recorded pipeline path before allowing noncanonical
  sibling `runs/` directories.
- `startLocalRun()` is a local MVP coordinator only: it records context, approval, node lifecycle,
  and a claim-register artifact under the target run directory; it does not execute terminal
  commands, PTY input, MCP tools, URL fetches, provider calls, or writes outside that run directory.
- If local-run approval is denied, `startLocalRun()` returns a blocked result before creating
  run evidence, context manifests, or artifacts.
- AI-suggested commands still cannot run automatically.

## OrPAD Orchestration Machine IPC security model

The Orchestration Machine IPC surface is a typed, feature-gated bridge for durable run metadata
and managed execute-step adapters. It does not expose arbitrary adapter execution, terminal
commands, MCP tools, provider calls, or source workspace edits from the renderer.

- The preload surface exposes one method per action under `window.orpad.machine`; there is no
  generic Machine `invoke(channel, args)` wrapper.
- Main process handlers require `event.sender`, `event.senderFrame.url`, and a `file://`
  renderer frame before doing any path or filesystem work.
- The feature gate is off by default. Runtime handlers reject until `ORPAD_MACHINE_IPC=1` is
  present when handlers are registered, or until an unpackaged/dev session explicitly enables
  managed runs through the typed `machine-enable-session` IPC.
- `machine-enable-session` is unavailable in packaged builds. In unpackaged/dev sessions it is
  reached from an explicit renderer confirmation, flips only the in-memory gate for the current
  process, and generates an in-memory session capability token when no environment token exists.
  It returns only that generated session token; environment-provided tokens still require user or
  process-level provisioning and are not reflected back through this IPC.
- Mutating actions (`machine-create-run`, `machine-execute-run-step`, `machine-resume-run`, `machine-pause-run`, `machine-cancel-run`, `machine-cancel-claim`, `machine-reject-item`, `machine-reprioritize-item`, `machine-inject-item`, `machine-edit-item`, `machine-decide-approval`, `machine-export-latest-run`, `machine-apply-patch`, `machine-review-patch`) require
  either `ORPAD_MACHINE_IPC_TOKEN` or the generated session token and a matching
  `capabilityToken` in the request. Read-only validate, list, and get-run actions still require
  the feature gate and sender/path/schema checks.
- The mutating capability token is entered, environment-supplied, or generated per desktop
  session and kept only in renderer process memory, not Web Storage.
- Requests are typed objects; missing or incorrectly typed fields fail before calling Machine
  storage helpers.
- `workspacePath` and `pipelinePath` must stay inside the renderer's approved workspace authority,
  and Machine execution is limited to `.or-pipeline` files.
- `runId` is an opaque identifier, not a path. It rejects path separators and resolves only under
  `<pipelineDir>/runs/<runId>`.
- `machine-create-run` validates `canMachineExecute` first and writes only the durable Machine run
  layout under the pipeline's `runs/` directory.
- `machine-execute-run-step` supports either a local deterministic `run.machineHarness` fixture or
  a recognized `run.machineAdapter` declaration. Main process loads the pipeline graph, expands
  inline nested graph containers, selects reachable Probe/Triage/Dispatcher/WorkerLoop nodes,
  executes Machine-owned support nodes such as WorkQueue/Gate/Barrier/ArtifactContract lifecycle
  markers, registers a Machine-owned candidate inventory artifact for triage input, claims via the
  dispatcher, runs one WorkerLoop step, finalizes run status from Machine queue inventory, and
  constructs the exact CLI overlay command itself. The renderer cannot pass an arbitrary command,
  args, cwd, or dangerous Codex bypass flag through this channel.
- The initial live adapter is restricted to declared `codex-cli` adapters. Proposal calls run with
  Codex `read-only` sandbox and parse only the `--output-last-message` JSON file because CLI
  stdout/stderr may contain plugin or network noise. Worker calls run from a Machine-owned overlay
  cwd with Codex `workspace-write`; canonical workspace path arguments are rejected, overlay diffs
  are collected as patch artifacts, and canonical source files are not written by this step.
- Runtime node failures return the refreshed durable run snapshot, including post-failure
  `node.failed` events, rather than trusting a renderer-supplied status or stale pre-run snapshot.
- `machine-resume-run` repairs derived queue snapshots from canonical Machine events and recovers
  stale claims through the dispatcher. It refuses terminal runs and pending approval requests, so
  resume cannot bypass an explicit approval decision. When the run is in the supervised-autonomy
  `paused` state it first clears the in-process pause intent, records a durable `run.resume-requested`
  event, and transitions `paused -> waiting` before the standard recovery; the transition is still a
  Machine-owned event-sourced state change, not a renderer-supplied status.
- `machine-pause-run` records supervised-autonomy pause intent for a run: it sets an in-process
  control token and appends a durable `run.pause-requested` event through the Machine event log. It
  does NOT take the run-lifecycle lock (the autonomous driver may hold it) and never kills a process;
  the driver observes the intent at its next step boundary and records the `paused` ack itself, so
  in-flight work always finishes gracefully. Cancel intent (`run.cancel-requested`) is recorded the
  same way at the front of `machine-cancel-run` before the existing cancelling/cancelled ack.
- `machine-cancel-claim` accepts only opaque `runId`, `claimId`, and `itemId` identifiers. Main
  process verifies the active claim lease and queue state before releasing the claim/write-set and
  moving the item to `blocked` or `queued`.
- `machine-reject-item` (STEER "leave this out") accepts only opaque `runId` and `itemId`. Main
  process reads the item's canonical (event-projected) state and rejects ONLY a queued / candidate /
  blocked item — a claimed/in-progress item must be stopped via `machine-cancel-claim` first. The
  rejection is one Machine-authored `queue.transition` to `rejected` (the legal-transition whitelist
  in queue-store gates it), so it is fully replayable from `events.jsonl`. Fail-fast under the
  lifecycle lock (returns `MACHINE_RUN_BUSY` if a step is in flight) — the supervised flow is pause →
  reject → resume. The renderer cannot supply an arbitrary target state.
- `machine-reprioritize-item` (STEER "do this first") accepts only opaque `runId` and `itemId` and
  acts ONLY on a queued item. It records a durable `queue.reprioritized` event whose sequence the
  dispatcher reads (via a pure event projection) as the claim-order priority — it does NOT mutate the
  item snapshot or add a persisted field, so claim order stays a deterministic replay of the log. The
  renderer supplies no priority value (the Machine derives it from event order) and cannot reorder
  claimed/in-progress work. Fail-fast under the lifecycle lock, same pause → steer → resume flow.
- `machine-inject-item` (STEER "add this") accepts a `title` (required) plus optional `targetFiles` /
  `acceptanceCriteria`. Main process BUILDS the candidate proposal — it derives a unique id and
  fingerprint (the renderer cannot forge an id collision or set arbitrary item fields), normalizes +
  schema-validates it via the same path as machine-generated candidates, then runs the standard
  ingest (`inbox→candidate`) and triage (`candidate→queued`) transitions. So an injected item is an
  ordinary, fully-replayable queue item. Fail-fast under the lifecycle lock.
- `machine-edit-item` (STEER "fix this") accepts an `itemId` plus a whitelist of human-meaningful
  fields (`title`, `targetFiles`, `acceptanceCriteria`) — never `id`, `state`, `claim`, or
  `fingerprint`. Queued-only (in-flight/claimed work is not editable — stop the claim first). The
  patched item is re-validated against the `workItem` schema before persisting (a steer edit can
  never write a malformed item), and the edit is recorded as a durable `queue.edited` event carrying
  the patch (audit + replay-of-intent). The edited content lives in the queue snapshot, which the
  resume repair path (`repairDerivedQueueFilesFromEvents`) preserves, so the edit survives replay.
  Fail-fast under the lifecycle lock.
- `machine-run-progress` (PUSH STREAM) is the only main→renderer **push** in the Machine surface: a
  one-way `webContents.send` fired after each completed step of an autonomous drive so the live
  graph/panel refreshes immediately instead of waiting for the renderer's ~2s poll. It is bound to
  the requesting `event.sender` (the renderer that initiated, and was authorized for, the run) and
  guarded against a destroyed/closed window, so a dead frame can never abort the drive. The payload
  is advisory only — `runId`, `stepIndex`, `sequence`, `lifecycleStatus` — and deliberately carries
  NO events, run state, or secrets: on receipt the renderer re-fetches the snapshot through the gated
  `machine-get-run` handler, so `events.jsonl` remains the single source of truth and the poll stays
  as a reconciling fallback. There is no renderer→main attack surface and no capability token (it is
  a notification, not an action).
- `machine-cancel-run` aborts Machine-registered adapter processes for the requested run and then
  routes active claimed work through the same claim cancellation path. If no claim exists yet, it
  records a cancelled partial run state without touching workspace files.
- `machine-decide-approval` can only decide an approval that is currently pending in Machine
  events for the requested run. Approved decisions record Machine-owned grants; denied decisions
  cancel the run through lifecycle guards. The renderer cannot mint arbitrary grants for a
  non-pending approval.
- `machine-export-latest-run` copies a trusted evidence snapshot to the legacy latest-run directory
  for compatibility. It does not apply patches, edit source files, or call external tools.
- `machine-apply-patch` applies user-selected files from a Machine-owned patch artifact only after
  validating the run artifact path, patch schema, write-set membership, and pre-image SHA for each
  selected workspace file. Selected files are preflighted as a batch before any canonical write, so
  an overlapping or stale patch cannot partially apply earlier files before a later base mismatch.
  Failed applications are recorded as Machine events and return a refreshed durable run snapshot to
  the renderer. The renderer exposes this through a supervised review modal rather than automatic
  canonical workspace mutation.
- `machine-review-patch` records a renderer-supervised decision to keep a Machine-owned patch
  artifact as review-only evidence. It validates the same run-relative patch artifact path and schema
  but does not write workspace files or execute external tools.

## OrPAD Orchestration Machine adapter security model

The first CLI adapter kernel remains disabled unless a main-process caller constructs it with
`enabled: true`. The Machine UI execute-step path can reach it only through a deterministic
harness command assembled by main process.

- CLI adapter execution uses `read-only-plus-overlay` workspaces. Allowed files are copied to an
  adapter-local overlay under the durable run root, or to a system temp overlay when an explicit
  dangerous Codex sandbox bypass approval is present.
  System temp overlays are removed after transcript and patch collection unless the caller
  explicitly opts into keeping them for debugging.
- The child process cwd is the overlay, not the canonical workspace. Direct writes to canonical
  queue/state/run files are therefore impossible through the adapter process.
- Commands are represented as `{ command, args[] }` and launched with `spawn(shell:false)`. Shell
  operators and direct shell executables such as `cmd.exe`, PowerShell, and POSIX shells are
  rejected by the command grant layer.
- Each process launch must match an exact command grant, including command, args, and cwd. A
  mismatched or expired grant blocks before process launch.
- The adapter containment gate requires command cwd to be exactly the overlay root and rejects
  command args that reference the canonical workspace root. This is a guardrail against accidental
  direct workspace targeting; it is not a substitute for OS-level sandboxing.
- `--dangerously-bypass-approvals-and-sandbox` is treated as a high-risk Codex CLI flag. It is
  blocked unless the adapter caller enables dangerous bypass, the exact command grant has
  `allowDangerousSandboxBypass: true`, the adapter request carries an explicit approval reason,
  and the overlay root is outside the canonical workspace in a system temp directory.
- The dangerous-bypass check is plugin-driven, not codex-specific. Each CLI provider plugin
  registered in `src/main/orchestration-machine/providers/registry.js` declares its own
  `dangerousArgs: string[]` metadata, and the adapter caller threads that list into
  `assertCliProcessContainment`. The codex bypass flag remains the default fallback when no
  plugin supplies a list, but any new CLI provider plugin (claude-code, generic) must declare
  its own dangerous args to receive the same enforcement.
- The shared provider catalog at `src/shared/ai/provider-catalog.js` is metadata-only. It must
  never embed ciphertext, raw API keys, or any other secret material. Renderer
  (`src/renderer/ai/providers/index.js`) and the Machine plugin registry both read this catalog
  for display name, models, default model, costs, family, and `needsKey`; ciphertext continues
  to live exclusively under safeStorage in `ai-keys.json`. Catalog entries declared with
  `needsKey: false` (codex-cli, ollama, openai-compatible) cannot be assigned a stored key
  through the `ai-key-set` IPC, and `validateProvider` rejects any provider id that is not
  registered in the catalog.
- API provider plugins (`src/main/orchestration-machine/providers/plugins/anthropic.js` and any
  future `openai.js`, `openrouter.js`, `ollama.js`) must perform all HTTP calls through Node
  `fetch`/`undici` only. SDK dependencies are forbidden. Raw provider HTTP responses and
  streaming chunks are *never* recorded in `events.jsonl`. Only the parsed `result`, the
  `usage` envelope, and an optional non-authoritative `apiTrace` (provider request id) are
  attached to the adapter result; the upstream byte stream is discarded after parsing. API
  keys are passed exclusively as a function argument (`providerKey`) to the plugin's
  `invokeApi`; the plugin must read no global state (`process.env`, `localStorage`) for keys
  and must put the key only in the appropriate authentication header (`x-api-key` for
  Anthropic). The provider key MUST NOT be serialized into the request body, the adapter
  request envelope, the adapter result envelope, or any artifact written under
  `runs/<runId>/`.
- The renderer-facing IPC channels added in PR M9 (`machine-list-providers`,
  `machine-list-models`, `machine-set-provider-selection`, `machine-read-budget-ledger`)
  enforce the same invariants as the rest of the Machine IPC surface: feature gate, sender
  frame validation, and a mutating capability token for the only mutating channel
  (`machine-set-provider-selection`). The mutating handler re-validates every renderer-
  supplied provider id against the in-process plugin registry — a renderer compromise
  cannot inject an unregistered provider id into a pipeline graph because
  `MACHINE_IPC_PROVIDER_NOT_REGISTERED` rejects the request before any state mutation.
  `machine-read-budget-ledger` runs through the authority's `assertWorkspaceContains` so
  the renderer cannot ask the main process to read ledger files outside the active
  workspace. The budget-meter and adapter-picker renderer modules go through these
  channels exclusively; neither module reads disk or computes selections on the renderer
  side.
- CLI provider plugins added in PR M8 (`claude-code.js`, generic CLI factory) follow the same
  M1 process-containment, M1 dangerous-arg metadata, and M0 lift-to-v2 contracts that
  `codex-cli.js` does. `claude-code` declares `--dangerously-skip-permissions` as its
  dangerous arg so the M1 containment gate refuses to spawn a Claude Code child process with
  that flag unless an explicit Machine grant + approval is in place. Generic CLI plugin
  registration (`createGenericCliPlugin`) is **rejected** at registration time when either
  `commandAllowlist` (non-empty array of `{ command, argsPrefix? }`) or
  `outputContractParser` (function) is missing — there is no path that lets a caller register
  an unbounded "run anything" CLI provider. Each generic plugin's `assertCommandAllowed`
  blocks any commandSpec whose command is not in the allowlist, with optional `argsPrefix`
  enforcement, before the M1 process-containment runs.
- The router fallback chain (`router/error-classifier.js`) does not weaken the approval and
  containment boundary applied to any single attempt. Each fallback target goes through the
  same `assertProviderKeySourceAllowed` / `assertCommandGranted` / `assertCliProcessContainment`
  gates that M1–M3 enforce. Specifically:
  - `KEY_MISSING` only falls back to a `needsKey: false` provider in the candidate chain;
    a key-required provider further down the chain is silently skipped, never invoked.
  - `RATE_LIMIT` and `RETRYABLE` (after the per-call retry budget is exhausted) fall back to
    the next candidate exactly once each.
  - `OUTPUT_VIOLATES_CONTRACT` performs at most one self-repair retry against the same
    candidate before falling back; this prevents a runaway accept-anything loop and bounds
    the cost of malformed responses.
  - `BUDGET_EXCEEDED` and `FATAL` short-circuit the chain — no further candidate is invoked.
  Cross-family fallback (api → cli) does NOT widen the workspace mode: every CLI candidate
  still receives `read-only-plus-overlay`, the same exact command grants, and the same
  dangerous-arg metadata its plugin declares.
- The response cache at `runs/<runId>/cache/<sha256>.json` is opt-in via the v2
  `pipeline.run.machineAdapter.cache.mode` value (`off` | `deterministic` | `idempotent-only`).
  Cache files store only the SHA-256 of the prompt and the parsed adapter result envelope —
  never the raw prompt text — so an inadvertent secret in a prompt does not become a long-lived
  cache leak. `apiSession` and `apiTrace` are stripped from the result before write.
  `deterministic` mode rejects prompts that match ISO timestamps, UUIDs, OrPAD run ids, or
  attempt ids; `idempotent-only` mode requires a non-empty `idempotencyKey` and only hits when
  the same key has been seen before. Cache hits are recorded in events.jsonl as `cache.hit`
  (so audit/replay can recompute cost without a network call) and the budget ledger entry
  for a cache hit always reports `costEstimateUsd: 0` and `cacheHit: true`. Plugin authors are
  responsible for sanitizing prompts before they reach the cache key path; OrPAD's threat
  model assumes cache files are inside the local-first run directory and not exported.
- The budget ledger at `runs/<runId>/budget-ledger.json` is a derived view, not authoritative.
  Cost values are plugin-reported *estimates* drawn from the provider catalog's per-model
  rates; provider invoice reconcile is out of scope. Any UI that surfaces a hard budget
  limit must communicate this provenance and rely on the catalog's costPerMTokens fields
  staying current. The ledger writer (`router/budget-ledger.js`) only copies a fixed set of
  usage fields (promptTokens, completionTokens, totalTokens, costEstimateUsd, currency,
  cacheHit), so a buggy or hostile plugin cannot smuggle additional fields (e.g. an API key)
  into the ledger by tucking them into `result.usage`. When `pipeline.run.machineAdapter.budget.hardStop`
  is `true`, the router refuses to invoke the plugin once `assertWithinBudget` reports a
  per-call or per-run violation; when `false`, the router emits a `budget.warning` event and
  proceeds. `BUDGET_EXCEEDED` is one of the standard router error classes
  (`router/adapter-router.js#ERROR_CLASSES`).
- The inherited environment is sanitized before spawn. `SENTRY_DSN`, `GITHUB_TOKEN`, `PASSWORD`,
  and `*_KEY`, `*_TOKEN`, or `*_SECRET` variables are removed from the adapter environment.
- Stdout/stderr are captured with output limits and written only as Machine artifacts when a
  run root is supplied. Secret-looking command arguments are redacted before transcript and
  verification metadata are written.
- Overlay diffs become Machine patch artifacts. The adapter does not apply them to the canonical
  workspace.
- Machine patch application checks the active write set and preflights selected file pre-image hashes
  before writing. Out-of-write-set changes and duplicate/base-mismatched patch applications are
  rejected without partial canonical writes.
- Worker results that claim `changedFiles` outside the claim write set are rejected before
  `worker.result` and queue close events are recorded.
- The API adapter kernel is provider-neutral and disabled by default. A provider response is
  parsed as a structured adapter result only; it cannot write queue, run, or artifact state
  directly.
- API provider keys are policy-checked before use. Desktop access must route through the
  safeStorage-backed key path (or explicit in-memory tests), web access requires an IndexedDB
  risk-consent source, and `localStorage` key reads are always rejected.
- API tracing and telemetry export are off unless exact capability grants include
  `use.tracing` or `export.telemetry`. Trace IDs and provider session IDs are non-authoritative
  adapter metadata, never canonical Machine state.
- Approval requests are Machine artifacts plus `approval.requested` events. Approval decisions
  are explicit `approval.decided` events; renderer/UI approval state must project from Machine
  state rather than becoming a second source of truth.
- Resume repair uses Machine events as canonical metadata and only repairs derived queue files
  when an item snapshot is still available. Artifact presence alone is never treated as proof
  that claimed work completed.
- Package compatibility is metadata-only in this phase. Normal install validation rejects npm
  lifecycle scripts, executable handlers, community overrides of the reserved `orpad.*`
  namespace, incompatible package formats, unsafe package-relative paths, and user-node type
  conflicts before activation. Untrusted, capability-denied, and review-required packages may
  be present on disk for inspection, but Machine execution keeps them non-runnable until
  OrPAD-owned trust evidence, review evidence, and exact capability grants resolve them.
- Package sharing installs use a main-process safe transaction. Local installs pre-audit the
  source folder, copy only manifest-declared files into a staging directory, re-run Machine
  discovery/validation, then atomically activate under `<userData>/nodes/<package-id>/` and update
  `<userData>/nodes/orpad-node-packs.lock.json`. Registry installs fetch the manifest plus
  declared raw files only; normal install does not run git, npm, archive extraction, lifecycle
  scripts, native builds, or package-provided commands.
- Registry signatures are verified only when OrPAD-owned trusted registry public keys are
  configured. A verified registry signature can turn registry-declared version signature,
  checksum, and approved review metadata into Machine-owned trust evidence; unsigned or
  untrusted registries do not. Registry installs compare the fetched manifest and declared
  asset bytes against registry SHA-256 checksums before activation, and checksum mismatches
  fail closed without replacing the active package.
- Registry governance separates official OrPAD Registry metadata from custom Registry
  discovery. Official entries use the `orpad-pr-reviewed` review model and are accepted through
  maintainer-reviewed Registry pull requests in `OrPAD-Lab/orpad-registry`; custom or
  third-party Registry sources are labeled separately in Package Manager and their review claims
  do not become OrPAD-owned approval evidence.
- Package updates reuse the same safe install transaction. Pinned installs are skipped by
  default, failed updates leave the active package untouched, and successful replacements store
  the previous lock entry plus backup path for an explicit rollback command.
- Package authoring tools are validation and metadata-generation tools only. `packages
  registry-entry create` computes SHA-256 checksums from manifest-declared files but never
  claims verified trust, never creates a registry signature, and never marks review status as
  approved. Publishing remains a manual registry pull request and review flow.
- Workspace-local package locks are metadata-only sharing state. Workspaces can declare
  required packages, but install state remains user-level app data and restore/install still routes
  through the Machine safe transaction instead of trusting workspace files as authority.
- Missing or incompatible community nodes are represented as lossless placeholders for graph
  round-trip; placeholder metadata is not executable.

## URL handling

**Implemented protections:**
- All renderer navigations blocked by `will-navigate` handler.
- `setWindowOpenHandler` forwards http/https to the OS browser — no inline rendering of external URLs.
- The auto-updater fetches only from `https://api.github.com/repos/luke-youngmin-cho/OrPAD/releases?per_page=20` (hardcoded HTTPS, no user-configurable endpoint). Response is parsed as JSON with no eval.
- Auto-install is fail-closed: installers are opened only after a signed Ed25519 release manifest verifies with the updater public key baked into the app, and the downloaded installer SHA-256/size matches the signed manifest entry. Missing public key, missing manifest, invalid signature, or checksum mismatch disables auto-install and leaves only the manual release-page path.
- Release signing uses `ORPAD_RELEASE_SIGNING_PRIVATE_KEY` in CI to create `orpad-release-manifest-<platform>.json`; app builds use `ORPAD_UPDATER_PUBLIC_KEY` to embed the matching public key.

**Policy for P1-7 (GitHub / Gist URL drop — not yet built):**
- Only HTTPS URLs accepted. `http://` must be rejected with a user-visible warning.
- Allowlist for direct fetch without a CORS warning: `raw.githubusercontent.com`, `gist.githubusercontent.com`.
- All other domains: require explicit user confirmation ("This will load content from an external URL").
- Fetched content **must not** be auto-saved to disk. Only the active editor buffer should be populated.
- Validate that the URL does not redirect to a non-allowlisted host before loading.

## IPC handlers

All `ipcMain` channels as of P1-4b. MCP, Command Runner, and PTY Terminal are the only
features that intentionally launch configured/user-requested child processes.

| Channel | Type | What it does | Sender-frame check | Path validation |
|---------|------|-------------|-------------------|----------------|
| `ai-keys-status` | handle | Return key presence/masks | n/a | userData only |
| `ai-key-set` | handle | Encrypt and save provider API key | n/a | userData only |
| `ai-key-get-decrypted` | handle | Reject legacy key export attempts | n/a | No plaintext key returned |
| `ai-key-remove` | handle | Delete provider API key | n/a | userData only |
| `ai-provider-chat` | handle | Main-process AI provider proxy using stored keys | reads `event.sender` | No plaintext key returned |
| `ai-provider-cancel` | handle | Cancel a main-process AI provider request | reads `event.sender` | Sender-owned request only |
| `ai-conversations-list` | handle | List `.orpad/conversations` summaries | n/a | Workspace subdir guard |
| `ai-conversation-load` | handle | Load one conversation JSON | n/a | Workspace subdir guard |
| `ai-conversation-save` | handle | Save one conversation JSON | n/a | Workspace subdir guard |
| `ai-conversation-delete` | handle | Delete one conversation JSON | n/a | Workspace subdir guard |
| `ai-conversations-search` | handle | Substring search conversation JSON | n/a | Workspace subdir guard |
| `get-app-info` | handle | Return version + isPackaged | — | — |
| `get-system-theme` | handle | Return system dark/light | — | — |
| `get-locale` | handle | Return locale code + mtime | — | — |
| `set-locale` | on | Write locale pref | — | — |
| `set-title` | on | Set window title | reads `event.sender` | — |
| `open-file-dialog` | handle | Native open dialog | reads `event.sender` | Dialog enforces |
| `save-file` | handle | `fsp.writeFile(filePath, …)` | — | **None** (see note) |
| `save-file-as` | handle | Save dialog then write | reads `event.sender` | Dialog enforces |
| `open-default-apps-settings` | handle | `shell.openExternal(ms-settings:…)` | — | Hardcoded URI |
| `show-save-dialog` | handle | Message box (save/discard) | reads `event.sender` | — |
| `confirm-close` | on | `win.destroy()` | reads `event.sender` | — |
| `drop-file` | on | Load dropped file | reads `event.sender` | `isSupportedFile()` check |
| `read-file` | handle | `fsp.readFile(filePath)` | — | **None** |
| `save-image` | handle | Write to `./assets/` subdir of open file | — | Subdir is `path.join(dir,'assets')` |
| `auto-save-recovery` | handle | Write to userData/recovery (SHA-256 key) | — | Writes only to userData |
| `clear-recovery` | handle | Delete from userData/recovery | — | Writes only to userData |
| `open-folder-dialog` | handle | Native folder dialog | reads `event.sender` | Dialog enforces |
| `read-directory` | handle | Recursive tree read (max depth 8) | — | **None** |
| `watch-directory` | handle | `fs.watch` on dirPath | reads `event.sender` | **None** |
| `unwatch-directory` | handle | Stop current watcher | reads `event.sender` | — |
| `create-file` | handle | `fsp.writeFile(filePath, '')` | — | **None** |
| `create-folder` | handle | `fsp.mkdir(folderPath)` | — | **None** |
| `rename-file` | handle | `fsp.rename(old, new)` | — | **None** |
| `delete-file` | handle | `shell.trashItem(filePath)` | — | **None** |
| `search-files` | handle | Regex search across dirPath | — | **None** |
| `build-link-index` | handle | Read all .md in dirPath | — | **None** |
| `resolve-wiki-link` | handle | Path lookup within dirPath | — | **None** |
| `get-backlinks` | handle | Read ≤1000 .md files | — | **None** |
| `get-file-names` | handle | List .md names in dirPath | — | **None** |
| `pipeline-validate-text` / `runbook-validate-text` | handle | Validate in-memory pipeline, graph, tree, or legacy runbook text | — | No filesystem path |
| `pipeline-validate-file` / `runbook-validate-file` | handle | Read and validate a pipeline, graph, tree, or legacy runbook file | — | Authority guard / workspace or approved file |
| `pipeline-scan-workspace` / `runbook-scan-workspace` | handle | Scan approved workspace metadata for pipelines, legacy runbooks, vault markers, and redaction candidates | — | Authority guard / workspace only |
| `pipeline-read-workspace-index` / `runbook-read-workspace-index` | handle | Read the metadata-only app userData workspace index snapshot | — | Authority guard / workspace only |
| `pipeline-create-run-record` / `runbook-create-run-record` | handle | Create minimal run evidence under `.orpad/pipelines/<pipeline>/runs/{runId}` or legacy `.orch-runs/{runId}` | — | Authority guard / workspace only |
| `pipeline-start-local-run` / `runbook-start-local-run` | handle | Create a local MVP run record, context manifest, approval events, and claim artifact under the target run directory | — | Authority guard / workspace only |
| `pipeline-read-run-record` / `runbook-read-run-record` | handle | Read `run.or-run` or legacy `run.json` plus `events.jsonl` from allowed run directories | — | Authority guard / `.orpad/pipelines/*/runs`, recorded workspace-local `.or-pipeline` sibling `runs`, or `.orch-runs` only |
| `machine-status` | handle | Report managed-run IPC gate and mutating capability readiness | Yes, requires `event.senderFrame.url` `file://` | No filesystem path |
| `machine-enable-session` | handle | Enable managed runs for the current unpackaged/dev process and return an in-memory session capability token | Yes, requires `event.senderFrame.url` `file://`; unavailable in packaged builds | No filesystem path |
| `machine-validate-pipeline` | handle | Validate an `.or-pipeline` and report Machine execution compatibility | Yes, requires `event.senderFrame.url` `file://` plus feature gate | Authority guard / workspace `.or-pipeline` only |
| `machine-create-run` | handle | Create a durable Machine run root after `canMachineExecute` validation | Yes, requires `event.senderFrame.url` `file://` plus feature gate and capability token | Authority guard / `.orpad/pipelines/*/runs/<runId>` only |
| `machine-get-run` | handle | Read `run-state.json` and `events.jsonl` for one Machine run | Yes, requires `event.senderFrame.url` `file://` plus feature gate | Authority guard / `.orpad/pipelines/*/runs/<runId>` only |
| `machine-list-runs` | handle | List durable Machine run summaries for one pipeline | Yes, requires `event.senderFrame.url` `file://` plus feature gate | Authority guard / `.orpad/pipelines/*/runs/` only |
| `machine-execute-run-step` | handle | Run one managed step through deterministic harness or recognized Codex CLI adapter: candidate ingest, dispatcher claim, WorkerLoop, Machine-assembled overlay adapter, optional evidence snapshot export | Yes, requires `event.senderFrame.url` `file://` plus feature gate and capability token | Authority guard / workspace `.or-pipeline`, durable run root, proposal read-only, worker overlay-only process cwd |
| `machine-resume-run` | handle | Repair derived queue snapshots, recover stale claims, mark a non-terminal non-approval-pending run waiting, and optionally export latest-run; a `paused` run additionally clears pause intent and records `run.resume-requested` before transitioning `paused -> waiting` | Yes, requires `event.senderFrame.url` `file://` plus feature gate and capability token | Authority guard / workspace `.or-pipeline`, durable run root only |
| `machine-pause-run` | handle | Record supervised-autonomy pause intent (in-process token + durable `run.pause-requested` event) so the autonomous driver suspends to `paused` at its next step boundary; lock-free and never kills a process | Yes, requires `event.senderFrame.url` `file://` plus feature gate and capability token | Authority guard / workspace `.or-pipeline`, durable run root only |
| `machine-cancel-run` | handle | Record `run.cancel-requested` intent, then abort Machine-registered adapter processes for a run and cancel active claimed work when present | Yes, requires `event.senderFrame.url` `file://` plus feature gate and capability token | Authority guard / workspace `.or-pipeline`, durable run root only |
| `machine-cancel-claim` | handle | Cancel an active Machine-owned claim, release its write-set, block or requeue the item, and optionally export latest-run | Yes, requires `event.senderFrame.url` `file://` plus feature gate and capability token | Authority guard / workspace `.or-pipeline`, durable run root, opaque claim/item ids only |
| `machine-reject-item` | handle | STEER "leave this out": reject a still-pending (queued/candidate/blocked) work item via a single replayable `queue.transition` to `rejected`; fail-fast if a step is in flight; never touches a claimed/in-progress item | Yes, requires `event.senderFrame.url` `file://` plus feature gate and capability token | Authority guard / workspace `.or-pipeline`, durable run root, opaque item id only |
| `machine-reprioritize-item` | handle | STEER "do this first": pull a queued item to the front of the dispatcher claim order via a durable `queue.reprioritized` event (its sequence is the priority); no item-field mutation, fully replayable; queued-only; fail-fast if a step is in flight | Yes, requires `event.senderFrame.url` `file://` plus feature gate and capability token | Authority guard / workspace `.or-pipeline`, durable run root, opaque item id only |
| `machine-inject-item` | handle | STEER "add this": inject a human work item — build a candidate from a title (+ optional target files / acceptance criteria), then run the standard ingest (inbox→candidate) + triage (candidate→queued) transitions; Machine derives a unique id/fingerprint; fail-fast if a step is in flight | Yes, requires `event.senderFrame.url` `file://` plus feature gate and capability token | Authority guard / workspace `.or-pipeline`, durable run root; candidate normalized + schema-validated (renderer cannot forge id/state) |
| `machine-edit-item` | handle | STEER "fix this": edit a queued item's title / target files / acceptance criteria in place via a durable `queue.edited` event carrying the patch; re-validates the patched item against the `workItem` schema before persisting; never edits id/state/claim/fingerprint; queued-only; fail-fast if a step is in flight | Yes, requires `event.senderFrame.url` `file://` plus feature gate and capability token | Authority guard / workspace `.or-pipeline`, durable run root, opaque item id only; whitelisted fields + schema re-validation (renderer cannot persist a malformed item) |
| `machine-decide-approval` | handle | Record a Machine-owned approval decision for a pending approval, optionally exporting latest-run | Yes, requires `event.senderFrame.url` `file://` plus feature gate and capability token | Authority guard / workspace `.or-pipeline`, durable run root, pending approval event only |
| `machine-export-latest-run` | handle | Export durable Machine run evidence and queue metadata to `harness/generated/latest-run` | Yes, requires `event.senderFrame.url` `file://` plus feature gate and capability token | Authority guard / pipeline evidence snapshot export only |
| `machine-apply-patch` | handle | Apply selected files from a Machine patch artifact to the canonical workspace after write-set and base-SHA checks | Yes, requires `event.senderFrame.url` `file://` plus feature gate and capability token | Authority guard / workspace `.or-pipeline`, durable run root, run-relative patch artifact, selected workspace files only |
| `machine-review-patch` | handle | Record a supervised review-only decision for one Machine patch artifact without applying it | Yes, requires `event.senderFrame.url` `file://` plus feature gate and capability token | Authority guard / workspace `.or-pipeline`, durable run root, run-relative patch artifact only |
| `machine-run-progress` | send (main→renderer) | PUSH STREAM: one-way per-step progress nudge sent to the requesting renderer after each completed step of an autonomous drive; advisory payload (`runId`/`stepIndex`/`sequence`) carrying no run state or secrets | Outbound ONLY to the initiating `event.sender` webContents, guarded against destroyed senders; no renderer→main surface, no capability token (not an action) | **None** — the renderer re-fetches via the gated `machine-get-run`; `events.jsonl` stays the source of truth |
| `save-binary` | handle | Save dialog then binary write | reads `event.sender` | Dialog enforces |
| `svg-to-png` | handle | Offscreen BrowserWindow render | reads `event.sender` | Validates dimensions |
| `save-text` | handle | Save dialog then text write | reads `event.sender` | Dialog enforces |
| `reveal-in-explorer` | handle | `shell.showItemInFolder` | — | **None** |
| `update-action` | on | Trigger update download/skip | reads `event.sender` | Validates action enum |
| `mcp-list-servers` / `mcp-export-config` | handle | Read MCP config/status | — | userData only |
| `mcp-upsert-server` / `mcp-import-config` / `mcp-remove-server` | handle | Mutate MCP config | — | userData only |
| `mcp-set-enabled` | handle | Start/stop configured stdio MCP server | — | Config-driven command |
| `mcp-refresh-server` | handle | Refresh tool/resource metadata | — | Server must already run |
| `mcp-list-tools` / `mcp-list-resources` / `mcp-read-resource` | handle | MCP metadata/resource reads | — | Server-defined |
| `mcp-prepare-tool-call` | handle | Mint short-lived permission token | — | No filesystem path |
| `mcp-grant-permission` / `mcp-revoke-global-permission` | handle | Store session/global grants | — | userData only |
| `mcp-call-tool` | handle | Execute MCP tool after permission check | — | Server-defined |
| `terminal.history` | handle | Read command-only runner history | — | userData only |
| `terminal.run` | handle | Start one `spawn(shell:false)` command | — | Workspace cwd guard |
| `terminal.cancel` | handle | Kill active command run | — | runId only |
| `terminal.status` | handle | Report active runner count | — | No filesystem path |
| `terminal.pty.shells` | handle | List detected shells | — | No filesystem path |
| `terminal.pty.restore` | handle | Read terminal restore metadata | — | userData only |
| `terminal.pty.spawn` | handle | Start an interactive PTY shell | reads `event.sender` | Workspace cwd guard |
| `terminal.pty.write` | handle | Send user input to PTY | — | sessionId only |
| `terminal.pty.resize` | handle | Resize PTY | — | sessionId only |
| `terminal.pty.kill` | handle | Kill PTY session | — | sessionId only |

**Path authority update (P2):** Workspace file/tree/search/link/Git handlers route through the
main-process authority manager. A renderer receives workspace authority only after an approved
folder is restored/opened, and individual file authority only after a user-opened file flow. The
e2e authority suite covers arbitrary outside reads/writes, sibling access after opening one file,
approved workspace tree access, and symlink/junction escape rejection. Save-dialog flows remain
allowed outside the workspace because the dialog is the user approval surface.

Residual risk: newly added IPC handlers must keep using the authority manager. Any future
pipeline/runbook write or execution surface must treat path authority tests as release-blocking.

**Machine IPC update:** Orchestration Machine handlers also route through the authority manager
and add `senderFrame`, feature-gate, typed request, `runId`, and mutating capability-token
checks before touching storage. In unpackaged/dev sessions, `machine-enable-session` can open the
feature gate only for the current process and only with an in-memory session capability token.
`machine-decide-approval` projects pending approvals from Machine
events before recording a decision and grant. `machine-resume-run` projects approval state from
Machine events before repairing derived queue files or recovering claims. `machine-cancel-run`
can only abort processes registered by Machine for that run id. `machine-cancel-claim` requires
an active Machine claim lease before it releases claim/write-set ownership.
`machine-execute-run-step` reaches CLI adapters only through Machine-selected harness commands or
recognized `run.machineAdapter` declarations. Worker execution remains overlay-cwd contained,
proposal execution is read-only, and arbitrary adapter execution, provider calls, terminal
commands, and MCP tools remain out of scope for renderer IPC. Source workspace writes are limited
to explicit `machine-apply-patch` review selections from Machine-owned patch artifacts with
write-set and pre-image hash checks; review-only patch decisions are event-only through
`machine-review-patch`.

**Command execution boundaries:** General filesystem/editor IPC still does not expose arbitrary
shell execution. P1-3 MCP uses the official SDK `StdioClientTransport`, which spawns the
configured server command only through `mcp-set-enabled`; default servers are disabled and tool
execution is permission-token gated. P1-4a Command Runner uses `spawn(shell:false)` only through
`terminal.run`; shell-like operators are rejected, cwd is workspace-guarded, and AI can only
prefill commands, never auto-run them. P1-4b PTY Terminal uses a native interactive shell only
through `terminal.pty.spawn`; initial cwd is workspace-guarded, environment secrets are filtered,
and AI suggestions are presented as drafts/prefills rather than executed.

## Dependency audit

Run on 2026-05-26 for v1.0.0-beta.4 readiness:

```
npm audit --omit=dev --audit-level=high
found 0 vulnerabilities
```

`npm audit --omit=dev --audit-level=critical` -> **exit 0** (no critical or high findings).

Full `npm audit --audit-level=high` still reports dev/build-tool findings through
`electron@33`, `electron-builder`, `workbox-cli`, and related transitive tooling.
Production dependency audit is clean at high severity, but Electron itself is the
packaged runtime, so the Electron major upgrade path remains a release-readiness follow-up.
Tracked as Follow-up #10.

**Triage:**
- v1.0.0-beta.4 updates production transitive dependencies including `fast-uri`,
  `hono`, `ip-address`, `qs`, `brace-expansion`, `mermaid`, and `uuid` through
  `npm audit fix --omit=dev`.
- Remaining high findings are dev/build pipeline findings or Electron runtime findings
  that require dedicated major-version upgrade work.

**js-yaml 4.1.1 `load()` safety:** In js-yaml v4.x the default `load()` function uses
`DEFAULT_SCHEMA` (equivalent to the old v3 `safeLoad` / `DEFAULT_SAFE_SCHEMA`). JavaScript-type
constructors (`!!js/function`, `!!js/regexp`, `!!js/undefined`) were removed in v4.0. The
`safeLoad` export is a deprecated compatibility alias for `load`. **No code change required.**

**smol-toml:** Simple recursive-descent TOML parser with no known deserialization issues.
No `eval` or dynamic code execution in the parser. **PASS.**

**DOMPurify 3.4.0:** Used for all HTML preview rendering with an explicit allowlist.
`FORCE_BODY` + `WHOLE_DOCUMENT: false` mode. No known issues. **PASS.**

## Follow-ups

1. **(Medium) Path authority maintenance** — The IPC path sandbox validation gap has been
   addressed for current workspace/file operations with a main-process authority manager and
   e2e coverage. Keep this as a release-blocking maintenance item for every new IPC handler,
   especially pipeline execution, workspace indexing, import, and artifact writing.
   Priority: **P1**. Owner: maintainer.

2. **(Low) `setWindowOpenHandler` allows http:// external links** — Current code opens both
   `http://` and `https://` links via `shell.openExternal`. Consider logging a warning or
   showing a "this link uses plain HTTP" dialog before opening. Low exploitability since the
   link must appear in a document the user opened.
   Priority: **P2**. Owner: maintainer.

3. **(Low) `style-src 'unsafe-inline'` in CSP** — Required for the dynamic theme engine.
   To remove it, nonce-based injection or a CSS-in-JS approach would be needed. Not
   practically exploitable given `script-src 'self'` blocks injected script execution.
   Priority: **P3**. Owner: maintainer (if ever doing a theme engine rewrite).

4. **(Low) Web build has no server-side CSP header** — GitHub Pages does not support custom
   response headers. The meta-tag CSP applies, but a `_headers` file (Netlify/Cloudflare
   Pages) or equivalent could add belt-and-suspenders enforcement at the HTTP layer if the
   deployment target ever changes.
   Priority: **P3**. Owner: maintainer.

5. **(Low) Mermaid/parser dependency watch** -> The production audit issue previously
   tracked through Mermaid/uuid is resolved for v1.0.0-beta.4. Keep Mermaid and its
   parser dependencies on the release audit watchlist because diagram parsing and
   sanitization remain user-content surfaces.
   Priority: **P3**. Owner: maintainer.

6. **(Medium) MCP custom server review** — Before public release, decide whether the MCP
   server editor should remain fully custom-command capable or ship with a stricter allowlist
   / advanced-mode warning. Current implementation is safe-by-default but intentionally
   powerful once the user opts in.
   Priority: **P1**. Owner: maintainer.

7. **(Medium) Command Runner history policy** — Commands are persisted, outputs are not.
   Revisit whether secret-looking commands should be skipped entirely instead of redacted in
   history, especially before teams use shared machines.
   Priority: **P2**. Owner: maintainer.

8. **(Low) macOS app not signed with Apple Developer ID** — First-launch GateKeeper warning.
   Users must run `xattr -cr` or use "Open Anyway". Not a code vulnerability; requires an
   Apple Developer subscription and notarization pipeline.
   Priority: **P2** (before macOS public launch). Owner: project lead.

9. **(Informational) Consider Snyk / Socket** — Automated SCA tooling for continuous
   dependency monitoring. Not configured currently. Could be wired into CI as a follow-on
   to the bundle-size gate added in P0-2.
   Priority: **P3**. Owner: maintainer.

10. **(High audit, release gate) Electron runtime upgrade review** — Full `npm audit` reports
    high advisories for the current Electron major. Because Electron is declared as a
    devDependency but shipped as the desktop runtime, do not rely only on `--omit=dev` for
    release readiness. Evaluate upgrading Electron and electron-builder in a dedicated pass.
    Priority: **P1**. Owner: maintainer.
