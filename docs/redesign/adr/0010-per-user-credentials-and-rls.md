# ADR-0010: Per-user credentials only; row-level security

## Status
Accepted — Michael confirmed other users get **completely separate** data (2026-10-14)

## Context
Shared env-var credentials (`GOOGLE_TOKENS`, `SLACK_*_TOKEN`) were a fallback for every login, so two other logins ingested Michael's mail and Slack (fixed 6e123cf, owner-only). A refresh copied Michael's token into their storage. The user records' encryption key was missing locally, and tooling worked around it.

## Decision
- **Credentials are per user only,** stored encrypted (envelope encryption: a data key per record, master key in a Vercel env var), and never shared or defaulted.
- **Every table carries `user_id`,** with Postgres **row-level security** (`current_setting('app.user_id')` set per request or job).
- **Minimal scopes:** the Slack user token gets `groups:history` only if private-channel history is wanted.
- **The admin role** manages users and cannot read another user's data.

## Consequences
### Positive
- The data-bleed class is impossible by construction, even with a bug in app code.

### Negative
- Each user must connect their own accounts (correct anyway); RLS adds setup to every query path.

## Alternatives considered
- **App-level filtering only:** rejected. One missed `WHERE` leaks data.
- **A separate database per user:** rejected. Overkill for a handful of users.
