export default {
  id: 'package-submission',
  label: 'Package Submission',
  description: 'Review record for a community or internal OrPAD package before registry approval.',
  filename: (vars) => `package-submission-${vars.slug(vars.title)}.md`,
  fields: [
    { key: 'title', label: 'Package name', required: true, placeholder: 'orpad.example.pack' },
    { key: 'owner', label: 'Reviewer', placeholder: 'Maintainer' },
  ],
  frontmatter: (vars) => ({
    title: vars.title,
    owner: vars.owner,
    status: 'Review',
  }),
  requiredSections: ['Package Summary', 'Author / Source', 'Capability Review', 'Files / Manifest', 'Verification', 'Approval Decision'],
  optionalSections: ['Quarantine Notes', 'Follow-ups'],
  body: (vars) => `# Package Submission: ${vars.title}

## Package Summary
_Summarize what the package adds and which user workflow it supports._

## Author / Source
- Author:
- Repository / PR:
- License:
- Version:

## Capability Review
| Capability | Needed? | Evidence |
|---|---:|---|
| \`read.workspace\` | _yes/no_ | _why_ |
| \`write.workspace\` | _yes/no_ | _why_ |
| \`run.localVerification\` | _yes/no_ | _why_ |
| Lifecycle scripts | _yes/no_ | _must stay disabled unless explicitly approved_ |

## Files / Manifest
- [ ] \`.codex-plugin/plugin.json\` or \`orpad.node-pack.json\` is present and valid.
- [ ] Package paths stay inside the submitted package root.
- [ ] Runtime handlers and capabilities match the manifest.
- [ ] Examples/templates do not write into the app bundle.

## Verification
| Check | Evidence | Result |
|---|---|---|
| Schema validation | _command or test_ | _pending_ |
| Install/import smoke | _command or test_ | _pending_ |
| Security review | _notes or test_ | _pending_ |

## Quarantine Notes
- _Risk that requires quarantine, rejection, or follow-up._

## Approval Decision
- Approve / request changes / reject: _decision and rationale._

## Follow-ups
- [ ] _Action before registry publication._
`,
};

