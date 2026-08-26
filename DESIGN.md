# Basil — the executive desk

Basil's visual world. Dark navy ground, warm white ink, gold accent. Replaces
the Wire Desk paper world (2026-08-03 → 2026-08-26), which is retained below
only as anti-reference.

Mode: **Operate** — the reader is completing a task, so scanability, consistency
and the real usage scene outrank expression. Brand lives in precise details.

---

## Thesis

Basil is a chief of staff reporting in. The first screen answers what changed,
what matters most, and what to do now — then hands over the day, the channels,
and the people, each with a route into it.

Every number on this surface is counted from a stored record and links to the
thing it counts. A figure you cannot click is decoration; a figure Basil
narrates about itself is a claim it has not earned.

## Palette

Ground is navy, not black: black makes gold read as yellow, and warm white on
true black halates enough to tire a reader who is here every morning.

| Token | Value | Role |
| --- | --- | --- |
| `--w-paper` | `#0E1724` | canvas |
| `--w-flimsy` | `#18222F` | raised — cards, sheets, the hero |
| `--w-tray` | `#131C2A` | sunk — archived, deferred |
| `--w-ink` | `#F4F1EA` | primary ink, warm |
| `--w-ink-soft` | `#A9B4C4` | secondary, ≥4.5:1 on canvas |
| `--w-carbon` | `#C8A96B` | **the accent** — gold |
| `--w-on-accent` | `#0E1724` | text ON gold |
| `--w-stamp` | `#FF8A80` | danger — Act now, corrections |
| `--w-manila` | `#FF8A3D` | warning — deferred, at risk |
| `--w-filed` | `#6EE7A0` | success — settled, closed |
| `--w-info` | `#7FB4FF` | information, distinct from the accent |

**Gold is reserved.** It marks where the system is speaking: section headers,
sourcing, primary controls, the wordmark. Used decoratively it stops meaning
anything, which is the only way a single accent can fail.

**Gold is a LIGHT colour.** Anything filling with `--w-carbon` takes its text
from `--w-on-accent`. White on gold is ~1.7:1. A test fails the build on any
hardcoded white over the accent, so this survives the next palette change.

## Rules that outrank aesthetics

**An outage is not an empty desk.** Every panel branches error → loading →
empty → content, in that order. `Unavailable` and `Empty` are separate
components on purpose: "nothing needs you" and "Basil cannot see whether
anything needs you" are the same empty array and opposite facts.

**Zero is not unknown.** A stat tile with no readable source shows an em-dash and
the reason, never `0`. The largest type on the page is the worst place to lie.

**Nothing is scored that has no field.** No relationship importance, no
confidence the feed does not carry, no conflict detection that does not exist.
Where a question cannot be answered from stored data, the surface says so.

**Colour never carries status alone.** Every state is colour *and* icon *and*
word — and that redundancy is load-bearing, not belt-and-braces. Under
deuteranopia gold and red collapse toward the same yellow whatever hues you
pick; that is a property of the deficiency, not a fixable palette flaw. Hue is
the fast path for most readers, never the only path for any.

**States are checked against each other, not just the background.** A colour can
clear 7:1 on the canvas and still be useless if it looks like another state. The
first warning here, `#F5B96B`, was ΔE 17.4 from the gold accent — same hue
family, separated only by lightness — so "Basil is speaking" and "this is at
risk" read alike while every contrast test passed. `#FF8A3D` is ΔE 42.4 apart,
27.2 under deuteranopia, and takes the set to zero confusable pairs.
`tests/palette-separation.test.mjs` holds that, plus WCAG 1.4.11 non-text
contrast for icons, bars and rules.

## Type

- **Fraunces / Instrument Serif** (`basil-display`) — the greeting only. One
  editorial moment per page; a serif in six places is decoration.
- **Geist Sans** — everything else: navigation, body, controls.
- **Courier Prime** (`wire-data`) — data only: times, counts, durations, ids.
  Monospace for measurement, never as a costume for "technical".

## Structure

- `--w-radius: 10px` — this world is panelled.
- Hero → five counts → priorities beside the day → four channel panels →
  pressure → watchlist.
- Mobile reorders: read, single most important action, **then the schedule**,
  then the rest. Nobody scrolls an alert queue to find their first meeting.
- The botanical mark sits behind the hero at 0.07 opacity, aria-hidden, never
  under body copy — contrast is audited against the canvas, so anything altering
  the effective ground under text would invalidate the audit.

## Refused

Kept from the previous world because the reasoning still holds:

| Refused | Why |
| --- | --- |
| Kicker / eyebrow above a heading | The reference had "GOOD MORNING" over "Michael." The heading carries itself; the greeting became the heading. |
| Thick coloured left border | The clearest tell of machine-made UI. Urgency is already colour + icon + word. |
| Donut / progress ring for signal | A ring answers "what share of the whole", which nobody asks about their own inbox. Bars answer "how much, from where". |
| Confidence as a 6px dot | The number lived in a `title` — invisible on touch and to a screen reader. |
| A stat that is not a link | Then it is decoration. |

## Accepted against default

The **hero-metric row** is a category default the craft floor refuses. It is
here because the owner pinned it, and it earns its place on two conditions:
every figure is counted from a store, and every figure links to what it counts.

## Open

1. **Never seen with real data.** Verified against contract-shaped fixtures in
   `/dev-harness/today`; the authenticated app has not been reviewed.
2. **Motion is unauthored.** No entrance, no transition beyond hover. The craft
   floor asks for one authored moment; this world has none yet.
3. **The seven flow pages** inherited the palette but were not recomposed.
