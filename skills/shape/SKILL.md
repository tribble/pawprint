---
name: shape
description: "Use before delegating or starting any build: settle unclear intent with focused questions, keep mocks for meaningful visual design, and answer technical uncertainty with a small verified slice that reports observed evidence. Not for reviews, recon, or mechanical edits."
---

# Shape

A build fails two different ways — you built the wrong thing, or you built on an untested
assumption. They need different checks, and neither needs a mandatory label.

## Wrong thing → ask

Material ambiguity about the desired outcome, scope, or a user-owned tradeoff: ask the user
a concrete question before the dependent build (see the ask-clarifying-questions skill).
Anything discovery, a technical check, or an already-approved default can answer is not a
question — don't ask it.

## Wrong look → mock

Mocks are for rendered layout and design: a screen, a diagram, a CLI/TUI presentation. When
the build is long or hard to undo, show the exact output as it would render and wait for
approval before building. Quick, reversible visual work skips the preview: build it and
show the result. Ordinary prose — a report, a message, a doc — is not a mock surface;
draft the real thing as the delegated result. A JSON blob, a schema diff, a textual
implementation plan, a task list, or promised future tests is not a mock — never dress one
up as one.

## Wrong assumption → verified slice

Technical uncertainty: investigate, or implement and verify one small representative slice
before applying the pattern broadly (migrate one package, then ten). Report observed
behavior and differences with evidence — never expected-behavior promises. When earlier
slices already established the same behavior, cite that evidence and check only what is
different about this batch.

Continuation the user already agreed to proceeds on that evidence — no go/adjust/no pause.
A new tradeoff or scope change goes to the user; so does an external write not already
covered by existing authorization. Cheap and reversible does not itself authorize an
external write.

## Delegating

- Every brief carries the user's verbatim `Owner outcome:` ask, unchanged, through every
  hop; implementers build to it, reviewers judge against it.
- Delegate real work. If producing a preview would *be* the work (splitting a design doc
  into Linear tasks, drafting the doc), the delegate does it within the already-authorized
  scope and surfaces the real result — never do the task to preview it.
- One slice per brief.
