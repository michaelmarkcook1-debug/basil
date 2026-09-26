/**
 * 2026-09-26: 375 contacts deleted server-side came back within seconds of the
 * People page opening. The browser's cache still held them, and its reconcile
 * step re-uploads anything the server lacks as "stranded". Deletions now live
 * on the server (suppressions.ids): imports skip them, GET hides them and hands
 * them to every browser, which drops them instead of re-uploading.
 *
 * Real modules, storage mocked. Synthetic people only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTs, makeLock, nextServer } from "./_helpers/load-ts.mjs";

const plain = (v) => structuredClone(v);

function userStore(seed = {}) {
  const files = new Map(Object.entries(seed).map(([k, v]) => [k, plain(v)]));
  const lock = makeLock(); const key = (u, f) => `${u}/${f}`;
  const readUserStore = async (u, f, fb) => plain(files.has(key(u, f)) ? files.get(key(u, f)) : fb);
  const writeUserStore = async (u, f, v) => { files.set(key(u, f), plain(v)); };
  const updateUserStore = (u, f, mut, fb) => lock.withLock(key(u, f), async () => { const n = mut(await readUserStore(u, f, fb)); await writeUserStore(u, f, n); return n; });
  return { mocks: { readUserStore, writeUserStore, updateUserStore }, get: (u, f) => plain(files.get(key(u, f)) ?? null) };
}

const work = Array.from({ length: 3 }, (_, i) => ({ id: `w${i}`, name: `Work Person${i}`, directory: "work", tags: [], personality: "Real note" }));
const wa = Array.from({ length: 5 }, (_, i) => ({ id: `wa-${i}`, name: `Whatsapp Person${i}`, directory: "personal", tags: ["whatsapp"], personality: "—" }));

function modules(seed) {
  const st = userStore(seed);
  const S = loadTs("lib/contacts/suppressions.ts", { "@/lib/storage/user-store": st.mocks });
  const store = loadTs("lib/contacts/user-store.ts", {
    "@/lib/storage/user-store": st.mocks, "@/lib/events/lock": makeLock(), "@/lib/contacts/suppressions": S,
  });
  const route = loadTs("app/api/contacts/user/route.ts", {
    "next/server": nextServer,
    "@/lib/contacts/user-store": store, "@/lib/contacts/suppressions": S,
    "@/lib/auth": { getSessionUser: async () => "u" },
    "@/lib/generate-cache/store": { deleteGenerateCache: async () => {} },
  });
  return { st, S, store, route };
}

test("a bulk re-upload cannot bring back deleted contacts; existing ones still merge", async () => {
  const { st, store } = modules({
    "u/sage-user-contacts.json": work,
    "u/sage-contact-suppressions.json": { emails: ["gone@example.invalid"], names: [], ids: wa.map((c) => c.id) },
  });
  const res = await store.bulkImportUserContacts("u", [...wa, ...work, { id: "new1", name: "New Person", tags: [] }, { id: "x", name: "Gone", email: "GONE@example.invalid", tags: [] }]);
  assert.equal(res.skippedDeleted, 6, "5 deleted ids + 1 deleted email refused");
  assert.equal(res.added, 1);
  assert.deepEqual(st.get("u", "sage-user-contacts.json").map((c) => c.id), ["w0", "w1", "w2", "new1"]);
});

test("GET hides deleted ids and lists them so browsers can drop them", async () => {
  const { route } = modules({
    // A stale copy that still holds a deleted person must not show them.
    "u/sage-user-contacts.json": [...work, wa[0]],
    "u/sage-contact-suppressions.json": { emails: [], names: [], ids: [wa[0].id] },
  });
  const res = await route.GET();
  assert.deepEqual(res.body.contacts.map((c) => c.id), ["w0", "w1", "w2"]);
  assert.deepEqual(plain(res.body.deletedIds), [wa[0].id]);
});

test("adding someone back by hand lifts the block; a browser re-upload does not", async () => {
  const { route, S } = modules({
    "u/sage-user-contacts.json": work,
    "u/sage-contact-suppressions.json": { emails: [], names: [], ids: ["wa-0", "wa-1"] },
  });
  const post = (body) => route.POST({ json: async () => body });
  assert.equal((await post({ import: [wa[0]] })).body.imported.added, 0);
  assert.equal((await post(wa[1])).status, 201);
  assert.deepEqual(plain((await S.getContactSuppressions("u")).ids), ["wa-0"]);
  assert.deepEqual((await route.GET()).body.contacts.map((c) => c.id), ["w0", "w1", "w2", "wa-1"]);
});

test("deleting in the app records the id, so every device honours it", async () => {
  const st = userStore();
  const S = loadTs("lib/contacts/suppressions.ts", { "@/lib/storage/user-store": st.mocks });
  await S.suppressContact("u", { id: "c1", name: "Jane Doe" });
  assert.deepEqual(plain((await S.getContactSuppressions("u")).ids), ["c1"]);
  const src = (await import("node:fs")).readFileSync(new URL("../app/api/contacts/user/[id]/route.ts", import.meta.url), "utf8");
  assert.match(src, /suppressContact\(username, \{ id: target\.id/);
});

test("the browser replays 26-vs-401: it drops server deletions instead of re-uploading them", async () => {
  const ls = new Map([
    ["sage-user-contacts", JSON.stringify([...work, ...wa])],
    ["sage-user-contacts-migrated-v1", "1"],
  ]);
  const localStorage = { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
  const posts = [];
  const fetch = async (url, init) => {
    if (init?.method === "POST") { posts.push(JSON.parse(init.body)); return new Response("{}", { status: 201 }); }
    return new Response(JSON.stringify({ contacts: work, deletedIds: wa.map((c) => c.id) }), { status: 200 });
  };
  const C = loadTs("lib/user-contacts.ts", { "./sync/channel": { emitChange: () => {} } }, {}, { window: {}, localStorage, fetch });
  const shown = await C.loadUserContactsFromServer();
  assert.equal(shown.map((c) => c.id).join(","), "w0,w1,w2", "the People page shows only what the server has");
  assert.equal(posts.length, 0, "nothing is re-uploaded");
  assert.deepEqual(JSON.parse(ls.get("sage-user-contacts")).map((c) => c.id), ["w0", "w1", "w2"], "the local copy is cleaned");

  // A contact that genuinely failed to upload is still rescued.
  ls.set("sage-user-contacts", JSON.stringify([...work, { id: "stranded", name: "Stranded Person", tags: [] }]));
  await C.loadUserContactsFromServer();
  await new Promise((r) => setImmediate(r));
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].import.map((c) => c.id), ["stranded"]);
});
