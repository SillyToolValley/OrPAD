# Content QA Audit

Use this skill when a pipeline improves documentation, Markdown, tutorials, course material, templates, or localization text.

Acceptance criteria:

- Source-of-truth claims are preserved or flagged as unverified.
- Audience, examples, headings, and acceptance criteria are explicitly reviewed.
- Markdown, tutorial, or locale-sensitive changes include focused validation or a documented blocker.
- Final editorial pass checks voice/tone, density, repetition, audience fit, and role separation.
- Final editorial pass is backed by OrPAD-owned evaluation artifacts, not only worker self-report.
- Rule-based diff analysis catches bullet/list density, long bullets, duplicate headings, repeated phrases, AI-like scaffolding, README commands in slides, missing before/after rewrite evidence, and checklist-only growth.
- Optional LLM judge input is limited to rule results, changed hunks, a small style sample, and the node-pack rubric, and must return JSON with evidenceRefs.
- Work items classify whether they repair source-of-truth accuracy, presentation/readability, or both.
- Prefer removing, merging, or rewriting low-value prose over adding more scaffolding.
- Slides and tutorial sections keep one main teaching point per slide or section unless the source format requires a lab handout.
