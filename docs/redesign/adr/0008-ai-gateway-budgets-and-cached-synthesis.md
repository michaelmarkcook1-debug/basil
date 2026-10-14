# ADR-0008: AI gateway with budgets; synthesis cached by input fingerprint

## Status
Proposed

## Context
Spend was $204 from June to October, with spikes: the daily cap was hit on 2026-10-13 by an uncached duplicate briefing (103k tokens per page open) and three failed meeting preps. Model quirks broke features: Opus 5.5 rejects forced tool calls, and answers have contained Python `None`.

## Decision
- **All model calls go through `ai-gateway`.** It provides tier routing (understand → Haiku, synthesise → Opus or Sonnet, chat → Opus), **native structured output** everywhere, prompt caching for stable prefixes, and metering of every call into `ai_spend`.
- **Budgets:** a per-user daily cap plus per-stage budgets. When a budget is hit, work **degrades** instead of failing: understanding queues, and synthesis serves the last artefact.
- **Synthesis** (briefing, operational read, meeting prep, profiles, relationship reads) is stored in `generated_artifacts` with a fingerprint of the graph rows it read. It's rebuilt only on fingerprint change plus a minimum age, or on Refresh.
- **Evals** run in CI for every structured stage.

## Consequences
### Positive
- Predictable cost (target ≤ $1/day). No duplicate generation.
- Model quirks handled once.

### Negative
- Fingerprinting needs careful input selection, or it rebuilds too often or too rarely.

## Alternatives considered
- **Per-feature model calls** (status quo): rejected.
- **The AI Gateway's response cache:** doesn't help. Prompts differ by time and context; graph fingerprints are the right cache key.
