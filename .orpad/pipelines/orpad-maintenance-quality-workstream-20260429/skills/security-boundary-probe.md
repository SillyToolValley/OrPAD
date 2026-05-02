# Security Boundary Probe

## Purpose

Find authority, trust, path, IPC, and execution risks in OrPAD.

## Outputs

- Write findings to `discovery/security-boundary-findings.md`.
- Stage candidates under `run.probeInboxRoot/security-boundary-probe/candidate/`.
- Include a `## Coverage Evidence` section with structured bullets that name `type`, `target`, `file` or `command`, and a short observed result so the discovery barrier can write `run.coverageManifestPath`.
- Every coverage evidence item must include a stable `id`, `observedAt`, `observationKind`, and current-run source, command, or evidence proof.
- Record scenario rows for `validate-imported-trust-denial`, `inspect-realpath-ref-boundary`, and `inspect-approval-deny-path`.
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

- Trust level must affect run capability, not only display.
- Ref resolution must prevent symlink escape and path traversal.
- Renderer approval denial must not start side-effecting local runs.
- Web and desktop validation should not diverge in security-sensitive ways.
- Terminal, MCP, provider, signing, publishing, and credential paths require explicit approval.
- SECURITY.md should reflect changed security boundaries.

## Evidence Budget

Inspect and record at least three current evidence items before writing an empty pass:

- Trust-level validation or execution gating path.
- Ref/path resolution behavior for pipeline graph/tree/skill refs.
- Approval denial or local-run side-effect boundary.

Do not execute destructive or external checks to satisfy this budget; static code and focused local validation are enough.

## Candidate Rules

- Mark approval-required items as blocked unless the user already approved them.
- Include exact files and current evidence.
- Do not run destructive, networked, credentialed, signing, publishing, or broad side-effect commands.
- Every staged candidate must include `userImpact`, `reproSteps`, `expectedBehavior`, `actualBehavior`, `sourceOfTruthTargets`, `verificationPlan`, and `coverageEvidenceIds` that reference current coverage evidence.
