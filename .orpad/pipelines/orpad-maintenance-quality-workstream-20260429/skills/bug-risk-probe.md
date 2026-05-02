# Bug Risk Probe

## Purpose

Find defects likely to break validation, editing, execution evidence, or migration.

## Outputs

- Write findings to `discovery/bug-risk-findings.md`.
- Stage candidates under `run.probeInboxRoot/bug-risk-probe/candidate/`.
- Include a `## Coverage Evidence` section with structured bullets that name `type`, `target`, `file` or `command`, and a short observed result so the discovery barrier can write `run.coverageManifestPath`.
- Every coverage evidence item must include a stable `id`, `observedAt`, `observationKind`, and source/command/evidence proof from the current run.
- Record scenario rows for `validate-broken-ref`, `compare-renderer-validator-node-types`, `inspect-generated-evidence-git-hygiene`, and `inspect-web-desktop-parity`.
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

- Validator and renderer disagree on supported node types.
- Manifest properties are editable but not persisted or not validated.
- Graph refs, tree refs, and skill refs resolve differently across desktop and web.
- Work state and evidence contracts can diverge.
- Generated files appear in git status unexpectedly.
- Tests create sidecar metadata files that are not ignored or cleaned.
- File association, scanner, preview, and editor mappings diverge.

## Evidence Budget

Inspect and record at least four current evidence items before writing an empty pass:

- Validator behavior or validator source.
- Renderer graph/editor state handling.
- Web adapter, scanner, preview, or file mapping behavior.
- Generated metadata/git hygiene behavior.

If a risk is historically remembered, reproduce it against current files or explicitly discard it as stale.

## Candidate Rules

- Reproduce with current code or current file contents.
- Include the failure mode and the likely user impact.
- Prefer small, well-tested fixes.
- Every staged candidate must include `userImpact`, `reproSteps`, `expectedBehavior`, `actualBehavior`, `sourceOfTruthTargets`, `verificationPlan`, and `coverageEvidenceIds` that reference current coverage evidence.
