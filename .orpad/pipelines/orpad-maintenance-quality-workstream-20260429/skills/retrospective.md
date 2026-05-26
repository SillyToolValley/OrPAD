# Retrospective Skill

## Purpose

Judge whether the pipeline improved real work quality and capture the next improvement.

## Outputs

- `retrospective.md`
- `run.metadataPath`
- `harness/generated/latest-run/summary.md`

## Procedure

1. Compare candidate quality against the user's expectation: did the pipeline discover real issues without being spoon-fed?
2. Explain whether the processed work items improved product code, tests, Packages, or the pipeline source of truth.
3. Identify any weak spot in discovery, queue ingestion, triage, implementation, or verification.
4. Compare `run.candidateInventoryPath` with the final queue state and call out any observation that was discovered but not queued, blocked, rejected, deferred, or deduped.
5. If the weak spot is actionable and self-improvement is enabled, stage it as a future candidate instead of silently changing scope.
6. Record processed item ids, residual queued/blocked/rejected work, inventory disposition counts, and a concrete next-cycle suggestion, even when the cycle status is `done`.
7. Update `run.metadataPath` with endedAt, status, final git HEAD, final git status digest, audit command summaries, and an `artifactManifest.files` list containing path, sha256, and size for `summaryPath`, `coverageManifestPath`, `candidateInventoryPath`, every required artifact, `journal.jsonl`, and queue item JSON file.
8. Write the final summary with evidence files created, verification run, residual risk, next-cycle suggestion, and status.

## Summary Status

End the summary with exactly one of:

- `## Status: done`
- `## Status: partial`
- `## Status: blocked`

The status marker closes the latest maintenance cycle only. It must not imply that this pipeline is finished, disabled, or no longer useful for future maintenance runs.

Use `## Status: done` only when candidate, queued, and claimed queue states are empty after the worker loop. If actionable queue items remain for a future cycle, use `## Status: partial` and list those item ids with the stop reason.
