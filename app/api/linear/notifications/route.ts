import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  isLinearConnected,
  getNotifications,
  markAllNotificationsRead,
} from "@/lib/linear/client";

export async function GET(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!(await isLinearConnected(username)))
    return NextResponse.json({ error: "Linear not connected" }, { status: 503 });

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? "50"), 100);
  const notifications = await getNotifications(username, limit);
  return NextResponse.json({ notifications });
}

// PATCH /api/linear/notifications — mark all as read
export async function PATCH(req: Request) {
  void req;
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!(await isLinearConnected(username)))
    return NextResponse.json({ error: "Linear not connected" }, { status: 503 });

  try {
    await markAllNotificationsRead(username);
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[linear] markAllRead error:", e);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
