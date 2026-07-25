# Repo Audit — execautoclaude

_Generated 2026-04-17. Purpose: label which files belong to which product before potential separation._

---

## Verdict: One product, two names

This repo contains **only Basil** — the personal executive-assistant app. There is **no FedSpend code** anywhere in this repository.

The confusion came from the folder name (`execautoclaude`) not matching the app name (`Basil`). The app title, branding, logo, and all UI copy say "Basil" throughout.

**Historical note:** The app was previously called "Sage" — `localStorage` keys like
`sage-contact-activity` and `sage-contact-suggestions` are leftovers from that era.

---

## Product mapping

### Basil (100% of this repo)

**What it is:** A single-user executive assistant for its owner. Connects to Google
Calendar, Gmail, Google Drive, Slack, and WhatsApp. Uses Claude AI to brief, schedule,
draft, and track decisions.

Deployed to **https://ag-contracts.vercel.app** (Vercel project: `ag-contracts`).

#### Pages (app/dashboard/)

| Route | Description |
|---|---|
| `/dashboard` | Home: greeting, calendar pulse, signals, relationships |
| `/dashboard/briefing` | AI-generated daily briefing from all sources |
| `/dashboard/chat` | Chat with Basil + tool-use approval UI |
| `/dashboard/contacts` | Work & personal contact directory with personality profiles |
| `/dashboard/decisions` | Decision log (auto-extracted + manual) |
| `/dashboard/digest` | Weekly retrospective by product (AG / TG) |
| `/dashboard/memory` | Basil's persistent memory store |
| `/dashboard/schedule` | Calendar with Basil-proposed meetings |
| `/dashboard/settings` | Google / Slack / Claude API connection status |
| `/dashboard/whatsapp` | WhatsApp QR link + chat browser + contact import |
| `/dashboard/actions` | Action tracker (commitments from meetings/email/Slack) |
| `/dashboard/meetings` | Upcoming meetings list |
| `/dashboard/meetings/[eventId]` | AI meeting-prep cheatsheet |

#### API routes (app/api/)

All routes are Basil-only: auth, calendar, email, memory, chat, briefing/digest/meeting-prep
generation, Slack, contacts, actions, decisions, drive, events/audit bus, webhooks (Google +
Slack), WhatsApp dump, and cron subscription renewal.

#### Components

All Basil-only: `app-sidebar`, `extra-context-input`, dashboard widgets (`now-panel`,
`pulse-strip`, `day-timeline`, `signals-feed`, `relationship-card`, `quick-actions`,
`basil-watching`, `calendar-card`, `email-card`, `slack-card`, `approval-panel`), and a full
shadcn/ui library.

#### Lib

All Basil-only: Google auth/calendar/gmail/drive, Slack client, WhatsApp dump job, AI tools +
system prompt, contacts data + lookup, memory/actions/decisions stores, event bus,
self-identity filter, utilities.

---

### FedSpend

**Not present in this repo.** Zero files, zero routes, zero references.

The `ag-contracts.vercel.app` URL points to *this* Basil repo — not a separate FedSpend
product. The project was likely named `ag-contracts` before it became Basil.

---

## Shared / ambiguous files

None — everything is cleanly Basil.

The UI component library (`components/ui/`) is generic shadcn/ui code that could be shared
with any product, but is currently only used by Basil.

---

## Legacy name references (safe to leave, low priority)

Holdovers from when Basil was called "Sage":
- `localStorage` keys: `sage-contact-activity`, `sage-contact-suggestions`
  (in `app/dashboard/contacts/page.tsx` and `lib/user-contacts.ts`)
- These don't affect functionality — cosmetic only.

---

## Deployment status

- **Live at:** https://ag-contracts.vercel.app (Vercel project: `ag-contracts`)
- **Deployed via:** Vercel CLI directly (no GitHub remote connected)
- **To redeploy:** `vercel --prod` from the project root
- No `.vercel/project.json` in the working copy — run `vercel link` first to re-link.

---

## Secrets / environment files

- `.env.local` — contains API keys (Google OAuth, Slack, Anthropic, etc.)
- Already excluded from git via `.gitignore` (`.env*` pattern)
- `.data/` — runtime JSON stores (tokens, actions, decisions, memory); also gitignored
