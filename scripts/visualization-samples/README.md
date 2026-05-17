# OrPAD Graph Visualization Samples

Regression catalog of `.or-graph` files covering the topologies our
pipeline generator can produce. Open any one of them in OrPAD as a
graph view (`File → Open` or add this folder as a workspace) to inspect
how the visualization handles each pattern.

Each sample is deliberately small so any rendering quirk is easy to
spot, and uses node IDs/labels that hint at the pattern under test.

| # | File | Pattern | What it stresses |
|---|---|---|---|
| 01 | `01-linear.or-graph` | Linear forward chain | baseline — every edge is forward, single column |
| 02 | `02-fork-join.or-graph` | Pattern J (true fork-join) | one source → N parallel probes → barrier → join |
| 03 | `03-ralph-loop.or-graph` | Pattern B (Ralph loop) | gate `revise` loop-back to worker |
| 04 | `04-queue-drain.or-graph` | Pattern I (queue drain) + Pattern K (patch reject) | gate `queue-not-empty` back to dispatcher, plus patch reject back to worker |
| 05 | `05-kitchen-sink.or-graph` | All patterns mixed | 3 probes + barrier + queue + selector → 3 sub-graphs → worker + tree self-check + patchReview + barrier-join + two gates with revise/queue-drain loop-backs |

These files are not part of any pipeline package — they are pure
`.or-graph` documents used only to verify the visualization. They do
not get executed.
