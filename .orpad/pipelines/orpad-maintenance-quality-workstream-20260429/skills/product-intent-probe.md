# Product Intent Probe

## Purpose

Find mismatches between OrPAD's intended product model and the current implementation.

## Outputs

- Write findings to `discovery/product-intent-findings.md`.
- Stage candidates under `run.probeInboxRoot/product-intent-probe/candidate/`.
- Include a `## Coverage Evidence` section with structured bullets that name `type`, `target`, `file` or `command`, and a short observed result so the discovery barrier can write `run.coverageManifestPath`.
- Every coverage evidence item must include a stable `id`, `observedAt`, `observationKind`, and enough current-run source, command, or evidence file detail to reproduce the observation.
- Record scenario rows for `launch-from-pipeline-path`, `inspect-manifest-policy`, and `inspect-node-pack-model`.
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

- Pipeline path should be enough to launch agent work.
- Manifest policy should replace prompt-heavy instructions.
- Graphs should compose other graphs as nested layers.
- Packages should distinguish built-in, official, and community nodes.
- Self-improvement should be controlled by manifest policy.
- Generated harness evidence should be evidence, not the main product.

## Evidence Budget

Inspect and record at least three current evidence items before writing an empty pass:

- Pipeline authoring model: `.orpad` structure, pipeline manifest, Graph/Manifest editor behavior, or validation output.
- Package model: built-in Package files, example pipeline, editor node type exposure, or validator support.
- Agent launch model: execution policy, run button behavior, approval/run boundary, or path-only launch instructions.

## Candidate Rules

- Cite the current source file, UI behavior, or pipeline contract that causes the mismatch.
- Explain why the mismatch hurts agent quality or user comprehension.
- Include a bounded fix and verification path.
- Every staged candidate must include `userImpact`, `reproSteps`, `expectedBehavior`, `actualBehavior`, `sourceOfTruthTargets`, `verificationPlan`, and `coverageEvidenceIds` that reference the evidence ids above.
