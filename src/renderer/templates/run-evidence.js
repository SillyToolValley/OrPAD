export default {
  id: 'run-evidence',
  label: 'Run Evidence',
  description: 'Verification summary for OrPAD runs, audits, and template-based workflow checks.',
  filename: (vars) => `run-evidence-${new Date().toISOString().slice(0, 10)}-${vars.slug(vars.title)}.md`,
  fields: [
    { key: 'title', label: 'Run or audit name', required: true, placeholder: 'Template hardening audit' },
    { key: 'owner', label: 'Owner', placeholder: 'Engineering owner' },
  ],
  frontmatter: (vars) => ({
    title: vars.title,
    owner: vars.owner,
    status: 'Draft',
  }),
  requiredSections: ['Run Summary', 'Scope', 'Evidence', 'Verification', 'Failures / Gaps', 'Decision'],
  optionalSections: ['Follow-ups'],
  body: (vars) => `# Run Evidence: ${vars.title}

## Run Summary
_Summarize what was generated, executed, audited, or reviewed._

## Scope
- _Included paths, templates, packs, or pipeline surfaces._
- _Excluded or deferred surfaces._

## Evidence
| Item | Source | Result |
|---|---|---|
| _Evidence item_ | \`path/or/command\` | _Observed result._ |

## Verification
- [ ] _Generation path was exercised._
- [ ] _Execution or audit path was exercised._
- [ ] _Decision evidence is recorded._

## Failures / Gaps
- _Failure, blocked verification, or low-value template candidate._

## Decision
- Keep / strengthen / add / deprecate: _decision and rationale._

## Follow-ups
- [ ] _Follow-up item if residual risk remains._
`,
};
