/**
 * GET    /api/uploads/[id] — one upload with its text (timestamped transcript or document text).
 * DELETE /api/uploads/[id] — remove the original and its text. Notes, decisions
 *                            and actions already made from it stay (they are
 *                            yours to keep or dismiss where they live).
 */
import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { getSessionUser } from "@/lib/auth";
import { getUpload, getUploadText, removeUpload } from "@/lib/uploads/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const { id } = await params;
  const upload = await getUpload(username, id);
  if (!upload) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ upload, ...(await getUploadText(username, id)) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const { id } = await params;
  const upload = await getUpload(username, id);
  if (!upload) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try { await del(upload.pathname); } catch (e) {
    console.warn("[uploads] original could not be deleted:", e instanceof Error ? e.message : e);
  }
  await removeUpload(username, id);
  return NextResponse.json({ ok: true });
}
