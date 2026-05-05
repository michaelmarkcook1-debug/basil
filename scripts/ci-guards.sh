#!/usr/bin/env bash
# ci-guards.sh — static code quality gates for Basil CI.
#
# Each guard emits a clear error message and exits 1 on violation.
# Run via:  npm run ci:guards
#
# Guards
# ──────
# 1. Hardcoded username comparisons  (fail)
#    Equality checks against literal session usernames like === "michael".
#    Use process.env.PRIMARY_OWNER_USERNAME for owner-specific branches.
#
# 2. Silent catch blocks  (fail)
#    Bare catch(() => {}) with no logging.
#    Annotate intentional fire-and-forget uses with: // fire-and-forget
#    catch(() => null) is NOT flagged — it's a valid optional-fetch transform.
#
# 3. BASIL_DATA outside lib/storage/  (fail)
#    BASIL_DATA is the superseded env-var persistence layer.
#    New code must use readStore/writeStore. Legacy migration code in
#    lib/storage/ is exempt.

set -euo pipefail

FAIL=0

# ── 1. Hardcoded username equality comparisons ─────────────────────────────────

echo "› Checking for hardcoded username comparisons..."

if grep -rEn --include="*.ts" --include="*.tsx" \
    '===\s*["\'"'"'](michael|demo-user)["\'"'"']|["\'"'"'](michael|demo-user)["\'"'"']\s*===' \
    app lib 2>/dev/null; then
  echo ""
  echo "ERROR: Hardcoded username in equality comparison."
  echo "       Use process.env.PRIMARY_OWNER_USERNAME instead of a literal string."
  FAIL=1
else
  echo "  OK"
fi

# ── 2. Silent catch blocks ──────────────────────────────────────────────────────

echo "› Checking for unannotated silent catch blocks..."

# Grep for bare catch(() => {}), then exclude:
#   - JSDoc / inline comment lines  (": *" after the filename:line prefix)
#   - Lines already annotated with // fire-and-forget or // dedup handles
SILENT=$(
  grep -rn 'catch(() => {})' app lib components 2>/dev/null \
    | grep -v ':[[:space:]]*\*\|:[[:space:]]*//' \
    | grep -v 'fire-and-forget\|dedup handles' \
  || true
)

if [ -n "$SILENT" ]; then
  echo ""
  echo "ERROR: Unannotated silent catch block(s) found:"
  echo "$SILENT"
  echo ""
  echo "       Add logging, or annotate intentional fire-and-forget uses with:"
  echo "         .catch(() => {}); // fire-and-forget"
  FAIL=1
else
  echo "  OK"
fi

# ── 3. BASIL_DATA outside lib/storage/ ────────────────────────────────────────

echo "› Checking for BASIL_DATA usage outside lib/storage/..."

BASIL_DATA_HITS=$(
  grep -rn 'process\.env\.BASIL_DATA' app lib 2>/dev/null \
    | grep -v 'lib/storage/' \
  || true
)

if [ -n "$BASIL_DATA_HITS" ]; then
  echo ""
  echo "ERROR: process.env.BASIL_DATA referenced outside lib/storage/."
  echo "$BASIL_DATA_HITS"
  echo ""
  echo "       Use readStore/writeStore from @/lib/storage/persistent instead."
  FAIL=1
else
  echo "  OK"
fi

# ── Result ─────────────────────────────────────────────────────────────────────

echo ""
if [ "$FAIL" -eq 1 ]; then
  echo "ci:guards — FAILED. Fix the violations above before merging."
  exit 1
else
  echo "ci:guards — all checks passed."
fi
