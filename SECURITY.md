# OrPAD Security Baseline

_Generated during P0-10 security scan on 2026-04-24. Updated through P1-5 template work. Updated 2026-06-19 for the G2 orchestration rebuild (Machine engine + authoring + node-pack registry removed; new orchestration-core governed-delegation IPC). Re-run on every major release._

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
| `core.startRun` / `core.replayTrace` / `core.onCoreTrace` | orchestration-core governed-delegation run (spawns the CLI agent inside an isolated overlay), recorded-trace replay, and the outbound `orpad-core-trace` stream | HIGH (execution substrate) |
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
- `Generate Pipeline` (the LLM pipeline authoring flow) and the static-graph
  editor were **removed in the G2 rebuild**. `.or-pipeline` / `.or-graph` /
  `.or-tree` files now open as read-only JSON; pipeline validation and the
  local-run backend below remain.
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

## OrPAD orchestration-core security model

The G2 rebuild **removed** the entire Orchestration Machine engine, the
`orchestration-authoring` pipeline generator, and the node-pack registry/manager.
Their renderer UI (static-graph editor, node browser, machine run panels,
adapter picker, Generate Pipeline, Package Manager) and their IPC surface
(`machine-*`, `orchestration-author-harness`, `orchestration-provision-harness`,
`orchestration-generate-pipeline`, `orchestration-*-node-pack*`,
`orchestration-list-node-packs`) and preload bridges (`window.orpad.machine`,
`window.orpad.orchestration` authoring) **no longer exist**. The capability-token
feature gate, managed-run session enable, and node-pack registry install paths
described in earlier revisions are gone.

The replacement is `src/main/orchestration-core/` (`core.cjs`, `trace.cjs`,
`ralphloop.cjs`): a zero-node **governed delegation** core. It grounds a goal,
seeds an isolated overlay containing only the declared write-set, delegates the
whole task to a capable CLI agent (`claude`) running inside that overlay, and
enforces the write-set by diffing overlay→canonical via the preserved isolation
moat (`orchestration-machine/patches.js` — write-set overlay + `patchArtifact`).
A motion/progress stop-signal (time cap + process-tree kill + partial recovery)
bounds each delegation.

Renderer-facing IPC is `registerCoreRunHandlers` in
`src/main/orchestration-core/ipc.cjs`, wired in `main.js`, exposed as
`window.orpad.core` in preload:

- `orpad-core-run-start` (invoke) — runs a REAL governed delegation. It resolves
  the run's workspace from the main-process authority (`authority.getWorkspaceRoot`)
  and refuses when no workspace is approved. It spawns the configured agent
  (`claude`) **inside an isolated overlay** under `<workspace>/.orpad/core-runs/<runId>/`
  seeded with only the caller-declared write-set; the moat diffs the overlay back
  to canonical and reports changes + out-of-write-set violations. **Verification
  gate (trust boundary):** when the caller supplies `verifyCommands` / `gates`,
  the handler runs those deterministic checks (shell commands, `cwd` = the run
  overlay) BEFORE applying any result; a failing gate **blocks the apply** so
  nothing unverified reaches the canonical workspace (optionally re-delegating up
  to `verifyCycles` times, reusing the overlay, with the failure logs injected).
  Gate commands execute under the same overlay containment as the agent's own
  Bash — scoped to `<workspace>/.orpad/core-runs/<runId>/overlay/`, no new
  capability beyond what the delegation already has. This is the one
  renderer-reachable channel that launches a child agent process — by design,
  contained to the overlay and the workspace, like Command Runner / PTY but scoped
  to the governed-delegation moat. It streams trace events back via `orpad-core-trace`.
  **Parallel research (fan-out):** when `parallelResearch` is set, the grounding
  step spawns several READ-ONLY research subagents concurrently, each in its own
  sibling overlay `<workspace>/.orpad/core-runs/<runId>/overlay-r{n}/` under the
  same run dir and the same moat; only the single build writer applies to canonical
  (writes are never parallelized). Each subagent is the same contained `claude`
  child process as a normal delegation — more processes, no new capability.
- `orpad-core-run-replay` (invoke) — replays a RECORDED `trace.jsonl` through the
  same `orpad-core-trace` channel for the live-trace GUI and CI (no paid agent
  run). The trace path is validated with `authority.assertWorkspacePath`, so the
  renderer cannot ask the main process to read a trace file outside the approved
  workspace. It spawns nothing and writes nothing.
- `orpad-core-trace` (send, main→renderer) — outbound-only push stream of
  emergent-graph trace events (phase / classified work node / run-done) to the
  initiating `event.sender`, guarded against destroyed senders. Advisory render
  data only; no secrets, no renderer→main attack surface, no capability token.

The legacy `.or-pipeline` / `.or-graph` / `.or-tree` files now open as read-only
JSON (the static-graph editor was removed); their pipeline **validation** and
local-run **backend** remain (see the Pipeline MVP section). Provider/adapter,
terminal, MCP, and arbitrary CLI execution remain out of scope for renderer IPC.

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
| `get-link-graph` | handle | Build the workspace markdown link graph (notes + wiki/md-link edges) from the read-only link index; resolves the workspace from the authority when no dirPath given | reads `event.sender` | Authority guard / workspace; read-only, reuses the link index |
| `pipeline-validate-text` / `runbook-validate-text` | handle | Validate in-memory pipeline, graph, tree, or legacy runbook text | — | No filesystem path |
| `pipeline-validate-file` / `runbook-validate-file` | handle | Read and validate a pipeline, graph, tree, or legacy runbook file | — | Authority guard / workspace or approved file |
| `pipeline-scan-workspace` / `runbook-scan-workspace` | handle | Scan approved workspace metadata for pipelines, legacy runbooks, vault markers, and redaction candidates | — | Authority guard / workspace only |
| `pipeline-read-workspace-index` / `runbook-read-workspace-index` | handle | Read the metadata-only app userData workspace index snapshot | — | Authority guard / workspace only |
| `pipeline-create-run-record` / `runbook-create-run-record` | handle | Create minimal run evidence under `.orpad/pipelines/<pipeline>/runs/{runId}` or legacy `.orch-runs/{runId}` | — | Authority guard / workspace only |
| `pipeline-start-local-run` / `runbook-start-local-run` | handle | Create a local MVP run record, context manifest, approval events, and claim artifact under the target run directory | — | Authority guard / workspace only |
| `pipeline-read-run-record` / `runbook-read-run-record` | handle | Read `run.or-run` or legacy `run.json` plus `events.jsonl` from allowed run directories | — | Authority guard / `.orpad/pipelines/*/runs`, recorded workspace-local `.or-pipeline` sibling `runs`, or `.orch-runs` only |
| `orpad-core-run-start` | handle | Run a governed delegation: spawn the configured CLI agent (`claude`) inside an isolated overlay seeded with the declared write-set, then diff overlay→canonical for changes + violations. Optional **verification gates** (`verifyCommands`/`gates`) run as shell checks with `cwd`=overlay BEFORE apply; a failing gate blocks the apply (nothing unverified reaches canonical), with up to `verifyCycles` overlay-reusing retries. Streams trace via `orpad-core-trace` | reads `event.sender` | Authority guard / workspace; overlay + run dirs + gate commands scoped under `<workspace>/.orpad/core-runs/<runId>/` only |
| `orpad-core-run-replay` | handle | Replay a recorded `trace.jsonl` through `orpad-core-trace` for the live-trace GUI / CI (spawns nothing, writes nothing) | reads `event.sender` | Authority guard / trace file must be inside the approved workspace |
| `orpad-core-trace` | send (main→renderer) | PUSH STREAM: outbound-only emergent-graph trace events (phase / classified work node / run-done) to the initiating sender | Outbound ONLY to the initiating `event.sender`, guarded against destroyed senders; no renderer→main surface, no capability token | **None** — advisory render data only, no secrets |
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

**orchestration-core IPC update:** the `orpad-core-*` handlers route through the
authority manager. `orpad-core-run-start` resolves the run workspace from the
authority (refusing when none is approved) and spawns the CLI agent only inside an
isolated overlay under `<workspace>/.orpad/core-runs/<runId>/`; the moat diffs the
overlay back to canonical and reports out-of-write-set violations, so the agent
cannot write canonical source outside the declared write-set. `orpad-core-run-replay`
validates the trace-file path with `authority.assertWorkspacePath` and spawns/writes
nothing. `orpad-core-trace` is an outbound-only push to the initiating sender with
no renderer→main surface. The removed Machine engine's capability-token gate,
managed-run session enable, durable run-store, adapter execution, and patch-apply
IPC no longer exist.

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
