/**
 * memory.js — Basil three-category memory system. Reference implementation.
 *
 * Three stores, three budgets, one deletion contract.
 *   DURABLE   — rules, preferences, identity. Always pinned. 2 000-token hard cap.
 *   KNOWLEDGE — chunked reference material. Retrieved by semantic similarity.
 *   WORKSPACE — time-bounded context. 7-day TTL; @active items are exempt.
 *
 * Zero external dependencies. Uses only Node.js built-ins: fs, path, crypto.
 * File-system backed (JSON files). Production swap points are documented inline.
 *
 * Production vector-store swap: grep "PRODUCTION:" for all integration points.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { embed, similarity } = require("./embeddings");

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES = /** @type {const} */ (["durable", "knowledge", "workspace"]);

const TOKEN_BUDGETS = {
  durable: 2000,
  knowledge: 4000,
  workspace: 1500,
};

const CHUNK_TOKENS = 256;          // max tokens per knowledge chunk
const WORKSPACE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CONFLICT_RATIO_THRESHOLD = 0.8; // strings this similar → conflict

// ── MemoryStore class ─────────────────────────────────────────────────────────

class MemoryStore {
  /**
   * @param {string} [dataDir] - Directory for JSON store files.
   */
  constructor(dataDir = ".memory") {
    this.dataDir = dataDir;
    this._ensureDir();
  }

  // ── Classify ───────────────────────────────────────────────────────────────

  /**
   * classify(input) → { category, confidence, reason }
   *
   * Heuristic classification. Production: replace the regex signals with an
   * LLM call (e.g. a fast one-shot classification prompt) for higher accuracy.
   *
   * @param {string | { content: string; metadata?: object }} input
   * @returns {{ category: string; confidence: number; reason: string }}
   */
  classify(input) {
    const text = (typeof input === "string" ? input : input.content || "")
      .toLowerCase()
      .trim();

    if (!text) {
      return { category: "knowledge", confidence: 0.5, reason: "empty input" };
    }

    // DURABLE signals: preferences, rules, identity, explicit instructions
    const durablePatterns = [
      /\bi prefer\b/,
      /\balways\b.{0,30}\b(use|do|say|avoid|prefer)/,
      /\bnever\b.{0,30}\b(use|do|say|send)/,
      /\brule:\s/,
      /\binstruction:\s/,
      /\bmy name is\b/,
      /\bcall me\b/,
      /\bi am\b.{0,20}\b(ceo|cto|vp|founder|director)/,
      /\bremember (that|this)\b/,
      /\bmy (style|voice|tone)\b/,
      /\bmy (company|team|org)\b/,
    ];

    // WORKSPACE signals: temporal, draft/in-progress, @active tag
    const workspacePatterns = [
      /@active/,
      /\btoday\b/,
      /\btomorrow\b/,
      /\bthis week\b/,
      /\bthis (morning|afternoon|evening)\b/,
      /\bcurrent draft\b/,
      /\bwip\b/,
      /\bin progress\b/,
      /\bjust (sent|received|uploaded|shared)\b/,
      /\b\d{4}-\d{2}-\d{2}\b/,     // ISO date
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}\b/,
    ];

    const durableScore = durablePatterns.filter((p) => p.test(text)).length;
    const workspaceScore = workspacePatterns.filter((p) => p.test(text)).length;

    if (durableScore > 0 && durableScore >= workspaceScore) {
      return {
        category: "durable",
        confidence: Math.min(0.5 + durableScore * 0.1, 0.95),
        reason: "preference/rule/identity signal",
      };
    }
    if (workspaceScore > 0) {
      return {
        category: "workspace",
        confidence: Math.min(0.5 + workspaceScore * 0.1, 0.95),
        reason: "temporal/in-progress signal",
      };
    }
    return { category: "knowledge", confidence: 0.6, reason: "reference material (default)" };
  }

  // ── Ingest ─────────────────────────────────────────────────────────────────

  /**
   * ingest(content, category, metadata?) → { id, sourceId, derivatives }
   *
   * For KNOWLEDGE: splits content into chunks and embeds each.
   *   PRODUCTION: embed() calls should be batched and awaited; the real
   *   implementation is async. The prototype calls embed() synchronously
   *   using the mock.
   *
   * @param {string} content
   * @param {"durable"|"knowledge"|"workspace"} category
   * @param {object} [metadata]
   * @returns {{ id: string; sourceId: string; derivatives: string[] }}
   */
  ingest(content, category, metadata = {}) {
    if (!CATEGORIES.includes(category)) {
      throw new Error(`Unknown category: ${category}. Must be one of: ${CATEGORIES.join(", ")}`);
    }
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("content must be a non-empty string");
    }

    const now = new Date().toISOString();

    if (category === "durable") {
      return this._ingestDurable(content, metadata, now);
    }
    if (category === "knowledge") {
      return this._ingestKnowledge(content, metadata, now);
    }
    return this._ingestWorkspace(content, metadata, now);
  }

  _ingestDurable(content, metadata, now) {
    const store = this._readStore("durable");
    const tokenCount = estimateTokens(content);

    // Conflict check: is this near-identical to an existing record?
    const conflict = store.find(
      (r) => levenshteinRatio(r.content, content) > CONFLICT_RATIO_THRESHOLD
    );

    if (conflict) {
      // Newer wins: push old content to history, update in place
      conflict.history = conflict.history || [];
      conflict.history.push({ content: conflict.content, updatedAt: conflict.updatedAt });
      conflict.content = content;
      conflict.tokenCount = tokenCount;
      conflict.updatedAt = now;
      if (metadata && Object.keys(metadata).length) {
        conflict.metadata = { ...conflict.metadata, ...metadata };
      }
      this._writeStore("durable", store);
      return { id: conflict.id, sourceId: conflict.sourceId, derivatives: [] };
    }

    const id = newId();
    const record = {
      id,
      sourceId: id,
      category: "durable",
      content,
      tokenCount,
      priority: metadata.priority ?? 5,
      tags: metadata.tags ?? [],
      metadata: { ...metadata, priority: undefined, tags: undefined },
      history: [],
      createdAt: now,
      updatedAt: now,
    };

    store.push(record);
    this._writeStore("durable", store);
    return { id, sourceId: id, derivatives: [] };
  }

  _ingestKnowledge(content, metadata, now) {
    // Split into chunks
    const chunks = chunkByTokens(content, CHUNK_TOKENS);
    const sourceId = newId();
    const ids = [];

    const store = this._readStore("knowledge");

    chunks.forEach((chunkText, i) => {
      const id = i === 0 ? sourceId : newId();
      ids.push(id);
      const embedding = embed(chunkText); // PRODUCTION: await real embed call

      store.push({
        id,
        sourceId,
        isSource: i === 0,
        category: "knowledge",
        content: chunkText,
        embedding,
        chunkIndex: i,
        totalChunks: chunks.length,
        tokenCount: estimateTokens(chunkText),
        tags: metadata.tags ?? [],
        metadata: {
          title: metadata.title,
          url: metadata.url,
          mimeType: metadata.mimeType,
          ...metadata,
          tags: undefined,
        },
        createdAt: now,
        updatedAt: now,
      });
    });

    this._writeStore("knowledge", store);
    return { id: sourceId, sourceId, derivatives: ids.slice(1) };
  }

  _ingestWorkspace(content, metadata, now) {
    const store = this._readStore("workspace");
    const id = newId();
    const isActive = (metadata.tags ?? []).includes("@active") || metadata.active === true;
    const expiresAt = isActive ? null : new Date(Date.now() + WORKSPACE_TTL_MS).toISOString();

    const record = {
      id,
      sourceId: id,
      category: "workspace",
      content,
      tokenCount: estimateTokens(content),
      expiresAt,
      active: isActive,
      tags: metadata.tags ?? [],
      metadata: { ...metadata, tags: undefined, active: undefined },
      createdAt: now,
      updatedAt: now,
    };

    store.push(record);
    this._writeStore("workspace", store);
    return { id, sourceId: id, derivatives: [] };
  }

  // ── Retrieve ───────────────────────────────────────────────────────────────

  /**
   * retrieve(query, options?) → ranked records
   *
   * PRODUCTION: embed() will be async; make this function async and await it.
   *
   * @param {string} query
   * @param {{ categories?: string[]; topK?: number; budgetTokens?: number }} [options]
   * @returns {Array<{ id: string; sourceId: string; content: string; score: number; category: string }>}
   */
  retrieve(query, options = {}) {
    const {
      categories = CATEGORIES,
      topK = 5,
      budgetTokens,
    } = options;

    const results = [];

    if (categories.includes("durable")) {
      const budget = budgetTokens ?? TOKEN_BUDGETS.durable;
      const recs = this._retrieveDurable(budget);
      results.push(...recs.map((r) => ({ ...r, score: 1.0, category: "durable" })));
    }

    if (categories.includes("knowledge")) {
      const budget = budgetTokens ?? TOKEN_BUDGETS.knowledge;
      const recs = this._retrieveKnowledge(query, topK, budget);
      results.push(...recs);
    }

    if (categories.includes("workspace")) {
      const budget = budgetTokens ?? TOKEN_BUDGETS.workspace;
      const recs = this._retrieveWorkspace(query, budget);
      results.push(...recs);
    }

    return results;
  }

  _retrieveDurable(budget) {
    const store = this._readStore("durable");
    const sorted = [...store].sort((a, b) => {
      if (b.priority !== a.priority) return (b.priority || 5) - (a.priority || 5);
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
    return fitWithinBudget(sorted, budget);
  }

  _retrieveKnowledge(query, topK, budget) {
    const store = this._readStore("knowledge");
    if (store.length === 0) return [];

    const queryVec = embed(query); // PRODUCTION: await
    const scored = store
      .filter((r) => r.embedding && r.embedding.length > 0)
      .map((r) => ({
        ...r,
        score: similarity(queryVec, r.embedding),
        category: "knowledge",
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return fitWithinBudget(scored, budget);
  }

  _retrieveWorkspace(query, budget) {
    const now = Date.now();
    const store = this._readStore("workspace");

    const live = store.filter((r) => {
      if (r.active) return true;
      if (!r.expiresAt) return true;
      return new Date(r.expiresAt).getTime() > now;
    });

    // Score: @active = 1.0; temporal query match = 0.8; recent = 0.6
    const queryLower = query.toLowerCase();
    const scored = live.map((r) => {
      if (r.active) return { ...r, score: 1.0, category: "workspace" };
      const temporal = /\b(today|tomorrow|this week|this month)\b/.test(queryLower);
      const score = temporal ? 0.8 : 0.6;
      return { ...r, score, category: "workspace" };
    });

    sorted(scored, (a, b) => b.score - a.score || new Date(b.updatedAt) - new Date(a.updatedAt));
    return fitWithinBudget(scored, budget);
  }

  // ── Promote / Demote ───────────────────────────────────────────────────────

  /**
   * promote(sourceId, toCategory) — move records up the persistence hierarchy.
   * Deletes from source, inserts into target.
   */
  promote(sourceId, toCategory) {
    return this._move(sourceId, toCategory);
  }

  /**
   * demote(sourceId, toCategory) — move records down (e.g. knowledge → workspace).
   */
  demote(sourceId, toCategory) {
    return this._move(sourceId, toCategory);
  }

  _move(sourceId, toCategory) {
    if (!CATEGORIES.includes(toCategory)) {
      throw new Error(`Unknown target category: ${toCategory}`);
    }

    const now = new Date().toISOString();
    const moved = [];

    // Find the source records across all categories
    for (const cat of CATEGORIES) {
      if (cat === toCategory) continue;
      const store = this._readStore(cat);
      const records = store.filter((r) => r.sourceId === sourceId);
      if (records.length === 0) continue;

      // Re-ingest content into the new category
      for (const rec of records) {
        const result = this.ingest(rec.content, toCategory, {
          ...rec.metadata,
          tags: rec.tags,
          priority: rec.priority,
        });
        moved.push(result.id);
      }

      // Remove originals
      const remaining = store.filter((r) => r.sourceId !== sourceId);
      this._writeStore(cat, remaining);
    }

    return { moved: moved.length, newIds: moved };
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  /**
   * del(sourceId) — delete source record + all derivatives across all categories.
   *
   * PRODUCTION: if using a vector DB, also call the DB's delete API for each id.
   *
   * @param {string} sourceId
   * @returns {{ deleted: string[] }}
   */
  del(sourceId) {
    const deleted = [];

    for (const cat of CATEGORIES) {
      const store = this._readStore(cat);
      const before = store.length;
      const toDelete = store.filter((r) => r.sourceId === sourceId);
      const remaining = store.filter((r) => r.sourceId !== sourceId);

      if (remaining.length < before) {
        deleted.push(...toDelete.map((r) => r.id));
        this._writeStore(cat, remaining);
      }
    }

    return { deleted };
  }

  // ── List ───────────────────────────────────────────────────────────────────

  /**
   * list(category, filter?) — enumerate records.
   *
   * @param {"durable"|"knowledge"|"workspace"} category
   * @param {{ tags?: string[]; since?: string; search?: string }} [filter]
   */
  list(category, filter = {}) {
    if (!CATEGORIES.includes(category)) {
      throw new Error(`Unknown category: ${category}`);
    }

    let store = this._readStore(category);

    if (filter.since) {
      const since = new Date(filter.since).getTime();
      store = store.filter((r) => new Date(r.updatedAt).getTime() >= since);
    }

    if (filter.tags && filter.tags.length > 0) {
      store = store.filter((r) =>
        filter.tags.every((t) => (r.tags || []).includes(t))
      );
    }

    if (filter.search) {
      const q = filter.search.toLowerCase();
      store = store.filter((r) => r.content.toLowerCase().includes(q));
    }

    return store;
  }

  // ── Audit ──────────────────────────────────────────────────────────────────

  /**
   * audit() — consistency report. Surfaces budget overages, conflicts, orphans.
   */
  audit() {
    const now = Date.now();
    const counts = {};
    const tokenTotals = {};
    const budgetStatus = {};
    let conflicts = [];
    let orphanedDerivatives = [];
    let expiredWorkspace = 0;

    for (const cat of CATEGORIES) {
      const store = this._readStore(cat);
      counts[cat] = store.length;
      tokenTotals[cat] = store.reduce((s, r) => s + (r.tokenCount || 0), 0);
      budgetStatus[cat] = {
        used: tokenTotals[cat],
        cap: TOKEN_BUDGETS[cat],
        over: tokenTotals[cat] > TOKEN_BUDGETS[cat],
      };
    }

    // Conflicts in durable: records with non-empty history
    const durable = this._readStore("durable");
    conflicts = durable
      .filter((r) => r.history && r.history.length > 0)
      .map((r) => ({
        ids: [r.id],
        reason: `${r.history.length} previous version(s) in history`,
      }));

    // Orphaned knowledge derivatives: chunks whose sourceId has no isSource record
    const knowledge = this._readStore("knowledge");
    const sourceIds = new Set(knowledge.filter((r) => r.isSource).map((r) => r.sourceId));
    orphanedDerivatives = knowledge
      .filter((r) => !r.isSource && !sourceIds.has(r.sourceId))
      .map((r) => r.id);

    // Expired workspace
    const workspace = this._readStore("workspace");
    expiredWorkspace = workspace.filter(
      (r) => !r.active && r.expiresAt && new Date(r.expiresAt).getTime() <= now
    ).length;

    return {
      counts,
      tokenTotals,
      budgetStatus,
      conflicts,
      orphanedDerivatives,
      expiredWorkspace,
    };
  }

  /**
   * evict() — remove expired workspace records from disk.
   */
  evict() {
    const now = Date.now();
    const store = this._readStore("workspace");
    const before = store.length;
    const remaining = store.filter(
      (r) => r.active || !r.expiresAt || new Date(r.expiresAt).getTime() > now
    );
    if (remaining.length < before) {
      this._writeStore("workspace", remaining);
    }
    return { evicted: before - remaining.length };
  }

  // ── Storage helpers ────────────────────────────────────────────────────────

  _storePath(category) {
    return path.join(this.dataDir, `${category}.json`);
  }

  _readStore(category) {
    const p = this._storePath(category);
    if (!fs.existsSync(p)) return [];
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return [];
    }
  }

  _writeStore(category, data) {
    const p = this._storePath(category);
    fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
  }

  _ensureDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function newId() {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Rough token estimator: 1 token ≈ 4 chars.
 * Production: use the target model's tokeniser (tiktoken, etc.)
 */
function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

/**
 * Split text into chunks of at most `maxTokens` each, on sentence/word
 * boundaries where possible.
 */
function chunkByTokens(text, maxTokens) {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let pos = 0;
  while (pos < text.length) {
    let end = pos + maxChars;
    if (end >= text.length) {
      chunks.push(text.slice(pos));
      break;
    }
    // Try to break on sentence boundary first, then word
    const window = text.slice(pos, end);
    const sentenceBreak = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf(".\n"),
      window.lastIndexOf("! "),
      window.lastIndexOf("? ")
    );
    if (sentenceBreak > maxChars * 0.5) {
      end = pos + sentenceBreak + 2;
    } else {
      const wordBreak = window.lastIndexOf(" ");
      if (wordBreak > maxChars * 0.5) end = pos + wordBreak + 1;
    }
    chunks.push(text.slice(pos, end).trim());
    pos = end;
  }
  return chunks.filter((c) => c.length > 0);
}

/**
 * Greedy budget packing: accumulate records until token limit is reached.
 */
function fitWithinBudget(records, budget) {
  const out = [];
  let total = 0;
  for (const r of records) {
    const t = r.tokenCount || estimateTokens(r.content);
    if (total + t > budget && out.length > 0) break;
    out.push(r);
    total += t;
  }
  return out;
}

/**
 * Levenshtein ratio: 0 = completely different, 1 = identical.
 * Only computed on strings ≤ 500 chars to avoid O(n²) on large documents.
 */
function levenshteinRatio(a, b) {
  const sa = (a || "").toLowerCase().slice(0, 500);
  const sb = (b || "").toLowerCase().slice(0, 500);
  if (sa === sb) return 1;
  if (sa.length === 0 || sb.length === 0) return 0;

  const m = sa.length;
  const n = sb.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        sa[i - 1] === sb[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  const dist = dp[m][n];
  return 1 - dist / Math.max(m, n);
}

/** In-place sort helper (returns the array for chaining). */
function sorted(arr, compareFn) {
  arr.sort(compareFn);
  return arr;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  MemoryStore,
  // Exported for testing
  _utils: { estimateTokens, chunkByTokens, fitWithinBudget, levenshteinRatio, newId },
};
