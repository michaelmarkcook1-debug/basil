---
description: Store something in Basil's memory. Basil classifies it into the right category.
---

Store the following in Basil's memory:

"$ARGUMENTS"

Instructions:
1. Classify the content into one of the four operative categories:
   - **fact** — a durable, verifiable detail about Michael, his company, tools, or life
   - **preference** — how Michael likes things done (communication, workflow, formatting, tool choices)
   - **person** — something meaningful learned about a named individual
   - **context** — an active project, ongoing goal, or current situation

2. If the content could plausibly fit more than one category, pick the most specific one and note your reasoning in one sentence.

3. Extract `entity` if the memory is about a specific person, company, or project (e.g. "Isaac Frank", "AnalystGenius").

4. Call POST /api/memory with:
   ```json
   { "kind": "<classified kind>", "content": "<cleaned content>", "entity": "<entity or omit>", "source": "manual" }
   ```

5. Confirm what was stored: show the kind, content, and entity (if any). Do not show the raw API response.

6. If the content is ambiguous — you genuinely cannot determine the right kind — ask one clarifying question before saving. Do not ask if the classification is clear.

**Do not store things that are clearly ephemeral or one-off** (e.g. "I'm tired today"). If the content is not worth retaining, say so briefly and skip the save.
