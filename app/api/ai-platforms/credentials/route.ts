import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { forceFlushSnapshot } from "@/lib/storage/persistent";
import {
  deleteAIPlatformKey,
  getAIPlatformStatus,
  saveAIPlatformKey,
  validateAIPlatformKey,
  type AIKeyPlatform,
} from "@/lib/ai-platforms/credentials";

const SUPPORTED: AIKeyPlatform[] = ["github", "openai", "anthropic", "gemini", "perplexity", "grok"];

function isPlatform(value: unknown): value is AIKeyPlatform {
  return typeof value === "string" && (SUPPORTED as string[]).includes(value);
}

function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("BASIL_TOKEN_ENCRYPTION_KEY")) {
    return "BASIL_TOKEN_ENCRYPTION_KEY is missing or invalid. Set it in Vercel/local env before saving integration tokens.";
  }
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "sk-***").replace(/gh[pousr]_[A-Za-z0-9_]+/g, "gh***");
}

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const entries = await Promise.all(SUPPORTED.map(async (platform) => [platform, await getAIPlatformStatus(username, platform)]));
  return NextResponse.json({ platforms: Object.fromEntries(entries) });
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let body: { platform?: unknown; apiKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isPlatform(body.platform)) {
    return NextResponse.json({ error: "Unsupported platform" }, { status: 400 });
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) return NextResponse.json({ error: "apiKey is required" }, { status: 400 });

  try {
    const label = await validateAIPlatformKey(body.platform, apiKey);
    await saveAIPlatformKey(username, body.platform, apiKey, label);
    await forceFlushSnapshot();
    return NextResponse.json({ ok: true, platform: body.platform, label });
  } catch (err) {
    const message = safeError(err);
    const status = message.includes("BASIL_TOKEN_ENCRYPTION_KEY") ? 500 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const platform = new URL(req.url).searchParams.get("platform");
  if (!isPlatform(platform)) {
    return NextResponse.json({ error: "Unsupported platform" }, { status: 400 });
  }

  try {
    await deleteAIPlatformKey(username, platform);
    await forceFlushSnapshot();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: safeError(err) }, { status: 500 });
  }
}
