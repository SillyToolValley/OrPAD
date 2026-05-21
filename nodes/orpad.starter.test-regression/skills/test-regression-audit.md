# Test Regression Audit

Use this skill when a pipeline investigates failures, repairs regressions, adds focused tests, or records validation evidence.

Acceptance criteria:

- Each change names the failure, reproduction evidence, and validation command or blocker.
- Regression-prone fixes add or update focused tests when the codebase has a practical test surface.
- Skipped or blocked validation is recorded as residual risk instead of hidden in the summary.

Candidate target policy:

- Regression findings should target both the source under test and the focused test or harness file when coverage is missing.
- If a test cannot be added, record the validation command and residual risk in the candidate acceptance criteria.
- Do not mark validation complete from static inspection alone when a runnable test path exists.
