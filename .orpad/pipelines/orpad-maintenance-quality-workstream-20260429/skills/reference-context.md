# Reference Context Skill

## Purpose

Create the fresh maintenance cycle context that lets an agent work from only the pipeline path.

## Inputs

- `pipeline.or-pipeline`
- `graphs/*.or-graph`
- `trees/*.or-tree`
- `skills/*.md`
- `rules/*.or-rule`
- Relevant local OrPAD files under `src/`, `tests/`, `nodes/`, `SECURITY.md`, `package.json`, and `electron-builder.yml`

## Required Output

Write these files under `run.artifactRoot`:

- `cycle-start.md`
- `reference-context.md`

## Procedure

1. Start a new maintenance cycle from the manifest alone. Treat any existing `harness/generated/latest-run` content as historical unless `npm run audit:orpad-run` passes for the current HEAD and worktree.
2. If stale generated state exists, replace it within the allowed generated harness area instead of using it as source-of-truth. Do not restore, beautify, or select generated evidence as the only improvement target.
3. Write `cycle-start.md` with runId, startedAt, current git HEAD, current git status digest, cycle semantics, previous latest-run handling, and the rule that `done` closes this cycle only.
4. Record the pipeline id, selected entry graph, node packs, trust level, maintenancePolicy, and self-improvement setting.
5. Summarize OrPAD's current product intent: local-first orchestration authoring, graph/tree editing, node packs, queue-driven maintenance, and safe agent execution.
6. Record which local files are likely relevant to this run.
7. Record which reference families are being used: agent orchestration, durable workflow, Electron security, Playwright verification, packaging, and developer-content quality.
8. Create or update `run.metadataPath` with schemaVersion `orpad.runEvidence.v1`, pipelineId, runId, startedAt, current git HEAD, current git status digest, and the audit commands that must pass before trusting latest-run evidence.
9. State assumptions and any missing context.

## Quality Bar

- Do not copy long reference text.
- Do not treat historical review findings as current evidence.
- Treat existing latest-run evidence files as historical until their metadata matches the current HEAD/worktree status and `npm run audit:orpad-run` passes.
- Make it clear that `latest-run` is the mutable snapshot for this cycle, while durable future runner evidence belongs under `runs/<runId>`.
- End with a short list of checks the discovery probes should perform.
