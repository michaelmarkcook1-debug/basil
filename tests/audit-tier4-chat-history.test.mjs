/**
 * L2 — truthful chat history. L3 — approval controls for every tool.
 *
 * The receipts module is dependency-free; the store and the history route are
 * the real modules with persistence and auth mocked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs, makeLock, nextServer } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const R = loadTs("lib/chat/receipts.ts");
const plain = (v) => structuredClone(v);

// ── the mapping ──────────────────────────────────────────────────────────────

test("every final SDK state maps to the outcome it means; unfinished is never success", () => {
  assert.equal(R.outcomeFromState("output-available"), "success");
  assert.equal(R.outcomeFromState("output-denied"), "denied");
  assert.equal(R.outcomeFromState("output-error"), "failed");
  for (const s of ["approval-requested", "approval-responded", "input-streaming", "input-available"]) {
    assert.equal(R.outcomeFromState(s), "pending", s);
  }
  assert.equal(R.outcomeFromState(undefined), "unknown");
  assert.equal(R.outcomeFromState("something-new"), "unknown");
});

test("a denied draft survives save → restore as denied, with its acknowledgement", () => {
  const live = {
    id: "asst-1", role: "assistant",
    parts: [
      { type: "text", text: "Here is the draft for your approval." },
      { type: "tool-draftEmail", state: "output-denied", input: { to: "basil-audit@example.invalid" } },
      { type: "text", text: "Understood — I will not send it." },
    ],
  };
  const stored = R.toStoredMessage(live, () => "2026-09-15T15:00:00.000Z");
  assert.match(stored.content, /for your approval/);
  assert.match(stored.content, /will not send it/, "the second text part is the acknowledgement");
  assert.deepEqual(plain(stored.toolReceipts.map((r) => [r.toolName, r.outcome])), [["draftEmail", "denied"]]);

  const restored = R.toUIMessage(stored);
  const tool = restored.parts.find((p) => p.type === "tool-draftEmail");
  assert.equal(tool.state, "output-denied");
  assert.equal(R.receiptLabel(tool.state).label, "denied");
  assert.match(restored.parts.find((p) => p.type === "text").text, /will not send it/);
});

test("pending, failed and unknown receipts never restore as a tick, and none is executable", () => {
  const stored = R.toStoredMessage({
    id: "a", role: "assistant",
    parts: [
      { type: "tool-scheduleMeeting", state: "approval-requested", input: {} },
      { type: "tool-addAction", state: "output-error", input: {} },
      { type: "tool-sendSlackMessage", state: "weird-future-state", input: {} },
      { type: "tool-draftEmail", state: "output-available", input: {} },
    ],
  });
  const restored = R.toUIMessage(stored);
  const byTool = Object.fromEntries(restored.parts.map((p) => [p.type, p.state]));
  assert.equal(byTool["tool-scheduleMeeting"], "archived-pending");
  assert.equal(byTool["tool-addAction"], "output-error");
  assert.equal(byTool["tool-sendSlackMessage"], "archived-unknown");
  assert.equal(byTool["tool-draftEmail"], "output-available");
  for (const p of restored.parts) {
    assert.equal(R.shouldRenderApproval(p), false, `${p.type} restored from history must not offer Approve/Deny`);
  }
  assert.equal(R.receiptLabel("archived-pending").label, "not completed");
  assert.equal(R.receiptLabel("archived-unknown").label, "outcome unknown");
  assert.equal(R.receiptLabel("output-available").label, "✓");
});

test("receipts saved before `outcome` existed are derived from their raw state — correctly", () => {
  const legacy = { id: "old", role: "assistant", content: "…", createdAt: "2026-08-01T00:00:00.000Z",
    toolReceipts: [{ toolName: "draftEmail", state: "approval-requested", input: {} }] };
  const restored = R.toUIMessage(legacy);
  assert.equal(restored.parts.find((p) => p.type.startsWith("tool-")).state, "archived-pending",
    "the old mapping would have made this a success tick");
});

// ── L3: every approval-required tool gets controls, from state alone ─────────

test("L3 every tool that requires approval renders controls when the server asks — no allowlist", () => {
  const src = readFileSync(path.join(ROOT, "lib/ai/tools.ts"), "utf8");
  // Fixture source, not the assertion target: the names of every tool declared
  // with needsApproval: true, so this test grows with the tool set.
  const decls = [...src.matchAll(/^\s{4}([a-zA-Z]+): tool\(\{/gm)];
  const names = decls
    .filter((d, i) => /needsApproval: true/.test(src.slice(d.index, decls[i + 1]?.index ?? src.length)))
    .map((d) => d[1]);
  assert.ok(names.includes("addAction") && names.includes("draftEmail") && names.length >= 8, `found ${names}`);
  for (const n of names) {
    assert.equal(R.shouldRenderApproval({ type: `tool-${n}`, state: "approval-requested" }), true, n);
    assert.equal(R.shouldRenderApproval({ type: `tool-${n}`, state: "archived-pending" }), false, `${n} archived`);
  }
  const page = readFileSync(path.join(ROOT, "app/dashboard/chat/page.tsx"), "utf8");
  assert.ok(!/ACTION_TOOLS/.test(page), "the four-name allowlist is gone");
});

// ── the store: revisions land ────────────────────────────────────────────────

function historyStore() {
  const files = new Map();
  const store = loadTs("lib/chat/store.ts", {
    "@/lib/events/lock": makeLock(),
    "@/lib/storage/user-store": {
      readUserStore: async (u, f, fallback) => plain(files.get(`${u}/${f}`) ?? fallback),
      writeUserStore: async (u, f, items) => { files.set(`${u}/${f}`, plain(items)); },
    },
    "@/lib/security/sensitive": loadTs("lib/security/sensitive.ts"),
  });
  return { store, durable: () => plain(files.get("fixture/chat-history.json") ?? []) };
}

test("L2 a later save of the same assistant id replaces the pending receipt with the denial", async () => {
  const { store, durable } = historyStore();
  const first = { id: "asst-1", role: "assistant", content: "Draft ready for approval.", createdAt: "2026-09-15T15:00:00.000Z",
    toolReceipts: [{ toolName: "draftEmail", state: "approval-requested", outcome: "pending", input: {} }] };
  await store.appendChatMessages("fixture", [{ id: "u-1", role: "user", content: "draft it", createdAt: "2026-09-15T14:59:00.000Z" }, first]);
  assert.equal(durable().length, 2);

  const revised = { ...first, content: "Draft ready for approval.\n\nUnderstood — not sending.",
    toolReceipts: [{ toolName: "draftEmail", state: "output-denied", outcome: "denied", input: {} }] };
  await store.appendChatMessages("fixture", [revised]);
  const rows = durable();
  assert.equal(rows.length, 2, "revision, not a duplicate");
  assert.equal(rows[1].toolReceipts[0].outcome, "denied");
  assert.match(rows[1].content, /not sending/);
  assert.equal(rows[1].createdAt, "2026-09-15T15:00:00.000Z", "creation time is kept");
  assert.ok(rows[1].revisedAt, "the revision is recorded");
  assert.equal(rows[0].content, "draft it", "other rows untouched");
});

test("L2 a save that carries only a subset of ids never removes the rest", async () => {
  const { store, durable } = historyStore();
  await store.appendChatMessages("fixture", [
    { id: "a", role: "user", content: "one", createdAt: "2026-09-01T00:00:00.000Z" },
    { id: "b", role: "assistant", content: "two", createdAt: "2026-09-01T00:00:01.000Z" },
  ]);
  await store.appendChatMessages("fixture", [{ id: "c", role: "user", content: "three", createdAt: "2026-09-02T00:00:00.000Z" }]);
  assert.deepEqual(durable().map((m) => m.id), ["a", "b", "c"]);
});

test("L1 a credential the model repeated is not persisted in history", async () => {
  const { store, durable } = historyStore();
  await store.appendChatMessages("fixture", [{ id: "x", role: "assistant", content: "The temporary password is Qm4$zTy9 — change it soon.", createdAt: "2026-09-15T00:00:00.000Z" }]);
  assert.doesNotMatch(durable()[0].content, /Qm4\$zTy9/);
});

// ── the route: outcomes are validated, not trusted ───────────────────────────

test("L2 the history route stores a client outcome only when it is one of ours", async () => {
  const saved = [];
  const route = loadTs("app/api/chat/history/route.ts", {
    "next/server": nextServer,
    "@/lib/auth": { getSessionUser: async () => "fixture" },
    "@/lib/chat/store": { getChatHistory: async () => [], appendChatMessages: async (_u, m) => { saved.push(...m); }, clearChatHistory: async () => {} },
    "@/lib/chat/receipts": R,
  });
  const res = await route.POST({ json: async () => ({ messages: [
    { id: "1", role: "assistant", content: "x", toolReceipts: [{ toolName: "draftEmail", state: "output-denied", outcome: "denied" }] },
    { id: "2", role: "assistant", content: "y", toolReceipts: [{ toolName: "addAction", state: "approval-requested", outcome: "success" }] }, // a lie
    { id: "3", role: "assistant", content: "z", toolReceipts: [{ toolName: "scheduleMeeting", state: "output-available" }] },              // legacy, no outcome
  ] }) });
  assert.equal(res.status, 200);
  assert.deepEqual(saved.map((m) => m.toolReceipts[0].outcome), ["denied", "pending", "success"],
    "a client claiming success for an approval-requested receipt is corrected from the state");
});
