// The deployment's GOOGLE_TOKENS / SLACK_*_TOKEN are the owner's accounts.
// Found 2026-10-09: two other logins with no connection of their own fell back
// to them and ingested the owner's Slack, mail and calendar every morning.
import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./_helpers/load-ts.mjs";

const ENV = {
  ADMIN_USERNAME: "owner",
  GOOGLE_TOKENS: JSON.stringify({ refresh_token: "env-refresh", access_token: "env-access" }),
  SLACK_BOT_TOKEN: "env-bot",
  SLACK_USER_TOKEN: "env-user",
};

function load(env, stored = {}) {
  const owner = loadTs("lib/auth/env-credential-owner.ts", {}, env);
  const store = {
    getIntegrationToken: async (u, p) => stored[`${u}/${p}`] ?? null,
    saveIntegrationToken: async () => {},
    deleteIntegrationToken: async () => {},
  };
  const google = loadTs("lib/google/auth.ts", {
    googleapis: { google: {} },
    "@/lib/storage/secure-token-store": store,
    "@/lib/auth/env-credential-owner": owner,
  }, env);
  const slack = loadTs("lib/slack/client.ts", {
    "@slack/web-api": { WebClient: class {}, LogLevel: {} },
    "@/lib/storage/secure-token-store": store,
    "@/lib/slack/render": { renderSlackText: (t) => t },
    "@/lib/auth/env-credential-owner": owner,
  }, env);
  return { owner, google, slack };
}

test("another login without its own connection gets NO Google or Slack", async () => {
  const { google, slack } = load(ENV);
  assert.equal(await google.getStoredTokens("franko"), null);
  const cfg = await slack.getSlackConfig("andrew_smokeci");
  assert.equal(cfg.botToken, undefined);
  assert.equal(cfg.userToken, undefined);
});

test("the owner still falls back to the deployment credentials (case-insensitive)", async () => {
  const { google, slack } = load(ENV);
  assert.equal((await google.getStoredTokens("Owner"))?.refresh_token, "env-refresh");
  const cfg = await slack.getSlackConfig("owner");
  assert.equal(cfg.botToken, "env-bot");
  assert.equal(cfg.userToken, "env-user");
});

test("a login's own connection always wins over the fallback", async () => {
  const { google, slack } = load(ENV, {
    "andrew_smokeci/google": { refresh_token: "andrews-own" },
    "andrew_smokeci/slack": { botToken: "andrews-bot", userToken: "andrews-user" },
  });
  assert.equal((await google.getStoredTokens("andrew_smokeci"))?.refresh_token, "andrews-own");
  assert.equal((await slack.getSlackConfig("andrew_smokeci")).userToken, "andrews-user");
});

test("PRIMARY_OWNER_USERNAME takes precedence; nobody qualifies when neither is set", () => {
  assert.equal(load({ ...ENV, PRIMARY_OWNER_USERNAME: "michael" }).owner.isEnvCredentialOwner("owner"), false);
  assert.equal(load({ ...ENV, PRIMARY_OWNER_USERNAME: "michael" }).owner.isEnvCredentialOwner("michael"), true);
  const none = load({ GOOGLE_TOKENS: ENV.GOOGLE_TOKENS }).owner;
  assert.equal(none.isEnvCredentialOwner("admin"), false);
  assert.equal(none.isEnvCredentialOwner(""), false);
  assert.equal(none.isEnvCredentialOwner(null), false);
});
