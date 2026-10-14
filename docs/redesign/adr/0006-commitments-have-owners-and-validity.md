# ADR-0006: Commitments always have an owner and a validity window

## Status
Proposed

## Context
"Actions" have an optional free-text owner that no screen uses. Two Zoom recaps filed Carter's and Roger's tasks, and status notes ("Blocker: …", "Follow up: … expected next week"), as the user's actions: 11 open became 33 in four days. Asks never expire ("are you on the call?" sat as a reply card for a day).

## Decision
A **COMMITMENT** has:
- `owner_person_id` (**required**);
- `for_person_id`;
- `text`, `due_at`, `valid_until`;
- `status` — open, done, dropped or expired — with `status_reason`;
- `evidence` (message ids).

*Mine* = owner is self. *Waiting on* = for is self and owner is someone else. Notes that name no owner are **not** commitments; they stay in the meeting or thread summary. A sweep expires items past `valid_until`. Thread re-evaluation (ADR-0005) closes items that are answered, fulfilled or superseded, with a reason.

## Consequences
### Positive
- Your list is only yours; "Waiting on others" is first-class.
- Nothing stale nags you.

### Negative
- Some genuinely unowned tasks are no longer auto-created (they surface in summaries instead).

## Alternatives considered
- **Optional owner plus a UI filter** (the 2026-10-14 interim fix): fine as a patch, but leaves unowned noise in the data.
