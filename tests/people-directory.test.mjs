/**
 * One identity per person (audit item 4, 2026-11-24): contacts, Pipedrive,
 * Slack, the calendar, email and meetings joined into one record per person.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTs } from "./_helpers/load-ts.mjs";

const D = loadTs("lib/people/directory.ts");
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const SELF = { emails: ["michael@talentgenius.io"], names: ["michael cook"] };
const plain = (x) => JSON.parse(JSON.stringify(x));
const build = (s, links) => plain(D.buildPeople(s, SELF, links));

test("addresses, phones and names normalise", () => {
  assert.equal(D.normEmail("Jane Doe <Jane.Doe@Acme.com>"), "jane.doe@acme.com");
  assert.equal(D.normEmail("j.a.n.e+news@googlemail.com"), "jane@gmail.com");
  assert.equal(D.normEmail("not an address"), null);
  assert.equal(D.normPhone("+44 7700 900123"), D.normPhone("07700 900123"));
  assert.equal(D.normPhone("123"), null);
  assert.equal(D.fullNameKey("Jane A. Doe"), "jane doe");
  assert.equal(D.fullNameKey("José Núñez (Acme)"), "jose nunez");
  assert.equal(D.fullNameKey("Jane"), null);
});

test("a shared email, Slack ID or phone is the same person across sources", () => {
  const people = build([
    { source: "contact", contactId: "c1", name: "Jane Doe", emails: ["jane@acme.com"] },
    { source: "slack", slackId: "U0JANE1", name: "Jane D", emails: ["JANE@acme.com"], phones: ["+44 7700 900123"] },
    { source: "pipedrive", pipedrivePersonId: 42, name: "Jane Doe", emails: [], phones: ["07700900123"], company: "Acme" },
    { source: "calendar", emails: ["jane@acme.com"] },
  ]);
  assert.equal(people.length, 1);
  const p = people[0];
  assert.equal(p.id, "contact:c1");
  assert.equal(p.name, "Jane Doe");
  assert.deepEqual(p.slackIds, ["U0JANE1"]);
  assert.deepEqual(p.pipedrivePersonIds, [42]);
  assert.equal(p.company, "Acme");
  assert.ok(p.names.includes("Jane D"));
  assert.equal(p.phones.length, 1, "the same number written two ways is one phone");
  assert.deepEqual([...p.sources].sort(), ["calendar", "contact", "pipedrive", "slack"]);
});

test("the same full name joins a nameless-domain record but not two different companies", () => {
  const people = build([
    { source: "email", name: "Jane Doe", emails: ["jane@acme.com"] },
    { source: "meeting", name: "Jane Doe" },
    { source: "pipedrive", pipedrivePersonId: 7, name: "Jane Doe", emails: ["jane.doe@globex.com"] },
  ]);
  // acme vs globex conflict → the name joins nothing; all three stay apart.
  assert.equal(people.length, 3);

  const two = build([
    { source: "email", name: "Tom Smith", emails: ["tom@acme.com"] },
    { source: "meeting", name: "Tom Smith" },
    { source: "slack", slackId: "U0TOM12", name: "Tom A. Smith", emails: ["tsmith@gmail.com"] },
  ]);
  // A webmail address doesn't conflict with a company one.
  assert.equal(two.length, 1);
  assert.deepEqual([...two[0].emails].sort(), ["tom@acme.com", "tsmith@gmail.com"]);
});

test("a bare first name never joins anyone, and the user is not in their own directory", () => {
  const people = build([
    { source: "contact", contactId: "c1", name: "Matt Jones", emails: ["matt@acme.com"] },
    { source: "meeting", name: "Matt" },
    { source: "email", name: "Michael Cook", emails: ["michael@talentgenius.io"] },
    { source: "calendar", name: "Michael Cook" },
  ]);
  assert.equal(people.length, 1);
  assert.equal(people[0].name, "Matt Jones");
});

test("no-reply and shared inboxes aren't people", () => {
  assert.equal(D.isPersonalEmail("noreply@acme.com"), false);
  assert.equal(D.isPersonalEmail("info@acme.com"), false);
  assert.equal(D.isPersonalEmail("x@resource.calendar.google.com"), false);
  assert.equal(D.isPersonalEmail("jane@acme.com"), true);
  assert.equal(build([{ source: "email", emails: ["noreply@acme.com"] }]).length, 0);
});

test("the user's corrections win", () => {
  const sightings = [
    { source: "slack", slackId: "U0JD0001", name: "jd" },
    { source: "contact", contactId: "c9", name: "John Dee", emails: ["john@dee.co"] },
    { source: "email", name: "Tom Smith", emails: ["tom@acme.com"] },
    { source: "meeting", name: "Tom Smith" },
  ];
  assert.equal(build(sightings).length, 3, "jd stays separate; the two Toms join by name");
  const corrected = build(sightings, {
    same: [["slack:U0JD0001", "contact:c9"]],
    different: [["email:tom@acme.com", "name:tom smith"]],
  });
  assert.equal(corrected.length, 3);
  const john = corrected.find((p) => p.contactId === "c9");
  assert.deepEqual(john.slackIds, ["U0JD0001"]);
  assert.equal(corrected.filter((p) => p.name === "Tom Smith").length, 2);
});

test("the result doesn't depend on the order sightings arrive in", () => {
  const s = [
    { source: "email", name: "Ann Lee", emails: ["ann@a.com"] },
    { source: "meeting", name: "Ann Lee" },
    { source: "slack", slackId: "U0ANN001", name: "Ann Lee", emails: ["ann@a.com"] },
    { source: "pipedrive", pipedrivePersonId: 3, name: "Ann Lee", emails: ["ann@b.com"] },
  ];
  const sig = (ps) => ps.map((p) => [...p.emails].sort().join(",")).sort().join("|");
  assert.equal(sig(build(s)), sig(build([...s].reverse())));
});

test("finding people: address, Slack ID, phone, full name; ambiguous names find nobody", () => {
  const ix = D.indexPeople(D.buildPeople([
    { source: "contact", contactId: "c1", name: "Jane Doe", emails: ["jane@acme.com"], phones: ["+1 415 555 0100"] },
    { source: "slack", slackId: "U0JANE1", name: "Jane Doe", emails: ["jane@acme.com"] },
    { source: "slack", slackId: "U0JANE1", name: "janed" },
    { source: "contact", contactId: "c2", name: "Jane Roe", emails: ["jroe@x.io"] },
  ], SELF));
  assert.equal(D.findPerson(ix, "JANE@acme.com").contactId, "c1");
  assert.equal(D.findPerson(ix, "Jane Doe <jane@acme.com>").contactId, "c1");
  assert.equal(D.findPerson(ix, "U0JANE1").contactId, "c1");
  assert.equal(D.findPerson(ix, "(415) 555-0100").contactId, "c1");
  assert.equal(D.findPerson(ix, "Jane A. Doe").contactId, "c1");
  assert.equal(D.findPerson(ix, "janed").contactId, "c1", "a unique handle finds its owner");
  assert.equal(D.findPerson(ix, "Jane"), null, "two Janes: a first name alone is nobody");
  assert.equal(D.findPerson(ix, "nobody@else.com"), null);
});

test("identifiersFor gathers every name and address; unknown inputs pass through", () => {
  const ix = D.indexPeople(D.buildPeople([
    { source: "contact", contactId: "c1", name: "Jane Doe", emails: ["jane@acme.com"] },
    { source: "slack", slackId: "U0JANE1", name: "Jane D", emails: ["jane@acme.com"] },
  ], SELF));
  const ids = plain(D.identifiersFor(ix, ["jane@acme.com", "Stranger Person", "who@else.org"]));
  assert.equal(ids.people.length, 1);
  assert.ok(ids.names.includes("Jane Doe") && ids.names.includes("Jane D") && ids.names.includes("Stranger Person"));
  assert.ok(ids.emails.includes("jane@acme.com") && ids.emails.includes("who@else.org"));
  assert.deepEqual(ids.slackIds, ["U0JANE1"]);
  assert.deepEqual(ids.unresolved, ["Stranger Person", "who@else.org"]);
  assert.equal(D.isFrom(ids, { email: "jane@acme.com", name: "whatever" }), true);
  assert.equal(D.isFrom(ids, { name: "Jane Doe" }), true);
  assert.equal(D.isFrom(ids, { name: "Jane Smith", email: "js@other.com" }), false);
  assert.equal(D.isFrom(ids, { slackId: "U0JANE1" }), true);
});

test("address lists parse names and addresses", () => {
  assert.deepEqual(plain(D.parseAddressList('Jane Doe <jane@acme.com>, bob@x.com, "Doe, John" <john@y.com>')), [
    { name: "Jane Doe", email: "jane@acme.com" }, { email: "bob@x.com" }, { name: "Doe, John", email: "john@y.com" },
  ]);
  assert.deepEqual(plain(D.parseAddressList("")), []);
});

test("wired in: meeting prep, profiles, Ask Basil and the daily cron use the directory", () => {
  const prep = src("app/api/generate/meeting-prep/route.ts");
  assert.match(prep, /identifiersFor\(peopleIx, rawAttendeeNames\)/);
  assert.match(prep, /isFrom\(attendeeIds/);
  assert.match(prep, /personIds: attendeeIds\.people\.flatMap/);
  assert.match(src("lib/contacts/generate-profile.ts"), /personEmails/);
  const tools = src("lib/ai/tools.ts");
  assert.match(tools, /whoIs: tool\(/);
  assert.match(tools, /linkPeople: tool\(/);
  assert.match(src("lib/ai/injection-guard.ts"), /"whoIs"/);
  assert.match(src("app/api/cron/pipedrive-sync/route.ts"), /rebuildPeopleDirectory/);
});
