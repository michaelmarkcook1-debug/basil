---
description: Delete a memory from Basil's store. Always shows a preview and requires explicit confirmation.
---

Delete the following from Basil's memory: "$ARGUMENTS"

Instructions:

**Step 1 — Dry run (always, no exceptions):**

1. Call GET /api/memory to fetch all stored memories.
2. Find all memories that match the query or ID provided:
   - If $ARGUMENTS looks like a UUID, match by exact id.
   - Otherwise, match by content/entity substring (case-insensitive).
3. Show the candidate(s) to be deleted:
   ```
   Found 1 memory to delete:
   ─────────────────────────────────────
   [preference] I prefer Zoom for all video calls
   id: abc123...
   ─────────────────────────────────────
   ```
4. If no matches found, say "No memory found matching that query." and stop.
5. If more than 5 matches, say "That query matches N memories — please narrow it down to a specific id or more precise phrase." and stop.

**Step 2 — Explicit confirmation gate:**

After showing the preview, ask:

> To confirm deletion, reply: **yes, delete**
> This cannot be undone.

Wait for the user's response. Do NOT proceed until you receive an explicit "yes, delete" or equivalent unambiguous affirmative.

**Step 3 — Execute deletion:**

1. For each confirmed memory, call DELETE /api/memory/<id>
2. After all deletions complete, confirm:
   ```
   Deleted: "[content]" (id: abc123...)
   This memory will no longer appear in Basil's context.
   ```

**Hard rules:**
- Never delete without an explicit user confirmation in the current conversation.
- Never delete more than 5 records in a single /forget invocation.
- If anything looks wrong mid-deletion, stop and report.
