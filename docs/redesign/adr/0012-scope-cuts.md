# ADR-0012: Scope cuts — Stig, Siri API, billing, WhatsApp, AI-tool tracking

## Status
Proposed

## Context
Usage data (seven days of request logs; spend logs June to October) shows features with no or duplicate use:
- the Stig briefing (a duplicate of the Briefing, 10% of AI spend);
- Stig Ask and Siri (zero calls ever logged);
- AI-platform tracking (0 items);
- billing and dunning (no paying users);
- WhatsApp import (personal contacts deleted);
- Microsoft and Teams (disconnected);
- shadow pipelines.

## Decision
**Not rebuilding these** in `basil-next`:
- Stig's operational read becomes a section of the one Briefing (ADR-0008).
- Siri can return later as a client of the agent API.
- Microsoft 365 is deferred until needed.

## Consequences
### Positive
- A smaller system: fewer routes, crons and failure modes.

### Negative
- Anything cut must be rebuilt if wanted later (cheap, given the module boundaries).
