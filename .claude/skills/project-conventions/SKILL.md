---
name: project-conventions
description: Basil's non-obvious invariants — theming, Tailwind arbitrary values, origins, spend guard, persistence, multi-tenancy. Read before editing styles, API routes, or AI call sites.
user-invocable: false
---

# Basil conventions

Every rule here cost a production incident. They are not style preferences.

## Theming — the `.wire` layer

`.wire` is a scoped token layer nested inside `.dark` (`forcedTheme="dark"`).

**A theme scope must restate its entire inherited semantic surface, not just the tokens it means to change.** `.basil-card` paints `background-color: var(--surface-1)`, and `.dark .basil-card` only adds a box-shadow — it never touches the background. When `.wire` flipped from light paper to dark navy without remapping `--surface-*`, every card in the app painted cream `#fafaf8` under near-white text. Meetings, Projects, Memory, Decisions, Briefing and Slack Command were all unreadable.

When you change a ground colour, enumerate every `--surface-*`, `--gold*`, and `--chart-*` token and confirm each still composes. See [app/wire.css](../../../app/wire.css).

## Tailwind arbitrary values

- **`text-[var(--x)]` emits no CSS at all.** Tailwind cannot tell a colour from a length. Always `text-[color:var(--x)]`. 196 usages across 46 files once silently emitted nothing; the accent colour had never rendered where a class set it.
- **No stray `)]]`.** Fifteen malformed values across eight files generated no CSS; fills rendered as nothing.

Both are enforced by [tests/wire-class-hygiene.test.mjs](../../../tests/wire-class-hygiene.test.mjs).

**Never conclude a colour is correct by reading the token table or looking at a screenshot.** Screenshot compression made near-white read as tan for an entire afternoon. Check the computed value.

## Origins — never build a URL by hand

[lib/http/origin.ts](../../../lib/http/origin.ts):

- `selfOrigin()` — for the app calling **itself** (cron, poll-ingest). Prefers `VERCEL_URL`.
- `publicOrigin()` — for links a **human or OAuth provider** will follow. Prefers `APP_URL`, which must match the registered redirect URIs.

Using the wrong one caused a **week-long silent ingest outage**: `poll-ingest` self-called a stale `APP_URL` pointing at a different Vercel project, got a 404 for every user, and reported `ok: true`.

## Spend guard

[lib/ai/spend-guard.ts](../../../lib/ai/spend-guard.ts). `reserveSpend()` → `commitSpend()` or `releaseSpend()`.

**A reservation is a ceiling, not an estimate.** Enforce it through the AI SDK `stopWhen` array. Return refusals via `spendCapResponse()` — never hand-roll the message; eight divergent versions existed before it was unified.

## Persistence

Vercel Blob via `readStore` / `writeStore` in [lib/storage/persistent.ts](../../../lib/storage/persistent.ts). `process.env.BASIL_DATA` is the legacy layer and is guarded against outside `lib/storage/`. `/tmp` is an L1 cache only — never the source of truth.

**Read-modify-write on a blob needs a lock or a merge.** `appendTrace` in `core/dispatch/dispatcher.ts` still does fire-and-forget read-modify-write and loses telemetry under concurrency. Do not copy that pattern.

## Multi-tenancy

Per-user, keyed by username. **No hardcoded username comparisons** — use `process.env.PRIMARY_OWNER_USERNAME`. Enforced by `npm run ci:guards`.

Every store function takes `username` as its first argument. There is no global "the user".

## Next.js

This is Next.js 16. The request interception file is **`proxy.ts`**, not `middleware.ts`. Read `node_modules/next/dist/docs/` rather than relying on training data.

## Identity

Basil's only address is `michael@talentgenius.io`. Never substitute a personal Gmail account, in code, config, env vars, or test fixtures.

## CI escape hatch

The only recognised suppression token is `// ci-ok: <reason>` (also `fire-and-forget`, `dedup handles`, `ci:skip`). An invented token like `basil-ci-allow-silent-catch` silently fails the guard — it did so for six weeks. See [scripts/ci-guards.mjs:130](../../../scripts/ci-guards.mjs).
