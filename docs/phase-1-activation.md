# Phase 1 — owner activation steps

Phase 1 hardened persistence, sessions, OAuth, and observability. Most of it is
live the moment it deploys. Three pieces are **activation-ready** — built and
wired, but inert until you provide infrastructure. Setting each env var turns
the feature on with zero code change; leaving it unset keeps today's behavior.

## 1. Upstash Redis — cross-instance locks + spend caps (recommended)

Already used for the AI spend counters (Sprint 3). It also now backs the
read-modify-write lock that prevents cross-instance data clobbering.

- Provision: Vercel dashboard → Storage → Upstash Redis (Marketplace).
- Env (auto-injected by the integration): `UPSTASH_REDIS_REST_URL`,
  `UPSTASH_REDIS_REST_TOKEN`.
- Without it: the lock falls back to an in-process mutex (correct for a single
  instance, best-effort across instances). Strongly recommended for production.

## 2. Postgres — durable transactional store (the move off flat-file JSON)

`lib/storage/adapters/postgres.ts` is a key-value backend `(scope, key) → jsonb`
that slots under the existing storage abstraction. When `DATABASE_URL` is set it
becomes the top-priority backend (above Blob), is the single consistent source
of truth (no /tmp cache staleness), and makes writes immediately durable.

- Provision: Vercel dashboard → Storage → Neon (Marketplace) — or any Postgres.
- Env: `DATABASE_URL` (Neon's pooled connection string). Optional `PGSSL=disable`
  for a local plaintext instance.
- The `basil_store` table is auto-created on first use.
- **Validate before relying on it.** This path cannot be exercised without a
  live database, so after setting `DATABASE_URL` on a preview deployment:
  sign up a test user, connect an integration, generate a briefing, and confirm
  the data round-trips. Then promote to production.
- Migrating existing Blob data into Postgres is a one-time copy (read each
  `basil/...` blob, write to `basil_store`); do this on a preview first.
- Backups: rely on your Postgres provider's PITR/snapshots (Neon has both). The
  Blob backup cron (`/api/cron/backup`) only covers the Blob backend.

## 3. Error webhook — alerting (optional)

`captureError` / `captureCronFailures` always log with a `[capture]` marker. Set
`ERROR_WEBHOOK_URL` (a Slack incoming webhook or Sentry-compatible endpoint) to
also push alerts — e.g. when a morning-briefing cron fails for a user.

## Other Phase 1 env (all optional)

- `AI_GLOBAL_MONTHLY_USD`, `AI_PER_USER_MONTHLY_USD` — spend ceilings (Sprint 3).
- `BACKUP_RETAIN_DAYS` (default 14) — Blob backup retention.
- `BLOB_SHRINK_GUARD_MIN` (default 5) — empty-overwrite tripwire threshold.

## Post-deploy smoke tests (can't run locally)

- OAuth connect for each provider (Google/Microsoft/Zoom/Slack) — confirms the
  new CSRF `state` round-trips and doesn't break the flow.
- Log out, then try the old session cookie — should be rejected (revoked).
