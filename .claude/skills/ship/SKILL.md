---
name: ship
description: Gate, push, then deploy Basil to production — in that order. Run this instead of a bare `vercel --prod`.
disable-model-invocation: true
---

# /ship

Deploying without pushing is how Basil accumulated 67 unpushed commits between
2026-06-14 and 2026-09-02 while CI never ran once, and how `npm run ci:guards`
stayed broken for six weeks unnoticed.

**Push first, deploy second.** Never reverse them.

## 1. Gates — all four must pass

```bash
npm test && npm run typecheck && npm run lint && npm run ci:guards
```

`lint` warnings are acceptable; **errors are not**. If any gate fails, stop and
report. Do not deploy over a red gate without saying so explicitly and getting
a clear yes.

## 2. Working tree

```bash
git status --porcelain
```

Must be empty. Commit or stash first — uncommitted work is not in the deploy
and is not in the push.

## 3. Push

```bash
git rev-list --count @{u}..HEAD   # how many commits are about to travel
git push
```

If the branch has no upstream, ask which remote branch it should track before
creating one. If the count is large, say the number out loud before pushing.

CI (`.github/workflows/basil-ci.yml`) runs lint, typecheck, tests, build,
guards, and a Playwright smoke test. **Wait for it.** A push that goes red and
a deploy that goes out anyway is the failure mode this command exists to stop.

## 4. Deploy

```bash
vercel --prod
```

Then confirm the deployment reached **Ready**, not just that the command
returned.

## 5. Verify the claim you are about to make

Check the thing that actually changed on the live site — the computed value,
the API response, the log line. Not the token table, not a screenshot, not
"the tests passed".

Report: deployment URL, status, commit SHA, what was verified and how.
