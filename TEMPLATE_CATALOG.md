# OrPAD Template Catalog

This catalog is the source-of-truth decision record for templates that are exposed to users through the document template picker, built-in pipeline examples, and Generate's starter node-pack selection. Build outputs under `docs/` are intentionally excluded from this catalog.

## User-Facing Markdown Templates

| Template id | Label | Role | Decision |
| --- | --- | --- | --- |
| `prd` | Product Requirements Document | Product change framing: problem, users, goals, scope, risks, and open questions. | Keep. It is the default product-planning template and remains first in the picker. |
| `release-checklist` | Release Checklist | Version, notes, build evidence, verification, publish plan, rollback, and ship/hold decision. | Add. Release prep is a repeated OrPAD workflow and needs a checklist that records build proof and accepted risk. |
| `node-pack-submission` | Node Pack Submission | Package author/source review, capability audit, manifest/file checks, verification, quarantine notes, and approval decision. | Add. Community package sharing should be mediated through PR or maintainer approval with a durable review record. |
| `ux-review` | UX Review | Journey, screens, issues, decisions, verification states, rejected ideas, and follow-ups. | Add. UI polish work needs a focused review artifact before implementation changes are queued. |
| `handover` | Handover | Session transfer summary for humans or AI conversations. | Keep. It supports long-running local-first workflows and has tracker coverage through the registry test. |
| `spec-sheet` | Spec Sheet | Endpoint, command, or module contract details with request/response/error/test sections. | Keep and monitor. It is useful when the user needs implementation-contract precision. |
| `task-list` | Task List | Owner and priority checklist that can later map to task tools. | Keep. Import integrations remain gated on matching MCP servers. |
| `adr` | Architecture Decision Record | Durable technical decision with context, consequences, and alternatives. | Keep. This is distinct from PRD/spec because it records a chosen tradeoff. |
| `session-log` | Session Log | Prompt/response and decision log for AI-assisted sessions. | Keep. It is valuable for auditability but should stay separate from handover. |
| `run-evidence` | Run Evidence | Verification summary for generated, executed, or audited OrPAD runs. | Keep. Template hardening needs a user-visible way to capture run/audit proof, failures, and keep/strengthen/add/deprecate decisions. |

Rejected or isolated candidates:

- Generic blank notes, meeting notes, and status updates are not added because they overlap with normal Markdown creation and dilute the picker.
- Snippet bodies such as `row-template` are editor snippets, not document templates.
- Reserved folders under `nodes/orpad.workstream/skills`, `rules`, and `trees` are internal starter asset slots until they contain concrete user-facing pack assets.
- Tutorial-only orchestration examples are not exposed as package templates. Built-in examples should model product, build, release, or maintenance work directly.

## Built-In Pipeline Templates

| Pipeline path | Role | Decision |
| --- | --- | --- |
| `nodes/orpad.core/examples/product-decision-gate/pipeline.or-pipeline` | Product readiness gate for problem evidence, owner, acceptance criteria, non-goals, and release risk. | Add. This is the smallest useful product-planning pipeline and replaces the generic gate sample. |
| `nodes/orpad.core/examples/release-risk-routing/pipeline.or-pipeline` | Release selector that routes evidence into ship, fix-forward, or hold branches. | Add. This makes selector branching useful for a real release decision instead of a branch demonstration. |
| `nodes/orpad.workstream/examples/product-build-workstream/pipeline.or-pipeline` | Executable product-build workstream with deterministic harness fixture and patch-review block. | Add and run-verify. It proves a copied template can create a worker result and reviewable patch without model cost. |
| `nodes/orpad.workstream/examples/maintenance-workstream.or-pipeline` | Maintenance quality workstream with parallel probes, queue validation, triage, dispatcher, worker loop, evidence contract, and review. | Keep and strengthen. It is validated as template-only and should be copied before execution against a real workspace. |

All built-in pipeline templates must declare:

- `template: true`
- `trustLevel: "local-authored"`
- `executionPolicy.mode: "template-only"`
- `executionPolicy.copyBeforeRun: true`

## Starter Node-Pack Templates

Generate can select these metadata-only starter packs when prompt text and workspace evidence match the situation. They are not one-click document templates; they are reusable authoring guidance for generated pipeline packages.

| Pack id | Role | Decision |
| --- | --- | --- |
| `orpad.starter.electron-maintenance` | Electron runtime, preload/IPC, renderer packaging, and desktop app maintenance. | Keep. |
| `orpad.starter.security-review` | Secrets, authority boundaries, XSS, IPC, and destructive capability risk. | Keep. |
| `orpad.starter.release-readiness` | Version metadata, release notes, build scripts, installers, and residual-risk evidence. | Keep. |
| `orpad.starter.content-qa` | Docs, Markdown, tutorials, localization, and template content quality. | Keep and use for Markdown template changes. |
| `orpad.starter.dotnet-lab-code` | C#/.NET lab code, README-to-code alignment, runnable examples, and course validation. | Keep. |
| `orpad.starter.frontend-ux` | Renderer/web UI, styles, templates UI, Playwright/e2e, and browser-facing behavior. | Keep and use for template picker UX changes. |
| `orpad.starter.test-regression` | Failing tests, regression checks, smoke runs, and validation gaps. | Keep and pair with template hardening verification. |
| `orpad.starter.node-pack-hardening` | Node pack manifests, discovery trust, capability gates, quarantine, and maintenance decisions. | Keep and use when starter pack selection or deprecation decisions are part of the work. |

## Validation Contract

Template changes should preserve this closed loop:

1. Document templates are registered in `src/renderer/templates/registry.js`, create Markdown through `createTemplateFile`, and are understood by `src/renderer/templates/tracker.js`.
2. Pipeline templates validate through `validateRunbookFile`; executable static templates must also have a copied-workspace machine run test or be explicitly labeled structural/template-only.
3. Generate starter-pack decisions are verified by `createOrchestrationPipeline` or `orpad generate` with a template-hardening prompt and a workspace snapshot that includes template, starter pack, and test paths.
4. Low-value or overlapping candidates are recorded here instead of silently remaining in the picker.
