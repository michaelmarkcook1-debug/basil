/**
 * Tier-2 fixes from the 2026-09-15 audit — the stale-cache mutation class.
 *
 * The shape every time: a mutation reads the /tmp write-through cache inside a
 * lock, appends or edits, and writes the whole collection back. The lock gives
 * mutual exclusion; it says nothing about whether the cached copy is current.
 * A second warm instance — or, for the dispatcher, a second in-flight call on
 * the same instance — overwrites the first's write.
 *
 * Every case runs the real module via tests/_helpers/load-ts.mjs against an
 * in-memory user-store that models exactly that: shared durable storage, one
 * cache per instance, one lock per instance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTs, makeLock } from "./_helpers/load-ts.mjs";

const clone = (v) => structuredClone(v);
/**
 * Wait for fire-and-forget writes to land. A fixed sleep flaked under the full
 * suite's parallel load (17 of 25 had landed at 250ms). Polling the durable
 * store is deterministic, and a genuinely lost write still fails — the count
 * never arrives and the assertion reports what did.
 */
async function waitFor(read, predicate, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (predicate(read())) return; await new Promise((r) => setTimeout(r, 10)); }
}

/**
 * Two (or more) warm serverless instances over one durable store. Each
 * instance has its own /tmp cache and its own in-process lock — the only thing
 * they share is what has actually been written durably.
 */
function durableStore(seed = {}, { latencyMs = 0 } = {}) {
  const durable = new Map(Object.entries(seed).map(([k, v]) => [k, clone(v)]));
  const key = (u, f) => `${u}/${f}`;
  // Real Blob reads take tens of milliseconds. A zero-latency mock resolves in
  // the next microtask, Node drains each read-modify-write before the next
  // timer fires, and the concurrent lost-update race can never happen — the
  // pre-fix dispatcher passed a 25-way concurrency test that way. Latency
  // restores the window the bug lives in.
  const io = () => (latencyMs ? new Promise((r) => setTimeout(r, latencyMs)) : undefined);
  const instance = () => {
    const cache = new Map();
    const lock = makeLock();
    const readUserStore = async (u, f, fallback, opts) => {
      await io();
      const k = key(u, f);
      if (!cache.has(k) || opts?.fresh) cache.set(k, clone(durable.has(k) ? durable.get(k) : fallback));
      return clone(cache.get(k));
    };
    const writeUserStore = async (u, f, items) => { await io(); durable.set(key(u, f), clone(items)); cache.set(key(u, f), clone(items)); };
    // Mirrors lib/storage/user-store.ts → persistent.ts updateStore: lock, fresh read, mutate, write.
    const updateUserStore = (u, f, mutator, fallback) =>
      lock.withLock(key(u, f), async () => { const next = mutator(await readUserStore(u, f, fallback, { fresh: true })); await writeUserStore(u, f, next); return next; });
    return { lock, mocks: { readUserStore, writeUserStore, updateUserStore } };
  };
  return { instance, durable: (u, f) => clone(durable.get(key(u, f)) ?? null) };
}

// ═════════════════════════════════════════════════════════════════════════════
// #2 — memory store
// ═════════════════════════════════════════════════════════════════════════════

const SEED_MEMORY = { id: "seed-1", kind: "fact", content: "Seed fact", source: "chat", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };

function memoryInstances(seed = [SEED_MEMORY]) {
  const store = durableStore({ "fixture/sage-memory.json": seed });
  const load = () => { const inst = store.instance(); return loadTs("lib/memory/store.ts", { "@/lib/events/lock": inst.lock, "@/lib/storage/user-store": inst.mocks }); };
  const a = load(), b = load();
  return { a, b, durable: () => store.durable("fixture", "sage-memory.json") ?? [] };
}

test("#2 memory: a save on one warm instance survives a later save on another", async () => {
  const { a, b, durable } = memoryInstances([]);
  await a.listMemories("fixture"); await b.listMemories("fixture"); // both caches warm and empty
  const first = await a.createMemory("fixture", { kind: "fact", content: "Fact A" });
  await b.createMemory("fixture", { kind: "fact", content: "Fact B" });
  const items = durable();
  assert.equal(items.length, 2, `durable store should hold both facts, has ${items.map((m) => m.content)}`);
  assert.ok(items.some((m) => m.id === first.id), "Fact A must not be overwritten by instance B");
});

test("#2 memory: an update on a stale instance does not erase another instance's new memory", async () => {
  const { a, b, durable } = memoryInstances();
  await a.listMemories("fixture"); await b.listMemories("fixture");
  const created = await a.createMemory("fixture", { kind: "context", content: "Fresh context" });
  const updated = await b.updateMemory("fixture", "seed-1", { content: "Seed fact, edited" });
  assert.equal(updated.content, "Seed fact, edited");
  const items = durable();
  assert.deepEqual(items.map((m) => m.id).sort(), [created.id, "seed-1"].sort());
});

test("#2 memory: a delete on a stale instance does not erase another instance's new memory", async () => {
  const { a, b, durable } = memoryInstances();
  await a.listMemories("fixture"); await b.listMemories("fixture");
  const created = await a.createMemory("fixture", { kind: "fact", content: "Keep me" });
  assert.equal(await b.deleteMemory("fixture", "seed-1"), true);
  assert.deepEqual(durable().map((m) => m.id), [created.id]);
});

test("#2 memory: createMemoryTracked reports a dedupe hit as not-created even when its cache is stale", async () => {
  const { a, b, durable } = memoryInstances([]);
  await a.listMemories("fixture"); await b.listMemories("fixture");
  await a.createMemory("fixture", { kind: "fact", content: "Same fact" });
  const r = await b.createMemoryTracked("fixture", { kind: "fact", content: "Same fact" });
  assert.equal(r.created, false, "instance B's stale cache must not turn a dedupe into a creation");
  assert.equal(durable().length, 1);
});

// ═════════════════════════════════════════════════════════════════════════════
// #2b — contact profile overrides (same pattern, verified in source by the audit)
// ═════════════════════════════════════════════════════════════════════════════

function overrideInstances() {
  const store = durableStore();
  const load = () => { const inst = store.instance(); return loadTs("lib/contacts/overrides-store.ts", { "@/lib/events/lock": inst.lock, "@/lib/storage/user-store": inst.mocks }); };
  return { a: load(), b: load(), durable: () => store.durable("fixture", "sage-contact-overrides.json") ?? {} };
}

test("#2b overrides: set, append and clear on a stale instance keep another instance's writes", async () => {
  const { a, b, durable } = overrideInstances();
  await a.getAllOverridesFromStore("fixture"); await b.getAllOverridesFromStore("fixture"); // warm, empty
  await a.setOverrideInStore("fixture", "c1", { personality: "direct" });
  await b.setOverrideInStore("fixture", "c2", { personality: "warm" });
  assert.deepEqual(Object.keys(durable()).sort(), ["c1", "c2"]);

  await b.appendToneObservation("fixture", "c3", { sourceRef: "gmail:1", tone: "terse", observedAt: "2026-09-15T10:00:00.000Z" });
  assert.deepEqual(Object.keys(durable()).sort(), ["c1", "c2", "c3"]);
  assert.equal(durable().c1.personality, "direct", "c1 written by A must survive B's later writes");

  await b.clearOverrideFromStore("fixture", "c2");
  assert.deepEqual(Object.keys(durable()).sort(), ["c1", "c3"]);
});

// ═════════════════════════════════════════════════════════════════════════════
// appendTrace — core/dispatch/dispatcher.ts (flagged 2026-09-04, fixed now)
// ═════════════════════════════════════════════════════════════════════════════

function dispatcherInstances() {
  const store = durableStore({}, { latencyMs: 3 });
  let n = 0;
  const load = () => {
    const inst = store.instance();
    class AIValidationError extends Error {}
    return loadTs("core/dispatch/dispatcher.ts", {
      "@/lib/storage/user-store": inst.mocks,
      "@/lib/ai/generate-validated": {
        AIValidationError,
        generateValidated: async ({ prompt }) => {
          if (prompt === "boom") throw new Error("provider down");
          await new Promise((r) => setTimeout(r, Math.random() * 4));
          return { ok: true };
        },
      },
      "@/lib/ingest/content-hash": { hashContent: (...a) => `${a.join("|")}#${n++}` },
      "@/lib/ai/model-config": {
        getTextModel: () => "mock-model",
        GATEWAY_MODEL_IDS: { fast: "gw/fast", default: "gw/default", long: "gw/long" },
        MAX_TOKENS: { fast: 256, default: 1024, long: 4096 },
      },
      "@/core/primitives/dispatch-request": { DISPATCH_LOG_FILE: "sage-dispatch-log.json", MAX_DISPATCH_TRACES: 1000 },
    });
  };
  const opts = (i, prompt = "go") => ({ username: "fixture", intent: "classify", sourceRef: `msg:${i}`, modelKind: "fast", system: "s", prompt, schema: {}, schemaName: "X" });
  return { a: load(), b: load(), opts, durable: () => store.durable("fixture", "sage-dispatch-log.json") ?? [] };
}

test("appendTrace: 25 concurrent dispatches on one instance leave 25 traces, not the last writer's", async () => {
  const { a, opts, durable } = dispatcherInstances();
  const quiet = console.info; console.info = () => {};
  try {
    await Promise.all(Array.from({ length: 25 }, (_, i) => a.dispatch(opts(i))));
    await waitFor(durable, (log) => log.length >= 25);
  } finally { console.info = quiet; }
  assert.equal(durable().length, 25, `expected 25 traces, durable log has ${durable().length}`);
  const viaReader = await a.readTraces("fixture", { limit: 100 });
  assert.equal(viaReader.length, 25);
});

test("appendTrace: a dispatch on a second warm instance does not overwrite the first instance's trace", async () => {
  const { a, b, opts, durable } = dispatcherInstances();
  const quiet = console.info; console.info = () => {};
  try {
    await a.readTraces("fixture"); await b.readTraces("fixture"); // both caches warm and empty
    await a.dispatch(opts(1)); await waitFor(durable, (log) => log.length >= 1);
    await b.dispatch(opts(2)); await waitFor(durable, (log) => log.length >= 2);
  } finally { console.info = quiet; }
  assert.deepEqual(durable().map((t) => t.sourceRef).sort(), ["msg:1", "msg:2"]);
});

test("appendTrace: a failed dispatch still records its trace and still rethrows", async () => {
  const { a, opts, durable } = dispatcherInstances();
  await assert.rejects(a.dispatch(opts(9, "boom")), /provider down/);
  await waitFor(durable, (log) => log.length >= 1);
  assert.equal(durable().length, 1);
  assert.equal(durable()[0].status, "provider_error");
});
