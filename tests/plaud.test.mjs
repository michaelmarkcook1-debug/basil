/**
 * Plaud plugin (2026-11-24): connect through Plaud's official MCP server,
 * sync recordings into Basil's upload pipeline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const C = loadTs("lib/plaud/client.ts", {
  "server-only": {},
  "@/lib/plaud/oauth": { PLAUD_RESOURCE: "https://mcp.plaud.ai/mcp", plaudAccessToken: async () => "t", PlaudAuthError: class extends Error {} },
});
const shape = loadTs("lib/uploads/shape.ts");
const Sync = loadTs("lib/plaud/sync.ts", {
  "server-only": {},
  "@/lib/storage/user-store": { readUserStore: async () => ({ processed: {} }), updateUserStore: async () => ({}) },
  "@/lib/uploads/store": { saveUpload: async () => {}, saveUploadText: async () => {}, patchUpload: async () => null },
  "@/lib/uploads/process": { analyseUploadText: async () => {} },
  "@/lib/uploads/shape": shape,
  "@/lib/plaud/client": C,
});

test("JSON-RPC replies are read from JSON or a streamed (SSE) body", () => {
  assert.equal(C.parseRpc("application/json", '{"jsonrpc":"2.0","id":3,"result":{"ok":1}}', 3).result.ok, 1);
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"ping"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"tools":[]}}\n\n';
  assert.ok(C.parseRpc("text/event-stream", sse, 7).result.tools);
  assert.equal(C.parseRpc("text/event-stream", "data: not json\n\n", 1), null);
});

test("tool results: structured content, JSON in text, plain text; errors throw", () => {
  assert.deepEqual({ ...C.toolPayload({ structuredContent: { a: 1 } }) }, { a: 1 });
  assert.equal(C.toolPayload({ content: [{ type: "text", text: '{"files":[{"id":"x"}]}' }] }).files[0].id, "x");
  assert.equal(C.toolPayload({ content: [{ type: "text", text: "hello" }] }), "hello");
  assert.throws(() => C.toolPayload({ isError: true, content: [{ type: "text", text: "Not authenticated" }] }), /Not authenticated/);
});

test("files and transcript segments are read defensively", () => {
  const f = C.toFile({ id: "r1", name: "Weekly sync", start_at: "2026-11-20T10:00:00Z", duration: 1800000 });
  assert.equal(f.name, "Weekly sync");
  assert.equal(f.durationMs, 1800000);
  assert.equal(C.toFile({ name: "no id" }), null);
  const segs = C.toSegments([{ start_time: 0, end_time: 4000, speaker: "Jane", content: "Let's start." }, { start_time: 4000, content: "  " }]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].speaker, "Jane");
});

test("sync: speakers become participants (not 'Speaker 1'); segments keep the speaker and convert to seconds", () => {
  const rec = { segments: [{ startMs: 0, endMs: 4000, speaker: "Jane Doe", text: "Budget is approved." }, { startMs: 4500, speaker: "Speaker 2", text: "Great." }] };
  assert.deepEqual([...Sync.peopleIn(rec)], ["Jane Doe"]);
  const s = Sync.segmentsOf(rec);
  assert.equal(s[0].start, 0);
  assert.equal(s[0].end, 4);
  assert.equal(s[0].text, "Jane Doe: Budget is approved.");
  assert.equal(s[1].start, 4.5);
});

test("wiring: OAuth with PKCE and state, read-only, daily cron, Plaud items have no audio download", () => {
  const oauth = src("lib/plaud/oauth.ts");
  assert.match(oauth, /code_challenge_method: "S256"/);
  assert.match(oauth, /token_endpoint_auth_method: "none"/, "public client, no secret");
  assert.match(src("app/api/auth/plaud/callback/route.ts"), /verifyOAuthState\("plaud"/);
  assert.match(src("vercel.json"), /"\/api\/cron\/plaud-sync"/);
  assert.match(src("app/api/uploads/[id]/file/route.ts"), /stays in Plaud/);
  assert.doesNotMatch(src("lib/plaud/client.ts"), /"(delete|update|create)_/, "only reads");
  assert.match(src("lib/uploads/process.ts"), /export async function analyseUploadText/);
});
