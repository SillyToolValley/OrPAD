# Electron Maintenance Starter Pack

This built-in starter pack shows how a community node pack can package an orchestration lens without shipping executable code.

It contributes a reusable graph, scope rule, and skill for Electron main/preload/renderer maintenance workflows. Pipelines generated for Electron tasks should declare this pack in `nodePacks` and reflect the pack lens in their context, probe, gate, and worker nodes.
