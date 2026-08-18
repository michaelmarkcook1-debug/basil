/**
 * tests/email-config.test.mjs
 *
 * Password-reset email was broken for days on 2026-08-15 and every debugging
 * round attacked the wrong layer. The causes were all in how the credential was
 * handled, not in the sending:
 *
 *  1. NO TRIMMING. A key pasted with a trailing newline rides into
 *     `Bearer <key>` and Resend answers 401 — identical to a wrong key, and
 *     re-entering the same value cannot fix it.
 *  2. "CONFIGURED" MEANT "NON-EMPTY". isEmailConfigured() returned true while
 *     the slot held an Anthropic key, so the app reported email as working.
 *  3. TWO CLIENTS. forgot-password hand-rolled its own fetch to Resend, so a
 *     fix in lib/email/send.ts did not reach the reset path.
 *  4. THE OPERATOR MESSAGE said "set RESEND_API_KEY" even when it WAS set,
 *     sending the operator to redo the one thing already done.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const send   = read("lib/email/send.ts");
const forgot = read("app/api/auth/forgot-password/route.ts");

test("there is exactly one Resend client in the codebase", () => {
  for (const p of ["app/api/auth/forgot-password/route.ts", "app/api/admin/email-probe/route.ts"]) {
    assert.ok(!/api\.resend\.com/.test(read(p)),
      `${p} must call lib/email/send.ts, not Resend directly — two clients drift apart`);
  }
  assert.ok(/api\.resend\.com/.test(send), "lib/email/send.ts is the one client");
});

test("the key is trimmed before it reaches the Authorization header", () => {
  assert.ok(/\.trim\(\)/.test(send),
    "an untrimmed pasted key yields a permanent 401 that re-entering the same value cannot fix");
  assert.ok(/function env\(/.test(send),
    "reads must go through the trimming accessor, not process.env directly");
  // The header must be built from the trimmed accessor, never the raw var.
  const authLine = /Authorization: `Bearer \$\{(\w+)\}`/.exec(send);
  assert.ok(authLine, "the Authorization header must exist");
  assert.notEqual(authLine[1], "process", "the header must not interpolate process.env directly");
});

test("a credential for a different service is rejected, not treated as configured", () => {
  assert.ok(/RESEND_KEY_PREFIX = "re_"/.test(send), "Resend keys are prefixed re_");
  assert.ok(/startsWith\(RESEND_KEY_PREFIX\)/.test(send),
    "the shape check is what catches an Anthropic key sitting in the Resend slot");
  assert.ok(/export function isEmailConfigured/.test(send) && /resendKeyProblem\(\) === null/.test(send),
    "isEmailConfigured must mean 'plausibly a Resend key', not 'the string is non-empty'");
});

test("the failure message never tells the operator to redo what they already did", () => {
  assert.ok(/isEmailConfigured\(\)/.test(forgot),
    "the log must branch on whether the key is actually configured");
  assert.ok(/do not just re-enter the key/.test(forgot),
    "a configured-but-rejected key must say so — the old copy said 'set RESEND_API_KEY' in both cases");
});

test("the probe asks Resend and leaks no key material", () => {
  const probe = read("app/api/admin/email-probe/route.ts");
  assert.ok(/Unauthorised/.test(probe) && /ADMIN_API_TOKEN/.test(probe), "the probe must be admin-gated");
  assert.ok(!/RESEND_API_KEY/.test(probe) || !/NextResponse\.json\([^)]*apiKey/.test(probe),
    "the response must never carry the key");
  assert.ok(/api\.resend\.com\/domains/.test(send),
    "probe via the domains endpoint — it validates the key AND the From domain without sending");
  assert.ok(/fromDomainVerified/.test(send),
    "an unverified From domain is a 403 that reads nothing like a key problem; the probe must separate them");
});
