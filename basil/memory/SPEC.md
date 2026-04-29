# Basil Memory System — Engineering Specification

Version: 1.0  
Status: Reference  
Last updated: 2026-04-29

---

## Overview

Three independent memory categories. Each has a different lifespan, retrieval mechanism, and token budget. They are stored separately and retrieved independently; the calling layer (system prompt builder) assembles them.

---

## 1. Categories

### 1.1 DURABLE RULES

Stable facts about the user: their preferences, voice rules, identity facts, and explicit behavioural instructions.

- **Lifetime:** Permanent until explicitly edited or deleted.
- **Token budget:** Hard cap **2 000 tokens** per call — always included.
- **Storage:** Single flat file `durable.json`. Array of records.
- **Priority field:** 1–10. Records are sorted descending by priority, then by `updatedAt` descending, then truncated to fit the budget.
- **Edit model:** Full replacement of the content field. Conflict: newer `updatedAt` wins; old version is archived in the record's `history[]` array, not discarded.

### 1.2 KNOWLEDGE BASE

Reference material that should be recallable but is too large to carry every time. Documents, vendor research, meeting transcripts, vault folders.

- **Lifetime:** Permanent until deleted.
- **Token budget:** Up to **4 000 tokens** per query (configurable) via top-k semantic retrieval.
- **Storage:** `knowledge.json` — array of **chunk** records. Large documents are split into `CHUNK_SIZE`-token slices at ingest time. Every chunk carries the `sourceId` of its parent document.
- **Retrieval:** Embed the query → cosine similarity against all chunk embeddings → return top-k chunks that fit within the per-query budget.
- **Source → derivatives:** One ingest call for a document creates one source record (`chunkIndex: 0`, `isSource: true`) plus N−1 derivative chunk records with the same `sourceId`. All share a `sourceId`. Deleting by `sourceId` removes every derivative automatically.

### 1.3 ACTIVE WORKSPACE

Time-bounded recent context. Today's calendar, current drafts, recent uploads, in-progress threads.

- **Lifetime:** Rolling 7-day TTL. Items tagged `@active` are exempt from expiry until the tag is removed.
- **Token budget:** Up to **1 500 tokens** — surfaced when a query has temporal overlap with the record (today, this week) or when items are `@active`.
- **Storage:** `workspace.json` — array of records with `expiresAt` timestamps.
- **Eviction:** Expired records (non-`@active`) are pruned lazily on read and eagerly via `evict()`.

---

## 2. Data Shapes

All timestamps are ISO-8601 strings. All IDs are 16-char lowercase hex.

### 2.1 Durable Record

```typescript
interface DurableRecord {
  id: string;                  // hex16
  sourceId: string;            // == id for originals; parent id for auto-derived
  category: "durable";
  content: string;             // the fact/rule/preference text
  tokenCount: number;          // estimated, re-computed on update
  priority: number;            // 1–10; default 5
  tags: string[];
  metadata: Record<string, unknown>;
  history: Array<{             // previous versions of content
    content: string;
    updatedAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
}
```

### 2.2 Knowledge Chunk Record

```typescript
interface KnowledgeRecord {
  id: string;
  sourceId: string;            // parent document id; == id if isSource
  isSource: boolean;           // true on the first chunk / root record
  category: "knowledge";
  content: string;             // chunk text
  embedding: number[];         // from embeddings module; [] if not yet computed
  chunkIndex: number;          // 0-based
  totalChunks: number;
  tokenCount: number;
  tags: string[];
  metadata: {
    title?: string;
    url?: string;
    mimeType?: string;
    [key: string]: unknown;
  };
  createdAt: string;
  updatedAt: string;
}
```

### 2.3 Workspace Record

```typescript
interface WorkspaceRecord {
  id: string;
  sourceId: string;
  category: "workspace";
  content: string;
  tokenCount: number;
  expiresAt: string;           // createdAt + TTL_MS, or null if @active
  active: boolean;             // true when tagged @active; skips TTL
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

---

## 3. Source ID → Derivatives Mapping

The `sourceId` field on every record is the deletion key. Rules:

1. A **source record** has `sourceId === id`.
2. A **derivative record** has `sourceId === parent.id`.
3. `del(sourceId)` removes every record where `record.sourceId === sourceId`. This is a full fan-out — it removes the source and all derivatives in one pass.
4. Deleting a derivative ID directly removes only that record; the source is untouched.
5. The store maintains no separate index file: the fan-out is a linear scan. For prototype scale (< 10 000 records) this is fast enough. Production: add a secondary index `sourceId → [id, ...]` in a separate `_index.json`.

---

## 4. Function Signatures

```typescript
// Classification — returns the best category for new content
classify(input: string | { content: string; metadata?: object }):
  { category: "durable"|"knowledge"|"workspace"; confidence: number; reason: string }

// Ingest — store content in the given category
ingest(content: string, category: "durable"|"knowledge"|"workspace", metadata?: object):
  { id: string; sourceId: string; derivatives: string[] }

// Retrieve — semantic search across one or all categories
retrieve(query: string, options?: {
  categories?: Array<"durable"|"knowledge"|"workspace">;
  topK?: number;        // default 5 per category
  budgetTokens?: number; // per-category override
}): Array<{ id: string; sourceId: string; content: string; score: number; category: string }>

// Promote — move a record to a higher-persistence category
promote(sourceId: string, toCategory: "durable"|"knowledge"|"workspace"):
  { moved: number; newIds: string[] }

// Demote — move to a lower-persistence or time-bounded category
demote(sourceId: string, toCategory: "knowledge"|"workspace"):
  { moved: number; newIds: string[] }

// Delete — remove source + all derivatives
del(sourceId: string): { deleted: string[] }

// List — enumerate records in a category with optional filter
list(category: "durable"|"knowledge"|"workspace", filter?: {
  tags?: string[];
  since?: string;      // ISO date
  search?: string;     // substring match on content
}): Array<DurableRecord | KnowledgeRecord | WorkspaceRecord>

// Audit — consistency report
audit(): {
  counts: Record<string, number>;
  tokenTotals: Record<string, number>;
  budgetStatus: Record<string, { used: number; cap: number; over: boolean }>;
  conflicts: Array<{ ids: string[]; reason: string }>;
  orphanedDerivatives: string[];
  expiredWorkspace: number;
}
```

---

## 5. Retrieval Pipeline

### 5.1 DURABLE

1. Load all durable records.
2. Sort: `priority DESC`, `updatedAt DESC`.
3. Accumulate records until token budget (2 000) is reached.
4. Return full set (not scored — durable records are always included).

### 5.2 KNOWLEDGE

1. Embed the query using `embeddings.embed(query)`.
2. Load all knowledge records that have a non-empty embedding.
3. Compute `embeddings.similarity(queryVec, record.embedding)` for each.
4. Sort by score descending.
5. Accumulate top-k records until token budget is reached.
6. Return with scores.

### 5.3 WORKSPACE

1. Load all workspace records.
2. Evict expired non-active records (in-memory only during retrieval; write back lazily).
3. Filter to records that are `@active` or have temporal overlap with the query (date detection via regex).
4. Sort by `updatedAt DESC`.
5. Accumulate until token budget (1 500) is reached.
6. Return with a score of `1.0` for `@active`, `0.8` for temporally matched.

---

## 6. Token Budget Strategy

Token counts are estimated with the formula:

```
tokenCount = ceil(content.length / 4)
```

This is a rough approximation (≈ GPT tokenisation rate). Production implementations should use the target model's actual tokeniser (e.g. `tiktoken` for OpenAI models).

**Budget enforcement:**

- DURABLE: if all records exceed 2 000 tokens, lower-priority records are silently dropped. The caller always receives a non-empty context.
- KNOWLEDGE: the `topK` parameter is a secondary constraint; the budget is primary. Chunks are added greedily until either limit is reached.
- WORKSPACE: same greedy approach; expired records are excluded before budget accounting.

**Assembly (done by the caller, not this module):**

```
total = durable_tokens + knowledge_tokens + workspace_tokens
target ≤ model_context - prompt_overhead - response_reserve
```

The memory module does not know the model context size; that is the caller's responsibility.

---

## 7. Promotion / Demotion

- `promote(sourceId, "durable")` copies records to the durable store, assigns new IDs, sets `priority: 5` unless overridden. The original records are deleted from the source category.
- `demote(sourceId, "workspace")` copies to workspace with a fresh TTL. Original is deleted.
- If the target category is `knowledge`, the content is re-chunked and re-embedded.

---

## 8. Conflict Resolution

**Rule:** If new content is ingested that is near-identical to an existing record (edit distance < 20% of character length), the newer record wins:

1. The old record's `content` is pushed onto `history[]`.
2. The old record's `content` and `tokenCount` are replaced with the new values.
3. The old record's `updatedAt` is updated.
4. No new ID is created — the update is in place.

Near-identity check: compare lowercase-normalised character content. If `levenshteinRatio(a, b) > 0.8`, treat as a conflict.

`audit()` surfaces all conflicts where the `history[]` array is non-empty.

---

## 9. Cache Invalidation on Delete

`del(sourceId)` performs:

1. Filter `store[category]` to remove all records where `record.sourceId === sourceId`.
2. Write the updated store file.
3. Return the list of deleted IDs.

There is no secondary embedding cache in the prototype. In production:

- Embedding vectors should be stored in a vector DB (e.g. pgvector, Qdrant). On delete, call the DB's delete API for each removed ID.
- If using an in-process ANN index (HNSW), the index must be rebuilt or incrementally updated after deletion. Document this cost at integration time.

---

## 10. What NOT to Build

The following are explicit non-goals for this system:

| Non-goal | Reason |
|---|---|
| Fine-tuning the model on user data | Privacy risk, cost, staleness — retrieval is sufficient |
| Real-time sync across devices | Out of scope; file-system is single-writer |
| Automatic memory formation from every chat turn | Creates noise; formation should be explicit or triggered by the LLM tool call |
| Semantic deduplication at ingest | Expensive; handle via `audit()` and manual review |
| Encryption at rest | Not this layer's responsibility; OS-level or vault-level concern |
| User-facing memory UI | Handled by the Basil app layer (`app/dashboard/memory/`) |
| Multi-user support | The prototype is single-user; multi-user requires per-user stores |

---

## 11. Integration Points with the Basil App

The production implementation of this spec lives at `lib/memory/` in the Next.js app. The reference implementation in this directory (`memory.js`) demonstrates the contract. To integrate:

1. Replace `durable.json` reads with calls to `readUserStore(username, "sage-memory.json", [])`.
2. Replace embedding storage with a real vector store column or provider.
3. Wire `classify()` to the LLM via the chat tool (`rememberThis`) — the tool already calls `createMemory()`.
4. `retrieve()` replaces the current `memoriesForPrompt()` function for knowledge-base queries.
5. `audit()` should feed the admin page (`/admin`).

---
