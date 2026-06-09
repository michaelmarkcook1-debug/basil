/**
 * memory-test.js — Unit tests for the Basil memory system.
 *
 * Zero dependencies. Uses Node.js built-in assert module.
 * Run: node memory-test.js
 *
 * Each test function is self-contained and uses a temporary directory
 * so tests are isolated and do not interfere.
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { MemoryStore, _utils } = require("./memory");
const { embed, similarity } = require("./embeddings");

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗  ${name}`);
    console.log(`       ${err.message}`);
    failed++;
    failures.push({ name, error: err.message });
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "basil-memory-test-"));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 1. Classification ─────────────────────────────────────────────────────────

console.log("\n1. Classification");

test("classify preference → durable", () => {
  const store = new MemoryStore(tempDir());
  const r = store.classify("I prefer Zoom over Google Meet for all video calls.");
  assert.strictEqual(r.category, "durable");
  assert.ok(r.confidence >= 0.5);
  assert.ok(r.reason.length > 0);
  cleanup(store.dataDir);
});

test("classify rule → durable", () => {
  const store = new MemoryStore(tempDir());
  const r = store.classify("Rule: Always CC Sam on investor communications.");
  assert.strictEqual(r.category, "durable");
  cleanup(store.dataDir);
});

test("classify temporal reference → workspace", () => {
  const store = new MemoryStore(tempDir());
  const r = store.classify("Today's call with Jordan at 2pm needs prep.");
  assert.strictEqual(r.category, "workspace");
  cleanup(store.dataDir);
});

test("classify @active tag → workspace", () => {
  const store = new MemoryStore(tempDir());
  const r = store.classify("Current draft @active — Example Analytics pricing model v3.");
  assert.strictEqual(r.category, "workspace");
  cleanup(store.dataDir);
});

test("classify reference material → knowledge", () => {
  const store = new MemoryStore(tempDir());
  const r = store.classify(
    "Gartner defines industry analyst platforms as tools that aggregate research from multiple analyst firms."
  );
  assert.strictEqual(r.category, "knowledge");
  cleanup(store.dataDir);
});

test("classify object input", () => {
  const store = new MemoryStore(tempDir());
  const r = store.classify({ content: "I prefer short bullets over prose in briefings." });
  assert.strictEqual(r.category, "durable");
  cleanup(store.dataDir);
});

test("classify empty string → knowledge (default)", () => {
  const store = new MemoryStore(tempDir());
  const r = store.classify("");
  assert.strictEqual(r.category, "knowledge");
  cleanup(store.dataDir);
});

// ── 2. Ingestion ──────────────────────────────────────────────────────────────

console.log("\n2. Ingestion");

test("ingest into durable returns id and sourceId", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  const result = store.ingest("I prefer Zoom.", "durable");
  assert.ok(result.id, "id should be set");
  assert.strictEqual(result.id, result.sourceId, "durable source has sourceId === id");
  assert.deepStrictEqual(result.derivatives, []);
  cleanup(dir);
});

test("ingest into durable writes to durable.json", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  store.ingest("I am CEO of Example Analytics.", "durable", { priority: 8 });
  const records = JSON.parse(fs.readFileSync(path.join(dir, "durable.json"), "utf8"));
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].priority, 8);
  assert.ok(records[0].tokenCount > 0);
  cleanup(dir);
});

test("ingest into knowledge creates chunks and embeddings", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  const longDoc = "Word ".repeat(2000); // ~500 tokens → will chunk
  const result = store.ingest(longDoc, "knowledge", { title: "Test Doc" });
  const records = JSON.parse(fs.readFileSync(path.join(dir, "knowledge.json"), "utf8"));
  assert.ok(records.length > 1, "long document should produce multiple chunks");
  assert.ok(result.derivatives.length > 0, "should have derivative chunk ids");
  assert.ok(records[0].embedding.length > 0, "chunks should be embedded");
  // All chunks share the same sourceId
  for (const r of records) assert.strictEqual(r.sourceId, result.sourceId);
  cleanup(dir);
});

test("ingest into workspace sets expiresAt", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  store.ingest("Draft Example Analytics pricing doc.", "workspace");
  const records = JSON.parse(fs.readFileSync(path.join(dir, "workspace.json"), "utf8"));
  assert.strictEqual(records.length, 1);
  assert.ok(records[0].expiresAt !== null, "should have an expiry");
  cleanup(dir);
});

test("ingest @active workspace skips TTL", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  store.ingest("Live pricing model.", "workspace", { tags: ["@active"] });
  const records = JSON.parse(fs.readFileSync(path.join(dir, "workspace.json"), "utf8"));
  assert.strictEqual(records[0].active, true);
  assert.strictEqual(records[0].expiresAt, null);
  cleanup(dir);
});

test("ingest unknown category throws", () => {
  const store = new MemoryStore(tempDir());
  assert.throws(
    () => store.ingest("test", "invalid"),
    /Unknown category/
  );
  cleanup(store.dataDir);
});

// ── 3. Retrieval ──────────────────────────────────────────────────────────────

console.log("\n3. Retrieval");

test("retrieve durable returns records sorted by priority", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  store.ingest("Low priority fact.", "durable", { priority: 2 });
  store.ingest("High priority preference.", "durable", { priority: 9 });
  const results = store.retrieve("anything", { categories: ["durable"] });
  assert.ok(results.length === 2);
  assert.ok(results[0].content.includes("High priority"), "higher priority first");
  cleanup(dir);
});

test("retrieve durable enforces token budget", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  // Add 3 records, each ~300 tokens (1200 chars). Budget = 2000 tokens → max 6 records
  // but we'll set a small budget to force truncation
  for (let i = 0; i < 5; i++) {
    store.ingest("x".repeat(1200), "durable", { priority: 5 });
  }
  // With budget=500 tokens, only ~1 record fits (each ~300 tokens)
  const results = store.retrieve("query", { categories: ["durable"], budgetTokens: 500 });
  assert.ok(results.length < 5, "budget should truncate results");
  cleanup(dir);
});

test("retrieve knowledge by semantic similarity", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  // Two documents — same text should score highest against itself
  const id1 = store.ingest("Basil is an AI executive assistant.", "knowledge");
  store.ingest("Completely unrelated: quantum entanglement in photons.", "knowledge");
  const results = store.retrieve("AI executive assistant", { categories: ["knowledge"] });
  assert.ok(results.length > 0);
  // The first result's sourceId should match the relevant document
  assert.strictEqual(results[0].sourceId, id1.sourceId);
  cleanup(dir);
});

test("retrieve workspace excludes expired records", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  // Manually insert an already-expired record
  const expired = {
    id: "deadbeef00000001",
    sourceId: "deadbeef00000001",
    category: "workspace",
    content: "Old draft from last week.",
    tokenCount: 6,
    expiresAt: new Date(Date.now() - 1000).toISOString(), // 1 second ago
    active: false,
    tags: [],
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const live = {
    id: "deadbeef00000002",
    sourceId: "deadbeef00000002",
    category: "workspace",
    content: "Current draft for today.",
    tokenCount: 5,
    expiresAt: new Date(Date.now() + 86400000).toISOString(), // tomorrow
    active: false,
    tags: [],
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, "workspace.json"), JSON.stringify([expired, live]), "utf8");

  const results = store.retrieve("draft", { categories: ["workspace"] });
  assert.ok(results.every((r) => r.id !== expired.id), "expired record should not appear");
  assert.ok(results.some((r) => r.id === live.id), "live record should appear");
  cleanup(dir);
});

// ── 4. Deletion fan-out ───────────────────────────────────────────────────────

console.log("\n4. Deletion fan-out");

test("del removes source + all derivatives", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  const result = store.ingest("Word ".repeat(2000), "knowledge"); // multi-chunk
  const totalChunks = 1 + result.derivatives.length;
  assert.ok(totalChunks > 1, "test precondition: should have derivatives");

  const { deleted } = store.del(result.sourceId);
  assert.strictEqual(deleted.length, totalChunks, "all chunks removed");

  const remaining = store.list("knowledge");
  assert.strictEqual(remaining.length, 0, "store should be empty after del");
  cleanup(dir);
});

test("del only removes records matching sourceId", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  const r1 = store.ingest("Document A.", "knowledge");
  const r2 = store.ingest("Document B.", "knowledge");

  store.del(r1.sourceId);

  const remaining = store.list("knowledge");
  assert.strictEqual(remaining.length, 1, "only the targeted source removed");
  assert.strictEqual(remaining[0].sourceId, r2.sourceId);
  cleanup(dir);
});

test("del works across all categories", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  const r = store.ingest("Shared content.", "durable");
  // Manually add a record with same sourceId in workspace to simulate cross-category
  const ws = JSON.parse(fs.readFileSync(path.join(dir, "durable.json"), "utf8"));
  // Use ingest then manually set sourceId to r.sourceId for testing cross-category del
  store.ingest("Related workspace item.", "workspace");
  const wsStore = JSON.parse(fs.readFileSync(path.join(dir, "workspace.json"), "utf8"));
  wsStore[0].sourceId = r.sourceId;
  fs.writeFileSync(path.join(dir, "workspace.json"), JSON.stringify(wsStore), "utf8");

  const { deleted } = store.del(r.sourceId);
  assert.ok(deleted.length >= 2, "should remove from both durable and workspace");
  assert.strictEqual(store.list("durable").length, 0);
  assert.strictEqual(store.list("workspace").length, 0);
  cleanup(dir);
});

test("del non-existent sourceId returns empty array", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  const { deleted } = store.del("nonexistent00000");
  assert.deepStrictEqual(deleted, []);
  cleanup(dir);
});

// ── 5. Promotion / Demotion ───────────────────────────────────────────────────

console.log("\n5. Promotion / Demotion");

test("promote knowledge → durable moves content and removes original", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  const r = store.ingest("I prefer structured meeting agendas.", "knowledge");
  assert.strictEqual(store.list("knowledge").length, 1);
  assert.strictEqual(store.list("durable").length, 0);

  const result = store.promote(r.sourceId, "durable");
  assert.ok(result.moved > 0, "should have moved records");
  assert.strictEqual(store.list("knowledge").length, 0, "original should be removed");
  assert.strictEqual(store.list("durable").length, 1, "should now be in durable");
  cleanup(dir);
});

test("demote durable → workspace sets TTL", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  const r = store.ingest("Temporary context: fundraising mode until Q3.", "durable");
  store.demote(r.sourceId, "workspace");
  assert.strictEqual(store.list("durable").length, 0);
  const ws = store.list("workspace");
  assert.strictEqual(ws.length, 1);
  assert.ok(ws[0].expiresAt !== null, "demoted workspace item should have TTL");
  cleanup(dir);
});

// ── 6. Token budget enforcement ───────────────────────────────────────────────

console.log("\n6. Token budget enforcement");

test("fitWithinBudget: greedy packing stops at cap", () => {
  const { fitWithinBudget } = _utils;
  const records = [
    { content: "a".repeat(400), tokenCount: 100 },
    { content: "b".repeat(400), tokenCount: 100 },
    { content: "c".repeat(400), tokenCount: 100 },
  ];
  const result = fitWithinBudget(records, 250);
  assert.strictEqual(result.length, 2, "only 2 records fit in 250-token budget");
});

test("fitWithinBudget: always returns at least one record", () => {
  const { fitWithinBudget } = _utils;
  const records = [{ content: "x".repeat(4000), tokenCount: 1000 }];
  const result = fitWithinBudget(records, 100); // single record exceeds budget
  // First record is always included even if it overflows the budget
  assert.strictEqual(result.length, 1, "at least one record included even over budget");
});

test("durable budget respected in retrieve", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  // Add 10 records of 60 tokens each (240 chars). Total = 600 tokens.
  for (let i = 0; i < 10; i++) {
    store.ingest("x".repeat(240), "durable", { priority: 5 });
  }
  const results = store.retrieve("q", { categories: ["durable"], budgetTokens: 300 });
  const total = results.reduce((s, r) => s + (r.tokenCount || 0), 0);
  assert.ok(total <= 360, `token total ${total} should be within budget`); // 1 record overflow OK
  cleanup(dir);
});

// ── 7. Conflict resolution ────────────────────────────────────────────────────

console.log("\n7. Conflict resolution");

test("ingesting near-duplicate updates in place, not creates new record", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  const original = "I prefer Zoom for all video calls.";
  store.ingest(original, "durable");
  assert.strictEqual(store.list("durable").length, 1);

  // Near-identical update (> 80% similar)
  const updated = "I prefer Zoom for all video calls always.";
  store.ingest(updated, "durable");

  const records = store.list("durable");
  assert.strictEqual(records.length, 1, "should not create a new record — update in place");
  assert.strictEqual(records[0].content, updated, "content should be the newer version");
  assert.ok(records[0].history.length > 0, "original should be archived in history");
  assert.strictEqual(records[0].history[0].content, original, "history holds old version");
  cleanup(dir);
});

test("audit surfaces conflicts (records with history)", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  // Two strings with levenshtein ratio > 0.8 (one char difference)
  store.ingest("I prefer shorter emails in all contexts.", "durable");
  store.ingest("I prefer shorter emails in all context.", "durable"); // triggers conflict

  const report = store.audit();
  assert.ok(report.conflicts.length > 0, "audit should report the conflict");
  cleanup(dir);
});

test("distinct content creates separate records", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  store.ingest("I prefer Zoom.", "durable");
  store.ingest("I prefer Slack for async comms.", "durable");
  assert.strictEqual(store.list("durable").length, 2, "distinct content creates two records");
  cleanup(dir);
});

// ── 8. Audit ──────────────────────────────────────────────────────────────────

console.log("\n8. Audit");

test("audit returns counts and budget status for all categories", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  store.ingest("Durable rule.", "durable");
  store.ingest("Knowledge doc.", "knowledge");
  store.ingest("Today's draft.", "workspace");

  const report = store.audit();
  assert.ok(report.counts.durable >= 1);
  assert.ok(report.counts.knowledge >= 1);
  assert.ok(report.counts.workspace >= 1);
  assert.ok(typeof report.budgetStatus.durable.over === "boolean");
  cleanup(dir);
});

test("audit reports orphaned derivatives", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  // Manually insert an orphaned knowledge chunk (sourceId has no isSource peer)
  const orphan = {
    id: "orphan00000001",
    sourceId: "missingSource001",
    isSource: false,
    category: "knowledge",
    content: "Orphaned chunk.",
    embedding: [],
    chunkIndex: 1,
    totalChunks: 2,
    tokenCount: 4,
    tags: [],
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, "knowledge.json"), JSON.stringify([orphan]), "utf8");

  const report = store.audit();
  assert.ok(report.orphanedDerivatives.includes("orphan00000001"));
  cleanup(dir);
});

test("audit reports expired workspace count", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  const expiredRecord = {
    id: "exp0000000000001",
    sourceId: "exp0000000000001",
    category: "workspace",
    content: "Expired item.",
    tokenCount: 3,
    expiresAt: new Date(Date.now() - 60000).toISOString(),
    active: false,
    tags: [],
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, "workspace.json"), JSON.stringify([expiredRecord]), "utf8");

  const report = store.audit();
  assert.strictEqual(report.expiredWorkspace, 1);
  cleanup(dir);
});

// ── 9. Embeddings ─────────────────────────────────────────────────────────────

console.log("\n9. Embeddings");

test("embed returns array of correct length", () => {
  const vec = embed("test sentence");
  assert.ok(Array.isArray(vec));
  assert.ok(vec.length > 0);
});

test("embed is deterministic for same input", () => {
  const a = embed("exact same text");
  const b = embed("exact same text");
  assert.deepStrictEqual(a, b);
});

test("embed produces different vectors for different text", () => {
  const a = embed("I prefer Zoom.");
  const b = embed("Quantum mechanics and photon entanglement.");
  const sim = similarity(a, b);
  assert.ok(sim < 0.99, `dissimilar texts should have low similarity, got ${sim.toFixed(3)}`);
});

test("similarity of identical vectors = 1", () => {
  const a = embed("same text");
  const sim = similarity(a, a);
  assert.ok(Math.abs(sim - 1.0) < 1e-6, `expected ~1, got ${sim}`);
});

test("similarity of zero vectors = 0", () => {
  const a = new Array(32).fill(0);
  const b = new Array(32).fill(0);
  const sim = similarity(a, b);
  assert.strictEqual(sim, 0);
});

// ── 10. List and evict ────────────────────────────────────────────────────────

console.log("\n10. List and evict");

test("list filters by tags", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  // Use clearly distinct strings to avoid conflict-detection merging them
  store.ingest("Jordan Avery is a strategic thinker and Example Analytics investor.", "durable", { tags: ["investor"] });
  store.ingest("Sam Rivera runs day-to-day operations and reports to the board.", "durable");
  const tagged = store.list("durable", { tags: ["investor"] });
  assert.strictEqual(tagged.length, 1);
  assert.ok(tagged[0].content.includes("Jordan"), "should return the tagged record");
  cleanup(dir);
});

test("list filters by search substring", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  store.ingest("Jordan Avery is on the board.", "durable");
  store.ingest("Sam Rivera runs operations.", "durable");
  const results = store.list("durable", { search: "jordan" });
  assert.strictEqual(results.length, 1);
  cleanup(dir);
});

test("evict removes expired workspace records from disk", () => {
  const dir = tempDir();
  const store = new MemoryStore(dir);
  // Insert one expired, one live
  const data = [
    {
      id: "evict0000000001",
      sourceId: "evict0000000001",
      category: "workspace",
      content: "Expired.",
      tokenCount: 1,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      active: false,
      tags: [],
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "evict0000000002",
      sourceId: "evict0000000002",
      category: "workspace",
      content: "Still live.",
      tokenCount: 2,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      active: false,
      tags: [],
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  fs.writeFileSync(path.join(dir, "workspace.json"), JSON.stringify(data), "utf8");

  const { evicted } = store.evict();
  assert.strictEqual(evicted, 1);
  assert.strictEqual(store.list("workspace").length, 1);
  cleanup(dir);
});

// ── Summary ───────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${"─".repeat(50)}`);
console.log(`  ${passed}/${total} tests passed`);
if (failed > 0) {
  console.log(`  ${failed} failed:`);
  for (const f of failures) console.log(`    ✗ ${f.name}: ${f.error}`);
  process.exit(1);
} else {
  console.log("  All tests passed.");
}
