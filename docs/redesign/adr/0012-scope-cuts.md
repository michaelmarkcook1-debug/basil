# ADR-0012: Scope cuts — Stig, Siri API, billing, WhatsApp

## Status
Accepted with changes (2026-10-14): AI coding-tool tracking is **kept** as the Code app (ADR-0013); Siri is "maybe later".

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
- the Stig engine (its operational read becomes a section of the one Briefing, ADR-0008);
- the Siri/Ask API (**maybe later**, as a client of the agent API);
- billing and dunning;
- WhatsApp import;
- shadow pipelines;
- Microsoft 365 (deferred until needed).

**Kept:** AI coding-tool tracking, as the **Code** app in the Work Apps tab (ADR-0013).

## Consequences
### Positive
- A smaller system: fewer routes, crons and failure modes.

### Negative
- Anything cut must be rebuilt if wanted later (cheap, given the module boundaries).
