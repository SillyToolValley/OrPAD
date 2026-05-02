# Pipeline Quality Probe

## Purpose

Find problems in pipeline, node-pack, graph, tree, skill, rule, work-state, and evidence contracts.

## Outputs

- Write findings to `discovery/pipeline-quality-findings.md`.
- Stage candidates under `run.probeInboxRoot/pipeline-quality-probe/candidate/`.
- Include a `## Coverage Evidence` section with structured bullets that name `type`, `target`, `file` or `command`, and a short observed result so the discovery barrier can write `run.coverageManifestPath`.
- Every coverage evidence item must include a stable `id`, `observedAt`, `observationKind`, and source, command, or evidence proof from the current run.
- Stage inventory fragment rows under `config.inventoryStageRoot` for every notable observation: `candidate`, `deferred`, `deduped-into`, or `empty-pass`. The discovery barrier, not parallel probes, writes the merged `run.candidateInventoryPath`.
- Every inventory row must include `id`, `lensId`, `status`, `title`, `evidenceIds`, `targetIds`, `riskCheckIds`, `checkResult`, `inspectedTargets`, and either `stagedCandidateId`, `dedupedInto`, or a concrete `reason`; include `scenarioIds` when this lens records scenario rows.
- Use target ids from `run.discoveryCoveragePolicy.targetMatrix`; do not replace target-level rows with one broad lens-level empty pass.
- Use risk check ids from the matching target. An empty-pass row may cover only one risk check and must include the concrete negative check that was attempted or observed.
- Stage one candidate per independently actionable failed risk check or tightly coupled cluster; do not bundle unrelated risk checks into one broad maintenance item.
- Empty-pass rows must include `negativeCheck.method`, `negativeCheck.expected`, and `negativeCheck.observed`.
- Empty-pass rows must name the exact file, command, selector, assertion, artifact, or observed behavior that cleared the risk. Do not use reusable text such as "current evidence directly probed", "focused tests or audit evidence", "covered without a separate actionable candidate", or "did not leave a separate actionable failure"; mark the row `deferred` when proof is not direct enough.
- Do not drop a weaker duplicate silently. Record it as `deduped-into` with the canonical candidate id and evidence ids.
- For every required risk check that does not produce a candidate, write an `empty-pass`, `deferred`, or `deduped-into` inventory row with inspected targets, evidence ids, and a concrete reason.

## Lenses

- A pipeline launched by path should not require prompt-specific hidden instructions.
- Evidence roots, work-state roots, and summary paths must be unambiguous.
- Parallel probe outputs must not race on a shared journal.
- Graph-level capabilities must include the union of child capabilities.
- Node schemas should expose config fields used by real graphs.
- Example pipelines should not write into immutable node-pack directories.
- Self-improvement policy must be explicit and enforceable.
- Graph node configs must not drift beyond their node-pack `configSchema`; run `npm run audit:orpad-node-schemas -- .orpad/pipelines/orpad-maintenance-quality-workstream-20260429/pipeline.or-pipeline` before treating node-pack schema coverage as sufficient.

## Evidence Budget

Inspect and record at least two current evidence items before writing an empty pass. Pipeline-quality is a supporting lens, so do not use it to skip product, UX, bug, security, or test-gap coverage.

Valid evidence includes:

- A mismatch between manifest, graph, tree, skill, rule, node-pack, or evidence contracts.
- A queue/journal/replay issue that would make other lenses unreliable.
- A source-of-truth pipeline issue that prevents path-only agent execution.

## Candidate Rules

- Include the exact file path and contract mismatch.
- Prefer fixes that improve agent autonomy and replayability.
- Do not choose generated latest-run artifact restoration as the improvement.
- Mark pipeline-quality candidates as lower priority than current P1/P2 product, UX, security, bug-risk, or test-gap candidates unless the pipeline issue blocks reliable discovery or execution.
- Every staged candidate must include `userImpact`, `reproSteps`, `expectedBehavior`, `actualBehavior`, `sourceOfTruthTargets`, `verificationPlan`, and `coverageEvidenceIds` that reference current coverage evidence.
