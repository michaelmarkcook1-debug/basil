# Basil visual system (2026-10-14, approved by Michael)

Cream canvas, navy chrome, gold marks, live data graphics. The reference
implementation is the Today page (`app/dashboard/page.tsx`, `components/today/v2/*`)
and People (`components/contacts/drift-strip.tsx`, `conversation-shape.tsx`).
Read those before changing a page.

## Colour (tokens in `app/wire.css`; every page sits inside `.wire`)

| Role | Use |
|---|---|
| `var(--w-paper)` #F6F1E7 | page ground (cream) |
| `var(--w-flimsy)` #FFFDF8 | cards |
| `var(--w-tray)` #EFE7D6 | sunk / track / empty fills |
| `var(--w-rule)`, `var(--w-rule-strong)` | borders |
| `var(--w-ink)` #14213A | text |
| `var(--w-ink-soft)` #4B5568 | secondary text (never fade it further with /opacity) |
| `var(--w-carbon)` #5E4A1F | bronze accent: links, small accent text on cream |
| `#10213F` | navy: primary buttons (text `#F6F1E7`), dark feature panels, page titles |
| `#C8A96B` / `#D4B978` | brand gold: fills, rings, the title full stop, and anything ON navy. Never gold text on cream (2:1) |
| `var(--w-stamp)` / `var(--w-manila)` / `var(--w-filed)` / `var(--w-info)` | danger / warning / success / info text |

Chart colours (validated for colour-blind separation — use exactly these):
- three-state: `#1F8A70` (good/steady/moving), `#2F5FA8` (info/warmer/waiting), `#D9661F` (risk/cooler/blocked); quiet = dashed `#8A8F99` ring
- channels: email `#5865C2`, Slack `#0E9E8A`, meetings `#BE7A2A`
- sequential (more = darker): `#A9B4CC #8392B4 #5C6E98 #384D7B #1B2E56`; zero = empty cell with a `var(--w-rule)` border
- on navy panels: meetings `#6C7FA3`, free/positive `#D4B978`

## Type
- Page title: `PageHero` (`components/basil/page-hero.tsx`) — mono eyebrow, Instrument Serif title + gold full stop.
- Section titles: `basil-serif text-[26px] text-[#10213F]` (or `SectionCard`).
- Times, counts, ids: `basil-mono`.
- Prose Basil wrote (a read, a summary): `basil-serif` at 20–24px reads beautifully; UI copy stays Geist.

## Shape and motion (utilities in `app/wire.css`)
- Cards: `rounded-[20px] border border-[var(--w-rule)] bg-[var(--w-flimsy)] p-5` — or `SectionCard`.
- `basil-rise` + staggered `style={{ animationDelay: "120ms" }}` for the load reveal (60–80ms apart).
- `basil-lift` on cards/rows that are themselves clickable (lift + gold border on hover).
- `basil-grow` (bars from the left), `basil-col` (columns from the bottom), `basil-ping` (live dot), `basil-pop`.
- Buttons: `BTN_PRIMARY` (navy) and `BTN_SECONDARY` (outlined cream) from `page-hero.tsx`; ≥44px tall.
- All motion is disabled under prefers-reduced-motion by the utilities themselves.

## Graphics
A graphic earns its place when it shows something faster than words: load over
time, what's overdue vs due, who owes what, how a day is shaped. Draw it from
data the page ALREADY has — never invent numbers, never add a fetch that can
trigger AI. Every graphic: a text label for each state (never colour alone), a
legend when there are ≥2 series, hover/focus detail where it helps, real
`<button>`s for interactive marks with `aria-label`s.

## Never
- Left-border accent stripes on cards, emoji, rainbow palettes, gradient washes
  (a faint gold radial glow is the one exception).
- `text-white` on the accent, faded text (`text-muted-foreground/60`), or a
  translucent background behind text — `tests/app-contrast.test.mjs` composites
  translucent fills over the cream ground and fails anything under 4.5:1.
- Changing what a page does: data fetching, API calls, handlers and state stay
  as they are. This is presentation, plus graphics from existing data.

## Checks
`npx tsc --noEmit -p .`, `npx eslint <files>`, and any test that reads the file
(`grep -rl "<path>" tests`). The whole-app contrast test needs a production
build (`npm run build`), which the lead runs once at the end.
