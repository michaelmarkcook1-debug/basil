/**
 * e2e/whatsapp-ux.spec.ts
 *
 * Catches the regression where the WhatsApp tab automatically started a QR
 * scan or showed "loading contacts" on mount — preventing users from choosing
 * whether to import at all.
 *
 * Three tests
 * ────────────
 * Test 1 — "page load does not auto-start import"
 *   • Navigate to /dashboard/whatsapp
 *   • Assert "Start import" button is visible
 *   • Assert NO progress card / "Waiting for QR scan" text
 *   • Assert NO perpetual loading indicator blocking the page
 *
 * Test 2 — "clicking Start import enters awaiting_qr state and shows QR"
 *   • Click "Start import"
 *   • Assert "Waiting for QR scan" text appears
 *   • On first poll: no QR image yet → assert placeholder text
 *   • On second poll: mock returns qrDataUrl → assert <img> QR code visible
 *
 * Test 3 — "cancel returns to idle"
 *   • Click "Start import" → enter awaiting_qr state
 *   • Click "Cancel" button
 *   • Assert progress panel is gone
 *   • Assert "Start import" button is back
 *   • Assert no perpetual "Waiting for WhatsApp" text remains
 *
 * Mock strategy
 * ─────────────
 * All /api/whatsapp/* routes are intercepted so the tests run without a real
 * Baileys process.  State transitions are controlled by a mutable counter so
 * the second call to GET /api/whatsapp/dump/status returns the QR URL.
 *
 * Prerequisites
 * ─────────────
 * • App must be started with E2E_TEST_MODE=true (wired in playwright.config.ts
 *   and the GitHub Actions e2e step).
 * • POST /api/e2e/test-session issues a real session cookie for the env-admin
 *   user — available only when E2E_TEST_MODE=true.
 */

import { test, expect, type Page } from "@playwright/test";

// ── Constants ─────────────────────────────────────────────────────────────────

/** A minimal 1×1 PNG encoded as a data URL — small enough to be deterministic
 *  in assertions without depending on real WhatsApp QR generation. */
const FAKE_QR_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const IDLE_STATUS = {
  state: "idle",
  chatCount: 0,
  messageCount: 0,
  contactCount: 0,
};

const AWAITING_QR_STATUS = {
  state: "awaiting_qr",
  chatCount: 0,
  messageCount: 0,
  contactCount: 0,
};

const AWAITING_QR_WITH_CODE = {
  ...AWAITING_QR_STATUS,
  qrDataUrl: FAKE_QR_DATA_URL,
};

// ── Auth helper ───────────────────────────────────────────────────────────────

async function authenticate(page: Page): Promise<void> {
  const res = await page.context().request.post("/api/e2e/test-session");
  if (!res.ok()) {
    throw new Error(
      `POST /api/e2e/test-session failed (${res.status()}) — ` +
        `is the server running with E2E_TEST_MODE=true?`
    );
  }
}

// ── Mock helpers ──────────────────────────────────────────────────────────────

/**
 * Wire up all /api/whatsapp/* mocks for a page in the "idle, no snapshot"
 * state.  Returns a `{ triggerQr }` object: calling `triggerQr()` makes the
 * next status poll return qrDataUrl so Test 2 can assert the QR image.
 */
async function mockWhatsappRoutes(page: Page) {
  // Track status poll calls so we can advance state on demand.
  let statusCallCount = 0;
  let inProgress = false;
  let cancelled = false;

  // GET /api/whatsapp/snapshot — no snapshot on disk.
  await page.route("/api/whatsapp/snapshot", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ snapshot: null }),
      });
    } else {
      // DELETE — ignored in these tests but must respond.
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }
  });

  // GET /api/whatsapp/dump/status — returns idle initially; transitions to
  // awaiting_qr once startImport() fires (inProgress=true), then adds the QR
  // image on the second poll so test 2 can assert both sub-states.
  await page.route(/\/api\/whatsapp\/dump\/status/, async (route) => {
    let body: object;

    if (cancelled) {
      body = { status: IDLE_STATUS };
    } else if (inProgress) {
      statusCallCount++;
      if (statusCallCount >= 2) {
        // Second poll — QR code is now available.
        body = { status: AWAITING_QR_WITH_CODE };
      } else {
        // First poll after start — QR not yet issued.
        body = { status: AWAITING_QR_STATUS };
      }
    } else {
      body = { status: IDLE_STATUS };
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  // POST /api/whatsapp/dump — starts the import; returns awaiting_qr immediately.
  await page.route("/api/whatsapp/dump", async (route) => {
    inProgress = true;
    cancelled = false;
    statusCallCount = 0;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: AWAITING_QR_STATUS,
        jobId: "e2e-test-job-1",
      }),
    });
  });

  // POST /api/whatsapp/reset — cancel/reset; transitions back to idle.
  await page.route("/api/whatsapp/reset", async (route) => {
    inProgress = false;
    cancelled = true;
    statusCallCount = 0;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  // POST /api/whatsapp/rebuild-index — best-effort on mount; silently succeed.
  await page.route("/api/whatsapp/rebuild-index", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
}

// ── Suite ─────────────────────────────────────────────────────────────────────

test.describe("WhatsApp import UX", () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
    await mockWhatsappRoutes(page);
  });

  // ── Test 1: page load does not auto-start import ──────────────────────────

  test("page load does not auto-start import", async ({ page }) => {
    await page.goto("/dashboard/whatsapp");

    // The "Start import" (or "Re-import") button must be visible immediately —
    // the user must make an explicit choice before anything happens.
    const startBtn = page.getByRole("button", { name: /Start import|Re-import/i });
    await expect(startBtn).toBeVisible({ timeout: 8_000 });

    // No progress state should be visible on fresh load.
    await expect(
      page.getByText(/Waiting for QR scan/i),
      "QR scan state shown on page load — import auto-started without user consent"
    ).not.toBeVisible();

    await expect(
      page.getByText(/Waiting for WhatsApp to issue a QR/i),
      "QR placeholder shown on page load — import auto-started"
    ).not.toBeVisible();

    // The QR image must not appear until the user explicitly starts the import.
    await expect(
      page.locator(`img[alt="WhatsApp link QR"]`),
      "QR image rendered on page load without user interaction"
    ).not.toBeVisible();
  });

  // ── Test 2: Start import → awaiting_qr → QR image ────────────────────────

  test("clicking Start import enters awaiting_qr state and shows QR code", async ({ page }) => {
    await page.goto("/dashboard/whatsapp");

    // Wait for page to settle, then click "Start import".
    const startBtn = page.getByRole("button", { name: /Start import|Re-import/i });
    await expect(startBtn).toBeVisible({ timeout: 8_000 });
    await startBtn.click();

    // The state label "Waiting for QR scan" should appear promptly.
    await expect(
      page.getByText(/Waiting for QR scan/i),
      "State label did not update to 'Waiting for QR scan' after clicking Start import"
    ).toBeVisible({ timeout: 6_000 });

    // First poll: QR not yet issued — placeholder text should be shown.
    // (The component renders "Waiting for WhatsApp to issue a QR code…" when
    // state=awaiting_qr but qrDataUrl is absent.)
    await expect(
      page.getByText(/Waiting for WhatsApp to issue a QR code/i),
      "Placeholder QR text not shown while waiting for QR code to be issued"
    ).toBeVisible({ timeout: 4_000 });

    // Second poll: mock returns qrDataUrl — the <img> QR code should appear.
    await expect(
      page.locator(`img[alt="WhatsApp link QR"]`),
      "QR image did not appear after status poll returned qrDataUrl — either polling stopped or the component is not rendering the image"
    ).toBeVisible({ timeout: 8_000 });

    // The placeholder text must disappear once the real QR is displayed.
    await expect(
      page.getByText(/Waiting for WhatsApp to issue a QR code/i),
      "Placeholder QR text still visible after QR image was received"
    ).not.toBeVisible();
  });

  // ── Test 3: cancel returns to idle ────────────────────────────────────────

  test("cancel returns page to idle state", async ({ page }) => {
    await page.goto("/dashboard/whatsapp");

    // Start the import.
    const startBtn = page.getByRole("button", { name: /Start import|Re-import/i });
    await expect(startBtn).toBeVisible({ timeout: 8_000 });
    await startBtn.click();

    // Confirm we're in awaiting_qr state before cancelling.
    await expect(page.getByText(/Waiting for QR scan/i)).toBeVisible({
      timeout: 6_000,
    });

    // Click the Cancel button.
    const cancelBtn = page.getByRole("button", { name: /Cancel/i });
    await expect(
      cancelBtn,
      "Cancel button not found — is it rendered when state=awaiting_qr?"
    ).toBeVisible({ timeout: 5_000 });
    await cancelBtn.click();

    // After cancel the page must return to idle:
    // 1. "Start import" button re-appears (or "Re-import" if snapshot exists).
    await expect(
      page.getByRole("button", { name: /Start import|Re-import/i }),
      "Start import button did not reappear after cancel — the page may be stuck in a loading or in-progress state"
    ).toBeVisible({ timeout: 6_000 });

    // 2. QR scan state label must be gone.
    await expect(
      page.getByText(/Waiting for QR scan/i),
      "QR scan state label still visible after cancel — cancelAndReset did not reset state"
    ).not.toBeVisible();

    // 3. The QR image must be gone (stickyQrUrl should have been cleared).
    await expect(
      page.locator(`img[alt="WhatsApp link QR"]`),
      "QR image still visible after cancel — stickyQrUrl was not cleared by cancelAndReset"
    ).not.toBeVisible();

    // 4. No perpetual "Waiting for WhatsApp" text remains.
    await expect(
      page.getByText(/Waiting for WhatsApp to issue a QR code/i),
      "QR placeholder text remains after cancel — loading state is permanent"
    ).not.toBeVisible();
  });
});
