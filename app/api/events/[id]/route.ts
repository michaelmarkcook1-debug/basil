import { NextResponse } from "next/server";
import { deleteEvent, updateEventStatus } from "@/lib/events/store";
import type { EventStatus } from "@/lib/events/types";

/**
 * PATCH /api/events/:id  — update status (approve / reject / acknowledge)
 * DELETE /api/events/:id — remove the event entirely
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { status?: EventStatus };
  if (!body.status) {
    return NextResponse.json({ error: "status required" }, { status: 400 });
  }
  const event = await updateEventStatus(id, body.status);
  if (!event) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ event });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const ok = await deleteEvent(id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
