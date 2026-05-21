# Security Review Audit

Use this skill when a pipeline handles secrets, IPC, browser-rendered content, local commands, network access, or destructive operations.

Acceptance criteria:

- Findings are backed by current local file, command, test, or artifact evidence.
- High-risk capabilities are approval-gated instead of executed silently.
- Secret-like values are excluded from prompts, logs, and run artifacts.
