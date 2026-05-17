# Per-node-state user actions

Source: codex CLI cross-review (medium reasoning, 2026-05-15).
This table maps every node type × runtime state to the user action it
SHOULD surface, plus an assessment of how OrPAD currently surfaces it.

| Node type | queued | running | blocked | completed | skipped | failed |
|---|---|---|---|---|---|---|
| entry | optional breakpoint | none | retry/skip if adapter issue | none | retry if accidental | retry |
| exit | none | none | resolve missing close condition / patch review | none | retry run close | inspect summary, retry |
| context | edit config, breakpoint | none | provide missing rule/evidence, retry | inspect artifacts | retry if needed | retry / improve prompt |
| probe | edit lens, breakpoint | none | retry probe or narrow lens | inspect candidates | retry | retry probe, improve prompt |
| workQueue | inspect queue | none | unblock/reject items, continue if queued | inspect counts | retry queue ingest | inspect queue artifact |
| triage | edit policy | none | classify approval-required item | inspect queued/blocked/rejected | retry | retry / improve prompt |
| dispatcher | set breakpoint | none | approve next item / resolve stop reason | continue if queue-not-empty | retry | retry dispatcher |
| workerLoop | set breakpoint, model/prompt | none | approve tool/capability or unblock work item | review result | retry item | retry node / choose model |
| patchReview | none | none | **approve/apply/skip patch** | inspect decision | follow-up run if skipped | retry review |
| gate | edit criteria | none | **provide evidence / skip gate / retry failed upstream** | none | retry if bad skip | inspect criteria failure |
| artifactContract | edit required files | none | add missing evidence or mark partial | inspect evidence | retry contract | inspect missing refs |
| barrier | inspect branches | none | resolve failed branch / partial policy | inspect merge | retry merge | retry failed branch |
| selector | choose default/selected | none | make required choice | inspect selected path | retry choice | edit selector, retry |
| graph | open nested layer | none | resolve nested blocked node | open summary | retry nested | open nested failure |
| tree | open tree | none | resolve failed leaf | inspect leaf evidence | retry leaf | retry failed leaf |

## UI assessment (codex)

- Patch review is surfaced relatively well in the banner and modal.
- Gate blocking is visible, but "Skip gate" is too globally available.
  It should show the exact missing evidence and risk before the button.
- Node-local actions live under right-click context menus. For runtime
  states, that is not enough.
- Recommended: a compact node footer action row for blocked/failed
  states with `Review`, `Retry`, `Skip`, `Improve Prompt`, `Choose Model`
  as applicable.
- Hover tooltip / state popover for queued/running/completed is fine,
  but blocked/failed/manual-choice states deserve always-visible buttons
  on the node itself.

## Top 5 fixes ranked by impact / cost (codex)

1. **Collision-aware loop-back routing** — applied
   (`collectOrchStateGraph` now counts column-overlapping intermediate
   nodes; `defaultOrchTransitionPoint` widens loop-back amplitude by
   that count and routes via side exit/entry).
2. **Parallel edge fan-out** — applied
   (`parallelIndex / parallelTotal` per source→target pair; control
   point displaced 1.5× the normal fan offset for parallel siblings).
3. **Label placement pass** — partially applied
   (chip background + right-offset; full collision-aware placement
   against node rects + arrow band is still future work).
4. **Reduce + rename edge categories** — applied
   (Okabe-Ito palette; `accept = pass`, `reject` and `loop-reject`
   share vermillion, `queue-loop = loop-revise = orange`; SVG arrow
   markers including a hollow back-edge head).
5. **Node-local blocked/failed action footer** — NOT yet applied
   (medium cost; next PR).

## Sample regression catalog

| # | File | Pattern | What it stresses |
|---|---|---|---|
| 01 | `01-linear.or-graph` | Linear | baseline spacing, legend minimalism |
| 02 | `02-fork-join.or-graph` | Pattern J | one source → N parallel probes → barrier |
| 03 | `03-ralph-loop.or-graph` | Pattern B | gate `revise` upward loop-back |
| 04 | `04-queue-drain.or-graph` | Pattern I + K | queue-empty/queue-not-empty fork, patch reject |
| 05 | `05-kitchen-sink.or-graph` | All patterns | selector + sub-graphs + tree + 2 gates + ralph + queue drain |
| 06 | `06-loop-through-column.or-graph` | Loop through deep column | regression for complaint #1 (back-edge hidden behind nodes) |
| 07 | `07-multi-worker-same-target.or-graph` | Fan-in + parallel sibling edges | three workers feed one patchReview with three reject loop-backs |

Open this `scripts/visualization-samples/` folder as an OrPAD workspace
(or open the individual `.or-graph` files in any workspace) to inspect
each pattern visually.
