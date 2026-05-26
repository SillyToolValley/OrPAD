# OrPAD Workspace Configuration

This `.orpad` folder contains OrPAD workspace assets.

Recommended layout:

```text
.orpad/
  guidelines/
    README.md
    harness-generation.md
  pipelines/
    <pipeline-id>/
      pipeline.or-pipeline
      graphs/
      trees/
      skills/
      rules/
      harness/
      runs/
```

The app ships built-in Packages from the repository-level `nodes/` folder.
User-installed Packages are managed in the OrPAD app data directory.

Future support may add:

- Workspace-local Packages under `.orpad/nodes/`.
- Workspace-level Package lock files.
- Project-portable custom Package resolution.
- Workspace override and conflict UI.
