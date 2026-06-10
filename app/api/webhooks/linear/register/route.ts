/**
 * POST /api/webhooks/linear/register
 *
 * Creates a Linear webhook subscription pointing at our receiver and stores
 * the returned webhook id + signing secret on the user's Linear config.
 *
 * Idempotent: if a webhook is already registered, returns its id without
 * creating a duplicate.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  getLinearConfig,
  saveLinearConfig,
  registerLinearWebhook,
  unregisterLinearWebhook,
} from "@/lib/linear/client";

/**
 * Best-guess base URL of the running deployment.
 * Order: explicit env > Vercel-provided > localhost.
 */
function baseUrlFromEnv(): string {
  if (process.env.BASIL_PUBLIC_URL) return process.env.BASIL_PUBLIC_URL.replace(/\/$/, "");
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;
  return "http://localhost:3000";
}

export async function POST() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const config = await getLinearConfig(username);
  if (!config.apiKey) {
    return NextResponse.json(
      { error: "Connect Linear in Settings first" },
      { status: 400 }
    );
  }

  // Already registered — no-op.
  if (config.webhookId && config.webhookSecret) {
    return NextResponse.json({ ok: true, webhookId: config.webhookId, reused: true });
  }

  const url = `${baseUrlFromEnv()}/api/webhooks/linear`;
  try {
    const { id, secret } = await registerLinearWebhook(username, url);
    await saveLinearConfig(username, {
      ...config,
      webhookId: id,
      webhookSecret: secret,
    });
    return NextResponse.json({ ok: true, webhookId: id });
  } catch (err) {
    console.error("[linear webhook register] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to register webhook" },
      { status: 502 }
    );
  }
}

/** Delete the registered webhook (used on integration disconnect). */
export async function DELETE() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const config = await getLinearConfig(username);
  if (!config.webhookId) return NextResponse.json({ ok: true, skipped: true });

  await unregisterLinearWebhook(username, config.webhookId);
  await saveLinearConfig(username, {
    ...config,
    webhookId: undefined,
    webhookSecret: undefined,
  });
  return NextResponse.json({ ok: true });
}
