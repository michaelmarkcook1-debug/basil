/**
 * POST /api/auth/linear  — save Linear Personal API Key
 * DELETE /api/auth/linear — remove Linear credentials
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  saveLinearConfig,
  deleteLinearConfig,
  validateAndIntrospect,
  registerLinearWebhook,
  unregisterLinearWebhook,
  getLinearConfig,
} from "@/lib/linear/client";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

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
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let body: { apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const apiKey = (body.apiKey ?? "").trim();
  if (!apiKey) {
    return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
  }

  // Validate the key + capture org id (used for webhook owner lookup).
  try {
    const { name, organizationId } = await validateAndIntrospect(apiKey);
    await saveLinearConfig(username, { apiKey, organizationId });

    // ── Auto-register the push-sync webhook ────────────────────────────────
    // Best-effort: a webhook failure must NOT block connecting Linear.
    // Polling fallback (poll-ingest cron) keeps things in sync if the
    // webhook can't be registered (e.g. localhost, missing public URL).
    let webhookRegistered = false;
    try {
      const url = `${baseUrlFromEnv()}/api/webhooks/linear`;
      const { id, secret } = await registerLinearWebhook(username, url);
      const cfg = await getLinearConfig(username);
      await saveLinearConfig(username, {
        ...cfg,
        webhookId: id,
        webhookSecret: secret,
      });
      webhookRegistered = true;
    } catch (whErr) {
      console.warn(
        "[auth/linear] webhook registration skipped:",
        whErr instanceof Error ? whErr.message : whErr
      );
    }

    await forceFlushSnapshot();
    return NextResponse.json({ ok: true, name, webhookRegistered });
  } catch (err) {
    const { message, status } = safeLinearError(err);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  // Tear down the webhook before removing credentials so Linear stops pushing
  // and we don't orphan a subscription on their side.
  const cfg = await getLinearConfig(username);
  if (cfg.webhookId) {
    await unregisterLinearWebhook(username, cfg.webhookId);
  }

  await deleteLinearConfig(username);
  await forceFlushSnapshot();
  return NextResponse.json({ ok: true });
}
