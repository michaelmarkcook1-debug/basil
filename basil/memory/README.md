# Basil Memory System

Reference implementation and engineering spec for Basil's three-category memory system.

---

## Quick Start

```bash
# Run tests (zero deps, plain Node.js)
node memory-test.js

# Use in code
const { MemoryStore } = require("./memory");
const store = new MemoryStore("./.memory");

store.ingest("I prefer Zoom for video calls.", "durable");
store.ingest("Q2 board deck — current draft.", "workspace", { tags: ["@active"] });
store.ingest(longDocument, "knowledge", { title: "Gartner Market Guide 2025" });

const context = store.retrieve("prepare for board meeting");
// → ranked records from all three categories, within token budgets
```

---

## The Three-Category Model

### DURABLE RULES

*What it is:* Stable facts about the user. Preferences, explicit instructions, identity details, behavioural rules.

*Examples:* "I prefer Zoom over Google Meet." / "Always CC Ed on investor emails." / "I'm CEO of AnalystGenius."

*Behaviour:* Always included in the system prompt. Hard cap at 2 000 tokens — lower-priority records are dropped first. Records are never silently overwritten: near-duplicates update in place and the previous version is archived in `history[]`.

*Priority:* Set `metadata.priority` (1–10, default 5) to pin critical rules at the top.

---

### KNOWLEDGE BASE

*What it is:* Reference material that should be recallable but is too large to carry on every call. Documents, research, transcripts, meeting notes.

*Examples:* Vendor contracts, competitor analysis, long email threads, uploaded PDFs.

*Behaviour:* Split into `~256-token` chunks at ingest. Each chunk is embedded and stored. Retrieval uses cosine similarity against the query. Top-k chunks within a 4 000-token budget are returned.

*Deletion guarantee:* `del(sourceId)` removes the source record and all derivative chunks atomically. A single call cleans everything.

---

### ACTIVE WORKSPACE

*What it is:* Time-bounded recent context. Today's calendar notes, current drafts, recent uploads.

*Examples:* "Today's call prep for Malcolm" / current pricing model draft / just-received PDF.

*Behaviour:* 7-day TTL by default. Tag content `@active` to exempt it from expiry. Surfaced when the query has temporal signals (today, this week) or when items are `@active`. Eviction is lazy-on-read and eager via `evict()`.

---

## Deletion Guarantees

| Operation | What is deleted |
|---|---|
| `del(sourceId)` | Source record + all derivatives (all categories) |
| `del(chunkId)` where `chunkId !== sourceId` | Only that chunk |
| `promote()` or `demote()` | Removes from source category, re-ingests into target |

There is no soft delete. `del()` writes the filtered store back to disk immediately. Once deleted, a memory is gone from all future LLM calls — the system prompt builder only reads live store data.

---

## Integration with the Basil App

This directory is the **design reference**. The production code lives at:

| This file | Production equivalent |
|---|---|
| `memory.js` `MemoryStore` | `lib/memory/store.ts` |
| `classify()` | `rememberThis` LLM tool → `createMemory()` |
| `retrieve()` | `memoriesForPrompt()` (durable/flat only today) |
| `del()` | `deleteMemory()` → `DELETE /api/memory/[id]` |
| `audit()` | `/admin` page |
| `.memory/*.json` files | `.data/users/<username>/sage-memory.json` |

**What the production implementation is missing vs this spec:**

1. **KNOWLEDGE / WORKSPACE categories** — the live app has only a flat category set (`fact`, `preference`, `person`, `context`) with no semantic retrieval. The `knowledge` and `workspace` categories from this spec are not yet wired in.
2. **Vector embeddings** — no embedding or semantic search in production. `memoriesForPrompt()` does a linear scan sorted by recency.
3. **Token budget accounting** — the production system caps at 40 records (10/kind), not token-counted. The spec's token-budget approach is more precise.
4. **Chunking** — large documents are not chunked in production; the import pipeline ingests each extracted memory as a short string.

To integrate this spec: implement the `KNOWLEDGE` and `WORKSPACE` retrievers, wire a real embedding provider into `embeddings.js`, and update `memoriesForPrompt()` to call `store.retrieve(query, { categories: [...] })` instead of the current flat sort.

---

## Embedding Providers (production)

Replace the mock in `embeddings.js` with one of:

| Provider | Model | Dimensions | Notes |
|---|---|---|---|
| OpenAI | text-embedding-3-small | 1536 | Best cost/quality ratio |
| Voyage | voyage-3-lite | 512 | Fast, cheap, Anthropic-aligned |
| Cohere | embed-english-v3.0 | 1024 | Good multilingual |
| Local | nomic-embed-text (Ollama) | 768 | Zero API cost, offline |

The `embed(text)` function in `embeddings.js` is the only integration point. Swap the body and update `EMBEDDING_DIM` to match.

---

## File Layout

```
basil/memory/
  SPEC.md          Engineering specification (data shapes, contracts, non-goals)
  README.md        This file
  memory.js        Reference implementation (MemoryStore class)
  embeddings.js    Embedding interface + mock
  memory-test.js   40 unit tests covering all public functions
  .memory/         Created at runtime — JSON store files (gitignored)
```

---

## Running Tests

```bash
node memory-test.js
# Expected: 40/40 tests passed
```

No build step, no `npm install`, no configuration. Each test creates and cleans up its own temp directory.
