import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  isLinearConnected,
  archiveNotification,
  markNotificationRead,
} from "@/lib/linear/client";

type Params = { params: Promise<{ id: string }> };

// PATCH — mark single notification as read
export async function PATCH(_req: Request, { params }: Params) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!(await isLinearConnected(username)))
    return NextResponse.json({ error: "Linear not connected" }, { status: 503 });

  const { id } = await params;
  try {
    await markNotificationRead(username, id);
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[linear] markRead error:", e);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

// DELETE — archive notification (remove from inbox)
export async function DELETE(_req: Request, { params }: Params) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!(await isLinearConnected(username)))
    return NextResponse.json({ error: "Linear not connected" }, { status: 503 });

  const { id } = await params;
  try {
    await archiveNotification(username, id);
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[linear] archive error:", e);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
