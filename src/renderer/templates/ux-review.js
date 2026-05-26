export default {
  id: 'ux-review',
  label: 'UX Review',
  description: 'Screen-by-screen UX review for flows, layout density, states, copy, and remaining polish work.',
  filename: (vars) => `ux-review-${vars.slug(vars.title)}.md`,
  fields: [
    { key: 'title', label: 'Flow or screen', required: true, placeholder: 'Package Manager' },
    { key: 'owner', label: 'Reviewer', placeholder: 'Design / product owner' },
  ],
  frontmatter: (vars) => ({
    title: vars.title,
    owner: vars.owner,
    status: 'Draft',
  }),
  requiredSections: ['Journey', 'Screens', 'Issues', 'Decisions', 'Verification', 'Follow-ups'],
  optionalSections: ['Rejected Ideas'],
  body: (vars) => `# UX Review: ${vars.title}

## Journey
_Describe the user goal, entry point, expected decision points, and success state._

## Screens
| Screen / state | What to inspect | Evidence |
|---|---|---|
| _Screen name_ | _layout, density, text, empty/loading/error state_ | _screenshot or note_ |

## Issues
| Severity | Issue | Fix |
|---|---|---|
| High / Medium / Low | _Observed problem_ | _Specific change_ |

## Decisions
- [decision] _Decision and why it is better for repeated use._

## Verification
- [ ] Desktop viewport checked.
- [ ] Narrow viewport checked.
- [ ] Empty, loading, error, and long-content states checked.
- [ ] Text does not overflow or overlap.

## Rejected Ideas
- _Idea rejected and reason._

## Follow-ups
- [ ] _Remaining UX or UI task._
`,
};
