/**
 * tests/siri-voice-access.test.mjs
 *
 * Guards the self-serve Siri voice path:
 *   Settings → generate per-user token → iOS Shortcut POSTs /api/stig/siri
 *   with "Authorization: Bearer bsl_…" → full Stig brain answers → exchange
 *   is receipted into chat history.
 *
 * The failure this prevents regressing to: Siri auth requiring manual
 * STIG_API_TOKEN / STIG_API_USERNAME env vars + a redeploy (single-user,
 * never configured, so voice access simply didn't work).
 *
 * Static source analysis — no TypeScript compilation required.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const tokens = read("lib/auth/siri-tokens.ts");
const stigAuth = read("lib/stig/auth.ts");
const siriRoute = read("app/api/stig/siri/route.ts");
const tokenRoute = read("app/api/siri/token/route.ts");
const speech = read("lib/ai/speech.ts");

test("siri-tokens: raw token is returned once, only the SHA-256 hash is stored", () => {
  assert.ok(/randomBytes\(32\)/.test(tokens), "token must be 32 random bytes");
  assert.ok(/createHash\("sha256"\)/.test(tokens), "must hash with sha256");
  assert.ok(/tokenHash: hashToken\(rawToken\)/.test(tokens),
    "stored record must contain the hash, not the raw token");
  assert.ok(!/rawToken\s*[,}]/.test(tokens.slice(tokens.indexOf("const entry"), tokens.indexOf("await updateStore"))),
    "the persisted entry must never include the raw token");
  assert.ok(/return rawToken/.test(tokens), "createSiriToken must return the raw token to the caller");
});

test("siri-tokens: one token per user; verify reads fresh so revocation sticks", () => {
  assert.ok(/filter\(\(r\) => r\.username\.toLowerCase\(\) !== username\.toLowerCase\(\)\)/.test(tokens),
    "creating a token must drop the user's previous token");
  assert.ok(/\{ fresh: true \}/.test(tokens),
    "verifySiriToken must bypass the /tmp cache (fresh read)");
});

test("stig auth: per-user Siri token is accepted, ahead of the legacy env token", () => {
  assert.ok(/verifySiriToken/.test(stigAuth), "getStigRequestUser must call verifySiriToken");
  const siriIdx = stigAuth.indexOf("verifySiriToken(suppliedToken)");
  const legacyIdx = stigAuth.indexOf("process.env.STIG_API_TOKEN");
  assert.ok(siriIdx !== -1 && legacyIdx !== -1 && siriIdx < legacyIdx,
    "per-user token check must run before the legacy env-token check");
});

test("siri route: rate-limits per username, accepts q alias, receipts to chat history", () => {
  assert.ok(/stig:siri:\$\{user\.username\}/.test(siriRoute),
    "rate limit must be keyed by authenticated username, not IP");
  assert.ok(/body\.question \?\? body\.q/.test(siriRoute), "must accept q as an alias for question");
  assert.ok(/appendChatMessages/.test(siriRoute), "voice exchanges must be appended to chat history");
  assert.ok(/toSpeech/.test(siriRoute), "reply must be sanitised for speech");
});

test("token delivery is forgiving: body token and raw Authorization both accepted", () => {
  assert.ok(/getStigRequestUser\(req, \{ bodyToken \}\)/.test(siriRoute),
    "route must pass the body token into auth (the Shortcuts-recommended path)");
  assert.ok(/opts\?\.bodyToken/.test(stigAuth), "stig auth must accept a body token");
  assert.ok(/auth\.startsWith\("bsl_"\)/.test(stigAuth),
    "a raw bsl_ token in Authorization (no Bearer prefix) must be accepted");
});

test("token management route: every method requires a session", () => {
  for (const method of ["GET", "POST", "DELETE"]) {
    const fn = tokenRoute.slice(tokenRoute.indexOf(`export async function ${method}`));
    assert.ok(/getSessionUser\(\)/.test(fn.slice(0, 300)),
      `${method} /api/siri/token must authenticate via session`);
  }
  assert.ok(!/verifySiriToken/.test(tokenRoute),
    "a Siri token must never be able to mint or revoke tokens");
});

test("speech sanitiser strips the markdown Siri would read aloud", () => {
  for (const pattern of ["```", "\\*\\*", "^#{1,6}", "\\[([^\\]]*)\\]"]) {
    assert.ok(speech.includes(pattern), `toSpeech must handle ${pattern}`);
  }
});
