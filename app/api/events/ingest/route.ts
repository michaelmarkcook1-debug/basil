import { NextResponse } from "next/server";
import { createEvent } from "@/lib/events/store";
import { eventFromIngest } from "@/lib/events/rules";
import { publish } from "@/lib/events/bus";
import type { IngestPayload } from "@/lib/events/types";
import { getSessionUser } from "@/lib/auth";

/**
 * POST /api/events/ingest
 * Simulated webhook endpoint. Real push wiring (Gmail Pub/Sub, Slack Events API,
 * Calendar events.watch) will call this same entry point in Phase 2.
 *
 * Body: IngestPayload (see lib/events/types.ts)
 */
export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let payload: IngestPayload;
  try {
    payload = (await req.json()) as IngestPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!payload?.source || !payload.title) {
    return NextResponse.json(
      { error: "source and title are required" },
      { status: 400 }
    );
  }

  const shaped = eventFromIngest(payload);
  const event = await createEvent(shaped);
  publish(event);
  return NextResponse.json({ event });
}
