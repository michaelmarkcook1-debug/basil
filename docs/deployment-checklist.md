# Deployment Checklist

Use this checklist every time you ship Basil to production.  Work through it top to bottom — each section depends on the one before it.

---

## 1 · Before merging the pull request

These checks run automatically in CI, but confirm they are all green before you click **Merge**.

- [ ] **CI is passing** — the GitHub Actions workflow (Lint · Typecheck · Test · Build · Guards · E2E) shows a green tick on the PR.  A single red step means something is broken; do not merge until it is fixed.

- [ ] **Build succeeds** — the `npm run build` step completed without errors.  A failed build means the app would crash immediately on deploy.

- [ ] **No hardcoded users** — the `ci:guards` step passed.  This catches code that routes data to a literal username like `"michael"` or `"admin"` instead of reading the session, which would silently send one user's data to another.

- [ ] **No silent fetch failures** — the `ci:guards` step also scans for empty `catch(() => {})` blocks that swallow errors without logging.  If these are flagged, either add a `console.warn` or confirm the silence is intentional and annotated with `// ci-ok: <reason>`.

- [ ] **No route mismatch warnings** — the `linear-route-consistency` test confirms every client `fetch("/api/...")` call points to a route file that actually exists.  A mismatch produces a 404 at runtime with no error in the UI.

- [ ] **Persistence warnings reviewed** — the `persistence-warnings` test flags any code that writes data to `/tmp` without also writing to Vercel Blob.  Data written only to `/tmp` is lost on every cold start.  If flagged, either fix the write or add an annotation confirming the data is intentionally ephemeral.

---

## 2 · Before deploying to production

Run these checks after CI passes but before running `vercel --prod`.

### Environment variables

Open the Vercel dashboard → your project → **Settings → Environment Variables** and confirm every item below is set for the **Production** environment.  The `/api/health` endpoint (`https://ag-contracts.vercel.app/api/health`) returns a JSON object with `checks.env` showing `true`/`false` for each — use that as a quick audit.

**Core (app will not start without these)**
- [ ] `AUTH_SECRET` — random 32-character secret used to sign session cookies.  If this changes, all active sessions are invalidated.
- [ ] `APP_URL` — the full production URL, e.g. `https://ag-contracts.vercel.app`.  Used in OAuth callback URLs and email links.
- [ ] `ADMIN_USERNAME` / `APP_PASSWORD` — credentials for the primary admin login.
- [ ] `BLOB_READ_WRITE_TOKEN` — Vercel Blob token.  Without this, contact data, WhatsApp snapshots, and all user files are stored in `/tmp` only and are wiped on every cold start.

**AI providers (at least one required)**
- [ ] `ANTHROPIC_API_KEY` — Claude API key.  Used for profile generation, briefings, digests, and the AI chat.
- [ ] `OPENAI_API_KEY` — OpenAI key.  Only needed if `AI_PROVIDER_MODE` is set to `openai`.

**Google (Gmail + Calendar integration)**
- [ ] `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI`

**Microsoft (Outlook + Teams integration)**
- [ ] `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_REDIRECT_URI` / `MICROSOFT_TENANT_ID`

**Slack**
- [ ] `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET` / `SLACK_REDIRECT_URI`

**Zoom**
- [ ] `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET`

**Background jobs (QStash)**
- [ ] `QSTASH_TOKEN` / `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` — used for scheduled email processing and cron jobs.  Missing these means daily digests and memory imports will silently not run.

**Optional but expected in production**
- [ ] `CRON_SECRET` — protects the `/api/cron/*` endpoints from being triggered by anyone who guesses the URL.
- [ ] `TAVILY_API_KEY` — web search used in briefings and memory imports.

### OAuth callback URLs

Each connected service must have the production URL registered as an allowed redirect.  A mismatch produces an OAuth error page — the user cannot connect the integration at all.

- [ ] **Google** — in [Google Cloud Console](https://console.cloud.google.com/) → OAuth 2.0 credentials, confirm `https://ag-contracts.vercel.app/api/auth/google/callback` is listed as an authorised redirect URI.
- [ ] **Microsoft** — in [Azure App Registrations](https://portal.azure.com/), confirm `https://ag-contracts.vercel.app/api/auth/microsoft/callback` is listed.
- [ ] **Slack** — in [Slack App Settings](https://api.slack.com/apps), confirm `https://ag-contracts.vercel.app/api/auth/slack/callback` is listed under **Redirect URLs**.
- [ ] **Zoom** — in [Zoom App Marketplace](https://marketplace.zoom.us/), confirm the redirect URL matches `APP_URL`.

### Webhooks

Webhooks must point to production or events will be silently dropped.

- [ ] **Google Calendar push** — if a watch subscription is active, confirm `CALENDAR_WATCH_URL` in Vercel env matches `https://ag-contracts.vercel.app/api/webhooks/calendar`.  Re-register via `/api/webhooks/calendar/register` if the URL changed.
- [ ] **Microsoft Calendar / Mail webhooks** — confirm `MICROSOFT_CALENDAR_WEBHOOK_URL` and `MICROSOFT_MAIL_WEBHOOK_URL` point to the production domain.  Microsoft webhook subscriptions expire every 3 days — check whether a renewal is needed.
- [ ] **Slack Events** — in Slack App Settings → Event Subscriptions, confirm the Request URL is `https://ag-contracts.vercel.app/api/webhooks/slack`.

---

## 3 · After deploying — smoke test

Run these in the browser on the live production URL immediately after `vercel --prod` finishes.  Each one covers a real failure mode that CI cannot catch.

- [ ] **Health endpoint returns ok** — open `https://ag-contracts.vercel.app/api/health` in your browser.  Confirm `"ok": true` and that `checks.env` shows `true` for all expected keys.  Any `false` entry is a missing environment variable.

- [ ] **Login works** — go to `/login`, enter your credentials, confirm you land on `/dashboard` without errors.  A broken `AUTH_SECRET` or mis-set `APP_URL` will prevent login entirely.

- [ ] **Dashboard loads** — confirm the contacts list loads and the signals feed renders.  A blank page or spinner that never resolves usually means a failed API call — open the browser console and look for red network errors.

- [ ] **Settings page loads** — navigate to `/dashboard/settings`.  Confirm the page renders and the connected integrations panel shows the correct status.  A crash here often means a missing env variable for one of the OAuth integrations.

- [ ] **Contact save and reload** — open any contact, edit a field, navigate away, then return.  Confirm the edit persisted.  This tests the full write path: API → Vercel Blob → re-read on next page load.  If edits vanish after reload, `BLOB_READ_WRITE_TOKEN` is likely missing or invalid.

- [ ] **WhatsApp tab is idle on load** — navigate to `/dashboard/whatsapp`.  Confirm the **Start import** button is visible and no QR code or "loading contacts" spinner appears automatically.  If the page auto-starts an import, a regression has been introduced.

- [ ] **Action/decision/memory entries save** — create one new action item and one memory note.  Reload the page and confirm both still appear.  These are the most frequently lost items when Blob persistence is misconfigured.

- [ ] **Verify Vercel logs for errors** — in the Vercel dashboard, open the **Functions** log for the production deployment.  Look for any `[ERROR]` lines or unhandled exceptions in the first few minutes after deploy.  Pay attention to:
  - `[storage] Blob write failed` — means Blob is connected but a write is failing (token may have insufficient permissions).
  - `[auth]` errors — session or OAuth misconfiguration.
  - `[whatsapp]` errors — only relevant if a user has triggered an import.

---

## 4 · Rollback

If a production issue is discovered after deploy:

- [ ] **Revert to the previous deployment** — in the Vercel dashboard, go to **Deployments**, find the last known-good deployment, and click **Promote to Production**.  This takes effect in under 30 seconds and requires no code change.

- [ ] **Revert the PR if CI missed the issue** — if the bug was in merged code, open a new PR that reverts the offending commit (`git revert <sha>`).  Do not force-push to `main`.

- [ ] **Document the incident** — create `docs/incidents/YYYY-MM-DD.md` (use today's date) with:
  - What broke and how it was noticed
  - What the root cause was
  - How it was fixed
  - What test or check would have caught it earlier

  > Example: `docs/incidents/2025-06-01.md` — "WhatsApp tab auto-started import on load; caused by missing idle-state guard after refactor. Added E2E test `whatsapp-ux.spec.ts` to prevent regression."

---

## Quick reference — key URLs

| Purpose | URL |
|---------|-----|
| Production app | https://ag-contracts.vercel.app |
| Health check | https://ag-contracts.vercel.app/api/health |
| Vercel dashboard | https://vercel.com/dashboard |
| GitHub Actions | https://github.com/[your-org]/[your-repo]/actions |
| Google Cloud Console | https://console.cloud.google.com/ |
| Azure App Registrations | https://portal.azure.com/ |
| Slack App Settings | https://api.slack.com/apps |
| Zoom Marketplace | https://marketplace.zoom.us/ |

---

*Last updated: see git log.  If a step no longer applies or a new integration is added, update this file in the same PR.*
