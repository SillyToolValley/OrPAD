# Maintenance Workstream Machine Fixture

This fixture captures the source-controlled shape of the current OrPAD maintenance workstream before the Orchestration Machine runtime exists.

It intentionally does not copy `.orpad/**/harness/generated/**` or `.orpad/**/runs/**` evidence. Those paths are generated runtime output and are ignored by git. The fixture records only the minimal source shape and the current audit snapshot that later Machine PRs need to preserve or migrate.

Source pipeline:

```text
.orpad/pipelines/orpad-maintenance-quality-workstream-20260429/pipeline.or-pipeline
```

PR 0 test harness decision:

```text
npm run test:machine
node --test tests/orchestration-machine/*.test.mjs
```

This uses the Node built-in test runner and adds no dependency.
