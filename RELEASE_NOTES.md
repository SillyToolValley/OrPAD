# OrPAD v1.0.0-beta.4

OrPAD v1.0.0-beta.4 focuses on package sharing readiness, Package Manager
navigation, and release audit cleanup.

## Changes

- Reworked Package Manager browse rows into compact full-width package slots
  with name, author, Detail, and Import actions.
- Moved registry package inspection into a focused Detail modal so large
  package catalogs are easier to scan.
- Added Registry governance metadata for official PR-reviewed OrPAD packages,
  custom Registry sources, third-party review claims, and discovery-only
  metadata.
- Added an initial official Registry JSON under `registry/packages.json` and
  wired the default Package Manager source to the repository-hosted copy.
- Added Package Manager trust labels and warnings so custom Registry URLs
  cannot self-declare OrPAD official approval.
- Added Registry authoring, source management, workspace lock, install/update,
  and review-state tests for package sharing flows.
- Updated release dependencies so `npm audit --omit=dev --audit-level=high`
  passes for production dependencies.
