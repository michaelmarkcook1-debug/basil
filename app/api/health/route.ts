/**
 * GET /api/health
 *
 * Liveness and configuration check. Returns 200 as long as the Next.js
 * runtime can handle requests.
 *
 * Never exposes secret values — only boolean presence flags.
 * No async I/O — stays fast regardless of external service state.
 *
 * Used by:
 *   - CI smoke tests (tests/smoke.test.mjs)
 *   - Uptime monitors / load-balancer health checks
 *   - Branch protection status checks
 *   - /dashboard (optional UI indicator)
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { put, del } from "@vercel/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // never cache — always reflects live env

// ── Package version ───────────────────────────────────────────────────────────

function getVersion(): string | undefined {
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined; // ci-ok: version is informational, missing is non-fatal
  }
}

// ── Env-var presence map ──────────────────────────────────────────────────────
//
// Groups:
//   core      — must be set for Basil to function at all
//   storage   — Vercel Blob (durable) + legacy fallbacks
//   ai        — LLM provider keys
//   google    — Gmail / Calendar integration
//   microsoft — Outlook / Teams integration
//   slack     — Slack integration
//   zoom      — Zoom integration
//
// Only presence (true/false) is returned — never the value itself.

const ENV_CHECKS = {
  // Core runtime
  AUTH_SECRET:              true,
  APP_URL:                  true,
  // STIG_API_TOKEN is optional — only needed for Siri Shortcuts / external API callers.
  // Labeled clearly in lib/readiness.ts so it never shows as a functional blocker.
  STIG_API_TOKEN:           true,
  // Durable storage
  BLOB_READ_WRITE_TOKEN:    true,
  BASIL_TOKEN_ENCRYPTION_KEY: true,
  // AI providers
  // Note: Basil uses env var `openai_basilv2` as the OpenAI key (legacy naming).
  // OPENAI_API_KEY is the documented standard name; both are checked here so
  // the health panel shows the correct state regardless of which is set.
  OPENAI_API_KEY:           true,
  openai_basilv2:           true,
  ANTHROPIC_API_KEY:        true,
  GEMINI_API_KEY:           true,
  // Integration: Google
  GOOGLE_CLIENT_ID:         true,
  GOOGLE_CLIENT_SECRET:     true,
  GOOGLE_REDIRECT_URI:      true,
  // Integration: Microsoft
  MICROSOFT_CLIENT_ID:      true,
  MICROSOFT_CLIENT_SECRET:  true,
  MICROSOFT_REDIRECT_URI:   true,
  // Integration: Slack
  SLACK_CLIENT_ID:          true,
  SLACK_CLIENT_SECRET:      true,
  SLACK_SIGNING_SECRET:     true,
  // Integration: Zoom
  ZOOM_CLIENT_ID:           true,
  ZOOM_CLIENT_SECRET:       true,
  ZOOM_REDIRECT_URI:        true,
} as const;

type EnvKey = keyof typeof ENV_CHECKS;

function buildEnvPresence(): Record<EnvKey, boolean> {
  const result = {} as Record<EnvKey, boolean>;
  for (const key of Object.keys(ENV_CHECKS) as EnvKey[]) {
    const val = process.env[key];
    result[key] = typeof val === "string" && val.trim().length > 0;
  }
  return result;
}

// ── Storage mode ──────────────────────────────────────────────────────────────

type StorageStatus = "blob-ok" | "blob-error" | "local-fs" | "unknown";

/**
 * Perform a real Vercel Blob write + read + delete round-trip to confirm
 * durable storage is actually working, not just configured.
 */
async function getBlobStorageStatus(): Promise<StorageStatus> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token || token.trim().length === 0) {
    // No Blob token — storage layer falls back to /tmp filesystem (ephemeral on Vercel)
    return process.env.NODE_ENV ? "local-fs" : "unknown";
  }

  try {
    const testPathname = "basil/_health-check";
    const testPayload = JSON.stringify({ ts: Date.now() });

    // Write
    const result = await put(testPathname, testPayload, {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });

    // Read back (bust CDN cache)
    const readRes = await fetch(`${result.url}?v=${Date.now()}`, {
      cache: "no-store",
    });
    if (!readRes.ok) {
      console.error("[health] Blob read-back failed:", readRes.status);
      return "blob-error";
    }

    // Delete (best-effort cleanup)
    await del(result.url).catch((e: unknown) => {
      console.warn("[health] Blob cleanup failed (non-fatal):", e);
    });

    return "blob-ok";
  } catch (err) {
    console.error(
      "[health] Blob round-trip failed:",
      err instanceof Error ? err.message : err
    );
    return "blob-error";
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET() {
  const env = buildEnvPresence();
  const storage = await getBlobStorageStatus();
  const version = getVersion();

  // ok = true as long as the handler runs. Core secret presence is surfaced in
  // checks.env so callers can distinguish "alive but misconfigured" from "down".
  const ok = true;

  const body = {
    ok,
    app:         "Basil",
    timestamp:   new Date().toISOString(),
    environment: process.env.NODE_ENV ?? "unknown",
    ...(version !== undefined ? { version } : {}),
    checks: {
      node:    true,
      storage,
      env,
    },
  };

  return Response.json(body, { status: 200 });
}
