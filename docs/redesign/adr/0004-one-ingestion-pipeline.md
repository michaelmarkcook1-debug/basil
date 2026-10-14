# ADR-0004: One idempotent ingestion pipeline on a durable workflow

## Status
Proposed

## Context
Ingestion today is several cron-driven fan-outs (`poll-ingest`, `slack-sync`, `reprocess`, `renew-subscriptions`) inside 300-second functions. Each re-derives its own view, and each page also fans out live: the Slack Command Centre takes 40 s. The nightly backup timed out every night for three months unnoticed.

## Decision
Use **one pipeline**: Connectors → Normalise → Resolve → Understand → Apply → Project (+ data-quality checks).
- **Triggers:** push (Gmail Pub/Sub, Calendar channels, Slack Events API with user-token events), plus a **15-minute reconcile** from per-source cursors. Crons only enqueue.
- **Meetings come from Zoom's recap emails** in Gmail (the Zoom account can't be connected; Michael, 2026-10-14). The Normalise stage recognises a recap email and turns it into a MEETING with its summary and action items. A Zoom API connector is a later, optional adapter.
- **Linear and other Work Apps sync through their adapters** (ADR-0013) into `app_items`. They feed the project radar, not commitments.
- **Run on Vercel Workflow DevKit** (`"use workflow"` / `"use step"`): durable steps, retries, per-step results. Steps are idempotent by `(source, source_id, content_hash)`.
- **Every run is recorded** in `pipeline_runs`, with counts and failures; failures alert.

## Consequences
### Positive
- One place to fix ingestion bugs.
- Replays after a fix (raw payloads kept 90 days).
- No time-boxed fan-outs, and observable runs.

### Negative
- Push setup per source (Pub/Sub topic, Slack event subscriptions).
- Workflow DevKit is a newer platform.

## Alternatives considered
- **Postgres job table** (`FOR UPDATE SKIP LOCKED`) drained by a 1-minute cron: simpler and fully transparent. It is **the fallback** if Workflow DevKit proves immature in Phase 0.
- **Vercel Queues:** viable for fan-out, but lacks multi-step durable state. Reconsider if steps stay single-hop.
- **Status quo crons:** rejected.
