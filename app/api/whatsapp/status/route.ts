/**
 * GET /api/whatsapp/status
 *
 * Returns whether the current user has a WhatsApp snapshot and, if so,
 * lightweight metadata about it (counts and capture time — no messages,
 * no contact details, no JIDs).
 *
 * This is a connection/integration status check used by:
 *   - CI smoke tests (tests/routes.test.mjs)
 *   - Dashboard UI to decide whether to show the WhatsApp import prompt
 *   - Health monitors checking integration availability
 *
 * It does NOT start or stop a dump. For dump-job progress polling use:
 *   GET /api/whatsapp/dump/status?jobId=<uuid>
 */

import { NextResponse } from "next/server";
import { getSnapshot } from "@/lib/whatsapp/dump-job";
import { getSessionUser } from "@/lib/auth";

export async function GET() {
  const username = await getSessionUser();
  if (!username) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const snapshot = await getSnapshot(username);

  if (!snapshot) {
    return NextResponse.json({
      connected: false,
      snapshot:  null,
    });
  }

  // Return counts and capture time only — never message bodies or contact details.
  return NextResponse.json({
    connected: true,
    snapshot: {
      capturedAt:   snapshot.capturedAt,
      chatCount:    snapshot.chatCount,
      messageCount: snapshot.messageCount,
      contactCount: snapshot.contactCount,
    },
  });
}
