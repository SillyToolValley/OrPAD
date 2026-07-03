# OrPAD v1.0.0-beta.6

This is a major prerelease. The orchestration subsystem has been fully rebuilt
("G2"): the old authoring / static-graph editor / node-pack backend was removed
and replaced with a governed agent-delegation core and a live **Run GUI**. The
in-app AI sidebar was removed, and a Run GUI window startup flash was fixed.

## Added

- **Run GUI** — a dedicated multi-run window that visualises governed agent runs
  as a live data-flow graph (agent lanes ↔ file nodes, per-node read/write
  chips, branch-aware DAG, parallel research fan-out), with a run-history picker,
  selectable layout themes, zoom-to-fit, and follow-active camera.
- **Governed delegation core** — a zero-node run engine that grounds in prior
  art, applies results to the workspace, and enforces a verification gate as the
  trust boundary, with a metric-gated iterate loop and a time-cap / tree-kill
  stop signal with partial recovery.
- **Codex provider** — run governed delegation with the `codex` CLI (alongside
  Claude Code), with per-strand themes and multi-active glow in the graph.
- **Terminal-driven Run GUI** — launching an AI CLI in the integrated terminal
  can be observed live in the Run GUI (read-only observation via PTY-stream
  parsing).

## Removed

- The in-app **AI sidebar** (AI chat, Assist tools, and the MCP servers panel),
  its toolbar button, the terminal "Ask AI" / "Explain error" actions, and the
  associated main-process bridges. OrPAD's AI capability is now centred on
  governed orchestration runs rather than an in-editor chat panel.

## Fixed

- The Run GUI window no longer flashes the full OrPAD editor before switching to
  the run layout — the orchestration layout is now applied before first paint.

## Notes

- Beta prereleases are not auto-served to stable users.
