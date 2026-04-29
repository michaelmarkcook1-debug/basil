---
description: Search Basil's memory for anything relevant to a query.
---

Search Basil's memory for: "$ARGUMENTS"

Instructions:
1. Call GET /api/memory to fetch all stored memories.

2. Filter and rank results by relevance to the query. Scoring:
   - Exact keyword match in content → highest relevance
   - Entity match (query contains a name that matches a memory's entity) → high
   - Semantic overlap (shared meaningful words) → medium
   - Recency as a tiebreaker

3. Present up to 10 results grouped by kind:
   - **Preferences** (if any)
   - **Facts** (if any)
   - **People** (if any)
   - **Context** (if any)

   Format each result as:
   `[kind] content` — omit the entity prefix if entity is null.
   For person memories, format as: `[person] <entity>: content`

4. If no memories match, say: "Nothing in memory matches that query yet."

5. After the results, add one line:
   - "Knowledge base: pending — not yet operative." (semantic document search is not built yet)
   - "Workspace buffer: pending — not yet operative." (time-bounded context is not built yet)

   This keeps expectations honest without making the feature feel broken.

6. Do not invent or extrapolate — only surface what is actually stored.
