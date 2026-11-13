/**
 * /api/integrations/linear — Linear API key lifecycle.
 *
 * POST  { apiKey }  — validate and save the API key for the session user,
 *                     MERGED into the stored config (same flow as
 *                     /api/auth/linear: org id captured, push webhook kept or
 *                     registered).
 * DELETE            — unregister the push webhook at Linear, then remove the
 *                     config (disconnect Linear). This is the Settings page's
 *                     disconnect path.
 *
 * Read-only data fetching stays at /api/linear (used by the signals feed).
 */
import { NextResponse } from "next/server";
import { verifySession, getSessionUser } from "@/lib/auth";
import {
  saveLinearConfig,
  deleteLinearConfig,
  getLinearConfig,
  validateAndIntrospect,
  registerLinearWebhook,
  unregisterLinearWebhook,
} from "@/lib/linear/client";

/** Same resolution as /api/auth/linear — where Linear should push to. */
function baseUrlFromEnv(): string {
  if (process.env.BASIL_PUBLIC_URL) return process.env.BASIL_PUBLIC_URL.replace(/\/$/, "");
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;
  return "http://localhost:3000";
}

function safeLinearError(err: unknown): { message: string; status: number } {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("BASIL_TOKEN_ENCRYPTION_KEY")) {
    return {
      message: "BASIL_TOKEN_ENCRYPTION_KEY is missing or invalid. Set it before saving integration tokens.",
      status: 500,
    };
  }
  return { message: msg, status: 400 };
}


export async function POST(req: Request) {
  if (!(await verifySession())) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const username = await getSessionUser();
  if (!username) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: { apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { apiKey } = body;
  if (!apiKey?.trim()) {
    return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
  }

  // Validate the key against Linear's API before saving.
  try {
    const key = apiKey.trim();
    const { name: displayName, organizationId } = await validateAndIntrospect(key);

    // Merge, never replace: saving { apiKey } alone dropped organizationId,
    // webhookId and webhookSecret, so the webhook receiver could no longer find
    // the owner or verify a signature and every push was silently refused.
    const existing = await getLinearConfig(username);
    const next = { ...existing, apiKey: key, organizationId };
    if (existing.webhookId && existing.organizationId && existing.organizationId !== organizationId) {
      // A key for a DIFFERENT workspace: the old webhook belongs to the old
      // one. Remove it while the stored (old) key can still do so.
      await unregisterLinearWebhook(username, existing.webhookId);
      delete next.webhookId;
      delete next.webhookSecret;
    }
    await saveLinearConfig(username, next);

    // Push webhook: keep the one we have; otherwise register one (best-effort,
    // as in /api/auth/linear — the poll-ingest cron covers a failure).
    let webhookRegistered = !!(next.webhookId && next.webhookSecret);
    if (!webhookRegistered) {
      try {
        const { id, secret } = await registerLinearWebhook(username, `${baseUrlFromEnv()}/api/webhooks/linear`);
        await saveLinearConfig(username, { ...next, webhookId: id, webhookSecret: secret });
        webhookRegistered = true;
      } catch (whErr) {
        console.warn(
          "[linear/connect] webhook registration skipped:",
          whErr instanceof Error ? whErr.message : whErr
        );
      }
    }

    console.log(`[linear/connect] ${username} connected Linear (${displayName})`);
    return NextResponse.json({ ok: true, displayName, webhookRegistered });
  } catch (e) {
    const { message, status } = safeLinearError(e);
    console.warn(`[linear/connect] ${username} connection failed: ${message}`);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE() {
  if (!(await verifySession())) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const username = await getSessionUser();
  if (!username) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  // Tear down the webhook BEFORE removing the credentials it needs, so Linear
  // stops pushing and no subscription is orphaned on their side. Best-effort:
  // unregisterLinearWebhook swallows "already gone".
  const cfg = await getLinearConfig(username);
  if (cfg.webhookId) {
    await unregisterLinearWebhook(username, cfg.webhookId);
  }

  await deleteLinearConfig(username);
  console.log(`[linear/disconnect] ${username} disconnected Linear`);
  return NextResponse.json({ ok: true });
}
