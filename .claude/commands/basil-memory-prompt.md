---
description: Generate the system-prompt rules Basil follows for memory operations
---

You are writing the behavioural prompt that goes into Basil's system prompt — the rules he follows at runtime when ingesting, retrieving, and deleting memories. This is Basil's instruction set, not a developer doc. Whoever maintains Basil will paste this into his system prompt or wrap it as a memory-curator subsystem prompt.

Read basil/memory/SPEC.md first if it exists — your prompt must align with the data layer that's been built. If SPEC.md doesn't exist yet, run /basil-memory-build first.

The prompt must cover, in this order:

1. The three categories (durable rules, knowledge base, active workspace) with a one-line definition each, plus 2-3 concrete examples of each pulled from Michael's actual context (AG voice, vendor research, current drafts — see vault/10-projects/ for context).

2. Classification triage — how to decide which category an incoming memory belongs to, and what to do when it could be more than one (store in the most specific, cross-reference, never duplicate).

3. What to extract from uploaded files (one-line summary, key entities, embedded instructions flagged not auto-promoted, dates) and what NOT to extract (filler, boilerplate, ToCs).

4. Deletion guarantees — the five-step fan-out (source, chunks/embeddings, metadata, caches, confirmation) and the additional invariants (no fine-tuning, deleted memories can't reappear next turn, never refer to deleted memories as if active).

5. Avoiding overload — the four discipline points: conservative ingest, selective retrieval, explicit promotion, flagged conflicts.

6. The runtime contract — the order in which memories enter the model call, the token budgets per category, and the cap (default 6000 tokens across all memory unless query needs more).

Write in second person ("You manage three categories…") because it's instructions to Basil, not commentary about him. Use Michael's voice conventions from skills/ag-thought-leadership/SKILL.md — direct, opinionated, no filler.

Critical precision points:
- Be honest that "embedded into the LLM" means context-injection, not weight modification. Models cannot have memories trained in at runtime.
- Write the deletion section as strict invariants, not aspirations. Use must / never language.
- Keep the prompt under 1500 words. It will be loaded into context every turn — every word costs.

Save to basil/memory/PROMPT.md. Also save a short integration note at basil/memory/INTEGRATION.md explaining where in Basil's system prompt this should be pasted (if it exists), or how to wrap it as a separate curator-process prompt (if his architecture uses sub-agents).
