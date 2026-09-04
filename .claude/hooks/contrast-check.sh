#!/usr/bin/env bash
# PostToolUse(Edit|Write) — run the colour/contrast contract tests the moment a
# style-bearing file changes.
#
# Why this exists: two whole-app colour regressions shipped in one session.
# Both were caught by tests that already existed — but only when someone
# thought to run them, hours later, after screenshots. These take ~1s.
#
# Exit 0 = silent.  Exit 2 = stderr is fed back to Claude as a correction.
set -uo pipefail

INPUT=$(cat)
FILE=$(printf '%s' "$INPUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=JSON.parse(s).tool_input??{};process.stdout.write(t.file_path??t.path??"")}catch{}})' 2>/dev/null)

[ -z "$FILE" ] && exit 0

# Only style-bearing files.
case "$FILE" in
  *.css|*/app/*.tsx|*/components/*.tsx) ;;
  *) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" || exit 0

OUT=$(node --test \
  tests/contrast-aa.test.mjs \
  tests/app-contrast.test.mjs \
  tests/wire-class-hygiene.test.mjs \
  tests/palette-separation.test.mjs 2>&1)

if [ $? -ne 0 ]; then
  printf 'Contrast/colour contract broken by the edit to %s:\n\n%s\n\nDo not reason from the token table — check the computed value.\n' \
    "$FILE" "$(printf '%s' "$OUT" | grep -E '^not ok|✗|AssertionError|expected|actual' | head -25)" >&2
  exit 2
fi
exit 0
