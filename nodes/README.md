# OrPAD Built-In Node Packs

This folder contains node packs shipped with OrPAD.

Built-in packs are immutable at runtime and are loaded before user-installed packs.

Recommended loading order:

1. Built-in packs from this folder.
2. User-installed packs from the OrPAD app data directory.

Core `orpad.*` node type ids are reserved for built-in OrPAD packs.

This folder also includes metadata-only starter packs under `orpad.starter.*`.
They are intentionally shaped like community node packs: each pack declares
portable graph, skill, and rule assets that the Generate authoring agent can
select for a situation-specific pipeline without loading arbitrary executable
code.

Current starter packs:

- `orpad.starter.electron-maintenance`
- `orpad.starter.security-review`
- `orpad.starter.release-readiness`
- `orpad.starter.content-qa`
- `orpad.starter.dotnet-lab-code`
- `orpad.starter.frontend-ux`
- `orpad.starter.test-regression`
- `orpad.starter.node-pack-hardening`

To inspect the active pack pool from a development checkout:

```text
node bin/orpad-cli.mjs node-packs list
node bin/orpad-cli.mjs node-packs list --user-node-packs <path-to-user-nodes> --json
```

The list command reports built-in packs, user-installed packs, manifest
diagnostics, duplicate ids, and node type conflicts that need user selection
before activation.

To prepare a community pack for sharing:

```text
node bin/orpad-cli.mjs node-packs validate <path-to-pack> --json
node bin/orpad-cli.mjs node-packs registry-entry create <path-to-pack> --source-repository https://github.com/<owner>/<repo> --source-ref <tag-or-commit> --json
```

`validate` checks the manifest, declared files, normal-install quarantine rules,
README presence, broad capabilities, and deterministic authoring diagnostics.
`registry-entry create` emits a draft registry entry with manifest and declared
file SHA-256 checksums. Draft entries always start as community/unapproved
metadata; registry maintainers add OrPAD-owned signatures or approved review
evidence after review.

Reproducibility in the sharing MVP is user-level. Pipelines declare required
packs in `nodePacks`; installed user packs are tracked in the app-data
`orpad-node-packs.lock.json`; and `node-packs export-list` can share that
inventory for collaboration or support. Workspace-local packs, workspace-level
node pack locks, and project-portable custom pack restoration are intentionally
deferred until a separate design covers the restore flow.
