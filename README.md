# OrPAD

<p align="center">
  <img src="assets/icon.png" alt="OrPAD" width="256" height="256">
  <br>
  <img src="assets/orpad-label.png" alt="Orchestration Pipeline Authoring & Development" width="640">
</p>

-> [Official website](https://or-pad-website.vercel.app)

**OrPAD (<a>Or</a>chestration <a>P</a>ipeline <a>A</a>uthoring & <a>D</a>evelopment)**<br>
 is a local-first editor for Markdown, structured data, diagrams, AI-assisted writing workflows, and supervised orchestration pipelines.

Open Markdown, JSON, YAML, CSV/TSV, TOML, XML, HTML, Mermaid, INI/conf, `.env`,
logs, and plain text in one app. Each supported format gets a dedicated
editable viewer and toolbar, while the source text stays close at hand.

**Quick links**

- [Open the web app](https://luke-youngmin-cho.github.io/OrPAD/)
- [Download desktop](https://github.com/luke-youngmin-cho/OrPAD/releases)
- [Install guide](#install)
- [Features](#features)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Security](SECURITY.md)

All local. No cloud account, subscription, or document upload required.

---

## Contents

- [Install](#install)
- [Why OrPAD?](#why-orpad)
- [Features](#features)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Workflows](#workflows)
- [Build from source](#build-from-source)
- [Privacy, telemetry, and crash reports](#privacy-telemetry-and-crash-reports)
- [Tech stack](#tech-stack)
- [Security](#security)
- [License](#license)

---

## Install

| Option | Start here | Best for |
| --- | --- | --- |
| Web app | [Open OrPAD Web](https://luke-youngmin-cho.github.io/OrPAD/) | Trying OrPAD with no install |
| Desktop app | [Download from Releases](https://github.com/luke-youngmin-cho/OrPAD/releases) | OS file associations, auto-update, and local file watching |
| Source build | [Build from source](#build-from-source) | Development and custom builds |

### Web

Open [luke-youngmin-cho.github.io/OrPAD](https://luke-youngmin-cho.github.io/OrPAD/).
No account or installer is required.

Chromium-based browsers such as Chrome, Edge, Arc, and Opera support the full
workspace experience through the
[File System Access API](https://developer.mozilla.org/docs/Web/API/File_System_API):
folder browsing, cross-file search, wiki-link backlinks, and read-write file
access.

Firefox and Safari support single-file open and Save As through normal browser
downloads. Open Folder shows a clear browser-support message instead of failing
silently.

OrPAD Web is also installable as a PWA. Chromium-based browsers show the
native install prompt on a later visit; Safari users get an in-app hint for
Add to Dock or Add to Home Screen. The app shell remains available for offline
launching after install. Network-backed features such as URL fetches, AI
providers, GitHub APIs, and MCP-related actions still require connectivity.

#### Share a file via URL

OrPAD Web can open trusted source URLs directly:

```text
https://luke-youngmin-cho.github.io/OrPAD/?github=nodejs/node/blob/main/README.md
https://luke-youngmin-cho.github.io/OrPAD/?gist=<gist_id>
https://luke-youngmin-cho.github.io/OrPAD/?src=https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
```

Use the **Share** button to copy a `#fragment=` snapshot link for the current
tab. URL-loaded and fragment-loaded tabs are marked unsaved, so saving always
prompts for a local filename. Only HTTPS URLs are accepted; trusted hosts open
directly, and other hosts ask for confirmation before fetching.

### Desktop

Download the installer for your platform from the
[OrPAD Releases page](https://github.com/luke-youngmin-cho/OrPAD/releases).

The desktop build adds:

- OS-default-app registration for 20+ file extensions
- A file watcher that refreshes the tree on external changes
- Auto-save recovery after restart
- In-app update checks through the GitHub Releases API

### Windows

Run the `.exe` installer from the
[OrPAD Releases page](https://github.com/luke-youngmin-cho/OrPAD/releases)
and follow the setup wizard.

Windows builds support Windows 10/11 x64.

### macOS

Download the `.dmg` from the
[OrPAD Releases page](https://github.com/luke-youngmin-cho/OrPAD/releases).
OrPAD Desktop requires macOS 11 Big Sur or newer because the current
Electron runtime no longer supports Catalina. Catalina users should use
[OrPAD Web](https://luke-youngmin-cho.github.io/OrPAD/) instead.

Mount the `.dmg`, then either launch OrPAD directly from the DMG or drag it
to `/Applications` or another writable location such as `~/Desktop/`.

OrPAD is not signed with an Apple Developer ID yet. On first launch, macOS
may block it with "Apple could not verify OrPAD is free of malware." You
can approve the app once through **System Settings > Privacy & Security > Open
Anyway**, or clear the quarantine flag from Terminal:

```bash
xattr -cr /Applications/OrPAD.app   # or wherever you placed it
open /Applications/OrPAD.app
```

The recursive `-cr` is needed because Electron apps contain nested helper
binaries, each with its own quarantine flag. OrPAD opens normally on later
launches.

---

## Why OrPAD?

Good file viewers usually specialize: JSON Editor Online for JSON, Modern CSV
for CSV, Typora for Markdown, Mermaid Live Editor for diagrams. Five formats
often means five apps, five clipboards, and several browser tabs.

OrPAD is one desktop and web app where every supported format has a
first-class editable viewer, plus a Pipes workspace for authoring pipeline
packages and supervised managed runs.

Every view round-trips through the text editor. Change a cell in the CSV grid
and the underlying text updates; edit the text and the grid refreshes. Scroll
sync works both ways, so cursor movement in the editor follows the preview and
the preview follows the editor.

---

## Features

### Format support

| Format | Viewer and editing support |
| --- | --- |
| Markdown | Split live preview, GitHub Flavored Markdown, KaTeX math, Mermaid blocks, code highlighting, HTML/PDF export |
| JSON | Tree view, JSONPath queries, schema validation, side-by-side diff, repair tools |
| CSV / TSV | Spreadsheet grid, sort, filter, and column operations |
| YAML / TOML / INI | Structured tree inspection and cross-format conversion |
| XML | Tree view and XPath search |
| HTML | Rendered preview, outline, and Markdown export |
| Mermaid | Live diagram preview synced with source |
| `.env` | Typed key-value table |
| JSONL / NDJSON | Grid view for homogeneous records |
| Plain text / logs | Per-format syntax highlighting and editor fallback |

### Markdown

- GitHub Flavored Markdown: tables, task lists, strikethrough, and `==highlight==`
- KaTeX math with inline `$...$` and block `$$...$$` syntax
- Mermaid diagrams in fenced `mermaid` code blocks
- `highlight.js` code blocks with auto-detect and copy button
- Wiki-style `[[links]]` with autocompletion and backlinks
- HTML and PDF export with full theme styling

### Editor and workspace

- CodeMirror 6 editor with syntax highlighting, line wrapping, and code folding
- Multi-tab workspace with drag reorder, pin, middle-click close, and Ctrl+Tab
- Split, editor-only, and preview-only view modes
- Bidirectional editor/preview scroll sync
- Per-format toolbar for Markdown formatting, CSV operations, JSON validation,
  JSONPath, XPath, diff, and related commands
- Clipboard image paste into `./assets/`
- Auto-save with crash recovery on restart
- Drag-and-drop file open
- New from Template for PRDs, handovers, specs, task lists, ADRs, session logs,
  and run evidence records. The maintained template decisions live in
  [TEMPLATE_CATALOG.md](TEMPLATE_CATALOG.md).

### Sidebar

- **Files:** real-time file tree watcher with new, rename, and delete actions
- **Search:** workspace text search with regex, case filter, and extension scope
- **TOC:** per-format outline for Markdown headings, JSON/YAML keys, XML/HTML
  elements, and CSV columns
- **Links:** backlinks for Markdown wiki links

### AI, MCP, terminal, and orchestration surfaces

- AI sidebar access through `Ctrl+L` and the command palette
- Command-palette entries for opening Pipes, creating a new pipeline, starting
  a managed run, and preparing a handoff
- Pipeline package editing for `.or-pipeline`, `.or-graph`, and `.or-tree`
  files, with Flow and Details views for graph structure and node metadata
- MCP and terminal-oriented workflow surfaces use supervised prompts and
  approval gates before side-effecting external tools or commands

### Themes, language, and platform

- 16 built-in themes including GitHub Light/Dark, Tokyo Night, Dracula, Nord,
  Catppuccin, and Gruvbox
- Custom theme creation with live preview
- 30 languages, selected at install or switched at runtime
- Windows NSIS installer with multi-language setup
- macOS 11+ universal DMG for arm64 and x64
- In-app update checks through GitHub Releases

---

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl+N | New file |
| Ctrl+O | Open file |
| Ctrl+S | Save |
| Ctrl+Shift+S | Save As |
| Ctrl+W | Close tab |
| Ctrl+Tab | Next tab |
| Ctrl+Shift+Tab | Previous tab |
| Ctrl+B | Bold in Markdown |
| Ctrl+I | Italic in Markdown |
| Ctrl+K | Link in Markdown; waits briefly for the Zen chord |
| Ctrl+K, Z | Toggle Zen Mode |
| Alt+Up / Alt+Down | Move line up / down |
| Shift+Alt+Up / Shift+Alt+Down | Copy line up / down |
| Ctrl+/ | Toggle line comment |
| Ctrl+Shift+/ | Toggle block comment |
| Ctrl+Alt+Up / Ctrl+Alt+Down | Add cursor above / below |
| Ctrl+D | Select next occurrence |
| Ctrl+Shift+L | Select all matching occurrences |
| Ctrl+Shift+[ / Ctrl+Shift+] | Fold / unfold current block |
| Ctrl+T | Toggle TOC sidebar |
| Ctrl+Shift+E | File explorer sidebar |
| Ctrl+Shift+F | Search in files |
| Ctrl+L | Toggle AI sidebar |

The command palette includes `Editor: Toggle Vim Mode`, `Editor: Toggle
Minimap`, and `Editor: Toggle Zen Mode`. Vim mode is persisted in
`localStorage["editor.vim"]`. `Ctrl+L` stays assigned to the AI sidebar, so
editor navigation does not steal that binding.

---

## Workflows

### Pipes and managed runs

Pipes are OrPAD pipeline packages for turning local files, node definitions,
and agent handoffs into an inspectable orchestration workflow. Pipeline files
can be authored as text while the Pipes UI exposes Flow and Details views for
editing graph layout, node configuration, run metadata, and handoff context.

Packages describe reusable orchestration roles such as probes, queues,
triage, dispatchers, worker loops, and barriers. They can include node
definitions, reusable graphs, skills, rules, templates, and supporting assets.
Managed runs use those definitions to launch supervised worker activity from
explicit local paths, collect evidence, and keep machine-readable run state
with the package instead of hiding decisions in chat history.

The run controls are intentionally explicit. **Start Run** begins a managed
run from the current pipeline package, while **Prepare Handoff** gathers the
context needed for a human or agent handoff before execution. AI-suggested
shell commands, MCP actions, terminal work, and external browsing are treated
as supervised surfaces: they may be prepared or documented, but side-effecting
commands and competitor or market research require approved browsing or
attached evidence before OrPAD treats them as source material.

### Package registry sharing

OrPAD packages can be shared through Registry metadata. The default public path
is the official OrPAD Registry, where new package entries are admitted through
maintainer-reviewed pull requests before Package Manager labels them as
OrPAD official review metadata.

The official registry index is served from
`https://raw.githubusercontent.com/OrPAD-Lab/orpad-registry/main/registry/packages.json`,
with a compatibility alias at `registry/node-packs.json` for already-shipped
builds. Submissions go through `https://github.com/OrPAD-Lab/orpad-registry/pulls`.

Custom Registry URLs remain supported for teams and experiments, but they are
shown as custom Registry sources and treated as discovery metadata unless the
workspace or user explicitly trusts them. Package Manager still checks
signatures, checksums, review state, declared capabilities, and high-risk
capabilities before import or update.

Authoring tools can generate checksum-backed Registry entry drafts for a pull
request, but they do not mark packages approved and do not create official
Registry signatures by themselves.

### Git status

When the open workspace is a Git repository, OrPAD shows the current branch
in the status bar, file badges in the Files sidebar, and change markers in the
editor gutter.

Git commands in the command palette are status-only: refresh, branch switch,
diff against HEAD, and revert current file. Commit, push, pull, fetch, auth,
conflict resolution, and Git LFS are intentionally out of scope for this phase.

Large repositories can make client-side `statusMatrix` scans slow. OrPAD
shows a scanning banner if the initial status load takes more than three
seconds. In the web build, Git status uses browser File System Access handles
and rebuilds its view from disk on each load, which is intended for
small-to-mid-size repositories rather than very large monorepos.

### Snippets

OrPAD ships built-in CodeMirror snippets for Markdown, JSON, YAML, CSV,
Mermaid, and `.env` files. Snippets appear in autocomplete with a `snippet`
tag, can be inserted through `Insert Snippet...` in the command palette, and
support placeholder cycling with Tab / Shift+Tab.

Typing a snippet name with a colon, such as `toc-marker:`, then pressing Tab
expands it inline.

Workspace snippets live at `.orpad/snippets.json` and override the
cross-workspace fallback stored in the app user-data `snippets.json`. The
schema is:

```json
{
  "markdown": [
    { "name": "note", "body": "> **Note** ${0}" }
  ]
}
```

---

## Build from source

Install dependencies, run the desktop app, or build release artifacts with npm:

```bash
npm install

# Run desktop app in development
npm start

# Build desktop installers for the current platform
npm run dist:win    # Windows NSIS installer (.exe)
npm run dist:mac    # macOS universal DMG (must be run on macOS)

# Build the web app into docs/ for GitHub Pages
npm run build:web       # development bundle
npm run build:web:min   # minified deploy bundle
npm run lh              # Lighthouse PWA check against localhost:4173
```

Useful project files:

- [package.json](package.json) lists available npm scripts.
- [electron-builder.yml](electron-builder.yml) defines desktop packaging.
- [scripts/build-web.js](scripts/build-web.js) builds the GitHub Pages web app.
- [scripts/create-release-manifest.mjs](scripts/create-release-manifest.mjs)
  writes signed release manifests for updater verification.

---

## Privacy, telemetry, and crash reports

### Usage analytics

OrPAD collects anonymous usage events through
[Plausible Analytics](https://plausible.io/privacy): session start/end, file
open/save, format bar interactions, and errors.

Collected event properties are limited to non-personal metadata such as file
format, rough file size, platform, and app version. File contents, filenames,
keystrokes, and user identifiers are not recorded.

To opt out:

- Run `localStorage.setItem("analytics-opt-out", "1")` in DevTools and reload.
- On desktop, development and unpackaged runs are always silent; only
  production builds send events.
- A "Send usage data" toggle will be added to Settings before the Phase 1
  release.

### Crash reports

OrPAD integrates [Sentry](https://sentry.io) for crash reporting when a
build provides `SENTRY_DSN`.

When crash reporting is active, Sentry captures unhandled exceptions, promise
rejections, stack traces, recent breadcrumb actions, app version, OS platform,
and Electron/browser version.

OrPAD does not send file contents, document paths, clipboard data,
keystrokes, or other user-generated content. Sentry's default PII scrubbing is
enabled, and a `beforeSend` hook strips breadcrumb messages containing `.env`,
`.key`, or `.pem` fragments before an event leaves the app.

To opt out on desktop, open DevTools with `Ctrl+Shift+I` and run:

```js
localStorage.setItem('sentry-opt-out', '1');
```

Restart the app. Crash reporting stays disabled until you remove the key:

```js
localStorage.removeItem('sentry-opt-out');
```

Current release builds do not assume a baked-in Sentry DSN. If `SENTRY_DSN` is
unset, the app logs one INFO line and disables crash reporting without making
network calls.

For self-hosted or custom builds, create a Sentry project and launch with:

```bash
SENTRY_DSN=https://<key>@<org>.ingest.sentry.io/<project> npm start
```

See [Plausible's privacy policy](https://plausible.io/privacy) and
[Sentry's privacy policy](https://sentry.io/privacy/) for details on how
aggregated analytics and crash data are processed.

---

## Tech stack

- [Electron 33](https://www.electronjs.org/) for the desktop app
- [CodeMirror 6](https://codemirror.net/) for the editor
- [marked](https://marked.js.org/) for Markdown parsing
- [highlight.js](https://highlightjs.org/) for code syntax highlighting
- [KaTeX](https://katex.org/) for math rendering
- [Mermaid](https://mermaid.js.org/) for diagrams
- [PapaParse](https://www.papaparse.com/) for CSV/TSV parsing
- [js-yaml](https://github.com/nodeca/js-yaml) for YAML parsing
- [smol-toml](https://github.com/squirrelchat/smol-toml) for TOML parsing
- [Ajv](https://ajv.js.org/) for JSON schema validation
- [DOMPurify](https://github.com/cure53/DOMPurify) for HTML sanitization
- [jsonrepair](https://github.com/josdejong/jsonrepair) for JSON repair
- [Turndown](https://github.com/mixmark-io/turndown) for HTML-to-Markdown export
- [esbuild](https://esbuild.github.io/) for bundling

---

## Security

See [SECURITY.md](SECURITY.md) for the security baseline, CSP policy, IPC
handler inventory, localStorage audit, and known follow-ups.

---

## License

MIT
