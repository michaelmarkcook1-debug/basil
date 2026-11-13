// Server logs never print credentials (2026-11-13): a failed Google refresh
// logged the whole googleapis error, refresh token included.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";

const L = loadTs("lib/security/log-redact.ts", { "node:util": await import("node:util") });
const fake = (prefix, n = 40) => prefix + "A1b2C3d4E5".repeat(Math.ceil(n / 10)).slice(0, n);

test("token shapes and named secret fields are removed from log text", () => {
  const google = fake("1//0"), access = fake("ya29."), slack = fake("xoxb-"), anth = fake("sk-ant-");
  const line = `refresh failed ${google} ${access} ${slack} key=${anth} Authorization: Bearer ${fake("", 30)}`;
  const out = L.redactLogText(line);
  for (const secret of [google, access, slack, anth]) assert.ok(!out.includes(secret), secret.slice(0, 6));
  assert.match(out, /\[google-refresh-token\].*\[google-access-token\].*\[slack-token\].*\[api-key\].*Bearer \[token\]/);
  assert.equal(L.redactLogText(`'refresh_token' => 'opaque-value-123456'`), `'refresh_token' => '[redacted]'`);
  assert.equal(L.redactLogText(`{"access_token":"opaque-value-123456"}`), `{"access_token":"[redacted]"}`);
  assert.equal(L.redactLogText("[cron/reminders] michael: ok"), "[cron/reminders] michael: ok", "ordinary lines are untouched");
});

test("a whole error object (the googleapis shape) is rendered and redacted", () => {
  const token = fake("1//0");
  const err = Object.assign(new Error("invalid_grant"), { config: { data: new URLSearchParams({ refresh_token: token, client_id: "abc" }) } });
  const out = L.redactLogArg(err);
  assert.equal(typeof out, "string");
  assert.ok(!out.includes(token));
  assert.match(out, /invalid_grant/);
  assert.equal(L.redactLogArg(42), 42);
});

test("installed on the Node runtime for every console level", () => {
  const lines = [];
  const target = { log: (...a) => lines.push(a), info: (...a) => lines.push(a), warn: (...a) => lines.push(a), error: (...a) => lines.push(a), debug: (...a) => lines.push(a) };
  L.installLogRedaction(target);
  target.error("[google/auth] failed:", { body: `refresh_token=${fake("1//0")}` });
  assert.ok(!JSON.stringify(lines).includes("1//0A1b2"));
  const inst = fs.readFileSync(new URL("../instrumentation.ts", import.meta.url), "utf8");
  assert.match(inst, /NEXT_RUNTIME === "nodejs"/);
  assert.match(inst, /installLogRedaction\(\)/);
});
