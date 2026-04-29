---
description: Audit Basil's memory store for stale entries, conflicts, and budget pressure.
---

Run a memory audit for Basil's store.

Instructions:

1. Call GET /api/memory to fetch all stored memories.

2. Run these checks and report findings per section:

---

**§1 — Stale records (90-day check)**

Flag any memory whose updatedAt is older than 90 days from today.
Report: count stale, list the top 5 oldest with their content and last-updated date.
Recommendation: "Consider reviewing these — they may be outdated."

---

**§2 — Conflicts (near-duplicate detection)**

Find pairs where:
- Both have the same kind AND
- Their contents share >70% of significant words (ignore words shorter than 4 chars)

For each conflict pair, show both entries and flag which one is newer.
Recommendation: "The newer record supersedes the older — consider deleting the older via /forget <id>."

---

**§3 — Potential misclassification**

Heuristic checks:
- A "fact" that starts with "I prefer" or "Always use" → probably should be "preference"
- A "context" that sounds permanent ("I am CEO of...") → probably should be "fact"
- A "fact" mentioning a person by name → might be better as "person" with entity set
- A "preference" with no first-person framing → may be misclassified

List any suspected misclassifications with a suggested reclassification.
Use /memory-promote <id> <new-kind> to fix them.

---

**§4 — Budget pressure**

Current limits for the prompt context injection:
- Max 40 records total (10 per kind)
- Only the 40 newest are injected into every Basil conversation

Count records per kind. If any kind has ≥8 records (≥80% of its budget):
Flag: "[kind] is at X/10 of its injection budget. Lower-priority records may be crowded out."

If total records ≥ 35:
Flag: "Total store is at X/40 injection records. Consider pruning old or low-value entries."

---

**§5 — Summary**

```
Memory audit complete — <date>
Total records: X
Stale (>90d):  X
Conflicts:     X pairs
Misclassified: X suspected
Budget pressure: [none | low | medium | high]
```

Suggest 1–3 concrete next steps based on findings. Use /forget, /memory-promote, or "visit /dashboard/memory to manage records."
