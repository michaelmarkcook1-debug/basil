/**
 * POST /api/e2e/test-session
 *
 * Test-only auth bypass — issues a real session cookie for the env-admin user
 * without requiring a password.  Used by Playwright e2e tests so they can
 * authenticate without hardcoding credentials or bypassing the real session
 * mechanism (the cookie is identical to what /api/auth issues).
 *
 * GUARD: returns 404 unless E2E_TEST_MODE=true or NODE_ENV=test.
 * Never enabled in production — the guard is evaluated at request time, not
 * at build time, so even a misconfigured deploy is safe.
 *
 * Usage in tests:
 *   const res = await page.context().request.post("/api/e2e/test-session");
 *   const { username } = await res.json();
 *   // Session cookie is now set in the page context's cookie jar.
 */

import { NextResponse } from "next/server";
import { createSession } from "@/lib/auth";
import { findByUsername } from "@/lib/users";

export async function POST() {
  // ── Safety guard ────────────────────────────────────────────────────────────
  // Must be E2E_TEST_MODE=true (set by playwright.config.ts / CI e2e step) OR
  // NODE_ENV=test (e.g. Jest / Vitest unit tests).  Never true in production.
  const isTestMode =
    process.env.E2E_TEST_MODE === "true" ||
    process.env.NODE_ENV === "test";

  if (!isTestMode) {
    // Return 404 so the endpoint is invisible to scanners.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // ── Issue session for the env-admin account ──────────────────────────────────
  // The env-admin is always present via the getUsers() fallback in users.ts
  // (ADMIN_USERNAME / APP_PASSWORD env vars, defaulting to "admin").
  const username = process.env.ADMIN_USERNAME ?? "admin"; // ci-ok: bootstrap default for env-admin; mirrors users.ts
  const user = await findByUsername(username);

  if (!user) {
    return NextResponse.json(
      { error: `Test user "${username}" not found — is ADMIN_USERNAME set correctly?` },
      { status: 500 }
    );
  }

  await createSession(username, user.sessionVersion ?? 1);

  return NextResponse.json({
    ok: true,
    username,
    // Return onboardingCompleted so tests can assert redirect target if needed.
    onboardingCompleted: user.onboardingCompleted ?? false,
  });
}
