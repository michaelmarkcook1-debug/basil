/**
 * A Zoom Member (not admin) gets 400/403 from the Reports API. Basil must then
 * fall back to the host-level endpoints instead of returning nothing — and
 * keep using Reports when Zoom allows it (richer: covers meetings you joined).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./_helpers/load-ts.mjs";

const auth = { getValidZoomAccessToken: async () => "tok", refreshZoomTokens: async () => null };
// The module runs in a sandbox; its fetch delegates to whichever route the test installs.
let route = () => { throw new Error("no route"); };
const calls = [];
const C = loadTs("lib/zoom/client.ts", { "./auth": auth }, {}, {
  fetch: async (url) => { const p = new URL(url).pathname; calls.push(p); return route(p); },
  console: { ...console, warn: () => {} },
});

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
async function withFetch(r, fn) {
  route = r; calls.length = 0;
  const out = await fn();
  return { r: out, calls: [...calls] };
}
const denied = () => json(400, { code: 4711, message: "Invalid access token, does not contain scopes:[report:read:list_meetings:admin]" });

test("Member: meeting list falls back to the host-level previous_meetings list", async () => {
  const { r, calls } = await withFetch((p) => p.startsWith("/v2/report/") ? denied() : json(200, {
    meetings: [{ id: 123, uuid: "abc==", topic: "Board prep", start_time: "2026-10-18T10:00:00Z", duration: 45, host_id: "h1", type: 2 }],
  }), () => C.getPastMeetings("michael", 30, 10));
  assert.deepEqual(calls, ["/v2/report/users/me/meetings", "/v2/report/users/me/meetings", "/v2/users/me/meetings"]);
  assert.equal(r.length, 1);
  assert.equal(r[0].topic, "Board prep");
  assert.equal(r[0].uuid, "abc==");
});

test("Admin-level access still uses Reports and never calls the fallback", async () => {
  const { r, calls } = await withFetch(() => json(200, { meetings: [{ id: 1, uuid: "u", topic: "Joined call", start_time: "2026-10-18T10:00:00Z", duration: 30, host_id: "other", participants_count: 6 }] }),
    () => C.getPastMeetings("michael"));
  assert.deepEqual(calls, ["/v2/report/users/me/meetings"]);
  assert.equal(r[0].participantCount, 6);
});

test("Member: attendees fall back to past_meetings participants with the same fields", async () => {
  const { r, calls } = await withFetch((p) => p.startsWith("/v2/report/") ? denied() : json(200, {
    participants: [{ name: "Carter Hughes", user_email: "carter@example.invalid", join_time: "2026-10-18T10:01:00Z", leave_time: "2026-10-18T10:44:00Z", duration: 2580 }],
  }), () => C.getMeetingParticipants("michael", "abc/def=="));
  assert.equal(calls.length, 2);
  assert.ok(calls[1].startsWith("/v2/past_meetings/"), calls[1]);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), [{ name: "Carter Hughes", email: "carter@example.invalid", joinTime: "2026-10-18T10:01:00Z", leaveTime: "2026-10-18T10:44:00Z", duration: 2580 }]);
});
