# Test Gap Probe

## Purpose

Find missing focused tests that would catch important OrPAD regressions.

## Outputs

- Write findings to `discovery/test-gap-findings.md`.
- Stage candidates under `run.probeInboxRoot/test-gap-probe/candidate/`.
- Include a `## Coverage Evidence` section with structured bullets that name `type`, `target`, `file` or `command`, and a short observed result so the discovery barrier can write `run.coverageManifestPath`.
- Every coverage evidence item must include a stable `id`, `observedAt`, `observationKind`, and current-run source, command, or evidence proof.
- Record scenario rows for `map-focused-electron-coverage`, `map-validator-audit-coverage`, and `map-web-or-file-association-coverage`.
- Stage inventory fragment rows under `config.inventoryStageRoot` for every notable observation: `candidate`, `deferred`, `deduped-into`, or `empty-pass`. The discovery barrier, not parallel probes, writes the merged `run.candidateInventoryPath`.
- Every inventory row must include `id`, `lensId`, `status`, `title`, `evidenceIds`, `targetIds`, `riskCheckIds`, `checkResult`, `scenarioIds`, `inspectedTargets`, and either `stagedCandidateId`, `dedupedInto`, or a concrete `reason`.
- Use target ids from `run.discoveryCoveragePolicy.targetMatrix`; do not replace target-level rows with one broad lens-level empty pass.
- Use risk check ids from the matching target. An empty-pass row may cover only one risk check and must include the concrete negative check that was attempted or observed.
- Stage one candidate per independently actionable failed risk check or tightly coupled cluster; do not bundle unrelated risk checks into one broad maintenance item.
- Empty-pass rows must include `negativeCheck.method`, `negativeCheck.expected`, and `negativeCheck.observed`.
- Empty-pass rows must name the exact file, command, selector, assertion, artifact, or observed behavior that cleared the risk. Do not use reusable text such as "current evidence directly probed", "focused tests or audit evidence", "covered without a separate actionable candidate", or "did not leave a separate actionable failure"; mark the row `deferred` when proof is not direct enough.
- Do not drop a weaker duplicate silently. Record it as `deduped-into` with the canonical candidate id and evidence ids.
- For every required risk check that does not produce a candidate, write an `empty-pass`, `deferred`, or `deduped-into` inventory row with inspected targets, scenario ids, evidence ids, and a concrete reason.

## Lenses

- Pipeline manifest preview and editing.
- Graph nested layer navigation, breadcrumb, parent return, and viewport fit.
- Node type filtering by graph vs tree editing surface.
- Built-in node-pack validation.
- Web adapter validation parity.
- Queue contract validation for staged probes and canonical journal.
- Trust, approval, and run side-effect boundaries.

## Evidence Budget

Inspect and record at least three current evidence items before writing an empty pass:

- Existing Electron e2e coverage for the touched product surface.
- Existing validator/unit coverage for schema, trust, ref, or node-pack behavior.
- Web/PWA, file association, or queue contract coverage gaps.

If no test is added, explain why the current focused tests already cover the highest-risk path.

## Candidate Rules

- Prefer tests tied to a concrete observed bug or high-risk contract.
- Include the expected test command.
- Avoid adding broad slow tests when a focused Electron or unit test can prove the behavior.
- Every staged candidate must include `userImpact`, `reproSteps`, `expectedBehavior`, `actualBehavior`, `sourceOfTruthTargets`, `verificationPlan`, and `coverageEvidenceIds` that reference current coverage evidence.
