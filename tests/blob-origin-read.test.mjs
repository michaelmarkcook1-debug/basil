/**
 * The Blob adapter must read from ORIGIN, never the Blob CDN.
 *
 * Observed 2026-09-26: after put(..., { allowOverwrite: true }) on a user's
 * contacts file, list() showed the new size at once but the authenticated
 * `fetch(url + "?v=" + Date.now(), { cache: "no-store" })` read returned the
 * OLD body (x-vercel-cache: HIT, age: 328) for over a minute. Reproduced on
 * throwaway basil/_diag/* blobs: stale for 13s, 54s and 42s+ (still stale when
 * the run ended); `get(url, { access: "private", useCache: false })` returned
 * the new body on every read from +1s.
 * The CDN leaves the `?v=` cache-buster out of its cache key, and
 * cacheControlMaxAge: 60 did not bound the window (served stale at age=92).
 *
 * The danger is the fresh read inside a lock: a read-modify-write that sees the
 * pre-overwrite copy writes it back, resurrecting deletes and dropping the
 * other instance's write.
 *
 * Every case runs the real lib/storage/adapters/blob.ts via load-ts against a
 * fake Blob service whose CDN behaves as measured: it ignores unknown query
 * params, serves its cached copy until invalidated, and is bypassed only by
 * `?cache=0` (what the SDK's `useCache: false` sends).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const HOST = "https://teststore.private.blob.vercel-storage.com";
const urlFor = (pathname) => `${HOST}/${pathname}`;
const pathOf = (url) => new URL(url).pathname.slice(1);
// Values parsed inside the load-ts sandbox carry that realm's prototypes, which
// strict deepEqual rejects even when the data is identical.
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Origin storage plus a CDN that is NOT invalidated on overwrite (the propagation window). */
function blobService() {
  const origin = new Map(); // pathname → body text
  const cdn = new Map();    // pathname → body text the edge still holds
  const failNext = { status: 0 };

  const serve = (pathname, bypassCdn) => {
    if (failNext.status) {
      const status = failNext.status;
      failNext.status = 0;
      return { status };
    }
    if (!bypassCdn && cdn.has(pathname)) return { status: 200, body: cdn.get(pathname), cache: "HIT" };
    if (!origin.has(pathname)) return { status: 404 };
    const body = origin.get(pathname);
    if (!bypassCdn) cdn.set(pathname, body); // a normal read fills the edge
    return { status: 200, body, cache: "MISS" };
  };

  const sdk = {
    async put(pathname, body, opts) {
      assert.equal(opts.access, "private");
      origin.set(pathname, body);
      return { url: urlFor(pathname), pathname };
    },
    async list({ prefix }) {
      const blobs = [...origin.keys()]
        .filter((p) => p.startsWith(prefix))
        .map((p) => ({ pathname: p, url: urlFor(p), size: origin.get(p).length, uploadedAt: new Date() }));
      return { blobs, hasMore: false };
    },
    async del(urls) {
      for (const u of [urls].flat()) origin.delete(pathOf(u));
    },
    // Mirrors @vercel/blob get(): useCache:false → ?cache=0 → origin; 404 → null; other !ok → throws.
    async get(url, opts) {
      assert.equal(opts.access, "private");
      const r = serve(pathOf(url), opts.useCache === false);
      if (r.status === 404) return null;
      if (r.status !== 200) throw new Error(`Failed to fetch blob: ${r.status}`);
      return {
        statusCode: 200,
        stream: new Response(r.body).body,
        headers: new Headers({ "x-vercel-cache": r.cache }),
        blob: { url, pathname: pathOf(url), etag: "", contentType: "application/json", size: r.body.length },
      };
    },
  };

  // The raw-fetch path the adapter used before: only ?cache=0 bypasses the edge.
  const fetch = async (input) => {
    const u = new URL(String(input));
    const r = serve(u.pathname.slice(1), u.searchParams.get("cache") === "0");
    return new Response(r.body ?? null, { status: r.status, headers: r.cache ? { "x-vercel-cache": r.cache } : {} });
  };

  return { origin, cdn, sdk, fetch, failNext };
}

/** Load a fresh adapter instance (its own URL cache — i.e. its own serverless instance). */
function loadAdapter(svc) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = svc.fetch; // load-ts hands the sandbox whatever `fetch` is at load time
  try {
    return loadTs("lib/storage/adapters/blob.ts", { "@vercel/blob": svc.sdk }, { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_teststore_x" });
  } finally {
    globalThis.fetch = realFetch;
  }
}

const SCOPE = "users/testuser";
const FILE = "sage-user-contacts.json";
const PATH = `basil/${SCOPE}/${FILE}`;

test("a read after an overwrite returns the new body while the CDN still holds the old one", async () => {
  const svc = blobService();
  const blob = loadAdapter(svc);

  await blob.blobWriteJson(SCOPE, FILE, [{ id: "a" }, { id: "b" }]);
  svc.cdn.set(PATH, JSON.stringify([{ id: "a" }, { id: "b" }])); // edge cached the old copy
  await blob.blobWriteJson(SCOPE, FILE, [{ id: "b" }]);

  assert.deepEqual(plain(await blob.blobReadJson(SCOPE, FILE, [])), [{ id: "b" }]);
});

test("a fresh read-modify-write on another instance does not resurrect a delete", async () => {
  const svc = blobService();
  const instanceA = loadAdapter(svc);
  const instanceB = loadAdapter(svc);

  await instanceA.blobWriteJson(SCOPE, FILE, [{ id: "a" }, { id: "b" }]);
  assert.equal((await instanceB.blobReadJson(SCOPE, FILE, [])).length, 2);
  svc.cdn.set(PATH, svc.origin.get(PATH)); // any earlier CDN read left [a, b] at the edge

  // Instance A deletes "a" (the user-store pattern: fresh read, filter, write back).
  const before = await instanceA.blobReadJson(SCOPE, FILE, []);
  await instanceA.blobWriteJson(SCOPE, FILE, before.filter((c) => c.id !== "a"));

  // Instance B adds "c" moments later, under the same lock, with a fresh read.
  const seen = await instanceB.blobReadJson(SCOPE, FILE, []);
  await instanceB.blobWriteJson(SCOPE, FILE, [...seen, { id: "c" }]);

  assert.deepEqual(
    JSON.parse(svc.origin.get(PATH)).map((c) => c.id),
    ["b", "c"],
    "the deleted contact came back — the read served the CDN's pre-delete copy"
  );
});

test("the empty-overwrite shrink guard checks the current body, not the CDN's", async () => {
  const svc = blobService();
  const blob = loadAdapter(svc);

  // Stored value is already empty; the edge still holds an old 6-item copy.
  await blob.blobWriteJson(SCOPE, FILE, [], { allowShrink: true });
  svc.cdn.set(PATH, JSON.stringify([1, 2, 3, 4, 5, 6]));

  await blob.blobWriteJson(SCOPE, FILE, []); // must not throw BlobShrinkGuardError
  assert.equal(svc.origin.get(PATH), "[]");
});

test("blobReadAllRaw copies the current bodies, not the CDN's", async () => {
  const svc = blobService();
  const blob = loadAdapter(svc);

  await blob.blobWriteJson(SCOPE, FILE, [{ id: "new" }]);
  svc.cdn.set(PATH, JSON.stringify([{ id: "old" }]));

  const all = await blob.blobReadAllRaw();
  assert.deepEqual(plain(all), [{ scope: SCOPE, key: FILE, data: [{ id: "new" }] }]);
});

test("absence still returns the fallback; failures and corrupt JSON still throw BlobReadError", async () => {
  const svc = blobService();
  const blob = loadAdapter(svc);

  assert.deepEqual(await blob.blobReadJson(SCOPE, "never-written.json", ["fb"]), ["fb"]);

  // Raced deletion: URL cached on this instance, blob gone at origin → 404 → fallback.
  await blob.blobWriteJson(SCOPE, FILE, [{ id: "a" }]);
  svc.origin.delete(PATH);
  assert.deepEqual(await blob.blobReadJson(SCOPE, FILE, ["fb"]), ["fb"]);

  await blob.blobWriteJson(SCOPE, FILE, [{ id: "a" }]);
  svc.failNext.status = 503;
  await assert.rejects(blob.blobReadJson(SCOPE, FILE, []), { name: "BlobReadError" });

  svc.origin.set(PATH, "{not json");
  await assert.rejects(blob.blobReadJson(SCOPE, FILE, []), { name: "BlobReadError" });
});

test("every Blob read in the adapter bypasses the CDN", () => {
  const src = readFileSync(resolve(import.meta.dirname, "../lib/storage/adapters/blob.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\bfetch\(/, "read blobs with get(..., { useCache: false }), not a raw fetch — the CDN ignores cache-busters");
  const gets = code.match(/(?<![.\w])get\([^)]*\)/g) ?? []; // the SDK's get(), not urlCache.get()
  assert.ok(gets.length > 0, "expected the adapter to read via get()");
  for (const call of gets) assert.match(call, /useCache:\s*false/, `CDN-cached read: ${call}`);
});
