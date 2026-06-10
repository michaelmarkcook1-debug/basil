# Basil — Production-Readiness Audit & Redesign Plan

_Generated 10 June 2026 by a six-dimension multi-agent audit (backend, persistence, design system, UX journey, polish, security) plus a hands-on walkthrough of the running app._

## Verdict

Basil is an impressive solo build with genuine production-grade craft in spots — the chat spend lifecycle, webhook HMAC verification, tenant isolation, and AES-encrypted tokens would pass review at a serious company — but it is not ready to charge money. The flagship promise is literally broken: the briefing cron resolves every user to the admin, so paying customers never receive the morning brief that defines the product, while the admin's regenerates N times at N-fold AI cost. The storage layer can silently and permanently destroy customer data (cross-instance clobbering, read-errors coerced to empty-then-overwritten, zero backups), and forgot-password hands out live reset tokens — a pre-auth account takeover. Beyond the blockers, the product contradicts its own pitch: intelligence is pull-only across ~20 fragmented pages, day-0 is dead air for up to 18 hours, and the differentiating personality layer is buried three taps deep. The good news: the bones are right and the brand already exists in the auth shell. This is 8-10 weeks of ruthless consolidation, not a rebuild. Gate revenue on Phases 0-2; ship the redesign in Phases 3-5.

## Scorecard

| Grade | Dimension | Summary |
|---|---|---|
| **C** | Backend | Pockets of production-grade craft (chat spend lifecycle, webhook HMAC, idempotency) undermined by a broken briefing cron, a pervasive silent-failure posture, and zero runtime validation across ~120 routes. |
| **D** | Persistence | Whole-file JSON on Blob with per-instance caches, in-process locks, and no backups — silent, unrecoverable customer data loss is a when, not an if, under normal Vercel concurrency. |
| **C** | Design system | A genuinely good token system the product ignores: 538 raw color literals, three competing golds, dead primitives with zero imports, and light-mode pastels shipping on a dark-default app. |
| **C** | UX journey | A real command center exists, but intelligence is pull-only, day-0 is empty until tomorrow's cron, six surfaces re-render one signal store, and the differentiator is buried three levels deep. |
| **C** | Polish | Commercial on the desktop dark happy path; Schedule is unusable on mobile, faded text fails WCAG, most API errors die in the console, and all 19 pages are client monoliths. |
| **C** | Security & auth | Tenant isolation and token encryption are solid, but a reset-token leak in the HTTP response and a hardcoded default admin password are takeover-grade holes. |
| **C-** | Overall | Strong bones, broken promise: fix the cron identity, the data substrate, and the two auth holes, then consolidate 20 pages into 6 surfaces behind the midnight+gold identity that already exists. |

## Blockers — must fix before charging money

- Cron identity bug — the product promise is broken: /api/cron/generate-briefing and /api/events/reprocess resolve every CRON_SECRET call to the admin user, so non-admin customers never get a morning briefing while the admin's regenerates N times at N-fold AI spend. Copy the x-basil-username header pattern poll-ingest already uses (app/api/cron/generate-briefing/route.ts, app/api/generate/briefing/route.ts, app/api/events/reprocess/route.ts), and add an integration test asserting every user gets their own briefing cache entry.
- Data-wipe pathway: blobReadJson coerces ANY read failure (network blip, Blob 5xx, corrupt JSON) to the empty-array fallback, and the next strong write durably persists the wipe of a user's entire action/memory/contact history. Distinguish missing-vs-error in lib/storage/adapters/blob.ts, abort read-modify-write on read errors, and add a shrink tripwire refusing writes that collapse a store to near-zero.
- No backups, versioning, or export — every clobber is permanent and the first 'my tasks disappeared' ticket has no remediation path. Ship a daily snapshot cron copying basil/users/** to a timestamped prefix with retention, plus a per-user JSON export, before taking a dollar.
- Cross-instance clobbering: per-instance /tmp cache with no TTL + in-process promise-chain 'locks' + last-write-wins whole-file JSON means done actions resurrect and new contacts vanish whenever a cron overlaps an interactive request. The unlocked global secure-users.json is worst: two concurrent signups and the second erases the first account. Interim: CAS versioning + Upstash locks + fresh re-reads inside locks; real fix: Phase 1 migration of accounts, entitlements, and mutable collections to Postgres/Redis.
- Pre-auth account takeover: /api/auth/forgot-password unconditionally returns the live reset URL in the JSON response (route.ts:120-124) — anyone who knows a target's email can reset their password, including the admin's. Remove resetUrl from the response entirely; rely on the emailed link.
- Hardcoded default admin credentials: lib/users.ts:71 falls back to admin/execauto2024 with no production guard — a misconfigured deploy ships a publicly-known admin login. Throw at boot in production when APP_PASSWORD/ADMIN_USERNAME are unset, mirroring the AUTH_SECRET guard, and delete the literal.
- Day-0 dead air: onboarding ends on an empty dashboard until the next 05:45 UTC cron — up to ~18 hours to first value, with empty states telling users the setup they just completed didn't work. Fire a 7-14 day backfill on OAuth callback, auto-generate the first brief on completion, and show sync-progress copy ('Connected — first sync in progress, ~3 min').
- Theme integrity on the default path: ~500 light-only pastel utilities (bg-amber-50, bg-red-50, border-emerald-300...) across 33 files render visibly broken on the dark-default theme — including Settings, the first page every new user visits, and the chat error panel. Sweep them to the existing --signal-* tokens and add a CI grep banning stock palette classes in app/dashboard.

## High priority

- Deliver the brief: a morning email rendered from the already-cached briefing JSON (the generation cost is already paid) plus a Slack DM, with per-channel toggles in Settings. The product is pull-only end to end today, which inverts the 'zero added workload' pitch and caps retention.
- Kill the silent-failure posture in ingestion: replace the six .catch(() => []) source fetches in poll-ingest with a per-source error map surfaced in health-meta (token expiry currently looks like a quiet inbox); advance the Gmail webhook historyId only on 404 HISTORY_NOT_FOUND (any error currently skips mail permanently); add per-item try/catch + finally forceFlushSnapshot to the email/Zoom loops; dead-letter Slack/Zoom processing failures before returning 200.
- Fail closed on Gmail/Calendar webhooks: when GMAIL_PUBSUB_TOKEN / CALENDAR_WATCH_TOKEN are unset, any unauthenticated POST is currently accepted. Reject when unconfigured and move to Google-signed OIDC verification for Pub/Sub.
- Add an OAuth CSRF state parameter across Google/Microsoft/Zoom/Slack/Linear — current flows allow an attacker to silently link their account to a victim's Basil session via login CSRF.
- Session hygiene: move login/register/forgot/reset to checkRateLimitDurable (the in-memory limiter is per-instance and IP-spoofable) and bump sessionVersion on logout — a captured 30-day token currently survives 'log out'.
- Protect the money trail: route queued Blob writes through waitUntil() and upgrade lib/ai/spend-log.ts to strong durability — the documented 'recoverable source of truth' for AI spend can vanish on instance recycle. Treat Upstash Redis as a required production dependency.
- Runtime validation + one error contract: a shared parseBody(req, zodSchema) helper on every mutation route (there is zero zod on ~120 routes today), one {error, code} envelope, and consistent 401/403 semantics so the client can have a single error handler.
- Observability floor: Sentry with user context, request IDs echoed in logs and errors, and an alert channel when any cron per-user result is ok:false — 'my briefing was missing this morning' is currently answerable only by scrolling Vercel logs.
- Scale the crons before they fall over: fan out briefing/poll-ingest via the existing QStash infrastructure (one job per user — the sequential loop will 504 around 4-8 users) and regenerate-before-delete so a failure preserves yesterday's brief instead of leaving nothing.
- Apply the chat hardening to /api/chat/mobile: it lacks the 200KB body cap and 30/min durable rate limit its web sibling has — lift the code verbatim from app/api/chat/route.ts.
- One gold: collapse the three-plus competing gold values and 538 raw oklch literals to a single --gold token registered in @theme, and tokenize app/dashboard/page.tsx (200 hardcoded hex, zero theme-token classes on the flagship page).
- Mobile + accessibility floor: fix Schedule's zero-breakpoint layout (a primary bottom-nav tab unusable at 390px), enforce a /60 opacity contrast floor for readable text, replace the hand-rolled PanelModal with the Radix Dialog already shipped, sweep icon-only buttons for aria-labels, mount one global toast (sonner), and fix app/error.tsx rendering nested <html> during crashes.

---

# The Redesign

## Diagnosis

Basil is organized around its data types — twenty routes for events, signals, actions, decisions, digests, and deltas — instead of around the executive's day, so the user must assemble the picture themselves across six overlapping views of the same signal store while the intelligence never comes to them. The differentiator (personality and influence) is buried as the second tab of a contact detail inside the Relationships page, and every act-on-it moment forces a context switch into chat. The fix is not new features: it is ruthless consolidation around one morning artifact, chat as an ambient companion, and influence intelligence surfaced at every point of action.

## New information architecture — 6 surfaces + 1 overlay

### Today

The daily brief AS the home screen: masthead lede, what changed since you last looked, schedule with prep chips, and the needs-you queue. The whole morning in 90 seconds.

_Absorbs: dashboard home (app/dashboard/page.tsx), briefing page, delta — becomes the 'What changed' strip, digest — becomes the Weekly tab / Sunday edition, home 'Basil Intelligence' panel_

### Signals

A triage queue where every thread is handled in place: inline draft/summarize results in a slide-over (the chat API already supports tool approval), one-tap done/snooze/make-action, and approach chips on senders.

_Absorbs: signals page, slack-command — its reply_needed/blocker/decision_pending types become Signals filters, the five canned-prompt chat detours_

### Meetings

Meeting intelligence: calendar and agenda with the gold now-rail, plus prep dossiers featuring per-attendee personality profiles — 'brief me before this meeting' as a first-class flow.

_Absorbs: schedule page, meetings list, meeting-prep detail (meetings/[eventId])_

### People

The relationship and influence layer promoted to top-level nav: personality, what-makes-them-tick, watch-outs, and server-side relationship health (lib/relationship/score) replacing the client-side heuristic.

_Absorbs: contacts page, home relationship trends panel, the buried Personality tab — promoted to the top of each person page_

### Commitments

Everything owed and decided: actions, decisions, waiting-on-others — with projects and Linear as tabs/panels rather than standalone routes.

_Absorbs: actions page, decisions page, projects, ai-projects, linear (the 1,627-line page becomes a panel + command-palette entry)_

### Memory

Basil's durable knowledge of the user's world — searchable, editable, and visibly the thing that makes every brief smarter.

_Absorbs: memory page, chat-saved notes_

### Ask Basil (overlay, not a destination)

Persistent companion rather than a page: a docked input bar on desktop, FAB on mobile, opening a slide-over that keeps page context and renders tool results (drafts, summaries, actions) inline where the need arose.

_Absorbs: chat page (route survives only as the overlay's deep-link target), signal action prompts_

## Kill or demote

- /dashboard/trust → behind the isAdmin gate (it is a design-system showcase with mock data living in user URL space)
- /dashboard/whatsapp → fold into Settings > Integrations (it is QR pairing and connection management, not a feature)
- /dashboard/slack-command → delete; its signal types become Signals filters
- /dashboard/digest → delete route after folding into Today's Weekly tab
- /dashboard/delta → delete route after folding into Today's 'What changed' strip
- /dashboard/projects and /dashboard/ai-projects → delete (orphaned; reachable only via dead components) or fold as a Commitments tab
- /dashboard/linear → demote from dedicated 1,627-line page to a Commitments panel + palette entry
- app/dashboard/components/ (19 unimported files from the previous home page) → delete wholesale
- /dashboard/chat → remove from primary nav; chat becomes the overlay
- Light theme → cut for v1: remove the toggle and the stone+teal token fork (a brand never shown in the auth shell); dark-only until a light identity is actually designed

## The 'Today' home screen

'Today' replaces the dashboard home and IS the daily brief. Top to bottom: (1) Compressed masthead, ~120px down from ~300px — the light-rays atmosphere becomes a low-opacity background wash; a Fraunces italic dateline ('Tuesday Edition — 10 June') and a small greeting sit left; the right side carries the day's lede, one sentence drawn from briefing.criticalToday ('Your 10:00 with Acme needs prep — 2 attendees you haven't met') with a gold CTA. (2) 'Since you last looked' strip: Delta's severity-bucketed change feed rendered as 3-5 dismissible chips. (3) The command grid — three columns on desktop, stacked on mobile. Left: The Brief, all sections re-mapped from the rainbow palette onto the four signal tokens, every line deep-linked to its entity (action, meeting, person) instead of plain text, with a Weekly tab absorbing Digest. Center: today's schedule with the 2px gold 'now' rail and per-meeting Prep chips showing attendee count and a personality hint. Right: the Needs-You queue with five mutually exclusive, decision-oriented metrics — Needs reply today, Meetings to prep, Overdue, Waiting on others, and a true Risks count (contradiction and at-risk-relationship signals only, ending the 'Risks: 35' cry-wolf) — each opening a filtered Signals or Commitments view. (4) People in motion: three or four relationship cards from the server-side score, each with an approach chip linking to the person's Personality view. Persistent throughout: the Ask Basil bar docked bottom-center (gold-ring input on desktop, FAB on mobile) opening a slide-over that keeps page context and renders tool results inline. On day-0 this same page becomes the onboarding surface: a sync-progress card ('Connected — first sync in progress, ~3 min'), backfill status, and first-brief generation state — never 'connect your accounts' shown to someone who just did.

## Design language

**Direction:** 'The private intelligence bureau' — extend the auth shell's midnight+gold language into every product surface: deep midnight fields, warm ivory text, one disciplined gold that always means 'now / act', Fraunces serif reserved for identity moments (mastheads, briefing headlines), and color used only for meaning via a four-signal palette. Calm, dense, confident — a daily edition prepared overnight by a discreet staff, not a SaaS dashboard.

### Tokens

- Color: --background #07111F; the existing four-level surface scale (#0B1828 → #0F1D36 → #142440 → #1A2D4F) actually enforced; text #F3EFE7 warm ivory; --muted-foreground #C6CEDB with a hard floor of /60 opacity for anything readable (/30-/50 reserved for separators and disabled states only).
- Accent: exactly one gold — --gold #C8A96B registered in @theme so bg-gold/text-gold/ring-gold utilities exist; codemod all 538 oklch(0.72 0.15 85) literals and the sidebar's 20 hardcoded hexes to it; delete the #c17d2a and #D4A845/#F0CB70 forks. Gold is semantic (now, active, primary CTA), never decorative.
- Signals: four tokens only — --signal-critical (the desaturated coral #D96C5F family), --signal-warning (amber), --signal-positive (emerald), --signal-info (slate blue) — each with -subtle/-border/-fg variants; violet and teal eliminated; briefing sections, status pills, and all pastel utilities re-mapped onto these.
- Type: Fraunces at weight 400 for basil-display only (page titles via one PageHeader component, masthead, briefing headlines); sans body at the existing fluid 16-18px; data scale of basil-data 13px and basil-caption 11px as the absolute floor — all fourteen ad-hoc pixel sizes (8px, 9px, 9.5px, 10.5px, 11.5px...) deleted; remove the global h1 font-family override and the never-rendered Instrument Serif font load.
- Space, shape, elevation, motion: 4px grid; radii 8 (chips) / 12 (cards) / 16 (overlays); cards are midnight glass — surface token plus a 1px rgba(243,239,231,0.06) hairline, near-zero shadows, gold glow reserved for active/primary; one PageShell using basil-content-lg (~1100px) with px-6 lg:px-8 on every route; motion at the existing 180/280ms tokens with basil-pulse 2.2s skeletons and prefers-reduced-motion honored. Dark-only for v1.

### Signature elements

- The gold thread — a 2px gold rail that always means 'now': the live time indicator on the schedule, the active nav item, and the day's critical item in the brief. Gold appears nowhere else, so the eye learns to follow it.
- The masthead — a Fraunces italic edition header ('Tuesday Edition — 10 June') with a one-line lede, rendered identically on the Today screen, the morning email, and the Slack DM, so the brief is recognizably Basil in every channel.
- Dossier cards — midnight glass cards with the ivory hairline; any card carrying personality intelligence gets a small gold corner tick, quietly signaling 'Basil knows this person.'
- Approach chips — compact influence hints ('Direct — lead with the number', 'Needs context — share the why first') beside any person's name in signals, meeting prep, the brief, and the draft-email flow; the differentiator made ambient rather than buried.
- Signal underglow — severity expressed as a soft left-edge tint from the four-signal palette on rows and cards, replacing pastel badge soup; a page reads as a calm midnight field with a few warm warnings, never a rainbow.

## Phased plan

### Phase 0 — Stop the bleeding

**Effort / unblocks:** S-M (~1-2 weeks). Unblocks: safe to put real users on the product without losing their data, their accounts, or their briefings.

Cron identity fix (x-basil-username header honored by briefing POST/DELETE and events/reprocess); remove resetUrl from forgot-password; APP_PASSWORD/ADMIN_USERNAME production boot guard; fail-closed Gmail/Calendar webhooks; blobReadJson missing-vs-error split + shrink tripwire; daily snapshot backup cron + per-user export endpoint; write-then-swap briefing regeneration; day-0 backfill trigger on OAuth callback with sync-progress copy.

### Phase 1 — Real persistence

**Effort / unblocks:** L (~2-3 weeks). Unblocks: multi-instance correctness, billing integrity, key-rotation sanity, and every scale concern downstream — eliminates the entire persistence blocker class.

Migrate user accounts, entitlements, and all mutable per-user collections (actions, events, contacts, decisions, memory, signal events) to Neon Postgres row-per-item, with Upstash Redis required in production; durable rate limits on all auth endpoints; sessionVersion bump on logout; OAuth CSRF state across all five providers; waitUntil on queued writes and strong-durability spend log; Sentry + request IDs + cron-failure alerting.

### Phase 2 — The brief arrives

**Effort / unblocks:** M (~2 weeks). Unblocks: the actual value proposition — intelligence that comes to you. Phases 0-2 together are the gate for charging money.

Morning briefing email rendered from the cached briefing JSON + Slack DM delivery with per-channel Settings toggles; QStash one-job-per-user fan-out for briefing and poll-ingest crons; per-source ingest error surfacing with reconnect prompts in the UI; zod parseBody on mutation routes with the unified {error, code} envelope; chat/mobile hardening.

### Phase 3 — Six surfaces

**Effort / unblocks:** M (~2 weeks). Unblocks: a coherent day-shaped product story, and roughly halves the surface area every later phase must polish and test.

IA consolidation per the new map: Today absorbs briefing/delta/digest, Signals absorbs slack-command with inline slide-over actions and dispositions, Meetings absorbs schedule+prep, Commitments absorbs actions/decisions/projects/Linear; delete orphan routes and the 19-file dead components folder; chat becomes the docked overlay/FAB; honest mutually-exclusive home metrics; Schedule responsive fix and mobile nav rework with Ask Basil promoted to a tab.

### Phase 4 — One language

**Effort / unblocks:** M-L (~2-3 weeks). Unblocks: the 'classy, sophisticated, instilling confidence' brand promise on every screen — and a design system that is enforceable rather than aspirational.

Token enforcement: single --gold, signal-token sweep replacing every pastel utility, type-scale collapse with the 11px floor, PageShell + PageHeader on every route, tokenize app/dashboard/page.tsx, commit to dark-only and delete the light fork; DataState mandated for async surfaces + global toast; /60 contrast floor with an axe-core Playwright pass; Radix dialogs replacing PanelModal; aria-label sweep; layout-preserving error boundaries; adopt-or-delete basil-primitives and prune dead CSS; CI grep banning stock palette classes.

### Phase 5 — Influence everywhere

**Effort / unblocks:** M (~1-2 weeks). Unblocks: the differentiator becomes the daily-felt experience instead of a buried tab — the reason an executive renews.

Approach chips at every point of action (signal threads, meeting prep, the brief's People section, the draft-email flow as a 'before you hit send' hint); home relationship rows deep-linking to the Personality view; server-side relationship score replacing the client heuristic; trust-envelope-based confidence replacing the volume heuristic; briefing line items deep-linked to their entities.

---

# Per-dimension audit detail

## backend — grade C

Basil's backend shows unusually strong craftsmanship in places — the chat route's spend-reservation lifecycle, Stripe webhook idempotency, Slack HMAC verification with dead-lettering, AI provider fallback, and durable rate limiting are genuinely production-grade. However, the flagship promise (a briefing every morning for every paying user) is broken by a cron identity bug: the briefing and reprocess cron paths resolve every CRON_SECRET call to the admin user, so non-admin customers never get cron-generated briefings while the admin's is regenerated N times at N-times the AI cost. Beyond that blocker, the system has a pervasive silent-failure posture (source fetches swallowed to empty arrays, webhooks returning 200 after dropped events, Gmail history baseline advanced on transient errors), no runtime request validation anywhere (zero zod on ~120 routes), and inconsistent error envelopes (JSON {error} vs {ok:false} vs plain text). Observability is console-only with good module prefixes but no error tracking, request IDs, or alerting, so a production incident is debuggable only by scrolling Vercel logs.

**Strengths:**

- Chat route (app/api/chat/route.ts) is exemplary: 200KB body cap, durable username-keyed rate limit with Redis fallback, spend reserve/commit/release with consumeStream guarding client disconnects, correct 401/413/429/400 statuses with Retry-After headers
- AI resilience layer (lib/ai/generate.ts) falls back from Vercel Gateway to direct Anthropic on transient errors, and SpendCapError is consistently mapped to 429 with Retry-After across briefing/digest/meeting-prep/chat
- Webhook fundamentals are right: Slack HMAC signature verification over raw bytes, Stripe signature + event-id idempotency dedupe + 500-to-force-retry semantics, Gmail Pub/Sub drain-with-200 semantics and batched message fetches sized to the ~10s ack deadline, dead-letter store for unresolvable webhook owners
- Cron loops mostly have per-user error isolation with per-user result maps in the response (cron/poll-ingest, cron/slack-sync, cron/billing-dunning), and slack-sync distinguishes fatal token errors from transient ones and surfaces token health to the UI
- signals/ranked has clamped limit/offset pagination, display-safe response projection, and per-request timing logs
- SSE stream (events/stream) is thoughtfully designed: Last-Event-ID resume, heartbeats, store-polling for cross-instance correctness, deliberately short maxDuration with documented reasoning
- Background work correctly uses next/server after() instead of fire-and-forget voids for the main ingest pipelines, with snapshot flushes before instance recycle

**Findings:**

### [BLOCKER] Cron briefing/reprocess fan-out always resolves to the admin user — paying users get no morning briefing

_Location: /Users/michaelcook/execautoclaude/app/api/cron/generate-briefing/route.ts (lines 47-69), /Users/michaelcook/execautoclaude/app/api/generate/briefing/route.ts (lines 80-87, 190-194), /Users/michaelcook/execautoclaude/app/api/events/reprocess/route.ts (lines 45-49)_

The cron wrapper loops over all users and POSTs to /api/generate/briefing per user, but it sends only the CRON_SECRET — no user identity. The briefing POST and DELETE handlers, when authenticated via CRON_SECRET, always resolve username to the first admin user. Net effect with N users: the admin's briefing is deleted and regenerated N times (N-times the Opus/Sonnet spend on one user), and every non-admin customer never receives a cron-generated briefing — the core 'relies on it every morning' product promise. The same admin-only fallback exists in /api/events/reprocess, which is a daily cron in vercel.json, so only the admin's events ever get backfilled. Note that poll-ingest already solved this correctly with an x-basil-username header — the pattern just wasn't propagated.

**Recommendation:** Copy the poll-ingest pattern: have cron/generate-briefing send an x-basil-username header per user, and have the briefing POST/DELETE (and events/reprocess) honor it when CRON_SECRET-authenticated. Add an integration test asserting each user in the store gets their own briefing cache entry after a cron run.

### [HIGH] Gmail webhook advances history baseline on ANY error, permanently skipping messages

_Location: /Users/michaelcook/execautoclaude/app/api/webhooks/gmail/route.ts (lines 175-180)_

The catch block around gmail.users.history.list unconditionally writes the new historyId and returns 200. The comment says the intent is to reset only on 404 HISTORY_NOT_FOUND (baseline too old), but the catch is generic: a transient Google 500, timeout, or token-refresh hiccup also advances the baseline, silently and permanently dropping every message in that history window. Pub/Sub would have retried on a non-2xx, but the 200 acknowledges delivery.

**Recommendation:** Inspect the error: only advance historyId on HISTORY_NOT_FOUND (HTTP 404). For transient errors, return 5xx so Pub/Sub redelivers, or dead-letter the payload via the existing writeDeadLetter helper.

### [HIGH] Poll-ingest swallows all upstream source failures into empty arrays — token expiry looks like a quiet inbox

_Location: /Users/michaelcook/execautoclaude/app/api/events/poll-ingest/route.ts (lines 165-173, 909-928)_

All six source fetches (Gmail, Slack, Calendar, Zoom-email search, Outlook, Teams) use .catch(() => []). An expired Google refresh token, a Google outage, or a revoked scope produces a successful 200 response with ingested:0, and the health-meta write still stamps lastPollAt with zero counts — the health panel claims a fresh, healthy poll. The user's data silently goes stale with no per-source error surfaced anywhere in the response or health metadata. Slack has an hourly auth.test probe cron; Google and Microsoft have no equivalent in this path. The briefing route shows the better pattern (null = failed/not-connected vs [] = empty).

**Recommendation:** Catch per-source errors into a {source: error} map, include it in the response and in health-meta (e.g. lastPollErrors), and distinguish 'connected but errored' from 'empty'. Flag fatal auth errors (invalid_grant) the way slack-sync flags token_revoked so the UI can prompt reconnection.

### [HIGH] No per-item error isolation in poll-ingest's email and Zoom after() blocks — one failure aborts the batch and skips the snapshot flush

_Location: /Users/michaelcook/execautoclaude/app/api/events/poll-ingest/route.ts (lines 426-456 email block, 726-736 zoom block)_

The Slack and Teams classification loops wrap each item in try/catch, but the email classification loop and the per-email Zoom after() callbacks do not. If processRegularEmail throws for one email (malformed message, Gmail 429, AI provider error), the remaining queued emails are never classified for that run AND the trailing forceFlushSnapshot() is skipped, so even successful earlier mutations may not persist before the instance recycles. The reprocess route has the correct per-item try/catch — this is an inconsistency within the same pipeline.

**Recommendation:** Wrap each processRegularEmail/processZoomEmail call in try/catch (matching the Slack/Teams loops) and move forceFlushSnapshot into a finally so it always runs.

### [HIGH] Zero runtime request validation across ~120 routes; bodies are cast, not checked

_Location: Codebase-wide; concrete examples: /Users/michaelcook/execautoclaude/app/api/actions/[id]/route.ts (lines 15-37), /Users/michaelcook/execautoclaude/app/api/settings/route.ts (lines 30-38), /Users/michaelcook/execautoclaude/app/api/onboarding/route.ts (line 19), /Users/michaelcook/execautoclaude/app/api/generate/meeting-prep/route.ts (JSON branch ~line 110)_

grep finds zero zod/safeParse usage in any route handler (zod exists only for AI output schemas). PATCH /api/actions/[id] casts the body to Partial<Pick<ActionItem,...>> — a compile-time fiction; a client can send status:123 or dueDate:{} and it flows into the store. PATCH /api/settings forwards the raw partial to patchSettings and infers 400-vs-500 by string-matching error messages starting with 'Invalid '. onboarding and meeting-prep's JSON branch call await req.json() unguarded, so a malformed body produces Next's plain-text 500 instead of the JSON {error} contract, and meeting-prep's title/date/time are never checked — 'undefined' literally flows into the AI prompt.

**Recommendation:** Introduce a small shared parseBody(req, zodSchema) helper returning a typed value or a 400 JSON response, and adopt it route-by-route starting with mutation endpoints (actions, settings, contacts, email, calendar, onboarding). This is mechanical work with high payoff for a commercial API.

### [MEDIUM] Sequential cron fan-outs will hit the function timeout as users grow — later users systematically starved

_Location: /Users/michaelcook/execautoclaude/app/api/cron/generate-briefing/route.ts, /Users/michaelcook/execautoclaude/app/api/cron/poll-ingest/route.ts (no maxDuration export on either)_

Both crons loop users sequentially with a blocking HTTP call per user and rely on the platform-default 300s limit (no maxDuration export, no time-remaining budget, no concurrency, no resumption). Briefing generation takes tens of seconds per user (maxDuration 300 on the inner route), so somewhere around 4-8 users the cron will 504 mid-loop and every user after the cutoff silently gets nothing — and because the loop DELETEs the cached briefing before regenerating, a timeout or POST failure leaves that user with no briefing at all rather than yesterday's.

**Recommendation:** Short-term: regenerate before delete (write-then-swap) so failure preserves the stale briefing, and add a time-budget check that stops cleanly and reports unprocessed users. Medium-term: fan out via the existing QStash jobs/handler or Workflow infrastructure (one job per user) instead of a sequential in-request loop.

### [MEDIUM] Inconsistent error envelope across the API surface

_Location: Codebase-wide; e.g. plain-text 'Forbidden'/'forbidden'/'Invalid signature' in cron/* and webhooks/*; {ok:false,error} in /Users/michaelcook/execautoclaude/app/api/slack/send/route.ts and signals/convert; {error} elsewhere; uncaught throws yield Next's non-JSON 500_

Three error shapes coexist: {error: string} (the majority), {ok:false, error} (slack/send, signals/convert 500s), and plain-text bodies on cron/webhook auth failures. Auth failures are sometimes 401, sometimes 403, for the same condition. The client helper basilFetch parses JSON {error|message}, so plain-text errors and framework 500s lose their server message. slack/send also returns String(e) raw to the client, leaking internal error text. A frontend engineer cannot write one error handler that works everywhere.

**Recommendation:** Standardize on {error: string, code?: string} with a tiny jsonError(status, message) helper; pick 401 for unauthenticated and 403 for bad cron/webhook secrets consistently; wrap route bodies so unexpected throws still emit the JSON envelope.

### [MEDIUM] Calendar/email GET return 200 with connected:false on upstream errors; email POST returns 401 for 'Gmail not connected'

_Location: /Users/michaelcook/execautoclaude/app/api/calendar/route.ts (lines 29-36), /Users/michaelcook/execautoclaude/app/api/email/route.ts (lines 80-82 and final catch)_

When the Google API errors (token refresh failure, 500, timeout), both GET routes respond HTTP 200 with connected:false and a generic message — indistinguishable from a genuinely unconnected account, so the UI will tell a connected user to 'Set up OAuth' during a transient outage, and uptime monitoring sees only 200s. Separately, POST /api/email returns status 401 for 'Gmail not connected.', which basilFetch classifies as auth_error (session expired) — the standard client handling for that is a login redirect, the wrong UX for a missing integration.

**Recommendation:** Distinguish three states in both routes: not connected (200 connected:false), upstream error (502/503 with {error}), success. Change the email POST not-connected case to 409 or 412 with a machine-readable code like 'gmail_not_connected'.

### [MEDIUM] Check-then-act dedupe races allow duplicate events under concurrent ingestion

_Location: /Users/michaelcook/execautoclaude/app/api/events/poll-ingest/route.ts (line 358), /Users/michaelcook/execautoclaude/app/api/webhooks/gmail/route.ts (line 112), /Users/michaelcook/execautoclaude/app/api/webhooks/slack/route.ts (line 148)_

All ingest paths do `if (await hasExternalId(...)) skip; else createEvent(...)` with no lock or unique constraint at the API layer. The cron poll, the Settings 'sync now' button, and the push webhooks can all run concurrently for the same user and message (the webhook even documents that poll-ingest may race it). Two interleaved checks both pass and the same email/Slack message becomes two events; downstream Jaccard dedupe softens actions but the Events feed and counters duplicate. Multiple concurrent after() blocks also each call forceFlushSnapshot over read-modify-write JSON stores, compounding last-writer-wins exposure (storage internals are another auditor's scope, but the API layer invites the race).

**Recommendation:** Make createEvent upsert-by-externalId (atomic at the store level), or serialize ingestion per user with a short-lived Redis lock (Upstash is already a dependency for rate limiting).

### [MEDIUM] Slack/Zoom webhooks acknowledge 200 after processing failures with no dead-letter — events silently lost

_Location: /Users/michaelcook/execautoclaude/app/api/webhooks/slack/route.ts (lines 195-197), /Users/michaelcook/execautoclaude/app/api/webhooks/zoom/route.ts (createEvent and workflow-start catches ~lines 180-200)_

Both webhooks correctly dead-letter when the owning user can't be resolved, but if createEvent or the durable workflow start() throws, the catch only console.errors and the handler still returns {ok:true}. The provider treats 200 as delivered and never retries, so the message/meeting is permanently lost with no durable record. Returning 200 to avoid retry storms is a defensible choice, but only if the failed payload is captured somewhere replayable.

**Recommendation:** In those catch blocks, call the existing writeDeadLetter helper with the payload before returning 200, and add an admin endpoint or script to replay dead letters.

### [MEDIUM] /api/chat/mobile lacks the rate limit and body-size cap that /api/chat has

_Location: /Users/michaelcook/execautoclaude/app/api/chat/mobile/route.ts_

The web chat route enforces a 200KB body cap and a durable 30-calls/minute per-user limit before reserving spend. The mobile sibling — same model tiers, tools, and 300s maxDuration — has neither. The monthly spend cap still applies, but a buggy or hostile mobile client can burn the user's entire monthly AI quota in minutes and tie up function time with oversized payloads.

**Recommendation:** Apply the same MAX_BODY_BYTES check and checkRateLimitDurable(`chat:${username}`) gate; the code can be lifted verbatim from app/api/chat/route.ts.

### [MEDIUM] renew-subscriptions cron lacks per-user isolation around auth client acquisition

_Location: /Users/michaelcook/execautoclaude/app/api/cron/renew-subscriptions/route.ts (lines 44-56)_

Inside the per-user loop, getAuthedClient(username) and getWatchState(username) are called outside any try/catch (only the inner watch renewals are guarded). If a token refresh throws for one user (Google transient error, revoked grant), the loop aborts and every remaining user's Gmail/Calendar watch silently lapses. Expired watches mean push ingestion stops; the only fallback is the once-daily poll, so affected users degrade to day-old data with no alert.

**Recommendation:** Wrap the whole per-user body in try/catch recording {username: error} in the results map, matching the pattern already used in cron/poll-ingest and billing-dunning.

### [MEDIUM] No error tracking, request correlation, or alerting — incidents are debuggable only by scrolling function logs

_Location: Codebase-wide (no Sentry/pino/winston/etc. in package.json or lib/)_

Logging is raw console.* with good module prefixes ([poll-ingest], [cron/...], [slack-webhook]) and cron responses do embed per-user result maps, which helps. But there is no error tracker, no structured/JSON logging, no request IDs to correlate a user report with a specific invocation, and background after() failures and fire-and-forget voids (e.g. `void recordIngest(...)`, `void appendAuditEntries(...)`) fail invisibly. For a commercial product, 'the briefing was wrong/missing this morning' is currently answerable only by grepping Vercel runtime logs within their retention window. The jobs store with attempt counters and the admin dispatch-log/shadow-log endpoints are decent partial compensations.

**Recommendation:** Add Sentry (or equivalent) with the Next.js SDK so route and after() exceptions are captured with user context; add a per-request ID header echoed in logs and error responses; route cron per-user failure maps to an alert channel (email/Slack) when any user's result is ok:false.

### [LOW] No retry/backoff or timeouts on Google API calls in ingest paths

_Location: /Users/michaelcook/execautoclaude/lib/google/* (no AbortSignal/timeout/retry config); contrast /Users/michaelcook/execautoclaude/lib/linear/client.ts line 53 (AbortSignal.timeout(10s)) and lib/zoom/client.ts (401-refresh-retry)_

Linear gets a 10s timeout, Zoom and Microsoft retry once after token refresh, Slack deliberately sets retries:0 — but the googleapis calls (Gmail, Calendar) have neither explicit timeouts nor any retry on transient 429/5xx. Combined with the .catch(() => []) swallowing in poll-ingest, a single Gmail blip during the one daily poll means a whole day of missed email signal.

**Recommendation:** Set a gaxios timeout and enable its built-in retry config (or a small retry wrapper with jittered backoff for 429/5xx) on the shared Google client factory.

### [LOW] signals/ranked response hardcodes flagsActive to true regardless of actual flags

_Location: /Users/michaelcook/execautoclaude/app/api/signals/ranked/route.ts (line 128 vs lines 42-44)_

The handler reads the real flags (and logs a warning when they're off) but the response body always returns flagsActive: { signalEvent_active: true, ranking_active: true }. Any client logic keying off this field gets a fabricated answer.

**Recommendation:** Return the actual flags object that was fetched at line 37.

### [LOW] Cache-miss GETs return HTTP 200 with literal null body; collection endpoints are unpaginated

_Location: /Users/michaelcook/execautoclaude/app/api/generate/briefing/route.ts (line 67), /Users/michaelcook/execautoclaude/app/api/generate/digest/route.ts (line 42), /Users/michaelcook/execautoclaude/app/api/events/route.ts, /Users/michaelcook/execautoclaude/app/api/contacts/user/route.ts_

GET briefing/digest return Response.json(null) on cache miss — a 200 whose body is the four bytes 'null', easy for clients to mishandle and impossible to distinguish from a deliberately empty value at the HTTP layer. Separately, /api/events?all=1 and the contacts/actions/decisions list endpoints return entire arrays with no limit/offset (only signals/ranked paginates); store compaction bounds events today, but contract-wise these endpoints don't scale and can't be cached or incrementally fetched.

**Recommendation:** Return 204 or {briefing: null, reason: 'no-cache'} for misses; add optional limit/offset (clamped, as in signals/ranked) to list endpoints before external clients depend on the unpaginated shape.

## persistence — grade D

Basil persists all state as whole-file JSON documents in Vercel Blob behind a per-instance /tmp write-through cache, with an in-process promise-chain "lock" guarding read-modify-write cycles. The design is unusually well documented and gets several things right (strong durability on user-mutating writes, AES-256-GCM for tokens and user records, per-user partitioning with paginated purge, append-only spend log), but it is fundamentally unsafe for a multi-instance commercial deployment: the /tmp cache has no TTL or cross-instance invalidation, every store is last-write-wins on a single file, and the global users file has no locking at all. Worse, any transient Blob read failure is silently coerced to the empty-array fallback, after which the next write durably persists the wipe — and there is no backup, versioning, or export to recover from. Combined with unbounded growth in the actions/ledger files and O(file-size) write amplification on every mutation, this layer will silently lose customer data under modest concurrent load. It is a well-executed prototype substrate that needs to move to a real database (Neon/Upstash via the Vercel Marketplace) or at minimum gain compare-and-swap semantics, error-vs-missing distinction, and automated snapshots before commercial launch.

**Strengths:**

- Clear, documented durability tiers: writeUserStore forces durability:'strong' (awaits the Blob put before the API response is sent) for all user-mutating writes, so a cold start cannot lose an acknowledged user write on the happy path (lib/storage/user-store.ts:36-40, lib/storage/persistent.ts:234-281)
- Encryption at rest is genuinely good for credentials: OAuth tokens (lib/storage/secure-token-store.ts) and user records (lib/storage/secure-auth-store.ts) are AES-256-GCM envelope-encrypted with fail-closed writes; password-reset tokens are stored as SHA-256 hashes only; key handling validates length and hard-fails in production (lib/storage/crypto.ts)
- Per-user data partitioning (basil/users/<safe>/...) with path-traversal sanitisation, plus a paginated full-prefix purge on account deletion that also clears the /tmp cache (lib/storage/persistent.ts:375-416, lib/storage/adapters/blob.ts:182-203)
- Core stores (events, actions, decisions, memory, contacts, chat) consistently serialise read-modify-write through withLock per user, which does prevent same-instance clobbering (lib/events/lock.ts)
- Some stores bound their growth: compactEvents prunes by age and caps at 300 events (lib/events/store.ts:185-239, invoked from the poll-ingest cron), chat history caps at 200 messages, signal events FIFO-cap at 2000
- Billing-relevant spend is recorded in an append-only one-blob-per-event log with collision-free filenames, explicitly designed so the non-atomic counter fallback can be reconciled (lib/ai/spend-log.ts); atomic Upstash Redis counters are used when configured (lib/storage/counter.ts)
- Honest engineering: known races are documented in-code (lock.ts notes the multi-instance gap, counter.ts documents the soft-cap race, classify route documents observed Blob CDN staleness)

**Findings:**

### [BLOCKER] Stale /tmp cache + last-write-wins enables silent cross-instance data clobbering

_Location: /Users/michaelcook/execautoclaude/lib/storage/persistent.ts (readStore lines 201-213, tmpWrite), /Users/michaelcook/execautoclaude/lib/events/lock.ts, all stores in lib/actions/store.ts, lib/events/store.ts, lib/contacts/user-store.ts, lib/decisions/store.ts, lib/memory/store.ts, lib/chat/store.ts_

Reads prefer the per-instance /tmp cache with NO TTL and NO cross-instance invalidation: once an instance caches a file, it serves and mutates that copy indefinitely, even after another instance overwrites the blob. withLock is an in-process promise chain ('Good enough for a single-process dev server' per its own comment), so two Vercel instances — e.g. the hourly slack-sync/poll-ingest crons running concurrently with an interactive request — each do read-modify-write of the ENTIRE JSON array and the loser's whole file is overwritten. Concrete user-visible failures: an action marked done resurrects, a newly created contact or memory vanishes, ingested actions disappear. For a commercial product this is silent, unexplainable data loss, the exact churn driver the audit is concerned with.

**Recommendation:** Move mutable per-user collections to a transactional store (Neon Postgres or Upstash Redis via the Vercel Marketplace — row-per-item, not file-per-collection). If Blob must remain short-term: add a version/etag field to every file and implement compare-and-swap (re-read fresh from Blob inside the lock before writing, reject and retry on version mismatch), add a short TTL to /tmp cache entries, and use a distributed lock (Upstash Redlock) keyed per user+file for cron/ingest paths.

### [BLOCKER] Transient Blob read failure is indistinguishable from 'file missing' — next write durably persists a wipe

_Location: /Users/michaelcook/execautoclaude/lib/storage/adapters/blob.ts (blobReadJson lines 59-80), /Users/michaelcook/execautoclaude/lib/storage/adapters/filesystem.ts (fsReadJson), consumed by every readAll() in lib/actions/store.ts, lib/memory/store.ts, lib/contacts/user-store.ts, lib/decisions/store.ts, lib/ledger/store.ts_

blobReadJson catches ALL errors (network failure, Blob 5xx, list() failure, corrupt JSON) and returns the fallback — typically []. Every store then treats [] as the true state inside its read-modify-write cycle: a cold-start instance (empty /tmp) that hits a momentary Blob hiccup during createAction will read [], push one item, and writeAll a 1-element array with strong durability — permanently destroying the user's entire action/memory/contact history. The same applies to corrupt JSON: corruption is masked as emptiness and then made permanent on the next write. There is no checksum, no item-count sanity guard, and no distinction between NOT_FOUND and ERROR anywhere in the read path.

**Recommendation:** Make blobReadJson distinguish 'blob does not exist' (return fallback) from 'read failed' (throw). Read-modify-write callers must abort on read errors, never proceed with the fallback. Add a cheap tripwire: refuse (or require explicit force) any write that shrinks a store file by more than N% / from >K items to near-zero, and log it loudly. Validate JSON shape per store before persisting.

### [BLOCKER] No backup, versioning, or export — every clobber is unrecoverable

_Location: Repo-wide: no backup/snapshot code exists (grep for backup/restore/export hits nothing operative); /Users/michaelcook/execautoclaude/lib/storage/adapters/blob.ts writes with allowOverwrite:true to a fixed pathname; /Users/michaelcook/execautoclaude/vercel.json crons contain no backup job_

Blobs are overwritten in place at deterministic paths; Vercel Blob has no native versioning. Combined with the two blockers above (cross-instance clobber, fallback-wipe), any data-loss event is permanent — there is no point-in-time copy, no daily snapshot cron, no user-facing export, and no admin restore tooling. For a commercial product, the first support ticket saying 'my tasks disappeared' has no remediation path at all.

**Recommendation:** Add a daily cron that copies every basil/users/** blob to a timestamped snapshot prefix (basil/_backups/<date>/...) with N-day retention, plus a per-user JSON export endpoint. When migrating to Postgres, rely on Neon point-in-time recovery instead. Optionally write each file's previous version to <name>.prev.json on overwrite as a one-write-deep undo.

### [HIGH] Global encrypted users file mutated with no locking — concurrent signups can lose accounts

_Location: /Users/michaelcook/execautoclaude/lib/users.ts (lines 143-239: every mutation does readUserRecords() → mutate → writeUserRecords()), /Users/michaelcook/execautoclaude/lib/storage/secure-auth-store.ts_

All user accounts live in ONE encrypted blob (secure-users.json). Mutations (createUser, updates, delete) are unguarded read-modify-write — there is not even the in-process withLock used elsewhere. Two near-simultaneous signups (likely during any launch/marketing spike) read the same array and the second write erases the first account: the new customer's credentials simply don't exist on next login. The single-file design also means every profile update rewrites and re-encrypts every user record, and a decrypt failure after key rotation falls back to the stale plaintext legacy users.json (line 86-115), silently resurrecting old account state.

**Recommendation:** Highest-priority migration target: move accounts to a real table (one row per user, unique constraint on username/email). Interim: wrap all users.ts mutations in withLock('users') AND add fresh re-read + version CAS, and store one encrypted blob per user (users/<u>/account.json) so concurrent signups touch different files.

### [HIGH] Fire-and-forget 'eventual' writes can be lost when the instance suspends — including the billing spend log

_Location: /Users/michaelcook/execautoclaude/lib/storage/persistent.ts (enqueueBlobWrite lines 158-169, writeStore eventual branch), /Users/michaelcook/execautoclaude/lib/ai/spend-log.ts (appendSpendEvent uses durability:'eventual' and swallows errors), /Users/michaelcook/execautoclaude/lib/generate-cache/store.ts_

Eventual writes land in /tmp and enqueue an un-awaited Blob put. There is no waitUntil() anywhere in the codebase, so once the response is sent Vercel may freeze or recycle the instance before the queued put executes — the write then exists only in ephemeral /tmp and is lost on cold start. For generated caches this is acceptable (as documented), but lib/ai/spend-log.ts — explicitly described as the 'RECOVERABLE SOURCE OF TRUTH' for AI spend reconciliation — uses eventual durability and never throws, meaning metered usage events can silently vanish. On the non-Redis counter fallback this leaves no authoritative record at all, i.e. revenue leakage.

**Recommendation:** Pass queued Blob writes to waitUntil() (from @vercel/functions) so the platform keeps the instance alive until they flush, or upgrade spend-log specifically to durability:'strong' (it is one small immutable blob per event — the latency cost is a single put). Add a startup/cron reconciliation that flags periods where counter totals diverge from the event log.

### [HIGH] Read-after-write staleness from Blob CDN acknowledged in code but unsolved for multi-instance reads

_Location: /Users/michaelcook/execautoclaude/app/api/actions/classify/route.ts (lines ~220-227 comment), /Users/michaelcook/execautoclaude/lib/storage/adapters/blob.ts (fetchBlob cache-buster), fresh:true used only in lib/storage/secure-auth-store.ts and lib/storage/secure-token-store.ts_

The team has observed (and documented in the classify route) that reading from Blob immediately after a write 'can serve the pre-write cached content' despite the ?v=Date.now() cache-buster. Their fix — read from local /tmp instead — only works when the write happened on the same instance, which is exactly the assumption that breaks under scale-out. Today only auth records and OAuth tokens use fresh:true; every data store (actions, events, decisions, memory, contacts, ledger, entitlements) reads through the unversioned /tmp cache. Notably entitlement.json (paywall state, mutated by Stripe webhooks on one instance, read by app traffic on others) and read-modify-write preludes are the reads that most need freshness and don't have it.

**Recommendation:** Until the DB migration: read entitlements and any cron/webhook-mutated file with fresh:true; for read-modify-write cycles always re-read fresh inside the lock immediately before writing; consider storing a monotonically increasing rev in each file and rejecting reads older than the last rev this instance wrote.

### [MEDIUM] Strong writes await a single global Blob promise chain — head-of-line blocking and error misattribution

_Location: /Users/michaelcook/execautoclaude/lib/storage/persistent.ts (blobChain lines 158-169, writeStore lines 270-276)_

All Blob puts on an instance are serialised through one global promise chain, and a durability:'strong' caller awaits the WHOLE chain. Under Fluid Compute concurrency, request B's strong write awaits request A's unrelated queued writes (latency coupling), and because errors are deliberately left uncaught on the chain, a failed put for file A can surface as the 500 returned to file B's request while A's caller (eventual) never learns of the failure. During ingest bursts that create dozens of actions, each full-file put queues behind the previous one, compounding with the O(file size) write amplification.

**Recommendation:** Key the write queue per pathname (Map<pathname, Promise>) so unrelated files don't serialise or share failures; have strong writers await only their own put's promise; record failed eventual writes to a retry queue or at least a counter surfaced in a health endpoint.

### [MEDIUM] Several stores perform read-modify-write with no lock at all

_Location: /Users/michaelcook/execautoclaude/lib/ledger/store.ts, /Users/michaelcook/execautoclaude/lib/settings/store.ts, /Users/michaelcook/execautoclaude/lib/delta/store.ts, /Users/michaelcook/execautoclaude/lib/billing/entitlement-store.ts, /Users/michaelcook/execautoclaude/lib/ai-projects/store.ts, /Users/michaelcook/execautoclaude/core/storage/signal-event-store.ts, /Users/michaelcook/execautoclaude/core/storage/canonical-identity-store.ts, /Users/michaelcook/execautoclaude/core/storage/signal-thread-store.ts, /Users/michaelcook/execautoclaude/core/feature-flags.ts_

Unlike the events/actions/memory stores, these modules skip withLock entirely, so even two concurrent requests on the SAME instance can interleave read-modify-write and lose updates. signal-event-store is described as the future 'canonical source of truth' for the Gmail cutover yet is written without any concurrency guard from high-volume ingestion paths; entitlement-store is mutated by billing webhooks; ledger.json backs user-visible items.

**Recommendation:** Minimum: wrap every mutation in these files in withLock(`<store>:${username}`) to match the rest of the codebase. These stores should be in the first wave of the database migration since several (signal events, entitlements) are written by background/webhook traffic that races interactive traffic across instances.

### [MEDIUM] Unbounded file growth and O(N) write amplification — actions, ledger, contacts never compact

_Location: /Users/michaelcook/execautoclaude/lib/actions/store.ts (no MAX/prune; done items retained forever; mergeExistingDuplicates is O(N²) per list call), /Users/michaelcook/execautoclaude/lib/ledger/store.ts, /Users/michaelcook/execautoclaude/lib/contacts/user-store.ts, /Users/michaelcook/execautoclaude/app/api/whatsapp/upload-snapshot/route.ts (no size cap); contrast lib/events/store.ts compactEvents (300 cap, only run by the daily poll-ingest cron)_

Events are capped at 300 and chat at 200, but sage-actions.json has no compaction — auto-archived 'done' items accumulate indefinitely, and every single mutation (each createAction during an ingest run, every status toggle) re-serialises and re-uploads the ENTIRE array with an awaited Blob put. listActions additionally runs O(N²) Jaccard dedup over the full list on every read. Practical ceiling: an active executive generating ~50 actions/day reaches thousands of records within months — multi-MB writes per toggle, multi-second ingest runs, and growing Blob egress per read. The same pattern applies to ledger.json, contacts, and the un-capped WhatsApp snapshot upload. The global secure-users.json similarly rewrites all users per account mutation, capping viable user count in the low hundreds.

**Recommendation:** Add compaction for actions mirroring compactEvents (archive done items older than N days to a cold archive blob, cap the hot file), cap or chunk the WhatsApp snapshot, and run compaction from the cron. Longer term the row-per-item database model eliminates write amplification entirely.

### [MEDIUM] Schema evolution is ad-hoc lazy migration with no versioning or central framework

_Location: /Users/michaelcook/execautoclaude/lib/events/store.ts (normaliseLegacyFields), /Users/michaelcook/execautoclaude/lib/contacts/user-store.ts (normalize), /Users/michaelcook/execautoclaude/core/feature-flags.ts (_v: 2 — the only versioned store), /Users/michaelcook/execautoclaude/lib/storage/secure-auth-store.ts and secure-token-store.ts (read-time migrations), /Users/michaelcook/execautoclaude/lib/storage/persistent.ts (BASIL_DATA migration)_

Each store invents its own backfill (per-process memo sets, read-time rewrites, defensive field defaults). Only feature-flags carries a schema version. There is no manifest of file formats, no migration ordering, and no way to know which shape a given user's blob is in — risky when fields are renamed (the sourceRef/externalId dual-write is a live example of the cost). Lazy read-time migration also interacts badly with the concurrency issues: a migration rewrite on one instance can race a user write on another.

**Recommendation:** Add a _v field to every store file and a small central registry of per-file migration functions applied on read (and persisted once, under the store's lock). Keep a documented manifest of every filename, owner module, shape, and current version — this also becomes the table schema spec for the database migration.

### [MEDIUM] Encryption at rest covers credentials but not user content; plaintext legacy users.json lingers after migration

_Location: /Users/michaelcook/execautoclaude/lib/storage/secure-auth-store.ts (readUserRecords migration never deletes users.json, lines 101-115), /Users/michaelcook/execautoclaude/lib/storage/secure-token-store.ts (legacy token files ARE nulled — inconsistent), content stores: lib/chat/store.ts, lib/events/store.ts (ingested email/Slack payloads), lib/actions/store.ts, whatsapp-snapshot.json_

OAuth tokens, user records, and reset tokens are properly encrypted (AES-256-GCM, fail-closed). However: (1) after the users.json→secure-users.json migration the plaintext file containing usernames, emails, and bcrypt hashes is left in Blob indefinitely — the token migration nulls its legacy file, the user migration does not; (2) all user CONTENT — chat history, ingested email/Slack bodies inside events, action text, contacts, WhatsApp message snapshots — is plaintext JSON protected only by the blobs' private access mode, so one leaked BLOB_READ_WRITE_TOKEN exposes every customer's communications; (3) there is no key-rotation procedure: rotating BASIL_TOKEN_ENCRYPTION_KEY bricks all envelopes (decrypt failures force token re-auth and fall back to the stale plaintext users file).

**Recommendation:** Null/delete users.json after successful migration (one-line parity with secure-token-store). Document and script key rotation (decrypt-with-old, re-encrypt-with-new sweep; support a comma-separated key list for transition). Decide explicitly whether content-level encryption is a product requirement; at minimum extend envelope encryption to chat history and the WhatsApp snapshot, which contain raw third-party communications.

### [LOW] Hot-path read fan-out: listConnectedProviders performs 11 fresh Blob round-trips per call

_Location: /Users/michaelcook/execautoclaude/lib/storage/secure-token-store.ts (listConnectedProviders lines 181-190; each getIntegrationToken uses fresh:true → list() + fetch per provider)_

Every call probes all 11 providers with cache-bypassing reads (each a Blob list() to resolve the URL plus an authenticated fetch, plus potential legacy-migration reads). If this backs a frequently rendered settings/status UI it adds ~22+ Blob operations and noticeable latency per page view, and Blob list() calls are metered. The in-memory urlCache only helps warm instances.

**Recommendation:** Maintain a single per-user connected-providers index file updated on save/delete, or cache the provider list with a short TTL; only the actual token use needs fresh decryption.

### [LOW] Counter fallback is non-atomic for spend caps when Redis is absent (documented, but verify production config)

_Location: /Users/michaelcook/execautoclaude/lib/storage/counter.ts (Blob fallback incrCounter — read-modify-write, last-write-wins)_

The code itself is honest that without UPSTASH_REDIS_REST_URL/TOKEN the spend guard becomes a soft cap with lost increments under concurrency. Combined with the eventual-durability spend log (see separate finding), a production deployment without Redis has neither accurate counters nor a guaranteed event log — a real revenue/cost-control gap rather than a code bug.

**Recommendation:** Treat Upstash Redis as a required production dependency (fail loudly at startup when missing in production), and add the reconciliation cron the comments promise so counter drift is corrected from the event log.

## design-system — grade C

Basil has a genuinely well-architected design system on paper — app/globals.css defines a coherent midnight+gold identity with surface elevation, a semantic signal palette, motion tokens, and a documented six-level type scale — but the application layer largely ignores it. The dashboard home page (app/dashboard/page.tsx) bypasses every token (200 hardcoded hex values, 0 theme-token classes, inline style objects), the brand gold exists in at least three competing values (538 raw oklch() literals across 44 files), and the system's own enforcement layer (components/ui/basil-primitives.tsx) is imported by zero files. Theme integrity is the most serious failure: the app defaults to dark, yet 33 dashboard files use light-only Tailwind pastel classes (bg-red-50, bg-amber-100, etc.) with virtually no dark: overrides, while light mode — reachable only via a mobile-only toggle — renders the hardcoded-dark home page inside a light shell. The auth shell would pass a Fortune-500 first impression; the dashboard passes only on the dark desktop happy path and visibly fractures on settings banners, briefing section colors, and any theme switch.

**Strengths:**

- app/globals.css is a high-quality foundation: 4-level surface elevation, semantic signal palette (critical/warning/positive/info), motion duration/easing tokens with prefers-reduced-motion overrides, gold focus-visible ring, fluid 16-18px type base, and WCAG-annotated contrast decisions (e.g. --muted-foreground darkened with rationale at globals.css:277, 347)
- The auth shell is coherent and polished — dedicated token block (globals.css:20-29), no-white-flash dark baseline via html:has(.auth-shell) (globals.css:14-17), and a consistent glass-card/gold-button language
- The dark-mode dashboard token set (globals.css:334-401) faithfully carries the auth identity (#07111F bg, #F3EFE7 ivory, #C8A96B gold) into the product — the brand bridge exists at the token level
- The shadcn/ui layer (components/ui/card.tsx, badge.tsx, button.tsx, skeleton.tsx) is cleanly token-driven; Card even composes the basil-card surface class
- DataState (components/ui/data-state.tsx) is a thoughtfully designed unified loading/empty/error component with error-kind-aware messaging, retry, and sign-in actions
- Navigation chrome is well-crafted: app-sidebar.tsx active gold rail + atmospheric glow, mobile-bottom-nav.tsx with safe-area insets, PWA standalone detection, and consistent 44px touch considerations

**Findings:**

### [BLOCKER] Theme integrity broken: light-only pastel classes ship in the dark-default theme

_Location: 33 files incl. app/dashboard/settings/page.tsx:1300,1312,1330 · app/dashboard/chat/page.tsx:826 · components/ui/data-state.tsx:200 · app/dashboard/briefing/page.tsx:73-131_

The app defaults to dark (app/layout.tsx:113, enableSystem=false), yet ~500 occurrences of light-only Tailwind shades (bg-red-50 x60, bg-emerald-50 x58, bg-amber-50 x57, bg-amber-100, border-emerald-300...) appear across 33 dashboard files with essentially zero dark: overrides (most affected files have 0). Settings — the first page every new user visits to connect integrations — renders pastel amber/emerald readiness banners on a midnight background; the chat error panel uses border-red-300 bg-red-50; even the shared DataState StaleBanner is light-only. Meanwhile briefing section foregrounds (text-red-600, text-violet-600) are too dark for the navy background. This is visible wrong-theme styling on the default path of a product selling executive-grade polish.

**Recommendation:** Sweep all raw red/amber/emerald/violet/blue/teal 50-300 utilities and replace them with the existing signal tokens (--signal-*-subtle/border/fg, globals.css:312-323 and 381-395) or the signal-surface-* classes already defined at globals.css:824-839. Add a lint rule (eslint-plugin-tailwindcss or a simple grep CI check) banning stock palette color classes in app/dashboard.

### [HIGH] Dashboard home page bypasses the design system entirely and is dark-only

_Location: app/dashboard/page.tsx (1,876 lines; e.g. 101-241 HeroLight, 256, 1766-1795 hero, 1810-1814 MetricBar)_

The flagship page contains 200 hardcoded hex literals, 162 arbitrary bracket utilities, and ZERO theme-token classes (no text-muted-foreground, bg-card, text-foreground anywhere). The hero h1 is a raw inline style object (Fraunces italic, color #F5EEE0, text-shadow) instead of basil-display; empty states, metric colors (#D96C5F, #5CB8FF), and all text colors (#AAB3C5 at /25-/65 opacity) are hand-coded. Consequences: in light mode the home page remains a dark page inside a light shell; the page is unmaintainable; and its 'warm brown-black' hero base (rgba(18,12,6)) plus a fourth gold family (#D4A845/#F0CB70/#B07820) drift from the midnight-navy identity even within dark mode.

**Recommendation:** Refactor page.tsx onto the token layer: map every hex to existing vars (--basil-muted, --basil-gold, --signal-*, --surface-*), replace inline hero styles with basil-display + a utility class, and either make HeroLight theme-aware or render it only in dark mode with a designed light-mode equivalent.

### [HIGH] The brand gold is not a token — three+ competing gold values, 538 raw oklch literals

_Location: 44 files; e.g. components/theme-toggle.tsx:33,43,50 · components/mobile-bottom-nav.tsx:56-104 · app/dashboard/meetings/page.tsx:465-505 · app/dashboard/contacts/page.tsx:41,117 · components/app-sidebar.tsx:65-282 (20 hex)_

oklch(0.72_0.15_85) is hardcoded as an arbitrary value 376 times (538 total oklch literals across 44 files), the sidebar hardcodes #C8A96B 20 times, and globals.css itself defines TWO different identity golds (--gold: #c17d2a in light at :329, #C8A96B in dark at :398). The oklch literal matches neither and never theme-shifts, so light mode shows the dark-mode gold (low contrast on stone surfaces) and the 'identity colour' the brand depends on is unpinned. Any future brand adjustment requires editing 40+ files.

**Recommendation:** Define one canonical accent token (e.g. --gold / --color-gold registered in @theme so bg-gold, text-gold, ring-gold utilities exist) with light/dark values, then codemod all oklch(0.72_0.15_85) and #C8A96B usages to it. The .text-gold utility at globals.css:512 is already there — extend the pattern.

### [HIGH] Design-system enforcement layer is dead code — near-zero adoption of documented primitives

_Location: components/ui/basil-primitives.tsx (0 imports) · globals.css:522-526 (.display-serif, 0 uses) · app/layout.tsx:24-29 (Instrument Serif loaded, never rendered) · globals.css:529-537 (.dash-grid 0 uses), 660-669 (.basil-content-*/.basil-section 0 uses), 701-733 (.basil-transition* 0 uses)_

basil-primitives.tsx ships typed wrappers (BasilText, OperationalCard, SectionHeader, StatusPill, EmptyState) explicitly documented as 'Use these instead of raw Tailwind classes' — and is imported by zero files. The type-scale classes have single-digit adoption across ~13,000 lines of dashboard pages (basil-heading x2, basil-caption x4, basil-data x7, basil-prose x2). Instrument Serif is downloaded on every page load for a .display-serif class used nowhere. The motion system (basil-transition*), interaction system (basil-interactive/pressable/selected), content-width containers, and chip-emerald/coral/cyan are all unused. The 931-line globals.css is roughly one-third dead weight, which means the 'system' provides no real consistency guarantee.

**Recommendation:** Decide per utility: adopt or delete. Migrate page headers and cards to SectionHeader/OperationalCard (or delete basil-primitives.tsx), remove the Instrument Serif font load and .display-serif, and prune unused utilities so the remaining system is authoritative and reviewable.

### [MEDIUM] No consistent page-header pattern — five different h1 treatments across nine pages

_Location: app/dashboard/signals/page.tsx:989 (basil-display text-2xl) · chat/page.tsx:763 (text-lg font-semibold) · meetings/page.tsx:464, settings/page.tsx:1286, actions/page.tsx:1248, decisions/page.tsx:702 (text-2xl font-semibold tracking-tight) · memory/page.tsx:369 (basil-display text-2xl→5xl) · page.tsx:1773 (inline-style italic clamp 3.5-5.5rem) · contacts + schedule (no h1 at all)_

Page identity is rendered five different ways. Worse, the global rule h1 { font-family: var(--font-heading); font-weight: 400 } (globals.css:454-459) silently turns the sans-intended 'text-2xl font-semibold' headers into Fraunces SemiBold — a serif weight the design system never specifies — so meetings/settings/actions get an accidental hybrid style. Memory's h1 scales to 5xl while Signals' stays 2xl for equivalent hierarchy. Two pages have no h1, hurting both consistency and accessibility. An exec navigating between pages perceives a different product on each.

**Recommendation:** Create one PageHeader component (eyebrow + basil-display title + description + action slot — SectionHeader in basil-primitives is 90% of this) and mandate it on every dashboard route. Remove the global h1 font-family override or scope it (e.g. .basil-display only) so weight/family is always explicit.

### [MEDIUM] Fractured ad-hoc type scale with sub-legible micro-text

_Location: app/dashboard (repo-wide): text-[12px] x137, text-[13px] x37, text-[9px] x11, text-[8px] x3, text-[10.5px] x4, text-[9.5px], text-[11.5px] · low-contrast examples app/dashboard/page.tsx:512,574,906-916,1342 (text-[#AAB3C5]/25-/45)_

Instead of the documented scale (basil-caption 11px, basil-data 13px), pages invent 14 distinct pixel sizes including fractional ones (10.5px, 9.5px, 11.5px) and 8-9px labels. On the home page, metadata is rendered at 9px with 25-45% opacity ivory — well below WCAG contrast and physically hard to read, directly contradicting the readability audit comment at globals.css:432-437 ('text below 16px on dense dashboards reads as cramped'). This reads as decorative dressing rather than an intelligence tool an exec relies on.

**Recommendation:** Collapse to the existing scale: text-xs (12px) / basil-caption / basil-data, set a hard floor at 11px, and replace opacity-based dimming below /55 with --muted-foreground tokens that were specifically tuned to hold 4.5:1.

### [MEDIUM] Loading/empty/error states fragmented across three competing patterns

_Location: components/ui/data-state.tsx (used in only 5 files) · components/ui/skeleton.tsx (19 files) · 9 files with hand-rolled animate-pulse (page.tsx alone has 21) · 14+ ad-hoc empty states e.g. app/dashboard/page.tsx ('No upcoming events', hardcoded #AAB3C5) · .basil-skeleton (globals.css:907-911) ~3 uses_

A well-designed DataState component exists but covers only 5 of ~20 surfaces; everything else hand-rolls skeletons and 'No X yet' blocks with divergent iconography, spacing, and (on the home page) hardcoded dark-only colors. The documented loading philosophy ('slow pulse, low contrast', globals.css:897-900, basil-pulse 2.2s) is implemented but unused — actual skeletons use Tailwind's fast default pulse. Error styling inside DataState (StaleBanner) and chat's brain-not-configured panel are light-only. No state is branded; empties use a generic Inbox icon rather than anything Basil.

**Recommendation:** Make DataState the single mandated wrapper for async cards/pages, restyle its Skeleton/StaleBanner with tokens and basil-pulse, add one branded empty illustration (the basil leaf watermark already exists for auth), and delete per-page empties.

### [MEDIUM] Briefing page uses a seven-hue rainbow palette that contradicts the signal system

_Location: app/dashboard/briefing/page.tsx:68-132_

Section definitions hardcode red, emerald, amber, violet, gold-oklch, teal, and blue accents (bg-violet-500, text-teal-600, ring-blue-500/25...). The design system's stated philosophy is 'Colour reserved for meaning — no decorative colour' (globals.css:210) with a deliberately desaturated four-signal palette. The daily briefing — the product's hero artifact — instead looks like a generic SaaS category list, uses hues (violet, teal) that exist nowhere else in the brand, and its -600 foregrounds have no dark: variants in the dark-default app.

**Recommendation:** Re-map briefing sections onto the semantic signal tokens (critical→signal-critical, follow-ups→signal-warning, people→signal-info, etc.) with gold reserved for meetings/identity, eliminating violet/teal entirely.

### [LOW] Light theme is effectively unreachable on desktop yet maintained in full

_Location: components/theme-toggle.tsx (only render site: app/dashboard/layout.tsx:110, mobile non-standalone header) · app/layout.tsx:113 (defaultTheme=dark, enableSystem=false)_

A complete 65-line light token set exists (globals.css:264-331) including a teal primary (#1a5c5f) and different gold (#c17d2a) — an identity never shown in the auth shell — but desktop and PWA-standalone users have no theme toggle at all. The light theme is both a brand fork (stone+teal vs midnight+gold) and a maintenance liability that the codebase demonstrably is not testing against (see blocker finding).

**Recommendation:** Make an explicit product decision: either commit to dark-only for v1 (remove the toggle and light tokens, simplifying every finding above) or expose the toggle in settings/sidebar and bring light mode up to the auth shell's brand (gold accent, no teal) with visual QA per page.

### [LOW] No shared page-container standard — every route picks its own width and padding

_Location: app/dashboard/settings/page.tsx:1281 (max-w-6xl) · briefing (max-w-5xl) · signals/page.tsx (max-w-[1400px]) · memory (max-w-[1100px]) · meetings/actions/decisions (full-bleed p-4/6/8) · globals.css:660-664 (.basil-content-* defined, 0 uses)_

Content width jumps between 1024px, 1152px, 1100px, 1400px, and unbounded as the user navigates, and horizontal padding varies (px-4/6/8 vs px-10 on signals vs px-7/8 on home). The basil-content-xs→full container scale built for exactly this purpose is never used. The result is a perceptible 'reflow' between pages that undermines the composed, premium feel.

**Recommendation:** Standardize on basil-content-lg (or -full for split-pane views) plus one padding recipe inside a shared PageShell component used by every dashboard route.

## ux-journey — grade C

Basil's navigation has already been pruned to a sensible 10-item sidebar plus an "Ask Basil" CTA, and the home page is a genuine command center with briefing, schedule, signal radar, and relationship panels. However, the product is pull-only end to end: the daily briefing is generated by cron at 6:15 UTC but never delivered to the user via email, Slack, or push, directly contradicting the "intelligence comes to you, zero added workload" vision. Day-0 is dead air — onboarding redirects to an empty dashboard with no initial sync (ingest cron runs once daily at 05:45 UTC), and roughly a third of the 20 dashboard routes (delta, digest, projects, ai-projects, trust, slack-command) are orphaned duplicates or dev tools left in user URL space, backed by a 19-component dead-code folder from a previous home page. The differentiating personality/influence layer exists and is well-crafted (contact Personality tab, meeting-prep attendee styles) but is buried three levels deep with no entry point from home, briefing, or signals, and acting on any signal requires a context switch into chat.

**Strengths:**

- Sidebar IA is already consolidated: 8 primary + 1 secondary destinations with a clear hierarchy, a prominent Ask Basil CTA, and a Cmd-K palette including quick-create actions (new action, log decision, add note) — components/app-sidebar.tsx, components/command-palette.tsx
- Home page (app/dashboard/page.tsx) is a real morning command center: Today's Briefing preview with per-section color coding, today's schedule with live 'now' highlighting, signal radar, recent threads, relationship trends, and computed insights — each panel deep-links and has an expand-in-place modal, so 'what matters right now' is mostly answerable without leaving the page
- Daily briefing is pre-generated server-side by cron for entitled users (app/api/cron/generate-briefing/route.ts), so the morning dashboard visit hits a warm cache instead of forcing the user to wait on generation
- The personality/influence promise is genuinely built, not vaporware: contact detail has Personality / What Makes Them Tick / Watch Out cards (app/dashboard/contacts/page.tsx ~705-770) and meeting prep renders per-attendee 'Quick Profile' style insights (app/dashboard/meetings/[eventId]/page.tsx ~359)
- Onboarding is a thorough 8-step flow capturing role, timezone, working hours, communication style, and OAuth connections, with correct resume-after-OAuth-redirect handling (app/(auth)/onboarding/page.tsx)
- Mobile bottom nav is a disciplined 4-tabs-plus-More pattern with safe-area inset handling (components/mobile-bottom-nav.tsx)

**Findings:**

### [HIGH] Intelligence is pull-only: daily briefing is generated but never delivered

_Location: vercel.json (crons), app/api/cron/generate-briefing/route.ts, components/pwa/ (service-worker-register.tsx only), app/dashboard/briefing/page.tsx_

The cron generates a briefing for every entitled user each morning, but there is no delivery channel: no briefing email, no Slack DM, no WhatsApp message, and no web push (the PWA folder contains only a service-worker register — no push subscription). Digest and delta additionally require the user to click Generate/Regenerate manually, and the briefing page shows a stale banner asking the user to regenerate. For a product whose pitch is 'an intelligence layer that does NOT add to your workload,' the current journey requires the user to remember to open the app and pull from up to six pages. This inverts the core value proposition and will depress retention — users who skip a morning never learn what they missed.

**Recommendation:** Ship at least one push channel before launch: (1) a morning briefing email rendered from the already-cached briefing JSON (cheapest, the generation cost is already paid), (2) a Slack DM via the existing Slack integration, and (3) web push for the PWA. Add per-channel toggles in Settings. Make the stale-briefing banner auto-regenerate on cron rather than asking the user to click Regenerate.

### [HIGH] Day-0 dead air: new users land on an empty dashboard until the next morning's cron

_Location: app/(auth)/onboarding/page.tsx (finishOnboarding, line ~309), app/api/auth/google/callback/route.ts, app/dashboard/page.tsx empty states_

finishOnboarding POSTs profile data and hard-redirects to /dashboard with no sync kick-off, and the Google OAuth callback contains no ingest/backfill trigger. Signal ingestion runs on a once-daily cron (poll-ingest at 05:45 UTC) and briefing generation at 06:15 UTC, so a user who completes the 8-step onboarding at 2pm sees: empty radar ('no signals yet'), 'No briefing yet — Generate briefing', 'No relationship data yet', and an AI Confidence widget reading 'Low — No signals yet'. Worse, several empty states say 'Connect your accounts to begin' even when accounts were just connected during onboarding — telling the user the setup they just completed didn't work. Time-to-first-value is up to ~18 hours, which is fatal for trial conversion.

**Recommendation:** Fire a backfill job immediately on OAuth callback (or on finishOnboarding) covering the last 7-14 days of Gmail/Calendar/Slack, then auto-generate the first briefing when the backfill completes. Replace 'Connect your accounts to begin' with state-aware copy ('Connected — first sync in progress, ~3 min') and show a sync-progress indicator on the home page for day-0 users.

### [HIGH] Six overlapping surfaces render the same signal intelligence; two of them are orphaned

_Location: app/dashboard/briefing/page.tsx, app/dashboard/digest/page.tsx, app/dashboard/delta/page.tsx, app/dashboard/signals/page.tsx, app/dashboard/slack-command/page.tsx, home Intelligence panel in app/dashboard/page.tsx_

Briefing (daily, 7 sections), Digest (weekly, 6 near-identical sections: meetings/changes/decisions/blockers/relationships/next-week), Delta ('What Changed' change feed with severity buckets), Signals (thread feed), slack-command (Slack-only signal feed with reply_needed/blocker/decision_pending types), and the home 'Basil Intelligence' panel are all views over the same underlying signal store. Digest and Delta appear in neither the sidebar nor the Cmd-K palette — they are unreachable except by typing the URL, meaning real users never see two fully-built intelligence surfaces while maintainers pay to keep them working. slack-command duplicates the Signals page for one source. This fragmentation forces the 'visit 6 pages to assemble the picture' behavior the vision explicitly rejects.

**Recommendation:** Consolidate to one intelligence spine: make Briefing the single 'Brief' surface with Daily / Weekly tabs (folding Digest in), merge Delta's change-feed into the home page as the 'What changed since you last looked' strip (its bucketed severity model is the best of the three), fold slack-command's signal types (reply_needed, promise_made, decision_pending) into the Signals thread model as filters, and delete the orphan routes. Target IA: Home, Brief, Signals, Actions (+Decisions tab), Schedule (+Meeting Prep merged), People, Memory, Ask Basil, Settings — 8 destinations.

### [MEDIUM] Dev/admin tools and dead routes leak into user URL space; 19-component dead-code folder

_Location: app/dashboard/trust/page.tsx, app/dashboard/slack-command/page.tsx, app/dashboard/whatsapp/page.tsx, app/dashboard/linear/page.tsx (1,627 lines, Cmd-K only), app/dashboard/projects/page.tsx, app/dashboard/ai-projects/page.tsx, app/dashboard/components/ (all 19 files unimported)_

/dashboard/trust is explicitly a 'Design system reference' showcase with mock data living at a user-facing URL. /dashboard/whatsapp is a QR-pairing/connection-management surface (settings material) linked from Settings and Contacts as if it were a feature page. /dashboard/projects and /dashboard/ai-projects are reachable only via links inside app/dashboard/components/ — a folder of 19 components (now-panel, attention-layer, approval-panel, what-changed, pulse-strip, etc.) from a previous home-page generation that nothing imports anymore. Linear gets a 1,627-line dedicated page reachable only through Cmd-K ('Linear (deep)'). For a commercial product this means untested, unowned surfaces remain shippable and crawlable, the bundle carries dead weight, and a curious user who finds /dashboard/trust sees lorem-style mock trust data presented in product chrome.

**Recommendation:** Move /dashboard/trust under /admin or behind the isAdmin gate (it already exists in the sidebar logic). Fold WhatsApp pairing into Settings > Integrations. Delete app/dashboard/components/ wholesale, and either delete projects/ai-projects or merge them as a tab of Actions. Keep Linear as a panel + palette entry but consider whether 1,627 lines of dedicated Linear UI belongs in an exec product at all.

### [MEDIUM] Acting on a signal always context-switches into chat

_Location: app/dashboard/signals/page.tsx (ACTIONS array, ~lines 575-610), app/dashboard/chat/page.tsx_

The signal thread detail offers five actions — Prepare me, Summarise, Draft response, Show risks, Relationship history — and every one is a router.push to /dashboard/chat?q=<canned prompt>. There is no inline reply, mark-handled, snooze, or convert-to-action on the thread itself, and after the chat detour the user has lost their place in the signal list. Chat does have real tools (draftEmail, addAction, completeAction, send/schedule with approval), so the capability exists — it's just only reachable by abandoning the surface where the need arose. Combined with the briefing page's text-only sections (no entity deep-links into the actions/decisions they reference), the journey is read-here, act-elsewhere across the whole product.

**Recommendation:** Embed the chat tool-loop inline: render 'Draft response' and 'Summarise' results in a slide-over panel on the Signals page (the chat API already supports tool approval), and add one-tap thread dispositions (done / snooze / make action). In the briefing, link each section item to its entity (action, decision, meeting, contact) rather than plain text.

### [MEDIUM] Home metrics double-count one signal list and inflate alarm

_Location: app/dashboard/page.tsx lines ~1742-1754 (criticalCount, unreadThreads, risksDetected) and MetricBar usage ~1807-1816_

The five hero metrics derive from the same arrays with overlapping thresholds: 'Critical' = high/urgent actions + signals scoring >0.7; 'Threads' = signals.length labeled 'Across all sources'; 'Risks' = signals scoring >0.3 — which in practice is nearly every signal, so the same item can appear in Critical, Threads, AND Risks simultaneously. A user with 40 routine emails sees 'Risks: 35' in red every morning. The adjacent 'AI Confidence' widget is similarly a volume heuristic (signal count + contact count) presented as model confidence. For an executive product whose currency is trust in the numbers, crying wolf in the first screen erodes exactly that, and the first-90-seconds read becomes 'everything is on fire' rather than 'here are the 3 things that matter'.

**Recommendation:** Make the metrics mutually exclusive and decision-oriented: Needs reply today, Meetings to prep, Overdue actions, Waiting on others, and one true Risks count (contradiction/at-risk relationship signals only). Rename or remove 'AI Confidence' — if kept, base it on the trust-envelope corroboration data that already exists in core/primitives/trust-envelope.

### [MEDIUM] The personality/influence layer — the differentiator — is buried three levels deep

_Location: app/dashboard/contacts/page.tsx (~705-770, Personality tab), app/dashboard/meetings/[eventId]/page.tsx (~359, attendeeInsights), app/dashboard/page.tsx (~1709-1722, client-side trend heuristic)_

The vision's signature promise ('understand the people in their organization, how to influence them') surfaces only as the second tab inside a contact detail inside the Relationships page, plus a Quick Profile block in meeting prep. There is no path from home, briefing, or signals to influence guidance — the home Relationship panel shows only a trend sparkline whose 'strengthening/cooling/at-risk' labels are computed client-side from raw counts (daysSince>14 = at-risk, count>=10 = strengthening), i.e., heuristic dressing rather than the real personality intelligence the product has elsewhere. A new user could use Basil for weeks without discovering its most differentiating feature.

**Recommendation:** Surface influence at the point of action: show 'How to approach <person>' chips on signal threads and in the briefing's People & Accounts section, link home relationship rows directly to the Personality tab (?tab=personality), and replace the client-side trend heuristic with the server-side relationship score that already exists in lib/relationship/score. Consider a 'Before you hit send' personality hint in the chat draftEmail flow.

### [LOW] Mobile journey hides Ask Basil and the intelligence surfaces

_Location: components/mobile-bottom-nav.tsx_

Mobile primary tabs are Home / Briefing / Actions / Schedule / More. Ask Basil — the desktop sidebar's visually dominant primary CTA and the only place users can act on signals — is buried behind the More drawer, as are Signals, Relationships, and Decisions. For the on-the-go executive persona (arguably the primary mobile use case is 'brief me before this meeting' and 'ask Basil something'), the chat entry point requiring two taps is a conversion leak, and there is no floating chat affordance to compensate.

**Recommendation:** Replace one tab (Actions is the best candidate — it's reachable from Home metrics) with Ask Basil, or add a floating chat FAB on mobile. Verify the More drawer orders Signals and Relationships above Settings.

### [LOW] First-screen ceremony outweighs intelligence density

_Location: app/dashboard/page.tsx (HeroLight ~lines 100-241, hero block ~1760-1802)_

The first ~300px of the morning screen is a decorative light-rays illustration, an oversized italic first-name greeting (clamp 3.5-5.5rem), and a date — before any intelligence appears. The briefing panel preview then truncates each section to one line of ~130 chars. On a 13-inch laptop the actionable rows (threads, relationships, intelligence) sit below the fold. The aesthetic is genuinely distinctive and worth keeping, but in its current proportion it taxes the exact 90 seconds the product is supposed to optimize.

**Recommendation:** Compress the hero to ~120px (smaller name, keep the atmosphere as a background), and promote the single most critical item of the day ('Your 10:00 with Acme needs prep — 2 attendees you haven't met') into the hero as a one-line lede with a CTA. The data for this already exists in briefing.criticalToday.

## polish — grade C

Basil has genuinely strong polish infrastructure for a solo-built product: a working Cmd-K command palette, a real (not vestigial) PWA with sensible caching strategies, broad skeleton-loader adoption, and a well-designed unified DataState component with error-kind-specific messaging and retry. However, execution is inconsistent in ways users will hit on day one: the Schedule page — one of four mobile bottom-nav tabs — has zero responsive handling and is effectively unusable on phones; the flagship dashboard home is hard-coded to dark-mode colors (167 hex literals) despite shipping a light-mode toggle; faded text (opacity 30-50% on midnight backgrounds) fails WCAG contrast across hundreds of instances; and many API failures are console-only because there is no global toast system and the DataState component is adopted in only 5 of 19 pages. All 19 dashboard pages are "use client" monoliths (8 over 1,000 lines; settings confirmed at 1,566), with raw useEffect fetch patterns everywhere except the home page's SWR. The happy path on desktop dark mode feels commercial; everything outside it degrades visibly.

**Strengths:**

- Command palette (components/command-palette.tsx, 203 lines) is real and well-built: cmdk + Radix dialog, Cmd/Ctrl-K binding, external-open custom event, fuzzy filtering, 'Ask Basil' query passthrough to chat, quick-action entries, and Esc/Enter hints
- PWA is real, not vestigial: complete app/manifest.ts (maskable icons, shortcuts, screenshots, standalone display), public/sw.js with correct strategies (cache-first static, network-only /api, network-first pages with offline fallback), deferred registration, branded offline page, standalone-mode chrome adjustments, and safe-area insets throughout
- Mobile shell is thoughtfully designed: components/mobile-bottom-nav.tsx (4 primary tabs + More opening the sidebar Sheet), aria-label on nav, env(safe-area-inset-bottom) padding, active-tab pips, and a separate mobile layout branch in app/dashboard/layout.tsx
- components/ui/data-state.tsx is a standout: unified loading/error/empty/stale states with a FetchErrorKind taxonomy (auth, permission, timeout, network, server), kind-specific guidance, sign-in and retry actions, and a stale-data banner
- Skeleton loading is broadly present (~25 files use Skeleton/animate-pulse); home page uses SWR with per-panel skeletons and placeholder-sized metric tiles that avoid layout shift
- Dashboard home parallelizes data via 7 independent useSWR hooks (no waterfall), and briefing page batches 6 status fetches in Promise.all
- Auth login form has proper label htmlFor/id pairs, autoComplete attributes, and autoFocus; prefers-reduced-motion is handled in globals.css; html lang is set; theme toggle has aria-labels
- Empty states exist for day-0 users on key pages (projects 'No projects yet', memory 'No memory yet', home cards with 'connect your accounts' guidance, contacts WhatsApp-path empty state)

**Findings:**

### [HIGH] Schedule page is broken on mobile despite being a primary bottom-nav tab

_Location: /Users/michaelcook/execautoclaude/app/dashboard/schedule/page.tsx (line 457; zero sm:/md:/lg: breakpoints in 706 lines)_

The schedule page renders a fixed-width 'w-60 shrink-0' mini-calendar sidebar next to the main calendar grid with no responsive handling whatsoever (grep finds zero breakpoint classes and no isMobile/useMediaQuery logic). On a 390px phone the sidebar consumes 240px, leaving ~150px for the week/day grid. Schedule is one of the four tabs in mobile-bottom-nav.tsx, so this is a first-session mobile experience for a product that ships a mobile-first PWA manifest.

**Recommendation:** Hide the aside below lg (hidden lg:flex) and surface the mini-calendar via a Sheet or popover on mobile; default mobile to a single-day agenda view. Add a Playwright viewport test at 390px for all four bottom-nav tabs.

### [HIGH] Dashboard home is hard-coded dark-mode-only while the app ships a light-mode toggle

_Location: /Users/michaelcook/execautoclaude/app/dashboard/page.tsx (167 hard-coded hex colors, 248 total literals incl. bg-white/[0.0x] and rgba() inline styles); light tokens defined in app/globals.css:266-278_

The flagship home page styles panels, text, skeletons, and the PanelModal with literal dark-theme colors (#AAB3C5, #C8A96B, rgba(13,26,52,...), bg-white/[0.05]) instead of theme tokens. globals.css defines a full light palette and ThemeToggle (next-themes) is mounted in both desktop and mobile layouts, so any user who taps the sun icon gets a visually broken home page — dark-tuned translucent whites and low-alpha grays on a #f5f4f0 background. Every other dashboard page uses tokens correctly (0 hex literals), making home the outlier.

**Recommendation:** Migrate home page colors to the existing CSS variables (bg-card, text-muted-foreground, border-border, plus custom tokens for the gold accent). If the home page is intentionally dark-only, force the dark class on its container — but per-page forced themes are worse than tokenizing.

### [HIGH] Systematic WCAG contrast failures from opacity-faded text on the midnight background

_Location: App-wide: 21 uses of text-muted-foreground/30, 40 of /40, 44 of /50 across app/dashboard and components; hard-coded #AAB3C5/40 empty states in app/dashboard/page.tsx:488,888,975,1132,1323,1358,1416_

Dark mode muted-foreground (#C6CEDB) on background #07111F passes at full opacity (~10:1), but the codebase routinely applies 30-50% opacity: /40 blends to roughly 2.7:1 and /30 to about 2:1 — far below the 4.5:1 AA minimum (and below 3:1 large-text). These faded styles are used for load-bearing content: empty-state messages, timestamps, sublabels, and the home page's 'No briefing yet' / 'No threads yet' guidance that day-0 users must read. This is a compliance exposure for commercial sale (ADA/EAA procurement checklists).

**Recommendation:** Establish a floor: never below /60 for any readable text (≈4.6:1 on this palette); reserve /30-/50 for decorative separators and disabled states only. Add an axe-core Playwright pass to the e2e suite to prevent regression.

### [MEDIUM] API failures are frequently invisible to users — no global toast system, console-only catches

_Location: /Users/michaelcook/execautoclaude/app/dashboard/settings/page.tsx:199 (readiness fetch logs to console, UI shows nothing), app/dashboard/contacts/page.tsx:325,350, app/dashboard/layout.tsx (settings guard catch), plus ad-hoc per-page 'toasts' in actions/page.tsx:1724 and linear/page.tsx:894_

There is no app-wide notification primitive: sonner/Toaster is absent from package.json and layouts, and the three pages that mention 'toast' each hand-roll their own (undo toast, forward toast). Many catch blocks log structured errors to console and stop — e.g. settings' readiness fetch failure leaves the tab silently stale, and contacts' JSON-parse failures are console-only. The excellent DataState error taxonomy exists but is imported by only 5 of 19+ dashboard pages, so most fetch failures render either nothing or a hand-rolled inconsistent state.

**Recommendation:** Add sonner (or equivalent) mounted once in the dashboard layout; route basil-fetch failures that have no inline surface through it. Mandate DataState for all card-level fetches — it already handles every error kind.

### [MEDIUM] app/error.tsx renders <html>/<body> — invalid nesting when a route errors, and no dashboard-level error boundary

_Location: /Users/michaelcook/execautoclaude/app/error.tsx (component named GlobalError, renders full <html> document); no app/global-error.tsx, no app/dashboard/error.tsx, no loading.tsx anywhere_

The file is written as a Next.js global-error (it returns <html lang="en"><body>...) but is named error.tsx, so Next renders it inside the root layout's existing <html>/<body> — producing nested document elements, hydration errors, and broken styling exactly when the user is already experiencing a crash. Root-layout errors themselves have no global-error.tsx to catch them. Additionally, with no dashboard/error.tsx, any page crash replaces the entire shell including navigation, stranding the user.

**Recommendation:** Rename the current file to app/global-error.tsx; create a layout-preserving app/error.tsx and an app/dashboard/error.tsx that keeps the sidebar/bottom-nav so users can navigate away from a crashed page.

### [MEDIUM] All 19 dashboard pages are 'use client' monoliths; 8 exceed 1,000 lines (settings confirmed at 1,566)

_Location: app/dashboard/page.tsx (1,876), actions (1,746), linear (1,627), settings (1,566), contacts (1,558), signals (1,128), memory (1,103), chat (1,030); 21,194 lines total across dashboard pages_

Every dashboard route opts its entire tree out of server rendering. First navigation paints nothing until the client bundle parses and useEffect fetches resolve (no route-level loading.tsx exists to stream a shell). Only the home page uses SWR; the rest use raw fetch-in-useEffect (settings has 14 fetch call sites across 5 effects, actions 12, briefing 9), so there is no request deduplication, cache, or revalidation, and the dashboard layout adds its own client-side /api/settings auth-guard fetch on every mount. Maintainability cost is already visible: the per-page inconsistency in error/empty handling tracks directly with file size.

**Recommendation:** Split each page into a server page.tsx that fetches initial data plus focused client islands; adopt SWR (already a dependency) for all client fetches per the async-parallel and client-swr-dedup best-practice rules; add loading.tsx skeletons per route segment. Start with settings — its Tabs structure decomposes naturally.

### [MEDIUM] Hand-rolled PanelModal lacks dialog semantics, focus trap, and scroll lock

_Location: /Users/michaelcook/execautoclaude/app/dashboard/page.tsx:396-435 (PanelModal), used by 6 expanded panels; Escape handled by a separate page-level listener_

The home page's panel-expansion modal is a fixed-position div with no role="dialog", no aria-modal, no focus trap, no focus restoration on close, and no body scroll locking. Keyboard and screen-reader users can tab straight through the overlay into the obscured page. The project already ships Radix Dialog (used correctly by the command palette and mobile Sheet), so this is an avoidable inconsistency on the most-visited page.

**Recommendation:** Replace PanelModal with the existing shadcn Dialog/Sheet primitives, which provide focus management, semantics, and scroll lock for free.

### [MEDIUM] Icon-only buttons widely missing accessible names (267 buttons vs 28 aria-labels in dashboard)

_Location: Examples: app/dashboard/contacts/page.tsx:396,399 (icon-only save/cancel name edit), settings/page.tsx (1,566 lines, zero aria-labels — copy buttons rely on title only), app/(auth)/login/page.tsx:242 (forgot-password label missing htmlFor/id)_

Across app/dashboard there are ~267 button elements but only 28 aria-label attributes. Many are icon-only (Check/X edit controls, Copy pills, chevrons, refresh buttons) and announce as 'button' to screen readers. Only 2 aria-live regions exist app-wide despite constant async content swaps, so loading/saved/error transitions are silent to assistive tech.

**Recommendation:** Sweep icon-only buttons for aria-label (an eslint-plugin-jsx-a11y rule catches this); add aria-live="polite" to save-state indicators and DataState transitions; fix the forgot-password label association.

### [LOW] Service worker has no user-facing update flow and a hard-coded cache version

_Location: /Users/michaelcook/execautoclaude/public/sw.js (CACHE_NAME="basil-v1"), components/pwa/service-worker-register.tsx:27 (update detection logs to console only)_

The PWA is otherwise production-quality, but when a new service worker installs, the only signal is a console.log — standalone-mode users (who never hard-refresh) can run stale UI indefinitely. CACHE_NAME is manually versioned, so forgetting to bump it on asset-affecting deploys risks serving stale precached resources.

**Recommendation:** Show a small 'Update available — refresh' toast/banner when newWorker.state === 'installed', wired to skipWaiting + reload; derive CACHE_NAME from the build ID at deploy time.

### [LOW] Empty-state quality is inconsistent: designed on some pages, low-contrast one-liners on the flagship

_Location: DataState/EmptyState adopted in only 5 files (delta, decisions, actions, signals-feed, pulse-strip); home page day-0 text at app/dashboard/page.tsx:888,975,1358,1416 rendered at #AAB3C5/40 and rgba(150,130,80,0.35)_

Day-0 users land on the home dashboard where 'No threads yet — connect your accounts' and 'No relationship data yet' are rendered at roughly 2.4:1 contrast with no call-to-action button, while projects and memory pages have full designed empty states with headings. The connect-your-accounts guidance — the single most important day-0 action — is among the least visible text in the app.

**Recommendation:** Use the existing EmptyState component (icon + title + description) for home-page panels and add a 'Connect accounts' button linking to /dashboard/settings, turning the day-0 dashboard into an onboarding surface.

## security-auth — grade C

Per-tenant isolation is genuinely solid: every one of the 15 sampled mutating routes (contacts, actions, events, settings, memory, decisions, calendar, slack, linear) resolves the username from the session cookie via getSessionUser/requireUser and passes it into username-scoped stores, so id-addressed routes (e.g. contacts/user/[id], decisions/[id]) cannot reach another tenant's data — no route trusts a client-supplied username/id for cross-tenant access. OAuth tokens are AES-256-GCM encrypted at rest (secure-token-store, fail-closed crypto), webhook signatures are correctly HMAC-verified for Slack/Linear/Zoom/Stripe/QStash, security headers are present, and prior sprints landed real controls (sessionVersion revocation, bcrypt-12, AUTH_SECRET/SKIP_AUTH production guards, account-enumeration-safe forgot-password). However the build ships at least one blocker: /api/auth/forgot-password returns the live reset-token URL in the HTTP response body unconditionally, enabling trivial account takeover for anyone who knows a target's email. Combined with a hardcoded default admin password, fail-open Gmail/Calendar webhooks, OAuth flows with no CSRF state parameter, in-memory (per-instance, IP-spoofable) rate limiting on auth endpoints, and a logout that does not revoke the 30-day token server-side, this is not yet commercial-ready.

**Strengths:**

- Strong multi-tenant scoping: all 15 sampled mutating routes derive username from the session (getSessionUser/requireUser) and delegate to username-scoped stores; id-addressed mutations return 404/null when the id is outside the caller's namespace rather than acting cross-tenant.
- OAuth/integration tokens (Google/Microsoft/Slack/Zoom/Linear + AI providers) are AES-256-GCM encrypted at rest via secure-token-store with fail-closed crypto (missing BASIL_TOKEN_ENCRYPTION_KEY throws); no plaintext token storage and transparent legacy migration.
- Webhook signature verification is correct and constant-time where it matters: Slack HMAC with 5-min replay window + timingSafeEqual, Linear per-user HMAC (multi-tenant safe), Zoom HMAC, Stripe provider.parseWebhookEvent, and QStash signature verification on the jobs handler.
- No secrets leak into the client bundle — grep of NEXT_PUBLIC_* shows only URLs and a display-only admin-username label, never tokens or keys.
- Good baseline session hardening: sessionVersion-based revocation, disabled-account check on every verify, bcrypt cost 12 with plaintext auto-upgrade, AUTH_SECRET required in production (module-load throw), SKIP_AUTH blocked in production, and account-enumeration-resistant forgot-password.
- Security headers configured (HSTS preload, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy, Permissions-Policy, CSP), and admin API routes consistently enforce isAdminUser server-side.

**Findings:**

### [BLOCKER] Password-reset token returned in HTTP response body — trivial account takeover

_Location: app/api/auth/forgot-password/route.ts:120-124_

The forgot-password handler builds resetUrl = `${base}/reset-password?token=${token}` and returns it in the JSON response (`return NextResponse.json({ ok: true, emailSent, resetUrl })`) UNCONDITIONALLY — the code comments document this as an intentional 'fallback for no-email setups.' Any unauthenticated party who POSTs a known email or username receives the live, one-hour reset token directly in the response, then POSTs /api/auth/reset-password to set a new password — no inbox access required. The only barrier is an in-memory per-IP 10/min rate limit, which is per-instance and IP-spoofable. This is a complete pre-auth account takeover for any known account, including the admin.

**Recommendation:** Never return the reset token/URL to the client. Remove resetUrl from the response and rely solely on the emailed link. If a no-email bootstrap path is truly required, gate it behind NODE_ENV !== 'production' AND an admin token, and log it as a privileged action.

### [HIGH] Hardcoded default admin password with no production guard

_Location: lib/users.ts:71 (getUsers env-admin fallback)_

getUsers() synthesizes an env-admin account using `process.env.APP_PASSWORD || "execauto2024"` and `process.env.ADMIN_USERNAME || "admin"`. Unlike AUTH_SECRET and SKIP_AUTH (which throw in production), there is NO production guard here. If APP_PASSWORD is unset on a production deploy, the publicly-known credentials admin/execauto2024 grant a working login that isAdminUser() then treats as the privileged admin — full admin access including /api/admin/users, export-state, emergency-reset, feature-flags.

**Recommendation:** Throw at boot in production if APP_PASSWORD (and ADMIN_USERNAME) are not explicitly set, mirroring the AUTH_SECRET guard. Remove the literal 'execauto2024' default entirely so a misconfigured deploy fails closed rather than shipping a known password.

### [HIGH] Gmail and Calendar webhooks fail OPEN when their shared-token env vars are unset

_Location: app/api/webhooks/gmail/route.ts:42-48; app/api/webhooks/calendar/route.ts:24-27_

Both endpoints guard with `if (process.env.GMAIL_PUBSUB_TOKEN && sent !== expected) return 403` (and the calendar equivalent with CALENDAR_WATCH_TOKEN / x-goog-channel-token). When the env var is absent the entire check is skipped and ANY unauthenticated POST is accepted, allowing attackers to inject forged push notifications that drive ingestion, dead-letter writes, and event creation for a resolved user. This contrasts with Slack/Linear/Zoom/Stripe which fail closed. Additionally the mechanism is a static shared token (not HMAC over the body), and the Gmail token travels in the URL query string where it is prone to logging.

**Recommendation:** Fail closed: if the verification secret is not configured, reject (or refuse to register the watch). Prefer real signature verification — Gmail Pub/Sub supports a Google-signed OIDC JWT (verify against GMAIL_PUBSUB_AUDIENCE) rather than a query-string token; for Calendar, treat the channel token as required and compare with timingSafeEqual.

### [MEDIUM] OAuth flows lack a CSRF state parameter

_Location: app/api/auth/google/route.ts:21-22 (getAuthUrl with no state); app/api/auth/google/callback/route.ts:17,34 (binds tokens to session user, no state validation); same pattern for microsoft/zoom/slack/linear_

The Google OAuth init builds the consent URL via getAuthUrl() with no anti-CSRF state value, and the callback resolves the account purely from the current session cookie and exchanges whatever `code` arrives. With no state to validate, a logged-in victim lured to a crafted callback URL carrying the attacker's authorization code will have the attacker's Google (or Slack/Zoom/etc.) account silently connected to the victim's Basil account — an OAuth login-CSRF / account-confusion that can route the victim's data through an attacker-controlled integration.

**Recommendation:** Generate a cryptographically random state, store it in a short-lived httpOnly cookie at init, include it in the authorize URL, and reject the callback if the returned state is missing or does not match. Apply uniformly across Google/Microsoft/Zoom/Slack/Linear.

### [MEDIUM] Auth endpoints use the weak in-memory rate limiter, not the durable one

_Location: app/api/auth/route.ts:9; app/api/auth/register/route.ts:11; app/api/auth/forgot-password/route.ts:81; app/api/auth/reset-password/route.ts:17_

Login, register, forgot-password and reset-password all call checkRateLimit() (a module-level in-memory Map, per-instance) keyed on getClientIp() from x-forwarded-for. On Vercel's multi-instance/Fluid Compute runtime the in-memory counter is not shared across instances, so an attacker spreading requests across concurrent instances multiplies the effective quota; the key is also a spoofable forwarded header. The codebase already ships checkRateLimitDurable() (Upstash sliding window, cross-instance) but none of the auth routes use it.

**Recommendation:** Switch all credential and reset endpoints to checkRateLimitDurable() so limits are enforced cluster-wide, and add tighter dedicated buckets (e.g. forgot/reset 5/hour). Key forgot/reset on the target account in addition to IP to slow targeted enumeration/abuse.

### [MEDIUM] Logout does not revoke the session server-side; 30-day tokens with no rotation

_Location: lib/auth.ts:24-38 (30d JWT), 113-115 (destroySession only deletes cookie); app/api/auth/route.ts:42-45 (DELETE)_

Sessions are 30-day JWTs with no rotation, sliding expiry, or idle timeout. destroySession()/DELETE only deletes the cookie in the caller's browser — it does NOT bump the user's sessionVersion. A token captured from logs, a shared device, an XSS exfil, or a proxy therefore remains valid for the full 30 days even after the user clicks 'log out.' The sessionVersion revocation mechanism exists (used on password change and admin revoke) but is not wired into logout.

**Recommendation:** On logout, bump sessionVersion (or maintain a per-session jti denylist) so the presented token is immediately rejected. Shorten the access token lifetime (e.g. 1-7 days) with refresh/rotation, and consider an idle timeout for an exec-assistant handling sensitive mailbox/calendar data.

### [LOW] Admin UI has no server-side guard — protection depends entirely on each admin API checking isAdminUser

_Location: app/admin/layout.tsx:1 ("use client"); app/admin/page.tsx:1 ("use client")_

The /admin layout and page are client components that gate access by fetching /api/admin/users and redirecting on 403. No Server Component / middleware check protects the admin surface. Data is currently safe because each admin API route independently enforces `getSessionUser() && isAdminUser()`, but the design has no defense-in-depth: any future admin API added without that check is immediately exposed, and the page shell itself renders for non-admins until the client fetch resolves.

**Recommendation:** Add a server-side guard (Server Component or middleware) for /admin/* that calls getSessionUser()+isAdminUser() and redirects unauthenticated/non-admin users before render, so admin gating does not rely solely on per-route discipline.

### [LOW] CSP allows 'unsafe-inline' and 'unsafe-eval'; edge proxy falls back to dev AUTH_SECRET

_Location: next.config.ts (script-src 'unsafe-inline' 'unsafe-eval'); proxy.ts:46 (AUTH_SECRET || "dev-secret-change-me")_

The Content-Security-Policy permits 'unsafe-inline' and 'unsafe-eval' in script-src, materially weakening the CSP as an XSS mitigation (acknowledged in-code as a Next.js constraint). Separately, the edge proxy validates session JWTs with `process.env.AUTH_SECRET || "dev-secret-change-me"` independently of lib/auth.ts's production throw; the app is saved only because auth.ts refuses to boot without AUTH_SECRET, but the middleware itself would happily accept dev-secret-signed tokens.

**Recommendation:** Move to a nonce/hash-based CSP to drop 'unsafe-inline' (and 'unsafe-eval' where feasible) once the App Router migration cost is acceptable. Remove the 'dev-secret-change-me' fallback in proxy.ts so the middleware also fails closed without AUTH_SECRET.

---

# Hands-on walkthrough findings (live app, 10 June 2026)

Corroborated by driving the dev build at localhost:3001 as user michael:

- **Dev environment was broken** — a stray `~/package.json`/`package-lock.json` (accidental `npm i @vercel/analytics` in $HOME, May 2026) made Turbopack infer the wrong workspace root; `next dev` could not resolve tailwindcss. Fixed: stray manifests renamed to `*.stray-bak`, `turbopack.root` pinned in next.config.ts.
- **proxy.ts ignores SKIP_AUTH** — the dev bypass works at the API layer but the middleware still bounces pages to /login; the two auth layers disagree about the bypass.
- **Model IDs leak into user-facing UI** — “Brain ready · anthropic/claude-haiku-4.5” on Briefing, a teal monospace “AI ready · anthropic/claude-haiku-4.5” banner on chat. Engineering showing through the product veneer.
- **Env-var names leak into Settings copy** — “BASIL_TOKEN_ENCRYPTION_KEY is set”, “ANTHROPIC_API_KEY is set”. Plus two stacked, contradictory readiness banners (33% vs 50%).
- **Mobile home has a layout collision** — “AI CONFIDENCE / Low” overlaps the GOOD AFTERNOON eyebrow; the stat-tile row clips mid-tile.
- **Light mode is half-converted** — shell goes light, every card stays hardcoded dark. Confirms the dark-only-for-v1 recommendation.
- **Empty states are passive dead ends** — Signals says “surface once Basil has processed enough signals” with no connect-integrations CTA.
- **The good news is real** — the auth shell, home masthead, Briefing tabs, and Relationships three-pane already carry a genuinely premium midnight+gold identity. The redesign extends what exists; it does not start over.
