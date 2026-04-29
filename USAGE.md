# Basil — Usage Guide

Practical reference for working with Basil day-to-day.

---

## Working with memory

Basil remembers facts, preferences, people, and active context across conversations. Everything is stored explicitly — nothing is inferred without your involvement.

### Operative memory categories

| Kind | What it holds | Example |
|---|---|---|
| `preference` | How you like things done | "I prefer bullets over prose in all briefings" |
| `fact` | Durable, verifiable details | "I'm CEO of AnalystGenius. There's another Michael at TalentGenius." |
| `person` | Notes on specific people | "Isaac: runs day-to-day ops at AG. Direct reports: Ed, Maya." |
| `context` | Active projects and ongoing situations | "Pricing model v3 is being revised with Isaac — deadline end of month" |

### Slash commands

**Store something:**
```
/remember I prefer Zoom for all video calls — never Google Meet
/remember Isaac Frank joined AnalystGenius in Jan 2025 as COO
```

**Search memory:**
```
/recall Zoom
/recall pricing model
/recall Isaac
```

**See everything stored:**
```
/memory-list
/memory-list preferences
/memory-list people
```

**Delete a memory:**
```
/forget Google Meet preference
/forget abc123-uuid
```
Basil always shows a preview and requires "yes, delete" before removing anything.

**Reclassify a memory:**
```
/memory-promote abc123-uuid fact
```
(Changes the kind of a stored record within the operative categories.)

**Run a health check:**
```
/memory-audit
```
Checks for stale records (>90 days), conflicts, potential misclassification, and budget pressure.

### Dashboard

The `/dashboard/memory` page lets you view, edit, delete, and import memories via a browser UI.

The dashboard home page shows a **Memory panel** in the "Your Day" section with:
- Per-category counts
- Last 5 ingested memories
- Quick recall search
- Quick ingest input

### Memory import

Paste any text — AI conversation exports, personal notes, project documents — into the Memory tab's import field. Basil will extract facts, preferences, context, and people notes automatically.

Supported file types for upload: `.txt`, `.md`, `.json`, `.csv` and any other plain-text format.

### How memory influences conversations

Every Basil conversation includes your stored memories in the system prompt. The most recent 40 records (10 per kind) are injected automatically. You don't need to re-explain your preferences or context — Basil carries them forward.

---

## Aspirational features (not yet live)

These are defined in `basil/memory/SPEC.md` and will be built out:

- **Knowledge base** — semantic retrieval of large documents and research. Not yet operative.
- **Workspace buffer** — 7-day TTL context for drafts and time-bound notes. Not yet operative.
- **Vector embeddings** — cosine-similarity retrieval. Pending embedding provider setup.

---

## Proactive Basil

Basil watches your Gmail, Slack, and Calendar automatically. The "Basil is watching" panel on the dashboard shows:

- **Needs approval** — drafts waiting for sign-off
- **Heads up** — notifications that haven't been acknowledged  
- **Handled silently** — auto-filed items that didn't need you

Click **Sync** to pull the latest from all integrations. Click any item to open the approval panel.

---

## Chat

`/dashboard/chat` — full conversation interface. Basil has access to your calendar, email, contacts, decisions log, and memory in every chat session.

Keyboard shortcut from the dashboard home: type in the search bar and press ⏎ to jump straight into chat with your query.

---

## Settings

`/dashboard/settings` — connect integrations (Gmail, Slack, Calendar, Google Drive), manage your timezone, and configure notification preferences.
