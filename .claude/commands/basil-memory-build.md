---
description: Build the memory system spec + reference implementation for Basil
---

You are building Basil's memory system. This is a two-part deliverable: a precise engineering spec that any Basil maintainer can implement against, and a working reference implementation in Node that demonstrates the contract end-to-end.

The system has three memory categories. Read this carefully — every design decision flows from these:

DURABLE RULES — stable facts about the user, their preferences, voice, project identity, and explicit behavioural instructions. Stored in a single editable file, pinned to every model call, hard cap 2000 tokens.

KNOWLEDGE BASE — reference material that should be recallable but not always carried. Documents, vendor research, transcripts, vault folders. Stored as embedded chunks in a vector store, retrieved per-query via top-k semantic search.

ACTIVE WORKSPACE — time-bounded recent context. Today's calendar, current drafts, recent uploads. Rolling 7-day buffer plus anything tagged @active. Surfaced when temporally relevant.

Build all of the following at `basil/memory/` inside the existing Agentic OS scaffold:

1. SPEC.md — the engineering specification. Include: data shapes for each category (TypeScript-ish JSON schemas), the source_id → derivatives mapping for deletion fan-out, the classification function signature, the retrieval pipeline, the promotion/demotion flow, token budgeting strategy, and the rules for cache invalidation on delete. Be concrete: state what data lives where, what functions exist, what their inputs and outputs are. Include a section on "what NOT to build" — explicit non-goals like fine-tuning the model on user data.

2. memory.js — a reference Node module implementing the spec. Zero external dependencies for the spec itself; you may use `node-pty` patterns from the existing bridge.js as a style guide. Functions required: classify(input), ingest(content, category, metadata), retrieve(query, options), promote(sourceId, toCategory), demote(sourceId, toCategory), del(sourceId), list(category, filter), audit(). Use a simple sqlite-style file-backed approach via JSON files for the prototype; document where a real implementation would swap in a proper vector store.

3. embeddings.js — a stub embedding interface. Real embeddings need a model provider (OpenAI, Voyage, Cohere, local). Don't pick one. Define the interface (`embed(text) -> number[]`, `similarity(a, b) -> number`) and provide a mock implementation that uses simple hashing for testing. Document the integration points for production.

4. memory-test.js — unit tests covering: classification, ingestion into each category, retrieval, deletion fan-out (verify all derivatives are removed), promotion/demotion, token budget enforcement, and the conflict-resolution rules ("newer wins, but flag it").

5. README.md inside basil/memory/ — operating notes for whoever maintains this. Quick start, the three-category model in plain language, deletion guarantees, and the integration points with the rest of Basil.

Constraints:
- Follow the existing codebase conventions: zero deps where possible, clear module boundaries, file-system primitives over services.
- Match the voice in existing files: direct, technical, no filler.
- Don't fabricate features. If a piece needs Basil's actual codebase to integrate, say so explicitly and stop there.
- Produce real working code. The tests should run and pass.

When done, append a session entry to vault/20-areas/session-log.md and update vault/10-projects/basil.md with the memory-system status.
