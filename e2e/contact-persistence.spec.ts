/**
 * e2e/contact-persistence.spec.ts
 *
 * Catches the exact bug where contact profile edits or generated-profile output
 * disappears after a tab switch (React state reset) or a full page reload (cache
 * miss).
 *
 * Two tests
 * ─────────
 * Test 1 — "saved fields persist through navigation and reload"
 *   • Inline name edit  →  navigate away  →  name still shows
 *   •                      reload          →  name still shows
 *   • API PATCH personality  →  select  →  Personality tab shows value
 *   •                           navigate away  →  still shows
 *   •                           reload          →  still shows
 *
 * Test 2 — "draft survives navigation; clears on save; server value survives reload"
 *   • Open gen panel, type notes  →  navigate away
 *   • Return  →  panel open, notes intact  (localStorage draft survived)
 *   • Click "Draft profile" (AI mocked)  →  preview appears
 *   • Navigate away before saving
 *   • Return  →  preview still visible  (preview was in draft)
 *   • Click "Save profile"  →  wait for "Saved" confirm
 *   • Assert localStorage draft key is gone  (clearDraft ran)
 *   • Navigate away  →  return  →  gen panel NOT open  (draft was cleared)
 *   • Personality tab shows mocked text  (server save worked)
 *   • Reload  →  personality still shows  (server persistence confirmed)
 *   • Draft key still absent after reload  (never re-written)
 *
 * Prerequisites
 * ─────────────
 * • App must be started with E2E_TEST_MODE=true (wired in playwright.config.ts
 *   and the GitHub Actions e2e step).
 * • POST /api/e2e/test-session issues a real session cookie for the env-admin
 *   user — available only when E2E_TEST_MODE=true.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";

// ── Constants ─────────────────────────────────────────────────────────────────

const TEST_CONTACT_ID   = "basil-ci-test-contact-e2e";
const TEST_CONTACT_NAME = "Basil CI Test Contact";

/** Stable prefix makes mock values unmistakably test-generated in failures. */
const E2E = "Playwright-e2e-test";
const MOCK_PERSONALITY      = `${E2E}: analytical, asks clarifying questions before committing`;
const MOCK_WHAT_MAKES_TICK  = `${E2E}: clear problem statements and measurable outcomes`;
const MOCK_WATCH_OUT        = `${E2E}: can over-index on edge cases and slow a decision`;
const MOCK_NOTES            = `${E2E}: context notes — should survive navigation and reload`;

// ── Contact fixture ───────────────────────────────────────────────────────────

const CONTACT_FIXTURE = {
  id:              TEST_CONTACT_ID,
  name:            TEST_CONTACT_NAME,
  initials:        "BC",
  color:           "bg-slate-600",
  title:           "E2E Test Role",
  company:         "Playwright Corp",
  email:           "ci-test@playwright.test",
  tags:            ["e2e-test"],
  status:          "pending",
  type:            "external",
  directory:       "work",
  relationship:    "Created by Playwright e2e smoke test",
  companyContext:  "Test context",
  personality:     "",
  whatMakesThemTick: "",
  watchOut:        "",
  recentActivity:  "Created by e2e test",
  activitySource:  "Playwright",
};

// ── Auth helper ───────────────────────────────────────────────────────────────

/**
 * Exchange a test-session token for a real session cookie, then install a
 * page init script that seeds localStorage with the username.
 *
 * usePersistentDraft scopes its keys to "basil:<username>:...", so the username
 * must be in localStorage before the contacts page mounts or drafts land under
 * the wrong key.  addInitScript runs on EVERY navigation of the page lifetime.
 */
async function authenticate(page: Page): Promise<string> {
  const res = await page.context().request.post("/api/e2e/test-session");
  if (!res.ok()) {
    throw new Error(
      `POST /api/e2e/test-session failed (${res.status()}) — ` +
      `is the server running with E2E_TEST_MODE=true?`
    );
  }
  const { username } = (await res.json()) as { username: string };

  // Seed localStorage on every page load so draft scoping is always correct.
  await page.addInitScript((u: string) => {
    localStorage.setItem("basil:session-user", u);
  }, username);

  return username;
}

// ── Contact API helpers ────────────────────────────────────────────────────────

async function apiPost(ctx: BrowserContext, path: string, data: unknown) {
  return ctx.request.post(path, {
    data,
    headers: { "Content-Type": "application/json" },
  });
}

async function apiPatch(ctx: BrowserContext, path: string, data: unknown) {
  return ctx.request.patch(path, {
    data,
    headers: { "Content-Type": "application/json" },
  });
}

async function apiDelete(ctx: BrowserContext, path: string) {
  return ctx.request.delete(path);
}

/** Ensure the test contact exists (idempotent — server dedupes by ID). */
async function ensureContact(ctx: BrowserContext) {
  await apiPost(ctx, "/api/contacts/user", CONTACT_FIXTURE);
}

/** Reset profile fields between tests so assertions are clean. */
async function resetContactProfile(ctx: BrowserContext) {
  await apiPatch(ctx, `/api/contacts/user/${TEST_CONTACT_ID}`, {
    name:             TEST_CONTACT_NAME,
    title:            CONTACT_FIXTURE.title,
    personality:      "",
    whatMakesThemTick: "",
    watchOut:         "",
  });
  // Clear any profile override for seed contacts (not used here, but defensive).
  await apiDelete(ctx, `/api/contacts/overrides/${TEST_CONTACT_ID}`).catch(() => {});
}

async function deleteContact(ctx: BrowserContext) {
  await apiDelete(ctx, `/api/contacts/user/${TEST_CONTACT_ID}`).catch(() => {});
  await apiDelete(ctx, `/api/contacts/overrides/${TEST_CONTACT_ID}`).catch(() => {});
}

// ── UI helpers ────────────────────────────────────────────────────────────────

/**
 * Wait for the contact to appear in the list and click it.
 * The contacts page loads asynchronously (server fetch in useEffect), so we
 * must wait for the name to be visible in the list before clicking.
 */
async function selectContact(page: Page, name: string) {
  // The contact name is rendered in a <p class="text-sm font-medium"> inside a
  // list button.  We wait for it, then click the first match.
  await expect(
    page.locator("p.font-medium", { hasText: name }).first()
  ).toBeVisible({ timeout: 12_000 });

  await page.locator("p.font-medium", { hasText: name }).first().click();

  // Wait for the detail panel heading to confirm selection.
  await expect(
    page.locator("h2", { hasText: name })
  ).toBeVisible({ timeout: 5_000 });
}

/** Navigate to contacts, wait for list to stabilise, select the contact. */
async function gotoAndSelect(page: Page, name: string = TEST_CONTACT_NAME) {
  await page.goto("/dashboard/contacts");
  await selectContact(page, name);
}

// ── Shared state ──────────────────────────────────────────────────────────────

let testUsername = "";

// ── Suite ─────────────────────────────────────────────────────────────────────

test.describe("Contact persistence", () => {

  // ── Setup / teardown ────────────────────────────────────────────────────────

  test.beforeAll(async ({ browser }) => {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    testUsername = await authenticate(page);
    await ensureContact(ctx);
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    await ctx.request.post("/api/e2e/test-session").catch(() => {});
    await deleteContact(ctx);
    await ctx.close();
  });

  test.beforeEach(async ({ page }) => {
    testUsername = await authenticate(page);
    // Ensure each test starts with a clean contact (no leftover profile edits).
    await resetContactProfile(page.context());
  });

  // ── Test 1: saved fields persist through navigation and reload ───────────────

  test("saved contact name persists through navigation and page reload", async ({ page }) => {
    const RENAMED = "Basil CI Test Contact Renamed";

    await gotoAndSelect(page);

    // ── Inline name edit ───────────────────────────────────────────────────────
    // The pencil icon is hidden behind opacity-0 group-hover CSS.
    // Hover the heading group to reveal it, then force-click to bypass CSS.
    await page.locator("h2", { hasText: TEST_CONTACT_NAME }).hover();
    await page.getByTitle("Edit name").click({ force: true });

    // The autoFocus <input> replaces the h2 heading.
    const nameInput = page.locator("input.text-xl.font-semibold");
    await expect(nameInput).toBeVisible({ timeout: 3_000 });
    await nameInput.clear();
    await nameInput.fill(RENAMED);
    await nameInput.press("Enter");

    // Confirm the UI updated (server call succeeded if optimistic update shows).
    await expect(page.locator("h2", { hasText: RENAMED })).toBeVisible({ timeout: 6_000 });

    // ── Navigate away → return ─────────────────────────────────────────────────
    await page.goto("/dashboard");
    await gotoAndSelect(page, RENAMED);

    await expect(
      page.locator("h2", { hasText: RENAMED }),
      "Renamed contact lost after navigating away and returning"
    ).toBeVisible();

    // ── Hard reload ────────────────────────────────────────────────────────────
    await page.reload();
    await selectContact(page, RENAMED);

    await expect(
      page.locator("h2", { hasText: RENAMED }),
      "Renamed contact lost after page reload — server persistence broken"
    ).toBeVisible();
  });

  test("API-patched profile fields persist through navigation and reload", async ({ page }) => {
    // Simulate what the UI does after "Accept profile": PATCH personality fields.
    const PERSONALITY = `${E2E}: patched-direct personality field`;
    const patchRes = await apiPatch(page.context(), `/api/contacts/user/${TEST_CONTACT_ID}`, {
      personality:       PERSONALITY,
      whatMakesThemTick: `${E2E}: patched what-makes-tick`,
      watchOut:          `${E2E}: patched watch-out`,
    });
    expect(patchRes.ok(), "PATCH personality must succeed").toBe(true);

    await gotoAndSelect(page);

    // ── View Personality tab ───────────────────────────────────────────────────
    await page.getByRole("tab", { name: /Personality/i }).click();
    await expect(page.getByText(PERSONALITY)).toBeVisible({ timeout: 6_000 });

    // ── Navigate away → return ─────────────────────────────────────────────────
    await page.goto("/dashboard");
    await gotoAndSelect(page);
    await page.getByRole("tab", { name: /Personality/i }).click();

    await expect(
      page.getByText(PERSONALITY),
      "Personality text lost after navigating away and returning"
    ).toBeVisible();

    // ── Hard reload ────────────────────────────────────────────────────────────
    await page.reload();
    await selectContact(page, TEST_CONTACT_NAME);
    await page.getByRole("tab", { name: /Personality/i }).click();

    await expect(
      page.getByText(PERSONALITY),
      "Personality text lost after page reload — server write or cache refresh broken"
    ).toBeVisible();
  });

  // ── Test 2: draft survives navigation; cleared after save ────────────────────

  test(
    "gen-notes draft survives navigation; preview in draft survives navigation; " +
    "save clears draft and persists to server; server value survives reload",
    async ({ page }) => {
      // ── Mock the AI generation endpoint ──────────────────────────────────────
      // Intercepts the fetch so the test never needs a real API key.
      // The mock stays active for the lifetime of this page context.
      await page.route("/api/contacts/generate-profile", async (route) => {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            personality:       MOCK_PERSONALITY,
            whatMakesThemTick: MOCK_WHAT_MAKES_TICK,
            watchOut:          MOCK_WATCH_OUT,
            recentActivity:    `${E2E}: no recent activity`,
            activitySource:    "Playwright e2e test",
            summary:           "E2E mock profile",
            generatedAt:       new Date().toISOString(),
          }),
        });
      });

      // ── Open gen panel and type notes ─────────────────────────────────────────
      await gotoAndSelect(page);

      await page.getByRole("button", { name: /Generate profile/i }).click();

      const textarea = page.locator("textarea").first();
      await expect(textarea).toBeVisible({ timeout: 3_000 });
      await textarea.fill(MOCK_NOTES);

      // Wait for usePersistentDraft debounce (400 ms) + buffer to flush.
      await page.waitForTimeout(600);

      // ── Navigate away BEFORE generating ──────────────────────────────────────
      await page.goto("/dashboard");

      // ── Return: assert draft notes and open state survived ────────────────────
      await gotoAndSelect(page);

      // genOpen=true was saved in the draft, so the textarea should be visible
      // without clicking "Generate profile" again.
      const textareaAfter = page.locator("textarea").first();
      await expect(
        textareaAfter,
        "Gen panel not open after return — genOpen=true was not restored from draft"
      ).toBeVisible({ timeout: 5_000 });
      await expect(
        textareaAfter,
        `Draft notes lost after navigation. Expected "${MOCK_NOTES}" — check usePersistentDraft debounce and localStorage key.`
      ).toHaveValue(MOCK_NOTES);

      // ── Generate the profile (mocked response) ────────────────────────────────
      await page.getByRole("button", { name: /Draft profile/i }).click();
      await expect(page.getByText(MOCK_PERSONALITY)).toBeVisible({ timeout: 8_000 });

      // ── Navigate away BEFORE saving ───────────────────────────────────────────
      await page.goto("/dashboard");

      // ── Return: assert preview survived in draft ──────────────────────────────
      await gotoAndSelect(page);

      await expect(
        page.getByText(MOCK_PERSONALITY),
        "Generated preview lost after navigating away before save. The preview field is not being persisted in the localStorage draft."
      ).toBeVisible({ timeout: 5_000 });

      // ── Save the profile ──────────────────────────────────────────────────────
      await page.getByRole("button", { name: /Save profile/i }).click();

      // Button transitions to "Saved" while in-flight and on success.
      // We treat either the "Saved" text OR the textarea becoming hidden as proof
      // (depending on Radix render timing, one may appear before the other).
      await expect(
        page.getByRole("button", { name: /^Saved$/ })
      ).toBeVisible({ timeout: 8_000 });

      // Wait for clearDraft() to run — it resets genOpen to false, hiding the
      // textarea and showing the "Generate profile" / "Regenerate" button again.
      await expect(
        page.getByRole("button", { name: /Generate profile|Regenerate/i })
      ).toBeVisible({ timeout: 5_000 });

      // ── Assert draft removed from localStorage immediately ────────────────────
      const draftKey = `basil:${testUsername}:contact-gen:${TEST_CONTACT_ID}`;

      const draftAfterSave = await page.evaluate(
        (key) => localStorage.getItem(key),
        draftKey
      );
      expect(draftAfterSave, "Draft key must be absent from localStorage after save").toBeNull();

      // ── Navigate away after save ──────────────────────────────────────────────
      await page.goto("/dashboard");

      // ── Return: gen panel must be CLOSED (draft is cleared) ──────────────────
      await gotoAndSelect(page);

      // The textarea must NOT be visible (genOpen=false after clearDraft).
      await expect(
        page.locator("textarea"),
        "Gen panel still open after save + navigate — clearDraft did not persist correctly"
      ).not.toBeVisible();

      // ── Personality tab: server-saved value shows ─────────────────────────────
      await page.getByRole("tab", { name: /Personality/i }).click();
      await expect(
        page.getByText(MOCK_PERSONALITY),
        "Saved personality text lost after post-save navigation — either server write or cache refresh is broken"
      ).toBeVisible({ timeout: 5_000 });

      // ── Hard reload: server persistence confirmed ─────────────────────────────
      await page.reload();
      await selectContact(page, TEST_CONTACT_NAME);
      await page.getByRole("tab", { name: /Personality/i }).click();

      await expect(
        page.getByText(MOCK_PERSONALITY),
        "Saved personality text lost after page reload. Server write succeeded but the page is not loading the persisted value on mount."
      ).toBeVisible({ timeout: 8_000 });

      // ── Draft still absent after reload ───────────────────────────────────────
      const draftAfterReload = await page.evaluate(
        (key) => localStorage.getItem(key),
        draftKey
      );
      expect(
        draftAfterReload,
        "Draft key reappeared in localStorage after reload — clearDraft is not permanent"
      ).toBeNull();
    }
  );
});
