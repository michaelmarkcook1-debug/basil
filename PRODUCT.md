# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary — the expert daily user.** Michael Cook, an executive at TalentGenius,
using Basil every day from both phone and desktop. He already knows the system's
vocabulary and does not need it explained. His situation is high-volume,
multi-channel, and interrupt-driven: signal arrives constantly across mail, chat,
calendar and meeting recaps, and the cost of missing one piece is real.

**Secondary — the first-time evaluator (confirmed 2026-08-03).** Basil is
pre-launch and being productised, so a stranger must be able to make sense of it
within their first few minutes. Design serves both: dense and fast for the daily
user, self-explaining for someone who has never seen it.

Additional accounts exist in production (`andrew_smokeci`, `franko`); the store
is genuinely per-user and multi-tenant.

## Product Purpose

Basil is an agentic chief of staff. It ingests the user's real working channels —
Gmail, Slack, Google Calendar, Zoom, Microsoft Teams, Outlook, Linear — and turns
that raw traffic into durable, reviewable records: actions, decisions, memory and
signals, plus a daily briefing.

Success is that the user can trust it: what Basil says is outstanding really is
outstanding, and what it says is handled really is handled. Its failures are
therefore not crashes but quiet wrongness — nagging about settled work, or
staying silent about something real.

## Positioning

Confirmed 2026-08-03: Basil does **four jobs at once**, and the combination is the
product. Any one of them alone is a category that already exists.

1. **Completeness** — watches every channel so no commitment, reply or follow-up
   is lost.
2. **Triage** — reads all of it and ranks the few things that need the user now.
3. **Relational memory** — who is owed, who has gone quiet, what was said, what
   they care about.
4. **Execution** — drafts, schedules, replies and closes loops, subject to
   approval.

The design consequence is explicit: the interface cannot be organised around a
single one of these without demoting the other three.

## Operating Context

- **Unattended by default.** Scheduled jobs do the work whether or not the user
  opens the app: `poll-ingest` daily 05:45 UTC, `reprocess` 06:00, briefing
  generation 06:15, `slack-sync` hourly, backup 02:30, subscription renewal 03:00.
  The user often meets Basil's output before ever opening a screen — via the
  morning briefing email or a Slack DM.
- **Both phone and desktop**, as an installed PWA.
- **Approval-gated actions.** Scheduling and sending run through an explicit
  approve step, not silent execution.
- **Evidence-linked records.** Actions, decisions and memory carry a `sourceRef`
  back to the originating message, thread or meeting.

## Capabilities and Constraints

- **The vocabulary is load-bearing (confirmed binding).** *Action*, *Decision*,
  *Memory*, *Signal*, *Briefing* name real stores, API routes and data-model
  types. The UI must keep these words; renaming in the interface would fork the
  product's language from its code.
- **Screens must render from stored data (confirmed binding).** No design may
  trigger model calls to display a view. A hard ceiling of $1/day per user is
  enforced in `lib/ai/spend-guard.ts`, and view-time generation would both breach
  it and make the UI fail when the cap or the provider does.
- **Tiered model use.** Classification runs on the cheap tier; only
  user-facing prose (briefings, chat) uses the flagship tier.
- **AI can be unavailable.** Provider outages and a reached spend cap are normal
  operating states, not exceptions — surfaces must degrade honestly rather than
  render failure as emptiness.
- **Surface inventory is NOT frozen.** The user explicitly declined to require
  that every current page survives, so Home, Contacts, Actions, Decisions, Chat,
  Projects, Learning and Settings may be restructured or consolidated.

## Brand Commitments

The product name is **Basil**. No other identity constraint was made binding; the
incumbent look is evidence for the redesign, not a commitment.

## Evidence on Hand

Real production data, not fixtures: live contacts with real employers, genuine
Zoom meeting recaps, real Slack threads and Gmail traffic, and a spend log of
actual per-call costs. Screenshots of the running product exist in this session.

`lib/contacts-data.ts` holds **fictional sample contacts** and is gated off from
real use — it must never be presented as real customer evidence.

There are no testimonials, case studies, benchmarks, press or named customers.
Future work must not fabricate any.

## Product Principles

1. **Trust is the product.** A wrong record costs more than a missing one,
   because the user has to notice it to correct it.
2. **Never nag about settled work.** Basil sees obligations arrive far more
   easily than it sees them resolved; a list that is wrong is a list the user
   stops reading.
3. **Show provenance.** Every claim traces to the message, thread or meeting it
   came from.
4. **Degrade honestly.** An outage, an empty result and a spend cap are three
   different states and must never render identically.
5. **Cheap to look at.** Attention is the interaction; viewing must not cost
   money.

## Accessibility & Inclusion

No formal standard has been established as binding. An ARIA pass was completed
previously, and keyboard operability exists on the calendar. WCAG 2.1 AA is the
sensible target for a commercial launch but is recorded here as an **open
decision**, not a confirmed requirement.
