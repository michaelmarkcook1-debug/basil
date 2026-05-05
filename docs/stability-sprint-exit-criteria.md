# Stability Sprint — Exit Criteria

This document defines exactly when it is safe to flip `CI_STRICT_PERSISTENCE=true` in `.github/workflows/basil-ci.yml`.

Until every criterion below is checked off **and verified on production**, keep `CI_STRICT_PERSISTENCE=false`.  Flipping the switch early turns the remaining migration work into blocking CI failures — which is the goal, but only once there is actually nothing left to migrate.

---

## What changes when you flip the switch

| | `CI_STRICT_PERSISTENCE=false` (now) | `CI_STRICT_PERSISTENCE=true` (target) |
|---|---|---|
| `process.env.BASIL_DATA` outside `lib/storage/` | ⚠ Warning — merge still allowed | ✗ Hard failure — merge blocked |
| `/tmp`, `DATA_DIR`, `tmpdir()` in route handlers | ⚠ Warning — merge still allowed | ✗ Hard failure — merge blocked |

The two hard-fail guards (silent catch blocks, hardcoded usernames) are unaffected — they already block merges regardless of this flag.

---

## Exit criteria

Check off each item only after verifying it on **production**, not just locally.

### 1 · No BASIL_DATA persistence

- [ ] `CI_STRICT_PERSISTENCE=false npm run ci:guards` shows zero `BASIL_DATA` warnings.
- [ ] Confirmed by running `grep -r "BASIL_DATA" app lib --include="*.ts" --include="*.tsx"` — only `lib/storage/` references remain (the migration path, which is exempt).
- [ ] The one-time migration in `lib/storage/persistent.ts` has been tested: a fresh cold start with a populated `BASIL_DATA` env var successfully migrates all files to Blob, then sets the migration sentinel so subsequent cold starts skip it.
- [ ] `BASIL_DATA` is no longer set in the Vercel production environment (or is set to an empty string that triggers no migration).

**Why this matters:** `BASIL_DATA` is a base64-encoded JSON snapshot stored as an environment variable. Vercel has a hard limit on env var size (~64 KB). Any user with more data than fits silently loses it on deploy. Blob has no such limit and survives cold starts.

---

### 2 · No durable /tmp user data

- [ ] `CI_STRICT_PERSISTENCE=false npm run ci:guards` shows zero `tmp-durable` warnings.
- [ ] Every route handler that previously wrote user data to `/tmp` now uses `writeStore(filename, data, userSubdir(username), { durability: 'strong' })`.
- [ ] Any remaining `/tmp` usage is confirmed ephemeral cache only (e.g. downloading a file for immediate processing) and is annotated: `// ci-ok: /tmp is L1 cache — Blob is durable source of truth`.
- [ ] Confirmed by deliberately deleting the `/tmp` directory equivalent (e.g. deploying to a new Vercel region) and verifying that no user data is lost.

**Why this matters:** Vercel's `/tmp` filesystem is per-instance and per-invocation. A cold start on a new instance starts with an empty `/tmp`. Any contact, action, memory, or WhatsApp snapshot stored only in `/tmp` is permanently lost.

---

### 3 · All user data stored in Blob storage

- [ ] **Contacts** — creating a contact, redeploying, and reloading shows the contact still present.
- [ ] **Actions and decisions** — creating an action item, redeploying (via `vercel --prod`), and reloading shows it still present.
- [ ] **Memory entries** — same as above.
- [ ] **AI-generated profiles** — generating a personality profile, redeploying, and reloading the contact shows the profile still present.
- [ ] **Settings / integration tokens** — connecting a Google or Slack account, redeploying, and navigating to Settings shows the integration still connected.
- [ ] **Briefing history** — any saved briefing survives a redeploy and reload.

Verification method: use `vercel --prod` to deploy, then immediately navigate to each feature area in a new private browser window (to avoid stale client cache).

---

### 4 · WhatsApp state is user-scoped

- [ ] The `tests/whatsapp-user-scope.test.mjs` test suite passes with no failures (33/33).
- [ ] Manually verified: two separate user accounts can each run a WhatsApp import simultaneously without their QR codes, snapshots, or contacts mixing.
- [ ] WhatsApp snapshots are stored under `users/<username>/whatsapp-snapshot.json` in Blob — confirmed via Vercel Blob browser or `npx vercel blob ls`.
- [ ] WhatsApp signal index is stored under `users/<username>/whatsapp-signal-index.json` — confirmed present after an import.

---

### 5 · Contact saves are atomic

- [ ] Rapidly updating the same contact from two browser tabs simultaneously does not corrupt the contact record (no partial writes, no lost-update).
- [ ] The `withLock(lockKey(username), ...)` pattern in `lib/contacts/user-store.ts` is in use for all contact writes.
- [ ] Creating a contact and immediately navigating away (before the Blob write completes) shows the contact on the next page load — i.e. the response is not sent before the Blob write finishes (`durability: 'strong'` is set).

---

### 6 · Health endpoint shows storage connected

- [ ] `GET /api/health` on production returns `"storage": "blob"` (not `"local-fs"`).
- [ ] `checks.env.BLOB_READ_WRITE_TOKEN: true` in the health response.
- [ ] No `[storage] Blob write failed` lines in Vercel function logs within 24 hours of the check.

Quick check:
```
curl -s https://ag-contracts.vercel.app/api/health | jq '.checks'
```

Expected:
```json
{
  "node": true,
  "storage": "blob",
  "env": {
    "BLOB_READ_WRITE_TOKEN": true,
    "AUTH_SECRET": true,
    ...
  }
}
```

---

### 7 · Actions, decisions, and memory survive a redeploy

This is the user-visible test of criteria 2 and 3.  Run it manually before flipping the switch.

1. As the primary user, create:
   - One new action item with a due date
   - One decision record
   - One memory note with a custom tag
2. Note the exact text of each so you can confirm byte-for-byte.
3. Run `vercel --prod` to deploy the current `main` branch.
4. Wait for the deploy to complete and the new instance to be serving.
5. Open a **private browser window** (no cached state) and log in.
6. Verify:
   - [ ] The action item is present with the correct due date.
   - [ ] The decision record is present with the correct text.
   - [ ] The memory note is present with the correct tag.
7. If any item is missing, do not flip the switch.  The Blob write is either not happening, not being awaited before the response, or the read path is falling through to an empty default.

---

## How to flip the switch

Once every criterion above is checked:

1. Open `.github/workflows/basil-ci.yml`.
2. Change:
   ```yaml
   CI_STRICT_PERSISTENCE: "false"
   ```
   to:
   ```yaml
   CI_STRICT_PERSISTENCE: "true"
   ```
3. Delete or comment out the `# CI_STRICT_PERSISTENCE: "true"` line in the commented block below it.
4. Open a pull request titled **"chore: enable strict persistence enforcement"**.
5. Confirm CI passes with zero failures.
6. Merge.

From this point on, any new code that references `process.env.BASIL_DATA` outside `lib/storage/` or writes user data to `/tmp` without a Blob mirror will block the PR.

---

## Current status

> Update this section as work completes.

| Criterion | Status | Notes |
|-----------|--------|-------|
| No BASIL_DATA outside lib/storage/ | 🟡 In progress | Migration path exists; usage being removed |
| No durable /tmp user data | 🟡 In progress | lib/storage/ uses dual-write; route handlers being audited |
| All user data in Blob | 🟡 In progress | Contacts and actions migrated; checking remaining stores |
| WhatsApp state user-scoped | ✅ Done | Tests passing (33/33 in whatsapp-user-scope.test.mjs) |
| Contact saves atomic | ✅ Done | withLock + durability:strong in user-store.ts |
| Health endpoint shows blob | 🔲 Not verified | Check production /api/health |
| Actions/decisions/memory survive redeploy | 🔲 Not verified | Needs manual test on production |

*Last updated: see git log.*
