/**
 * GET  /api/uploads — the user's uploads, newest first, plus the folder new files go to.
 * POST /api/uploads — register a file the browser just put in Blob storage and
 *                     start reading it. Body: { pathname, filename, contentType,
 *                     title?, occurredAt?, people?, extractActions? }.
 *
 * Processing (transcription, extraction) runs after the response returns;
 * the record's status shows its progress.
 */
import { NextResponse, after } from "next/server";
import { randomUUID } from "node:crypto";
import { head } from "@vercel/blob";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { checkRateLimitDurable } from "@/lib/rate-limit";
import { listUploads, saveUpload } from "@/lib/uploads/store";
import { processUpload } from "@/lib/uploads/process";
import { mediaPrefix } from "@/lib/uploads/paths";
import { defaultExtractActions, kindOf, occurredAtFromFilename, titleFromFilename, type UploadRecord } from "@/lib/uploads/shape";

export const dynamic = "force-dynamic";
// Transcribing an hour of audio and extracting from it takes a few minutes.
export const maxDuration = 300;

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  return NextResponse.json({ uploads: await listUploads(username), prefix: mediaPrefix(username) });
}

const Body = z.object({
  pathname: z.string().min(1).max(600),
  filename: z.string().min(1).max(300),
  contentType: z.string().max(200).default(""),
  title: z.string().max(200).optional(),
  occurredAt: z.string().max(40).optional(),
  people: z.array(z.string().max(120)).max(30).optional(),
  extractActions: z.boolean().optional(),
});

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const rl = await checkRateLimitDurable(`uploads:${username}`, 10);
  if (!rl.allowed) return NextResponse.json({ error: "Too many uploads in a minute — try again shortly." }, { status: 429 });

  const parsed = Body.safeParse(await req.json().catch(() => null)); // ci-ok: unreadable body → schema rejects null → 400 below
  if (!parsed.success) return NextResponse.json({ error: "Invalid upload details." }, { status: 400 });
  const b = parsed.data;
  if (!b.pathname.startsWith(mediaPrefix(username)) || b.pathname.includes("..")) {
    return NextResponse.json({ error: "That file is not in your folder." }, { status: 403 });
  }
  const kind = kindOf(b.filename, b.contentType);
  if (!kind) return NextResponse.json({ error: "Basil reads audio, video, PDF, Word, text and caption (.vtt/.srt) files." }, { status: 400 });

  let size = 0;
  try { size = (await head(b.pathname)).size; } catch {
    return NextResponse.json({ error: "The upload did not finish — try again." }, { status: 400 });
  }
  const when = b.occurredAt && !Number.isNaN(Date.parse(b.occurredAt)) ? b.occurredAt
    : occurredAtFromFilename(b.filename) ?? new Date().toISOString();
  const now = new Date().toISOString();
  const rec: UploadRecord = {
    id: randomUUID(), kind, filename: b.filename, contentType: b.contentType, size, pathname: b.pathname,
    title: b.title?.trim() || titleFromFilename(b.filename), occurredAt: when,
    people: (b.people ?? []).map((p) => p.trim()).filter(Boolean),
    extractActions: b.extractActions ?? defaultExtractActions(when),
    status: "uploaded", detail: kind === "recording" ? "Waiting to transcribe…" : "Waiting to read…",
    createdAt: now, updatedAt: now,
  };
  await saveUpload(username, rec);
  after(() => processUpload(username, rec.id));
  return NextResponse.json({ upload: rec }, { status: 201 });
}
