---
name: shape
description: "Use before delegating or starting any build: pick the checkpoint — the cheapest artifact the user can judge in ~30 seconds that would catch a wrong build — and stop there until they have. Sometimes a mock, sometimes examples, sometimes the built result itself. Not for reviews, recon, or mechanical edits."
---

# Shape

A build is waterfall in miniature: requirements guessed, long build, judgment at the end.
Shape moves the judgment to the **cheapest point that would catch a wrong build**. That
point is not always a mock — pick it:

| the build is…                       | checkpoint                                           | brief carries                             |
|-------------------------------------|------------------------------------------------------|-------------------------------------------|
| long or hard to undo, visual        | the picture: exact output as it would appear         | `Approved mock:`                          |
| long or hard to undo, behavioural   | 2–3 examples `given <real input> → <exact output>`   | `Approved mock:`                          |
| long or hard to undo, a contract    | signature / schema diff, before → after              | `Approved mock:`                          |
| quick and reversible                | **the result itself** — build it, review it in place | `Mock: skipped: result is the checkpoint` |
| no user-visible surface             | none — the reviewer loop is the check                | `Mock: skipped: <reason>`                 |

If producing the preview would *be* the work (breaking a doc into tasks, drafting the doc),
the result is the cheaper checkpoint: delegate, don't preview. Never do the task to preview it.

## When a preview is the checkpoint

```
## Shape: <the user's ask, verbatim>

Questions:            ← 0–5, about what they'd DO with the result, never implementation.
1. …                    Omit when the preview is the question.

Mock:                 ← the densest form the surface allows (table above), from REAL data:
<…>                     this session, this repo, this ticket. Prose is not a mock.

First slice: <one sentence — the smallest thing usable tomorrow>

go / "that minus X" / no
```

Then **stop** — nothing spawned, nothing edited, until the user answers. "That minus X" →
show the corrected preview in ≤5 lines and proceed; don't re-ask.

## Always

- One slice per brief. "Sidebar + overlay + CLI + tokens" is four shapes.
- The checkpoint goes into the brief verbatim; it is the acceptance criterion for implementer and reviewer.
- The skip reason is visible in the brief. It is wrong if the result comes back needing a rewrite.
