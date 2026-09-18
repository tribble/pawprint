---
name: shape
description: "Use before delegating or starting any build with a user-visible surface (CLI output, message, UI text, PR behaviour, data shape): show the user the result as it would appear, get a go, then build the smallest usable slice. Do not use for reviews, recon, mechanical edits, or work with no user-visible surface — mark those `Mock: skipped: <reason>`."
---

# Shape

The user approves the **thing they will see**, never a plan. A plan reads like control and isn't: you can't tell from "add overlay + sidebar + CLI flag" whether the result is right. A mock takes 30 seconds to judge.

## Output (one screen, this order, nothing else)

```
## Shape: <the user's ask, verbatim>

Questions:                       ← 0–5. About what they'd DO with the result, never implementation.
1. …                               Omit the section when the mock itself is the question.

Mock — what you'd see:
<the artifact as it would appear: exact terminal output / exact message text /
 the PR's behaviour bullets / before→after rows. Built from the user's REAL data
 where possible (this session, this repo, this ticket), not lorem ipsum.>

First slice: <one sentence — the smallest thing usable tomorrow>
Later, only if the slice earns it: <one line, or omit>

go / "that minus X" / no
```

Then **stop**. No agent spawned, no file edited, until the user answers.

## Rules

- Mock from real data. Run the query, read the session, fetch the ticket — the mock is the first test of whether the thing is buildable.
- One slice per brief. "Sidebar + overlay + CLI + tokens" is four shapes, not one.
- Corrections re-shape: "that minus X" → show the corrected mock in ≤5 lines, then proceed. Don't re-ask.
- The approved mock goes into the brief verbatim under `Approved mock:` and is the acceptance criterion — the implementer builds to it and the reviewer judges against it.
- Skipping is allowed and must be visible: `Mock: skipped: <reason>` in the brief. Valid reasons: no user-visible surface (refactor, dep bump, CI fix), or the user already said what it should look like.

## Anti-patterns

- Asking implementation questions ("where should the flag live?"). Decide; the mock exposes wrong decisions.
- A mock that is a description of the mock ("a list of artifacts with timestamps"). Show the list.
- Shaping the whole feature, then building the whole feature. Shape the slice.
