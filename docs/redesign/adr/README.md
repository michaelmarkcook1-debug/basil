# Basil redesign — Architecture Decision Records

Proposed 2026-10-14; open questions answered the same day (see the Status of each ADR). See [the system design](../README.md).

| # | Decision |
|---|---|
| [0001](0001-modular-monolith-on-vercel.md) | Modular monolith on Next.js/Vercel |
| [0002](0002-postgres-system-of-record.md) | Postgres (Neon) as the system of record; Blob only for raw payloads |
| [0003](0003-context-graph-identity-and-self.md) | A context graph with canonical people, identities and "self" |
| [0004](0004-one-ingestion-pipeline.md) | One idempotent ingestion pipeline on a durable workflow |
| [0005](0005-one-understanding-stage.md) | One AI understanding stage with one rule set |
| [0006](0006-commitments-have-owners-and-validity.md) | Commitments always have an owner and a validity window |
| [0007](0007-read-models-no-live-fanout.md) | Screens read precomputed views — no live fan-out |
| [0008](0008-ai-gateway-budgets-and-cached-synthesis.md) | AI gateway with budgets; synthesis cached by input fingerprint |
| [0009](0009-approvals-as-pending-operations.md) | Outbound actions only via approved pending operations |
| [0010](0010-per-user-credentials-and-rls.md) | Per-user credentials only; row-level security |
| [0011](0011-clean-rebuild-with-shadow-cutover.md) | Clean rebuild with a shadow-run cut-over |
| [0012](0012-scope-cuts.md) | Scope cuts: Stig, Siri API (maybe later), billing, WhatsApp — coding-tool tracking kept |
| [0013](0013-work-apps-hub.md) | One "Work Apps" tab with pluggable app adapters (Linear, Code, +add) |
