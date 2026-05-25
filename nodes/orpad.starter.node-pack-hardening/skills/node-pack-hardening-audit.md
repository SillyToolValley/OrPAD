# Node Pack Hardening Audit

Use this skill when work changes node pack manifests, discovery roots, starter pack selection, trust or capability gates, quarantine behavior, or maintenance decisions.

Acceptance criteria:

- Compare the in-code built-in catalog, disk `nodes/**/orpad.node-pack.json` manifests, and declared graph/skill/rule assets before editing.
- Treat user and community packs as untrusted until current validation, trust evidence, capability grants, and directory audit diagnostics prove otherwise.
- Run focused node pack compatibility or authoring tests and record keep, repair, quarantine, or deprecate decisions for every affected pack or validation gap.
