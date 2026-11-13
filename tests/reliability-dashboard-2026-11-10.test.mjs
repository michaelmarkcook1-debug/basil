// Dashboard reliability pass (2026-11-10, bug list sections E, G, C5, A9 and
// the two hook items). The pages told the user the wrong thing: a failed load
// read as an empty state, a failed save or delete looked done, a double-click
// made two records, "today" was the UTC day, and browser storage was shared by
// everyone signed in on the same browser.
//
// The pure decisions are extracted to lib/dashboard/{day,reliability}.ts and
// run here through loadTs. The pages are client components the harness cannot
// compile (JSX), so their wiring is checked from source.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
// Values built inside the loadTs sandbox come from another realm; compare JSON.
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

const D = loadTs("lib/dashboard/day.ts");
const R = loadTs("lib/dashboard/reliability.ts");

/** The body of a named function in a source file (up to the next top-level-ish close). */
function body(file, signature, len = 2400) {
  const s = src(file);
  const at = s.indexOf(signature);
  assert.ok(at > -1, `${signature} exists in ${file}`);
  return s.slice(at, at + len);
}

const UTC_TODAY = /new Date\(\)\.toISOString\(\)\.split\("T"\)\[0\]/;

// ── C5: "today" is the user's calendar day ──────────────────────────────────

test("C5: today, tomorrow and due dates are calendar days in the user's timezone, not UTC", () => {
  // 21:00 in New York on Tue 10 Nov is already Wed 11 Nov in UTC.
  const nyEvening = new Date("2026-11-11T02:00:00Z");
  assert.equal(D.dayInZone(nyEvening, "America/New_York"), "2026-11-10");
  assert.equal(D.dayInZone(nyEvening, "Europe/London"), "2026-11-11");
  assert.equal(D.dayInZone("not a date", "Europe/London"), "");
  assert.equal(D.dayInZone(nyEvening, "Not/AZone").length, 10, "an invalid zone falls back to the browser's");
  assert.equal(D.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(D.addDays("2026-03-29", -1), "2026-03-28", "no DST drift (London clocks change 29 Mar)");
  // "Push → Tomorrow" at 21:30 New York time is Wednesday, not Thursday.
  assert.equal(D.daysFromToday(1, "America/New_York", new Date("2026-11-11T02:30:00Z")), "2026-11-11");
  // A date-only due date IS the day; a timestamp is converted.
  assert.equal(D.dueDayOf("2026-11-12", "America/Los_Angeles"), "2026-11-12");
  assert.equal(D.dueDayOf("2026-11-12T03:00:00Z", "America/Los_Angeles"), "2026-11-11");
  // A date-only due date no longer renders a day early west of London.
  assert.equal(D.formatDueDay("2026-11-12", "America/Los_Angeles", { weekday: "short", day: "numeric", month: "short" }), "Thu 12 Nov");
  assert.equal(D.formatDay("2026-11-12", { day: "numeric", month: "short" }), "12 Nov");
});

test("C5: the dashboard pages use the settings timezone for today", () => {
  for (const f of ["app/dashboard/actions/page.tsx", "app/dashboard/decisions/page.tsx", "app/dashboard/meetings/[eventId]/page.tsx"]) {
    assert.doesNotMatch(src(f), UTC_TODAY, `${f} no longer takes today from toISOString()`);
  }
  const actions = src("app/dashboard/actions/page.tsx");
  assert.match(actions, /if \(j\?\.timezone\) setTimeZone\(j\.timezone\);/, "actions reads settings.timezone");
  assert.match(actions, /const todayStr = dayInZone\(new Date\(\), timeZone\);/);
  assert.match(actions, /const weekEndStr = addDays\(todayStr, 7\);/);
  assert.match(actions, /const yesterday = addDays\(todayStr, -1\);/);
  assert.match(actions, /const key = dayInZone\(a\.updatedAt, timeZone\)/, "completed actions group by the user's day");
  const decisions = src("app/dashboard/decisions/page.tsx");
  assert.match(decisions, /todayStr=\{dayInZone\(new Date\(\), timeZone\)\}/);
  assert.match(decisions, /date: dayInZone\(new Date\(\)\),/);
  const prep = src("app/dashboard/meetings/[eventId]/page.tsx");
  assert.match(prep, /const todayLocal = dayInZone\(new Date\(\), timeZone\);/);
  assert.match(prep, /date: meta\.date \|\| dayInZone\(new Date\(\), timeZone\),/);
  assert.match(src("app/dashboard/page.tsx"), /Due \$\{formatDueDay\(a\.dueDate, timeZone, \{ weekday: "short", day: "numeric", month: "short" \}\)\}/);
  const controls = src("components/actions/action-controls.tsx");
  assert.doesNotMatch(controls, /\.toISOString\(\)\.split/);
  assert.match(controls, /dueDate: daysFromToday\(o\.days, settings\?\.timezone\)/);
});

// ── E1, E2, E5: memory page ─────────────────────────────────────────────────

test("E1: Clean facts checks the response instead of printing 'Removed undefined'", () => {
  const purge = body("app/dashboard/memory/page.tsx", "async function handlePurgeCI()", 900);
  assert.match(purge, /if \(!res\.ok\) throw new Error/);
  assert.match(purge, /typeof data\.removed !== "number"/);
  assert.match(purge, /setPurgeError\(true\)/);
  assert.match(src("app/dashboard/memory/page.tsx"), /Clean facts did not run\. Try again\./);
});

test("E2: a failed first load shows an error with Retry, not skeletons under a 'cached' banner", () => {
  const page = src("app/dashboard/memory/page.tsx");
  assert.match(page, /\{loadError && memories !== null && \(/, "the cached-data banner only shows when something is cached");
  const errorState = page.indexOf("memories === null && loadError ?");
  const skeletons = page.indexOf(") : memories === null ? (");
  assert.ok(errorState > -1 && skeletons > errorState, "the error state is checked before the skeletons");
  assert.match(page, /Memories did not load\. Try again\./);
});

test("E5: a failed memory edit keeps the editor open with the text and says so", () => {
  const page = src("app/dashboard/memory/page.tsx");
  assert.match(page, /async function handleEdit\([^)]*\): Promise<boolean>/);
  const save = body("app/dashboard/memory/page.tsx", "async function saveEdit()", 700);
  assert.match(save, /const ok = await onEdit\(/);
  assert.match(save, /if \(!ok\) \{ setEditError\("That was not saved\. Try again\."\); return; \}\s*setEditing\(false\);/);
});

// ── E3, E4, E6: actions and decisions ───────────────────────────────────────

test("E3: the actions Sync button reports a failed request instead of 'Syncing in background'", () => {
  const btn = body("app/dashboard/actions/page.tsx", "function ActionsSyncButton(", 1600);
  assert.match(btn, /if \(!res\.ok\) throw new Error\(String\(res\.status\)\);/);
  assert.match(btn, /setFailed\(true\);\s*return;/);
  assert.match(btn, /failed \? "Sync failed — tap to retry"/);
});

test("E4: rollback helpers put back exactly what the optimistic update took away", () => {
  const list = [{ id: "a" }, { id: "c" }];
  same(R.restoreRemoved(list, { id: "b" }, 1).map((x) => x.id), ["a", "b", "c"]);
  same(R.restoreRemoved(list, { id: "a" }, 0).map((x) => x.id), ["a", "c"], "never duplicates a row a refresh already restored");
  same(R.restoreRemoved(list, { id: "z" }, 99).map((x) => x.id), ["a", "c", "z"]);
  same(R.restoreRemoved(list, { id: "z" }, -1).map((x) => x.id), ["a", "c", "z"]);
  same(R.revertField([{ id: "a", notes: "new" }, { id: "b", notes: "x" }], "a", "notes", "old"), [{ id: "a", notes: "old" }, { id: "b", notes: "x" }]);
});

test("E4: actions delete offers Undo only after the server confirmed, and rolls back otherwise", () => {
  const del = body("app/dashboard/actions/page.tsx", "async function handleDelete(id: string)", 3200);
  const confirmed = del.indexOf("deleted = res.ok;");
  const undo = del.indexOf("pushUndo({");
  assert.ok(confirmed > -1 && undo > confirmed, "Undo is pushed after the DELETE result is known");
  assert.match(del, /restoreRemoved\(prev, target, targetIndex\)/);
  assert.match(del, /That was not deleted\. Try again\./);
  assert.match(del, /if \(!res\.ok\) throw new Error\(`undo failed/, "a failed Undo is not silent either");
  const notes = body("app/dashboard/actions/page.tsx", "async function handleNotes(", 1300);
  assert.match(notes, /revertField\(prev, id, "notes", previousNotes\)/);
  assert.match(notes, /throw new Error\("notes not saved"\)/, "throwing lets the notes panel keep the text and say it was not saved");
  assert.match(src("components/explore-panel.tsx"), /setSaveError\(true\)/);
});

test("E4: decisions delete and notes check res.ok and roll back", () => {
  const del = body("app/dashboard/decisions/page.tsx", "async function handleDelete(id: string)", 1500);
  assert.match(del, /ok = res\.ok;/);
  assert.match(del, /restoreRemoved\(prev, target, targetIndex\)/);
  assert.match(del, /That was not deleted\. Try again\./);
  const notes = body("app/dashboard/decisions/page.tsx", "async function handleNotes(", 1300);
  assert.match(notes, /revertField\(prev, id, "notes", previousNotes\)/);
  assert.match(notes, /throw new Error\("notes not saved"\)/);
});

test("E6: Save cannot be double-clicked into two records, and a failure is shown", () => {
  const actions = src("app/dashboard/actions/page.tsx");
  assert.match(actions, /if \(!form\.text\.trim\(\) \|\| adding\) return;/);
  assert.match(actions, /setAddError\("That was not saved\. Try again\."\);/);
  assert.match(actions, /onClick=\{handleAdd\} disabled=\{adding \|\| !form\.text\.trim\(\)\}/);
  const decisions = src("app/dashboard/decisions/page.tsx");
  const add = body("app/dashboard/decisions/page.tsx", "async function handleAdd()", 700);
  assert.match(add, /if \(!form\.text\.trim\(\) \|\| adding\) return;/);
  assert.match(add, /try \{\s*await saveDecision\(\);\s*\} catch/, "the network rejection is caught");
  assert.match(add, /setAddError\("That was not saved\. Try again\."\)/);
  assert.match(decisions, /disabled=\{adding \|\| !form\.text\.trim\(\)\}/);
});

// ── E7, E8, D7 ──────────────────────────────────────────────────────────────

test("E7: learning outages render as errors, and Restore / Reset / Stop asking check res.ok", () => {
  const page = src("app/dashboard/learning/page.tsx");
  assert.doesNotMatch(page, /r\.ok \? r\.json\(\) : \{ preferences: \[\], priors: \[\] \}/, "no empty profile on a failed response");
  assert.doesNotMatch(page, /r\.ok \? r\.json\(\) : null/);
  assert.match(page, /if \(!r\.ok\) throw new Error/);
  assert.match(page, /!data && profileError \?/);
  assert.match(page, /if \(!trust && trustError\) return <LoadFailed/);
  assert.equal((page.match(/if \(!res\.ok\) throw new Error\(String\(res\.status\)\);/g) ?? []).length, 2, "act and setTrust both check");
  assert.match(page, /That change was not saved\. Try again\./);
});

test("E8: a failed past-meetings load and a failed manual note are shown, not dropped", () => {
  const page = src("app/dashboard/meetings/page.tsx");
  assert.match(page, /if \(!r\.ok\) throw new Error\(`recent-meetings/);
  assert.match(page, /\.catch\(\(\) => \{ setPastError\(true\); setPastLoading\(false\); \}\)/);
  assert.match(page, /pastError && pastMeetings\.length === 0 \?/);
  assert.match(page, /Past meetings did not load\. Try again\./);
  const form = body("app/dashboard/meetings/page.tsx", "function ManualPrepForm(", 2200);
  assert.match(form, /\} else \{\s*setSaveError\("That was not saved\. Try again\."\);/);
  assert.match(form, /\} catch \{\s*setSaveError/);
});

test("D7: Generate Prep is disabled when the meeting cannot be found or the calendar failed", () => {
  const page = src("app/dashboard/meetings/[eventId]/page.tsx");
  assert.match(page, /if \(!r\.ok\) throw new Error\(`calendar \$\{r\.status\}`\); return r\.json\(\);/, "r.ok is checked before r.json()");
  assert.match(page, /setMetaProblem\("not-found"\)/);
  assert.match(page, /setMetaProblem\("not-connected"\)/);
  assert.match(page, /setMetaProblem\("failed"\)/);
  assert.match(page, /if \(!meta \|\| metaProblem\) return;/, "the paid call cannot run");
  assert.match(page, /disabled=\{loading \|\| metaProblem !== null\}/);
  assert.match(page, /This meeting could not be found on your calendar\./);
});

// ── G4–G12 ──────────────────────────────────────────────────────────────────

test("G4: Briefing asks the server for the right type before generating", () => {
  const page = src("app/dashboard/briefing/page.tsx");
  assert.doesNotMatch(page, /fetch\("\/api\/generate\/briefing", \{ cache: "no-store" \}\)/, "no type-less GET");
  assert.match(page, /fetch\(`\/api\/generate\/briefing\?type=\$\{encodeURIComponent\(mountType\)\}`/);
  const sw = body("app/dashboard/briefing/page.tsx", "async function handleTypeChange(", 1400);
  const check = sw.indexOf("/api/generate/briefing?type=");
  const gen = sw.indexOf("void generate(type)");
  assert.ok(check > -1 && gen > check, "the server's per-type cache is asked before a paid generation");
  assert.match(sw, /if \(typeRequestRef\.current !== type\) return;/);
  // The server reads ?type= (owned elsewhere; asserted so a rename is caught).
  assert.match(src("app/api/generate/briefing/route.ts"), /searchParams\.get\("type"\)/);
});

test("G5: Log AI work offers only platforms the import route accepts and keeps the platform's history", () => {
  const route = src("app/api/ai-projects/import/route.ts");
  const accepted = route.match(/SCRAPE_PLATFORMS = new Set<Platform>\(\[([\s\S]*?)\]\)/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  same([...R.AI_IMPORT_PLATFORMS].sort(), accepted.sort());
  const existing = [
    { platform: "chatgpt", externalId: "p1", name: "Q3 plan", url: "https://x/p1", lastActiveAt: "2026-11-01T00:00:00Z" },
    { platform: "chatgpt", externalId: "p2", name: "Hiring", lastActiveAt: "2026-11-02T00:00:00Z" },
    { platform: "gemini", externalId: "g1", name: "Other platform", lastActiveAt: "2026-11-03T00:00:00Z" },
  ];
  const b = R.buildAiImportBody("chatgpt", existing, { name: "New work", externalId: "manual-1", lastActiveAt: "2026-11-10T00:00:00Z" });
  assert.equal(b.platform, "chatgpt");
  same(b.projects.map((p) => p.externalId), ["p1", "p2", "manual-1"], "the route replaces the platform's list, so the existing ones ride along");
  same(Object.keys(b.projects[2]).sort(), ["externalId", "lastActiveAt", "name"], "only fields the route reads");
  const page = src("app/dashboard/(project-management)/ai-projects/page.tsx");
  assert.match(page, /AI_IMPORT_PLATFORMS\.map\(\(p\) =>/);
  assert.doesNotMatch(page, /<option value="claude-code">|<option value="learning">/);
  assert.match(page, /body: JSON\.stringify\(\{ importance: logForm\.importance, category: logForm\.category \}\)/, "importance/category go through the PATCH that stores them");
});

test("G6: a settings reload does not overwrite unsaved edits", () => {
  const saved = { name: "Michael", timezone: "Europe/London", aliasEmails: [] };
  assert.equal(R.settingsDraftDirty({ ...saved }, saved), false);
  assert.equal(R.settingsDraftDirty({ ...saved, timezone: "America/New_York" }, saved), true);
  assert.equal(R.settingsDraftDirty({ ...saved, aliasEmails: ["a@b.c"] }, saved), true);
  assert.equal(R.settingsDraftDirty({ ...saved, linkedin: undefined }, saved), false, "undefined and absent are the same");
  assert.equal(R.shouldAdoptServerSettings(null, false), true, "first load fills the form");
  assert.equal(R.shouldAdoptServerSettings({}, false), true);
  assert.equal(R.shouldAdoptServerSettings({}, true), false, "unsaved edits are kept");
  const page = src("app/dashboard/settings/page.tsx");
  assert.match(page, /setDraft\(\(prev\) => \(shouldAdoptServerSettings\(prev, settingsDraftDirty\(prev, saved\)\) \? data : prev\)\);/);
  assert.doesNotMatch(body("app/dashboard/settings/page.tsx", "async function loadAll()", 1800), /setDraft\(data\);/);
});

test("G7: WhatsApp import failures, profile counts, double starts and chat races", () => {
  const page = src("app/dashboard/whatsapp/page.tsx");
  assert.doesNotMatch(page, /setImportPreview\(\{ added: 0 \}\)/, "a failed import is not a green 'up to date'");
  assert.match(page, /setImportError\("Contacts were not imported\. Try again\."\);/);
  assert.match(page, /ok\+\+; \/\/ only a profile that was generated AND saved counts/);
  assert.match(page, /`\$\{profileProgress\.ok\} of \$\{profileProgress\.total\} profiles generated`/);
  const start = body("app/dashboard/whatsapp/page.tsx", "const startImport = useCallback(async () => {", 1600);
  assert.match(start, /if \(startingRef\.current\) return;/);
  assert.match(start, /if \(!res\.ok\) throw new Error\(`dump/);
  assert.match(start, /setStartError\("The import did not start\. Try again\."\);/);
  const chat = body("app/dashboard/whatsapp/page.tsx", "// Fetch full chat when selection changes", 1500);
  assert.match(chat, /signal: controller\.signal/);
  assert.match(chat, /return \(\) => controller\.abort\(\);/);
  assert.match(chat, /setChat\(data\.chat \?\? null\)/, "a chat without data never leaves the previous one on screen");
});

test("G8: a failed Slack read shows a message and Retry", () => {
  assert.equal(R.slackReadFailed(false, { status: "ready" }), true);
  assert.equal(R.slackReadFailed(true, { status: "error" }), true);
  assert.equal(R.slackReadFailed(true, null), true);
  assert.equal(R.slackReadFailed(true, { status: "ready" }), false);
  assert.equal(R.slackReadFailed(true, { status: "not_connected" }), false, "state panels keep their own guidance");
  const page = src("app/dashboard/slack-command/page.tsx");
  assert.match(page, /if \(slackReadFailed\(res\.ok, body\)\) \{/);
  assert.match(page, /\{status === "error" && \(/);
  assert.match(page, /Retry/);
});

test("G9: Linear saves the issue's own team status, guards Enter, clears descriptions, rolls back", () => {
  assert.equal(R.isLinearDoneType("canceled"), true, "Linear spells it with one l");
  assert.equal(R.isLinearDoneType("completed"), true);
  assert.equal(R.isLinearDoneType("started"), false);
  const states = [
    { id: "a-prog", name: "In Progress", team: { id: "A" } },
    { id: "b-prog", name: "In Progress", team: { id: "B" } },
  ];
  assert.equal(R.pickLinearState(states, "B", "In Progress").id, "b-prog", "not the first team's state");
  assert.equal(R.pickLinearState(states, null, "In Progress").id, "a-prog");
  assert.equal(R.pickLinearState(states, "C", "In Progress"), undefined);
  const before = { title: "T", description: "Old text", priority: 2, dueDate: "", assigneeId: "", labelIds: ["x", "y"] };
  same(R.buildLinearIssuePatch(before, { ...before }), {}, "nothing changed, nothing sent");
  same(R.buildLinearIssuePatch(before, { ...before, description: "" }), { description: "" }, "a cleared description is saved");
  same(R.buildLinearIssuePatch(before, { ...before, labelIds: ["y", "x"] }), {}, "label order is not a change");
  same(R.buildLinearIssuePatch({ ...before, dueDate: "2026-11-12" }, before), { dueDate: null });
  const page = src("app/dashboard/(project-management)/linear/page.tsx");
  assert.doesNotMatch(page, /"cancelled";/);
  assert.match(page, /const currentState = pickLinearState\(states, issueTeamId\(issue\), issue\.state\.name\);/);
  assert.match(page, /const inTeam = chosen \? pickLinearState\(pool, issueTeamId\(selectedIssue\), chosen\.name\) : undefined;/);
  assert.match(page, /if \(!newForm\.title\.trim\(\) \|\| !newForm\.teamId \|\| creatingRef\.current\) return;/);
  assert.match(page, /if \(!selectedIssue \|\| !replyBody\.trim\(\) \|\| sendingReplyRef\.current\) return;/);
  assert.match(page, /if \(!notif\.issue \|\| !body\.trim\(\) \|\| sendingRef\.current\) return;/);
  assert.match(page, /restoreRemoved\(prev, removed, index\)/);
  assert.match(page, /readAt: previous \}/);
  assert.match(page, /inboxError && notifications\.length === 0 \?/);
  assert.match(page, /The inbox did not load\. Try again\./);
});

test("G10: the slot picker takes the date from the same local clock as the time", () => {
  const dt = new Date(2026, 10, 10, 21, 30); // 21:30 local on 10 Nov
  assert.equal(D.localDay(dt), "2026-11-10");
  const picker = body("app/dashboard/schedule/components/DayView.tsx", "function SmartSlotPicker(", 6000);
  assert.doesNotMatch(picker, /toISOString\(\)\.slice\(0, 10\)/);
  assert.match(picker, /const dateStr = localDay\(dt\);/);
});

test("G11: an older month's slow response cannot overwrite the month on screen", () => {
  const g = R.createLatestGuard();
  const october = g.begin();
  const november = g.begin();
  assert.equal(g.isLatest(october), false);
  assert.equal(g.isLatest(november), true);
  const page = src("app/dashboard/schedule/page.tsx");
  assert.match(page, /monthAbortRef\.current\?\.abort\(\);/);
  assert.match(page, /const ticket = monthGuard\.begin\(\);/);
  assert.equal((page.match(/if \(!isLatest\(\)\) return;/g) ?? []).length, 2, "both the success and the failure path are guarded");
});

test("G12: a killed upload reads as stalled and polling stops", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const rec = (status, updatedAt) => ({ status, updatedAt, createdAt: "2026-11-10T09:00:00Z" });
  assert.equal(R.isUploadStalled(rec("transcribing", "2026-11-10T11:30:00Z"), now), true, "30 minutes without a change");
  assert.equal(R.isUploadStalled(rec("transcribing", "2026-11-10T11:50:00Z"), now), false);
  assert.equal(R.isUploadStalled(rec("ready", "2026-11-10T08:00:00Z"), now), false);
  assert.equal(R.isUploadStalled(rec("failed", "2026-11-10T08:00:00Z"), now), false);
  assert.equal(R.isUploadStalled({ status: "analysing", createdAt: "2026-11-10T09:00:00Z" }, now), true, "falls back to createdAt");
  assert.ok(R.UPLOAD_MAX_POLLS * 4 <= 15 * 60, "polling is capped at well under 15 minutes");
  const page = src("app/dashboard/uploads/page.tsx");
  assert.match(page, /isUploadInFlight\(u\.status\) && !isUploadStalled\(u, loadedAt\)/);
  assert.match(page, /if \(pollsRef\.current >= UPLOAD_MAX_POLLS\) \{ setPollCapped\(true\); return; \}/);
  assert.match(page, /stalled \? "Stalled" : STATUS_TEXT\[u\.status\]/);
});

// ── A9: browser storage is per user ─────────────────────────────────────────

function browser() {
  const ls = new Map();
  const localStorage = { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
  const session = loadTs("lib/session-user.ts", {}, {}, { window: {}, localStorage });
  return { ls, localStorage, session };
}

test("A9: cached contacts are per user — a second person on the browser does not inherit the first's", async () => {
  const b = browser();
  const fetch = async () => new Response(JSON.stringify({ contacts: [], deletedIds: [] }), { status: 200 });
  const C = loadTs("lib/user-contacts.ts", { "./sync/channel": { emitChange: () => {} }, "./session-user": b.session }, {}, { window: {}, localStorage: b.localStorage, fetch });
  b.session.setSessionUsername("alice");
  await C.addUserContact({ id: "c1", name: "Alice's Contact", tags: [] });
  C.dismissSuggestion("s1");
  assert.ok(b.ls.has("basil:alice:sage-user-contacts"));
  assert.ok(b.ls.has("basil:alice:sage-dismissed-suggestions"));
  assert.ok(!b.ls.has("sage-user-contacts"), "the shared bare key is not written");
  b.session.setSessionUsername("bob");
  assert.equal(C.getUserContacts().length, 0, "Bob sees none of Alice's cache");
  assert.equal(C.getDismissedSuggestionIds().length, 0);
  // Bob's first load must not upload Alice's cache into his account.
  const posts = [];
  const C2 = loadTs("lib/user-contacts.ts", { "./sync/channel": { emitChange: () => {} }, "./session-user": b.session }, {}, {
    window: {}, localStorage: b.localStorage,
    fetch: async (url, init) => { if (init?.method === "POST") posts.push(JSON.parse(init.body)); return new Response(JSON.stringify({ contacts: [], deletedIds: [] }), { status: 200 }); },
  });
  await C2.loadUserContactsFromServer();
  assert.equal(posts.length, 0);
  assert.ok(b.ls.has("basil:bob:sage-user-contacts-migrated-v1"));
});

test("A9: profile overrides and focus mode are per user; actions/decisions legacy lists use the scoped key", async () => {
  const b = browser();
  b.session.setSessionUsername("alice");
  const fetch = async () => new Response(JSON.stringify({ override: { personality: "Direct" } }), { status: 200 });
  const O = loadTs("lib/contact-profile-overrides.ts", { "./session-user": b.session }, {}, { window: {}, localStorage: b.localStorage, fetch });
  await O.setOverride("c1", { personality: "Direct" });
  assert.ok(b.ls.has("basil:alice:sage-contact-profile-overrides"));
  b.session.setSessionUsername("bob");
  assert.equal(O.getOverride("c1"), undefined, "Bob does not see Alice's override");

  const mode = src("components/ui/mode-context.tsx");
  assert.match(mode, /localStorage\.getItem\(scopedKey\(STORAGE_KEY\)\)/);
  assert.match(mode, /localStorage\.setItem\(scopedKey\(STORAGE_KEY\)/);
  assert.match(mode, /localStorage\.getItem\(scopedKey\(SUGGEST_DISMISS_KEY\)\)/);
  assert.match(mode, /localStorage\.setItem\(scopedKey\(SUGGEST_DISMISS_KEY\)/);
  assert.match(mode, /useState<ModeState>\(DEFAULT_STATE\)/, "no localStorage read in the useState initializer (hydration)");
  assert.doesNotMatch(mode, /useState<string \| null>\(\(\) =>/);
  assert.match(mode, /useEffect\(\(\) => \{\s*\/\/[^\n]*\n[^\n]*\n\s*setState\(readPersistedState\(\)\);/);

  for (const f of ["app/dashboard/actions/page.tsx", "app/dashboard/decisions/page.tsx"]) {
    const s = src(f);
    assert.match(s, /const legacyKey = scopedKey\(LEGACY_STORAGE_KEY\);/, `${f} reads the scoped legacy key`);
    assert.doesNotMatch(s, /localStorage\.(getItem|removeItem)\(LEGACY_STORAGE_KEY\)/);
  }
});

// ── Smaller items: hooks ────────────────────────────────────────────────────

test("usePersistentDraft lands an edit made just before switching item, under its own key", () => {
  const hook = src("lib/hooks/use-persistent-draft.ts");
  assert.match(hook, /pendingRef\.current = \{ key: storageKeyRef\.current, value: draft \};/, "the value is bound to its key when typed");
  const load = hook.slice(hook.indexOf("// ── Load from storage"), hook.indexOf("// ── Debounced write"));
  const flush = load.indexOf("flushPending();");
  const read = load.indexOf("window.localStorage.getItem(storageKey)");
  assert.ok(flush > -1 && read > flush, "the pending write is flushed before the new key is read");
  assert.match(hook, /useEffect\(\(\) => \(\) => flushPending\(\), \[flushPending\]\);/, "and on unmount");
  assert.match(hook, /pendingRef\.current = null; \/\/ a later flush must not resurrect a cleared draft/);
  assert.match(hook, /window\.localStorage\.setItem\(p\.key, JSON\.stringify\(p\.value\)\);/);
});

test("useContactPhotos does not cache 'no photo' when the fetch failed", () => {
  const hook = src("lib/hooks/use-contact-photos.ts");
  assert.match(hook, /if \(!r\.ok\) throw new Error/);
  const onError = hook.slice(hook.indexOf(".catch(() => {"));
  assert.doesNotMatch(onError, /photoCache\.set/);
  assert.match(onError, /prevPendingKey\.current = "";/);
});
