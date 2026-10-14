# ADR-0002: Postgres (Neon) as the system of record; Blob for raw payloads only

## Status
Proposed

## Context
State lives in about 44 whole-file JSON documents per user in private Vercel Blob (7.6 MB for Michael), each updated by read-modify-write under a lock. The audit found:
- **Stale reads:** the Blob CDN returned pre-overwrite bodies, which brought deleted logins back.
- **Lost or duplicate writes** whenever a reader bypassed the lock.
- **Recomputation:** derived facts (last contact) can't be queried, so they're recomputed by fan-out or stored twice and drift apart.

The data is inherently relational: people ↔ identities ↔ messages ↔ commitments.

## Decision
- Use **Postgres on Neon** (via the Vercel Marketplace) as the system of record, with Drizzle for the typed schema and migrations, and `pgvector` for memory and fact retrieval.
- Use **Vercel Blob only** for raw source payloads (kept 90 days, for replay), attachments and nightly exports.
- Add no Redis or cache tier: Postgres reads at this scale are sub-10 ms.

## Consequences
### Positive
- Transactional, row-level updates: no stale-read or whole-file clobbering classes.
- Derived facts become queries or views (`last_contact = max(sent_at)`).
- Point-in-time restore gives an RPO of about 1 hour, versus today's nightly backup (which silently failed from July to October).

### Negative
- A schema to design and migrate; an extra vendor.
- Cold starts on Neon's free tier (use a small always-on instance, about $19/mo, if latency matters).

## Alternatives considered
- **Keep Blob JSON:** rejected. It is the root of several failure classes.
- **Firestore or MongoDB:** rejected. The data is relational and we need joins and constraints (unique identities).
- **Vercel KV/Redis as primary:** rejected. No relational queries.
- **The existing Postgres adapter** (key-value rows): rejected as an end state. It keeps whole-document semantics.
