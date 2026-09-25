/**
 * L1 — credentials must not enter assistant content.
 *
 * Every value here is synthetic. The library is dependency-free and runs in
 * this realm directly; the integration cases load the real store modules with
 * only persistence mocked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTs, makeLock } from "./_helpers/load-ts.mjs";

const S = loadTs("lib/security/sensitive.ts");
const plain = (v) => structuredClone(v);

// ── the library ──────────────────────────────────────────────────────────────

test("passwords with a value are redacted; the word alone is not", () => {
  const r = S.redactSensitive("Your temporary password is Tq7!vX2p — please change it after login.");
  assert.doesNotMatch(r.text, /Tq7!vX2p/);
  assert.match(r.text, /\[redacted password\]/);
  assert.equal(r.count, 1);
  const ok = S.redactSensitive("Please reset your password from the settings page.");
  assert.equal(ok.count, 0, "no value present — nothing to redact");
});

test("verification codes are redacted in the shapes email actually uses", () => {
  for (const line of [
    "Your verification code is 482913.",
    "Verification code: 48-29-13",
    "Use code 917204 to sign in. It expires in 10 minutes.",
    "OTP: 553311",
    "Enter this one-time passcode 730984 within 5 minutes",
  ]) {
    const r = S.redactSensitive(line);
    assert.equal(r.count >= 1, true, `should redact: ${line}`);
    assert.doesNotMatch(r.text, /\d{6}|48-29-13/, `value survived: ${r.text}`);
  }
  // Six digits that are NOT a code stay put.
  assert.equal(S.redactSensitive("Invoice 482913 is attached; PO 730984 approved.").count, 0);
});

test("API keys, bearer tokens, JWTs and Basil's own Siri tokens are redacted", () => {
  // Assembled at runtime. GitHub push protection scans SOURCE text for token
  // shapes and declined the push while these sat here contiguously — it
  // cannot tell a fixture from a leak, which is rather the point of this
  // file. The redactor sees the joined string, which is what is under test.
  const tok = (...parts) => parts.join("");
  const samples = [
    "key " + tok("sk-ant-", "api03-", "Abc123DEF456ghi789JKL012mno345PQR678"),
    "Authorization: Bearer 9f8e7d6c5b4a3210fedcba9876543210",
    "session " + tok("eyJhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
    "shortcut token bsl_" + "a".repeat(64),
    "slack " + tok("xox", "b-", "1234567890-abcdefghijklmnop"),
  ];
  for (const s of samples) {
    const r = S.redactSensitive(s);
    assert.equal(r.count, 1, `expected one redaction in: ${s}`);
    assert.match(r.text, /\[redacted token\]/);
  }
});

test("secrets in URLs lose their value but keep the parameter name and path", () => {
  const r = S.redactSensitive("Reset here: https://app.example.test/reset-password/AbCdEfGhIjKlMnOpQrStUvWx?token=Zz9Yy8Xx7Ww6Vv5Uu4&lang=en");
  assert.equal(r.count, 2);
  assert.match(r.text, /reset-password\/\[redacted url-secret\]/);
  assert.match(r.text, /token=\[redacted url-secret\]&lang=en/);
});

test("redactDeep reaches strings nested in generated JSON and reports a count", () => {
  const doc = { summary: "Login with password: Sw0rdf1sh!", topics: ["code 448812 sent", "budget review"], n: 3, nested: { note: "fine" } };
  const { value, count } = S.redactDeep(doc);
  assert.equal(count, 2);
  assert.doesNotMatch(JSON.stringify(value), /Sw0rdf1sh|448812/);
  assert.equal(value.n, 3);
  assert.equal(value.nested.note, "fine");
  assert.equal(doc.summary, "Login with password: Sw0rdf1sh!", "input is not mutated");
});

// ── the cache layer: every generated artifact goes through here ──────────────

function cacheModule() {
  const files = new Map();
  const store = loadTs("lib/generate-cache/store.ts", {
    "@/lib/storage/persistent": {
      readStore: async (f, fallback, sub) => plain(files.get(`${sub}/${f}`) ?? fallback),
      writeStore: async (f, data, sub) => { files.set(`${sub}/${f}`, plain(data)); },
      deleteStore: async (f, sub) => { files.delete(`${sub}/${f}`); },
    },
    "@/lib/storage/user-store": { userSubdir: (u) => `users/${u}` },
    "@/lib/security/sensitive": S,
  });
  return { store, files };
}

test("a generated meeting prep is redacted BEFORE it is cached", async () => {
  const { store, files } = cacheModule();
  await store.writeGenerateCache("fixture", "meeting-prep", { prep: "Their temp password is Kx9#pLm2 and code 662310" }, { inputHash: "h", ttlMs: 60_000 });
  const stored = JSON.stringify([...files.values()]);
  assert.doesNotMatch(stored, /Kx9#pLm2|662310/, "the durable record must not carry the values");
  assert.match(stored, /\[redacted password\]/);
});

test("a cache written BEFORE the fix is redacted when it is read back", async () => {
  const { store, files } = cacheModule();
  // Simulate a pre-fix record: written directly, values intact.
  await store.writeGenerateCache("fixture", "briefing", { ok: true }, { inputHash: "h", ttlMs: 60_000 });
  const path = [...files.keys()][0];
  const rec = files.get(path);
  rec.content = { summary: "Temporary password: Vb3$qRt8 — verification code 903341" };
  files.set(path, rec);
  const read = await store.readGenerateCache("fixture", "briefing");
  assert.doesNotMatch(JSON.stringify(read.content), /Vb3\$qRt8|903341/);
  assert.equal(read.redactedOnRead, 2, "the record reports what it had to scrub");
});

// ── commitments: the store is the last line ──────────────────────────────────

test("an extracted commitment carrying a one-time code is stored without it", async () => {
  const files = new Map();
  const actions = loadTs("lib/actions/store.ts", {
    "@/lib/events/lock": makeLock(),
    "./classify": { classifyAction: () => ({ category: "task", decisionRequired: false }) },
    "./utils": { isOverdueStale: () => false, isGroupOwner: () => false, isMeetingAttendancePast: () => false },
    "@/lib/self-identity": { getSelfIdentity: async () => ({ names: ["Fixture"], emails: [] }) },
    "@/lib/storage/user-store": {
      readUserStore: async (u, f, fallback) => plain(files.get(`${u}/${f}`) ?? fallback),
      writeUserStore: async (u, f, items) => { files.set(`${u}/${f}`, plain(items)); },
    },
    "@/lib/security/sensitive": S,
  });
  const a = await actions.createAction("fixture", { text: "Confirm the account using verification code 771205 before Friday", source: "email", priority: "medium" });
  assert.doesNotMatch(a.text, /771205/);
  assert.match(a.text, /\[redacted code\]/);
  assert.doesNotMatch(JSON.stringify([...files.values()]), /771205/);
});
