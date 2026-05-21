# Frontend UX Audit

Use this skill when a pipeline changes renderer UI, graph editor behavior, inspector controls, context menus, CSS, browser-facing assets, or e2e UX coverage.

Acceptance criteria:

- User-visible states, empty states, disabled states, and interaction transitions are explicitly checked.
- Layout-sensitive changes include focused screenshot, e2e, or browser verification evidence where practical.
- Tests or verification cover the workflow that triggered the UX issue, not only the edited helper function.

Candidate target policy:

- UI behavior findings should target the renderer/web source, CSS, and focused e2e files needed to make the workflow testable.
- Context-menu or inspector findings should name the exact state transition and the UI surface where it appears.
- Do not treat visual verification as optional when the change affects layout, menus, or canvas controls.
