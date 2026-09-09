# AI SDLC artifacts

Written by the GStack agents in [.claude/agents/](../.claude/agents/), driven by the playbooks in
[.claude/workflows/](../.claude/workflows/). See [CLAUDE.md](../CLAUDE.md) §3 for the pipelines and gates.

```
ai-sdlc/
  requirements/specs/NNN-slug.md   ← ONE doc per feature, reviewed at the Requirements gate
  design/NNN-slug-design.md        ← the design for that same NNN, reviewed at the Design gate
```

## The requirements doc is written by three agents, in order

| Agent | Adds |
|---|---|
| `gstack-business-analyst` | The document — problem, outcome, scope in/out, numbered behaviour rules, edge cases, failure modes, assumptions, risks |
| `gstack-tech-lead` | `## Feasibility & Blast Radius` — verdict, evidence, radius, missing upstream capability, pipeline |
| `gstack-product-owner` | `## User Stories & Acceptance Criteria` — Given/When/Then, expected verdicts, negative cases, Definition of Done |

They append to the **same file** on purpose: one artifact is reviewed at one gate.

## Rules

- `Status` stays `Draft` until a **named human** approves it. No agent ever sets `Approved` —
  not the author, not the architect, not the orchestrating session.
- `NNN` is the next free 3-digit number. The design doc reuses the requirements doc's `NNN`.
- Absolute dates only; these documents outlive the conversation that produced them.
- The doc is the current agreement, not a historical record. If it turns out to be wrong, correct it —
  QA, code review, and the PR description all test against it.
- Behaviour rules must be individually testable, with concrete values. "Share links are validated"
  is not a rule; "a destination item with no anonymous link at all reports FAIL naming that folder" is.
