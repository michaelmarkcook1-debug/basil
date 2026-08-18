# The Wire Desk

Basil's visual world. Direction locked 2026-08-03, seed key `basil01`, index 3
of the grounded shortlist. Built and shipped 2026-08-15.

This document exists so the next person to touch these surfaces changes them on
purpose. It records what each mark **means**, not just what it looks like — the
palette is a small vocabulary of states, and a mark used decoratively costs the
reader the ability to trust it anywhere.

---

## Thesis

Basil is a desk editor handing you the queue with its sourcing intact.

The reader sees what came in, from which wire, when it was filed, and how sure
Basil is — then works it down and spikes the rest. Everything else is in
service of that sentence.

## What this world refuses

Refusals are the design. Each of these was the default the surface drifted
toward, and each was removed for a stated reason:

| Refused | Why |
| --- | --- |
| Greeting header ("Good morning, Michael") | Costs a first viewport to tell the reader something they know. The dateline says where and when instead. |
| Hero metric row / KPI stats | Numbers with no action attached. The queue length is visible by looking at the queue. |
| Donut and proportional timelines | Block height encoded duration, which is not what the reader needs. Filed copy, in time order. |
| A stack of cards | Cards imply independent objects. These are dispatches on one desk; they share one rule. |
| Corner chat bubble | An assistant persona pretending to be a colleague. Ask Basil is a page. |
| Confidence as a 6px dot | The number lived in a `title` attribute — invisible on touch, unreadable to a screen reader. Now a legible stamp: `unconfirmed 42%`. |

## Ground: why light

Chosen from the **use scene**, not from category. The desk is read at 06:40 in a
lit kitchen and between meetings in daylight. The morning briefing already
reached the reader by email at 06:15; this surface is where they come to work
the queue down, awake and in the light.

Teleprinter paper is cool and slightly green (`#E9EAE4`), not warm cream —
cream plus a serif plus terracotta is the look every model ships, and it reads
as a template rather than a place.

**Status: this is the one unreviewed bet in the world.** No comp was approved
before the build (`.impeccable/mocks/` was never created), so the light ground
went from decision straight to production without ever being seen. It is the
first thing to revisit.

## Palette — every colour is a state

Scoped under `.wire` rather than `:root` so unconverted surfaces keep working.
Delete the scope when the last one lands.

**Stock**
- `--w-paper` `#E9EAE4` — the ground
- `--w-flimsy` `#F4F4EF` — a fresh sheet, raised
- `--w-tray` `#DCDDD4` — spike and deferred trays, sunk
- `--w-rule` / `--w-rule-strong` — the rules that separate dispatches

**Ink**
- `--w-ink` `#17170F` — typebar strike
- `--w-ink-soft` `#55564A` — secondary, still ≥4.5:1 on paper

**The four marks.** Each has one meaning and no decorative use:
- `--w-carbon` `#35346B` — carbon copy: structure, attribution, which wire
- `--w-stamp` `#A82D1A` — FLASH, corrections, kills. **Reserved.** Spending
  stamp red on an ordinary row is what makes a real alert stop working.
- `--w-manila` `#6E4C15` — spiked, deferred, awaiting
- `--w-filed` `#2A5233` — confirmed, settled, filed

Tints (`*-tint`, 8% alpha) are for fills only. Text always uses the solid ink so
contrast holds.

**Paper tokens are for the paper world.** The dashboard shell is dark chrome
under the forced dark theme; `--w-carbon` on `--sidebar` is 1.65:1. That shipped
once. `tests/wire-class-hygiene.test.mjs` now fails the build if the shell
paints itself with paper tokens again.

## Type

- **Archivo Narrow** — condensed news gothic. Slugs, prefixes, decks.
- **Courier Prime** — the teleprinter. Carries **data only**: filed times, wire
  ids, sequence numbers, confidence values.

Monospace as a costume for "technical" is a tell. Monospace for measurement is
what it is for. If a string is not a measurement, it is not Courier.

Both self-host via `next/font`; no webfont request.

## Structure

- Rows share one continuous rule. Never a stack of cards.
- `--w-radius: 3px` — paper is cut, not rounded.
- A dispatch is: prefix · slug · wire · time filed · sourcing stamp.
- The spike sits at the foot: what Basil set aside, always pullable back.

## The rule that outranks aesthetics

**An outage is not an empty desk, and neither is a page still loading.**

Every sheet branches error → loading → empty → content, in that order. A failed
fetch says the wire is down and offers a retry; it never renders as "nothing
needs you". This is pinned by test, and the test asserts the ordering invariant
rather than any one spelling of it, so the guard survives a refactor.

## Open

1. **The light ground has never been reviewed.** Highest priority.
2. **The shell was not redesigned.** The sidebar and mobile bar are still the
   incumbent dark chrome. Legible now, but not this world — a dark frame around
   a paper desk is a decision nobody has actually made.
3. **Confidence is absent from the today feed.** `Dispatch` deliberately does
   not invent a number the feed does not carry; it shows sourcing (observed vs
   inferred) instead. When the feed carries confidence, the stamp is ready.
4. The finish-review pass was run against source and emitted CSS, not against
   screenshots of the authenticated app.
