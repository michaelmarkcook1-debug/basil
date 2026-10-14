# ADR-0007: Screens read precomputed views — no live fan-out

## Status
Proposed

## Context
Screens assemble themselves by calling Gmail, Slack, Calendar and Linear on load:
- Slack Command Centre: about 40 s.
- People activity: about 14 s cold.
- Today: about 5 s, with stale-while-revalidate patches.

Different screens compute the same facts differently (last contact).

## Decision
The pipeline's **Project** stage maintains read-model tables — `today_view`, `people_view`, `inbox_view`, `commitments_view` and `slack_view` — updated per batch, plus a 5-minute validity sweep. Screens query only these, showing "as of" from the last pipeline run. Live source calls happen only in connectors, effects and explicit "search everything" agent tools.

## Consequences
### Positive
- p95 under 300 ms, and every screen agrees.
- Degraded mode is free: when sources fail, views show their last state.

### Negative
- Freshness is bounded by pipeline latency (≤ 5 min push, ≤ 15 min reconcile).

## Alternatives considered
- **Live fan-out with caches** (status quo): rejected. Slow, inconsistent, and the caches were themselves a bug source.
- **Materialized views only** (`REFRESH MATERIALIZED VIEW`): acceptable for some; incremental table updates chosen for the per-row freshness of the hot views.
