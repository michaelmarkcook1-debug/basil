/**
 * e2e/home.spec.ts — Basil Playwright smoke tests.
 *
 * Goal: catch obvious UI regressions before deployment.
 * These are smoke tests — they verify the app renders and doesn't crash,
 * not that every feature works correctly.
 *
 * Tests
 * ─────
 *   1. Homepage loads without a network error
 *   2. No fatal console errors on homepage load
 *   3. Dashboard or login renders something meaningful
 *      (unauthenticated users are redirected to /login)
 *   4. Health endpoint returns { ok: true }
 *   5. Settings page does not crash if the route exists
 *
 * Run locally:  npm run test:e2e
 * (starts dev server automatically via playwright.config.ts webServer)
 */

import { test, expect } from "@playwright/test";

// ── 1. Homepage loads ─────────────────────────────────────────────────────────

test("homepage returns a successful response", async ({ page }) => {
  const response = await page.goto("/");
  // Accept 200 (public landing) or 302/307 redirect (auth guard → login).
  expect(response?.status()).toBeLessThan(500);
});

// ── 2. No fatal console errors ────────────────────────────────────────────────

test("homepage has no fatal console errors", async ({ page }) => {
  const fatalErrors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      // Filter out known noise that isn't actually fatal:
      //   • Next.js hydration mismatches on first load in dev mode
      //   • Browser extension injections
      //   • Missing favicon (404) — not a JS error
      const benign =
        text.includes("ERR_FAILED") ||          // browser net errors logged by the page itself
        text.includes("favicon") ||
        text.includes("extensions") ||
        text.includes("hydrat");                // Next.js hydration warnings
      if (!benign) fatalErrors.push(text);
    }
  });

  await page.goto("/");
  // Give the page a moment to complete hydration.
  await page.waitForLoadState("domcontentloaded");

  expect(
    fatalErrors,
    `Fatal console errors on homepage:\n${fatalErrors.join("\n")}`
  ).toHaveLength(0);
});

// ── 3. Dashboard or login renders ─────────────────────────────────────────────

test("visiting /dashboard renders the login page or dashboard content", async ({ page }) => {
  await page.goto("/dashboard");

  // The app should end up on either /login (auth redirect) or /dashboard.
  const url = page.url();
  const isLoginOrDashboard =
    url.includes("/login") ||
    url.includes("/dashboard") ||
    url.includes("/onboarding");

  expect(isLoginOrDashboard).toBe(true);

  // Page should contain something visible — not be entirely blank.
  const bodyText = await page.locator("body").innerText();
  expect(bodyText.trim().length).toBeGreaterThan(10);
});

// ── 4. Health endpoint ────────────────────────────────────────────────────────

test("GET /api/health returns { ok: true }", async ({ request }) => {
  const response = await request.get("/api/health");

  expect(response.status()).toBe(200);

  const body = await response.json();
  expect(body).toMatchObject({ ok: true, app: "Basil" });

  // Presence map must exist and be an object.
  expect(typeof body.checks).toBe("object");
  expect(typeof body.checks.env).toBe("object");
});

// ── 5. Settings page does not crash ──────────────────────────────────────────

test("settings page does not return a 500 error", async ({ page }) => {
  const response = await page.goto("/dashboard/settings", {
    waitUntil: "domcontentloaded",
  });

  // Auth redirect (302/307) or successful load (200) are both acceptable.
  // A 500 means the route crashed and is not acceptable.
  const status = response?.status() ?? 200;
  expect(status).not.toBe(500);
  expect(status).toBeLessThan(500);
});
