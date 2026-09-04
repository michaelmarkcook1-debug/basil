#!/usr/bin/env bash
# PreToolUse(Bash) — refuse `vercel --prod` unless the gates are green.
#
# Why this exists: between 2026-06-14 and 2026-09-02, 67 commits were deployed
# straight to production from a laptop without ever being pushed, so CI never
# ran once. `npm run ci:guards` was broken for six weeks and nothing caught it.
# Deploying is the moment that matters — gate it there.
#
# Exit 0 = allow.  Exit 2 = block, stderr goes back to Claude.
set -uo pipefail

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input?.command??"")}catch{}})' 2>/dev/null)

# Only interested in production deploys.
case "$CMD" in
  *vercel*--prod*|*vercel\ deploy*--prod*) ;;
  *) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" || exit 0
FAILED=""

npm test        >/tmp/basil-gate-test.log  2>&1 || FAILED="$FAILED\n  ✗ npm test           → /tmp/basil-gate-test.log"
npm run typecheck >/tmp/basil-gate-tsc.log 2>&1 || FAILED="$FAILED\n  ✗ npm run typecheck  → /tmp/basil-gate-tsc.log"
node scripts/ci-guards.mjs >/tmp/basil-gate-guards.log 2>&1 || FAILED="$FAILED\n  ✗ npm run ci:guards  → /tmp/basil-gate-guards.log"

if [ -n "$FAILED" ]; then
  printf 'Production deploy BLOCKED — gates are not green:%b\n\nFix these, or tell Michael explicitly that you are deploying over a red gate and why.\n' "$FAILED" >&2
  exit 2
fi

# Deploying un-pushed work is how the six-week CI blackout happened. Warn, don't block.
if git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
  AHEAD=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
  [ "$AHEAD" -gt 0 ] && printf 'Gates green. Note: %s commit(s) not yet pushed — this deploy will not be covered by CI.\n' "$AHEAD" >&2
fi
exit 0
