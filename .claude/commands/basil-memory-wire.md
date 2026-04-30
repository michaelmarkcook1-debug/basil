---
description: Wire Basil's memory system into the Agentic OS bridge, dashboard, and slash commands
---

You are integrating Basil's memory system into the Agentic OS so Michael can interact with it from the cockpit and Claude Code. The memory system itself lives at basil/memory/ — built by /basil-memory-build, with behavioural rules from /basil-memory-prompt.

Read basil/memory/SPEC.md, basil/memory/PROMPT.md, and basil/memory/INTEGRATION.md before starting. If any are missing, stop and tell Michael which prompt to run first.

The gap table in INTEGRATION.md tells you which operations are operative versus aspirational on Basil's side. This matters: only wire UI for operative operations. For aspirational ones (likely KNOWLEDGE retrieval and WORKSPACE buffering at this point), ship a stub that reports "pending — not yet operative on Basil's side" rather than a broken interaction. A panel that lies about what works is worse than a panel that admits what doesn't.

Read CLAUDE.md and USAGE.md before touching them. Match their existing voice: direct, opinionated, no filler. Don't generate generic documentation prose.

Build the following:

1. Bridge message types. Extend basil/bridge.js (or document the additions if it should stay zero-deps) so Claude Code can send memory operations to Basil. New message types:
   - type: "memory.ingest" with body { content, category?, metadata?, sourceId? }
   - type: "memory.recall" with body { query, k?, category? }
   - type: "memory.delete" with body { sourceId } — requires confirmed: true field, server rejects without it
   - type: "memory.list" with body { category, filter? }
   - type: "memory.promote" with body { sourceId, toCategory } — requires confirmed: true field
   Each gets a corresponding reply with status and operative/pending flag. Document the shapes in basil/README.md.

2. Slash commands at .claude/commands/. All destructive operations (delete, demote, promote-with-overwrite) route through Claude Code, never the dashboard, because the chat surface enables proper confirmation:

   - /remember <content> — sends a memory.ingest. Lets Basil classify. If classification is ambiguous (Basil flags it), asks Michael to choose category before confirming. Surfaces what was stored and where.

   - /recall <query> — sends memory.recall. Surfaces top results in chat with category, source, and one-line summary. If the relevant category is marked aspirational in INTEGRATION.md's gap table, returns "recall pending — knowledge base not yet retrievable" rather than empty results.

   - /forget <query-or-id> — sends memory.delete with confirmed: false to dry-run. Surfaces what would be deleted: source, derived chunks, embeddings, cache entries. Asks Michael for explicit "yes, delete" before sending the real delete with confirmed: true. Confirms count and identifier on completion. Without explicit yes, does nothing.

   - /memory-list <category> — lists what's stored in a category, with summaries.

   - /memory-promote <sourceId> <toCategory> — proposes the promotion, shows the new placement and any conflict (e.g. a contradicting durable rule). Requires "yes, promote" confirmation before firing memory.promote with confirmed: true.

   - /memory-audit — runs the audit pass: items not retrieved in 90+ days (archival candidates), flagged conflicts between memories, items in the wrong category, durable-rule budget pressure.

3. Dashboard panel. Extend the existing Basil panel rather than adding a new one — memory operations all flow through Basil, and the right column is already tall (Basil → Recent Sessions → Recent Decisions). Add a Memory subsection inside the Basil panel:
   - Counts per category (durable rules, knowledge base, active workspace) — pending categories show "—" with a "pending" tag
   - Last 5 ingested items with category and source (read-only list)
   - A simple ingest input — paste text, optional category override, dispatch via memory.ingest
   - A recall search box — types a query, shows top hits inline, gracefully degrades if recall is aspirational

   The panel does NOT include delete, promote, or demote controls. Those are chat-only. Match the existing dashboard aesthetic (navy + amber, IBM Plex Mono, existing CSS variables — don't introduce new ones). The panel uses the existing Basil bridge to talk to memory; it doesn't read memory files directly.

4. Skill: skills/memory-curation/SKILL.md — when Claude Code should propose remembering things on Michael's behalf. The principle: never auto-ingest. Instead, when Michael says something that looks like a durable rule (instruction, preference, hard requirement), surface a one-line proposal in chat: "Want me to remember this as a durable rule?" and only ingest on confirmation. Phrase-matching ("from now on", "always", "remember that") is too noisy on its own and produces false positives — people say these phrases conversationally without meaning to set rules. Require explicit yes. The friction of confirming once is much lower than polluting memory.

5. Update CLAUDE.md to reference the memory commands and the curation skill. Match existing voice. The slash commands list, the skills list, and the "How to behave" section all need new entries — keep them brief and aligned with the surrounding tone.

6. Update USAGE.md with a "Working with memory" section. Cover: the three categories explained for Michael (not the engineering detail — that's in SPEC.md), the slash commands and what each does, the dashboard surface, and the safety rule (deletions require chat confirmation). Match the existing voice.

Constraints:
- Don't break any existing tests. Run the existing audit checks after the changes and confirm.
- The dashboard memory subsection must gracefully handle Basil being offline — show "Basil offline, queued" rather than erroring.
- Deletion and promotion confirmations are non-negotiable. /forget without explicit "yes, delete" doesn't fire. /memory-promote without explicit "yes, promote" doesn't fire.
- Aspirational operations must show "pending" — never fake a successful response when the data layer can't actually serve it.

When done, run an end-to-end smoke test:
   a. Ingest a sample durable rule via /remember. Verify it lands in the right category and shows up in /memory-list durable.
   b. Run /recall against a query that should match it. Verify it surfaces.
   c. Ingest a SECOND durable rule that contradicts the first. Verify Basil flags the conflict per the rules in PROMPT.md.
   d. /forget the original. Confirm with "yes, delete". Verify deletion fan-out: it's gone from /memory-list, gone from /recall, AND any derived chunks/embeddings are gone (use /memory-audit or direct inspection of basil/memory/ files to confirm).
   e. Run /memory-audit and verify it surfaces no stale items immediately after the test (the new entries shouldn't be 90 days old).

Append a session entry to vault/20-areas/session-log.md covering what was wired and what's still pending. Update vault/20-areas/tasks.md to mark the memory work complete or note what's outstanding. Update vault/10-projects/basil.md to surface the memory-system status — and pin the gap table from INTEGRATION.md under a "Memory system status" heading there, since that's where Michael will look for it rather than buried in the memory subfolder.
