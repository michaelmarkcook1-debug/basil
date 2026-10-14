// "Whose action is it?" (2026-10-13 audit). Two Zoom recaps filed Carter's
// "send the brochure to Michael" and Roger's cache task as Michael's open
// actions, plus every follow-up/blocker note as an unowned "action": 11 → 33
// open in four days. Someone else's commitment is waiting-on; a note that
// names nobody stays a note.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTs } from "./_helpers/load-ts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const U = loadTs("lib/actions/utils.ts");
const ME = ["michael cook"];

test("isWaitingOnOthers: the user's own actions vs someone else's", () => {
  for (const owner of ["", "me", "Michael", "Michael Cook", "michael cook", "You"]) assert.equal(U.isWaitingOnOthers({ owner }, ME), false, owner);
  for (const owner of ["Carter", "Roger", "Matthew Paquette"]) assert.equal(U.isWaitingOnOthers({ owner }, ME), true, owner);
  assert.equal(U.isWaitingOnOthers({ owner: "Carter" }, []), false, "no known name → never hide an action");
});

test("ownerOfMeetingNote: the user's, a named person's, or nobody's (stays a note)", () => {
  const own = (t) => U.ownerOfMeetingNote(t, ME)?.owner ?? null;
  assert.equal(own("Follow up: Michael to discuss acquisition evaluation model with Carter"), "michael cook");
  assert.equal(own("Brief Carter before it is announced — Michael owns this"), "michael cook");
  assert.equal(own("Matthew to implement spider chart and revised Market Watch layout"), "Matthew");
  assert.equal(own("Follow up: Roger will share the endpoint ETA"), "Roger");
  assert.equal(own("Follow up: AI technology stack insights tool final version expected next week"), null);
  assert.equal(own("Blocker: Technology stack insights tool cannot provide 100% accurate representations"), null);
  assert.equal(own("Blocker: Roger's endpoint setup progress is unknown"), null, "a status, not anyone's task");
});

test("recap, Slack and email notes only become actions when they name someone", () => {
  const zoom = src("lib/email/process-gmail-message.ts");
  for (const kind of ["consequenceOwner", "blockerOwner", "followUpOwner"]) {
    assert.match(zoom, new RegExp(`if \\(!${kind}\\) \\{ notesKeptAsNotes\\+\\+; continue; \\}`), kind);
    assert.match(zoom, new RegExp(`owner: ${kind},`), `${kind} is recorded as the action's owner`);
  }
  for (const f of ["lib/slack/materialize-slack.ts", "lib/email/materialize-email.ts"]) {
    assert.match(src(f), /const owner = ownerOfMeetingNote\(consequence, selfNames\)\?\.owner;\s*if \(!owner\) continue;/, f);
  }
});

test("Today and the Actions page count only the user's actions; others' are 'Waiting on others'", () => {
  assert.match(src("lib/today/feed.ts"), /const actions = allActions\.filter\(\(a\) => !isWaitingOnOthers\(a, identity\.names\)\);/);
  // Today (redesigned 2026-10-14): your open actions exclude others', and only
  // those are bucketed; others' open actions feed "Waiting on others".
  const today = src("app/dashboard/page.tsx");
  assert.match(today, /const mine = useMemo\(\(\) => all\.filter\(\(a\) => a\.status !== "done" && !isWaitingOnOthers\(a, selfNames\)\)/);
  assert.match(today, /bucketCommitments\(mine, clock, timeZone\)/);
  assert.match(today, /const waiting = useMemo\(\(\) => all\.filter\(\(a\) => a\.status !== "done" && isWaitingOnOthers\(a, selfNames\)\)/);
  const page = src("app/dashboard/actions/page.tsx");
  assert.match(page, /if \(statusFilter === "waiting"\) return matchesSearch && a\.status !== "done" && isTheirs\(a\);\s*if \(isTheirs\(a\)\) return false;/);
  assert.match(page, /Waiting on others \(\{waitingCount\}\)/);
});
