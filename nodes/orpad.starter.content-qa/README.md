# Content QA Starter Pack

This built-in starter pack packages a content-quality orchestration lens for documentation, Markdown, tutorials, learning material, and localization.

Generated pipelines use the pack by declaring it in `nodePacks` and carrying content-specific criteria into context, probe, gate, worker, and artifact nodes.

For docs, slides, tutorials, and course material, generated pipelines should also carry a final editorial quality gate before artifact recording. That gate uses OrPAD-owned worker evaluation artifacts under `artifacts/evaluations/content-editorial/workers/`, declares judge artifact expectations under `artifacts/evaluations/content-editorial/judges/`, runs a rule-based diff analyzer over changed hunks, and may require an optional JSON-only LLM judge through `judgePolicy`.

Workers should leave concrete diff evidence through removals, merges, rewrites, and focused validation. The gate does not accept self-reported editorial proof in a worker summary as a substitute for the independent evaluation artifact.
