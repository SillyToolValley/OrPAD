# Frontend UX Audit

Use this skill when a pipeline changes renderer UI, graph editor behavior, inspector controls, context menus, CSS, browser-facing assets, or e2e UX coverage.

Acceptance criteria:

- Changed UI screens or states reflect the requested visual, workflow, or reference constraints without regressing essential controls/actions.
- Layout-sensitive changes include focused screenshot, e2e, or browser verification evidence where practical, with before/after screenshots for visual-refresh work.
- Tests or verification cover the workflow that triggered the UX issue, not only the edited helper function.
- When the request names or attaches a visual reference, evidence records the reference path, dimensions or blocked reason, extracted palette, surface hierarchy, typography or material cues, and the current UI surfaces being compared.
- Broad theme or visual-refresh work updates the theme tokens, surface treatments, and representative screens to match the requested reference style instead of only tokenizing existing colors.
- Visual evidence compares before and after screenshots for the target screens whenever the change is meant to alter the look and feel.

Candidate target policy:

- UI behavior findings should target the renderer/web source, CSS, and focused e2e files needed to make the workflow testable.
- Context-menu or inspector findings should name the exact state transition and the UI surface where it appears.
- Do not treat visual verification as optional when the change affects layout, changed UI surfaces, menus, canvas controls, or reference styling.
- Reference-image findings should target the palette/theme source, CSS surface system, image assets, and focused visual smoke coverage needed to prove the reference style was applied.
