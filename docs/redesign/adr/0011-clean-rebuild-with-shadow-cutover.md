# ADR-0011: Clean rebuild with a shadow-run cut-over

## Status
Proposed (approach chosen by Michael, 2026-10-14)

## Context
Michael chose a clean rebuild over incremental change. The risk is a long gap without improvements, and losing curated knowledge: profiles, notes, memories and decisions.

## Decision
- **Build `basil-next`** as a new repo through the phases in the design (Foundations → Ingest and resolve → Understand and project → Act and converse → Migrate and cut over).
- **The current app stays in maintenance-only mode:** security and breakage fixes only.
- **Cut-over:**
  1. Import curated data from Blob, with dry-run diff reports for review.
  2. **Shadow-run 1–2 weeks** on the same accounts, comparing Today, People and Inbox side by side.
  3. Michael signs off.
  4. Switch the domain.
  5. Keep the old app read-only for 30 days, then retire it.

## Consequences
### Positive
- A coherent codebase built for the requirements; no legacy coupling.

### Negative
- Calendar time before value; double running during the shadow period (cost: about one extra day of AI per day in shadow, so cap shadow synthesis).

## Alternatives considered
- **Incremental strangler in place:** lower risk, but slower to reach coherence. Michael preferred a clean rebuild.
