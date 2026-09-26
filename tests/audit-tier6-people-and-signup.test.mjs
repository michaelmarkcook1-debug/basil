/**
 * 2026-09-26: new users can sign up; connections can be deleted and stay
 * deleted; confidence and provenance fine print is gone from the product.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { loadTs, makeLock, nextServer } from "./_helpers/load-ts.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plain = (v) => structuredClone(v);

function userStore(seed = {}) {
  const files = new Map(Object.entries(seed).map(([k, v]) => [k, plain(v)]));
  const lock = makeLock(); const key = (u, f) => `${u}/${f}`;
  const readUserStore = async (u, f, fb) => plain(files.has(key(u, f)) ? files.get(key(u, f)) : fb);
  const writeUserStore = async (u, f, v) => { files.set(key(u, f), plain(v)); };
  const updateUserStore = (u, f, mut, fb) => lock.withLock(key(u, f), async () => { const n = mut(await readUserStore(u, f, fb)); await writeUserStore(u, f, n); return n; });
  return { mocks: { readUserStore, writeUserStore, updateUserStore }, get: (u, f) => plain(files.get(key(u, f)) ?? null) };
}

// ── Sign-up ──────────────────────────────────────────────────────────────────

function registerRoute(env) {
  return loadTs("app/api/auth/register/route.ts", {
    "next/server": nextServer,
    "@/lib/auth": { createSession: async () => {} },
    "@/lib/users": { findByEmail: async () => null, findByUsername: async () => null, createUser: async (u) => ({ ...u, id: "new" }) },
    "@/lib/settings/store": { patchSettings: async () => {} },
    "@/lib/rate-limit": { checkRateLimitDurable: async () => ({ allowed: true }), getClientIp: () => "203.0.113.1" },
    "@/lib/storage/persistent": { forceFlushSnapshot: async () => {} },
  }, env);
}
const body = { name: "Test", surname: "User", country: "GB", email: "test.user@example.invalid", username: "test_user_1", password: "synthetic-pass-1" };

test("sign-up is refused in production until ALLOW_REGISTRATION=true, and the page can ask first", async () => {
  const closed = registerRoute({ NODE_ENV: "production" });
  assert.deepEqual(plain((await closed.GET()).body), { open: false });
  assert.equal((await closed.POST({ headers: new Headers(), json: async () => body })).status, 403);
  const open = registerRoute({ NODE_ENV: "production", ALLOW_REGISTRATION: "true" });
  assert.deepEqual(plain((await open.GET()).body), { open: true });
  const res = await open.POST({ headers: new Headers(), json: async () => body });
  assert.equal(res.status, 200); assert.equal(res.body.success, true);
});

test("the register page shows the closed state before the form, not a 403 after it", () => {
  const page = readFileSync(path.join(ROOT, "app/(auth)/register/page.tsx"), "utf8");
  assert.match(page, /fetch\("\/api\/auth\/register"/);
  assert.match(page, /open === false \?/);
});

// ── Deleting a connection ────────────────────────────────────────────────────

test("deleting a connection removes it, Basil's notes on them, and keeps them out of suggestions", async () => {
  const st = userStore({ "u/sage-contact-overrides.json": { c1: { personality: "Direct", toneHistory: [{ date: "2026-09-01", person: "Jane Doe", direction: "cooling", summary: "short replies" }] } } });
  const contacts = [{ id: "c1", name: "Jane Doe", email: "jane@example.invalid" }, { id: "c2", name: "Omar Haddad" }];
  let invalidated = 0;
  const S = loadTs("lib/contacts/suppressions.ts", { "@/lib/storage/user-store": st.mocks });
  const overrides = loadTs("lib/contacts/overrides-store.ts", { "@/lib/storage/user-store": st.mocks, "@/lib/events/lock": makeLock() });
  const route = loadTs("app/api/contacts/user/[id]/route.ts", {
    "next/server": nextServer, zod: require("zod"),
    "@/lib/auth": { getSessionUser: async () => "u" },
    "@/lib/contacts/user-store": {
      listUserContacts: async () => plain(contacts),
      deleteUserContactFromStore: async (_u, id) => { const i = contacts.findIndex((c) => c.id === id); if (i < 0) return false; contacts.splice(i, 1); return true; },
      updateUserContactInStore: async () => null,
    },
    "@/lib/contacts/overrides-store": overrides,
    "@/lib/contacts/suppressions": S,
    "@/lib/contacts/activity-cache": { invalidateActivityCache: async () => { invalidated += 1; } },
    "@/lib/api/respond": { parseBody: async () => ({ ok: false, response: { status: 400 } }) },
    "@/lib/generate-cache/store": { deleteGenerateCache: async () => { invalidated += 1; } },
  });
  const res = await route.DELETE({}, { params: Promise.resolve({ id: "c1" }) });
  assert.equal(res.status, 204);
  assert.deepEqual(contacts.map((c) => c.id), ["c2"]);
  assert.equal(st.get("u", "sage-contact-overrides.json").c1, undefined, "profile and tone history go with them");
  const sup = await S.getContactSuppressions("u");
  assert.ok(S.isSuppressed(sup, "Jane Doe") && S.isSuppressed(sup, undefined, "JANE@example.invalid"));
  assert.equal(S.isSuppressed(sup, "Omar Haddad"), false);
  assert.equal(invalidated, 1);
  assert.equal((await route.DELETE({}, { params: Promise.resolve({ id: "nope" }) })).status, 404);
});

test("the People page offers Delete, with a confirmation, for the user's own connections", () => {
  const page = readFileSync(path.join(ROOT, "app/dashboard/contacts/page.tsx"), "utf8");
  assert.match(page, /isUserContact && onDelete/);
  assert.match(page, /confirmingDelete \?/);
  assert.match(page, /await deleteUserContact\(selected\.id\)/);
});

// ── No confidence or provenance fine print in the product ────────────────────

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

test("no product surface renders a confidence rating or provenance small print", () => {
  const files = [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "components"))]
    .filter((f) => !/app\/admin\/|app\/dev-harness\/|components\/ui\/trust-(ui|badge)\.tsx$/.test(f));
  const banned = /<(ConfidenceMeter|FreshnessTag|FreshnessDecayBar|ProvenanceIndicator|ProvenanceTrail|EvidencePanel|SignalSummary|TrustTierBadge|TrustDot)\b|%\s*confidence|confidence\s*\*\s*100/;
  const hits = files.filter((f) => banned.test(readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(hits, [], `still rendering fine print: ${hits.join(", ")}`);
});

test("the approval card no longer asks the model for a confidence number", () => {
  const src = readFileSync(path.join(ROOT, "lib/ai/tools.ts"), "utf8");
  const meta = src.slice(src.indexOf("const APPROVAL_META"), src.indexOf("};", src.indexOf("const APPROVAL_META")));
  assert.match(meta, /why:/); assert.doesNotMatch(meta, /confidence:/);
});
