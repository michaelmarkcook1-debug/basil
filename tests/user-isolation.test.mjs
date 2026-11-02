// A second person's Basil beside the owner's (2026-11-02, before onboarding a
// colleague). A live two-user sweep found every read and write API scoped to
// the session; these pin the holes it and the audit did find:
//  - the LinkedIn backfill took any username from any signed-in user
//  - Slack and Zoom pushes fell back to "the first / only connected user"
//  - connecting Google never checked the account belonged to someone else
//  - the owner's Vercel projects and name leaked into every user's pages
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

/** resolve-user.ts over an in-memory set of users. */
function resolver({ users, slack = {}, selfIds = {}, zoom = [], identities = {} }) {
  return loadTs("lib/webhooks/resolve-user.ts", {
    "@/lib/users": { getUsers: async () => users },
    "@/lib/google/watch-state": { getWatchState: async () => ({}) },
    "@/lib/microsoft/watch-state": { getWatchState: async () => ({}) },
    "@/lib/slack/client": {
      getSlackConfig: async (u) => slack[u] ?? {},
      getSlackUserClientForUser: async (u) => (selfIds[u] ? { auth: { test: async () => ({ user_id: selfIds[u] }) } } : null),
    },
    "@/lib/zoom/auth": { isZoomConnected: async (u) => zoom.includes(u) },
    "@/lib/self-identity": { getSelfIdentity: async (u) => ({ emails: identities[u] ?? [], names: [] }) },
  });
}

const MICHAEL = { username: "michael", email: "michael@talentgenius.io" };
const GUY = { username: "guy", email: "guy@talentgenius.io" };

test("LinkedIn backfill: a signed-in user can only scan their own mail", () => {
  const s = src("app/api/admin/linkedin-backfill/route.ts");
  assert.match(s, /if \(!bearerOk && target && target !== session && !isAdminUser\(session!\)\) \{\s+return NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\);/);
  assert.doesNotMatch(s, /body\.username \?\? session/);
});

test("Slack: a colleague in the same workspace never inherits the owner's env-token events", async () => {
  const R = resolver({
    users: [MICHAEL, GUY],
    slack: { michael: { userToken: "env" }, guy: { userToken: "x", teamId: "T1", authUserId: "UGUY" } },
    selfIds: { michael: "UMICHAEL" },
  });
  assert.equal(await R.resolveSlackUserByTeam("T1", null, []), "ambiguous", "no authorisation → don't guess");
  assert.equal(await R.resolveSlackUserByTeam("T1", null, ["UMICHAEL"]), "michael");
  assert.equal(await R.resolveSlackUserByTeam("T1", null, ["UGUY"]), "guy");
  assert.equal(await R.resolveSlackUserByTeam("T1", null, ["USTRANGER"]), "ambiguous");
});

test("Slack: both connected by OAuth are told apart by the authorised user; one user still routes alone", async () => {
  const both = resolver({
    users: [MICHAEL, GUY],
    slack: { michael: { userToken: "a", teamId: "T1", authUserId: "UM" }, guy: { userToken: "b", teamId: "T1", authUserId: "UG" } },
  });
  assert.equal(await both.resolveSlackUserByTeam("T1", null, ["UG"]), "guy");
  assert.equal(await both.resolveSlackUserByTeam("T1", null, ["UM"]), "michael");
  assert.equal(await both.resolveSlackUserByTeam("T2", null, ["UG"]), null, "another workspace");
  const solo = resolver({ users: [MICHAEL], slack: { michael: { userToken: "env" } } });
  assert.equal(await solo.resolveSlackUserByTeam("T1", null, []), "michael", "single user unchanged");
});

test("Slack webhook passes the authorised users and has no first-match fallback", () => {
  const s = src("app/api/webhooks/slack/route.ts");
  assert.match(s, /resolveSlackUserByTeam\(teamId, parsed\.enterprise_id, authorizedSlackUsers\)/);
  assert.doesNotMatch(s, /resolveSlackUser\(\)/);
});

test("Zoom: a colleague's meeting goes to the colleague or nowhere, never to the only Zoom-connected user", async () => {
  const R = resolver({
    users: [MICHAEL, GUY],
    zoom: ["michael"],
    identities: { michael: ["michael@talentgenius.io", "michael@analystgenius.ai"], guy: ["guy@talentgenius.io"] },
  });
  assert.equal(await R.resolveZoomUser("guy@talentgenius.io"), null, "Guy hasn't connected Zoom");
  assert.equal(await R.resolveZoomUser("MICHAEL@analystgenius.ai"), "michael", "an alias counts as the owner's");
  assert.equal(await R.resolveZoomUser("zoom-login@elsewhere.com"), "michael", "unknown host, one Zoom user");
  const both = resolver({ users: [MICHAEL, GUY], zoom: ["michael", "guy"], identities: { guy: ["guy@talentgenius.io"] } });
  assert.equal(await both.resolveZoomUser("guy@talentgenius.io"), "guy");
  assert.equal(await both.resolveZoomUser("zoom-login@elsewhere.com"), null, "unknown host, two Zoom users");
});

test("Google: an account another user owns is refused before anything reads it", async () => {
  const O = loadTs("lib/google/account-owner.ts", {
    "@/lib/users": { getUsers: async () => [MICHAEL, GUY] },
    "@/lib/self-identity": { getSelfIdentity: async (u) => ({ emails: u === "michael" ? ["michael@talentgenius.io"] : ["guy@talentgenius.io"], names: [] }) },
    "@/lib/google/watch-state": { getWatchState: async (u) => (u === "michael" ? { gmail: { watchedEmail: "mc@gmail.example" } } : {}) },
  });
  assert.equal(await O.otherOwnerOf("Michael@TalentGenius.io", "guy"), "michael");
  assert.equal(await O.otherOwnerOf("mc@gmail.example", "guy"), "michael", "the owner's connected mailbox");
  assert.equal(await O.otherOwnerOf("guy@talentgenius.io", "guy"), null, "your own address");
  assert.equal(await O.otherOwnerOf("new@talentgenius.io", "guy"), null);

  const cb = src("app/api/auth/google/callback/route.ts");
  const check = cb.indexOf("await otherOwnerOf(connectedAs, username)");
  assert.ok(check > 0);
  assert.ok(check < cb.indexOf("rememberOwnAddress(username"), "checked before recording the address as theirs");
  assert.ok(check < cb.indexOf("autoRegisterGoogleWebhooks(username)"), "and before any mail is watched or backfilled");
  assert.match(cb, /await deleteIntegrationToken\(username, "google"\);/);
  assert.match(src("app/(auth)/onboarding/page.tsx"), /if \(error === "google_taken"\) setSaveError\(GOOGLE_TAKEN\);/);
});

test("AI projects: the deployment's Vercel token and Claude Code folder are the owner's only", () => {
  const s = src("lib/ai-projects/sync.ts");
  assert.match(s, /const vercelToken = owner \? process\.env\.VERCEL_TOKEN : undefined;/);
  assert.match(s, /owner \? fetchClaudeCodeProjects\(\) : Promise\.resolve\(\[\]\)/);
});

test("briefing, digest, meeting prep, Stig and extra context name the signed-in user, not the owner", () => {
  for (const f of [
    "app/api/generate/briefing/route.ts",
    "app/api/generate/digest/route.ts",
    "app/api/generate/meeting-prep/route.ts",
    "lib/stig/engine.ts",
    "lib/ai/extra-context.ts",
  ]) {
    const code = src(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    assert.doesNotMatch(code, /Michael|MICHAEL/, f);
  }
  assert.doesNotMatch(src("lib/ai/tools.ts"), /^\s+michael: \{/m, "the availability tool reports 'you', not 'michael'");
});
