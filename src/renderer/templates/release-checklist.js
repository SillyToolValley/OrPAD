export default {
  id: 'release-checklist',
  label: 'Release Checklist',
  description: 'Version, notes, build, verification, publish, rollback, and approval checklist for a release.',
  filename: (vars) => `release-${vars.slug(vars.version || vars.title)}.md`,
  fields: [
    { key: 'title', label: 'Release name', required: true, placeholder: 'OrPAD desktop beta' },
    { key: 'version', label: 'Version', placeholder: '1.0.0-beta.4' },
    { key: 'owner', label: 'Release owner', placeholder: 'Engineering owner' },
  ],
  frontmatter: (vars) => ({
    title: vars.title,
    version: vars.version,
    owner: vars.owner,
    status: 'Draft',
  }),
  requiredSections: ['Release Summary', 'Version / Build', 'Preflight', 'Verification', 'Publish Plan', 'Rollback', 'Decision'],
  optionalSections: ['Known Gaps', 'Follow-ups'],
  body: (vars) => `# Release Checklist: ${vars.title}

## Release Summary
_State what is shipping, who it affects, and why this version is worth publishing._

## Version / Build
- Version: ${vars.version || '_unset_'}
- Build artifact: _installer, zip, web bundle, or package path_
- Release notes: _path or link_

## Preflight
- [ ] Version metadata is correct.
- [ ] Release notes match the shipped behavior.
- [ ] Required templates, packages, and generated assets are present.
- [ ] Signing, notarization, or unsigned-build decision is recorded.

## Verification
| Check | Command / Evidence | Result |
|---|---|---|
| Build | \`npm run dist:win\` | _pending_ |
| Renderer | \`npm run build:renderer\` | _pending_ |
| Machine tests | \`npm run test:machine\` | _pending_ |
| E2E smoke | _Playwright target_ | _pending_ |

## Publish Plan
- Target channel: _beta / stable / internal_
- Upload location: _release, registry, or package host_
- Announcement owner: ${vars.owner || '_unset_'}

## Rollback
- Previous version: _version and artifact_
- Rollback trigger: _failure condition_
- Rollback action: _remove release, publish hotfix, or restore previous artifact_

## Known Gaps
- _Gap or accepted risk._

## Decision
- Ship / hold / rebuild: _decision and rationale._

## Follow-ups
- [ ] _Post-release action._
`,
};
