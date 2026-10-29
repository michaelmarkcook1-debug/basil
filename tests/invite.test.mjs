// Inviting a colleague (lib/auth/invite.ts): one step for the admin, plug and
// play for them — a link, a password, then Google and Slack in onboarding.
// Registration stays closed; the new account starts empty and never sees the
// owner's data.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const noop = new Proxy({}, { get: () => async () => ({}) });
const I = loadTs("lib/auth/invite.ts", {
  "server-only": {}, "node:crypto": await import("node:crypto"),
  "@/lib/users": noop, "@/lib/auth/reset-tokens": noop, "@/lib/email/send": noop,
});

test("a username comes from the work email and never collides", () => {
  assert.equal(I.usernameFor("Ed.Baum+basil@talentgenius.io", []), "ed.baum");
  assert.equal(I.usernameFor("ed.baum@talentgenius.io", ["michael", "ed.baum"]), "ed.baum2");
  assert.equal(I.usernameFor("ed.baum@x.io", ["ed.baum", "ED.BAUM2"]), "ed.baum3", "case-insensitive");
  assert.equal(I.usernameFor("@x.io", []), "user");
});

test("the invite email is plain words, one button, and says the link lasts a week", () => {
  const m = I.inviteEmail({ firstName: "Ed", inviter: "Michael Cook", link: "https://basil-app.vercel.app/reset-password?token=abc&welcome=1" });
  assert.equal(m.subject, "Michael Cook has set you up on Basil");
  assert.match(m.text, /about three minutes/);
  assert.match(m.text, /Sign in to Google when asked/);
  assert.match(m.text, /expires in 7 days/);
  assert.match(m.text, /never shared with anyone else/);
  assert.match(m.html, />Set up my Basil<\/a>/);
  assert.doesNotMatch(I.inviteEmail({ firstName: "<b>x</b>", inviter: "A", link: "https://x" }).html, /<b>x<\/b>/, "names are escaped");
});

test("the invite: unusable random password, onboarding pending, a 7-day link, email optional", () => {
  const s = src("lib/auth/invite.ts");
  assert.match(s, /password: randomBytes\(32\)\.toString\("hex"\)/);
  assert.match(s, /onboardingCompleted: false/);
  assert.match(s, /export const INVITE_TTL_MS = 7 \* 24 \* 60 \* 60 \* 1000;/);
  assert.match(s, /createResetToken\(user\.username, user\.email, INVITE_TTL_MS\)/);
  assert.match(s, /\/reset-password\?token=\$\{token\}&welcome=1/);
  assert.match(s, /if \(await findByEmail\(email\)\) throw new Error/);
  assert.match(src("lib/auth/reset-tokens.ts"), /expiresAt: new Date\(now \+ ttlMs\)\.toISOString\(\)/);
});

test("only an admin can invite; registration stays closed", () => {
  const r = src("app/api/admin/invite/route.ts");
  assert.match(r, /if \(!username \|\| !isAdminUser\(username\)\) return NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\);/);
  assert.match(src("app/api/auth/register/route.ts"), /process\.env\.ALLOW_REGISTRATION === "true"/);
  assert.match(src("app/admin/page.tsx"), /<InviteCard onInvited=\{\(\) => void load\(\)\} \/>/);
});

test("choosing a password from an invite signs them in and starts onboarding", () => {
  const p = src("app/reset-password/page.tsx");
  assert.match(p, /const welcome     = params\.get\("welcome"\) === "1";/);
  assert.match(p, /if \(login\.ok\) \{ window\.location\.replace\("\/onboarding"\); return; \}/);
  assert.match(p, /\{welcome \? "Welcome to Basil" : "Set a new password"\}/);
  assert.match(src("app/api/auth/reset-password/route.ts"), /return NextResponse\.json\(\{ ok: true, username \}\);/);
});

test("onboarding offers Zoom (optional) and comes back to the final step", () => {
  const o = src("app/(auth)/onboarding/page.tsx");
  assert.match(o, /href=\{`\/api\/auth\/zoom\?from=\$\{encodeURIComponent\("\/onboarding\?connected=zoom"\)\}`\}/);
  assert.match(o, /if \(connected === "zoom"\)\s+setStep\(TOTAL_STEPS - 1\);/);
});

test("a new account never falls back to the owner's Google or Slack", () => {
  assert.match(src("lib/google/auth.ts"), /const envRaw = isEnvCredentialOwner\(username\) \? process\.env\.GOOGLE_TOKENS : undefined;/);
  assert.match(src("lib/slack/client.ts"), /const envOk      = isEnvCredentialOwner\(username\);/);
});
