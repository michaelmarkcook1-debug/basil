# Memory Prompt — Integration Notes

Where and how to wire `PROMPT.md` into Basil's actual runtime.

---

## Current Architecture

Basil is a Next.js application. The system prompt is assembled at request time in:

```
lib/ai/system-prompt.ts → getSystemPrompt(username, timezoneOverride?)
```

This function builds a single string that is passed as the `system` parameter to every `streamText()` / `generateText()` call. It currently includes:

- Identity and personality block
- Current date/time
- Absolute ground rules (no fabrication)
- Org context (hardcoded for `username === "michael"`)
- Tool manifest summary
- **`memorySection`** — the existing memory block, loaded via `memoriesForPrompt(username)`

---

## Option A — Inline Paste (current architecture, minimal change)

Replace the existing `memorySection` block in `getSystemPrompt()` with the content of `PROMPT.md`, followed by the live memory data.

**Exact location:** `lib/ai/system-prompt.ts`, the `memorySection` template literal (line ~39–65).

**Structure after the change:**

```
${memoryBehaviouralRules}   ← PROMPT.md content (static, ~900 tokens)

## What You've Learned
${liveMemoryData}            ← memoriesForPrompt(username) output (variable, ≤2000 tokens)
```

**Implementation steps:**

1. Add `MEMORY_BEHAVIOUR_PROMPT` as a module-level constant in `system-prompt.ts` (paste PROMPT.md content verbatim, or import from a separate `.ts` file).
2. Replace the current `memorySection` conditional with:
   ```typescript
   const memorySection = `\n\n${MEMORY_BEHAVIOUR_PROMPT}\n\n## What You've Learned\n${memories || "No memories stored yet."}`;
   ```
3. No API changes required. No new routes. One file edit.

**Trade-off:** PROMPT.md's ~900 tokens are loaded every turn for every user. At current scale this is acceptable. Watch total system prompt size — it's already large for the `username === "michael"` branch.

---

## Option B — Curator Sub-Agent (future architecture)

If Basil is ever refactored to use a memory-curator sub-agent (a separate process that pre-processes memory before the main chat call), `PROMPT.md` becomes the curator's full system prompt.

**Flow:**
```
User message →
  Memory Curator (system: PROMPT.md)
    → reads query
    → retrieves relevant records from all three categories
    → returns { durable: [...], knowledge: [...], workspace: [...] } as structured context
  Main Basil call (system: core prompt + curator output injected)
    → responds to user
```

**Implementation:** Using the Workflow DevKit, this maps to a step function that calls the curator model, awaits structured JSON output, then passes it as tool context to the main chat workflow. `PROMPT.md` becomes the curator's `system` parameter.

**When to choose this:** When knowledge-base retrieval is expensive enough (external vector DB, large corpus) that it shouldn't block the main chat call, or when you want separate observability for memory operations.

---

## What's Missing Before Either Option Works in Full

The current production system (`lib/memory/store.ts`) only implements DURABLE storage — flat records, no chunking, no embeddings. `memoriesForPrompt()` returns all records sorted by recency, not by query relevance.

To fully honour the runtime contract in `PROMPT.md`:

| Gap | File to change | What to add |
|---|---|---|
| KNOWLEDGE category | `lib/memory/store.ts` | Chunking, embedding storage, cosine retrieval |
| WORKSPACE category | `lib/memory/store.ts` | TTL field, `@active` tag, eviction |
| Query-aware retrieval | `lib/ai/system-prompt.ts` | Pass query string into `memoriesForPrompt()` so KNOWLEDGE retrieval is semantic |
| Token budget enforcement | `lib/memory/store.ts` | `fitWithinBudget()` (already in `basil/memory/memory.js`) |
| Embedding provider | New: `lib/memory/embeddings.ts` | Wire real provider; `basil/memory/embeddings.js` is the interface spec |

**Short-term:** Pasting PROMPT.md into the system prompt still improves Basil's behaviour immediately for the DURABLE category — the classification triage, deletion invariants, and conflict rules apply now. The KNOWLEDGE/WORKSPACE sections become accurate as those categories are built out.

---

## Token Budget Reality Check

Current system prompt for `username === "michael"` is approximately:

| Section | Estimated tokens |
|---|---|
| Identity + ground rules | ~600 |
| Org context + team + personas | ~800 |
| Tool manifest | ~400 |
| Existing memory section | ~150 (template) + live memories |
| **PROMPT.md addition** | **~900** |
| **New total (before live data)** | **~2 850** |

This is within safe bounds for Claude Sonnet (200K context). Monitor if the org context section grows — the combined system prompt should stay under 4 000 tokens to leave ample room for tool results and user context.
