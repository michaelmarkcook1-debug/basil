# ADR-0005: One AI understanding stage with one rule set

## Status
Proposed

## Context
Separate AI passes interpret the same messages with different rules:
- email, Slack and Zoom classifiers;
- the needs-reply judge;
- promise capture;
- thread resolution.

Tone rules differed (Zoom counted any frustration), and notification handling differed (NDA notices became tasks). Fixing one passed the bug to the others.

## Decision
A single **Understand** stage (Haiku, about 20 messages per call, native structured output) returns everything per message:
- `needs_reply`, `reply_valid_until`
- `asks[]`
- `commitments[] {by, for, text, due}`
- `decisions[]`
- `tone_towards_self`
- `facts[]`
- `is_notification`

It runs under **one versioned rule set**: tone only towards the user; notifications and newsletters create nothing; statements are never tasks; time-bound asks expire.

Long meeting transcripts use the same schema, with a larger model when they exceed the token budget.

**Evals:** every audit failure becomes a fixture, among them Carter's Bookings confirmation, "I'll take a look", Malcolm's frustration with a colleague, "send the brochure to Michael", and the "are you on the call?" ask a day later. CI fails if any regresses.

## Consequences
### Positive
- One prompt to get right; consistent behaviour across sources.
- About 8 calls a day instead of per-message calls.

### Negative
- A large schema; a regression affects all sources (mitigated by evals and versioning).

## Alternatives considered
- **Per-source classifiers** (status quo): rejected.
- **Rules only, no AI:** rejected. It can't tell "I'll take a look" from a question.
- **Opus for understanding:** rejected on cost. Haiku plus evals is sufficient; escalate only on low confidence.
