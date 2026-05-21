# Security Review Starter Pack

This built-in starter pack packages a review lens for secret handling, authority boundaries, XSS, IPC, and destructive capability risk.

It is metadata-only: no lifecycle scripts and no executable handlers. Generated pipelines use the pack by declaring it in `nodePacks` and applying its security review lens to context, probe, approval, gate, and artifact nodes.
