---
description: Promote a memory to a different category. Requires explicit confirmation.
---

Promote memory to a different category: "$ARGUMENTS"

Instructions:

**Step 1 — Parse arguments:**
$ARGUMENTS should be in the form: `<sourceId> <toCategory>`
- sourceId: a memory UUID or search phrase
- toCategory: "durable" | "knowledge" | "workspace"

If the format is unclear, ask: "Please provide: /memory-promote <id-or-phrase> <target-category>"

**Step 2 — Check operability:**

Today's operative categories are: **durable** (fact/preference/person/context).

- If toCategory is "knowledge" or "workspace":
  Reply: "The **knowledge** and **workspace** categories are not yet operative in Basil's live store. Promotion to these categories is pending — see `basil/memory/INTEGRATION.md` for the implementation roadmap. No changes were made."
  Stop here.

- If toCategory is "durable": continue.

**Step 3 — Show the record and get confirmation:**

1. Call GET /api/memory and find the record matching sourceId (by UUID or content substring).
2. If not found, say "No memory found matching that query."
3. Show what will change:
   ```
   Promote this memory?
   ─────────────────────────────────────
   Content: [content]
   From:    [current kind]
   To:      [new kind in durable]
   ─────────────────────────────────────
   Reply "yes, promote" to confirm.
   ```

**Step 4 — Execute (after "yes, promote"):**

1. Call PATCH /api/memory/<id> with `{ "kind": "<new kind>" }`
2. Confirm: "Updated: '[content]' is now stored as [new kind]."

Note: True promotion to KNOWLEDGE (chunked, embedded) or WORKSPACE (TTL-based) requires the infrastructure in `basil/memory/INTEGRATION.md` to be built first.
