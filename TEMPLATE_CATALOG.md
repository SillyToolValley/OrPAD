# OrPAD Template Catalog

This catalog is the source-of-truth decision record for the user-facing document
templates exposed through the document template picker. Build outputs under
`docs/` are intentionally excluded from this catalog.

> The built-in pipeline templates, Generate starter packages, and node-pack
> catalog documented in earlier revisions were removed in the G2 orchestration
> rebuild (the static-graph editor, pipeline generator, and node-pack system are
> gone). Only the Markdown document templates below remain.

## User-Facing Markdown Templates

| Template id | Label | Role | Decision |
| --- | --- | --- | --- |
| `prd` | Product Requirements Document | Product change framing: problem, users, goals, scope, risks, and open questions. | Keep. It is the default product-planning template and remains first in the picker. |
| `release-checklist` | Release Checklist | Version, notes, build evidence, verification, publish plan, rollback, and ship/hold decision. | Keep. Release prep is a repeated OrPAD workflow and needs a checklist that records build proof and accepted risk. |
| `package-submission` | Package Submission | Author/source review, capability audit, manifest/file checks, verification, quarantine notes, and approval decision. | Keep. A durable review record for shared content. |
| `ux-review` | UX Review | Journey, screens, issues, decisions, verification states, rejected ideas, and follow-ups. | Keep. UI polish work needs a focused review artifact before implementation changes are queued. |
| `handover` | Handover | Session transfer summary for humans or AI conversations. | Keep. It supports long-running local-first workflows and has tracker coverage through the registry test. |
| `spec-sheet` | Spec Sheet | Endpoint, command, or module contract details with request/response/error/test sections. | Keep and monitor. Useful when the user needs implementation-contract precision. |
| `task-list` | Task List | Owner and priority checklist that can later map to task tools. | Keep. Import integrations remain gated on matching MCP servers. |
| `adr` | Architecture Decision Record | Durable technical decision with context, consequences, and alternatives. | Keep. This is distinct from PRD/spec because it records a chosen tradeoff. |
| `session-log` | Session Log | Prompt/response and decision log for AI-assisted sessions. | Keep. Valuable for auditability but stays separate from handover. |
| `run-evidence` | Run Evidence | Verification summary for generated, executed, or audited OrPAD runs. | Keep. Captures run/audit proof, failures, and keep/strengthen/add/deprecate decisions. |

Rejected or isolated candidates:

- Generic blank notes, meeting notes, and status updates are not added because they overlap with normal Markdown creation and dilute the picker.
- Snippet bodies such as `row-template` are editor snippets, not document templates.

## Validation Contract

Template changes should preserve this closed loop:

1. Document templates are registered in `src/renderer/templates/registry.js`, create Markdown through `createTemplateFile`, and are understood by `src/renderer/templates/tracker.js`.
2. Low-value or overlapping candidates are recorded here instead of silently remaining in the picker.
