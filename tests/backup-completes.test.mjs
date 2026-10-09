/**
 * 2026-10-09: the nightly backup timed out every night. It listed all of basil/
 * — including basil/_backups/ (199k copies, sorting first) — and copied every
 * spend event one by one; per-user data was last backed up on 2026-07-04.
 * Fake Blob API; nothing touches real storage.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./_helpers/load-ts.mjs";

const B = loadTs("lib/storage/backup.ts", { "@vercel/blob": {} });
const DAY = 86_400_000, NOW = Date.parse("2026-10-09T02:35:00Z");

function fakeBlob(paths) {
  const store = new Map(paths.map(([p, ageDays = 0]) => [p, { pathname: p, url: `https://blob.invalid/${p}`, uploadedAt: new Date(NOW - ageDays * DAY) }]));
  const calls = { list: [], copy: [], del: [] };
  const api = {
    list: async ({ prefix, mode, cursor, limit }) => {
      calls.list.push(prefix);
      const under = [...store.values()].filter((b) => b.pathname.startsWith(prefix)).sort((a, b) => a.pathname.localeCompare(b.pathname));
      if (mode === "folded") {
        const folders = new Set(), blobs = [];
        for (const b of under) { const rest = b.pathname.slice(prefix.length); if (rest.includes("/")) folders.add(prefix + rest.split("/")[0] + "/"); else blobs.push(b); }
        return { blobs, folders: [...folders], hasMore: false };
      }
      const start = cursor ? Number(cursor) : 0;
      const page = under.slice(start, start + limit);
      return { blobs: page, hasMore: start + limit < under.length, cursor: String(start + limit) };
    },
    copy: async (url, to) => { calls.copy.push(to); store.set(to, { pathname: to, url: `https://blob.invalid/${to}`, uploadedAt: new Date(NOW) }); },
    del: async (urls) => { calls.del.push(...urls); for (const u of urls) store.delete(u.replace("https://blob.invalid/", "")); },
  };
  return { api, calls, store };
}

const live = [
  ["basil/secure-users.json"], ["basil/users/michael/sage-actions.json"], ["basil/users/michael/sage-memory.json"],
  ["basil/counters/global-2026-10.json"], ["basil/spend/2026-10/events/new.json", 1], ["basil/spend/2026-09/events/old.json", 20],
];
const oldBackups = Array.from({ length: 300 }, (_, i) => [`basil/_backups/2026-07-0${1 + (i % 3)}/spend/x${i}.json`, 90]);

test("backup never lists the backup tree, copies user data first, and spend events only when new", async () => {
  const f = fakeBlob([...live, ...oldBackups]);
  const r = await B.backupAllUsers("2026-10-09", { now: NOW, api: f.api });
  assert.equal(r.complete, true); assert.equal(r.failed, 0);
  assert.ok(!f.calls.list.some((p) => p.startsWith("basil/_backups/")), "the 199k-copy backup tree is never paged through");
  const copied = f.calls.copy.map((p) => p.replace("basil/_backups/2026-10-09/", ""));
  assert.deepEqual(copied.slice(0, 1), ["secure-users.json"], "the account database goes first");
  assert.ok(copied.indexOf("users/michael/sage-actions.json") < copied.indexOf("counters/global-2026-10.json"), "users/ before other folders");
  assert.ok(copied.includes("spend/2026-10/events/new.json"));
  assert.ok(!copied.includes("spend/2026-09/events/old.json"), "immutable spend events are copied once, while new");
});

test("backup stops cleanly at the deadline and says it is incomplete", async () => {
  const f = fakeBlob(live);
  const r = await B.backupAllUsers("2026-10-09", { now: NOW, deadline: Date.now() - 1, api: f.api });
  assert.equal(r.complete, false);
});

test("prune deletes stale date folders (suffixes included), oldest first, and keeps recent ones", async () => {
  const f = fakeBlob([
    ["basil/_backups/2026-07-01/a.json"], ["basil/_backups/2026-07-02-manual/b.json"],
    ["basil/_backups/2026-10-01/c.json"], ["basil/_backups/2026-10-09-manual/d.json"], ...live,
  ]);
  const r = await B.pruneBackups("2026-09-25", { api: f.api });
  assert.equal(r.complete, true);
  assert.deepEqual(f.calls.del.map((u) => u.replace("https://blob.invalid/basil/_backups/", "")), ["2026-07-01/a.json", "2026-07-02-manual/b.json"]);
  assert.ok(f.store.has("basil/_backups/2026-10-01/c.json") && f.store.has("basil/users/michael/sage-actions.json"));
});

test("the cron prunes only after a complete backup, inside the function's time limit", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../app/api/cron/backup/route.ts", import.meta.url), "utf8");
  assert.match(src, /backupAllUsers\(todayKey, \{ deadline: started \+ 240_000 \}\)/);
  assert.match(src, /const prune = backup\.complete\s*\? await pruneBackups/);
});
