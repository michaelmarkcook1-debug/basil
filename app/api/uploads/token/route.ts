/**
 * POST /api/uploads/token — client-upload token for Vercel Blob.
 *
 * Files go straight from the browser to Blob storage (a two-hour video is far
 * past a function's 4.5 MB request limit). This route only signs the upload:
 * signed-in user, their own media folder, allowed types, 500 MB at most.
 */
import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { getSessionUser } from "@/lib/auth";
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES } from "@/lib/uploads/shape";
import { mediaPrefix } from "@/lib/uploads/paths";

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  let body: HandleUploadBody;
  try { body = (await req.json()) as HandleUploadBody; } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(mediaPrefix(username)) || pathname.includes("..")) {
          throw new Error("Uploads go to your own folder only.");
        }
        return { allowedContentTypes: ALLOWED_CONTENT_TYPES, maximumSizeInBytes: MAX_UPLOAD_BYTES, addRandomSuffix: true };
      },
    });
    return NextResponse.json(result);
  } catch (e) {
    console.warn("[uploads/token] refused:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Upload refused" }, { status: 400 });
  }
}
