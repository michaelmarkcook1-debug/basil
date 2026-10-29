/**
 * GET /api/uploads/[id]/file — download the original (private Blob, so it is
 * streamed through here for the signed-in owner only).
 */
import { get } from "@vercel/blob";
import { getSessionUser } from "@/lib/auth";
import { getUpload } from "@/lib/uploads/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const username = await getSessionUser();
  if (!username) return new Response("Unauthorised", { status: 401 });
  const { id } = await params;
  const upload = await getUpload(username, id);
  if (!upload) return new Response("Not found", { status: 404 });
  const res = await get(upload.pathname, { access: "private", useCache: false });
  if (!res || res.statusCode !== 200 || !res.stream) return new Response("The file could not be read from storage.", { status: 502 });
  const name = upload.filename.replace(/["\r\n]/g, "");
  return new Response(res.stream, {
    headers: {
      "Content-Type": res.blob.contentType || "application/octet-stream",
      "Content-Length": String(res.blob.size),
      "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(upload.filename)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
