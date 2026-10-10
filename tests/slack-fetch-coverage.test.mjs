// "Slack isn't showing all messages" (2026-10-10). The fetcher read one page of
// conversations per type, kept 15 channels / 20 DMs / 5 group DMs in Slack's
// arbitrary order, took the latest 5 messages of each, and never saw a thread
// reply. Against the real workspace: 16 messages from 6 conversations, vs 85
// from 16 now. And Google Calendar's Slack app posted its daily agenda into the
// views as if it were a person ("don't include Slack Google Calendar updates").
import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./_helpers/load-ts.mjs";

const NOW = Date.now() / 1000;
const ts = (hoursAgo, n = 0) => (NOW - hoursAgo * 3600).toFixed(6).replace(/\d$/, String(n));

function workspace({ searchWorks = true, rateLimitHistory = false } = {}) {
  const channels = Array.from({ length: 34 }, (_, i) => ({ id: `C${i}`, name: `chan-${i}`, is_member: i >= 30 || i === 0 }));
  channels.push({ id: "CNOT", name: "not-mine", is_member: false });
  const ims = [...Array.from({ length: 24 }, (_, i) => ({ id: `D${i}`, user: `U${i}` })), { id: "DCAL", user: "UCAL" }];
  const mpims = Array.from({ length: 12 }, (_, i) => ({ id: `G${i}`, name: `mpdm-${i}` }));
  const history = {
    C33: [{ ts: ts(2), user: "U1", text: "Deploy is green" }, { ts: ts(3), subtype: "channel_join", user: "U2", text: "joined" },
          { ts: ts(4), subtype: "file_share", user: "U3", text: "Spec attached" }],
    D23: [{ ts: ts(1), user: "U23", text: "Can you review this today?" }],
    DCAL: [{ ts: ts(5), user: "UCAL", text: "*Today*-<!date^1|Friday>", bot_profile: { name: "Google Calendar" } }],
    G11: [{ ts: ts(6), user: "U5", text: "Group DM eleven" }],
    C31: "missing_scope", // private channel: no history access with this token
  };
  const hits = [
    { channel: { id: "C33" }, ts: ts(2), user: "U1", text: "Deploy is green" },          // duplicate of history
    { channel: { id: "C33" }, ts: ts(2.5), user: "U9", text: "Thread reply: approved" }, // thread reply — history never has it
    { channel: { id: "D23" }, ts: ts(1), user: "U23", text: "Can you review this today?" },
    { channel: { id: "DCAL" }, ts: ts(5), user: "UCAL", username: "google calendar", text: "*Today*" },
    { channel: { id: "G11" }, ts: ts(6), user: "U5", text: "Group DM eleven" },
    { channel: { id: "C31" }, ts: ts(7), user: "U4", text: "Private channel note" },
    { channel: { id: "CNOT" }, ts: ts(1), user: "U8", text: "Someone else's channel" },
    { channel: { id: "D0" }, ts: ts(24 * 10), user: "U0", text: "Ten days old" },
  ];
  const calls = { history: [], search: 0, list: [] };
  const page = (arr, cursor) => { const start = Number(cursor || 0); const next = start + 10 < arr.length ? String(start + 10) : ""; return { channels: arr.slice(start, start + 10), response_metadata: { next_cursor: next } }; };
  const web = {
    auth: { test: async () => ({ user_id: "USELF" }) },
    users: { info: async ({ user }) => ({ user: { real_name: user === "UCAL" ? "Google Calendar" : `Person ${user}` } }) },
    conversations: {
      list: async ({ types, cursor }) => { calls.list.push(types); return page(types === "im" ? ims : types === "mpim" ? mpims : channels, cursor); },
      members: async () => ({ members: ["USELF", "U5"] }),
      history: async ({ channel }) => {
        calls.history.push(channel);
        if (rateLimitHistory) { const e = new Error("rate limited"); e.code = "slack_webapi_rate_limited"; throw e; }
        if (history[channel] === "missing_scope") { const e = new Error("missing_scope"); e.data = { error: "missing_scope" }; throw e; }
        return { messages: history[channel] ?? [] };
      },
    },
    search: {
      messages: async () => {
        calls.search++;
        if (!searchWorks) throw new Error("not_allowed_token_type");
        return { messages: { matches: hits, paging: { pages: 1 } } };
      },
    },
  };
  class WebClient { constructor() { return web; } }
  const client = loadTs("lib/slack/client.ts", {
    "@slack/web-api": { WebClient, LogLevel: {} },
    "@/lib/storage/secure-token-store": { getIntegrationToken: async () => null, saveIntegrationToken: async () => {}, deleteIntegrationToken: async () => {} },
    "@/lib/slack/render": { renderSlackText: (t) => t },
    "@/lib/auth/env-credential-owner": { isEnvCredentialOwner: () => true },
  }, { SLACK_BOT_TOKEN: "xoxb-test", SLACK_USER_TOKEN: "xoxp-test" });
  return { client, calls };
}

test("every conversation is listed (all pages), and active ones are read — not the first page's first few", async () => {
  const { client, calls } = workspace();
  const msgs = await client.getRecentSlackMessages("u", 300, 7);
  const texts = msgs.map((m) => m.text);
  assert.ok(texts.includes("Deploy is green"), "channel #33 is on page 4 of the channel list");
  assert.ok(texts.includes("Can you review this today?"), "the 24th DM — past the old 20-DM cut");
  assert.ok(texts.includes("Group DM eleven"), "the 12th group DM — past the old 5-group-DM cut");
  assert.ok(calls.list.filter((t) => t === "mpim").length >= 2, "group DMs paginated");
  // Only conversations with activity get a history call.
  assert.equal([...new Set(calls.history)].sort().join(","), "C31,C33,D23,G11");
});

test("thread replies and private-channel messages come in through search", async () => {
  const { client } = workspace();
  const texts = (await client.getRecentSlackMessages("u", 300, 7)).map((m) => m.text);
  assert.ok(texts.includes("Thread reply: approved"));
  assert.ok(texts.includes("Private channel note"), "no history access → search's hits stand alone");
  assert.equal(texts.filter((t) => t === "Deploy is green").length, 1, "history and search are de-duplicated");
});

test("Google Calendar's Slack posts never appear; system messages don't either; files with a comment do", async () => {
  const { client, calls } = workspace();
  const msgs = await client.getRecentSlackMessages("u", 300, 7);
  assert.equal(msgs.filter((m) => /calendar/i.test(m.author + m.channel) || /^\*?Today\*?/.test(m.text)).length, 0);
  assert.ok(!calls.history.includes("DCAL"), "the calendar app's DM is not even read");
  const texts = msgs.map((m) => m.text);
  assert.ok(!texts.includes("joined"), "channel_join is not a message");
  assert.ok(texts.includes("Spec attached"), "a file shared with a comment is");
  assert.equal(client.isCalendarAppPost({ bot_profile: { name: "Google Calendar" } }), true);
  assert.equal(client.isCalendarAppPost({ username: "outlook calendar" }), true);
  assert.equal(client.isCalendarAppPost({ username: "calendar-team-lead" }), false);
});

test("channels you are not in, and messages outside the window, stay out", async () => {
  const { client } = workspace();
  const texts = (await client.getRecentSlackMessages("u", 300, 7)).map((m) => m.text);
  assert.ok(!texts.includes("Someone else's channel"));
  assert.ok(!texts.includes("Ten days old"));
});

test("without search, conversations are read directly — channels and DMs both represented", async () => {
  const { client, calls } = workspace({ searchWorks: false });
  const msgs = await client.getRecentSlackMessages("u", 300, 7);
  assert.equal(calls.search, 1);
  assert.ok(calls.history.length > 0 && calls.history.length <= 45);
  assert.ok(msgs.some((m) => m.text === "Deploy is green"));
});

test("a rate limit fails the fetch instead of returning a partial inbox", async () => {
  const { client } = workspace({ rateLimitHistory: true });
  await assert.rejects(() => client.getRecentSlackMessages("u", 300, 7), /rate limited/);
});
