# CI and Branch Protection

This document explains how Basil's CI pipeline works and how to configure GitHub to prevent broken code from reaching `main`.

---

## What CI does

Every pull request and push to `main` runs the **Basil CI** workflow (`.github/workflows/basil-ci.yml`), which:

1. **Lint** — checks code style and formatting
2. **TypeScript** — fails on type errors (`tsc --noEmit`)
3. **Tests** — runs the Node built-in test suite
4. **Build** — verifies the Next.js app compiles cleanly
5. **Code quality guards** — catches silent catch blocks, hardcoded usernames, legacy env-var persistence, and unsafe `/tmp` usage (`npm run ci:guards`)

If any step fails, the check is marked red. Without branch protection, a red check is just a warning — nothing stops a merge. The steps below make it a hard block.

---

## Setting up branch protection on GitHub

> **Do this once.** You need Owner or Admin access to the repository.

1. Open the repository on GitHub.
2. Click **Settings** (top navigation bar).
3. In the left sidebar, click **Branches**.
4. Under "Branch protection rules", click **Add branch protection rule**.
5. In **Branch name pattern**, type exactly: `main`
6. Enable **Require a pull request before merging**.
   - Leave the default of 1 required approving review, or set to 0 if you're working solo and just want the CI gate.
7. Enable **Require status checks to pass before merging**.
   - In the search box that appears, type `Lint · Typecheck · Test · Build · Guards` and select the **Basil CI** job when it appears.
   - If the job hasn't run yet, push a branch with a small change first so it appears in the list.
8. Enable **Require branches to be up to date before merging**.
   - This ensures the branch has incorporated the latest `main` before the status check counts.
9. If the option is visible, enable **Do not allow bypassing the above settings**.
   - This removes the admin override escape hatch, so even repo owners can't force-merge a red branch.
10. Click **Save changes**.

After this, any pull request into `main` with a failing CI check will show a blocked merge button — no matter who is trying to merge it.

---

## Verifying it works

1. Create a test branch.
2. Introduce a deliberate violation — for example, add `.catch(() => {})` anywhere in `app/` without a `// ci-ok` annotation.
3. Open a pull request to `main`.
4. Confirm the CI check fails and the **Merge pull request** button is greyed out or shows "Merging is blocked."
5. Fix the violation, push, and confirm the check goes green and the button becomes available.

---

## Escape hatches

CI guards can be suppressed per-line when a pattern is genuinely intentional:

| Annotation | When to use |
|---|---|
| `// ci-ok: <reason>` | Any guard — suppress with an explanation |
| `// fire-and-forget` | Silent catch that is intentionally not logged |
| `// dedup handles` | Silent catch where deduplication logic handles the failure |

Suppression annotations must include a reason so reviewers understand the intent.

---

## What CI does NOT protect against

> **Warning:** CI is not a substitute for durable storage, user scoping, or backend architecture. It only prevents known broken code patterns from merging.

CI will not catch:

- **Data loss** from using `/tmp` as durable storage (it warns, but `/tmp` is ephemeral on Vercel — data silently disappears on cold starts)
- **User data leakage** from missing auth checks or incorrect user scoping in route handlers
- **Logic bugs** that don't produce type errors or test failures
- **Secrets committed to the repo** (use `git-secrets` or GitHub secret scanning for that)
- **Runtime failures** caused by missing environment variables or misconfigured integrations

Think of CI as a floor, not a ceiling.

---

## Adding new guards

Guards live in `scripts/ci-guards.mjs`. Each guard is either a **hard failure** (exits 1, blocks merge) or a **warning** (exits 0, visible but not blocking).

To promote persistence warnings to hard failures in CI:

```bash
CI_STRICT_PERSISTENCE=true npm run ci:guards
```

Set this in the workflow environment when you're confident all `/tmp` and `BASIL_DATA` uses have been migrated.
