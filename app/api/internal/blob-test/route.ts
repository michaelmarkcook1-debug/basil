/**
 * GET /api/internal/blob-test
 * Temporary debug endpoint — test blob round-trip and return full error.
 * Protected by CRON_SECRET.
 */
import { NextResponse } from "next/server";
import { put, del } from "@vercel/blob";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const result: Record<string, unknown> = {
    tokenPresent: !!token,
    tokenPrefix: token ? token.slice(0, 20) + "..." : null,
  };

  try {
    const putResult = await put("basil/_blob-test", JSON.stringify({ ts: Date.now() }), {
      access: "private",
      addRandomSuffix: false,
      contentType: "application/json",
    });
    result.putOk = true;
    result.putUrl = putResult.url;

    const readRes = await fetch(`${putResult.url}?v=${Date.now()}`, {
      cache: "no-store",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    result.readStatus = readRes.status;
    result.readOk = readRes.ok;
    if (!readRes.ok) {
      result.readBody = await readRes.text().catch(() => "(unreadable)");
    } else {
      result.readData = await readRes.text();
    }

    await del(putResult.url).catch((e: unknown) => {
      result.delError = e instanceof Error ? e.message : String(e);
    });
    result.delOk = !result.delError;
  } catch (err) {
    result.putOk = false;
    result.error = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    if (err instanceof Error && err.stack) {
      result.stack = err.stack.split("\n").slice(0, 5).join("\n");
    }
  }

  return NextResponse.json(result);
}
