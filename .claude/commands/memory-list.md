---
description: List Basil's stored memories, optionally filtered by category.
---

List Basil's stored memories. Filter: "$ARGUMENTS"

Instructions:
1. Call GET /api/memory to fetch all stored memories.

2. Parse $ARGUMENTS for an optional filter:
   - "facts" or "fact" → kind === "fact"
   - "preferences" or "preference" → kind === "preference"
   - "people" or "person" → kind === "person"
   - "context" → kind === "context"
   - Empty or unrecognised → show all categories

3. Display a summary header:
   ```
   Memory store — <N> records total
   fact: X  |  preference: X  |  person: X  |  context: X
   ```

4. Group and list records by kind. Within each group, show newest first (they are already sorted by updatedAt desc from the API). Format:
   ```
   ── Preferences (<count>) ──────────────────────────
   • I prefer Zoom for all video calls
   • Bullets over prose in all briefings

   ── Facts (<count>) ────────────────────────────────
   • CEO of AnalystGenius
   ...
   ```
   For person memories, include entity: `• <entity>: <content>`

5. Cap display at 20 records per kind. If there are more, add: "(… and N more — visit /dashboard/memory to see all)"

6. At the end, note aspirational categories:
   ```
   Knowledge base: pending — semantic document retrieval not yet operative.
   Workspace buffer: pending — time-bounded context not yet operative.
   ```
