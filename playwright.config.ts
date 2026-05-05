import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for Basil e2e smoke tests.
 *
 * Runs Chromium only — fast smoke coverage, not cross-browser regression.
 * In CI the app must already be built and running; locally the dev server
 * is started automatically.
 *
 * Run:  npm run test:e2e
 * CI:   npm run test:e2e  (after `npm run build && npm start`)
 */
export default defineConfig({
  testDir: "./e2e",

  /* Maximum time one test can take.
   * Contact persistence tests include navigation round-trips, debounce waits,
   * and server round-trips — 45 s gives plenty of room. */
  timeout: 45_000,

  /* Reporter: verbose in CI, dot locally. */
  reporter: process.env.CI ? "github" : "list",

  /* Shared settings for all projects. */
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",

    /* Capture screenshot on failure for debugging. */
    screenshot: "only-on-failure",

    /* Collect trace on first retry — useful for debugging CI failures. */
    trace: "on-first-retry",
  },

  /* Only run Chromium — broaden when cross-browser coverage is needed. */
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  /* Start the dev server automatically in local dev.
   * In CI the server is started separately by the workflow (next build + next start),
   * so the webServer block is omitted entirely — Playwright connects to the
   * already-running server via use.baseURL above.
   *
   * E2E_TEST_MODE=true enables POST /api/e2e/test-session (auth bypass).
   * Never set this in production — the endpoint returns 404 when unset. */
  ...(process.env.CI
    ? {}
    : {
        webServer: {
          command: "E2E_TEST_MODE=true npm run dev",
          url: "http://127.0.0.1:3000",
          reuseExistingServer: true,
          timeout: 120_000,
          stdout: "ignore",
          stderr: "pipe",
          env: {
            E2E_TEST_MODE: "true",
          },
        },
      }),
});
