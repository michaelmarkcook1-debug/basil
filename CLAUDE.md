@AGENTS.md

## Memory slash commands

Six slash commands are wired for Basil's memory system. They live in `.claude/commands/`.

| Command | Purpose | Operative? |
|---|---|---|
| `/remember <content>` | Store something in Basil's memory; Basil classifies the kind | Yes |
| `/recall <query>` | Search memory for relevant records | Yes |
| `/forget <query-or-id>` | Delete a memory — dry-run preview then explicit confirmation required | Yes |
| `/memory-list [category]` | List all memories, optionally filtered by kind | Yes |
| `/memory-promote <id> <category>` | Reclassify a memory to a different kind | Yes (durable only) |
| `/memory-audit` | Audit for stale entries, conflicts, misclassification, budget pressure | Yes |

Operative categories: `fact`, `preference`, `person`, `context` (all map to DURABLE in the three-category spec).  
Aspirational categories (`knowledge`, `workspace`) are defined in `basil/memory/SPEC.md` but not yet wired.

## Memory curation skill

`basil/skills/memory-curation/SKILL.md` — trigger phrases, classification rules, conflict handling, and deletion guardrails for Basil when acting as a memory curator.

## Memory reference implementation

`basil/memory/` — three-category spec, reference implementation, embeddings interface, 40-test suite, and wiring notes. Read `basil/memory/INTEGRATION.md` before touching `lib/ai/system-prompt.ts`.
