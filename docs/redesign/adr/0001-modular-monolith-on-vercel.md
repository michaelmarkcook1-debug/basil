# ADR-0001: Modular monolith on Next.js/Vercel

## Status
Proposed

## Context
Basil serves one primary user and a handful of others. It is built and run by one person. Today it is a 103k-line Next.js app with 185 API routes and **no internal module boundaries**: any route can call Gmail, write any store, or call a model. That's how four separate paths ended up creating "actions".

## Decision
Keep a **single Next.js deployable on Vercel**, organised as modules with enforced boundaries:
- `connectors`
- `pipeline`
- `graph`
- `views`
- `synthesis`
- `agent`
- `effects`
- `ai-gateway`
- `platform`

Routes are thin: they call module APIs. A lint rule (dependency-cruiser) forbids cross-module internals, and in particular any import of a source SDK outside `connectors` and `effects`.

## Consequences
### Positive
- One deploy, one runtime, no network hops. Operable by one person.
- The boundaries make "one way in, one way out" (ADR-0004, ADR-0009) enforceable.

### Negative
- One bad deploy affects everything (mitigated by CI gates and instant rollback).
- Module discipline depends on the lint rule.

## Alternatives considered
- **Microservices:** rejected. Operational cost and distributed failure modes with no scale need (≤ 10 users).
- **Separate worker service** (e.g. Fly, Railway) for ingestion: rejected for now. Vercel Functions plus a durable workflow cover the load; revisit if runs exceed function limits.
