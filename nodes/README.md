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

To inspect the active pack pool from a development checkout:

```text
node bin/orpad-cli.mjs node-packs list
node bin/orpad-cli.mjs node-packs list --user-node-packs <path-to-user-nodes> --json
```

The list command reports built-in packs, user-installed packs, manifest
diagnostics, duplicate ids, and node type conflicts that need user selection
before activation.

Future support may add workspace-local node packs under `.orpad/nodes/`, workspace-level node pack locks, and project-portable custom pack resolution. These are intentionally not part of the initial node pack structure.
