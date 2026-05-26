# Harness Generation Guidelines

Generated harnesses should be created under the pipeline's declared `harness.path`.

For queue-driven workstream pipelines:

- Put queue state under the run artifact root.
- Keep queue state out of graph files.
- Store work item artifacts under `artifacts/work-items/<work-item-id>/`.
- Record queue transitions in `queue/journal.jsonl`.
- Treat approval, credentials, publishing, signing, destructive git, and destructive filesystem operations as explicit stop conditions.
- Local read, edit, build, and focused verification steps are allowed when the pipeline and node capabilities allow them.

Generated harnesses should be reproducible from the `.or-pipeline`, referenced graphs, Packages, skills, rules, and this guideline folder.
